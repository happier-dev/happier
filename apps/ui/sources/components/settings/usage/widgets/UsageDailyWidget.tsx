import * as React from 'react';
import { View } from 'react-native';
import { UsageAccountingMetricSchema, getUsageQueryKey } from '@happier-dev/protocol/inputs/usageQuery';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import {
  UsageDailyChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption, useWidgetFrameBodyIdentity } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import { agentIdFromEngineKey, USAGE_MODEL_MIX_OTHER_KEY } from '@/sync/api/account/usageAnalytics';
import { createUsageAgentSeriesColor, usageOtherColor, usageSignatureAccent } from '../usageAccent';
import { formatUsageCalendarDate, formatUsageWeeklyBucketLabel, resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageCostKindPhrase, usagePageCostTrend } from '../usageCostPresentation';
import { useUsageDrill } from '../usageDrill';
import { useUsageChartDetails } from './usageMountedControls';
import {
  fillUsageMixCalendar,
  fillUsageTrendCalendar,
  usageAxisTicks,
  usageDailyBarGeometry,
  usageSeriesValueFormatter,
  usageVolumeSeries,
  usageSourceTimelineSeries,
  useUsageSeriesLens,
  useUsageSeriesMotion,
  type UsageSeriesChoice,
} from '../usageSeriesPresentation';
import {
  UsageAgentMark,
  UsageCoverageLine,
  usageAgentTitle,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
  useUsageChartPlotPx,
  USAGE_CHART_FRAME_PX,
} from './usageBodyKit';

/** Only a roomy, full-size Daily draws the peak figure above its plot; a phone and a compact card do not. */
function dailyShowsPeak(phone: boolean, compact: boolean): boolean {
  return !phone && !compact;
}

/**
 * Daily's plot height and the room its settled chart holds, decided before its first paint from the room its frame
 * declares (`useUsageChartPlotPx`). A compact card (Small, Wide) fits its one row; every other size draws the
 * declared plot, so a taller partner or its own drawn box never re-sizes it after it draws (sweep 1110 #8). The
 * plot's floor leaves the peak figure's room inside the 120 px a plot keeps, so a Medium card still holds the
 * legend and the coverage note.
 */
export function useUsageDailyChartShape(): Readonly<{ kind: 'chart'; plotPx: number; peak: boolean }> {
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  const peak = dailyShowsPeak(phone, false);
  const plotPx = useUsageChartPlotPx(phone ? 140 : 120 - USAGE_CHART_FRAME_PX.peak, { peak });
  // A compact card is a fixed viewport: its measured room is its container's, never its content's.
  if (presentation?.size === 'small' || presentation?.size === 'wide')
    return { kind: 'chart', plotPx: Math.max(1, (presentation.geometry?.height ?? 96) - USAGE_CHART_FRAME_PX.chrome / 2), peak: false };
  return { kind: 'chart', peak, plotPx };
}

/**
 * "Daily usage": the period's buckets stacked by Agent when per-Agent tokens are known, otherwise one
 * accent series. Source partitions use the accounting timeline when the producer supplies them.
 */
export function UsageDailyWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  const metric = UsageAccountingMetricSchema.parse(props.query.metric);
  const currency = view?.pageCost.selection?.currency ?? 'USD';
  const format = React.useMemo(
    () => usageSeriesValueFormatter(metric, currency),
    [metric, currency],
  );
  // The query's own calendar: a quiet day keeps its place on the axis instead of vanishing.
  const coverage = props.slice.accounting?.coverage;
  const range = React.useMemo(() => resolveUsageShownCalendarRange(props.query, coverage, props.slice.accounting, props.slice.accountingObservationRange),
    [props.query, coverage, props.slice.accounting, props.slice.accountingObservationRange]);
  const bucketLabel = React.useCallback(
    (startMs: number) => range?.granularity === 'week' ? formatUsageWeeklyBucketLabel(startMs, range)
      : formatUsageCalendarDate(
        startMs,
        props.query.timeZoneOffsetMinutes,
        props.query.granularity === 'hour'
          ? { hour: 'numeric' }
          : props.query.granularity === 'month'
            ? { month: 'short', year: '2-digit' }
            : { month: 'short', day: 'numeric' },
      ),
    [range, props.query.granularity, props.query.timeZoneOffsetMinutes],
  );
  const { series: sourceSeries, incompleteBucketStarts } = React.useMemo(() => { const agentColor = createUsageAgentSeriesColor(theme);
    return usageSourceTimelineSeries({
    timeline: metric === 'cost' ? view?.pageCost.accounting.engineTimeline : props.slice.accounting?.engineTimeline,
    range, coverage, metric, costMode: props.query.costBasis, costSelection: view?.pageCost.selection ?? null,
    dimensionKey: agentIdFromEngineKey, label: usageAgentTitle,
    color: (_index, key) => key === USAGE_MODEL_MIX_OTHER_KEY ? usageOtherColor(theme) : agentColor(key), bucketLabel,
  }); }, [props.slice.accounting?.engineTimeline, view?.pageCost, range, coverage, metric, props.query.costBasis, theme, bucketLabel]);
  const byAgent = sourceSeries.length > 0 || (metric === 'tokens' && view?.agentMix.hasData === true);
  const agentForSeries = React.useCallback((id: string) => sourceSeries.find(entry => entry.id === id)?.dimensionKey ?? id, [sourceSeries]);
  const pageCost = view?.pageCost;
  const costTrend = React.useMemo(() => metric === 'cost' && pageCost ? usagePageCostTrend(pageCost) : null, [metric, pageCost]);
  const series = React.useMemo<readonly HappierSeries[]>(() => {
    if (!view) return [];
    if (sourceSeries.length > 0) return sourceSeries;
    if (byAgent) {
      const mix = range ? fillUsageMixCalendar(view.agentMix, range, coverage) : view.agentMix;
      const agentColor = createUsageAgentSeriesColor(theme);
      return mix.keys.map((key, index) => ({
        id: key.key,
        label: key.key === USAGE_MODEL_MIX_OTHER_KEY ? t('usage.modelMix.other') : usageAgentTitle(key.key, key.label),
        // The Agent dimension draws each Agent in its identity hue; the mark sits beside it in the legend.
        color: key.key === USAGE_MODEL_MIX_OTHER_KEY ? usageOtherColor(theme) : agentColor(key.key),
        detail: format(key.totalTokens),
        points: mix.buckets.map((bucket) => ({
          id: String(bucket.startMs),
          x: bucket.startMs,
          label: bucketLabel(bucket.startMs),
          y: bucket.tokens[index] ?? null,
        })),
      }));
    }
    const trend = costTrend ?? view.trend;
    return usageVolumeSeries(
      range ? fillUsageTrendCalendar(trend, range, coverage) : trend,
      metric,
      metric === 'cost' ? t('usage.cost') : t('usage.tokens'),
      usageSignatureAccent(theme),
      props.query.timeZoneOffsetMinutes,
    ).map(entry => ({ ...entry, points: entry.points.map(point => ({ ...point, label: bucketLabel(Number(point.x) * 1000) })) }));
  }, [view, byAgent, sourceSeries, metric, theme, format, range, coverage, bucketLabel, props.query.timeZoneOffsetMinutes, currency, costTrend]);
  // Bars use calendar categories. Keep the timestamp as semantic identity, while exact-value
  // alternatives receive the same formatted date as the axis rather than a numeric epoch.
  const chartSeries = React.useMemo(() => series.map(entry => ({
    ...entry, points: entry.points.map(point => ({ ...point, x: point.label ?? bucketLabel(byAgent ? Number(point.x) : Number(point.x) * 1000) })),
  })), [series, bucketLabel, byAgent]);
  const leads = React.useMemo(
    () =>
      byAgent
        ? Object.fromEntries(
            series
              .filter((entry) => entry.id !== USAGE_MODEL_MIX_OTHER_KEY)
              .map((entry): [string, React.ReactNode] => [
                entry.id,
                <UsageAgentMark key={entry.id} agentId={agentForSeries(entry.id)} serverId={props.serverId} size={12} />,
              ]),
          )
        : undefined,
    [byAgent, series, agentForSeries, props.serverId],
  );
  const count = series[0]?.points.length ?? 0;
  // A period change morphs: the days that stay keep their bars, the days that join rise in.
  const motion = useUsageSeriesMotion(count, 'bucket', JSON.stringify(['usage_daily', props.serverId, getUsageQueryKey(props.query)]));
  // Choosing an Agent in the lens or the legend narrows the page's one filter row to it.
  const drill = useUsageDrill(props.query);
  const drillable = byAgent && drill.available('agents');
  const choice = React.useCallback(
    (seriesId: string): UsageSeriesChoice | null => {
      if (!drillable || seriesId === USAGE_MODEL_MIX_OTHER_KEY) return null;
      const agentId = agentForSeries(seriesId);
      const selected = drill.selected('agents', agentId);
      const name = usageAgentTitle(agentId);
      return {
        selected,
        pressLabel: selected
          ? t('usage.board.page.drillRemove', { name })
          : t('usage.board.page.drillFilterTo', { name }),
        onPress: (callerContext, invocation) => drill.toggle('agents', agentId, callerContext, invocation),
      };
    },
    [drill, drillable, agentForSeries],
  );
  const lens = useUsageSeriesLens({
    series,
    format,
    accentColor: theme.colors.text.primary,
    ...(metric === 'cost' && view
      ? { footer: view.pageCost.selection ? usageCostKindPhrase(view.pageCost.selection.kind) : t('common.unavailable') }
      : {}),
    ...(drillable ? { choice } : {}),
    testID: `${props.testID}.lens`,
  });
  // The lab's typical-day box compares today's observed total with the mean of known,
  // completed active days. It is neither a forecast nor a distribution/confidence band.
  const dailyContext = React.useMemo(() => {
    const empty = { reference: undefined, barRanges: [], bucketShading: [] };
    const incompleteTrend = metric === 'cost'
      ? costTrend?.filter(point => point.partialCost)
      : view?.trend.filter(point => point.tokensFromParts);
    const incompleteTrendStarts = new Set(incompleteTrend?.map(point => point.timestamp * 1000));
    // Cost hatching describes actual usage without a price. A calendar-only slot
    // can still have an unknown value without carrying that meaning.
    const unpricedStarts = byAgent ? incompleteBucketStarts : new Set(costTrend
      ?.filter(point => point.reportCount > 0 && point.cost === null)
      .map(point => point.timestamp * 1000));
    const buckets = (series[0]?.points ?? []).flatMap((point, index) => {
      if (typeof point.x !== 'number' || !Number.isFinite(point.x)) return [];
      const startMs = byAgent ? point.x : point.x * 1000;
      const values = series.map(entry => entry.points[index]?.y);
      const complete = !incompleteBucketStarts.has(startMs) && !incompleteTrendStarts.has(startMs)
        && values.every(value => typeof value === 'number' && Number.isFinite(value));
      const total = complete
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
      const gap = (metric !== 'cost' || unpricedStarts.has(startMs)) && values.every(value => value == null);
      return [{ id: point.id, startMs, total, gap }];
    });
    const peak = {
      peakEligibleBucketIds: buckets.filter(bucket => bucket.total !== null).map(bucket => bucket.id),
      gapBucketIds: buckets.filter(bucket => bucket.gap).map(bucket => bucket.id),
    };
    if (props.query.granularity !== 'day') return { ...empty, ...peak };
    const now = Date.now();
    const days = buckets.map(bucket => ({ ...bucket, ...resolveUsageCalendarInstant(bucket.startMs, props.query.timeZoneOffsetMinutes) }));
    const bucketShading = days.filter(bucket => bucket.weekday === 0 || bucket.weekday === 6)
      .map(bucket => ({ bucketId: bucket.id }));
    const completed = days.filter(bucket => bucket.bucketEndMs <= now
      && (!range || ((range.startMs ?? bucket.bucketStartMs) <= bucket.bucketStartMs && range.endMs >= bucket.bucketEndMs))
      && bucket.total !== null && Number.isFinite(bucket.total) && bucket.total > 0);
    if (completed.length === 0) return { ...empty, ...peak, bucketShading };
    const value = completed.reduce((sum, bucket) => sum + bucket.total! / completed.length, 0);
    const reference = { value, label: t('usage.board.page.average') };
    const current = days.find(bucket => bucket.bucketStartMs <= now && now < bucket.bucketEndMs);
    const barRanges = current?.total !== null && current?.total !== undefined && current.total < value
      ? [{ bucketId: current.id, lower: current.total, upper: value, label: reference.label }] : [];
    return { reference, barRanges, bucketShading, ...peak };
  }, [series, byAgent, range, props.query.granularity, props.query.timeZoneOffsetMinutes, metric, incompleteBucketStarts, costTrend, view?.trend]);
  const weekly = range?.granularity === 'week';
  const axisTicks = React.useMemo(() => {
    const starts = series[0]?.points.map((point) => typeof point.x === 'number' ? (byAgent ? point.x : point.x * 1000) : null) ?? [];
    // A week's axis tick is the date it starts on (a clipped first week: the period's first day). Its "partial week"
    // reading stays with the bar's exact value; on the axis it would crowd the ticks beside it.
    const labels = series[0]?.points.map((point, index) => weekly && range && starts[index] !== null
      ? formatUsageCalendarDate(Math.max(starts[index]!, range.startMs ?? starts[index]!), props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' })
      : point.label ?? '') ?? [];
    const lastStart = starts[labels.length - 1] ?? null;
    const now = Date.now();
    // The still-running day is named for what it is. A running week keeps its date: "This week" wraps under its bar.
    const running = props.query.granularity === 'day' && lastStart !== null && now >= lastStart && now - lastStart < 24 * 60 * 60 * 1000;
    return usageAxisTicks(labels, running ? t('usage.today') : undefined);
  }, [series, metric, byAgent, props.query.granularity, props.query.timeZoneOffsetMinutes, weekly, range]);
  const measure = `${metric === 'cost' ? t('usage.cost') : t('usage.tokens')} · ${usagePeriodPhrase(props.query)}`;
  // A long period draws one bar per week: the card is named for its bars ("Weekly usage"), never "Daily usage · by week"
  // (USAGE-ACCEPT 1121 #16). A name the person gave the widget still wins at the frame.
  const weeklyIdentity = React.useMemo(() => weekly ? { title: t('usage.board.page.weeklyUsage') } : null, [weekly]);
  useWidgetFrameBodyIdentity(weeklyIdentity);
  // The frame's subtitle is the same from the first paint: whether the bars split by agent is only known once the
  // read answers, and the legend says it then. The chart's own label (for assistive technology) names the split.
  useWidgetFrameBodyCaption(measure);
  const caption = byAgent ? `${metric === 'cost' ? t('usage.cost') : t('usage.tokens')} ${t('usage.board.page.byAgent')} · ${usagePeriodPhrase(props.query)}` : measure;
  const details = useUsageChartDetails(t(`usage.widgets.${props.id}`), Boolean(view && count > 0));
  const compact = presentation?.size === 'small' || presentation?.size === 'wide';
  const shape = useUsageDailyChartShape();
  const height = shape.plotPx;
  // A period that recorded nothing says so once, rather than drawing its days as unrecorded on a 0-to-0 axis. An empty
  // population is a measured 0 (its totals are zeros and no read reported a gap): beside a partner the card draws its
  // days as the flat week they are, so it holds its plot instead of one line over blank room. A phone keeps the line.
  const accounting = props.slice.accounting;
  const nothingRecorded = accounting?.totals.eventCount === 0;
  const measuredZeroWeek = nothingRecorded && !phone && !compact && count > 0 && accounting?.totals.tokens.total === 0
    && (accounting.coverage?.reasons.length ?? 0) === 0;
  const drawnSeries = React.useMemo(() => measuredZeroWeek
    ? chartSeries.map(entry => ({ ...entry, points: entry.points.map(point => ({ ...point, y: point.y ?? 0 })) }))
    : chartSeries, [chartSeries, measuredZeroWeek]);
  if (!view || count === 0 || (nothingRecorded && !measuredZeroWeek))
    // Until the first read answers, the body holds the settled chart's shape (its plot, axis and legend room).
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} readingShape={shape} onRetry={props.model.refresh} />;
  return (
    <View testID={`${props.testID}.drawn`}>
    <UsageDailyChart theme={chartTheme} gap={theme.space.s10} testID={props.testID} chart={{
        ...details,
        label: weeklyIdentity ? `${weeklyIdentity.title} · ${caption}` : caption,
        series: drawnSeries,
        size: compact ? 'tile' : 'full',
        viewportHeight: height,
        ...usageDailyBarGeometry(count),
        axisTicks,
        ...(leads ? { leads } : {}),
        // Money scales to the data: a small-data week's $0.002 days stand as bars, never flattened under a cent floor
        // (USAGE-ACCEPT #13). An all-zero week still rests at the chart's own empty baseline.
        ...(metric === 'cost' ? {} : { minimumMaximum: 1 }),
        showScaleValues: !measuredZeroWeek,
        showPeakValue: !measuredZeroWeek && dailyShowsPeak(phone, compact),
        showLegend: !compact && !measuredZeroWeek && (series.length > 1 || dailyContext.gapBucketIds.length > 0),
        gapLabel: metric === 'cost' ? t('usage.board.page.factUnpriced') : t('usage.board.howYouWork.notRecorded'),
        ...dailyContext,
        ...motion,
        unknownLabel: '—',
        showReadout: false,
        valuesLabel: t('usage.showAll'),
        valuesCollapseLabel: t('usage.showLess'),
        valueFormatter: format,
        ...lens,
        ...(drillable
          ? {
              onSeriesPress: (seriesId: string) => {
                choice(seriesId)?.onPress();
              },
              seriesPressLabel: (entry: HappierSeries) =>
                choice(entry.id)?.pressLabel ?? null,
              selectedSeriesIds: series
                .filter((entry) => drill.selected('agents', agentForSeries(entry.id)))
                .map((entry) => entry.id),
            }
          : {}),
      }} footer={<UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />} />
    </View>
  );
}
