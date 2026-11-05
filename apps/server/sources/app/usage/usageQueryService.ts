import { getUsageAnalyticsRankedDimensions, type UsageAnalyticsPricingPartitions } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsBreakdownDimension, type UsageAnalyticsBreakdowns, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse, type UsageAnalyticsSeriesBucket, type UsageAnalyticsTotals, type UsageObservationContext } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import {
    buildUsageActivity,
    buildUsageEngineTimeline,
    buildUsageInsights,
    buildUsageModelTimeline,
    deriveEngineKey,
} from "./query/buildUsagePremiumSections";
import { resolveUsageBucketBounds as resolveBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { resolveUsageContributionDimensionKey } from '@happier-dev/protocol/usage/usageCostFacts';
import { hasCompleteUsageCostEvidence, readUsagePageCostProjectionBasis, repriceUsageAnalyticsCoverage, repriceUsageAnalyticsResponseSteps } from '@happier-dev/protocol/usage/usageCost';
import { resolveCapturedUsageModelPriceCatalog, type CapturedUsageModelPriceCatalog } from './usageModelPriceCatalog';
import type { ScopedUsageContribution, ScopedUsageReplayContext } from "./query/resolveScopedUsageContributions";
import { addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from "./usageMetrics";
import { addUsageCostForMode, withEffectiveUsageCost, type UsageCostMode } from "./query/resolveUsageCostMode";
import type { UsageQueryEvent } from "./query/loadUsageEventsForQuery";
import { buildUsageResultProjection } from "./query/buildUsageResultProjection";
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { projectUsageAnalyticsPopulation, type UsageAnalyticsPopulation } from './query/projectUsageAnalyticsPopulation';
import type { UsageQueryTiming } from './query/usageQueryTiming';
import type { ScopedUsageEvidenceRow } from './query/scopedUsageEventRow';
import { captureUsageAnalyticsBatchInTx } from './query/readUsageAnalyticsBatch';

function readContributionContext(row: ScopedUsageContribution): UsageObservationContext | undefined {
    if (row.contextUsedTokens == null && row.contextWindowTokens == null) return undefined;
    return {
        usedTokens: row.contextUsedTokens,
        windowTokens: row.contextWindowTokens,
    };
}

function resolveLatestContributionContext(
    rows: readonly ScopedUsageContribution[],
): UsageObservationContext | undefined {
    let latest: UsageObservationContext | undefined;
    for (const row of rows) {
        latest = readContributionContext(row) ?? latest;
    }
    return latest;
}

function toUsageTotals(rows: ScopedUsageContribution[], costMode: UsageCostMode): UsageAnalyticsTotals {
    let tokens = createEmptyUsageTokens();
    const eventIds = new Set<string>();

    for (const row of rows) {
        tokens = addUsageTokens(tokens, row.tokens);
        for (const eventId of row.contributingEventIds) eventIds.add(eventId);
    }
    const cost = aggregateUsageContributionCosts(rows, costMode);

    return {
        eventCount: eventIds.size,
        tokens,
        cost: withEffectiveUsageCost(cost, costMode),
        context: resolveLatestContributionContext(rows),
    };
}

function buildSeries(
    rows: ScopedUsageContribution[],
    granularity: UsageAnalyticsQueryRequest['granularity'],
    timeZoneOffsetMinutes: number,
    costMode: UsageCostMode,
): UsageAnalyticsSeriesBucket[] {
    const buckets = new Map<number, UsageAnalyticsSeriesBucket>();

    for (const row of rows) {
        const { bucketStartMs, bucketEndMs } = resolveBucketBounds(
            granularity,
            row.observedAt.getTime(),
            timeZoneOffsetMinutes,
        );
        const current = buckets.get(bucketStartMs) ?? {
            bucketStartMs,
            bucketEndMs,
            eventCount: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
        };
        current.eventCount += row.contributingEventIds.length;
        current.tokens = addUsageTokens(current.tokens, row.tokens);
        current.cost = addUsageCostForMode(current.cost, row.cost, costMode);
        current.context = readContributionContext(row) ?? current.context;
        buckets.set(bucketStartMs, current);
    }

    return Array.from(buckets.values()).sort((left, right) => left.bucketStartMs - right.bucketStartMs);
}

export async function queryUsageAnalytics(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
): Promise<UsageAnalyticsQueryResponse> {
    const snapshot = await inReadSnapshot(tx => captureUsageAnalyticsInTx(tx, accountId, request));
    return projectUsageAnalytics(snapshot, request);
}

export interface UsageAnalyticsSnapshot {
    rows: UsageQueryEvent[];
    evidenceRows?: readonly ScopedUsageEvidenceRow[];
    normalizedEvidenceById?: ReadonlyMap<string, ScopedUsageEvidenceRow>;
    replayContext?: ScopedUsageReplayContext;
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

/** Ownership admission and every DB reader share the caller's transaction. No result computation or reply runs here. */
export async function captureUsageAnalyticsInTx(
    tx: Tx,
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    isReaderClosed?: () => boolean,
): Promise<UsageAnalyticsSnapshot> {
    const captured = await captureUsageAnalyticsBatchInTx(tx, accountId, [request], isReaderClosed);
    return captured.snapshots.get(getUsageAnalyticsQueryRequestKey(request))!;
}

/** Reconcile, price and aggregate only committed captured rows, without retaining a pooled connection. */
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
    priceCatalog: UsageModelPriceCatalog, population: UsageAnalyticsPopulation, timing?: UsageQueryTiming): Generator<void, PreparedUsageAnalyticsProjection, void> {
    const { totalContributions, evidenceRows, costMode } = population;
    const publicPopulation = request.population === 'public_eligible_personal';
    const totals = toUsageTotals(totalContributions, costMode);
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
    const rankedDimensions = getUsageAnalyticsRankedDimensions(request);
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
    for (const dimension of new Set([...rankedDimensions, ...(request.includeModelTimeline ? ['model' as const] : [])])) {
        dimensionCounts.set(dimension, new Set(totalContributions.map(row => resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown')).size);
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
        coverageReasons: totalContributions.flatMap((row) => row.coverageReasons ?? []),
        timelineTruncated: timelineTruncatedFor(request.topLimit), request, ranked: rankedFor(request),
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
    const pricing = repriceUsageAnalyticsResponseSteps({
        v: 1,
        totals,
        series,
        breakdowns,
        insights: request.includeInsights ? insights : undefined,
        activity,
        leaders: undefined,
        modelTimeline,
        engineTimeline,
        messageStats,
        ...projection,
    }, priceCatalog, {}, costMode, request, () => performance.now() - pricingSliceStartedAt >= pricingSliceMs);
    const advancePrice = () => {
        pricingSliceStartedAt = performance.now();
        return timing ? timing.measure('price', () => pricing.next()) : pricing.next();
    };
    let priced = advancePrice();
    while (!priced.done) { yield; priced = advancePrice(); }
    const value = priced.value;
    return { value, pricingPartitions: readUsagePageCostProjectionBasis(value)?.partitions,
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
