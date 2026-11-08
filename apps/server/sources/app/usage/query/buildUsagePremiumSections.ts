import type { UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

import type { UsageMessageCounts } from "./loadUsageMessageStatsForQuery";
import type { ScopedUsageContribution } from "./resolveScopedUsageContributions";
import { resolveUsageContributionSourceContext } from "./resolveScopedUsageContributions";
import { buildUsageLeaderList, selectUsageLeaderTokenFrontier, type UsageLeaderDimension } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { resolveUsageBucketBounds as resolveBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { resolveUsageContributionDimensionKey } from '@happier-dev/protocol/usage/usageCostFacts';
import { resolveUsageCostMode } from "./resolveUsageCostMode";
import { resolveUsageDayStreaks } from '@happier-dev/protocol/usage/usageActivitySummary';
import { canonicalUsageModelPriceId } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { projectUsageRecordedActivity } from '@happier-dev/protocol/usage/usageActivityProjectionFacts';

type UsageEventRow = Pick<
    ScopedUsageContribution,
    | "sessionId"
    | "observedAt"
    | "agentId"
    | "backendMode"
    | "modelId"
    | "projectKey"
    | "workspaceId"
    | "machineId"
    | "source"
    | "metadata"
    | "accountingEvidence"
    | "tokens"
    | "cost"
    | "contributingEventIds"
>;

type UsageLeaderGroup = NonNullable<UsageAnalyticsQueryResponse["leaders"]>;
type UsageAnalyticsLeader = NonNullable<NonNullable<UsageLeaderGroup["agents"]>[number]>;
type UsageInsights = NonNullable<UsageAnalyticsQueryResponse["insights"]>;
type UsageActivity = NonNullable<UsageAnalyticsQueryResponse["activity"]>;
type UsageTimeline = NonNullable<UsageAnalyticsQueryResponse["modelTimeline"]>;

const MINUTES_TO_MILLISECONDS = 60_000;

function getLocalBucketKey(
    value: Date,
    granularity: "hour" | "day" | "month",
    timeZoneOffsetMinutes: number,
): string {
    const { bucketStartMs } = resolveBucketBounds(granularity, value.getTime(), timeZoneOffsetMinutes);
    const localBucketStart = new Date(bucketStartMs + timeZoneOffsetMinutes * MINUTES_TO_MILLISECONDS);
    if (granularity === "month") {
        return localBucketStart.toISOString().slice(0, 7);
    }
    if (granularity === "hour") {
        return `${String(localBucketStart.getUTCHours()).padStart(2, "0")}:00`;
    }
    return localBucketStart.toISOString().slice(0, 10);
}

export function deriveEngineKey(row: UsageEventRow): string | null {
    return resolveUsageContributionDimensionKey(row, "engine");
}

function buildLeaderList(
    rows: UsageEventRow[],
    topLimit: number,
    dimension: UsageLeaderDimension,
    requestedMode: UsageAnalyticsQueryRequest["costMode"],
    includeSources = false,
    deferPricing = false,
): UsageAnalyticsLeader[] | undefined {
    const admitted = rows.map(row => ({ ...row, eventCount: row.contributingEventIds.length,
        sourceContext: resolveUsageContributionSourceContext(row) }));
    if (deferPricing) {
        const candidates = selectUsageLeaderTokenFrontier(admitted, dimension, topLimit);
        // The pricing owner rebuilds these leaders from the complete bucket.
        // Only membership/count and labels survive this preparation. Money is
        // needed here solely when a frontier tie changes witnessed membership.
        if (candidates.length <= topLimit) return candidates.map(candidate => candidate.value);
    }
    return buildUsageLeaderList(admitted, dimension, topLimit, resolveUsageCostMode(requestedMode), undefined,
        includeSources && !deferPricing);
}

export function buildUsageActivity(
    rows: readonly Pick<UsageEventRow, 'observedAt' | 'contributingEventIds'>[],
    resolution: UsageAnalyticsQueryRequest["activityResolution"],
    timeZoneOffsetMinutes = 0,
): UsageActivity | undefined {
    return projectUsageRecordedActivity(rows.map(row => ({ observedAtMs: row.observedAt.getTime(),
        eventCount: row.contributingEventIds.length })), resolution, timeZoneOffsetMinutes);
}

function buildTopKeyedLabel(values: Map<string, number>): { key: string; label: string } | undefined {
    if (values.size === 0) {
        return undefined;
    }

    return Array.from(values.entries())
        .sort((left, right) => {
            if (right[1] !== left[1]) {
                return right[1] - left[1];
            }
            return left[0].localeCompare(right[0]);
        })
        .map(([key]) => ({ key, label: key }))[0];
}

function countFavoriteModelChanges(rows: readonly { modelId: string | null }[]): number {
    let previous: string | null = null;
    let changes = 0;

    for (const row of rows) {
        const modelId = canonicalUsageModelPriceId(row.modelId);
        if (!modelId) {
            continue;
        }
        if (!previous) {
            previous = modelId;
            continue;
        }
        if (modelId !== previous) {
            changes += 1;
            previous = modelId;
        }
    }

    return changes;
}

export function buildUsageInsights(
    rows: UsageEventRow[],
    messageCounts: UsageMessageCounts,
    timeZoneOffsetMinutes = 0,
    modelOrderRows: readonly { modelId: string | null }[] = rows,
): UsageInsights {
    const activeDays = new Set<string>();
    const sessions = new Set<string>();
    const models = new Map<string, number>();
    const months = new Map<string, number>();
    const days = new Map<string, number>();
    const hours = new Map<string, number>();
    let cacheSavingsUsd = 0;

    for (const row of rows) {
        const dateKey = getLocalBucketKey(row.observedAt, "day", timeZoneOffsetMinutes);
        activeDays.add(dateKey);
        if (row.sessionId) {
            sessions.add(row.sessionId);
        }
        const modelId = resolveUsageContributionDimensionKey(row, 'model');
        if (modelId) {
            models.set(modelId, (models.get(modelId) ?? 0) + row.tokens.total);
        }
        const monthKey = getLocalBucketKey(row.observedAt, "month", timeZoneOffsetMinutes);
        months.set(monthKey, (months.get(monthKey) ?? 0) + row.tokens.total);
        days.set(dateKey, (days.get(dateKey) ?? 0) + row.tokens.total);
        const hourKey = getLocalBucketKey(row.observedAt, "hour", timeZoneOffsetMinutes);
        hours.set(hourKey, (hours.get(hourKey) ?? 0) + row.tokens.total);
        cacheSavingsUsd += row.cost.breakdown?.cacheSavingsUsd ?? 0;
    }

    const daySummary = resolveUsageDayStreaks({ days: [...activeDays].map(date => ({ date, eventCount: 1 })),
        referenceMs: Date.now(), timeZoneOffsetMinutes });
    return {
        activeDays: daySummary.activeDays ?? 0,
        longestStreakDays: daySummary.longestStreakDays ?? 0,
        sessionsUsed: sessions.size,
        messagesUsed: messageCounts.messageCount,
        modelsTried: models.size,
        favoriteModel: buildTopKeyedLabel(models),
        favoriteModelChangeCount: countFavoriteModelChanges(modelOrderRows),
        busiestMonth: buildTopKeyedLabel(months),
        busiestDay: buildTopKeyedLabel(days),
        busiestHour: buildTopKeyedLabel(hours),
        ...(cacheSavingsUsd > 0 ? { cacheSavingsUsd } : {}),
    };
}

function buildTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    dimension: UsageLeaderDimension,
    timeZoneOffsetMinutes: number,
    requestedMode: UsageAnalyticsQueryRequest["costMode"],
    deferPricing = false,
): UsageTimeline | undefined {
    const buckets = new Map<number, {
        bucketStartMs: number;
        bucketEndMs: number;
        rows: UsageEventRow[];
    }>();

    for (const row of rows) {
        const bounds = resolveBucketBounds(granularity, row.observedAt.getTime(), timeZoneOffsetMinutes);
        const bucket = buckets.get(bounds.bucketStartMs) ?? {
            bucketStartMs: bounds.bucketStartMs,
            bucketEndMs: bounds.bucketEndMs,
            rows: [],
        };
        bucket.rows.push(row);
        buckets.set(bounds.bucketStartMs, bucket);
    }

    if (buckets.size === 0) {
        return undefined;
    }

    return Array.from(buckets.values())
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
        .map((bucket) => ({
            bucketStartMs: bucket.bucketStartMs,
            bucketEndMs: bucket.bucketEndMs,
            leaders: buildLeaderList(bucket.rows, topLimit, dimension, requestedMode, true, deferPricing) ?? [],
        }));
}

export function buildUsageModelTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    timeZoneOffsetMinutes = 0,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
    deferPricing = false,
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, "model", timeZoneOffsetMinutes, requestedMode, deferPricing);
}

export function buildUsageEngineTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    timeZoneOffsetMinutes = 0,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
    deferPricing = false,
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, "engine", timeZoneOffsetMinutes, requestedMode, deferPricing);
}
