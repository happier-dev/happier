import type {
  ConnectedServiceQuotaMeterV1,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  normalizeQuotaMeter,
  selectEffectiveQuotaMeter,
  type NormalizedQuotaMeter,
  type ProviderLimitCategory,
} from '../../quotas/normalization';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readLimitCategory(value: unknown): ProviderLimitCategory {
  return readConnectedServiceLimitCategoryV1(value) ?? 'usage_limit';
}

function isReliableMeter(meter: ConnectedServiceQuotaMeterV1): boolean | undefined {
  if (meter.status === 'unavailable') return false;
  if (meter.confidence === 'stale' || meter.confidence === 'unknown' || meter.confidence === 'estimated') return false;
  if (meter.status === 'estimated') return false;
  return undefined;
}

export function normalizeConnectedServiceAuthGroupQuotaMeter(
  meter: ConnectedServiceQuotaMeterV1,
): NormalizedQuotaMeter {
  const details = isRecord(meter.details) ? meter.details : {};
  return normalizeQuotaMeter({
    meterId: meter.meterId,
    label: meter.label,
    limitCategory: readLimitCategory(details.limitCategory),
    remainingPct: meter.remainingPct,
    utilizationPct: meter.utilizationPct,
    used: meter.used,
    limit: meter.limit,
    resetAtMs: meter.resetAtMs ?? meter.resetsAt,
    providerLimitId: readString(meter.providerLimitId) ?? readString(details.providerLimitId),
    reliable: isReliableMeter(meter),
    applicable: meter.status !== 'unavailable',
  });
}

function readProviderResetsAtMs(snapshot: Readonly<{ meters: readonly ConnectedServiceQuotaMeterV1[] }>): number | null {
  const resetValues = snapshot.meters
    .map((meter) => meter.resetAtMs ?? meter.resetsAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return resetValues.length > 0 ? Math.min(...resetValues) : null;
}

function isExhausted(meters: ReadonlyArray<NormalizedQuotaMeter>): boolean {
  const effective = selectEffectiveQuotaMeter(meters);
  if (effective?.remainingPct !== null && effective?.remainingPct !== undefined) {
    return effective.remainingPct <= 0;
  }
  return false;
}

export function projectProviderAccountUsageSnapshotToAuthGroupRuntimeState(
  snapshot: ProviderAccountUsageSnapshotV1,
): ConnectedServiceAuthGroupMemberRuntimeState | null {
  if (snapshot.state !== 'loaded_data' || snapshot.meters.length === 0) return null;
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAtMs,
    meters: snapshot.meters,
  });
}

export function buildConnectedServiceAuthGroupRuntimeStateFromMeters(input: Readonly<{
  capturedAtMs: number;
  meters: readonly ConnectedServiceQuotaMeterV1[];
}>): ConnectedServiceAuthGroupMemberRuntimeState {
  const normalizedMeters = input.meters.map(normalizeConnectedServiceAuthGroupQuotaMeter);
  const effectiveMeter = selectEffectiveQuotaMeter(normalizedMeters);
  return {
    providerResetsAtMs: effectiveMeter?.resetAtMs ?? readProviderResetsAtMs(input),
    quotaSnapshot: {
      capturedAtMs: input.capturedAtMs,
      effectiveMeterId: effectiveMeter?.meterId ?? null,
      effectiveRemainingPercent: effectiveMeter?.remainingPct ?? null,
      meters: normalizedMeters.map((meter) => ({
        meterId: meter.meterId,
        limitCategory: meter.limitCategory,
        remainingPct: meter.remainingPct,
        resetAtMs: meter.resetAtMs,
        providerLimitId: meter.providerLimitId,
      })),
      exhausted: isExhausted(normalizedMeters),
      planUnavailable: input.meters.length > 0 && input.meters.every((meter) => meter.status === 'unavailable'),
    },
  };
}
