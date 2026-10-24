import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { resetExecutionRunBackendOutput, type ExecutionRunBackendController, type ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';
import { resumeBackendControllerForResumableRun, type ResumedExecutionRunBackend } from '@/agent/executionRuns/runtime/resumeBackendController';
import { disposeExecutionRunBackendController } from './settleExecutionRunControllerOccurrence';
import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from '@/agent/executionRuns/runtime/turnDelivery';
import {
  EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_CODE,
  EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_MESSAGE,
} from '@/agent/executionRuns/runtime/executionRunErrors';

type BackendLongLivedRunSendArgs = Readonly<{
  runId: string;
  params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: () => Promise<ResumedExecutionRunBackend>;
  isSessionClosing?: () => boolean;
  maxTurns: number | null;
  getNowMs: () => number;
  finishRun: FinishExecutionRun;
  sendAcp: AcpSendFn;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean; resumed?: boolean }>) => Promise<void>;
  admitRuntimeActivity: (runId: string) => Promise<void>;
  rollbackRuntimeActivityAfterFailedAdmission: (reason: string) => Promise<void>;
  terminalRuntimeActivityAfterFailedAdmission: (runId: string, reason: string) => Promise<void>;
  onPublicStateUpdated?: (runId: string) => void;
}>;

type BackendLongLivedRunSendResult = { ok: boolean; errorCode?: string; error?: string };
type PreparedBackendLongLivedRunResult =
  | { ok: true; controller: ExecutionRunBackendController }
  | { ok: false; errorCode?: string; error?: string };

function readPreparedBackendController(args: BackendLongLivedRunSendArgs): PreparedBackendLongLivedRunResult {
  const controller = args.controllers.get(args.runId) ?? null;
  if (!controller || controller.kind !== 'backend' || !controller.childSessionId || controller.cancelled) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }
  return { ok: true, controller };
}

export async function prepareBackendLongLivedRunResume(
  args: BackendLongLivedRunSendArgs,
): Promise<PreparedBackendLongLivedRunResult> {
  const run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  const wantsResume = args.params.resume === true;
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

  // Public terminal state can precede native teardown and controller removal.
  // Resume must acquire a fresh occurrence, as Ensure does, rather than send into
  // the terminal occurrence while its disposal is still pending.
  if (run.status !== 'running' || !backendCtrl || !backendCtrl.childSessionId) {
    if (wantsResume && run.retentionPolicy === 'resumable') {
      const resumed = await resumeBackendControllerForResumableRun({
        runId: args.runId,
        run,
        runs: args.runs,
        controllers: args.controllers,
        budgetRegistry: args.budgetRegistry,
        createBackend: args.createBackend,
        isSessionClosing: args.isSessionClosing,
        sendAcp: args.sendAcp,
        parentProvider: args.parentProvider,
        streamedTranscriptSession: args.streamedTranscriptSession,
        writeActivityMarker: args.writeActivityMarker,
        getNowMs: args.getNowMs,
        admitRuntimeActivity: args.admitRuntimeActivity,
        rollbackRuntimeActivityAfterFailedAdmission: args.rollbackRuntimeActivityAfterFailedAdmission,
        terminalRuntimeActivityAfterFailedAdmission: args.terminalRuntimeActivityAfterFailedAdmission,
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

  return readPreparedBackendController(args);
}

export async function sendBackendLongLivedRun(
  args: BackendLongLivedRunSendArgs,
): Promise<BackendLongLivedRunSendResult> {
  const admittedController = args.controllers.get(args.runId) ?? null;
  if (
    args.params.resume !== true
    && admittedController?.kind === 'backend'
    && !admittedController.childSessionId
    && admittedController.provisioningPromise
  ) {
    await admittedController.provisioningPromise;
  }
  const prepared = args.params.resume === true
    ? await prepareBackendLongLivedRunResume(args)
    : readPreparedBackendController(args);
  if (!prepared.ok) return prepared;
  return sendPreparedBackendLongLivedRun(args, prepared.controller);
}

export async function sendPreparedBackendLongLivedRun(
  args: BackendLongLivedRunSendArgs,
  preparedController: ExecutionRunBackendController,
): Promise<BackendLongLivedRunSendResult> {
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

  const childSessionId = preparedController.childSessionId;
  if (args.controllers.get(args.runId) !== preparedController || !childSessionId) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }
  const ctrl2 = preparedController;
  if (ctrl2.cancelled) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  const isCurrentController = (): boolean => args.controllers.get(args.runId) === ctrl2;

  if (ctrl2.turnInFlight) {
    // A provider-side failure after invocation cannot prove whether the input was accepted.
    // Keep that exact turn's custody exclusive until completion or explicit stop settles it.
    if (ctrl2.turnCancelReason === 'outcome_unknown') {
      return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
    }
    const hasSteer = typeof ctrl2.backend.sendSteerPrompt === 'function';
    const action = resolveInFlightDeliveryAction({ delivery, hasSteer });
    if (action === 'busy') {
      return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
    }
    if (action === 'steer') {
      const activeEpoch = ctrl2.turnEpoch;
      try {
        await ctrl2.backend.sendSteerPrompt!(childSessionId, args.params.message);
      } catch {
        if (
          isCurrentController()
          && ctrl2.turnInFlight
          && ctrl2.turnEpoch === activeEpoch
        ) {
          ctrl2.turnCancelReason = 'outcome_unknown';
          ctrl2.turnCancelEpoch = activeEpoch;
        }
        return {
          ok: false,
          errorCode: EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_CODE,
          error: EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_MESSAGE,
        };
      }
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
      return { ok: true };
    }

    // cancel_and_send
    ctrl2.turnCancelReason = 'steer';
    ctrl2.turnCancelEpoch = ctrl2.turnEpoch;
    try {
      await ctrl2.backend.cancel(childSessionId);
    } catch {
      // best effort
    }
  }

  if (typeof args.maxTurns === 'number' && ctrl2.turnCount >= args.maxTurns) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Turn limit exceeded' };
  }

  const thisEpoch = ctrl2.turnEpoch + 1;
  ctrl2.turnEpoch = thisEpoch;
  ctrl2.turnInFlight = true;
  args.onPublicStateUpdated?.(args.runId);
  resetExecutionRunBackendOutput(ctrl2);

  ctrl2.turnCount += 1;
  // Persist the cumulative turn count so resuming cannot reset enforcement (for example maxTurns).
  const runAfterTurn = args.runs.get(args.runId);
  if (runAfterTurn) {
    args.runs.set(args.runId, { ...runAfterTurn, turnCount: ctrl2.turnCount });
  }
  // Effectful provider admission is attempted once. Any untyped throw after invocation is
  // outcome-unknown, so replaying the prompt here could execute the same input twice.
  const sendPromise = Promise.resolve().then(() => ctrl2.backend.sendPrompt(childSessionId, args.params.message));

  const runCompletionLoop = async (): Promise<void> => {
    try {
      if (ctrl2.backend.waitForResponseComplete) {
        await ctrl2.backend.waitForResponseComplete();
      }

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

      // A stopped occurrence may be resumed again while this provider response is still pending.
      // Output from the retired controller must not leak into or mutate its successor occurrence.
      if (!isCurrentController()) return;

      const rawText = ctrl2.buffer.trim();
      const streamed =
        run.ioMode === 'streaming' && Boolean(ctrl2.streamWriter) && ctrl2.sidechainStreamBuffer.trim().length > 0;
      if (!streamed && rawText.length > 0) {
        args.sendAcp(args.parentProvider, { type: 'message', message: rawText, sidechainId: run.sidechainId });
      }
    } catch (e: any) {
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
        return;
      }

      if (isAbortLikeError(e)) {
        if (
          ctrl2.turnCancelReason === 'outcome_unknown'
          && ctrl2.turnCancelEpoch === thisEpoch
        ) {
          // Both provider admission and completion observation are ambiguous. Preserve custody
          // for the existing terminal/liveness/stop owner instead of accepting another input.
          await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'abort' });
          return;
        }
        // Long-lived runs are interactive: if a turn is cancelled/aborted, keep the run alive so
        // callers can retry or continue steering without losing the entire execution run.
        await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'abort' });
        if (ctrl2.turnEpoch === thisEpoch) ctrl2.turnInFlight = false;
        // Best-effort: clear steer markers if they were associated with this epoch.
        if (ctrl2.turnCancelReason === 'steer' && ctrl2.turnCancelEpoch === thisEpoch) {
          ctrl2.turnCancelReason = null;
          ctrl2.turnCancelEpoch = null;
        }
        return;
      }

      const message = e instanceof Error ? e.message : 'Execution failed';
      await ctrl2.streamWriter?.flushAll({ reason: 'abort', interruptedReason: message });
      if (isCurrentController()) {
        const finishedAtMs = args.getNowMs();
        await args.finishRun(
          args.runId,
          { status: 'failed', summary: message, finishedAtMs, error: { code: 'execution_run_failed', message } },
          {
            output: {
              status: 'failed',
              summary: message,
              runId: run.runId,
              callId: run.callId,
              sidechainId: run.sidechainId,
              finishedAtMs,
              startedAtMs: run.startedAtMs,
              error: { code: 'execution_run_failed', message },
            },
            isError: true,
          },
        );
      }
      try {
        await disposeExecutionRunBackendController(ctrl2);
      } catch {
        // ignore
      }
      try {
        await ctrl2.terminalMarkerWritePromise;
      } catch {
        // ignore
      }
      ctrl2.resolveTerminal();
      if (isCurrentController()) args.controllers.delete(args.runId);
    } finally {
      if (isCurrentController()) {
        args.onPublicStateUpdated?.(args.runId);
        await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
      }
    }
  };

  // Long-lived send should ACK quickly so UIs can steer/interrupt without timing out.
  // Completion is handled asynchronously; output is streamed via onMessage and flushed
  // to the sidechain once the backend signals the turn has completed.
  try {
    await sendPromise;
    // Attach completion handlers before any other awaited work to avoid unhandled rejections when
    // backends signal cancellation/completion on a near-zero timer.
    void runCompletionLoop();
    // Best-effort: record explicit user activity immediately so machine-level dashboards can
    // surface active long-lived runs even if model output streams are throttled.
    if (isCurrentController()) {
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
    }
  } catch {
    const stillOwnsTurn = (
      isCurrentController()
      && ctrl2.turnEpoch === thisEpoch
    );
    if (stillOwnsTurn) {
      ctrl2.turnCancelReason = 'outcome_unknown';
      ctrl2.turnCancelEpoch = thisEpoch;
    }
    if (isCurrentController()) {
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
    }
    // Only the provider completion observer can safely release ambiguous prompt custody. A
    // backend without one remains busy until its existing terminal/liveness/stop path settles.
    if (stillOwnsTurn && ctrl2.backend.waitForResponseComplete) {
      void runCompletionLoop();
    }
    return {
      ok: false,
      errorCode: EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_CODE,
      error: EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_MESSAGE,
    };
  }

  return { ok: true };
}
