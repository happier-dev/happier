import { expect, it } from 'vitest';
import { readUsageAccountingMetadata, UsageAccountingMetadataSchema, UsageAnalyticsCostFactSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';

it('admits unpriced money and explicit partial producer coverage', () => {
  const tokens = { input: 10, output: 5, reasoning: 2, cacheRead: 4, cacheWrite: 0, total: 15 };
  const response = UsageAnalyticsQueryResponseSchema.parse({
    v: 1,
    totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
    costFacts: [{ kind: 'unpriced', amountUsd: null, currency: 'USD', source: 'none', tokens, eventCount: 1, complete: false, asOfMs: 10 }],
    coverage: {
      status: 'partial', reasons: ['unpriced_tokens'], missingDimensions: ['machine'],
      sources: [{ source: 'native', path: 'native', status: 'partial', asOfMs: 10, eventCount: 1 }],
      range: { startMs: 0, endMs: 10, complete: false }, ranked: [],
    },
  });
  expect(response.costFacts?.[0].amountUsd).toBeNull();
  expect(response.coverage?.sources[0].status).toBe('partial');
});

it('reads stored accounting evidence by dropping extras but rejects invalid known fields', () => {
  expect(readUsageAccountingMetadata({ usageAccounting: { inferenceId: 'inference', status: 'pending', extra: 'drop' } })).toEqual({ inferenceId: 'inference', status: 'pending' });
  expect(readUsageAccountingMetadata({ usageAccounting: { status: 'fabricated' } })).toBeNull();
  expect(UsageAccountingMetadataSchema.safeParse({ status: 'available', extra: 'drop' }).success).toBe(false);
});

it('retains explicit vendor counter overlap semantics for disjoint display projection', () => {
  expect(readUsageAccountingMetadata({ usageAccounting: { inputIncludesCache: true, outputIncludesReasoning: true } })).toEqual({ inputIncludesCache: true, outputIncludesReasoning: true });
});

it('rejects zero money masquerading as an unpriced fact', () => {
  const fact = { kind: 'unpriced', amountUsd: 0, currency: 'USD', source: 'none', tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 }, eventCount: 1, complete: false, asOfMs: 10 };
  expect(UsageAnalyticsCostFactSchema.safeParse(fact).success).toBe(false);
});
