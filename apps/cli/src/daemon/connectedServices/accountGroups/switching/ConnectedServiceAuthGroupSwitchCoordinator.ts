import {
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupCandidateDecisionTrace,
  type ConnectedServiceAuthGroupMember,
  type ConnectedServiceAuthGroupMemberRuntimeState,
  type ConnectedServiceAuthGroupPolicyV1,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from '../selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import {
  readConnectedServiceAuthGenerationApplyFailure,
  type ConnectedServiceAuthGenerationApplyFailure,
} from '../../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../../accountTransitions/acceptedConnectedServiceAccountVerification';
import { evaluatePredictiveSoftSwitchSessionApplyPolicy } from './predictiveSoftSwitchPolicy';
import type { ConnectedServiceGroupQuotaProbeResult } from '../../quotas/ConnectedServiceQuotasCoordinator';
import {
  buildGenerationApplyResult,
  buildLeaseCompletion,
  buildPolicyWaitUntilResetResult,
  buildPredictiveApplyUnavailableResult,
  buildSessionApplyFromLeaseCompletion,
  buildSwitchDecisionDiagnostics,
  canRetryCurrentProfileForObservedProfile,
  canRetryObservedProfileDuringPreTurnSelection,
  ConnectedServiceAuthGroupSwitchLeaseExpiredError,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  isPredictiveSessionApplyReason,
  isProfileAdoptableForObservedDivergence,
  isProfileEligibleForObservedGeneration,
  isReasonEnabled,
  isTransientPredictiveApplyUnavailable,
  mergeSwitchDecisionDiagnostics,
  normalizeProfileId,
  readPredictiveSoftSwitchSessionApplyFailure,
  readSwitchResultDecisionTrace,
  resolveEarliestRetryAtMs,
  resolvePolicyRecoveryWaitRetryAtMs,
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  shouldApplyLeaseCompletion,
  switchResultApplyFields,
  type ConnectedServiceAuthGroupSwitchApplyGenerationInput,
  type ConnectedServiceAuthGroupSwitchApplyGenerationResult,
  type ConnectedServiceAuthGroupSwitchApplyMode,
  type ConnectedServiceAuthGroupSwitchEvent,
  type ConnectedServiceAuthGroupSwitchLimitAction,
  type ConnectedServiceAuthGroupSwitchPipelinePhase,
  type ConnectedServiceAuthGroupSwitchPipelineRequest,
  type ConnectedServiceAuthGroupSwitchPipelineTrigger,
  type ConnectedServiceAuthGroupSwitchResult,
  type ConnectedServiceAuthGroupSwitchState,
  type GenerationConflictResolution,
  type LeaseAcquireResult,
  type LeaseCompletion,
  type ObservedGenerationApplyResult,
  type RecordObservedFailureStateOutcome,
} from './pipeline/switchPipeline';

export {
  ConnectedServiceAuthGroupSwitchLeaseExpiredError,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  SESSION_SWITCH_LIMIT_WINDOW_MS,
} from './pipeline/switchPipeline';
export type {
  ConnectedServiceAuthGroupSwitchEvent,
  ConnectedServiceAuthGroupSwitchLimitAction,
  ConnectedServiceAuthGroupSwitchResult,
  ConnectedServiceAuthGroupSwitchState,
} from './pipeline/switchPipeline';

export class ConnectedServiceAuthGroupQuotaProbeIncompleteError extends Error {
  readonly code = 'connected_service_auth_group_quota_probe_incomplete';

  constructor(readonly reason: ConnectedServiceGroupQuotaProbeResult['reason']) {
    super('Connected service auth group quota evidence could not be refreshed within the pre-turn budget');
    this.name = 'ConnectedServiceAuthGroupQuotaProbeIncompleteError';
  }
}

export class ConnectedServiceAuthGroupSwitchCoordinator {
  private readonly switchTimestampsBySessionKey = new Map<string, number[]>();

  constructor(private readonly deps: Readonly<{
    leases: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry;
    nowMs: () => number;
    quotaFreshnessMs: number;
    loadState(input: Readonly<{
      serviceId: string;
      groupId: string;
      trigger?: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    }>): Promise<ConnectedServiceAuthGroupSwitchState>;
    commitSwitch(input: Readonly<{
      serviceId: string;
      groupId: string;
      fromProfileId: string | null;
      toProfileId: string;
      expectedGeneration: number;
      reason: string;
    }>): Promise<ConnectedServiceAuthGroupSwitchState>;
    prepareCandidateForSwitch?(input: Readonly<{
      serviceId: string;
      groupId: string;
      profileId: string;
      reason: string;
    }>): Promise<
      | Readonly<{ status: 'ready' }>
      | Readonly<{
          status: 'ineligible';
          memberState: ConnectedServiceAuthGroupMemberRuntimeState;
        }>
    >;
    preflightApplyGeneration?(
      input: ConnectedServiceAuthGroupSwitchApplyGenerationInput,
    ): Promise<ConnectedServiceAuthGroupSwitchApplyGenerationResult | void>;
    applyGeneration(
      input: ConnectedServiceAuthGroupSwitchApplyGenerationInput,
    ): Promise<ConnectedServiceAuthGroupSwitchApplyGenerationResult | void>;
    resolvePostApplyCredentialRevision?(input: Readonly<{
      serviceId: string;
      groupId: string;
      activeProfileId: string | null;
      generation: number;
    }>): Promise<ConnectedServiceAuthGroupSwitchState['credentialRevision']>;
    recordObservedFailureState?(input: Readonly<{
      serviceId: string;
      groupId: string;
      loaded: ConnectedServiceAuthGroupSwitchState;
      reason: string;
      observedProfileId?: string | null;
      retryAtMs?: number | null;
      retryAfterMs?: number | null;
      resetsAtMs?: number | null;
      planType?: string | null;
    }>): Promise<void>;
    probeQuotaSnapshotsForGroup?(input: Readonly<{
      serviceId: string;
      groupId: string;
      profileIds: ReadonlyArray<string>;
      reason: string;
      deadlineAtMs?: number;
    }>): Promise<ConnectedServiceGroupQuotaProbeResult | void>;
    resolveGenerationConflict?: (error: unknown) => number | null;
    emitEvent?: (event: ConnectedServiceAuthGroupSwitchEvent) => void;
  }>) {}

  private async loadStateAfterApply(input: Readonly<{
    serviceId: string;
    groupId: string;
    trigger?: ConnectedServiceAuthGroupSwitchPipelineTrigger;
  }>): Promise<ConnectedServiceAuthGroupSwitchState> {
    const observed = await this.deps.loadState(input);
    if (!this.deps.resolvePostApplyCredentialRevision) return observed;
    const credentialRevision = await this.deps.resolvePostApplyCredentialRevision({
      serviceId: observed.serviceId,
      groupId: observed.groupId,
      activeProfileId: observed.activeProfileId,
      generation: observed.generation,
    });
    return {
      ...observed,
      credentialRevision: credentialRevision ?? null,
    };
  }

  private async resolveAuthoritativeRevisionSupersession(input: Readonly<{
    completion: ConnectedServiceAuthGroupSwitchApplyGenerationInput;
    failure: ConnectedServiceAuthGenerationApplyFailure;
    trigger?: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
  }>): Promise<Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'superseded_after_apply' }> | null> {
    if (input.failure.errorCode !== 'credential_revision_superseded') return null;
    const observed = await this.loadStateAfterApply({
      serviceId: input.completion.serviceId,
      groupId: input.completion.groupId,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    });
    const attemptedRevision = input.completion.credentialRevision ?? null;
    const observedRevision = observed.credentialRevision ?? null;
    const isAuthoritativeSupersession = observed.generation > input.completion.generation
      || (
        observed.generation === input.completion.generation
        && observed.activeProfileId === input.completion.activeProfileId
        && attemptedRevision !== null
        && observedRevision !== null
        && observedRevision !== attemptedRevision
      );
    if (!isAuthoritativeSupersession) return null;
    const diagnostics = input.decisionTrace === undefined
      ? input.failure.diagnostics
      : mergeSwitchDecisionDiagnostics({
          diagnostics: input.failure.diagnostics,
          decisionTrace: input.decisionTrace,
        });
    return {
      status: 'superseded_after_apply',
      activeProfileId: observed.activeProfileId,
      generation: observed.generation,
      credentialRevision: observedRevision,
      adoptedProfileId: input.completion.activeProfileId,
      adoptedGeneration: input.completion.generation,
      adoptedCredentialRevision: attemptedRevision,
      reconciliationDisposition: 'superseded_after_apply',
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  }

  private async preflightPredictiveSessionApply(
    input: ConnectedServiceAuthGroupSwitchApplyGenerationInput,
  ): Promise<ConnectedServiceAuthGenerationApplyFailure | null> {
    if (!this.deps.preflightApplyGeneration) return null;
    if (!isPredictiveSessionApplyReason(input.reason)) return null;
    if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) return null;
    try {
      const applyResult = await this.deps.preflightApplyGeneration(input);
      return readPredictiveSoftSwitchSessionApplyFailure({
        reason: input.reason,
        sessionId: input.sessionId,
        applyResult,
      });
    } catch (error) {
      const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
      if (!applyFailure) throw error;
      return applyFailure;
    }
  }

  /**
   * Candidate choice stays wholly owned by the canonical selector. An optional boundary may prove
   * that a selected credential is unusable before the CAS; when it does, we feed that fact back as
   * operation-local member state and ask the same selector for the next candidate. Nothing is
   * committed, persisted, or selected by the boundary itself.
   */
  private async selectPreparedCandidate(input: Readonly<{
    state: ConnectedServiceAuthGroupSwitchState;
    activeProfileId: string | null | undefined;
    reason: string;
    allowCurrentProfileRetry?: boolean;
  }>): Promise<ReturnType<typeof selectConnectedServiceAuthGroupCandidate>> {
    const memberStatesByProfileId = new Map(input.state.memberStatesByProfileId);
    for (;;) {
      const selected = selectConnectedServiceAuthGroupCandidate({
        nowMs: this.deps.nowMs(),
        quotaFreshnessMs: this.deps.quotaFreshnessMs,
        activeProfileId: input.activeProfileId ?? null,
        policy: input.state.policy,
        members: input.state.members,
        memberStatesByProfileId,
        ...(input.allowCurrentProfileRetry === undefined
          ? {}
          : { allowCurrentProfileRetry: input.allowCurrentProfileRetry }),
      });
      if (!selected.selected || !this.deps.prepareCandidateForSwitch) return selected;
      const prepared = await this.deps.prepareCandidateForSwitch({
        serviceId: input.state.serviceId,
        groupId: input.state.groupId,
        profileId: selected.selected.profileId,
        reason: input.reason,
      });
      if (prepared.status === 'ready') return selected;
      const existing = memberStatesByProfileId.get(selected.selected.profileId) ?? {};
      memberStatesByProfileId.set(selected.selected.profileId, {
        ...existing,
        ...prepared.memberState,
      });
    }
  }

  private async probeQuotaSnapshotsBeforePreTurnSelection(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    request: Readonly<{
      serviceId: string;
      groupId: string;
      reason: string;
      deadlineAtMs?: number;
    }>;
    loaded: ConnectedServiceAuthGroupSwitchState;
    activeProfileId?: string | null;
    allowCurrentProfileRetry: boolean;
  }>): Promise<ConnectedServiceAuthGroupSwitchState> {
    if (!this.deps.probeQuotaSnapshotsForGroup) return input.loaded;
    const profileIds = resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: input.activeProfileId ?? input.loaded.activeProfileId,
      members: input.loaded.members,
      memberStatesByProfileId: input.loaded.memberStatesByProfileId,
      policy: input.loaded.policy,
      nowMs: this.deps.nowMs(),
      quotaFreshnessMs: this.deps.quotaFreshnessMs,
      allowCurrentProfileRetry: input.allowCurrentProfileRetry,
    });
    if (profileIds.length === 0) return input.loaded;
    const probeResult = await this.deps.probeQuotaSnapshotsForGroup({
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      profileIds,
      reason: input.request.reason,
      ...(input.request.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.request.deadlineAtMs }),
    });
    if (probeResult?.status === 'incomplete') {
      throw new ConnectedServiceAuthGroupQuotaProbeIncompleteError(probeResult.reason);
    }
    return await this.deps.loadState({
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      trigger: input.trigger,
    });
  }

  private resolveSessionSwitchKey(input: Readonly<{ sessionId?: string; serviceId: string; groupId: string }>): string | null {
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 ? input.sessionId.trim() : null;
    if (!sessionId) return null;
    return `${sessionId}\0${input.serviceId}\0${input.groupId}`;
  }

  private countRecentSessionSwitches(key: string, nowMs: number): number {
    const cutoffMs = nowMs - SESSION_SWITCH_LIMIT_WINDOW_MS;
    const recent = (this.switchTimestampsBySessionKey.get(key) ?? []).filter((timestamp) => timestamp >= cutoffMs);
    this.switchTimestampsBySessionKey.set(key, recent);
    return recent.length;
  }

  private recordSessionSwitch(key: string | null, nowMs: number): void {
    if (!key) return;
    const cutoffMs = nowMs - SESSION_SWITCH_LIMIT_WINDOW_MS;
    const recent = (this.switchTimestampsBySessionKey.get(key) ?? []).filter((timestamp) => timestamp >= cutoffMs);
    recent.push(nowMs);
    this.switchTimestampsBySessionKey.set(key, recent);
  }

  private async resolveStateAfterGenerationConflict(input: Readonly<{
    error: unknown;
    sessionId?: string;
    serviceId: string;
    groupId: string;
    loaded: ConnectedServiceAuthGroupSwitchState;
    reason?: string;
    observedProfileId?: string | null;
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    lease: Extract<LeaseAcquireResult, { kind: 'owner' }>;
  }>): Promise<GenerationConflictResolution | null> {
    const conflictGeneration = this.deps.resolveGenerationConflict?.(input.error);
    if (typeof conflictGeneration !== 'number' || !Number.isFinite(conflictGeneration)) return null;
    const observed = await this.deps.loadState({
      serviceId: input.serviceId,
      groupId: input.groupId,
      trigger: input.trigger,
    });
    if (observed.generation <= input.loaded.generation) return null;
    if (normalizeProfileId(observed.activeProfileId) === normalizeProfileId(input.loaded.activeProfileId)) {
      return { kind: 'retry', state: observed };
    }
    const failedProfileId = normalizeProfileId(input.observedProfileId)
      ?? normalizeProfileId(input.loaded.activeProfileId);
    const observedActiveProfileId = normalizeProfileId(observed.activeProfileId);
    if (!observedActiveProfileId || !failedProfileId) {
      return { kind: 'retry', state: observed };
    }
    const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
      nowMs: this.deps.nowMs(),
      quotaFreshnessMs: this.deps.quotaFreshnessMs,
      activeProfileId: failedProfileId,
      policy: observed.policy,
      members: observed.members,
      memberStatesByProfileId: observed.memberStatesByProfileId,
    });
    if (!isProfileEligibleForObservedGeneration({
      profileId: observedActiveProfileId,
      reason: input.reason ?? '',
      nowMs: this.deps.nowMs(),
      quotaFreshnessMs: this.deps.quotaFreshnessMs,
      memberStatesByProfileId: observed.memberStatesByProfileId,
      selected: observedGenerationSelection,
    })) {
      return {
        kind: 'retry',
        state: observed,
        selectionActiveProfileId: observed.activeProfileId,
      };
    }
    const completion = buildLeaseCompletion({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      serviceId: input.serviceId,
      groupId: input.groupId,
      activeProfileId: observed.activeProfileId,
      generation: observed.generation,
      ...(observed.credentialRevision == null ? {} : { credentialRevision: observed.credentialRevision }),
      ...(input.reason ? { reason: input.reason } : {}),
      result: {
        status: 'observed_generation',
        activeProfileId: observed.activeProfileId,
        generation: observed.generation,
        credentialRevision: observed.credentialRevision ?? null,
        diagnostics: buildSwitchDecisionDiagnostics({
          decisionTrace: observedGenerationSelection.decisionTrace,
        }),
      },
    });
    input.lease.complete(completion);
    try {
      return {
        kind: 'observed_generation',
        result: await this.applyObservedGeneration(completion),
      };
    } finally {
      input.lease.finish();
    }
  }

  private async applyObservedGeneration(completion: LeaseCompletion): Promise<ObservedGenerationApplyResult> {
    let applyResult: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void;
    const decisionTrace = readSwitchResultDecisionTrace(completion.result);
    try {
      const preflightFailure = await this.preflightPredictiveSessionApply(completion);
      if (preflightFailure) {
        return buildGenerationApplyResult({
          activeProfileId: completion.activeProfileId,
          generation: completion.generation,
          reason: completion.reason,
          failure: preflightFailure,
          ...(decisionTrace === undefined ? {} : { decisionTrace }),
        });
      }
      applyResult = await this.deps.applyGeneration(completion);
      const predictiveFailure = readPredictiveSoftSwitchSessionApplyFailure({
        reason: completion.reason,
        sessionId: completion.sessionId,
        applyResult,
      });
      if (predictiveFailure) {
        return buildGenerationApplyResult({
          activeProfileId: completion.activeProfileId,
          generation: completion.generation,
          reason: completion.reason,
          failure: predictiveFailure,
          ...(decisionTrace === undefined ? {} : { decisionTrace }),
        });
      }
      const applyFields = switchResultApplyFields(applyResult);
      const observedAfterApply = await this.loadStateAfterApply({
        serviceId: completion.serviceId,
        groupId: completion.groupId,
      });
      const revisionWasSuperseded = observedAfterApply.generation === completion.generation
        && completion.credentialRevision != null
        && observedAfterApply.credentialRevision != null
        && observedAfterApply.credentialRevision !== completion.credentialRevision;
      if (observedAfterApply.generation > completion.generation || revisionWasSuperseded) {
        return {
          status: 'superseded_after_apply',
          activeProfileId: observedAfterApply.activeProfileId,
          generation: observedAfterApply.generation,
          credentialRevision: observedAfterApply.credentialRevision ?? null,
          adoptedProfileId: completion.activeProfileId,
          adoptedGeneration: completion.generation,
          adoptedCredentialRevision: completion.credentialRevision ?? null,
          reconciliationDisposition: 'superseded_after_apply',
          ...applyFields,
          ...(decisionTrace === undefined
            ? {}
            : {
                diagnostics: mergeSwitchDecisionDiagnostics({
                  diagnostics: applyFields.diagnostics,
                  decisionTrace,
                }),
              }),
        };
      }
      return {
        status: 'observed_generation',
        activeProfileId: completion.activeProfileId,
        generation: completion.generation,
        credentialRevision: completion.credentialRevision ?? null,
        ...applyFields,
        ...(decisionTrace === undefined
          ? {}
          : {
              diagnostics: mergeSwitchDecisionDiagnostics({
                diagnostics: applyFields.diagnostics,
                decisionTrace,
              }),
            }),
      };
    } catch (error) {
      const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
      if (!applyFailure) throw error;
      const superseded = await this.resolveAuthoritativeRevisionSupersession({
        completion,
        failure: applyFailure,
        ...(decisionTrace === undefined ? {} : { decisionTrace }),
      });
      if (superseded) return superseded;
      return buildGenerationApplyResult({
        activeProfileId: completion.activeProfileId,
        generation: completion.generation,
        reason: completion.reason,
        failure: applyFailure,
        ...(decisionTrace === undefined ? {} : { decisionTrace }),
      });
    }
  }

  private async recordObservedFailureStateWithConflictRecovery(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    loaded: ConnectedServiceAuthGroupSwitchState;
    reason: string;
    observedProfileId?: string | null;
    retryAtMs?: number | null;
    retryAfterMs?: number | null;
    resetsAtMs?: number | null;
    planType?: string | null;
    lease: Extract<LeaseAcquireResult, { kind: 'owner' }>;
  }>): Promise<RecordObservedFailureStateOutcome> {
    if (!this.deps.recordObservedFailureState) {
      return { kind: 'recorded', state: input.loaded };
    }

    let loaded = input.loaded;
    for (;;) {
      try {
        await this.deps.recordObservedFailureState({
          serviceId: input.serviceId,
          groupId: input.groupId,
          loaded,
          reason: input.reason,
          observedProfileId: input.observedProfileId,
          retryAtMs: input.retryAtMs,
          retryAfterMs: input.retryAfterMs,
          resetsAtMs: input.resetsAtMs,
          planType: input.planType,
        });
        return {
          kind: 'recorded',
          state: await this.deps.loadState({
            serviceId: input.serviceId,
            groupId: input.groupId,
            trigger: 'classified_failure',
          }),
        };
      } catch (error) {
        const resolvedConflict = await this.resolveStateAfterGenerationConflict({
          error,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          serviceId: input.serviceId,
          groupId: input.groupId,
          loaded,
          reason: input.reason,
          observedProfileId: input.observedProfileId,
          trigger: 'classified_failure',
          lease: input.lease,
        });
        if (!resolvedConflict) throw error;
        if (resolvedConflict.kind === 'observed_generation') {
          return resolvedConflict;
        }
        loaded = resolvedConflict.state;
      }
    }
  }

  private emitSwitchResult(input: Readonly<{
    request: Readonly<{
      serviceId: string;
      groupId: string;
      reason: string;
      observedProfileId?: string | null;
      limitCategory?: string | null;
      retryAtMs?: number | null;
      retryAfterMs?: number | null;
      quotaScope?: string | null;
      providerLimitId?: string | null;
      action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
    }>;
    loaded: Readonly<{
      activeProfileId: string | null;
      generation: number;
      credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    }>;
    resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
    toProfileId: string | null;
    toGeneration: number;
    mode?: ConnectedServiceAuthGroupSwitchApplyMode;
    success: boolean;
    startedAtMs: number;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
  }>): void {
    this.deps.emitEvent?.({
      type: 'connected_service_auth_group_switch',
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      fromProfileId: normalizeProfileId(input.request.observedProfileId) ?? input.loaded.activeProfileId,
      toProfileId: input.toProfileId,
      reason: input.request.reason,
      ...(input.request.limitCategory === undefined ? {} : { limitCategory: input.request.limitCategory }),
      ...(input.request.retryAfterMs === undefined && input.request.retryAtMs === undefined
        ? {}
        : { retryAfterMs: input.request.retryAfterMs ?? input.request.retryAtMs ?? null }),
      ...(input.request.quotaScope === undefined ? {} : { quotaScope: input.request.quotaScope }),
      ...(input.request.providerLimitId === undefined ? {} : { providerLimitId: input.request.providerLimitId }),
      ...(input.request.action === undefined ? {} : { action: input.request.action }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      fromGeneration: input.loaded.generation,
      toGeneration: input.toGeneration,
      resultStatus: input.resultStatus,
      success: input.success,
      latencyMs: Math.max(0, this.deps.nowMs() - input.startedAtMs),
      ...(input.decisionTrace === undefined ? {} : { decisionTrace: input.decisionTrace }),
    });
  }

  private shouldEmitSwitchPipelineResult(
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger,
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase,
  ): boolean {
    if (trigger === 'classified_failure') return true;
    return phase === 'switch_limit'
      || phase === 'observed_divergence'
      || phase === 'apply_failed'
      || phase === 'switched';
  }

  private maybeEmitSwitchPipelineResult(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase;
    request: ConnectedServiceAuthGroupSwitchPipelineRequest;
    loaded: Readonly<{
      activeProfileId: string | null;
      generation: number;
      credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    }>;
    resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
    toProfileId: string | null;
    toGeneration: number;
    mode?: ConnectedServiceAuthGroupSwitchApplyMode;
    success: boolean;
    startedAtMs: number;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
  }>): void {
    if (input.resultStatus === 'predictive_apply_unavailable') return;
    if (!this.shouldEmitSwitchPipelineResult(input.trigger, input.phase)) return;
    this.emitSwitchResult(input);
  }

  private resolvePipelineResultProfileId(input: Readonly<{
    result: ConnectedServiceAuthGroupSwitchResult;
    loaded: Readonly<{ activeProfileId: string | null }>;
  }>): string | null {
    switch (input.result.status) {
      case 'switched':
      case 'observed_generation':
      case 'generation_apply_failed':
      case 'predictive_apply_unavailable':
      case 'superseded_after_apply':
        return input.result.activeProfileId;
      case 'auto_switch_disabled':
      case 'switch_reason_disabled':
      case 'manual_strategy':
        return input.loaded.activeProfileId;
      case 'no_eligible_member':
      case 'switch_limit_reached':
        return null;
    }
  }

  private completePipelineResult(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase;
    lease: Extract<LeaseAcquireResult, { kind: 'owner' }>;
    request: ConnectedServiceAuthGroupSwitchPipelineRequest;
    loaded: Readonly<{
      activeProfileId: string | null;
      generation: number;
      credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    }>;
    result: ConnectedServiceAuthGroupSwitchResult;
    startedAtMs: number;
  }>): ConnectedServiceAuthGroupSwitchResult {
    input.lease.complete(buildLeaseCompletion({
      ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      activeProfileId: input.loaded.activeProfileId,
      generation: input.loaded.generation,
      ...(input.loaded.credentialRevision == null ? {} : { credentialRevision: input.loaded.credentialRevision }),
      reason: input.request.reason,
      result: input.result,
    }));
    this.maybeEmitSwitchPipelineResult({
      trigger: input.trigger,
      phase: input.phase,
      request: input.request,
      loaded: input.loaded,
      resultStatus: input.result.status,
      toProfileId: this.resolvePipelineResultProfileId(input),
      toGeneration: input.result.generation,
      success: false,
      startedAtMs: input.startedAtMs,
      decisionTrace: readSwitchResultDecisionTrace(input.result),
    });
    input.lease.finish();
    return input.result;
  }

  private resolvePolicyResult(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    request: ConnectedServiceAuthGroupSwitchPipelineRequest;
    loaded: ConnectedServiceAuthGroupSwitchState;
  }>): Readonly<{
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase;
    result: ConnectedServiceAuthGroupSwitchResult;
  }> | null {
    if (!input.loaded.policy.autoSwitch || input.loaded.policy.recoveryMode === 'off') {
      return {
        phase: 'policy',
        result: { status: 'auto_switch_disabled', generation: input.loaded.generation },
      };
    }
    if (!isReasonEnabled(input.loaded.policy, input.request.reason)) {
      return {
        phase: 'policy',
        result: { status: 'switch_reason_disabled', generation: input.loaded.generation },
      };
    }
    if (input.loaded.policy.recoveryMode === 'wait_until_reset') {
      return {
        phase: 'policy',
        result: buildPolicyWaitUntilResetResult({
          loaded: input.loaded,
          retryAtMs: input.trigger === 'classified_failure'
            ? resolvePolicyRecoveryWaitRetryAtMs(input.request)
            : null,
        }),
      };
    }

    const switchesThisTurn = typeof input.request.switchesThisTurn === 'number' && Number.isFinite(input.request.switchesThisTurn)
      ? Math.max(0, Math.trunc(input.request.switchesThisTurn))
      : 0;
    const sessionSwitchKey = this.resolveSessionSwitchKey(input.request);
    const hourlySwitchCount = typeof input.request.sessionSwitchesThisHour === 'number' && Number.isFinite(input.request.sessionSwitchesThisHour)
      ? Math.max(0, Math.trunc(input.request.sessionSwitchesThisHour))
      : sessionSwitchKey
        ? this.countRecentSessionSwitches(sessionSwitchKey, this.deps.nowMs())
        : 0;
    if (
      switchesThisTurn >= input.loaded.policy.maxSwitchesPerTurn
      || hourlySwitchCount >= input.loaded.policy.maxSwitchesPerSessionHour
    ) {
      return {
        phase: 'switch_limit',
        result: { status: 'switch_limit_reached', generation: input.loaded.generation },
      };
    }
    return null;
  }

  async switchAfterClassifiedFailure(input: Readonly<{
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
  }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    return await this.runSwitchPipeline(input, 'classified_failure');
  }

  async switchBeforeTurn(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
    switchesThisTurn?: number;
    sessionSwitchesThisHour?: number;
    deadlineAtMs?: number;
  }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    return await this.runSwitchPipeline(input, 'pre_turn');
  }

  /**
   * Recipient-only application of an already-authoritative generation. This API deliberately has
   * no candidate-selection or commit input; automatic/settings fanout can therefore share one
   * bounded executor without allowing siblings to re-enter the decision pipeline.
   */
  async applyCommittedGeneration(input: Readonly<{
    sessionId: string;
    serviceId: string;
    groupId: string;
    activeProfileId: string;
    generation: number;
    credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    reason: string;
    fromProfileId?: string | null;
  }>): Promise<ObservedGenerationApplyResult> {
    return await this.applyObservedGeneration(buildLeaseCompletion({
      sessionId: input.sessionId,
      serviceId: input.serviceId,
      groupId: input.groupId,
      activeProfileId: input.activeProfileId,
      generation: input.generation,
      ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
      reason: input.reason,
      ...(input.fromProfileId === undefined ? {} : { fromProfileId: input.fromProfileId }),
      result: {
        status: 'observed_generation',
        activeProfileId: input.activeProfileId,
        generation: input.generation,
        credentialRevision: input.credentialRevision ?? null,
      },
    }));
  }

  private async runSwitchPipeline(
    input: ConnectedServiceAuthGroupSwitchPipelineRequest,
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger,
  ): Promise<ConnectedServiceAuthGroupSwitchResult> {
    const startedAtMs = this.deps.nowMs();
    const lease = this.deps.leases.acquire(input);
    if (lease.kind === 'loser') {
      let observed: LeaseCompletion;
      try {
        observed = await lease.waitForOwner();
      } catch (error) {
        const failedProfileId = normalizeProfileId(input.observedProfileId);
        if (
          !(error instanceof ConnectedServiceAuthGroupSwitchLeaseExpiredError)
          || !failedProfileId
        ) {
          throw error;
        }
        const current = await this.deps.loadState({ ...input, trigger });
        const currentProfileId = normalizeProfileId(current.activeProfileId);
        if (!currentProfileId || currentProfileId === failedProfileId) {
          throw error;
        }
        // A peer committed current group truth before its longer application work completed.
        // Consume that authoritative generation instead of terminalizing the recovery on a
        // coordination timeout.
        observed = buildLeaseCompletion({
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          serviceId: current.serviceId,
          groupId: current.groupId,
          activeProfileId: currentProfileId,
          generation: current.generation,
          ...(current.credentialRevision === undefined
            ? {}
            : { credentialRevision: current.credentialRevision }),
          reason: input.reason,
          fromProfileId: failedProfileId,
          result: {
            status: 'observed_generation',
            activeProfileId: currentProfileId,
            generation: current.generation,
            credentialRevision: current.credentialRevision ?? null,
          },
        });
      }
      if (!shouldApplyLeaseCompletion(observed)) {
        this.maybeEmitSwitchPipelineResult({
          trigger,
          phase: 'lease_loser_non_apply',
          request: input,
          loaded: observed,
          resultStatus: observed.result.status,
          toProfileId: observed.activeProfileId,
          toGeneration: observed.generation,
          success: false,
          startedAtMs,
          decisionTrace: readSwitchResultDecisionTrace(observed.result),
        });
        return observed.result;
      }
      if (
        trigger === 'classified_failure'
        &&
        normalizeProfileId(input.observedProfileId)
        && normalizeProfileId(input.observedProfileId) === normalizeProfileId(observed.activeProfileId)
      ) {
        return await this.runSwitchPipeline(input, trigger);
      }
      const result = await this.applyObservedGeneration(buildSessionApplyFromLeaseCompletion({
        completion: observed,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }));
      this.maybeEmitSwitchPipelineResult({
        trigger,
        phase: 'lease_loser_apply',
        request: input,
        loaded: observed,
        resultStatus: result.status,
        toProfileId: result.activeProfileId,
        toGeneration: result.generation,
        success: result.status === 'observed_generation',
        startedAtMs,
      });
      return result;
    }

    try {
      let loaded = await this.deps.loadState({ ...input, trigger });
      const observedProfileId = normalizeProfileId(input.observedProfileId);
      let selectionActiveProfileId = loaded.activeProfileId;

      if (trigger === 'classified_failure') {
        const observedFailureOutcome = await this.recordObservedFailureStateWithConflictRecovery({
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          serviceId: input.serviceId,
          groupId: input.groupId,
          loaded,
          reason: input.reason,
          observedProfileId: input.observedProfileId,
          retryAtMs: input.retryAtMs,
          retryAfterMs: input.retryAfterMs,
          resetsAtMs: input.resetsAtMs,
          planType: input.planType,
          lease,
        });
        if (observedFailureOutcome.kind === 'observed_generation') {
          this.maybeEmitSwitchPipelineResult({
            trigger,
            phase: 'record_observed_generation',
            request: input,
            loaded,
            resultStatus: observedFailureOutcome.result.status,
            toProfileId: observedFailureOutcome.result.activeProfileId,
            toGeneration: observedFailureOutcome.result.generation,
            success: observedFailureOutcome.result.status === 'observed_generation',
            startedAtMs,
          });
          return observedFailureOutcome.result;
        }
        loaded = observedFailureOutcome.state;
        const loadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
        let didProbeForSelection = false;
        if (observedProfileId && loadedActiveProfileId && loadedActiveProfileId !== observedProfileId) {
          selectionActiveProfileId = observedProfileId;
          loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
            trigger,
            request: input,
            loaded,
            activeProfileId: selectionActiveProfileId,
            allowCurrentProfileRetry: false,
          });
          didProbeForSelection = true;
          const currentLoadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
          const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            activeProfileId: selectionActiveProfileId,
            policy: loaded.policy,
            members: loaded.members,
            memberStatesByProfileId: loaded.memberStatesByProfileId,
          });
          if (
            currentLoadedActiveProfileId
            && currentLoadedActiveProfileId !== observedProfileId
            && isProfileAdoptableForObservedDivergence({
              profileId: currentLoadedActiveProfileId,
              members: loaded.members,
              selected: observedGenerationSelection,
            })
          ) {
            const completion = buildLeaseCompletion({
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              serviceId: input.serviceId,
              groupId: input.groupId,
              activeProfileId: loaded.activeProfileId,
              generation: loaded.generation,
              ...(loaded.credentialRevision == null ? {} : { credentialRevision: loaded.credentialRevision }),
              reason: input.reason,
              fromProfileId: observedProfileId,
              result: {
                status: 'observed_generation',
                activeProfileId: loaded.activeProfileId,
                generation: loaded.generation,
                credentialRevision: loaded.credentialRevision ?? null,
                diagnostics: buildSwitchDecisionDiagnostics({
                  decisionTrace: observedGenerationSelection.decisionTrace,
                }),
              },
            });
            lease.complete(completion);
            let result: ObservedGenerationApplyResult;
            try {
              result = await this.applyObservedGeneration(completion);
            } finally {
              lease.finish();
            }
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'observed_divergence',
              request: input,
              loaded,
              resultStatus: result.status,
              toProfileId: result.activeProfileId,
              toGeneration: result.generation,
              success: result.status === 'observed_generation',
              startedAtMs,
            });
            return result;
          }
          selectionActiveProfileId = currentLoadedActiveProfileId;
        }
        if (!didProbeForSelection) {
          loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
            trigger,
            request: input,
            loaded,
            activeProfileId: selectionActiveProfileId,
            allowCurrentProfileRetry: false,
          });
        }
      }

      const preProbePolicyResult = trigger === 'pre_turn'
        ? this.resolvePolicyResult({ trigger, request: input, loaded })
        : null;
      if (preProbePolicyResult) {
        return this.completePipelineResult({
          trigger,
          phase: preProbePolicyResult.phase,
          lease,
          request: input,
          loaded,
          result: preProbePolicyResult.result,
          startedAtMs,
        });
      }

      if (trigger === 'pre_turn') {
        const allowCurrentProfileRetry = canRetryObservedProfileDuringPreTurnSelection(input.reason);
        loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
          trigger,
          request: input,
          loaded,
          allowCurrentProfileRetry,
        });

        const loadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
        if (observedProfileId && loadedActiveProfileId && observedProfileId !== loadedActiveProfileId) {
          const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            activeProfileId: observedProfileId,
            policy: loaded.policy,
            members: loaded.members,
            memberStatesByProfileId: loaded.memberStatesByProfileId,
            allowCurrentProfileRetry,
          });
          if (isProfileEligibleForObservedGeneration({
            profileId: loadedActiveProfileId,
            reason: input.reason,
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            memberStatesByProfileId: loaded.memberStatesByProfileId,
            selected: observedGenerationSelection,
          })) {
            const result: ConnectedServiceAuthGroupSwitchResult = {
              status: 'observed_generation',
              activeProfileId: loaded.activeProfileId,
              generation: loaded.generation,
              credentialRevision: loaded.credentialRevision ?? null,
              diagnostics: buildSwitchDecisionDiagnostics({
                decisionTrace: observedGenerationSelection.decisionTrace,
              }),
            };
            const completion = buildLeaseCompletion({
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              serviceId: input.serviceId,
              groupId: input.groupId,
              activeProfileId: loaded.activeProfileId,
              generation: loaded.generation,
              ...(loaded.credentialRevision == null ? {} : { credentialRevision: loaded.credentialRevision }),
              reason: input.reason,
              fromProfileId: observedProfileId,
              result,
            });
            lease.complete(completion);
            let applied: ObservedGenerationApplyResult;
            try {
              applied = await this.applyObservedGeneration(completion);
            } finally {
              lease.finish();
            }
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'observed_divergence',
              request: input,
              loaded,
              resultStatus: applied.status,
              toProfileId: applied.activeProfileId,
              toGeneration: applied.generation,
              ...(applied.status === 'observed_generation' && applied.mode ? { mode: applied.mode } : {}),
              success: applied.status === 'observed_generation',
              startedAtMs,
            });
            return applied;
          }
        }
      }

      const postProbePolicyResult = trigger === 'classified_failure'
        ? this.resolvePolicyResult({ trigger, request: input, loaded })
        : null;
      if (postProbePolicyResult) {
        return this.completePipelineResult({
          trigger,
          phase: postProbePolicyResult.phase,
          lease,
          request: input,
          loaded,
          result: postProbePolicyResult.result,
          startedAtMs,
        });
      }

      const allowLoadedActiveProfileRetry = trigger === 'pre_turn'
        ? canRetryCurrentProfileForObservedProfile({
            reason: input.reason,
            observedProfileId,
            activeProfileId: loaded.activeProfileId,
          })
        : false;
      const selected = await this.selectPreparedCandidate({
        state: loaded,
        activeProfileId: trigger === 'pre_turn' ? loaded.activeProfileId : selectionActiveProfileId,
        reason: input.reason,
        ...(trigger === 'pre_turn' ? { allowCurrentProfileRetry: allowLoadedActiveProfileRetry } : {}),
      });
      if (!selected.selected) {
        const result: ConnectedServiceAuthGroupSwitchResult = selected.reason === 'manual_strategy'
          ? { status: 'manual_strategy', generation: loaded.generation }
          : {
              status: 'no_eligible_member',
              generation: loaded.generation,
              groupExhausted: true,
              retryAtMs: resolveEarliestRetryAtMs(selected.excluded),
              excluded: selected.excluded,
              diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace }),
            };
        return this.completePipelineResult({
          trigger,
          phase: 'no_candidate',
          lease,
          request: input,
          loaded,
          result,
          startedAtMs,
        });
      }

      let selectedProfileId = selected.selected.profileId;
      let selectedDecisionTrace = selected.decisionTrace;
      if (selectedProfileId === loaded.activeProfileId && trigger === 'pre_turn' && allowLoadedActiveProfileRetry) {
        const result: ConnectedServiceAuthGroupSwitchResult = {
          status: 'observed_generation',
          activeProfileId: loaded.activeProfileId,
          generation: loaded.generation,
          credentialRevision: loaded.credentialRevision ?? null,
          diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selectedDecisionTrace }),
        };
        return this.completePipelineResult({
          trigger,
          phase: 'conflict_observed_generation',
          lease,
          request: input,
          loaded,
          result,
          startedAtMs,
        });
      }

      let commitLoaded = loaded;
      let commitSelectionActiveProfileId: string | null | undefined = trigger === 'pre_turn'
        ? loaded.activeProfileId
        : selectionActiveProfileId;
      let committed: ConnectedServiceAuthGroupSwitchState;
      for (;;) {
        try {
          const preflightFailure = await this.preflightPredictiveSessionApply({
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            serviceId: input.serviceId,
            groupId: input.groupId,
            activeProfileId: selectedProfileId,
            generation: commitLoaded.generation + 1,
            reason: input.reason,
            fromProfileId: commitLoaded.activeProfileId,
          });
          if (preflightFailure) {
            const result: ConnectedServiceAuthGroupSwitchResult = buildGenerationApplyResult({
              activeProfileId: selectedProfileId,
              generation: commitLoaded.generation + 1,
              reason: input.reason,
              failure: preflightFailure,
              decisionTrace: selectedDecisionTrace,
            });
            if (result.status === 'predictive_apply_unavailable') {
              return this.completePipelineResult({
                trigger,
                phase: 'apply_failed',
                lease,
                request: input,
                loaded: commitLoaded,
                result,
                startedAtMs,
              });
            }
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'apply_failed',
              request: input,
              loaded: commitLoaded,
              resultStatus: 'generation_apply_failed',
              toProfileId: selectedProfileId,
              toGeneration: commitLoaded.generation + 1,
              success: false,
              startedAtMs,
              decisionTrace: selectedDecisionTrace,
            });
            lease.complete(buildLeaseCompletion({
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              serviceId: input.serviceId,
              groupId: input.groupId,
              activeProfileId: selectedProfileId,
              generation: commitLoaded.generation + 1,
              reason: input.reason,
              fromProfileId: commitLoaded.activeProfileId,
              result,
            }));
            lease.finish();
            return result;
          }
          committed = await this.deps.commitSwitch({
            serviceId: input.serviceId,
            groupId: input.groupId,
            fromProfileId: commitLoaded.activeProfileId,
            toProfileId: selectedProfileId,
            expectedGeneration: commitLoaded.generation,
            reason: input.reason,
          });
          break;
        } catch (error) {
          const resolvedConflict = await this.resolveStateAfterGenerationConflict({
            error,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            serviceId: input.serviceId,
            groupId: input.groupId,
            loaded: commitLoaded,
            reason: input.reason,
            ...(trigger === 'classified_failure' ? { observedProfileId: input.observedProfileId } : {}),
            trigger,
            lease,
          });
          if (resolvedConflict?.kind === 'observed_generation') {
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'conflict_observed_generation',
              request: input,
              loaded: commitLoaded,
              resultStatus: resolvedConflict.result.status,
              toProfileId: resolvedConflict.result.activeProfileId,
              toGeneration: resolvedConflict.result.generation,
              success: resolvedConflict.result.status === 'observed_generation',
              startedAtMs,
            });
            return resolvedConflict.result;
          }
          if (resolvedConflict?.kind === 'retry') {
            commitLoaded = resolvedConflict.state;
            commitSelectionActiveProfileId = resolvedConflict.selectionActiveProfileId
              ?? (trigger === 'pre_turn' ? commitLoaded.activeProfileId : commitSelectionActiveProfileId);
            const retrySelected = await this.selectPreparedCandidate({
              state: commitLoaded,
              activeProfileId: commitSelectionActiveProfileId,
              reason: input.reason,
            });
            if (!retrySelected.selected) {
              const result: ConnectedServiceAuthGroupSwitchResult = retrySelected.reason === 'manual_strategy'
                ? { status: 'manual_strategy', generation: commitLoaded.generation }
                : {
                    status: 'no_eligible_member',
                    generation: commitLoaded.generation,
                    groupExhausted: true,
                    retryAtMs: resolveEarliestRetryAtMs(retrySelected.excluded),
                    excluded: retrySelected.excluded,
                    diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: retrySelected.decisionTrace }),
                  };
              return this.completePipelineResult({
                trigger,
                phase: 'no_candidate',
                lease,
                request: input,
                loaded: commitLoaded,
                result,
                startedAtMs,
              });
            }
            selectedProfileId = retrySelected.selected.profileId;
            selectedDecisionTrace = retrySelected.decisionTrace;
            if (trigger === 'pre_turn' && selectedProfileId === commitLoaded.activeProfileId) {
              const result: ConnectedServiceAuthGroupSwitchResult = {
                status: 'observed_generation',
                activeProfileId: commitLoaded.activeProfileId,
                generation: commitLoaded.generation,
                credentialRevision: commitLoaded.credentialRevision ?? null,
              };
              return this.completePipelineResult({
                trigger,
                phase: 'conflict_observed_generation',
                lease,
                request: input,
                loaded: commitLoaded,
                result,
                startedAtMs,
              });
            }
            continue;
          }
          throw error;
        }
      }
      const completion = buildLeaseCompletion({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        serviceId: input.serviceId,
        groupId: input.groupId,
        activeProfileId: committed.activeProfileId,
        generation: committed.generation,
        ...(committed.credentialRevision == null ? {} : { credentialRevision: committed.credentialRevision }),
        reason: input.reason,
        result: {
          status: 'switched',
          activeProfileId: committed.activeProfileId ?? selectedProfileId,
          generation: committed.generation,
          credentialRevision: committed.credentialRevision ?? null,
          diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selectedDecisionTrace }),
        },
      });
      let applyResult: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void;
      lease.complete(completion);
      try {
        try {
          applyResult = await this.deps.applyGeneration({
            ...completion,
            // Pre-switch active member, so the transcript "from" is the real member rather than null.
            fromProfileId: commitLoaded.activeProfileId,
          });
        } catch (error) {
          const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
          if (!applyFailure) throw error;
          const superseded = await this.resolveAuthoritativeRevisionSupersession({
            completion,
            failure: applyFailure,
            trigger,
            decisionTrace: selectedDecisionTrace,
          });
          if (superseded) {
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'apply_failed',
              request: input,
              loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
              resultStatus: 'superseded_after_apply',
              toProfileId: superseded.activeProfileId,
              toGeneration: superseded.generation,
              success: false,
              startedAtMs,
              decisionTrace: selectedDecisionTrace,
            });
            return superseded;
          }
          const unavailableResult = isTransientPredictiveApplyUnavailable({
            reason: input.reason,
            failure: applyFailure,
          })
            ? buildPredictiveApplyUnavailableResult({
                activeProfileId: committed.activeProfileId ?? selectedProfileId,
                generation: committed.generation,
                failure: applyFailure,
              })
            : null;
          if (unavailableResult) return unavailableResult;
          this.maybeEmitSwitchPipelineResult({
            trigger,
            phase: 'apply_failed',
            request: input,
            loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
            resultStatus: 'generation_apply_failed',
            toProfileId: committed.activeProfileId ?? selectedProfileId,
            toGeneration: committed.generation,
            success: false,
            startedAtMs,
            decisionTrace: selectedDecisionTrace,
          });
          return {
            status: 'generation_apply_failed',
            activeProfileId: committed.activeProfileId ?? selectedProfileId,
            generation: committed.generation,
            errorCode: applyFailure.errorCode,
            diagnostics: mergeSwitchDecisionDiagnostics({
              diagnostics: applyFailure.diagnostics,
              decisionTrace: selectedDecisionTrace,
            }),
          };
        }
        const sessionSwitchKey = this.resolveSessionSwitchKey(input);
        const predictiveFailure = readPredictiveSoftSwitchSessionApplyFailure({
          reason: input.reason,
          sessionId: input.sessionId,
          applyResult,
        });
        if (predictiveFailure) {
        const unavailableResult = isTransientPredictiveApplyUnavailable({
          reason: input.reason,
          failure: predictiveFailure,
        })
          ? buildPredictiveApplyUnavailableResult({
              activeProfileId: committed.activeProfileId ?? selectedProfileId,
              generation: committed.generation,
              failure: predictiveFailure,
            })
          : null;
        if (unavailableResult) return unavailableResult;
        this.maybeEmitSwitchPipelineResult({
          trigger,
          phase: 'apply_failed',
          request: input,
          loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
          resultStatus: 'generation_apply_failed',
          toProfileId: committed.activeProfileId ?? selectedProfileId,
          toGeneration: committed.generation,
          success: false,
          startedAtMs,
          decisionTrace: selectedDecisionTrace,
        });
        return {
          status: 'generation_apply_failed',
          activeProfileId: committed.activeProfileId ?? selectedProfileId,
          generation: committed.generation,
          errorCode: predictiveFailure.errorCode,
          diagnostics: mergeSwitchDecisionDiagnostics({
            diagnostics: predictiveFailure.diagnostics,
            decisionTrace: selectedDecisionTrace,
          }),
        };
        }
        const observedAfterApply = await this.loadStateAfterApply({ ...input, trigger });
        const adoptedProfileId = committed.activeProfileId ?? selectedProfileId;
      // The server generation is the group-selection CAS epoch. Credential refresh can advance the
      // exact application epoch without changing that number, so revision is the second fence.
      // A lower generation remains a lagging/non-authoritative adapter observation.
        const revisionWasSuperseded = observedAfterApply.generation === committed.generation
          && committed.credentialRevision != null
          && observedAfterApply.credentialRevision != null
          && observedAfterApply.credentialRevision !== committed.credentialRevision;
        if (observedAfterApply.generation > committed.generation || revisionWasSuperseded) {
        const applyFields = switchResultApplyFields(applyResult);
        this.maybeEmitSwitchPipelineResult({
          trigger,
          phase: 'apply_failed',
          request: input,
          loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
          resultStatus: 'superseded_after_apply',
          toProfileId: observedAfterApply.activeProfileId,
          toGeneration: observedAfterApply.generation,
          success: false,
          startedAtMs,
          decisionTrace: selectedDecisionTrace,
        });
        return {
          status: 'superseded_after_apply',
          activeProfileId: observedAfterApply.activeProfileId,
          generation: observedAfterApply.generation,
          credentialRevision: observedAfterApply.credentialRevision ?? null,
          adoptedProfileId,
          adoptedGeneration: committed.generation,
          adoptedCredentialRevision: committed.credentialRevision ?? null,
          reconciliationDisposition: 'superseded_after_apply',
          ...applyFields,
          diagnostics: mergeSwitchDecisionDiagnostics({
            diagnostics: applyFields.diagnostics,
            decisionTrace: selectedDecisionTrace,
          }),
        };
        }
        this.recordSessionSwitch(sessionSwitchKey, this.deps.nowMs());
      this.maybeEmitSwitchPipelineResult({
        trigger,
        phase: 'switched',
        request: input,
        loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
        resultStatus: 'switched',
        toProfileId: committed.activeProfileId ?? selectedProfileId,
        toGeneration: committed.generation,
        ...(applyResult?.mode ? { mode: applyResult.mode } : {}),
        success: true,
        startedAtMs,
        decisionTrace: selectedDecisionTrace,
      });
        const applyFields = switchResultApplyFields(applyResult);
        return {
          status: 'switched',
          activeProfileId: committed.activeProfileId ?? selectedProfileId,
          generation: committed.generation,
          credentialRevision: committed.credentialRevision ?? null,
          ...applyFields,
          diagnostics: mergeSwitchDecisionDiagnostics({
            diagnostics: applyFields.diagnostics,
            decisionTrace: selectedDecisionTrace,
          }),
        };
      } finally {
        lease.finish();
      }
    } catch (error) {
      lease.fail(error);
      throw error;
    }
  }
}
