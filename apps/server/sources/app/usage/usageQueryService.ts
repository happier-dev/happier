import type {
    UsageAnalyticsBreakdownDimension,
    UsageAnalyticsBreakdownEntry,
    UsageAnalyticsBreakdowns,
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
    UsageAnalyticsSeriesBucket,
    UsageAnalyticsTotals,
    UsageObservationCost,
    UsageObservationContext,
    UsageObservationTokens,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import {
    buildUsageActivity,
    buildUsageCostPresentation,
    buildUsageEngineTimeline,
    buildUsageInsights,
    buildUsageLeaders,
    buildUsageModelTimeline,
} from "./query/buildUsagePremiumSections";
import { resolveBucketBounds } from "./query/bucketBounds";
import { loadUsageMessageStatsForQuery } from "./query/loadUsageMessageStatsForQuery";
import {
    resolveScopedUsageContributions,
    type ScopedUsageContribution,
    type ScopedUsageEventRow,
} from "./query/resolveScopedUsageContributions";
import { addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from "./usageMetrics";
import { addUsageCostForMode, resolveUsageCostMode, withEffectiveUsageCost, type UsageCostMode } from "./query/resolveUsageCostMode";

type UsageEventRow = Awaited<ReturnType<typeof loadUsageEventsForQuery>>[number];

function readCostBreakdown(value: unknown): Record<string, number> | undefined {
    if (typeof value === "string") {
        try {
            return readCostBreakdown(JSON.parse(value));
        } catch {
            return undefined;
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const breakdown: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
            breakdown[key] = entry;
        }
    }
    return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function toEventTokens(row: UsageEventRow): UsageObservationTokens {
    return {
        input: row.inputTokens,
        output: row.outputTokens,
        reasoning: row.reasoningTokens,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
        total: row.totalTokens,
    };
}

function toEventCost(row: UsageEventRow): UsageObservationCost {
    return {
        reportedUsd: row.reportedCostUsd,
        estimatedUsd: row.estimatedCostUsd,
        invoiceUsd: row.invoiceCostUsd,
        billingContext: (row.billingContext ?? 'unknown') as UsageObservationCost['billingContext'],
        costSource: (row.costSource ?? 'none') as UsageObservationCost['costSource'],
        currency: row.currency,
        breakdown: readCostBreakdown(row.costBreakdown),
    };
}

function toScopedUsageEventRow(row: UsageEventRow): ScopedUsageEventRow {
    return {
        id: row.id,
        sessionId: row.sessionId,
        observedAt: row.observedAt,
        createdAt: row.createdAt,
        agentId: row.agentId,
        backendMode: row.backendMode,
        modelId: row.modelId,
        projectKey: row.projectKey,
        workspaceId: row.workspaceId,
        source: row.source,
        scope: row.scope,
        isCumulative: row.isCumulative,
        turnId: row.turnId,
        contextUsedTokens: row.contextUsedTokens,
        contextWindowTokens: row.contextWindowTokens,
        tokens: toEventTokens(row),
        cost: toEventCost(row),
    };
}

function toPremiumEventRow(row: ScopedUsageContribution) {
    return row;
}

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
    let cost = createEmptyUsageCost();
    const eventIds = new Set<string>();

    for (const row of rows) {
        tokens = addUsageTokens(tokens, row.tokens);
        cost = addUsageCostForMode(cost, row.cost, costMode);
        for (const eventId of row.contributingEventIds) eventIds.add(eventId);
    }

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

function resolveBreakdownKey(row: ScopedUsageContribution, dimension: UsageAnalyticsBreakdownDimension): string | null {
    if (dimension === 'agent') return row.agentId;
    if (dimension === 'model') return row.modelId;
    if (dimension === 'session') return row.sessionId;
    if (dimension === 'project') return row.projectKey;
    if (dimension === 'workspace') return row.workspaceId;
    if (dimension === 'backendMode') return row.backendMode;
    return row.source;
}

function buildBreakdownEntries(
    rows: ScopedUsageContribution[],
    dimension: UsageAnalyticsBreakdownDimension,
    topLimit: number,
    costMode: UsageCostMode,
): UsageAnalyticsBreakdownEntry[] {
    const entries = new Map<string, UsageAnalyticsBreakdownEntry>();

    for (const row of rows) {
        const key = resolveBreakdownKey(row, dimension) ?? 'unknown';
        const current = entries.get(key) ?? {
            key,
            label: key,
            eventCount: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
        };
        current.eventCount += row.contributingEventIds.length;
        current.tokens = addUsageTokens(current.tokens, row.tokens);
        current.cost = addUsageCostForMode(current.cost, row.cost, costMode);
        current.context = readContributionContext(row) ?? current.context;
        if (dimension === 'session') {
            if (row.contextUsedTokens !== null) {
                current.latestContextUsedTokens = row.contextUsedTokens;
            }
            if (row.contextWindowTokens !== null) {
                current.latestContextWindowTokens = row.contextWindowTokens;
            }
        }
        entries.set(key, current);
    }

    return Array.from(entries.values())
        .sort((left, right) => {
            if (right.tokens.total !== left.tokens.total) return right.tokens.total - left.tokens.total;
            if (right.cost.reportedUsd !== left.cost.reportedUsd) return right.cost.reportedUsd - left.cost.reportedUsd;
            if (right.eventCount !== left.eventCount) return right.eventCount - left.eventCount;
            return left.key.localeCompare(right.key);
        })
        .slice(0, topLimit)
        .map((entry) => ({ ...entry, cost: withEffectiveUsageCost(entry.cost, costMode) }));
}

async function loadUsageEventsForQuery(accountId: string, request: UsageAnalyticsQueryRequest) {
    return await db.usageEvent.findMany({
        where: {
            accountId,
            observedAt: request.dateRange
                ? {
                    gte: request.dateRange.startMs ? new Date(request.dateRange.startMs) : undefined,
                    lte: request.dateRange.endMs ? new Date(request.dateRange.endMs) : undefined,
                }
                : undefined,
            sessionId: request.filters?.sessionIds?.length ? { in: request.filters.sessionIds } : undefined,
            agentId: request.filters?.agentIds?.length ? { in: request.filters.agentIds } : undefined,
            modelId: request.filters?.modelIds?.length ? { in: request.filters.modelIds } : undefined,
            projectKey: request.filters?.projectKeys?.length ? { in: request.filters.projectKeys } : undefined,
            workspaceId: request.filters?.workspaceIds?.length ? { in: request.filters.workspaceIds } : undefined,
            backendMode: request.filters?.backendModes?.length ? { in: request.filters.backendModes } : undefined,
            source: request.filters?.sources?.length ? { in: request.filters.sources } : undefined,
        },
        orderBy: {
            observedAt: 'asc',
        },
        select: {
            id: true,
            sessionId: true,
            observedAt: true,
            createdAt: true,
            agentId: true,
            backendMode: true,
            modelId: true,
            projectKey: true,
            workspaceId: true,
            machineId: true,
            source: true,
            scope: true,
            isCumulative: true,
            turnId: true,
            inputTokens: true,
            outputTokens: true,
            reasoningTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            totalTokens: true,
            reportedCostUsd: true,
            estimatedCostUsd: true,
            invoiceCostUsd: true,
            billingContext: true,
            costSource: true,
            currency: true,
            costBreakdown: true,
            contextUsedTokens: true,
            contextWindowTokens: true,
        },
    });
}

export async function queryUsageAnalytics(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
): Promise<UsageAnalyticsQueryResponse> {
    const rows = await loadUsageEventsForQuery(accountId, request);
    const scopedRows = rows.map(toScopedUsageEventRow);
    const { totalContributions, bucketAttributions } = resolveScopedUsageContributions(scopedRows);
    const costMode = resolveUsageCostMode(request.costMode);
    const premiumRows = totalContributions.map(toPremiumEventRow);
    const premiumBucketRows = bucketAttributions.map(toPremiumEventRow);
    const totals = toUsageTotals(totalContributions, costMode);
    const sessionIds = Array.from(
        new Set(
            premiumRows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
        ),
    );
    const messageCounts = request.includeMessageStats || request.includeInsights
        ? await loadUsageMessageStatsForQuery(accountId, request, sessionIds)
        : undefined;
    const insights = messageCounts
        ? buildUsageInsights(premiumRows, messageCounts, request.timeZoneOffsetMinutes)
        : undefined;
    const messageStats = insights && messageCounts
        ? {
            sessionCount: insights.sessionsUsed,
            messageCount: messageCounts.messageCount,
        }
        : undefined;
    const breakdowns = request.breakdowns?.length
        ? request.breakdowns.reduce<UsageAnalyticsBreakdowns>((acc, dimension) => {
            acc[dimension] = buildBreakdownEntries(totalContributions, dimension, request.topLimit, costMode);
            return acc;
        }, {})
        : undefined;

    return {
        v: 1,
        totals,
        series: request.includeSeries
            ? buildSeries(bucketAttributions, request.granularity, request.timeZoneOffsetMinutes, costMode)
            : undefined,
        breakdowns,
        insights: request.includeInsights ? insights : undefined,
        activity: request.includeActivity
            ? buildUsageActivity(premiumRows, request.activityResolution, request.timeZoneOffsetMinutes)
            : undefined,
        leaders: request.includeLeaders ? buildUsageLeaders(premiumRows, request.topLimit, request.costMode) : undefined,
        modelTimeline: request.includeModelTimeline
            ? buildUsageModelTimeline(
                premiumBucketRows,
                request.granularity,
                request.topLimit,
                request.timeZoneOffsetMinutes,
                request.costMode,
            )
            : undefined,
        engineTimeline: request.includeModelTimeline
            ? buildUsageEngineTimeline(
                premiumBucketRows,
                request.granularity,
                request.topLimit,
                request.timeZoneOffsetMinutes,
                request.costMode,
            )
            : undefined,
        messageStats,
        costPresentation: buildUsageCostPresentation(totals.cost, request.costMode),
    };
}
