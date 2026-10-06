import type { StoredCredentials } from '@/persistence';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SessionContinuationInspectionV1Schema } from '@happier-dev/protocol/sessions/agentTransition';
import type { WorkflowAccountRunActionDeps, WorkflowProgressEnvelopeV1, WorkflowMaterializedLeafV1, ReviewWalkthroughObservation } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { resumeActionCompletionV1, readActionCompletionRunObservationV1, isActionCompletionRunObservationPendingV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { cancelSessionInput } from '@/session/services/cancelSessionInput';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { WorkflowInvocationRecoveryObservation } from './recovery';
import { classifyWorkflowSessionInputResult, observeWorkflowDetachedExecutionRunInput, observeWorkflowSessionInputResult, resolveWorkflowDetachedExecutionRunInputTurn, stopWorkflowPendingExecutionRunInput } from './stepExecution';

type WorkflowInvocationRecoveryEvidence = Awaited<ReturnType<NonNullable<WorkflowAccountRunActionDeps['observeRecovery']>>>;

type RecoveryActionExecutor = Readonly<{
  execute: (
    actionId: 'execution.run.get' | 'execution.run.stop',
    input: Readonly<{ sessionId: null; runId: string; includeStructured?: false }>,
    context: Readonly<{ surface: 'agent'; authority: 'account_automation'; executionRunTargetMachineId: string; signal?: AbortSignal }>,
  ) => Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode: string }>>;
}>;

export async function resolveWorkflowAuthorizedSession(params: Readonly<{
  credentials: StoredCredentials; sessionId: string; machineId: string; signal?: AbortSignal;
}>) {
  const target = await resolveSessionTransportContext({
    credentials: params.credentials, idOrPrefix: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!target.ok || target.sessionId !== params.sessionId) return null;
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    accountEncryptionMode: target.accountEncryptionCurrentness.mode,
    rawSession: target.rawSession,
  });
  return metadata && metadata.machineId === params.machineId ? { target, metadata } : null;
}

/** Fresh exact native facts only; the Protocol owner decides which controls they permit. */
export async function observeWorkflowInvocationRecoveryEvidence(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  progress: WorkflowProgressEnvelopeV1;
  getRun: (request: Readonly<{ runId: string; includeStructured: false }>) => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<WorkflowInvocationRecoveryEvidence> {
  const unavailable: WorkflowInvocationRecoveryEvidence = {
    activity: 'unknown', canReattach: false, canContinueConversation: false,
  };
  const execution = params.progress.execution;
  if (!execution) return unavailable;
  try {
    if (execution.kind === 'action') {
      if (!execution.awaitedRuns?.length) return unavailable;
      const snapshots = await Promise.all(execution.awaitedRuns.map(async (run) => {
        const parsed = ExecutionRunGetResponseSchema.safeParse(await params.getRun({ runId: run.runId, includeStructured: false }));
        return parsed.success && parsed.data.run.runId === run.runId ? parsed.data : undefined;
      }));
      if (snapshots.some((snapshot) => snapshot === undefined)) return unavailable;
      return { activity: snapshots.some((snapshot) => snapshot?.run.status === 'running') ? 'active' : 'not_active',
        canReattach: true, canContinueConversation: false };
    }
    if (execution.kind === 'detached_run') {
      const parsed = ExecutionRunGetResponseSchema.safeParse(await params.getRun({ runId: execution.runId, includeStructured: false }));
      if (!parsed.success || parsed.data.run.runId !== execution.runId) return unavailable;
      const nativeRun = parsed.data.run;
      const turn = resolveWorkflowDetachedExecutionRunInputTurn(nativeRun, execution.runId, execution.localInputId);
      return {
        activity: turn ? turn.state === 'active' ? 'active' : 'not_active' : 'unknown',
        canReattach: turn !== null,
        // This is the loaded retained runtime's declaration, not a saved resume
        // handle or a guess based on intent/status/Agent id.
        canContinueConversation: nativeRun.lifecycle?.state === 'current'
          && nativeRun.interaction?.capabilities.delivery.includes('newTurn') === true,
      };
    }
    const authorized = await resolveWorkflowAuthorizedSession({ ...params, sessionId: execution.sessionId });
    if (!authorized) return unavailable;
    const observed = await observeWorkflowSessionInputResult({ credentials: params.credentials,
      sessionId: execution.sessionId, localId: execution.localInputId, deadlineMs: Date.now(),
      ...(params.signal ? { signal: params.signal } : {}) });
    if (!observed.ok || observed.sessionId !== execution.sessionId || observed.localId !== execution.localInputId) return unavailable;
    const result = classifyWorkflowSessionInputResult(observed.result);
    const evidence: WorkflowInvocationRecoveryEvidence = {
      activity: result.kind === 'pending' ? 'unknown' : 'not_active',
      canReattach: true, canContinueConversation: false,
    };
    try {
      const { target, metadata } = authorized;
      if (target.rawSession.archivedAt !== null && target.rawSession.archivedAt !== undefined) return evidence;
      const agentId = resolveAgentIdFromSessionMetadata(metadata);
      if (!agentId) return evidence;
      const request = { credentials: params.credentials, machineId: params.machineId,
        ...(params.signal ? { signal: params.signal } : {}) };
      const inspected = SessionContinuationInspectionV1Schema.safeParse(await callMachineRpc({ ...request,
        method: RPC_METHODS.SESSION_CONTINUATION_INSPECT,
        request: { v: 1, sourceSessionId: execution.sessionId, selection: { v: 1, agentId } },
      }));
      if (!inspected.success || inspected.data.type !== 'available') return evidence;
      const described = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callMachineRpc({ ...request,
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, request: { machineId: params.machineId },
      }));
      const capabilities = described.success ? described.data.projection.agentsById[agentId]?.capabilities?.sessions : undefined;
      if (!capabilities?.delivery.includes('newTurn')) return evidence;
      const canContinueConversation = target.rawSession.active === true
        || (capabilities.open.includes('resume') && Boolean(buildInactiveSessionResumeSpawnOptions({
          sessionId: execution.sessionId, rawSession: target.rawSession, metadata,
        })?.resume));
      return { ...evidence, canContinueConversation };
    } catch {
      // Losing capability inspection does not erase exact settled-input proof.
      return evidence;
    }
  } catch {
    return unavailable;
  }
}

/** Exact observation/stop adapter. It never sends, starts, or resolves a provider handle. */
export function createWorkflowInvocationRecoveryObserver(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  actionExecutor: RecoveryActionExecutor;
  now?: () => number;
  observeSession?: typeof observeWorkflowSessionInputResult;
  cancelSession?: typeof cancelSessionInput;
  observeRun?: typeof observeWorkflowDetachedExecutionRunInput;
  nativeActionRuns?: Readonly<{
    get: (runId: string, signal?: AbortSignal) => Promise<unknown>;
    stop: (runId: string, signal?: AbortSignal) => Promise<unknown>;
    wait: (runId: string, signal?: AbortSignal, observation?: ReviewWalkthroughObservation) => Promise<unknown>;
  }>;
}>) {
  const now = params.now ?? Date.now;
  const observeSession = params.observeSession ?? observeWorkflowSessionInputResult;
  const cancelSession = params.cancelSession ?? cancelSessionInput;
  const observeRun = params.observeRun ?? observeWorkflowDetachedExecutionRunInput;
  return async (input: Readonly<{
    progress: import('@happier-dev/protocol').WorkflowProgressEnvelopeV1;
    terminalParent: boolean;
    cancellationRequested: boolean;
    observationOnly?: boolean;
    frozenActionContract?: WorkflowMaterializedLeafV1['actionContract'];
    signal?: AbortSignal;
  }>): Promise<WorkflowInvocationRecoveryObservation> => {
    const execution = input.progress.execution;
    if (!execution) return { kind: 'unresolved', code: 'workflow_execution_correspondence_missing' };
    if (execution.kind === 'action') {
      const id = ActionIdSchema.safeParse(execution.actionId);
      if (!id.success || !execution.awaitedRuns?.length || execution.output === undefined || !input.frozenActionContract?.completion) {
        return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
      }
      if (!params.nativeActionRuns) return { kind: 'unresolved', code: 'execution_run_observation_unavailable' };
      try {
        const snapshots = await Promise.all(execution.awaitedRuns.map(async (run) => {
          const parsed = ExecutionRunGetResponseSchema.safeParse(await params.nativeActionRuns!.get(run.runId, input.signal));
          if (!parsed.success || parsed.data.run.runId !== run.runId) throw new Error('execution_run_correspondence_mismatch');
          return { ...run, native: parsed.data };
        }));
        const active = snapshots.filter(({ native, observation }) => native.run.status === 'running'
          && (!observation || isActionCompletionRunObservationPendingV1(readActionCompletionRunObservationV1(native, observation))));
        if (active.length) {
          let stopUnavailable = false;
          if (!input.observationOnly && (input.terminalParent || input.cancellationRequested)) {
            const stopped = await Promise.allSettled(active.map(async ({ runId }) => await params.nativeActionRuns!.stop(runId, input.signal)));
            stopUnavailable = stopped.some((result) => result.status === 'rejected');
          }
          // Stop acceptance is not terminal proof. The indexed recovery owner
          // retains this exact native wait even if the Stop response was lost.
          return { kind: 'unresolved', code: stopUnavailable ? 'execution_run_observation_unavailable' : 'execution_run_input_pending',
            ...(!input.observationOnly ? { waitForCompletion: async () => {
              const waited = await Promise.allSettled(active.map(async ({ runId, observation }) => {
                const parsed = ExecutionRunGetResponseSchema.safeParse(await params.nativeActionRuns!.wait(runId, input.signal, observation));
                if (!parsed.success || parsed.data.run.runId !== runId
                  || isActionCompletionRunObservationPendingV1(readActionCompletionRunObservationV1(parsed.data, observation))) {
                  throw new Error('execution_run_terminal_observation_unavailable');
                }
              }));
              for (const result of waited) if (result.status === 'rejected') throw result.reason;
            } } : {}),
          };
        }
        const completion = await resumeActionCompletionV1({ actionId: execution.actionId, completion: input.frozenActionContract.completion,
          state: { output: execution.output, awaitedRuns: execution.awaitedRuns },
          resolveDeclaration: () => getActionSpec(id.data).completion,
          observeRun: async (run) => {
            const snapshot = snapshots.find((entry) => entry.runId === run.runId && entry.key === run.key);
            return snapshot ? readActionCompletionRunObservationV1(snapshot.native, run.observation)
              : { kind: 'outcome_uncertain', code: 'execution_run_correspondence_mismatch' };
          } });
        return completion.kind === 'completed' ? { kind: 'completed', result: completion.value }
          : { kind: completion.kind, code: completion.errorCode };
      } catch { return { kind: 'unresolved', code: 'execution_run_observation_unavailable' }; }
    }
    if (execution.kind === 'session') {
      let observed: Awaited<ReturnType<typeof observeSession>>;
      try {
        observed = await observeSession({
          credentials: params.credentials,
          sessionId: execution.sessionId,
          localId: execution.localInputId,
          deadlineMs: now(),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        return { kind: 'unresolved', code: 'session_input_result_read_failed' };
      }
      if (!observed.ok) return { kind: 'unresolved', code: observed.code };
      const result = classifyWorkflowSessionInputResult(observed.result);
      switch (result.kind) {
        case 'completed': return result;
        case 'failed': return result;
        case 'pending':
          if (input.observationOnly || (!input.terminalParent && !input.cancellationRequested)) {
            return { kind: 'unresolved', code: 'session_input_pending' };
          }
          break;
        case 'cancelled': return { ...result, code: 'session_input_cancelled' };
      }
      let cancelled: Awaited<ReturnType<typeof cancelSession>>;
      try {
        cancelled = await cancelSession({
          credentials: params.credentials,
          sessionId: execution.sessionId,
          localId: execution.localInputId,
        });
      } catch {
        return { kind: 'unresolved', code: 'session_input_cancel_unavailable' };
      }
      switch (cancelled.kind) {
        case 'pending_retired': return { kind: 'cancelled', code: 'session_input_pending_retired' };
        // Acknowledging a stop is not exact terminal evidence.
        case 'turn_cancel_requested': return { kind: 'unresolved', code: 'session_input_turn_cancel_requested' };
        case 'turn_cancel_refused':
        case 'turn_cancel_unavailable': return { kind: 'unresolved', code: cancelled.code };
      }
    }

    const sessionId = null;
    let actionFailure: string | null = null;
    const actionContext = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      executionRunTargetMachineId: params.machineId,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    let observed: Awaited<ReturnType<typeof observeRun>>;
    try {
      observed = await observeRun({
        runId: execution.runId,
        localInputId: execution.localInputId,
        get: async (request) => {
          const result = await params.actionExecutor.execute(
            'execution.run.get',
            { sessionId, ...request },
            actionContext,
          );
          if (!result.ok) {
            actionFailure = result.errorCode;
            return null;
          }
          return result.result;
        },
      });
    } catch {
      return { kind: 'unresolved', code: actionFailure ?? 'execution_run_result_read_failed' };
    }
    if (actionFailure) return { kind: 'unresolved', code: actionFailure };
    if (observed.kind !== 'pending') return observed;
    if (input.observationOnly || (!input.terminalParent && !input.cancellationRequested)) {
      return { kind: 'unresolved', code: 'execution_run_input_pending' };
    }
    const { signal: _signal, ...stopContext } = actionContext;
    return await stopWorkflowPendingExecutionRunInput({
      runId: execution.runId,
      localInputId: execution.localInputId,
      stop: async () => {
        try {
          return await params.actionExecutor.execute(
            'execution.run.stop',
            { sessionId, runId: execution.runId },
            stopContext,
          );
        } catch {
          return { ok: false, errorCode: 'execution_run_stop_unavailable' };
        }
      },
      get: async (request) => {
        const result = await params.actionExecutor.execute(
          'execution.run.get',
          { sessionId, ...request },
          stopContext,
        );
        return result.ok ? result.result : null;
      },
      observe: observeRun,
    });
  };
}
