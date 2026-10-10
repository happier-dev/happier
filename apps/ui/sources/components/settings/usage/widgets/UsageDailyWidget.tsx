import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useDeviceType } from '@/utils/platform/responsive';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { USAGE_MODEL_MIX_OTHER_KEY } from '@/sync/api/account/usageAnalytics';
import { usageOtherColor, usageSignatureAccent } from '../usageAccent';
import { formatUsageCalendarDate, resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { useUsageDrill } from '../usageDrill';
import {
  fillUsageMixCalendar,
  fillUsageTrendCalendar,
  usageAxisTicks,
  usageSeriesValueFormatter,
  usageVolumeSeries,
  useUsageSeriesLens,
  useUsageSeriesMotion,
  type UsageSeriesChoice,
} from '../usageSeriesPresentation';
import {
  UsageAgentMark,
  UsageBodyInsufficient,
  UsageCoverageLine,
  usageAgentTitle,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';

/** Room the axis, legend and coverage line take under the plot in a sized frame. */
const CHROME_PX = 84;

/**
 * "Daily usage": the period's buckets stacked by Agent when per-Agent tokens are known, otherwise one
 * accent series. Cost per Agent per bucket is not a produced fact, so Cost draws the one total series.
 */
export function UsageDailyWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  const metric = props.query.metric;
  const currency = view?.costPresentation.currency ?? 'USD';
  const format = React.useMemo(
    () => usageSeriesValueFormatter(metric, currency),
    [metric, currency],
  );
  const byAgent = metric === 'tokens' && view?.agentMix.hasData === true;
  // The query's own calendar: a quiet day keeps its place on the axis instead of vanishing.
  const coverage = props.slice.accounting?.coverage;
  const range = React.useMemo(() => resolveUsageShownCalendarRange(props.query, coverage), [props.query, coverage]);
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
  const series = React.useMemo<readonly HappierSeries[]>(() => {
    if (!view) return [];
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
    return usageVolumeSeries(
      range ? fillUsageTrendCalendar(view.trend, range, coverage) : view.trend,
      metric,
      metric === 'cost' ? t('usage.cost') : t('usage.tokens'),
      usageSignatureAccent(theme),
      props.query.timeZoneOffsetMinutes,
    ).map(entry => ({ ...entry, points: entry.points.map(point => ({ ...point, label: bucketLabel(Number(point.x) * 1000) })) }));
  }, [view, byAgent, metric, theme, format, range, coverage, bucketLabel, props.query.timeZoneOffsetMinutes]);
  const leads = React.useMemo(
    () =>
      byAgent
        ? Object.fromEntries(
            series
              .filter((entry) => entry.id !== USAGE_MODEL_MIX_OTHER_KEY)
              .map((entry): [string, React.ReactNode] => [
                entry.id,
                <UsageAgentMark key={entry.id} agentId={entry.id} serverId={props.serverId} size={12} />,
              ]),
          )
        : undefined,
    [byAgent, series, props.serverId],
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
      const selected = drill.selected('agents', seriesId);
      const name = usageAgentTitle(seriesId);
      return {
        selected,
        pressLabel: selected
          ? t('usage.board.page.drillRemove', { name })
          : t('usage.board.page.drillFilterTo', { name }),
        onPress: () => {
          drill.toggle('agents', seriesId);
        },
      };
    },
    [drill, drillable],
  );
  const lens = useUsageSeriesLens({
    series,
    format,
    accentColor: theme.colors.text.primary,
    ...(metric === 'cost' && view
      ? { footer: usageCostKindPhrase(view.costPresentation.source) }
      : {}),
    ...(drillable ? { choice } : {}),
    testID: `${props.testID}.lens`,
  });
  // A typical active bucket, excluding the still-running last one.
  const reference = React.useMemo(() => {
    if (count < 3) return undefined;
    const totals = Array.from({ length: count - 1 }, (_, index) =>
      series.every(entry => typeof entry.points[index]?.y === 'number')
        ? series.reduce((sum, entry) => sum + (entry.points[index]?.y ?? 0), 0) : null,
    ).filter((value): value is number => value !== null && value > 0);
    if (totals.length < 2) return undefined;
    return {
      value: totals.reduce((sum, value) => sum + value, 0) / totals.length,
      label: t('usage.board.page.average'),
    };
  }, [series, count]);
  const axisTicks = React.useMemo(() => {
    const labels = series[0]?.points.map((point) => point.label ?? '') ?? [];
    const last = series[0]?.points[labels.length - 1];
    const now = Date.now();
    const lastStart = typeof last?.x === 'number' ? (metric === 'tokens' && byAgent ? last.x : last.x * 1000) : null;
    // The still-running bucket is named for what it is.
    const running = props.query.granularity === 'day' && lastStart !== null && now >= lastStart && now - lastStart < 24 * 60 * 60 * 1000;
    return usageAxisTicks(labels, running ? t('usage.today') : undefined);
  }, [series, metric, byAgent, props.query.granularity]);
  const caption = `${metric === 'cost' ? t('usage.cost') : t('usage.tokens')}${byAgent ? ` ${t('usage.board.page.byAgent')}` : ''} · ${usagePeriodPhrase(props.query)}`;
  useWidgetFrameBodyCaption(caption);
  if (!view || count === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.page.noUsageTitle')}
        reason={t('usage.board.page.noUsageReason')}
      />
    );
  const height = Math.max(
    phone ? 140 : 120,
    Math.min(320, (presentation?.geometry?.height ?? 260) - CHROME_PX),
  );
  return (
    <View style={{ gap: 10 }} testID={`${props.testID}.daily`}>
      <StackedSeriesChart
        testID={`${props.testID}.chart`}
        theme={chartTheme}
        label={caption}
        series={series}
        variant="bar"
        size="full"
        viewportHeight={height}
        barGap={count > 45 ? 2 : count > 20 ? 4 : 6}
        barMaxWidth={28}
        barMinHeight={0}
        axisTicks={axisTicks}
        {...(leads ? { leads } : {})}
        minimumMaximum={metric === 'cost' ? 0.01 : 1}
        showGrid
        showScaleValues
        scaleGutter={44}
        showPeakValue={!phone}
        showLegend={series.length > 1}
        reference={reference}
        {...motion}
        unknownLabel={t('common.unavailable')}
        showReadout={false}
        valuesLabel={t('usage.showAll')}
        valuesCollapseLabel={t('usage.showLess')}
        valueFormatter={format}
        {...lens}
        {...(drillable
          ? {
              onSeriesPress: (seriesId: string) => {
                choice(seriesId)?.onPress();
              },
              seriesPressLabel: (entry: HappierSeries) =>
                choice(entry.id)?.pressLabel ?? null,
              selectedSeriesIds: series
                .filter((entry) => drill.selected('agents', entry.id))
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
