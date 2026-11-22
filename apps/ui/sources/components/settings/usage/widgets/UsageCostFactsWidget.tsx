import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { UsageAnalyticsCostFactKind } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { ChartDatum, formatHappierDataValue, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
  usagePartialHistoryLabel,
  useUsageAnalyticsView,
  UsageBodyNote,
} from './usageBodyKit';
import { UsageModelPricesLine } from './UsageModelPrices';
import { usagePageCostCaption, usageTokensFromPartsNote } from '../usageCostPresentation';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';

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
  // The one answer leads: the page cost Overview, Agents and the Period summary show, from the same owner decision.
  const pageCost = useUsageAnalyticsView(props.slice, props.query)?.pageCost ?? null;
  // Unknown never leads: without a known amount the facts stand on their own.
  const total = pageCost?.amountUsd != null && pageCost.selection ? { amountUsd: pageCost.amountUsd, selection: pageCost.selection } : null;
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const facts = KIND_ORDER.flatMap((kind) => (props.slice.costFactTotals ?? []).filter((fact) => fact.kind === kind &&
      (fact.kind === 'unpriced'
        ? fact.eventCount > 0 || (resolveUsageMeasuredTokens(fact.tokens).total ?? 0) > 0
        : fact.eventCount > 0 || fact.amountUsd !== null && fact.amountUsd > 0)
  ));
  // One qualifier, said once: when every fact is partial the band says so once, not under each figure (R9).
  const partialOnce = facts.length > 1 && facts.every((fact) => !fact.complete);
  // The same for token totals added up from their parts: once under the figures, never after each one (USAGE-ACCEPT 1121 #13).
  const fromPartsNote = usageTokensFromPartsNote(facts.map((fact) => resolveUsageMeasuredTokens(fact.tokens).fromParts));
  if (!props.slice.accounting)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  // The prices behind API-equivalent money live with the money they make (U10); unpriced models
  // are exactly the case where there are no money facts yet.
  const prices = <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />;
  const lead = total ? <HappierDataMetric testID={`${props.testID}.total`} theme={chartTheme} size="hero"
    label={t('usage.cost')} value={total.amountUsd} caption={usagePageCostCaption(total)}
    valueFormatter={(value) => formatUsageCost(value, total.selection.currency)} /> : null;
  if (facts.length === 0 && lead)
    return (
      <View style={styles.body} testID={`${props.testID}.costFacts`}>
        {lead}
        {prices}
        <UsageCoverageLine slice={props.slice} sources={['accounting']} onRetry={props.model.refresh} testID={`${props.testID}.coverage`} />
      </View>
    );
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
      {lead}
      <View style={styles.grid}>
        {facts.map((fact) => {
          const tokens = resolveUsageMeasuredTokens(fact.tokens);
          const exactTokens = formatHappierDataValue(tokens.total, getPreferredLanguage());
          const exactAmount = fact.amountUsd === null ? null : formatHappierDataValue(fact.amountUsd, getPreferredLanguage());
          const hiddenPrecision = !formatTokenCount(tokens.total).includes(exactTokens)
            || exactAmount !== null && !formatUsageCost(fact.amountUsd!, fact.currency).includes(exactAmount);
          const figure = <HappierDataMetric
              testID={`${props.testID}.fact.${fact.kind}`}
              theme={chartTheme}
              size="stat"
              showLabel
              label={t(KIND_TITLE[fact.kind])}
              value={fact.amountUsd ?? tokens.total ?? '—'}
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
                  ? t('usage.board.page.factUnpricedOverlap')
                  // Money with no counted tokens (an Agent that reports cost only) has no token line, never "— tokens".
                  : tokens.total === null ? null
                  : fact.kind === 'api_equivalent'
                    ? t('usage.board.page.factApiTokens', { tokens: formatTokenCount(tokens.total) })
                    // The tokens on the rows that carried this money, not every token of the Agents that reported it.
                    : t('usage.board.page.factCostTokens', { tokens: formatTokenCount(tokens.total) }),
                fact.complete || partialOnce ? null : t('usage.board.page.factIncomplete'),
              ]
                .filter(Boolean)
                .join(' · ')}
            />;
          return <View key={`${fact.kind}:${fact.currency}`} style={styles.cell}>
            {hiddenPrecision ? <ChartDatum testID={`${props.testID}.fact.${fact.kind}.detail`}
              datum={{ label: t(KIND_TITLE[fact.kind]),
                value: exactAmount === null ? `${exactTokens} ${t('usage.board.page.tokensUnit')}` : `${fact.currency} ${exactAmount}`,
                subtitle: [fact.amountUsd === null ? null : fact.kind === 'api_equivalent'
                  ? t('usage.board.page.factApiTokens', { tokens: exactTokens }) : t('usage.board.page.factCostTokens', { tokens: exactTokens }),
                  tokens.fromParts ? t('usage.board.page.tokensFromParts') : null,
                  fact.complete ? null : t('usage.board.page.factIncomplete')].filter(Boolean).join(' · ') }}>
              {figure}
            </ChartDatum> : figure}
          </View>;
        })}
      </View>
      {/* The figures count overlapping populations, so they never present as parts of one sum. */}
      {facts.length > 1 || fromPartsNote ? (
        <UsageBodyNote testID={`${props.testID}.partial`}>
          {[partialOnce ? usagePartialHistoryLabel() : null, fromPartsNote,
            facts.length > 1 ? t('usage.board.page.factsOverlap') : null].filter(Boolean).join(' · ')}
        </UsageBodyNote>
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
  body: { gap: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 18 },
  // Two figures share a phone row (lab d2views P, 2×2): two bases and the gap fit a 390 px sheet's column.
  cell: { flexGrow: 1, flexBasis: 128, minWidth: 0 },
}));
