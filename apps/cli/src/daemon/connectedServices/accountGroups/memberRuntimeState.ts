import type {
  ConnectedServiceAuthGroupMemberStateV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import {
  clearConnectedServiceAuthGroupMemberRuntimeBlockers,
  compareConnectedServiceQuotaObservationRecency,
  isConnectedServiceQuotaObservationFresh,
} from '@happier-dev/protocol';

import { logger as defaultLogger } from '@/ui/logger';
import { ConnectedServiceAuthGroupRuntimeStateRevisionConflictError } from '@/api/connectedServices/connectedServiceCredentialApi';

import type {
  ConnectedServiceAuthGroupMemberRuntimeState,
  ConnectedServiceAuthGroupPolicyV1,
  ConnectedServiceAuthGroupQuotaSnapshot,
} from './selection/selectConnectedServiceAuthGroupCandidate';
import {
  connectedServiceAuthGroupMeterHasRemainingQuota as meterHasRemainingQuota,
  connectedServiceAuthGroupSnapshotProvesQuotaUsable as snapshotProvesQuotaUsable,
  connectedServiceAuthGroupSnapshotProvesRateLimitUsable as snapshotProvesRateLimitUsable,
  isConnectedServiceAuthGroupUsageMeter as isQuotaMeter,
} from './quotas/quotaUsability';

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

/** One blocker interpretation for selection and positive-evidence reconciliation. */
export function resolveConnectedServiceAuthGroupSnapshotEligibilityBlocker(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  nowMs: number,
): Readonly<{ reason: 'capacity_limited' | 'auth_invalid' | 'plan_unavailable' | 'validation_blocked'; retryAtMs: number | null }> | null {
  const active = (snapshot?.meters ?? []).filter((meter) => meter.resetAtMs === null || meter.resetAtMs > nowMs);
  for (const [categories, reason] of [
    [['auth_invalid', 'disabled'], 'auth_invalid'],
    [['plan_invalid'], 'plan_unavailable'],
    [['validation_failed'], 'validation_blocked'],
    [['capacity'], 'capacity_limited'],
  ] as const) {
    const blocking = active.filter((meter) => categories.some((category) => category === meter.limitCategory));
    if (blocking.length > 0) return { reason, retryAtMs: blocking.some((meter) => meter.resetAtMs === null)
      ? null : Math.max(...blocking.map((meter) => meter.resetAtMs!)) };
  }
  return null;
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
  | {
    kind: 'fresh_quota';
    observedAtMs: number;
    quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot;
    quotaFreshnessMs: number;
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
      'lastFailureProviderLimitId',
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
  if (params.evidence.kind === 'fresh_quota') {
    return reconcileMemberRuntimeStateWithQuotaEvidence({
      state: params.state,
      quotaSnapshot: params.evidence.quotaSnapshot,
      quotaFreshnessMs: params.evidence.quotaFreshnessMs,
      policy: params.policy,
      nowMs: params.nowMs,
    });
  }
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

export function logMemberRuntimeStatePositiveEvidenceClear(params: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  evidenceKind: ConnectedServiceAuthGroupPositiveEvidence['kind'];
  before: ConnectedServiceAuthGroupMemberRuntimeState;
  after: ConnectedServiceAuthGroupMemberRuntimeState;
  logger?: Pick<typeof defaultLogger, 'debug'>;
}>): void {
  (params.logger ?? defaultLogger).debug('[DAEMON RUN] Connected-service member blockers cleared by positive evidence', {
    serviceId: params.serviceId,
    groupId: params.groupId,
    profileId: params.profileId,
    evidenceKind: params.evidenceKind,
    clearedBlockerKinds: resolveClearedBlockerKinds(params.before, params.after),
  });
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
      logMemberRuntimeStatePositiveEvidenceClear({
        serviceId: params.serviceId,
        groupId: params.groupId,
        profileId: params.profileId,
        evidenceKind: params.evidence.kind,
        before: member.state,
        after: reconciled,
        logger: params.logger,
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
  quotaFreshnessMs: number;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  if (!params.quotaSnapshot) return params.state;
  return reconcileMemberRuntimeStateWithPositiveEvidence({
    state: params.state,
    evidence: {
      kind: 'fresh_quota',
      observedAtMs: params.nowMs,
      quotaSnapshot: params.quotaSnapshot,
      quotaFreshnessMs: params.quotaFreshnessMs,
    },
    policy: params.policy,
    nowMs: params.nowMs,
  });
}

function reconcileMemberRuntimeStateWithQuotaEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot;
  quotaFreshnessMs: number;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  const state = params.state;
  const quotaSnapshot = params.quotaSnapshot;
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  if (!state || !isConnectedServiceQuotaObservationFresh({
    observedAtMs: quotaSnapshot.capturedAtMs,
    nowMs: params.nowMs,
    maxAgeMs: params.quotaFreshnessMs,
  })) return state;
  if (lastObservedAtMs !== null && compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: lastObservedAtMs,
    incomingObservedAtMs: quotaSnapshot.capturedAtMs,
    nowMs: params.nowMs,
  }) !== 'incoming_newer') return state;
  if (quotaSnapshot.planUnavailable || resolveConnectedServiceAuthGroupSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs)) return state;
  // A probe must itself follow the existing limiter cooldown. Waiting until later cannot
  // turn a potentially lagging observation captured just after a failure into new proof.
  if (state.lastFailureKind === 'usage_limit' && lastObservedAtMs !== null
    && lastObservedAtMs <= params.nowMs
    && quotaSnapshot.capturedAtMs < lastObservedAtMs + params.policy.cooldownMs) return state;

  let changed = false;
  const next: {
    -readonly [Key in keyof ConnectedServiceAuthGroupMemberRuntimeState]: ConnectedServiceAuthGroupMemberRuntimeState[Key];
  } = { ...state };

  const quotaMeters = (quotaSnapshot.meters ?? []).filter(isQuotaMeter);
  const failureLimitId = state.lastFailureProviderLimitId?.trim();
  const matchingQuotaMeters = failureLimitId
    ? quotaMeters.filter((meter) => meter.providerLimitId === failureLimitId)
    : quotaMeters;
  const quotaUsable = state.lastFailureKind === 'usage_limit'
    ? matchingQuotaMeters.length > 0 && matchingQuotaMeters.every((meter) => meter.reliable !== false && meterHasRemainingQuota(meter))
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
      delete next.lastFailureProviderLimitId;
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
      delete next.lastFailureProviderLimitId;
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

function resolveLimiterRetryAtMs(retryAtMs: number | null, existingRetryAtMs: number | null): number | null {
  if (retryAtMs === null) return existingRetryAtMs;
  if (existingRetryAtMs === null) return retryAtMs;
  return Math.max(retryAtMs, existingRetryAtMs);
}

function resolveProviderResetAtMs(input: Readonly<{
  resetAtMs?: number | null;
  existingResetAtMs: number | null;
}>): number | null {
  const resetAtMs = numberOrNull(input.resetAtMs);
  if (resetAtMs === null) return input.existingResetAtMs;
  if (input.existingResetAtMs === null) return resetAtMs;
  return Math.max(resetAtMs, input.existingResetAtMs);
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
  /** Provider-declared hard-limit reset, kept separate from transient retry timing. */
  providerResetsAtMs?: number | null;
  planType: string | null | undefined;
  observedAtMs: number;
}>): ConnectedServiceAuthGroupMemberRuntimeState {
  const existing = input.existing ?? {};
  const state: ConnectedServiceAuthGroupMemberRuntimeState = {
    ...(existing.cooldownUntilMs === undefined ? {} : { cooldownUntilMs: existing.cooldownUntilMs }),
    ...(existing.exhaustedUntilMs === undefined ? {} : { exhaustedUntilMs: existing.exhaustedUntilMs }),
    ...(existing.quotaExhaustedUntilMs === undefined ? {} : { quotaExhaustedUntilMs: existing.quotaExhaustedUntilMs }),
    ...(existing.providerResetsAtMs === undefined ? {} : { providerResetsAtMs: existing.providerResetsAtMs }),
    ...(existing.rateLimitedUntilMs === undefined ? {} : { rateLimitedUntilMs: existing.rateLimitedUntilMs }),
    ...(existing.capacityLimitedUntilMs === undefined ? {} : { capacityLimitedUntilMs: existing.capacityLimitedUntilMs }),
    ...(existing.authInvalidUntilMs === undefined ? {} : { authInvalidUntilMs: existing.authInvalidUntilMs }),
    ...(existing.planUnavailableUntilMs === undefined ? {} : { planUnavailableUntilMs: existing.planUnavailableUntilMs }),
    ...(existing.modelUnavailableUntilMsByModelId === undefined ? {} : { modelUnavailableUntilMsByModelId: existing.modelUnavailableUntilMsByModelId }),
    ...(existing.validationBlockedUntilMs === undefined ? {} : { validationBlockedUntilMs: existing.validationBlockedUntilMs }),
    ...(existing.autoDisabledReason === undefined ? {} : { autoDisabledReason: existing.autoDisabledReason }),
    ...(existing.lastFailureCode === undefined ? {} : { lastFailureCode: existing.lastFailureCode }),
    lastFailureKind: input.reason,
    ...((input.reason === 'usage_limit' || input.reason === 'rate_limit') && input.providerLimitId?.trim()
      ? { lastFailureProviderLimitId: input.providerLimitId.trim() } : {}),
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
    case 'usage_limit': {
      const quotaExhaustedUntilMs = resolveLimiterRetryAtMs(input.retryAtMs, numberOrNull(existing.quotaExhaustedUntilMs));
      const providerResetsAtMs = resolveProviderResetAtMs({ resetAtMs: input.providerResetsAtMs, existingResetAtMs: numberOrNull(existing.providerResetsAtMs) });
      return {
        ...state,
        ...(quotaExhaustedUntilMs === null ? {} : { quotaExhaustedUntilMs }),
        ...(providerResetsAtMs === null ? {} : { providerResetsAtMs }),
      };
    }
    case 'rate_limit': {
      const rateLimitedUntilMs = resolveLimiterRetryAtMs(input.retryAtMs, numberOrNull(existing.rateLimitedUntilMs));
      const providerResetsAtMs = resolveProviderResetAtMs({ resetAtMs: input.providerResetsAtMs, existingResetAtMs: numberOrNull(existing.providerResetsAtMs) });
      return {
        ...state,
        ...(rateLimitedUntilMs === null ? {} : { rateLimitedUntilMs }),
        ...(providerResetsAtMs === null ? {} : { providerResetsAtMs }),
      };
    }
    case 'capacity':
      return { ...state, capacityLimitedUntilMs: resolveLimiterRetryAtMs(input.retryAtMs, numberOrNull(existing.capacityLimitedUntilMs)) };
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
