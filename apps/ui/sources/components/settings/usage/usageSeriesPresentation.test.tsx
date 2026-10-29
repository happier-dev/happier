import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fillUsageMixCalendar, fillUsageTrendCalendar, usageAxisTicks, usageSeriesFrame, usageSourceTimelineSeries, usageVolumeSeries, useUsageSeriesLens, type UsageSeriesChoice } from './usageSeriesPresentation';
import type { UsageAnalyticsCoverage } from '@happier-dev/protocol';

const coverage = (startMs: number, endMs: number, complete: boolean): UsageAnalyticsCoverage => ({
    status: complete ? 'complete' : 'partial', reasons: complete ? [] : ['incomplete_history'], sources: [],
    missingDimensions: [], ranked: [], range: { startMs, endMs, complete },
});

const lensSeries = [
    { id: 'claude', label: 'Claude Code', color: '#111', points: [{ id: 'mon', x: 1, label: 'Mon', y: 1200 }, { id: 'tue', x: 2, label: 'Tue', y: 300 }] },
    { id: 'codex', label: 'Codex', color: '#222', points: [{ id: 'mon', x: 1, label: 'Mon', y: 800 }, { id: 'tue', x: 2, label: 'Tue', y: null }] },
];
function LensChart(props: Readonly<{ choice?: (seriesId: string) => UsageSeriesChoice | null }>) {
    const lens = useUsageSeriesLens({ series: lensSeries, format: (value) => `${value} tok`, accentColor: lightTheme.colors.text.primary,
        footer: 'API-equivalent', testID: 'lens', ...(props.choice ? { choice: props.choice } : {}) });
    return <StackedSeriesChart theme={projectPluginUiTheme(lightTheme)} label="Tokens" series={lensSeries} variant="bar" size="full"
        width={320} showReadout={false} testID="chart" {...lens} />;
}
type StubGesture = Readonly<{ __handlers: Record<string, (event: { x: number }) => void>; __config: Record<string, unknown> }>;
function lensTap(screen: Awaited<ReturnType<typeof renderScreen>>): StubGesture {
    const detector = screen.findByType('GestureDetector' as never);
    const [, exclusive] = (detector.props.gesture as { gestures: readonly [StubGesture, { gestures: readonly StubGesture[] }] }).gestures;
    return exclusive.gestures[1]!;
}

describe('the all-series lens', () => {
    it('shows every series exactly, with the bucket total only when every part is known', async () => {
        const screen = await renderScreen(<LensChart />);
        expect(screen.findAllHostsByTestId('lens-lens')).toHaveLength(0);
        // The chart's own selection (keyboard focus, a press) is where the lens reads.
        act(() => pressTestInstance(screen.findByTestId('chart-bucket-mon'), 'bucket'));
        const text = screen.getTextContent();
        expect(text).toContain('Mon');
        expect(text).toContain('Claude Code');
        expect(text).toContain('1200 tok');
        expect(text).toContain('800 tok');
        expect(text).toContain('2000 tok');
        expect(text).toContain('API-equivalent');
        act(() => pressTestInstance(screen.findByTestId('chart-bucket-tue'), 'bucket'));
        // An unknown part is said, and no total is made up around it.
        expect(screen.getTextContent()).toContain('300 tok');
        expect(screen.getTextContent()).not.toContain('2000 tok');
        const lens = screen.findByTestId('lens-lens')!;
        expect(lens).toBeTruthy();
        // Read only the painted lens: a fabricated partial total would add another value here.
        const lensText = lens.findAllByType(Text).map(node => node.props.children);
        expect(lensText).toContain(t('common.unavailable'));
        expect(lensText.filter(value => typeof value === 'string' && value.endsWith(' tok'))).toEqual(['300 tok']);
    });
    it('lets a held lens narrow to one series, and only while it is held', async () => {
        const chosen: string[] = [];
        const choice = (seriesId: string): UsageSeriesChoice => ({ onPress: () => chosen.push(seriesId), pressLabel: `Show only ${seriesId}`, selected: false });
        const screen = await renderScreen(<LensChart choice={choice} />);
        act(() => pressTestInstance(screen.findByTestId('chart-bucket-mon'), 'bucket'));
        // Following the reader is passive: nothing in the lens takes a press.
        expect(screen.findAllHostsByTestId('lens-lens-row-codex')).toHaveLength(0);
        act(() => lensTap(screen).__handlers.onEnd!({ x: 10 }));
        const row = screen.findByTestId('lens-lens-row-codex')!;
        expect(row.props.accessibilityLabel).toBe('Show only codex');
        act(() => pressTestInstance(row, 'row'));
        expect(chosen).toEqual(['codex']);
        // Tapping the held bucket again lets it go.
        act(() => lensTap(screen).__handlers.onEnd!({ x: 10 }));
        expect(screen.findAllHostsByTestId('lens-lens-row-codex')).toHaveLength(0);
    });
});

describe('usage projection into the shared series renderer', () => {
    it('retains known cost from older unpartitioned buckets beside source-partitioned buckets', () => {
        const tokens = { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 };
        const cost = { reportedUsd: 0, estimatedUsd: 9, currency: 'USD', costSource: 'pricing_estimate' as const };
        const series = usageSourceTimelineSeries({ timeline: [
            { bucketStartMs: 0, bucketEndMs: 10, leaders: [{ key: 'claude', eventCount: 1, tokens, cost }] },
            { bucketStartMs: 10, bucketEndMs: 20, leaders: [{ key: 'claude', eventCount: 1, tokens, cost,
                sources: [{ source: 'native', path: 'native', execution: 'outside', eventCount: 1, tokens, cost }] }] },
        ], range: null, metric: 'cost', costMode: 'auto', costSelection: { kind: 'estimated', currency: 'USD', mode: 'auto' },
        dimensionKey: key => key, label: key => key, color: () => 'ink', bucketLabel: String });
        expect(series[0]?.points.map(point => point.y)).toEqual([9, 9]);
        expect(series[0]?.fillPattern).toBeUndefined();
    });
    it('keeps source appearance orthogonal to dimension hue and missing calendar evidence', () => {
        const day = 86_400_000;
        const tokens = { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 };
        const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
        const sources = [
            { source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens, cost },
            { source: 'native', path: 'native' as const, execution: 'outside' as const, eventCount: 1, tokens, cost },
        ];
        const series = usageSourceTimelineSeries({ timeline: [
            { bucketStartMs: 0, bucketEndMs: day, leaders: [
                { key: 'model:local', eventCount: 1, tokens, cost, sources: [sources[0]!] },
                { key: 'model:remote', eventCount: 1, tokens, cost, sources: [sources[1]!] },
            ] },
            { bucketStartMs: day * 2, bucketEndMs: day * 3, leaders: [{ key: 'model:local', eventCount: 1, tokens, cost, sources: [sources[0]!] }] },
        ], range: { startMs: 0, endMs: day * 3, granularity: 'day', timeZoneOffsetMinutes: 0 }, coverage: coverage(0, day * 3, false),
        metric: 'tokens', costMode: 'auto', dimensionKey: key => key.split(':')[0]!, label: key => key, color: index => `hue-${index}`, bucketLabel: String });
        expect(series.map(entry => ({ color: entry.color, values: entry.points.map(point => point.y) }))).toEqual([
            { color: 'hue-0', values: [10, null, 5] },
        ]);
        expect(series[0]!.label).toBe('model');
        expect(series[0]!.sourceDetails?.['0']?.map(part => ({ execution: part.execution, value: part.value }))).toEqual([
            { execution: 'happier', value: 5 }, { execution: 'outside', value: 5 },
        ]);
        expect(series[0]!.sourceDetails?.['0']?.every(part => !part.label.includes('runtime'))).toBe(true);
        expect(usageSourceTimelineSeries({ timeline: [{ bucketStartMs: 0, bucketEndMs: day, leaders: [{ key: 'old', eventCount: 1, tokens, cost }] }],
            range: null, metric: 'tokens', costMode: 'auto', dimensionKey: key => key, label: key => key, color: () => 'ink', bucketLabel: String })).toEqual([]);
    });
    it('retains older accounting buckets and the current currency in exact selected values', async () => {
        const points = Array.from({ length: 40 }, (_, index) => ({ timestamp: 1_710_000_000 + index * 86_400, tokens: index, cost: index === 0 ? 0.00004 : index, reportCount: 1 }));
        const screen = await renderScreen(<StackedSeriesChart theme={projectPluginUiTheme(lightTheme)} label="Cost"
            series={usageVolumeSeries(points, 'cost', 'Cost EUR', lightTheme.colors.text.link)} variant="bar" size="full" testID="volume"
            renderFrame={usageSeriesFrame(points.length)} />);
        expect(screen.findAllHostsByTestId('volume-bar-0-0')).toHaveLength(1);
        expect(screen.findByTestId('volume')?.props.accessibilityLabel).toContain('Cost EUR 0.00004');
        const first = screen.findByTestId(`volume-bucket-${points[0]!.timestamp}`);
        act(() => pressTestInstance(first, 'volume-bucket'));
        expect(screen.getTextContent()).toContain('0.00004');
        expect(screen.findByType('ScrollView' as never).props.horizontal).toBe(true);
    });
    it('keeps missing request counts unavailable while a witnessed zero remains zero', () => {
        const series = usageVolumeSeries([
            { timestamp: 1, tokens: 5, cost: 0, reportCount: 1 },
            { timestamp: 2, tokens: 5, cost: 0, reportCount: 1, requests: 0 },
        ], 'requests', 'Requests', lightTheme.colors.text.link);
        expect(series[0]!.points.map((point) => point.y)).toEqual([null, 0]);
    });
    it('keeps every calendar day of the shown range, so a quiet day is a gap in its place', () => {
        const day = 86_400_000;
        const start = Date.UTC(2026, 8, 28);
        const bucket = (index: number, tokens: number) => ({ startMs: start + index * day, endMs: start + (index + 1) * day, total: tokens, tokens: [tokens], shares: [1] });
        const mix = { keys: [{ key: 'claude', label: 'Claude', totalTokens: 30 }], buckets: [bucket(0, 10), bucket(3, 20)], total: 30, hasData: true };
        const filled = fillUsageMixCalendar(mix, { startMs: start - day, endMs: start + 4 * day + 1, granularity: 'day', timeZoneOffsetMinutes: 0 }, coverage(start - day, start + 4 * day + 1, true));
        expect(filled.buckets.map((entry) => entry.total)).toEqual([0, 10, 0, 0, 20, 0]);
        expect(filled.buckets.map((entry) => entry.startMs)).toEqual([-1, 0, 1, 2, 3, 4].map((index) => start + index * day));
        expect(filled.buckets[0]!.tokens).toEqual([0]);
        expect(filled.total).toBe(30);
        // An open-ended range starts at the first recorded bucket; nothing is invented before it.
        expect(fillUsageMixCalendar(mix, { endMs: start + 3 * day, granularity: 'day', timeZoneOffsetMinutes: 0 }).buckets).toHaveLength(4);
    });
    it('never drops a recorded bucket that the calendar walk does not meet', () => {
        const day = 86_400_000;
        const start = Date.UTC(2026, 8, 28) + 3_600_000;
        const mix = { keys: [{ key: 'claude', label: 'Claude', totalTokens: 10 }], buckets: [{ startMs: start, endMs: start + day, total: 10, tokens: [10], shares: [1] }], total: 10, hasData: false };
        expect(fillUsageMixCalendar(mix, { startMs: start - 2 * day, endMs: start + day, granularity: 'day', timeZoneOffsetMinutes: 0 })).toBe(mix);
    });
    it('fills quiet days of a trend with a recorded zero in the same calendar', () => {
        const day = 86_400;
        const start = Date.UTC(2026, 8, 28) / 1000;
        const filled = fillUsageTrendCalendar([{ timestamp: start, tokens: 5, cost: 1, reportCount: 1 }, { timestamp: start + 2 * day, tokens: 7, cost: 2, reportCount: 1 }],
            { startMs: start * 1000, endMs: (start + 2 * day) * 1000, granularity: 'day', timeZoneOffsetMinutes: 0 }, coverage(start * 1000, (start + 2 * day) * 1000, true));
        expect(filled.map((point) => point.tokens)).toEqual([5, 0, 7]);
        expect(filled[1]).toMatchObject({ timestamp: start + day, cost: 0, reportCount: 0 });
    });
    it('keeps missing partial-history days unavailable through the exact-value renderer', async () => {
        const day = 86_400_000;
        const start = Date.UTC(2026, 8, 28);
        const range = { startMs: start, endMs: start + 3 * day, granularity: 'day' as const, timeZoneOffsetMinutes: 0 };
        const points = fillUsageTrendCalendar([{ timestamp: start / 1000, tokens: 5, cost: 1, reportCount: 1 }], range,
            coverage(start, start + 3 * day, false));
        expect(points.map(point => point.tokens)).toEqual([5, null, null]);
        const screen = await renderScreen(<StackedSeriesChart theme={projectPluginUiTheme(lightTheme)} label="Tokens"
            series={usageVolumeSeries(points, 'tokens', 'Tokens', lightTheme.colors.text.link)} variant="bar" size="full"
            unknownLabel="Unavailable" testID="partial" />);
        act(() => pressTestInstance(screen.findByTestId(`partial-bucket-${(start + day) / 1000}`), 'partial bucket'));
        expect(screen.getTextContent()).toContain('Unavailable');
    });
    it('fills zero only inside the producer-proven complete interval and excludes the end boundary', () => {
        const day = 86_400_000;
        const start = Date.UTC(2026, 8, 28);
        const range = { startMs: start - day, endMs: start + 3 * day, granularity: 'day' as const, timeZoneOffsetMinutes: 0 };
        const mix = { keys: [{ key: 'claude', label: 'Claude', totalTokens: 10 }], buckets: [{ startMs: start,
            endMs: start + day, tokens: [10], shares: [1], total: 10 }], total: 10, hasData: true };
        const result = fillUsageMixCalendar(mix, range, coverage(start, start + 2 * day, true));
        expect(result.buckets.map(bucket => bucket.tokens)).toEqual([[null], [10], [0], [null]]);
    });
    it('labels bucket instants in the query offset across UTC midnight', () => {
        const start = Date.UTC(2026, 8, 27, 12);
        const series = usageVolumeSeries([{ timestamp: start / 1000, tokens: 1, cost: 0, reportCount: 1 }],
            'tokens', 'Tokens', lightTheme.colors.text.link, 840);
        expect(series[0]!.points[0]!.label).toBe(new Intl.DateTimeFormat(undefined,
            { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 8, 28))));
    });
});

describe('usage axis ticks', () => {
    const week = ['Oct 10', 'Oct 11', 'Oct 12', 'Oct 13', 'Oct 14', 'Oct 15', 'Oct 16'];
    it('names each label by the bucket it belongs to, never closer than two buckets', () => {
        expect(usageAxisTicks(week, 'Today')).toEqual([
            { label: 'Oct 10', bucket: 0 }, { label: 'Oct 12', bucket: 2 }, { label: 'Oct 14', bucket: 4 }, { label: 'Today', bucket: 6 },
        ]);
        const month = usageAxisTicks(Array.from({ length: 30 }, (_, day) => `d${day}`));
        expect(month.map((tick) => tick.bucket)).toEqual([0, 7, 15, 22, 29]);
        expect(month.every((tick) => tick.label === `d${tick.bucket}`)).toBe(true);
    });
});
