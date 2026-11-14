import { getUsageAnalyticsRankedDimensions, type UsageAnalyticsPricingPartitions } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsBreakdownDimension, type UsageAnalyticsBreakdowns, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse, type UsageAnalyticsSeriesBucket, type UsageAnalyticsTotals, type UsageObservationContext } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from "@/storage/inTx";
import {
    buildUsageActivity,
    buildUsageEngineTimeline,
    buildUsageInsights,
    buildUsageModelTimeline,
    deriveEngineKey,
} from "./query/buildUsagePremiumSections";
import { resolveUsageBucketBounds as resolveBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { resolveUsageContributionDimensionKey } from '@happier-dev/protocol/usage/usageCostFacts';
import { hasCompleteUsageCostEvidence, projectUsageAnalyticsSummarySteps, readUsagePageCostProjectionBasis, repriceUsageAnalyticsCoverage, repriceUsageAnalyticsResponseSteps } from '@happier-dev/protocol/usage/usageCost';
import { resolveCapturedUsageModelPriceCatalog, type CapturedUsageModelPriceCatalog } from './usageModelPriceCatalog';
import type { ScopedUsageContribution, ScopedUsageReplayContext } from "./query/resolveScopedUsageContributions";
import { createEmptyUsageCost, createEmptyUsageTokens } from "./usageMetrics";
import { withEffectiveUsageCost, type UsageCostMode } from "./query/resolveUsageCostMode";
import type { UsageQueryEvent } from "./query/loadUsageEventsForQuery";
import { buildUsageResultProjection } from "./query/buildUsageResultProjection";
import { addUsageMeasuredTokens, aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import { projectUsageContributionTotals } from '@happier-dev/protocol/usage/usageActivityProjectionFacts';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { projectUsageAnalyticsPopulation, type UsageAnalyticsPopulation } from './query/projectUsageAnalyticsPopulation';
import type { UsageQueryTiming } from './query/usageQueryTiming';
import type { ScopedUsageEvidenceRow } from './query/scopedUsageEventRow';
import { captureUsageAnalyticsBatch, captureUsageAnalyticsBatchInTx, projectUsageAnalyticsBatch } from './query/readUsageAnalyticsBatch';
import { selectUsageScopeKeys, usageScopeFilterDimensions } from '@happier-dev/protocol/usage/usageFilterOptions';

const scopeDimensions = new Set<UsageAnalyticsBreakdownDimension>(Object.values(usageScopeFilterDimensions));

function readContributionContext(row: ScopedUsageContribution): UsageObservationContext | undefined {
    if (row.contextUsedTokens == null && row.contextWindowTokens == null) return undefined;
    return {
        usedTokens: row.contextUsedTokens,
        windowTokens: row.contextWindowTokens,
    };
}

function toUsageTotals(rows: ScopedUsageContribution[], costMode: UsageCostMode, deferCost = false): UsageAnalyticsTotals {
    const cost = deferCost ? createEmptyUsageCost() : aggregateUsageContributionCosts(rows, costMode);
    return projectUsageContributionTotals(rows.map(row => ({ tokens: row.tokens,
        eventCount: row.contributingEventIds.length, context: readContributionContext(row) })), withEffectiveUsageCost(cost, costMode));
}

function buildSeries(
    rows: ScopedUsageContribution[],
    granularity: UsageAnalyticsQueryRequest['granularity'],
    timeZoneOffsetMinutes: number,
    costMode: UsageCostMode,
): UsageAnalyticsSeriesBucket[] {
    const buckets = new Map<number, { value: UsageAnalyticsSeriesBucket; rows: ScopedUsageContribution[] }>();

    for (const row of rows) {
        const { bucketStartMs, bucketEndMs } = resolveBucketBounds(
            granularity,
            row.observedAt.getTime(),
            timeZoneOffsetMinutes,
        );
        const group: { value: UsageAnalyticsSeriesBucket; rows: ScopedUsageContribution[] } = buckets.get(bucketStartMs) ?? { rows: [], value: {
            bucketStartMs,
            bucketEndMs,
            eventCount: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
        } };
        const current = group.value;
        current.eventCount += row.contributingEventIds.length;
        current.tokens = addUsageMeasuredTokens(current.tokens, row.tokens);
        current.context = readContributionContext(row) ?? current.context;
        group.rows.push(row);
        buckets.set(bucketStartMs, group);
    }

    // Publish exact monetary operands once per bucket rather than rebuilding
    // an accumulator and its numeric/provenance output for every input row.
    return Array.from(buckets.values(), ({ value, rows }) => ({ ...value,
        cost: aggregateUsageContributionCosts(rows, costMode),
    })).sort((left, right) => left.bucketStartMs - right.bucketStartMs);
}

export async function queryUsageAnalytics(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
): Promise<UsageAnalyticsQueryResponse> {
    const snapshot = await captureUsageAnalytics(accountId, request);
    return projectUsageAnalyticsAsync(snapshot, request);
}

/** All standalone reads share the batch owner's accounting and supporting snapshots. */
export async function captureUsageAnalytics(accountId: string, request: UsageAnalyticsQueryRequest,
    isReaderClosed?: () => boolean): Promise<UsageAnalyticsSnapshot> {
    const captured = await captureUsageAnalyticsBatch(accountId, [request], isReaderClosed);
    return captured.snapshots.get(getUsageAnalyticsQueryRequestKey(request))!;
}

export interface UsageAnalyticsSnapshot {
    rows: UsageQueryEvent[];
    /** PostgreSQL capture leaves historical metadata opaque until the read completes. */
    rawEvidenceRows?: readonly import('./query/scopedUsageEventRow').ScopedUsageEvidenceDbRow[];
    evidenceRows?: readonly ScopedUsageEvidenceRow[];
    normalizedEvidenceById?: ReadonlyMap<string, ScopedUsageEvidenceRow>;
    replayContext?: ScopedUsageReplayContext;
    /** The canonical replay owner has already prepared this exact captured request. */
    preparedQueryKey?: string;
    legacyReports: Array<{ id: string; sessionId: string | null; key: string; data: unknown; createdAt: Date; updatedAt: Date }>;
    priceCatalog: CapturedUsageModelPriceCatalog;
    messageCountsBySession: ReadonlyMap<string, number> | undefined;
}

/** Output projection needs only captured message counts after accounting has folded. */
export type UsageAnalyticsProjectionContext = Pick<UsageAnalyticsSnapshot, 'messageCountsBySession'>;

/** A captured Session count is admitted only for selected private, unfiltered execution membership. */
export function selectUsageMessageCounts(
    request: UsageAnalyticsQueryRequest,
    sessionIds: readonly string[],
    messageCountsBySession: ReadonlyMap<string, number> | undefined,
): { messageCount: number } | undefined {
    if (request.population === 'public_eligible_personal' || request.filters?.execution !== undefined
        || messageCountsBySession === undefined) return undefined;
    return { messageCount: sessionIds.reduce((count, sessionId) =>
        count + (messageCountsBySession.get(sessionId) ?? 0), 0) };
}

/** Composing readers retain the caller's snapshot; standalone entry points use captureUsageAnalytics. */
export async function captureUsageAnalyticsInTx(
    tx: Tx,
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    isReaderClosed?: () => boolean,
): Promise<UsageAnalyticsSnapshot> {
    const captured = await captureUsageAnalyticsBatchInTx(tx, accountId, [request], isReaderClosed);
    return captured.snapshots.get(getUsageAnalyticsQueryRequestKey(request))!;
}

/** Live scalar requests use the batch owner's cooperative fold, pricing and projection. */
export async function projectUsageAnalyticsAsync(snapshot: UsageAnalyticsSnapshot,
    request: UsageAnalyticsQueryRequest, isReaderClosed?: () => boolean): Promise<UsageAnalyticsQueryResponse> {
    const batch = await projectUsageAnalyticsBatch({
        snapshots: new Map([[getUsageAnalyticsQueryRequestKey(request), snapshot]]),
        priceCatalog: snapshot.priceCatalog,
    }, [request], true, false, undefined, undefined, isReaderClosed);
    const result = batch.results[0];
    if (!result || !('value' in result)) throw new Error('Usage analytics projection failed');
    return { ...result.value, priceCatalog: batch.priceCatalog };
}

/** Pure synchronous consumers drain the same projection steps without retaining a pooled connection. */
export function projectUsageAnalytics(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    priceCatalog: UsageModelPriceCatalog = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog),
    population: UsageAnalyticsPopulation = projectUsageAnalyticsPopulation(snapshot, request)): UsageAnalyticsQueryResponse {
    return prepareUsageAnalyticsProjection(snapshot, request, priceCatalog, population).value;
}

interface PreparedUsageAnalyticsProjection {
    value: UsageAnalyticsQueryResponse;
    pricingPartitions?: UsageAnalyticsPricingPartitions;
    select: (request: UsageAnalyticsQueryRequest, captured: UsageAnalyticsProjectionContext) => UsageAnalyticsQueryResponse;
}

/** The scalar API drains the same preparation units without changing its synchronous contract. */
export function prepareUsageAnalyticsProjection(snapshot: UsageAnalyticsProjectionContext, request: UsageAnalyticsQueryRequest,
    priceCatalog: UsageModelPriceCatalog, population: UsageAnalyticsPopulation): PreparedUsageAnalyticsProjection {
    const preparation = prepareUsageAnalyticsProjectionSteps(snapshot, request, priceCatalog, population);
    let next = preparation.next();
    while (!next.done) next = preparation.next();
    return next.value;
}

/** One admitted population/coordinate owns its union. Batch callers can service I/O between real projection units. */
export function* prepareUsageAnalyticsProjectionSteps(snapshot: UsageAnalyticsProjectionContext, request: UsageAnalyticsQueryRequest,
    priceCatalog: UsageModelPriceCatalog, population: UsageAnalyticsPopulation, timing?: UsageQueryTiming, groupPrices = false, retainContributions = true): Generator<void, PreparedUsageAnalyticsProjection, void> {
    const { totalContributions, evidenceRows, costMode } = population;
    const publicPopulation = request.population === 'public_eligible_personal';
    const rankedDimensions = getUsageAnalyticsRankedDimensions(request);
    // Compact pricing replaces these money outputs before any result leaves
    // this owner. Do not first aggregate event-money facts that it discards.
    const grouped = groupPrices && !publicPopulation && rankedDimensions.size === 0 && !request.includeModelTimeline;
    const totals = toUsageTotals(totalContributions, costMode, grouped);
    yield;
    const sessionIds = Array.from(
        new Set(
            totalContributions.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
        ),
    );
    // Whole-Session counts cannot prove membership in a selected execution population.
    const messageCounts = selectUsageMessageCounts(request, sessionIds, snapshot.messageCountsBySession);
    const insights = messageCounts
        ? buildUsageInsights(totalContributions, messageCounts, request.timeZoneOffsetMinutes)
        : undefined;
    const messageStats = insights && messageCounts
        ? {
            sessionCount: insights.sessionsUsed,
            messageCount: messageCounts.messageCount,
        }
        : undefined;
    yield;
    const breakdowns: UsageAnalyticsBreakdowns | undefined = request.breakdowns?.length ? {} : undefined;
    const modelTimeline = request.includeModelTimeline ? buildUsageModelTimeline(totalContributions,
        request.granularity, request.topLimit, request.timeZoneOffsetMinutes, request.costMode, true) : undefined;
    if (request.includeModelTimeline) yield;
    const engineTimeline = request.includeModelTimeline ? buildUsageEngineTimeline(totalContributions,
        request.granularity, request.topLimit, request.timeZoneOffsetMinutes, request.costMode, true) : undefined;
    if (request.includeModelTimeline) yield;
    const timelineCardinalities = new Map<number, { models: Set<string>; engines: Set<string> }>();
    if (request.includeModelTimeline) for (const row of totalContributions) {
        const { bucketStartMs } = resolveBucketBounds(request.granularity, row.observedAt.getTime(), request.timeZoneOffsetMinutes);
        const counts = timelineCardinalities.get(bucketStartMs) ?? { models: new Set<string>(), engines: new Set<string>() };
        counts.models.add(resolveUsageContributionDimensionKey(row, 'model') ?? 'unknown');
        counts.engines.add(deriveEngineKey(row) ?? 'unknown');
        timelineCardinalities.set(bucketStartMs, counts);
    }
    if (request.includeModelTimeline) yield;
    const timelineTruncatedFor = (limit: number) => [...timelineCardinalities.values()].some((counts) => counts.models.size > limit || counts.engines.size > limit);
    const dimensionCounts = new Map<UsageAnalyticsBreakdownDimension, number>();
    const scopeKeys: NonNullable<UsageAnalyticsQueryResponse['scopeKeys']> = [];
    for (const dimension of new Set([...rankedDimensions, ...(request.includeModelTimeline ? ['model' as const] : [])])) {
        const keys = new Set(totalContributions.map(row => resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown'));
        dimensionCounts.set(dimension, keys.size);
        // The private filter inventory needs all identities, never a ranked frontier or rich event rows.
        if (!publicPopulation && request.breakdowns?.includes(dimension) && scopeDimensions.has(dimension)) {
            scopeKeys.push({ dimension, keys: [...keys] });
        }
        yield;
    }
    const rankedFor = (selected: UsageAnalyticsQueryRequest) => {
        const dimensions = getUsageAnalyticsRankedDimensions(selected);
        const ranked = [...dimensions].map((dimension) => {
            const totalEntries = dimensionCounts.get(dimension)!;
            const returnedEntries = Math.min(totalEntries, selected.topLimit);
            return { dimension, totalEntries, returnedEntries, complete: totalEntries === returnedEntries };
        });
        if (selected.includeModelTimeline && modelTimeline && !dimensions.has('model')) {
            ranked.push({ dimension: 'model',
                totalEntries: dimensionCounts.get('model')!,
                returnedEntries: new Set(modelTimeline.flatMap((bucket) => bucket.leaders.slice(0, selected.topLimit).map((leader) => leader.key))).size,
                complete: [...timelineCardinalities.values()].every((counts) => counts.models.size <= selected.topLimit),
            });
        }
        return ranked;
    };
    const { projectCoverage, ...projection } = buildUsageResultProjection({
        contributions: totalContributions, evidenceRows, coverageEvidence: population.coverageEvidence,
        preparedContributions: population.preparedContributions,
        coverageReasons: totalContributions.flatMap((row) => row.coverageReasons ?? []),
        timelineTruncated: timelineTruncatedFor(request.topLimit), request, ranked: rankedFor(request),
        // Repricing below owns the published cost facts and presentation for
        // rich detail too. Raw per-row facts would be immediately replaced.
        deferCost: true,
    });
    if (!projection.costPresentation) {
        const { effectiveUsd: _selected, ...rawCost } = totals.cost;
        totals.cost = rawCost;
    }
    yield;
    const series = request.includeSeries
        ? buildSeries(totalContributions, request.granularity, request.timeZoneOffsetMinutes, costMode)
        : undefined;
    if (request.includeSeries) yield;
    const activity = request.includeActivity
        ? buildUsageActivity(totalContributions, request.activityResolution, request.timeZoneOffsetMinutes)
        : undefined;
    if (request.includeActivity) yield;
    // Reload 112's unprofiled p95 is 22ms (20ms timer resolution). A 20ms
    // work slice targets that observed scheduling granularity;
    // row count never decides when the host yields, and no transaction is held.
    const pricingSliceMs = 20;
    let pricingSliceStartedAt = 0;
    const raw: UsageAnalyticsQueryResponse = {
        v: 1,
        totals,
        series,
        breakdowns,
        scopeKeys: scopeKeys.length ? scopeKeys : undefined,
        insights: request.includeInsights ? insights : undefined,
        activity,
        leaders: undefined,
        modelTimeline,
        engineTimeline,
        messageStats,
        ...projection,
    };
    // Compact delivery already owns tariff-linear populations. Prepare them
    // before pricing when no consumer requests priced event detail. Ranking
    // preparation still uses the rich owner, which chooses cost-ordered entries.
    const operands = grouped ? yield* projectUsageAnalyticsSummarySteps({ ...raw, priceCatalog }, request) : raw;
    const pricing = repriceUsageAnalyticsResponseSteps(operands, priceCatalog, {}, costMode, request,
        () => performance.now() - pricingSliceStartedAt >= pricingSliceMs);
    const advancePrice = () => {
        pricingSliceStartedAt = performance.now();
        return timing ? timing.measure('price', () => pricing.next()) : pricing.next();
    };
    let priced = advancePrice();
    while (!priced.done) { yield; priced = advancePrice(); }
    // The delivery owner still consumes admitted row identity for Session/turn
    // membership. These unpriced rows cannot reach a requested detail page.
    const value = grouped ? { ...priced.value, contributions: raw.contributions } : priced.value;
    const pricingPartitions = readUsagePageCostProjectionBasis(value)?.partitions;
    // Compact delivery must also release the detail held by the private pricing witness.
    // Summaries and requested detail keep these operands until their consumers finish.
    if (!retainContributions) delete value.contributions;
    return { value, pricingPartitions,
        select(selected: UsageAnalyticsQueryRequest, selectedSnapshot: UsageAnalyticsProjectionContext): UsageAnalyticsQueryResponse {
        const selectedCoverage = projectCoverage(selected, rankedFor(selected), selected.includeModelTimeline === true && timelineTruncatedFor(selected.topLimit));
        const coverage = repriceUsageAnalyticsCoverage(selectedCoverage, selectedCoverage,
            value.costFacts?.some(fact => fact.kind === 'unpriced') ?? false);
        const complete = hasCompleteUsageCostEvidence({ ...value, coverage });
        const hasMessages = selectedSnapshot.messageCountsBySession !== undefined;
        return { ...value,
            coverage,
            costFacts: value.costFacts?.map(fact => ({ ...fact, complete: fact.kind !== 'unpriced' && complete })),
            series: selected.includeSeries ? value.series : undefined,
            breakdowns: selected.breakdowns?.length ? Object.fromEntries(selected.breakdowns.map(dimension => [dimension, value.breakdowns?.[dimension]?.slice(0, selected.topLimit)])) : undefined,
            scopeKeys: selectUsageScopeKeys(value.scopeKeys, selected.breakdowns),
            insights: selected.includeInsights && hasMessages ? value.insights : undefined,
            activity: selected.includeActivity && value.activity ? { ...value.activity,
                calendarDays: selected.activityResolution === 'weekdayHour' ? undefined : value.activity.calendarDays,
                weekdayHourBuckets: selected.activityResolution === 'calendar' ? undefined : value.activity.weekdayHourBuckets } : undefined,
            leaders: selected.includeLeaders && value.leaders ? Object.fromEntries(Object.entries(value.leaders).map(([dimension, entries]) => [dimension, entries?.slice(0, selected.topLimit)])) : undefined,
            modelTimeline: selected.includeModelTimeline ? value.modelTimeline?.map(bucket => ({ ...bucket, leaders: bucket.leaders.slice(0, selected.topLimit) })) : undefined,
            engineTimeline: selected.includeModelTimeline ? value.engineTimeline?.map(bucket => ({ ...bucket, leaders: bucket.leaders.slice(0, selected.topLimit) })) : undefined,
            messageStats: hasMessages ? value.messageStats : undefined,
        };
    } };
}
