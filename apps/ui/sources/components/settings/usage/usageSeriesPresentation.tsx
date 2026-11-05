import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet as RNStyleSheet, View } from 'react-native';
import { describeHappierSeriesBucket, type HappierSeries, type HappierSeriesBucket, type StackedSeriesChartProps } from '@happier-dev/plugin-ui/presentation';

import { resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { resolveUsageCostBasis, resolveUsageCostForSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsagePageCostSelection, type UsageAnalyticsCoverage, type UsageAnalyticsQueryResponse, type UsageCostMode } from '@happier-dev/protocol';

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
import { usageSourceTitle } from './widgets/usageBodyKit';
import { usagePageCostRow } from './usageCostPresentation';
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

export function fillUsageTrendCalendar(points: readonly UsageCalendarTrendPoint[], range: UsageCalendarRange, coverage?: UsageAnalyticsCoverage): readonly UsageCalendarTrendPoint[] {
    const starts = walkUsageCalendar(range, points.map((point) => point.timestamp * 1000));
    if (!starts || starts.length === points.length) return points;
    const recorded = new Map(points.map((point) => [point.timestamp * 1000, point]));
    return starts.map((startMs) => {
        const value = usageMissingBucketValue(startMs, range, coverage);
        return recorded.get(startMs) ?? { timestamp: startMs / 1000, tokens: value, cost: value, reportCount: value };
    });
}

/** Up to five evenly spaced bucket labels for the axis, each on its own bucket (never closer than two buckets apart, so neighbours
 * keep their room) and ending on the last bucket. */
export function usageAxisTicks(labels: readonly string[], lastLabel?: string): readonly Readonly<{ label: string; bucket: number }>[] {
    if (labels.length === 0) return [];
    const count = Math.min(5, labels.length, Math.max(2, Math.floor((labels.length - 1) / 2) + 1));
    const ticks = Array.from({ length: count }, (_, index) => {
        const bucket = count === 1 ? 0 : Math.round(index * (labels.length - 1) / (count - 1));
        return { label: labels[bucket]!, bucket };
    });
    if (lastLabel) ticks[ticks.length - 1] = { ...ticks[ticks.length - 1]!, label: lastLabel };
    return ticks;
}

export function usageMixSeries(mix: UsageCalendarMix, label: (value: string) => string, color: (index: number, key: string) => string, timeZoneOffsetMinutes = 0): readonly HappierSeries[] {
    return mix.keys.map((key, index) => ({ id: key.key, label: label(key.label), color: color(index, key.key), detail: `${formatTokenCount(key.totalTokens)} · ${mix.total > 0 ? Math.round(key.totalTokens / mix.total * 100) : 0}%`, points: mix.buckets.map((bucket) => ({
        id: String(bucket.startMs), x: bucket.startMs,
        label: formatUsageCalendarDate(bucket.startMs, timeZoneOffsetMinutes, { month: 'short', day: 'numeric' }),
        y: bucket.tokens[index] ?? null,
    })) }));
}

type UsageSourceDetail = Readonly<{ id: string; label: string; execution: 'happier' | 'outside' | 'unknown'; value: number | null }>;
export type UsageSourceSeries = HappierSeries & Readonly<{ dimensionKey: string;
    sourceDetails?: Readonly<Record<string, readonly UsageSourceDetail[]>>;
}>;

/** Present the producer's partitions; execution placement is never inferred from a source name. */
export function usageSourceTimelineSeries(input: Readonly<{
    timeline: UsageAnalyticsQueryResponse['engineTimeline'];
    range: UsageCalendarRange | null;
    coverage?: UsageAnalyticsCoverage;
    metric: 'tokens' | 'cost';
    costMode: UsageCostMode;
    costSelection?: UsagePageCostSelection | null;
    dimensionKey: (key: string) => string;
    label: (key: string, fallback: string | undefined) => string;
    color: (index: number, key: string) => string;
    bucketLabel: (startMs: number) => string;
}>): readonly UsageSourceSeries[] {
    const timeline = input.timeline ?? [];
    const parts = new Map<string, { key: string; label: string; values: Map<number, number | null>; allOutside: boolean;
        details: Record<string, Map<string, UsageSourceDetail>> }>();
    for (const bucket of timeline) for (const leader of bucket.leaders) {
        if (input.metric === 'tokens' && !leader.sources?.length) continue;
        const key = input.dimensionKey(leader.key);
        const entry = parts.get(key) ?? { key, label: input.label(key, leader.key === key ? leader.label : undefined),
            values: new Map<number, number | null>(), allOutside: true, details: {} };
        if (!leader.sources?.length) entry.allOutside = false;
        // A whole-call report can price the Agent/day without attributing money
        // to its individual capture sources. The query owner selects the leader's
        // money; source partitions are details, never another summation policy.
        if (input.metric === 'cost') {
            const value = leader.cost ? input.costSelection !== undefined
                ? resolveUsageCostForSelection(leader.cost, input.costSelection)
                : resolveUsageCostBasis(leader.cost, input.costMode)?.amountUsd ?? null : null;
            const previous = entry.values.get(bucket.bucketStartMs);
            entry.values.set(bucket.bucketStartMs, value === null || previous === null ? null : (previous ?? 0) + value);
        }
        for (const part of leader.sources ?? []) {
            if (part.execution !== 'outside') entry.allOutside = false;
            const execution = part.execution === 'happier' ? t('usage.board.page.executionHappier')
                : part.execution === 'outside' ? t('usage.board.page.executionOutside') : t('usage.board.page.executionUnknown');
            const value = input.metric === 'tokens' ? part.tokens.total : input.costSelection !== undefined
                ? resolveUsageCostForSelection(part.cost, input.costSelection) : resolveUsageCostBasis(part.cost, input.costMode)?.amountUsd ?? null;
            if (input.metric === 'tokens') {
                const previous = entry.values.get(bucket.bucketStartMs);
                entry.values.set(bucket.bucketStartMs, value === null || previous === null ? null : (previous ?? 0) + value);
            }
            const details = entry.details[String(bucket.bucketStartMs)] ?? new Map<string, UsageSourceDetail>();
            const basisLabel = input.metric === 'cost' && input.costSelection !== undefined
                ? usagePageCostRow(part.cost, input.costSelection)?.label : undefined;
            // Engine leaders collapse into one dimension: their matching source partitions must
            // collapse too. Raw identity keeps equal translated titles and other Agents distinct.
            const id = JSON.stringify([key, part.source, part.path, part.execution]);
            const previous = details.get(id);
            details.set(id, { id, label: [execution, usageSourceTitle(part.source), basisLabel].filter(Boolean).join(' · '),
                execution: part.execution, value: value === null || previous?.value === null ? null : (previous?.value ?? 0) + value });
            entry.details[String(bucket.bucketStartMs)] = details;
        }
        parts.set(key, entry);
    }
    const recorded = timeline.map(bucket => bucket.bucketStartMs);
    const starts = input.range ? walkUsageCalendar(input.range, recorded) ?? recorded : recorded;
    const buckets = new Map(timeline.map(bucket => [bucket.bucketStartMs, bucket]));
    const dimensionIndexes = new Map<string, number>();
    for (const entry of parts.values()) if (!dimensionIndexes.has(entry.key)) dimensionIndexes.set(entry.key, dimensionIndexes.size);
    return [...parts].map(([id, entry]) => ({ id, dimensionKey: entry.key, label: entry.label,
        sourceDetails: Object.fromEntries(Object.entries(entry.details).map(([bucket, details]) => [bucket, [...details.values()]])),
        color: input.color(dimensionIndexes.get(entry.key)!, entry.key),
        ...(entry.allOutside ? { fillPattern: 'hatch' as const } : {}),
        points: starts.map(startMs => {
            const bucket = buckets.get(startMs);
            // A truncated dimension or an older unpartitioned bucket cannot establish a source zero.
            const value = bucket ? input.range && usageMissingBucketValue(startMs, input.range, input.coverage) === 0
                && bucket.leaders.every(leader => leader.sources !== undefined)
                && !input.coverage?.reasons.includes('ranked_truncation') ? 0 : null
                : input.range ? usageMissingBucketValue(startMs, input.range, input.coverage) : null;
            return { id: String(startMs), x: startMs, label: input.bucketLabel(startMs), y: entry.values.has(startMs) ? entry.values.get(startMs)! : value };
        }) }));
}

/** Host Popover and scrolling stay at their incumbent owner; only inert chart facts cross this adapter. */
export function usageSeriesTooltip(accentColor: string, triggerTestID: string, format: (value: number) => string = formatTokenCountLong,
    formatCoordinate?: (x: number) => string) {
    return (bucket: HappierSeriesBucket, visual: ReactNode, select: () => void) => <ChartTooltip triggerTestID={triggerTestID} title={bucket.label}
        accessibilityLabel={describeHappierSeriesBucket(bucket, t('common.unavailable'), formatCoordinate ? { formatCoordinate } : {})} onSelect={select}
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
    /** A point's title when its caller says it only on demand (unlabelled time points); the bucket's label otherwise. */
    pointTitle?: (bucket: HappierSeriesBucket) => string;
    testID?: string;
}>): Pick<StackedSeriesChartProps, 'renderPlotOverlay' | 'onSelect'> {
    const { series, format, accentColor, footer, choice, pointTitle, testID } = input;
    // The chart's own keyboard selection: the lens shows where the viewer is reading.
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const onSelect = useCallback((bucketId: string) => setFocusedId(bucketId), []);
    const renderPlotOverlay = useCallback<NonNullable<StackedSeriesChartProps['renderPlotOverlay']>>((plot) => {
        const colors = new Map(series.map((entry) => [entry.id, entry.color]));
        const resolveContent = (index: number): ScrubLensContent | null => {
            const bucket = plot.buckets[index];
            if (!bucket) return null;
            const known = bucket.values.every((entry) => entry.value !== null);
            const rows = bucket.values.flatMap((entry): ScrubLensRow[] => {
                const chosen = choice?.(entry.seriesId) ?? null;
                const color = entry.color ?? colors.get(entry.seriesId);
                const parent = { id: entry.seriesId, label: entry.label, ...(color ? { color } : {}),
                    value: entry.value === null ? t('common.unavailable') : format(entry.value),
                    ...(chosen ? chosen : {}) };
                const details = (series.find(part => part.id === entry.seriesId) as UsageSourceSeries | undefined)?.sourceDetails?.[bucket.id] ?? [];
                return [parent, ...details.map(part => ({ id: part.id, label: part.label,
                    value: part.value === null ? t('common.unavailable') : format(part.value) }))];
            });
            return { title: pointTitle ? pointTitle(bucket) : bucket.label, rows, ...(footer ? { footer } : {}),
                // Comparison overlays are independent observations, never additive parts.
                ...(known && bucket.values.length > 1 && !series.some(entry => entry.overlay)
                    ? { total: format(bucket.values.reduce((sum, entry) => sum + (entry.value ?? 0), 0)) } : {}) };
        };
        const focusIndex = focusedId === null ? -1 : plot.buckets.findIndex((bucket) => bucket.id === focusedId);
        return <ScrubLens style={RNStyleSheet.absoluteFill} accentColor={accentColor} resolveContent={resolveContent}
            layout={{ centers: plot.centers }}
            focusIndex={focusIndex < 0 ? null : focusIndex} {...(testID ? { testID } : {})} />;
    }, [series, format, accentColor, footer, choice, pointTitle, focusedId, testID]);
    return { renderPlotOverlay, onSelect };
}
