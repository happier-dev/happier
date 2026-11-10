import { resolveUsageCostBasisForSelection, resolveUsageCostForSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsagePageCostProjection, type UsagePageCostSelection} from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsageObservationCost } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
import { t } from '@/text';

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
  return (projection.accounting.series ?? []).map(bucket => ({ timestamp: bucket.bucketStartMs / 1000,
    tokens: bucket.tokens.total, reportCount: bucket.eventCount,
    cost: resolveUsageCostForSelection(bucket.cost, projection.selection),
  }));
}

export { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
