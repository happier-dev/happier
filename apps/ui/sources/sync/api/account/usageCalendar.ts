import { resolveUsageBucketBounds, resolveUsageCalendarInstant, resolveUsageCalendarDateStart } from '@happier-dev/protocol';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';
const DAY_MS = 86_400_000;
const WEEKS = 53;

export type UsageHeatmapMode = 'daily' | 'weekly' | 'cumulative';

export interface UsageHeatmapCell {
    isoDate: string;
    value: number;
    inRange: boolean;
}

export interface UsageHeatmapColumn {
    cells: UsageHeatmapCell[];
    /** Short month label shown above the column, or null. */
    monthLabel: string | null;
}

export interface UsageHeatmapGrid {
    columns: UsageHeatmapColumn[];
}

export interface UsageDayStripCell {
    isoDate: string;
    value: number;
    isToday: boolean;
    /** 0 = Sunday … 6 = Saturday in the selected calendar. */
    weekday: number;
    dayOfMonth: number;
}

type CalendarRange = Readonly<{ startMs?: number; endMs: number; timeZoneOffsetMinutes: number }>;

/**
 * A GitHub-style contribution grid: `WEEKS` week-columns (oldest→newest) of 7
 * weekday rows (Mon→Sun) ending on the selected calendar's last week.
 * Canonical fixed-offset boundaries. `mode` reshapes the per-day counts:
 *  - daily: the day's own count
 *  - weekly: every cell in a column shows that week's total
 *  - cumulative: running total across the visible window up to that day
 * Exported for unit tests of the range/aggregation logic.
 */
export function buildHeatmapGrid(
    calendarDays: readonly { date: string; eventCount: number }[],
    nowMs: number,
    mode: UsageHeatmapMode,
    weeks: number = WEEKS,
    range?: CalendarRange,
): UsageHeatmapGrid {
    const counts = new Map<string, number>();
    for (const day of calendarDays) {
        counts.set(day.date, (counts.get(day.date) ?? 0) + day.eventCount);
    }

    const offset = range?.timeZoneOffsetMinutes ?? 0;
    const end = resolveUsageBucketBounds('day', range ? range.endMs - 1 : nowMs, offset).bucketStartMs;
    const lastWeekStart = resolveUsageBucketBounds('week', end, offset).bucketStartMs;
    const first = range?.startMs ?? (range ? [...counts.keys()].sort()[0] : undefined);
    const start = typeof first === 'number' ? first : typeof first === 'string'
        ? resolveUsageCalendarDateStart(first, offset) : undefined;
    const firstWeekStart = start === undefined ? lastWeekStart - (weeks - 1) * 7 * DAY_MS
        : resolveUsageBucketBounds('week', start, offset).bucketStartMs;
    const firstDay = start === undefined ? firstWeekStart : resolveUsageBucketBounds('day', start, offset).bucketStartMs;
    const columnCount = Math.max(0, Math.round((lastWeekStart - firstWeekStart) / (7 * DAY_MS)) + 1);

    // Precompute a chronological running total for cumulative mode.
    let running = 0;
    const columns: UsageHeatmapColumn[] = [];
    let previousMonth = -1;

    for (let c = 0; c < columnCount; c += 1) {
        const weekStart = firstWeekStart + c * 7 * DAY_MS;
        let weekTotal = 0;
        const dayMsByRow: number[] = [];
        for (let r = 0; r < 7; r += 1) {
            const dayMs = weekStart + r * DAY_MS;
            dayMsByRow.push(dayMs);
            if (dayMs >= firstDay && dayMs <= end) {
                weekTotal += counts.get(resolveUsageCalendarInstant(dayMs, offset).date) ?? 0;
            }
        }

        const cells: UsageHeatmapCell[] = dayMsByRow.map((dayMs) => {
            const inRange = dayMs >= firstDay && dayMs <= end;
            const iso = resolveUsageCalendarInstant(dayMs, offset).date;
            const dayCount = inRange ? counts.get(iso) ?? 0 : 0;
            if (inRange) running += dayCount;
            let value = dayCount;
            if (mode === 'weekly') value = inRange ? weekTotal : 0;
            else if (mode === 'cumulative') value = inRange ? running : 0;
            return { isoDate: iso, value, inRange };
        });

        // Month label when the column's first day starts a new month.
        const monthOfWeekStart = new Date(weekStart + offset * 60_000).getUTCMonth();
        const monthLabel = monthOfWeekStart !== previousMonth
            ? formatUsageCalendarDate(weekStart, offset, { month: 'short' })
            : null;
        previousMonth = monthOfWeekStart;

        columns.push({ cells, monthLabel });
    }

    return { columns };
}

/**
 * Period-adaptive day strip (D-R3-2): one cell per day, oldest→newest, ending
 * at the selected range's exclusive end (or today for legacy callers). Used for short
 * windows where a 53-week year grid would misrepresent the period.
 */
export function buildDayStrip(
    calendarDays: readonly { date: string; eventCount: number }[],
    nowMs: number,
    dayCount: number,
    range?: CalendarRange,
): UsageDayStripCell[] {
    const counts = new Map<string, number>();
    for (const day of calendarDays) {
        counts.set(day.date, (counts.get(day.date) ?? 0) + day.eventCount);
    }

    const offset = range?.timeZoneOffsetMinutes ?? 0;
    const today = resolveUsageBucketBounds('day', nowMs, offset).bucketStartMs;
    const end = range ? resolveUsageBucketBounds('day', range.endMs - 1, offset).bucketStartMs : today;
    const cells: UsageDayStripCell[] = [];
    for (let i = dayCount - 1; i >= 0; i -= 1) {
        const dayMs = end - i * DAY_MS;
        const date = new Date(dayMs + offset * 60_000);
        const iso = resolveUsageCalendarInstant(dayMs, offset).date;
        cells.push({
            isoDate: iso,
            value: counts.get(iso) ?? 0,
            isToday: dayMs === today,
            weekday: date.getUTCDay(),
            dayOfMonth: date.getUTCDate(),
        });
    }
    return cells;
}
