import type { UsageAnalyticsContribution, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageAnalyticsSummary,
    UsageObservationCost, UsageAnalyticsBreakdownEntry, UsagePricingPopulation, UsageAnalyticsTimelineSource } from './usageAnalyticsContracts.js';
import { readUsagePageCostProjectionBasis, resolveUsageCostBasis, resolveUsageContributionDimensionKey, serializeUsageCostBasis, usagePageCostProjectionBasis, type UsageCostMode } from './usageCostFacts.js';
import { bundledUsageModelPriceCatalog, type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { projectUsageAgentAccountingCalendar, resolveUsageAccountingCalendarPeriod } from './usageAgentCalendar.js';
import { summarizeUsageExecutionSources } from './usageSourceSummary.js';
import { sameQualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { projectPublicProfileAccounting, resolvePublicProfileArtifactPeriod } from '../account/publicProfileAccounting.js';
import { buildUsagePricingPopulation, priceUsagePricingPopulation, resolveUsagePricingPopulationStates, type UsagePricingPopulationStates } from './usagePricingPopulation.js';
import { compareUsageRankedLeaders, decorateUsageBreakdownList, groupUsageLeaderSources, groupUsageTimelineContributions, hasUsageEventCounts, selectUsageLeaderTokenFrontier, usageTimelinePartitionKey, type UsageAnalyticsPricingPartitions, type UsagePricingRank, type UsageLeaderDimension } from './usageLeaderProjection.js';
import { addUsageMoney, readUsageMoney, usageMoneyFromNumber, usageMoneyToNumber } from './usageMoney.js';
import { buildUsageSummaryCalendarPricing, repriceUsageSummaryCalendarPricing } from './usageSummaryCalendarPricing.js';
import { hasCompleteUsageCostEvidence, repriceUsageAnalyticsCoverage } from './usageAnalyticsDemandProjection.js';

type RankedPricing = NonNullable<UsageAnalyticsSummary['rankedPricing']>;
type RankedPricingDemand = { key: string; entries: readonly UsageAnalyticsBreakdownEntry[] };
function withoutCost<T extends { cost?: UsageObservationCost }>(value: T): Omit<T, 'cost'> {
    const { cost: _cost, ...metadata } = value;
    return metadata;
}
function buildRankedPricing(rows: readonly UsageAnalyticsContribution[], dimension: UsageLeaderDimension,
    demands: readonly RankedPricingDemand[], sources: boolean,
    sharedStates?: UsagePricingPopulationStates, wholePopulation?: UsagePricingPopulation, admitted?: UsagePricingRank): RankedPricing {
    // A caller may expand a rich response's output demand before contracting it.
    // A narrower admitted frontier cannot supply those additional candidates.
    if (admitted && demands.some(demand => demand.entries.length > admitted!.candidates.length)) admitted = undefined;
    const populationFor = (selected: readonly UsageAnalyticsContribution[]) => buildUsagePricingPopulation(selected, sharedStates);
    const countedRows = hasUsageEventCounts(rows) ? rows : undefined;
    const groups = new Map<string, UsageAnalyticsContribution[]>();
    if (!admitted) for (const row of rows) {
        const key = !countedRows && dimension === 'model' ? row.modelId ?? 'unknown'
            : resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        const group = groups.get(key);
        if (group) group.push(row); else groups.set(key, [row]);
    }
    const admittedCandidates = admitted && new Map(admitted.candidates.map(candidate => [candidate.value.key, candidate]));
    const selections = demands.map(({ key, entries: previous }) => {
        const witnessedAll = (admitted?.totalEntries ?? groups.size) === previous.length
            && previous.every(entry => admittedCandidates?.has(entry.key) ?? groups.has(entry.key));
        const labels = new Map(previous.map(entry => [entry.key, entry.label]));
        const admittedValues = admitted?.candidates.map(candidate => {
            const { cost: _cost, sources: _sources, ...value } = candidate.value;
            return { ...value, label: labels.get(value.key) ?? value.key };
        }).sort((left, right) => right.tokens.total - left.tokens.total);
        const admittedFrontier = admittedValues?.[Math.min(previous.length, admittedValues.length) - 1]?.tokens.total ?? Infinity;
        const candidates = countedRows && !witnessedAll
            ? decorateUsageBreakdownList(admittedValues?.filter(entry => entry.tokens.total >= admittedFrontier)
                ?? selectUsageLeaderTokenFrontier(countedRows, dimension, previous.length, labels).map(group => group.value),
                countedRows, dimension, previous)
            : previous;
        const frontier = candidates[Math.min(previous.length, candidates.length) - 1]?.tokens.total ?? Infinity;
        // Compact operands have no selected price yet; private repricing owns tie ordering.
        return { key, entries: candidates.filter(entry => entry.tokens.total >= frontier)
            .sort((left, right) => right.tokens.total - left.tokens.total || left.key.localeCompare(right.key)) };
    });
    // One dimension admits each candidate's money once for all consuming outputs.
    // Labels, context and requested frontiers still belong to each output.
    const populations = new Map([...new Set(selections.flatMap(selection => selection.entries.map(entry => entry.key)))].map(key => {
        const prepared = admittedCandidates?.get(key);
        if (prepared) return [key, { population: wholePopulation
                && prepared.population.groups.reduce((count, group) => count + group.contributionCount, 0) === rows.length
                ? wholePopulation : prepared.population,
            ...(sources ? { sources: prepared.sources ?? [] } : {}) }] as const;
        const selected = groups.get(key) ?? [];
        const sourceGroups = sources ? groupUsageLeaderSources(hasUsageEventCounts(selected)
            ? selected : selected.map(row => ({ ...row, eventCount: row.eventCount ?? 1 }))) : [];
        // Source populations are admitted in the sibling `sources` field;
        // timeline decorations are not Breakdown metadata on the compact wire.
        return [key, {
            population: selected.length === rows.length && wholePopulation ? wholePopulation : populationFor(selected),
            ...(sources ? { sources: sourceGroups.map(group => ({
                value: group.value,
                population: populationFor(group.rows) })) } : {}) }] as const;
    }));
    return Object.fromEntries(selections.map(selection => [selection.key, selection.entries.map(entry => {
        const { sources: _sources, ...rankedValue }: Omit<UsageAnalyticsBreakdownEntry, 'cost'> & { cost?: UsageObservationCost; sources?: UsageAnalyticsTimelineSource[] } = entry;
        return { value: withoutCost(rankedValue), ...populations.get(entry.key)! };
    })]));
}

function* buildSummaryPricing(value: UsageAnalyticsQueryResponse, rows: readonly UsageAnalyticsContribution[], admitted?: UsageAnalyticsPricingPartitions):
    Generator<void, { pricing: Record<string, UsagePricingPopulation>; rankedPricing: RankedPricing; countedPricing: boolean }, void> {
    const shared = admitted ? undefined : resolveUsagePricingPopulationStates(rows);
    yield;
    const complete = hasCompleteUsageCostEvidence(value);
    const pricing: Record<string, UsagePricingPopulation> = { totals: admitted
        ? complete ? admitted.totals : { groups: admitted.totals.groups.map(group => ({ ...group, complete: false })) }
        : buildUsagePricingPopulation(rows, shared, complete) };
    yield;
    const rankedPricing: RankedPricing = {};
    const rowsForBucket = groupUsageTimelineContributions(rows,
        [...value.series ?? [], ...value.modelTimeline ?? [], ...value.engineTimeline ?? []]);
    yield;
    for (const [index, bucket] of (value.series ?? []).entries()) {
        const selected = rowsForBucket(bucket);
        pricing[`series:${index}`] = selected.length === rows.length ? pricing.totals!
            : admitted?.series.get(usageTimelinePartitionKey('series', bucket)) ?? buildUsagePricingPopulation(selected, shared);
        yield;
    }
    const demands = new Map<UsageLeaderDimension, RankedPricingDemand[]>();
    const admit = (dimension: UsageLeaderDimension, demand: RankedPricingDemand) => {
        // Preserve wire insertion order before dimensions share their operands.
        rankedPricing[demand.key] = [];
        const outputs = demands.get(dimension);
        if (outputs) outputs.push(demand); else demands.set(dimension, [demand]);
    };
    for (const [dimension, entries] of Object.entries(value.breakdowns ?? {})) if (entries) {
        admit(dimension as UsageLeaderDimension, { key: `breakdowns:${dimension}`, entries });
    }
    const dimensions = { agents: 'agent', models: 'model', sessions: 'session', projects: 'project', workspaces: 'workspace', engines: 'engine' } as const;
    for (const [dimension, entries] of Object.entries(value.leaders ?? {})) if (entries) {
        admit(dimensions[dimension as keyof typeof dimensions], { key: `leaders:${dimension}`,
            entries: entries.filter((entry): entry is UsageAnalyticsBreakdownEntry => entry.tokens !== undefined && entry.cost !== undefined) });
    }
    for (const [dimension, outputs] of demands) {
        Object.assign(rankedPricing, buildRankedPricing(rows, dimension, outputs, false, undefined, pricing.totals, admitted?.ranked.get(dimension)));
        yield;
    }
    for (const family of ['modelTimeline', 'engineTimeline'] as const) for (const [index, bucket] of (value[family] ?? []).entries()) {
        Object.assign(rankedPricing, buildRankedPricing(rowsForBucket(bucket),
            family === 'modelTimeline' ? 'model' : 'engine', [{ key: `${family}:${index}`,
                entries: bucket.leaders.filter((entry): entry is UsageAnalyticsBreakdownEntry => entry.tokens !== undefined && entry.cost !== undefined) }], true, shared,
                undefined, admitted?.timelines.get(usageTimelinePartitionKey(family === 'modelTimeline' ? 'model' : 'engine', bucket))));
        yield;
    }
    return { pricing, rankedPricing, countedPricing: rows.every(row => row.eventCount !== undefined) };
}

function withoutReportIdentities(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
    const { reportedTotalId: _id, reportedTotalContributionIds: _ids, ...facts } = serializeUsageCostBasis(cost, mode);
    return facts;
}

/** Contract an admitted rich query into facts consumed by the presented slices. */
export function projectUsageAnalyticsSummary(value: UsageAnalyticsQueryResponse, query: UsageAnalyticsQueryRequest): UsageAnalyticsQueryResponse {
    const projection = projectUsageAnalyticsSummarySteps(value, query);
    let next = projection.next();
    while (!next.done) next = projection.next();
    return next.value;
}

/** Hosts may service I/O between existing calendar and grouped-pricing units without duplicating accounting. */
export function* projectUsageAnalyticsSummarySteps(value: UsageAnalyticsQueryResponse, query: UsageAnalyticsQueryRequest,
    admitted: UsageAnalyticsPricingPartitions | undefined = readUsagePageCostProjectionBasis(value)?.partitions):
    Generator<void, UsageAnalyticsQueryResponse, void> {
    if (!value.contributions) return value;
    const mode = query.costMode ?? 'auto';
    // Host projections may keep the admitted rows for private evidence after
    // preparing their grouped summary. Contract those facts without rebuilding
    // the population, while still serializing each selected money basis.
    if (value.summary) return projectSummaryFacts(value, value.summary, mode);
    const rows = value.contributions;
    const endMs = query.dateRange?.endMs ?? value.coverage?.range.endMs;
    const accountRows: Array<{ ref: NonNullable<UsageAnalyticsContribution['connectedAccount']>; rows: UsageAnalyticsContribution[] }> = [];
    let observationStart: number | undefined;
    let observationEnd: number | undefined;
    for (const row of rows) {
        observationStart = observationStart === undefined ? row.observedAtMs : Math.min(observationStart, row.observedAtMs);
        observationEnd = observationEnd === undefined ? row.observedAtMs + 1 : Math.max(observationEnd, row.observedAtMs + 1);
        if (row.providerAttribution === 'known' && row.connectedAccount) {
            let group = accountRows.find(group => sameQualifiedConnectedAccountRef(group.ref, row.connectedAccount!));
            if (!group) { group = { ref: row.connectedAccount, rows: [] }; accountRows.push(group); }
            group.rows.push(row);
        }
    }
    yield;
    const period = endMs === undefined ? undefined : resolveUsageAccountingCalendarPeriod({ accounting: value,
        period: { startMs: query.dateRange ? query.dateRange.startMs : value.coverage?.range.startMs, endMs },
        timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, observationStartMs: observationStart });
    const calendar = (query.includeActivity || query.includeModelTimeline) && period
        ? projectUsageAgentAccountingCalendar({ accounting: value, period,
            timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, costMode: mode }).projection : undefined;
    if (calendar) yield;
    const execution = summarizeUsageExecutionSources(rows);
    yield;
    const groupedPricing: { pricing?: Record<string, UsagePricingPopulation>; rankedPricing?: RankedPricing; countedPricing?: boolean } =
        query.population === 'public_eligible_personal' ? {} : yield* buildSummaryPricing(value, rows, hasUsageEventCounts(rows) ? admitted : undefined);
    let accountingCalendar: UsageAnalyticsSummary['accountingCalendar'];
    if (calendar) {
        if (query.population === 'public_eligible_personal') accountingCalendar = { value: calendar };
        else {
            const grouped = buildUsageSummaryCalendarPricing(calendar, rows, query, groupedPricing.pricing?.totals);
            accountingCalendar = { value: grouped.value, pricing: grouped.populations };
        }
        yield;
    }
    const publicProfilePeriod = query.population === 'public_eligible_personal'
        ? resolvePublicProfileArtifactPeriod({ startMs: query.dateRange?.startMs ?? value.coverage?.range.startMs, endMs },
            query.timeZoneOffsetMinutes) : undefined;
    const publicProfileAccounting = publicProfilePeriod && period
        ? projectPublicProfileAccounting(value, publicProfilePeriod, calendar ?? projectUsageAgentAccountingCalendar({ accounting: value,
            period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, costMode: mode }).projection) : undefined;
    if (publicProfileAccounting) yield;
    const accounts: UsageAnalyticsSummary['accounts'] = {
        unknownContributionCount: rows.filter(row => row.providerAttribution !== 'known'
            || !row.connectedAccount && row.providerSource !== 'provider' && !(row.providerSource === 'native' && row.connectedAccount === null))
            .length,
        values: [],
    };
    for (const [index, group] of accountRows.entries()) {
        const population = groupedPricing.pricing ? group.rows.length === rows.length
            ? groupedPricing.pricing.totals! : buildUsagePricingPopulation(group.rows) : undefined;
        if (groupedPricing.pricing && population) groupedPricing.pricing[`account:${index}`] = population;
        const priced = group.rows.flatMap(row => {
            const basis = resolveUsageCostBasis(row.cost, 'api_equivalent');
            return basis?.kind === 'api_equivalent' ? [basis] : [];
        });
        accounts.values.push({ ref: group.ref, contributionCount: group.rows.length, pricedContributionCount: priced.length,
            apiEquivalentUsd: usageMoneyToNumber(priced.reduce((sum, basis) => addUsageMoney(sum, readUsageMoney(basis, 'amountUsd', basis.amountUsd)), usageMoneyFromNumber(0))),
            pricingSources: [...new Set(priced.map(basis => basis.source))].sort() });
        yield;
    }
    const summary: UsageAnalyticsSummary = { v: 1, costMode: mode,
        ...groupedPricing,
        ...(observationStart === undefined || observationEnd === undefined ? {}
            : { observationRange: { startMs: observationStart, endMs: observationEnd } }),
        catalogRevision: (value.priceCatalog ?? bundledUsageModelPriceCatalog).provenance.revision,
        ...(accountingCalendar ? { accountingCalendar } : {}),
        ...(publicProfileAccounting ? { publicProfileAccounting } : {}),
        accounts,
        execution: { coverage: execution.coverage, totalTokens: execution.totalTokens,
            groups: execution.groups.map(({ contributions: _rows, ...group }) => group) } };
    return projectSummaryFacts(value, summary, mode);
}

function projectSummaryFacts(value: UsageAnalyticsQueryResponse, summary: UsageAnalyticsSummary,
    mode: UsageCostMode): UsageAnalyticsQueryResponse {
    const completed = readUsagePageCostProjectionBasis(value);
    const { contributions: _rows, ...response } = value;
    const sanitizeLeader = <T extends { cost?: UsageObservationCost; sources?: NonNullable<UsageAnalyticsQueryResponse['modelTimeline']>[number]['leaders'][number]['sources'] }>(entry: T): T => ({ ...entry,
        ...(entry.cost ? { cost: withoutReportIdentities(entry.cost, mode) } : {}),
        ...(entry.sources ? { sources: entry.sources.map(source => ({ ...source, cost: withoutReportIdentities(source.cost, mode) })) } : {}) });
    const projected: UsageAnalyticsQueryResponse = { ...response, summary, totals: { ...value.totals, cost: withoutReportIdentities(value.totals.cost, mode) },
        series: value.series?.map(bucket => ({ ...bucket, cost: withoutReportIdentities(bucket.cost, mode) })),
        breakdowns: value.breakdowns && Object.fromEntries(Object.entries(value.breakdowns).map(([dimension, entries]) =>
            [dimension, entries?.map(sanitizeLeader)])),
        leaders: value.leaders && Object.fromEntries(Object.entries(value.leaders).map(([dimension, entries]) => [dimension, entries?.map(sanitizeLeader)])),
        modelTimeline: value.modelTimeline?.map(bucket => ({ ...bucket, leaders: bucket.leaders.map(sanitizeLeader) })),
        engineTimeline: value.engineTimeline?.map(bucket => ({ ...bucket, leaders: bucket.leaders.map(sanitizeLeader) })) };
    if (completed) Object.defineProperty(projected.totals.cost, usagePageCostProjectionBasis,
        { value: { response: projected, mode: completed.mode, catalog: completed.catalog, overrides: completed.overrides } });
    return projected;
}

/** Reprice the producer's tariff-linear sufficient statistics, without event detail. */
export function repriceUsageAnalyticsSummary(value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog,
    overrides: UsageModelPriceOverridesV1, mode: UsageCostMode): UsageAnalyticsQueryResponse {
    const summary = value.summary!;
    const originalPrices = Object.keys(overrides).length === 0
        && catalog.provenance.revision === summary.catalogRevision && mode === summary.costMode;
    if (!summary.pricing) {
        if (!originalPrices) throw new Error('Usage summary is missing grouped pricing operands');
        return value.priceCatalog === catalog ? value : { ...value, priceCatalog: catalog };
    }
    const price = (population: UsagePricingPopulation) => priceUsagePricingPopulation(population, catalog, overrides, mode);
    const total = price(summary.pricing.totals!);
    const ranked = (key: string, limit: number) => {
        const entries = summary.rankedPricing?.[key]?.map(entry => ({ ...entry.value, cost: price(entry.population).cost,
            ...(entry.sources ? { sources: entry.sources.map(source => ({ ...source.value, cost: price(source.population).cost })) } : {}) }));
        return (summary.countedPricing ? entries?.sort((left, right) => compareUsageRankedLeaders(left, right, mode)) : entries)?.slice(0, limit);
    };
    const breakdowns = value.breakdowns && Object.fromEntries(Object.entries(value.breakdowns).map(([dimension, entries]) =>
        [dimension, entries && (ranked(`breakdowns:${dimension}`, entries.length) ?? entries)]));
    const leaders = value.leaders && Object.fromEntries(Object.entries(value.leaders).map(([dimension, entries]) =>
        [dimension, entries && (ranked(`leaders:${dimension}`, entries.length) ?? entries)]));
    const unknown = total.facts.some(fact => fact.kind === 'unpriced');
    const coverage = repriceUsageAnalyticsCoverage(value.coverage, value.coverage, unknown);
    let insights = value.insights;
    if (insights) {
        const { cacheSavingsUsd: _oldSavings, ...otherInsights } = insights;
        insights = { ...otherInsights, ...(total.cacheSavingsComplete ? { cacheSavingsUsd: total.cacheSavingsUsd } : {}) };
    }
    const projected: UsageAnalyticsQueryResponse = { ...value, priceCatalog: catalog, totals: { ...value.totals, cost: total.cost },
        series: value.series?.map((bucket, index) => ({ ...bucket, cost: price(summary.pricing![`series:${index}`]!).cost })),
        breakdowns, leaders,
        modelTimeline: value.modelTimeline?.map((bucket, index) => ({ ...bucket, leaders: ranked(`modelTimeline:${index}`, bucket.leaders.length) ?? bucket.leaders })),
        engineTimeline: value.engineTimeline?.map((bucket, index) => ({ ...bucket, leaders: ranked(`engineTimeline:${index}`, bucket.leaders.length) ?? bucket.leaders })),
        costFacts: total.facts, coverage,
        costPresentation: total.selected ? { mode, effectiveUsd: total.selected.amountUsd, currency: total.selected.currency, source: total.selected.source } : undefined,
        insights,
        summary: { ...summary, costMode: mode,
            ...(summary.accountingCalendar?.pricing ? { accountingCalendar: { ...summary.accountingCalendar,
                value: repriceUsageSummaryCalendarPricing(summary.accountingCalendar.value, summary.accountingCalendar.pricing, catalog, overrides, mode) } } : {}),
            accounts: { ...summary.accounts, values: summary.accounts.values.map((account, index) => {
            const priced = price(summary.pricing![`account:${index}`]!);
            return { ...account, pricedContributionCount: priced.pricedContributionCount, apiEquivalentUsd: priced.apiEquivalentUsd, pricingSources: priced.pricingSources };
        }) } } };
    Object.defineProperty(projected.totals.cost, usagePageCostProjectionBasis, { value: { response: projected, mode, catalog, overrides } });
    return projected;
}
