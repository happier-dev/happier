import type {
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";

import type { UsageMessageCounts } from "./loadUsageMessageStatsForQuery";
import type { ScopedUsageContribution } from "./resolveScopedUsageContributions";
import { resolveBucketBounds } from "./bucketBounds";
import { addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from "../usageMetrics";
import { addUsageCostForMode, resolveEffectiveUsageCostUsd, resolveUsageCostMode, resolveUsageCostPresentationSource, withEffectiveUsageCost } from "./resolveUsageCostMode";

type UsageEventRow = Pick<
    ScopedUsageContribution,
    | "sessionId"
    | "observedAt"
    | "agentId"
    | "backendMode"
    | "modelId"
    | "projectKey"
    | "workspaceId"
    | "source"
    | "tokens"
    | "cost"
    | "contributingEventIds"
>;

type UsageLeaderGroup = NonNullable<UsageAnalyticsQueryResponse["leaders"]>;
type UsageAnalyticsLeader = NonNullable<NonNullable<UsageLeaderGroup["agents"]>[number]>;
type UsageAnalyticsLeaderAggregate = UsageAnalyticsLeader & {
    tokens: UsageObservationTokens;
    cost: UsageObservationCost;
    totalTokens: number;
    effectiveUsd: number;
};
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

function deriveEngineKey(row: UsageEventRow): string | null {
    if (!row.agentId) {
        return null;
    }
    if (!row.backendMode) {
        return row.agentId;
    }
    return `${row.agentId}:${row.backendMode}`;
}

function buildLeaderList(
    rows: UsageEventRow[],
    topLimit: number,
    resolveKey: (row: UsageEventRow) => string | null,
    requestedMode: UsageAnalyticsQueryRequest["costMode"],
): UsageAnalyticsLeader[] | undefined {
    const grouped = new Map<string, UsageAnalyticsLeaderAggregate>();
    const mode = resolveUsageCostMode(requestedMode);

    for (const row of rows) {
        const key = resolveKey(row);
        if (!key) {
            continue;
        }
        const existing = grouped.get(key) ?? {
            key,
            label: key,
            eventCount: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
            totalTokens: 0,
            effectiveUsd: 0,
        } satisfies UsageAnalyticsLeaderAggregate;
        existing.eventCount += row.contributingEventIds.length;
        existing.totalTokens += row.tokens.total;
        existing.effectiveUsd += resolveEffectiveUsageCostUsd(row.cost, mode);
        existing.tokens = addUsageTokens(existing.tokens, row.tokens);
        existing.cost = addUsageCostForMode(existing.cost, row.cost, mode);
        grouped.set(key, existing);
    }

    if (grouped.size === 0) {
        return undefined;
    }

    return Array.from(grouped.values())
        .sort((left, right) => {
            if (right.totalTokens !== left.totalTokens) {
                return right.totalTokens - left.totalTokens;
            }
            if (right.effectiveUsd !== left.effectiveUsd) {
                return right.effectiveUsd - left.effectiveUsd;
            }
            if (right.eventCount !== left.eventCount) {
                return right.eventCount - left.eventCount;
            }
            return left.key.localeCompare(right.key);
        })
        .slice(0, topLimit)
        .map(({ totalTokens: _totalTokens, effectiveUsd: _effectiveUsd, ...leader }) => ({
            ...leader,
            cost: withEffectiveUsageCost(leader.cost, mode),
        }));
}

export function buildUsageLeaders(
    rows: UsageEventRow[],
    topLimit: number,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
): UsageLeaderGroup | undefined {
    const leaders: UsageLeaderGroup = {
        agents: buildLeaderList(rows, topLimit, (row) => row.agentId, requestedMode),
        models: buildLeaderList(rows, topLimit, (row) => row.modelId, requestedMode),
        sessions: buildLeaderList(rows, topLimit, (row) => row.sessionId, requestedMode),
        projects: buildLeaderList(rows, topLimit, (row) => row.projectKey, requestedMode),
        workspaces: buildLeaderList(rows, topLimit, (row) => row.workspaceId, requestedMode),
        engines: buildLeaderList(rows, topLimit, deriveEngineKey, requestedMode),
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

        const localObservedAt = new Date(row.observedAt.getTime() + timeZoneOffsetMinutes * MINUTES_TO_MILLISECONDS);
        const weekday = localObservedAt.getUTCDay();
        const hour = localObservedAt.getUTCHours();
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
    resolveKey: (row: UsageEventRow) => string | null,
    timeZoneOffsetMinutes: number,
    requestedMode: UsageAnalyticsQueryRequest["costMode"],
): UsageTimeline | undefined {
    const mode = resolveUsageCostMode(requestedMode);
    const buckets = new Map<number, {
        bucketStartMs: number;
        bucketEndMs: number;
        leaders: Map<string, UsageAnalyticsLeaderAggregate>;
    }>();

    for (const row of rows) {
        const key = resolveKey(row);
        if (!key) {
            continue;
        }
        const bounds = resolveBucketBounds(granularity, row.observedAt.getTime(), timeZoneOffsetMinutes);
        const bucket = buckets.get(bounds.bucketStartMs) ?? {
            bucketStartMs: bounds.bucketStartMs,
            bucketEndMs: bounds.bucketEndMs,
            leaders: new Map<string, UsageAnalyticsLeaderAggregate>(),
        };
        const existing = bucket.leaders.get(key) ?? {
            key,
            label: key,
            eventCount: 0,
            totalTokens: 0,
            effectiveUsd: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
        } satisfies UsageAnalyticsLeaderAggregate;
        existing.eventCount += row.contributingEventIds.length;
        existing.totalTokens += row.tokens.total;
        existing.effectiveUsd += resolveEffectiveUsageCostUsd(row.cost, mode);
        existing.tokens = addUsageTokens(existing.tokens, row.tokens);
        existing.cost = addUsageCostForMode(existing.cost, row.cost, mode);
        bucket.leaders.set(key, existing);
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
            leaders: Array.from(bucket.leaders.entries())
                .sort((left, right) => {
                    if (right[1].totalTokens !== left[1].totalTokens) {
                        return right[1].totalTokens - left[1].totalTokens;
                    }
                    if (right[1].effectiveUsd !== left[1].effectiveUsd) {
                        return right[1].effectiveUsd - left[1].effectiveUsd;
                    }
                    if (right[1].eventCount !== left[1].eventCount) {
                        return right[1].eventCount - left[1].eventCount;
                    }
                    return left[0].localeCompare(right[0]);
                })
                .slice(0, topLimit)
                .map(([, leader]) => ({
                    key: leader.key,
                    label: leader.label,
                    eventCount: leader.eventCount,
                    tokens: leader.tokens,
                    cost: withEffectiveUsageCost(leader.cost, mode),
                })),
        }));
}

export function buildUsageModelTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    timeZoneOffsetMinutes = 0,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, (row) => row.modelId, timeZoneOffsetMinutes, requestedMode);
}

export function buildUsageEngineTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    timeZoneOffsetMinutes = 0,
    requestedMode?: UsageAnalyticsQueryRequest["costMode"],
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, deriveEngineKey, timeZoneOffsetMinutes, requestedMode);
}

export function buildUsageCostPresentation(
    totalsCost: UsageObservationCost,
    requestedMode: UsageAnalyticsQueryRequest["costMode"],
): NonNullable<UsageAnalyticsQueryResponse["costPresentation"]> {
    const mode = resolveUsageCostMode(requestedMode);
    return {
        mode,
        effectiveUsd: resolveEffectiveUsageCostUsd(totalsCost, mode),
        currency: totalsCost.currency,
        source: resolveUsageCostPresentationSource(totalsCost, mode),
    };
}
