import * as React from 'react';
import { UsageAccountingMetricSchema } from '@happier-dev/protocol/inputs/usageQuery';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { agentIdFromEngineKey, USAGE_MODEL_MIX_OTHER_KEY } from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { usageOtherColor, usageSeriesColor } from '../usageAccent';
import { formatUsageCalendarDate, resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageCostKindPhrase, usagePageCostTrend } from '../usageCostPresentation';
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
  resolveUsageChartPlotPx,
} from './usageBodyKit';
import { UsageRiverStyleBody } from './UsageChartStyleBodies';

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
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const presentation = useWidgetPresentation();
  const areaInk = useUsageSeriesAreaInk();
  const byModel = props.query.breakdown.includes('model');
  const cost = metric === 'cost';
  const format = usageSeriesValueFormatter(metric, view?.pageCost.selection?.currency ?? 'USD');
  const accounting = cost ? view?.pageCost.accounting : props.slice.accounting;
  const range = React.useMemo(() => resolveUsageShownCalendarRange(props.query, props.slice.accounting?.coverage, props.slice.accounting, props.slice.accountingObservationRange),
    [props.query, props.slice.accounting, props.slice.accountingObservationRange]);
  const sourceSeries = React.useMemo(() => usageSourceTimelineSeries({
    timeline: byModel ? accounting?.modelTimeline : accounting?.engineTimeline,
    range, coverage: props.slice.accounting?.coverage,
    metric, costMode: props.query.costBasis, costSelection: view?.pageCost.selection ?? null,
    dimensionKey: byModel ? key => key : agentIdFromEngineKey,
    label: byModel ? (key, fallback) => usageDimensionLabel('model', key, fallback) : usageAgentTitle,
    color: (index, key) => byModel ? usageSeriesColor(theme, index) : getAgentIdentityColor(theme, key),
    bucketLabel: startMs => formatUsageCalendarDate(startMs, props.query.timeZoneOffsetMinutes, { month: 'short', day: 'numeric' }),
  }), [byModel, accounting, range, props.slice.accounting?.coverage, view?.pageCost.selection, props.query, theme]);
  const agentForSeries = React.useCallback((id: string) => sourceSeries.find(entry => entry.id === id)?.dimensionKey ?? id, [sourceSeries]);
  const mix = React.useMemo(() => {
    if (!view) return null;
    const source = byModel ? view.modelMix : view.agentMix;
    return range ? fillUsageMixCalendar(source, range, props.slice.accounting?.coverage) : source;
  }, [view, byModel, range, props.slice.accounting?.coverage]);
  useWidgetFrameBodyCaption(
    `${byModel ? t('usage.board.page.byModel') : t('usage.board.page.byAgent')} · ${usagePeriodPhrase(props.query)}`,
  );
  const series = React.useMemo(
    () => {
      if (sourceSeries.length > 0) return sourceSeries;
      if (cost && view) {
        const trend = usagePageCostTrend(view.pageCost);
        return usageVolumeSeries(range ? fillUsageTrendCalendar(trend, range, props.slice.accounting?.coverage) : trend,
          'cost', t('usage.cost'), usageSeriesColor(theme, 0), props.query.timeZoneOffsetMinutes);
      }
      return mix
        ? usageMixSeries(
            mix,
            (label) => label,
            // Agents keep their identity hue; models are a magnitude ramp of the one accent.
            (index, key) =>
              key === USAGE_MODEL_MIX_OTHER_KEY
                ? usageOtherColor(theme)
                : byModel
                  ? usageSeriesColor(theme, index)
                  : getAgentIdentityColor(theme, key),
            props.query.timeZoneOffsetMinutes,
          ).map((entry, index) => ({
            ...entry,
            label:
              mix.keys[index]!.key === USAGE_MODEL_MIX_OTHER_KEY
                ? t('usage.modelMix.other')
                : byModel
                  ? usageDimensionLabel('model', mix.keys[index]!.key, entry.label)
                  : usageAgentTitle(mix.keys[index]!.key, entry.label),
          }))
        : [];
    },
    [mix, sourceSeries, cost, view, range, theme, byModel, props.query, props.slice.accounting?.coverage],
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
    ...(cost ? { footer: view?.pageCost.selection ? usageCostKindPhrase(view.pageCost.selection.kind) : t('common.unavailable') } : {}),
    accentColor: theme.colors.text.primary,
    ...(drillable ? { choice } : {}),
    testID: `${props.testID}.lens`,
  });
  const hasChart = series.length > 0 && (cost || sourceSeries.length > 0 || mix?.hasData === true);
  const details = useUsageChartDetails(t(`usage.widgets.${props.id}`), hasChart);
  if ((series.length === 0 || (!cost && !sourceSeries.length && !mix?.hasData)) && isUsageReadOutstanding(props.slice, ['accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} shape={{ kind: 'chart', plotPx: resolveUsageChartPlotPx(presentation?.geometry, 120) }}
      waitingOn={{ slice: props.slice, sources: ['accounting'] }} />;
  if ((series.length === 0 || (!cost && !sourceSeries.length && !mix?.hasData)) && isUsageReadFailed(props.slice, ['accounting']))
    return <UsageBodyReadFailed slice={props.slice} sources={['accounting']} testID={props.testID} onRetry={props.model.refresh} />;
  if (series.length === 0 || (!cost && !sourceSeries.length && !mix?.hasData))
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.page.flowEmptyTitle')}
        reason={t('usage.board.page.flowEmptyReason')}
      />
    );
  // The plot takes what the frame leaves after its chrome (wrapped legend and coverage note included).
  const height = resolveUsageChartPlotPx(presentation?.geometry, 120);
  return (
    <View style={{ gap: theme.space.s10 }} testID={`${props.testID}.flow`}>
      <StackedSeriesChart
        {...details}
        testID={`${props.testID}.chart`}
        theme={chartTheme}
        label={cost ? t('usage.cost') : t('usage.tokens')}
        series={series}
        // Volume buckets count seconds, mix and source buckets milliseconds; exact values read each as its date.
        coordinateFormatter={(x) => formatUsageCalendarDate(sourceSeries.length === 0 && cost ? x * 1000 : x, props.query.timeZoneOffsetMinutes,
          range?.granularity === 'hour' ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } : undefined)}
        variant="area"
        size="full"
        viewportHeight={height}
        {...areaInk}
        plotInset={2}
        scaleGutter={44}
        showGrid
        showScaleValues
        showLegend
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
        unknownLabel="—"
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
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}
