import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { UsageAnalyticsCostFactKind } from '@happier-dev/protocol';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';

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
  if (!props.slice.accounting)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.page.noUsageTitle')}
        reason={t('usage.board.page.noUsageReason')}
      />
    );
  if (facts.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.noMoney`}
        title={t('usage.board.page.noCostFactsTitle')}
        reason={t('usage.board.page.noCostFactsReason')}
      />
    );
  return (
    <View style={styles.body} testID={`${props.testID}.costFacts`}>
      <View style={styles.grid}>
        {facts.map((fact) => (
          <View key={`${fact.kind}:${fact.currency}`} style={styles.cell}>
            <HappierDataMetric
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
                fact.complete ? null : t('usage.board.page.factIncomplete'),
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          </View>
        ))}
      </View>
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  body: { gap: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 18 },
  cell: { flexGrow: 1, flexBasis: 150, minWidth: 0 },
}));
