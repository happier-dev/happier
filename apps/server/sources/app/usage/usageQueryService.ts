import type {
    UsageAnalyticsBreakdownDimension,
    UsageAnalyticsBreakdownEntry,
    UsageAnalyticsBreakdowns,
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
    UsageAnalyticsSeriesBucket,
    UsageAnalyticsTotals,
    UsageObservationCost,
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
import { loadUsageMessageStatsForQuery } from "./query/loadUsageMessageStatsForQuery";
import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from "./usageMetrics";

type UsageEventRow = Awaited<ReturnType<typeof loadUsageEventsForQuery>>[number];

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
    };
}

function toPremiumEventRow(row: UsageEventRow) {
    return {
        sessionId: row.sessionId,
        observedAt: row.observedAt,
        providerId: row.providerId,
        backendMode: row.backendMode,
        modelId: row.modelId,
        projectKey: row.projectKey,
        workspaceId: row.workspaceId,
        source: row.source,
        tokens: toEventTokens(row),
        cost: toEventCost(row),
    };
}

function toUsageTotals(rows: UsageEventRow[]): UsageAnalyticsTotals {
    let tokens = createEmptyUsageTokens();
    let cost = createEmptyUsageCost();

    for (const row of rows) {
        tokens = addUsageTokens(tokens, toEventTokens(row));
        cost = addUsageCost(cost, toEventCost(row));
    }

    return {
        eventCount: rows.length,
        tokens,
        cost,
    };
}

function resolveBucketBounds(observedAt: Date, granularity: UsageAnalyticsQueryRequest['granularity']): {
    bucketStartMs: number;
    bucketEndMs: number;
} {
    const value = new Date(observedAt);
    let start: Date;
    let end: Date;

    if (granularity === 'hour') {
        start = new Date(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), 0, 0, 0);
        end = new Date(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours() + 1, 0, 0, 0);
    } else if (granularity === 'week') {
        const day = value.getDay();
        const offset = day === 0 ? 6 : day - 1;
        start = new Date(value.getFullYear(), value.getMonth(), value.getDate() - offset, 0, 0, 0, 0);
        end = new Date(value.getFullYear(), value.getMonth(), value.getDate() + (7 - offset), 0, 0, 0, 0);
    } else if (granularity === 'month') {
        start = new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
        end = new Date(value.getFullYear(), value.getMonth() + 1, 1, 0, 0, 0, 0);
    } else {
        start = new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
        end = new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1, 0, 0, 0, 0);
    }

    return {
        bucketStartMs: start.getTime(),
        bucketEndMs: end.getTime(),
    };
}

function buildSeries(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest['granularity'],
): UsageAnalyticsSeriesBucket[] {
    const buckets = new Map<number, UsageAnalyticsSeriesBucket>();

    for (const row of rows) {
        const { bucketStartMs, bucketEndMs } = resolveBucketBounds(row.observedAt, granularity);
        const current = buckets.get(bucketStartMs) ?? {
            bucketStartMs,
            bucketEndMs,
            eventCount: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
        };
        current.eventCount += 1;
        current.tokens = addUsageTokens(current.tokens, toEventTokens(row));
        current.cost = addUsageCost(current.cost, toEventCost(row));
        buckets.set(bucketStartMs, current);
    }

    return Array.from(buckets.values()).sort((left, right) => left.bucketStartMs - right.bucketStartMs);
}

function resolveBreakdownKey(row: UsageEventRow, dimension: UsageAnalyticsBreakdownDimension): string | null {
    if (dimension === 'provider') return row.providerId;
    if (dimension === 'model') return row.modelId;
    if (dimension === 'session') return row.sessionId;
    if (dimension === 'project') return row.projectKey;
    if (dimension === 'workspace') return row.workspaceId;
    if (dimension === 'backendMode') return row.backendMode;
    return row.source;
}

function buildBreakdownEntries(
    rows: UsageEventRow[],
    dimension: UsageAnalyticsBreakdownDimension,
    topLimit: number,
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
        current.eventCount += 1;
        current.tokens = addUsageTokens(current.tokens, toEventTokens(row));
        current.cost = addUsageCost(current.cost, toEventCost(row));
        entries.set(key, current);
    }

    return Array.from(entries.values())
        .sort((left, right) => {
            if (right.tokens.total !== left.tokens.total) return right.tokens.total - left.tokens.total;
            if (right.cost.reportedUsd !== left.cost.reportedUsd) return right.cost.reportedUsd - left.cost.reportedUsd;
            if (right.eventCount !== left.eventCount) return right.eventCount - left.eventCount;
            return left.key.localeCompare(right.key);
        })
        .slice(0, topLimit);
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
            providerId: request.filters?.providerIds?.length ? { in: request.filters.providerIds } : undefined,
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
            providerId: true,
            backendMode: true,
            modelId: true,
            projectKey: true,
            workspaceId: true,
            source: true,
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
        },
    });
}

export async function queryUsageAnalytics(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
): Promise<UsageAnalyticsQueryResponse> {
    const rows = await loadUsageEventsForQuery(accountId, request);
    const premiumRows = rows.map(toPremiumEventRow);
    const totals = toUsageTotals(rows);
    const sessionIds = Array.from(
        new Set(
            premiumRows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
        ),
    );
    const messageStats = request.includeMessageStats || request.includeInsights
        ? await loadUsageMessageStatsForQuery(accountId, request, sessionIds)
        : undefined;
    const breakdowns = request.breakdowns?.length
        ? request.breakdowns.reduce<UsageAnalyticsBreakdowns>((acc, dimension) => {
            acc[dimension] = buildBreakdownEntries(rows, dimension, request.topLimit);
            return acc;
        }, {})
        : undefined;

    return {
        v: 1,
        totals,
        series: request.includeSeries ? buildSeries(rows, request.granularity) : undefined,
        breakdowns,
        insights: request.includeInsights ? buildUsageInsights(premiumRows, messageStats ?? { sessionCount: 0, messageCount: 0 }) : undefined,
        activity: request.includeActivity ? buildUsageActivity(premiumRows, request.activityResolution) : undefined,
        leaders: request.includeLeaders ? buildUsageLeaders(premiumRows, request.topLimit) : undefined,
        modelTimeline: request.includeModelTimeline ? buildUsageModelTimeline(premiumRows, request.granularity, request.topLimit) : undefined,
        engineTimeline: request.includeModelTimeline ? buildUsageEngineTimeline(premiumRows, request.granularity, request.topLimit) : undefined,
        messageStats,
        costPresentation: buildUsageCostPresentation(totals.cost, request.costMode),
    };
}
