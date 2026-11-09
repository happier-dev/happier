import { ConnectedServiceAuthGroupPolicyV2Schema, isConnectedServiceCredentialHealthStatusUsable } from '@happier-dev/protocol/connect/connected-service-schemas';
import { isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';
import type { ConnectedServicePoolSelectionV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { ConnectedServiceAuthGroupPolicyV2, ConnectedServiceCredentialHealthStatusV1, ConnectedServiceLimitCategoryV1, ProviderAccountSubscriptionV1 } from '@happier-dev/protocol';

import {
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
} from '../state/memberRuntimeState';

export type { ConnectedServiceAuthGroupPolicyV2 } from '@happier-dev/protocol';

/**
 * Derived from the protocol schema default so the daemon default never drifts from the canonical
 * `ConnectedServiceAuthGroupPolicyV2Schema` (single source of truth for policy defaults, including
 * the `strategy` default). A hardcoded literal here was a latent split-brain against the schema.
 * The daemon never writes policy back, so no migration is required.
 */
export const DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2: ConnectedServiceAuthGroupPolicyV2 =
  ConnectedServiceAuthGroupPolicyV2Schema.parse({});

export type ConnectedServiceAuthGroupMember = Readonly<{
  profileId: string;
  priority: number;
  createdAtMs: number;
  enabled: boolean;
}>;

export type ConnectedServiceAuthGroupQuotaMeterSnapshot = Readonly<{
  meterId: string;
  modelId?: string | null;
  limitCategory: ConnectedServiceLimitCategoryV1;
  remainingPct: number | null;
  resetAtMs: number | null;
  providerLimitId: string | null;
  windowDurationMs?: number | null;
  reliable?: boolean;
}>;

export type ConnectedServiceAuthGroupQuotaSnapshot = Readonly<{
  capturedAtMs: number;
  staleAfterMs: number;
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
  lastFailureProviderLimitId?: string | null;
  lastFailureCode?: string | null;
  autoDisabledReason?: 'model_not_entitled' | null;
  lastObservedAtMs?: number | null;
  quotaSnapshot?: ConnectedServiceAuthGroupQuotaSnapshot | null;
}>;

export type ConnectedServiceAuthGroupCandidate = ConnectedServiceAuthGroupMember & Readonly<{
  leastLimitedScore: number | null;
  preferenceDeadlineMs?: number | null;
}>;

export function resolveConnectedServiceAuthGroupModelEligibilityBlocker(input: Readonly<{
  state: ConnectedServiceAuthGroupMemberRuntimeState | null | undefined;
  modelId: string | null | undefined;
  nowMs: number;
}>): Readonly<{ reason: 'plan_unavailable'; retryAtMs: number }> | null {
  const modelId = input.modelId?.trim();
  const untilMs = modelId ? numberOrNull(input.state?.modelUnavailableUntilMsByModelId?.[modelId]) : null;
  return untilMs !== null && untilMs > input.nowMs ? { reason: 'plan_unavailable', retryAtMs: untilMs } : null;
}

export type ConnectedServiceAuthGroupCandidateSelection = Readonly<{
  selected: ConnectedServiceAuthGroupCandidate | null;
  reason: 'selected' | 'manual_strategy' | 'no_eligible_members';
  excluded: ReadonlyArray<ConnectedServiceAuthGroupCandidateExclusion>;
  decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace & Readonly<{
    strategy: ConnectedServiceAuthGroupPolicyV2['strategy'];
    selectionBasis: 'manual_strategy' | 'no_eligible_members' | 'preference' | 'primary_restore' | 'active_stickiness' | 'soft_switch';
    sticky: boolean;
    orderedEligibleCandidates: ReadonlyArray<ConnectedServiceAuthGroupCandidate>;
  }>;
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
  modelId?: string | null;
  reason: string;
  policy?: ConnectedServiceAuthGroupPolicyV2;
  providerLimitId?: string | null;
  profileId: string;
  nowMs: number;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>;

type ConnectedServiceAuthGroupCandidateExclusion = Readonly<ConnectedServicePoolSelectionV1['excluded'][number]>;

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
  policy: ConnectedServiceAuthGroupPolicyV2;
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

export function credentialHealthAllowsSelection(status: ConnectedServiceCredentialHealthStatusV1 | null | undefined): boolean {
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
  policy: ConnectedServiceAuthGroupPolicyV2;
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
): snapshot is ConnectedServiceAuthGroupQuotaSnapshot {
  if (!snapshot) return false;
  return isQuotaSnapshotWithinFreshnessWindow(snapshot, nowMs);
}

function isQuotaSnapshotWithinFreshnessWindow(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  nowMs: number,
): boolean {
  return isConnectedServiceQuotaObservationFresh({
    observedAtMs: snapshot.capturedAtMs,
    nowMs,
    maxAgeMs: snapshot.staleAfterMs,
  });
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

function selectedProviderLimitIds(
  policy: ConnectedServiceAuthGroupPolicyV2,
): ReadonlySet<string> | null {
  const selection = policy.quotaLimitSelection;
  if (!selection || selection.mode === 'all') return null;
  return new Set(selection.providerLimitIds);
}

/** One policy decision reused by periodic, pre-turn, and classified-failure switching. */
export function isConnectedServiceAuthGroupProviderLimitSelected(input: Readonly<{
  policy: ConnectedServiceAuthGroupPolicyV2;
  providerLimitId: string | null | undefined;
}>): boolean {
  const selected = selectedProviderLimitIds(input.policy);
  if (!selected) return true;
  const providerLimitId = input.providerLimitId?.trim() ?? '';
  return providerLimitId.length === 0 || selected.has(providerLimitId);
}

/**
 * Recomputes policy-sensitive quota evidence from the retained raw meters. This is deliberately
 * selector-owned: one account snapshot can feed Pools with different policies, so filtering at
 * ingestion would discard evidence needed by another Pool.
 */
export function projectConnectedServiceAuthGroupQuotaSnapshot(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null,
  policy: ConnectedServiceAuthGroupPolicyV2,
  modelId?: string | null,
): ConnectedServiceAuthGroupQuotaSnapshot | null {
  if (!snapshot) return null;
  const selected = selectedProviderLimitIds(policy);
  const requestedModel = modelId?.trim();
  const hasOtherModel = requestedModel && (snapshot.meters ?? []).some(
    (meter) => meter.modelId && meter.modelId !== requestedModel,
  );
  if (!selected && !hasOtherModel) return snapshot;
  const meters = (snapshot.meters ?? []).filter((meter) => (
    (!requestedModel || !meter.modelId || meter.modelId === requestedModel)
    && (!selected || (meter.providerLimitId !== null && selected.has(meter.providerLimitId)))
  ));
  const effective = meters
    .filter((meter) => (
      (isQuotaMeter(meter) || isRateLimitMeter(meter))
      && meter.reliable !== false
      && numberOrNull(meter.remainingPct) !== null
    ))
    .slice()
    .sort((left, right) => {
      const remainingDelta = (left.remainingPct ?? 100) - (right.remainingPct ?? 100);
      return remainingDelta !== 0 ? remainingDelta : left.meterId.localeCompare(right.meterId);
    })[0] ?? null;
  return {
    ...snapshot,
    meters,
    effectiveMeterId: effective?.meterId ?? null,
    effectiveRemainingPercent: effective?.remainingPct ?? null,
    exhausted: meters.some((meter) => (
      (isQuotaMeter(meter) || isRateLimitMeter(meter)) && meterIsExhausted(meter)
    )),
    planUnavailable: meters.length > 0 && meters.every((meter) => (
      meter.limitCategory !== 'usage_limit'
      && meter.limitCategory !== 'rate_limit'
      && meter.limitCategory !== 'unknown'
    )),
  };
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
  const resettable = new Map<string, ReadonlyArray<string>>();
  for (const excluded of selection.excluded) {
    if (excluded.reason === 'disabled' || excluded.reason === 'auth_invalid' || excluded.reason === 'plan_unavailable') continue;
    if (excluded.reason !== 'quota_exhausted') return [];
    const snapshot = projectConnectedServiceAuthGroupQuotaSnapshot(
      params.memberStatesByProfileId.get(excluded.profileId)?.quotaSnapshot ?? null,
      params.policy,
      params.modelId,
    );
    if (!isFreshQuotaSnapshot(snapshot, params.nowMs) || !snapshot) return [];
    // Banked usage resets cannot repair request-rate or capacity throttling.
    if (!(snapshot.meters ?? []).some((meter) => isQuotaMeter(meter) && meterIsExhausted(meter))) return [];
    if ((snapshot.meters ?? []).some((meter) => isRateLimitMeter(meter) && meterIsExhausted(meter))) return [];
    resettable.set(excluded.profileId, [...new Set((snapshot.meters ?? [])
      .filter((meter) => isQuotaMeter(meter) && meterIsExhausted(meter))
      .map((meter) => meter.providerLimitId?.trim())
      .filter((id): id is string => Boolean(id)))]);
  }
  return params.members.filter((member) => resettable.has(member.profileId)).sort(comparePriority).map((member) => ({
    ...member, providerLimitIds: resettable.get(member.profileId) ?? [],
  }));
}

function resolveQuotaSnapshotExhaustionRetryAtMs(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
  state: ConnectedServiceAuthGroupMemberRuntimeState | null,
  nowMs: number,
  policy: ConnectedServiceAuthGroupPolicyV2,
): number | null {
  const meterRetryAtMs = (snapshot.meters ?? [])
    .filter((meter) => (isQuotaMeter(meter) || isRateLimitMeter(meter)) && meterIsExhausted(meter))
    .map((meter) => numberOrNull(meter.resetAtMs))
    .filter((value): value is number => value !== null && value > nowMs)
    .sort((left, right) => left - right)[0] ?? null;
  return meterRetryAtMs
    ?? (selectedProviderLimitIds(policy) ? null : numberOrNull(state?.providerResetsAtMs));
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
    params.reason === 'same_provider_account_exhausted'
    &&
    params.policy
    && params.providerLimitId != null
    && !isConnectedServiceAuthGroupProviderLimitSelected({
      policy: params.policy,
      providerLimitId: params.providerLimitId,
    })
  ) {
    return false;
  }
  if (
    !requiresFreshQuotaEvidenceForSwitchReason(params.reason)
    && !allowsUnknownQuotaEvidenceForSwitchReason(params.reason)
  ) {
    return true;
  }
  const state = params.memberStatesByProfileId.get(params.profileId) ?? null;
  const policy = params.policy ?? DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2;
  const projectedSnapshot = projectConnectedServiceAuthGroupQuotaSnapshot(state?.quotaSnapshot ?? null, policy, params.modelId);
  const quotaSnapshot = isFreshQuotaSnapshot(projectedSnapshot, params.nowMs)
    ? projectedSnapshot
    : null;
  if (!quotaSnapshot) return allowsUnknownQuotaEvidenceForSwitchReason(params.reason);
  if (quotaSnapshot.planUnavailable) return false;
  if (resolveSnapshotEligibilityBlocker(quotaSnapshot, params.nowMs)) return false;
  return !isQuotaExhausted(quotaSnapshot);
}

function resolveSoftSwitchRemainingPercent(policy: ConnectedServiceAuthGroupPolicyV2): number | null {
  const value = numberOrNull(policy.softSwitchRemainingPercent);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

export function isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter(input: Readonly<{
  activeProfileId: string | null;
  candidate: ConnectedServiceAuthGroupCandidate;
  policy: ConnectedServiceAuthGroupPolicyV2;
}>): boolean {
  if (input.activeProfileId && input.candidate.profileId === input.activeProfileId) return false;
  const threshold = resolveSoftSwitchRemainingPercent(input.policy);
  if (threshold === null) return false;
  const candidateScore = input.candidate.leastLimitedScore;
  return candidateScore !== null && candidateScore > threshold;
}

export type ConnectedServiceAuthGroupSoftSwitchSourceEvidence = Readonly<
  | { status: 'at_or_below_threshold'; remainingPercent: number; thresholdPercent: number }
  | { status: 'above_threshold'; remainingPercent: number; thresholdPercent: number }
  | { status: 'unknown'; reason: 'missing_active_profile' | 'missing_fresh_quota_snapshot' | 'missing_remaining_percent' | 'missing_soft_switch_threshold' }
>;

export function resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence(input: Readonly<{
  modelId?: string | null;
  activeProfileId: string | null;
  policy: ConnectedServiceAuthGroupPolicyV2;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  nowMs: number;
}>): ConnectedServiceAuthGroupSoftSwitchSourceEvidence {
  const activeProfileId = input.activeProfileId?.trim() ?? '';
  if (!activeProfileId) return { status: 'unknown', reason: 'missing_active_profile' };
  const threshold = resolveSoftSwitchRemainingPercent(input.policy);
  if (threshold === null) return { status: 'unknown', reason: 'missing_soft_switch_threshold' };
  const state = input.memberStatesByProfileId.get(activeProfileId) ?? null;
  const quotaSnapshot = projectConnectedServiceAuthGroupQuotaSnapshot(state?.quotaSnapshot ?? null, input.policy, input.modelId);
  if (!quotaSnapshot) return { status: 'unknown', reason: 'missing_fresh_quota_snapshot' };
  const remainingPercent = resolveLeastLimitedScore(quotaSnapshot);
  if (remainingPercent === null) return { status: 'unknown', reason: 'missing_remaining_percent' };
  const fresh = isQuotaSnapshotWithinFreshnessWindow(
    quotaSnapshot,
    input.nowMs,
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
  lastSwitchReason?: string | null;
  lastSwitchAt?: number | null;
  policy: ConnectedServiceAuthGroupPolicyV2;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  nowMs: number;
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
  policy: ConnectedServiceAuthGroupPolicyV2;
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
  reason?: string;
  requiredModelIds?: ReadonlyArray<string>;
  modelId?: string | null;
  nowMs: number;
  activeProfileId: string | null;
  lastSwitchReason?: string | null;
  lastSwitchAt?: number | null;
  policy: ConnectedServiceAuthGroupPolicyV2;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  allowCurrentProfileRetry?: boolean;
  unavailableProfileIds?: ReadonlySet<string>;
  requireFreshQuotaEvidence?: boolean;
  quotaProbeDeferredUntilMsByProfileId?: ReadonlyMap<string, number>;
  providerLimitId?: string | null;
}>): ConnectedServiceAuthGroupCandidateSelection {
  if (params.policy.strategy === 'manual') {
    return {
      selected: null,
      reason: 'manual_strategy',
      excluded: [],
      decisionTrace: {
        activeProfileId: params.activeProfileId,
        reason: 'manual_strategy',
        strategy: params.policy.strategy,
        selectionBasis: 'manual_strategy',
        sticky: false,
        orderedEligibleCandidates: [],
        candidates: [],
      },
    };
  }

  let candidates: ConnectedServiceAuthGroupCandidate[] = [];
  const decisionTraceCandidates: ConnectedServiceAuthGroupCandidateDecisionTraceEntry[] = [];

  const requiredModelIds = new Set([...(params.requiredModelIds ?? []), params.providerLimitId]);
  for (const member of params.members) {
    const state = params.memberStatesByProfileId.get(member.profileId) ?? null;
    const projectedQuotaSnapshot = projectConnectedServiceAuthGroupQuotaSnapshot(state?.quotaSnapshot ?? null, params.policy, params.modelId);
    const quotaSnapshot = isFreshQuotaSnapshot(projectedQuotaSnapshot, params.nowMs)
      ? projectedQuotaSnapshot
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
    const probeRetryAtMs = params.quotaProbeDeferredUntilMsByProfileId?.get(member.profileId);
    if (probeRetryAtMs !== undefined && probeRetryAtMs > params.nowMs) {
      exclude('quota_probe_deferred', probeRetryAtMs);
      continue;
    }
    if (!credentialHealthAllowsSelection(effectiveState?.credentialHealthStatus)) {
      exclude('auth_invalid');
      continue;
    }
    if (params.unavailableProfileIds?.has(member.profileId)) {
      exclude('credential_unavailable');
      continue;
    }
    const modelBlocker = resolveConnectedServiceAuthGroupModelEligibilityBlocker({
      state: effectiveState, modelId: params.modelId ?? params.providerLimitId, nowMs: params.nowMs,
    }) ?? [...requiredModelIds].map(modelId => resolveConnectedServiceAuthGroupModelEligibilityBlocker({
      state: effectiveState, modelId, nowMs: params.nowMs,
    })).find(blocker => blocker !== null);
    if (modelBlocker) {
      exclude(modelBlocker.reason, modelBlocker.retryAtMs);
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
      exclude('quota_exhausted', resolveQuotaSnapshotExhaustionRetryAtMs(
        quotaSnapshot,
        state,
        params.nowMs,
        params.policy,
      ));
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

    const candidate = { ...member, leastLimitedScore: resolveLeastLimitedScore(quotaSnapshot) };
    if (params.requireFreshQuotaEvidence && (!quotaSnapshot
      || candidate.leastLimitedScore === null || candidate.leastLimitedScore <= 0)) {
      exclude('quota_evidence_unavailable');
      continue;
    }
    if (params.reason === 'soft_threshold' && member.profileId !== params.activeProfileId) {
      if (!hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({ ...params, profileId: member.profileId, reason: params.reason })) {
        exclude('quota_evidence_unavailable');
        continue;
      }
    }
    candidates.push({
      ...candidate,
      ...(params.policy.strategy === 'expiry_first' ? {
        preferenceDeadlineMs: resolvePreferenceDeadline(quotaSnapshot, state?.subscription, params.nowMs),
      } : {}),
    });
    decisionTraceCandidates.push({
      profileId: member.profileId,
      decision: 'eligible',
      quotaEvidence,
    });
  }

  // The soft-switch threshold protects a usable current member from unnecessary swaps.
  // Once that member is excluded, any proven positive allowance can restore admission.
  const softSwitchExcludedProfileIds = new Set<string>();
  if (params.reason === 'soft_threshold' && (!params.allowCurrentProfileRetry
    || candidates.some(candidate => candidate.profileId === params.activeProfileId))) {
    candidates = candidates.filter(candidate => {
      if (candidate.profileId === params.activeProfileId
        || isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter({ ...params, candidate })) return true;
      softSwitchExcludedProfileIds.add(candidate.profileId);
      return false;
    });
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
    lastSwitchReason: params.lastSwitchReason,
    lastSwitchAt: params.lastSwitchAt,
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
  const sticky = !primaryRestorePreferred && softSwitchPreferred !== null
    && softSwitchPreferred.profileId === params.activeProfileId;
  const candidateDecisions = decisionTraceCandidates.map(candidate => (
    softSwitchExcludedProfileIds.has(candidate.profileId)
      ? { ...candidate, decision: 'excluded' as const, exclusionReason: 'not_meaningfully_better' as const }
      : selected && candidate.profileId === selected.profileId
        ? { ...candidate, decision: 'selected' as const }
        : candidate
  ));
  return {
    selected,
    reason,
    excluded: candidateDecisions.flatMap(candidate => candidate.decision === 'excluded' && candidate.exclusionReason
      ? [{ profileId: candidate.profileId, reason: candidate.exclusionReason,
        ...(candidate.retryAtMs === undefined ? {} : { retryAtMs: candidate.retryAtMs }) }]
      : []),
    decisionTrace: {
      activeProfileId: params.activeProfileId,
      reason,
      strategy: params.policy.strategy,
      selectionBasis: !selected ? 'no_eligible_members'
        : primaryRestorePreferred ? 'primary_restore'
          : sticky ? 'active_stickiness'
            : softSwitchPreferred ? 'soft_switch' : 'preference',
      sticky,
      orderedEligibleCandidates: candidates,
      candidates: candidateDecisions,
    },
  };
}
