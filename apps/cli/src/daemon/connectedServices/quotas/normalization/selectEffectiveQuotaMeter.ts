import type { NormalizedQuotaMeter } from './normalizeQuotaMeter';

export type EffectiveQuotaMeter = NormalizedQuotaMeter & Readonly<{
  effectiveStrategy: 'most_constrained';
}>;

function participatesInPercentageRanking(meter: NormalizedQuotaMeter): boolean {
  return (meter.limitCategory === 'usage_limit' || meter.limitCategory === 'rate_limit')
    && meter.reliable
    && meter.applicable
    && meter.remainingPct !== null;
}

export function selectEffectiveQuotaMeter(
  meters: ReadonlyArray<NormalizedQuotaMeter>,
): EffectiveQuotaMeter | null {
  const ranked = meters
    .filter(participatesInPercentageRanking)
    .slice()
    .sort((left, right) => {
      const remainingDelta = (left.remainingPct ?? 100) - (right.remainingPct ?? 100);
      if (remainingDelta !== 0) return remainingDelta;
      return left.meterId.localeCompare(right.meterId);
    });
  const selected = ranked[0] ?? null;
  return selected ? { ...selected, effectiveStrategy: 'most_constrained' } : null;
}
