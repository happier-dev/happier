import type {
  ConnectedServiceQuotaMeterV1,
} from '@happier-dev/protocol';

import { clampQuotaPct, deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';
import { selectComparableConnectedServiceQuotaMeters } from './connectedServiceQuotaGauge';

export type ConnectedServiceQuotaSelectedMeter = Readonly<{
  meterId: string;
  label: string;
  utilizationPct: number | null;
  remainingPct: number | null;
  /** The snapshot meter behind the selection; null when a pinned meter is absent. */
  meter: ConnectedServiceQuotaMeterV1 | null;
}>;

export type ConnectedServiceQuotaSummaryStrategy = 'primary' | 'min_remaining';

/** Both released V2/V3 and exact V4 quota snapshots carry this display fact. */
export type ConnectedServiceQuotaSnapshotForBadge = Readonly<{
  meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>;
}>;

/**
 * The one meter selection + remaining-% projection behind pinned badges and the
 * usage summary.
 *
 * Remaining comes from the meter's own `remainingPct` when the provider reports
 * one, and only otherwise from utilization. `min_remaining` ranks within the
 * comparable-meter family so an unrelated rate limit cannot become the headline
 * number; ties keep the requested order.
 */
export function selectConnectedServiceQuotaSummaryMeters(params: Readonly<{
  meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>;
  meterIds: ReadonlyArray<string>;
  strategy?: ConnectedServiceQuotaSummaryStrategy;
}>): ConnectedServiceQuotaSelectedMeter[] {
  const strategy = params.strategy ?? 'primary';
  const comparableMeterIds = strategy === 'min_remaining'
    ? new Set(selectComparableConnectedServiceQuotaMeters(params.meters).map((meter) => meter.meterId))
    : null;
  const selectedMeterIds = comparableMeterIds
    ? params.meterIds.filter((meterId) => comparableMeterIds.has(meterId))
    : params.meterIds;

  const selected = selectedMeterIds.map((meterId, index) => {
    const meter = params.meters.find((candidate) => candidate.meterId === meterId) ?? null;
    const utilizationPct = meter ? deriveQuotaUtilizationPct(meter) : null;
    const remainingPct = typeof meter?.remainingPct === 'number' && Number.isFinite(meter.remainingPct)
      ? clampQuotaPct(meter.remainingPct)
      : utilizationPct === null ? null : clampQuotaPct(100 - utilizationPct);
    return {
      selection: {
        meterId,
        label: meter?.label ?? meterId,
        utilizationPct,
        remainingPct,
        meter,
      } satisfies ConnectedServiceQuotaSelectedMeter,
      index,
    };
  });

  if (strategy === 'min_remaining') {
    selected.sort((left, right) => {
      const leftScore = left.selection.remainingPct ?? Number.POSITIVE_INFINITY;
      const rightScore = right.selection.remainingPct ?? Number.POSITIVE_INFINITY;
      if (leftScore !== rightScore) return leftScore - rightScore;
      return left.index - right.index;
    });
  }

  return selected.map(({ selection }) => selection);
}

export function computeConnectedServiceQuotaSummaryBadges(params: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotForBadge | null;
  pinnedMeterIds: ReadonlyArray<string>;
  strategy?: ConnectedServiceQuotaSummaryStrategy;
}>): Array<{ meterId: string; text: string }> {
  if (!params.pinnedMeterIds || params.pinnedMeterIds.length === 0) return [];

  return selectConnectedServiceQuotaSummaryMeters({
    meters: params.snapshot?.meters ?? [],
    meterIds: params.pinnedMeterIds,
    ...(params.strategy ? { strategy: params.strategy } : {}),
  }).map(({ meterId, label, remainingPct }) => ({
    meterId,
    text: remainingPct === null ? '—' : `${label} ${Math.round(remainingPct)}%`,
  }));
}
