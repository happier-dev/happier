import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UsagePeriodSummaryBody, formatHappierDataValue, type UsageSummaryMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import { Typography } from '@/constants/Typography';
import {
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsageComparisonCost,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
  readUsageSourceNeedsNewerServer,
} from './usageBodyKit';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { formatUsageDurationCompact } from './usageHowYouWorkPresentation';
import { usageComparison } from '../usageComparisonPresentation';

const HOUR_MS = 60 * 60 * 1000;

/**
 * "Your month": the one multi-number widget. The hero is the shown metric with its exact preceding
 * range; below it only facts this query actually produced (paid, merged work, agent time).
 */
export function UsagePeriodSummaryWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const previousCost = useUsageComparisonCost(props.slice, props.query.costBasis,
    props.query.metric === 'cost' ? view?.pageCost.selection : null);
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!view)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} readingShape={{ kind: 'summary' }} onRetry={props.model.refresh} />;
  const cost = props.query.metric === 'cost';
  const selectedCost = view.pageCost;
  const currency = selectedCost.selection?.currency ?? view.costPresentation.currency;
  // `amountUsd` is authoritative: a candidate basis with an unavailable amount means some usage has
  // neither a reported cost nor a model price, never "estimated where not reported" under a dash.
  const costCaption =
    selectedCost.amountUsd !== null && selectedCost.selection
      ? usageCostKindPhrase(selectedCost.selection.kind)
      : selectedCost.selection
        ? t('usage.board.page.costUnpricedCaption')
        : t('common.unavailable');
  const current = cost ? selectedCost.amountUsd : view.hero.totalTokens;
  const previousAccounting = props.slice.comparison?.accounting;
  const previous = previousAccounting
    ? cost
      ? previousCost
      : previousAccounting.totals.tokens.total
    : null;
  const comparison = usageComparison(current, previous);
  const apiEquivalent = props.slice.costFactTotals?.find(fact => fact.kind === 'api_equivalent' && fact.currency === currency);
  const invoice = props.slice.costFactTotals?.find(fact => fact.kind === 'invoice' && fact.currency === currency);
  // A work read this Home's server cannot answer counts nothing, not zero merged work.
  const merged = readUsageSourceNeedsNewerServer(props.slice, 'work') ? null
    : props.slice.workSummary?.mergedPrCount ?? null;
  const measuredIntervals = props.slice.howYouWork?.intervals;
  const intervals = measuredIntervals?.coverage === 'complete_for_supplied_facts' ? measuredIntervals : null;
  const subline = [
    comparison !== null ? t('usage.board.page.vsPrevious') : null,
    t('usage.board.page.sessionsCount', {
      count: view.hero.sessions.toLocaleString(),
    }),
    !cost && apiEquivalent?.amountUsd != null
      ? t('usage.board.page.atApiPrices', {
          amount: formatUsageCost(apiEquivalent.amountUsd, currency),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // A figure this Home's server is too old to read will not arrive by waiting: its slot says so in the header's words.
  const unmeasured = (source: 'how_you_work' | 'work') => readUsageSourceNeedsNewerServer(props.slice, source)
    ? t('usage.board.page.needsNewerServer') : t('usage.board.page.notMeasuredYet');
  const stats: UsageSummaryMetric[] = [];
  if (!cost && invoice?.amountUsd != null)
    stats.push(
      { id: 'paid', label: t('usage.board.page.youPaid'), value: invoice.amountUsd,
        valueFormatter: (value) => formatUsageCost(value, currency), caption: usageCostKindPhrase('invoice') },
    );
  else
    stats.push(
      { id: 'cost', label: t('usage.cost'), value: selectedCost.amountUsd ?? UNKNOWN_VALUE,
        valueFormatter: (value) => formatUsageCost(value, currency), caption: costCaption },
    );
  if (props.query.includeWorkEvidence)
    stats.push(
      { id: 'merged', label: t('usage.board.page.mergedPrs'), value: merged ?? UNKNOWN_VALUE,
        // Every figure, a zero or a dash included, says why it reads as it does in the same caption slot.
        caption:
          merged === null
            ? unmeasured('work')
            : merged > 0
              ? t('usage.board.page.linkedByEvidence')
              : t('usage.board.page.noneLinkedByEvidence'),
      },
    );
  // The query chooses the statistic; asynchronous arrivals only replace its
  // value. An unanswered duration never temporarily becomes Active days.
  if (props.query.includeSessionEvidence)
    stats.push(
      { id: 'agent', label: t('usage.board.page.agentTime'), value: intervals ? intervals.agentTimeMs / HOUR_MS : UNKNOWN_VALUE,
        valueFormatter: intervals ? () => formatUsageDurationCompact(intervals.agentTimeMs) : undefined,
        ...(intervals && !formatUsageDurationCompact(intervals.agentTimeMs).includes(formatHappierDataValue(intervals.agentTimeMs / HOUR_MS, getPreferredLanguage())) ? {
          datum: { label: t('usage.board.page.agentTime'),
            value: t('usage.board.howYouWork.durationSeconds', { seconds: formatHappierDataValue(intervals.agentTimeMs / 1000, getPreferredLanguage()) }),
            subtitle: t('usage.board.page.elapsedTime', { time: t('usage.board.howYouWork.durationSeconds', {
              seconds: formatHappierDataValue(intervals.elapsedBusyMs / 1000, getPreferredLanguage()),
            }) }) },
        } : {}),
        caption: intervals ? t('usage.board.page.elapsedTime', {
          time: formatUsageDurationCompact(intervals.elapsedBusyMs),
        }) : unmeasured('how_you_work') },
    );
  else
    stats.push(
      { id: 'active', label: t('usage.board.page.activeDays'), value: view.insights.activeDays ?? UNKNOWN_VALUE,
        caption: view.hero.longestStreakDays === null ? undefined : t('usage.board.page.longestStreak', {
          count: view.hero.longestStreakDays,
        }) },
    );
  return (
    <UsagePeriodSummaryBody theme={chartTheme} testID={props.testID} stats={stats}
      spacing={{ body: theme.space.s20, statColumns: theme.space.s24, statRows: theme.space.s16 }}
      subline={subline} sublineStyle={styles.subline} hero={{
          id: 'total',
          label: cost ? t('usage.cost') : t('usage.tokens'),
          value: current ?? UNKNOWN_VALUE,
          caption: cost ? costCaption : current === null ? t('common.unavailable') : undefined,
          unit: cost ? undefined : t('usage.board.page.tokensUnit'),
          valueFormatter:
            cost
              ? (value) => formatUsageCost(value, currency)
              : formatTokenCount,
          ...(comparison !== null
            ? {
                comparison: {
                  value: comparison.value,
                  label: subline,
                  meaning: 'neutral' as const,
                },
              }
            : {})
      }} coverage={<UsageCoverageLine
        slice={props.slice}
        sources={['accounting', 'comparison']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />} />
  );
}

const UNKNOWN_VALUE = '—';

const styles = StyleSheet.create((theme) => ({
  // The line under the figure sits where the comparison's label sits once it lands (same role, colour and
  // gap as HappierDataMetric's), so the comparison's arrival replaces this line without moving what is below.
  subline: { ...Typography.variant('micro'), color: theme.colors.text.tertiary },
}));
