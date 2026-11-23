// Slow-trend BTC bot for bars-replay/v1 (cbBTC vs USDC, 1-minute bars).
//
// Idea: a full-size round trip costs roughly 26 bps once fees, modelled
// slippage and pool impact are paid, while one-minute noise is only a few
// bps, so fast signals churn themselves to death. This bot therefore trades
// rarely and only with the slow trend:
//
//   - Trend: the 60-bar (1-hour) simple average of closes above the 240-bar
//     (4-hour) average means uptrend; below means stay in cash.
//   - Entry (flat, uptrend, latest close also above the 60-bar average):
//     buy with the whole cash balance, once, no scaling in.
//   - Exit (holding): sell everything when the 60-bar average falls back
//     under the 240-bar average, or the close drops 100 bps from the highest
//     close seen since entry (trailing stop), or 150 bps under the close of
//     the bar that decided the buy (hard stop). Whichever comes first.
//   - After an exit the bot waits 60 bars before it may enter again, and it
//     opens no new position in the last 120 bars of the window, so a late
//     entry cannot be flattened at a loss. One exception: if it has still
//     never traded by bar 1350 it buys once, because the race guardrail
//     wants at least one trade.
//
// All arithmetic is integer (bigint closes at the symbol's price scale):
// averages are compared cross-multiplied, stops are bps ratios. No clock,
// no randomness, no network, no files: the same bars always give the same
// orders.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const FAST = 60;
const SLOW = 240;
const TRAIL_BPS = 100n;
const STOP_BPS = 150n;
const COOLDOWN_BARS = 60;
const NO_ENTRY_AFTER = 1320;
const FALLBACK_BAR = 1350;
const MAX_SLIPPAGE_BPS = 100;
const BPS_DEN = 10_000n;

/** Every close seen so far for the traded symbol, in batch order. */
const closes: bigint[] = [];
/** Rolling sums behind the two averages. */
let sumFast = 0n;
let sumSlow = 0n;
/** Close of the bar that decided the current buy; null while flat. */
let entryClose: bigint | null = null;
/** Highest close since the current buy was decided. */
let peakClose = 0n;
/** First bar at which a fresh entry is allowed again after an exit. */
let reenterFrom = 0;
/** Whether any buy has been decided yet (the guardrail fallback needs it). */
let traded = false;

function pushClose(c: bigint): void {
  closes.push(c);
  sumFast += c;
  sumSlow += c;
  if (closes.length > FAST) sumFast -= closes[closes.length - 1 - FAST]!;
  if (closes.length > SLOW) sumSlow -= closes[closes.length - 1 - SLOW]!;
}

/** sumFast/FAST > sumSlow/SLOW, exactly, with no division. */
function uptrend(): boolean {
  return sumFast * BigInt(SLOW) > sumSlow * BigInt(FAST);
}


/** Latest close strictly above the fast average, exactly. */
function aboveFast(c: bigint): boolean {
  return c * BigInt(FAST) > sumFast;
}

/** True when `c` sits at least `bps` below `ref`. */
function droppedBps(c: bigint, ref: bigint, bps: bigint): boolean {
  return c * BPS_DEN <= ref * (BPS_DEN - bps);
}

await runBars({
  onBatch(state, batch) {
    const symbol = state.hello.symbols[0]!.symbol;
    const c = state.close(symbol);
    if (c === null) return [];
    pushClose(c);
    const held = state.positions.get(symbol);
    const orders: OrderInput[] = [];

    if (held !== undefined && held.qty > 0n) {
      if (c > peakClose) peakClose = c;
      const trendGone = closes.length >= SLOW && !uptrend();
      const trailed = entryClose !== null && droppedBps(c, peakClose, TRAIL_BPS);
      const stopped = entryClose !== null && droppedBps(c, entryClose, STOP_BPS);
      if (trendGone || trailed || stopped) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryClose = null;
        peakClose = 0n;
        reenterFrom = batch.seq + COOLDOWN_BARS;
      }
      return orders;
    }

    if (state.cash <= 0n) return [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (state.cash < minNotional) return [];

    const trendEntry =
      closes.length >= SLOW &&
      batch.seq < NO_ENTRY_AFTER &&
      batch.seq >= reenterFrom &&
      uptrend() &&
      aboveFast(c);
    const fallback = !traded && batch.seq >= FALLBACK_BAR;

    if (trendEntry || fallback) {
      orders.push({ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entryClose = c;
      peakClose = c;
      traded = true;
    }
    return orders;
  },
});
