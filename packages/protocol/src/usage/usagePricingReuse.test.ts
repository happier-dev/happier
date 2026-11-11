import { describe, expect, it } from 'vitest';
import { createUsageModelCostEstimator, estimateUsageModelCost, projectUsageAnalyticsSummary, repriceUsageAnalyticsResponse } from './usageCost.js';
import { createUsagePricingReuse, type UsagePricingReuseCheckpoint } from './usagePricingReuse.js';
import { readUsageMoney, serializeUsageMoneyProvenance, withUsageMoney } from './usageMoney.js';
import type { UsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsContribution, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from './usageAggregation.js';

const tokens = { input: 1, output: 0.1, reasoning: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 2 };
const catalog: UsageModelPriceCatalog = { v: 1, models: { model: { inputUsdPerMillion: 283.3333333333333,
    outputUsdPerMillion: 2.718281828, cacheReadUsdPerMillion: 0.01, cacheWriteUsdPerMillion: 5.25 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'reuse-test', fetchStatus: 'ready' } };
const roundTrip = (value: UsagePricingReuseCheckpoint): UsagePricingReuseCheckpoint => JSON.parse(JSON.stringify(value));
function observedCatalog() {
    let reads = 0;
    const value = { ...catalog, models: new Proxy(catalog.models, { get(target, key, receiver) {
        if (key === 'model') reads++;
        return Reflect.get(target, key, receiver);
    } }) };
    return { value, reads: () => reads, reset() { reads = 0; } };
}

describe('pricing-owner exact tariff reuse', () => {
    it.each(['auto', 'reported', 'estimated', 'api_equivalent'] as const)(
        'shares restored tariffs across summary and calendar populations with identical %s wire money', mode => {
        const categories = withUsageMoney({ ...tokens }, { input: { units: 100000000000000003n, scale: 17 } });
        const rows: UsageAnalyticsContribution[] = [1, 2].map(index => ({ id: `row-${index}`, eventCount: 1,
            observedAtMs: index * 3_600_000, agentId: `agent-${index}`, modelId: 'model', machineId: null,
            sessionId: null, turnId: null, projectKey: null, workspaceId: null, source: 'runtime',
            sourceContext: { path: 'runtime', execution: 'happier' }, tokens: categories, tokenCategories: categories,
            cost: createEmptyUsageCost() }));
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 86_400_000 }, includeActivity: true,
            includeModelTimeline: true, includeLeaders: false, costMode: mode });
        const raw: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: rows.length,
            tokens: rows.reduce((sum, row) => addUsageTokens(sum, row.tokens), createEmptyUsageTokens()), cost: createEmptyUsageCost() },
            series: rows.map(row => ({ bucketStartMs: row.observedAtMs, bucketEndMs: row.observedAtMs + 3_600_000,
                eventCount: 1, tokens: row.tokens, cost: createEmptyUsageCost() })), contributions: rows };
        const compact: UsageAnalyticsQueryResponse = JSON.parse(JSON.stringify(projectUsageAnalyticsSummary(
            repriceUsageAnalyticsResponse(raw, catalog, {}, mode), query)));
        const observed = observedCatalog();
        const first = createUsagePricingReuse(observed.value, {}, mode);
        observed.reset();
        const expected = repriceUsageAnalyticsResponse(compact, observed.value, {}, mode, undefined, first);
        expect(first.stats.tariffCalculations).toBeGreaterThan(0);
        expect(observed.reads(), 'tariff statistics match real model resolution across output cells').toBe(first.stats.tariffCalculations);
        let resolverBuilds = 0;
        for (let publication = 0; publication < 4; publication++) {
            expect(repriceUsageAnalyticsResponse(expected, observed.value, {}, mode, undefined, () => {
                resolverBuilds++;
                return first;
            }), 'completed pricing retains identity across source publications').toBe(expected);
        }
        expect(resolverBuilds, 'completed publications need no tariff resolver').toBe(0);
        const next = createUsagePricingReuse(observed.value, {}, mode, roundTrip(first.snapshot()));
        observed.reset();
        const actual = repriceUsageAnalyticsResponse(compact, observed.value, {}, mode, undefined, next);
        expect(observed.reads(), 'every summary and calendar operand uses restored tariffs').toBe(0);
        expect(next.stats.tariffCalculations).toBe(0);
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        expect(actual.summary?.accountingCalendar).toBeDefined();
        const live = createUsagePricingReuse(observed.value, {}, mode, roundTrip(next.snapshot()));
        expect(JSON.stringify(repriceUsageAnalyticsResponse(actual, observed.value, {}, mode, undefined, live)))
            .toBe(JSON.stringify(expected));
        expect(roundTrip(live.snapshot()), 'a live priced response must still admit its checkpoint operands')
            .toEqual(roundTrip(next.snapshot()));
    });

    it('restores exact tariffs and cache savings from JSON without resolving the model again', () => {
        const observed = observedCatalog();
        const categories = withUsageMoney({ ...tokens }, { input: { units: 100000000000000003n, scale: 17 } });
        const first = createUsagePricingReuse(observed.value, {}, 'auto');
        observed.reset();
        const expected = createUsageModelCostEstimator(observed.value, {}, first)('model', categories)!;
        expect(observed.reads()).toBe(1);
        const next = createUsagePricingReuse(observed.value, {}, 'auto', roundTrip(first.snapshot()));
        expect(next.reusesPreviousPriceInputs).toBe(true);
        observed.reset();
        const actual = createUsageModelCostEstimator(observed.value, {}, next)('model', categories)!;
        expect(observed.reads(), 'restored exact operands do no tariff lookup').toBe(0);
        expect(next.stats).toMatchObject({ tariffCalculations: 0, tariffReuses: 1 });
        expect(actual).toEqual(expected);
        expect(serializeUsageMoneyProvenance(actual)).toEqual(serializeUsageMoneyProvenance(expected));
        expect(readUsageMoney(actual.breakdown!, 'cacheSavingsUsd', actual.breakdown!.cacheSavingsUsd))
            .toEqual(readUsageMoney(expected.breakdown!, 'cacheSavingsUsd', expected.breakdown!.cacheSavingsUsd));
    });

    it('calculates only missing exact operands across independent population estimators', () => {
        const observed = observedCatalog();
        const first = createUsagePricingReuse(observed.value, {}, 'auto');
        createUsageModelCostEstimator(observed.value, {}, first)('model', tokens);
        createUsageModelCostEstimator(observed.value, {}, first)('unknown', tokens);
        createUsageModelCostEstimator(observed.value, {}, first)('model', null);
        const next = createUsagePricingReuse(observed.value, {}, 'auto', roundTrip(first.snapshot()));
        const precise = withUsageMoney({ ...tokens }, { input: { units: 100000000000000003n, scale: 17 } });
        observed.reset();
        for (const categories of [tokens, precise, precise, null]) {
            const actual = createUsageModelCostEstimator(observed.value, {}, next)('model', categories);
            expect(actual).toEqual(estimateUsageModelCost('model', categories, catalog));
        }
        expect(createUsageModelCostEstimator(observed.value, {}, next)('unknown', tokens)).toBeNull();
        expect(observed.reads(), 'one changed decimal operand is the only new tariff calculation').toBe(1);
        expect(next.stats).toMatchObject({ tariffCalculations: 1, tariffReuses: 4 });
        expect(next.snapshot().estimates).toHaveLength(4);
        const reduced = createUsagePricingReuse(observed.value, {}, 'auto', roundTrip(next.snapshot()));
        createUsageModelCostEstimator(observed.value, {}, reduced)('model', tokens);
        expect(reduced.snapshot().estimates).toHaveLength(1);
    });

    it('invalidates same-revision changed rates, overrides and cost mode against fresh canonical money', () => {
        const first = createUsagePricingReuse(catalog, {}, 'auto');
        createUsageModelCostEstimator(catalog, {}, first)('model', tokens);
        const checkpoint = roundTrip(first.snapshot());
        const changed = { ...catalog, models: { model: { ...catalog.models.model!, inputUsdPerMillion: 7 } } };
        const override = { model: { kind: 'rates' as const, inputUsdPerMillion: 19, outputUsdPerMillion: 23,
            cacheReadUsdPerMillion: 0.01, cacheWriteUsdPerMillion: 5.25 } };
        for (const [prices, overrides, mode] of [[changed, {}, 'auto'], [catalog, override, 'auto'],
            [catalog, {}, 'reported']] as const) {
            const next = createUsagePricingReuse(prices, overrides, mode, checkpoint);
            expect(next.reusesPreviousPriceInputs).toBe(false);
            expect(createUsageModelCostEstimator(prices, overrides, next)('model', tokens))
                .toEqual(estimateUsageModelCost('model', tokens, prices, overrides));
            expect(next.stats).toMatchObject({ tariffCalculations: 1, tariffReuses: 0 });
        }
        expect(createUsagePricingReuse(catalog, {}, 'auto').reusesPreviousPriceInputs).toBe(false);
    });
});
