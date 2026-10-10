import { expect, it } from 'vitest';
import { repriceUsageAnalyticsResponse, repriceUsageObservationCost, resolveUsageCostFacts, resolveUsageCostBasis, resolveEffectiveUsageCostUsd } from './usageCost.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';

it('never reclassifies a mixed aggregate with none provenance as reported money', () => {
  const mixed = { reportedUsd: 4, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
  expect(resolveUsageCostBasis(mixed, 'reported')).toBeNull();
  expect(resolveEffectiveUsageCostUsd(mixed, 'reported')).toBe(0);
});

it('recognizes explicit zero pricing while leaving default zero unpriced', () => {
  const zero = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
  expect(resolveUsageCostBasis({ ...zero, costSource: 'none' }, 'auto')).toBeNull();
  expect(resolveUsageCostBasis({ ...zero, costSource: 'pricing_estimate' }, 'auto')).toMatchObject({ kind: 'estimated', amountUsd: 0 });
});

it('keeps vendor API-equivalent reports a separate reported fact regardless of current tariff availability', () => {
  const raw = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported_api_equivalent' as const };
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const unpriced = repriceUsageObservationCost(raw, 'private-model', tokens);
  expect(resolveUsageCostFacts(unpriced)).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 7,
    source: 'provider_reported_api_equivalent' }));
  const priced = repriceUsageObservationCost(raw, 'private-model', tokens, bundledUsageModelPriceCatalog,
    { 'private-model': { kind: 'rates', inputUsdPerMillion: 2, outputUsdPerMillion: 3 } }, 'api_equivalent');
  expect(priced).toMatchObject({ ...raw, apiEquivalentUsd: 2, effectiveUsd: 2 });
  expect(resolveUsageCostFacts(priced)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reported', amountUsd: 7, source: 'provider_reported_api_equivalent' }),
    expect.objectContaining({ kind: 'api_equivalent', amountUsd: 2 }),
  ]));
});

it('selects witnessed invoice and explicit monetary modes without blending their amounts', () => {
  const cost = { reportedUsd: 0.12, estimatedUsd: 0.09, invoiceUsd: 0.08, currency: 'USD' };
  expect(resolveUsageCostBasis(cost, 'auto')).toMatchObject({ kind: 'invoice', amountUsd: 0.08 });
  expect(resolveUsageCostBasis(cost, 'reported')).toMatchObject({ kind: 'reported', amountUsd: 0.12 });
  expect(resolveUsageCostBasis(cost, 'estimated')).toMatchObject({ kind: 'estimated', amountUsd: 0.09 });
});

it('returns an admitted API-equivalent query mode through the strict response contract', () => {
  const request = UsageAnalyticsQueryRequestSchema.parse({ costMode: 'api_equivalent' });
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const cost = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD' };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
    contributions: [{ id: 'observed', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: null,
      modelId: 'priced-model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost }],
  });
  const repriced = repriceUsageAnalyticsResponse(response, {
    v: 1, models: { 'priced-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }, {}, request.costMode);
  expect(UsageAnalyticsQueryResponseSchema.parse(repriced).costPresentation)
    .toMatchObject({ mode: 'api_equivalent', effectiveUsd: 2, currency: 'USD' });
  expect(repriced.totals.cost.reportedUsd).toBe(7);
});
