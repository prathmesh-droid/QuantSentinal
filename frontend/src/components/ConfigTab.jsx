import React, { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

export default function ConfigTab({ portfolio, portfolioMode = 'live', onConfigUpdate, onReset, onDeposit, onTriggerRun }) {
  const { config } = portfolio;

  // Local state for configuration adjustments
  const [targetProfit, setTargetProfit] = useState(config.targetProfitPercent * 100);
  const [stopLoss, setStopLoss] = useState(config.stopLossPercent * 100);
  const [maxPositions, setMaxPositions] = useState(config.maxPositions);
  const [aggressiveness, setAggressiveness] = useState(config.aggressiveness);
  const [rotationEnabled, setRotationEnabled] = useState(config.rotationEnabled === true);
  const [rotationMinCandidateScore, setRotationMinCandidateScore] = useState(config.rotationMinCandidateScore || 88);
  const [rotationMaxUnderperformerProfit, setRotationMaxUnderperformerProfit] = useState(config.rotationMaxUnderperformerProfit ?? 2.0);

  // Local state for manual deposit
  const [depositAmount, setDepositAmount] = useState('');

  // Action status indicators
  const [saving, setSaving] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');

  // Simulation start date selection state
  const getTodayStr = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const todayStr = getTodayStr();

  const getPastDateStr = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const getYTDStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-01-01`;
  };

  const minHistoryDate = '2019-01-01';
  const default1YDate = getPastDateStr(365);
  const [selectedStartDate, setSelectedStartDate] = useState(default1YDate);
  const [autoReplay, setAutoReplay] = useState(true);

  const datePresets = [
    { label: 'From 2019', value: '2019-01-01' },
    { label: '5Y Backtest', value: getPastDateStr(1826) },
    { label: '3Y Backtest', value: getPastDateStr(1095) },
    { label: '2Y Backtest', value: getPastDateStr(730) },
    { label: '1Y Backtest', value: getPastDateStr(365) },
    { label: 'YTD', value: getYTDStr() },
    { label: '6M Ago', value: getPastDateStr(180) },
    { label: '3M Ago', value: getPastDateStr(90) },
    { label: 'Today (Clean Slate)', value: todayStr }
  ];

  const handleSaveConfig = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${API_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: portfolioMode,
          targetProfitPercent: targetProfit / 100,
          stopLossPercent: stopLoss / 100,
          maxPositions: Number(maxPositions),
          aggressiveness,
          rotationEnabled,
          rotationMinCandidateScore: Number(rotationMinCandidateScore),
          rotationMaxUnderperformerProfit: Number(rotationMaxUnderperformerProfit)
        })
      });
      if (!res.ok) throw new Error("Failed to save settings");
      const data = await res.json();
      onConfigUpdate(data.config);
      setMessage(`Configuration saved successfully for ${portfolioMode === 'live' ? 'Live Portfolio' : 'Backtest'}.`);
    } catch (err) {
      console.error(err);
      setMessage("Error: Could not save configuration.");
    } finally {
      setSaving(false);
    }
  };

  const handleDepositSubmit = async (e) => {
    e.preventDefault();
    if (!depositAmount || isNaN(depositAmount) || Number(depositAmount) <= 0) {
      setMessage("Error: Please enter a valid deposit amount.");
      return;
    }
    setDepositing(true);
    setMessage('');
    try {
      const res = await fetch(`${API_URL}/api/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: portfolioMode,
          amount: Number(depositAmount)
        })
      });
      if (!res.ok) throw new Error("Deposit failed");
      const data = await res.json();
      onDeposit(data.state);
      setDepositAmount('');
      setMessage(`Successfully injected ₹${Number(depositAmount).toLocaleString('en-IN')} cash into ${portfolioMode === 'live' ? 'Live Portfolio' : 'Backtest'}!`);
    } catch (err) {
      console.error(err);
      setMessage("Error: Capital injection failed.");
    } finally {
      setDepositing(false);
    }
  };

  const handleTriggerRun = async () => {
    setRunning(true);
    setMessage('');
    try {
      const res = await fetch(`${API_URL}/api/trigger-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: portfolioMode })
      });
      if (!res.ok) throw new Error("Trigger run failed");
      const data = await res.json();
      onTriggerRun(data.state);
      setMessage(`Daily run catch-up completed for ${portfolioMode === 'live' ? 'Live Portfolio' : 'Backtest'}.`);
    } catch (err) {
      console.error(err);
      setMessage("Error: Daily simulation run failed.");
    } finally {
      setRunning(false);
    }
  };

  const handleResetCustomDate = async (targetDate = selectedStartDate, replay = autoReplay) => {
    const isToday = targetDate === 'today' || targetDate === todayStr;
    const confirmMessage = (portfolioMode === 'live' || isToday)
      ? `Are you sure you want to reset the Live Portfolio to a fresh ₹1,00,000 cash slate today?\n\nAll current live holdings and history will be cleared.`
      : `Are you sure you want to reset the backtest simulation to start on ${targetDate}?\n\nAll current trade history will be reset to initial ₹1,00,000 on ${targetDate}.${replay ? '\n\nThe engine will automatically replay all trading days up to today.' : ''}`;

    if (!window.confirm(confirmMessage)) return;

    setResetting(true);
    setMessage('');
    try {
      const res = await fetch(`${API_URL}/api/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: portfolioMode,
          startDate: targetDate,
          replay: isToday ? false : replay
        })
      });
      if (!res.ok) throw new Error("Reset failed");
      const data = await res.json();
      onReset(data.state);
      setMessage(
        portfolioMode === 'live'
          ? "Live Portfolio successfully reset to clean ₹1,00,000 slate."
          : `Simulation successfully reset to ${targetDate}${replay ? ' and backtest replayed to today.' : '.'}`
      );
    } catch (err) {
      console.error(err);
      setMessage("Error: Could not reset simulation.");
    } finally {
      setResetting(false);
    }
  };

  const isErrorMessage = message.toLowerCase().includes('error');

  return (
    <div className="tab-content" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Active Portfolio Info Banner */}
      <div className="glass-panel" style={{ padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: portfolioMode === 'live' ? '4px solid var(--green)' : '4px solid var(--accent)' }}>
        <div>
          <span style={{ fontSize: '0.75rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em', color: portfolioMode === 'live' ? 'var(--green)' : 'var(--accent)' }}>
            Configuring Active Portfolio
          </span>
          <h3 style={{ margin: '0.2rem 0 0', fontSize: '1.1rem', fontWeight: '700' }}>
            {portfolioMode === 'live' ? 'Live Forward Trading Desk (₹1,00,000 Starting Slate)' : 'Backtesting Simulation Portfolio'}
          </h3>
        </div>
        <span className={`status-badge ${portfolioMode === 'live' ? 'live' : 'closed'}`} style={{ padding: '0.35rem 0.8rem' }}>
          <span className="status-dot" />
          <span>{portfolioMode === 'live' ? 'LIVE DESK ACTIVE' : 'BACKTEST ACTIVE'}</span>
        </span>
      </div>

      {/* Alert Messages banner */}
      {message && (
        <div style={{
          padding: '1rem',
          borderRadius: '10px',
          background: isErrorMessage ? 'var(--red-glow)' : 'var(--green-glow)',
          border: `1px solid ${isErrorMessage ? 'var(--red-border)' : 'var(--green-border)'}`,
          color: isErrorMessage ? 'var(--red)' : 'var(--green)',
          fontSize: '0.9rem',
          fontWeight: '500'
        }}>
          {message}
        </div>
      )}

      <div className="config-layout">
        {/* Risk Management Settings */}
        <div className="glass-panel">
          <div className="panel-header">
            <h2>Trading Parameters</h2>
          </div>
          <form onSubmit={handleSaveConfig} className="config-group">
            <div className="config-item">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                <label style={{ margin: 0 }}>Strategy Approach</label>
                <span style={{
                  fontSize: '0.75rem',
                  fontWeight: '700',
                  padding: '0.2rem 0.55rem',
                  borderRadius: '5px',
                  background: aggressiveness === 'conservative' ? 'rgba(59, 130, 246, 0.15)' : 'var(--accent-glow)',
                  color: aggressiveness === 'conservative' ? 'var(--blue, #3b82f6)' : 'var(--accent)',
                  border: `1px solid ${aggressiveness === 'conservative' ? 'rgba(59, 130, 246, 0.3)' : 'var(--accent-border)'}`,
                  letterSpacing: '0.4px'
                }}>
                  {aggressiveness === 'conservative' ? 'CONSERVATIVE SELECTED' : 'AGGRESSIVE SELECTED'}
                </span>
              </div>

              {/* Strategy Toggle Cards */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: '0.75rem',
                marginTop: '0.35rem'
              }}>
                {/* Aggressive Card */}
                <div
                  onClick={() => setAggressiveness('aggressive')}
                  style={{
                    padding: '0.9rem',
                    borderRadius: '8px',
                    border: (aggressiveness === 'aggressive' || aggressiveness === 'hyper')
                      ? '2px solid var(--accent)'
                      : '1px solid var(--border-color)',
                    background: (aggressiveness === 'aggressive' || aggressiveness === 'hyper')
                      ? 'var(--accent-glow)'
                      : 'var(--bg-card)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.45rem',
                    position: 'relative'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '700', fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                      Aggressive Approach
                    </span>
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: '700',
                      padding: '0.15rem 0.45rem',
                      borderRadius: '4px',
                      background: (aggressiveness === 'aggressive' || aggressiveness === 'hyper') ? 'var(--accent)' : 'var(--border-color)',
                      color: '#ffffff'
                    }}>
                      {(aggressiveness === 'aggressive' || aggressiveness === 'hyper') ? 'ACTIVE' : 'SELECT'}
                    </span>
                  </div>

                  <div style={{
                    fontSize: '0.78rem',
                    fontWeight: '700',
                    color: 'var(--accent)',
                    display: 'flex',
                    gap: '0.4rem',
                    alignItems: 'center'
                  }}>
                    <span>~172 Trades/Yr</span>
                    <span>•</span>
                    <span>+44% to +48% Return</span>
                  </div>

                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                    Broad momentum entries including pre-breakout coils within 1.5% of 20d high. Fast capital turnover with unbottlenecked entries up to 10 concurrent holdings.
                  </div>

                  <div style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                    borderTop: '1px solid var(--border-color)',
                    paddingTop: '0.35rem',
                    fontWeight: '500'
                  }}>
                    Triggers: 1.75x RVOL | 3.0% Alpha | 1.4% Move | 64% CLV
                  </div>
                </div>

                {/* Conservative Card */}
                <div
                  onClick={() => setAggressiveness('conservative')}
                  style={{
                    padding: '0.9rem',
                    borderRadius: '8px',
                    border: aggressiveness === 'conservative'
                      ? '2px solid var(--accent)'
                      : '1px solid var(--border-color)',
                    background: aggressiveness === 'conservative'
                      ? 'var(--accent-glow)'
                      : 'var(--bg-card)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.45rem',
                    position: 'relative'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '700', fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                      Conservative Approach
                    </span>
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: '700',
                      padding: '0.15rem 0.45rem',
                      borderRadius: '4px',
                      background: aggressiveness === 'conservative' ? 'var(--accent)' : 'var(--border-color)',
                      color: '#ffffff'
                    }}>
                      {aggressiveness === 'conservative' ? 'ACTIVE' : 'SELECT'}
                    </span>
                  </div>

                  <div style={{
                    fontSize: '0.78rem',
                    fontWeight: '700',
                    color: 'var(--blue, #3b82f6)',
                    display: 'flex',
                    gap: '0.4rem',
                    alignItems: 'center'
                  }}>
                    <span>~40-41 Trades/Yr</span>
                    <span>•</span>
                    <span>+21% to +22% Return</span>
                  </div>

                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                    Institutional breakout strategy with confirmed 20-day high close only. Disciplined pacing (max 2 buys/day) and 100% Risk-Off cash preservation freeze.
                  </div>

                  <div style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                    borderTop: '1px solid var(--border-color)',
                    paddingTop: '0.35rem',
                    fontWeight: '500'
                  }}>
                    Triggers: 1.90x RVOL | 4.0% Alpha | 1.8% Move | 68% CLV
                  </div>
                </div>
              </div>

              <div className="config-desc" style={{ marginTop: '0.35rem' }}>
                Toggle strategy profile to switch between institutional capital preservation (~40-41 trades/yr) and broad high-frequency momentum (~172 trades/yr). Click "Save Strategy Settings" to persist.
              </div>
            </div>

            <div className="config-item">
              <label>Target Profit Threshold</label>
              <div className="config-slider-row">
                <input
                  type="range"
                  min="5"
                  max="30"
                  value={targetProfit}
                  onChange={(e) => setTargetProfit(Number(e.target.value))}
                  className="config-slider"
                />
                <span className="config-slider-val">+{targetProfit}%</span>
              </div>
              <div className="config-desc">Profit target ratio at which open positions automatically trigger limit sells.</div>
            </div>

            <div className="config-item">
              <label>Stop Loss Threshold</label>
              <div className="config-slider-row">
                <input
                  type="range"
                  min="2"
                  max="15"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(Number(e.target.value))}
                  className="config-slider"
                />
                <span className="config-slider-val">-{stopLoss}%</span>
              </div>
              <div className="config-desc">Percentage loss threshold at which positions automatically trigger stop loss liquidations.</div>
            </div>

            <div className="config-item">
              <label>Max Concurrent Holdings</label>
              <input
                type="number"
                min="2"
                max="50"
                value={maxPositions}
                onChange={(e) => setMaxPositions(e.target.value)}
                className="config-input"
              />
              <div className="config-desc">Maximum number of stock positions held in parallel (governs capital scaling per stock).</div>
            </div>

            <div className="config-item" style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <label style={{ margin: 0, fontWeight: '600', color: 'var(--text-primary)' }}>
                  Dynamic Capital Rotation
                </label>
                <input
                  type="checkbox"
                  checked={rotationEnabled}
                  onChange={(e) => setRotationEnabled(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                />
              </div>
              <div className="config-desc" style={{ marginBottom: '0.75rem' }}>
                When maximum holding slots are full, automatically liquidates the weakest underperforming holding to fund incoming high-conviction breakout setups. Sector caps are disabled so holdings can naturally concentrate in the leading market sector.
              </div>

              {rotationEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <div>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Min. Candidate Score to Trigger</label>
                    <input
                      type="number"
                      min="75"
                      max="100"
                      value={rotationMinCandidateScore}
                      onChange={(e) => setRotationMinCandidateScore(Number(e.target.value))}
                      className="config-input"
                      style={{ marginTop: '0.25rem', padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Max Profit of Replaced Lagger (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="-10"
                      max="10"
                      value={rotationMaxUnderperformerProfit}
                      onChange={(e) => setRotationMaxUnderperformerProfit(Number(e.target.value))}
                      className="config-input"
                      style={{ marginTop: '0.25rem', padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                    />
                  </div>
                </div>
              )}
            </div>

            <button type="submit" className="btn btn-primary" style={{ marginTop: '0.5rem' }} disabled={saving}>
              {saving ? "Saving Configurations..." : "Save Strategy Settings"}
            </button>
          </form>
        </div>

        {/* Administration and Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Capital Injection */}
          <div className="glass-panel">
            <div className="panel-header">
              <h2>Capital Injection</h2>
            </div>
            <form onSubmit={handleDepositSubmit} className="config-group">
              <div className="config-item">
                <label>Deposit Amount (₹)</label>
                <div className="config-input-row">
                  <input
                    type="number"
                    placeholder="e.g. 50000"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    className="config-input"
                  />
                  <button type="submit" className="btn btn-primary" disabled={depositing}>
                    {depositing ? "Depositing..." : "Inject Cash"}
                  </button>
                </div>
                <div className="config-desc">Add supplementary funds directly to the trading desk cash reserves.</div>
              </div>
            </form>
          </div>

          {/* Simulation Commands */}
          <div className="glass-panel">
            <div className="panel-header">
              <h2>Simulation Commands</h2>
            </div>
            <div className="config-group">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <button
                  onClick={handleTriggerRun}
                  className="btn btn-primary"
                  style={{ width: '100%' }}
                  disabled={running || resetting}
                >
                  {running ? "Simulating Market Days..." : "Trigger Daily Update"}
                </button>
                <div className="config-desc" style={{ marginBottom: '0.5rem' }}>
                  Force simulation engine to catch up and execute trades up to today's date using actual daily market bars.
                </div>

                <div style={{ borderTop: '1px solid var(--border-color)', margin: '0.25rem 0 0.5rem 0' }} />

                {/* Custom Reset & Start Date Selection */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '0.9rem', fontWeight: '600', color: 'var(--text-primary)' }}>
                      Reset Simulation & Start Date
                    </label>
                    <span style={{
                      fontSize: '0.75rem',
                      padding: '0.2rem 0.55rem',
                      borderRadius: '5px',
                      background: selectedStartDate === todayStr ? 'var(--green-glow)' : 'var(--accent-glow)',
                      color: selectedStartDate === todayStr ? 'var(--green)' : 'var(--accent)',
                      border: `1px solid ${selectedStartDate === todayStr ? 'var(--green-border)' : 'var(--accent-border)'}`,
                      fontWeight: '600'
                    }}>
                      {selectedStartDate === todayStr ? 'Live Forward Mode' : 'Historical Backtest'}
                    </span>
                  </div>

                  <div className="config-desc" style={{ marginTop: '-0.25rem' }}>
                    Choose any past date to run a fresh retrospective backtest, or pick today to start trading from a clean slate.
                  </div>

                  {/* Date Input */}
                  <div className="config-item" style={{ marginTop: '0.1rem' }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Choose Start Date (YYYY-MM-DD)</label>
                    <input
                      type="date"
                      value={selectedStartDate}
                      min={minHistoryDate}
                      max={todayStr}
                      onChange={(e) => setSelectedStartDate(e.target.value)}
                      className="config-input"
                      disabled={resetting || running}
                      style={{ cursor: 'pointer' }}
                    />
                  </div>

                  {/* Preset Pills */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Quick Date Presets:</div>
                    <div className="preset-pills">
                      {datePresets.map((preset) => (
                        <button
                          key={preset.value}
                          type="button"
                          className={`preset-pill ${selectedStartDate === preset.value ? 'active' : ''}`}
                          onClick={() => setSelectedStartDate(preset.value)}
                          disabled={resetting || running}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Auto-Replay Toggle */}
                  {selectedStartDate !== todayStr && (
                    <label style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.55rem',
                      cursor: 'pointer',
                      fontSize: '0.825rem',
                      color: 'var(--text-secondary)',
                      marginTop: '0.15rem'
                    }}>
                      <input
                        type="checkbox"
                        checked={autoReplay}
                        onChange={(e) => setAutoReplay(e.target.checked)}
                        disabled={resetting || running}
                        style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
                      />
                      <span>Automatically replay backtest trades from <strong>{selectedStartDate}</strong> to today</span>
                    </label>
                  )}

                  {/* Reset Action Button */}
                  <button
                    onClick={() => handleResetCustomDate(selectedStartDate, autoReplay)}
                    className="btn btn-danger"
                    style={{ width: '100%', marginTop: '0.35rem', fontWeight: '600' }}
                    disabled={resetting || running || !selectedStartDate}
                  >
                    {resetting
                      ? "Resetting & Replaying Simulation..."
                      : selectedStartDate === todayStr
                        ? "Reset to Today (Clean Slate ₹100k)"
                        : autoReplay
                          ? `Reset & Run Backtest from ${selectedStartDate}`
                          : `Reset Baseline to ${selectedStartDate}`
                    }
                  </button>

                  <div className="config-desc" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Wipes all trade history, active holdings, and logs. Reinitializes cash balance to ₹1,00,000 starting on {selectedStartDate}.
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
