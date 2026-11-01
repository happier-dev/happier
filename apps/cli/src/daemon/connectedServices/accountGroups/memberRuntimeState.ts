import type {
  ConnectedServiceAuthGroupMemberStateV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import {
  clearConnectedServiceAuthGroupMemberRuntimeBlockers,
  compareConnectedServiceQuotaObservationRecency,
} from '@happier-dev/protocol';

import { logger as defaultLogger } from '@/ui/logger';
import { ConnectedServiceAuthGroupRuntimeStateRevisionConflictError } from '@/api/connectedServices/connectedServiceCredentialApi';

import type {
  ConnectedServiceAuthGroupMemberRuntimeState,
  ConnectedServiceAuthGroupPolicyV1,
  ConnectedServiceAuthGroupQuotaMeterSnapshot,
  ConnectedServiceAuthGroupQuotaSnapshot,
} from './selection/selectConnectedServiceAuthGroupCandidate';

export type ConnectedServiceMemberRuntimeStateApi = Readonly<{
  getConnectedServiceAuthGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupRuntimeState(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration: number;
    expectedRuntimeStateRevision: number;
    memberStates: ReadonlyArray<Readonly<{
      profileId: string;
      state: ConnectedServiceAuthGroupMemberStateV1;
    }>>;
  }>): Promise<ConnectedServiceAuthGroupV1>;
}>;

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

function snapshotProvesQuotaUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  if (snapshot.exhausted) return false;
  const quotaMeters = (snapshot.meters ?? []).filter(isQuotaMeter);
  if (quotaMeters.length > 0) return quotaMeters.every(meterHasRemainingQuota);
  const remaining = numberOrNull(snapshot.effectiveRemainingPercent);
  return remaining !== null && remaining > 0;
}

function snapshotProvesRateLimitUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  const rateLimitMeters = (snapshot.meters ?? []).filter(isRateLimitMeter);
  return rateLimitMeters.length > 0 && rateLimitMeters.every(meterHasRemainingQuota);
}

function resolveSnapshotEligibilityBlocker(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  nowMs: number,
): boolean {
  const meters = snapshot?.meters ?? [];
  if (meters.length === 0) return false;
  if (meters.some((meter) => meter.limitCategory === 'usage_limit' || meter.limitCategory === 'rate_limit' || meter.limitCategory === 'unknown')) {
    return false;
  }
  if (meters.some((meter) => numberOrNull(meter.resetAtMs) !== null && numberOrNull(meter.resetAtMs)! <= nowMs)) {
    return false;
  }
  const categories = new Set(meters.map((meter) => meter.limitCategory));
  return categories.has('auth_invalid')
    || categories.has('disabled')
    || categories.has('plan_invalid')
    || categories.has('validation_failed')
    || categories.has('capacity');
}

export type ConnectedServiceAuthGroupPositiveEvidence = Readonly<
  {
    kind:
      | 'successful_spawn'
      | 'successful_turn'
      | 'credential_refresh'
      | 'oauth_token_callback'
      | 'account_adoption';
    observedAtMs: number;
  }
>;

function evidenceIsNewerThanFailure(
  evidence: ConnectedServiceAuthGroupPositiveEvidence,
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
): boolean {
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  return lastObservedAtMs === null || evidence.observedAtMs > lastObservedAtMs;
}

function positiveEvidenceProvesRuntimeUsable(
  evidence: ConnectedServiceAuthGroupPositiveEvidence,
): boolean {
  if (evidence.kind === 'successful_spawn' || evidence.kind === 'account_adoption') return false;
  return true;
}

function clearAuthenticationFailure(
  state: ConnectedServiceAuthGroupMemberRuntimeState,
): ConnectedServiceAuthGroupMemberRuntimeState {
  const next: {
    -readonly [Key in keyof ConnectedServiceAuthGroupMemberRuntimeState]: ConnectedServiceAuthGroupMemberRuntimeState[Key];
  } = { ...state };
  let changed = false;
  for (const key of ['authInvalidUntilMs', 'credentialHealthStatus'] as const) {
    if (next[key] !== undefined) {
      delete next[key];
      changed = true;
    }
  }
  if (
    state.lastFailureKind === 'auth_expired'
    || state.lastFailureKind === 'auth_failed'
    || state.lastFailureKind === 'refresh_failed'
    || state.lastFailureKind === 'account_disabled'
  ) {
    for (const key of [
      'cooldownStartedAtMs',
      'cooldownUntilMs',
      'exhaustedUntilMs',
      'lastFailureKind',
      'lastObservedAtMs',
    ] as const) {
      if (next[key] !== undefined) {
        delete next[key];
        changed = true;
      }
    }
  }
  return changed ? next : state;
}

export function reconcileMemberRuntimeStateWithPositiveEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  evidence: ConnectedServiceAuthGroupPositiveEvidence;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  void params.policy;
  void params.nowMs;
  const state = params.state;
  if (!state || !evidenceIsNewerThanFailure(params.evidence, state)) return state;
  if (!positiveEvidenceProvesRuntimeUsable(params.evidence)) return state;

  if (params.evidence.kind === 'credential_refresh' || params.evidence.kind === 'oauth_token_callback') {
    return clearAuthenticationFailure(state);
  }
  const cleared = clearConnectedServiceAuthGroupMemberRuntimeBlockers(state);
  if (cleared === state) return state;
  // A successful turn has no model identity here. It cannot refute a rejection learned for
  // another model in the pool; those exclusions expire or are cleared by an explicit member edit.
  const next = {
    ...cleared,
    ...(state.modelUnavailableUntilMsByModelId === undefined ? {} : {
      modelUnavailableUntilMsByModelId: state.modelUnavailableUntilMsByModelId,
    }),
    ...(state.autoDisabledReason === undefined ? {} : { autoDisabledReason: state.autoDisabledReason }),
    ...(state.lastFailureCode === 'model_not_entitled' ? { lastFailureCode: state.lastFailureCode } : {}),
  };
  return resolveClearedBlockerKinds(state, next).length > 0 ? next : state;
}

/**
 * The blocker-field names cleared between the pre- and post-reconcile member states. Field NAMES
 * are safe to log (no credentials); we never log the field values.
 */
function resolveClearedBlockerKinds(
  before: ConnectedServiceAuthGroupMemberRuntimeState,
  after: ConnectedServiceAuthGroupMemberRuntimeState,
): readonly string[] {
  const afterRecord = after as Record<string, unknown>;
  return Object.keys(before).filter(
    (key) => (before as Record<string, unknown>)[key] !== undefined && afterRecord[key] === undefined,
  );
}

export async function persistMemberRuntimeStateWithPositiveEvidence(params: Readonly<{
  api: ConnectedServiceMemberRuntimeStateApi;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  evidence: ConnectedServiceAuthGroupPositiveEvidence;
  normalizePolicy: (policy: ConnectedServiceAuthGroupV1['policy']) => ConnectedServiceAuthGroupPolicyV1;
  /**
   * Diagnosability sink (QA2-F01 / RR-8): the positive-evidence success chain was log-silent, so a
   * live clear of member blockers was invisible. NAMES only — never credential/token values.
   */
  logger?: Pick<typeof defaultLogger, 'debug'>;
}>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const group = await params.api.getConnectedServiceAuthGroup({
      serviceId: params.serviceId,
      groupId: params.groupId,
    });
    if (!group || group.generation !== params.generation) return false;
    const member = group.members.find((item) => item.profileId === params.profileId) ?? null;
    if (!member) return false;
    const reconciled = reconcileMemberRuntimeStateWithPositiveEvidence({
      state: member.state,
      evidence: params.evidence,
      policy: params.normalizePolicy(group.policy),
      nowMs: params.evidence.observedAtMs,
    });
    if (!reconciled || reconciled === member.state) return false;
    try {
      await params.api.updateConnectedServiceAuthGroupRuntimeState({
        serviceId: params.serviceId,
        groupId: params.groupId,
        expectedGeneration: group.generation,
        expectedRuntimeStateRevision: group.runtimeStateRevision,
        memberStates: [{ profileId: params.profileId, state: reconciled }],
      });
      (params.logger ?? defaultLogger).debug('[DAEMON RUN] Connected-service member blockers cleared by positive evidence', {
        serviceId: params.serviceId,
        groupId: params.groupId,
        profileId: params.profileId,
        evidenceKind: params.evidence.kind,
        clearedBlockerKinds: resolveClearedBlockerKinds(member.state, reconciled),
      });
      return true;
    } catch (error) {
      if (!(error instanceof ConnectedServiceAuthGroupRuntimeStateRevisionConflictError) || attempt === 1) throw error;
    }
  }
  return false;
}

export function reconcileMemberRuntimeStateWithFreshQuotaEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  const state = params.state;
  const quotaSnapshot = params.quotaSnapshot;
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  if (!state || !quotaSnapshot) return state;
  if (lastObservedAtMs !== null && compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: lastObservedAtMs,
    incomingObservedAtMs: quotaSnapshot.capturedAtMs,
    nowMs: params.nowMs,
  }) !== 'incoming_newer') return state;
  if (quotaSnapshot.planUnavailable || resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs)) return state;

  let changed = false;
  const next: {
    -readonly [Key in keyof ConnectedServiceAuthGroupMemberRuntimeState]: ConnectedServiceAuthGroupMemberRuntimeState[Key];
  } = { ...state };

  const quotaMeters = (quotaSnapshot.meters ?? []).filter(isQuotaMeter);
  const quotaUsable = state.lastFailureKind === 'usage_limit'
    ? quotaMeters.length > 0 && quotaMeters.every(meterHasRemainingQuota)
    : state.lastFailureKind === undefined || state.lastFailureKind === null
      ? snapshotProvesQuotaUsable(quotaSnapshot)
      : false;
  if (
    quotaUsable
    && (
      numberOrNull(state.cooldownStartedAtMs) !== null
      || numberOrNull(state.cooldownUntilMs) !== null
      || numberOrNull(state.exhaustedUntilMs) !== null
    )
  ) {
    delete next.cooldownStartedAtMs;
    delete next.cooldownUntilMs;
    delete next.exhaustedUntilMs;
    changed = true;
  }

  if (quotaUsable && (numberOrNull(state.quotaExhaustedUntilMs) !== null || state.lastFailureKind === 'usage_limit')) {
    delete next.quotaExhaustedUntilMs;
    delete next.providerResetsAtMs;
    if (state.lastFailureKind === 'usage_limit') {
      delete next.lastFailureKind;
      delete next.lastObservedAtMs;
    }
    changed = true;
  }

  const rateUsable = (
    state.lastFailureKind === 'rate_limit'
    || state.lastFailureKind === undefined
    || state.lastFailureKind === null
  ) && snapshotProvesRateLimitUsable(quotaSnapshot);
  if (rateUsable && (numberOrNull(state.rateLimitedUntilMs) !== null || state.lastFailureKind === 'rate_limit')) {
    delete next.rateLimitedUntilMs;
    delete next.providerResetsAtMs;
    if (state.lastFailureKind === 'rate_limit') {
      delete next.lastFailureKind;
      delete next.lastObservedAtMs;
    }
    changed = true;
  }

  return changed ? next : state;
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function resolveLimiterRetryAtMs(retryAtMs: number | null): number | null {
  return retryAtMs;
}

function resolveAuthFailureRetryAtMs(input: Readonly<{
  policy: ConnectedServiceAuthGroupPolicyV1;
  retryAtMs: number | null;
  observedAtMs: number;
}>): number | null {
  if (input.retryAtMs !== null) return input.retryAtMs;
  const cooldownMs = readNonNegativeNumber(input.policy.cooldownMs);
  return cooldownMs === null ? null : input.observedAtMs + cooldownMs;
}

export const CONNECTED_SERVICE_MODEL_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function resolvePlanInvalidRetryAtMs(retryAtMs: number | null, observedAtMs: number): number {
  return Math.max(retryAtMs ?? 0, observedAtMs + CONNECTED_SERVICE_MODEL_ENTITLEMENT_COOLDOWN_MS);
}

export function buildObservedFailureMemberRuntimeState(input: Readonly<{
  existing: ConnectedServiceAuthGroupMemberRuntimeState | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  reason: string;
  limitCategory?: string | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  retryAtMs: number | null;
  planType: string | null | undefined;
  observedAtMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState {
  const existing = input.existing ?? {};
  const state: ConnectedServiceAuthGroupMemberRuntimeState = {
    ...(existing.cooldownUntilMs === undefined ? {} : { cooldownUntilMs: existing.cooldownUntilMs }),
    ...(existing.exhaustedUntilMs === undefined ? {} : { exhaustedUntilMs: existing.exhaustedUntilMs }),
    ...(existing.quotaExhaustedUntilMs === undefined ? {} : { quotaExhaustedUntilMs: existing.quotaExhaustedUntilMs }),
    ...(existing.rateLimitedUntilMs === undefined ? {} : { rateLimitedUntilMs: existing.rateLimitedUntilMs }),
    ...(existing.capacityLimitedUntilMs === undefined ? {} : { capacityLimitedUntilMs: existing.capacityLimitedUntilMs }),
    ...(existing.authInvalidUntilMs === undefined ? {} : { authInvalidUntilMs: existing.authInvalidUntilMs }),
    ...(existing.planUnavailableUntilMs === undefined ? {} : { planUnavailableUntilMs: existing.planUnavailableUntilMs }),
    ...(existing.modelUnavailableUntilMsByModelId === undefined ? {} : { modelUnavailableUntilMsByModelId: existing.modelUnavailableUntilMsByModelId }),
    ...(existing.validationBlockedUntilMs === undefined ? {} : { validationBlockedUntilMs: existing.validationBlockedUntilMs }),
    ...(existing.autoDisabledReason === undefined ? {} : { autoDisabledReason: existing.autoDisabledReason }),
    ...(existing.lastFailureCode === undefined ? {} : { lastFailureCode: existing.lastFailureCode }),
    lastFailureKind: input.reason,
    lastObservedAtMs: input.observedAtMs,
    ...(input.planType ? { lastObservedPlanType: input.planType } : {}),
  };
  const providerLimitId = input.providerLimitId?.trim();
  if (
    input.limitCategory === 'plan_invalid'
    && input.quotaScope === 'model'
    && providerLimitId
  ) {
    return {
      ...state,
      lastFailureCode: 'model_not_entitled',
      modelUnavailableUntilMsByModelId: {
        ...existing.modelUnavailableUntilMsByModelId,
        [providerLimitId]: resolvePlanInvalidRetryAtMs(input.retryAtMs, input.observedAtMs),
      },
      ...(input.policy.autoDisablePlanInvalidAccounts === true
        ? { autoDisabledReason: 'model_not_entitled' as const }
        : {}),
    };
  }
  if (input.reason === 'permission_denied' && input.limitCategory === 'plan_invalid') {
    return {
      ...state,
      planUnavailableUntilMs: resolvePlanInvalidRetryAtMs(input.retryAtMs, input.observedAtMs),
    };
  }
  switch (input.reason) {
    case 'usage_limit':
      return { ...state, quotaExhaustedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs) };
    case 'rate_limit':
      return { ...state, rateLimitedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs) };
    case 'capacity':
      return { ...state, capacityLimitedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs) };
    case 'auth_expired':
    case 'auth_failed':
    case 'refresh_failed':
    case 'account_disabled':
      return {
        ...state,
        credentialHealthStatus: 'needs_reauth',
        authInvalidUntilMs: resolveAuthFailureRetryAtMs({
          policy: input.policy,
          retryAtMs: input.retryAtMs,
          observedAtMs: input.observedAtMs,
        }),
      };
    case 'plan':
      return { ...state, planUnavailableUntilMs: resolvePlanInvalidRetryAtMs(input.retryAtMs, input.observedAtMs) };
    case 'validation':
      return { ...state, validationBlockedUntilMs: input.retryAtMs };
    default:
      return state;
  }
}
