import { randomUUID } from 'node:crypto';

import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type {
  BackendTargetRefV1,
  ExecutionRunResultContractV1,
  ExecutionRunTurnResultV1,
  SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import { normalizeStrictJsonValue } from '@happier-dev/protocol';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunState } from '../executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import {
  readExecutionRunControllerHostBarrier,
  raceExecutionRunControllerFailure,
  throwIfExecutionRunControllerFailed,
} from '@/agent/executionRuns/controllers/failureSignal';
import type { FinishExecutionRun } from '../executionRunFinishRun';
import { resumeBackendControllerForResumableRun } from '../resumeBackendController';
import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from '../turnDelivery';
import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import type { ExecutionRunPermissionRequestStoreProvider } from '../executionRunPermissionResponseTarget';
import type { ExecutionRunPermissionRequestStore } from '../executionRunPermissionResponseTarget';
import type { AgentStateResponseTargetDispatch } from '@/agent/permissions/agentStateRequestStore';
import { resolveExecutionRunIntentProfile, resolveExecutionRunIntentProfileFromCatalog, type ExecutionRunProfileContributionCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunTranscriptPublisher } from '../executionRunTranscriptPublisher';
import { isExecutionRunTranscriptCustodyError } from '../executionRunTranscriptPublisher';
import { settleExecutionRunController } from '../settleExecutionRunController';
import { readExecutionRunErrorCode } from '../errors';
import {
  buildExecutionRunResultContractPrompt,
  decodeExecutionRunProfileResult,
} from '@happier-dev/protocol';
import { projectExecutionRunWorkflowInputAcceptance, type ExecutionRunWorkflowObservationSink } from '../executionRunWorkflowObservation';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { publishExecutionRunTurn } from '../publishExecutionRunTurn';
import type { ReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { readRuntimeTurnFailureAlreadySurfacedEvent } from '@/agent/runtime/turns/runtimeTurnOperations';

function buildObservedTurnResult(
  contract: ExecutionRunResultContractV1 | undefined,
  value: import('@happier-dev/protocol').JsonValue | string,
): ExecutionRunTurnResultV1 {
  if (!contract || contract.kind === 'text') {
    return { kind: 'text', value: typeof value === 'string' ? value : JSON.stringify(value) };
  }
  if (contract.kind === 'decision') {
    return { kind: 'decision', value: typeof value === 'string' ? value : JSON.stringify(value) };
  }
  return { kind: 'json', value };
}

export async function sendBackendLongLivedRun(args: Readonly<{
  runId: string;
  reviewComments?: ReviewRunCommentService;
  params: Readonly<{
    message: string;
    resume?: boolean;
    delivery?: unknown;
    localInputId?: string;
    resultContract?: ExecutionRunResultContractV1;
    structuredInput?: import('@happier-dev/protocol').HappierStructuredInputV1;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    workflowObservationSink?: ExecutionRunWorkflowObservationSink;
  }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: {
    runId?: string;
    controllerOccurrenceId: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }) => ExecutionRunHostRuntime;
  maxTurns: number | null;
  getNowMs: () => number;
  finishRun: FinishExecutionRun;
  sendAcp: ExecutionRunTranscriptPublisher;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  permissionRequestStore?: ExecutionRunPermissionRequestStore;
  handlePermissionResponseTarget?: (dispatch: AgentStateResponseTargetDispatch) => Promise<boolean>;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  onPublicStateUpdated?: (runId: string) => void;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  authorizeProviderEffect?: () => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
  const admittedController = args.controllers.get(args.runId) ?? null;
  if (
    args.params.resume !== true
    && admittedController?.kind === 'backend'
    && !admittedController.runtimeId
    && admittedController.provisioningPromise
  ) {
    await admittedController.provisioningPromise;
  }
  const run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  const wantsResume = args.params.resume === true;
  const delivery = normalizeExecutionRunSendDelivery(args.params.delivery);
  if (run.status !== 'running' && !(wantsResume && run.retentionPolicy === 'resumable')) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }
  if (run.runClass !== 'long_lived' && !(wantsResume && run.retentionPolicy === 'resumable')) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
  }

  const ctrl = args.controllers.get(args.runId) ?? null;
  if (ctrl && ctrl.kind === 'voice_agent') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
  }

  const backendCtrl = ctrl && ctrl.kind === 'backend' ? ctrl : null;

  if (!backendCtrl || !backendCtrl.runtimeId) {
    if (wantsResume && run.retentionPolicy === 'resumable') {
      const resumed = await resumeBackendControllerForResumableRun({
        runId: args.runId,
        run,
        runs: args.runs,
        controllers: args.controllers,
        budgetRegistry: args.budgetRegistry,
        createRuntime: args.createRuntime,
        sendAcp: args.sendAcp,
        parentProvider: args.parentProvider,
        streamedTranscriptSession: args.streamedTranscriptSession,
        getPermissionRequestStore: args.getPermissionRequestStore,
        writeActivityMarker: args.writeActivityMarker,
        getNowMs: args.getNowMs,
        profileCatalog: args.profileCatalog,
        ...(args.params.causalPermissionAuthority
          ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
          : {}),
        ...(args.onPublicStateUpdated ? { onPublicStateUpdated: args.onPublicStateUpdated } : {}),
        requireReplayCapture: run.runClass === 'long_lived',
        onModelOutput: () => {
          void args.writeActivityMarker(args.runId, args.getNowMs());
        },
      });
      if (!resumed.ok) return resumed;
    } else {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    }
  }

  const ctrl2 = args.controllers.get(args.runId) ?? null;
  if (!ctrl2 || ctrl2.kind !== 'backend' || !ctrl2.runtimeId) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }
  if (ctrl2.cancelled) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  if (ctrl2.initialPendingInputAdmission) {
    const admissionBarrier = ctrl2.initialPendingInputAdmission;
    const initialAdmission = await admissionBarrier;
    if (
      ctrl2.cancelled
      || args.controllers.get(args.runId) !== ctrl2
      || args.runs.get(args.runId)?.status !== 'running'
    ) {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    }
    if (initialAdmission === 'unknown') {
      return {
        ok: false,
        errorCode: 'execution_run_initial_input_outcome_unknown',
        error: 'Initial input custody is unresolved',
      };
    }
    if (ctrl2.initialPendingInputAdmission === admissionBarrier) {
      ctrl2.initialPendingInputAdmission = undefined;
    }
  }

  const publishInputTurns = (): void => {
    if (!ctrl2.inputTurnOccurrenceId) return;
    const currentRun = args.runs.get(args.runId);
    if (!currentRun) return;
    args.runs.set(args.runId, {
      ...currentRun,
      inputTurns: {
        occurrenceId: ctrl2.inputTurnOccurrenceId,
        ...(ctrl2.currentInputTurn ? { current: ctrl2.currentInputTurn } : {}),
        ...(ctrl2.lastInputTurn ? { last: ctrl2.lastInputTurn } : {}),
      },
    });
    args.onPublicStateUpdated?.(args.runId);
  };

  if (args.authorizeProviderEffect) {
    const admission = await args.authorizeProviderEffect();
    if (!admission.ok) return admission;
  }

  if (ctrl2.turnInFlight) {
    if (args.params.localInputId || args.params.resultContract) {
      return {
        ok: false,
        errorCode: 'execution_run_not_allowed',
        error: 'Exact per-turn results require a new ordinary prompt turn',
      };
    }
    // A provider-side failure after invocation cannot prove whether the input was
    // accepted. Keep the existing turn custody exclusive until the runtime supplies a
    // completion/terminal fact (or the Run is explicitly stopped); steering or replacing
    // it here could execute a second input beside the first.
    if (ctrl2.turnCancelReason === 'outcome_unknown') {
      return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
    }
    const hasSteer = typeof ctrl2.backend.steerInput === 'function';
    const action = resolveInFlightDeliveryAction({ delivery, hasSteer });
    if (action === 'busy') {
      return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
    }
    if (action === 'steer') {
      try {
        const result = await ctrl2.backend.steerInput!(
          ctrl2.runtimeId,
          {
            text: args.params.message,
            ...(args.params.structuredInput
              ? { structuredInput: normalizeStrictJsonValue(args.params.structuredInput) }
              : {}),
          },
          args.params.causalPermissionAuthority
            ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
            : undefined,
        );
        if (result.status !== 'admitted') {
          return { ok: false, errorCode: result.diagnostic.code, error: result.diagnostic.message ?? result.status };
        }
      } catch (e) {
        await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
        // Once the provider steer has been invoked, a thrown error cannot prove
        // whether the provider applied it. Keep the existing turn exclusive so a
        // second steer cannot overlap or duplicate the first one.
        ctrl2.turnCancelReason = 'outcome_unknown';
        ctrl2.turnCancelEpoch = ctrl2.turnEpoch;
        return {
          ok: false,
          errorCode: 'execution_run_send_outcome_unknown',
          error: 'The steer may have been accepted before the provider response failed',
        };
      }
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
      return { ok: true };
    }

    // cancel_and_send
    ctrl2.turnCancelReason = 'steer';
    ctrl2.turnCancelEpoch = ctrl2.turnEpoch;
    try {
      await ctrl2.backend.cancel(ctrl2.runtimeId);
    } catch {
      // best effort
    }
  }

  if (typeof args.maxTurns === 'number' && ctrl2.turnCount >= args.maxTurns) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Turn limit exceeded' };
  }

  const thisEpoch = ctrl2.turnEpoch + 1;
  const localInputId = args.params.localInputId?.trim() || null;
  const turnId = `${args.runId}-turn-${thisEpoch}`;
  const clearWorkflowObservation = (): void => {
    if (localInputId && ctrl2.workflowObservation?.localInputId === localInputId) {
      ctrl2.workflowObservation = undefined;
    }
  };
  ctrl2.turnEpoch = thisEpoch;
  ctrl2.turnInFlight = true;
  ctrl2.buffer = '';
  ctrl2.sidechainStreamBuffer = '';
  ctrl2.sidechainStreamKey = '';
  if (localInputId) {
    ctrl2.inputTurnOccurrenceId ??= randomUUID();
    ctrl2.currentInputTurn = {
      turnId,
      inputIds: [localInputId],
      state: 'active',
    };
    if (args.params.workflowObservationSink) {
      ctrl2.workflowObservation = {
        workflowRunId: args.params.workflowObservationSink.workflowRunId,
        localInputId,
        sink: args.params.workflowObservationSink,
        usage: createExactTurnUsageAccumulator(),
      };
    }
    if (args.permissionRequestStore && args.handlePermissionResponseTarget) {
      const releaseResponseTarget = args.permissionRequestStore.registerResponseTargetHandler(
        'execution_run_host_bridge',
        args.handlePermissionResponseTarget,
      );
      ctrl2.currentInputPermissionRequestStore = {
        localInputId,
        turnId,
        store: args.permissionRequestStore,
        releaseResponseTarget,
      };
    }
    publishInputTurns();
  }

  ctrl2.turnCount += 1;
  // Persist the cumulative turn count so resuming cannot reset enforcement (for example maxTurns).
  const runAfterTurn = args.runs.get(args.runId);
  if (runAfterTurn) {
    args.runs.set(args.runId, { ...runAfterTurn, turnCount: ctrl2.turnCount });
  }
  // One effectful provider send only. A thrown error after invocation does not prove the
  // provider rejected the prompt, so replaying it here could execute the same input twice.
  const unsubscribeAcceptance = ctrl2.workflowObservation?.localInputId === localInputId
    ? ctrl2.backend.subscribeRuntimeEvents?.((event) => {
      if (event.kind === 'input-accepted' && localInputId && event.inputIds.includes(localInputId)) {
        projectExecutionRunWorkflowInputAcceptance(ctrl2, args.runId, event);
      }
    }) : undefined;
  const runtimeLifetime = ctrl2.backend.getRuntimeLifetimeSignal();
  const releaseAcceptanceObservation = () => {
    unsubscribeAcceptance?.();
    runtimeLifetime.removeEventListener('abort', releaseAcceptanceObservation);
  };
  if (unsubscribeAcceptance) {
    if (runtimeLifetime.aborted) releaseAcceptanceObservation();
    else runtimeLifetime.addEventListener('abort', releaseAcceptanceObservation, { once: true });
  }
  let providerSendInvoked = false;
  const sendPromise = Promise.resolve().then(async () => {
    const resultPrompt = buildExecutionRunResultContractPrompt(args.params.resultContract);
    const profile = args.profileCatalog ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog,
      run.intent, run.profileId, run.profileSourceCustody) : resolveExecutionRunIntentProfile(run.intent);
    const initialContext = ctrl2.turnCount === 1 ? profile.buildInitialInputContext?.({ start: run, structuredMeta: run.structuredMeta }) : '';
    const text = [initialContext, args.params.message, resultPrompt].filter(Boolean).join('\n\n');
    providerSendInvoked = true;
    return await ctrl2.backend.deliverInput(
      ctrl2.runtimeId!,
      {
        text,
        ...(args.params.structuredInput
          ? { structuredInput: normalizeStrictJsonValue(args.params.structuredInput) }
          : {}),
      },
      localInputId || args.params.resultContract || args.params.causalPermissionAuthority
        ? {
            ...(localInputId ? { localId: localInputId } : {}),
            ...(args.params.resultContract ? { resultContract: args.params.resultContract } : {}),
            ...(args.params.causalPermissionAuthority
              ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
              : {}),
          }
        : undefined,
    );
  });

  const runCompletionLoop = async (): Promise<void> => {
    const admitNextInput = async ({ instructions, localId }: Readonly<{ instructions: string; localId: string }>) => {
      const result = await sendBackendLongLivedRun({ ...args,
        params: { message: instructions, localInputId: localId,
          ...(args.params.causalPermissionAuthority ? { causalPermissionAuthority: args.params.causalPermissionAuthority } : {}) },
      });
      return result.ok ? { status: 'accepted' as const } : {
        status: result.errorCode === 'execution_run_send_outcome_unknown' ? 'outcomeUnknown' as const : 'rejected' as const,
        code: result.errorCode, message: result.error,
      };
    };
    try {
      if (ctrl2.backend.waitForTurnCompletion) {
        let completionError: unknown;
        try {
          await raceExecutionRunControllerFailure(ctrl2, ctrl2.backend.waitForTurnCompletion());
        } catch (error) {
          completionError = error;
        }
        // Provider usage and resume identity are emitted before terminal
        // truth, but their exact Workflow sink is asynchronous. Keep that
        // ordering even when the provider completion observer rejects.
        const completionHostBarrier = readExecutionRunControllerHostBarrier(ctrl2);
        if (completionHostBarrier) {
          await completionHostBarrier;
        }
        if (completionError !== undefined) throw completionError;
      }
      const completionHostBarrier = readExecutionRunControllerHostBarrier(ctrl2);
      if (completionHostBarrier) await completionHostBarrier;
      throwIfExecutionRunControllerFailed(ctrl2);

      if (ctrl2.turnEpoch === thisEpoch) {
        ctrl2.turnInFlight = false;
        if (
          ctrl2.turnCancelReason === 'outcome_unknown'
          && ctrl2.turnCancelEpoch === thisEpoch
        ) {
          ctrl2.turnCancelReason = null;
          ctrl2.turnCancelEpoch = null;
        }
      }
      await ctrl2.streamWriter?.flushAll({ reason: 'turn-end' });

      const rawText = ctrl2.buffer.trim();
      const decoded = decodeExecutionRunProfileResult(rawText, args.params.resultContract);
      const result = decoded.ok
        ? buildObservedTurnResult(args.params.resultContract, decoded.value)
        : null;
      if (localInputId) {
        ctrl2.lastInputTurn = {
          turnId,
          inputIds: [localInputId],
          state: decoded.ok ? 'completed' : 'failed',
          ...(result ? { result } : {}),
        };
        ctrl2.currentInputPermissionRequestStore?.releaseResponseTarget();
        ctrl2.currentInputPermissionRequestStore = undefined;
        ctrl2.currentInputTurn = undefined;
        clearWorkflowObservation();
        publishInputTurns();
      }
      const structuredPublished = await publishExecutionRunTurn({
        runId: args.runId, turnId, rawText, finishedAtMs: args.getNowMs(), controller: ctrl2,
        controllers: args.controllers, runs: args.runs, profileCatalog: args.profileCatalog,
        sendAcp: args.sendAcp, parentProvider: args.parentProvider,
        reviewComments: args.reviewComments,
        onPublicStateUpdated: args.onPublicStateUpdated, admitNextInput,
      });
      const streamed =
        run.ioMode === 'streaming' && Boolean(ctrl2.streamWriter) && ctrl2.sidechainStreamBuffer.trim().length > 0;
      if (!structuredPublished && !streamed && rawText.length > 0) {
        await args.sendAcp(args.parentProvider, { type: 'message', message: rawText, sidechainId: run.sidechainId });
      }
    } catch (e: any) {
      const failedTurn = readRuntimeTurnFailureAlreadySurfacedEvent(e);
      if (failedTurn?.diagnostic.code === 'agent_context_window_exceeded' && ctrl2.turnEpoch === thisEpoch) {
        ctrl2.turnInFlight = false;
        if (localInputId && ctrl2.currentInputTurn) {
          ctrl2.lastInputTurn = { ...ctrl2.currentInputTurn, state: 'failed' };
          ctrl2.currentInputPermissionRequestStore?.releaseResponseTarget();
          ctrl2.currentInputPermissionRequestStore = undefined;
          ctrl2.currentInputTurn = undefined;
          clearWorkflowObservation();
          publishInputTurns();
        }
        if (await publishExecutionRunTurn({ runId: args.runId, turnId, rawText: ctrl2.buffer,
          diagnostic: failedTurn.diagnostic, finishedAtMs: args.getNowMs(), controller: ctrl2,
          controllers: args.controllers, runs: args.runs, profileCatalog: args.profileCatalog,
          sendAcp: args.sendAcp, parentProvider: args.parentProvider,
          reviewComments: args.reviewComments,
          onPublicStateUpdated: args.onPublicStateUpdated, admitNextInput,
        })) return;
      }
      if (
        ctrl2.turnCancelReason === 'steer'
        && ctrl2.turnCancelEpoch === thisEpoch
        && isAbortLikeError(e)
      ) {
        // The active turn was intentionally interrupted for steering; do not terminalize the run.
        ctrl2.turnCancelReason = null;
        ctrl2.turnCancelEpoch = null;
        await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'steer' });
        if (ctrl2.turnEpoch === thisEpoch) ctrl2.turnInFlight = false;
        if (localInputId && ctrl2.currentInputTurn) {
          ctrl2.lastInputTurn = { ...ctrl2.currentInputTurn, state: 'cancelled' };
          ctrl2.currentInputPermissionRequestStore?.releaseResponseTarget();
          ctrl2.currentInputPermissionRequestStore = undefined;
          ctrl2.currentInputTurn = undefined;
          clearWorkflowObservation();
          publishInputTurns();
        }
        return;
      }

      if (isAbortLikeError(e)) {
        if (
          ctrl2.turnCancelReason === 'outcome_unknown'
          && ctrl2.turnCancelEpoch === thisEpoch
        ) {
          // The effectful send and its completion observer both ended ambiguously.
          // Keep this exact turn's custody for the existing terminal, liveness, or
          // explicit stop owner; accepting another input could duplicate the effect.
          await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'abort' });
          return;
        }
        // Long-lived runs are interactive: if a turn is cancelled/aborted, keep the run alive so
        // callers can retry or continue steering without losing the entire execution run.
        await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'abort' });
        if (ctrl2.turnEpoch === thisEpoch) {
          ctrl2.turnInFlight = false;
          if (localInputId && ctrl2.currentInputTurn?.turnId === turnId) {
            ctrl2.lastInputTurn = { ...ctrl2.currentInputTurn, state: 'cancelled' };
            ctrl2.currentInputPermissionRequestStore?.releaseResponseTarget();
            ctrl2.currentInputPermissionRequestStore = undefined;
            ctrl2.currentInputTurn = undefined;
            clearWorkflowObservation();
            publishInputTurns();
          }
        }
        // Best-effort: clear steer markers if they were associated with this epoch.
        if (ctrl2.turnCancelReason === 'steer' && ctrl2.turnCancelEpoch === thisEpoch) {
          ctrl2.turnCancelReason = null;
          ctrl2.turnCancelEpoch = null;
        }
        return;
      }

      const message = e instanceof Error ? e.message : 'Execution failed';
      const errorCode = readExecutionRunErrorCode(e) ?? 'execution_run_failed';
      if (localInputId && ctrl2.currentInputTurn) {
        ctrl2.lastInputTurn = { ...ctrl2.currentInputTurn, state: 'failed' };
        ctrl2.currentInputPermissionRequestStore?.releaseResponseTarget();
        ctrl2.currentInputPermissionRequestStore = undefined;
        ctrl2.currentInputTurn = undefined;
        clearWorkflowObservation();
        publishInputTurns();
      }
      await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: message });
      const finishedAtMs = args.getNowMs();
      let shouldSettleController = true;
      try {
        await args.finishRun(
          args.runId,
          { status: 'failed', summary: message, finishedAtMs, error: { code: errorCode, message } },
          {
            output: {
              status: 'failed',
              summary: message,
              runId: run.runId,
              callId: run.callId,
              sidechainId: run.sidechainId,
              finishedAtMs,
              startedAtMs: run.startedAtMs,
              error: { code: errorCode, message },
            },
            isError: true,
          },
        );
      } catch (finishError) {
        // Completion is detached after the send ACK. finishRun has already made this typed
        // failure observable in run state, so there is no waiting caller to reject. An error
        // before that canonical transition remains exceptional and preserves the controller.
        const terminalRun = args.runs.get(args.runId);
        if (!isExecutionRunTranscriptCustodyError(finishError) && terminalRun?.status === 'running') {
          shouldSettleController = false;
          throw finishError;
        }
      } finally {
        if (shouldSettleController) {
          await settleExecutionRunController({
            runId: args.runId,
            controller: ctrl2,
            controllers: args.controllers,
          });
          args.onPublicStateUpdated?.(args.runId);
        }
      }
    } finally {
      releaseAcceptanceObservation();
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
    }
  };

  // Long-lived send should ACK quickly so UIs can steer/interrupt without timing out.
  // Completion is handled asynchronously; output is streamed via onMessage and flushed
  // to the sidechain once the backend signals the turn has completed.
  try {
    const admission = await raceExecutionRunControllerFailure(ctrl2, sendPromise);
    if (admission.status !== 'admitted') {
      releaseAcceptanceObservation();
      if (ctrl2.turnEpoch === thisEpoch) {
        ctrl2.turnInFlight = false;
        ctrl2.turnCount -= 1;
        if (localInputId) {
          ctrl2.currentInputPermissionRequestStore?.releaseResponseTarget();
          ctrl2.currentInputPermissionRequestStore = undefined;
          ctrl2.currentInputTurn = undefined;
          clearWorkflowObservation();
          publishInputTurns();
        }
        const currentRun = args.runs.get(args.runId);
        if (currentRun) args.runs.set(args.runId, { ...currentRun, turnCount: ctrl2.turnCount });
      }
      return { ok: false, errorCode: admission.diagnostic.code, error: admission.diagnostic.message ?? admission.status };
    }
    const initialHostBarrier = readExecutionRunControllerHostBarrier(ctrl2);
    if (initialHostBarrier) {
      await initialHostBarrier;
    }
    throwIfExecutionRunControllerFailed(ctrl2);
    // Attach completion handlers before any other awaited work to avoid unhandled rejections when
    // backends signal cancellation/completion on a near-zero timer.
    void runCompletionLoop();
    // Best-effort: record explicit user activity immediately so machine-level dashboards can
    // surface active long-lived runs even if model output streams are throttled.
    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
  } catch (e: any) {
    if (providerSendInvoked || isAbortLikeError(e)) {
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
      if (ctrl2.turnEpoch === thisEpoch) {
        ctrl2.turnCancelReason = 'outcome_unknown';
        ctrl2.turnCancelEpoch = thisEpoch;
      }
      // Only an actual completion observer may release ambiguous provider custody. A
      // backend without one stays busy until its existing terminal/liveness/stop path
      // settles the controller.
      if (ctrl2.backend.waitForTurnCompletion) {
        void runCompletionLoop();
      }
      return {
        ok: false,
        errorCode: 'execution_run_send_outcome_unknown',
        error: isAbortLikeError(e)
          ? 'The prompt may have been accepted before the provider cancelled the request'
          : 'The prompt may have been accepted before the provider response failed',
      };
    }

    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
    const message = e instanceof Error ? e.message : 'Execution failed';
    const errorCode = readExecutionRunErrorCode(e) ?? 'execution_run_failed';
    const finishedAtMs = args.getNowMs();
    try {
      await args.finishRun(
        args.runId,
        { status: 'failed', summary: message, finishedAtMs, error: { code: errorCode, message } },
        {
          output: {
            status: 'failed',
            summary: message,
            runId: run.runId,
            callId: run.callId,
            sidechainId: run.sidechainId,
            finishedAtMs,
            startedAtMs: run.startedAtMs,
            error: { code: errorCode, message },
          },
          isError: true,
        },
      );
    } finally {
      await settleExecutionRunController({
        runId: args.runId,
        controller: ctrl2,
        controllers: args.controllers,
      });
      args.onPublicStateUpdated?.(args.runId);
    }
    return { ok: false, errorCode: 'execution_run_failed', error: message };
  }

  return { ok: true };
}
