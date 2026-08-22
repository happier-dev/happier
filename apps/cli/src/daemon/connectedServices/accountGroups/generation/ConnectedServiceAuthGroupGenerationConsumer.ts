import type { ConnectedServiceSessionAuthSwitchReason } from '../../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type { ConnectedServiceId } from '@happier-dev/protocol';
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
}>;

type RecipientResult = Readonly<{
  disposition: 'applied_hot' | 'deferred_persisted' | 'restart_requested' | 'failed' | 'unavailable';
  reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
  errorCode: string | null;
  pendingRecorded: boolean;
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

type PendingInput = Readonly<{
  sessionId: string;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  disposition: Exclude<ConnectedServiceAuthGenerationReconciliationDisposition, 'converged'>;
  errorCode: string | null;
}>;

/**
 * Pure lower owner for at-least-once server-generation consumption. It deliberately has no quota,
 * candidate-selection or server-commit dependency: by the time this owner runs, group truth is an
 * immutable committed fact. Binding discovery decides membership; every reachable live runner
 * applies now and every non-live session records that exact desired generation before cursor ack.
 * Provider adoption proof is evaluated by the apply/clear owner after dispatch, never as a
 * pre-dispatch recipient veto.
 */
export class ConnectedServiceAuthGroupGenerationConsumer {
  constructor(private readonly deps: Readonly<{
    applyCommittedGeneration(input: Readonly<{
      sessionId: string;
      fromProfileId: string | null;
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
      switchReason: ConnectedServiceSessionAuthSwitchReason;
      executionAuthority: ConnectedServiceGenerationExecutionAuthority;
      applicationOwnerId?: string;
      applicationCohortSessionIds?: readonly string[];
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
      applicationCohortSessionIds: readonly string[];
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
    enforceGroupUnavailable?(input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
    }>): Promise<void>;
    clearAdoptedGeneration(input: Readonly<{
      sessionId: string;
      providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
    }>): Promise<void | Readonly<{ status: 'cleared' | 'superseded' }>>;
    resolveGenerationApplicationScope(input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      applicationOwnerId: string | null;
    }>): Promise<
      | Readonly<{
        status: 'supported';
        scope: 'per_session_runtime' | 'shared_group_auth_surface' | 'request_time_auth';
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
  }>) {}

  async settleExactRecipientApplication(input: Readonly<{
    sessionId: string;
    providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
  }>): Promise<void | Readonly<{ status: 'cleared' | 'superseded' }>> {
    return await this.deps.clearAdoptedGeneration(input);
  }

  async consumeUnavailable(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    sessions: readonly Pick<LocalGenerationSession, 'sessionId' | 'activity'>[];
    signal?: AbortSignal;
  }>): Promise<Readonly<{ acknowledgeable: boolean; recordedSessionCount: number }>> {
    let recordedSessionCount = 0;
    let acknowledgeable = true;
    for (const session of input.sessions) {
      input.signal?.throwIfAborted();
      try {
        if (session.activity === 'live') {
          if (!this.deps.enforceGroupUnavailable) {
            acknowledgeable = false;
            continue;
          }
          await this.deps.enforceGroupUnavailable({
            sessionId: session.sessionId,
            serviceId: input.serviceId,
            groupId: input.groupId,
          });
          input.signal?.throwIfAborted();
          recordedSessionCount += 1;
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        acknowledgeable = false;
      }
    }
    return { acknowledgeable, recordedSessionCount };
  }

  async decideAndConsume(input: Readonly<{
    decideCommittedGeneration: () => Promise<ConnectedServiceAuthGroupCommittedGenerationFact>;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
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
    }>> = [];

    const recordPending = async (pending: PendingInput): Promise<void> => {
      input.signal?.throwIfAborted();
      resultsBySessionId[pending.sessionId] = {
        disposition: pending.disposition === 'deferred_restart' ? 'deferred_persisted' : 'failed',
        reconciliationDisposition: pending.disposition,
        errorCode: pending.errorCode,
        pendingRecorded: false,
      };
    };

    for (const session of input.sessions) {
      input.signal?.throwIfAborted();
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
        await recordPending({
          sessionId: session.sessionId,
          committedGeneration: input.committedGeneration,
          disposition: 'failed',
          errorCode: 'generation_application_scope_unavailable',
        });
        continue;
      }
      if (application.status !== 'supported') {
        await recordPending({
          sessionId: session.sessionId,
          committedGeneration: input.committedGeneration,
          disposition: 'failed',
          errorCode: application.errorCode,
        });
        continue;
      }
      // The projection reconciler installs the committed group truth before invoking this
      // consumer. A request-time-auth runtime reads that canonical projection on every request,
      // so no per-session push, shared-surface proof, or restart is needed here.
      if (application.scope === 'request_time_auth') {
        resultsBySessionId[session.sessionId] = {
          disposition: 'applied_hot',
          reconciliationDisposition: 'converged',
          errorCode: null,
          pendingRecorded: false,
        };
        continue;
      }
      if (session.activity !== 'live' && application.scope !== 'shared_group_auth_surface') {
        await recordPending({
          sessionId: session.sessionId,
          committedGeneration: input.committedGeneration,
          disposition: 'deferred_restart',
          errorCode: null,
        });
        continue;
      }
      liveTargets.push({
        sessionId: session.sessionId,
        fromProfileId: session.fromProfileId ?? null,
        applicationScope: application.scope,
        applicationOwnerId: application.ownerId,
      });
    }

    const fanout = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: input.committedGeneration,
      switchReason: input.switchReason,
      targets: liveTargets,
      executionAuthority: input.executionAuthority,
      ...(input.signal ? { signal: input.signal } : {}),
      applyCommittedGeneration: this.deps.applyCommittedGeneration,
      ...(this.deps.applySharedGenerationApplication
        ? { applySharedGenerationApplication: this.deps.applySharedGenerationApplication }
        : {}),
      clearAdoptedGeneration: this.deps.clearAdoptedGeneration,
      verifySharedGenerationApplication: this.deps.verifySharedGenerationApplication,
    });
    input.signal?.throwIfAborted();
    for (const [sessionId, result] of Object.entries(fanout.resultsBySessionId ?? {})) {
      resultsBySessionId[sessionId] = {
        ...result,
        disposition: result.reconciliationDisposition === 'converged'
          ? 'applied_hot'
          : result.reconciliationDisposition === 'deferred_restart'
            ? result.restartRequested === true
              ? 'restart_requested'
              : 'deferred_persisted'
            : result.errorCode === 'committed_generation_apply_unavailable'
              ? 'unavailable'
              : 'failed',
      };
    }
    const acknowledgeable = input.sessions.every((session) => {
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
      skippedIdleSessionCount: recipients.filter(([, result]) => result.disposition === 'deferred_persisted').length,
      failedSessionCount: failures.length,
      failures,
      resultsBySessionId,
      acknowledgeable,
      outcome,
    };
  }
}
