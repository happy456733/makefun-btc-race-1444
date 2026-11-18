// Hourglass momentum bot for make.fun btc-race-24h-20261118-1444.
//
// Idea (from my own analysis of this kit's dev window, 1,440 one-minute
// cbBTC/USDC bars): one-minute returns are near-noise (stdev ~7 bps) and
// 30-minute momentum mean-reverts, but 60-minute momentum persists — after a
// 60-minute rise of 40+ bps the next hour averages about +25 bps. So this bot
// trades rarely and only on that slow signal: it buys with all its cash when
// the 60-minute close-to-close return tops 30 bps, then rides the move with
// a 70 bps trailing stop below the highest close since entry, plus a hard
// 150 bps stop against its entry cost. In a falling or choppy window it
// mostly sits in cash, which is what a long-only bot has to do there.
//
// Costs matter: a full-size round trip pays ~26-32 bps (4 bps fee + 2 bps
// slippage each way, plus pool impact), so a trade has to catch a move well
// bigger than that. The 60-minute entry filter and the wide trailing stop
// are what keep the trade count low and the winners long.
//
// Deterministic: every decision is integer arithmetic on the closes the
// harness has sent; no clock, no randomness, no network, no files.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry: 60-minute close-to-close return above this (basis points).
const ENTRY_WINDOW = 60;
const ENTRY_BPS = 30n;
// Exit: trailing stop, basis points below the highest close since entry.
const TRAIL_BPS = 70n;
// Exit: hard stop, basis points below the position's average entry cost.
const STOP_BPS = 150n;
// Slippage guard on every order: fills move far less than this per minute.
const MAX_SLIPPAGE_BPS = 500;

const BPS = 10_000n;

/** True when (a - b) / b exceeds `bps` basis points, in exact integers. */
function upMoreThan(a: bigint, b: bigint, bps: bigint): boolean {
  return (a - b) * BPS > bps * b;
}

/** True when (b - a) / b exceeds `bps` basis points, in exact integers. */
function downMoreThan(a: bigint, b: bigint, bps: bigint): boolean {
  return (b - a) * BPS > bps * b;
}

// ---------------------------------------------------------------- strategy

/** Closes seen so far, oldest first; only bars that actually carried CBBTC. */
const closes: bigint[] = [];
/** Highest close since the current position was opened (0 when flat). */
let peakClose = 0n;

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined) return [];
  const close = BigInt(bar.c);
  closes.push(close);
  if (closes.length > ENTRY_WINDOW + 1) closes.shift();

  const held = state.positions.get(SYMBOL);
  const qty = held?.qty ?? 0n;

  if (qty === 0n) {
    // Flat: enter only on a strong 60-minute rise.
    if (closes.length <= ENTRY_WINDOW) return [];
    const ref = closes[closes.length - 1 - ENTRY_WINDOW]!;
    if (!upMoreThan(close, ref, ENTRY_BPS)) return [];
    if (state.cash <= 0n) return [];
    peakClose = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  // Holding: track the peak, exit on the trailing stop or the hard stop.
  if (close > peakClose) peakClose = close;
  if (downMoreThan(close, peakClose, TRAIL_BPS)) {
    peakClose = 0n;
    return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  // Average entry price implied by the position cost: value = qty * price / 10^7
  // (qty_scale 8 + price_scale 5 - quote_scale 6), so price = cost * 10^7 / qty.
  const cost = held?.cost ?? 0n;
  if (cost > 0n) {
    const entryPrice = (cost * 10_000_000n) / qty;
    if (downMoreThan(close, entryPrice, STOP_BPS)) {
      peakClose = 0n;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  return [];
}

await runBars({ onBatch });
