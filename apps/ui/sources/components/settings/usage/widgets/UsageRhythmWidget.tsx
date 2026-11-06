import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { UsageRhythmChart, USAGE_RHYTHM_MATRIX_MIN_WIDTH_PX, USAGE_RHYTHM_SIDE_BY_SIDE_MIN_WIDTH_PX } from '@happier-dev/plugin-ui/presentation';
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
  UsageBodyReadFailed,
  UsageBodyReading,
  UsageCoverageLine,
  isUsageReadFailed,
  isUsageReadOutstanding,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { UsageSkyStyleBody, UsageWeekTideStyleBody, UsageDaylightStyleBody } from './UsageChartStyleBodies';
import { UsageCalendarArtStyleBody, isUsageCalendarArtStyle } from './UsagePlanetFamilyBodies';

/**
 * What the settled body measures at the widths the page is designed for, so the reading state holds
 * that room: side by side (calendar beside weekday × hour), a half-width card (calendar over the matrix,
 * measured at ~430 px) and a phone (calendar over the 24-hour rhythm). Other widths hold nothing rather
 * than a guess.
 */
const SETTLED_SIDE_BY_SIDE_BODY_PX = 180;
const SETTLED_HALF_WIDTH_BODY_PX = 272;
const HALF_WIDTH_MAX_PX = 520;
const SETTLED_PHONE_BODY_PX = 223;
function settledBodyPx(width: number | undefined): number | undefined {
  if (width === undefined) return undefined;
  if (width >= USAGE_RHYTHM_SIDE_BY_SIDE_MIN_WIDTH_PX) return SETTLED_SIDE_BY_SIDE_BODY_PX;
  if (width < USAGE_RHYTHM_MATRIX_MIN_WIDTH_PX) return SETTLED_PHONE_BODY_PX;
  return width < HALF_WIDTH_MAX_PX ? SETTLED_HALF_WIDTH_BODY_PX : undefined;
}

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageRhythmWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  if (style === 'sky') return <UsageSkyStyleBody {...props} />;
  if (style === 'weekTide') return <UsageWeekTideStyleBody {...props} />;
  if (style === 'daylight') return <UsageDaylightStyleBody {...props} />;
  if (isUsageCalendarArtStyle(style)) return <UsageCalendarArtStyleBody {...props} style={style} />;
  return <UsageRhythmWidgetOriginal {...props} />;
}

/**
 * "When you work": the active-days calendar beside the weekday × hour rhythm, both read from the same
 * admitted activity facts in the query's own calendar (fixed offset, Monday weeks).
 */
function UsageRhythmWidgetOriginal(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const width = useWidgetPresentation()?.geometry?.width;
  const accent = usageSignatureAccent(theme);
  const activity = view?.activity;
  const language = getPreferredLanguage();
  const calendar = React.useMemo(() => {
    const range = resolveUsageShownCalendarRange(props.query, props.slice.accounting?.coverage, props.slice.accounting, props.slice.accountingObservationRange);
    return activity && range ? usageHeatmapPresentation({ calendarDays: activity.calendarDays, mode: 'daily', range,
      coverage: props.slice.accounting?.coverage, accentColor: accent, emptyColor: theme.colors.surface.inset }) : null;
  }, [activity, props.query, props.slice.accounting, props.slice.accountingObservationRange, accent, theme.colors.surface.inset, language]);
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
    if (isUsageReadOutstanding(props.slice, ['accounting']))
      return (
        <View style={{ minHeight: settledBodyPx(width) }}>
          <UsageBodyReading testID={`${props.testID}.loading`} />
        </View>
      );
    if (isUsageReadFailed(props.slice, ['accounting']))
      return <UsageBodyReadFailed slice={props.slice} sources={['accounting']} testID={props.testID} onRetry={props.model.refresh} />;
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.rhythmEmptyTitle')}
        reason={t('usage.board.howYouWork.rhythmEmptyReason')}
      />
    );
  }
  const matrix = width === undefined || width >= USAGE_RHYTHM_MATRIX_MIN_WIDTH_PX;
  return (
    <UsageRhythmChart theme={chartTheme} width={width} testID={props.testID}
      spacing={{ body: theme.space.s12, blocks: theme.space.s20, block: theme.space.s8 }}
      headings={{
        calendar: <Text style={styles.label}>{t('usage.board.howYouWork.activeDays')}</Text>,
        weekdayHour: <Text style={styles.label}>{t('usage.board.howYouWork.weekdayHour')}</Text>,
        byHour: <Text style={styles.label}>{t('usage.board.howYouWork.byHour')}</Text>,
      }}
      calendar={hasCalendar && calendar ? {
        ...calendar,
        renderCell: usageGridTooltip(accent, 'usage-heatmap-cell-trigger'),
        renderFrame: calendar.layout === 'strip' ? undefined : usageGridFrame,
      } : undefined}
      punch={hasRhythm && matrix ? {
        ...usageDotGridPresentation(view.punchCard, accent, theme.colors.border.default),
        renderCell: usageGridTooltip(accent, 'usage-punchcard-cell-trigger'),
      } : undefined}
      hours={hasRhythm && (width === undefined || !matrix) ? {
        label: t('usage.workRhythm'),
        series: createUsageHourRhythmSeries(view.hourRhythm, accent, theme.colors.border.default),
        variant: 'bar', size: 'tile', viewportHeight: 52, barGap: 2, barMinHeight: 2,
        axisTicks: [{ label: '12A', bucket: 0 }, { label: '6A', bucket: 6 }, { label: '12P', bucket: 12 }, { label: '6P', bucket: 18 }],
        showGrid: false, showAnnotations: true, showReadout: false,
        renderBucket: usageSeriesTooltip(accent, 'usage-rhythm-hour-trigger'),
      } : undefined}
      footer={<UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
      />} />
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.secondary,
  },
}));
