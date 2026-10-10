import type { UsageAnalyticsGranularity } from './usageAnalyticsContracts.js';

const MINUTES_TO_MILLISECONDS = 60_000;

export interface UsageBucketBounds {
    bucketStartMs: number;
    bucketEndMs: number;
}

/** Query offsets are minutes east of UTC, fixed for the entire requested range.
 * Weeks begin Monday. This deliberately does not reconstruct historical IANA offsets.
 */
export function resolveUsageBucketBounds(
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

/** Calendar labels and weekday/hour cells use the same offset as their bucket. */
export function resolveUsageCalendarInstant(timestampMs: number, timeZoneOffsetMinutes: number) {
    const localValue = new Date(timestampMs + timeZoneOffsetMinutes * MINUTES_TO_MILLISECONDS);
    return {
        date: localValue.toISOString().slice(0, 10),
        weekday: localValue.getUTCDay(),
        hour: localValue.getUTCHours(),
        ...resolveUsageBucketBounds('day', timestampMs, timeZoneOffsetMinutes),
    };
}

/** Convert an admitted local calendar date back to the query's actual bucket instant. */
export function resolveUsageCalendarDateStart(date: string, timeZoneOffsetMinutes: number): number {
    const timestampMs = Date.parse(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestampMs)
        || new Date(timestampMs).toISOString().slice(0, 10) !== date) {
        throw new RangeError('Invalid usage calendar date');
    }
    return timestampMs - timeZoneOffsetMinutes * MINUTES_TO_MILLISECONDS;
}
