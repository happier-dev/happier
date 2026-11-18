import { expect, it } from 'vitest';
import type { UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { buildUsageLeaderList, reprojectUsageLeaders, type UsageAnalyticsPricingPartitions } from './usageLeaderProjection.js';
import { resolveEffectiveUsageCostUsd } from './usageCostFacts.js';
import { buildUsagePricedPartition } from './usagePricingPopulation.js';

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
    const build = (subset: readonly (typeof rows)[number][]) => buildUsagePricedPartition(subset, 'auto');
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

it('uses a timeline leader’s selected money for an identical source partition', () => {
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: String(index), observedAtMs: index,
        sessionId: null, agentId: null, modelId: index < 6 ? 'one-source' : 'two-sources', machineId: null,
        projectKey: null, workspaceId: null, source: index < 8 ? 'codex_app_server' as const : 'claude_sdk' as const,
        eventCount: 1, tokens, cost }));
    const pricedMemberships: string[][] = [];
    let samePopulation = false;
    const ranks = buildUsageLeaderList(rows, 'model', 2, 'auto', undefined, true, {
        price(selected) { pricedMemberships.push(selected.map(row => row.id)); return buildUsagePricedPartition(selected, 'auto'); },
        admit(rank) {
            const one = rank.candidates.find(candidate => candidate.value.key === 'one-source');
            samePopulation = one?.sources?.[0]?.population === one?.population;
        },
    });
    expect(ranks?.map(leader => ({ amount: resolveEffectiveUsageCostUsd(leader.cost, 'auto'),
        sources: leader.sources?.map(source => resolveEffectiveUsageCostUsd(source.cost, 'auto')) })))
        .toEqual([{ amount: 6, sources: [6] }, { amount: 4, sources: [2, 2] }]);
    expect(pricedMemberships).toEqual([
        ['0', '1', '2', '3', '4', '5'], ['6', '7', '8', '9'], ['6', '7'], ['8', '9'],
    ]);
    expect(samePopulation).toBe(true);
});
