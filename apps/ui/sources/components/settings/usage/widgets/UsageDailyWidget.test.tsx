import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { GestureDetector } from 'react-native-gesture-handler';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import { UsageObservationCostSchema, type UsageObservationCost } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { serializeUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrameBodyRowsContext } from '@/components/widgets/frame/widgetFrameBody';
import { WidgetFrameBodyCaptionContext, WidgetFrameBodyIdentityContext, type WidgetFrameBodyIdentity } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { usageSourceTitle } from '@/sync/domains/usage/usageLabels';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { ScrubLens } from '../UsageScrubLens';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { resetPlayedEntrancesForTests } from '../usageEntrance';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
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
function fixture(values: readonly (number | null)[], endMs: number, byAgent = true, granularity: 'hour' | 'day' | 'week' = 'day',
  members = ['codex'], byModel = false, period: UsageQuery['period'] = { startMs: start, endMs }) {
  const query = normalizeUsageQuery({ period, timeZoneOffsetMinutes: 840, granularity, metric: 'tokens', ...(byModel ? { breakdown: ['model'] } : {}) });
  const step = granularity === 'week' ? 7 * day : granularity === 'hour' ? 3_600_000 : day;
  const bucket = (index: number) => resolveUsageBucketBounds(granularity, start + index * step, query.timeZoneOffsetMinutes);
  const tokens = (value: number) => ({ input: value, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: value });
  const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
  const totalAt = (value: number) => members.reduce((sum, _id, rank) => sum + value + rank, 0);
  const total = values.reduce<number>((sum, value) => sum + (value === null ? 0 : totalAt(value)), 0);
  const timeline = byAgent || byModel ? values.flatMap((value, index) => value === null ? [] : [{
    ...bucket(index), leaders: members.map((id, rank) => {
      const reading = tokens(value + rank);
      return { key: byModel ? id : `${id}:local`, label: id === 'folded-member' ? 'Folded member' : undefined,
        eventCount: 1, tokens: reading, cost, ...(byModel ? {} : {
          sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens: reading, cost }],
        }) };
    }),
  }]) : [];
  const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
    v: 1, totals: { tokens: tokens(total), cost, eventCount: values.filter(value => value !== null).length },
    series: values.flatMap((value, index) => value === null ? [] : [{ ...bucket(index), eventCount: 1, tokens: tokens(totalAt(value)), cost }]),
    engineTimeline: byModel ? [] : timeline,
    ...(byModel ? { modelTimeline: timeline } : {}),
    coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [], missingDimensions: [], ranked: [],
      range: { startMs: start, endMs, complete: false } },
  } }] }, bundledUsageModelPriceCatalog).results[0]!;
  const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
  return { query, slice, model, serverId: 'home', id: 'usage_daily' as const, testID: 'daily' };
}

describe('Daily period chart', () => {
  it.each([['daily', false], ['flow', false], ['flow', true]] as const)(
    'keeps every admitted member in %s Values when the drawing folds a member into Other (by model: %s)', async (kind, byModel) => {
    const props = fixture([10, 20], start + 2 * day, !byModel, 'day', ['folded-member', 'b', 'c', 'd', 'e', 'f'], byModel);
    const screen = await renderControls(kind === 'daily' ? <UsageDailyWidget {...props} />
      : <UsageFlowWidget {...props} id="usage_flow" testID="flow" />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series.map((entry: { id: string }) => entry.id)).toEqual(['f', 'e', 'd', 'c', 'b', '__other__']);
    await screen.pressByTestIdAsync(`${kind}.chart-values-toggle`);
    const row = screen.findHostByTestId(`${kind}.chart-values-row-0`)!;
    expect(row.props.accessibilityLabel).toMatch(/folded member: 10/i);
    const amounts = [...row.props.accessibilityLabel.matchAll(/: (\d+)(?= · |, |$)/g)].map(match => Number(match[1]));
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(75);
  });
  it('keeps the running bucket in the spoken chart and Exact values after the area ends', async () => {
    const end = start + 6 * day + 3_600_000;
    const props = fixture([10, 10, 10, 10, 10, 10, 17], end, true, 'day', undefined, false, { relative: '7days' });
    vi.spyOn(Date, 'now').mockReturnValue(end + 1);
    const screen = await renderControls(<UsageFlowWidget {...props} id="usage_flow" testID="flow" />);
    expect(screen.findByType(StackedSeriesChart).props.series[0].points.map((point: { y: number }) => point.y))
      .toEqual([10, 10, 10, 10, 10, 10]);
    const qualifier = t('session.transcriptNavigation.soFar');
    expect(screen.findHostByTestId('flow.chart')?.props.accessibilityLabel).toContain(`${qualifier}: Codex 17`);
    await screen.pressByTestIdAsync('flow.chart-values-toggle');
    const finalRow = screen.findHostByTestId('flow.chart-values-row-6');
    expect(finalRow?.props.accessibilityLabel).toContain(`${qualifier}: Codex: 17`);
    const displayedAmounts = Array.from({ length: 7 }, (_, index) => (
      Number(screen.findHostByTestId(`flow.chart-values-row-${index}`)?.props.accessibilityLabel.match(/Codex: (\d+)/u)?.[1])
    ));
    expect(displayedAmounts.reduce((sum, amount) => sum + amount, 0)).toBe(props.slice.accounting?.totals.tokens.total);
  });
  it('keeps the qualified running reading and Exact values when the observed run is too short to plot', async () => {
    const end = start + 6 * day + 3_600_000;
    const props = fixture([null, null, null, null, null, 12, 17], end, true, 'day', undefined, false, { relative: '7days' });
    vi.spyOn(Date, 'now').mockReturnValue(end + 1);
    const caption = vi.fn();
    const screen = await renderControls(
      <WidgetFrameBodyCaptionContext.Provider value={caption}>
        <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      </WidgetFrameBodyCaptionContext.Provider>,
    );
    const qualifier = t('session.transcriptNavigation.soFar');
    expect(screen.findHostByTestId('flow.empty')).toBeTruthy();
    expect(screen.findHostByTestId('flow.chart-scale-0')).toBeFalsy();
    expect(caption).toHaveBeenLastCalledWith(expect.stringContaining(qualifier));
    expect(screen.getTextContent()).toContain(`17 · ${qualifier}`);
    expect(screen.findHostByTestId('flow.chart')?.props.accessibilityLabel).toContain(`${qualifier}: Codex 17`);
    await screen.pressByTestIdAsync('flow.chart-values-toggle');
    // The existing Flow trim leaves out the five leading unread buckets.
    const rows = Array.from({ length: 2 }, (_, index) =>
      screen.findHostByTestId(`flow.chart-values-row-${index}`)?.props.accessibilityLabel ?? '');
    expect(rows.at(-1)).toContain(`${qualifier}: Codex: 17`);
    const values = rows.flatMap(row => [...row.matchAll(/Codex: (\d+)/gu)].map(match => Number(match[1])));
    expect(values).toEqual([12, 17]);
    expect(values.reduce((sum, amount) => sum + amount, 0)).toBe(props.slice.accounting?.totals.tokens.total);
  });
  it.each([
    { period: { relative: 'today' }, granularity: 'hour' },
    { period: { relative: '7days' }, granularity: 'day' },
  ] as const)('draws the first $granularity and names its partial total once', async ({ period, granularity }) => {
    const end = start + 30 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(end + 1);
    const props = fixture([17], end, true, granularity, undefined, false, period);
    const caption = vi.fn();
    const screen = await renderControls(
      <WidgetFrameBodyCaptionContext.Provider value={caption}>
        <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      </WidgetFrameBodyCaptionContext.Provider>,
    );
    const qualifier = t('session.transcriptNavigation.soFar');
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series[0].points.map((point: { y: number }) => point.y)).toEqual([17]);
    expect(caption).toHaveBeenLastCalledWith(expect.stringContaining(qualifier));
    expect(screen.findHostByTestId('flow.chart')?.props.accessibilityLabel).toContain(qualifier);
    await screen.pressByTestIdAsync('flow.chart-values-toggle');
    const amount = props.slice.accounting!.totals.tokens.total;
    expect(screen.findHostByTestId('flow.chart-values-row-0')?.props.accessibilityLabel)
      .toContain(`${qualifier}: Codex: ${amount}`);
    expect(screen.findHostByTestId('flow.chart-values-row-1')).toBeFalsy();
  });

  it('draws the last mark of a custom range that finished during this day', async () => {
    const end = start + 4 * day + 30 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(end + 1);
    const props = fixture([10, 10, 10, 10, 17], end);
    const screen = await renderControls(<UsageFlowWidget {...props} id="usage_flow" testID="flow" />);
    expect(screen.findByType(StackedSeriesChart).props.series[0].points.map((point: { y: number }) => point.y))
      .toEqual([10, 10, 10, 10, 17]);
    await screen.pressByTestIdAsync('flow.chart-values-toggle');
    const rows = Array.from({ length: 5 }, (_, index) =>
      screen.findHostByTestId(`flow.chart-values-row-${index}`)?.props.accessibilityLabel);
    expect(rows[4]).not.toContain(t('session.transcriptNavigation.soFar'));
    expect(rows.reduce((sum, row) => sum + Number(row?.match(/Codex: (\d+)/u)?.[1]), 0))
      .toBe(props.slice.accounting?.totals.tokens.total);
  });

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
  it('names weekly bars by the dates they start on and names the card for its weekly bars (USAGE-ACCEPT 1118 #18, 1121 #16)', async () => {
    // Keep the last week running: replacing its date with "This week" must fail too (review F-05).
    vi.spyOn(Date, 'now').mockReturnValue(start + 12 * day);
    const props = fixture([10, 30, 20], start + 14 * day, true, 'week');
    const lent: (WidgetFrameBodyIdentity | null)[] = [];
    const screen = await renderScreen(<WidgetFrameBodyIdentityContext.Provider value={(identity) => { lent.push(identity); }}>
      <UsageDailyWidget {...props} />
    </WidgetFrameBodyIdentityContext.Provider>);
    const chart = screen.findByType(StackedSeriesChart);
    const shortDate = (date: number) => formatUsageCalendarDate(date, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' });
    expect(chart.props.axisTicks.map((tick: { label: string }) => tick.label)).toEqual([shortDate(start), shortDate(start + 10 * day)]);
    // "Daily usage · by week" contradicted itself at 1Y: the frame takes "Weekly usage" and the chart says it too.
    expect(lent.at(-1)?.title).toBe(t('usage.board.page.weeklyUsage'));
    expect(chart.props.label).toContain(t('usage.board.page.weeklyUsage'));
  });
  it('names the card for its daily bars once the read says them; the catalog name stays bucket-neutral (J-B78)', async () => {
    const lent: (WidgetFrameBodyIdentity | null)[] = [];
    await renderScreen(<WidgetFrameBodyIdentityContext.Provider value={(identity) => { lent.push(identity); }}>
      <UsageDailyWidget {...fixture([10, 30], start + 2 * day)} />
    </WidgetFrameBodyIdentityContext.Provider>);
    expect(lent.at(-1)?.title).toBe(t('usage.board.page.dailyUsage'));
    expect(t('usage.widgets.usage_daily')).not.toBe(t('usage.board.page.dailyUsage'));
  });
  it('names the card for the bars its period draws from the first read, never the catalog name first (USAGE-DESIGN-PASS-57 #7)', async () => {
    const { UsageWidgetBody } = await import('./UsageWidgetBody');
    const query = normalizeUsageQuery({ period: { relative: '7days' }, metric: 'tokens' });
    const lent: (WidgetFrameBodyIdentity | null)[] = [];
    const facts = { authority: { serverId: 'home', accountId: 'usage-account' }, query, slice: null, pending: true, error: null,
      refresh: async () => {} };
    await renderScreen(<WidgetFrameBodyIdentityContext.Provider value={(identity) => { lent.push(identity); }}>
      <UsageWidgetBody id="usage_daily" input={{}} serverId="home" testID="daily" facts={facts} />
    </WidgetFrameBodyIdentityContext.Provider>);
    expect(lent.at(-1)?.title).toBe(t('usage.board.page.dailyUsage'));
  });
  it('holds the settled chart room on the Usage page, where the header says coverage and the body draws no note (USAGE-DESIGN-PASS-57 #6)', async () => {
    const { UsageBodyReading, USAGE_CHART_FRAME_PX, resolveUsageChartChromePx } = await import('./usageBodyKit');
    const { UsageWidgetBatchProvider } = await import('./usageWidgetBatch');
    const { readUsageWidgetQueryOverrides } = await import('../usageWidgetPageContext');
    const query = normalizeUsageQuery({ period: { relative: '7days' }, metric: 'tokens' });
    const shape = { kind: 'chart' as const, plotPx: 252, peak: true };
    const minHeightOf = async (node: React.ReactElement) => {
      const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'medium',
        footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 480, height: 400 } }}>{node}</WidgetPresentationProvider>);
      const style = screen.findHostByTestId('daily.loading')!.props.style;
      await screen.unmount();
      return (Array.isArray(style) ? Object.assign({}, ...style) : style).minHeight as number;
    };
    const home = await minHeightOf(<UsageBodyReading testID="daily.loading" shape={shape} />);
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const page = await minHeightOf(<InjectedAuthProvider credentials={null}>
      <UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(query)} enabled={false}>
        <UsageBodyReading testID="daily.loading" shape={shape} />
      </UsageWidgetBatchProvider>
    </InjectedAuthProvider>);
    expect(home).toBe(252 + resolveUsageChartChromePx(480, { peak: true }));
    expect(page).toBe(home - USAGE_CHART_FRAME_PX.note);
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

  it.each([true, false])('distinguishes alternate pricing from a price gap after a Daily bucket merge (by Agent: %s)', async (byAgent) => {
    const endMs = start + 6 * day;
    vi.spyOn(Date, 'now').mockReturnValue(endMs + day);
    const props = fixture([null, 10, 20, 30, 40, 50], endMs, byAgent);
    const query = normalizeUsageQuery({ ...props.query, metric: 'cost', costBasis: 'reported' });
    const accounting = props.slice.accounting!;
    const unpriced = { reportedUsd: null, estimatedUsd: null, currency: 'USD' };
    const apiPriced = { ...unpriced, apiEquivalentUsd: 2, pricingSource: 'catalog' };
    const reported = (amount: number) => ({ ...unpriced, reportedUsd: amount });
    const operands = [[unpriced], [apiPriced], [reported(3), apiPriced], [reported(4), unpriced], [reported(1.5)]];
    const compact = (costs: readonly UsageObservationCost[]) => UsageObservationCostSchema.parse(JSON.parse(JSON.stringify(
      serializeUsageCostBasis(aggregateUsageContributionCosts(costs.map(cost => ({ cost })), 'reported'), 'reported'),
    )));
    const costs = operands.map(compact);
    const period = operands.flat();
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
      ...accounting,
      totals: { ...accounting.totals, eventCount: period.length, cost: compact(period) },
      series: accounting.series?.map((bucket, index) => ({ ...bucket, eventCount: operands[index]!.length, cost: costs[index]! })),
      engineTimeline: accounting.engineTimeline?.map((bucket, index) => ({
        ...bucket, leaders: bucket.leaders.map(leader => ({ ...leader,
          eventCount: operands[index]!.length, cost: costs[index]!,
          sources: operands[index]!.map((cost, sourceIndex) => ({
            ...leader.sources![0]!,
            ...(sourceIndex === 1 ? { source: 'native', path: 'native' as const, execution: 'outside' as const } : {}),
            cost: compact([cost]),
          })),
        })),
      })),
    } }] }, bundledUsageModelPriceCatalog).results[0]!;
    const widget = <UsageDailyWidget {...props} query={query} slice={slice} />;
    const screen = byAgent ? await renderControls(widget) : await renderScreen(widget);
    const bucketId = (index: number) => String((start + index * day) / (byAgent ? 1 : 1_000));
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series[0].points.map((point: { y: number | null }) => point.y)).toEqual([null, null, null, 3, 4, 1.5]);
    for (const [index, hatched] of [false, true, false, false, true, false].entries()) {
      expect.soft(Boolean(screen.findHostByTestId(`daily.chart-gap-${bucketId(index)}`)), `Day ${index + 1} hatch`).toBe(hatched);
    }
    expect(screen.findHostByTestId('daily.chart-gap-key')).toBeTruthy();
    expect.soft(chart.props.reference?.value).toBe(1.5);
    expect.soft(screen.findHostByTestId('daily.chart-peak')?.props.children).toBe('$1.50');
    if (byAgent) {
      await act(async () => {
        screen.findHostByTestId('daily.chart')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 640, height: 240 } } });
      });
      const scrub = screen.findByType(ScrubLens);
      const x = scrub.props.layout.centers[2];
      const gesture = scrub.findByType(GestureDetector).props.gesture;
      await act(async () => { gesture.gestures[1].gestures[1].__handlers.onEnd({ x }); });
      const lens = screen.findByTestId('daily.lens-lens');
      expect(lens).toBeTruthy();
      const labels = lens!.findAllByType(Text).map(node => node.props.children);
      expect(labels).toContain([
        t('usage.board.page.executionHappier'), usageSourceTitle('runtime'), t('usage.board.page.costBasisUnavailable'),
      ].join(' · '));
    }
  });

  it('does not inspect alternate prices on timeline leaders or sources when Flow has no selected basis', async () => {
    const endMs = start + 7 * day;
    const props = fixture([10, 20, 30, 40, 50, 60, 70], endMs, true, 'day', ['codex', 'claude', 'gemini', 'cursor', 'opencode', 'qwen']);
    const query = normalizeUsageQuery({ ...props.query, metric: 'cost', costBasis: 'reported' });
    const accounting = props.slice.accounting!;
    const onlyApi = serializeUsageCostBasis({
      reportedUsd: null, estimatedUsd: null, currency: 'USD', apiEquivalentUsd: 2, pricingSource: 'catalog',
    }, 'reported');
    // Previously serialized leaders can have a selected amount without a stored missing-price fact.
    const legacyApiOnly = { ...onlyApi, selectedBasis: { mode: 'reported' as const, value: null } };
    let leaderCostReads = 0;
    let sourceCostReads = 0;
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
      ...accounting, totals: { ...accounting.totals, cost: onlyApi },
      series: accounting.series?.map(bucket => ({ ...bucket, cost: onlyApi })),
      engineTimeline: accounting.engineTimeline?.map(bucket => ({
        ...bucket, leaders: bucket.leaders.map(leader => ({
          ...leader,
          cost: { ...legacyApiOnly, get apiEquivalentUsd() { leaderCostReads += 1; return onlyApi.apiEquivalentUsd!; } },
          sources: leader.sources?.map(source => ({
            ...source,
            cost: { ...legacyApiOnly, get apiEquivalentUsd() { sourceCostReads += 1; return onlyApi.apiEquivalentUsd!; } },
          })),
        })),
      })),
    } }] }, bundledUsageModelPriceCatalog).results[0]!;
    leaderCostReads = 0;
    sourceCostReads = 0;
    const screen = await renderScreen(<UsageFlowWidget {...props} query={query} slice={slice} id="usage_flow" testID="flow" />);
    expect(screen.findHostByTestId('flow.empty')).toBeTruthy();
    expect({ leaderCostReads, sourceCostReads }).toEqual({ leaderCostReads: 0, sourceCostReads: 0 });
  });

  it('hatches recorded unpriced Daily costs even when an Agent has a known bar or zero', async () => {
    const endMs = start + 4 * day;
    const props = fixture([20, 10, null, 30], endMs);
    const query = normalizeUsageQuery({ ...props.query, metric: 'cost', costBasis: 'reported' });
    const accounting = props.slice.accounting!;
    const price = (reportedUsd: number | null) => ({ reportedUsd, estimatedUsd: null, currency: 'USD' as const });
    const [priced, unpriced, partial] = accounting.engineTimeline!;
    const base = priced!.leaders[0]!;
    const leader = (key: string, amount: number | null) => ({
      ...base, key, cost: price(amount), sources: base.sources?.map(source => ({ ...source, cost: price(amount) })),
    });
    const value = { ...accounting,
      totals: { ...accounting.totals, cost: price(5) },
      series: accounting.series?.map((bucket, index) => ({ ...bucket, cost: price([2, null, 3][index]!) })),
      engineTimeline: [
        { ...priced!, leaders: [leader('codex:local', 2)] },
        { ...unpriced!, leaders: [leader('claude:local', null)] },
        { ...partial!, leaders: [leader('codex:local', 3), leader('claude:local', null)] },
      ],
      coverage: { ...accounting.coverage!, status: 'complete' as const, reasons: [],
        range: { startMs: start, endMs, complete: true } },
    };
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value }] },
      bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageDailyWidget {...props} query={query} slice={slice} />);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.series.map((series: React.ComponentProps<typeof StackedSeriesChart>['series'][number]) => series.points[1]?.y)).toEqual([0, null]);
    const hatches = Array.from({ length: 4 }, (_, index) => Boolean(screen.findHostByTestId(`daily.chart-gap-${start + index * day}`)));
    expect(hatches).toEqual([false, true, false, true]);
    expect(screen.findHostByTestId('daily.chart-bar-3-0')).toBeTruthy();
    expect(screen.findHostByTestId('daily.chart-gap-key')).toBeTruthy();
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
