import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { USAGE_MODEL_MIX_OTHER_KEY } from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { usageOtherColor, usageSeriesColor } from '../usageAccent';
import { resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { useUsageDrill } from '../usageDrill';
import {
  usageMixSeries,
  fillUsageMixCalendar,
  useUsageSeriesAreaInk,
  useUsageSeriesLens,
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

const CHROME_PX = 72;

/**
 * "Tokens over time": the period's flow stacked by Agent, or by model when the widget's own
 * breakdown asks for models. Token counts only — no per-bucket money is produced per series.
 */
export function UsageFlowWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const presentation = useWidgetPresentation();
  const areaInk = useUsageSeriesAreaInk();
  const byModel = props.query.breakdown.includes('model');
  const mix = React.useMemo(() => {
    if (!view) return null;
    const source = byModel ? view.modelMix : view.agentMix;
    const range = resolveUsageShownCalendarRange(props.query, props.slice.accounting?.coverage);
    return range ? fillUsageMixCalendar(source, range, props.slice.accounting?.coverage) : source;
  }, [view, byModel, props.query, props.slice.accounting?.coverage]);
  useWidgetFrameBodyCaption(
    `${byModel ? t('usage.board.page.byModel') : t('usage.board.page.byAgent')} · ${usagePeriodPhrase(props.query)}`,
  );
  const series = React.useMemo(
    () =>
      mix
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
                  ? entry.label || mix.keys[index]!.key
                  : usageAgentTitle(mix.keys[index]!.key, entry.label),
          }))
        : [],
    [mix, theme, byModel, props.query.timeZoneOffsetMinutes],
  );
  // Choosing an Agent in the lens or the legend narrows the page's one filter row to it.
  const drill = useUsageDrill(props.query);
  const drillable = !byModel && drill.available('agents');
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
    format: formatTokenCount,
    accentColor: theme.colors.text.primary,
    ...(drillable ? { choice } : {}),
    testID: `${props.testID}.lens`,
  });
  if (!mix?.hasData)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.page.flowEmptyTitle')}
        reason={t('usage.board.page.flowEmptyReason')}
      />
    );
  const height = Math.max(
    120,
    Math.min(260, (presentation?.geometry?.height ?? 220) - CHROME_PX),
  );
  return (
    <View style={{ gap: 10 }} testID={`${props.testID}.flow`}>
      <StackedSeriesChart
        testID={`${props.testID}.chart`}
        theme={chartTheme}
        label={t('usage.tokens')}
        series={series}
        variant="area"
        size="full"
        viewportHeight={height}
        {...areaInk}
        plotInset={2}
        scaleGutter={44}
        showGrid
        showScaleValues
        showLegend
        {...(byModel
          ? {}
          : {
              leads: Object.fromEntries(
                mix.keys
                  .filter((key) => key.key !== USAGE_MODEL_MIX_OTHER_KEY)
                  .map((key): [string, React.ReactNode] => [
                    key.key,
                    <UsageAgentMark key={key.key} agentId={key.key} serverId={props.serverId} size={12} />,
                  ]),
              ),
            })}
        valueFormatter={formatTokenCount}
        unknownLabel={t('common.unavailable')}
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
