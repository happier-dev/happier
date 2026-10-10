import { resolveUsageBucketBounds, type UsageAnalyticsCoverage, type UsageAnalyticsGranularity } from '@happier-dev/protocol';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { getPreferredLanguage, t } from '@/text';

/** Shared presentation semantics from the admitted query: fixed offsets and exclusive ends. */
export type UsageCalendarRange = Readonly<{
    startMs?: number;
    endMs: number;
    granularity: UsageAnalyticsGranularity;
    timeZoneOffsetMinutes: number;
}>;

/** An open range is drawn only as far as the producer witnessed it, never up to the viewer's clock. */
export function resolveUsageShownCalendarRange(query: UsageQuery, coverage?: UsageAnalyticsCoverage): UsageCalendarRange | null {
    const endMs = query.period.endMs ?? coverage?.range.endMs;
    if (endMs === undefined) return null;
    const startMs = query.period.startMs ?? coverage?.range.startMs;
    return { ...(startMs !== undefined ? { startMs } : {}), endMs,
        granularity: query.granularity, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes };
}

/** Missing counts are zero only where the producer proves complete accounting for that interval. */
export function usageMissingBucketValue(startMs: number, range: UsageCalendarRange, coverage?: UsageAnalyticsCoverage): 0 | null {
    if (coverage?.range.complete !== true) return null;
    const endMs = resolveUsageBucketBounds(range.granularity, startMs, range.timeZoneOffsetMinutes).bucketEndMs;
    const countedStart = Math.max(startMs, range.startMs ?? startMs);
    const countedEnd = Math.min(endMs, range.endMs);
    return countedStart < countedEnd && coverage.range.startMs !== undefined && coverage.range.endMs !== undefined
        && coverage.range.startMs <= countedStart && coverage.range.endMs >= countedEnd ? 0 : null;
}

export function formatUsageCalendarDate(timestampMs: number, timeZoneOffsetMinutes: number,
    options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
    locales?: Intl.LocalesArgument): string {
    return formatWithCachedDateTimeFormatter(timestampMs + timeZoneOffsetMinutes * 60_000, locales ?? getPreferredLanguage(), { ...options, timeZone: 'UTC' });
}

/** Exact selected dates; a named rolling preset cannot be recovered from a range's duration. */
export function formatUsageCalendarPeriod(period: Readonly<{ startMs?: number; endMs?: number; timeZoneOffsetMinutes?: number }>,
    locales?: Intl.LocalesArgument): string {
    const offset = period.timeZoneOffsetMinutes ?? 0;
    if (period.startMs === undefined) return period.endMs === undefined ? t('usage.allTime')
        : `${t('usage.allTime')} – ${formatUsageCalendarDate(period.endMs - 1, offset, undefined, locales)}`;
    const start = formatUsageCalendarDate(period.startMs, offset, undefined, locales);
    if (period.endMs === undefined) return `${start} – ${t('usage.today')}`;
    const end = formatUsageCalendarDate(Math.max(period.startMs, period.endMs - 1), offset, undefined, locales);
    return start === end ? start : `${start} – ${end}`;
}
