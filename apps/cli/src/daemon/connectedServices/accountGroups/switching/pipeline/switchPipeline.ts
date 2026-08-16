import {
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupCandidateDecisionTrace,
  type ConnectedServiceAuthGroupMember,
  type ConnectedServiceAuthGroupMemberRuntimeState,
  type ConnectedServiceAuthGroupPolicyV1,
} from '../../selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from '../../selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import {
  readConnectedServiceAuthGenerationApplyFailure,
  type ConnectedServiceAuthGenerationApplyFailure,
} from '../../../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../../../accountTransitions/acceptedConnectedServiceAccountVerification';
import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import { evaluatePredictiveSoftSwitchSessionApplyPolicy } from '../predictiveSoftSwitchPolicy';

export type ConnectedServiceAuthGroupSwitchState = Readonly<{
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  runtimeStateRevision: number;
  /** Exact credential epoch for the active profile when the projection can resolve it. */
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  policy: ConnectedServiceAuthGroupPolicyV1;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>;

export type LeaseCompletion = Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  reason?: string;
  fromProfileId?: string | null;
  result: ConnectedServiceAuthGroupSwitchResult;
}>;
export type ConnectedServiceAuthGroupSwitchApplyMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';
export type ConnectedServiceAuthGroupProviderApplication = 'applied' | 'observed';
export type ConnectedServiceAuthGroupSwitchApplyGenerationResult = Readonly<{
  mode?: ConnectedServiceAuthGroupSwitchApplyMode;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
  /** Apply-proven context (e.g. resume continuity) surfaced for switch telemetry (INC-6). */
  diagnostics?: unknown;
}>;
export type ConnectedServiceAuthGroupSwitchApplyGenerationInput = Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  reason?: string;
  /**
   * Pre-switch active group member. The persisted session group binding does not track the live
   * member, so it is threaded here so the session transcript "from" is the real member rather
   * than null (which the UI renders as the native / "CLI Auth" label).
   */
  fromProfileId?: string | null;
}>;

export type ConnectedServiceAuthGroupSwitchDecisionDiagnostics = Readonly<{
  decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;

type LeaseOutcome =
  | Readonly<{ status: 'completed'; completion: LeaseCompletion }>
  | Readonly<{ status: 'failed'; error: unknown }>;

export type LeaseAcquireResult =
  | Readonly<{
      kind: 'owner';
      complete(completion: LeaseCompletion): void;
      finish(): void;
      fail(error: unknown): void;
    }>
  | Readonly<{
      kind: 'loser';
      waitForOwner(options?: Readonly<{ timeoutMs?: number }>): Promise<LeaseCompletion>;
    }>;

const DEFAULT_SWITCH_LEASE_TIMEOUT_MS = 30_000;
export const SESSION_SWITCH_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function switchKey(serviceId: string, groupId: string): string {
  return `${serviceId}\0${groupId}`;
}

export class ConnectedServiceAuthGroupSwitchLeaseExpiredError extends Error {
  constructor() {
    super('connected_service_auth_group_switch_lease_expired');
  }
}

export class InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry {
  private readonly pendingByKey = new Map<string, {
    promise: Promise<LeaseOutcome>;
    resolve: (outcome: LeaseOutcome) => void;
    settled: boolean;
  }>();

  constructor(private readonly options: Readonly<{ leaseTimeoutMs?: number }> = {}) {}

  acquire(input: Readonly<{ serviceId: string; groupId: string }>): LeaseAcquireResult {
    const key = switchKey(input.serviceId, input.groupId);
    const pending = this.pendingByKey.get(key);
    if (pending) {
      return {
        kind: 'loser',
        waitForOwner: async (waitOptions) => {
          const timeoutMs = waitOptions?.timeoutMs ?? this.options.leaseTimeoutMs ?? DEFAULT_SWITCH_LEASE_TIMEOUT_MS;
          let timeout: ReturnType<typeof setTimeout> | null = null;
          const outcome = await Promise.race([
            pending.promise,
            new Promise<LeaseOutcome>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new ConnectedServiceAuthGroupSwitchLeaseExpiredError()), timeoutMs);
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          if (outcome.status === 'failed') throw outcome.error;
          return outcome.completion;
        },
      };
    }

    let resolveCompletion: (outcome: LeaseOutcome) => void = () => {};
    const promise = new Promise<LeaseOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    const entry = { promise, resolve: resolveCompletion, settled: false };
    this.pendingByKey.set(key, entry);
    return {
      kind: 'owner',
      complete: (completion) => {
        const current = this.pendingByKey.get(key);
        if (current !== entry || entry.settled) return;
        entry.settled = true;
        current.resolve({ status: 'completed', completion });
      },
      finish: () => {
        if (this.pendingByKey.get(key) !== entry) return;
        this.pendingByKey.delete(key);
      },
      fail: (error) => {
        const current = this.pendingByKey.get(key);
        if (current !== entry) return;
        this.pendingByKey.delete(key);
        if (!entry.settled) {
          entry.settled = true;
          current.resolve({ status: 'failed', error });
        }
      },
    };
  }
}

export type ConnectedServiceAuthGroupSwitchResult =
  | Readonly<{
      status: 'switched';
      activeProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      mode?: ConnectedServiceAuthGroupSwitchApplyMode;
      providerApplication?: ConnectedServiceAuthGroupProviderApplication;
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
      /** Apply-proven context (e.g. resume continuity) surfaced for switch telemetry (INC-6). */
      diagnostics?: unknown;
    }>
  | Readonly<{
      status: 'superseded_after_apply';
      activeProfileId: string | null;
      generation: number;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
      adoptedProfileId: string | null;
      adoptedGeneration: number;
      adoptedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
      reconciliationDisposition: 'superseded_after_apply';
      mode?: ConnectedServiceAuthGroupSwitchApplyMode;
      providerApplication?: ConnectedServiceAuthGroupProviderApplication;
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
      diagnostics?: unknown;
    }>
  | Readonly<{
      status: 'generation_apply_failed';
      activeProfileId: string | null;
      generation: number;
      errorCode: string;
      diagnostics?: unknown;
    }>
  | Readonly<{
      status: 'predictive_apply_unavailable';
      activeProfileId: string | null;
      generation: number;
      errorCode: string;
      diagnostics?: unknown;
    }>
  | Readonly<{
      status: 'observed_generation';
      activeProfileId: string | null;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      mode?: ConnectedServiceAuthGroupSwitchApplyMode;
      providerApplication?: ConnectedServiceAuthGroupProviderApplication;
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
      /** Apply-proven context (e.g. resume continuity) surfaced for switch telemetry (INC-6). */
      diagnostics?: unknown;
    }>
  | Readonly<{
      status: 'no_eligible_member';
      generation: number;
      groupExhausted: true;
      retryAtMs: number | null;
      excluded: ReadonlyArray<Readonly<{
        profileId: string;
        reason: string;
        retryAtMs?: number | null;
      }>>;
      diagnostics?: ConnectedServiceAuthGroupSwitchDecisionDiagnostics;
    }>
  | Readonly<{ status: 'manual_strategy'; generation: number }>
  | Readonly<{ status: 'auto_switch_disabled'; generation: number }>
  | Readonly<{ status: 'switch_reason_disabled'; generation: number }>
  | Readonly<{ status: 'switch_limit_reached'; generation: number }>;

export type ConnectedServiceAuthGroupSwitchLimitAction = Readonly<{
  kind: 'open_url';
  url: string;
}>;

export type ConnectedServiceAuthGroupSwitchEvent = Readonly<{
  type: 'connected_service_auth_group_switch';
  serviceId: string;
  groupId: string;
  fromProfileId: string | null;
  toProfileId: string | null;
  reason: string;
  limitCategory?: string | null;
  retryAfterMs?: number | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
  mode?: ConnectedServiceAuthGroupSwitchApplyMode;
  fromGeneration: number;
  toGeneration: number;
  resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
  success: boolean;
  latencyMs: number;
  decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;

export function isReasonEnabled(policy: ConnectedServiceAuthGroupPolicyV1, reason: string): boolean {
  switch (reason) {
    case 'usage_limit':
    case 'rate_limit':
    case 'soft_threshold':
    case 'same_provider_account_exhausted':
    case 'capacity':
      return policy.switchOn.usageLimit;
    case 'auth_expired':
    case 'permission_denied':
      return policy.switchOn.authExpired;
    case 'refresh_failed':
      return policy.switchOn.refreshFailure || policy.switchOn.authExpired;
    default:
      return false;
  }
}

export function resolveEarliestRetryAtMs(excluded: ReadonlyArray<Readonly<{ retryAtMs?: number | null }>>): number | null {
  let earliest: number | null = null;
  for (const item of excluded) {
    if (typeof item.retryAtMs !== 'number' || !Number.isFinite(item.retryAtMs)) continue;
    earliest = earliest === null ? item.retryAtMs : Math.min(earliest, item.retryAtMs);
  }
  return earliest;
}

export function buildSwitchDecisionDiagnostics(input: Readonly<{
  decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): ConnectedServiceAuthGroupSwitchDecisionDiagnostics {
  return { decisionTrace: input.decisionTrace };
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSwitchDecisionTrace(value: unknown): value is ConnectedServiceAuthGroupCandidateDecisionTrace {
  if (!isReadonlyRecord(value)) return false;
  const reason = value.reason;
  return (
    (reason === 'selected' || reason === 'manual_strategy' || reason === 'no_eligible_members')
    && Array.isArray(value.candidates)
  );
}

export function mergeSwitchDecisionDiagnostics(input: Readonly<{
  diagnostics?: unknown;
  decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): unknown {
  if (input.diagnostics === undefined) {
    return buildSwitchDecisionDiagnostics({ decisionTrace: input.decisionTrace });
  }
  if (isReadonlyRecord(input.diagnostics)) {
    return {
      ...input.diagnostics,
      decisionTrace: input.decisionTrace,
    };
  }
  return {
    applyDiagnostics: input.diagnostics,
    decisionTrace: input.decisionTrace,
  };
}

export function readSwitchResultDecisionTrace(
  result: ConnectedServiceAuthGroupSwitchResult,
): ConnectedServiceAuthGroupCandidateDecisionTrace | undefined {
  if (!('diagnostics' in result)) return undefined;
  if (!isReadonlyRecord(result.diagnostics)) return undefined;
  const decisionTrace = result.diagnostics.decisionTrace;
  return isSwitchDecisionTrace(decisionTrace) ? decisionTrace : undefined;
}

export function resolvePolicyRecoveryWaitRetryAtMs(input: Readonly<{
  retryAtMs?: number | null;
  resetsAtMs?: number | null;
}>): number | null {
  const values = [input.retryAtMs, input.resetsAtMs]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

export function buildPolicyWaitUntilResetResult(input: Readonly<{
  loaded: ConnectedServiceAuthGroupSwitchState;
  retryAtMs: number | null;
}>): Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'no_eligible_member' }>> {
  const excluded = input.loaded.members.map((member) => ({
    profileId: member.profileId,
    reason: 'policy_wait_until_reset' as const,
    ...(input.retryAtMs === null ? {} : { retryAtMs: input.retryAtMs }),
  }));
  const candidates = input.loaded.members.map((member) => ({
    profileId: member.profileId,
    decision: 'excluded' as const,
    exclusionReason: 'policy_wait_until_reset' as const,
    ...(input.retryAtMs === null ? {} : { retryAtMs: input.retryAtMs }),
    quotaEvidence: { status: 'stale_or_missing' as const },
  }));
  return {
    status: 'no_eligible_member',
    generation: input.loaded.generation,
    groupExhausted: true,
    retryAtMs: input.retryAtMs,
    excluded,
    diagnostics: buildSwitchDecisionDiagnostics({
      decisionTrace: {
        activeProfileId: input.loaded.activeProfileId,
        reason: 'no_eligible_members',
        candidates,
      },
    }),
  };
}

export function normalizeProfileId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function canRetryCurrentProfileForObservedProfile(input: Readonly<{
  reason: string;
  observedProfileId?: string | null;
  activeProfileId: string | null | undefined;
}>): boolean {
  if (input.reason !== 'soft_threshold') return false;
  const observedProfileId = normalizeProfileId(input.observedProfileId);
  const activeProfileId = normalizeProfileId(input.activeProfileId);
  return !observedProfileId || !activeProfileId || observedProfileId === activeProfileId;
}

export function canRetryObservedProfileDuringPreTurnSelection(reason: string): boolean {
  return reason === 'soft_threshold';
}

export function isProfileEligibleForObservedGeneration(input: Readonly<{
  profileId: string;
  reason: string;
  nowMs: number;
  quotaFreshnessMs: number;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
}>): boolean {
  return input.selected.selected?.profileId === input.profileId
    && hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: input.reason,
      profileId: input.profileId,
      nowMs: input.nowMs,
      quotaFreshnessMs: input.quotaFreshnessMs,
      memberStatesByProfileId: input.memberStatesByProfileId,
    });
}

export function isProfileAdoptableForObservedDivergence(input: Readonly<{
  profileId: string;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
}>): boolean {
  return input.members.some((member) => member.profileId === input.profileId && member.enabled)
    && !input.selected.excluded.some((excluded) => excluded.profileId === input.profileId);
}

export function buildLeaseCompletion(input: Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  reason?: string;
  fromProfileId?: string | null;
  result: ConnectedServiceAuthGroupSwitchResult;
}>): LeaseCompletion {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    serviceId: input.serviceId,
    groupId: input.groupId,
    activeProfileId: input.activeProfileId,
    generation: input.generation,
    ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.fromProfileId === undefined ? {} : { fromProfileId: input.fromProfileId }),
    result: input.result,
  };
}

export function buildSessionApplyFromLeaseCompletion(input: Readonly<{
  completion: LeaseCompletion;
  sessionId?: string;
}>): LeaseCompletion {
  const { sessionId: _ownerSessionId, ...completion } = input.completion;
  return {
    ...completion,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export function shouldApplyLeaseCompletion(completion: LeaseCompletion): boolean {
  return completion.result.status === 'switched' || completion.result.status === 'observed_generation';
}

function providerApplicationForApplyMode(
  mode: ConnectedServiceAuthGroupSwitchApplyMode | undefined,
): ConnectedServiceAuthGroupProviderApplication | null {
  if (mode === 'spawn_next_turn') return 'observed';
  if (mode === 'hot_apply' || mode === 'restart_resume') return 'applied';
  return null;
}

export function switchResultApplyFields(
  applyResult: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void,
): Pick<
  Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'switched' | 'observed_generation' }>,
  'mode' | 'providerApplication' | 'verificationByServiceId' | 'diagnostics'
> {
  const providerApplication = providerApplicationForApplyMode(applyResult?.mode);
  return {
    ...(applyResult?.mode ? { mode: applyResult.mode } : {}),
    ...(providerApplication ? { providerApplication } : {}),
    ...(applyResult?.verificationByServiceId
      ? { verificationByServiceId: applyResult.verificationByServiceId }
      : {}),
    ...(applyResult?.diagnostics === undefined ? {} : { diagnostics: applyResult.diagnostics }),
  };
}

export function readPredictiveSoftSwitchSessionApplyFailure(input: Readonly<{
  reason?: string;
  sessionId?: string;
  applyResult?: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void;
}>): ConnectedServiceAuthGenerationApplyFailure | null {
  const decision = evaluatePredictiveSoftSwitchSessionApplyPolicy({
    reason: (input.reason ?? 'unknown') as Parameters<typeof evaluatePredictiveSoftSwitchSessionApplyPolicy>[0]['reason'],
    sessionId: input.sessionId,
    applyMode: input.applyResult?.mode,
  });
  if (decision.status === 'allow') return null;
  return {
    errorCode: 'hot_apply_restart_required',
    diagnostics: {
      policyReason: decision.reason,
      ...(input.applyResult?.mode ? { attemptedMode: input.applyResult.mode } : {}),
    },
  };
}

export function isPredictiveSessionApplyReason(reason: string | undefined): boolean {
  return reason === 'soft_threshold' || reason === 'same_provider_account_exhausted';
}

export function isTransientPredictiveApplyUnavailable(input: Readonly<{
  reason?: string;
  failure: ConnectedServiceAuthGenerationApplyFailure;
}>): boolean {
  return isPredictiveSessionApplyReason(input.reason) && input.failure.errorCode === 'hot_apply_failed';
}

export function buildPredictiveApplyUnavailableResult(input: Readonly<{
  activeProfileId: string | null;
  generation: number;
  failure: ConnectedServiceAuthGenerationApplyFailure;
  decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'predictive_apply_unavailable' }> {
  const diagnostics = input.decisionTrace === undefined
    ? input.failure.diagnostics
    : mergeSwitchDecisionDiagnostics({
        diagnostics: input.failure.diagnostics,
        decisionTrace: input.decisionTrace,
      });
  return {
    status: 'predictive_apply_unavailable',
    activeProfileId: input.activeProfileId,
    generation: input.generation,
    errorCode: input.failure.errorCode,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

export function buildGenerationApplyResult(input: Readonly<{
  activeProfileId: string | null;
  generation: number;
  reason?: string;
  failure: ConnectedServiceAuthGenerationApplyFailure;
  decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): Extract<
  ConnectedServiceAuthGroupSwitchResult,
  { status: 'generation_apply_failed' | 'predictive_apply_unavailable' }
> {
  if (isTransientPredictiveApplyUnavailable({ reason: input.reason, failure: input.failure })) {
    return buildPredictiveApplyUnavailableResult(input);
  }
  const diagnostics = input.decisionTrace === undefined
    ? input.failure.diagnostics
    : mergeSwitchDecisionDiagnostics({
        diagnostics: input.failure.diagnostics,
        decisionTrace: input.decisionTrace,
      });
  return {
    status: 'generation_apply_failed',
    activeProfileId: input.activeProfileId,
    generation: input.generation,
    errorCode: input.failure.errorCode,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

export type ObservedGenerationApplyResult = Extract<
  ConnectedServiceAuthGroupSwitchResult,
  { status: 'observed_generation' | 'superseded_after_apply' | 'generation_apply_failed' | 'predictive_apply_unavailable' }
>;

export type GenerationConflictResolution =
  | Readonly<{ kind: 'observed_generation'; result: ObservedGenerationApplyResult }>
  | Readonly<{
      kind: 'retry';
      state: ConnectedServiceAuthGroupSwitchState;
      selectionActiveProfileId?: string | null;
    }>;

export type RecordObservedFailureStateOutcome =
  | Readonly<{ kind: 'recorded'; state: ConnectedServiceAuthGroupSwitchState }>
  | Readonly<{ kind: 'observed_generation'; result: ObservedGenerationApplyResult }>;

export type ConnectedServiceAuthGroupSwitchPipelineTrigger = 'classified_failure' | 'pre_turn';

export type ConnectedServiceAuthGroupSwitchPipelineRequest = Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  reason: string;
  observedProfileId?: string | null;
  retryAtMs?: number | null;
  retryAfterMs?: number | null;
  resetsAtMs?: number | null;
  limitCategory?: string | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
  planType?: string | null;
  switchesThisTurn?: number;
  sessionSwitchesThisHour?: number;
  deadlineAtMs?: number;
}>;

export type ConnectedServiceAuthGroupSwitchPipelinePhase =
  | 'lease_loser_non_apply'
  | 'lease_loser_apply'
  | 'record_observed_generation'
  | 'policy'
  | 'switch_limit'
  | 'no_candidate'
  | 'observed_divergence'
  | 'conflict_observed_generation'
  | 'apply_failed'
  | 'switched';
