export { getUsageAnalyticsRankedDimensions, projectUsageAnalyticsCoverage, projectUsageAnalyticsResponseDemand } from './usageAnalyticsDemandProjection.js';
import type { UsageAnalyticsBreakdownDimension, UsageAnalyticsBreakdownEntry, UsageAnalyticsContribution, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageAnalyticsTimelineSource, UsageObservationCost, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { aggregateUsageContributionCosts, aggregateUsageCostPartitionsSteps, resolveUsageContributionCosts, addUsageTokens, createEmptyUsageTokens, withEffectiveUsageCost } from './usageAggregation.js';
import { resolveEffectiveUsageCostUsd, resolveUsageContributionDimensionKey, type UsageCostMode } from './usageCostFacts.js';

export type UsageLeaderDimension = Parameters<typeof resolveUsageContributionDimensionKey>[1];
export type UsageLeaderContribution = Pick<UsageAnalyticsContribution,
    'sessionId' | 'agentId' | 'backendMode' | 'modelId' | 'projectKey' | 'workspaceId' | 'source' | 'tokens' | 'cost'>
    & Pick<UsageAnalyticsContribution, 'sourceContext'> & { id?: string; machineId?: string | null; eventCount: number };
type UsageLeader = NonNullable<NonNullable<UsageAnalyticsQueryResponse['leaders']>['models']>[number];
type UsageRankedLeader = UsageLeader & { tokens: UsageLeaderContribution['tokens']; cost: UsageLeaderContribution['cost'] };

export interface UsagePricedRows {
    cost: UsageObservationCost;
    population: UsagePricingPopulation;
}
export interface UsagePricingRank {
    totalEntries: number;
    candidates: Array<{ value: UsageRankedLeader; population: UsagePricingPopulation;
        sources?: Array<{ value: Omit<UsageAnalyticsTimelineSource, 'cost'>; population: UsagePricingPopulation }> }>;
}
/** Operands produced by this ranking, consumed directly by compact delivery. */
export interface UsageAnalyticsPricingPartitions {
    totals: UsagePricingPopulation;
    series: Map<string, UsagePricingPopulation>;
    ranked: Map<UsageLeaderDimension, UsagePricingRank>;
    timelines: Map<string, UsagePricingRank>;
}
export const usageTimelinePartitionKey = (dimension: string, range: UsageTimelineRange) =>
    `${dimension}:${range.bucketStartMs}:${range.bucketEndMs}`;

/** Keep the worst retained entry at the root; only the returned N need sorting. */
function selectTop<T>(entries: Iterable<T>, limit: number, compare: (left: T, right: T) => number): T[] {
    if (limit <= 0) return [];
    const heap: T[] = [];
    for (const entry of entries) {
        if (heap.length < limit) {
            let index = heap.length;
            heap.push(entry);
            while (index > 0) {
                const parent = Math.floor((index - 1) / 2);
                if (compare(heap[parent]!, entry) >= 0) break;
                heap[index] = heap[parent]!;
                index = parent;
            }
            heap[index] = entry;
        } else if (compare(entry, heap[0]!) < 0) {
            let index = 0;
            while (index * 2 + 1 < heap.length) {
                let child = index * 2 + 1;
                if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) > 0) child++;
                if (compare(entry, heap[child]!) >= 0) break;
                heap[index] = heap[child]!;
                index = child;
            }
            heap[index] = entry;
        }
    }
    return heap.sort(compare);
}

/** Price can reorder a token tie, but cannot admit a lower token population. */
export function selectUsageLeaderTokenFrontier<T extends UsageLeaderContribution>(rows: readonly T[],
    dimension: UsageLeaderDimension, topLimit: number, labels: ReadonlyMap<string, string | undefined> = new Map()) {
    return prepareUsageLeaderTokenFrontier(rows, dimension, topLimit, labels).candidates;
}

function prepareUsageLeaderTokenFrontier<T extends UsageLeaderContribution>(rows: readonly T[],
    dimension: UsageLeaderDimension, topLimit: number, labels: ReadonlyMap<string, string | undefined>) {
    type Group = { value: Omit<UsageRankedLeader, 'cost'>; rows: T[] };
    const groups = new Map<string, Group>();
    for (const row of rows) {
        const key = resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        let group = groups.get(key);
        if (!group) {
            group = { value: { key, label: labels.get(key) ?? key, eventCount: 0, tokens: createEmptyUsageTokens() }, rows: [] };
            groups.set(key, group);
        }
        group.rows.push(row);
        group.value.eventCount += row.eventCount;
        group.value.tokens = addUsageTokens(group.value.tokens, row.tokens);
    }
    const compare = (left: Group, right: Group) => right.value.tokens.total - left.value.tokens.total;
    const top = selectTop(groups.values(), topLimit, compare);
    const frontier = top.at(-1)?.value.tokens.total ?? Infinity;
    // Every frontier tie remains available for later private-price ordering.
    return { totalEntries: groups.size, candidates: [...groups.values()].filter(group => group.value.tokens.total >= frontier).sort(compare) };
}

/** Token counts fix the frontier; prices, witnessed counts and key resolve ties. */
export function compareUsageRankedLeaders(left: UsageRankedLeader, right: UsageRankedLeader, mode: UsageCostMode): number {
    return right.tokens.total - left.tokens.total
        || resolveEffectiveUsageCostUsd(right.cost, mode) - resolveEffectiveUsageCostUsd(left.cost, mode)
        || right.eventCount - left.eventCount || left.key.localeCompare(right.key);
}

/** Rich money is already selected: retain only the requested output population. */
export function selectUsageRankedLeaders(entries: readonly UsageRankedLeader[], topLimit: number, mode: UsageCostMode): UsageRankedLeader[] {
    return selectTop(entries, topLimit, (left, right) => compareUsageRankedLeaders(left, right, mode));
}

/** Source membership/counts are shared by rich money and compact operand projections. */
export function groupUsageLeaderSources<T extends Pick<UsageLeaderContribution, 'source' | 'sourceContext' | 'tokens' | 'eventCount'>>(rows: readonly T[]) {
    const groups = new Map<string, { key: string; value: Omit<UsageAnalyticsTimelineSource, 'cost'>; rows: T[] }>();
    for (const row of rows) {
        const context = row.sourceContext ?? { path: 'unknown' as const, execution: 'unknown' as const };
        const source = row.source ?? 'unknown';
        const key = JSON.stringify([source, context.path, context.execution]);
        let group = groups.get(key);
        if (!group) {
            group = { key, value: { ...context, source, eventCount: 0, tokens: createEmptyUsageTokens() }, rows: [] };
            groups.set(key, group);
        }
        group.rows.push(row);
        group.value.eventCount += row.eventCount;
        group.value.tokens = addUsageTokens(group.value.tokens, row.tokens);
    }
    return [...groups.values()];
}

/** Server and private client reprojection rank the same complete candidate population. */
export function buildUsageLeaderList<T extends UsageLeaderContribution>(rows: readonly T[], dimension: UsageLeaderDimension, topLimit: number,
    mode: UsageCostMode, labels: ReadonlyMap<string, string | undefined> = new Map(), includeSources = false,
    pricing?: { price: (rows: readonly T[]) => UsagePricedRows; admit: (rank: UsagePricingRank) => void }): UsageRankedLeader[] | undefined {
    const steps = buildUsageLeaderListSteps(rows, dimension, topLimit, mode, labels, includeSources, pricing && {
        price: function* (selected) { return pricing.price(selected); }, admit: pricing.admit,
    });
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

export function* buildUsageLeaderListSteps<T extends UsageLeaderContribution>(rows: readonly T[], dimension: UsageLeaderDimension, topLimit: number,
    mode: UsageCostMode, labels: ReadonlyMap<string, string | undefined> = new Map(), includeSources = false,
    pricing?: { price: (rows: readonly T[]) => Generator<void, UsagePricedRows, void>; admit: (rank: UsagePricingRank) => void }): Generator<void, UsageRankedLeader[] | undefined, void> {
    const { candidates, totalEntries } = prepareUsageLeaderTokenFrontier(rows, dimension, topLimit, labels);
    const sourceRows = includeSources ? new Map(candidates.map(group => [group.value.key, group.rows])) : undefined;
    if (!candidates.length) {
        pricing?.admit({ totalEntries, candidates: [] });
        return undefined;
    }
    // Tokens decide admission before money breaks ties. Do not fold monetary
    // operands for groups that cannot enter the requested ranking. Compact
    // repricing retains the whole frontier because private prices can reorder it.
    const admitted: UsagePricingRank['candidates'] | undefined = pricing ? [] : undefined;
    if (pricing && admitted) for (const group of candidates) {
        const part = yield* pricing.price(group.rows);
        const sources: Array<{ key: string; value: Omit<UsageAnalyticsTimelineSource, 'cost'>;
            cost: UsageObservationCost; population: UsagePricingPopulation }> | undefined = includeSources ? [] : undefined;
        if (sources) for (const source of groupUsageLeaderSources(group.rows)) {
            const { cost, population } = yield* pricing.price(source.rows);
            sources.push({ key: source.key, value: source.value, cost, population });
        }
        admitted.push({ value: { ...group.value, cost: withEffectiveUsageCost(part.cost, mode),
            ...(sources ? { sources: [...sources].sort((left, right) => left.key.localeCompare(right.key))
                .map(source => ({ ...source.value, cost: withEffectiveUsageCost(source.cost, mode) })) } : {}) },
            population: part.population, ...(sources ? { sources: sources.map(({ cost: _cost, key: _key, ...source }) => source) } : {}) });
    }
    if (admitted) {
        pricing!.admit({ totalEntries, candidates: admitted });
        return selectUsageRankedLeaders(admitted.map(candidate => candidate.value), topLimit, mode);
    }
    const amounts: UsageRankedLeader[] = [];
    for (const group of candidates) amounts.push({ ...group.value,
        cost: yield* aggregateUsageCostPartitionsSteps(resolveUsageContributionCosts(group.rows, mode), mode) });
    const ranked = selectUsageRankedLeaders(amounts, topLimit, mode);
    const answer: UsageRankedLeader[] = [];
    for (const leader of ranked) {
        const sources: UsageAnalyticsTimelineSource[] | undefined = includeSources ? [] : undefined;
        if (sources) for (const part of groupUsageLeaderSources(sourceRows!.get(leader.key)!)
            .sort((left, right) => left.key.localeCompare(right.key))) {
            const cost = yield* aggregateUsageCostPartitionsSteps(resolveUsageContributionCosts(part.rows, mode), mode);
            sources.push({ ...part.value, cost: withEffectiveUsageCost(cost, mode) });
        }
        answer.push({ ...leader, cost: withEffectiveUsageCost(leader.cost, mode), ...(sources ? { sources } : {}) });
    }
    return answer;
}

/** Breakdown decoration retains the last witnessed context; ranking shares the leader owner. */
export function buildUsageBreakdownList(rows: readonly (UsageLeaderContribution & Pick<UsageAnalyticsContribution, 'context'>)[],
    dimension: UsageAnalyticsBreakdownDimension, topLimit: number, mode: UsageCostMode,
    previous: readonly UsageAnalyticsBreakdownEntry[] = []): UsageAnalyticsBreakdownEntry[] {
    return decorateUsageBreakdownList(buildUsageLeaderList(rows, dimension, topLimit, mode,
        new Map(previous.map(entry => [entry.key, entry.label])), false) ?? [], rows, dimension, previous);
}

/** Monetary and compact operand projections share the same witnessed context decoration. */
export function decorateUsageBreakdownList<T extends Omit<UsageAnalyticsBreakdownEntry, 'cost'>>(entries: readonly T[],
    rows: readonly (UsageLeaderContribution & Pick<UsageAnalyticsContribution, 'context'>)[],
    dimension: UsageLeaderDimension, previous: readonly UsageAnalyticsBreakdownEntry[] = []): T[] {
    const decorations = new Map<string, Pick<UsageAnalyticsBreakdownEntry, 'context' | 'latestContextUsedTokens' | 'latestContextWindowTokens'>>();
    for (const entry of previous) decorations.set(entry.key, { context: entry.context,
        latestContextUsedTokens: entry.latestContextUsedTokens, latestContextWindowTokens: entry.latestContextWindowTokens });
    for (const row of rows) {
        const key = resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        const decoration = decorations.get(key) ?? {};
        if (row.context?.usedTokens != null || row.context?.windowTokens != null) decoration.context = row.context;
        if (dimension === 'session') {
            if (row.context?.usedTokens != null) decoration.latestContextUsedTokens = row.context.usedTokens;
            if (row.context?.windowTokens != null) decoration.latestContextWindowTokens = row.context.windowTokens;
        }
        decorations.set(key, decoration);
    }
    return entries.map(leader => ({ ...leader, ...decorations.get(leader.key) }));
}

function groupLegacyContributions(rows: readonly UsageAnalyticsContribution[], dimension: UsageLeaderDimension) {
    const grouped = new Map<string, UsageAnalyticsContribution[]>();
    for (const row of rows) {
        // Pre-count responses witnessed raw model ids, including snapshot ids.
        const key = dimension === 'model' ? row.modelId ?? 'unknown'
            : resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        const group = grouped.get(key);
        if (group) group.push(row); else grouped.set(key, [row]);
    }
    return grouped;
}

export function hasUsageEventCounts(rows: readonly UsageAnalyticsContribution[]): rows is readonly (UsageAnalyticsContribution & { eventCount: number })[] {
    return rows.every(row => row.eventCount !== undefined);
}

type UsageTimelineRange = Readonly<{ bucketStartMs: number; bucketEndMs: number }>;

/** Partition the admitted rows once, shared by all chart families in this projection. */
export function groupUsageTimelineContributions(rows: readonly UsageAnalyticsContribution[], buckets: readonly UsageTimelineRange[]) {
    const keyOf = (range: UsageTimelineRange) => `${range.bucketStartMs}:${range.bucketEndMs}`;
    const groups = new Map<string, { range: UsageTimelineRange; rows: UsageAnalyticsContribution[] }>();
    for (const range of buckets) {
        const key = keyOf(range);
        if (!groups.has(key)) groups.set(key, { range, rows: [] });
    }
    const ordered = [...groups.values()].sort((left, right) => left.range.bucketStartMs - right.range.bucketStartMs);
    let latestEnd = -Infinity;
    const prefixEnds = ordered.map(({ range }) => latestEnd = Math.max(latestEnd, range.bucketEndMs));
    if (ordered.length) for (const row of rows) {
        const at = row.observedAtMs;
        let first = 0;
        let end = ordered.length;
        while (first < end) {
            const middle = Math.floor((first + end) / 2);
            if (ordered[middle]!.range.bucketStartMs <= at) first = middle + 1;
            else end = middle;
        }
        // Prefix ends preserve overlapping/sparse ranges too. Iterate the input
        // rows in their original order: floating monetary sums are order-sensitive.
        for (let index = first - 1; index >= 0 && prefixEnds[index]! > at; index--) {
            const group = ordered[index]!;
            if (at < group.range.bucketEndMs) group.rows.push(row);
        }
    }
    return (range: UsageTimelineRange): readonly UsageAnalyticsContribution[] => groups.get(keyOf(range))!.rows;
}

/** Older contributions lack witnessed counts; keep their candidates and mark ranking incomplete. */
export function reprojectUsageLeaders(value: UsageAnalyticsQueryResponse, contributions: readonly UsageAnalyticsContribution[], mode: UsageCostMode,
    projectCost: (raw: UsageLeaderContribution['cost'], rows: readonly UsageAnalyticsContribution[], range?: UsageTimelineRange) => UsageLeaderContribution['cost'],
    rankingDemand?: Pick<UsageAnalyticsQueryRequest, 'breakdowns' | 'includeLeaders' | 'topLimit'>,
    pricing?: { partitions: UsageAnalyticsPricingPartitions;
        price: (rows: readonly UsageAnalyticsContribution[], queryScoped: boolean) => UsagePricedRows }):
    Pick<UsageAnalyticsQueryResponse, 'series' | 'breakdowns' | 'leaders' | 'modelTimeline' | 'engineTimeline' | 'coverage'> {
    const steps = reprojectUsageLeadersSteps(value, contributions, mode,
        function* (raw, rows, range) { return projectCost(raw, rows, range); }, rankingDemand, pricing && {
            partitions: pricing.partitions, price: function* (rows, scoped) { return pricing.price(rows, scoped); },
        });
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

export function* reprojectUsageLeadersSteps(value: UsageAnalyticsQueryResponse, contributions: readonly UsageAnalyticsContribution[], mode: UsageCostMode,
    projectCost: (raw: UsageLeaderContribution['cost'], rows: readonly UsageAnalyticsContribution[], range?: UsageTimelineRange) => Generator<void, UsageLeaderContribution['cost'], void>,
    rankingDemand?: Pick<UsageAnalyticsQueryRequest, 'breakdowns' | 'includeLeaders' | 'topLimit'>,
    pricing?: { partitions: UsageAnalyticsPricingPartitions;
        price: (rows: readonly UsageAnalyticsContribution[], queryScoped: boolean) => Generator<void, UsagePricedRows, void> }):
    Generator<void, Pick<UsageAnalyticsQueryResponse, 'series' | 'breakdowns' | 'leaders' | 'modelTimeline' | 'engineTimeline' | 'coverage'>, void> {
    let incomplete = false;
    const rank = function* (rows: readonly (UsageAnalyticsContribution & { eventCount: number })[], dimension: UsageLeaderDimension,
        limit: number, labels: ReadonlyMap<string, string | undefined> = new Map(), includeSources = false, range?: UsageTimelineRange) {
        return yield* buildUsageLeaderListSteps(rows, dimension, limit, mode, labels, includeSources, pricing && {
            price: selected => pricing.price(selected, range !== undefined),
            admit: admitted => { if (range) pricing.partitions.timelines.set(usageTimelinePartitionKey(dimension, range), admitted);
                else pricing.partitions.ranked.set(dimension, admitted); },
        });
    };
    const project = function* (entries: UsageLeader[] | undefined, rows: readonly UsageAnalyticsContribution[], dimension: UsageLeaderDimension, includeSources = false, range?: UsageTimelineRange) {
        if (!entries) return undefined;
        if (hasUsageEventCounts(rows)) {
            return (yield* rank(rows, dimension, entries.length,
                new Map(entries.map(entry => [entry.key, entry.label])), includeSources, range)) ?? [];
        }
        incomplete = true;
        const grouped = groupLegacyContributions(rows, dimension);
        const answer: UsageLeader[] = [];
        for (const entry of entries) {
            // Pre-count responses retain their witnessed raw candidate keys.
            const selected = grouped.get(entry.key) ?? [];
            const sources: UsageAnalyticsTimelineSource[] | undefined = includeSources && entry.sources ? [] : undefined;
            if (sources) for (const part of entry.sources!) sources.push({ ...part,
                cost: yield* projectCost(part.cost, selected.filter(row => (row.source ?? 'unknown') === part.source
                    && (row.sourceContext?.path ?? 'unknown') === part.path
                    && (row.sourceContext?.execution ?? 'unknown') === part.execution)) });
            answer.push({ ...entry, ...(entry.cost ? { cost: yield* projectCost(entry.cost, selected) } : {}),
                ...(sources ? { sources } : {}) });
        }
        return answer;
    };
    const dimensions = { agents: 'agent', models: 'model', sessions: 'session', projects: 'project', workspaces: 'workspace', engines: 'engine' } as const;
    // Initial server projection supplies demand rather than throwing away one
    // set of raw-money rankings. Each requested dimension consumes the priced
    // population once, shared when a breakdown and a leader use that dimension.
    const requestedRanks = new Map<UsageLeaderDimension, UsageRankedLeader[] | undefined>();
    const countedDemand = rankingDemand && hasUsageEventCounts(contributions) ? contributions : undefined;
    if (countedDemand) for (const dimension of new Set<UsageLeaderDimension>([
        ...(rankingDemand!.breakdowns ?? []), ...(rankingDemand!.includeLeaders ? Object.values(dimensions) : []),
    ])) requestedRanks.set(dimension, yield* rank(countedDemand, dimension, rankingDemand!.topLimit));
    let leaders = value.leaders && { ...value.leaders };
    if (countedDemand) {
        leaders = rankingDemand!.includeLeaders && contributions.length
            ? Object.fromEntries(Object.entries(dimensions).map(([key, dimension]) => [key, requestedRanks.get(dimension)])) : undefined;
    } else if (leaders) for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) leaders[key] = yield* project(leaders[key], contributions, dimensions[key]);
    // A timeline partitions this query's selected money, not a sequence of new
    // day-scoped queries. Resolve overlap before bucketing: a whole reported
    // charge belongs to its observation time; covered earlier estimates are
    // still raw facts, but cannot invalidate or duplicate that selected charge.
    const timelineCosts = !pricing && (value.series || value.modelTimeline || value.engineTimeline) ? resolveUsageContributionCosts(contributions, mode) : null;
    const timelineRows = timelineCosts ? contributions.map((row, index) => ({ ...row, cost: timelineCosts[index]! })) : contributions;
    const rowsForBucket = groupUsageTimelineContributions(timelineRows,
        [...(value.series ?? []), ...(value.modelTimeline ?? []), ...(value.engineTimeline ?? [])]);
    const timeline = function* (buckets: UsageAnalyticsQueryResponse['modelTimeline'], dimension: 'model' | 'engine') {
        if (!buckets) return undefined;
        const answer: NonNullable<typeof buckets> = [];
        for (const bucket of buckets) answer.push({ ...bucket,
            leaders: (yield* project(bucket.leaders, rowsForBucket(bucket), dimension, true, bucket)) ?? [] });
        return answer;
    };
    const modelTimeline = yield* timeline(value.modelTimeline, 'model');
    const engineTimeline = yield* timeline(value.engineTimeline, 'engine');
    const series: UsageAnalyticsQueryResponse['series'] = value.series ? [] : undefined;
    if (series) for (const bucket of value.series!) series.push({ ...bucket,
        cost: yield* projectCost(bucket.cost, rowsForBucket(bucket), bucket) });
    const breakdowns = countedDemand ? rankingDemand!.breakdowns?.length ? Object.fromEntries(rankingDemand!.breakdowns.map(dimension => [dimension,
        decorateUsageBreakdownList(requestedRanks.get(dimension) ?? [], countedDemand, dimension)])) : undefined
        : value.breakdowns && { ...value.breakdowns };
    if (breakdowns && !countedDemand) for (const dimension of Object.keys(breakdowns) as UsageAnalyticsBreakdownDimension[]) {
        const entries = breakdowns[dimension];
        if (!entries) continue;
        if (hasUsageEventCounts(contributions)) {
            breakdowns[dimension] = decorateUsageBreakdownList((yield* rank(contributions,
                dimension, entries.length, new Map(entries.map(entry => [entry.key, entry.label])))) ?? [], contributions, dimension, entries);
        } else {
            incomplete = true;
            const grouped = groupLegacyContributions(contributions, dimension);
            const priced: UsageAnalyticsBreakdownEntry[] = [];
            for (const entry of entries) priced.push({ ...entry, cost: yield* projectCost(entry.cost, grouped.get(entry.key) ?? []) });
            breakdowns[dimension] = priced;
        }
    }
    const fullPopulation = contributions.every(row => row.eventCount !== undefined)
        && contributions.reduce((sum, row) => sum + (row.eventCount ?? 0), 0) === value.totals.eventCount;
    const ranked = value.coverage?.ranked.map(entry => {
        const returned = breakdowns?.[entry.dimension];
        if (!fullPopulation || !returned) return entry;
        const totalEntries = new Set(contributions.map(row => resolveUsageContributionDimensionKey(row, entry.dimension) ?? 'unknown')).size;
        return { ...entry, totalEntries, returnedEntries: returned.length, complete: totalEntries === returned.length };
    });
    const coverage = incomplete && value.coverage ? { ...value.coverage,
        status: value.coverage.status === 'complete' ? 'partial' as const : value.coverage.status,
        reasons: [...new Set([...value.coverage.reasons, 'ranked_truncation' as const])],
        ranked: value.coverage.ranked.map(entry => ({ ...entry, complete: false })),
    } : value.coverage && { ...value.coverage, ranked: ranked ?? value.coverage.ranked };
    return { series, breakdowns, leaders, modelTimeline, engineTimeline, coverage };
}
