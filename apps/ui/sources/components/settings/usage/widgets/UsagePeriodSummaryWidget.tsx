import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { formatUsageDuration } from './usageHowYouWorkPresentation';

const HOUR_MS = 60 * 60 * 1000;

/**
 * "Your month": the one multi-number widget. The hero is the shown metric with its exact preceding
 * range; below it only facts this query actually produced (paid, merged work, agent time).
 */
export function UsagePeriodSummaryWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!view)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.page.noUsageTitle')}
        reason={t('usage.board.page.noUsageReason')}
      />
    );
  const cost = props.query.metric === 'cost';
  const currency = view.costPresentation.currency;
  const current = cost ? view.hero.effectiveUsd : view.hero.totalTokens;
  const previousAccounting = props.slice.comparison?.accounting;
  const previous = previousAccounting
    ? cost
      ? (previousAccounting.costPresentation?.effectiveUsd ?? null)
      : previousAccounting.totals.tokens.total
    : null;
  const delta =
    previous !== null && previous > 0 ? (current - previous) / previous : null;
  const apiEquivalent = props.slice.costFactTotals?.find(fact => fact.kind === 'api_equivalent' && fact.currency === currency);
  const invoice = props.slice.costFactTotals?.find(fact => fact.kind === 'invoice' && fact.currency === currency);
  const merged =
    props.slice.work?.outcomes.filter(
      (outcome) => outcome.pullRequest.state === 'merged',
    ) ?? null;
  const intervals = props.slice.howYouWork?.intervals ?? null;
  const subline = [
    delta !== null ? t('usage.board.page.vsPrevious') : null,
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
  const stats: React.ReactElement[] = [];
  if (invoice?.amountUsd != null)
    stats.push(
      <HappierDataMetric
        key="paid"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.youPaid')}
        value={invoice.amountUsd}
        valueFormatter={(value) => formatUsageCost(value, currency)}
        caption={usageCostKindPhrase('invoice')}
      />,
    );
  else
    stats.push(
      <HappierDataMetric
        key="cost"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.cost')}
        value={view.hero.effectiveUsd}
        valueFormatter={(value) => formatUsageCost(value, currency)}
        caption={
          view.costPresentation.source
            ? usageCostKindPhrase(view.costPresentation.source)
            : undefined
        }
      />,
    );
  if (merged)
    stats.push(
      <HappierDataMetric
        key="merged"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.mergedPrs')}
        value={merged.length}
        caption={
          merged.length > 0 ? t('usage.board.page.linkedByEvidence') : undefined
        }
      />,
    );
  if (intervals)
    stats.push(
      <HappierDataMetric
        key="agent"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.agentTime')}
        value={intervals.agentTimeMs / HOUR_MS}
        valueFormatter={() => formatUsageDuration(intervals.agentTimeMs)}
        caption={t('usage.board.page.elapsedTime', {
          time: formatUsageDuration(intervals.elapsedBusyMs),
        })}
      />,
    );
  if (stats.length < 3)
    stats.push(
      <HappierDataMetric
        key="active"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.activeDays')}
        value={view.insights.activeDays}
        caption={t('usage.board.page.longestStreak', {
          count: view.hero.longestStreakDays,
        })}
      />,
    );
  return (
    <View style={styles.body} testID={`${props.testID}.summary`}>
      <View style={styles.hero}>
        <HappierDataMetric
          testID={`${props.testID}.hero`}
          theme={chartTheme}
          size="hero"
          label={cost ? t('usage.cost') : t('usage.tokens')}
          value={current}
          unit={cost ? undefined : t('usage.board.page.tokensUnit')}
          valueFormatter={
            cost
              ? (value) => formatUsageCost(value, currency)
              : formatTokenCount
          }
          {...(delta !== null
            ? {
                comparison: {
                  value: `${delta >= 0 ? '▲' : '▼'} ${Math.round(Math.abs(delta) * 100)}%`,
                  label: subline,
                  meaning: 'neutral' as const,
                },
              }
            : {})}
        />
        {delta === null ? <Text style={styles.subline}>{subline}</Text> : null}
      </View>
      <View style={styles.stats}>
        {stats.map((stat) => (
          <View key={stat.key} style={styles.stat}>
            {stat}
          </View>
        ))}
      </View>
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting', 'comparison']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  subline: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.text.secondary },
  body: { gap: 20 },
  hero: { gap: 4 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 16 },
  stat: { flexGrow: 1, flexBasis: 120, minWidth: 0 },
}));
