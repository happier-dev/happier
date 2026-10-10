import type {
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
} from "@happier-dev/protocol";

import type { UsageMessageCounts } from "./loadUsageMessageStatsForQuery";
import type { ScopedUsageContribution } from "./resolveScopedUsageContributions";
import { buildUsageLeaderList, resolveUsageBucketBounds as resolveBucketBounds, resolveUsageCalendarInstant, resolveUsageContributionDimensionKey, type UsageLeaderDimension } from "@happier-dev/protocol";
import { resolveUsageCostMode } from "./resolveUsageCostMode";

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
): UsageAnalyticsLeader[] | undefined {
    return buildUsageLeaderList(rows.map(row => ({ ...row, eventCount: row.contributingEventIds.length })),
        dimension, topLimit, resolveUsageCostMode(requestedMode));
}

export function buildUsageLeaders(
    rows: UsageEventRow[],
    topLimit: number,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
): UsageLeaderGroup | undefined {
    const leaders: UsageLeaderGroup = {
        agents: buildLeaderList(rows, topLimit, "agent", requestedMode),
        models: buildLeaderList(rows, topLimit, "model", requestedMode),
        sessions: buildLeaderList(rows, topLimit, "session", requestedMode),
        projects: buildLeaderList(rows, topLimit, "project", requestedMode),
        workspaces: buildLeaderList(rows, topLimit, "workspace", requestedMode),
        engines: buildLeaderList(rows, topLimit, "engine", requestedMode),
    };

    return Object.values(leaders).some((value) => value && value.length > 0) ? leaders : undefined;
}

export function buildUsageActivity(
    rows: UsageEventRow[],
    resolution: UsageAnalyticsQueryRequest["activityResolution"],
    timeZoneOffsetMinutes = 0,
): UsageActivity | undefined {
    const calendarDays = new Map<string, number>();
    const weekdayHourBuckets = new Map<string, { weekday: number; hour: number; eventCount: number }>();

    for (const row of rows) {
        const dateKey = getLocalBucketKey(row.observedAt, "day", timeZoneOffsetMinutes);
        calendarDays.set(dateKey, (calendarDays.get(dateKey) ?? 0) + row.contributingEventIds.length);

        const { weekday, hour } = resolveUsageCalendarInstant(row.observedAt.getTime(), timeZoneOffsetMinutes);
        const weekdayHourKey = `${weekday}:${hour}`;
        const currentBucket = weekdayHourBuckets.get(weekdayHourKey) ?? { weekday, hour, eventCount: 0 };
        currentBucket.eventCount += row.contributingEventIds.length;
        weekdayHourBuckets.set(weekdayHourKey, currentBucket);
    }

    if (rows.length === 0) {
        return undefined;
    }

    return {
        calendarDays:
            resolution === "weekdayHour"
                ? undefined
                : Array.from(calendarDays.entries())
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([date, eventCount]) => ({ date, eventCount })),
        weekdayHourBuckets:
            resolution === "calendar"
                ? undefined
                : Array.from(weekdayHourBuckets.values()).sort((left, right) => {
                    if (left.weekday !== right.weekday) {
                        return left.weekday - right.weekday;
                    }
                    return left.hour - right.hour;
                }),
    };
}

function countLongestStreak(dayKeys: string[]): number {
    if (dayKeys.length === 0) {
        return 0;
    }

    const timestamps = dayKeys
        .map((key) => new Date(`${key}T00:00:00.000Z`).getTime())
        .sort((left, right) => left - right);

    let longest = 1;
    let current = 1;

    for (let index = 1; index < timestamps.length; index += 1) {
        const previous = timestamps[index - 1];
        const next = timestamps[index];
        if (next - previous === 24 * 60 * 60 * 1000) {
            current += 1;
            longest = Math.max(longest, current);
            continue;
        }
        if (next !== previous) {
            current = 1;
        }
    }

    return longest;
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

function countFavoriteModelChanges(rows: UsageEventRow[]): number {
    let previous: string | null = null;
    let changes = 0;

    for (const row of rows) {
        const modelId = row.modelId;
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
        if (row.modelId) {
            models.set(row.modelId, (models.get(row.modelId) ?? 0) + row.tokens.total);
        }
        const monthKey = getLocalBucketKey(row.observedAt, "month", timeZoneOffsetMinutes);
        months.set(monthKey, (months.get(monthKey) ?? 0) + row.tokens.total);
        days.set(dateKey, (days.get(dateKey) ?? 0) + row.tokens.total);
        const hourKey = getLocalBucketKey(row.observedAt, "hour", timeZoneOffsetMinutes);
        hours.set(hourKey, (hours.get(hourKey) ?? 0) + row.tokens.total);
        cacheSavingsUsd += row.cost.breakdown?.cacheSavingsUsd ?? 0;
    }

    return {
        activeDays: activeDays.size,
        longestStreakDays: countLongestStreak(Array.from(activeDays.values())),
        sessionsUsed: sessions.size,
        messagesUsed: messageCounts.messageCount,
        modelsTried: models.size,
        favoriteModel: buildTopKeyedLabel(models),
        favoriteModelChangeCount: countFavoriteModelChanges(rows),
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
            leaders: buildLeaderList(bucket.rows, topLimit, dimension, requestedMode) ?? [],
        }));
}

export function buildUsageModelTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    timeZoneOffsetMinutes = 0,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, "model", timeZoneOffsetMinutes, requestedMode);
}

export function buildUsageEngineTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    timeZoneOffsetMinutes = 0,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, "engine", timeZoneOffsetMinutes, requestedMode);
}
