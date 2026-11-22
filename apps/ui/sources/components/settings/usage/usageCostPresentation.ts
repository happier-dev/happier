import { resolveUsageCostBasisForSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsagePageCostProjection, type UsagePageCostSelection} from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsageObservationCost } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
import { t } from '@/text';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageAnalytics';

/**
 * A row names its actual reported/priced/estimated basis, including a labelled mixed aggregate. A row whose total
 * is unavailable says why in the Daily legend's and Cost facts' words ("Without an API price"), so the row, the
 * hatched day and the missing total read as one (R138). A row that still carries some known money says only part
 * of it has no price (R139).
 */
export function usagePageCostRow(cost: UsageObservationCost, selection: UsagePageCostSelection | null) {
  const basis = resolveUsageCostBasisForSelection(cost, selection);
  if (basis) return { ...basis, label: usageCostKindPhrase(basis.kind) };
  if (!selection) return null;
  const partlyPriced = cost.reportedUsd !== null && cost.reportedUsd > 0 || cost.estimatedUsd !== null && cost.estimatedUsd > 0
    || cost.apiEquivalentUsd != null && cost.apiEquivalentUsd > 0 || cost.invoiceUsd != null && cost.invoiceUsd > 0;
  return { label: t(partlyPriced ? 'usage.board.page.costRowPartUnpriced' : 'usage.board.page.factUnpriced') };
}

/** Chart coordinates of the same selected page facts; unavailable money stays unavailable. */
export function usagePageCostTrend(projection: UsagePageCostProjection) {
  return (projection.accounting.series ?? []).map(bucket => {
    const basis = resolveUsageCostBasisForSelection(bucket.cost, projection.selection);
    return { timestamp: bucket.bucketStartMs / 1000,
      tokens: resolveUsageMeasuredTokens(bucket.tokens).total, reportCount: bucket.eventCount,
      cost: basis?.amountUsd ?? null, partialCost: basis?.partial === true,
      recordedUnpriced: bucket.eventCount > 0 && (basis?.amountUsd == null || basis?.partial === true) };
  });
}

/**
 * The page cost's caption, said the same way wherever the one page total shows (Period summary, Cost facts).
 * `amountUsd` is authoritative: a candidate basis with an unavailable amount means some usage has neither a
 * reported cost nor a model price. An amount with no basis is an empty population's measured zero: it names no kind.
 */
export function usagePageCostCaption(projection: Pick<UsagePageCostProjection, 'amountUsd' | 'selection'>): string | undefined {
  if (projection.amountUsd !== null) return projection.selection ? usageCostKindPhrase(projection.selection.kind) : undefined;
  return projection.selection ? t('usage.board.page.costUnpricedCaption') : t('common.unavailable');
}

/**
 * The one note a widget carries when its token totals are added up from their reported parts: said once under the
 * widget's figures, never after each row (USAGE-ACCEPT 1118 #11, 1121 #13). `fromParts` holds one flag per counted
 * total the widget shows; a row's exact reading may still name its own.
 */
export function usageTokensFromPartsNote(fromParts: readonly boolean[]): string | null {
  if (!fromParts.some(Boolean)) return null;
  return fromParts.every(Boolean) ? t('usage.board.page.tokensFromPartsOnce') : t('usage.board.page.tokensFromPartsSome');
}

export { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
