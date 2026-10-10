import { expect, it } from 'vitest';
import { repriceUsageAnalyticsResponse } from './usageCost.js';
import { UsageAnalyticsContributionSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';

const contribution = { id: 'row', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: 'agent', modelId: 'model',
    machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    cost: { reportedUsd: 0, estimatedUsd: 0, costSource: 'none', currency: 'USD' } };

it('admits witnessed contribution event counts while retaining older missing counts', () => {
    expect(UsageAnalyticsContributionSchema.parse({ ...contribution, eventCount: 3 }).eventCount).toBe(3);
    expect(UsageAnalyticsContributionSchema.parse(contribution).eventCount).toBeUndefined();
    expect(UsageAnalyticsContributionSchema.safeParse({ ...contribution, eventCount: -1 }).success).toBe(false);
});

it('recovers a server-omitted token-tied winner after a private price override', () => {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 7, costSource: 'pricing_estimate', currency: 'USD' };
    const leader = { key: 'a-model', label: 'a-model', eventCount: 2, tokens, cost };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 5, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 }, cost },
        leaders: { models: [leader] }, modelTimeline: [{ bucketStartMs: 0, bucketEndMs: 100, leaders: [leader] }],
        contributions: ['a-model', 'z-model'].map(modelId => ({ id: modelId, observedAtMs: 1, sessionId: 'session', turnId: null,
            agentId: 'agent', backendMode: null, modelId, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
            tokens, tokenCategories: tokens, cost })),
    });
    const admitted = { ...response, contributions: response.contributions!.map((row, index) => ({ ...row, eventCount: index === 0 ? 2 : 3 })) };
    const result = repriceUsageAnalyticsResponse(admitted, {
        v: 1, models: { 'a-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 }, 'z-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 3 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' },
    }, { 'z-model': { kind: 'rates', inputUsdPerMillion: 10, outputUsdPerMillion: 3 } }, 'api_equivalent');
    expect(result.leaders?.models).toEqual([expect.objectContaining({ key: 'z-model', label: 'z-model', eventCount: 3,
        cost: expect.objectContaining({ apiEquivalentUsd: 10, effectiveUsd: 10 }) })]);
    expect(result.modelTimeline?.[0]?.leaders[0]?.key).toBe('z-model');
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent' && fact.source.includes('user:'))?.eventCount).toBe(3);
});

it('retains older rankings honestly when missing event counts prevent reconstructing ties', () => {
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens: contribution.tokens, cost: contribution.cost },
        contributions: [contribution], leaders: { models: [{ key: 'model', label: 'preserved label', eventCount: 3,
            tokens: contribution.tokens, cost: contribution.cost }] },
        coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [], range: { complete: true },
            ranked: [{ dimension: 'model', totalEntries: 1, returnedEntries: 1, complete: true }] },
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1, models: { model: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' } }, {}, 'api_equivalent');
    expect(result.leaders?.models?.[0]).toMatchObject({ key: 'model', label: 'preserved label', eventCount: 3 });
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['ranked_truncation'], ranked: [{ complete: false }] });
});
