import type {
  ConnectedServiceAuthGroupQuotaLimitSelectionV1,
  ConnectedServiceQuotaMeterV1,
  ProviderAccountUsageSnapshotV1,
  ProviderAccountSubscriptionV1,
} from '@happier-dev/protocol';
import {
  hasConnectedServiceQuotaCreditHeadroom,
  isConnectedServiceQuotaCreditMeter,
  readConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol';

import {
  normalizeQuotaMeter,
  selectEffectiveQuotaMeter,
  type NormalizedQuotaMeter,
  type ProviderLimitCategory,
} from '../../quotas/normalization';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { selectConnectedServiceAuthGroupQuotaMeters } from './quotaLimitSelection';
import { isConnectedServiceAuthGroupQuotaSnapshotExhausted } from './quotaUsability';

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

export function projectProviderAccountUsageSnapshotToAuthGroupRuntimeState(
  snapshot: ProviderAccountUsageSnapshotV1,
  selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1,
): ConnectedServiceAuthGroupMemberRuntimeState | null {
  if (snapshot.state !== 'loaded_data' || snapshot.meters.length === 0) return null;
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAtMs,
    meters: snapshot.meters,
    subscription: snapshot.subscription,
    selection,
  });
}

export function buildConnectedServiceAuthGroupRuntimeStateFromMeters(input: Readonly<{
  capturedAtMs: number;
  meters: readonly ConnectedServiceQuotaMeterV1[];
  subscription?: ProviderAccountSubscriptionV1;
  selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1;
}>): ConnectedServiceAuthGroupMemberRuntimeState {
  const selectedMeters = selectConnectedServiceAuthGroupQuotaMeters(input.meters, input.selection);
  // Credits are not an allowance: they never set the effective meter or its reset, and only
  // decide whether a spent account still serves work.
  const creditMeters = selectedMeters.filter(isConnectedServiceQuotaCreditMeter);
  const allowanceMeters = selectedMeters.filter((meter) => !isConnectedServiceQuotaCreditMeter(meter));
  const normalizedMeters = allowanceMeters.map(normalizeConnectedServiceAuthGroupQuotaMeter);
  const effectiveMeter = selectEffectiveQuotaMeter(normalizedMeters);
  const quotaSnapshot = {
    capturedAtMs: input.capturedAtMs,
    effectiveMeterId: effectiveMeter?.meterId ?? null,
    effectiveRemainingPercent: effectiveMeter?.remainingPct ?? null,
    meters: normalizedMeters.map((meter, index) => ({
      meterId: meter.meterId,
      limitCategory: meter.limitCategory,
      remainingPct: meter.remainingPct,
      resetAtMs: meter.resetAtMs,
      providerLimitId: meter.providerLimitId,
      windowDurationMs: allowanceMeters[index]?.windowDurationMs ?? null,
      reliable: meter.reliable && meter.applicable,
    })),
    ...(creditMeters.length > 0 ? { creditsAvailable: creditMeters.some(hasConnectedServiceQuotaCreditHeadroom) } : {}),
  };
  return {
    ...(input.subscription ? { subscription: input.subscription } : {}),
    providerResetsAtMs: effectiveMeter?.resetAtMs ?? readProviderResetsAtMs({ meters: allowanceMeters }),
    quotaSnapshot: {
      ...quotaSnapshot,
      ...(selectedMeters.length > 0 ? {
        exhausted: isConnectedServiceAuthGroupQuotaSnapshotExhausted(quotaSnapshot),
        planUnavailable: (allowanceMeters.length > 0 ? allowanceMeters : selectedMeters)
          .every((meter) => meter.status === 'unavailable'),
      } : {}),
    },
  };
}
