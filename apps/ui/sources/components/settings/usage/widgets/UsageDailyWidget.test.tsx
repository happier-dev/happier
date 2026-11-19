import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import { serializeUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { WidgetFrameBodyRowsContext } from '@/components/widgets/frame/widgetFrameBody';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { UsageDailyWidget } from './UsageDailyWidget';
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
function fixture(values: readonly (number | null)[], endMs: number, byAgent = true, granularity: 'day' | 'week' = 'day') {
  const query = normalizeUsageQuery({ period: { startMs: start, endMs }, timeZoneOffsetMinutes: 840, granularity, metric: 'tokens' });
  const step = granularity === 'week' ? 7 * day : day;
  const bucket = (index: number) => resolveUsageBucketBounds(granularity, start + index * step, query.timeZoneOffsetMinutes);
  const tokens = (value: number) => ({ input: value, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: value });
  const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
    v: 1, totals: { tokens: tokens(total), cost, eventCount: values.filter(value => value !== null).length },
    series: values.flatMap((value, index) => value === null ? [] : [{ ...bucket(index), eventCount: 1, tokens: tokens(value), cost }]),
    engineTimeline: byAgent ? values.flatMap((value, index) => value === null ? [] : [{ ...bucket(index), leaders: [{ key: 'codex:local', eventCount: 1, tokens: tokens(value), cost,
        sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens: tokens(value), cost }] }] }]) : [],
    coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [], missingDimensions: [], ranked: [],
      range: { startMs: start, endMs, complete: false } },
  } }] }, bundledUsageModelPriceCatalog).results[0]!;
  const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
  return { query, slice, model, serverId: 'home', id: 'usage_daily' as const, testID: 'daily' };
}

describe('Daily period chart', () => {
  it('conserves admitted weekly amounts and calls out both clipped weeks', async () => {
    const props = fixture([10, 30, 20], start + 14 * day, true, 'week');
    const screen = await renderScreen(<UsageDailyWidget {...props} />);
    const points = screen.findByType(StackedSeriesChart).props.series[0].points;
    const shortDate = (date: number) => formatUsageCalendarDate(date, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' });
    expect(points.map((point: { y: number }) => point.y)).toEqual([10, 30, 20]);
    expect(points.map((point: { label: string }) => point.label)).toEqual([
      t('usage.board.charts.partialWeek', { from: shortDate(start), to: shortDate(start + 2 * day) }),
      shortDate(start + 3 * day),
      t('usage.board.charts.partialWeek', { from: shortDate(start + 10 * day), to: shortDate(start + 13 * day) }),
    ]);
  });
  it('names weekly bars by the dates they start on and says the chart is by week (USAGE-ACCEPT 1118 #18)', async () => {
    // Keep the last week running: replacing its date with "This week" must fail too (review F-05).
    vi.spyOn(Date, 'now').mockReturnValue(start + 12 * day);
    const props = fixture([10, 30, 20], start + 14 * day, true, 'week');
    const screen = await renderScreen(<UsageDailyWidget {...props} />);
    const chart = screen.findByType(StackedSeriesChart);
    const shortDate = (date: number) => formatUsageCalendarDate(date, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' });
    expect(chart.props.axisTicks.map((tick: { label: string }) => tick.label)).toEqual([shortDate(start), shortDate(start + 10 * day)]);
    expect(chart.props.label).toContain(t('usage.board.page.byWeek'));
  });
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

  it.each([
    { hasCompleteDay: true, missingEngine: 'claude:local', firstDay: [2, null] },
    { hasCompleteDay: false, missingEngine: 'claude:local', firstDay: [2, null] },
    { hasCompleteDay: true, missingEngine: 'codex:remote', firstDay: [2] },
    { hasCompleteDay: true, missingEngine: 'codex:local', firstDay: [2] },
    { hasCompleteDay: true, missingEngine: 'no Agent split', firstDay: [2] },
  ])('keeps unpriced Agent cost out of the exact average and peak ($missingEngine, complete day: $hasCompleteDay)', async ({
    hasCompleteDay, missingEngine, firstDay,
  }) => {
    const endMs = start + 2 * day;
    vi.spyOn(Date, 'now').mockReturnValue(endMs + day);
    const props = fixture([10, 20], endMs);
    const query = normalizeUsageQuery({ ...props.query, metric: 'cost', costBasis: 'reported' });
    const observed = props.slice.accounting!;
    const price = (reportedUsd: number | null) => ({ reportedUsd, estimatedUsd: null, currency: 'USD' });
    const byAgent = (key: string, reportedUsd: number | null) => ({ key, eventCount: 1,
      tokens: observed.totals.tokens, cost: price(reportedUsd),
      sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const,
        eventCount: 1, tokens: observed.totals.tokens, cost: price(reportedUsd) }] });
    const partialDayCost = serializeUsageCostBasis(aggregateUsageContributionCosts([
      { cost: price(2) }, { cost: price(null) },
    ], 'reported'), 'reported');
    const sameEngine = missingEngine === 'codex:local';
    const noAgentSplit = missingEngine === 'no Agent split';
    const mixedDay = sameEngine ? [{ ...byAgent('codex:local', 2), eventCount: 2,
      cost: partialDayCost }]
      : [byAgent('codex:local', 2), byAgent(missingEngine, null)];
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
      ...observed,
      totals: { ...observed.totals, cost: price(hasCompleteDay ? 3.5 : 2) },
      ...(noAgentSplit && observed.series ? {
        series: observed.series.map((bucket, index) => ({ ...bucket, cost: index === 0 ? partialDayCost : price(1.5) })),
      } : {}),
      engineTimeline: noAgentSplit ? [] : [
        { bucketStartMs: start, bucketEndMs: start + day, leaders: mixedDay },
        { bucketStartMs: start + day, bucketEndMs: endMs,
          leaders: sameEngine ? [byAgent('codex:local', 1.5)]
            : [byAgent('codex:local', 0.5), byAgent(missingEngine, hasCompleteDay ? 1 : null)] },
      ],
    } }] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageDailyWidget {...props} query={query} slice={slice} />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series.map((entry: { points: { y: number | null }[] }) => entry.points[0]?.y)).toEqual(firstDay);
    expect(chart.props.reference?.value).toBe(hasCompleteDay ? 1.5 : undefined);
    expect(screen.findHostByTestId('daily.chart-peak')?.props.children).toBe(hasCompleteDay ? '$1.50' : undefined);
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

  it.each([true, false])('keeps token parts out of exact Daily comparisons and peaks (by Agent: %s)', async (byAgent) => {
    const endMs = start + 2 * day;
    vi.spyOn(Date, 'now').mockReturnValue(endMs + day);
    const props = fixture([30, 10], endMs, byAgent);
    const observed = props.slice.accounting!;
    const floor = { input: 30, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const slice = resolveUsagePageAggregation({ queries: [props.query], accounting: [{ query: props.query, status: 'available', value: {
      ...observed,
      series: observed.series?.map((bucket, index) => index === 0 ? { ...bucket, tokens: floor } : bucket),
      engineTimeline: observed.engineTimeline?.map((bucket, index) => index === 0 ? { ...bucket, leaders: bucket.leaders.map(leader => ({
        ...leader, tokens: floor, sources: leader.sources?.map(source => ({ ...source, tokens: floor })),
      })) } : bucket),
    } }] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageDailyWidget {...props} slice={slice} />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series[0].points.map((point: { y: number | null }) => point.y)).toEqual([30, 10]);
    expect(chart.props.reference?.value).toBe(10);
    expect(screen.findHostByTestId('daily.chart-peak')?.props.children).toBe('10');
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
  it('draws an empty population as its flat days beside a partner, and one quiet line where a read reported a gap (R8 #2)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 20 * day);
    // The server's empty population: zero totals, coverage 'unknown' with no reason (no source to cover).
    const empty = (reasons: readonly string[]) => {
      const props = fixture([], start + 3 * day, false);
      const accounting = props.slice.accounting!;
      const slice = { ...props.slice, accounting: { ...accounting, coverage: { ...accounting.coverage!, status: reasons.length ? 'partial' as const : 'unknown' as const,
        reasons: reasons as never, range: { startMs: start, endMs: start + 3 * day, complete: false } } } };
      return { ...props, slice, model: { ...props.model, slice } };
    };
    const room = { ...medium, geometry: { width: 560, height: 368 } };
    const read = await renderScreen(<WidgetPresentationProvider value={room}><UsageDailyWidget {...empty([])} /></WidgetPresentationProvider>);
    const chart = read.findByType(StackedSeriesChart);
    expect(chart.props.series.flatMap((entry: { points: { y: number | null }[] }) => entry.points.map(point => point.y))).toEqual([0, 0, 0]);
    expect([chart.props.showScaleValues, chart.props.showPeakValue, chart.props.showLegend]).toEqual([false, false, false]);
    const unknown = await renderScreen(<WidgetPresentationProvider value={room}><UsageDailyWidget {...empty(['incomplete_history'])} /></WidgetPresentationProvider>);
    expect(unknown.findAllByType(StackedSeriesChart)).toHaveLength(0);
  });
  it('holds the settled chart\'s room while its first read is pending, then says what it is still reading', async () => {
    vi.useFakeTimers();
    try {
      const props = fixture([10, 30], start + 2 * day);
      const query = props.query;
      const slice = resolveUsagePageAggregation({ queries: [query], sources: [{ source: 'accounting', status: 'pending' as const }] }, bundledUsageModelPriceCatalog).results[0]!;
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
