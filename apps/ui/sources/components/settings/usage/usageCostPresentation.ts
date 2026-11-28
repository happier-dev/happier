import { projectUsageCostBucket, resolveUsageCostForSelection, type UsagePageCostProjection } from '@happier-dev/protocol/usage/usageCostFacts';
import { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
import { t } from '@/text';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageAnalytics';

/** Name the actual money or the cost owner's reason the selected basis is incomplete. */
export function usageCostBucketLabel(reading: ReturnType<typeof projectUsageCostBucket>): string | undefined {
  switch (reading.unavailableReason) {
    case 'unpriced': return t('usage.board.page.factUnpriced');
    case 'part_unpriced': return t('usage.board.page.costRowPartUnpriced');
    case 'basis_unavailable': return t('usage.board.page.costBasisUnavailable');
    case null: return reading.basis ? usageCostKindPhrase(reading.basis.kind) : undefined;
  }
}

/** Chart coordinates of the same selected page facts; unavailable money stays unavailable. */
export function usagePageCostTrend(projection: UsagePageCostProjection, collectBucketFacts = false) {
  return (projection.accounting.series ?? []).map(bucket => {
    const reading = collectBucketFacts ? projectUsageCostBucket(bucket.cost, projection.selection) : null;
    return { timestamp: bucket.bucketStartMs / 1000,
      tokens: resolveUsageMeasuredTokens(bucket.tokens).total, reportCount: bucket.eventCount,
      cost: reading ? reading.amountUsd : resolveUsageCostForSelection(bucket.cost, projection.selection),
      partialCost: reading?.partial, costUnavailableReason: reading?.unavailableReason };
  });
}

export function usageHasRecordedUnpricedCost(eventCount: number, reason: UsagePageCostProjection['unavailableReason'] | undefined): boolean {
  return eventCount > 0 && (reason === 'unpriced' || reason === 'part_unpriced');
}

/** The selected money basis or the cost owner's reason it could not supply a total. */
export function usagePageCostCaption(projection: UsagePageCostProjection): string | undefined {
  switch (projection.unavailableReason) {
    case 'unpriced': return t('usage.board.page.factUnpriced');
    case 'part_unpriced': return t('usage.board.page.costUnpricedCaption');
    case 'basis_unavailable': return t('usage.board.page.costBasisUnavailable');
    case null: return projection.selection ? usageCostKindPhrase(projection.selection.kind) : undefined;
  }
}

/**
 * The one note a widget carries when its token totals are added up from their reported parts: said once under the
 * widget's figures, never after each row (USAGE-ACCEPT 1118 #11, 1121 #13). `fromParts` holds one flag per counted
 * total the widget shows; a row's exact reading may still name its own.
 */
export function usageTokensFromPartsNote(fromParts: readonly (boolean | undefined)[]): string | null {
  if (!fromParts.some(Boolean)) return null;
  return fromParts.every(Boolean) ? t('usage.board.page.tokensFromPartsOnce') : t('usage.board.page.tokensFromPartsSome');
}

export { usageCostKindPhrase } from '@/sync/domains/usage/resolveUsageCostModeLabel';
