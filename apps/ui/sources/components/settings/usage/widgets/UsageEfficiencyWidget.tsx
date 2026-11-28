import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  CompositionStrip,
  ChartDatum,
  formatHappierDataExactShare,
  formatHappierDataValue,
  HappierDataMetric,
  UsageChartValues,
} from '@happier-dev/plugin-ui/presentation';
import { ChartTooltip } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePlanText } from './plans/UsagePlanParts';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useDeviceType } from '@/utils/platform/responsive';
import {
  formatTokenCount,
  formatTokenCountLong,
  formatUsageCost,
} from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import { usageSeriesColor } from '../usageAccent';
import { usagePageCostCaption } from '../usageCostPresentation';
import { usageComparison } from '../usageComparisonPresentation';
import { usageChartValuesLabels } from './usageChartHost';
import {
  usageCompositionSegments,
  usageCompositionShareLabel,
} from '../usageCompositionPresentation';
import {
  isUsageReadOutstanding,
  UsageBodyInsufficient,
  UsageBodyReading,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsageComparisonCost,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
  UsageBodyNothingYet,
} from './usageBodyKit';
import { useUsageWidgetPageNothingRecorded } from './usageWidgetBatch';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';

/** The waffle's legend: the strip's own key layout (one entry a row), never a page-local legend. */
const MIX_KEY_LEGEND = { legend: 'compact', layout: 'key' } as const;
/** A segment's colour is a height:100% fill, so its tooltip trigger fills the segment or the strip paints only its track. */
const MIX_SEGMENT_TRIGGER_STYLE = { flex: 1 } as const;

/** Below this width the mix is the dot waffle (lab `kitcharts`: "waffle on tile and phone"). */
const WAFFLE_BELOW_PX = 360;
/** From this width the figures share one row (a full-width band); narrower, they pair up two a row. */
const ALL_ACROSS_FROM_PX = 720;

function selectEfficiencyPerMergedPr({ query, slice }: Pick<UsageBodyProps, 'query' | 'slice'>, costUsd: number | null) {
  const session = query.session;
  if (typeof session === 'string' || session?.length === 1) return null;
  const merged = slice.workSummary?.mergedPrCount ?? null;
  return { merged, costUsd: merged !== null && merged > 0 && costUsd !== null ? costUsd / merged : null };
}

/**
 * "Efficiency": cache hit rate and cost per million tokens beside the token mix they come from.
 * Ratios need their basis; without one the fact is absent rather than a misleading zero.
 */
export function UsageEfficiencyWidget(props: UsageBodyProps) {
  const unknownValue = t('usage.board.plans.cellUnknown');
  // A ratio without its basis is a quiet dash in its figure slot; its caption says why (unknowns stay quiet, never a
  // bold word as the figure). The legend, table and tooltip keep the word, where it reads as a cell, not a figure.
  const unknownFigure = '—';
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const previousCost = useUsageComparisonCost(props.slice, props.query.costBasis, view?.pageCost.selection);
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  const text = usePlanText();
  const pageNothingRecorded = useUsageWidgetPageNothingRecorded();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  // The same exact legend either way; only the picture changes with the room there is.
  const waffle =
    phone ||
    presentation?.footprint.width === 'compact' ||
    (presentation?.geometry?.width ?? Number.POSITIVE_INFINITY) <
      WAFFLE_BELOW_PX;
  const cellStyle = !phone && (presentation?.geometry?.width ?? 0) >= ALL_ACROSS_FROM_PX
    ? styles.cellInRow
    : styles.cell;
  if (!view) {
    // Its ratios beside the mix they come from: the skeleton holds that shape while the read answers.
    if (isUsageReadOutstanding(props.slice, ['accounting'])) return <UsageBodyReading testID={`${props.testID}.loading`} shape={{ kind: 'mix' }} />;
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  }
  const { composition } = view;
  const totalTokens = props.slice.accounting ? resolveUsageMeasuredTokens(props.slice.accounting.totals.tokens).total : null;
  const efficiency = { ...view.efficiency,
    costPerMtokUsd: totalTokens !== null && totalTokens > 0 && view.pageCost.amountUsd !== null
      ? view.pageCost.amountUsd / totalTokens * 1e6 : null,
    currency: view.pageCost.selection?.currency ?? 'USD' };
  const previous = props.slice.comparison?.accounting;
  const previousTokens = previous ? resolveUsageMeasuredTokens(previous.totals.tokens).total : null;
  const previousPerMtok =
    previousTokens !== null && previousTokens > 0 && previousCost !== null
      ? (previousCost /
          previousTokens) *
        1e6
      : null;
  const perMtokComparison = usageComparison(efficiency.costPerMtokUsd, previousPerMtok);
  const costCaption = usagePageCostCaption(view.pageCost);
  const hasRatios =
    efficiency.cacheHitRatePct !== null || efficiency.costPerMtokUsd !== null;
  const perMergedPr = selectEfficiencyPerMergedPr(props, view.pageCost.amountUsd);
  const segments = usageCompositionSegments(composition, (index) =>
    usageSeriesColor(theme, index),
  );
  // Nothing was recorded in the period: the page says so once; this card keeps one quiet line.
  if (!hasRatios && segments.length === 0 && pageNothingRecorded) return <UsageBodyNothingYet testID={props.testID} />;
  if (!hasRatios && segments.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.noBasis`}
        title={t('usage.board.page.efficiencyNoBasisTitle')}
        reason={view.pageCost.amountUsd === null && costCaption ? costCaption : t('usage.board.page.efficiencyNoBasisReason')}
      />
    );
  const cacheCaption = efficiency.cacheHitRatePct === null ? t('common.unavailable')
    : view.cacheSavings?.cacheSavingsUsd != null
      ? t('usage.board.page.cacheListPriceDifference', { amount: formatUsageCost(view.cacheSavings.cacheSavingsUsd, 'USD') })
      : t('usage.board.page.cacheReadTokens', { tokens: formatTokenCount(efficiency.cachedReadTokens) });
  const exactCacheRate = efficiency.cacheHitRatePct === null ? null : formatHappierDataExactShare(efficiency.cacheHitRatePct / 100, getPreferredLanguage());
  const exactCacheBasis = view.cacheSavings?.cacheSavingsUsd != null
    ? `USD ${formatHappierDataValue(view.cacheSavings.cacheSavingsUsd, getPreferredLanguage())}` : `${formatTokenCountLong(efficiency.cachedReadTokens)} ${t('usage.board.page.tokensUnit')}`;
  const cacheFigure = <HappierDataMetric testID={`${props.testID}.cacheHit`} theme={chartTheme} size="stat" showLabel
    label={t('usage.board.page.cacheHit')} value={efficiency.cacheHitRatePct ?? unknownFigure}
    valueFormatter={value => `${Math.round(value)}%`} caption={cacheCaption} />;
  const cacheHidden = exactCacheRate !== null && (`${Math.round(efficiency.cacheHitRatePct!)}%` !== exactCacheRate
    || !cacheCaption.includes(formatHappierDataValue(view.cacheSavings?.cacheSavingsUsd ?? efficiency.cachedReadTokens!, getPreferredLanguage())));
  return (
    <View style={styles.body} testID={`${props.testID}.efficiency`}>
      {/* The figures keep their slots: an unknown is a quiet dash with its reason beneath. A figure with no producer
          (work that kept no change) is not drawn until its fact exists (acceptance follow-up #22). */}
      <View style={styles.grid}>
        <View style={cellStyle}>
          {cacheHidden && exactCacheRate ? <ChartDatum testID={`${props.testID}.cacheHit.detail`}
            datum={{ label: t('usage.board.page.cacheHit'), value: exactCacheRate, subtitle: `${exactCacheBasis} · ${cacheCaption}` }}>{cacheFigure}</ChartDatum> : cacheFigure}
        </View>
        <View style={cellStyle}>
          <HappierDataMetric
            testID={`${props.testID}.perMtok`}
            theme={chartTheme}
            size="stat"
            showLabel
            label={t('usage.board.page.perMillionTokens')}
            value={efficiency.costPerMtokUsd ?? unknownFigure}
            caption={
              efficiency.costPerMtokUsd === null && view.pageCost.amountUsd !== null
                ? t('common.unavailable') : costCaption
            }
            valueFormatter={(value) => formatUsageCost(value, efficiency.currency)}
            {...(perMtokComparison !== null
              ? {
                  comparison: {
                    value: perMtokComparison.value,
                    label: t('usage.board.page.vsBefore'),
                    meaning: perMtokComparison.delta <= 0 ? ('good' as const) : ('bad' as const),
                  },
                }
              : isUsageReadOutstanding(props.slice, ['comparison'])
                ? { comparisonRoom: { value: '▼ 100%', label: t('usage.board.page.vsBefore') } }
                : {})}
          />
        </View>
        {perMergedPr && <View style={cellStyle}>
          <HappierDataMetric
            testID={`${props.testID}.perMergedPr`}
            theme={chartTheme}
            size="stat"
            showLabel
            label={t('usage.board.page.perMergedPr')}
            value={perMergedPr.costUsd ?? unknownFigure}
            valueFormatter={(value) => formatUsageCost(value, efficiency.currency)}
            caption={
              perMergedPr.merged === null
                ? t('usage.board.page.notMeasuredYet')
                : perMergedPr.merged === 0
                  ? t('usage.board.page.noneLinkedByEvidence')
                  : t('usage.board.page.linkedByEvidence')
            }
          />
        </View>}
      </View>
      {segments.length > 0 ? (
        <View style={styles.mixSlot}>
        <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <CompositionStrip
          theme={chartTheme}
          label={t('usage.context.tokenMixTitle')}
          total={composition.total}
          segments={segments}
          basis={t('usage.tokens')}
          size={waffle ? 'tile' : 'full'}
          // Beside the waffle (a phone, a narrow frame) the legend is the strip's key: one entry a row, its share in one
          // right-aligned column. Two columns of name, share and amount broke "Cache read" into fragments on a phone
          // (native N1); the exact amounts stay one press away in Exact values.
          {...(waffle ? { appearance: MIX_KEY_LEGEND } : {})}
          variant={waffle ? 'waffle' : 'strip'}
          minimumVisibleFraction={0.005}
          minimumFillWidth={2}
          segmentGap={2}
          valueFormatter={formatTokenCount}
          shareFormatter={usageCompositionShareLabel}
          unknownLabel={unknownValue}
          testID={`${props.testID}.mix`}
          renderBarSegment={(segment, visual, share) => (
            <ChartTooltip
              keyboard={false}
              triggerTestID="usage-efficiency-mix-trigger"
              title={segment.label}
              subtitle={
                share === null ? undefined : usageCompositionShareLabel(share)
              }
              value={
                segment.value === null
                  ? unknownValue
                  : formatTokenCountLong(segment.value)
              }
              accentColor={segment.color ?? chartTheme.colors.accent}
              triggerStyle={MIX_SEGMENT_TRIGGER_STYLE}
            >
              {visual}
            </ChartTooltip>
          )}
        />
        </View>
        <UsageChartValues theme={chartTheme} testID={`${props.testID}.mix`}
          label={`${t('usage.context.tokenMixTitle')} · ${composition.total === null ? unknownValue : formatTokenCountLong(composition.total)} ${t('usage.board.page.tokensUnit')}`}
          labels={usageChartValuesLabels()} table={{
            columns: [{ label: t('usage.context.tokenMixTitle') }, { label: t('usage.tokens') }, { label: '%' }],
            rows: composition.segments.map(segment => [t(`usage.tokenMix.${segment.key}`), segment.tokens === null ? unknownValue : formatTokenCountLong(segment.tokens),
              composition.total !== null && composition.total > 0 && segment.tokens !== null
                ? formatHappierDataExactShare(segment.tokens / composition.total, getPreferredLanguage()) : unknownValue]),
          }} />
        </View>
      ) : (
        // The mix keeps its slot when the sources report no token split: an empty track with the reason beneath it.
        <View style={styles.mixSlot} testID={`${props.testID}.mixUnavailable`}>
          <View style={[styles.mixTrack, { backgroundColor: theme.colors.surface.inset }]} />
          <Text style={[styles.mixCaption, text.detail]}>
            {`${t('usage.context.tokenMixTitle')} · ${t('common.unavailable')}`}
          </Text>
        </View>
      )}
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
  body: { gap: 18 },
  mixSlot: { gap: theme.space.s8 },
  mixTrack: { height: 14, borderRadius: 5 },
  mixCaption: { ...Typography.default(), color: theme.colors.text.tertiary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 16 },
  // Two figures a row whenever the card can hold two; a narrower one stacks them.
  cell: { flexGrow: 1, flexBasis: '40%', minWidth: 120 },
  cellInRow: { flexGrow: 1, flexBasis: '20%', minWidth: 120 },
}));
