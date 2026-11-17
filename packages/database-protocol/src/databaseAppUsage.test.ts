import { describe, expect, it } from 'vitest';
import { projectDatabaseCaptureUsageV1 as project, type DatabaseCaptureCostsReadResultV1 } from './index.js';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';

const catalog: UsageModelPriceCatalog = { v: 1, models: { model: {
    inputUsdPerMillion: 2, outputUsdPerMillion: 4, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 3,
} }, provenance: { source: 'litellm', origin: 'fetched', asOfMs: 1000, revision: 'fixture-revision', fetchStatus: 'ready' } };
const tokens = { input: 1_000_000, output: 1_000_000, reasoning: 200_000, cacheRead: 250_000, cacheWrite: 250_000, total: 2_000_000 };
const categories = { ...tokens, input: 500_000, output: 800_000 };
const row = { bucketStartMs: 0, provider: 'vendor', modelId: 'model', requestedModel: 'model', operation: 'chat',
    callCount: 2, tokens, tokenCategories: categories, reportedCost: null, firstSeenMs: 1000, lastSeenMs: 2000 };
const raw = { ok: true, source: { kind: 'environment', serverId: 'home', environmentId: 'environment' },
    since: 1000, until: 3_600_000, items: [row], coverage: { callCount: 2, tokenCategoryCallCount: 2,
        reportedCostCallCount: 0, lostObservations: 0, reason: null } } satisfies Extract<DatabaseCaptureCostsReadResultV1, { ok: true }>;

describe('App calls Usage projection', () => {
    it('prices the same aggregate with each viewer prices and retains catalog provenance across existing chart data', () => {
        const original = structuredClone(raw);
        const standard = project(raw, catalog, {}, { granularity: 'hour' });
        const personal = project(raw, catalog, { model: { kind: 'rates', inputUsdPerMillion: 10,
            outputUsdPerMillion: 20, cacheReadUsdPerMillion: 2, cacheWriteUsdPerMillion: 4 } }, { granularity: 'hour' });
        expect(standard.subject).toBe('app_calls');
        expect(UsageAnalyticsQueryResponseSchema.safeParse(standard.accounting).success).toBe(true);
        expect(standard.accounting.totals.cost.apiEquivalentUsd).toBe(6);
        expect(personal.accounting.totals.cost.apiEquivalentUsd).toBe(26.5);
        expect(standard.accounting.series?.[0]?.cost.apiEquivalentUsd).toBe(6);
        expect(standard.accounting.breakdowns?.model?.[0]?.cost.apiEquivalentUsd).toBe(6);
        expect(standard.accounting.priceCatalog?.provenance.revision).toBe('fixture-revision');
        expect(standard.accounting.contributions).toEqual([expect.objectContaining({ sessionId: null,
            turnId: null, agentId: null, source: 'app_calls', eventCount: 2 })]);
        expect(raw).toEqual(original);
    });

    it('preserves unpriced calls and lost coverage instead of treating them as zero spend', () => {
        const result = project({ ...raw, items: [row, { ...row, modelId: 'unlisted', callCount: 1 },
            { ...row, tokenCategories: null }],
            coverage: { ...raw.coverage, callCount: 5, tokenCategoryCallCount: 3, lostObservations: 1, reason: 'capture_write_failed' } },
        catalog, {}, { granularity: 'hour' });
        expect(result.accounting.totals.eventCount).toBe(5);
        expect(result.accounting.coverage?.status).toBe('partial');
        expect(result.accounting.coverage?.reasons).toContain('incomplete_history');
        expect(result.accounting.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unpriced', eventCount: 1 })]));
        expect(result.accounting.coverage?.reasons).toContain('unknown_token_categories');
        expect(result.accounting.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unpriced', eventCount: 2 })]));
        expect(result.coverage.lostObservations).toBe(1);
    });

    it('retains reported money in its emitted currency beside the distinct API-equivalent estimate', () => {
        const result = project({ ...raw, items: [{ ...row, reportedCost: { amount: 4.25, currency: 'EUR' } }],
            coverage: { ...raw.coverage, reportedCostCallCount: 2 } }, catalog, {}, { granularity: 'hour' });
        expect(result.accounting.costFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'reported', amountUsd: 4.25, currency: 'EUR' }),
            expect.objectContaining({ kind: 'api_equivalent', amountUsd: 6, currency: 'USD' }),
        ]));
    });
});
