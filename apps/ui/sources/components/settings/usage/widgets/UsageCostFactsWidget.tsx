import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { UsageAnalyticsCostFactKind } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { ChartDatum, formatHappierDataValue, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useRegisterUsageBodyReadingPlaceholder } from './usageBodyHeightMemory';
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
import { usageCostKindPhrase, usageTokensFromPartsNote } from '../usageCostPresentation';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';
import { readUsageAppCallsEnvironmentIds } from '@/sync/domains/usage/usageAppCallsSource';

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

/** A fact's name: App calls have no agents, so what the provider reported says who reported it. */
type CostFact = NonNullable<UsageBodyProps['slice']['costFactTotals']>[number];

/** The tokens a money fact was counted on, as its caption says them; null for money with no counted tokens. */
function costFactTokensCaption(fact: CostFact, tokens: string | null): string | null {
  if (fact.amountUsd === null || tokens === null) return null;
  // The tokens on the rows that carried this money, not every token of the Agents that reported it.
  return fact.kind === 'api_equivalent'
    ? t('usage.board.page.factApiTokens', { tokens })
    : t('usage.board.page.factCostTokens', { tokens });
}

/**
 * A fact's figure with its exact values a press or hover away when the ink rounds them (4.2M tokens, $0.0028): one rule
 * for the facts and for the lead that says one of them.
 */
function withExactBasis(figure: React.ReactElement, fact: CostFact, appCalls: boolean, testID: string): React.ReactElement {
  const tokens = resolveUsageMeasuredTokens(fact.tokens);
  const exactTokens = formatHappierDataValue(tokens.total, getPreferredLanguage());
  const exactAmount = fact.amountUsd === null ? null : formatHappierDataValue(fact.amountUsd, getPreferredLanguage());
  const hiddenPrecision = !formatTokenCount(tokens.total).includes(exactTokens)
    || exactAmount !== null && !formatUsageCost(fact.amountUsd!, fact.currency).includes(exactAmount);
  if (!hiddenPrecision) return figure;
  return <ChartDatum testID={testID}
    datum={{ label: costFactTitle(fact.kind, appCalls),
      value: exactAmount === null ? `${exactTokens} ${t('usage.board.page.tokensUnit')}` : `${fact.currency} ${exactAmount}`,
      subtitle: [costFactTokensCaption(fact, exactTokens),
        tokens.fromParts ? t('usage.board.page.tokensFromParts') : null,
        fact.complete ? null : t('usage.board.page.factIncomplete')].filter(Boolean).join(' · ') }}>
    {figure}
  </ChartDatum>;
}

function costFactTitle(kind: UsageAnalyticsCostFactKind, appCalls: boolean): string {
  return kind === 'reported' && appCalls ? t('usage.board.page.factReportedByProvider') : t(KIND_TITLE[kind]);
}

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
  const appCalls = readUsageAppCallsEnvironmentIds(props.query.sources) !== null;
  const facts = KIND_ORDER.flatMap((kind) => (props.slice.costFactTotals ?? []).filter((fact) => fact.kind === kind &&
      (fact.kind === 'unpriced'
        ? fact.eventCount > 0 || (resolveUsageMeasuredTokens(fact.tokens).total ?? 0) > 0
        : fact.eventCount > 0 || fact.amountUsd !== null && fact.amountUsd > 0)
  ));
  // The lead is the page cost. When exactly one displayed fact is that same money (its kind, its currency and its
  // amount), the lead says it once and carries that fact's token basis; the fact is not said again beneath it (design
  // review D2, Usage ruling 11-26, J-B76). Two figures that only print alike are never the same fact.
  const leadMatches = total ? facts.filter((fact) => fact.kind === total.selection.kind
    && fact.currency === total.selection.currency && fact.amountUsd === total.amountUsd) : [];
  const leadFact = leadMatches.length === 1 ? leadMatches[0] : undefined;
  const shownFacts = leadFact ? facts.filter((fact) => fact !== leadFact) : facts;
  // One qualifier, said once: when every fact is partial the band says so once, not under each figure (R9).
  const partialOnce = facts.length > 1 && facts.every((fact) => !fact.complete);
  // The same for token totals added up from their parts: once under the figures, never after each one (USAGE-ACCEPT 1121 #13).
  const fromPartsNote = usageTokensFromPartsNote(facts.map((fact) => resolveUsageMeasuredTokens(fact.tokens).fromParts));
  if (!props.slice.accounting)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  // The prices behind API-equivalent money live with the money they make (U10); unpriced models
  // are exactly the case where there are no money facts yet.
  const prices = <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />;
  const leadTokens = leadFact ? resolveUsageMeasuredTokens(leadFact.tokens).total : null;
  // The qualifier comes before the token basis, so a two-line caption never cuts it off (J-B77).
  const leadCaption = total === null ? '' : [usageCostKindPhrase(total.selection.kind),
    leadFact && !leadFact.complete && !partialOnce ? t('usage.board.page.factIncomplete') : null,
    leadFact ? costFactTokensCaption(leadFact, leadTokens === null ? null : formatTokenCount(leadTokens)) : null].filter(Boolean).join(' · ');
  const leadFigure = total ? <HappierDataMetric testID={`${props.testID}.total`} theme={chartTheme} size="hero"
    label={t('usage.cost')} value={total.amountUsd} caption={leadCaption}
    valueFormatter={(value) => formatUsageCost(value, total.selection.currency)} /> : null;
  const lead = leadFigure && leadFact ? withExactBasis(leadFigure, leadFact, appCalls, `${props.testID}.total.detail`) : leadFigure;
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
      {shownFacts.length > 0 ? <View style={styles.grid}>
        {shownFacts.map((fact) => {
          const tokens = resolveUsageMeasuredTokens(fact.tokens);
          const figure = <HappierDataMetric
              testID={`${props.testID}.fact.${fact.kind}`}
              theme={chartTheme}
              size="stat"
              showLabel
              label={costFactTitle(fact.kind, appCalls)}
              value={fact.amountUsd ?? tokens.total ?? '—'}
              {...(fact.amountUsd === null
                ? { unit: t('usage.board.page.tokensUnit') }
                : {})}
              valueFormatter={
                fact.amountUsd === null
                  ? formatTokenCount
                  : (value) => formatUsageCost(value, fact.currency)
              }
              // The qualifier leads, so the two-line caption never cuts it off (J-B77).
              caption={[
                fact.complete || partialOnce ? null : t('usage.board.page.factIncomplete'),
                fact.amountUsd === null
                  ? t('usage.board.page.factUnpricedOverlap')
                  // Money with no counted tokens (an Agent that reports cost only) has no token line, never "— tokens".
                  : costFactTokensCaption(fact, tokens.total === null ? null : formatTokenCount(tokens.total)),
              ]
                .filter(Boolean)
                .join(' · ')}
            />;
          // Unpriced tokens are said with a sentence, not a figure's basis: that cell takes its own line, so the
          // sentence is never cut short beside a money figure (design review D2).
          return <View key={`${fact.kind}:${fact.currency}`} style={[styles.cell, fact.amountUsd === null ? styles.sentenceCell : null]}>
            {withExactBasis(figure, fact, appCalls, `${props.testID}.fact.${fact.kind}.detail`)}
          </View>;
        })}
      </View> : null}
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

/** Room for a line whose words arrive with the read: drawn nowhere, it only holds the line. */
const HELD_LINE = '\u00a0';

/**
 * Cost facts' first read in the shape that lands (r223 #66): the lead figure, the row of labelled facts (four, as an
 * Account with every kind of money draws them; a phone wraps them 2 × 2), the overlap note and the prices line, each held by the shared pending metric (the declarative loading mechanism, fc934452b71), not three list rows.
 */
export function UsageCostFactsReading(props: Readonly<{ testID: string }>) {
  const chartTheme = useUsagePluginTheme();
  useRegisterUsageBodyReadingPlaceholder();
  const loadingLabel = t('usage.board.page.loading');
  return (
    <View
      style={styles.body}
      testID={props.testID}
      accessible
      accessibilityRole="progressbar"
      role="progressbar"
      accessibilityLabel={loadingLabel}
      aria-label={loadingLabel}
      accessibilityState={{ busy: true }}
      aria-busy
    >
      <HappierDataMetric theme={chartTheme} size="hero" pending decorative label={t('usage.cost')} value={0} caption={HELD_LINE} />
      {/* The lead says the fact it is, so the settled grid holds the other money: one row of two figures is the
          common landing at 1440 and 390 (design review D2, J-B77). A warm read keeps its remembered room. */}
      <View style={styles.grid}>
        {[0, 1].map((index) => (
          <View key={index} style={styles.cell}>
            <HappierDataMetric theme={chartTheme} size="stat" pending decorative showLabel label={HELD_LINE} value={0} caption={HELD_LINE} />
          </View>
        ))}
      </View>
      {/* The overlap note under the figures and the prices line keep their lines. */}
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <UsageBodyNote testID={`${props.testID}.note`}>{HELD_LINE}</UsageBodyNote>
      </View>
      <View style={styles.pricesRoom} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 16 },
  pricesRoom: { minHeight: HAPPIER_PAGE_METRICS.smallControlHeightPx },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 18 },
  // Two figures share a phone row (lab d2views P, 2×2): two bases and the gap fit a 390 px sheet's column.
  cell: { flexGrow: 1, flexBasis: 128, minWidth: 0 },
  sentenceCell: { flexBasis: '100%' },
}));
