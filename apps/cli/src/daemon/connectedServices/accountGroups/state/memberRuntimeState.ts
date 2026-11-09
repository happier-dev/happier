import { clearConnectedServiceAuthGroupMemberRuntimeBlockers } from '@happier-dev/protocol/connect/connectedServiceAuthGroupMemberRuntimeStatePolicy';
import { compareConnectedServiceQuotaObservationRecency, isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from '../quotas/projection';
import type {
  ConnectedServiceAuthGroupMemberRuntimeState,
  ConnectedServiceAuthGroupPolicyV2,
  ConnectedServiceAuthGroupQuotaMeterSnapshot,
  ConnectedServiceAuthGroupQuotaSnapshot,
} from '../selection/selectConnectedServiceAuthGroupCandidate';

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function meterHasRemainingQuota(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  const remaining = numberOrNull(meter.remainingPct);
  return remaining !== null && remaining > 0;
}

function isQuotaMeter(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  return meter.limitCategory === 'usage_limit';
}

function isRateLimitMeter(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  return meter.limitCategory === 'rate_limit';
}

function snapshotProvesQuotaUsable(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  requireExplicitUsageMeter: boolean,
): boolean {
  if (snapshot.exhausted || snapshot.planUnavailable) return false;
  const quotaMeters = (snapshot.meters ?? []).filter(isQuotaMeter);
  if (quotaMeters.length > 0) return quotaMeters.every(meterHasRemainingQuota);
  if (requireExplicitUsageMeter) return false;
  const remaining = numberOrNull(snapshot.effectiveRemainingPercent);
  return remaining !== null && remaining > 0;
}

function snapshotProvesRateLimitUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  const rateLimitMeters = (snapshot.meters ?? []).filter(isRateLimitMeter);
  return rateLimitMeters.length > 0 && rateLimitMeters.every(meterHasRemainingQuota);
}

function snapshotProvesRuntimeUsable(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
): boolean {
  if (snapshot.exhausted || snapshot.planUnavailable) return false;
  const quotaMeters = (snapshot.meters ?? []).filter(isQuotaMeter);
  if (
    quotaMeters.length > 0
    && !quotaMeters.every(meterHasRemainingQuota)
  ) {
    return false;
  }
  const rateLimitMeters =
    (snapshot.meters ?? []).filter(isRateLimitMeter);
  if (
    rateLimitMeters.length > 0
    && !rateLimitMeters.every(meterHasRemainingQuota)
  ) {
    return false;
  }
  if (
    quotaMeters.length > 0
    || rateLimitMeters.length > 0
  ) {
    return true;
  }
  const remaining =
    numberOrNull(snapshot.effectiveRemainingPercent);
  return remaining !== null && remaining > 0;
}

function isSnapshotNewerThanFailure(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
  nowMs: number,
): boolean {
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  return lastObservedAtMs === null || compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: lastObservedAtMs,
    incomingObservedAtMs: snapshot.capturedAtMs,
    nowMs,
  }) === 'incoming_newer';
}

export function projectConnectedServiceQuotaSnapshotToAuthGroupQuotaEvidence(
  snapshot: ConnectedServiceQuotaSnapshotV1,
): ConnectedServiceAuthGroupQuotaSnapshot {
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAt,
    staleAfterMs: snapshot.staleAfterMs,
    meters: snapshot.meters,
  }).quotaSnapshot!;
}

export function reconcileMemberRuntimeStateWithFreshQuotaEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot | null;
  policy: ConnectedServiceAuthGroupPolicyV2;
  nowMs: number;
  authenticatedProbe?: boolean;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  const state = params.state;
  const quotaSnapshot = params.quotaSnapshot;
  if (!state || !quotaSnapshot || !isSnapshotNewerThanFailure(quotaSnapshot, state, params.nowMs)) return state;
  if (!isConnectedServiceQuotaObservationFresh({ observedAtMs: quotaSnapshot.capturedAtMs,
    nowMs: params.nowMs, maxAgeMs: quotaSnapshot.staleAfterMs })) return state;
  if (quotaSnapshot.planUnavailable) return state;
  const lastObservedAtMs = numberOrNull(state.lastObservedAtMs);
  // The observation itself must follow the existing cooldown; consuming an early probe later
  // cannot turn potentially lagging provider quota into evidence that the failure recovered.
  if (state.lastFailureKind === 'usage_limit' && lastObservedAtMs !== null
    && lastObservedAtMs <= params.nowMs
    && quotaSnapshot.capturedAtMs < lastObservedAtMs + params.policy.cooldownMs) return state;
  const failureLimitId = state.lastFailureProviderLimitId?.trim();
  const matchingQuotaMeters = (quotaSnapshot.meters ?? []).filter(meter => isQuotaMeter(meter)
    && (!failureLimitId || meter.providerLimitId === failureLimitId));
  const quotaUsable = state.lastFailureKind === 'usage_limit'
    ? !quotaSnapshot.exhausted && matchingQuotaMeters.length > 0
      && matchingQuotaMeters.every(meter => meter.reliable !== false && meterHasRemainingQuota(meter))
    : (state.lastFailureKind === undefined || state.lastFailureKind === null)
      && snapshotProvesQuotaUsable(quotaSnapshot, false);
  if (state.lastFailureKind === 'usage_limit' && !quotaUsable) return state;
  if (
    params.authenticatedProbe
    && snapshotProvesRuntimeUsable(quotaSnapshot)
  ) {
    const cleared = clearConnectedServiceAuthGroupMemberRuntimeBlockers(state);
    if (state.lastFailureKind === 'usage_limit' || state.lastFailureKind === 'rate_limit') {
      delete cleared.providerResetsAtMs;
    }
    // A generic authenticated quota response proves neither entitlement nor success for a rejected model.
    return { ...cleared,
      ...(state.modelUnavailableUntilMsByModelId ? { modelUnavailableUntilMsByModelId: state.modelUnavailableUntilMsByModelId } : {}),
      ...(state.autoDisabledReason ? { autoDisabledReason: state.autoDisabledReason } : {}),
    };
  }

  const rateUsable = (
    state.lastFailureKind === 'rate_limit'
    || state.lastFailureKind === undefined
    || state.lastFailureKind === null
  ) && snapshotProvesRateLimitUsable(quotaSnapshot);
  if (!quotaUsable && !rateUsable) return state;

  const next: {
    -readonly [Key in keyof ConnectedServiceAuthGroupMemberRuntimeState]: ConnectedServiceAuthGroupMemberRuntimeState[Key];
  } = { ...state };
  let changed = false;
  if (quotaUsable) {
    for (const key of ['cooldownStartedAtMs', 'cooldownUntilMs', 'exhaustedUntilMs', 'quotaExhaustedUntilMs'] as const) {
      if (next[key] !== undefined) {
        delete next[key];
        changed = true;
      }
    }
    if (state.lastFailureKind === 'usage_limit') {
      delete next.lastFailureKind;
      delete next.lastFailureProviderLimitId;
      delete next.lastObservedAtMs;
      changed = true;
    }
  }
  if (rateUsable) {
    for (const key of ['cooldownStartedAtMs', 'cooldownUntilMs', 'exhaustedUntilMs', 'rateLimitedUntilMs'] as const) {
      if (next[key] !== undefined) {
        delete next[key];
        changed = true;
      }
    }
    if (state.lastFailureKind === 'rate_limit') {
      delete next.lastFailureKind;
      delete next.lastFailureProviderLimitId;
      delete next.lastObservedAtMs;
      changed = true;
    }
  }
  if ((quotaUsable || rateUsable) && next.providerResetsAtMs !== undefined) {
    delete next.providerResetsAtMs;
    changed = true;
  }
  return changed ? next : state;
}
