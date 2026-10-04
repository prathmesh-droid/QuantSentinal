import React, { useState, useMemo } from 'react';

export default function LedgerTab({ history = [] }) {
  const [viewMode, setViewMode] = useState('campaigns'); // 'campaigns' | 'fills'
  const [expandedKeys, setExpandedKeys] = useState({});

  const toggleExpand = (key) => {
    setExpandedKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Group individual execution fills into unified Position Campaigns (by symbol + buyDate)
  const campaigns = useMemo(() => {
    const map = new Map();
    for (const trade of history) {
      const key = `${trade.symbol}_${trade.buyDate}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          symbol: trade.symbol,
          name: trade.name,
          sector: trade.sector,
          buyDate: trade.buyDate,
          strategy: trade.strategy,
          score: trade.score,
          legs: [],
          totalQuantity: 0,
          totalInvested: 0,
          totalRealizedRevenue: 0,
          totalProfit: 0,
          firstSellDate: trade.sellDate,
          lastSellDate: trade.sellDate,
        });
      }
      const c = map.get(key);
      c.legs.push(trade);
      c.totalQuantity += trade.quantity;
      const legCost = trade.quantity * trade.buyPrice;
      const legRevenue = trade.quantity * trade.sellPrice;
      c.totalInvested += legCost;
      c.totalRealizedRevenue += legRevenue;
      c.totalProfit += trade.profit;

      if (trade.sellDate > c.lastSellDate) c.lastSellDate = trade.sellDate;
      if (trade.sellDate < c.firstSellDate) c.firstSellDate = trade.sellDate;
    }

    return Array.from(map.values()).map(c => {
      const avgBuyPrice = c.totalQuantity > 0 ? (c.totalInvested / c.totalQuantity) : 0;
      const avgSellPrice = c.totalQuantity > 0 ? (c.totalRealizedRevenue / c.totalQuantity) : 0;
      const netProfitPercent = c.totalInvested > 0 ? (c.totalProfit / c.totalInvested) * 100 : 0;
      return {
        ...c,
        avgBuyPrice,
        avgSellPrice,
        netProfitPercent,
        isMultiLeg: c.legs.length > 1
      };
    });
  }, [history]);

  // Active items based on selected view mode
  const activeItems = viewMode === 'campaigns' ? campaigns : history;

  // Performance metrics calculated from the active dataset
  const totalCount = activeItems.length;
  const wins = activeItems.filter(item => (viewMode === 'campaigns' ? item.totalProfit : item.profit) >= 0);
  const losses = activeItems.filter(item => (viewMode === 'campaigns' ? item.totalProfit : item.profit) < 0);
  
  const winCount = wins.length;
  const lossCount = losses.length;
  const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;
  
  const totalRealizedPnl = history.reduce((sum, t) => sum + t.profit, 0);
  const avgReturn = totalCount > 0 
    ? (viewMode === 'campaigns' 
        ? campaigns.reduce((sum, c) => sum + c.netProfitPercent, 0) / campaigns.length 
        : history.reduce((sum, t) => sum + t.profitPercent, 0) / history.length)
    : 0;

  const avgHoldingDays = useMemo(() => {
    if (activeItems.length === 0) return 0;
    const totalDays = activeItems.reduce((sum, item) => {
      const bDate = new Date(item.buyDate);
      const sDate = new Date(viewMode === 'campaigns' ? item.lastSellDate : item.sellDate);
      const diffTime = Math.abs(sDate - bDate);
      const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
      return sum + diffDays;
    }, 0);
    return totalDays / activeItems.length;
  }, [activeItems, viewMode]);

  // Find best trade / campaign
  const bestItem = useMemo(() => {
    if (activeItems.length === 0) return null;
    return [...activeItems].sort((a, b) => {
      const profitA = viewMode === 'campaigns' ? a.totalProfit : a.profit;
      const profitB = viewMode === 'campaigns' ? b.totalProfit : b.profit;
      return profitB - profitA;
    })[0];
  }, [activeItems, viewMode]);

  return (
    <div className="tab-content">
      {/* Metrics Row */}
      <div className="ledger-summary-row">
        <div className="ledger-summary-card">
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {viewMode === 'campaigns' ? 'Completed Campaigns' : 'Execution Fills'}
          </span>
          <div className="ledger-summary-val">{totalCount}</div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {winCount} Wins | {lossCount} Losses
          </span>
        </div>

        <div className="ledger-summary-card">
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {viewMode === 'campaigns' ? 'Campaign Win Rate' : 'Fill Win Rate'}
          </span>
          <div className="ledger-summary-val" style={{ color: winRate >= 50 ? 'var(--green)' : 'inherit' }}>
            {winRate.toFixed(1)}%
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {viewMode === 'campaigns' ? 'True position win rate' : 'Raw order fill win rate'}
          </span>
        </div>

        <div className="ledger-summary-card">
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Total Realized P&L</span>
          <div className={`ledger-summary-val ${totalRealizedPnl >= 0 ? 'positive' : 'negative'}`}>
            {totalRealizedPnl >= 0 ? '+' : ''}₹{totalRealizedPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            Realized cash returns
          </span>
        </div>

        <div className="ledger-summary-card">
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {viewMode === 'campaigns' ? 'Avg. Campaign Return' : 'Avg. Fill Return'}
          </span>
          <div className={`ledger-summary-val ${avgReturn >= 0 ? 'positive' : 'negative'}`}>
            {avgReturn >= 0 ? '+' : ''}{avgReturn.toFixed(2)}%
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {viewMode === 'campaigns' ? 'Blended per-trade expectation' : 'Unweighted per-fill average'}
          </span>
        </div>

        <div className="ledger-summary-card">
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Avg. Holding Period
          </span>
          <div className="ledger-summary-val">
            {totalCount > 0 ? `${avgHoldingDays.toFixed(1)} days` : '--'}
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {viewMode === 'campaigns' ? 'Mean duration per campaign' : 'Mean duration per execution'}
          </span>
        </div>
      </div>

      {/* Main Ledger Table */}
      <div className="glass-panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h2 style={{ margin: 0 }}>Closed Trades Ledger</h2>
            {bestItem && (
              <span style={{ fontSize: '0.75rem', color: 'var(--green)', background: 'var(--green-glow)', padding: '0.2rem 0.5rem', border: '1px solid var(--green-border)', borderRadius: '4px' }}>
                Best: {bestItem.symbol.replace('.NS', '')} (+₹{(viewMode === 'campaigns' ? bestItem.totalProfit : bestItem.profit).toFixed(0)})
              </span>
            )}
          </div>

          {/* View Mode Toggle */}
          <div style={{ display: 'inline-flex', background: 'var(--bg-main)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '2px' }}>
            <button
              onClick={() => setViewMode('campaigns')}
              style={{
                border: 'none',
                background: viewMode === 'campaigns' ? 'var(--accent)' : 'transparent',
                color: viewMode === 'campaigns' ? '#fff' : 'var(--text-secondary)',
                padding: '0.35rem 0.75rem',
                borderRadius: '6px',
                fontSize: '0.78rem',
                fontWeight: viewMode === 'campaigns' ? '600' : '400',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              Position Campaigns (Unified)
            </button>
            <button
              onClick={() => setViewMode('fills')}
              style={{
                border: 'none',
                background: viewMode === 'fills' ? 'var(--accent)' : 'transparent',
                color: viewMode === 'fills' ? '#fff' : 'var(--text-secondary)',
                padding: '0.35rem 0.75rem',
                borderRadius: '6px',
                fontSize: '0.78rem',
                fontWeight: viewMode === 'fills' ? '600' : '400',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              All Execution Fills
            </button>
          </div>
        </div>

        {activeItems.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No completed trades logged yet. Scanning for swing setups.
          </div>
        ) : (
          <div className="table-container">
            <table className="custom-table" style={{ fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Qty</th>
                  <th>Buy Details</th>
                  <th>Sell Details</th>
                  <th>Hold Period</th>
                  <th>Realized Return</th>
                  <th>Exit Trigger / Execution</th>
                </tr>
              </thead>
              <tbody>
                {viewMode === 'campaigns' ? (
                  // Unified Campaigns View
                  [...campaigns].reverse().map(campaign => {
                    const isProfit = campaign.totalProfit >= 0;
                    const buyDate = new Date(campaign.buyDate);
                    const sellDate = new Date(campaign.lastSellDate);
                    const diffTime = Math.abs(sellDate - buyDate);
                    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
                    const isExpanded = !!expandedKeys[campaign.key];

                    return (
                      <React.Fragment key={campaign.key}>
                        <tr style={{ background: isExpanded ? 'rgba(37, 99, 235, 0.03)' : undefined }}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <span className="stock-badge">{campaign.symbol.replace('.NS', '')}</span>
                                {campaign.isMultiLeg && (
                                  <span 
                                    onClick={() => toggleExpand(campaign.key)}
                                    style={{
                                      fontSize: '0.65rem',
                                      fontWeight: '700',
                                      padding: '0.1rem 0.35rem',
                                      borderRadius: '4px',
                                      background: 'var(--accent-glow)',
                                      color: 'var(--accent)',
                                      border: '1px solid var(--accent-border)',
                                      cursor: 'pointer'
                                    }}
                                    title="Click to view partial fills"
                                  >
                                    {campaign.legs.length} Fills {isExpanded ? '▲' : '▼'}
                                  </span>
                                )}
                              </div>
                              <span className="company-name">{campaign.name}</span>
                            </div>
                          </td>
                          <td>
                            <div>{campaign.totalQuantity}</div>
                            {campaign.isMultiLeg && (
                              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>split exit</div>
                            )}
                          </td>
                          <td>
                            <div>₹{campaign.avgBuyPrice.toFixed(2)}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{campaign.buyDate}</div>
                          </td>
                          <td>
                            <div>₹{campaign.avgSellPrice.toFixed(2)} <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>(avg)</span></div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{campaign.lastSellDate}</div>
                          </td>
                          <td>{diffDays} day{diffDays === 1 ? '' : 's'}</td>
                          <td className={isProfit ? 'positive-cell' : 'negative-cell'}>
                            <div>{isProfit ? '+' : ''}₹{campaign.totalProfit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                            <div style={{ fontSize: '0.75rem', fontWeight: '600' }}>{isProfit ? '+' : ''}{campaign.netProfitPercent.toFixed(2)}%</div>
                          </td>
                          <td>
                            {campaign.isMultiLeg ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                <span 
                                  onClick={() => toggleExpand(campaign.key)}
                                  style={{
                                    fontSize: '0.72rem',
                                    fontWeight: '600',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    background: isProfit ? 'var(--green-glow)' : 'var(--red-glow)',
                                    color: isProfit ? 'var(--green)' : 'var(--red)',
                                    border: isProfit ? '1px solid var(--green-border)' : '1px solid var(--red-border)',
                                    cursor: 'pointer',
                                    display: 'inline-block'
                                  }}
                                >
                                  Scale-Out ({campaign.legs.length} Fills) {isExpanded ? '▲' : '▼'}
                                </span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                  Final: {campaign.legs[campaign.legs.length - 1].reason.split('(')[0]}
                                </span>
                              </div>
                            ) : (
                              <span 
                                style={{
                                  fontSize: '0.75rem',
                                  fontWeight: '600',
                                  padding: '0.15rem 0.4rem',
                                  borderRadius: '4px',
                                  background: campaign.legs[0]?.reason.includes('Profit') ? 'var(--green-glow)' : 'var(--red-glow)',
                                  color: campaign.legs[0]?.reason.includes('Profit') ? 'var(--green)' : 'var(--red)',
                                  border: campaign.legs[0]?.reason.includes('Profit') ? '1px solid var(--green-border)' : '1px solid var(--red-border)'
                                }}
                              >
                                {campaign.legs[0]?.reason || 'Position Exit'}
                              </span>
                            )}
                          </td>
                        </tr>

                        {/* Expanded sub-rows showing individual execution fills */}
                        {isExpanded && campaign.legs.map((leg, legIdx) => {
                          const legProfit = leg.profit >= 0;
                          return (
                            <tr key={`${campaign.key}_leg_${legIdx}`} style={{ background: 'rgba(37, 99, 235, 0.02)', fontSize: '0.78rem' }}>
                              <td style={{ paddingLeft: '2rem' }}>
                                <span style={{ color: 'var(--text-muted)' }}>↳ Fill #{legIdx + 1}</span>
                              </td>
                              <td>{leg.quantity}</td>
                              <td>₹{leg.buyPrice.toFixed(2)}</td>
                              <td>
                                <div>₹{leg.sellPrice.toFixed(2)}</div>
                                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{leg.sellDate}</div>
                              </td>
                              <td>-</td>
                              <td className={legProfit ? 'positive-cell' : 'negative-cell'}>
                                {legProfit ? '+' : ''}₹{leg.profit.toFixed(2)} ({legProfit ? '+' : ''}{leg.profitPercent.toFixed(2)}%)
                              </td>
                              <td>
                                <span style={{ color: 'var(--text-secondary)' }}>{leg.reason}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })
                ) : (
                  // Raw Individual Fills View
                  [...history].reverse().map((trade, idx) => {
                    const isProfit = trade.profit >= 0;
                    const buyDate = new Date(trade.buyDate);
                    const sellDate = new Date(trade.sellDate);
                    const diffTime = Math.abs(sellDate - buyDate);
                    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

                    return (
                      <tr key={idx}>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="stock-badge">{trade.symbol.replace('.NS', '')}</span>
                            <span className="company-name">{trade.name}</span>
                          </div>
                        </td>
                        <td>{trade.quantity}</td>
                        <td>
                          <div>₹{trade.buyPrice.toFixed(2)}</div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{trade.buyDate}</div>
                        </td>
                        <td>
                          <div>₹{trade.sellPrice.toFixed(2)}</div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{trade.sellDate}</div>
                        </td>
                        <td>{diffDays} day{diffDays === 1 ? '' : 's'}</td>
                        <td className={isProfit ? 'positive-cell' : 'negative-cell'}>
                          <div>{isProfit ? '+' : ''}₹{trade.profit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                          <div style={{ fontSize: '0.75rem' }}>{isProfit ? '+' : ''}{trade.profitPercent.toFixed(2)}%</div>
                        </td>
                        <td>
                          <span 
                            style={{
                              fontSize: '0.75rem',
                              fontWeight: '600',
                              padding: '0.15rem 0.4rem',
                              borderRadius: '4px',
                              background: trade.reason.includes('Profit') ? 'var(--green-glow)' : 'var(--red-glow)',
                              color: trade.reason.includes('Profit') ? 'var(--green)' : 'var(--red)',
                              border: trade.reason.includes('Profit') ? '1px solid var(--green-border)' : '1px solid var(--red-border)'
                            }}
                          >
                            {trade.reason}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

