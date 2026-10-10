import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet as RNStyleSheet, View } from 'react-native';
import { describeHappierSeriesBucket, type HappierSeries, type HappierSeriesBucket, type StackedSeriesChartProps } from '@happier-dev/plugin-ui/presentation';

import { resolveUsageBucketBounds, type UsageAnalyticsCoverage } from '@happier-dev/protocol';

import { ChartTooltip, HorizontalChartFrame } from '@/components/ui/charts';
import type { UsageHourRhythm, UsageModelMix, UsageTrendPoint } from '@/sync/api/account/usageAnalytics';
import { formatUsageHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { t } from '@/text';
import { formatTokenCount, formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';
import { useMotionPreferences } from '@/components/instrument';
import { DrawnLinePath } from '@/components/instrument/charts/DrawnLinePath';
import { ChartInkFade } from '@/components/instrument/charts/LineFade';
import { INSTRUMENT_DURATIONS } from '@/components/instrument/motion/motionTokens';
import { useEntrancesEnabled } from './usageEntrance';
import { withUsageAccentAlpha } from './usageAccent';
import { ScrubLens, type ScrubLensContent, type ScrubLensRow } from './UsageScrubLens';
import { formatUsageCalendarDate, usageMissingBucketValue, type UsageCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
export type { UsageCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';

type UsageCalendarTrendPoint = Readonly<{ timestamp: number; tokens: number | null; cost: number | null; reportCount: number | null }>;
type UsageCalendarMix = Omit<UsageModelMix, 'buckets'> & Readonly<{ buckets: readonly Readonly<{
    startMs: number; endMs: number; total: number | null; tokens: readonly (number | null)[]; shares: readonly (number | null)[];
}>[] }>;

/**
 * Preserve the incumbent volume grow-in (350ms, 30ms stagger, eight-slot budget) and host spring.
 * `bucket` identity is the period morph (lab `kitstates` morph): the days that stay keep their marks
 * and re-interpolate in place, the days that join rise from the axis. Nothing remounts.
 */
export function useUsageSeriesMotion(pointCount: number, identity: 'bucket' | 'slot' = 'slot') {
    const motion = useMotionPreferences();
    const entrancesEnabled = useEntrancesEnabled();
    const barMotion = useMemo<StackedSeriesChartProps['barMotion']>(() => ({
        identity,
        ...(motion.entrance.kind === 'travel' && entrancesEnabled ? { entrance: { durationMs: 350,
            delaysMs: Array.from({ length: pointCount }, (_, index) => Math.min(index, 7) * 30) } } : {}),
        ...(motion.level !== 'minimal' ? { change: motion.springs.standard } : {}),
    }), [entrancesEnabled, identity, motion.entrance.kind, motion.level, motion.springs.standard, pointCount]);
    return { barMotion, reducedMotion: motion.level === 'minimal' };
}

/** Preserve the canonical draw/fade engine and the surface's entrance-once policy. */
export function useUsageSeriesLineInk() {
    const motion = useMotionPreferences();
    const entrancesEnabled = useEntrancesEnabled();
    const renderLinePath: NonNullable<StackedSeriesChartProps['renderLinePath']> = (path, ink) =>
        <DrawnLinePath path={path} width={ink.width} height={ink.height} color={ink.color}
            strokeWidth={ink.strokeWidth} animateOnMount={entrancesEnabled && !ink.reducedMotion} />;
    return { renderLinePath, reducedMotion: motion.level === 'minimal' };
}

export function useUsageSeriesAreaInk() {
    const motion = useMotionPreferences();
    const entrancesEnabled = useEntrancesEnabled();
    const renderInk: NonNullable<StackedSeriesChartProps['renderInk']> = (visual, reducedMotion) =>
        <ChartInkFade animateEntrance={entrancesEnabled && !reducedMotion} durationMs={INSTRUMENT_DURATIONS.entranceEmphasis}>{visual}</ChartInkFade>;
    return { renderInk, reducedMotion: motion.level === 'minimal' };
}

export function usageSparkSeries(values: readonly number[], label: string, color: string): readonly HappierSeries[] {
    return [{ id: 'trend', label, color, points: values.map((y, index) => ({ id: String(index), x: index + 1, y })) }];
}

export function createUsageHourRhythmSeries(rhythm: UsageHourRhythm, color: string, emptyColor?: string): readonly HappierSeries[] {
    return [{ id: 'hours', label: t('usage.events'), color, points: rhythm.hours.map((bar) => ({ id: String(bar.hour), x: bar.hour,
        label: formatUsageHourLabel(bar.hour), y: bar.eventCount,
        color: bar.eventCount === 0 ? emptyColor ?? color : bar.hour === rhythm.busiestHour ? color : withUsageAccentAlpha(color, 0.25),
        opacity: bar.eventCount === 0 ? 0.5 : 1,
        ...(bar.hour === rhythm.busiestHour ? { annotation: t('usage.busiestTag') } : {}),
    })) }];
}

function volumeBucketLabel(timestamp: number, pointCount: number, timeZoneOffsetMinutes = 0): string {
    return formatUsageCalendarDate(timestamp * 1000, timeZoneOffsetMinutes,
        pointCount <= 8 ? { month: 'short', day: 'numeric' } : { month: 'short' });
}

export function usageVolumeSeries(points: readonly (UsageCalendarTrendPoint & Readonly<{ requests?: number }>)[], metric: 'tokens' | 'cost' | 'requests', label: string, color: string, timeZoneOffsetMinutes = 0): readonly HappierSeries[] {
    return [{ id: metric, label, color, points: points.map((point) => ({
        id: String(point.timestamp), x: point.timestamp,
        label: volumeBucketLabel(point.timestamp, points.length, timeZoneOffsetMinutes),
        y: metric === 'cost' ? point.cost : metric === 'requests' ? point.requests ?? null : point.tokens,
    })) }];
}

/** Bucket starts from the range's first bucket to its last, or `null` when a recorded start is not one of them. */
function walkUsageCalendar(range: UsageCalendarRange, recorded: readonly number[]): readonly number[] | null {
    const first = range.startMs ?? recorded[0];
    if (first === undefined) return null;
    const lastRecorded = recorded[recorded.length - 1];
    const starts: number[] = [];
    let cursor = Math.min(first, recorded[0] ?? first);
    while (cursor < range.endMs || (lastRecorded !== undefined && cursor <= lastRecorded)) {
        const bounds = resolveUsageBucketBounds(range.granularity, cursor, range.timeZoneOffsetMinutes);
        starts.push(bounds.bucketStartMs);
        cursor = bounds.bucketEndMs;
    }
    const known = new Set(starts);
    return recorded.every((start) => known.has(start)) ? starts : null;
}

/**
 * Every calendar bucket retains its place. Missing history is unavailable; a producer-proven
 * complete interval can establish a quiet zero.
 */
export function fillUsageMixCalendar(mix: UsageModelMix, range: UsageCalendarRange, coverage?: UsageAnalyticsCoverage): UsageCalendarMix {
    const starts = walkUsageCalendar(range, mix.buckets.map((bucket) => bucket.startMs));
    if (!starts || starts.length === mix.buckets.length) return mix;
    const recorded = new Map(mix.buckets.map((bucket) => [bucket.startMs, bucket]));
    return { ...mix, buckets: starts.map((startMs) => {
        const bucket = recorded.get(startMs);
        if (bucket) return bucket;
        const value = usageMissingBucketValue(startMs, range, coverage);
        const empty = mix.keys.map(() => value);
        return { startMs, endMs: resolveUsageBucketBounds(range.granularity, startMs, range.timeZoneOffsetMinutes).bucketEndMs,
            total: value, tokens: empty, shares: empty };
    }) };
}

export function fillUsageTrendCalendar(points: readonly UsageTrendPoint[], range: UsageCalendarRange, coverage?: UsageAnalyticsCoverage): readonly UsageCalendarTrendPoint[] {
    const starts = walkUsageCalendar(range, points.map((point) => point.timestamp * 1000));
    if (!starts || starts.length === points.length) return points;
    const recorded = new Map(points.map((point) => [point.timestamp * 1000, point]));
    return starts.map((startMs) => {
        const value = usageMissingBucketValue(startMs, range, coverage);
        return recorded.get(startMs) ?? { timestamp: startMs / 1000, tokens: value, cost: value, reportCount: value };
    });
}

/** Up to five evenly spaced bucket labels for the axis, ending on the last bucket. */
export function usageAxisTicks(labels: readonly string[], lastLabel?: string): readonly string[] {
    if (labels.length === 0) return [];
    const count = Math.min(5, labels.length);
    const ticks = Array.from({ length: count }, (_, index) =>
        labels[count === 1 ? 0 : Math.round(index * (labels.length - 1) / (count - 1))]!);
    if (lastLabel) ticks[ticks.length - 1] = lastLabel;
    return ticks;
}

export function usageMixSeries(mix: UsageCalendarMix, label: (value: string) => string, color: (index: number, key: string) => string, timeZoneOffsetMinutes = 0): readonly HappierSeries[] {
    return mix.keys.map((key, index) => ({ id: key.key, label: label(key.label), color: color(index, key.key), detail: `${formatTokenCount(key.totalTokens)} · ${mix.total > 0 ? Math.round(key.totalTokens / mix.total * 100) : 0}%`, points: mix.buckets.map((bucket) => ({
        id: String(bucket.startMs), x: bucket.startMs,
        label: formatUsageCalendarDate(bucket.startMs, timeZoneOffsetMinutes, { month: 'short', day: 'numeric' }),
        y: bucket.tokens[index] ?? null,
    })) }));
}

/** Host Popover and scrolling stay at their incumbent owner; only inert chart facts cross this adapter. */
export function usageSeriesTooltip(accentColor: string, triggerTestID: string, format: (value: number) => string = formatTokenCountLong) {
    return (bucket: HappierSeriesBucket, visual: ReactNode, select: () => void) => <ChartTooltip triggerTestID={triggerTestID} title={bucket.label}
        accessibilityLabel={describeHappierSeriesBucket(bucket, t('common.unavailable'))} onSelect={select}
        value={bucket.values.map((entry) => `${entry.label} · ${entry.value === null ? t('common.unavailable') : format(entry.value)}`).join('\n')}
        accentColor={accentColor} triggerStyle={{ flex: 1 }}>
        {visual}
    </ChartTooltip>;
}

export function usageSeriesFrame(pointCount: number, lens?: Readonly<{ accentColor: string; resolveContent: (index: number) => ScrubLensContent | null }>) {
    const width = Math.max(640, pointCount * 58 + 18);
    return (visual: ReactNode) => <HorizontalChartFrame contentWidth={width}><View style={{ width }}>
        {lens ? <ScrubLens layout={{ leadingPx: 4, cellPx: 42, gapPx: 10, count: pointCount }}
            resolveContent={lens.resolveContent} accentColor={lens.accentColor}>{visual}</ScrubLens> : visual}
    </View></HorizontalChartFrame>;
}

export function usageVolumeLens(points: readonly (UsageTrendPoint & Readonly<{ requests?: number }>)[], currency: string,
    label: (timestamp: number) => string = (timestamp) => volumeBucketLabel(timestamp, points.length),
    requestLabel = t('usage.events')) {
    return (index: number): ScrubLensContent | null => {
        const point = points[index];
        if (!point) return null;
        return { title: label(point.timestamp), rows: [
            ...(point.requests === undefined ? [] : [{ label: requestLabel, value: formatTokenCountLong(point.requests) }]),
            { label: t('usage.tokens'), value: formatTokenCountLong(point.tokens) },
            { label: t('usage.cost'), value: formatUsageCost(point.cost, currency) },
            { label: t('usage.events'), value: point.reportCount.toLocaleString() },
        ] };
    };
}

export function usageSeriesValueFormatter(metric: 'tokens' | 'cost' | 'requests', currency: string) {
    return metric === 'cost' ? (value: number) => formatUsageCost(value, currency) : formatTokenCount;
}

/** What choosing one series in the lens or the legend does (a drill), worded by its caller. */
export type UsageSeriesChoice = Readonly<{ onPress: () => void; pressLabel: string; selected: boolean }>;

/**
 * The all-series lens over a chart's own plot (lab `kitstates` lens). The chart hands over its bucket
 * slots and exact values; nothing here scales, sums a series or reads data. A bucket's total is shown
 * only when every series in it is known.
 */
export function useUsageSeriesLens(input: Readonly<{
    series: readonly HappierSeries[];
    format: (value: number) => string;
    accentColor: string;
    /** What the numbers mean, said once under them (cost basis). */
    footer?: string;
    choice?: (seriesId: string) => UsageSeriesChoice | null;
    testID?: string;
}>): Pick<StackedSeriesChartProps, 'renderPlotOverlay' | 'onSelect'> {
    const { series, format, accentColor, footer, choice, testID } = input;
    // The chart's own keyboard selection: the lens shows where the viewer is reading.
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const onSelect = useCallback((bucketId: string) => setFocusedId(bucketId), []);
    const renderPlotOverlay = useCallback<NonNullable<StackedSeriesChartProps['renderPlotOverlay']>>((plot) => {
        const colors = new Map(series.map((entry) => [entry.id, entry.color]));
        const resolveContent = (index: number): ScrubLensContent | null => {
            const bucket = plot.buckets[index];
            if (!bucket) return null;
            const known = bucket.values.every((entry) => entry.value !== null);
            const rows = bucket.values.map((entry): ScrubLensRow => {
                const chosen = choice?.(entry.seriesId) ?? null;
                const color = entry.color ?? colors.get(entry.seriesId);
                return { id: entry.seriesId, label: entry.label, ...(color ? { color } : {}),
                    value: entry.value === null ? t('common.unavailable') : format(entry.value),
                    ...(chosen ? chosen : {}) };
            });
            return { title: bucket.label, rows, ...(footer ? { footer } : {}),
                ...(known && bucket.values.length > 1
                    ? { total: format(bucket.values.reduce((sum, entry) => sum + (entry.value ?? 0), 0)) } : {}) };
        };
        const focusIndex = focusedId === null ? -1 : plot.buckets.findIndex((bucket) => bucket.id === focusedId);
        return <ScrubLens style={RNStyleSheet.absoluteFill} accentColor={accentColor} resolveContent={resolveContent}
            layout={{ centers: plot.centers }}
            focusIndex={focusIndex < 0 ? null : focusIndex} {...(testID ? { testID } : {})} />;
    }, [series, format, accentColor, footer, choice, focusedId, testID]);
    return { renderPlotOverlay, onSelect };
}
