import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { clampQuotaPct, deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';

export function computeConnectedServiceQuotaSummaryBadges(params: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1 | null;
  pinnedMeterIds: ReadonlyArray<string>;
}>): Array<{ meterId: string; text: string }> {
  if (!params.pinnedMeterIds || params.pinnedMeterIds.length === 0) return [];

  const meters = params.snapshot?.meters ?? [];

  return params.pinnedMeterIds.map((meterId) => {
    const meter = meters.find((m) => m.meterId === meterId) ?? null;
    const label = meter?.label ?? meterId;
    const utilizationPct = meter ? deriveQuotaUtilizationPct(meter) : null;
    const remainingPct = utilizationPct === null ? null : clampQuotaPct(100 - utilizationPct);
    const text = remainingPct === null ? `${label} —` : `${label} ${Math.round(remainingPct)}%`;
    return { meterId, text };
  });
}
