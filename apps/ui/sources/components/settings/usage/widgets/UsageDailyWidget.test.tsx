import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { WidgetFrameBodyRowsContext } from '@/components/widgets/frame/widgetFrameBody';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveUsageDailyChartShape, UsageDailyWidget } from './UsageDailyWidget';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { resetPlayedEntrancesForTests } from '../usageEntrance';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
let controlsHome: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => { standardCleanup(); resetPlayedEntrancesForTests(); await controlsHome?.dispose(); controlsHome = undefined; vi.restoreAllMocks(); });
async function renderControls(children: React.ReactNode) {
  controlsHome = await serveActionHomes({ homes: [{ key: 'daily', serverUrl: 'https://usage-daily-controls.test', accountId: 'daily-account' }],
    route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
  const server = controlsHome.homes.daily!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  return renderMountedCurrentUiContext(children);
}

const day = 86_400_000;
// Friday midnight in UTC+14, so weekend classification cannot use the UTC weekday.
const start = Date.UTC(2026, 9, 8, 10);
function fixture(values: readonly (number | null)[], endMs: number, byAgent = true) {
  const query = normalizeUsageQuery({ period: { startMs: start, endMs }, timeZoneOffsetMinutes: 840, granularity: 'day', metric: 'tokens' });
  const tokens = (value: number) => ({ input: value, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: value });
  const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
    v: 1, totals: { tokens: tokens(total), cost, eventCount: values.filter(value => value !== null).length },
    series: values.flatMap((value, index) => value === null ? [] : [{ bucketStartMs: start + index * day,
      bucketEndMs: start + (index + 1) * day, eventCount: 1, tokens: tokens(value), cost }]),
    engineTimeline: byAgent ? values.flatMap((value, index) => value === null ? [] : [{ bucketStartMs: start + index * day,
      bucketEndMs: start + (index + 1) * day, leaders: [{ key: 'codex:local', eventCount: 1, tokens: tokens(value), cost,
        sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens: tokens(value), cost }] }] }]) : [],
    coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [], missingDimensions: [], ranked: [],
      range: { startMs: start, endMs, complete: false } },
  } }] }).results[0]!;
  const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
  return { query, slice, model, serverId: 'home', id: 'usage_daily' as const, testID: 'daily' };
}

describe('Daily period chart', () => {
  it('rises on first data and draws retained bars immediately on a revisit, keeping change motion', async () => {
    const props = fixture([10, 30], start + 2 * day);
    const first = await renderScreen(<UsageDailyWidget {...props} />);
    expect(first.findByType(StackedSeriesChart).props.barMotion.entrance).toBeDefined();
    await first.unmount();
    const revisit = await renderScreen(<UsageDailyWidget {...props} />);
    const chart = revisit.findByType(StackedSeriesChart);
    expect(chart.props.barMotion.entrance).toBeUndefined();
    expect(chart.props.barMotion.change).toBeDefined();
    expect(chart.props.series[0].points.map((point: { y: number }) => point.y)).toEqual([10, 30]);
  });
  it('gives the plot the room a taller partner leaves in its cell', () => {
    const presentation = { size: 'tall', geometry: { width: 500, height: 368 } } as Parameters<typeof resolveUsageDailyChartShape>[0];
    expect(resolveUsageDailyChartShape(presentation, false).plotPx).toBe(252);
    expect(resolveUsageDailyChartShape(presentation, false, 270).plotPx).toBe(522);
    expect(resolveUsageDailyChartShape(presentation, true, 270).plotPx).toBeLessThanOrEqual(252);
  });
  it.each([true, false])('names date buckets in the shown calendar for accessibility and exact values, retaining their semantic identity (by Agent: %s)', async (byAgent) => {
    const props = fixture([10, 30], start + 2 * day, byAgent);
    const screen = await renderControls(<UsageDailyWidget {...props} />);
    const expected = formatUsageCalendarDate(start, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' });
    const chart = screen.findHostByTestId('daily.chart')!;
    expect(chart.props.accessibilityLabel).toContain(`${expected}:`);
    expect(chart.props.accessibilityLabel).not.toContain(new Intl.NumberFormat().format(start));
    expect(screen.findByType(StackedSeriesChart).props.series[0].points[0].id).toBe(String(byAgent ? start : start / 1000));
    await screen.pressByTestIdAsync('daily.chart-values-toggle');
    const row = screen.findHostByTestId('daily.chart-values-row-0')!;
    expect(row.props.accessibilityLabel).toContain(expected);
    expect(row.props.accessibilityLabel).not.toContain(new Intl.NumberFormat().format(start));
  });
  it('compares today with known completed active days and shades weekends in the shown calendar', async () => {
    const now = start + 3 * day + day / 2;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const screen = await renderScreen(<UsageDailyWidget {...fixture([0, 10, 30, 2], now)} />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.reference.value).toBe(20);
    expect(chart.props.barRanges).toEqual([{ bucketId: String(start + 3 * day), lower: 2, upper: 20, label: expect.any(String) }]);
    expect(chart.props.bucketShading.map((entry: { bucketId: string }) => entry.bucketId)).toEqual([String(start + day), String(start + 2 * day)]);
    expect(chart.props.series[0].points.map((point: { y: number }) => point.y)).toEqual([0, 10, 30, 2]);
  });

  it('includes a completed historical last day, skips uncovered days, and draws no today comparison', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 20 * day);
    const screen = await renderScreen(<UsageDailyWidget {...fixture([10, null, 0, 30], start + 4 * day)} />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.reference.value).toBe(20);
    expect(chart.props.barRanges).toEqual([]);
    expect(chart.props.series[0].points.map((point: { y: number | null }) => point.y)).toEqual([10, null, 0, 30]);
    expect(screen.findAllHostsByTestId(`daily.chart-gap-${start + day}`)).toHaveLength(1);
  });

  it('keys the hatched day in the legend, so a day with no figure reads as one (R137 Costs)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 20 * day);
    const screen = await renderScreen(<UsageDailyWidget {...fixture([10, null, 0, 30], start + 4 * day)} />);
    expect(screen.findByType(StackedSeriesChart).props.gapLabel).toBe(t('usage.board.howYouWork.notRecorded'));
    expect(screen.getTextContent()).toContain(t('usage.board.howYouWork.notRecorded'));
    await screen.unmount();
    const covered = await renderScreen(<UsageDailyWidget {...fixture([10, 20, 0, 30], start + 4 * day)} />);
    expect(covered.getTextContent()).not.toContain(t('usage.board.howYouWork.notRecorded'));
  });

  it('can compare one witnessed active day without treating an uncovered today as observed usage', async () => {
    const now = start + day + day / 2;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const screen = await renderScreen(<UsageDailyWidget {...fixture([10, null], now)} />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.reference.value).toBe(10);
    expect(chart.props.barRanges).toEqual([]);
    expect(chart.props.series[0].points.map((point: { y: number | null }) => point.y)).toEqual([10, null]);
    expect(screen.findAllHostsByTestId(`daily.chart-gap-${start + day}`)).toHaveLength(1);
  });

  it.each(['small', 'wide'] as const)('keeps the selected period and unknown gaps in %s geometry', async (size) => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 20 * day);
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size,
      footprint: { columns: 2, columnSpan: size === 'small' ? 1 : 2, rowSpan: 1, width: size === 'small' ? 'half' : 'full', height: 'compact' },
      geometry: { width: size === 'small' ? 320 : 640, height: 96 } }}>
      <UsageDailyWidget {...fixture([10, null, 0, 30], start + 4 * day)} />
    </WidgetPresentationProvider>);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series[0].points).toHaveLength(4);
    // The UI owner reserves room for the axis; compact plots must fit their
    // measured body rather than imposing the full chart's minimum height.
    expect(chart.props.viewportHeight).toBeGreaterThan(0);
    expect(chart.props.viewportHeight).toBeLessThanOrEqual(96);
    expect(chart.props.showLegend).toBe(false);
    expect(screen.findAllHostsByTestId(`daily.chart-gap-${start + day}`)).toHaveLength(1);
    expect(screen.findAllHostsByTestId('daily.chart-bar-3-0')).toHaveLength(1);
  });
});

describe('Daily keeps its shape: declared plot height and a chart-shaped first read', () => {
  const medium = { size: 'medium' as const, footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular' as const, width: 'half' as const } };
  const plotOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findByType(StackedSeriesChart).props.viewportHeight as number;
  it('draws the same plot in a tall cell as in its own room, so a taller partner or a refresh never stretches it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 20 * day);
    const props = fixture([10, 30, 20], start + 3 * day);
    // Its own room: the declared 252 px plot with the peak figure, axis, legend and coverage note around it.
    const own = await renderScreen(<WidgetPresentationProvider value={{ ...medium, geometry: { width: 560, height: 368 } }}><UsageDailyWidget {...props} /></WidgetPresentationProvider>);
    const tall = await renderScreen(<WidgetPresentationProvider value={{ ...medium, geometry: { width: 560, height: 920 } }}><UsageDailyWidget {...props} /></WidgetPresentationProvider>);
    expect(plotOf(tall)).toBe(plotOf(own));
    expect(plotOf(own)).toBeGreaterThanOrEqual(200);
  });
  it('decides its plot before first paint from the room its frame declares, never from a box measured after mount (sweep 1110 #8)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 20 * day);
    const props = fixture([10, 30, 20], start + 3 * day);
    const inRoom = (geometry?: { width: number; height: number }) => <WidgetFrameBodyRowsContext.Provider value={4}>
      <WidgetPresentationProvider value={{ ...medium, ...(geometry ? { geometry } : {}) }}><UsageDailyWidget {...props} /></WidgetPresentationProvider>
    </WidgetFrameBodyRowsContext.Provider>;
    // First paint (nothing measured yet), then the frame's measured box at its own height and at a stretched one.
    const first = plotOf(await renderScreen(inRoom()));
    const measured = plotOf(await renderScreen(inRoom({ width: 560, height: 300 })));
    const stretched = plotOf(await renderScreen(inRoom({ width: 560, height: 700 })));
    expect(measured).toBe(first);
    expect(stretched).toBe(first);
  });
  it('holds the settled chart\'s room while its first read is pending, then says what it is still reading', async () => {
    vi.useFakeTimers();
    try {
      const props = fixture([10, 30], start + 2 * day);
      const query = props.query;
      const slice = resolveUsagePageAggregation({ queries: [query], sources: [{ source: 'accounting', status: 'pending' as const }] }).results[0]!;
      const geometry = { width: 560, height: 336 };
      const settled = await renderScreen(<WidgetPresentationProvider value={{ ...medium, geometry }}><UsageDailyWidget {...props} /></WidgetPresentationProvider>);
      const reading = await renderScreen(<WidgetPresentationProvider value={{ ...medium, geometry }}><UsageDailyWidget {...props} slice={slice} /></WidgetPresentationProvider>);
      const plot = reading.findHostByTestId('daily.loading.plot');
      expect(plot).not.toBeNull();
      expect(plot!.props.style).toEqual(expect.objectContaining({ height: plotOf(settled) }));
      expect(reading.findHostByTestId('daily.loading.note')?.props.children ?? null).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reading.getTextContent()).toMatch(/usage\.board\.page\.coveragePending|Still reading/);
    } finally {
      vi.useRealTimers();
    }
  });
});
