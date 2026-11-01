import type { ProviderLimitCategory } from '../../quotas/normalization';
import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  isConnectedServiceQuotaObservationFresh,
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceCredentialHealthStatusV1,
  type ProviderAccountSubscriptionV1,
  type ConnectedServiceAuthGroupPolicyV1 as ProtocolConnectedServiceAuthGroupPolicyV1,
} from '@happier-dev/protocol';
import {
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
  reconcileMemberRuntimeStateWithPositiveEvidence,
  type ConnectedServiceAuthGroupPositiveEvidence,
} from '../memberRuntimeState';

export {
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
  reconcileMemberRuntimeStateWithPositiveEvidence,
  type ConnectedServiceAuthGroupPositiveEvidence,
} from '../memberRuntimeState';

export type ConnectedServiceAuthGroupPolicyV1 = Readonly<ProtocolConnectedServiceAuthGroupPolicyV1>;

/**
 * Derived from the protocol schema default so the daemon default never drifts from the canonical
 * `ConnectedServiceAuthGroupPolicyV1Schema` (single source of truth for policy defaults, including
 * `strategy: 'expiry_first'`). A hardcoded literal here was a latent split-brain against the
 * schema. The daemon never writes policy back, so no migration is required.
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
  limitCategory: ProviderLimitCategory;
  remainingPct: number | null;
  resetAtMs: number | null;
  providerLimitId: string | null;
  windowDurationMs?: number | null;
  reliable?: boolean;
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
  subscription?: ProviderAccountSubscriptionV1;
  credentialHealthStatus?: ConnectedServiceCredentialHealthStatusV1 | null;
  cooldownStartedAtMs?: number | null;
  cooldownUntilMs?: number | null;
  exhaustedUntilMs?: number | null;
  quotaExhaustedUntilMs?: number | null;
  rateLimitedUntilMs?: number | null;
  capacityLimitedUntilMs?: number | null;
  authInvalidUntilMs?: number | null;
  planUnavailableUntilMs?: number | null;
  modelUnavailableUntilMsByModelId?: Readonly<Record<string, number>>;
  validationBlockedUntilMs?: number | null;
  providerResetsAtMs?: number | null;
  lastFailureKind?: string | null;
  lastFailureCode?: string | null;
  autoDisabledReason?: 'model_not_entitled' | null;
  lastObservedAtMs?: number | null;
  quotaSnapshot?: ConnectedServiceAuthGroupQuotaSnapshot | null;
}>;

export type ConnectedServiceAuthGroupCandidate = ConnectedServiceAuthGroupMember & Readonly<{
  leastLimitedScore: number | null;
  preferenceDeadlineMs?: number | null;
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
      | 'quota_probe_deferred'
      | 'disabled'
      | 'cooldown'
      | 'quota_exhausted'
      | 'capacity_limited'
      | 'auth_invalid'
      | 'credential_unavailable'
      | 'quota_evidence_unavailable'
      | 'soft_threshold_not_met'
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

export function resolveConnectedServiceAuthGroupPriorityPrimaryProfileId(
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>,
): string | null {
  return members
    .filter((candidate) => candidate.enabled)
    .slice()
    .sort(comparePriority)[0]?.profileId ?? null;
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

function resolveSnapshotEligibilityBlocker(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  nowMs: number,
): ConnectedServiceAuthGroupCandidateExclusion['reason'] extends infer Reason
  ? Readonly<{ reason: Extract<Reason, 'capacity_limited' | 'auth_invalid' | 'plan_unavailable' | 'validation_blocked'>; retryAtMs?: number | null }> | null
  : never {
  const meters = snapshot?.meters ?? [];
  if (meters.length === 0) return null;
  if (meters.some((meter) => meter.limitCategory === 'usage_limit' || meter.limitCategory === 'rate_limit' || meter.limitCategory === 'unknown')) {
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
  if (categories.has('plan_invalid')) {
    return { reason: 'plan_unavailable', retryAtMs };
  }
  if (categories.has('validation_failed')) {
    return { reason: 'validation_blocked', retryAtMs };
  }
  if (categories.has('capacity')) {
    return { reason: 'capacity_limited', retryAtMs };
  }
  return null;
}

function isFreshQuotaSnapshot(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null | undefined,
  nowMs: number,
  quotaFreshnessMs: number,
): snapshot is ConnectedServiceAuthGroupQuotaSnapshot {
  if (!snapshot) return false;
  return isQuotaSnapshotWithinFreshnessWindow(snapshot, nowMs, quotaFreshnessMs);
}

function isQuotaSnapshotWithinFreshnessWindow(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  nowMs: number,
  quotaFreshnessMs: number,
): boolean {
  return isConnectedServiceQuotaObservationFresh({
    observedAtMs: snapshot.capturedAtMs,
    nowMs,
    maxAgeMs: quotaFreshnessMs,
  });
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

/** A reset is a quota remedy, not a fallback for every reason a pool cannot select. */
export function resolveConnectedServiceAuthGroupQuotaResetCandidates(
  params: Parameters<typeof selectConnectedServiceAuthGroupCandidate>[0],
): ReadonlyArray<ConnectedServiceAuthGroupMember & Readonly<{ providerLimitIds: ReadonlyArray<string> }>> {
  const selection = selectConnectedServiceAuthGroupCandidate({ ...params, allowCurrentProfileRetry: true });
  if (selection.selected || selection.reason === 'manual_strategy') return [];
  const resettable = new Set<string>();
  for (const excluded of selection.excluded) {
    if (excluded.reason === 'disabled' || excluded.reason === 'auth_invalid' || excluded.reason === 'plan_unavailable') continue;
    if (excluded.reason !== 'quota_exhausted') return [];
    const snapshot = params.memberStatesByProfileId.get(excluded.profileId)?.quotaSnapshot;
    if (!isFreshQuotaSnapshot(snapshot, params.nowMs, params.quotaFreshnessMs) || !snapshot) return [];
    // A banked usage reset cannot repair request-rate or capacity throttling. Require the
    // actual usage-window evidence, not a generic effective meter or a persisted cooldown.
    if (!(snapshot.meters ?? []).some((meter) => isQuotaMeter(meter) && meterIsExhausted(meter))) return [];
    if ((snapshot.meters ?? []).some((meter) => isRateLimitMeter(meter) && meterIsExhausted(meter))) return [];
    resettable.add(excluded.profileId);
  }
  return params.members.filter((member) => resettable.has(member.profileId)).sort(comparePriority).map((member) => ({
    ...member,
    providerLimitIds: [...new Set((params.memberStatesByProfileId.get(member.profileId)?.quotaSnapshot?.meters ?? [])
      .filter((meter) => isQuotaMeter(meter) && meterIsExhausted(meter))
      .map((meter) => meter.providerLimitId?.trim())
      .filter((id): id is string => Boolean(id)))],
  }));
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
    || reason === 'soft_threshold'
    || reason === 'auth_expired'
    || reason === 'account_disabled'
    || reason === 'account_changed'
    || reason === 'refresh_failed';
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
  const quotaSnapshot = state?.quotaSnapshot ?? null;
  if (!quotaSnapshot) return { status: 'unknown', reason: 'missing_fresh_quota_snapshot' };
  const remainingPercent = resolveLeastLimitedScore(quotaSnapshot);
  if (remainingPercent === null) return { status: 'unknown', reason: 'missing_remaining_percent' };
  const fresh = isQuotaSnapshotWithinFreshnessWindow(
    quotaSnapshot,
    input.nowMs,
    input.quotaFreshnessMs,
  );
  if (!fresh) {
    // Source and candidate evidence are intentionally asymmetric. A measured low source remains a
    // safe reason to leave that source until its exact quota window resets; a candidate must still
    // be fresh before we move work onto it. Unknown or elapsed reset boundaries fail closed.
    const effectiveMeterId = quotaSnapshot.effectiveMeterId?.trim() ?? '';
    const effectiveMeter = effectiveMeterId
      ? quotaSnapshot.meters?.find((meter) => meter.meterId === effectiveMeterId) ?? null
      : null;
    const resetAtMs = numberOrNull(effectiveMeter?.resetAtMs);
    if (
      remainingPercent > threshold
      || resetAtMs === null
      || resetAtMs <= input.nowMs
    ) {
      return { status: 'unknown', reason: 'missing_fresh_quota_snapshot' };
    }
  }
  if (remainingPercent <= threshold) {
    return { status: 'at_or_below_threshold', remainingPercent, thresholdPercent: threshold };
  }
  if (!fresh) return { status: 'unknown', reason: 'missing_fresh_quota_snapshot' };
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
 * Restore an eligible priority primary on fresh healthy quota after an automatic limit fallback.
 * Group switch provenance survives member failure-state reconciliation and also distinguishes a
 * deliberate manual selection. Older groups without provenance retain their landed-reset proof.
 * Eligibility and fresh headroom remain owned by the normal candidate path.
 */
function resolvePrimaryRestorePreferredCandidate(params: Readonly<{
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  candidates: ReadonlyArray<ConnectedServiceAuthGroupCandidate>;
  activeProfileId: string | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  nowMs: number;
  lastSwitchReason?: string | null;
  lastSwitchAt?: number | null;
}>): ConnectedServiceAuthGroupCandidate | null {
  if (!params.policy.autoRestorePrimaryWhenReset) return null;
  if (params.policy.strategy !== 'priority') return null;
  if (!params.activeProfileId) return null;
  const primaryProfileId = resolveConnectedServiceAuthGroupPriorityPrimaryProfileId(params.members);
  if (!primaryProfileId || primaryProfileId === params.activeProfileId) return null;
  const primaryCandidate = params.candidates.find((candidate) => candidate.profileId === primaryProfileId) ?? null;
  if (!primaryCandidate) return null;
  const primaryState = params.memberStatesByProfileId.get(primaryProfileId) ?? null;
  if (params.lastSwitchReason) {
    if (!['usage_limit', 'rate_limit', 'capacity', 'soft_threshold', 'same_provider_account_exhausted'].includes(params.lastSwitchReason)) return null;
    const capturedAtMs = numberOrNull(primaryState?.quotaSnapshot?.capturedAtMs);
    const lastSwitchAt = numberOrNull(params.lastSwitchAt);
    if (lastSwitchAt !== null && (capturedAtMs === null || capturedAtMs <= lastSwitchAt)) return null;
  } else if (!primaryLeftForLimitAndResetLanded(primaryState, params.nowMs)) {
    return null;
  }
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

function compareLeastLimited(left: ConnectedServiceAuthGroupCandidate, right: ConnectedServiceAuthGroupCandidate): number {
  const leftScore = left.leastLimitedScore;
  const rightScore = right.leastLimitedScore;
  if (leftScore !== null && rightScore !== null && leftScore !== rightScore) return rightScore - leftScore;
  if (leftScore !== null && rightScore === null) return -1;
  if (leftScore === null && rightScore !== null) return 1;
  return comparePriority(left, right);
}

function resolvePreferenceDeadline(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  subscription: ProviderAccountSubscriptionV1 | undefined,
  nowMs: number,
): number | null {
  // Prefer the long allowance, not an incidental short-window reset. When duration is
  // unknown, use the existing effective allowance rather than guessing from labels.
  const usable = (snapshot?.meters ?? []).filter((meter) => meter.limitCategory === 'usage_limit'
    && meter.reliable !== false && meter.remainingPct !== null && meter.remainingPct > 0);
  const longestDuration = Math.max(0, ...usable.map((meter) => meter.windowDurationMs ?? 0));
  const relevant = longestDuration > 0
    ? usable.filter((meter) => meter.windowDurationMs === longestDuration)
    : usable.filter((meter) => meter.meterId === snapshot?.effectiveMeterId);
  const deadlines = relevant.map((meter) => meter.resetAtMs)
    .filter((date): date is number => date !== null && Number.isFinite(date) && date > nowMs);
  if (subscription?.status === 'subscribed' && subscription.renewal === 'off'
    && subscription.observedAtMs <= nowMs && nowMs - subscription.observedAtMs <= subscription.staleAfterMs
    && subscription.currentPeriodEndAtMs !== undefined && subscription.currentPeriodEndAtMs > nowMs) {
    deadlines.push(subscription.currentPeriodEndAtMs);
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

export function selectConnectedServiceAuthGroupCandidate(params: Readonly<{
  nowMs: number;
  quotaFreshnessMs: number;
  activeProfileId: string | null;
  lastSwitchReason?: string | null;
  lastSwitchAt?: number | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  allowCurrentProfileRetry?: boolean;
  unavailableProfileIds?: ReadonlySet<string>;
  providerLimitId?: string | null;
  requiredModelIds?: ReadonlyArray<string>;
  quotaProbeDeferredUntilMsByProfileId?: ReadonlyMap<string, number>;
  switchReason?: string;
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
  const decisionTraceCandidates: Array<{
    profileId: string;
    decision: 'selected' | 'eligible' | 'excluded';
    exclusionReason?: ConnectedServiceAuthGroupCandidateExclusion['reason'];
    retryAtMs?: number | null;
    quotaEvidence: ConnectedServiceAuthGroupCandidateDecisionTraceEntry['quotaEvidence'];
  }> = [];

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
    if (!member.enabled || effectiveState?.autoDisabledReason === 'model_not_entitled') {
      excluded.push({ profileId: member.profileId, reason: 'disabled' });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'disabled',
        quotaEvidence,
      });
      continue;
    }
    const probeRetryAtMs = params.quotaProbeDeferredUntilMsByProfileId?.get(member.profileId);
    if (probeRetryAtMs !== undefined && probeRetryAtMs > params.nowMs) {
      excluded.push({ profileId: member.profileId, reason: 'quota_probe_deferred', retryAtMs: probeRetryAtMs });
      decisionTraceCandidates.push({ profileId: member.profileId, decision: 'excluded',
        exclusionReason: 'quota_probe_deferred', retryAtMs: probeRetryAtMs, quotaEvidence });
      continue;
    }
    if (!credentialHealthAllowsSelection(effectiveState?.credentialHealthStatus)) {
      excluded.push({ profileId: member.profileId, reason: 'auth_invalid' });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'auth_invalid',
        quotaEvidence,
      });
      continue;
    }
    if (!params.allowCurrentProfileRetry && params.activeProfileId === member.profileId) {
      excluded.push({ profileId: member.profileId, reason: 'current_active' });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'current_active',
        quotaEvidence,
      });
      continue;
    }
    if (params.unavailableProfileIds?.has(member.profileId)) {
      excluded.push({ profileId: member.profileId, reason: 'credential_unavailable' });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'credential_unavailable',
        quotaEvidence,
      });
      continue;
    }
    const requiredModelIds = [...(params.requiredModelIds ?? []), params.providerLimitId ?? ''];
    const modelUnavailableUntilMs = requiredModelIds.reduce<number | null>((latest, modelId) => {
      const untilMs = numberOrNull(effectiveState?.modelUnavailableUntilMsByModelId?.[modelId.trim()]);
      return untilMs !== null && untilMs > params.nowMs ? Math.max(latest ?? untilMs, untilMs) : latest;
    }, null);
    if (modelUnavailableUntilMs !== null && modelUnavailableUntilMs > params.nowMs) {
      excluded.push({ profileId: member.profileId, reason: 'plan_unavailable', retryAtMs: modelUnavailableUntilMs });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'plan_unavailable',
        retryAtMs: modelUnavailableUntilMs,
        quotaEvidence,
      });
      continue;
    }
    const stateBlocker = resolveStateBlocker(effectiveState, params.nowMs);
    if (stateBlocker) {
      excluded.push({ profileId: member.profileId, reason: stateBlocker.reason, retryAtMs: stateBlocker.retryAtMs });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: stateBlocker.reason,
        retryAtMs: stateBlocker.retryAtMs,
        quotaEvidence,
      });
      continue;
    }
    const snapshotBlocker = resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs);
    if (snapshotBlocker) {
      excluded.push({
        profileId: member.profileId,
        reason: snapshotBlocker.reason,
        ...(snapshotBlocker.retryAtMs === null || snapshotBlocker.retryAtMs === undefined ? {} : { retryAtMs: snapshotBlocker.retryAtMs }),
      });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: snapshotBlocker.reason,
        ...(snapshotBlocker.retryAtMs === null || snapshotBlocker.retryAtMs === undefined ? {} : { retryAtMs: snapshotBlocker.retryAtMs }),
        quotaEvidence,
      });
      continue;
    }
    if (quotaSnapshot && isQuotaExhausted(quotaSnapshot)) {
      const retryAtMs = resolveQuotaSnapshotExhaustionRetryAtMs(quotaSnapshot, effectiveState, params.nowMs);
      excluded.push({
        profileId: member.profileId,
        reason: 'quota_exhausted',
        retryAtMs,
      });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'quota_exhausted',
        retryAtMs,
        quotaEvidence,
      });
      continue;
    }
    const effectiveRecentLimiterRetry = resolveRecentLimiterRetry({
      state: effectiveState,
      policy: params.policy,
      nowMs: params.nowMs,
    });
    if (effectiveRecentLimiterRetry !== null) {
      excluded.push({
        profileId: member.profileId,
        reason: effectiveRecentLimiterRetry.reason,
        retryAtMs: effectiveRecentLimiterRetry.retryAtMs,
      });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: effectiveRecentLimiterRetry.reason,
        retryAtMs: effectiveRecentLimiterRetry.retryAtMs,
        quotaEvidence,
      });
      continue;
    }
    const persistedQuotaRetryAtMs = resolveQuotaRuntimeExhaustion(effectiveState, params.nowMs);
    if (persistedQuotaRetryAtMs !== null) {
      excluded.push({ profileId: member.profileId, reason: 'quota_exhausted', retryAtMs: persistedQuotaRetryAtMs });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'quota_exhausted',
        retryAtMs: persistedQuotaRetryAtMs,
        quotaEvidence,
      });
      continue;
    }

    const cooldownRetryAtMs = resolveCooldownRetryAtMs({
      policy: params.policy,
      state: effectiveState,
      nowMs: params.nowMs,
    });
    if (cooldownRetryAtMs !== null) {
      excluded.push({ profileId: member.profileId, reason: 'cooldown', retryAtMs: cooldownRetryAtMs });
      decisionTraceCandidates.push({
        profileId: member.profileId,
        decision: 'excluded',
        exclusionReason: 'cooldown',
        retryAtMs: cooldownRetryAtMs,
        quotaEvidence,
      });
      continue;
    }

    const candidate: ConnectedServiceAuthGroupCandidate = {
      ...member,
      leastLimitedScore: resolveLeastLimitedScore(quotaSnapshot),
      ...(params.policy.strategy === 'expiry_first' ? {
        preferenceDeadlineMs: resolvePreferenceDeadline(quotaSnapshot, state?.subscription, params.nowMs),
      } : {}),
    };
    if (params.switchReason === 'soft_threshold' && member.profileId !== params.activeProfileId) {
      const exclusionReason = !hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
        reason: params.switchReason, profileId: member.profileId, nowMs: params.nowMs,
        quotaFreshnessMs: params.quotaFreshnessMs, memberStatesByProfileId: params.memberStatesByProfileId,
      }) ? 'quota_evidence_unavailable' as const
        : !isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter({
          activeProfileId: params.activeProfileId, candidate, policy: params.policy,
        }) ? 'soft_threshold_not_met' as const : null;
      if (exclusionReason) {
        excluded.push({ profileId: member.profileId, reason: exclusionReason });
        decisionTraceCandidates.push({ profileId: member.profileId, decision: 'excluded', exclusionReason, quotaEvidence });
        continue;
      }
    }
    decisionTraceCandidates.push({
      profileId: member.profileId,
      decision: 'eligible',
      quotaEvidence,
    });
    candidates.push(candidate);
  }

  if (params.policy.strategy === 'expiry_first') {
    candidates.sort((left, right) => {
      const leftAdequate = left.leastLimitedScore !== null && left.leastLimitedScore > params.policy.softSwitchRemainingPercent;
      const rightAdequate = right.leastLimitedScore !== null && right.leastLimitedScore > params.policy.softSwitchRemainingPercent;
      if (leftAdequate !== rightAdequate) return leftAdequate ? -1 : 1;
      if (leftAdequate && rightAdequate) {
        const deadlineDifference = (left.preferenceDeadlineMs ?? Infinity) - (right.preferenceDeadlineMs ?? Infinity);
        if (deadlineDifference < 0 || deadlineDifference > 0) return deadlineDifference;
      }
      return compareLeastLimited(left, right);
    });
  } else if (params.policy.strategy === 'least_limited') {
    candidates.sort(compareLeastLimited);
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
    lastSwitchReason: params.lastSwitchReason,
    lastSwitchAt: params.lastSwitchAt,
  });

  const softSwitchPreferred = resolveSoftSwitchPreferredCandidate({
    candidates,
    activeProfileId: params.activeProfileId,
    policy: params.policy,
    allowCurrentProfileRetry: params.allowCurrentProfileRetry,
  });

  const selected = primaryRestorePreferred ?? softSwitchPreferred ?? candidates[0] ?? null;
  const reason = selected ? 'selected' : 'no_eligible_members';
  if (selected) {
    const selectedTraceCandidate = decisionTraceCandidates.find((candidate) => candidate.profileId === selected.profileId);
    if (selectedTraceCandidate) selectedTraceCandidate.decision = 'selected';
  }

  return {
    selected,
    reason,
    excluded,
    decisionTrace: {
      activeProfileId: params.activeProfileId,
      reason,
      candidates: decisionTraceCandidates,
    },
  };
}
