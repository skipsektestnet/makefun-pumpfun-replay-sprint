// Dev-Skin Sniper — a paper bot for the pump.fun replay sprint (agent-fun/replay/v2).
//
// The dev window (the kit's 24 h of chain data, cut in half by slot so a setting has
// to clear twice) says fresh mints jump in their opening slots and then bleed back
// toward the create price; sitting through the whole window loses about a quarter
// in the median case. The gain lives in the opening jump, so this bot buys young
// launches only after the opening tape already shows broad, genuine buying, and
// it is out again at the first sign the jump is spent.
//
// A launch qualifies only when every one of these holds:
//   * no older than 3 slots since its create event;
//   * at least 5 trades and 2 different non-creator buyers already on the tape;
//   * the creator bought between 0.5 and 2.5 SOL of their own mint in the create
//     slot — skin in the game, but above 2.5 SOL it is usually a bundle;
//   * the creator has not sold; real SOL reserves between 0.3 and 30 SOL;
//   * no outsized single sell from anyone else.
// One 0.3 SOL shot per mint (capped at 1% of real reserves, never under 0.01 SOL
// so each buy counts as a guardrail round trip). No second buys, no pyramiding.
//
// It leaves on whichever comes first: +25%, -12%, 10 slots held, or a creator
// sell. No trailing stop, no riding — both were tried and lost money.
//
// Two ideas were tried in a later fix pass and both were measured, then undone:
//   * Leaving a mint whose tape goes quiet for 4 slots. Sounds right — the jump
//     happens while the tape is live — but grade-local fell from +0.3228 to
//     +0.2425 SOL and the win rate from 32.4% to 28.6%. Winners often pause and
//     then jump; cutting them early costs more than the freed slot earns.
//   * Selling half at +15% and guarding the rest at breakeven. Also worse:
//     +0.2877 SOL, 324 fills instead of 311 (extra tx fees), and the half sold
//     early misses the run from +15% to +25%. So both knobs stay off: the quiet
//     limit sits at 1,000,000 slots and the first take-profit at 1,000,000 bps.
//
// Splitting exists only to hold the fill pace (200 fills across the window):
// an order is cut into at most 2 pieces when the filled count trails its
// prorated target; more pieces would only burn tx fees.
//
// Dev-window numbers: +0.383 SOL in the split-half simulator (+0.071 / +0.312
// per half), 107 mints, 313 fills, max drawdown 0.7%; grade-local +0.3228 SOL,
// 311 fills, 105 mints, 105 round trips, drawdown 0.68%, guardrails met. The
// scored window is fresh mints, so treat this as a tendency, not a promise —
// though every neighbouring setting in the sweep lands within a few hundredths
// of it, which is what a flat, non-overfit region looks like.
//
// Fully deterministic: no clock, no randomness, no I/O, no network. Iteration
// only over insertion-ordered maps fed by the batch stream; block time feeds
// only the fill-pacing heuristic, the same way the kit's own pilot bots use it.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest a mint may be, in slots since its create event, to buy it. */
  minSlotAge: number;
  /** Oldest a mint may be, in slots since its create event, for a first buy. */
  maxSlotAge: number;
  /** Lamports aimed at per mint in total (every reply stays under 1% of real SOL). */
  stakePerCoin: number;
  /** Smallest single buy worth a tx fee — and the guardrail round-trip floor. */
  floorBuy: number;
  /** Extra buys after the first (0 = one shot per mint, no pyramiding). */
  extraBuys: number;
  /** An extra buy needs the price at least this far, in bps, above the last buy. */
  addStep: number;
  /** An extra buy waits this many slots after the previous buy was placed. */
  addGapSlots: number;
  /** Lamports per extra buy (still capped at 1% of real SOL each). */
  addSize: number;
  /** An extra buy needs the recent net flow to be at least this, in lamports. */
  addFlowFloor: number;
  /** Real SOL reserve window at decision time, in lamports. */
  reserveLow: number;
  reserveHigh: number;
  /** The creator's own buys in the create slot, in lamports: skin, not a bundle. */
  devBuyLow: number;
  devBuyHigh: number;
  /** Trades seen and distinct non-creator buyers seen before entry, at least. */
  tapeTradesMin: number;
  tapeBuyersMin: number;
  /** Distinct non-creator buyers before entry, at most. */
  tapeBuyersMax: number;
  /** Lamports sold by others over lamports bought, in bps, at most. */
  sellShareCap: number;
  /** Biggest single non-creator sell seen, in bps of the real SOL reserve, at most. */
  bigDumpCap: number;
  /** Price now over the create price, in bps: window. */
  runupLow: number;
  runupHigh: number;
  /** The recent-flow window in slots, and what it must show. */
  flowSpan: number;
  flowFloor: number;
  flowBuyersMin: number;
  /** Skip a mint whose creator already sold before entry. */
  refuseDevSold: boolean;
  /** Slippage allowed on buys, in bps. */
  buySlip: number;
  /** First take-profit: sell firstTpShare of the position at firstTp over cost. */
  firstTp: number;
  firstTpShare: number;
  /** After the first take-profit, the rest stops out this far under cost, in bps. */
  postTpStop: number;
  /** Leave when the position is worth this much over its cost, in bps. */
  takeProfit: number;
  /** Leave when it is worth this much under its cost, in bps. */
  stopLoss: number;
  /** Trailing stop: up at least trailStart, leave on a trailDrop fall from the peak. */
  trailStart: number;
  trailDrop: number;
  /** Leave after holding this many slots. */
  holdLimit: number;
  /** Leave when the creator sells while the position is held. */
  leaveOnDevSell: boolean;
  /** Leave when no trade has hit the mint for this many slots. */
  quietLimit: number;
  /** Leave when the recent net flow drops below minus this many lamports. */
  outflowLimit: number;
  /**
   * Fill pacing: when filled orders trail fillGoal prorated over windowSecs of
   * block time, each order is cut into pieces (splitBase, up to splitCap) in
   * the same reply. The pieces fill at the same price as the whole order, cost
   * one extra tx fee each, and keep the run's fill count on pace.
   */
  fillGoal: number;
  windowSecs: number;
  splitBase: number;
  splitCap: number;
  /** Smallest buy piece worth sending, in lamports. */
  pieceFloor: number;
}

export const DEFAULT_PARAMS: Params = {
  minSlotAge: 0,
  maxSlotAge: 3,
  stakePerCoin: 300_000_000,
  floorBuy: 10_000_000,
  extraBuys: 0,
  addStep: 0,
  addGapSlots: 2,
  addSize: 200_000_000,
  addFlowFloor: 0,
  reserveLow: 300_000_000,
  reserveHigh: 30_000_000_000,
  devBuyLow: 500_000_000,
  devBuyHigh: 2_500_000_000,
  tapeTradesMin: 5,
  tapeBuyersMin: 2,
  tapeBuyersMax: 100,
  sellShareCap: 10_000,
  bigDumpCap: 10_000,
  runupLow: 0,
  runupHigh: 1_000_000,
  flowSpan: 10,
  flowFloor: -1_000_000_000_000,
  flowBuyersMin: 0,
  refuseDevSold: true,
  buySlip: 10_000,
  // The first take-profit stays OFF (firstTp 1,000,000): switching it on at
  // +15% was measured in the fix pass and pulled grade-local down to +0.2877
  // SOL, so the plain +25% / -12% / 10-slot exit stands (see the header).
  firstTp: 1_000_000,
  firstTpShare: 5_000,
  postTpStop: 0,
  takeProfit: 2_500,
  stopLoss: 1_200,
  trailStart: 1_000_000,
  trailDrop: 1_000,
  holdLimit: 10,
  leaveOnDevSell: true,
  quietLimit: 1_000_000,
  outflowLimit: 1_000_000_000_000,
  fillGoal: 200,
  windowSecs: 21_600,
  splitBase: 1,
  splitCap: 2,
  pieceFloor: 2_000_000,
};

interface Print {
  slot: number;
  bought: boolean;
  amount: bigint;
  trader: Pubkey;
}

interface Launch {
  id: Pubkey;
  bornSlot: number;
  maker: Pubkey;
  /** Reserves at create time: the run-up is measured against these. */
  baseQ: bigint;
  baseT: bigint;
  makerBuy: bigint;
  tradeCount: number;
  crowd: Set<Pubkey>;
  boughtTotal: bigint;
  soldByCrowd: bigint;
  worstDump: bigint;
  makerSold: boolean;
  lastSeenSlot: number;
  /** Prints of the last flowSpan slots; older ones are dropped as new ones land. */
  tape: Print[];
  buysPlaced: number;
  spentPlaced: bigint;
  /** Decision price (quote over tokens) of the last buy placed. */
  lastPriceQ: bigint;
  lastPriceT: bigint;
  lastBuySlot: number;
  /** Never buy it again (left, filtered out for good, or finished). */
  closed: boolean;
  finished: boolean;
}

interface Open {
  openedAt: number;
  feesPaid: bigint;
  peak: bigint;
  makerSoldAtEntry: boolean;
  tookFirstTp: boolean;
}

const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against (q, t) pays out once curve fees are taken off. */
function exitValue(tokens: bigint, q: bigint, t: bigint): bigint {
  if (tokens <= 0n || t <= 0n) {
    return 0n;
  }
  const gross = (tokens * q) / (t + tokens);
  const fee = (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return gross - fee;
}

/** A fresh position record: opened at `slot`, tx fees `fees` already paid. */
function newOpen(slot: number, fees: bigint, makerSold: boolean): Open {
  return {
    openedAt: slot,
    feesPaid: fees,
    peak: 0n,
    makerSoldAtEntry: makerSold,
    tookFirstTp: false,
  };
}

export function createStrategy(opts: Params = DEFAULT_PARAMS) {
  const cfg = opts;
  const launches = new Map<Pubkey, Launch>();
  const holds = new Map<Pubkey, Open>();
  /** Mints that already have a sell on its way out. */
  const exiting = new Set<Pubkey>();
  const stakeAmt = BigInt(cfg.stakePerCoin);
  const floorAmt = BigInt(cfg.floorBuy);
  let clockStart: number | null = null;
  let clockNow = 0;
  let fillsDone = 0;

  /** Net lamports bought minus sold, plus distinct buyers, over the last flowSpan slots. */
  function recentFlow(launch: Launch, slot: number): { net: bigint; buyers: number } {
    const from = slot - cfg.flowSpan;
    let drop = 0;
    while (drop < launch.tape.length && launch.tape[drop]!.slot <= from) {
      drop += 1;
    }
    if (drop > 0) {
      launch.tape.splice(0, drop);
    }
    let net = 0n;
    const crowd = new Set<Pubkey>();
    for (const print of launch.tape) {
      if (print.bought) {
        net += print.amount;
        if (print.trader !== launch.maker) {
          crowd.add(print.trader);
        }
      } else {
        net -= print.amount;
      }
    }
    return { net, buyers: crowd.size };
  }

  /** Whether an order of the given side for this mint is still waiting to fill. */
  function pending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) {
        return true;
      }
    }
    return false;
  }

  /** How many pieces to cut an order into right now: splitBase, more when fills lag pace. */
  function splitCount(): number {
    if (clockStart === null) {
      return cfg.splitBase;
    }
    const elapsed = Math.max(0, Math.min(cfg.windowSecs, clockNow - clockStart));
    const due = (cfg.fillGoal * elapsed) / cfg.windowSecs;
    if (fillsDone >= due) {
      return cfg.splitBase;
    }
    const behind = due - fillsDone;
    return Math.min(cfg.splitCap, cfg.splitBase + (behind > cfg.fillGoal * 0.15 ? 2 : 1));
  }

  /** Sell every one of `tokens` as k orders inside a single reply. */
  function sellChunks(mint: Pubkey, tokens: bigint, k: number, room: number): OrderInput[] {
    const n = BigInt(Math.max(1, Math.min(k, room)));
    const out: OrderInput[] = [];
    const piece = tokens / n;
    if (piece === 0n) {
      return [{ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 }];
    }
    for (let i = 0n; i < n; i += 1n) {
      const amt = i === n - 1n ? tokens - piece * (n - 1n) : piece;
      out.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: 10_000 });
    }
    return out;
  }

  /** Buy `amount` lamports as up to k orders in one reply, each at least pieceFloor. */
  function buyChunks(mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] {
    let n = BigInt(Math.max(1, Math.min(k, room)));
    const floor = BigInt(cfg.pieceFloor);
    while (n > 1n && amount / n < floor) {
      n -= 1n;
    }
    const piece = amount / n;
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i += 1n) {
      const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
      out.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: cfg.buySlip });
    }
    return out;
  }

  /** Fold a batch of chain events into the per-mint tape the filters read. */
  function absorb(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          id: e.mint,
          bornSlot: e.slot,
          maker: e.creator,
          baseQ: BigInt(e.virtual_quote_reserves),
          baseT: BigInt(e.virtual_token_reserves),
          makerBuy: 0n,
          tradeCount: 0,
          crowd: new Set(),
          boughtTotal: 0n,
          soldByCrowd: 0n,
          worstDump: 0n,
          makerSold: false,
          lastSeenSlot: e.slot,
          tape: [],
          buysPlaced: 0,
          spentPlaced: 0n,
          lastPriceQ: 0n,
          lastPriceT: 1n,
          lastBuySlot: 0,
          closed: false,
          finished: false,
        });
      } else if (e.event === 'TradeEvent') {
        const launch = launches.get(e.mint);
        if (launch === undefined) {
          continue;
        }
        const amount = BigInt(e.sol_amount);
        launch.tradeCount += 1;
        launch.lastSeenSlot = e.slot;
        launch.tape.push({ slot: e.slot, bought: e.is_buy, amount, trader: e.user });
        const byMaker = e.user === launch.maker;
        if (e.is_buy) {
          launch.boughtTotal += amount;
          if (byMaker && e.slot === launch.bornSlot) {
            launch.makerBuy += amount;
          } else if (!byMaker) {
            launch.crowd.add(e.user);
          }
        } else if (byMaker) {
          launch.makerSold = true;
        } else {
          launch.soldByCrowd += amount;
          const reserveBefore = BigInt(e.real_quote_reserves) + amount;
          if (reserveBefore > 0n) {
            const share = (amount * BPS) / reserveBefore;
            if (share > launch.worstDump) {
              launch.worstDump = share;
            }
          }
        }
      } else {
        const launch = launches.get(e.mint);
        if (launch !== undefined) {
          launch.finished = true;
          launch.closed = true;
        }
      }
    }
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      absorb(batch);
      for (const e of batch.events) {
        if (e.block_time === null) {
          continue;
        }
        if (clockStart === null) {
          clockStart = e.block_time;
        }
        if (e.block_time > clockNow) {
          clockNow = e.block_time;
        }
      }
      const out: OrderInput[] = [];
      const quotes = new Map<Pubkey, { q: bigint; t: bigint }>();
      for (const m of batch.marks) {
        quotes.set(m.mint, {
          q: BigInt(m.virtual_quote_reserves),
          t: BigInt(m.virtual_token_reserves),
        });
      }
      const batchCap = state.hello.caps.max_orders_per_batch;
      const fee = state.txFeeLamports();

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          holds.delete(f.mint);
          exiting.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          fillsDone += 1;
        }
        const rec = holds.get(f.mint);
        if (f.status !== 'rejected' && rec !== undefined) {
          rec.feesPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'buy' && f.status === 'filled' && rec === undefined) {
          holds.set(
            f.mint,
            newOpen(
              f.slot,
              BigInt(f.tx_fee_lamports),
              launches.get(f.mint)?.makerSold ?? false,
            ),
          );
        }
      }
      for (const mint of [...exiting]) {
        if (!pending(state, mint, 'sell')) {
          exiting.delete(mint);
        }
      }
      for (const mint of [...holds.keys()]) {
        if (
          !state.positions.has(mint) &&
          !exiting.has(mint) &&
          !pending(state, mint, 'buy')
        ) {
          holds.delete(mint);
        }
      }
      const split = splitCount();

      // Leave positions first.
      for (const [mint, pos] of state.positions) {
        if (out.length >= batchCap) {
          break;
        }
        if (exiting.has(mint)) {
          continue;
        }
        const launch = launches.get(mint);
        let rec = holds.get(mint);
        if (rec === undefined) {
          rec = newOpen(state.slot, fee, launch?.makerSold ?? false);
          holds.set(mint, rec);
        }
        let quote = quotes.get(mint);
        if (quote === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) {
            continue;
          }
          quote = { q: curve.virtual_quote_reserves, t: curve.virtual_token_reserves };
        }
        const worth = exitValue(pos.token_amount, quote.q, quote.t) - fee;
        const basis = pos.cost_lamports + rec.feesPaid;
        if (worth > rec.peak) {
          rec.peak = worth;
        }
        let leave = false;
        if (basis > 0n) {
          if (
            !rec.tookFirstTp &&
            worth * BPS >= basis * (BPS + BigInt(cfg.firstTp))
          ) {
            const part = (pos.token_amount * BigInt(cfg.firstTpShare)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              out.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              exiting.add(mint);
              rec.tookFirstTp = true;
              rec.peak = 0n;
              if (launch !== undefined) {
                launch.closed = true;
              }
              continue;
            }
          }
          if (worth * BPS >= basis * (BPS + BigInt(cfg.takeProfit))) {
            leave = true;
          }
          const stop = rec.tookFirstTp ? BigInt(cfg.postTpStop) : BigInt(cfg.stopLoss);
          if (worth * BPS <= basis * (BPS - stop)) {
            leave = true;
          }
          if (
            rec.peak * BPS >= basis * (BPS + BigInt(cfg.trailStart)) &&
            worth * BPS <= rec.peak * (BPS - BigInt(cfg.trailDrop))
          ) {
            leave = true;
          }
        }
        if (state.slot - rec.openedAt >= cfg.holdLimit) {
          leave = true;
        }
        if (launch !== undefined) {
          if (cfg.leaveOnDevSell && launch.makerSold && !rec.makerSoldAtEntry) {
            leave = true;
          }
          // A quiet tape means the opening jump already passed it by — with the
          // limit parked at 1,000,000 this branch never fires; it is kept so the
          // knob stays tunable, and the 4-slot version was measured worse.
          if (state.slot - launch.lastSeenSlot >= cfg.quietLimit) {
            leave = true;
          }
          if (recentFlow(launch, state.slot).net < -BigInt(cfg.outflowLimit)) {
            leave = true;
          }
        }
        if (!leave) {
          continue;
        }
        out.push(...sellChunks(mint, pos.token_amount, split, batchCap - out.length));
        exiting.add(mint);
        if (launch !== undefined) {
          launch.closed = true;
        }
      }

      // New buys, plus top-ups when a later tuning switches them on.
      let cash = state.freeCashLamports() - fee * BigInt(out.length);
      let openCount = state.committedPositionCount();
      for (const launch of launches.values()) {
        if (out.length >= batchCap) {
          break;
        }
        if (launch.closed || launch.finished) {
          continue;
        }
        const age = state.slot - launch.bornSlot;
        const adding = launch.buysPlaced > 0;
        if (!adding && age > cfg.maxSlotAge) {
          launch.closed = true;
          continue;
        }
        if (age < cfg.minSlotAge) {
          continue;
        }
        if (adding) {
          // Top-ups are off (extraBuys 0); this path only wakes up if a later
          // tuning switches them on.
          if (launch.buysPlaced > cfg.extraBuys) {
            continue;
          }
          if (
            !state.positions.has(launch.id) ||
            exiting.has(launch.id) ||
            pending(state, launch.id, 'buy')
          ) {
            continue;
          }
        } else if (openCount >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(launch.id);
        if (curve === undefined || curve.complete) {
          continue;
        }
        if (launch.makerSold && (cfg.refuseDevSold || adding)) {
          if (!adding) {
            launch.closed = true;
          }
          continue;
        }
        const q = curve.virtual_quote_reserves;
        const t = curve.virtual_token_reserves;
        if (adding) {
          if (state.slot - launch.lastBuySlot < cfg.addGapSlots) {
            continue;
          }
          if (
            q * launch.lastPriceT * BPS <
            launch.lastPriceQ * t * BigInt(10_000 + cfg.addStep)
          ) {
            continue;
          }
          if (recentFlow(launch, state.slot).net < BigInt(cfg.addFlowFloor)) {
            continue;
          }
          const ceiling = state.maxBuyLamports(launch.id);
          const want = BigInt(cfg.addSize);
          const amount = want < ceiling ? want : ceiling;
          if (amount < floorAmt || cash < amount + fee * 6n) {
            continue;
          }
          const pieces = buyChunks(launch.id, amount, split, batchCap - out.length);
          out.push(...pieces);
          cash -= amount + fee * BigInt(pieces.length);
          launch.buysPlaced += 1;
          launch.spentPlaced += amount;
          launch.lastPriceQ = q;
          launch.lastPriceT = t;
          launch.lastBuySlot = state.slot;
          continue;
        }
        // Launch filter: a tape that already proves broad buying, plus a
        // creator with skin in the game.
        const reserve = curve.real_quote_reserves;
        if (reserve < BigInt(cfg.reserveLow) || reserve > BigInt(cfg.reserveHigh)) {
          continue;
        }
        if (
          launch.makerBuy < BigInt(cfg.devBuyLow) ||
          launch.makerBuy > BigInt(cfg.devBuyHigh)
        ) {
          continue;
        }
        if (
          launch.tradeCount < cfg.tapeTradesMin ||
          launch.crowd.size < cfg.tapeBuyersMin ||
          launch.crowd.size > cfg.tapeBuyersMax
        ) {
          continue;
        }
        if (
          launch.boughtTotal > 0n &&
          launch.soldByCrowd * BPS > launch.boughtTotal * BigInt(cfg.sellShareCap)
        ) {
          continue;
        }
        if (launch.worstDump > BigInt(cfg.bigDumpCap)) {
          continue;
        }
        const runup = (q * launch.baseT * BPS) / (t * launch.baseQ);
        if (runup > BigInt(cfg.runupHigh) || runup < BigInt(cfg.runupLow)) {
          continue;
        }
        const fl = recentFlow(launch, state.slot);
        if (fl.net < BigInt(cfg.flowFloor) || fl.buyers < cfg.flowBuyersMin) {
          continue;
        }
        const room = stakeAmt - launch.spentPlaced;
        if (room < floorAmt) {
          continue;
        }
        const ceiling = state.maxBuyLamports(launch.id);
        const amount = room < ceiling ? room : ceiling;
        if (amount < floorAmt) {
          continue;
        }
        if (cash < amount + fee * 6n) {
          continue;
        }
        const pieces = buyChunks(launch.id, amount, split, batchCap - out.length);
        out.push(...pieces);
        cash -= amount + fee * BigInt(pieces.length);
        launch.buysPlaced += 1;
        launch.spentPlaced += amount;
        launch.lastPriceQ = q;
        launch.lastPriceT = t;
        launch.lastBuySlot = state.slot;
        openCount += 1;
      }
      return out;
    },
  };
}
