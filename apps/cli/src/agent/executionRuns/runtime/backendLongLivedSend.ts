import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';
import { resumeBackendControllerForResumableRun } from '@/agent/executionRuns/runtime/resumeBackendController';
import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from '@/agent/executionRuns/runtime/turnDelivery';

function readAbortRetryConfig(): { maxAttempts: number; delayMs: number } {
  const parseIntOr = (raw: unknown, fallback: number): number => {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback;
  };
  const parseDelayOr = (raw: unknown, fallback: number): number => {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
  };

  return {
    maxAttempts: parseIntOr(process.env.HAPPIER_EXECUTION_RUN_ABORT_RETRY_ATTEMPTS, 2),
    delayMs: parseDelayOr(process.env.HAPPIER_EXECUTION_RUN_ABORT_RETRY_DELAY_MS, 50),
  };
}

async function sendPromptWithAbortRetry(args: Readonly<{
  send: () => Promise<void>;
  maxAttempts: number;
  delayMs: number;
}>): Promise<void> {
  const attempts = Math.max(1, Math.trunc(args.maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await args.send();
      return;
    } catch (e) {
      if (!isAbortLikeError(e) || attempt >= attempts) throw e;
      const delay = Math.max(0, Math.trunc(args.delayMs));
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
}

export async function sendBackendLongLivedRun(args: Readonly<{
  runId: string;
  params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: (opts: { runId?: string; backendId: string; backendTarget?: BackendTargetRefV1; permissionMode: string }) => AgentBackend;
  maxTurns: number | null;
  getNowMs: () => number;
  finishRun: FinishExecutionRun;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  onPublicStateUpdated?: (runId: string) => void;
  }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
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

  if (!backendCtrl || !backendCtrl.childSessionId) {
    if (wantsResume && run.retentionPolicy === 'resumable') {
      const resumed = await resumeBackendControllerForResumableRun({
        runId: args.runId,
        run,
        runs: args.runs,
        controllers: args.controllers,
        budgetRegistry: args.budgetRegistry,
        createBackend: args.createBackend,
        sendAcp: args.sendAcp,
        parentProvider: args.parentProvider,
        streamedTranscriptSession: args.streamedTranscriptSession,
        writeActivityMarker: args.writeActivityMarker,
        getNowMs: args.getNowMs,
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
  if (!ctrl2 || ctrl2.kind !== 'backend' || !ctrl2.childSessionId) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }
  if (ctrl2.cancelled) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };

  const abortRetry = readAbortRetryConfig();
  let shouldRetryAbortSend = false;

  if (ctrl2.turnInFlight) {
    const hasSteer = typeof ctrl2.backend.sendSteerPrompt === 'function';
    const action = resolveInFlightDeliveryAction({ delivery, hasSteer });
    if (action === 'busy') {
      return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
    }
    if (action === 'steer') {
      try {
        await ctrl2.backend.sendSteerPrompt!(ctrl2.childSessionId, args.params.message);
      } catch (e) {
        return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Steer failed' };
      }
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
      return { ok: true };
    }

    // cancel_and_send
    ctrl2.turnCancelReason = 'steer';
    ctrl2.turnCancelEpoch = ctrl2.turnEpoch;
    try {
      await ctrl2.backend.cancel(ctrl2.childSessionId);
    } catch {
      // best effort
    }
    shouldRetryAbortSend = true;
  }

  if (typeof args.maxTurns === 'number' && ctrl2.turnCount >= args.maxTurns) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Turn limit exceeded' };
  }

  const thisEpoch = ctrl2.turnEpoch + 1;
  ctrl2.turnEpoch = thisEpoch;
  ctrl2.turnInFlight = true;
  ctrl2.buffer = '';
  ctrl2.sidechainStreamBuffer = '';
  ctrl2.sidechainStreamKey = '';

  ctrl2.turnCount += 1;
  // Persist the cumulative turn count so resuming cannot reset enforcement (for example maxTurns).
  const runAfterTurn = args.runs.get(args.runId);
  if (runAfterTurn) {
    args.runs.set(args.runId, { ...runAfterTurn, turnCount: ctrl2.turnCount });
  }
  const sendPromise = Promise.resolve().then(() => sendPromptWithAbortRetry({
    send: () => ctrl2.backend.sendPrompt(ctrl2.childSessionId!, args.params.message),
    maxAttempts: shouldRetryAbortSend ? abortRetry.maxAttempts : 1,
    delayMs: abortRetry.delayMs,
  }));

  const runCompletionLoop = async (): Promise<void> => {
    try {
      if (ctrl2.backend.waitForResponseComplete) {
        await ctrl2.backend.waitForResponseComplete();
      }

      if (ctrl2.turnEpoch === thisEpoch) ctrl2.turnInFlight = false;
      await ctrl2.streamWriter?.flushAll({ reason: 'turn-end' });

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
      const finishedAtMs = args.getNowMs();
      args.finishRun(
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
      try {
        await ctrl2.backend.dispose();
      } catch {
        // ignore
      }
      try {
        await ctrl2.terminalMarkerWritePromise;
      } catch {
        // ignore
      }
      ctrl2.resolveTerminal();
      args.controllers.delete(args.runId);
    } finally {
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
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
    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
  } catch (e: any) {
    if (isAbortLikeError(e)) {
      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
      if (ctrl2.turnEpoch === thisEpoch) ctrl2.turnInFlight = false;
      return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Turn cancelled' };
    }

    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true }).catch(() => {});
    const message = e instanceof Error ? e.message : 'Execution failed';
    const finishedAtMs = args.getNowMs();
    args.finishRun(
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
    try {
      await ctrl2.backend.dispose();
    } catch {
      // ignore
    }
    try {
      await ctrl2.terminalMarkerWritePromise;
    } catch {
      // ignore
    }
    ctrl2.resolveTerminal();
    args.controllers.delete(args.runId);
    return { ok: false, errorCode: 'execution_run_failed', error: message };
  }

  return { ok: true };
}
