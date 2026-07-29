import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol';

import {
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
} from '../state/memberRuntimeState';

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
  resumePromptMode: 'standard' | 'off' | 'custom';
}>;

/**
 * Derived from the protocol schema default so the daemon default never drifts from the canonical
 * `ConnectedServiceAuthGroupPolicyV1Schema` (single source of truth for policy defaults, including
 * the `strategy` default). A hardcoded literal here was a latent split-brain against the schema.
 * The daemon never writes policy back, so no migration is required.
 */
export const DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1: ConnectedServiceAuthGroupPolicyV1 =
  ConnectedServiceAuthGroupPolicyV1Schema.parse({});

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
  decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;

export type ConnectedServiceAuthGroupCandidateDecisionTrace = Readonly<{
  activeProfileId: string | null;
  reason: ConnectedServiceAuthGroupCandidateSelection['reason'];
  candidates: ReadonlyArray<ConnectedServiceAuthGroupCandidateDecisionTraceEntry>;
}>;

export type ConnectedServiceAuthGroupCandidateDecisionTraceEntry = Readonly<{
  profileId: string;
  decision: 'selected' | 'eligible' | 'excluded';
  exclusionReason?: ConnectedServiceAuthGroupCandidateExclusion['reason'];
  retryAtMs?: number | null;
  quotaEvidence: Readonly<{
    status: 'fresh' | 'stale_or_missing';
    remainingPercent?: number | null;
    capturedAtMs?: number;
    exhausted?: boolean;
  }>;
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
      | 'validation_blocked'
      | 'policy_wait_until_reset';
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

function credentialHealthAllowsSelection(status: ConnectedServiceCredentialHealthStatusV1 | null | undefined): boolean {
  return status === null
    || status === undefined
    || isConnectedServiceCredentialHealthStatusUsable(status);
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

function buildCandidateQuotaEvidenceTrace(snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null): ConnectedServiceAuthGroupCandidateDecisionTraceEntry['quotaEvidence'] {
  if (!snapshot) {
    return { status: 'stale_or_missing' };
  }
  return {
    status: 'fresh',
    remainingPercent: resolveLeastLimitedScore(snapshot),
    capturedAtMs: snapshot.capturedAtMs,
    exhausted: isQuotaExhausted(snapshot),
  };
}

function requiresFreshQuotaEvidenceForSwitchReason(reason: string): boolean {
  return reason === 'usage_limit'
    || reason === 'rate_limit'
    || reason === 'soft_threshold';
}

function allowsUnknownQuotaEvidenceForSwitchReason(reason: string): boolean {
  return reason === 'usage_limit'
    || reason === 'same_provider_account_exhausted';
}

export function hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason(
  params: ConnectedServiceAuthGroupSwitchReasonEvidenceInput,
): boolean {
  if (
    !requiresFreshQuotaEvidenceForSwitchReason(params.reason)
    && !allowsUnknownQuotaEvidenceForSwitchReason(params.reason)
  ) {
    return true;
  }
  const state = params.memberStatesByProfileId.get(params.profileId) ?? null;
  const quotaSnapshot = isFreshQuotaSnapshot(state?.quotaSnapshot, params.nowMs, params.quotaFreshnessMs)
    ? state?.quotaSnapshot ?? null
    : null;
  if (!quotaSnapshot) return allowsUnknownQuotaEvidenceForSwitchReason(params.reason);
  if (quotaSnapshot.planUnavailable) return false;
  if (resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs)) return false;
  return !isQuotaExhausted(quotaSnapshot);
}

function resolveSoftSwitchRemainingPercent(policy: ConnectedServiceAuthGroupPolicyV1): number | null {
  const value = numberOrNull(policy.softSwitchRemainingPercent);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

export function isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter(input: Readonly<{
  activeProfileId: string | null;
  candidate: ConnectedServiceAuthGroupCandidate;
  policy: ConnectedServiceAuthGroupPolicyV1;
}>): boolean {
  if (input.activeProfileId && input.candidate.profileId === input.activeProfileId) return false;
  const threshold = resolveSoftSwitchRemainingPercent(input.policy);
  if (threshold === null) return false;
  const candidateScore = input.candidate.leastLimitedScore;
  return candidateScore !== null && candidateScore > threshold;
}

export type ConnectedServiceAuthGroupSoftSwitchSourceEvidence = Readonly<
  | { status: 'at_or_below_threshold'; remainingPercent: number; thresholdPercent: number; projected?: true }
  | { status: 'above_threshold'; remainingPercent: number; thresholdPercent: number }
  | { status: 'unknown'; reason: 'missing_active_profile' | 'missing_fresh_quota_snapshot' | 'missing_remaining_percent' | 'missing_soft_switch_threshold' }
>;

/**
 * Recent consumption velocity of the active member's remaining%, used to PREEMPT a soft-switch when
 * the current snapshot is still healthy but a fast burn will cross the threshold within the horizon.
 * `remainingPercentPerMs` must be a positive burn (remaining decreasing); the horizon is the
 * projection window (derive it from the existing `probeIfSnapshotOlderThanMs` — the next check
 * window — so no new policy knob is introduced).
 */
export type ConnectedServiceAuthGroupSoftSwitchBurnProjection = Readonly<{
  remainingPercentPerMs: number;
  horizonMs: number;
}>;

function projectBurnedRemainingPercent(
  remainingPercent: number,
  burnProjection: ConnectedServiceAuthGroupSoftSwitchBurnProjection | null | undefined,
): number | null {
  if (!burnProjection) return null;
  const { remainingPercentPerMs, horizonMs } = burnProjection;
  if (!Number.isFinite(remainingPercentPerMs) || remainingPercentPerMs <= 0) return null;
  if (!Number.isFinite(horizonMs) || horizonMs <= 0) return null;
  return remainingPercent - remainingPercentPerMs * horizonMs;
}

export function resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence(input: Readonly<{
  activeProfileId: string | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  nowMs: number;
  quotaFreshnessMs: number;
  burnProjection?: ConnectedServiceAuthGroupSoftSwitchBurnProjection | null;
}>): ConnectedServiceAuthGroupSoftSwitchSourceEvidence {
  const activeProfileId = input.activeProfileId?.trim() ?? '';
  if (!activeProfileId) return { status: 'unknown', reason: 'missing_active_profile' };
  const threshold = resolveSoftSwitchRemainingPercent(input.policy);
  if (threshold === null) return { status: 'unknown', reason: 'missing_soft_switch_threshold' };
  const state = input.memberStatesByProfileId.get(activeProfileId) ?? null;
  const quotaSnapshot = isFreshQuotaSnapshot(state?.quotaSnapshot, input.nowMs, input.quotaFreshnessMs)
    ? state?.quotaSnapshot ?? null
    : null;
  if (!quotaSnapshot) return { status: 'unknown', reason: 'missing_fresh_quota_snapshot' };
  const remainingPercent = resolveLeastLimitedScore(quotaSnapshot);
  if (remainingPercent === null) return { status: 'unknown', reason: 'missing_remaining_percent' };
  if (remainingPercent <= threshold) {
    return { status: 'at_or_below_threshold', remainingPercent, thresholdPercent: threshold };
  }
  // Preemptive: the current snapshot is above the threshold, but the projected next-window remaining
  // (current burn rate × horizon) crosses it. Fire the soft-switch BEFORE the turn burns through —
  // reusing the SAME threshold semantics, not a new knob.
  const projectedRemaining = projectBurnedRemainingPercent(remainingPercent, input.burnProjection);
  if (projectedRemaining !== null && projectedRemaining <= threshold) {
    return { status: 'at_or_below_threshold', remainingPercent, thresholdPercent: threshold, projected: true };
  }
  return { status: 'above_threshold', remainingPercent, thresholdPercent: threshold };
}

function resolveCurrentCandidate(
  candidates: ReadonlyArray<ConnectedServiceAuthGroupCandidate>,
  activeProfileId: string | null,
): ConnectedServiceAuthGroupCandidate | null {
  if (!activeProfileId) return null;
  return candidates.find((candidate) => candidate.profileId === activeProfileId) ?? null;
}

/**
 * "Reset landed" signal, sharing the same `providerResetsAtMs` datum that `honorProviderResetsAt`
 * consumes as a cooldown floor (see `resolveCooldownRetryAtMs`): the member was assigned a provider
 * reset because it hit a limit, and that reset time is now in the past. Paired with an existing
 * limiter-context marker so a never-limited member (whose `providerResetsAtMs` is merely a future
 * scheduled window, or absent) is never treated as "recovered from a limit". This is the
 * "we are off the primary BECAUSE it was limited AND its limit has since reset" precondition.
 */
function primaryLeftForLimitAndResetLanded(
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
  nowMs: number,
): boolean {
  const providerResetsAtMs = numberOrNull(state?.providerResetsAtMs);
  if (providerResetsAtMs === null || providerResetsAtMs > nowMs) return false;
  return numberOrNull(state?.exhaustedUntilMs) !== null
    || numberOrNull(state?.quotaExhaustedUntilMs) !== null
    || numberOrNull(state?.rateLimitedUntilMs) !== null
    || numberOrNull(state?.cooldownStartedAtMs) !== null
    || numberOrNull(state?.cooldownUntilMs) !== null
    || state?.lastFailureKind === 'usage_limit'
    || state?.lastFailureKind === 'rate_limit'
    || state?.lastFailureKind === 'capacity';
}

/**
 * Restore the priority-primary member as the selection target — overriding priority ranking and the
 * soft-switch "stay put" decision — when the group had switched away from it because it was limited
 * and that limit has since reset. Opt-in via `policy.autoRestorePrimaryWhenReset`. Gated so restore
 * does EXACTLY what its name promises:
 *  - F3: only under `strategy === 'priority'`. Under `least_limited` there is no fixed primary
 *    (selection is headroom-based and members commonly share the default priority), so restore
 *    would silently pin the pool to the oldest account — never do that.
 *  - F2: only when the primary actually left BECAUSE it was limited and its provider reset has
 *    landed (`primaryLeftForLimitAndResetLanded`). A primary that was never limited (e.g. after a
 *    manual "Make Active" to a backup) carries no landed-reset marker, so a manual/among-equals
 *    choice is never bounced back, and a still-pending reset is not restored early.
 *  - F1: fail closed on unknown headroom. Without a fresh score we cannot prove the primary has
 *    enough headroom to avoid an immediate soft-switch-away (flap), so treat unknown as not-safe.
 * Reuses the existing eligibility machinery (`candidates`) and the same preferred-candidate
 * override seam as soft-switch — no new switch path.
 */
function resolvePrimaryRestorePreferredCandidate(params: Readonly<{
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  candidates: ReadonlyArray<ConnectedServiceAuthGroupCandidate>;
  activeProfileId: string | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  nowMs: number;
}>): ConnectedServiceAuthGroupCandidate | null {
  if (!params.policy.autoRestorePrimaryWhenReset) return null;
  if (params.policy.strategy !== 'priority') return null;
  if (!params.activeProfileId) return null;
  const primaryMember = params.members
    .filter((candidate) => candidate.enabled)
    .slice()
    .sort(comparePriority)[0] ?? null;
  if (!primaryMember) return null;
  if (primaryMember.profileId === params.activeProfileId) return null;
  const primaryCandidate = params.candidates.find((candidate) => candidate.profileId === primaryMember.profileId) ?? null;
  if (!primaryCandidate) return null;
  const primaryState = params.memberStatesByProfileId.get(primaryMember.profileId) ?? null;
  if (!primaryLeftForLimitAndResetLanded(primaryState, params.nowMs)) return null;
  if (primaryCandidate.leastLimitedScore === null) return null;
  const threshold = resolveSoftSwitchRemainingPercent(params.policy);
  if (threshold !== null && primaryCandidate.leastLimitedScore <= threshold) {
    return null;
  }
  return primaryCandidate;
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
    return {
      selected: null,
      reason: 'manual_strategy',
      excluded: [],
      decisionTrace: {
        activeProfileId: params.activeProfileId,
        reason: 'manual_strategy',
        candidates: [],
      },
    };
  }

  const excluded: ConnectedServiceAuthGroupCandidateExclusion[] = [];
  const candidates: ConnectedServiceAuthGroupCandidate[] = [];
  const decisionTraceCandidates: ConnectedServiceAuthGroupCandidateDecisionTraceEntry[] = [];

  for (const member of params.members) {
    const state = params.memberStatesByProfileId.get(member.profileId) ?? null;
    const quotaSnapshot = isFreshQuotaSnapshot(state?.quotaSnapshot, params.nowMs, params.quotaFreshnessMs)
      ? state?.quotaSnapshot ?? null
      : null;
    const effectiveState = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      state,
      quotaSnapshot,
      policy: params.policy,
      nowMs: params.nowMs,
    });
    const quotaEvidence = buildCandidateQuotaEvidenceTrace(quotaSnapshot);
    const exclude = (
      reason: ConnectedServiceAuthGroupCandidateExclusion['reason'],
      retryAtMs?: number | null,
    ): void => {
      excluded.push({ profileId: member.profileId, reason, ...(retryAtMs === undefined ? {} : { retryAtMs }) });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: reason,
        ...(retryAtMs === undefined ? {} : { retryAtMs }),
        quotaEvidence,
      });
    };

    if (!member.enabled) {
      exclude('disabled');
      continue;
    }
    if (!params.allowCurrentProfileRetry && params.activeProfileId === member.profileId) {
      exclude('current_active');
      continue;
    }
    if (!credentialHealthAllowsSelection(effectiveState?.credentialHealthStatus)) {
      exclude('auth_invalid');
      continue;
    }
    const stateBlocker = resolveStateBlocker(effectiveState, params.nowMs);
    if (stateBlocker) {
      exclude(stateBlocker.reason, stateBlocker.retryAtMs);
      continue;
    }
    const snapshotBlocker = resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs);
    if (snapshotBlocker) {
      exclude(snapshotBlocker.reason, snapshotBlocker.retryAtMs);
      continue;
    }
    if (quotaSnapshot && isQuotaExhausted(quotaSnapshot)) {
      exclude('quota_exhausted', resolveQuotaSnapshotExhaustionRetryAtMs(quotaSnapshot, state, params.nowMs));
      continue;
    }
    const recentLimiterRetry = resolveRecentLimiterRetry({
      state: effectiveState,
      policy: params.policy,
      nowMs: params.nowMs,
    });
    if (recentLimiterRetry !== null) {
      exclude(recentLimiterRetry.reason, recentLimiterRetry.retryAtMs);
      continue;
    }
    const persistedQuotaRetryAtMs = resolveQuotaRuntimeExhaustion(effectiveState, params.nowMs);
    if (persistedQuotaRetryAtMs !== null) {
      exclude('quota_exhausted', persistedQuotaRetryAtMs);
      continue;
    }

    const cooldownRetryAtMs = resolveCooldownRetryAtMs({
      policy: params.policy,
      state: effectiveState,
      nowMs: params.nowMs,
    });
    if (cooldownRetryAtMs !== null) {
      exclude('cooldown', cooldownRetryAtMs);
      continue;
    }

    candidates.push({
      ...member,
      leastLimitedScore: resolveLeastLimitedScore(quotaSnapshot),
    });
    decisionTraceCandidates.push({
      profileId: member.profileId,
      decision: 'eligible',
      quotaEvidence,
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

  const primaryRestorePreferred = resolvePrimaryRestorePreferredCandidate({
    members: params.members,
    candidates,
    activeProfileId: params.activeProfileId,
    policy: params.policy,
    memberStatesByProfileId: params.memberStatesByProfileId,
    nowMs: params.nowMs,
  });

  const softSwitchPreferred = resolveSoftSwitchPreferredCandidate({
    candidates,
    activeProfileId: params.activeProfileId,
    policy: params.policy,
    allowCurrentProfileRetry: params.allowCurrentProfileRetry,
  });

  const selected = primaryRestorePreferred ?? softSwitchPreferred ?? candidates[0] ?? null;
  const reason = selected ? 'selected' : 'no_eligible_members';
  return {
    selected,
    reason,
    excluded,
    decisionTrace: {
      activeProfileId: params.activeProfileId,
      reason,
      candidates: decisionTraceCandidates.map((candidate) => (
        selected && candidate.profileId === selected.profileId
          ? { ...candidate, decision: 'selected' }
          : candidate
      )),
    },
  };
}
