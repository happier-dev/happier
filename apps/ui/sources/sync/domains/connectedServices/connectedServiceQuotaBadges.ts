import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { clampQuotaPct, deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';

export function computeConnectedServiceQuotaSummaryBadges(params: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1 | null;
  pinnedMeterIds: ReadonlyArray<string>;
  strategy?: 'primary' | 'min_remaining';
}>): Array<{ meterId: string; text: string }> {
  if (!params.pinnedMeterIds || params.pinnedMeterIds.length === 0) return [];

  const meters = params.snapshot?.meters ?? [];

  const badgesWithMeta = params.pinnedMeterIds.map((meterId, index) => {
    const meter = meters.find((m) => m.meterId === meterId) ?? null;
    const label = meter?.label ?? meterId;
    const utilizationPct = meter ? deriveQuotaUtilizationPct(meter) : null;
    const remainingPct = utilizationPct === null ? null : clampQuotaPct(100 - utilizationPct);
    const text = remainingPct === null ? `${label} —` : `${label} ${Math.round(remainingPct)}%`;
    return { meterId, text, remainingPct, index };
  });

  const strategy = params.strategy ?? 'primary';
  if (strategy === 'min_remaining') {
    return badgesWithMeta
      .slice()
      .sort((a, b) => {
        const aScore = a.remainingPct === null ? Number.POSITIVE_INFINITY : a.remainingPct;
        const bScore = b.remainingPct === null ? Number.POSITIVE_INFINITY : b.remainingPct;
        if (aScore !== bScore) return aScore - bScore;
        return a.index - b.index;
      })
      .map(({ meterId, text }) => ({ meterId, text }));
  }

  return badgesWithMeta.map(({ meterId, text }) => ({ meterId, text }));
}
