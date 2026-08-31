import type { ConnectedServiceSessionAuthSwitchReason } from '../../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type {
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  SessionConnectedServiceAuthCurrentGroupTruthV1,
} from '@happier-dev/protocol';
import {
  applyConnectedServiceAuthGroupGenerationToSessions,
  type ApplyAuthGroupGenerationToSessionsResult,
} from '../../sessionAuthSwitch/applyAuthGroupGenerationToSessions';
import type {
  ConnectedServiceAuthGenerationReconciliationDisposition,
  ConnectedServiceAuthGroupCommittedGenerationFact,
  ConnectedServiceGenerationExecutionAuthority,
  ConnectedServiceProviderAdoptedGenerationTarget,
} from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

type LocalGenerationSession = Readonly<{
  sessionId: string;
  activity: 'live' | 'idle' | 'offline';
  fromProfileId?: string | null;
  applicationOwnerId?: string | null;
  isCurrent?: () => boolean;
}>;

type ConnectedServiceAuthGenerationRecipientApplyReason =
  | 'same_provider_account_exhausted'
  | 'soft_threshold'
  | 'manual';

function resolveGenerationRecipientApplyReason(
  switchReason: ConnectedServiceSessionAuthSwitchReason,
): ConnectedServiceAuthGenerationRecipientApplyReason {
  if (switchReason === 'automatic_runtime_failure') return 'same_provider_account_exhausted';
  if (switchReason === 'pre_turn_group_policy') return 'soft_threshold';
  return 'manual';
}

function isCurrentGenerationSession(session: LocalGenerationSession): boolean {
  return session.isCurrent?.() !== false;
}

type RecipientResult = Readonly<{
  disposition: 'applied_hot' | 'restart_requested' | 'failed' | 'unavailable';
  reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
  errorCode: string | null;
}>;

export type ConnectedServiceAuthGroupGenerationConsumptionResult = ApplyAuthGroupGenerationToSessionsResult & Readonly<{
  acknowledgeable: boolean;
  outcome: ConnectedServiceAuthGroupGenerationConsumptionOutcome;
  resultsBySessionId: Readonly<Record<string, RecipientResult>>;
}>;

export type ConnectedServiceAuthGroupGenerationConsumptionOutcome =
  | 'adopted_current'
  | 'retryable_not_acknowledged'
  | 'superseded_by_newer_truth'
  | 'action_required_restart_required';

/**
 * Pure lower owner for at-least-once server-generation consumption. It deliberately has no quota,
 * candidate-selection or server-commit dependency: by the time this owner runs, group truth is an
 * immutable committed fact. Binding discovery decides membership; every reachable live runner
 * applies now. Offline sessions are outside this consumer and catch up from current server truth
 * when their runtime registers or is explicitly spawned/resumed.
 * Provider adoption proof is evaluated by the apply owner after dispatch, never as a
 * pre-dispatch recipient veto.
 */
export class ConnectedServiceAuthGroupGenerationConsumer {
  constructor(private readonly deps: Readonly<{
    applyCommittedGeneration(input: Readonly<{
      sessionId: string;
      fromProfileId: string | null;
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
      switchReason: ConnectedServiceSessionAuthSwitchReason;
      generationApplyReason: ConnectedServiceAuthGenerationRecipientApplyReason;
      executionAuthority: ConnectedServiceGenerationExecutionAuthority;
      applicationOwnerId?: string;
      signal?: AbortSignal;
    }>): Promise<Readonly<{
      reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
      errorCode: string | null;
      authoritativeGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact;
      providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
      restartRequested?: boolean;
    }>>;
    applySharedGenerationApplication?(input: Readonly<{
      representativeSessionId: string;
      applicationOwnerId: string;
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
      switchReason: ConnectedServiceSessionAuthSwitchReason;
      executionAuthority: ConnectedServiceGenerationExecutionAuthority;
      signal?: AbortSignal;
    }>): Promise<Readonly<{
      reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
      errorCode: string | null;
      authoritativeGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact;
      providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
      restartRequested?: boolean;
    }>>;
    resolveGenerationApplicationScope(input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      applicationOwnerId: string | null;
    }>): Promise<
      | Readonly<{
        status: 'supported';
        scope: 'per_session_runtime' | 'shared_group_auth_surface';
        ownerId: string;
      }>
      | Readonly<{
        status: 'unsupported' | 'unavailable';
        errorCode: string;
      }>
    >;
    verifySharedGenerationApplication(input: Readonly<{
      sessionId: string;
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
      applicationOwnerId: string;
    }>): Promise<ConnectedServiceProviderAdoptedGenerationTarget | null>;
    settleExactRecipientApplication?(input: Readonly<{
      sessionId: string;
      providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
    }>): Promise<void>;
    continueAfterExactRecipientApplication?(input: Readonly<{
      sessionId: string;
      providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
    }>): Promise<void>;
    notifyCurrentGroupTruth(input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      applicationOwnerId: string;
      currentTruth: SessionConnectedServiceAuthCurrentGroupTruthV1;
      applicationSettled?: true;
      isCurrent?: () => boolean;
    }>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>>;
  }>) {}

  async consumeUnavailable(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    unavailableReason: 'group_missing' | 'active_profile_missing';
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
    return await this.consumeCurrentTruth({
      serviceId: input.serviceId,
      currentTruth: {
        kind: 'current_auth_group_unavailable',
        groupId: input.groupId,
        unavailableReason: input.unavailableReason,
      },
      sessions: input.sessions,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async consumeAvailableCurrentTruth(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
    return await this.consumeCurrentTruth({
      serviceId: input.serviceId,
      currentTruth: {
        kind: 'current_auth_group_available',
        groupId: input.groupId,
        generation: input.generation,
        credentialRevision: input.credentialRevision,
      },
      sessions: input.sessions,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  private async consumeCurrentTruth(input: Readonly<{
    serviceId: ConnectedServiceId;
    currentTruth: SessionConnectedServiceAuthCurrentGroupTruthV1;
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
    input.signal?.throwIfAborted();
    const resultsBySessionId: Record<string, RecipientResult> = {};
    for (const session of input.sessions) {
      if (session.activity !== 'live' || !isCurrentGenerationSession(session)) continue;
      input.signal?.throwIfAborted();
      let application: Awaited<ReturnType<typeof this.deps.resolveGenerationApplicationScope>>;
      try {
        application = await this.deps.resolveGenerationApplicationScope({
          sessionId: session.sessionId,
          serviceId: input.serviceId,
          applicationOwnerId: session.applicationOwnerId ?? null,
        });
      } catch {
        application = { status: 'unavailable', errorCode: 'generation_application_scope_unavailable' };
      }
      if (!isCurrentGenerationSession(session)) continue;
      if (application.status !== 'supported') {
        resultsBySessionId[session.sessionId] = {
          disposition: 'failed',
          reconciliationDisposition: 'failed',
          errorCode: application.errorCode,
        };
        continue;
      }
      if (!isCurrentGenerationSession(session)) continue;
      const notification = await this.deps.notifyCurrentGroupTruth({
        sessionId: session.sessionId,
        serviceId: input.serviceId,
        applicationOwnerId: application.ownerId,
        currentTruth: input.currentTruth,
        ...(session.isCurrent ? { isCurrent: session.isCurrent } : {}),
      }).catch(() => ({ ok: false as const, errorCode: 'current_group_truth_notification_failed' }));
      if (!isCurrentGenerationSession(session)) continue;
      resultsBySessionId[session.sessionId] = notification.ok
        ? { disposition: 'applied_hot', reconciliationDisposition: 'converged', errorCode: null }
        : { disposition: 'failed', reconciliationDisposition: 'failed', errorCode: notification.errorCode };
    }
    const recipients = Object.entries(resultsBySessionId);
    const failures = recipients.flatMap(([sessionId, result]) => result.reconciliationDisposition === 'failed'
      ? [{ sessionId, errorCode: result.errorCode }]
      : []);
    return {
      ok: failures.length === 0,
      appliedSessionCount: recipients.length - failures.length,
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: input.sessions.filter((session) => session.activity !== 'live').length,
      failedSessionCount: failures.length,
      failures,
      resultsBySessionId,
      acknowledgeable: failures.length === 0,
      outcome: failures.length === 0 ? 'adopted_current' : 'retryable_not_acknowledged',
    };
  }

  async decideAndConsume(input: Readonly<{
    decideCommittedGeneration: () => Promise<ConnectedServiceAuthGroupCommittedGenerationFact>;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
    input.signal?.throwIfAborted();
    // The decision callback is invoked exactly once here, before recipient scheduling begins.
    // The immutable result—not the callback—is passed into consume, so no recipient can re-enter
    // candidate selection or server commit under stale quota/identity evidence.
    const committedGeneration = await input.decideCommittedGeneration();
    return await this.consume({
      committedGeneration,
      switchReason: input.switchReason,
      sessions: input.sessions,
      ...(input.signal ? { signal: input.signal } : {}),
      executionAuthority: input.executionAuthority,
    });
  }

  async consume(input: Readonly<{
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
    input.signal?.throwIfAborted();
    const resultsBySessionId: Record<string, RecipientResult> = {};
    const liveTargets: Array<Readonly<{
      sessionId: string;
      fromProfileId: string | null;
      applicationScope: 'per_session_runtime' | 'shared_group_auth_surface';
      applicationOwnerId: string;
      isCurrent?: () => boolean;
    }>> = [];

    for (const session of input.sessions) {
      input.signal?.throwIfAborted();
      if (session.activity !== 'live' || !isCurrentGenerationSession(session)) continue;
      // Recipient filtering is owned by the projection reconciler using exact revision proof.
      // The consumer never treats profile+generation alone as convergence because A rev1 -> A rev2
      // is an ABA change with the same group tuple.
      let application: Awaited<ReturnType<typeof this.deps.resolveGenerationApplicationScope>>;
      try {
        application = await this.deps.resolveGenerationApplicationScope({
          sessionId: session.sessionId,
          serviceId: input.committedGeneration.decisionCommittedTarget.serviceId,
          applicationOwnerId: session.applicationOwnerId ?? null,
        });
        input.signal?.throwIfAborted();
      } catch (error) {
        if (input.signal?.aborted) throw error;
        resultsBySessionId[session.sessionId] = {
          disposition: 'failed',
          reconciliationDisposition: 'failed',
          errorCode: 'generation_application_scope_unavailable',
        };
        continue;
      }
      if (!isCurrentGenerationSession(session)) continue;
      if (application.status !== 'supported') {
        resultsBySessionId[session.sessionId] = {
          disposition: 'failed',
          reconciliationDisposition: 'failed',
          errorCode: application.errorCode,
        };
        continue;
      }
      liveTargets.push({
        sessionId: session.sessionId,
        fromProfileId: session.fromProfileId ?? null,
        applicationScope: application.scope,
        applicationOwnerId: application.ownerId,
        ...(session.isCurrent ? { isCurrent: session.isCurrent } : {}),
      });
    }

    const fanout = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: input.committedGeneration,
      switchReason: input.switchReason,
      targets: liveTargets,
      executionAuthority: input.executionAuthority,
      ...(input.signal ? { signal: input.signal } : {}),
      applyCommittedGeneration: async (applyInput) => await this.deps.applyCommittedGeneration({
        ...applyInput,
        generationApplyReason: resolveGenerationRecipientApplyReason(input.switchReason),
      }),
      ...(this.deps.applySharedGenerationApplication
        ? { applySharedGenerationApplication: this.deps.applySharedGenerationApplication }
        : {}),
      verifySharedGenerationApplication: this.deps.verifySharedGenerationApplication,
      ...(this.deps.settleExactRecipientApplication
        ? { settleExactRecipientApplication: this.deps.settleExactRecipientApplication }
        : {}),
    });
    input.signal?.throwIfAborted();
    for (const [sessionId, result] of Object.entries(fanout.resultsBySessionId ?? {})) {
      const target = liveTargets.find((candidate) => candidate.sessionId === sessionId);
      if (!target || target.isCurrent?.() === false) continue;
      resultsBySessionId[sessionId] = {
        ...result,
        disposition: result.reconciliationDisposition === 'converged'
          ? 'applied_hot'
          : result.reconciliationDisposition === 'deferred_restart'
            ? result.restartRequested === true
              ? 'restart_requested'
              : 'failed'
            : result.errorCode === 'committed_generation_apply_unavailable'
              ? 'unavailable'
              : 'failed',
      };
    }
    const availableCredentialRevision = input.committedGeneration.decisionCommittedTarget.credentialRevision;
    for (const target of liveTargets) {
      if (target.isCurrent?.() === false) continue;
      const current = resultsBySessionId[target.sessionId];
      if (current?.reconciliationDisposition !== 'converged') continue;
      if (availableCredentialRevision === null) {
        resultsBySessionId[target.sessionId] = {
          disposition: 'failed',
          reconciliationDisposition: 'failed',
          errorCode: 'credential_revision_missing',
        };
        continue;
      }
      const notification = await this.deps.notifyCurrentGroupTruth({
        sessionId: target.sessionId,
        serviceId: input.committedGeneration.decisionCommittedTarget.serviceId,
        applicationOwnerId: target.applicationOwnerId,
        applicationSettled: true,
        ...(target.isCurrent ? { isCurrent: target.isCurrent } : {}),
        currentTruth: {
          kind: 'current_auth_group_available',
          groupId: input.committedGeneration.decisionCommittedTarget.groupId,
          generation: input.committedGeneration.decisionCommittedTarget.generation,
          credentialRevision: availableCredentialRevision,
        },
      }).catch(() => ({ ok: false as const, errorCode: 'current_group_truth_notification_failed' }));
      if (target.isCurrent?.() === false) {
        delete resultsBySessionId[target.sessionId];
        continue;
      }
      if (!notification.ok) {
        resultsBySessionId[target.sessionId] = {
          disposition: 'failed',
          reconciliationDisposition: 'failed',
          errorCode: notification.errorCode,
        };
        continue;
      }
      if (this.deps.continueAfterExactRecipientApplication) {
        const providerAdoptedTarget = fanout.resultsBySessionId?.[target.sessionId]?.providerAdoptedTarget;
        if (!providerAdoptedTarget) continue;
        await this.deps.continueAfterExactRecipientApplication({
          sessionId: target.sessionId,
          providerAdoptedTarget,
        }).catch(() => undefined);
      }
    }
    const acknowledgeable = input.sessions.filter((session) => (
      session.activity === 'live' && isCurrentGenerationSession(session)
    )).every((session) => {
      const result = resultsBySessionId[session.sessionId];
      return result?.reconciliationDisposition === 'converged';
    });
    const outcome: ConnectedServiceAuthGroupGenerationConsumptionOutcome = acknowledgeable
      ? 'adopted_current'
      : Object.values(resultsBySessionId).some((result) => result.reconciliationDisposition === 'superseded_after_apply')
        ? 'superseded_by_newer_truth'
        : Object.values(resultsBySessionId).some((result) => result.reconciliationDisposition === 'deferred_restart')
          ? 'action_required_restart_required'
          : 'retryable_not_acknowledged';
    const recipients = Object.entries(resultsBySessionId);
    const failures = recipients.flatMap(([sessionId, result]) => (
      result.disposition === 'failed' || result.disposition === 'unavailable'
        ? [{ sessionId, errorCode: result.errorCode }]
        : []
    ));
    return {
      ok: failures.length === 0,
      appliedSessionCount: recipients.filter(([, result]) => result.disposition === 'applied_hot').length,
      restartRequestedSessionCount: recipients.filter(([, result]) => result.disposition === 'restart_requested').length,
      skippedIdleSessionCount: fanout.skippedIdleSessionCount,
      failedSessionCount: failures.length,
      failures,
      resultsBySessionId,
      acknowledgeable,
      outcome,
    };
  }
}
