import type { UsageAnalyticsGranularity } from "@happier-dev/protocol";

const MINUTES_TO_MILLISECONDS = 60_000;

export interface UsageBucketBounds {
    bucketStartMs: number;
    bucketEndMs: number;
}

export function resolveBucketBounds(
    granularity: UsageAnalyticsGranularity,
    timestampMs: number,
    timeZoneOffsetMinutes: number,
): UsageBucketBounds {
    const offsetMs = timeZoneOffsetMinutes * MINUTES_TO_MILLISECONDS;
    const localValue = new Date(timestampMs + offsetMs);
    const year = localValue.getUTCFullYear();
    const month = localValue.getUTCMonth();
    const date = localValue.getUTCDate();
    const hour = localValue.getUTCHours();

    let localStartMs: number;
    let localEndMs: number;
    if (granularity === "hour") {
        localStartMs = Date.UTC(year, month, date, hour, 0, 0, 0);
        localEndMs = Date.UTC(year, month, date, hour + 1, 0, 0, 0);
    } else if (granularity === "week") {
        const weekday = localValue.getUTCDay();
        const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
        localStartMs = Date.UTC(year, month, date - daysSinceMonday, 0, 0, 0, 0);
        localEndMs = Date.UTC(year, month, date + (7 - daysSinceMonday), 0, 0, 0, 0);
    } else if (granularity === "month") {
        localStartMs = Date.UTC(year, month, 1, 0, 0, 0, 0);
        localEndMs = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
    } else {
        localStartMs = Date.UTC(year, month, date, 0, 0, 0, 0);
        localEndMs = Date.UTC(year, month, date + 1, 0, 0, 0, 0);
    }

    return {
        bucketStartMs: localStartMs - offsetMs,
        bucketEndMs: localEndMs - offsetMs,
    };
}
