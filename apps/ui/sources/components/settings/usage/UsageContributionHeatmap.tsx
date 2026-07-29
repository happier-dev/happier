import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ChartTooltip, HorizontalChartFrame, resolveHeatmapColor, useHorizontalChartViewport } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { usageSignatureAccent } from './usageAccent';

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
    /** 0 = Sunday … 6 = Saturday (UTC). */
    weekday: number;
    dayOfMonth: number;
}

function isoFromMs(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function todayUtcMs(nowMs: number): number {
    const now = new Date(nowMs);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const MONTH_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short' });
const WEEKDAY_NARROW = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });

/**
 * A GitHub-style contribution grid: `WEEKS` week-columns (oldest→newest) of 7
 * weekday rows (Sun→Sat) ending on the week containing `nowMs`. Deterministic
 * UTC boundaries. `mode` reshapes the per-day counts:
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
): UsageHeatmapGrid {
    const counts = new Map<string, number>();
    for (const day of calendarDays) {
        counts.set(day.date, (counts.get(day.date) ?? 0) + day.eventCount);
    }

    const today = todayUtcMs(nowMs);
    const weekdayOfToday = new Date(today).getUTCDay();
    const lastWeekStart = today - weekdayOfToday * DAY_MS;
    const firstWeekStart = lastWeekStart - (weeks - 1) * 7 * DAY_MS;

    // Precompute a chronological running total for cumulative mode.
    let running = 0;
    const columns: UsageHeatmapColumn[] = [];
    let previousMonth = -1;

    for (let c = 0; c < weeks; c += 1) {
        const weekStart = firstWeekStart + c * 7 * DAY_MS;
        let weekTotal = 0;
        const dayMsByRow: number[] = [];
        for (let r = 0; r < 7; r += 1) {
            const dayMs = weekStart + r * DAY_MS;
            dayMsByRow.push(dayMs);
            if (dayMs <= today) {
                weekTotal += counts.get(isoFromMs(dayMs)) ?? 0;
            }
        }

        const cells: UsageHeatmapCell[] = dayMsByRow.map((dayMs) => {
            const inRange = dayMs <= today;
            const iso = isoFromMs(dayMs);
            const dayCount = inRange ? counts.get(iso) ?? 0 : 0;
            if (inRange) running += dayCount;
            let value = dayCount;
            if (mode === 'weekly') value = inRange ? weekTotal : 0;
            else if (mode === 'cumulative') value = inRange ? running : 0;
            return { isoDate: iso, value, inRange };
        });

        // Month label when the column's first day starts a new month.
        const monthOfWeekStart = new Date(weekStart).getUTCMonth();
        const monthLabel = monthOfWeekStart !== previousMonth
            ? MONTH_SHORT.format(new Date(weekStart))
            : null;
        previousMonth = monthOfWeekStart;

        columns.push({ cells, monthLabel });
    }

    return { columns };
}

/**
 * Period-adaptive day strip (D-R3-2): one cell per day, oldest→newest, ending
 * at TODAY (the last cell is always today). Used for the 7-day / 30-day
 * windows where a 53-week year grid would misrepresent the period.
 */
export function buildDayStrip(
    calendarDays: readonly { date: string; eventCount: number }[],
    nowMs: number,
    dayCount: number,
): UsageDayStripCell[] {
    const counts = new Map<string, number>();
    for (const day of calendarDays) {
        counts.set(day.date, (counts.get(day.date) ?? 0) + day.eventCount);
    }

    const today = todayUtcMs(nowMs);
    const cells: UsageDayStripCell[] = [];
    for (let i = dayCount - 1; i >= 0; i -= 1) {
        const dayMs = today - i * DAY_MS;
        const date = new Date(dayMs);
        cells.push({
            isoDate: isoFromMs(dayMs),
            value: counts.get(isoFromMs(dayMs)) ?? 0,
            isToday: dayMs === today,
            weekday: date.getUTCDay(),
            dayOfMonth: date.getUTCDate(),
        });
    }
    return cells;
}

const CELL = 11;
const GAP = 3;
const COLUMN_STRIDE = CELL + GAP;
/** Height of the month-label axis (monthRow 14 + wrap gap 8) — the left/right
 * cell fade is inset below this so the label axis is never dimmed (C-3). */
const LABEL_AXIS_HEIGHT = 14 + 8;

/**
 * Index of the first week-column whose LEFT edge is at or right of the
 * end-anchored viewport's left edge (`visibleLeft` = the scroll offset). A month
 * label is left-anchored on its column, so a label renders ONLY for columns at
 * this index or later — any earlier column starts off-screen-left and its wider-
 * than-a-column label would bleed a partial glyph into the edge ("Sep"→"ep").
 * Deterministic from the frame's own offset/stride math, correct at ANY width.
 */
export function resolveFirstFullyVisibleColumn(visibleLeft: number, columnStride: number): number {
    if (columnStride <= 0 || visibleLeft <= 0) return 0;
    return Math.max(0, Math.ceil(visibleLeft / columnStride));
}

/** Tooltip title for a heatmap day cell — noon-UTC anchored so the local-time
 * formatter can never slide the label to the previous day. */
function formatCellDate(isoDate: string): string {
    return formatWithCachedDateTimeFormatter(
        new Date(`${isoDate}T12:00:00.000Z`),
        undefined,
        { year: 'numeric', month: 'short', day: 'numeric' },
    );
}

function formatCellEvents(value: number): string {
    return `${value.toLocaleString()} ${t('usage.events')}`;
}

const styles = StyleSheet.create((theme) => ({
    wrap: {
        // 8px between the month-label row and the week grid: the labels must
        // read as an axis, not as an eighth cell row (D-R4-2 finding).
        gap: 8,
    },
    monthRow: {
        flexDirection: 'row',
        height: 14,
    },
    monthLabelSlot: {
        width: CELL + GAP,
        position: 'relative',
    },
    monthLabel: {
        position: 'absolute',
        left: 0,
        top: 0,
        fontSize: 10,
        lineHeight: 12,
        color: theme.colors.text.secondary,
    },
    grid: {
        flexDirection: 'row',
        gap: GAP,
    },
    column: {
        gap: GAP,
    },
    cell: {
        width: CELL,
        height: CELL,
        borderRadius: 2.5,
    },
    stripWrap: {
        gap: 8,
    },
    stripRow: {
        flexDirection: 'row',
        gap: 4,
        alignItems: 'stretch',
    },
    stripSlot: {
        flex: 1,
        minWidth: 0,
        gap: 4,
        alignItems: 'stretch',
    },
    stripCell: {
        borderRadius: 4,
    },
    stripCellToday: {
        borderWidth: 1,
    },
    stripAxisLabel: {
        fontSize: 11,
        lineHeight: 14,
        textAlign: 'center',
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));

/**
 * The month-label axis. Reads the frame's end-anchor geometry and renders a
 * label ONLY for columns at/after the first fully-visible column — so a
 * partially-scrolled older column never bleeds a half-word into the edge
 * ("Sep"→"ep"). Deterministic, correct at any width; when the grid fits
 * (visibleLeft 0) every label shows.
 */
function MonthLabelRow({ columns }: Readonly<{ columns: readonly UsageHeatmapColumn[] }>) {
    const viewport = useHorizontalChartViewport();
    const firstVisible = resolveFirstFullyVisibleColumn(viewport?.visibleLeft ?? 0, COLUMN_STRIDE);
    return (
        <View style={styles.monthRow}>
            {columns.map((column, index) => (
                <View key={`m-${index}`} style={styles.monthLabelSlot}>
                    {column.monthLabel && index >= firstVisible ? (
                        <Text style={styles.monthLabel}>{column.monthLabel}</Text>
                    ) : null}
                </View>
            ))}
        </View>
    );
}

/**
 * Period-adaptive token-activity calendar (banner + Band 3 "When you work").
 *  - Year window (`days` omitted): GitHub-style 53-week grid ending at TODAY,
 *    rendered inside the end-anchored `HorizontalChartFrame` so the newest
 *    columns (the current month) are the visible edge — never clipped
 *    off-screen (D-R3-1).
 *  - Short windows (`days` provided, e.g. 7/30): one day-cell per period day,
 *    today = last cell, weekday/date axis (D-R3-2).
 */
export const UsageContributionHeatmap = React.memo(function UsageContributionHeatmap(props: Readonly<{
    calendarDays: readonly { date: string; eventCount: number }[];
    mode: UsageHeatmapMode;
    /** Render a day strip for this many days instead of the year grid. */
    days?: number;
    nowMs?: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const nowMs = props.nowMs ?? Date.now();
    const days = props.days;
    const accent = usageSignatureAccent(theme);
    const emptyColor = theme.colors.surface.inset;

    const grid = React.useMemo(
        () => (days == null ? buildHeatmapGrid(props.calendarDays, nowMs, props.mode) : null),
        [props.calendarDays, nowMs, props.mode, days],
    );
    const strip = React.useMemo(
        () => (days != null ? buildDayStrip(props.calendarDays, nowMs, days) : null),
        [props.calendarDays, nowMs, days],
    );
    const values = React.useMemo(() => {
        if (strip) return strip.filter((cell) => cell.value > 0).map((cell) => cell.value);
        if (grid) {
            return grid.columns.flatMap((column) => column.cells.filter((cell) => cell.inRange && cell.value > 0).map((cell) => cell.value));
        }
        return [];
    }, [grid, strip]);

    if (strip) {
        const compact = strip.length > 14;
        const cellHeight = compact ? 16 : 28;
        // Weekday initials for a week; ~weekly date marks (Mondays) for longer strips.
        return (
            <View style={styles.stripWrap} testID={props.testID}>
                <View style={styles.stripRow}>
                    {strip.map((cell) => {
                        const showLabel = !compact || cell.weekday === 1;
                        return (
                            <View key={cell.isoDate} style={styles.stripSlot}>
                                <ChartTooltip
                                    triggerTestID="usage-heatmap-cell-trigger"
                                    title={formatCellDate(cell.isoDate)}
                                    value={formatCellEvents(cell.value)}
                                    accentColor={accent}
                                >
                                    <View
                                        style={[
                                            styles.stripCell,
                                            { height: cellHeight, backgroundColor: resolveHeatmapColor({ value: cell.value, values, baseColor: accent, emptyColor }) },
                                            cell.isToday ? [styles.stripCellToday, { borderColor: accent }] : null,
                                        ]}
                                    />
                                </ChartTooltip>
                                <Text style={styles.stripAxisLabel} numberOfLines={1}>
                                    {showLabel
                                        ? (compact ? String(cell.dayOfMonth) : WEEKDAY_NARROW.format(new Date(`${cell.isoDate}T12:00:00.000Z`)))
                                        : ' '}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            </View>
        );
    }

    const columns = grid?.columns ?? [];
    const contentWidth = columns.length * (CELL + GAP);
    const modeLabel = props.mode === 'daily'
        ? t('usage.banner.daily')
        : props.mode === 'weekly'
            ? t('usage.banner.weekly')
            : t('usage.banner.cumulative');

    return (
        <HorizontalChartFrame
            contentWidth={contentWidth}
            showEdgeIndicators={false}
            // Snap the end-anchor to a week-column boundary so the leftmost
            // visible column starts flush at the viewport edge (C-3).
            columnStride={COLUMN_STRIDE}
            // Fade the CELLS only — inset below the month-label axis so no label
            // is ever dimmed. Partial labels are eliminated deterministically by
            // culling in MonthLabelRow (not by the fade), correct at ANY width.
            edgeFadeInsetTop={LABEL_AXIS_HEIGHT}
            scrollViewProps={{ testID: props.testID }}
        >
            <View style={styles.wrap}>
                <MonthLabelRow columns={columns} />
                <View style={styles.grid}>
                    {columns.map((column, columnIndex) => (
                        <View key={`c-${columnIndex}`} style={styles.column}>
                            {column.cells.map((cell, rowIndex) => (
                                <ChartTooltip
                                    key={`${cell.isoDate}-${rowIndex}`}
                                    triggerTestID="usage-heatmap-cell-trigger"
                                    disabled={!cell.inRange}
                                    title={formatCellDate(cell.isoDate)}
                                    subtitle={modeLabel}
                                    value={formatCellEvents(cell.value)}
                                    accentColor={accent}
                                >
                                    <View
                                        style={[
                                            styles.cell,
                                            {
                                                backgroundColor: cell.inRange
                                                    ? resolveHeatmapColor({ value: cell.value, values, baseColor: accent, emptyColor })
                                                    : 'transparent',
                                            },
                                        ]}
                                    />
                                </ChartTooltip>
                            ))}
                        </View>
                    ))}
                </View>
            </View>
        </HorizontalChartFrame>
    );
});
