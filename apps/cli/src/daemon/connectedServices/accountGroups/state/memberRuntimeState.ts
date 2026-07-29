import {
  clearConnectedServiceAuthGroupMemberRuntimeBlockers,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from '../quotas/projection';
import type {
  ConnectedServiceAuthGroupMemberRuntimeState,
  ConnectedServiceAuthGroupPolicyV1,
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
): boolean {
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  return lastObservedAtMs === null || snapshot.capturedAtMs > lastObservedAtMs;
}

export function projectConnectedServiceQuotaSnapshotToAuthGroupQuotaEvidence(
  snapshot: ConnectedServiceQuotaSnapshotV1,
): ConnectedServiceAuthGroupQuotaSnapshot {
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAt,
    meters: snapshot.meters,
  }).quotaSnapshot!;
}

export function reconcileMemberRuntimeStateWithFreshQuotaEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot | null;
  policy?: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
  authenticatedProbe?: boolean;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  void params.policy;
  void params.nowMs;
  const state = params.state;
  const quotaSnapshot = params.quotaSnapshot;
  if (!state || !quotaSnapshot || !isSnapshotNewerThanFailure(quotaSnapshot, state)) return state;
  if (quotaSnapshot.planUnavailable) return state;
  if (
    params.authenticatedProbe
    && snapshotProvesRuntimeUsable(quotaSnapshot)
  ) {
    return clearConnectedServiceAuthGroupMemberRuntimeBlockers(
      state,
    );
  }

  const quotaUsable = (
    state.lastFailureKind === 'usage_limit'
    || state.lastFailureKind === undefined
    || state.lastFailureKind === null
  ) && snapshotProvesQuotaUsable(quotaSnapshot, state.lastFailureKind === 'usage_limit');
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
