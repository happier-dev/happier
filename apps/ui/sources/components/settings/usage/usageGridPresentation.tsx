import type { ReactNode } from 'react';
import type { HappierGridCell, HappierGridFrame, HeatmapProps } from '@happier-dev/plugin-ui/presentation';
import { formatHappierDataValue } from '@happier-dev/plugin-ui/presentation';

import { ChartTooltip, HorizontalChartFrame, resolveHeatmapColor, useHorizontalChartViewport } from '@/components/ui/charts';
import type { UsagePunchCard, UsageSummaryActivityPoint } from '@/sync/api/account/usageAnalytics';
import { buildDayStrip, buildHeatmapGrid, type UsageHeatmapMode } from '@/sync/api/account/usageCalendar';
import { t } from '@/text';
import { formatUsageHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { resolveUsageBucketBounds, resolveUsageCalendarDateStart, type UsageAnalyticsCoverage } from '@happier-dev/protocol';
import { formatUsageCalendarDate, usageMissingBucketValue, type UsageCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { withUsageAccentAlpha } from './usageAccent';
import { RippleCell, rippleDelayMs } from '@/components/instrument/charts/RippleGrid';
import { useMotionPreferences } from '@/components/instrument';
import { useEntrancesEnabled } from './usageEntrance';

type GridFacts = Pick<HeatmapProps, 'label' | 'cells' | 'rows' | 'columns' | 'layout' | 'size' | 'annotation' | 'order'>;
const dateLabel = (iso: string) => formatUsageCalendarDate(resolveUsageCalendarDateStart(iso, 0), 0);
const events = (value: number) => `${formatHappierDataValue(value)} ${t('usage.events')}`;
const weekdayLabel = (weekday: number, width: 'long' | 'narrow') => formatUsageCalendarDate(Date.UTC(2024, 0, 7 + weekday), 0, { weekday: width });

/** Usage owns calendar/date shaping; the public renderer receives already positioned facts. */
export function usageHeatmapPresentation(input: Readonly<{ calendarDays: readonly { date: string; eventCount: number }[]; mode: UsageHeatmapMode; nowMs?: number; days?: number; range?: UsageCalendarRange; coverage?: UsageAnalyticsCoverage; accentColor: string; emptyColor: string }>): GridFacts {
    const nowMs = input.nowMs ?? Date.now();
    const range = input.range;
    const firstDate = input.calendarDays[0]?.date;
    const startMs = range?.startMs ?? (range && firstDate ? resolveUsageCalendarDateStart(firstDate, range.timeZoneOffsetMinutes) : undefined);
    const rangeDays = range && startMs !== undefined
        ? Math.max(0, Math.round((resolveUsageBucketBounds('day', range.endMs - 1, range.timeZoneOffsetMinutes).bucketStartMs
            - resolveUsageBucketBounds('day', startMs, range.timeZoneOffsetMinutes).bucketStartMs) / 86_400_000) + 1) : undefined;
    const days = range ? rangeDays !== undefined && rangeDays <= 30 ? rangeDays : undefined : input.days;
    const known = new Set(input.calendarDays.map(day => day.date));
    const valueFor = (cell: { isoDate: string; value: number }): number | null => !range || known.has(cell.isoDate) ? cell.value
        : usageMissingBucketValue(resolveUsageCalendarDateStart(cell.isoDate, range.timeZoneOffsetMinutes), { ...range, granularity: 'day' }, input.coverage);
    if (days !== undefined) {
        const strip = buildDayStrip(input.calendarDays, nowMs, days, range);
        const values = strip.map(valueFor).filter((value): value is number => value !== null);
        return { label: t('usage.activity'), layout: 'strip', rows: [{ id: 'days', label: '' }],
            columns: strip.map((cell) => ({ id: cell.isoDate, label: strip.length > 14 ? cell.weekday === 1 ? String(cell.dayOfMonth) : '' : weekdayLabel(cell.weekday, 'narrow') })),
            cells: strip.map((cell) => { const value = valueFor(cell); return { id: cell.isoDate, row: 'days', column: cell.isoDate, label: dateLabel(cell.isoDate), value,
                valueLabel: value === null ? t('common.unavailable') : events(value), emphasized: cell.isToday,
                color: resolveHeatmapColor({ value: value ?? 0, values, baseColor: input.accentColor, emptyColor: input.emptyColor }) }; }) };
    }
    const grid = buildHeatmapGrid(input.calendarDays, nowMs, input.mode, undefined, range);
    const values = grid.columns.flatMap((column) => column.cells.filter((cell) => cell.inRange).map(valueFor)).filter((value): value is number => value !== null);
    return { label: t('usage.activity'), rows: Array.from({ length: 7 }, (_, index) => ({ id: String(index), label: '' })),
        columns: grid.columns.map((column) => ({ id: column.cells[0]!.isoDate, label: column.monthLabel ?? '' })),
        cells: grid.columns.flatMap((column) => column.cells.flatMap((cell, row) => { const value = valueFor(cell); return cell.inRange ? [{ id: cell.isoDate, row: String(row), column: column.cells[0]!.isoDate, label: dateLabel(cell.isoDate), value,
            valueLabel: value === null ? t('common.unavailable') : events(value),
            color: resolveHeatmapColor({ value: value ?? 0, values, baseColor: input.accentColor, emptyColor: input.emptyColor }) }] : []; })) };
}

export function usageDotGridPresentation(punchCard: UsagePunchCard, accentColor: string, emptyColor: string): GridFacts {
    const hourLabel = formatUsageHourLabel;
    const peak = Math.max(1, punchCard.peak);
    return { label: t('usage.workRhythm'),
        annotation: punchCard.busiest ? `${weekdayLabel(punchCard.busiest.weekday, 'long')} · ${hourLabel(punchCard.busiest.hour)} · ${t('usage.busiestTag')}` : undefined,
        rows: Array.from({ length: 7 }, (_, weekday) => ({ id: String(weekday), label: weekdayLabel(weekday, 'narrow') })),
        columns: Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), label: [0, 6, 12, 18].includes(hour) ? hourLabel(hour) : '' })),
        cells: punchCard.cells.flatMap((row, weekday) => row.map((value, hour) => ({ id: `${weekday}:${hour}`, row: String(weekday), column: String(hour), label: `${weekdayLabel(weekday, 'long')} · ${hourLabel(hour)}`, value, valueLabel: events(value),
            color: value > 0 ? withUsageAccentAlpha(accentColor, 0.16 + 0.84 * value / peak) : withUsageAccentAlpha(emptyColor, 0.4),
            emphasized: punchCard.busiest?.weekday === weekday && punchCard.busiest.hour === hour }))),
    };
}

/** Recap matrix pads unavailable history explicitly, rather than inventing measured zero. */
export function usageActivityGridPresentation(activity: readonly UsageSummaryActivityPoint[], color: string, emptyColor: string, squareCount = 14, rowSize = 7, timeZoneOffsetMinutes = 0): GridFacts {
    const recent = activity.slice(-squareCount);
    const fillerCount = Math.max(0, squareCount - recent.length);
    const points = [...Array.from({ length: fillerCount }, () => null), ...recent];
    const values = recent.map((point) => point.tokens);
    return { label: t('usage.activity'), size: 'tile', order: 'rows',
        rows: Array.from({ length: Math.ceil(squareCount / rowSize) }, (_, index) => ({ id: String(index), label: '' })),
        columns: Array.from({ length: rowSize }, (_, index) => ({ id: String(index), label: '' })),
        cells: points.map((point, index) => ({ id: point ? String(point.timestamp) : `unavailable:${index}`, row: String(Math.floor(index / rowSize)), column: String(index % rowSize),
            label: point ? formatUsageCalendarDate(point.timestamp, timeZoneOffsetMinutes) : t('usage.noData.title'), value: point ? point.tokens : null,
            color: resolveHeatmapColor({ value: point?.active ? point.tokens : 0, values, baseColor: color, emptyColor }) })) };
}

/** Canonical host overlay owns hover, touch and keyboard; the renderer owns semantic selection. */
export function usageGridTooltip(accentColor: string, triggerTestID: string) {
    return (cell: HappierGridCell, visual: ReactNode, select: () => void) => {
        const value = cell.value === null || !Number.isFinite(cell.value) ? t('usage.noData.title') : cell.valueLabel ?? formatHappierDataValue(cell.value);
        return <ChartTooltip triggerTestID={triggerTestID} title={cell.label} value={value} accentColor={accentColor}
            accessibilityLabel={`${cell.label}: ${value}`} onSelect={select} triggerStyle={{ flex: 1 }}>{visual}</ChartTooltip>;
    };
}

/** Reuse the incumbent motion owner, but never its replaced grid layout. */
export function useUsageActivityGridTooltip(accentColor: string, columns: number) {
    const animate = useEntrancesEnabled();
    const motion = useMotionPreferences();
    const tooltip = usageGridTooltip(accentColor, 'usage-activity-square');
    return (cell: HappierGridCell, visual: ReactNode, select: () => void) => <RippleCell animate={animate} travel={motion.entrance.kind === 'travel'}
        delayMs={rippleDelayMs(Number(cell.row) * columns + Number(cell.column), columns)}>{tooltip(cell, visual, select)}</RippleCell>;
}

function GridViewport({ frame }: { frame: HappierGridFrame }) {
    const viewport = useHorizontalChartViewport();
    return frame.renderContent(viewport?.visibleLeft ?? 0);
}
export function usageGridFrame(frame: HappierGridFrame) {
    return <HorizontalChartFrame contentWidth={frame.contentWidth} columnStride={frame.columnStride} edgeFadeInsetTop={frame.axisHeight} showEdgeIndicators={false}>
        <GridViewport frame={frame} />
    </HorizontalChartFrame>;
}
