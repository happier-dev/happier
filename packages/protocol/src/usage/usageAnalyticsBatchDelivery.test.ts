import { expect, it } from 'vitest';
import { UsageAnalyticsQueryBatchResponseSchema, UsageAnalyticsQueryRequestSchema,
  type UsageAnalyticsContribution, type UsageAnalyticsQueryBatchResponse } from './usageAnalyticsContracts.js';
import { encodeUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from './usageAnalyticsBatchDelivery.js';
import { allocateUsageOutcomes } from './usageOutcomeAllocation.js';
import { aggregateUsageContributionCosts } from './usageAggregation.js';
import { resolveUsageCostBasis } from './usageCostFacts.js';

const query = UsageAnalyticsQueryRequestSchema.parse({ topLimit: 20 });
const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
// Reload99 Work census: 5,744 events, served in the caller's existing 20-row pages.
const rows: UsageAnalyticsContribution[] = Array.from({ length: 5_744 }, (_, index) => ({
  id: `event-${index}`, eventCount: 1, observedAtMs: index, sessionId: 'same-session', turnId: `turn-${index % 3}`,
  agentId: 'agent', modelId: 'model', machineId: 'same-machine', projectKey: '/same/long/project/path', workspaceId: null,
  source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens, tokenCategories: tokens,
  cost: { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' },
  ...(index % 2 ? { backendMode: null } : {}),
}));
const value = { v: 1 as const,
  totals: { eventCount: rows.length, tokens, cost: { reportedUsd: 0, estimatedUsd: 1, currency: 'USD' } }, contributions: rows };
const batch: UsageAnalyticsQueryBatchResponse = { v: 1, results: [{ query, value }] };
const input = { queries: [query], includeContributions: false, contributionQueries: [query] };

it('delivers no unused cost-breakdown bytes to Work while conserving every contribution and money basis', () => {
  // Account A's 7D census on reload150: 25,442 contributions; its only cost
  // breakdown is cacheSavingsUsd. Work renders amounts, never savings detail.
  const contributions = Array.from({ length: 25_442 }, (_, index) => ({
    ...rows[index % rows.length]!, id: `work-${index}`,
    cost: { ...rows[index % rows.length]!.cost, breakdown: { cacheSavingsUsd: index / 1000 } },
  }));
  const response = { ...batch, results: [{ query, value: { ...value, contributions } }] };
  const deliver = (work: boolean) => [...projectUsageAnalyticsBatchDelivery(response, input, true, work ? 'work' : undefined)]
    .map(encodeUsageAnalyticsBatchDelivery);
  const rich = deliver(false);
  const compact = deliver(true);
  const delivered = compact.map(chunk => UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(JSON.stringify(chunk))))
    .flatMap(chunk => chunk.contributionPages ?? []).flatMap(page => page.rows);
  expect(delivered.reduce((sum, row) => sum + (row.cost.breakdown === undefined ? 0 : JSON.stringify(row.cost.breakdown).length), 0)).toBe(0);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(rich).length);
  expect(delivered.map(row => row.id)).toEqual(contributions.map(row => row.id));
  expect(delivered.map(row => row.tokens)).toEqual(contributions.map(row => row.tokens));
  for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
    expect(delivered.map(row => resolveUsageCostBasis(row.cost, mode)))
      .toEqual(contributions.map(row => resolveUsageCostBasis(row.cost, mode)));
    expect(resolveUsageCostBasis(aggregateUsageContributionCosts(delivered, mode), mode))
      .toEqual(resolveUsageCostBasis(aggregateUsageContributionCosts(contributions, mode), mode));
  }
  const allocated = allocateUsageOutcomes({ contributions: delivered, evidence: [] });
  expect(allocated.allocations).toHaveLength(contributions.length);
  expect(new Set(allocated.allocations.map(row => row.contribution.id)).size).toBe(contributions.length);
  expect(allocated.allocations.reduce((sum, row) => sum + row.contribution.tokens.total!, 0)).toBe(contributions.length);
  expect(allocated.allocations.every(row => row.outcome === null)).toBe(true);
  // Rich exports retain their admitted detail.
  expect(rich.flatMap(chunk => chunk.contributionPages ?? []).every(page =>
    'values' in page.rows && page.rows.values.some(value => value !== null && typeof value === 'object' && 'breakdown' in value))).toBe(true);
});

it('shrinks repeated contribution operands within each requested page and preserves every admitted value', () => {
  const original = [...projectUsageAnalyticsBatchDelivery(batch, input, true, 'work')];
  const encoded = original.map(encodeUsageAnalyticsBatchDelivery);
  const admitted = encoded.map(chunk => UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(JSON.stringify(chunk))));
  expect(admitted).toEqual(original);
  expect(admitted.flatMap(chunk => chunk.contributionPages ?? []).flatMap(page => page.rows)).toEqual(rows);
  const originalPages = original.flatMap(chunk => chunk.contributionPages ?? []);
  const encodedPages = encoded.flatMap(chunk => chunk.contributionPages ?? []);
  // Relative cost contract over repeated real operands, not a runtime size ceiling.
  expect(JSON.stringify(encodedPages).length).toBeLessThan(JSON.stringify(originalPages).length / 2);
});

it.each([0, 1])('preserves the witnessed detail population with %i rows', count => {
  const response = { ...batch, results: [{ query, value: { ...value,
    contributions: rows.slice(0, count) } }] };
  const chunks = [...projectUsageAnalyticsBatchDelivery(response, input, true, 'work')];
  expect(chunks.map(encodeUsageAnalyticsBatchDelivery).map(chunk => UsageAnalyticsQueryBatchResponseSchema.parse(chunk)))
    .toEqual(chunks);
});

it('preserves carried Session membership when a compact response has no contributions', () => {
  const sessionIds = ['historical-session'];
  const sessionMembership = { turns: [{ sessionId: 'historical-session', turnId: 'historical-turn',
    executions: ['outside' as const] }] };
  const response: UsageAnalyticsQueryBatchResponse = { v: 1, results: [{ query, value: {
    v: 1, totals: value.totals, sessionIds, sessionMembership,
  } }] };
  const chunks = [...projectUsageAnalyticsBatchDelivery(response,
    { ...input, contributionQueries: [], sessionQueries: [query] }, false)];
  const delivered = UsageAnalyticsQueryBatchResponseSchema.parse(chunks[1]).results[0];
  expect(delivered).toEqual({ query, value: { v: 1, totals: value.totals, sessionIds, sessionMembership } });
});

it.each([0, 1])('derives current Session membership from %i present contributions', count => {
  const response: UsageAnalyticsQueryBatchResponse = { v: 1, results: [{ query, value: { ...value,
    contributions: rows.slice(0, count), sessionIds: ['stale-session'], sessionMembership: { turns: [] },
  } }] };
  const chunks = [...projectUsageAnalyticsBatchDelivery(response,
    { ...input, contributionQueries: [], sessionQueries: [query] }, false)];
  const delivered = UsageAnalyticsQueryBatchResponseSchema.parse(chunks[1]).results[0];
  expect(delivered).toMatchObject({ value: {
    sessionIds: count === 0 ? [] : ['same-session'],
    sessionMembership: { turns: count === 0 ? [] : [{ sessionId: 'same-session', turnId: 'turn-0', executions: ['happier'] }] },
  } });
});

it.each([
  { fields: ['id'], values: ['private-value'], indices: [[1]] },
  { fields: ['id'], values: ['private-value'], indices: [[]] },
  { fields: ['id', 'id'], values: ['private-value'], indices: [[0, 0]] },
  { fields: ['__proto__'], values: ['private-value'], indices: [[0]] },
  { fields: ['id'], values: [23], indices: [[0]] },
])('rejects malformed dictionaries and invalid reconstructed contribution rows', rows => {
  expect(UsageAnalyticsQueryBatchResponseSchema.safeParse({ v: 1, results: [], contributionPages: [{
    query, offset: 0, totalCount: 1, nextOffset: null, rows,
  }] }).success).toBe(false);
});
