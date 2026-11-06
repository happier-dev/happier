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
import { usageCostKindPhrase } from '../usageCostPresentation';
import { usageComparison } from '../usageComparisonPresentation';
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
} from './usageBodyKit';

/** Below this width the mix is the dot waffle (lab `kitcharts`: "waffle on tile and phone"). */
const WAFFLE_BELOW_PX = 360;
/** From this width the four figures share one row (a full-width band); narrower, they pair up two a row. */
const FOUR_ACROSS_FROM_PX = 720;

/**
 * "Efficiency": cache hit rate and cost per million tokens beside the token mix they come from.
 * Ratios need their basis; without one the fact is absent rather than a misleading zero.
 */
export function UsageEfficiencyWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const previousCost = useUsageComparisonCost(props.slice, props.query.costBasis, view?.pageCost.selection);
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  const text = usePlanText();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  // The same exact legend either way; only the picture changes with the room there is.
  const waffle =
    phone ||
    presentation?.footprint.width === 'compact' ||
    (presentation?.geometry?.width ?? Number.POSITIVE_INFINITY) <
      WAFFLE_BELOW_PX;
  const cellStyle = !phone && (presentation?.geometry?.width ?? 0) >= FOUR_ACROSS_FROM_PX
    ? styles.cellInRow
    : styles.cell;
  if (!view) {
    // Its ratios beside the mix they come from: the skeleton holds that shape while the read answers.
    if (isUsageReadOutstanding(props.slice, ['accounting'])) return <UsageBodyReading testID={`${props.testID}.loading`} shape={{ kind: 'mix' }} />;
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  }
  const { composition } = view;
  const totalTokens = props.slice.accounting?.totals.tokens.total ?? 0;
  const efficiency = { ...view.efficiency,
    costPerMtokUsd: totalTokens > 0 && view.pageCost.amountUsd !== null
      ? view.pageCost.amountUsd / totalTokens * 1e6 : null,
    currency: view.pageCost.selection?.currency ?? 'USD' };
  const previous = props.slice.comparison?.accounting;
  const previousPerMtok =
    previous && previous.totals.tokens.total > 0 && previousCost !== null
      ? (previousCost /
          previous.totals.tokens.total) *
        1e6
      : null;
  const perMtokComparison = usageComparison(efficiency.costPerMtokUsd, previousPerMtok);
  // A candidate basis whose amount is unavailable: some usage has neither a reported cost nor a model price.
  const unpriced = view.pageCost.selection != null && view.pageCost.amountUsd === null;
  const hasRatios =
    efficiency.cacheHitRatePct !== null || efficiency.costPerMtokUsd !== null;
  // Work evidence is not part of this widget's own read: the figure names a merged PR only when the slice carries it.
  const merged = props.slice.work?.outcomes.filter((outcome) => outcome.pullRequest.state === 'merged') ?? null;
  const perMergedPrUsd = merged && merged.length > 0 && view.pageCost.amountUsd !== null
    ? view.pageCost.amountUsd / merged.length : null;
  const segments = usageCompositionSegments(composition, (index) =>
    usageSeriesColor(theme, index),
  );
  if (!hasRatios && segments.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.noBasis`}
        title={t('usage.board.page.efficiencyNoBasisTitle')}
        reason={t(unpriced ? 'usage.board.page.efficiencyUnpricedReason' : 'usage.board.page.efficiencyNoBasisReason')}
      />
    );
  const cacheCaption = efficiency.cacheHitRatePct === null ? t('common.unavailable')
    : view.cacheSavings?.cacheSavingsUsd != null
      ? t('usage.board.page.cacheListPriceDifference', { amount: formatUsageCost(view.cacheSavings.cacheSavingsUsd, 'USD') })
      : t('usage.board.page.cacheReadTokens', { tokens: formatTokenCount(efficiency.cachedReadTokens) });
  const exactCacheRate = efficiency.cacheHitRatePct === null ? null : formatHappierDataExactShare(efficiency.cacheHitRatePct / 100, getPreferredLanguage());
  const exactCacheBasis = view.cacheSavings?.cacheSavingsUsd != null
    ? `USD ${formatHappierDataValue(view.cacheSavings.cacheSavingsUsd, getPreferredLanguage())}` : `${formatHappierDataValue(efficiency.cachedReadTokens, getPreferredLanguage())} ${t('usage.board.page.tokensUnit')}`;
  const cacheFigure = <HappierDataMetric testID={`${props.testID}.cacheHit`} theme={chartTheme} size="stat" showLabel
    label={t('usage.board.page.cacheHit')} value={efficiency.cacheHitRatePct ?? UNKNOWN_VALUE}
    valueFormatter={value => `${Math.round(value)}%`} caption={cacheCaption} />;
  const cacheHidden = exactCacheRate !== null && (`${Math.round(efficiency.cacheHitRatePct!)}%` !== exactCacheRate
    || !cacheCaption.includes(formatHappierDataValue(view.cacheSavings?.cacheSavingsUsd ?? efficiency.cachedReadTokens, getPreferredLanguage())));
  return (
    <View style={styles.body} testID={`${props.testID}.efficiency`}>
      {/* The lab's four figures keep their slots: an unknown is a quiet dash with its reason beneath. */}
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
            value={efficiency.costPerMtokUsd ?? UNKNOWN_VALUE}
            caption={
              efficiency.costPerMtokUsd === null
                ? unpriced
                  ? t('usage.board.page.costUnpricedCaption')
                  : t('common.unavailable')
                : view.pageCost.selection
                  ? usageCostKindPhrase(view.pageCost.selection.kind)
                  : undefined
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
        <View style={cellStyle}>
          <HappierDataMetric
            testID={`${props.testID}.perMergedPr`}
            theme={chartTheme}
            size="stat"
            showLabel
            label={t('usage.board.page.perMergedPr')}
            value={perMergedPrUsd ?? UNKNOWN_VALUE}
            valueFormatter={(value) => formatUsageCost(value, efficiency.currency)}
            caption={
              !merged
                ? t('usage.board.page.notMeasuredYet')
                : merged.length === 0
                  ? t('usage.board.page.noneLinkedByEvidence')
                  : t('usage.board.page.linkedByEvidence')
            }
          />
        </View>
        <View style={cellStyle}>
          <HappierDataMetric
            testID={`${props.testID}.noKeptChange`}
            theme={chartTheme}
            size="stat"
            showLabel
            label={t('usage.board.page.noKeptChange')}
            value={UNKNOWN_VALUE}
            caption={t('usage.board.page.notMeasuredYet')}
          />
        </View>
      </View>
      {segments.length > 0 ? (
        <CompositionStrip
          theme={chartTheme}
          label={t('usage.context.tokenMixTitle')}
          total={composition.total}
          segments={segments}
          basis={t('usage.tokens')}
          size={waffle ? 'tile' : 'full'}
          variant={waffle ? 'waffle' : 'strip'}
          minimumVisibleFraction={0.005}
          minimumFillWidth={2}
          segmentGap={2}
          valueFormatter={formatTokenCount}
          shareFormatter={usageCompositionShareLabel}
          unknownLabel="—"
          testID={`${props.testID}.mix`}
          renderBarSegment={(segment, visual, share) => (
            <ChartTooltip
              triggerTestID="usage-efficiency-mix-trigger"
              title={segment.label}
              subtitle={
                share === null ? undefined : usageCompositionShareLabel(share)
              }
              value={
                segment.value === null
                  ? '—'
                  : formatTokenCountLong(segment.value)
              }
              accentColor={segment.color ?? chartTheme.colors.accent}
            >
              {visual}
            </ChartTooltip>
          )}
        />
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

const UNKNOWN_VALUE = '—';

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
