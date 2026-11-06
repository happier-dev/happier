import * as React from 'react';
import { UsageAccountingMetricSchema } from '@happier-dev/protocol/inputs/usageQuery';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import {
  UsageDailyChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useDeviceType } from '@/utils/platform/responsive';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { agentIdFromEngineKey, USAGE_MODEL_MIX_OTHER_KEY } from '@/sync/api/account/usageAnalytics';
import { usageOtherColor, usageSignatureAccent } from '../usageAccent';
import { formatUsageCalendarDate, resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageCostKindPhrase, usagePageCostTrend } from '../usageCostPresentation';
import { useUsageDrill } from '../usageDrill';
import { useUsageChartDetails } from './usageMountedControls';
import {
  fillUsageMixCalendar,
  fillUsageTrendCalendar,
  usageAxisTicks,
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
  resolveUsageChartPlotPx,
  USAGE_CHART_FRAME_PX,
} from './usageBodyKit';

/** Only a roomy, full-size Daily draws the peak figure above its plot; a phone and a compact card do not. */
function dailyShowsPeak(phone: boolean, compact: boolean): boolean {
  return !phone && !compact;
}

/**
 * Daily's plot height and the room its settled chart holds. A compact card (Small, Wide) fits its one row; every
 * other size draws the declared plot (`resolveUsageChartPlotPx`), so a tall cell keeps the chart's height and
 * leaves its own space empty. The plot's floor leaves the peak figure's room inside the 120 px a plot keeps, so a
 * Medium card still holds the legend and the coverage note.
 */
export function resolveUsageDailyChartShape(presentation: ReturnType<typeof useWidgetPresentation>, phone: boolean): Readonly<{ kind: 'chart'; plotPx: number; peak: boolean }> {
  if (presentation?.size === 'small' || presentation?.size === 'wide')
    return { kind: 'chart', plotPx: Math.max(1, (presentation.geometry?.height ?? 96) - USAGE_CHART_FRAME_PX.chrome / 2), peak: false };
  const peak = dailyShowsPeak(phone, false);
  return { kind: 'chart', peak, plotPx: resolveUsageChartPlotPx(presentation?.geometry, phone ? 140 : 120 - USAGE_CHART_FRAME_PX.peak, { peak }) };
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
    (startMs: number) =>
      formatUsageCalendarDate(
        startMs,
        props.query.timeZoneOffsetMinutes,
        props.query.granularity === 'hour'
          ? { hour: 'numeric' }
          : props.query.granularity === 'month'
            ? { month: 'short', year: '2-digit' }
            : { month: 'short', day: 'numeric' },
      ),
    [props.query.granularity, props.query.timeZoneOffsetMinutes],
  );
  const sourceSeries = React.useMemo(() => usageSourceTimelineSeries({
    timeline: metric === 'cost' ? view?.pageCost.accounting.engineTimeline : props.slice.accounting?.engineTimeline,
    range, coverage, metric, costMode: props.query.costBasis, costSelection: view?.pageCost.selection ?? null,
    dimensionKey: agentIdFromEngineKey, label: usageAgentTitle,
    color: (_index, key) => getAgentIdentityColor(theme, key), bucketLabel,
  }), [props.slice.accounting?.engineTimeline, view?.pageCost, range, coverage, metric, props.query.costBasis, theme, bucketLabel]);
  const byAgent = sourceSeries.length > 0 || (metric === 'tokens' && view?.agentMix.hasData === true);
  const agentForSeries = React.useCallback((id: string) => sourceSeries.find(entry => entry.id === id)?.dimensionKey ?? id, [sourceSeries]);
  const series = React.useMemo<readonly HappierSeries[]>(() => {
    if (!view) return [];
    if (sourceSeries.length > 0) return sourceSeries;
    if (byAgent) {
      const mix = range ? fillUsageMixCalendar(view.agentMix, range, coverage) : view.agentMix;
      return mix.keys.map((key, index) => ({
        id: key.key,
        label: key.key === USAGE_MODEL_MIX_OTHER_KEY ? t('usage.modelMix.other') : usageAgentTitle(key.key, key.label),
        // The Agent dimension draws each Agent in its identity hue; the mark sits beside it in the legend.
        color: key.key === USAGE_MODEL_MIX_OTHER_KEY ? usageOtherColor(theme) : getAgentIdentityColor(theme, key.key),
        detail: format(key.totalTokens),
        points: mix.buckets.map((bucket) => ({
          id: String(bucket.startMs),
          x: bucket.startMs,
          label: bucketLabel(bucket.startMs),
          y: bucket.tokens[index] ?? null,
        })),
      }));
    }
    const trend = metric === 'cost' ? usagePageCostTrend(view.pageCost) : view.trend;
    return usageVolumeSeries(
      range ? fillUsageTrendCalendar(trend, range, coverage) : trend,
      metric,
      metric === 'cost' ? t('usage.cost') : t('usage.tokens'),
      usageSignatureAccent(theme),
      props.query.timeZoneOffsetMinutes,
    ).map(entry => ({ ...entry, points: entry.points.map(point => ({ ...point, label: bucketLabel(Number(point.x) * 1000) })) }));
  }, [view, byAgent, sourceSeries, metric, theme, format, range, coverage, bucketLabel, props.query.timeZoneOffsetMinutes, currency]);
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
  const motion = useUsageSeriesMotion(count, 'bucket');
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
        onPress: () => {
          drill.toggle('agents', agentId);
        },
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
    if (props.query.granularity !== 'day') return empty;
    const now = Date.now();
    const buckets = (series[0]?.points ?? []).flatMap((point, index) => {
      if (typeof point.x !== 'number' || !Number.isFinite(point.x)) return [];
      const startMs = byAgent ? point.x : point.x * 1000;
      const calendar = resolveUsageCalendarInstant(startMs, props.query.timeZoneOffsetMinutes);
      const values = series.map(entry => entry.points[index]?.y);
      const total = values.every(value => typeof value === 'number' && Number.isFinite(value))
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
      return [{ id: point.id, ...calendar, total }];
    });
    const bucketShading = buckets.filter(bucket => bucket.weekday === 0 || bucket.weekday === 6)
      .map(bucket => ({ bucketId: bucket.id }));
    const completed = buckets.filter(bucket => bucket.bucketEndMs <= now
      && (!range || ((range.startMs ?? bucket.bucketStartMs) <= bucket.bucketStartMs && range.endMs >= bucket.bucketEndMs))
      && bucket.total !== null && Number.isFinite(bucket.total) && bucket.total > 0);
    if (completed.length === 0) return { ...empty, bucketShading };
    const value = completed.reduce((sum, bucket) => sum + bucket.total! / completed.length, 0);
    const reference = { value, label: t('usage.board.page.average') };
    const current = buckets.find(bucket => bucket.bucketStartMs <= now && now < bucket.bucketEndMs);
    const barRanges = current?.total !== null && current?.total !== undefined && current.total < value
      ? [{ bucketId: current.id, lower: current.total, upper: value, label: reference.label }] : [];
    return { reference, barRanges, bucketShading };
  }, [series, byAgent, range, props.query.granularity, props.query.timeZoneOffsetMinutes]);
  const axisTicks = React.useMemo(() => {
    const labels = series[0]?.points.map((point) => point.label ?? '') ?? [];
    const last = series[0]?.points[labels.length - 1];
    const now = Date.now();
    const lastStart = typeof last?.x === 'number' ? (byAgent ? last.x : last.x * 1000) : null;
    // The still-running bucket is named for what it is.
    const running = props.query.granularity === 'day' && lastStart !== null && now >= lastStart && now - lastStart < 24 * 60 * 60 * 1000;
    return usageAxisTicks(labels, running ? t('usage.today') : undefined);
  }, [series, metric, byAgent, props.query.granularity]);
  const measure = `${metric === 'cost' ? t('usage.cost') : t('usage.tokens')} · ${usagePeriodPhrase(props.query)}`;
  // The frame's subtitle is the same from the first paint: whether the bars split by agent is only known once the
  // read answers, and the legend says it then. The chart's own label (for assistive technology) names the split.
  useWidgetFrameBodyCaption(measure);
  const caption = byAgent ? `${metric === 'cost' ? t('usage.cost') : t('usage.tokens')} ${t('usage.board.page.byAgent')} · ${usagePeriodPhrase(props.query)}` : measure;
  const details = useUsageChartDetails(t(`usage.widgets.${props.id}`), Boolean(view && count > 0));
  const compact = presentation?.size === 'small' || presentation?.size === 'wide';
  const shape = resolveUsageDailyChartShape(presentation, phone);
  const height = shape.plotPx;
  if (!view || count === 0)
    // Until the first read answers, the body holds the settled chart's shape (its plot, axis and legend room).
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} readingShape={shape} onRetry={props.model.refresh} />;
  return (
    <UsageDailyChart theme={chartTheme} gap={theme.space.s10} testID={props.testID} chart={{
        ...details,
        label: caption,
        series: chartSeries,
        size: compact ? 'tile' : 'full',
        viewportHeight: height,
        barGap: count > 45 ? 2 : count > 20 ? 4 : 6,
        barMinHeight: 0,
        axisTicks,
        ...(leads ? { leads } : {}),
        // A near-zero money scale reads in whole cents ($0.05 · $0.10), never "$0.005".
        minimumMaximum: metric === 'cost' ? 0.1 : 1,
        showGrid: true,
        showScaleValues: true,
        scaleGutter: 44,
        showPeakValue: dailyShowsPeak(phone, compact),
        showLegend: !compact && series.length > 1,
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
  );
}
