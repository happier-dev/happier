import * as React from 'react';
import { UsageAccountingMetricSchema } from '@happier-dev/protocol/inputs/usageQuery';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierSeriesTrailingReadingContext,
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { agentIdFromEngineKey, USAGE_MODEL_MIX_OTHER_KEY } from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';
import { useUsageAgentColor, usageOtherColor, usageSeriesColor } from '../usageAccent';
import { formatUsageCalendarDate, resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { usagePageCostCaption, usagePageCostTrend } from '../usageCostPresentation';
import { useUsageDrill } from '../usageDrill';
import { useUsageChartDetails } from './usageMountedControls';
import {
  usageMixSeries,
  usageVolumeSeries,
  usageSeriesValueFormatter,
  fillUsageTrendCalendar,
  usageSourceTimelineSeries,
  fillUsageMixCalendar,
  useUsageSeriesAreaInk,
  useUsageSeriesLens,
  type UsageSeriesChoice,
} from '../usageSeriesPresentation';
import {
  UsageAgentMark,
  UsageBodyInsufficient,
  UsageBodyNoUsage,
  UsageBodyReadFailed,
  isUsageReadFailed,
  UsageCoverageLine,
  usageAgentTitle,
  usageDimensionLabel,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
  isUsageReadOutstanding,
  UsageBodyReading,
  useUsageChartPlotPx,
} from './usageBodyKit';
import { UsageRiverStyleBody } from './UsageChartStyleBodies';
import { projectUsageFlowModel } from './usageChartModels';

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageFlowWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  if (style === 'agentRiver') return <UsageRiverStyleBody {...props} />;
  return <UsageFlowWidgetOriginal {...props} />;
}

/**
 * "Tokens over time": the period's flow stacked by Agent, or by model when the widget's own
 * breakdown asks for models. Money uses the same selected kind as the period and daily bars.
 */
function UsageFlowWidgetOriginal(props: UsageBodyProps) {
  const metric = UsageAccountingMetricSchema.parse(props.query.metric);
  const { theme } = useUnistyles();
  const agentColor = useUsageAgentColor();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const areaInk = useUsageSeriesAreaInk();
  const byModel = props.query.breakdown.includes('model');
  const cost = metric === 'cost';
  const format = usageSeriesValueFormatter(metric, view?.pageCost.selection?.currency ?? 'USD');
  const accounting = cost ? view?.pageCost.accounting : props.slice.accounting;
  const range = React.useMemo(() => resolveUsageShownCalendarRange(props.query, props.slice.accounting?.coverage, props.slice.accounting, props.slice.accountingObservationRange),
    [props.query, props.slice.accounting, props.slice.accountingObservationRange]);
  const { series: sourceSeries } = React.useMemo(() => usageSourceTimelineSeries({
    timeline: byModel ? accounting?.modelTimeline : accounting?.engineTimeline,
    range, coverage: props.slice.accounting?.coverage,
    metric, costSelection: view?.pageCost.selection ?? null,
    dimensionKey: byModel ? key => key : agentIdFromEngineKey,
    label: byModel ? (key, fallback) => usageDimensionLabel('model', key, fallback) : usageAgentTitle,
    color: (index, key) => key === USAGE_MODEL_MIX_OTHER_KEY ? usageOtherColor(theme)
      : byModel ? usageSeriesColor(theme, index) : agentColor(key),
    bucketLabel: startMs => formatUsageCalendarDate(startMs, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' }),
  }), [byModel, accounting, range, props.slice.accounting?.coverage, view?.pageCost.selection, props.query, theme, agentColor]);
  const agentForSeries = React.useCallback((id: string) => sourceSeries.find(entry => entry.id === id)?.dimensionKey ?? id, [sourceSeries]);
  const mix = React.useMemo(() => {
    if (!view) return null;
    const source = byModel ? view.modelMix : view.agentMix;
    return range ? fillUsageMixCalendar(source, range, props.slice.accounting?.coverage) : source;
  }, [view, byModel, range, props.slice.accounting?.coverage]);
  // The period's own buckets decide whether there is a flow to draw; the drawing then leaves the unread ends off.
  const periodSeries = React.useMemo(
    () => {
      if (sourceSeries.length > 0) return sourceSeries;
      if (cost && view) {
        const trend = usagePageCostTrend(view.pageCost);
        return usageVolumeSeries(range ? fillUsageTrendCalendar(trend, range, props.slice.accounting?.coverage) : trend,
          'cost', t('usage.cost'), usageSeriesColor(theme, 0), props.query.timeZoneOffsetMinutes);
      }
      return mix ? usageMixSeries(mix, {
        label: (key, fallback) => key === USAGE_MODEL_MIX_OTHER_KEY ? t('usage.modelMix.other')
          : byModel ? usageDimensionLabel('model', key, fallback) : usageAgentTitle(key, fallback),
        color: (index, key) => key === USAGE_MODEL_MIX_OTHER_KEY ? usageOtherColor(theme)
          : byModel ? usageSeriesColor(theme, index) : agentColor(key),
        bucketLabel: startMs => formatUsageCalendarDate(startMs, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' }),
      }) : [];
    },
    [mix, sourceSeries, cost, view, range, theme, agentColor, byModel, props.query, props.slice.accounting?.coverage],
  );
  // Volume buckets use seconds; the Agent/model sources and mix use milliseconds.
  const timeUnitMs = sourceSeries.length === 0 && cost ? 1_000 : 1;
  const period = props.query.period;
  const { series, trailingReading, drawsPartial } = React.useMemo(() => {
    const flow = projectUsageFlowModel(periodSeries, range, Date.now(), timeUnitMs, period);
    const label = t('session.transcriptNavigation.soFar');
    const labelPartial = (entries: typeof flow.drawn) => entries.map(entry => ({
      ...entry, points: entry.points.map(point => point.partial ? { ...point, annotation: label } : point),
    }));
    const drawsPartial = flow.drawn.some(entry => entry.points.at(-1)?.partial === true);
    const series = drawsPartial ? labelPartial(flow.drawn) : flow.drawn;
    const trailingReading = flow.trailingReading ? labelPartial(flow.trailingReading) : drawsPartial ? series : null;
    return { series, trailingReading, drawsPartial };
  }, [periodSeries, range, timeUnitMs, period]);
  const hasChart = series.length > 0 && (cost || sourceSeries.length > 0 || mix?.hasData === true);
  const plotsUsage = hasChart && (drawsPartial || usageFlowHasShape(periodSeries));
  const sparseReading = !plotsUsage && trailingReading
    ? trailingReading.reduce((total, entry) => total + (entry.points.at(-1)?.y ?? 0), 0)
    : null;
  useWidgetFrameBodyCaption(
    `${byModel ? t('usage.board.page.byModel') : t('usage.board.page.byAgent')} · ${usagePeriodPhrase(props.query)}`
    + (drawsPartial || sparseReading !== null ? ` · ${t('session.transcriptNavigation.soFar')}` : ''),
  );
  // Choosing an Agent in the lens or the legend narrows the page's one filter row to it.
  const drill = useUsageDrill(props.query);
  const byAgent = !byModel && (!cost || sourceSeries.length > 0);
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
  const costCaption = cost && view ? usagePageCostCaption(view.pageCost) : undefined;
  const lens = useUsageSeriesLens({
    series,
    format,
    ...(costCaption ? { footer: costCaption } : {}),
    accentColor: theme.colors.text.primary,
    ...(drillable ? { choice } : {}),
    testID: `${props.testID}.lens`,
  });
  const details = useUsageChartDetails(t(`usage.widgets.${props.id}`), hasChart);
  // The plot takes what the frame declares after its chrome, decided before the first paint (sweep 1110 #9).
  const height = useUsageChartPlotPx(120);
  if ((series.length === 0 || (!cost && !sourceSeries.length && !mix?.hasData)) && isUsageReadOutstanding(props.slice, ['accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} shape={{ kind: 'chart', plotPx: height }}
      waitingOn={{ slice: props.slice, sources: ['accounting'] }} />;
  if ((series.length === 0 || (!cost && !sourceSeries.length && !mix?.hasData)) && isUsageReadFailed(props.slice, ['accounting']))
    return <UsageBodyReadFailed slice={props.slice} sources={['accounting']} testID={props.testID} onRetry={props.model.refresh} />;
  // A period that recorded nothing says so, like the daily bars beside it; "needs more history" is for real but thin usage.
  if (props.slice.accounting?.totals.eventCount === 0)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  // Two or three recorded buckets among unread ones have no shape to follow: drawn, they are one stray stroke beside the
  // daily bars that already show them. The flow waits for a stretch of recorded usage (USAGE-ACCEPT 1118 #13).
  const needsMoreHistory = !plotsUsage ? (
    <UsageBodyInsufficient
      testID={`${props.testID}.empty`}
      title={t('usage.board.page.flowEmptyTitle')}
      reason={t('usage.board.page.flowEmptyReason')}
    />
  ) : null;
  if (needsMoreHistory && sparseReading === null) return needsMoreHistory;
  const chart = (
    <StackedSeriesChart
      {...details}
      testID={`${props.testID}.chart`}
      theme={chartTheme}
      label={cost ? t('usage.cost') : t('usage.tokens')}
      series={series}
      coordinateFormatter={(x) => formatUsageCalendarDate(x * timeUnitMs, props.query.timeZoneOffsetMinutes,
        range?.granularity === 'hour' ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } : undefined)}
      variant="area"
      size="full"
      viewportHeight={height}
      {...areaInk}
      plotInset={2}
      scaleGutter={44}
      showGrid={plotsUsage}
      showScaleValues={plotsUsage}
      showLegend={plotsUsage}
      {...(sparseReading !== null ? {
        renderFrame: () => needsMoreHistory,
        summary: `${format(sparseReading)} · ${t('session.transcriptNavigation.soFar')}`,
      } : {})}
      {...(!byAgent
        ? {}
        : {
            leads: Object.fromEntries(
              series
                .filter((entry) => entry.id !== USAGE_MODEL_MIX_OTHER_KEY)
                .map((entry): [string, React.ReactNode] => [
                  entry.id,
                  <UsageAgentMark key={entry.id} agentId={agentForSeries(entry.id)} serverId={props.serverId} size={12} />,
                ]),
            ),
          })}
      valueFormatter={format}
      unknownLabel={'—'}
      showReadout={false}
      valuesLabel={t('usage.showAll')}
      valuesCollapseLabel={t('usage.showLess')}
      {...lens}
      {...(drillable
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
        : {})}
    />
  );
  return (
    <View style={{ gap: theme.space.s10 }} testID={`${props.testID}.flow`}>
      <HappierSeriesTrailingReadingContext.Provider value={trailingReading}>{chart}</HappierSeriesTrailingReadingContext.Provider>
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

/** The fewest recorded buckets in a row that draw as a flow; the chart draws shorter runs as a lone line. */
const USAGE_FLOW_MIN_RUN = 4;

/** A flow has a shape once some stretch of consecutive buckets carries a recorded value (all of them when the period is shorter). */
function usageFlowHasShape(series: readonly Readonly<{ points: readonly Readonly<{ y: number | null }>[] }>[]): boolean {
  const length = Math.max(0, ...series.map(entry => entry.points.length));
  let longest = 0;
  let run = 0;
  for (let index = 0; index < length; index += 1) {
    run = series.some(entry => entry.points[index]?.y != null) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest > 0 && longest >= Math.min(USAGE_FLOW_MIN_RUN, length);
}
