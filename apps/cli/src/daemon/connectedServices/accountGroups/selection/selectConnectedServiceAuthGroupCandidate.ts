import type {
  ConnectedServiceCredentialHealthStatusV1,
  ConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol';

export type ConnectedServiceAuthGroupPolicyV1 = Readonly<{
  v: 1;
  strategy: 'priority' | 'least_limited' | 'manual';
  autoSwitch: boolean;
  switchOn: Readonly<{
    usageLimit: boolean;
    authExpired: boolean;
    accountChanged: boolean;
    refreshFailure: boolean;
  }>;
  cooldownMs: number;
  honorProviderResetsAt: boolean;
  autoRestorePrimaryWhenReset: boolean;
  maxSwitchesPerTurn: number;
  maxSwitchesPerSessionHour: number;
  softSwitchRemainingPercent: number;
  probeIfSnapshotOlderThanMs: number;
  preTurnProbeMode: 'never' | 'when_stale' | 'always_for_group';
  preTurnProbeOrder: 'current_first_then_candidates' | 'candidates_first_then_current';
  recoveryMode: 'off' | 'wait_until_reset' | 'switch_then_resume' | 'switch_or_wait';
  recoveryPromptMode: 'standard';
  resumePromptMode: 'standard' | 'off' | 'custom';
  effectiveMeterStrategy: 'most_constrained' | 'primary' | 'secondary' | 'daily' | 'weekly' | 'session';
  memberRuntimeStatePersistence: 'server_state_json';
}>;

export const DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1: ConnectedServiceAuthGroupPolicyV1 = {
  v: 1,
  strategy: 'priority',
  autoSwitch: false,
  switchOn: {
    usageLimit: true,
    authExpired: true,
    accountChanged: true,
    refreshFailure: false,
  },
  cooldownMs: 30_000,
  honorProviderResetsAt: true,
  autoRestorePrimaryWhenReset: false,
  maxSwitchesPerTurn: 1,
  maxSwitchesPerSessionHour: 3,
  softSwitchRemainingPercent: 15,
  probeIfSnapshotOlderThanMs: 300_000,
  preTurnProbeMode: 'when_stale',
  preTurnProbeOrder: 'current_first_then_candidates',
  recoveryMode: 'switch_or_wait',
  recoveryPromptMode: 'standard',
  resumePromptMode: 'standard',
  effectiveMeterStrategy: 'most_constrained',
  memberRuntimeStatePersistence: 'server_state_json',
};

export type ConnectedServiceAuthGroupMember = Readonly<{
  profileId: string;
  priority: number;
  createdAtMs: number;
  enabled: boolean;
}>;

export type ConnectedServiceAuthGroupQuotaMeterSnapshot = Readonly<{
  meterId: string;
  limitCategory: ConnectedServiceLimitCategoryV1;
  remainingPct: number | null;
  resetAtMs: number | null;
  providerLimitId: string | null;
}>;

export type ConnectedServiceAuthGroupQuotaSnapshot = Readonly<{
  capturedAtMs: number;
  effectiveMeterId?: string | null;
  effectiveRemainingPercent?: number | null;
  meters?: ReadonlyArray<ConnectedServiceAuthGroupQuotaMeterSnapshot>;
  exhausted?: boolean;
  planUnavailable?: boolean;
}>;

export type ConnectedServiceAuthGroupMemberRuntimeState = Readonly<{
  credentialHealthStatus?: ConnectedServiceCredentialHealthStatusV1 | null;
  cooldownStartedAtMs?: number | null;
  cooldownUntilMs?: number | null;
  exhaustedUntilMs?: number | null;
  quotaExhaustedUntilMs?: number | null;
  rateLimitedUntilMs?: number | null;
  capacityLimitedUntilMs?: number | null;
  authInvalidUntilMs?: number | null;
  planUnavailableUntilMs?: number | null;
  validationBlockedUntilMs?: number | null;
  providerResetsAtMs?: number | null;
  lastFailureKind?: string | null;
  lastObservedAtMs?: number | null;
  quotaSnapshot?: ConnectedServiceAuthGroupQuotaSnapshot | null;
}>;

export type ConnectedServiceAuthGroupCandidate = ConnectedServiceAuthGroupMember & Readonly<{
  leastLimitedScore: number | null;
}>;

export type ConnectedServiceAuthGroupCandidateSelection = Readonly<{
  selected: ConnectedServiceAuthGroupCandidate | null;
  reason: 'selected' | 'manual_strategy' | 'no_eligible_members';
  excluded: ReadonlyArray<ConnectedServiceAuthGroupCandidateExclusion>;
}>;

export type ConnectedServiceAuthGroupSwitchReasonEvidenceInput = Readonly<{
  reason: string;
  profileId: string;
  nowMs: number;
  quotaFreshnessMs: number;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>;

type ConnectedServiceAuthGroupCandidateExclusion = Readonly<{
  profileId: string;
  reason:
    | 'current_active'
    | 'disabled'
    | 'cooldown'
    | 'quota_exhausted'
    | 'capacity_limited'
    | 'auth_invalid'
    | 'plan_unavailable'
    | 'validation_blocked';
  retryAtMs?: number | null;
}>;

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function comparePriority(left: ConnectedServiceAuthGroupMember, right: ConnectedServiceAuthGroupMember): number {
  return left.priority - right.priority
    || left.createdAtMs - right.createdAtMs
    || left.profileId.localeCompare(right.profileId);
}

function resolveCooldownRetryAtMs(params: Readonly<{
  policy: ConnectedServiceAuthGroupPolicyV1;
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  nowMs: number;
}>): number | null {
  const cooldownStartedAtMs = numberOrNull(params.state?.cooldownStartedAtMs);
  const policyRetryAtMs = cooldownStartedAtMs === null ? null : cooldownStartedAtMs + params.policy.cooldownMs;
  const cooldownUntilMs = numberOrNull(params.state?.cooldownUntilMs);
  const exhaustedUntilMs = numberOrNull(params.state?.exhaustedUntilMs);
  const hasBlockingCooldownState =
    cooldownStartedAtMs !== null
    || cooldownUntilMs !== null
    || exhaustedUntilMs !== null;
  const providerResetsAtMs = params.policy.honorProviderResetsAt
    && hasBlockingCooldownState
    ? numberOrNull(params.state?.providerResetsAtMs)
    : null;
  const retryAtMs = Math.max(
    policyRetryAtMs ?? -Infinity,
    cooldownUntilMs ?? -Infinity,
    exhaustedUntilMs ?? -Infinity,
    providerResetsAtMs ?? -Infinity,
  );
  return Number.isFinite(retryAtMs) && retryAtMs > params.nowMs ? retryAtMs : null;
}

function resolveStateBlocker(
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
  nowMs: number,
): Readonly<{ reason: 'capacity_limited' | 'auth_invalid' | 'plan_unavailable' | 'validation_blocked'; retryAtMs: number }> | null {
  const blockers = [
    { reason: 'capacity_limited' as const, retryAtMs: numberOrNull(state?.capacityLimitedUntilMs) },
    { reason: 'auth_invalid' as const, retryAtMs: numberOrNull(state?.authInvalidUntilMs) },
    { reason: 'plan_unavailable' as const, retryAtMs: numberOrNull(state?.planUnavailableUntilMs) },
    { reason: 'validation_blocked' as const, retryAtMs: numberOrNull(state?.validationBlockedUntilMs) },
  ];
  return blockers.find((blocker): blocker is { reason: typeof blocker.reason; retryAtMs: number } =>
    blocker.retryAtMs !== null && blocker.retryAtMs > nowMs,
  ) ?? null;
}

function resolveSnapshotEligibilityBlocker(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  nowMs: number,
): Readonly<{
  reason: 'capacity_limited' | 'auth_invalid' | 'plan_unavailable' | 'validation_blocked';
  retryAtMs: number | null;
}> | null {
  const meters = snapshot?.meters ?? [];
  if (meters.length === 0) return null;
  if (meters.some((meter) =>
    meter.limitCategory === 'usage_limit'
    || meter.limitCategory === 'rate_limit'
    || meter.limitCategory === 'unknown',
  )) {
    return null;
  }

  const retryAtMs = meters
    .map((meter) => numberOrNull(meter.resetAtMs))
    .filter((value): value is number => value !== null && value > nowMs)
    .sort((left, right) => left - right)[0] ?? null;
  const categories = new Set(meters.map((meter) => meter.limitCategory));
  if (categories.has('auth_invalid') || categories.has('disabled')) {
    return { reason: 'auth_invalid', retryAtMs };
  }
  if (categories.has('plan_invalid')) return { reason: 'plan_unavailable', retryAtMs };
  if (categories.has('validation_failed')) return { reason: 'validation_blocked', retryAtMs };
  if (categories.has('capacity')) return { reason: 'capacity_limited', retryAtMs };
  return null;
}

function resolveQuotaRuntimeExhaustion(
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
  nowMs: number,
): number | null {
  const quotaExhaustedUntilMs = numberOrNull(state?.quotaExhaustedUntilMs);
  const rateLimitedUntilMs = numberOrNull(state?.rateLimitedUntilMs);
  const retryAtMs = Math.max(
    quotaExhaustedUntilMs ?? -Infinity,
    rateLimitedUntilMs ?? -Infinity,
  );
  return Number.isFinite(retryAtMs) && retryAtMs > nowMs ? retryAtMs : null;
}

function resolveRecentLimiterRetry(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  nowMs: number;
}>): Readonly<{ reason: 'quota_exhausted' | 'capacity_limited'; retryAtMs: number }> | null {
  const state = params.state;
  if (!state) return null;
  const lastFailureKind = state.lastFailureKind;
  if (
    lastFailureKind !== 'usage_limit'
    && lastFailureKind !== 'rate_limit'
    && lastFailureKind !== 'capacity'
  ) {
    return null;
  }
  const lastObservedAtMs = numberOrNull(state.lastObservedAtMs);
  if (lastObservedAtMs === null) return null;
  const retryAtMs = lastObservedAtMs + params.policy.cooldownMs;
  if (retryAtMs <= params.nowMs) return null;
  return {
    reason: lastFailureKind === 'capacity' ? 'capacity_limited' : 'quota_exhausted',
    retryAtMs,
  };
}

function isFreshQuotaSnapshot(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null | undefined,
  nowMs: number,
  quotaFreshnessMs: number,
): snapshot is ConnectedServiceAuthGroupQuotaSnapshot {
  if (!snapshot) return false;
  return nowMs - snapshot.capturedAtMs <= quotaFreshnessMs;
}

function isSnapshotNewerThanFailure(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
): boolean {
  const lastObservedAtMs = numberOrNull(state?.lastObservedAtMs);
  return lastObservedAtMs === null || snapshot.capturedAtMs > lastObservedAtMs;
}

function meterHasRemainingQuota(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  const remaining = numberOrNull(meter.remainingPct);
  return remaining !== null && remaining > 0;
}

function meterIsExhausted(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  const remaining = numberOrNull(meter.remainingPct);
  return remaining !== null && remaining <= 0;
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

function reconcileMemberRuntimeStateWithFreshQuotaEvidence(params: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null;
  quotaSnapshot: ConnectedServiceAuthGroupQuotaSnapshot | null;
}>): ConnectedServiceAuthGroupMemberRuntimeState | null {
  const state = params.state;
  const quotaSnapshot = params.quotaSnapshot;
  if (!state || !quotaSnapshot || !isSnapshotNewerThanFailure(quotaSnapshot, state)) return state;

  let changed = false;
  const next: {
    -readonly [Key in keyof ConnectedServiceAuthGroupMemberRuntimeState]: ConnectedServiceAuthGroupMemberRuntimeState[Key];
  } = { ...state };

  const quotaUsable = snapshotProvesQuotaUsable(quotaSnapshot);
  const hasPersistedQuotaBlocker = numberOrNull(state.quotaExhaustedUntilMs) !== null;
  if (quotaUsable && hasPersistedQuotaBlocker) {
    delete next.quotaExhaustedUntilMs;
    delete next.providerResetsAtMs;
    if (state.lastFailureKind === 'usage_limit') delete next.lastFailureKind;
    changed = true;
  }

  const rateUsable = snapshotProvesRateLimitUsable(quotaSnapshot);
  const hasPersistedRateLimitBlocker = numberOrNull(state.rateLimitedUntilMs) !== null;
  if (rateUsable && hasPersistedRateLimitBlocker) {
    delete next.rateLimitedUntilMs;
    delete next.providerResetsAtMs;
    if (state.lastFailureKind === 'rate_limit') delete next.lastFailureKind;
    changed = true;
  }

  return changed ? next : state;
}

function isQuotaExhausted(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  if (snapshot.exhausted) return true;
  if ((snapshot.meters ?? []).some((meter) => (
    (isQuotaMeter(meter) || isRateLimitMeter(meter))
    && meterIsExhausted(meter)
  ))) {
    return true;
  }
  const remaining = numberOrNull(snapshot.effectiveRemainingPercent);
  return remaining !== null && remaining <= 0;
}

function resolveQuotaSnapshotExhaustionRetryAtMs(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
  nowMs: number,
): number | null {
  const meterRetryAtMs = (snapshot.meters ?? [])
    .filter((meter) => (isQuotaMeter(meter) || isRateLimitMeter(meter)) && meterIsExhausted(meter))
    .map((meter) => numberOrNull(meter.resetAtMs))
    .filter((value): value is number => value !== null && value > nowMs)
    .sort((left, right) => left - right)[0] ?? null;
  return meterRetryAtMs ?? numberOrNull(state?.providerResetsAtMs);
}

function resolveLeastLimitedScore(snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null): number | null {
  if (!snapshot) return null;
  return numberOrNull(snapshot.effectiveRemainingPercent);
}

function requiresFreshQuotaEvidenceForSwitchReason(reason: string): boolean {
  return reason === 'usage_limit' || reason === 'rate_limit' || reason === 'soft_threshold';
}

export function hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason(
  params: ConnectedServiceAuthGroupSwitchReasonEvidenceInput,
): boolean {
  if (!requiresFreshQuotaEvidenceForSwitchReason(params.reason)) return true;
  const state = params.memberStatesByProfileId.get(params.profileId) ?? null;
  const quotaSnapshot = isFreshQuotaSnapshot(state?.quotaSnapshot, params.nowMs, params.quotaFreshnessMs)
    ? state?.quotaSnapshot ?? null
    : null;
  if (!quotaSnapshot) return false;
  if (quotaSnapshot.planUnavailable) return false;
  if (resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs)) return false;
  return !isQuotaExhausted(quotaSnapshot);
}

function resolveSoftSwitchRemainingPercent(policy: ConnectedServiceAuthGroupPolicyV1): number | null {
  const value = numberOrNull(policy.softSwitchRemainingPercent);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function resolveCurrentCandidate(
  candidates: ReadonlyArray<ConnectedServiceAuthGroupCandidate>,
  activeProfileId: string | null,
): ConnectedServiceAuthGroupCandidate | null {
  if (!activeProfileId) return null;
  return candidates.find((candidate) => candidate.profileId === activeProfileId) ?? null;
}

function resolveSoftSwitchPreferredCandidate(params: Readonly<{
  candidates: ReadonlyArray<ConnectedServiceAuthGroupCandidate>;
  activeProfileId: string | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  allowCurrentProfileRetry?: boolean;
}>): ConnectedServiceAuthGroupCandidate | null {
  if (!params.allowCurrentProfileRetry) return null;
  const current = resolveCurrentCandidate(params.candidates, params.activeProfileId);
  if (!current) return null;
  const threshold = resolveSoftSwitchRemainingPercent(params.policy);
  if (threshold === null) return null;
  const currentScore = current.leastLimitedScore;
  if (currentScore === null) return current;
  if (currentScore > threshold) return current;
  const betterCandidate = params.candidates.find((candidate) => (
    candidate.profileId !== current.profileId
    && candidate.leastLimitedScore !== null
    && candidate.leastLimitedScore > currentScore
  ));
  return betterCandidate ?? current;
}

export function selectConnectedServiceAuthGroupCandidate(params: Readonly<{
  nowMs: number;
  quotaFreshnessMs: number;
  activeProfileId: string | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  allowCurrentProfileRetry?: boolean;
}>): ConnectedServiceAuthGroupCandidateSelection {
  if (params.policy.strategy === 'manual') {
    return { selected: null, reason: 'manual_strategy', excluded: [] };
  }

  const excluded: ConnectedServiceAuthGroupCandidateExclusion[] = [];
  const candidates: ConnectedServiceAuthGroupCandidate[] = [];

  for (const member of params.members) {
    if (!member.enabled) {
      excluded.push({ profileId: member.profileId, reason: 'disabled' });
      continue;
    }
    if (!params.allowCurrentProfileRetry && params.activeProfileId === member.profileId) {
      excluded.push({ profileId: member.profileId, reason: 'current_active' });
      continue;
    }
    const state = params.memberStatesByProfileId.get(member.profileId) ?? null;
    if (state?.credentialHealthStatus === 'needs_reauth') {
      excluded.push({ profileId: member.profileId, reason: 'auth_invalid' });
      continue;
    }
    const stateBlocker = resolveStateBlocker(state, params.nowMs);
    if (stateBlocker) {
      excluded.push({ profileId: member.profileId, reason: stateBlocker.reason, retryAtMs: stateBlocker.retryAtMs });
      continue;
    }
    const quotaSnapshot = isFreshQuotaSnapshot(state?.quotaSnapshot, params.nowMs, params.quotaFreshnessMs)
      ? state?.quotaSnapshot ?? null
      : null;
    const snapshotBlocker = resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs);
    if (snapshotBlocker) {
      excluded.push({
        profileId: member.profileId,
        reason: snapshotBlocker.reason,
        retryAtMs: snapshotBlocker.retryAtMs,
      });
      continue;
    }
    if (quotaSnapshot && isQuotaExhausted(quotaSnapshot)) {
      excluded.push({
        profileId: member.profileId,
        reason: 'quota_exhausted',
        retryAtMs: resolveQuotaSnapshotExhaustionRetryAtMs(quotaSnapshot, state, params.nowMs),
      });
      continue;
    }
    const effectiveState = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      state,
      quotaSnapshot,
    });
    const recentLimiterRetry = resolveRecentLimiterRetry({
      state: effectiveState,
      policy: params.policy,
      nowMs: params.nowMs,
    });
    if (recentLimiterRetry !== null) {
      excluded.push({
        profileId: member.profileId,
        reason: recentLimiterRetry.reason,
        retryAtMs: recentLimiterRetry.retryAtMs,
      });
      continue;
    }
    const persistedQuotaRetryAtMs = resolveQuotaRuntimeExhaustion(effectiveState, params.nowMs);
    if (persistedQuotaRetryAtMs !== null) {
      excluded.push({ profileId: member.profileId, reason: 'quota_exhausted', retryAtMs: persistedQuotaRetryAtMs });
      continue;
    }

    const cooldownRetryAtMs = resolveCooldownRetryAtMs({
      policy: params.policy,
      state: effectiveState,
      nowMs: params.nowMs,
    });
    if (cooldownRetryAtMs !== null) {
      excluded.push({ profileId: member.profileId, reason: 'cooldown', retryAtMs: cooldownRetryAtMs });
      continue;
    }

    candidates.push({
      ...member,
      leastLimitedScore: resolveLeastLimitedScore(quotaSnapshot),
    });
  }

  if (params.policy.strategy === 'least_limited') {
    candidates.sort((left, right) => {
      const leftScore = left.leastLimitedScore;
      const rightScore = right.leastLimitedScore;
      if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      if (leftScore !== null && rightScore === null) return -1;
      if (leftScore === null && rightScore !== null) return 1;
      return comparePriority(left, right);
    });
  } else {
    candidates.sort(comparePriority);
  }

  const softSwitchPreferred = resolveSoftSwitchPreferredCandidate({
    candidates,
    activeProfileId: params.activeProfileId,
    policy: params.policy,
    allowCurrentProfileRetry: params.allowCurrentProfileRetry,
  });

  return {
    selected: softSwitchPreferred ?? candidates[0] ?? null,
    reason: softSwitchPreferred || candidates[0] ? 'selected' : 'no_eligible_members',
    excluded,
  };
}
