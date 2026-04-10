import type {
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";

import type { UsageMessageStats } from "./loadUsageMessageStatsForQuery";
import { resolveEffectiveUsageCostUsd, resolveUsageCostMode, resolveUsageCostPresentationSource } from "./resolveUsageCostMode";

type UsageEventRow = {
    sessionId: string | null;
    observedAt: Date;
    providerId: string | null;
    backendMode: string | null;
    modelId: string | null;
    projectKey: string | null;
    workspaceId: string | null;
    source: string | null;
    tokens: UsageObservationTokens;
    cost: UsageObservationCost;
};

type UsageLeaderGroup = NonNullable<UsageAnalyticsQueryResponse["leaders"]>;
type UsageAnalyticsLeader = NonNullable<NonNullable<UsageLeaderGroup["providers"]>[number]>;
type UsageInsights = NonNullable<UsageAnalyticsQueryResponse["insights"]>;
type UsageActivity = NonNullable<UsageAnalyticsQueryResponse["activity"]>;
type UsageTimeline = NonNullable<UsageAnalyticsQueryResponse["modelTimeline"]>;

function getUtcDateKey(value: Date): string {
    return value.toISOString().slice(0, 10);
}

function getUtcMonthKey(value: Date): string {
    return value.toISOString().slice(0, 7);
}

function getUtcHourKey(value: Date): string {
    return `${String(value.getUTCHours()).padStart(2, "0")}:00`;
}

function deriveEngineKey(row: UsageEventRow): string | null {
    if (!row.providerId) {
        return null;
    }
    if (!row.backendMode) {
        return row.providerId;
    }
    return `${row.providerId}:${row.backendMode}`;
}

function resolveBucketBounds(observedAt: Date, granularity: UsageAnalyticsQueryRequest["granularity"]) {
    const value = new Date(observedAt);
    let start: Date;
    let end: Date;

    if (granularity === "hour") {
        start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours(), 0, 0, 0));
        end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours() + 1, 0, 0, 0));
    } else if (granularity === "week") {
        const day = value.getUTCDay();
        const offset = day === 0 ? 6 : day - 1;
        start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() - offset, 0, 0, 0, 0));
        end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + (7 - offset), 0, 0, 0, 0));
    } else if (granularity === "month") {
        start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
        end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    } else {
        start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0));
        end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1, 0, 0, 0, 0));
    }

    return {
        bucketStartMs: start.getTime(),
        bucketEndMs: end.getTime(),
    };
}

function buildLeaderList(
    rows: UsageEventRow[],
    topLimit: number,
    resolveKey: (row: UsageEventRow) => string | null,
): UsageAnalyticsLeader[] | undefined {
    const grouped = new Map<string, UsageAnalyticsLeader & { totalTokens: number; effectiveUsd: number }>();
    const mode = resolveUsageCostMode(undefined);

    for (const row of rows) {
        const key = resolveKey(row);
        if (!key) {
            continue;
        }
        const existing = grouped.get(key) ?? {
            key,
            label: key,
            eventCount: 0,
            totalTokens: 0,
            effectiveUsd: 0,
        };
        existing.eventCount += 1;
        existing.totalTokens += row.tokens.total;
        existing.effectiveUsd += resolveEffectiveUsageCostUsd(row.cost, mode);
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
        .map(({ totalTokens: _totalTokens, effectiveUsd: _effectiveUsd, ...leader }) => leader);
}

export function buildUsageLeaders(rows: UsageEventRow[], topLimit: number): UsageLeaderGroup | undefined {
    const leaders: UsageLeaderGroup = {
        providers: buildLeaderList(rows, topLimit, (row) => row.providerId),
        models: buildLeaderList(rows, topLimit, (row) => row.modelId),
        sessions: buildLeaderList(rows, topLimit, (row) => row.sessionId),
        projects: buildLeaderList(rows, topLimit, (row) => row.projectKey),
        workspaces: buildLeaderList(rows, topLimit, (row) => row.workspaceId),
        engines: buildLeaderList(rows, topLimit, deriveEngineKey),
    };

    return Object.values(leaders).some((value) => value && value.length > 0) ? leaders : undefined;
}

export function buildUsageActivity(
    rows: UsageEventRow[],
    resolution: UsageAnalyticsQueryRequest["activityResolution"],
): UsageActivity | undefined {
    const calendarDays = new Map<string, number>();
    const weekdayHourBuckets = new Map<string, { weekday: number; hour: number; eventCount: number }>();

    for (const row of rows) {
        const dateKey = getUtcDateKey(row.observedAt);
        calendarDays.set(dateKey, (calendarDays.get(dateKey) ?? 0) + 1);

        const weekday = row.observedAt.getUTCDay();
        const hour = row.observedAt.getUTCHours();
        const weekdayHourKey = `${weekday}:${hour}`;
        const currentBucket = weekdayHourBuckets.get(weekdayHourKey) ?? { weekday, hour, eventCount: 0 };
        currentBucket.eventCount += 1;
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

export function buildUsageInsights(rows: UsageEventRow[], messageStats: UsageMessageStats): UsageInsights {
    const activeDays = new Set<string>();
    const sessions = new Set<string>();
    const models = new Map<string, number>();
    const months = new Map<string, number>();
    const days = new Map<string, number>();
    const hours = new Map<string, number>();

    for (const row of rows) {
        const dateKey = getUtcDateKey(row.observedAt);
        activeDays.add(dateKey);
        if (row.sessionId) {
            sessions.add(row.sessionId);
        }
        if (row.modelId) {
            models.set(row.modelId, (models.get(row.modelId) ?? 0) + row.tokens.total);
        }
        const monthKey = getUtcMonthKey(row.observedAt);
        months.set(monthKey, (months.get(monthKey) ?? 0) + row.tokens.total);
        days.set(dateKey, (days.get(dateKey) ?? 0) + row.tokens.total);
        const hourKey = getUtcHourKey(row.observedAt);
        hours.set(hourKey, (hours.get(hourKey) ?? 0) + row.tokens.total);
    }

    return {
        activeDays: activeDays.size,
        longestStreakDays: countLongestStreak(Array.from(activeDays.values())),
        sessionsUsed: sessions.size,
        messagesUsed: messageStats.messageCount,
        modelsTried: models.size,
        favoriteModel: buildTopKeyedLabel(models),
        favoriteModelChangeCount: countFavoriteModelChanges(rows),
        busiestMonth: buildTopKeyedLabel(months),
        busiestDay: buildTopKeyedLabel(days),
        busiestHour: buildTopKeyedLabel(hours),
    };
}

function buildTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
    resolveKey: (row: UsageEventRow) => string | null,
): UsageTimeline | undefined {
    const buckets = new Map<number, { bucketStartMs: number; bucketEndMs: number; leaders: Map<string, number> }>();

    for (const row of rows) {
        const key = resolveKey(row);
        if (!key) {
            continue;
        }
        const bounds = resolveBucketBounds(row.observedAt, granularity);
        const bucket = buckets.get(bounds.bucketStartMs) ?? {
            bucketStartMs: bounds.bucketStartMs,
            bucketEndMs: bounds.bucketEndMs,
            leaders: new Map<string, number>(),
        };
        bucket.leaders.set(key, (bucket.leaders.get(key) ?? 0) + row.tokens.total);
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
                    if (right[1] !== left[1]) {
                        return right[1] - left[1];
                    }
                    return left[0].localeCompare(right[0]);
                })
                .slice(0, topLimit)
                .map(([key, _value]) => ({ key, label: key, eventCount: 1 })),
        }));
}

export function buildUsageModelTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, (row) => row.modelId);
}

export function buildUsageEngineTimeline(
    rows: UsageEventRow[],
    granularity: UsageAnalyticsQueryRequest["granularity"],
    topLimit: number,
): UsageTimeline | undefined {
    return buildTimeline(rows, granularity, topLimit, deriveEngineKey);
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
