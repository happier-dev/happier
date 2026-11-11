import { expect, it } from 'vitest';
import type { UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { reprojectUsageLeaders, type UsageAnalyticsPricingPartitions } from './usageLeaderProjection.js';
import { createUsagePricedPartitionBuilder } from './usagePricingPopulation.js';

it('prices each ranking population once when leaders and breakdowns request the same dimension', () => {
  for (const count of [8, 128]) {
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
    const rows = Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: index,
      sessionId: `session-${index % 2}`, turnId: null, agentId: null, modelId: null, machineId: null,
      projectKey: null, workspaceId: null, source: null, eventCount: 1, tokens, cost }));
    const entry = (key: string, label: string) => ({ key, label, eventCount: count / 2,
      tokens: { ...tokens, input: count / 2, total: count / 2 }, cost });
    const value: UsageAnalyticsQueryResponse = { v: 1,
      totals: { eventCount: count, tokens, cost },
      leaders: { sessions: [entry('session-0', 'Leader zero')] },
      breakdowns: { session: [entry('session-0', 'Breakdown zero'), entry('session-1', 'Breakdown one')] } };
    const build = createUsagePricedPartitionBuilder('auto').build;
    const partitions: UsageAnalyticsPricingPartitions = { totals: build(rows).population,
      series: new Map(), ranked: new Map(), timelines: new Map() };
    let pricedRows = 0;
    const projected = reprojectUsageLeaders(value, rows, 'auto', (_raw, selected) => build(selected).cost,
      undefined, { partitions, price(selected) { pricedRows += selected.length; return build(selected); } });
    expect(pricedRows, `${count} rows form one session ranking, consumed by two outputs`).toBe(count);
    expect(projected.leaders?.sessions).toMatchObject([{ key: 'session-0', label: 'Leader zero',
      eventCount: count / 2, cost: { effectiveUsd: count / 2 } }]);
    expect(projected.breakdowns?.session).toMatchObject([
      { key: 'session-0', label: 'Breakdown zero', cost: { effectiveUsd: count / 2 } },
      { key: 'session-1', label: 'Breakdown one', cost: { effectiveUsd: count / 2 } },
    ]);
    expect(partitions.ranked.get('session')?.candidates).toHaveLength(2);
  }
});
