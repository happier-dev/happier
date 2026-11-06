import { resolveUsageCostBasisForSelection, resolveUsageCostForSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsagePageCostProjection, type UsagePageCostSelection} from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsageObservationCost } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
import { t } from '@/text';

/** A row names its actual reported/priced/estimated basis, including a labelled mixed aggregate. */
export function usagePageCostRow(cost: UsageObservationCost, selection: UsagePageCostSelection | null) {
  const basis = resolveUsageCostBasisForSelection(cost, selection);
  return basis ? { ...basis, label: usageCostKindPhrase(basis.kind) }
    : selection ? { label: t('usage.board.page.costUnpricedCaption') } : null;
}

/** Chart coordinates of the same selected page facts; unavailable money stays unavailable. */
export function usagePageCostTrend(projection: UsagePageCostProjection) {
  return (projection.accounting.series ?? []).map(bucket => ({ timestamp: bucket.bucketStartMs / 1000,
    tokens: bucket.tokens.total, reportCount: bucket.eventCount,
    cost: resolveUsageCostForSelection(bucket.cost, projection.selection),
  }));
}

export { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
