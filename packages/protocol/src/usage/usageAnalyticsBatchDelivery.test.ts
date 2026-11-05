import { expect, it } from 'vitest';
import { UsageAnalyticsQueryBatchResponseSchema, UsageAnalyticsQueryRequestSchema,
  type UsageAnalyticsContribution, type UsageAnalyticsQueryBatchResponse } from './usageAnalyticsContracts.js';
import { encodeUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from './usageAnalyticsBatchDelivery.js';

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
