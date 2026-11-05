import { describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, UsagePricingPopulationSchema, type UsageAnalyticsContribution, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import * as usageCost from './usageCost.js';
import { projectUsageAgentAccountingCalendar, projectUsageAgentCalendar, UsageAgentCalendarSchema } from './usageAgentCalendar.js';
import { buildUsageLeaderList } from './usageLeaderProjection.js';
import { addUsageTokens, aggregateUsageContributionCosts, createEmptyUsageTokens } from './usageAggregation.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { projectUsagePlanInsights } from './usagePlanInsights.js';
import { ConnectedServiceQuotaGetResultV1Schema } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { formatUsageCost } from './usageFormatting.js';
import { projectUsageAccountingSnapshotPrices } from './resolveUsagePageAggregation.js';
import type { UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { readUsageMoney, withUsageMoney } from './usageMoney.js';
import { resolveUsageCostFacts } from './usageCostFacts.js';
import { buildUsagePricedPartition, buildUsagePricingPopulation, priceUsagePricingPopulation, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';
import { projectUsageAnalyticsResponseDemand } from './usageAnalyticsDemandProjection.js';

const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' as const };
const catalog = { v: 1 as const, models: { model: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    provenance: { source: 'litellm' as const, origin: 'bundled' as const, asOfMs: 1, revision: 'summary-test', fetchStatus: 'ready' as const } };
const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 86_400_000 },
    includeActivity: true, includeLeaders: true, includeModelTimeline: true, breakdowns: ['model'], topLimit: 1 });
function contribution(index: number, change: Partial<UsageAnalyticsContribution> = {}): UsageAnalyticsContribution {
    return { id: `private-row-${index}`, eventCount: 1, observedAtMs: 1_000 + index, sessionId: 'session', turnId: `turn-${index}`,
        agentId: 'agent', modelId: 'model', machineId: 'machine', projectKey: 'project', workspaceId: null,
        source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens, tokenCategories: tokens, cost, ...change };
}
function response(rows: UsageAnalyticsContribution[]): UsageAnalyticsQueryResponse {
    return usageCost.repriceUsageAnalyticsResponse({ v: 1, totals: { eventCount: rows.length,
        tokens: rows.reduce((sum, row) => addUsageTokens(sum, row.tokens), createEmptyUsageTokens()),
        cost: aggregateUsageContributionCosts(rows, 'auto') }, contributions: rows, priceCatalog: catalog,
        breakdowns: { model: buildUsageLeaderList(rows.map(row => ({ ...row, eventCount: row.eventCount! })), 'model', 1, 'auto') ?? [] },
        coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], range: { startMs: 0, endMs: 86_400_000, complete: true },
            sources: [{ source: 'runtime', path: 'runtime', machineId: 'machine', status: 'available', eventCount: rows.length, historyComplete: true }] } });
}

// The existing snapshot price owner consumes only the compact admitted answer.
function priceCompact(compact: UsageAnalyticsQueryResponse,
    overrides: UsageModelPriceOverridesV1 = {}, mode: UsageAnalyticsQueryRequest['costMode'] = 'auto') {
    const requested = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, costBasis: mode,
        includeActivity: true, includeLeaders: true, includeModelTimeline: true,
        includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
    return projectUsageAccountingSnapshotPrices({ query: requested, status: 'available',
        value: compact }, overrides).priceProjection!.value;
}

describe('compact Usage summary', () => {
    it('starts an end-only calendar at the selected population first observed local day', () => {
        const endMs = Date.parse('2026-10-22T12:00:00Z');
        const firstMs = Date.parse('2026-10-19T23:00:00Z');
        const laterMs = Date.parse('2026-10-21T23:00:00Z');
        const admitted = { ...query, dateRange: { endMs }, timeZoneOffsetMinutes: 120 };
        const rows = [contribution(0, { observedAtMs: firstMs }), contribution(1, { observedAtMs: laterMs })];
        for (const selected of [rows, rows.slice(1)]) {
            const compact = usageCost.projectUsageAnalyticsSummary(response(selected), admitted);
            const calendar = compact.summary!.accountingCalendar!.value;
            expect(calendar.period).toEqual({ startMs: selected.length === 2
                ? Date.parse('2026-10-19T22:00:00Z') : Date.parse('2026-10-21T22:00:00Z'), endMs });
            expect(calendar.days.map(day => day.date)).toEqual(selected.length === 2
                ? ['2026-10-20', '2026-10-21', '2026-10-22'] : ['2026-10-22']);
            expect(compact.summary!.observationRange).toEqual({ startMs: selected[0]!.observedAtMs, endMs: laterMs + 1 });
            expect(calendar.periodSummary.totals.tokens).toBe(selected.length);
            expect(Object.keys(compact.summary!.accountingCalendar!.pricing!)).toHaveLength(selected.length);
        }
    });

    it('does not build empty prehistory for an end-only population with no observations', () => {
        const endMs = Date.parse('2026-10-22T12:00:00Z');
        const compact = usageCost.projectUsageAnalyticsSummary(response([]), { ...query, dateRange: { endMs } });
        const calendar = compact.summary!.accountingCalendar!;
        expect(calendar.value.period).toEqual({ startMs: endMs, endMs });
        expect(calendar.value.days).toEqual([]);
        expect(calendar.value.weeks).toEqual([]);
        expect(calendar.pricing).toEqual({});
        expect(compact.summary!.observationRange).toBeUndefined();
    });

    it('preserves explicit epoch and partial custom calendar bounds before the first observation', () => {
        for (const startMs of [0, 1_000]) {
            const endMs = 3 * 86_400_000;
            const compact = usageCost.projectUsageAnalyticsSummary(response([contribution(0, { observedAtMs: 2 * 86_400_000 + 1 })]),
                { ...query, dateRange: { startMs, endMs } });
            const calendar = compact.summary!.accountingCalendar!.value;
            expect(calendar.period).toEqual({ startMs, endMs });
            expect(calendar.days).toHaveLength(3);
            expect(calendar.days[0]!.startMs).toBe(startMs);
            expect(calendar.days.slice(0, 2).map(day => day.totals.tokens)).toEqual([0, 0]);
        }
    });

    it('preserves Overview ranked pricing bytes when shared breakdowns are removed from the delivered demand', () => {
        const rows = [contribution(0), contribution(1, { modelId: 'other', projectKey: 'other-project' })];
        const rich = response(rows);
        const rank = (dimension: Parameters<typeof buildUsageLeaderList>[1]) =>
            buildUsageLeaderList(rows.map(row => ({ ...row, eventCount: row.eventCount! })), dimension, 2, 'auto')!;
        rich.breakdowns = { agent: rank('agent'), project: rank('project') };
        rich.leaders = { agents: rank('agent'), models: rank('model'), sessions: rank('session'),
            projects: rank('project'), workspaces: rank('workspace'), engines: rank('engine') };
        const admitted = UsageAnalyticsQueryRequestSchema.parse({ ...query, includeActivity: false,
            includeModelTimeline: false, breakdowns: ['agent', 'project'], topLimit: 2 });
        const requested = { ...admitted, breakdowns: [] };
        for (const counted of [true, false]) {
            if (!counted) for (const row of rich.contributions!) delete row.eventCount;
            const compact = usageCost.projectUsageAnalyticsSummary(rich, admitted);
            const separate = usageCost.projectUsageAnalyticsSummary({ ...rich, breakdowns: undefined }, requested);
            const delivered = projectUsageAnalyticsResponseDemand(compact, admitted, requested)!;
            expect(Object.keys(separate.summary!.rankedPricing!)).toEqual(['leaders:agents', 'leaders:models',
                'leaders:sessions', 'leaders:projects', 'leaders:workspaces', 'leaders:engines']);
            expect(JSON.stringify(delivered.summary!.rankedPricing)).toBe(JSON.stringify(separate.summary!.rankedPricing));
        }
    });

    it('reuses admitted rich monetary partitions when delivering compact pricing', () => {
        for (const count of [128, 66_114]) {
            const rich = response(Array.from({ length: count }, (_, index) => contribution(index,
                { modelId: index % 2 ? 'model' : 'other' })));
            const expected = JSON.stringify(usageCost.projectUsageAnalyticsSummary(
                { ...rich, totals: { ...rich.totals } },
                { ...query, includeActivity: false, includeModelTimeline: false, includeLeaders: false }));
            let moneyReads = 0;
            for (const row of rich.contributions!) {
                const admitted = row.cost;
                Object.defineProperty(row, 'cost', { enumerable: true, get() { moneyReads++; return admitted; } });
            }
            const compact = usageCost.projectUsageAnalyticsSummary(rich,
                { ...query, includeActivity: false, includeModelTimeline: false, includeLeaders: false });
            expect(JSON.stringify(compact)).toBe(expected);
            expect(moneyReads, 'rich and compact consumers share the admitted money partitions').toBe(0);
        }
    });

    it('preserves row-order provenance when reported totals interleave their covered source rows', () => {
        const rows = [0, 1].flatMap(index => [
            contribution(index * 2, { id: `covered-${index}`, modelId: null,
                cost: { ...cost, estimatedUsd: 0, costSource: 'none', reportedTotalId: `total-${index}` } }),
            contribution(index * 2 + 1, { id: `total-${index}`, modelId: null,
                cost: { ...cost, estimatedUsd: 0, reportedUsd: 0.1, costSource: 'provider_reported_api_equivalent',
                    reportedTotalContributionIds: [`covered-${index}`], apiEquivalentUsd: 0, pricingSource: 'no_tokens' } }),
        ]);
        const expected = aggregateUsageContributionCosts(rows, 'auto');
        expect(expected.costSource).toBe('none');
        expect(buildUsagePricedPartition(rows, 'auto').cost).toEqual(expected);
    });

    it('admits ranked pricing operands once when a breakdown and leader consume the same dimension', () => {
        const measure = (count: number, withLeaders: boolean) => {
            const rich = response(Array.from({ length: count }, (_, index) => contribution(index,
                { modelId: index % 2 ? 'model' : 'other' })));
            const models = rich.breakdowns!.model!;
            if (withLeaders) rich.leaders = { models };
            let costReads = 0;
            for (const row of rich.contributions!) {
                const admitted = row.cost;
                Object.defineProperty(row, 'cost', { enumerable: true, get() { costReads++; return admitted; } });
            }
            const compact = usageCost.projectUsageAnalyticsSummary(rich,
                { ...query, includeActivity: false, includeModelTimeline: false, includeLeaders: withLeaders });
            if (withLeaders) {
                expect(compact.summary!.rankedPricing!['leaders:models']).toHaveLength(2);
                expect(compact.summary!.rankedPricing!['leaders:models'])
                    .toEqual(compact.summary!.rankedPricing!['breakdowns:model']);
            }
            return costReads;
        };
        // Read-only QA census: 66,114 events (r108-measurements.json, 2026-11-04).
        for (const count of [128, 66_114]) {
            expect(measure(count, true), 'another output of an admitted dimension must not revisit contribution money')
                .toBe(measure(count, false));
        }
    });

    it('preserves separate ranked frontiers and metadata while sharing their monetary operands', () => {
        for (const counted of [true, false]) {
            const rich = response(Array.from({ length: 11 }, (_, index) => contribution(index,
                { modelId: index < 6 ? 'model' : index < 10 ? 'other' : 'third' })));
            const models = buildUsageLeaderList(rich.contributions!.map(row => ({ ...row, eventCount: row.eventCount! })),
                'model', 2, 'auto')!;
            rich.breakdowns!.model![0] = { ...rich.breakdowns!.model![0]!, label: 'breakdown label',
                context: { usedTokens: 9, windowTokens: 20 } };
            rich.leaders = { models: models.map(entry => ({ ...entry, label: `leader ${entry.key}` })) };
            if (!counted) for (const row of rich.contributions!) delete row.eventCount;
            const demand = { ...query, includeActivity: false, includeModelTimeline: false };
            const combined = usageCost.projectUsageAnalyticsSummary(rich, demand).summary!.rankedPricing!;
            const breakdown = usageCost.projectUsageAnalyticsSummary({ ...rich, leaders: undefined }, demand).summary!.rankedPricing!;
            const leaders = usageCost.projectUsageAnalyticsSummary({ ...rich, breakdowns: undefined }, demand).summary!.rankedPricing!;
            expect(combined['breakdowns:model']).toEqual(breakdown['breakdowns:model']);
            expect(combined['leaders:models']).toEqual(leaders['leaders:models']);
            expect(combined['breakdowns:model']).toHaveLength(1);
            expect(combined['leaders:models']).toHaveLength(2);
            expect(combined['breakdowns:model']![0]!.value).toMatchObject({ label: 'breakdown label',
                context: { usedTokens: 9, windowTokens: 20 } });
            expect(combined['leaders:models']![0]!.value.label).toBe('leader model');
        }
    });

    it('keeps zero-total observations out of unpriced fact counts after grouping', () => {
        const rows = [contribution(0, { modelId: 'unknown', cost: { ...cost, estimatedUsd: 0 } }),
            contribution(1, { modelId: 'unknown', cost: { ...cost, estimatedUsd: 0 },
                tokens: { ...tokens, input: 0, output: 1, total: 0 },
                tokenCategories: { ...tokens, input: 0, output: 1, total: 0 } })];
        const rich = response(rows);
        const compact = priceUsagePricingPopulation(buildUsagePricingPopulation(rows), catalog, {}, 'auto');
        expect(compact.facts).toEqual(rich.costFacts);
    });
    it('retains exact observation bounds without event rows or calendar buckets on the wire', () => {
        const rich = response([contribution(0, { observedAtMs: 899 }), contribution(1, { observedAtMs: 101 }),
            contribution(2, { observedAtMs: 500 })]);
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich,
            { ...query, includeActivity: false, includeModelTimeline: false }))));
        expect(compact.contributions).toBeUndefined();
        expect(compact.summary?.accountingCalendar).toBeUndefined();
        expect(compact.summary).toMatchObject({ observationRange: { startMs: 101, endMs: 900 } });
        expect(priceCompact(compact, { model: { kind: 'rates', inputUsdPerMillion: 3, outputUsdPerMillion: 7 } }).summary)
            .toMatchObject({ observationRange: { startMs: 101, endMs: 900 } });
        expect(usageCost.projectUsageAnalyticsSummary(response([]), query).summary).not.toHaveProperty('observationRange');
    });

    it('retains overlap state only for scoped monetary operands, independent of ordinary population size', () => {
        const measure = (count: number) => {
            const rows = Array.from({ length: count }, (_, index) => contribution(index));
            rows[0] = contribution(0, { cost: { ...cost, reportedTotalId: 'private-row-1' } });
            rows[1] = contribution(1, { cost: { ...cost, estimatedUsd: 0, reportedUsd: 7,
                costSource: 'provider_reported', reportedTotalContributionIds: ['private-row-0'] } });
            const states = resolveUsagePricingPopulationStates(rows);
            const population = buildUsagePricingPopulation(rows, states);
            expect(priceUsagePricingPopulation(population, catalog, {}, 'auto').cost.effectiveUsd).toBe(7 + (count - 2) / 1_000_000);
            return [...states.values()].reduce((sum, state) => sum + state.size, 0);
        };
        expect(measure(256), 'ordinary contributions must not occupy identity-overlap indexes').toBe(measure(128));
    });

    it('admits exact tariff operands once per model independently of contribution count', () => {
        const rate = 123.456789;
        const prices = { ...catalog, models: { model: { inputUsdPerMillion: rate, outputUsdPerMillion: 2 } } };
        const expected = usageCost.estimateUsageModelCost('model', tokens, prices);
        const original = Number.prototype.toString;
        let conversions = 0;
        Number.prototype.toString = function (...args) {
            if (this.valueOf() === rate) conversions++;
            return original.apply(this, args);
        };
        try {
            const estimate = usageCost.createUsageModelCostEstimator(prices);
            expect(estimate('model', tokens)).toEqual(expected);
            const first = conversions;
            for (let index = 0; index < 128; index++) expect(estimate('model', tokens)).toEqual(expected);
            expect(conversions, 'one admitted tariff serves all requested monetary operands').toBe(first);
        } finally { Number.prototype.toString = original; }
    });

    it('admits unscoped compact money without constructing per-mode identity populations', () => {
        let identityReads = 0;
        const rows = Array.from({ length: 128 }, (_, index) => contribution(index));
        for (const row of rows) Object.defineProperty(row, 'id', { enumerable: true,
            get() { identityReads++; return 'unused-event-identity'; } });
        const states = resolveUsagePricingPopulationStates(rows);
        const population = buildUsagePricingPopulation(rows, states);
        expect(population.groups).toHaveLength(1);
        for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            expect(priceUsagePricingPopulation(population, catalog, {}, mode)).toEqual(
                priceUsagePricingPopulation(buildUsagePricingPopulation(rows.map((row, index) => contribution(index))), catalog, {}, mode));
        }
        expect(identityReads, 'ordinary money has no report identity overlap to resolve').toBe(0);
    });

    it('contracts counted ranking populations without copying unrelated contribution evidence', () => {
        const rich = response(Array.from({ length: 128 }, (_, index) => contribution(index,
            { modelId: `model-${index % 8}` })));
        let evidenceReads = 0;
        for (const row of rich.contributions!) Object.defineProperty(row, 'turnId', { enumerable: true,
            get() { evidenceReads++; return 'private-turn'; } });
        const compact = usageCost.projectUsageAnalyticsSummary(rich, { ...query,
            includeActivity: false, includeModelTimeline: false, includeLeaders: false });
        expect(compact.summary?.rankedPricing?.['breakdowns:model']).toHaveLength(8);
        expect(compact.contributions).toBeUndefined();
        expect(evidenceReads, 'compact ranking does not consume private turn evidence').toBe(0);
    });

    it('puts only sub-Number exact operands on the pricing wire, including public zero and fractional categories', () => {
        const categories = withUsageMoney({ ...tokens }, { input: { units: 100000000000000003n, scale: 17 } });
        const breakdown = withUsageMoney({ credit: 0 }, { credit: { units: 2n, scale: 21 } });
        const observed = withUsageMoney({ reportedUsd: 0.2, estimatedUsd: 0.3, invoiceUsd: 0,
            currency: 'USD', costSource: 'provider_reported' as const, breakdown }, {
            reportedUsd: { units: 1n, scale: 1 }, invoiceUsd: { units: 1n, scale: 20 },
        });
        const population = buildUsagePricingPopulation([contribution(1, { tokenCategories: categories, cost: observed })]);
        const group = population.groups[0]!;
        expect(group.categoryUnits).toEqual({ input: { units: '100000000000000003', scale: 17 } });
        expect(group.costUnits).toEqual({ reportedUsd: { units: '1', scale: 1 }, invoiceUsd: { units: '1', scale: 20 },
            'breakdown:credit': { units: '2', scale: 21 } });
        const wire = UsagePricingPopulationSchema.parse(JSON.parse(JSON.stringify(population)));
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333,
            outputUsdPerMillion: 0 } };
        for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            expect(priceUsagePricingPopulation(wire, catalog, overrides, mode)).toEqual(
                priceUsagePricingPopulation(population, catalog, overrides, mode));
        }
    });

    it('admits timeline pricing with source partitions through the strict compact wire schema', () => {
        const rows = [contribution(1)];
        const rich = usageCost.repriceUsageAnalyticsResponse({ ...response(rows), modelTimeline: [{ bucketStartMs: 0, bucketEndMs: 86_400_000,
            leaders: buildUsageLeaderList(rows.map(row => ({ ...row, eventCount: row.eventCount! })), 'model', 1,
                'auto', new Map(), true) ?? [] }] });
        const compact = usageCost.projectUsageAnalyticsSummary(rich, query);
        const rebuilt = usageCost.projectUsageAnalyticsSummary({ ...rich, totals: { ...rich.totals } }, query);
        expect(JSON.stringify(compact)).toBe(JSON.stringify(rebuilt));
        const admitted = UsageAnalyticsQueryResponseSchema.safeParse(JSON.parse(JSON.stringify(compact)));
        expect(admitted.success, JSON.stringify(admitted.error?.issues.map(issue => ({ code: issue.code, path: issue.path })))).toBe(true);
        expect(compact.summary?.rankedPricing?.['modelTimeline:0']?.[0]?.sources?.[0]?.population).toBeDefined();
    });

    it('partitions a population once rather than scanning its rows for every chart bucket or ranked candidate', () => {
        const measure = (rowCount: number, parts: number, ranked: boolean) => {
            const rows = Array.from({ length: rowCount }, (_, index) => contribution(index, {
                observedAtMs: index, ...(ranked ? { modelId: `model-${index % parts}` } : {}),
            }));
            const initial = response(rows);
            const width = rows.length / parts;
            const rich = usageCost.repriceUsageAnalyticsResponse({ ...initial,
                breakdowns: ranked ? initial.breakdowns : undefined,
                series: ranked ? undefined : Array.from({ length: parts }, (_, index) => ({
                    bucketStartMs: index * width, bucketEndMs: (index + 1) * width, eventCount: width,
                    tokens: { ...tokens, input: width, total: width }, cost,
                })),
            }, catalog);
            let reads = 0;
            const field = ranked ? 'modelId' : 'observedAtMs';
            for (const row of rich.contributions!) {
                const value = row[field];
                Object.defineProperty(row, field, { enumerable: true, get: () => { reads++; return value; } });
            }
            const compact = usageCost.projectUsageAnalyticsSummary(rich, { ...query, includeActivity: false,
                includeModelTimeline: false, includeLeaders: false, includeSeries: !ranked,
                breakdowns: ranked ? ['model'] : undefined });
            expect(compact.summary?.pricing?.totals?.groups.length).toBeGreaterThan(0);
            return reads;
        };
        for (const ranked of [false, true]) {
            // Allow work per returned group, but not rows multiplied by groups:
            // adding the same outputs must cost the same at either row count.
            const extra = (rowCount: number) => measure(rowCount, 16, ranked) - measure(rowCount, 8, ranked);
            expect.soft(extra(256), ranked ? 'ranked candidates must not rescan rows' : 'chart buckets must not rescan rows').toBe(extra(128));
        }
    });

    it('defers decimal admission for an untagged monetary fact until arithmetic needs it', () => {
        const decimal = 0.27431;
        const original = Number.prototype.toString;
        let conversions = 0;
        Number.prototype.toString = function (...args) {
            if (this.valueOf() === decimal) conversions++;
            return original.apply(this, args);
        };
        try {
            expect(resolveUsageCostFacts({ ...cost, estimatedUsd: decimal })).toMatchObject([
                { kind: 'estimated', amountUsd: decimal, currency: 'USD', source: 'pricing_estimate' },
            ]);
            expect(conversions).toBe(0);
        } finally {
            Number.prototype.toString = original;
        }
    });

    it('transfers valid exact provenance without revalidating a monetary fact', () => {
        const tagged = withUsageMoney({ ...cost, estimatedUsd: 0.2 }, {
            estimatedUsd: { units: 1n, scale: 1 },
        });
        const original = Number.isFinite;
        let validations = 0;
        Number.isFinite = function (value) {
            if (value === 0.2) validations++;
            return original(value);
        };
        try {
            const fact = resolveUsageCostFacts(tagged).find(fact => fact.kind === 'estimated')!;
            expect(readUsageMoney(fact, 'amountUsd', fact.amountUsd)).toEqual({ units: 1n, scale: 1 });
            expect(validations).toBe(0);
        } finally {
            Number.isFinite = original;
        }
        const stale = { ...tagged, estimatedUsd: 0.3 };
        const staleFact = resolveUsageCostFacts(stale).find(fact => fact.kind === 'estimated')!;
        expect(readUsageMoney(staleFact, 'amountUsd', staleFact.amountUsd)).toEqual({ units: 3n, scale: 1 });
    });

    it('keeps total and chart-cell selected availability through Resource JSON without changing legacy rich costs', () => {
        const rows = [contribution(1, { cost: { ...cost, reportedTotalId: 'final' } }),
            contribution(2, { id: 'final', observedAtMs: 3_700_000, modelId: null, tokens: createEmptyUsageTokens(), tokenCategories: createEmptyUsageTokens(),
                cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported', reportedTotalContributionIds: ['private-row-1'] } })];
        const rich = response(rows);
        rich.series = [{ bucketStartMs: 0, bucketEndMs: 3_600_000, eventCount: 1, tokens, cost },
            { bucketStartMs: 3_600_000, bucketEndMs: 7_200_000, eventCount: 1, tokens: createEmptyUsageTokens(), cost }];
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } };
        const richPriced = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        expect(JSON.stringify(richPriced)).not.toContain('selectedBasis');
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, query))));
        const priced = usageCost.repriceUsageAnalyticsResponse(compact, catalog, overrides);
        const decoded = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(priced)));
        expect(usageCost.resolveEffectiveUsageCostUsd(decoded.series![0]!.cost, 'auto')).toBe(0);
        expect(usageCost.projectUsagePageCost(decoded, 'auto').amountUsd).toBe(3);
        const outside = response([contribution(3, { cost: { ...cost, reportedTotalId: 'outside-report' } })]);
        const outsideCompact = usageCost.projectUsageAnalyticsSummary(outside, query);
        const outsideDecoded = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.repriceUsageAnalyticsResponse(outsideCompact, catalog, overrides))));
        expect(usageCost.projectUsagePageCost(outsideDecoded, 'auto').amountUsd).toBeNull();
        expect(outsideDecoded.totals.cost.apiEquivalentUsd).toBeGreaterThan(0);
    });

    it('retains mode-specific availability for reported totals outside the selected population', () => {
        const samples = [contribution(1, { cost: { ...cost, reportedTotalId: 'outside-report' } }),
            contribution(2, { cost: { ...cost, reportedUsd: 3, estimatedUsd: 2, costSource: 'provider_reported',
                reportedTotalContributionIds: ['outside-event'] } })];
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } };
        for (const row of samples) for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            const rich = usageCost.repriceUsageAnalyticsResponse(response([row]), catalog, {}, mode);
            const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, { ...query, costMode: mode }))));
            expect(usageCost.projectUsagePageCost(usageCost.repriceUsageAnalyticsResponse(compact, catalog, overrides, mode), mode).amountUsd)
                .toBe(usageCost.projectUsagePageCost(usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides, mode), mode).amountUsd);
            expect(JSON.stringify(compact.summary)).not.toContain('outside-');
        }
    });

    it('sums normalized categories independently of raw counter object aliases', () => {
        const inclusive = { input: 10, output: 0, reasoning: 0, cacheRead: 5, cacheWrite: 0, total: 10 };
        const exclusive = { ...inclusive, total: 15 };
        const rich = response([contribution(1, { tokens: inclusive, tokenCategories: { ...inclusive, input: 5 } }),
            contribution(2, { tokens: exclusive, tokenCategories: exclusive })]);
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 1_000_000, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0 } };
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, query))));
        expect(usageCost.repriceUsageAnalyticsResponse(compact, catalog, overrides).totals.cost.apiEquivalentUsd).toBe(15);
        expect(usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides).totals.cost.apiEquivalentUsd).toBe(15);
    });

    it('reselects a complete reported-total population when a private tariff makes its tokens available', () => {
        const zero = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
        const rich = response([contribution(1, { modelId: 'unknown', cost: { ...zero, reportedTotalId: 'total' } }),
            contribution(2, { id: 'total', modelId: 'unknown', cost: { ...zero, reportedTotalContributionIds: ['private-row-1'] } })]);
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, query))));
        const overrides = { unknown: { kind: 'rates' as const, inputUsdPerMillion: 4_000_000, outputUsdPerMillion: 0 } };
        const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        const actual = usageCost.repriceUsageAnalyticsResponse(compact, catalog, overrides);
        expect(actual.costPresentation).toEqual(expected.costPresentation);
        expect(actual.costPresentation?.effectiveUsd).toBe(4);
        expect(usageCost.repriceUsageAnalyticsResponse(UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(actual))), catalog).costPresentation)
            .toEqual(usageCost.repriceUsageAnalyticsResponse(rich, catalog).costPresentation);
    });

    it('uses the same exact mixed tariffs for colliding grouped populations and fractional token inputs', () => {
        const rates = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 },
            other: { kind: 'rates' as const, inputUsdPerMillion: 1000, outputUsdPerMillion: 0 } };
        const build = (counts: number[]) => response([...counts.map((count, index) => contribution(index,
            { tokens: { ...tokens, input: count, total: count }, tokenCategories: { ...tokens, input: count, total: count } })),
            contribution(99, { modelId: 'other' })]);
        const values = [[1, 2, 12], [1, 5, 9]].map(build);
        const grouped = values.map(value => UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(value, query)))));
        expect(grouped[0]!.summary).toEqual(grouped[1]!.summary);
        const prices = grouped.map(value => usageCost.repriceUsageAnalyticsResponse(value, catalog, rates));
        expect(prices[0]!.totals.cost.apiEquivalentUsd).toBe(prices[1]!.totals.cost.apiEquivalentUsd);
        for (let index = 0; index < values.length; index++) {
            expect(prices[index]!.totals.cost.apiEquivalentUsd).toBe(usageCost.repriceUsageAnalyticsResponse(values[index]!, catalog, rates).totals.cost.apiEquivalentUsd);
            expect(formatUsageCost(prices[index]!.totals.cost.apiEquivalentUsd!, 'USD')).toBe('$0.0052');
        }
        const fractional = build([0.1, 0.2]);
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(fractional,
            { ...query, includeActivity: false, includeModelTimeline: false }))));
        expect(UsageAnalyticsQueryResponseSchema.parse(usageCost.repriceUsageAnalyticsResponse(compact, catalog, rates)).costFacts)
            .toEqual(UsageAnalyticsQueryResponseSchema.parse(usageCost.repriceUsageAnalyticsResponse(fractional, catalog, rates)).costFacts);
    });

    it('contracts a whole-report membership graph to bounded overlap states without its identities', () => {
        const count = 32_975;
        const rows = Array.from({ length: count }, (_, index) => contribution(index, { cost: { ...cost, reportedTotalId: 'private-whole-report' } }));
        rows.push(contribution(count, { id: 'private-whole-report', tokens: createEmptyUsageTokens(), tokenCategories: createEmptyUsageTokens(),
            cost: { ...cost, reportedUsd: 7, estimatedUsd: 0, costSource: 'provider_reported', reportedTotalContributionIds: rows.map(row => row.id) } }));
        const rich = response(rows);
        const compact = usageCost.projectUsageAnalyticsSummary(rich, query);
        const wire = JSON.stringify(compact);
        expect(wire).not.toContain('private-whole-report');
        expect(wire).not.toContain('private-row-');
        expect(compact.summary?.pricing?.totals?.groups).toHaveLength(2);
        expect(wire.length).toBeLessThan(JSON.stringify(rich).length / 20);
        const priced = usageCost.repriceUsageAnalyticsResponse(UsageAnalyticsQueryResponseSchema.parse(JSON.parse(wire)), catalog,
            { model: { kind: 'rates', inputUsdPerMillion: 7, outputUsdPerMillion: 0 } });
        expect(priced.costPresentation?.effectiveUsd).toBe(7);
    }, 60_000);

    it('contracts custom-priced filtered summaries after historical membership admission', () => {
        const rich = response([contribution(1), contribution(2), contribution(3)]);
        const requested = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, projects: ['project'],
            includeWorkEvidence: true, workProjection: 'summary', includeSessionEvidence: true, includeTranscriptEvidence: false });
        const projected = projectUsageAccountingSnapshotPrices({ query: requested, status: 'available', value: rich },
            { model: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } }).priceProjection!.value;
        expect(projected.contributions).toBeUndefined();
        // 2026-10-31 orchestrator L0 ruling: exact decimal prices replace IEEE order artifacts.
        expect(projected.totals.cost.effectiveUsd).toBe(0.00085);
    });

    it('reprices a retained compact answer while its next refresh is pending', () => {
        const rich = response([contribution(1), contribution(2), contribution(3)]);
        const compact = usageCost.projectUsageAnalyticsSummary(rich, query);
        const requested = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 },
            includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
        const pending = { query: requested, status: 'pending' as const, value: compact };
        const updated = projectUsageAccountingSnapshotPrices(pending,
            { model: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } });
        expect(updated.priceProjection?.value.totals.cost.effectiveUsd).toBe(0.00085);
    });

    it('reprices admitted grouped tokens without ordered detail', () => {
        const rich = response([contribution(1), contribution(2), contribution(3)]);
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, query))));
        expect(usageCost.repriceUsageAnalyticsResponse(compact, catalog,
            { model: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } }).totals.cost.effectiveUsd)
            .toBe(0.00085);
    });

    it('publishes exact compact money at the existing price owner', () => {
        const rich = response([contribution(1), contribution(2), contribution(3)]);
        const requested = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, includeActivity: true,
            includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } };
        const projected = projectUsageAccountingSnapshotPrices({ query: requested, status: 'available', value: rich }, overrides).priceProjection!.value;
        expect(projected.contributions).toBeUndefined();
        expect(projected.totals.cost.effectiveUsd).toBe(0.00085);
        expect(formatUsageCost(projected.totals.cost.effectiveUsd!, 'USD')).toBe('$0.0009');
        expect(usageCost.repriceUsageAnalyticsResponse(projected, catalog, overrides)).toBe(projected);
        const input = { period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0, costMode: 'auto' as const };
        const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        expect(UsageAgentCalendarSchema.parse(projectUsageAgentCalendar({ ...input, accounting: projected })))
            .toEqual(UsageAgentCalendarSchema.parse(projectUsageAgentCalendar({ ...input, accounting: expected })));
    });

    it('clears a serialized private tariff from its retained grouped original facts', () => {
        const rich = response([contribution(1), contribution(2), contribution(3)]);
        const priced = priceCompact(usageCost.projectUsageAnalyticsSummary(rich, query),
            { model: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } });
        const serialized = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(priced)));
        expect(usageCost.repriceUsageAnalyticsResponse(serialized, catalog, {}).totals.cost)
            .toEqual(usageCost.projectUsageAnalyticsSummary(rich, query).totals.cost);
    });

    it('converges identical grouped populations despite different row token allocations', () => {
        const build = (counts: number[]) => response(counts.map((count, index) => contribution(index,
            { tokens: { ...tokens, input: count, total: count }, tokenCategories: { ...tokens, input: count, total: count } })));
        const first = build([1, 2, 12]);
        const second = build([1, 5, 9]);
        expect(usageCost.projectUsageAnalyticsSummary(first, query).summary)
            .toEqual(usageCost.projectUsageAnalyticsSummary(second, query).summary);
        const requested = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 },
            includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } };
        const price = (value: UsageAnalyticsQueryResponse) => projectUsageAccountingSnapshotPrices(
            { query: requested, status: 'available', value }, overrides).priceProjection!.value;
        expect(price(first).contributions).toBeUndefined();
        expect(formatUsageCost(price(first).totals.cost.effectiveUsd!, 'USD')).toBe('$0.0042');
        expect(formatUsageCost(price(second).totals.cost.effectiveUsd!, 'USD')).toBe('$0.0042');
    });

    it('shares the corrected exact formatted cost at a custom-tariff rounding boundary', () => {
        const rich = response([contribution(1), contribution(2), contribution(3)]);
        const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, query))));
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } };
        const oldProjection = usageCost.projectUsagePageCost(usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides, 'auto'), 'auto');
        const compactProjection = usageCost.projectUsagePageCost(priceCompact(compact, overrides), 'auto');
        expect(oldProjection.amountUsd).toBe(0.00085);
        expect(compactProjection.amountUsd).not.toBeNull();
        const oldDisplay = formatUsageCost(oldProjection.amountUsd!, 'USD');
        const compactDisplay = formatUsageCost(compactProjection.amountUsd!, 'USD');
        console.info('[usage-summary-custom-rounding]', JSON.stringify({ oldAmount: oldProjection.amountUsd,
            compactAmount: compactProjection.amountUsd, oldDisplay, compactDisplay }));
        expect(compactDisplay).toBe(oldDisplay);
    });

    it('delivers no contribution identities at the observed 32,975-row scale while keeping local override and calendar results', () => {
        const rich = response(Array.from({ length: 32_975 }, (_, index) => contribution(index)));
        const summary = usageCost.projectUsageAnalyticsSummary(rich, query);
        const wire = JSON.stringify(summary);
        expect(summary.contributions).toBeUndefined();
        expect(wire).not.toContain('private-row-');
        expect(wire).not.toContain('turn-');
        expect(wire.length).toBeLessThan(JSON.stringify(rich).length / 20);
        const admitted = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(wire));
        const { selectedBasis, ...observedCost } = admitted.totals.cost;
        expect({ ...admitted.totals, cost: observedCost }).toEqual(JSON.parse(JSON.stringify(rich.totals)));
        expect(selectedBasis?.mode).toBe('auto');
        console.info('[usage-summary-payload]', JSON.stringify({ contributions: rich.contributions!.length,
            richBytes: new TextEncoder().encode(JSON.stringify(rich)).length, summaryBytes: new TextEncoder().encode(wire).length,
            events: summary.totals.eventCount }));
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 7, outputUsdPerMillion: 11 } };
        const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        const actual = priceCompact(admitted, overrides);
        expect(actual.totals.cost.apiEquivalentUsd).toBeCloseTo(expected.totals.cost.apiEquivalentUsd!, 10);
        expect(actual.costPresentation?.effectiveUsd).toBeCloseTo(expected.costPresentation!.effectiveUsd, 10);
        const input = { period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0, costMode: 'auto' as const };
        const calendar = projectUsageAgentAccountingCalendar({ ...input, accounting: actual }).projection;
        const original = projectUsageAgentAccountingCalendar({ ...input, accounting: expected }).projection;
        expect(calendar.periodSummary.totals.tokens).toEqual(original.periodSummary.totals.tokens);
        expect(calendar.periodSummary.totals.sessions).toEqual(original.periodSummary.totals.sessions);
        expect(calendar.coverage).toEqual(original.coverage);
        expect(calendar.periodSummary.totals.cost?.amountUsd).toBeCloseTo(original.periodSummary.totals.cost!.amountUsd, 10);
        expect(UsageAgentCalendarSchema.parse(projectUsageAgentCalendar({ ...input, accounting: actual }))).toEqual(UsageAgentCalendarSchema.parse(calendar));
    }, 60_000);

    it('retains token-tied candidates omitted by server ranking after a private override', () => {
        const rich = response([contribution(1), contribution(2, { modelId: 'other' })]);
        const overrides = { other: { kind: 'rates' as const, inputUsdPerMillion: 10_000_000, outputUsdPerMillion: 0 } };
        const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        const compact = usageCost.projectUsageAnalyticsSummary(rich, query);
        const actual = priceCompact(compact, overrides);
        expect(actual.breakdowns?.model?.[0]?.key).toBe('other');
        expect(actual.breakdowns?.model?.[0]?.cost.effectiveUsd).toEqual(expected.breakdowns?.model?.[0]?.cost.effectiveUsd);
    });

    it('restores exact producer targets after retained serialized prices change A → B → no override', () => {
        const rich = response([contribution(1), contribution(2, { modelId: 'other' })]);
        rich.series = [{ bucketStartMs: 0, bucketEndMs: 3_600_000, eventCount: 2, tokens: rich.totals.tokens, cost: rich.totals.cost }];
        const original = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(usageCost.projectUsageAnalyticsSummary(rich, query))));
        const withPrice = (value: UsageAnalyticsQueryResponse, rate: number) => priceCompact(value,
            { other: { kind: 'rates', inputUsdPerMillion: rate, outputUsdPerMillion: 0 } });
        const first = withPrice(original, 2_000_000);
        const second = withPrice(UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(first))), 9_000_000);
        expect(second.costPresentation?.effectiveUsd).not.toEqual(first.costPresentation?.effectiveUsd);
        const restored = priceCompact(UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(second))));
        for (const key of ['totals', 'series', 'breakdowns', 'costFacts', 'costPresentation', 'coverage', 'insights'] as const) {
            expect(JSON.parse(JSON.stringify({ value: restored[key] }))).toEqual(JSON.parse(JSON.stringify({ value: original[key] })));
        }
        const calendarInput = { period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0 };
        expect(UsageAgentCalendarSchema.parse(projectUsageAgentCalendar({ ...calendarInput, accounting: restored })))
            .toEqual(UsageAgentCalendarSchema.parse(projectUsageAgentCalendar({ ...calendarInput, accounting: original })));
    });

    it('resolves reported overlap before partitioning and preserves explicit mode and currency availability', () => {
        const zero = createEmptyUsageTokens();
        const rows = [contribution(1, { cost: { ...cost, reportedTotalId: 'final-report' } }),
            contribution(2, { observedAtMs: 3_700_000, modelId: 'other', cost: { ...cost, currency: 'EUR', reportedTotalId: 'final-report' } }),
            contribution(3, { id: 'final-report', observedAtMs: 3_800_000, modelId: null, tokens: zero, tokenCategories: zero,
                cost: { reportedUsd: 7, estimatedUsd: 0, currency: 'EUR', costSource: 'provider_reported',
                    reportedTotalContributionIds: ['private-row-1', 'private-row-2'] } })];
        const rich = response(rows);
        rich.series = [{ bucketStartMs: 0, bucketEndMs: 3_600_000, eventCount: 1, tokens, cost },
            { bucketStartMs: 3_600_000, bucketEndMs: 7_200_000, eventCount: 2, tokens, cost }];
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 9, outputUsdPerMillion: 0 } };
        for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides, mode);
            const compact = usageCost.projectUsageAnalyticsSummary(rich, { ...query, costMode: mode });
            expect(JSON.stringify(compact)).not.toContain('private-row-');
            expect(JSON.stringify(compact)).not.toContain('final-report');
            const actual = priceCompact(compact, overrides, mode);
            expect(actual.costPresentation?.currency).toEqual(expected.costPresentation?.currency);
            expect(actual.costPresentation?.effectiveUsd).toEqual(expected.costPresentation?.effectiveUsd);
            const a = projectUsageAgentAccountingCalendar({ accounting: actual, period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0, costMode: mode }).projection;
            const b = projectUsageAgentAccountingCalendar({ accounting: expected, period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0, costMode: mode }).projection;
            expect(a.hours.map(hour => hour.totals.cost)).toEqual(b.hours.map(hour => hour.totals.cost));
            expect(a.periodSummary.totals.cost).toEqual(b.periodSummary.totals.cost);
        }
    });

    it('keeps cache-free tokens priced when missing cache rates leave neighboring model tokens unknown', () => {
        const cachedTokens = { ...tokens, cacheRead: 3, total: 4 };
        const rows = [contribution(1), contribution(2, { tokens: cachedTokens, tokenCategories: cachedTokens }),
            contribution(3, { modelId: 'unknown' }), contribution(4, { modelId: null, tokens: createEmptyUsageTokens(), tokenCategories: createEmptyUsageTokens() })];
        const rich = response(rows);
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 3, outputUsdPerMillion: 0 } };
        const actual = priceCompact(usageCost.projectUsageAnalyticsSummary(rich, query), overrides);
        const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        expect(actual.costFacts).toEqual(expected.costFacts);
        expect(actual.coverage).toEqual(expected.coverage);
        expect(usageCost.projectUsagePageCost(actual, 'auto').amountUsd).toEqual(usageCost.projectUsagePageCost(expected, 'auto').amountUsd);
    });

    it('preserves attributed Plans contribution counts while repricing compact account values', () => {
        const ref = { service: { pluginId: 'acme.accounts', localId: 'native' }, accountId: 'account' };
        const rows = [contribution(1, { providerAttribution: 'known', providerSource: 'native', connectedAccount: ref }),
            contribution(2, { providerAttribution: 'known', providerSource: 'native', connectedAccount: ref }),
            contribution(3, { providerAttribution: 'known', providerSource: 'native', connectedAccount: ref, modelId: 'unknown' }), contribution(4)];
        const rich = response(rows);
        const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 2_000_000, outputUsdPerMillion: 0 } };
        const compact = priceCompact(usageCost.projectUsageAnalyticsSummary(rich, query), overrides);
        const expected = usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides);
        const input = { query: normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 } }),
            quota: [ConnectedServiceQuotaGetResultV1Schema.parse({ source: { bindingKind: 'account', ref }, current: null, pace: [], targets: [],
                waitingWork: { status: 'unavailable', reason: 'read_failed' } })] };
        const actualPlan = projectUsagePlanInsights({ ...input, accounting: compact });
        const expectedPlan = projectUsagePlanInsights({ ...input, accounting: expected });
        expect(actualPlan.accounts[0]?.value).toEqual(expectedPlan.accounts[0]?.value);
        expect(actualPlan.accounts[0]?.value).toMatchObject({ status: 'available', pricedContributionCount: 2,
            unpricedContributionCount: 1, unknownAccountContributionCount: 1, amountUsd: 4 });
    });

    it('keeps rich and grouped Plans value exact across model groups', () => {
        const ref = { service: { pluginId: 'acme.accounts', localId: 'native' }, accountId: 'account' };
        const rows = [4, 8, 9].map((count, index) => contribution(index, { providerAttribution: 'known', providerSource: 'native', connectedAccount: ref,
            modelId: index === 1 ? 'other' : 'model', tokens: { ...tokens, input: count, total: count },
            tokenCategories: { ...tokens, input: count, total: count } }));
        const rich = response(rows);
        const rate = { kind: 'rates' as const, inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 };
        const overrides = { model: rate, other: rate };
        const compact = priceCompact(usageCost.projectUsageAnalyticsSummary(rich, query), overrides);
        const input = { query: normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 } }),
            quota: [ConnectedServiceQuotaGetResultV1Schema.parse({ source: { bindingKind: 'account', ref }, current: null, pace: [], targets: [],
                waitingWork: { status: 'unavailable', reason: 'read_failed' } })] };
        const actual = projectUsagePlanInsights({ ...input, accounting: compact }).accounts[0]!.value;
        const expected = projectUsagePlanInsights({ ...input, accounting: usageCost.repriceUsageAnalyticsResponse(rich, catalog, overrides) }).accounts[0]!.value;
        expect(actual).toEqual(expected);
        expect(actual).toMatchObject({ status: 'available', amountUsd: 0.0059499999999999996 });
    });
});
