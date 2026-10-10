import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  DotGrid,
  Heatmap,
  StackedSeriesChart,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { getPreferredLanguage, t } from '@/text';
import { usageSignatureAccent } from '../usageAccent';
import { resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import {
  usageDotGridPresentation,
  usageGridFrame,
  usageGridTooltip,
  usageHeatmapPresentation,
} from '../usageGridPresentation';
import {
  createUsageHourRhythmSeries,
  usageSeriesTooltip,
} from '../usageSeriesPresentation';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';

/** Below this body width the 7×24 matrix is unreadable; the 24-hour rhythm says the same. */
const MATRIX_MIN_WIDTH_PX = 440;
/** Calendar and weekday×hour sit side by side only when each keeps its matrix width. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 2 * MATRIX_MIN_WIDTH_PX;

/**
 * "When you work": the active-days calendar beside the weekday × hour rhythm, both read from the same
 * admitted activity facts in the query's own calendar (fixed offset, Monday weeks).
 */
export function UsageRhythmWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const width = useWidgetPresentation()?.geometry?.width;
  const accent = usageSignatureAccent(theme);
  const activity = view?.activity;
  const language = getPreferredLanguage();
  const calendar = React.useMemo(() => {
    const range = resolveUsageShownCalendarRange(props.query, props.slice.accounting?.coverage);
    return activity && range ? usageHeatmapPresentation({ calendarDays: activity.calendarDays, mode: 'daily', range,
      coverage: props.slice.accounting?.coverage, accentColor: accent, emptyColor: theme.colors.surface.inset }) : null;
  }, [activity, props.query, props.slice.accounting?.coverage, accent, theme.colors.surface.inset, language]);
  const hasCalendar = (activity?.calendarDays.length ?? 0) > 0;
  const hasRhythm =
    (view?.punchCard.total ?? 0) > 0 || (view?.hourRhythm.total ?? 0) > 0;
  const streak = view?.hero.longestStreakDays ?? 0;
  useWidgetFrameBodyCaption(
    view && streak > 0
      ? t('usage.board.howYouWork.longestStreak', { count: streak })
      : null,
  );
  if (!view || !activity || (!hasCalendar && !hasRhythm)) {
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.rhythmEmptyTitle')}
        reason={t('usage.board.howYouWork.rhythmEmptyReason')}
      />
    );
  }
  const matrix = width === undefined || width >= MATRIX_MIN_WIDTH_PX;
  const sideBySide = width !== undefined && width >= SIDE_BY_SIDE_MIN_WIDTH_PX;
  return (
    <View style={styles.body} testID={`${props.testID}.rhythm`}>
      <View style={[styles.blocks, sideBySide ? styles.row : null]}>
        {hasCalendar && calendar ? (
          <View style={[styles.block, sideBySide ? styles.half : null]}>
            <Text style={styles.label}>
              {t('usage.board.howYouWork.activeDays')}
            </Text>
            <Heatmap
              testID={`${props.testID}.calendar`}
              theme={chartTheme}
              showReadout={false}
              {...calendar}
              renderCell={usageGridTooltip(
                accent,
                'usage-heatmap-cell-trigger',
              )}
              renderFrame={
                calendar.layout === 'strip' ? undefined : usageGridFrame
              }
            />
          </View>
        ) : null}
        {hasRhythm ? (
          <View style={[styles.block, sideBySide ? styles.half : null]}>
            <Text style={styles.label}>
              {t('usage.board.howYouWork.weekdayHour')}
            </Text>
            {matrix ? (
              <DotGrid
                testID={`${props.testID}.punchcard`}
                theme={chartTheme}
                showReadout={false}
                {...usageDotGridPresentation(
                  view.punchCard,
                  accent,
                  theme.colors.border.default,
                )}
                renderCell={usageGridTooltip(
                  accent,
                  'usage-punchcard-cell-trigger',
                )}
              />
            ) : (
              <StackedSeriesChart
                testID={`${props.testID}.hours`}
                theme={chartTheme}
                label={t('usage.workRhythm')}
                series={createUsageHourRhythmSeries(
                  view.hourRhythm,
                  accent,
                  theme.colors.border.default,
                )}
                variant="bar"
                size="tile"
                viewportHeight={52}
                barGap={2}
                barMinHeight={2}
                axisTicks={['12A', '6A', '12P', '6P']}
                showGrid={false}
                showAnnotations
                showReadout={false}
                renderBucket={usageSeriesTooltip(
                  accent,
                  'usage-rhythm-hour-trigger',
                )}
              />
            )}
          </View>
        ) : null}
      </View>
      <UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 12, minWidth: 0 },
  blocks: { gap: 20 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  block: { gap: 8, minWidth: 0 },
  half: { flex: 1 },
  label: {
    ...Typography.default('semiBold'),
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text.secondary,
  },
}));
