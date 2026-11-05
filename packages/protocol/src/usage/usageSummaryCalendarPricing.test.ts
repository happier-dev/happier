import { beforeAll, describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema,
    type UsageAnalyticsContribution, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { addUsageTokens, aggregateUsageContributionCosts, createEmptyUsageTokens } from './usageAggregation.js';
import { projectUsageAgentAccountingCalendar, UsageAgentCalendarSchema } from './usageAgentCalendar.js';
import { projectUsageAnalyticsSummary, repriceUsageAnalyticsResponse } from './usageCost.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { buildUsagePricingPopulation, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';
import { buildUsageSummaryCalendarPricing } from './usageSummaryCalendarPricing.js';

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
