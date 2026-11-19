import { beforeAll, describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema,
    type UsageAnalyticsContribution, type UsageAnalyticsQueryResponse, type UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { addUsageTokens, aggregateUsageContributionCosts, createEmptyUsageTokens } from './usageAggregation.js';
import { projectUsageAgentAccountingCalendar, UsageAgentCalendarSchema } from './usageAgentCalendar.js';
import { projectUsageAnalyticsSummary, repriceUsageAnalyticsResponse } from './usageCost.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { buildUsagePricingPopulation, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';
import { buildUsageSummaryCalendarPricing, repriceUsageSummaryCalendarPricing } from './usageSummaryCalendarPricing.js';

import { createUsagePricingReuse, type UsagePricingReuseCheckpoint } from './usagePricingReuse.js';
import { readUsageMoney, serializeUsageMoneyProvenance, usageMoneyFromNumber, withUsageMoney } from './usageMoney.js';

const startMs = Date.parse('2026-10-19T00:00:00Z');
const dayMs = 86_400_000;
const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs, endMs: startMs + 9 * dayMs },
    timeZoneOffsetMinutes: 330, includeActivity: true });
const catalog: UsageModelPriceCatalog = { v: 1, models: {
    first: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    second: { inputUsdPerMillion: 3, outputUsdPerMillion: 4 },
}, provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'calendar-A', fetchStatus: 'ready' } };
const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };

function row(index: number, changes: Partial<UsageAnalyticsContribution> = {}): UsageAnalyticsContribution {
    return { id: `private-calendar-event-${index}`, eventCount: 1, observedAtMs: startMs + 1_000,
        sessionId: 'private-session', turnId: 'private-turn', agentId: 'codex', modelId: 'first',
        machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
        sourceContext: { path: 'runtime', execution: 'happier' }, tokens, tokenCategories: tokens,
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'pricing_estimate' }, ...changes };
}

function response(rows: UsageAnalyticsContribution[], overrides: UsageModelPriceOverridesV1 = {}): UsageAnalyticsQueryResponse {
    return repriceUsageAnalyticsResponse({ v: 1, contributions: rows, priceCatalog: catalog,
        totals: { eventCount: rows.length,
            tokens: rows.reduce((total, row) => addUsageTokens(total, row.tokens), createEmptyUsageTokens()),
            cost: aggregateUsageContributionCosts(rows, 'auto') },
        coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [],
            range: { ...query.dateRange!, complete: true },
            sources: [{ source: 'runtime', path: 'runtime', status: 'available', eventCount: rows.length, historyComplete: true }] },
    }, catalog, overrides);
}

function calendar(value: UsageAnalyticsQueryResponse, mode: NonNullable<typeof query.costMode> = 'auto') {
    // Observe the public calendar, not in-process exact arithmetic Symbols that
    // JSON and boundary admission intentionally omit.
    return UsageAgentCalendarSchema.parse(projectUsageAgentAccountingCalendar({ accounting: value,
        period: { startMs, endMs: query.dateRange!.endMs! }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
        costMode: mode }).projection);
}

const wire = (value: UsageAnalyticsQueryResponse) => UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(value)));

describe('compact calendar pricing', () => {
    it('keeps the known cost and its incomplete status in rich and compact hourly views', () => {
        const value = response([
            row(1, { cost: { reportedUsd: 2, estimatedUsd: null, currency: 'USD' } }),
            row(2, { agentId: 'claude', modelId: null,
                cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD' } }),
            row(3, { observedAtMs: startMs + 3_601_000,
                cost: { reportedUsd: 1.5, estimatedUsd: null, currency: 'USD' } }),
        ]);
        const mode = 'reported';
        const compact = wire(projectUsageAnalyticsSummary(value, { ...query, costMode: mode }));
        const { value: summaryCalendar, pricing } = compact.summary!.accountingCalendar!;
        const repriced = repriceUsageSummaryCalendarPricing(summaryCalendar, pricing!, catalog, {}, mode);
        for (const result of [calendar(value, mode), UsageAgentCalendarSchema.parse(repriced)]) {
            for (const buckets of [result.weekdayHourBuckets, result.hourOfDayBuckets]) {
                const costs = buckets.map(bucket => bucket.totals.cost);
                expect(costs.find(cost => cost?.amountUsd === 2)).toMatchObject({ partial: true });
                expect(costs.find(cost => cost?.amountUsd === 1.5)).toBeDefined();
                expect(costs.find(cost => cost?.amountUsd === 1.5)).not.toHaveProperty('partial');
            }
        }
    });

    it.each(['auto', 'reported', 'estimated', 'api_equivalent'] as const)(
        'reuses exact %s calendar targets before traversing unchanged atomic groups', mode => {
        const preciseTokens = withUsageMoney({ ...tokens }, { input: { units: 100000000000000003n, scale: 17 } });
        const rows = [row(1, { tokens: preciseTokens, tokenCategories: preciseTokens,
            cost: withUsageMoney({ reportedUsd: 0.1, estimatedUsd: 0.2, currency: 'USD', costSource: 'provider_reported' },
                { reportedUsd: { units: 100000000000000003n, scale: 18 },
                    estimatedUsd: { units: 200000000000000003n, scale: 18 } }) }),
            row(2, { agentId: 'claude', modelId: 'second', observedAtMs: startMs + 8 * dayMs + 3_600_000 })];
        const compact = wire(projectUsageAnalyticsSummary(response(rows), { ...query, costMode: mode }));
        const { value, pricing } = compact.summary!.accountingCalendar!;
        const first = createUsagePricingReuse(catalog, {}, mode);
        const expected = repriceUsageSummaryCalendarPricing(value, pricing!, catalog, {}, mode, first);
        const checkpoint: UsagePricingReuseCheckpoint = JSON.parse(JSON.stringify(first.snapshot()));
        const next = createUsagePricingReuse(catalog, {}, mode, checkpoint);
        let traversals = 0;
        for (const population of Object.values(pricing!)) {
            const originalIterator = population.groups[Symbol.iterator];
            population.groups[Symbol.iterator] = function () { traversals++; return originalIterator.call(this); };
        }
        const actual = repriceUsageSummaryCalendarPricing(value, pricing!, catalog, {}, mode, next);
        expect(traversals, 'restored targets skip the real merge traversal').toBe(0);
        expect(next.stats).toMatchObject({ calendarTargetCalculations: 0, calendarTargetReuses: 23 });
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        const actualCost = actual.hours.find(hour => hour.agents.some(agent => agent.agentId === 'codex'))!.totals.cost;
        const expectedCost = expected.hours.find(hour => hour.agents.some(agent => agent.agentId === 'codex'))!.totals.cost;
        expect(actualCost).not.toBeNull();
        expect(serializeUsageMoneyProvenance(actualCost!)).toEqual(serializeUsageMoneyProvenance(expectedCost!));
        expect(readUsageMoney(actualCost!, 'amountUsd', actualCost!.amountUsd))
            .toEqual(readUsageMoney(expectedCost!, 'amountUsd', expectedCost!.amountUsd));
        expect(readUsageMoney(expectedCost!, 'amountUsd', expectedCost!.amountUsd),
            'fixture carries selected precision beyond its public number').not.toEqual(usageMoneyFromNumber(expectedCost!.amountUsd));

        const legacy = { ...checkpoint };
        delete legacy.calendar;
        const legacyReuse = createUsagePricingReuse(catalog, {}, mode, legacy);
        expect(JSON.stringify(repriceUsageSummaryCalendarPricing(value, pricing!, catalog, {}, mode, legacyReuse)))
            .toBe(JSON.stringify(expected));
        expect(legacyReuse.stats).toMatchObject({ calendarTargetCalculations: 23, calendarTargetReuses: 0 });
        const changedCatalog = { ...catalog, models: { ...catalog.models,
            first: { ...catalog.models.first!, inputUsdPerMillion: 7 } } };
        for (const [prices, overrides, nextMode] of [[changedCatalog, {}, mode],
            [catalog, { first: { kind: 'rates' as const, inputUsdPerMillion: 11, outputUsdPerMillion: 13 } }, mode],
            [catalog, {}, mode === 'reported' ? 'auto' : 'reported']] as const) {
            const invalidated = createUsagePricingReuse(prices, overrides, nextMode, checkpoint);
            const actual = repriceUsageSummaryCalendarPricing(value, pricing!, prices, overrides, nextMode, invalidated);
            expect(invalidated.stats).toMatchObject({ calendarTargetCalculations: 23, calendarTargetReuses: 0 });
            expect(JSON.stringify(actual)).toBe(JSON.stringify(repriceUsageSummaryCalendarPricing(value, pricing!, prices, overrides, nextMode)));
        }

        const mutations: ReadonlyArray<(population: UsagePricingPopulation) => void> = [
            population => { population.groups[0]!.categoryUnits.input = { units: '100000000000000007', scale: 17 }; },
            population => { population.groups[0]!.costUnits.reportedUsd = { units: '100000000000000007', scale: 18 }; },
            population => { population.groups[0]!.selection = { auto: 'unavailable', reported: 'unavailable', estimated: 'unavailable' }; },
            population => { population.groups[0]!.asOfMs++; population.groups[0]!.complete = false;
                population.groups[0]!.eventCount++; population.groups[0]!.contributionCount++; },
        ];
        for (const mutate of mutations) {
            const changed: Record<string, UsagePricingPopulation> = JSON.parse(JSON.stringify(pricing));
            const changedKey = Object.keys(changed)[0]!;
            mutate(changed[changedKey]!);
            let changedTraversals = 0;
            let unchangedTraversals = 0;
            for (const [key, population] of Object.entries(changed)) {
                const originalIterator = population.groups[Symbol.iterator];
                population.groups[Symbol.iterator] = function () {
                    if (key === changedKey) changedTraversals++; else unchangedTraversals++;
                    return originalIterator.call(this);
                };
            }
            const reuse = createUsagePricingReuse(catalog, {}, mode, checkpoint);
            const actual = repriceUsageSummaryCalendarPricing(value, changed, catalog, {}, mode, reuse);
            expect(reuse.stats).toMatchObject({ calendarTargetCalculations: 12, calendarTargetReuses: 11 });
            expect(changedTraversals, 'each affected target merges the changed atom once').toBe(12);
            expect(unchangedTraversals, 'only the shared period target revisits the other atom').toBe(1);
            const fresh = repriceUsageSummaryCalendarPricing(value, changed, catalog, {}, mode);
            expect(JSON.stringify(actual)).toBe(JSON.stringify(fresh));
            expect(serializeUsageMoneyProvenance(actual.periodSummary.totals.cost ?? {}))
                .toEqual(serializeUsageMoneyProvenance(fresh.periodSummary.totals.cost ?? {}));
        }
        const reordered = { ...value, hours: [...value.hours].reverse() };
        const reorderedReuse = createUsagePricingReuse(catalog, {}, mode, checkpoint);
        expect(JSON.stringify(repriceUsageSummaryCalendarPricing(reordered, pricing!, catalog, {}, mode, reorderedReuse)))
            .toBe(JSON.stringify(repriceUsageSummaryCalendarPricing(reordered, pricing!, catalog, {}, mode)));
        expect(reorderedReuse.stats).toMatchObject({ calendarTargetCalculations: 1, calendarTargetReuses: 22 });
    });

    it('reprices every calendar target exactly across private prices, catalog changes and clearing after JSON delivery', () => {
        const rows = [row(1), row(2, { agentId: 'claude', modelId: 'second',
            observedAtMs: startMs + dayMs + 3_600_000 }),
        row(3, { modelId: 'second', observedAtMs: startMs + 7 * dayMs + 7_200_000 }),
        row(4, { agentId: null, modelId: 'first', observedAtMs: startMs + 8 * dayMs + 7_200_000 })];
        const rich = response(rows);
        let compact = wire(projectUsageAnalyticsSummary(rich, query));
        const newCatalog: UsageModelPriceCatalog = { ...catalog, models: {
            first: { inputUsdPerMillion: 9, outputUsdPerMillion: 11 },
            second: { inputUsdPerMillion: 13, outputUsdPerMillion: 17 },
        }, provenance: { ...catalog.provenance, revision: 'calendar-B' } };
        const passes: ReadonlyArray<readonly [UsageModelPriceCatalog, UsageModelPriceOverridesV1]> = [
            [catalog, { first: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 },
                second: { kind: 'rates', inputUsdPerMillion: 1_000, outputUsdPerMillion: 0 } }],
            [newCatalog, { first: { kind: 'map', modelId: 'second' } }],
            [catalog, {}],
        ];
        for (const [prices, overrides] of passes) {
            compact = wire(repriceUsageAnalyticsResponse(compact, prices, overrides));
            const expected = calendar(repriceUsageAnalyticsResponse(rich, prices, overrides));
            // Full equality covers costs, cost leaders and shares alongside unchanged
            // tokens, Sessions, coverage, active days and weekly Agent mix.
            expect(calendar(compact)).toEqual(expected);
            expect(compact.contributions).toBeUndefined();
        }
        expect(calendar(compact)).toEqual(calendar(rich));
    });

    it('resolves reported overlap across calendar cells before grouping and keeps unavailable money distinct from zero', () => {
        const zero = createEmptyUsageTokens();
        const rows = [row(1, { cost: { reportedUsd: 0, estimatedUsd: 2, currency: 'USD',
            costSource: 'pricing_estimate', reportedTotalId: 'private-calendar-report' } }),
        row(2, { id: 'private-calendar-report', agentId: 'claude', modelId: null,
            observedAtMs: startMs + dayMs + 1_000, tokens: zero, tokenCategories: zero,
            cost: { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported',
                reportedTotalContributionIds: ['private-calendar-event-1'] } }),
        row(3, { observedAtMs: startMs + 2 * dayMs + 1_000, agentId: 'unknown-model', modelId: 'missing',
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } })];
        const rich = response(rows);
        const overrides = { first: { kind: 'rates' as const, inputUsdPerMillion: 5, outputUsdPerMillion: 0 } };
        for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            const compact = wire(projectUsageAnalyticsSummary(rich, { ...query, costMode: mode }));
            const actual = calendar(wire(repriceUsageAnalyticsResponse(compact, catalog, overrides, mode)), mode);
            const expected = calendar(repriceUsageAnalyticsResponse(rich, catalog, overrides, mode), mode);
            expect(actual).toEqual(expected);
            expect(actual.days.find(day => day.agents.some(agent => agent.agentId === 'unknown-model'))!
                .agents.find(agent => agent.agentId === 'unknown-model')!.metrics.cost).toBeNull();
            expect(JSON.stringify(compact.summary)).not.toContain('private-calendar-report');
        }
    });

    describe('at the observed event scale', () => {
      const prepare = () => {
        const small = response([row(0)]);
        const overrides = { first: { kind: 'rates' as const, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0 } };
        const large = response(Array.from({ length: 32_975 }, (_, index) => row(index)), overrides);
        const projected = calendar(large);
        const smallSummary = projectUsageAnalyticsSummary(small, query);
        const largeSummary = projectUsageAnalyticsSummary(large, query);
        const rows = large.contributions!;
        let tokenReads = 0;
        for (const row of rows) {
            const tokens = row.tokens;
            Object.defineProperty(row, 'tokens', { enumerable: true, get() { tokenReads++; return tokens; } });
        }
        const states = resolveUsagePricingPopulationStates(rows);
        const onePassStarted = performance.now();
        const wholePopulation = buildUsagePricingPopulation(rows, states);
        const onePassMs = performance.now() - onePassStarted;
        const onePassReads = tokenReads;
        console.info('usage-calendar-grouping-baseline', { events: rows.length, onePassReads, onePassMs });
        return { rows, projected, smallSummary, largeSummary, wholePopulation, overrides, onePassReads, onePassMs,
            readTokenReads: () => tokenReads, resetTokenReads: () => { tokenReads = 0; } };
      };
      let scale: ReturnType<typeof prepare>;
      beforeAll(() => { scale = prepare(); });
      it('groups calendar price facts by rendered cells rather than retaining 32975 event allocations', () => {
        const { rows, projected, wholePopulation, onePassReads, onePassMs, smallSummary, largeSummary, overrides } = scale;
        scale.resetTokenReads();
        const calendarStarted = performance.now();
        const grouped = buildUsageSummaryCalendarPricing(projected, rows, query);
        const calendarMs = performance.now() - calendarStarted;
        expect(Object.keys(grouped.populations), 'one dated hour/Agent is delivered once, rather than once per calendar family').toHaveLength(1);
        // All rows share one dated hour/Agent. Building larger calendar targets
        // must merge its tariff groups, not reread every event for each target.
        expect(scale.readTokenReads()).toBe(onePassReads);
        const calendarReads = scale.readTokenReads();
        scale.resetTokenReads();
        const reused = buildUsageSummaryCalendarPricing(projected, rows, query, wholePopulation);
        expect(scale.readTokenReads()).toBe(0);
        expect(reused.populations).toEqual(grouped.populations);
        console.info('usage-calendar-grouping', { events: rows.length, onePassReads, calendarReads, sameQueryReuseReads: scale.readTokenReads(),
            onePassMs, calendarMs, renderedPricingTargets: Object.keys(grouped.populations).length });
        const smallPricing = smallSummary.summary!.accountingCalendar!.pricing;
        const largePricing = largeSummary.summary!.accountingCalendar!.pricing;
        expect(largePricing).toBeDefined();
        expect(Object.keys(largePricing!)).toHaveLength(Object.keys(smallPricing!).length);
        expect(Object.values(largePricing!).map(population => population.groups.length))
            .toEqual(Object.values(smallPricing!).map(population => population.groups.length));
        expect(JSON.stringify(largePricing)).not.toContain('private-calendar-event-');
        expect(JSON.stringify(largePricing)).not.toContain('private-session');
        expect(calendar(wire(repriceUsageAnalyticsResponse(wire(largeSummary), catalog, overrides))))
            .toEqual(projected);
      });
    });
});
