import type { ConnectedServiceSessionAuthSwitchReason } from '../../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';
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

type RecipientResult = Readonly<{
  providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
  disposition: 'applied_hot' | 'inactive' | 'deferred_restart' | 'restart_requested' | 'failed' | 'unavailable';
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

/**
 * Pure lower owner for at-least-once server-generation consumption. It deliberately has no quota,
 * candidate-selection or server-commit dependency: by the time this owner runs, group truth is an
 * committed fact. Binding discovery decides membership; reachable live runners apply now.
 * Inactive sessions resolve the current selection on their next start and require no local write.
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
      generationApplyReason: ConnectedServiceAuthGenerationRecipientApplyReason;
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
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
    }>): Promise<void>;
    clearAdoptedGeneration(input: Readonly<{
      sessionId: string;
      providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
    }>): Promise<void | Readonly<{ status: 'cleared' | 'superseded' }>>;
    resolveGenerationApplicationScope(input: Readonly<{
      sessionId: string;
      serviceId: ConnectedAccountServiceKey;
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
    serviceId: ConnectedAccountServiceKey;
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

  async consume(input: Readonly<{
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    sessions: readonly LocalGenerationSession[];
    signal?: AbortSignal;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>): Promise<ConnectedServiceAuthGroupGenerationConsumptionResult> {
    input.signal?.throwIfAborted();
    const resultsBySessionId: Record<string, RecipientResult> = {};
    const sessionsById = new Map(input.sessions.map(session => [session.sessionId, session]));
    const liveTargets: Array<Readonly<{
      sessionId: string;
      fromProfileId: string | null;
      applicationScope: 'per_session_runtime' | 'shared_group_auth_surface';
      applicationOwnerId: string;
      isCurrent?: () => boolean;
    }>> = [];

    const recordFailure = (sessionId: string, errorCode: string): void => {
      resultsBySessionId[sessionId] = {
        disposition: 'failed',
        reconciliationDisposition: 'failed',
        errorCode,
        pendingRecorded: false,
      };
    };

    for (const session of input.sessions) {
      input.signal?.throwIfAborted();
      if (session.isCurrent?.() === false) continue;
      if (session.activity !== 'live') {
        resultsBySessionId[session.sessionId] = {
          disposition: 'inactive',
          reconciliationDisposition: 'deferred_restart',
          errorCode: null,
          pendingRecorded: false,
        };
        continue;
      }
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
        recordFailure(session.sessionId, 'generation_application_scope_unavailable');
        continue;
      }
      if (application.status !== 'supported') {
        recordFailure(session.sessionId, application.errorCode);
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
      clearAdoptedGeneration: this.deps.clearAdoptedGeneration,
      verifySharedGenerationApplication: this.deps.verifySharedGenerationApplication,
    });
    input.signal?.throwIfAborted();
    for (const [sessionId, result] of Object.entries(fanout.resultsBySessionId ?? {})) {
      if (sessionsById.get(sessionId)?.isCurrent?.() === false) continue;
      resultsBySessionId[sessionId] = {
        ...result,
        disposition: result.reconciliationDisposition === 'converged'
          ? 'applied_hot'
          : result.reconciliationDisposition === 'deferred_restart'
            ? result.restartRequested === true
              ? 'restart_requested'
              : 'deferred_restart'
            : result.errorCode === 'committed_generation_apply_unavailable'
              ? 'unavailable'
              : 'failed',
      };
    }
    const acknowledgeable = input.sessions.every((session) => {
      if (session.isCurrent?.() === false) return true;
      const result = resultsBySessionId[session.sessionId];
      return result?.disposition === 'inactive' || result?.reconciliationDisposition === 'converged';
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
      skippedIdleSessionCount: recipients.filter(([, result]) => result.disposition === 'inactive' || result.disposition === 'deferred_restart').length,
      failedSessionCount: failures.length,
      failures,
      resultsBySessionId,
      acknowledgeable,
      outcome,
    };
  }
}
