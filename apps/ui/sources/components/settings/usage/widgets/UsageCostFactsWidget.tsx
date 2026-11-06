import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { UsageAnalyticsCostFactKind } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { ChartDatum, formatHappierDataValue, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
  usagePartialHistoryLabel,
} from './usageBodyKit';
import { UsageModelPricesLine } from './UsageModelPrices';

/** Each kind of money is its own fact; they are never summed into one figure. */
const KIND_ORDER: readonly UsageAnalyticsCostFactKind[] = [
  'api_equivalent',
  'invoice',
  'reported',
  'estimated',
  'unpriced',
];

const KIND_TITLE: Readonly<
  Record<
    UsageAnalyticsCostFactKind,
    | 'usage.board.page.factApiEquivalent'
    | 'usage.board.page.factInvoice'
    | 'usage.board.page.factReported'
    | 'usage.board.page.factEstimated'
    | 'usage.board.page.factUnpriced'
  >
> = {
  api_equivalent: 'usage.board.page.factApiEquivalent',
  invoice: 'usage.board.page.factInvoice',
  reported: 'usage.board.page.factReported',
  estimated: 'usage.board.page.factEstimated',
  unpriced: 'usage.board.page.factUnpriced',
};

/**
 * "What the money means": up to five separate facts — worth at API prices, invoiced, reported,
 * estimated and unpriced tokens. A missing kind is absent, not $0; unpriced is tokens, never money.
 */
export function UsageCostFactsWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const facts = KIND_ORDER.flatMap((kind) => (props.slice.costFactTotals ?? []).filter((fact) => fact.kind === kind &&
      (fact.kind === 'unpriced'
        ? fact.tokens.total > 0
        : fact.eventCount > 0 || (fact.amountUsd ?? 0) > 0)
  ));
  // One qualifier, said once: when every fact is partial the band says so once, not under each figure (R9).
  const partialOnce = facts.length > 1 && facts.every((fact) => !fact.complete);
  if (!props.slice.accounting)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  // The prices behind API-equivalent money live with the money they make (U10); unpriced models
  // are exactly the case where there are no money facts yet.
  const prices = <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />;
  if (facts.length === 0)
    return (
      <View style={styles.body}>
        <UsageBodyInsufficient
          testID={`${props.testID}.noMoney`}
          replacesContent={false}
          title={t('usage.board.page.noCostFactsTitle')}
          reason={t('usage.board.page.noCostFactsReason')}
        />
        {prices}
      </View>
    );
  return (
    <View style={styles.body} testID={`${props.testID}.costFacts`}>
      <View style={styles.grid}>
        {facts.map((fact) => {
          const exactTokens = formatHappierDataValue(fact.tokens.total, getPreferredLanguage());
          const exactAmount = fact.amountUsd === null ? null : formatHappierDataValue(fact.amountUsd, getPreferredLanguage());
          const hiddenPrecision = !formatTokenCount(fact.tokens.total).includes(exactTokens)
            || exactAmount !== null && !formatUsageCost(fact.amountUsd!, fact.currency).includes(exactAmount);
          const figure = <HappierDataMetric
              testID={`${props.testID}.fact.${fact.kind}`}
              theme={chartTheme}
              size="stat"
              showLabel
              label={t(KIND_TITLE[fact.kind])}
              value={fact.amountUsd ?? fact.tokens.total}
              {...(fact.amountUsd === null
                ? { unit: t('usage.board.page.tokensUnit') }
                : {})}
              valueFormatter={
                fact.amountUsd === null
                  ? formatTokenCount
                  : (value) => formatUsageCost(value, fact.currency)
              }
              caption={[
                fact.amountUsd === null
                  ? t('usage.board.page.unpricedCaption')
                  : t('usage.board.page.factTokens', {
                      tokens: formatTokenCount(fact.tokens.total),
                    }),
                fact.complete || partialOnce ? null : t('usage.board.page.factIncomplete'),
              ]
                .filter(Boolean)
                .join(' · ')}
            />;
          return <View key={`${fact.kind}:${fact.currency}`} style={styles.cell}>
            {hiddenPrecision ? <ChartDatum testID={`${props.testID}.fact.${fact.kind}.detail`}
              datum={{ label: t(KIND_TITLE[fact.kind]),
                value: exactAmount === null ? `${exactTokens} ${t('usage.board.page.tokensUnit')}` : `${fact.currency} ${exactAmount}`,
                subtitle: [t('usage.board.page.factTokens', { tokens: exactTokens }),
                  fact.complete ? null : t('usage.board.page.factIncomplete')].filter(Boolean).join(' · ') }}>
              {figure}
            </ChartDatum> : figure}
          </View>;
        })}
      </View>
      {partialOnce ? (
        <Text style={styles.partial} testID={`${props.testID}.partial`}>{usagePartialHistoryLabel()}</Text>
      ) : null}
      {prices}
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  partial: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
  body: { gap: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 18 },
  cell: { flexGrow: 1, flexBasis: 150, minWidth: 0 },
}));
