const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
dns.setDefaultResultOrder('ipv4first');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { exec } = require('child_process');
const mongoose = require('mongoose');
const {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateATR,
  calculateRVOL,
  calculateSlope,
  checkBreakouts,
  calculateADX
} = require('./utils/indicators');
const StateModel = require('./models/State');
const MarketDataModel = require('./models/MarketData');
const os = require('os');

const FALLBACK_WATCHLIST_FILE = path.join(__dirname, 'data', 'watchlist_fallback.json');

const DEFAULT_WATCHLIST = [
  { symbol: 'GOLDBEES.NS', name: 'Nippon India ETF Gold BeES', sector: 'Precious Metals', cap: 'ETF' },
  { symbol: 'SILVERBEES.NS', name: 'Nippon India ETF Silver BeES', sector: 'Precious Metals', cap: 'ETF' },
  { symbol: 'RELIANCE.NS', name: 'Reliance Industries', sector: 'Energy & Conglomerate', cap: 'Large Cap' },
  { symbol: 'TCS.NS', name: 'Tata Consultancy Services', sector: 'IT Services', cap: 'Large Cap' },
  { symbol: 'HDFCBANK.NS', name: 'HDFC Bank Ltd', sector: 'Banking & Financials', cap: 'Large Cap' },
  { symbol: 'INFY.NS', name: 'Infosys Ltd', sector: 'IT Services', cap: 'Large Cap' },
  { symbol: 'SBIN.NS', name: 'State Bank of India', sector: 'Banking & Financials', cap: 'Large Cap' }
];

const WATCHLIST = [];
let inMemoryState = null;
let inMemoryMarketData = null; // In-memory runtime cache: { lastUpdated: String, watchlist: Array, data: Object }

function loadWatchlist() {
  // 1. Try from in-memory cache
  if (inMemoryMarketData?.watchlist?.length > 0) {
    WATCHLIST.length = 0;
    WATCHLIST.push(...inMemoryMarketData.watchlist);
    console.log(`Loaded ${WATCHLIST.length} assets from in-memory watchlist.`);
    return;
  }

  // 2. Try loading from fallback watchlist file
  if (fs.existsSync(FALLBACK_WATCHLIST_FILE)) {
    try {
      const list = JSON.parse(fs.readFileSync(FALLBACK_WATCHLIST_FILE, 'utf8'));
      if (Array.isArray(list) && list.length > 0) {
        WATCHLIST.length = 0;
        WATCHLIST.push(...list);
        console.log(`Loaded ${WATCHLIST.length} assets from fallback watchlist file.`);
        return;
      }
    } catch (e) {
      console.warn("Failed to load fallback watchlist file:", e.message);
    }
  }

  // 3. Fall back to minimal hardcoded default
  WATCHLIST.length = 0;
  WATCHLIST.push(...DEFAULT_WATCHLIST);
  console.log(`Using default boot watchlist with ${WATCHLIST.length} assets.`);
}

// Initialize watchlist on boot
loadWatchlist();

// Default initial state starting July 1, 2026
const INITIAL_STATE = {
  lastSimulationDate: '2026-07-01',
  cash: 100000.0,
  holdings: [],
  history: [],
  valuationHistory: [
    {
      date: '2026-07-01',
      cash: 100000.0,
      holdingsValue: 0.0,
      totalValue: 100000.0,
      profitPercent: 0.0,
      totalDeposited: 100000.0
    }
  ],
  logs: [
    {
      date: '2026-07-01',
      sentiment: 'NEUTRAL',
      text: "Quant Sentinal Aggressive Trading System online. Initial capital of ₹1,00,000 deposited. Objective: Target 15%-20% annualized returns using momentum breakouts and oversold rebounds. Current simulation baseline set to 2026-07-01. Ready for market scanning and execution."
    }
  ],
  config: {
    targetProfitPercent: 0.25, // +25.0% baseline with dynamic uncapped trailing runner
    stopLossPercent: 0.048,    // -4.8% strict risk-managed stop loss (eliminates large drawdowns)
    maxPositions: 10,          // 10 concentrated positions (~10%-12% each) to maximize compounding & reduce cash drag
    aggressiveness: 'aggressive', // conservative, moderate, aggressive, hyper
    rotationEnabled: false,     // Disabled: do not rotate out positions
    rotationMinCandidateScore: 88, // High-conviction entry threshold for rotation
    rotationMaxUnderperformerProfit: 2.0 // Rotates out positions performing below +2.0%
  }
};

let inMemoryLiveState = null;

function getDbKey(portfolioType) {
  return (portfolioType === 'live') ? 'live_portfolio_state' : 'simulation_state';
}

// Load current state for specified portfolio (backtest vs live)
async function loadState(portfolioType = 'backtest') {
  const isLive = (portfolioType === 'live');
  const key = getDbKey(portfolioType);

  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    try {
      let doc = await StateModel.findOne({ key }).lean();
      if (doc) {
        doc.portfolioType = isLive ? 'live' : 'backtest';
        if (isLive) inMemoryLiveState = doc;
        else inMemoryState = doc;
        return doc;
      }
    } catch (e) {
      console.warn(`MongoDB read failed for ${key}:`, e.message);
    }
  }

  if (isLive) {
    if (inMemoryLiveState) return inMemoryLiveState;
    return await initLivePortfolio();
  }

  if (inMemoryState) {
    return inMemoryState;
  }

  return await resetSimulation('2025-10-01', 'backtest');
}

// Save state for specified portfolio
async function saveState(state, portfolioType) {
  const pType = portfolioType || state?.portfolioType || 'backtest';
  state.portfolioType = pType;
  const isLive = (pType === 'live');
  const key = getDbKey(pType);

  if (isLive) inMemoryLiveState = { ...state };
  else inMemoryState = { ...state };

  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    try {
      const stateData = { ...state };
      delete stateData._id;
      delete stateData.key;

      await StateModel.findOneAndUpdate(
        { key },
        { $set: stateData },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (e) {
      console.error(`Error saving ${key} to MongoDB:`, e.message);
    }
  }
}

// Initialize clean live forward portfolio with ₹1,00,000 cash starting today
async function initLivePortfolio() {
  const latestDate = getLatestCompletedMarketDate() || '2026-10-01';
  let activeConfig = INITIAL_STATE.config;
  if (inMemoryState && inMemoryState.config) {
    activeConfig = { ...INITIAL_STATE.config, ...inMemoryState.config };
  }

  const liveState = {
    ...JSON.parse(JSON.stringify(INITIAL_STATE)),
    portfolioType: 'live',
    config: activeConfig,
    lastSimulationDate: latestDate,
    cash: 100000.0,
    holdings: [],
    history: [],
    valuationHistory: [
      {
        date: latestDate,
        cash: 100000.0,
        holdingsValue: 0.0,
        totalValue: 100000.0,
        profitPercent: 0.0,
        totalDeposited: 100000.0
      }
    ],
    logs: [
      {
        date: latestDate,
        sentiment: 'NEUTRAL',
        text: `Quant Sentinal Live Trading Desk online (${activeConfig.aggressiveness === 'conservative' ? 'Conservative Approach' : 'Aggressive Approach'}). Clean starting capital of ₹1,00,000.00 deposited today (${latestDate}). Ready for forward order placement, live stop-loss tracking, and broker sync.`
      }
    ]
  };

  await saveState(liveState, 'live');
  return liveState;
}

// Reset state
async function resetSimulation(customStartDate, portfolioType = 'backtest') {
  if (portfolioType === 'live') {
    return await initLivePortfolio();
  }

  const startDate = customStartDate || '2025-10-01';
  let activeConfig = INITIAL_STATE.config;
  if (inMemoryState && inMemoryState.config) {
    activeConfig = { ...INITIAL_STATE.config, ...inMemoryState.config };
  } else if (mongoose.connection.readyState === 1) {
    try {
      const doc = await StateModel.findOne({ key: 'simulation_state' }).lean();
      if (doc && doc.config) {
        activeConfig = { ...INITIAL_STATE.config, ...doc.config };
      }
    } catch (_) {}
  }

  const state = {
    ...JSON.parse(JSON.stringify(INITIAL_STATE)),
    portfolioType: 'backtest',
    config: activeConfig,
    lastSimulationDate: startDate,
    cash: 100000.0,
    holdings: [],
    history: [],
    valuationHistory: [
      {
        date: startDate,
        cash: 100000.0,
        holdingsValue: 0.0,
        totalValue: 100000.0,
        profitPercent: 0.0,
        totalDeposited: 100000.0
      }
    ],
    logs: [
      {
        date: startDate,
        sentiment: 'NEUTRAL',
        text: `Quant Sentinal Trading System online (${activeConfig.aggressiveness === 'conservative' ? 'Conservative Approach' : 'Aggressive Approach'}). Initial capital of ₹1,00,000 deposited. Objective: Target 15%-20% annualized returns using momentum breakouts and smart support rebounds. Current simulation baseline set to ${startDate}. Ready for market scanning and execution.`
      }
    ]
  };
  await saveState(state, 'backtest');
  return state;
}

// Execute a live buy order into the live portfolio
async function executeLiveTrade({ symbol, name, sector, quantity, price, stopLoss, targetPrice, reason, date }) {
  const state = await loadState('live');
  const tradeDate = date || state.lastSimulationDate || getLatestCompletedMarketDate();
  const numQty = parseInt(quantity, 10);
  const numPrice = parseFloat(price);
  const cost = numQty * numPrice;

  if (isNaN(numQty) || numQty <= 0 || isNaN(numPrice) || numPrice <= 0) {
    throw new Error("Invalid quantity or price provided for live trade.");
  }

  if (state.cash < cost) {
    throw new Error(`Insufficient live cash balance. Available: ₹${state.cash.toFixed(2)}, Required: ₹${cost.toFixed(2)}`);
  }

  const sl = parseFloat(stopLoss) || (numPrice * (1 - (state.config.stopLossPercent || 0.048)));
  const tp = parseFloat(targetPrice) || (numPrice * (1 + (state.config.targetProfitPercent || 0.25)));

  state.cash -= cost;

  const existingIdx = state.holdings.findIndex(h => h.symbol === symbol);
  if (existingIdx !== -1) {
    const parent = state.holdings[existingIdx];
    const totalQty = parent.quantity + numQty;
    const totalCost = (parent.quantity * parent.buyPrice) + cost;
    const blended = totalCost / totalQty;
    parent.quantity = totalQty;
    parent.buyPrice = blended;
    parent.currentPrice = numPrice;
    parent.value = totalQty * numPrice;
    parent.profit = parent.value - totalCost;
    parent.profitPercent = (parent.profit / totalCost) * 100;
    parent.stopLoss = Math.max(parent.stopLoss || 0, sl);
    parent.targetPrice = tp;
    parent.isAccumulated = true;
  } else {
    state.holdings.push({
      symbol,
      name: name || symbol.replace('.NS', ''),
      sector: sector || 'Equity',
      quantity: numQty,
      buyPrice: numPrice,
      currentPrice: numPrice,
      buyDate: tradeDate,
      targetPrice: tp,
      stopLoss: sl,
      value: cost,
      profit: 0.0,
      profitPercent: 0.0,
      buyReason: reason || 'Live Manual Entry',
      slStatus: 'HARD_STOP'
    });
  }

  let holdingsValue = 0;
  for (const h of state.holdings) holdingsValue += h.value;
  const totalValue = state.cash + holdingsValue;
  const lastVal = state.valuationHistory[state.valuationHistory.length - 1];
  if (lastVal) {
    lastVal.cash = state.cash;
    lastVal.holdingsValue = holdingsValue;
    lastVal.totalValue = totalValue;
    lastVal.profitPercent = ((totalValue - lastVal.totalDeposited) / lastVal.totalDeposited) * 100;
  }

  state.logs.unshift({
    date: tradeDate,
    sentiment: 'BULLISH',
    text: `LIVE BUY EXECUTED: Bought ${numQty}x ${symbol} @ ₹${numPrice.toFixed(2)} (₹${cost.toFixed(0)}). Stop Loss: ₹${sl.toFixed(2)}, Target: ₹${tp.toFixed(2)}.`
  });

  await saveState(state, 'live');
  return state;
}

// Close an active holding in the live portfolio
async function closeLiveTrade({ symbol, price, reason, date }) {
  const state = await loadState('live');
  const idx = state.holdings.findIndex(h => h.symbol === symbol);
  if (idx === -1) {
    throw new Error(`Position ${symbol} not found in live portfolio.`);
  }

  const h = state.holdings[idx];
  const numPrice = parseFloat(price) || h.currentPrice;
  const tradeDate = date || state.lastSimulationDate || getLatestCompletedMarketDate();
  const proceeds = h.quantity * numPrice;
  const cost = h.quantity * h.buyPrice;
  const pnl = proceeds - cost;
  const pnlPct = (pnl / cost) * 100;

  state.cash += proceeds;
  state.holdings.splice(idx, 1);

  state.history.unshift({
    symbol: h.symbol,
    name: h.name,
    sector: h.sector,
    quantity: h.quantity,
    buyPrice: h.buyPrice,
    sellPrice: numPrice,
    buyDate: h.buyDate,
    sellDate: tradeDate,
    profit: pnl,
    profitPercent: pnlPct,
    reason: reason || 'Live Manual Exit'
  });

  let holdingsValue = 0;
  for (const pos of state.holdings) holdingsValue += pos.value;
  const totalValue = state.cash + holdingsValue;
  const lastVal = state.valuationHistory[state.valuationHistory.length - 1];
  if (lastVal) {
    lastVal.cash = state.cash;
    lastVal.holdingsValue = holdingsValue;
    lastVal.totalValue = totalValue;
    lastVal.profitPercent = ((totalValue - lastVal.totalDeposited) / lastVal.totalDeposited) * 100;
  }

  state.logs.unshift({
    date: tradeDate,
    sentiment: pnl >= 0 ? 'BULLISH' : 'BEARISH',
    text: `LIVE POSITION CLOSED: Sold ${h.quantity}x ${symbol} @ ₹${numPrice.toFixed(2)}. P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%). Reason: ${reason || 'Manual Exit'}.`
  });

  await saveState(state, 'live');
  return state;
}

// Helper to format date as YYYY-MM-DD in UTC timezone (matching Yahoo's trading calendar)
function formatUTCDate(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

let activeUpdatePromise = null;

function hasBarsForRange(dataObj, minStartDate, targetEndDate) {
  if (!dataObj || typeof dataObj !== 'object') return false;
  const testSymbols = ['RELIANCE.NS', 'NIFTYBEES.NS', '^NSEI', 'HDFCBANK.NS', 'TCS.NS', 'INFY.NS'];
  for (const sym of testSymbols) {
    const bars = dataObj[sym];
    if (bars && Array.isArray(bars) && bars.length > 0) {
      const firstBarDate = bars[0].date;
      const lastBarDate = bars[bars.length - 1].date;
      // Allow up to 4 calendar days gap for weekends and official exchange holidays (e.g. Gandhi Jayanti + weekend)
      const daysDiffEnd = targetEndDate
        ? (new Date(targetEndDate) - new Date(lastBarDate)) / (1000 * 60 * 60 * 24)
        : 0;
      const coversEnd = !targetEndDate || lastBarDate >= targetEndDate || (daysDiffEnd >= 0 && daysDiffEnd <= 4);
      const coversStart = !minStartDate || firstBarDate <= minStartDate;
      if (coversEnd && coversStart) return true;
    }
  }
  return false;
}

// Return the latest completed trading session date in market data <= candidateDate
function getLatestCompletedMarketDate(candidateDate) {
  const data = inMemoryMarketData?.data;
  if (!data) return candidateDate;
  const bench = data['^NSEI'] || data['NIFTYBEES.NS'] || data['RELIANCE.NS'];
  if (!bench || bench.length === 0) return candidateDate;
  if (!candidateDate) return bench[bench.length - 1].date;
  const filtered = bench.filter(b => b.date <= candidateDate);
  if (filtered.length > 0) {
    return filtered[filtered.length - 1].date;
  }
  return candidateDate;
}

// Fetch and Store Yahoo Finance Data via Python yfinance helper script into in-memory runtime cache

async function updateCache(endDateStr, forceRefresh = false, minStartDateStr = null) {
  const todayStr = formatUTCDate(new Date());

  // 1. Check in-memory market data first (ensure it contains both start and target bars)
  if (
    !forceRefresh &&
    inMemoryMarketData &&
    inMemoryMarketData.data &&
    Object.keys(inMemoryMarketData.data).length > 0 &&
    hasBarsForRange(inMemoryMarketData.data, minStartDateStr, endDateStr)
  ) {
    return inMemoryMarketData.data;
  }

  // 2. Check MongoDB MarketData collection before running Python fetch (ensure it contains both bars)
  if (!forceRefresh && mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const doc = await MarketDataModel.findOne({ key: 'daily_bars' }).lean();
      if (
        doc &&
        doc.data &&
        Object.keys(doc.data).length > 0 &&
        hasBarsForRange(doc.data, minStartDateStr, endDateStr)
      ) {
        inMemoryMarketData = doc;
        if (doc.watchlist && Array.isArray(doc.watchlist) && doc.watchlist.length > 0) {
          WATCHLIST.length = 0;
          WATCHLIST.push(...doc.watchlist);
        }
        console.log(`Loaded live market data for ${Object.keys(doc.data).length} symbols from MongoDB cache.`);
        return doc.data;
      }
    } catch (e) {
      console.warn("MongoDB MarketData cache read warning:", e.message);
    }
  }

  // 3. Check local 5Y historical market data file (enables instant offline 1Y, 2Y, 3Y, 5Y backtesting)
  if (!forceRefresh) {
    const local5yPath = path.join(__dirname, 'data', 'market_data_5y.json');
    if (fs.existsSync(local5yPath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(local5yPath, 'utf8'));
        if (hasBarsForRange(localData, minStartDateStr, endDateStr)) {
          console.log(`Loaded 5-year offline market data (${Object.keys(localData).length} symbols) for backtesting.`);
          inMemoryMarketData = { data: localData, watchlist: WATCHLIST };
          return localData;
        }
      } catch (err) {
        console.warn("Could not read local market_data_5y.json:", err.message);
      }
    }
  }

  // If there is already an active fetch happening, wait for its completion to prevent race conditions
  if (activeUpdatePromise) {
    console.log("Waiting for concurrent market data update to finish...");
    return activeUpdatePromise;
  }

  // Create update promise and store it globally
  activeUpdatePromise = (async () => {
    console.log("Market data outdated or missing. Fetching live market data using Python yfinance script...");

    // Dynamically calculate start date (450 days lookback = 1Y max backtest window + ~85 day buffer for 50+ bar indicator warmup)
    const endD = new Date(endDateStr);
    const startD = new Date(endD.getTime() - (450 * 24 * 60 * 60 * 1000));
    const startDateStr = formatUTCDate(startD);
    // Determine Python executable (prefer isolated backend venv if available)
    const venvUnix = path.join(__dirname, 'venv', 'bin', 'python3');
    const venvWin = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
    let pythonBin = 'python3';

    if (fs.existsSync(venvUnix)) {
      pythonBin = `"${venvUnix}"`;
    } else if (fs.existsSync(venvWin)) {
      pythonBin = `"${venvWin}"`;
    }

    const pythonScript = path.join(__dirname, 'fetch_data.py');
    const tempOutputFile = path.join(os.tmpdir(), `market_data_${Date.now()}.json`);

    try {
      // Execute Python yfinance batch script writing to OS temp file
      await new Promise((resolve, reject) => {
        exec(`${pythonBin} "${pythonScript}" "${startDateStr}" "${endDateStr}" "${tempOutputFile}"`, (error, stdout, stderr) => {
          if (error) {
            console.error(`Python script error: ${error.message}`);
            console.error(`Stderr: ${stderr}`);
            reject(error);
          } else {
            console.log(`Python script output: ${stdout || 'SUCCESS'}`);
            resolve();
          }
        });
      });

      if (!fs.existsSync(tempOutputFile)) {
        throw new Error("Python script finished but output was not generated.");
      }

      const rawPayload = fs.readFileSync(tempOutputFile, 'utf8');
      const payload = JSON.parse(rawPayload);

      // Clean up temp file immediately - no persistent disk dependency
      try {
        fs.unlinkSync(tempOutputFile);
      } catch (_) { }

      // Update in-memory storage
      inMemoryMarketData = payload;
      if (payload.watchlist && Array.isArray(payload.watchlist) && payload.watchlist.length > 0) {
        WATCHLIST.length = 0;
        WATCHLIST.push(...payload.watchlist);
      }
      console.log(`Loaded live market data for ${Object.keys(payload.data).length} symbols into server memory.`);

      // Persist into MongoDB MarketData
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          await MarketDataModel.findOneAndUpdate(
            { key: 'daily_bars' },
            {
              key: 'daily_bars',
              lastUpdated: todayStr,
              watchlist: payload.watchlist,
              data: payload.data
            },
            { upsert: true }
          );
          console.log(`Persisted market data for ${Object.keys(payload.data).length} symbols to MongoDB.`);
        } catch (dbErr) {
          console.warn("Failed to persist MarketData to MongoDB:", dbErr.message);
        }
      }

      return payload.data;
    } catch (err) {
      try {
        if (fs.existsSync(tempOutputFile)) fs.unlinkSync(tempOutputFile);
      } catch (_) { }
      throw err;
    }
  })();

  try {
    const result = await activeUpdatePromise;
    return result;
  } finally {
    activeUpdatePromise = null;
  }
}


// Generate aggressive narrative logs for Quant Sentinal
function generateNarrativeLog(date, sentiment, cash, holdings, totalValue, transactions) {
  const activeHoldingsSymbols = holdings.map(h => h.symbol.replace('.NS', '')).join(', ');

  const marketSummaries = {
    BULLISH: [
      `Market action is highly constructive. Nifty is maintaining its upward trajectory. Bulls are in complete control.`,
      `Bullish momentum is sweeping through the index. Aggressive trading pays off in conditions like these.`,
      `We see clean breakouts across multiple sectors. Capital is chasing growth, and we are riding the wave.`
    ],
    BEARISH: [
      `Bearish sentiment is dominating today's session. Sellers are dragging down core sectors. We are managing risk closely.`,
      `Market structure is turning defensive. The index faced strong overhead rejection. Cash conservation is key here.`,
      `Selling pressure accelerated today. Weak global cues and IT/Banking drag. We are playing tight and protecting capital.`
    ],
    VOLATILE: [
      `Extreme chop in today's session. High intraday swings but no clear trend direction. Wild action.`,
      `Volatile session with massive swings. Traders are fighting over key support levels. Tight stop losses are saving our positions.`,
      `Sector rotation is happening at breakneck speed. Volatility index (VIX) spikes. We stay nimble.`
    ],
    NEUTRAL: [
      `Market closed flat. Consolidation phase continues as institutions wait for fresh triggers.`,
      `Sideways rangebound trading today. Quiet session with low volume. Excellent environment for selective stock pickings.`,
      `No major movements today. Index is resting on the 20-day SMA. Consolidation before the next big expansion.`
    ]
  };

  const genericRemarks = [
    `Annual target of 15%-20% returns requires aggressive risk management. We do not marry positions—we rent momentum.`,
    `Rule #1: Let winners run, cut losers immediately. 6% stop loss is non-negotiable.`,
    `Aggressive trading is about probability. Win rate matters, but average win size vs average loss size matters more.`,
    `Deploying capital strictly where edge exists. We hold cash when market setups are sub-optimal.`
  ];

  const summaryArr = marketSummaries[sentiment] || marketSummaries.NEUTRAL;
  const mainSummary = summaryArr[Math.floor((date.charCodeAt(date.length - 1) || 0) % summaryArr.length)];
  const remark = genericRemarks[Math.floor((date.charCodeAt(date.length - 2) || 0) % genericRemarks.length)];

  let logsText = `${mainSummary}\n\n`;

  if (transactions.length > 0) {
    logsText += `**Transactions Executed:**\n`;
    transactions.forEach(t => {
      if (t.type === 'BUY') {
        logsText += `- **BOUGHT** ${t.quantity} shares of ${t.symbol.replace('.NS', '')} at ₹${t.price.toFixed(2)}. Target set at ₹${t.targetPrice.toFixed(2)}, Stop Loss at ₹${t.stopLoss.toFixed(2)}. *Reason:* ${t.reason}\n`;
      } else if (t.type === 'SELL') {
        const profitLossText = t.profit >= 0 ? `PROFIT of +₹${t.profit.toFixed(2)} (+${t.profitPercent.toFixed(1)}%)` : `LOSS of -₹${Math.abs(t.profit).toFixed(2)} (${t.profitPercent.toFixed(1)}%)`;
        logsText += `- **SOLD** ${t.quantity} shares of ${t.symbol.replace('.NS', '')} at ₹${t.price.toFixed(2)}: Triggered ${t.reason}. Realized ${profitLossText}.\n`;
      } else if (t.type === 'DEPOSIT') {
        const amtStr = (t.amount || 20000.0).toLocaleString('en-IN');
        logsText += `- **MONTHLY DEPOSIT**: Added ₹${amtStr}.00 cash to the portfolio. Total cash available: ₹${cash.toFixed(2)}.\n`;
      }
    });
    logsText += `\n`;
  } else {
    logsText += `No trade executions today. Current portfolio allocation is stable. `;
    if (holdings.length > 0) {
      logsText += `Active holdings: ${activeHoldingsSymbols}. `;
    } else {
      logsText += `Currently holding 100% cash, scanning for high-probability setups. `;
    }
    logsText += `\n\n`;
  }

  logsText += `**Desk Metrics:**\n`;
  logsText += `- Total Portfolio Net Worth: ₹${totalValue.toFixed(2)}\n`;
  logsText += `- Cash Balance: ₹${cash.toFixed(2)} | Holdings Value: ₹${(totalValue - cash).toFixed(2)}\n`;
  logsText += `- Status: ${remark}`;

  return logsText;
}

/**
 * Evaluate broad market regime based on benchmark ETF / index (e.g. NIFTYBEES.NS or RELIANCE.NS)
 */
function evaluateMarketRegime(simDate, cachedData, isConservative = false) {
  const benchmarkData = cachedData['^NSEI'] || cachedData['NIFTYBEES.NS'] || cachedData['RELIANCE.NS'];
  if (!benchmarkData || benchmarkData.length === 0) {
    return { regime: 'NEUTRAL', benchmarkRsi: 50, trend: 'FLAT', return5d: 0 };
  }

  const dayIdx = benchmarkData.findIndex(row => row.date === simDate);
  if (dayIdx === -1 || dayIdx < 20) {
    return { regime: 'NEUTRAL', benchmarkRsi: 50, trend: 'FLAT', return5d: 0 };
  }

  const subHistory = benchmarkData.slice(0, dayIdx + 1);
  const closes = subHistory.map(r => r.close);
  const ema20Arr = calculateEMA(closes, 20);
  const ema50Arr = calculateEMA(closes, 50);
  const rsiArr = calculateRSI(closes, 14);

  const currClose = closes[closes.length - 1];
  const close5dAgo = closes[Math.max(0, closes.length - 6)];
  const return5d = (currClose - close5dAgo) / close5dAgo;

  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const rsi = rsiArr[rsiArr.length - 1] || 50;

  if (isConservative) {
    // Strict capital preservation: benchmark below 20 EMA, or negative 5d return, or RSI < 48
    if ((ema20 && currClose < ema20) || return5d < -0.008 || (rsi < 48)) {
      return { regime: 'RISK_OFF', benchmarkRsi: rsi, trend: 'DOWN', return5d };
    }
  } else {
    // High-frequency momentum: only enter RISK_OFF on significant market crash (return5d < -2% or RSI < 42)
    if (currClose < ema20 * 0.985 && (rsi < 42 || return5d < -0.02) && (ema50 ? currClose < ema50 : true)) {
      return { regime: 'RISK_OFF', benchmarkRsi: rsi, trend: 'DOWN', return5d };
    }
  }

  // 2. Confirmed Bullish: Above 20 EMA with positive 5d return & healthy RSI
  if (ema20 && currClose >= ema20 * 1.001 && return5d >= 0 && rsi >= 50) {
    return { regime: 'BULLISH', benchmarkRsi: rsi, trend: 'UP', return5d };
  }

  // 3. Counter-trend rally / choppy consolidation: Above 20 EMA but flat or consolidating
  return { regime: 'NEUTRAL', benchmarkRsi: rsi, trend: 'CONSOLIDATING', return5d };
}

/**
 * Intelligent Multi-Strategy Scanner with Volume Confirmation & Multi-Factor Scoring
 * Scans universe for high-win-rate swing setups based on active strategy mode (Aggressive vs Conservative).
 */
function scanMarketCandidates(simDate, cachedData, currentHoldings = [], config = {}) {
  const isConservative = (config?.aggressiveness === 'conservative');
  const marketRegime = evaluateMarketRegime(simDate, cachedData, isConservative);
  const candidates = [];

  // Calculate benchmark 20-day return for Relative Strength filtering (NIFTY 50 index)
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

  for (const stock of WATCHLIST) {
    // Exclude index ETFs: they are macro benchmarks for regime analysis, not individual swing stocks
    if (stock.sector === 'ETFs') continue;

    const existingHolding = currentHoldings.find(h => h.symbol === stock.symbol);
    let isAccumulationCandidate = false;

    if (existingHolding) {
      // --- Safe Pyramiding / Accumulation Guardrails (Pillar 4) ---
      // 1. Max 1 accumulation tranche per holding
      // 2. Minimum cushion: unrealized profit >= +6.0% (guarantees net zero risk upon adding)
      // 3. Held for at least 3 trading days
      const daysHeld = existingHolding.buyDate
        ? Math.max(1, Math.round((new Date(simDate) - new Date(existingHolding.buyDate)) / (1000 * 60 * 60 * 24)))
        : 5;

      if (existingHolding.isAccumulated || (existingHolding.profitPercent || 0) < 6.0 || daysHeld < 3) {
        continue; // Cannot add to this holding
      }
      isAccumulationCandidate = true;
    }

    const stockHistory = cachedData[stock.symbol];
    if (!stockHistory || stockHistory.length === 0) continue;

    // Get index for current simulation date
    const dayIdx = stockHistory.findIndex(row => row.date === simDate);
    if (dayIdx === -1 || dayIdx < 14) continue; // Need at least 14 bars (RSI period)

    const subHistory = stockHistory.slice(0, dayIdx + 1);
    const closes = subHistory.map(row => row.close);
    const highs = subHistory.map(row => row.high);
    const lows = subHistory.map(row => row.low);
    const opens = subHistory.map(row => row.open !== undefined ? row.open : row.close);
    const volumes = subHistory.map(row => row.volume || 0);

    const len = closes.length;
    const currentClose = closes[len - 1];
    const currentOpen = opens[len - 1];
    const currentHigh = highs[len - 1];
    const currentLow = lows[len - 1];
    const prevClose = closes[len - 2] || currentClose;

    // Compute technical indicators (EMA + SMA + RSI + MACD + ATR + RVOL + ADX)
    const ema20Array = calculateEMA(closes, 20);
    const ema50Array = calculateEMA(closes, 50);
    const sma20Array = calculateSMA(closes, 20);
    const sma50Array = calculateSMA(closes, 50);
    const rsiArray = calculateRSI(closes, 14);
    const macdResult = calculateMACD(closes);
    const atrArray = calculateATR(highs, lows, closes, 14);
    const rvolArray = calculateRVOL(volumes, 20);
    const adxArray = calculateADX(highs, lows, closes, 14);
    const ema20Slope = calculateSlope(ema20Array, 5);
    const ema50Slope = calculateSlope(ema50Array, 10);

    const ema20 = ema20Array[len - 1];
    const ema50 = ema50Array[len - 1];
    const sma20 = sma20Array[len - 1];
    const sma50 = sma50Array[len - 1];
    const rsiVal = rsiArray[len - 1];
    const histogram = macdResult.histogram[len - 1];
    const currentAtr = atrArray[len - 1] || (currentClose * 0.025);
    const currentRvol = rvolArray[len - 1] || 1.0;
    const currentAdx = adxArray[len - 1] || 22;

    if (ema20 === null || rsiVal === null) continue;

    const candleRange = currentHigh - currentLow;
    const clv = candleRange > 0 ? (currentClose - currentLow) / candleRange : 0.5;
    const dayMove = prevClose > 0 ? (currentClose - prevClose) / prevClose : 0;
    const isMetalETF = stock.sector === 'Precious Metals';

    const past20Close = closes[Math.max(0, len - 21)];
    const stockReturn20d = past20Close > 0 ? ((currentClose - past20Close) / past20Close) : 0;
    const rsExcess = stockReturn20d - benchmarkReturn20d;

    const past10Close = closes[Math.max(0, len - 11)];
    const stockReturn10d = past10Close > 0 ? ((currentClose - past10Close) / past10Close) : 0;

    if (isConservative) {
      // -------------------------------------------------------------
      // CONSERVATIVE APPROACH: Institutional 20d Breakouts (~40-41 trades/yr)
      // Strictly trade 20-day high breakouts with 1.9x RVOL and 4% Alpha
      // -------------------------------------------------------------
      if (currentClose < 50 || currentClose > 75000) continue;
      if (ema50 && (ema20 < ema50 || ema50Slope < -0.005)) continue;
      if (currentClose < ema20 * 0.985) continue;
      if (currentClose > ema20 * 1.08) continue;
      if (stockReturn10d > 0.18) continue;

      const minRsExcess = isMetalETF ? -0.05 : 0.040;
      if (rsExcess < minRsExcess) continue;

      const breakout20 = checkBreakouts(closes, highs, lows, 20);
      if (!breakout20.isBullishBreakout) continue;

      const minRvol = isMetalETF ? 1.10 : 1.90;
      if (currentRvol < minRvol) continue;

      const minDayMove = isMetalETF ? 0.003 : 0.018;
      if (dayMove < minDayMove) continue;

      if (currentClose < currentOpen) continue;
      if (clv < 0.68 && !isMetalETF) continue;
      if (rsiVal < (isMetalETF ? 46 : 52) || rsiVal > 72.5) continue;
      if (!isMetalETF && currentAdx < 20) continue;
      if (ema50 && (ema20 < ema50 * 1.01 || ema20Slope <= 0)) continue;

      let score = isMetalETF ? 90 : 88;
      if (rsExcess >= 0.08) score += 10;
      else if (rsExcess >= 0.04) score += 7;
      if (currentRvol >= 3.0) score += 10;
      else if (currentRvol >= 2.0) score += 7;
      if (clv >= 0.70) score += 4;
      if (currentAdx >= 25) score += 4;
      if (marketRegime.regime === 'BULLISH') score += 3;
      else if (marketRegime.regime === 'RISK_OFF') score -= 6;
      score = Math.max(50, Math.min(100, Math.round(score)));

      if (isAccumulationCandidate && (score < 85 || currentRvol < 1.0)) continue;
      const minScoreThreshold = isAccumulationCandidate
        ? 84
        : (marketRegime.regime === 'RISK_OFF' ? 92 : (marketRegime.regime === 'NEUTRAL' ? 88 : 84));
      if (score < minScoreThreshold) continue;

      candidates.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        price: currentClose,
        score: score,
        rsGain: rsExcess,
        reason: isAccumulationCandidate
          ? `[ACCUMULATE] Trend continuation in winning holding: Institutional breakout (${currentRvol.toFixed(1)}x RVOL, RSI: ${rsiVal.toFixed(1)})`
          : isMetalETF
            ? `Precious Metals 20-day breakout in confirmed uptrend (${currentRvol.toFixed(1)}x RVOL, RSI: ${rsiVal.toFixed(1)}).`
            : `Fresh 20-day breakout with institutional volume surge (${currentRvol.toFixed(1)}x RVOL, RSI: ${rsiVal.toFixed(1)}) in confirmed uptrend.`,
        strategy: isMetalETF ? 'COMMODITY_MOMENTUM' : 'MOMENTUM_BREAKOUT',
        isAccumulation: isAccumulationCandidate,
        parentHolding: isAccumulationCandidate ? existingHolding : null,
        technicalStats: {
          rsi: rsiVal,
          sma20: sma20 || ema20,
          sma50: sma50 || ema50,
          ema20,
          ema50: ema50 || ema20,
          rvol: currentRvol,
          atr: currentAtr,
          macdHist: histogram || 0
        }
      });
    } else {
      // -------------------------------------------------------------
      // AGGRESSIVE APPROACH: Broad High-Frequency Momentum (~172 trades/yr)
      // Captures breakouts & coiling expansions with fast capital turnover
      // -------------------------------------------------------------
      if (currentClose < 20 || currentClose > 75000) continue;
      if (!ema20 || currentClose < ema20) continue;
      if (ema50 && (ema20 < ema50 * 1.005 || currentClose < ema50)) continue;
      if (rsExcess < 0.030) continue;
      if (stockReturn10d > 0.18) continue;

      const distFromEma20 = (currentClose - ema20) / ema20;
      if (distFromEma20 > 0.080) continue;

      const lookback20Highs = highs.slice(Math.max(0, len - 21), len - 1);
      const highestHigh20 = lookback20Highs.length > 0 ? Math.max(...lookback20Highs) : currentClose;
      const isNew20dHigh = currentHigh >= highestHigh20;
      const distTo20dHigh = highestHigh20 > 0 ? (highestHigh20 - currentClose) / highestHigh20 : 0;
      const isCoilingNearHigh = distTo20dHigh <= 0.015 && distTo20dHigh >= -0.01;
      if (!isNew20dHigh && !isCoilingNearHigh) continue;

      const minDayMove = isMetalETF ? 0.003 : 0.014;
      const minRvol = isMetalETF ? 1.10 : 1.75;
      if (currentRvol < minRvol) continue;

      if (dayMove < minDayMove) continue;
      if (currentClose < currentOpen) continue;
      if (clv < 0.64) continue;
      if (rsiVal > 76.5) continue;

      let strategyName = isMetalETF ? 'COMMODITY_MOMENTUM' : (isNew20dHigh ? 'MOMENTUM_BREAKOUT' : 'COILING_BREAKOUT_EXPANSION');
      let reason = isMetalETF
        ? `Precious Metals momentum (${currentRvol.toFixed(1)}x RVOL, RSI: ${rsiVal.toFixed(1)}) in confirmed uptrend.`
        : isNew20dHigh
          ? `Fresh 20-day breakout with volume surge (${currentRvol.toFixed(1)}x RVOL, RSI: ${rsiVal.toFixed(1)}) in confirmed uptrend.`
          : `Coiling within 1.5% of 20-day high with volume surge (${currentRvol.toFixed(1)}x RVOL, RSI: ${rsiVal.toFixed(1)}) ready for expansion.`;

      let score = 76;
      if (isNew20dHigh && clv >= 0.70 && currentRvol >= 2.0 && rsExcess >= 0.05) score = 96;
      else if (isNew20dHigh && currentRvol >= 1.8) score = 91;
      else if (isCoilingNearHigh && currentRvol >= 2.0) score = 86;

      if (isAccumulationCandidate && (score < 80 || currentRvol < 1.0)) continue;

      candidates.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        price: currentClose,
        score: score,
        rsGain: rsExcess,
        reason: isAccumulationCandidate ? `[ACCUMULATE] Trend continuation in winning holding: ${reason}` : reason,
        strategy: strategyName,
        isAccumulation: isAccumulationCandidate,
        parentHolding: isAccumulationCandidate ? existingHolding : null,
        technicalStats: {
          rsi: rsiVal,
          sma20: sma20 || ema20,
          sma50: sma50 || ema50,
          ema20,
          ema50: ema50 || ema20,
          rvol: currentRvol,
          atr: currentAtr,
          macdHist: histogram || 0
        }
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const diff = (b.rsGain || 0) - (a.rsGain || 0);
    if (Math.abs(diff) > 0.005) return diff;
    return (b.technicalStats?.rvol || 1) - (a.technicalStats?.rvol || 1);
  });
  return { candidates, marketRegime };
}

// Core Simulation Function
async function runSimulation(targetEndDateStr, forceRefresh = false, portfolioType = 'backtest') {
  const pType = portfolioType || 'backtest';
  const state = await loadState(pType);
  const cachedData = await updateCache(targetEndDateStr, forceRefresh, state.lastSimulationDate);

  const lastRunDateStr = state.lastSimulationDate;
  if (!forceRefresh && lastRunDateStr >= targetEndDateStr) {
    console.log(`Simulation is already up to date (${lastRunDateStr}).`);
    return state;
  }

  // Find all unique trading dates from True Benchmark Index (^NSEI / NIFTYBEES.NS), fallback to RELIANCE.NS
  const calendarData = cachedData['^NSEI'] || cachedData['NIFTYBEES.NS'] || cachedData['RELIANCE.NS'];
  if (!calendarData || calendarData.length === 0) {
    throw new Error("Failed to load historical data for calendar baseline.");
  }

  // Extract dates that are greater than lastRunDateStr and <= targetEndDateStr
  const tradingDates = calendarData
    .map(row => row.date)
    .filter(date => date > lastRunDateStr && date <= targetEndDateStr)
    .sort();

  if (tradingDates.length === 0) {
    console.log("No new trading days found to simulate.");
    return state;
  }

  console.log(`Simulating ${tradingDates.length} trading days: from ${tradingDates[0]} to ${tradingDates[tradingDates.length - 1]}`);

  // Track total deposited capital and monthly injection transitions
  let currentTotalDeposited = (state.valuationHistory && state.valuationHistory.length > 0)
    ? (state.valuationHistory[state.valuationHistory.length - 1].totalDeposited || 100000.0)
    : 100000.0;

  // Track month key (YYYY-MM) of last deposit
  let lastDepositMonthKey = state.lastSimulationDate ? state.lastSimulationDate.slice(0, 7) : null;

  // We loop day-by-day through the new trading dates
  for (const simDate of tradingDates) {
    const todayTransactions = [];

    // --- 1. Monthly Deposit Check (Disabled: playing with 1L fixed starting capital) ---
    const currentMonthKey = simDate.slice(0, 7);

    if (false && currentMonthKey !== lastDepositMonthKey) {
      const depositAmount = 0.0;
      state.cash += depositAmount;
      currentTotalDeposited += depositAmount;
      lastDepositMonthKey = currentMonthKey;
    }

    // --- 2. Portfolio Sell Checks (Evaluate active holdings) ---
    const remainingHoldings = [];

    for (const position of state.holdings) {
      const stockData = cachedData[position.symbol];
      const dayBar = stockData ? stockData.find(row => row.date === simDate) : null;

      if (!dayBar) {
        // No data for this stock today, keep position
        remainingHoldings.push(position);
        continue;
      }

      const { high, low, close } = dayBar;
      let triggerSell = false;
      let sellPrice = close;
      let sellReason = '';

      // --- Institutional Trend-Following Exit Engine ---
      const dayIdx = stockData.findIndex(row => row.date === simDate);
      const buyIdx = stockData.findIndex(row => row.date === position.buyDate);
      const tradingDaysHeld = (buyIdx !== -1 && dayIdx !== -1) ? (dayIdx - buyIdx) : Math.round((new Date(simDate) - new Date(position.buyDate)) / (1000 * 60 * 60 * 24));
      const currentGainPct = ((close - position.buyPrice) / position.buyPrice) * 100;
      const todayPeakGainPercent = ((high - position.buyPrice) / position.buyPrice) * 100;

      // Track historical peak profit achieved during the lifetime of this trade
      if (!position.peakProfitPercent || todayPeakGainPercent > position.peakProfitPercent) {
        position.peakProfitPercent = todayPeakGainPercent;
      }
      const peakProfitGainPercent = position.peakProfitPercent;

      // Calculate stock 20-day EMA and RSI for trailing runner support
      let dayEma20 = null;
      let stockRsi = 50;
      if (dayIdx >= 10) {
        const closesSoFar = stockData.slice(0, dayIdx + 1).map(r => r.close);
        const ema20Arr = calculateEMA(closesSoFar, 20);
        dayEma20 = ema20Arr[ema20Arr.length - 1];
        const rsiArr = calculateRSI(closesSoFar, 14);
        stockRsi = rsiArr[rsiArr.length - 1] || 50;
      }

      // Dynamic Profit Protection (Swing Trading Capital Preservation Ladder):
      // Level 0: At +3.0% peak gain -> Move stop loss to Breakeven (+1.2% profit cushion)
      if (peakProfitGainPercent >= 3.0) {
        const beLevel = position.buyPrice * 1.012;
        if (beLevel > position.stopLoss) position.stopLoss = beLevel;
      }

      // Level 1: At +11.0% peak gain -> Lock in +5.5% minimum profit
      if (peakProfitGainPercent >= 11.0) {
        const lockProfit1 = position.buyPrice * 1.055;
        if (lockProfit1 > position.stopLoss) position.stopLoss = lockProfit1;
      }

      // Level 3: At +18.0% peak gain -> Lock in +11.5% minimum profit
      if (peakProfitGainPercent >= 18.0) {
        const lockProfit2 = position.buyPrice * 1.115;
        if (lockProfit2 > position.stopLoss) position.stopLoss = lockProfit2;
      }

      // Level 4: At +25.0% peak gain -> Pillar 3: Uncapped 20-Day EMA Runner
      // Remove artificial caps and trail dynamically on the 20-day EMA to allow +40% to +80% multi-baggers
      if (peakProfitGainPercent >= 25.0) {
        const runnerTrail = dayEma20 ? dayEma20 * 0.99 : position.buyPrice * 1.18;
        if (runnerTrail > position.stopLoss) position.stopLoss = runnerTrail;
      }

      // Level 5: At +35.0% peak gain -> Tighten EMA20 trail to capture apex of big runs
      if (peakProfitGainPercent >= 35.0 && dayEma20) {
        const runnerTrail = dayEma20 * 0.995;
        if (runnerTrail > position.stopLoss) position.stopLoss = runnerTrail;
      }

      // --- 1. Clean Trailing Profit Lock ---
      // If trailing stop is breached, exit full position at stopLoss (or open if gapped down)
      const isTrailingStop = position.stopLoss > position.buyPrice;
      const trailingBreach = close <= position.stopLoss;
      const initialBreach = close <= position.stopLoss || low <= position.stopLoss;

      let partialSellQty = 0;
      let partialSellReason = '';

      // Full Stop or Full Trailing Exit
      if (isTrailingStop ? trailingBreach : initialBreach) {
        triggerSell = true;
        sellPrice = (dayBar.open && dayBar.open < position.stopLoss) ? dayBar.open : position.stopLoss;
        sellReason = isTrailingStop ? 'Trailing Profit Locked' : 'Stop Loss Triggered';
      }
      // 1b. Early Failed Breakout Cut
      else if (tradingDaysHeld >= 3 && tradingDaysHeld <= 4 && currentGainPct <= -2.4 && stockRsi < 50 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = `Early Failed Breakout Exit (${tradingDaysHeld}d held, ${currentGainPct.toFixed(1)}%)`;
      }
      // 2. Stagnation / Time Stop
      else if (tradingDaysHeld >= 6 && currentGainPct < -1.0 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = `Stagnation Time-Stop (${tradingDaysHeld}d held, ${currentGainPct.toFixed(1)}%)`;
      }
      // 2b. Dead-Money Time Stop (Pillar 5): Free up capital if stock stalls at <= 0.0% below 20 EMA after 10 trading days
      else if (tradingDaysHeld >= 10 && currentGainPct <= 0.0 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = `Stagnation Dead-Money Exit (${tradingDaysHeld}d held, ${currentGainPct.toFixed(1)}%)`;
      }
      // 2c. Failed Breakout Follow-Through Protection (Only for early pops under 10% that immediately collapse below 20 EMA)
      else if (peakProfitGainPercent >= 4.0 && peakProfitGainPercent < 10.0 && dayEma20 && close < dayEma20) {
        triggerSell = true;
        sellPrice = close;
        sellReason = `Failed Follow-Through (Peaked +${peakProfitGainPercent.toFixed(1)}%, closed below 20 EMA)`;
      }
      // 3. Parabolic Climax Blow-Off: Sell 50% to lock explosive gain, let remaining 50% ride on regular trailing rules (EMA20)
      else if (!position.isClimaxScaled && currentGainPct >= 20.0 && stockRsi >= 82 && dayEma20 && close > dayEma20 * 1.12) {
        if (position.quantity >= 2) {
          partialSellQty = Math.floor(position.quantity * 0.5);
          partialSellReason = `Parabolic Climax 50% Profit Taken (${stockRsi.toFixed(1)} RSI, +${currentGainPct.toFixed(1)}%)`;
        } else {
          triggerSell = true;
          sellPrice = close;
          sellReason = `Parabolic Climax Blow-Off (${stockRsi.toFixed(1)} RSI, +${currentGainPct.toFixed(1)}%) Profit Taken`;
        }
      }

      // Handle Partial Sell (50%)
      if (partialSellQty > 0) {
        const pSellPrice = close;
        const pRevenue = partialSellQty * pSellPrice;
        const pCost = partialSellQty * position.buyPrice;
        const pProfit = pRevenue - pCost;
        const pProfitPercent = (pProfit / pCost) * 100;

        state.cash += pRevenue;
        position.quantity -= partialSellQty;

        if (partialSellReason.includes('Parabolic Climax')) {
          position.isClimaxScaled = true;
          // Trail remaining shares on EMA20
          position.stopLoss = Math.max(position.stopLoss, dayEma20 ? dayEma20 * 0.99 : position.buyPrice * 1.15);
        }

        state.history.push({
          symbol: position.symbol,
          name: position.name,
          sector: position.sector,
          quantity: partialSellQty,
          buyPrice: position.buyPrice,
          sellPrice: pSellPrice,
          buyDate: position.buyDate,
          sellDate: simDate,
          profit: pProfit,
          profitPercent: pProfitPercent,
          reason: partialSellReason,
          buyReason: position.buyReason,
          strategy: position.strategy || 'UNKNOWN',
          score: position.score || 0,
          accumulated: position.isAccumulated || false
        });

        todayTransactions.push({
          type: 'SELL',
          symbol: position.symbol,
          quantity: partialSellQty,
          price: pSellPrice,
          profit: pProfit,
          profitPercent: pProfitPercent,
          reason: partialSellReason
        });

        console.log(`[${simDate}] PARTIAL SOLD ${partialSellQty}x ${position.symbol} @ ₹${pSellPrice.toFixed(2)} (${partialSellReason}). P&L: ₹${pProfit.toFixed(2)} (+${pProfitPercent.toFixed(1)}%). Remaining: ${position.quantity} shares, SL: ₹${position.stopLoss.toFixed(2)}`);

        // Update remaining position
        position.currentPrice = close;
        position.value = position.quantity * close;
        position.profit = position.value - (position.quantity * position.buyPrice);
        position.profitPercent = (position.profit / (position.quantity * position.buyPrice)) * 100;
        remainingHoldings.push(position);
      }
      // Handle Full Sell
      else if (triggerSell) {
        const revenue = position.quantity * sellPrice;
        const cost = position.quantity * position.buyPrice;
        const profit = revenue - cost;
        const profitPercent = (profit / cost) * 100;

        state.cash += revenue;

        const completedTrade = {
          symbol: position.symbol,
          name: position.name,
          sector: position.sector,
          quantity: position.quantity,
          buyPrice: position.buyPrice,
          sellPrice: sellPrice,
          buyDate: position.buyDate,
          sellDate: simDate,
          profit: profit,
          profitPercent: profitPercent,
          reason: sellReason,
          buyReason: position.buyReason,
          strategy: position.strategy || 'UNKNOWN',
          score: position.score || 0,
          accumulated: position.isAccumulated || false
        };

        state.history.push(completedTrade);
        todayTransactions.push({
          type: 'SELL',
          symbol: position.symbol,
          quantity: position.quantity,
          price: sellPrice,
          profit: profit,
          profitPercent: profitPercent,
          reason: sellReason
        });

        console.log(`[${simDate}] SOLD ${position.symbol} @ ₹${sellPrice.toFixed(2)} (${sellReason}). P&L: ₹${profit.toFixed(2)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
      } else {
        // Position remains open, update its current price
        position.currentPrice = close;
        position.value = position.quantity * close;
        position.profit = position.value - (position.quantity * position.buyPrice);
        position.profitPercent = (position.profit / (position.quantity * position.buyPrice)) * 100;
        remainingHoldings.push(position);
      }
    }
    state.holdings = remainingHoldings;

    // --- 3. Technical Scanner & Buys ---
    const { candidates, marketRegime } = scanMarketCandidates(simDate, cachedData, state.holdings, state.config);

    // Helper: execute a buy or accumulation and record transaction
    const executeBuy = (targetStock) => {
      let currentHoldingsValue = 0;
      for (const h of state.holdings) currentHoldingsValue += h.value;
      const totalPortfolioValue = state.cash + currentHoldingsValue;
      const minCashReserve = Math.min(2000, totalPortfolioValue * 0.02);
      if (state.cash <= minCashReserve) return false;

      // --- BRANCH A: SAFE POSITION ACCUMULATION / PYRAMIDING ---
      if (targetStock.isAccumulation) {
        const parent = state.holdings.find(h => h.symbol === targetStock.symbol);
        if (!parent || parent.isAccumulated) return false;

        // Guardrail 1: Inverted Triangle Sizing (max 50% of parent quantity, max 6% of portfolio)
        const maxAddQtyByParent = Math.max(1, Math.floor(parent.quantity * 0.5));
        const maxCapitalForAdd = Math.min(totalPortfolioValue * 0.06, state.cash - minCashReserve);
        const maxAddQtyByCap = Math.floor(maxCapitalForAdd / targetStock.price);

        let qty = Math.min(maxAddQtyByParent, maxAddQtyByCap);
        if (qty <= 0 && parent.quantity === 1 && state.cash >= targetStock.price + minCashReserve) {
          if ((parent.value + targetStock.price) <= totalPortfolioValue * 0.20) {
            qty = 1;
          }
        }
        if (qty <= 0) return false;

        const addCost = qty * targetStock.price;
        if ((parent.value + addCost) > totalPortfolioValue * 0.20) return false;

        const totalNewQty = parent.quantity + qty;
        const oldCostBasis = parent.quantity * parent.buyPrice;
        const totalCostBasis = oldCostBasis + addCost;
        const blendedBuyPrice = totalCostBasis / totalNewQty;

        // Guardrail 2: Combined Zero-Loss Guarantee
        // Combined stop loss MUST ensure that if hit, total trade exits at or above breakeven (+0.5% profit cushion)
        const guaranteedBreakevenStop = blendedBuyPrice * 1.005;
        const existingStopCapped = parent.stopLoss ? Math.min(parent.stopLoss, targetStock.price * 0.94) : 0;
        const newStopLoss = Math.max(guaranteedBreakevenStop, existingStopCapped);

        state.cash -= addCost;
        parent.quantity = totalNewQty;
        parent.buyPrice = blendedBuyPrice;
        parent.currentPrice = targetStock.price;
        parent.value = totalNewQty * targetStock.price;
        parent.profit = parent.value - totalCostBasis;
        parent.profitPercent = (parent.profit / totalCostBasis) * 100;
        parent.stopLoss = newStopLoss;
        parent.isAccumulated = true;
        parent.accumulatedDate = simDate;
        parent.accumulatedQty = qty;
        parent.accumulatedPrice = targetStock.price;

        todayTransactions.push({
          type: 'ACCUMULATE',
          symbol: targetStock.symbol,
          quantity: qty,
          price: targetStock.price,
          blendedBuyPrice,
          stopLoss: newStopLoss,
          reason: targetStock.reason
        });

        console.log(`[${simDate}] [ACCUMULATED] +${qty}x ${targetStock.symbol} @ ₹${targetStock.price.toFixed(2)}. Total: ${totalNewQty} shares, Blended Entry: ₹${blendedBuyPrice.toFixed(2)}, Guaranteed SL: ₹${newStopLoss.toFixed(2)} (Net Zero-Loss Protected)`);
        return true;
      }

      // --- BRANCH B: NEW POSITION PURCHASE ---
      const availableSlots = Math.max(1, state.config.maxPositions - state.holdings.length);

      // Pillar 2: Asymmetric Conviction Sizing:
      // Grade A+ Institutional Breakouts (Score >= 93) get 15.0% capital allocation to supercharge compounding.
      // Standard setups (Score < 93) get 12.5% allocation to balance portfolio diversification.
      const isHighConviction = (targetStock.score || 0) >= 93;
      const allocPct = isHighConviction ? 0.15 : 0.125;
      const targetPositionSize = totalPortfolioValue * allocPct;
      const minAllocationFloor = Math.min(4000, totalPortfolioValue * 0.04);
      if (state.cash < minAllocationFloor + minCashReserve) return false;

      const capitalAllocation = Math.min(targetPositionSize, state.cash - minCashReserve);
      let qty = Math.floor(capitalAllocation / targetStock.price);

      // High-priced momentum compounders (e.g. Bosch Ltd., PTC Industries, Bajaj Auto):
      // Allow buying 1 share if cash is sufficient (preserving min reserve) and price <= 35% of portfolio
      if (qty <= 0 && state.cash >= targetStock.price + minCashReserve && targetStock.price <= totalPortfolioValue * 0.35) {
        qty = 1;
      }
      if (qty <= 0) return false;

      const cost = qty * targetStock.price;
      state.cash -= cost;
      const targetPrice = targetStock.price * (1 + state.config.targetProfitPercent);
      const stopLoss = targetStock.price * (1 - state.config.stopLossPercent);

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
        buyReason: targetStock.reason,
        strategy: targetStock.strategy,
        score: targetStock.score,
        technicalStats: targetStock.technicalStats
      });

      todayTransactions.push({ type: 'BUY', symbol: targetStock.symbol, quantity: qty, price: targetStock.price, targetPrice, stopLoss, reason: targetStock.reason });
      console.log(`[${simDate}] BOUGHT ${qty}x ${targetStock.symbol} @ ₹${targetStock.price.toFixed(2)} (₹${cost.toFixed(0)} / Portfolio ₹${totalPortfolioValue.toFixed(0)}). SL: ₹${stopLoss.toFixed(2)}`);
      return true;
    };

    // --- Pass 1: Deploy cash to qualified scanner candidates ---
    let currentHoldingsValue = 0;
    for (const h of state.holdings) currentHoldingsValue += h.value;
    const isConservative = (state.config.aggressiveness === 'conservative');

    if (isConservative) {
      // -------------------------------------------------------------------------
      // CONSERVATIVE APPROACH: Disciplined Pacing & Capital Preservation (~40-41 trades/yr)
      // -------------------------------------------------------------------------
      const totalPortVal = state.cash + currentHoldingsValue;
      const cashRatio = totalPortVal > 0 ? (state.cash / totalPortVal) : 1;
      const maxBuysToday = (marketRegime.regime === 'BULLISH' && cashRatio > 0.20)
        ? 4
        : (marketRegime.regime === 'BULLISH')
          ? 2
          : 1;
      let todayBuysCount = 0;

      for (const targetStock of candidates) {
        if (todayBuysCount >= maxBuysToday) break;
        const isAccumulation = targetStock.isAccumulation;

        // Broad Market Regime Gate: In RISK_OFF, strictly block new swing buys
        if (!isAccumulation && marketRegime.regime === 'RISK_OFF') continue;

        // Anti-Choppiness Gate: In NEUTRAL regimes, do not buy if 5-day market return is negative
        if (!isAccumulation && marketRegime.regime === 'NEUTRAL') {
          if (marketRegime.return5d < 0) continue;
          if (targetStock.score < 92 || (targetStock.rsGain || 0) < 0.06 || (targetStock.technicalStats?.rvol || 1) < 2.0) continue;
        }

        // Cool-off protection: If stopped out within last 8 trading days, do not immediately re-enter unless RVOL >= 2.0
        if (!isAccumulation) {
          const simIdx = tradingDates.indexOf(simDate);
          const recentLoss = state.history.some(t => {
            if (t.symbol !== targetStock.symbol || t.profit > 0) return false;
            const sellIdx = tradingDates.indexOf(t.sellDate);
            if (sellIdx === -1) return false;
            const daysSinceLoss = simIdx - sellIdx;
            if (daysSinceLoss <= 8) {
              if ((targetStock.technicalStats?.rvol || 1) >= 2.0) return false;
              return true;
            }
            return false;
          });
          if (recentLoss) continue;
        }

        const availableSlots = state.config.maxPositions - state.holdings.length;
        let canBuy = isAccumulation ? (state.cash >= 1000) : (availableSlots > 0 && state.cash >= 1000);

        const rotationEnabled = state.config.rotationEnabled !== false;
        const minCandScore = state.config.rotationMinCandidateScore || 88;
        const maxUnderperformerProfit = state.config.rotationMaxUnderperformerProfit ?? 2.0;

        if (!isAccumulation && rotationEnabled && (!canBuy || state.cash < targetStock.price) && targetStock.score >= minCandScore && state.holdings.length > 0) {
          let worstHoldingIndex = -1;
          let worstHoldingProfit = Infinity;

          for (let j = 0; j < state.holdings.length; j++) {
            const h = state.holdings[j];
            if (h.buyDate === simDate) continue;
            if (h.profitPercent < worstHoldingProfit) {
              worstHoldingProfit = h.profitPercent;
              worstHoldingIndex = j;
            }
          }

          if (worstHoldingIndex !== -1 && worstHoldingProfit <= maxUnderperformerProfit) {
            const position = state.holdings[worstHoldingIndex];
            const stockData = cachedData[position.symbol];
            const dayBar = stockData ? stockData.find(row => row.date === simDate) : null;
            const sellPrice = dayBar ? dayBar.close : position.currentPrice;
            const revenue = position.quantity * sellPrice;

            if (state.cash + revenue >= targetStock.price) {
              const cost = position.quantity * position.buyPrice;
              const profit = revenue - cost;
              const profitPercent = (profit / cost) * 100;
              state.cash += revenue;

              state.history.push({
                symbol: position.symbol,
                name: position.name,
                sector: position.sector,
                quantity: position.quantity,
                buyPrice: position.buyPrice,
                sellPrice,
                buyDate: position.buyDate,
                sellDate: simDate,
                profit,
                profitPercent,
                reason: `Replaced by ${targetStock.symbol} (Score: ${targetStock.score.toFixed(1)})`
              });
              todayTransactions.push({
                type: 'SELL',
                symbol: position.symbol,
                quantity: position.quantity,
                price: sellPrice,
                profit,
                profitPercent,
                reason: `Replaced by ${targetStock.symbol}`
              });
              state.holdings.splice(worstHoldingIndex, 1);
              canBuy = true;
            }
          }
        }

        if (canBuy && state.cash >= 1000) {
          if (executeBuy(targetStock)) {
            todayBuysCount++;
          }
          if (todayBuysCount >= maxBuysToday) break;
        }
      }
    } else {
      // -------------------------------------------------------------------------
      // AGGRESSIVE APPROACH: Broad High-Frequency Momentum Execution (~172 trades/yr)
      // -------------------------------------------------------------------------
      // 1. First priority: Pyramiding winning positions
      for (const cand of candidates.filter(x => x.isAccumulation)) {
        if (state.cash < 4000) break;
        executeBuy(cand);
      }

      // 2. Second priority: New Breakouts & Expansion setups with capital rotation
      const rotationEnabled = state.config.rotationEnabled !== false;
      const minCandScore = state.config.rotationMinCandidateScore || 88;
      const maxUnderperformerProfit = state.config.rotationMaxUnderperformerProfit ?? 2.0;

      for (const targetStock of candidates.filter(x => !x.isAccumulation)) {
        // Only block non-accumulation buys if market is in confirmed deep crash (return5d < -2.0%)
        if (marketRegime.regime === 'RISK_OFF' && marketRegime.return5d < -0.02) {
          continue;
        }

        const isFull = state.holdings.length >= state.config.maxPositions;
        const lowCash = state.cash < targetStock.price || state.cash < 4000;

        if ((isFull || lowCash) && rotationEnabled && targetStock.score >= minCandScore && state.holdings.length > 0) {
          let worstHoldingIndex = -1;
          let worstHoldingProfit = Infinity;

          for (let j = 0; j < state.holdings.length; j++) {
            const h = state.holdings[j];
            if (h.buyDate === simDate) continue;
            if (h.profitPercent < worstHoldingProfit) {
              worstHoldingProfit = h.profitPercent;
              worstHoldingIndex = j;
            }
          }

          if (worstHoldingIndex !== -1 && worstHoldingProfit <= maxUnderperformerProfit) {
            const position = state.holdings[worstHoldingIndex];
            const stockData = cachedData[position.symbol];
            const dayBar = stockData ? stockData.find(row => row.date === simDate) : null;
            const sellPrice = dayBar ? dayBar.close : position.currentPrice;
            const revenue = position.quantity * sellPrice;

            if (state.cash + revenue >= targetStock.price) {
              const cost = position.quantity * position.buyPrice;
              const profit = revenue - cost;
              const profitPercent = (profit / cost) * 100;
              state.cash += revenue;

              state.history.push({
                symbol: position.symbol,
                name: position.name,
                sector: position.sector,
                quantity: position.quantity,
                buyPrice: position.buyPrice,
                sellPrice,
                buyDate: position.buyDate,
                sellDate: simDate,
                profit,
                profitPercent,
                reason: `Replaced by ${targetStock.symbol} (Score: ${targetStock.score.toFixed(1)})`
              });
              todayTransactions.push({
                type: 'SELL',
                symbol: position.symbol,
                quantity: position.quantity,
                price: sellPrice,
                profit,
                profitPercent,
                reason: `Replaced by ${targetStock.symbol}`
              });
              state.holdings.splice(worstHoldingIndex, 1);
            }
          }
        }

        if (state.holdings.length >= state.config.maxPositions) break;
        if (state.cash < 4000) break;

        executeBuy(targetStock);
      }
    }

    // --- 4. End-of-Day Valuation and Logging ---
    let holdingsValue = 0;
    for (const h of state.holdings) {
      // Re-fetch close price to ensure accurate valuation
      const stockData = cachedData[h.symbol];
      const dayBar = stockData ? stockData.find(row => row.date === simDate) : null;
      if (dayBar) {
        h.currentPrice = dayBar.close;
        h.value = h.quantity * dayBar.close;
        h.profit = h.value - (h.quantity * h.buyPrice);
        h.profitPercent = (h.profit / (h.quantity * h.buyPrice)) * 100;
      }
      holdingsValue += h.value;
    }

    const totalValue = state.cash + holdingsValue;
    const profitPercent = currentTotalDeposited > 0 ? ((totalValue - currentTotalDeposited) / currentTotalDeposited) * 100 : 0.0;

    // Append to valuation history
    state.valuationHistory.push({
      date: simDate,
      cash: state.cash,
      holdingsValue: holdingsValue,
      totalValue: totalValue,
      profitPercent: profitPercent,
      totalDeposited: currentTotalDeposited
    });

    // Determine Day Sentiment based on transactions or random fluctuation
    let sentiment = 'NEUTRAL';
    const sellsCount = todayTransactions.filter(t => t.type === 'SELL').length;
    const buysCount = todayTransactions.filter(t => t.type === 'BUY').length;

    if (sellsCount > 0) {
      const profitableSells = todayTransactions.filter(t => t.type === 'SELL' && t.profit > 0).length;
      sentiment = profitableSells > sellsCount / 2 ? 'BULLISH' : 'BEARISH';
    } else if (buysCount > 0) {
      sentiment = 'BULLISH';
    } else {
      // Random mock fluctuation based on date hash
      const hash = simDate.charCodeAt(simDate.length - 1) + simDate.charCodeAt(simDate.length - 2);
      if (hash % 3 === 0) sentiment = 'BULLISH';
      else if (hash % 3 === 1) sentiment = 'BEARISH';
      else sentiment = 'VOLATILE';
    }

    // Generate Narrative log
    const logText = generateNarrativeLog(simDate, sentiment, state.cash, state.holdings, totalValue, todayTransactions);
    state.logs.unshift({
      date: simDate,
      sentiment: sentiment,
      text: logText,
      details: {
        cash: state.cash,
        holdingsValue: holdingsValue,
        totalValue: totalValue,
        activePositions: state.holdings.length,
        transactions: todayTransactions.map(t => ({
          type: t.type,
          symbol: t.symbol ? t.symbol.replace('.NS', '') : null,
          quantity: t.quantity,
          price: t.price,
          targetPrice: t.targetPrice,
          stopLoss: t.stopLoss,
          profit: t.profit,
          profitPercent: t.profitPercent,
          reason: t.reason,
          amount: t.amount
        })),
        holdings: state.holdings.map(h => ({
          symbol: h.symbol.replace('.NS', ''),
          quantity: h.quantity,
          buyPrice: h.buyPrice,
          currentPrice: h.currentPrice,
          profitPercent: h.profitPercent,
          value: h.value
        }))
      }
    });

    state.lastSimulationDate = simDate;
  }

  await saveState(state, pType);
  return state;
}

// Get basic quote details for a symbol (for scanner screen)
async function getWatchlistQuotes(endDateStr) {
  const cachedData = await updateCache(endDateStr);
  const result = [];

  for (const stock of WATCHLIST) {
    const history = cachedData[stock.symbol];
    if (history && history.length >= 2) {
      const todayBar = history[history.length - 1];
      const yesterdayBar = history[history.length - 2];

      const change = todayBar.close - yesterdayBar.close;
      const changePercent = (change / yesterdayBar.close) * 100;

      // Extract closes, highs, lows, volumes for technical indicators
      const closes = history.map(r => r.close);
      const highs = history.map(r => r.high);
      const lows = history.map(r => r.low);
      const volumes = history.map(r => r.volume || 0);

      const rsiArray = calculateRSI(closes, 14);
      const ema20Array = calculateEMA(closes, 20);
      const ema50Array = calculateEMA(closes, 50);
      const sma20Array = calculateSMA(closes, 20);
      const sma50Array = calculateSMA(closes, 50);
      const rvolArray = calculateRVOL(volumes, 20);
      const breakout20 = checkBreakouts(closes, highs, lows, 20);

      const rsi = rsiArray[rsiArray.length - 1];
      const ema20 = ema20Array[ema20Array.length - 1];
      const ema50 = ema50Array[ema50Array.length - 1];
      const sma20 = sma20Array[sma20Array.length - 1];
      const sma50 = sma50Array[sma50Array.length - 1];
      const rvol = rvolArray[rvolArray.length - 1] || 1.0;

      // Intelligent Action recommendations based on technical setup & volume
      let recommendation = 'HOLD / WAIT';
      let recReason = 'Trend is consolidating, waiting for directional expansion.';

      if (todayBar.close > ema20 && ema20 > ema50 && breakout20.isBullishBreakout && rvol >= 1.2 && rsi >= 53 && rsi <= 68 && todayBar.close <= ema20 * 1.045) {
        recommendation = 'STRONG BUY';
        recReason = `Volume-backed 20-day high breakout (${rvol.toFixed(1)}x RVOL, RSI: ${rsi.toFixed(1)}) in confirmed uptrend.`;
      } else if (ema20 > ema50 && todayBar.close >= ema20 * 0.985 && todayBar.close <= ema20 * 1.03 && todayBar.close > yesterdayBar.close && rsi >= 43 && rsi <= 58) {
        recommendation = 'ACCUMULATE';
        recReason = `Bouncing off 20 EMA support in primary uptrend (RSI: ${rsi.toFixed(1)}).`;
      } else if (rsi > 72 || (ema20 && todayBar.close > ema20 * 1.08)) {
        recommendation = 'HOLD / REDUCE';
        recReason = 'Short-term overbought/extended, watch for trailing stop-loss trigger.';
      } else if (ema20 && ema50 && todayBar.close < ema20 && ema20 < ema50) {
        recommendation = 'AVOID';
        recReason = 'Asset in confirmed downtrend below 20 and 50 EMAs.';
      }

      result.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        cap: stock.cap || 'Equity',
        price: todayBar.close,
        change,
        changePercent,
        rsi: rsi || 50,
        sma20: sma20 || ema20 || todayBar.close,
        sma50: sma50 || ema50 || todayBar.close,
        rvol: rvol,
        recommendation,
        recReason,
        history: history.slice(-30) // Last 30 trading days for mini charts
      });
    } else {
      result.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        cap: stock.cap || 'Equity',
        price: 0,
        change: 0,
        changePercent: 0,
        rsi: 50,
        sma20: 0,
        sma50: 0,
        rvol: 1.0,
        recommendation: 'WAIT',
        recReason: 'Loading market data...',
        history: []
      });
    }
  }

  return result;
}

// Scan and rank entire stock universe using algorithmic multi-factor criteria.
// Returns Top 25 stocks along with each indicator and pass/fail boolean status.
async function getTop25AlgoRankings(simDate, forceRefresh = false) {
  let state;
  try {
    state = await loadState();
  } catch (_) {
    state = { holdings: [], config: { maxPositions: 12 } };
  }

  let targetDate = simDate;
  if (!targetDate || targetDate === 'today') {
    targetDate = formatUTCDate(new Date());
  }

  const cachedData = await updateCache(targetDate, forceRefresh);
  const benchmarkData = cachedData['^NSEI'] || cachedData['NIFTYBEES.NS'] || cachedData['RELIANCE.NS'];

  // Auto-fallback: If targetDate has no session bar in benchmark data (e.g. exchange holiday or weekend),
  // automatically step back to the true latest completed market session bar.
  if (benchmarkData && benchmarkData.length > 0) {
    const hasTargetBar = benchmarkData.some(row => row.date === targetDate);
    if (!hasTargetBar) {
      const priorBars = benchmarkData.filter(row => row.date <= targetDate);
      if (priorBars.length > 0) {
        const fallbackSession = priorBars[priorBars.length - 1].date;
        console.log(`[getTop25AlgoRankings] Target date ${targetDate} has no benchmark session bar (exchange holiday/weekend). Auto-resolving to latest completed session: ${fallbackSession}`);
        targetDate = fallbackSession;
      }
    }
  }

  const isConservative = (state.config?.aggressiveness === 'conservative');
  const marketRegime = evaluateMarketRegime(targetDate, cachedData, isConservative);

  let benchmarkReturn20d = 0;
  if (benchmarkData && benchmarkData.length > 0) {
    const bIdx = benchmarkData.findIndex(row => row.date === targetDate);
    const validBIdx = bIdx !== -1 ? bIdx : benchmarkData.length - 1;
    if (validBIdx >= 20) {
      const bClose = benchmarkData[validBIdx].close;
      const bPast = benchmarkData[validBIdx - 20].close;
      if (bPast > 0) benchmarkReturn20d = (bClose - bPast) / bPast;
    }
  }

  const scoredStocks = [];

  for (const stock of WATCHLIST) {
    // Exclude index ETFs from single-stock ranking
    if (stock.sector === 'ETFs') continue;

    const history = cachedData[stock.symbol];
    if (!history || history.length < 15) continue;

    let dayIdx = history.findIndex(row => row.date === targetDate);
    if (dayIdx === -1) dayIdx = history.length - 1;
    if (dayIdx < 14) continue;

    const subHistory = history.slice(0, dayIdx + 1);
    const closes = subHistory.map(r => r.close);
    const highs = subHistory.map(r => r.high);
    const lows = subHistory.map(r => r.low);
    const opens = subHistory.map(r => r.open !== undefined ? r.open : r.close);
    const volumes = subHistory.map(r => r.volume || 0);

    const len = closes.length;
    const currentClose = closes[len - 1];
    const prevClose = closes[len - 2] || currentClose;
    const currentOpen = opens[len - 1];
    const currentHigh = highs[len - 1];
    const currentLow = lows[len - 1];

    if (currentClose < 20) continue; // skip micro/penny stocks

    const dayChange = currentClose - prevClose;
    const dayChangePercent = prevClose > 0 ? (dayChange / prevClose) * 100 : 0;

    // Technical calculations
    const ema20Arr = calculateEMA(closes, 20);
    const ema50Arr = calculateEMA(closes, 50);
    const rsiArr = calculateRSI(closes, 14);
    const rvolArr = calculateRVOL(volumes, 20);
    const adxArr = calculateADX(highs, lows, closes, 14);
    const breakout20 = checkBreakouts(closes, highs, lows, 20);
    const ema20Slope = calculateSlope(ema20Arr, 5);
    const ema50Slope = calculateSlope(ema50Arr, 10);

    const ema20 = ema20Arr[len - 1];
    const ema50 = ema50Arr[len - 1];
    const rsi = rsiArr[len - 1] || 50;
    const rvol = rvolArr[len - 1] || 1.0;
    const adx = adxArr[len - 1] || 20;

    // Relative strength & extension returns
    const past20Close = closes[Math.max(0, len - 21)];
    const stockReturn20d = past20Close > 0 ? (currentClose - past20Close) / past20Close : 0;
    const alpha20d = (stockReturn20d - benchmarkReturn20d) * 100;

    const past10Close = closes[Math.max(0, len - 11)];
    const stockReturn10d = past10Close > 0 ? (currentClose - past10Close) / past10Close : 0;

    // CLV
    const candleRange = currentHigh - currentLow;
    const clv = candleRange > 0 ? (currentClose - currentLow) / candleRange : 0.5;

    // Distance from 20 EMA & 20-day high
    const distFromEma20 = ema20 > 0 ? ((currentClose - ema20) / ema20) * 100 : 0;
    const highestHigh20 = breakout20.highestHigh20 || currentHigh;
    const distFrom20dHigh = highestHigh20 > 0 ? ((highestHigh20 - currentClose) / highestHigh20) * 100 : 0;

    // Indicator Evaluations (Pass/Fail matching Active Strategy Approach)
    const passTrend = (currentClose >= (ema20 || 0)) && (ema50 ? ema20 >= ema50 * (isConservative ? 1.01 : 1.005) : true);
    const passRS = alpha20d >= (isConservative ? 4.0 : 3.0);
    const passRvol = rvol >= (isConservative ? 1.90 : 1.75);
    const passRSI = isConservative ? (rsi >= 52 && rsi <= 72.5) : (rsi >= 48 && rsi <= 76.5);
    const passBreakout = isConservative ? breakout20.isBullishBreakout : (breakout20.isBullishBreakout || distFrom20dHigh <= 1.5);
    const passCLV = clv >= (isConservative ? 0.68 : 0.64);
    const passADX = adx >= 20;
    const passSafety = distFromEma20 >= -1.0 && distFromEma20 <= 8.0 && stockReturn10d <= 0.18;

    const indicators = [
      {
        id: 'trend',
        name: 'Stage 2 Trend',
        shortName: 'Trend',
        criteria: isConservative
          ? 'Price >= 20 EMA, 20 EMA > 50 EMA by 1.0% with positive slope'
          : 'Price >= 20 EMA, 20 EMA > 50 EMA & rising',
        value: ema20 && ema50 ? `EMA20 > EMA50` : `EMA20: ₹${(ema20 || 0).toFixed(0)}`,
        metric: `₹${(ema20 || 0).toFixed(0)} / ₹${(ema50 || 0).toFixed(0)}`,
        passed: Boolean(passTrend)
      },
      {
        id: 'rs',
        name: 'Relative Strength',
        shortName: 'RS Alpha',
        criteria: isConservative
          ? 'Alpha >= +4.0% institutional outperformance vs Nifty 50'
          : 'Alpha >= +3.0% outperformance vs Nifty 50',
        value: `${alpha20d >= 0 ? '+' : ''}${alpha20d.toFixed(1)}%`,
        metric: `${alpha20d >= 0 ? '+' : ''}${alpha20d.toFixed(1)}% vs Nifty`,
        passed: Boolean(passRS)
      },
      {
        id: 'rvol',
        name: 'Volume Surge',
        shortName: 'RVOL',
        criteria: isConservative
          ? 'Institutional volume >= 1.90x 20-day avg'
          : 'Institutional volume >= 1.75x 20-day avg',
        value: `${rvol.toFixed(1)}x`,
        metric: `${rvol.toFixed(2)}x Vol`,
        passed: Boolean(passRvol)
      },
      {
        id: 'rsi',
        name: 'RSI Momentum',
        shortName: 'RSI',
        criteria: isConservative
          ? 'RSI within institutional sweet spot (52.0 - 72.5)'
          : 'RSI within expansion band (48.0 - 76.5)',
        value: `${rsi.toFixed(1)}`,
        metric: `${rsi.toFixed(1)} RSI`,
        passed: Boolean(passRSI)
      },
      {
        id: 'breakout',
        name: '20D Breakout',
        shortName: 'Breakout',
        criteria: isConservative
          ? 'Confirmed 20-day high close (no pre-breakout speculation)'
          : 'New 20-day high or coiling within 1.5% of resistance',
        value: breakout20.isBullishBreakout ? 'New High' : `-${distFrom20dHigh.toFixed(1)}%`,
        metric: breakout20.isBullishBreakout ? 'Breakout High!' : `${distFrom20dHigh.toFixed(1)}% to High`,
        passed: Boolean(passBreakout)
      },
      {
        id: 'clv',
        name: 'CLV Pressure',
        shortName: 'CLV',
        criteria: isConservative
          ? 'Close Location Value >= 68% (upper third of daily range)'
          : 'Close Location Value >= 64% (upper candle range)',
        value: `${(clv * 100).toFixed(0)}%`,
        metric: `${(clv * 100).toFixed(0)}% Range`,
        passed: Boolean(passCLV)
      },
      {
        id: 'adx',
        name: 'ADX Velocity',
        shortName: 'ADX',
        criteria: 'ADX >= 20.0 (Confirmed directional trend)',
        value: `${adx.toFixed(1)}`,
        metric: `${adx.toFixed(1)} ADX`,
        passed: Boolean(passADX)
      },
      {
        id: 'safety',
        name: 'Extension Safety',
        shortName: 'Safety',
        criteria: '<= 8.5% above 20 EMA (No parabolic trap)',
        value: `${distFromEma20 >= 0 ? '+' : ''}${distFromEma20.toFixed(1)}%`,
        metric: `${distFromEma20 >= 0 ? '+' : ''}${distFromEma20.toFixed(1)}% from EMA20`,
        passed: Boolean(passSafety)
      }
    ];

    const passedCount = indicators.filter(i => i.passed).length;

    // Confluence Score Calculation (0-100)
    let score = 45;
    if (breakout20.isBullishBreakout && passTrend && passRvol && passRSI && passCLV) {
      score = 88;
    } else if (passTrend && passBreakout && passRS) {
      score = 76;
    } else if (passTrend && (passRS || passRvol)) {
      score = 65;
    } else if (passTrend) {
      score = 55;
    }

    // Add factor weights matching scanMarketCandidates
    if (alpha20d >= 8.0) score += 9;
    else if (alpha20d >= 4.0) score += 6;
    else if (alpha20d >= 1.5) score += 3;
    else if (alpha20d < 0) score -= 6;

    if (rvol >= 3.0) score += 9;
    else if (rvol >= 2.0) score += 6;
    else if (rvol >= 1.5) score += 3;
    else if (rvol < 0.9) score -= 5;

    if (passTrend && ema20Slope > 0.05) score += 5;
    if (clv >= 0.70) score += 4;
    else if (clv < 0.45) score -= 4;

    if (distFromEma20 >= 1.0 && distFromEma20 <= 7.5) score += 5;
    else if (distFromEma20 > 11.0) score -= 6;

    if (adx >= 25) score += 4;
    if (dayChangePercent >= 1.4 && currentClose >= currentOpen) score += 4;

    const algoScore = Math.max(15, Math.min(99, Math.round(score)));

    let signal = 'WATCHLIST';
    if (algoScore >= 88 && passedCount >= 6) signal = 'STRONG BUY';
    else if (algoScore >= 75 && passedCount >= 5) signal = 'BUY SETUP';
    else if (algoScore >= 60 && passedCount >= 4) signal = 'ACCUMULATE';
    else if (!passTrend || algoScore < 45) signal = 'AVOID / WAIT';

    // Execution Diagnostics: Why was this stock bought or not bought on this simulation date?
    const exactBarOnDate = history.find(row => row.date === targetDate);
    const latestAvailableBarDate = history[history.length - 1]?.date || 'N/A';
    const activeHolding = (state.holdings || []).find(h => h.symbol === stock.symbol);
    const holdingsCount = (state.holdings || []).length;
    const maxPositions = state.config?.maxPositions || 12;

    let executionStatus = null;

    if (!exactBarOnDate) {
      executionStatus = {
        status: 'NO_BAR_TODAY',
        label: `Feed Missing (${latestAvailableBarDate})`,
        reason: `No market bar received in data feed for ${targetDate} (latest bar is ${latestAvailableBarDate}). Live engine cannot execute orders without an active session bar.`
      };
    } else if (activeHolding) {
      executionStatus = {
        status: 'ACTIVE_HOLDING',
        label: 'Currently Held',
        reason: `Already actively held in portfolio since ${activeHolding.buyDate} (${(activeHolding.profitPercent || 0) >= 0 ? '+' : ''}${(activeHolding.profitPercent || 0).toFixed(1)}% P&L).`
      };
    } else if (holdingsCount >= maxPositions) {
      executionStatus = {
        status: 'PORTFOLIO_FULL',
        label: 'Portfolio Full',
        reason: `Trading desk is at full capacity (${holdingsCount}/${maxPositions} concurrent holdings). No available position slot.`
      };
    }

    if (!executionStatus) {
      // Evaluate strict Strategy 1 live execution criteria
      const dayMove = prevClose > 0 ? (currentClose - prevClose) / prevClose : 0;
      const isBreakout = breakout20.isBullishBreakout;
      const isAboveEma20 = currentClose > ema20;
      const isEmaAligned = ema50 ? ema20 >= ema50 * 0.995 : true;
      const rsAlphaExcess = stockReturn20d - benchmarkReturn20d;
      const isAlpha3 = rsAlphaExcess >= 0.03;
      const isRvol175 = rvol >= 1.75;
      const isRsiSweet = rsi >= 52 && rsi <= 76.5;
      const isGreen = currentClose >= currentOpen;
      const isClv64 = clv >= 0.64;
      const isDayMove14 = dayMove >= 0.014;
      const isExtSafe = currentClose <= ema20 * 1.08;
      const is10dSafe = stockReturn10d <= 0.18;

      if (isBreakout && isAboveEma20 && isEmaAligned && isAlpha3 && isRvol175 && isRsiSweet && isGreen && isClv64 && isDayMove14 && isExtSafe && is10dSafe) {
        executionStatus = {
          status: 'QUALIFIED_BUY',
          label: 'Buy Trigger Met',
          reason: 'Passed 100% of strict live execution triggers. Eligible for automated buy execution.'
        };
      } else {
        if (!isBreakout) {
          executionStatus = {
            status: 'AWAITING_BREAKOUT',
            label: 'Awaiting Breakout High',
            reason: `Price is ${distFrom20dHigh.toFixed(1)}% below 20-day high (₹${highestHigh20.toFixed(1)}). Live execution requires a clean 20-day breakout close.`
          };
        } else if (!isClv64) {
          executionStatus = {
            status: 'CLV_REJECTION',
            label: `CLV ${(clv * 100).toFixed(0)}% < 64%`,
            reason: `Candle Close Location Value is ${(clv * 100).toFixed(1)}%. Live engine requires >= 64.0% to reject upper-wick selling pressure traps.`
          };
        } else if (!isRvol175) {
          executionStatus = {
            status: 'RVOL_INSUFFICIENT',
            label: `RVOL ${rvol.toFixed(1)}x < 1.75x`,
            reason: `Relative volume is ${rvol.toFixed(2)}x. Live engine requires >= 1.75x institutional volume surge to confirm big-money backing.`
          };
        } else if (!isDayMove14) {
          executionStatus = {
            status: 'DAY_MOVE_LOW',
            label: `Move +${(dayMove * 100).toFixed(1)}% < 1.4%`,
            reason: `Daily breakout candle expansion is +${(dayMove * 100).toFixed(1)}%. Live engine requires >= +1.4% expansion on breakout day.`
          };
        } else if (!isAlpha3) {
          executionStatus = {
            status: 'ALPHA_LOW',
            label: `Alpha +${(rsAlphaExcess * 100).toFixed(1)}% < 3%`,
            reason: `Relative Strength Alpha is +${(rsAlphaExcess * 100).toFixed(1)}% vs Nifty. Live engine requires >= +3.0% alpha for high-conviction swing leaders.`
          };
        } else if (!isGreen) {
          executionStatus = {
            status: 'RED_CANDLE',
            label: 'Red Intraday Candle',
            reason: 'Candle closed below open (Close < Open). Breakout day must be an expanding green candle.'
          };
        } else if (!isExtSafe) {
          executionStatus = {
            status: 'EXTENDED',
            label: `Extended ${distFromEma20.toFixed(1)}% > 8%`,
            reason: `Price is ${distFromEma20.toFixed(1)}% above 20 EMA. Live engine limits entry to <= 8.0% above 20 EMA to avoid chasing extended moves.`
          };
        } else if (!isRsiSweet) {
          executionStatus = {
            status: 'RSI_EXHAUSTED',
            label: `RSI ${rsi.toFixed(1)} > 76.5`,
            reason: `14-day RSI is ${rsi.toFixed(1)}. Live engine caps entry at <= 76.5 to avoid buying at the exhausted climax of momentum moves.`
          };
        } else {
          executionStatus = {
            status: 'STRICT_FILTER',
            label: 'Execution Filter Pending',
            reason: 'High-conviction watchlist setup, but did not meet live breakout entry rules.'
          };
        }
      }
    }

    if (!executionStatus) {
      executionStatus = { status: 'WATCHLIST_PENDING', label: 'Watchlist Setup', reason: '' };
    }

    const stopLossPercent = state.config?.stopLossPercent || 0.048;
    const targetProfitPercent = state.config?.targetProfitPercent || 0.25;
    const isHighConviction = algoScore >= 93;
    const suggestedAllocPct = isHighConviction ? 15.0 : 12.5;
    const stopLossPrice = Number((currentClose * (1 - stopLossPercent)).toFixed(2));
    const targetPrice = Number((currentClose * (1 + targetProfitPercent)).toFixed(2));
    const riskAmount = Number((currentClose - stopLossPrice).toFixed(2));
    const rewardAmount = Number((targetPrice - currentClose).toFixed(2));

    scoredStocks.push({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      cap: stock.cap || 'Equity',
      price: currentClose,
      change: dayChange,
      changePercent: dayChangePercent,
      algoScore,
      signal,
      executionStatus,
      passedCount,
      totalIndicators: indicators.length,
      indicators,
      history: history.slice(Math.max(0, dayIdx - 20), dayIdx + 1),
      orderTicket: {
        action: 'BUY',
        orderType: 'LIMIT',
        productType: 'CNC / DELIVERY',
        limitPrice: Number(currentClose.toFixed(2)),
        limitPriceBuffered: Number((currentClose * 1.002).toFixed(2)),
        stopLoss: stopLossPrice,
        stopLossPercent: Number((stopLossPercent * 100).toFixed(1)),
        stopLossAmount: riskAmount,
        targetPrice: targetPrice,
        targetProfitPercent: Number((targetProfitPercent * 100).toFixed(1)),
        targetProfitAmount: rewardAmount,
        riskRewardRatio: '1 : 5.2',
        suggestedAllocPct: suggestedAllocPct,
        convictionGrade: isHighConviction ? 'Grade A+ (High Conviction)' : algoScore >= 80 ? 'Grade A (Standard)' : 'Grade B (Watchlist)',
        isQualified: executionStatus?.status === 'QUALIFIED_BUY',
        sessionDate: targetDate
      }
    });
  }

  // Sort by algoScore descending, then by passedCount, then by RVOL
  scoredStocks.sort((a, b) => {
    if (b.algoScore !== a.algoScore) return b.algoScore - a.algoScore;
    if (b.passedCount !== a.passedCount) return b.passedCount - a.passedCount;
    return b.changePercent - a.changePercent;
  });

  const allRanked = scoredStocks.map((item, idx) => ({
    ...item,
    rank: idx + 1
  }));

  return {
    date: targetDate,
    marketRegime: marketRegime.regime,
    strategyApproach: isConservative ? 'conservative' : 'aggressive',
    strategyTitle: isConservative ? 'Conservative (Institutional ~40-41 Trades/Yr)' : 'Aggressive (Broad Momentum ~172 Trades/Yr)',
    totalScanned: scoredStocks.length,
    top25: allRanked.slice(0, 25),
    rankings: allRanked
  };
}

// Re-evaluate all open holdings against current config targets using the last known price.
// Called immediately after a config change so new profit/stop targets take effect without
// needing to wait for the next trading day simulation.
async function reEvaluateHoldings(portfolioType = 'backtest') {
  const pType = portfolioType || 'backtest';
  const state = await loadState(pType);
  if (!state.holdings || state.holdings.length === 0) {
    console.log('[reEvaluate] No open holdings to re-evaluate.');
    return { closedTrades: [], remainingHoldings: [] };
  }

  const simDate = state.lastSimulationDate;
  const cachedData = await updateCache(simDate);

  const remainingHoldings = [];
  const closedTrades = [];

  for (const position of state.holdings) {
    const stockData = cachedData[position.symbol];
    // Use the last available bar for this position (most recent trading day)
    const dayBar = stockData ? [...stockData].reverse().find(row => row.date <= simDate) : null;

    if (!dayBar) {
      remainingHoldings.push(position);
      continue;
    }

    const high = dayBar.high;
    const low = dayBar.low;
    const close = dayBar.close;

    let triggerSell = false;
    let sellPrice = close;
    let sellReason = '';

    // --- Institutional Trend-Following Exit Engine (Synced with Simulation) ---
    const buyIdx = stockData.findIndex(row => row.date === position.buyDate);
    const currIdx = stockData.findIndex(row => row.date === simDate);
    const tradingDaysHeld = (buyIdx !== -1 && currIdx !== -1) ? (currIdx - buyIdx) : Math.round((new Date(simDate) - new Date(position.buyDate)) / (1000 * 60 * 60 * 24));
    const currentGainPct = ((close - position.buyPrice) / position.buyPrice) * 100;
    const maxProfitGainPercent = ((high - position.buyPrice) / position.buyPrice) * 100;

    let dayEma20 = null;
    let stockRsi = 50;
    if (currIdx >= 10) {
      const closesSoFar = stockData.slice(0, currIdx + 1).map(r => r.close);
      const ema20Arr = calculateEMA(closesSoFar, 20);
      dayEma20 = ema20Arr[ema20Arr.length - 1];
      const rsiArr = calculateRSI(closesSoFar, 14);
      stockRsi = rsiArr[rsiArr.length - 1] || 50;
    }

    // Dynamic Profit Protection (Uncapped Upside):
    // Step 1: At +5.0% peak gain, move stop loss to Breakeven (+0.5% buffer)
    if (maxProfitGainPercent >= 5.0) {
      const beLevel = position.buyPrice * 1.005;
      if (beLevel > position.stopLoss) position.stopLoss = beLevel;
    }

    // Step 2: At +8.0% gain, lock in +5.0% minimum profit
    if (maxProfitGainPercent >= 8.0) {
      const lockProfit = position.buyPrice * 1.050;
      if (lockProfit > position.stopLoss) position.stopLoss = lockProfit;
    }

    // Step 3: At +10.5% gain, lock in +8.0% minimum profit
    if (maxProfitGainPercent >= 10.5) {
      const lockProfit2 = position.buyPrice * 1.080;
      if (lockProfit2 > position.stopLoss) position.stopLoss = lockProfit2;
    }

    // Step 4: At +13.0% gain, lock in +10.5% minimum profit
    if (maxProfitGainPercent >= 13.0) {
      const lockProfit3 = position.buyPrice * 1.105;
      if (lockProfit3 > position.stopLoss) position.stopLoss = lockProfit3;
    }

    // Step 5: At +15.0% gain, activate RUNNER MODE (trail 20 EMA or lock +12.5%)
    if (maxProfitGainPercent >= 15.0 && dayEma20) {
      const runnerTrail = Math.max(position.buyPrice * 1.125, dayEma20 * 0.985);
      if (runnerTrail > position.stopLoss) position.stopLoss = runnerTrail;
    }

    // Check Stop-Loss / Trailing Stop Trigger
    const isTrailingStop = position.stopLoss > position.buyPrice;
    const initialStopBreach = close <= position.stopLoss || low <= position.stopLoss * 0.94;
    const trailingStopBreach = close <= position.stopLoss || low <= position.stopLoss * 0.98;

    if (isTrailingStop ? trailingStopBreach : initialStopBreach) {
      triggerSell = true;
      sellPrice = isTrailingStop
        ? (dayBar.open && dayBar.open < position.stopLoss ? dayBar.open : position.stopLoss)
        : Math.min(close, position.stopLoss);
      sellReason = isTrailingStop ? 'Trailing Profit Locked' : 'Stop Loss Triggered';
    }
    // Stagnation / Time Stop
    else if (tradingDaysHeld >= 22 && currentGainPct < -3.5 && dayEma20 && close < dayEma20 * 0.985) {
      triggerSell = true;
      sellPrice = close;
      sellReason = `Stagnation Time-Stop (${tradingDaysHeld}d held, ${currentGainPct.toFixed(1)}%)`;
    }
    // Parabolic Climax Blow-Off Exit
    else if (currentGainPct >= 20.0 && stockRsi >= 82 && dayEma20 && close > dayEma20 * 1.12) {
      triggerSell = true;
      sellPrice = close;
      sellReason = `Parabolic Climax Blow-Off (${stockRsi.toFixed(1)} RSI, +${currentGainPct.toFixed(1)}%) Profit Taken`;
    }

    if (triggerSell) {
      const revenue = position.quantity * sellPrice;
      const cost = position.quantity * position.buyPrice;
      const profit = revenue - cost;
      const profitPercent = (profit / cost) * 100;

      state.cash += revenue;

      const completedTrade = {
        symbol: position.symbol,
        name: position.name,
        sector: position.sector,
        quantity: position.quantity,
        buyPrice: position.buyPrice,
        sellPrice: sellPrice,
        buyDate: position.buyDate,
        sellDate: simDate,
        profit: profit,
        profitPercent: profitPercent,
        reason: `${sellReason} (Config Re-evaluation)`,
        accumulated: position.isAccumulated || false
      };

      state.history.push(completedTrade);
      closedTrades.push(completedTrade);
      console.log(`[reEvaluate] SOLD ${position.symbol} @ ₹${sellPrice.toFixed(2)} — ${sellReason}. P&L: ₹${profit.toFixed(2)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
    } else {
      // Update current price but keep position
      position.currentPrice = close;
      position.value = position.quantity * close;
      position.profit = position.value - (position.quantity * position.buyPrice);
      position.profitPercent = (position.profit / (position.quantity * position.buyPrice)) * 100;
      remainingHoldings.push(position);
    }
  }

  state.holdings = remainingHoldings;
  await saveState(state, pType);

  console.log(`[reEvaluate] Done. Closed ${closedTrades.length} position(s), ${remainingHoldings.length} still open.`);
  return { state, closedTrades };
}

// Deploy available cash into candidate setups immediately on current simulation date
async function deployIdleCash(simDate, portfolioType = 'backtest') {
  const pType = portfolioType || 'backtest';
  const state = await loadState(pType);
  const targetDate = simDate || state.lastSimulationDate;
  const cachedData = await updateCache(targetDate);

  const hasAccumulationCandidate = state.holdings.some(h => !h.isAccumulated && (h.profitPercent || 0) >= 8.0);
  let availableSlots = state.config.maxPositions - state.holdings.length;
  if ((availableSlots <= 0 && !hasAccumulationCandidate) || state.cash < 1000) {
    return state;
  }

  const { candidates, marketRegime } = scanMarketCandidates(targetDate, cachedData, state.holdings, state.config);

  const maxDeployBuys = 4;
  let newBuysCount = 0;
  for (const targetStock of candidates) {
    if (newBuysCount >= maxDeployBuys) break;
    if (targetStock.sector === 'ETFs') continue;

    const isAccumulation = targetStock.isAccumulation;

    if (marketRegime && marketRegime.regime === 'RISK_OFF') {
      const isElite = targetStock.score >= 90 && ((targetStock.rsGain || 0) >= 0.04 || targetStock.strategy === 'PRE_BREAKOUT_BASE');
      if (!isElite) continue;
    } else if (!isAccumulation && marketRegime && marketRegime.regime === 'NEUTRAL' && targetStock.score < 76 && (targetStock.rsGain || 0) < 0.02) {
      continue;
    }


    availableSlots = state.config.maxPositions - state.holdings.length;
    if (!isAccumulation && (availableSlots <= 0 || state.cash < 1000)) continue;

    let currentHoldingsValue = 0;
    for (const h of state.holdings) currentHoldingsValue += h.value;
    const totalPortfolioValue = state.cash + currentHoldingsValue;
    const minCashReserve = totalPortfolioValue * 0.05;
    if (state.cash <= minCashReserve) break;

    // --- ACCUMULATION BRANCH ---
    if (isAccumulation) {
      const parent = state.holdings.find(h => h.symbol === targetStock.symbol);
      if (!parent || parent.isAccumulated) continue;

      const maxAddQtyByParent = Math.max(1, Math.floor(parent.quantity * 0.5));
      const maxCapitalForAdd = Math.min(totalPortfolioValue * 0.06, state.cash - minCashReserve);
      const maxAddQtyByCap = Math.floor(maxCapitalForAdd / targetStock.price);

      let qty = Math.min(maxAddQtyByParent, maxAddQtyByCap);
      if (qty <= 0 && parent.quantity === 1 && state.cash >= targetStock.price + minCashReserve) {
        if ((parent.value + targetStock.price) <= totalPortfolioValue * 0.20) {
          qty = 1;
        }
      }
      if (qty <= 0) continue;

      const addCost = qty * targetStock.price;
      if ((parent.value + addCost) > totalPortfolioValue * 0.20) continue;

      const totalNewQty = parent.quantity + qty;
      const oldCostBasis = parent.quantity * parent.buyPrice;
      const totalCostBasis = oldCostBasis + addCost;
      const blendedBuyPrice = totalCostBasis / totalNewQty;

      const guaranteedBreakevenStop = blendedBuyPrice * 1.005;
      const existingStopCapped = parent.stopLoss ? Math.min(parent.stopLoss, targetStock.price * 0.94) : 0;
      const newStopLoss = Math.max(guaranteedBreakevenStop, existingStopCapped);

      state.cash -= addCost;
      parent.quantity = totalNewQty;
      parent.buyPrice = blendedBuyPrice;
      parent.currentPrice = targetStock.price;
      parent.value = totalNewQty * targetStock.price;
      parent.profit = parent.value - totalCostBasis;
      parent.profitPercent = (parent.profit / totalCostBasis) * 100;
      parent.stopLoss = newStopLoss;
      parent.isAccumulated = true;
      parent.accumulatedDate = targetDate;
      parent.accumulatedQty = qty;
      parent.accumulatedPrice = targetStock.price;

      newBuysCount++;
      console.log(`[deployIdleCash] [ACCUMULATED] +${qty} shares of ${targetStock.symbol} @ ₹${targetStock.price}. Blended Entry: ₹${blendedBuyPrice.toFixed(2)}, Guaranteed SL: ₹${newStopLoss.toFixed(2)}`);
      continue;
    }

    // --- NEW POSITION BRANCH ---
    const isHighConviction = (targetStock.score || 0) >= 93;
    const allocPct = isHighConviction ? 0.15 : 0.125;
    const targetPositionSize = totalPortfolioValue * allocPct;
    const capitalAllocation = Math.min(targetPositionSize, state.cash - minCashReserve);
    let qty = Math.floor(capitalAllocation / targetStock.price);

    // High-priced momentum compounders:
    if (qty <= 0 && state.cash >= targetStock.price + minCashReserve && targetStock.price <= totalPortfolioValue * 0.35) {
      qty = 1;
    }

    if (qty > 0) {
      const cost = qty * targetStock.price;
      state.cash -= cost;
      const targetPrice = targetStock.price * (1 + state.config.targetProfitPercent);
      const stopLoss = targetStock.price * (1 - state.config.stopLossPercent);

      const newHolding = {
        symbol: targetStock.symbol,
        name: targetStock.name,
        sector: targetStock.sector,
        quantity: qty,
        buyPrice: targetStock.price,
        currentPrice: targetStock.price,
        buyDate: targetDate,
        targetPrice,
        stopLoss,
        value: cost,
        profit: 0.0,
        profitPercent: 0.0,
        buyReason: targetStock.reason,
        technicalStats: targetStock.technicalStats
      };

      state.holdings.push(newHolding);
      newBuysCount++;
      console.log(`[deployIdleCash] BOUGHT ${qty} shares of ${targetStock.symbol} @ ₹${targetStock.price}. Target: ₹${targetPrice.toFixed(2)}, SL: ₹${stopLoss.toFixed(2)}`);
      if (newBuysCount >= maxDeployBuys) break;
    }
  }

  if (newBuysCount > 0) {
    let holdingsValue = 0;
    for (const h of state.holdings) {
      holdingsValue += h.value;
    }
    const totalValue = state.cash + holdingsValue;
    const lastVal = state.valuationHistory[state.valuationHistory.length - 1];
    if (lastVal) {
      lastVal.cash = state.cash;
      lastVal.holdingsValue = holdingsValue;
      lastVal.totalValue = totalValue;
      lastVal.profitPercent = ((totalValue - lastVal.totalDeposited) / lastVal.totalDeposited) * 100;
    }
    await saveState(state, pType);
  }

  return state;
}

module.exports = {
  WATCHLIST,
  loadState,
  saveState,
  resetSimulation,
  runSimulation,
  reEvaluateHoldings,
  deployIdleCash,
  getWatchlistQuotes,
  evaluateMarketRegime,
  scanMarketCandidates,
  getTop25AlgoRankings,
  initLivePortfolio,
  executeLiveTrade,
  closeLiveTrade,
  getLatestCompletedMarketDate,
  updateCache
};
