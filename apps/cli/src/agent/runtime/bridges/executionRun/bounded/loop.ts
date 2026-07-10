import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunManagerStartParams } from '../executionRunTypes';
import type { ExecutionRunController, ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import {
  readExecutionRunControllerHostBarrier,
  raceExecutionRunControllerFailure,
  throwIfExecutionRunControllerFailed,
} from '@/agent/executionRuns/controllers/failureSignal';
import type { FinishExecutionRun } from '../executionRunFinishRun';
import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from '../turnDelivery';
import { resolveExecutionRunRuntimeBackendId } from '../backendTargets';
import {
  createExecutionRunTimeoutError,
  isExecutionRunTimeoutError,
  readExecutionRunErrorCode,
  type ExecutionRunTimeoutError,
} from '../errors';
import { logger } from '@/ui/logger';

const UNPROBEABLE_LIVENESS_SETTLE_GRACE_MS = 50;
const MAX_UNPROBEABLE_LIVENESS_SETTLE_GRACE_MS = 250;

export async function executeBoundedBackendRun(args: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  startedAtMs: number;
  params: ExecutionRunManagerStartParams;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: ACPProvider;
  getNowMs: () => number;
  boundedTimeoutMs: number | null;
  finishRun: FinishExecutionRun;
}>): Promise<void> {
  const { runId, callId, sidechainId, startedAtMs, params } = args;
  const profile = args.profileCatalog
    ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, params.intent, params.profileId)
    : resolveExecutionRunIntentProfile(params.intent);
  const shouldMaterializeInTranscript = profile.transcriptMaterialization !== 'none';
  const ctrl = args.controllers.get(runId);
  if (!ctrl) return;
  if (ctrl.kind !== 'backend') return;
  const backendCtrl = ctrl as ExecutionRunBackendController;

  try {
    if (!backendCtrl.childSessionId) {
      throw new Error('Execution-run session not ready');
    }

    const start = {
      sessionId: params.sessionId,
      runId,
      callId,
      sidechainId,
      intent: params.intent,
      backendId: resolveExecutionRunRuntimeBackendId(params.backendTarget),
      backendTarget: params.backendTarget,
      instructions: params.instructions ?? '',
      intentInput: params.intentInput,
      permissionMode: params.permissionMode,
      retentionPolicy: params.retentionPolicy,
      runClass: params.runClass,
      ioMode: params.ioMode,
      startedAtMs,
      ...(params.structuredOutputRecovery ? { structuredOutputRecovery: params.structuredOutputRecovery } : {}),
    } as const;
    let effectiveInstructions = start.instructions;
    const prompt = profile.buildPrompt({ ...start, instructions: effectiveInstructions });

    function waitForExternalMessage(): Promise<void> {
      if (backendCtrl.pendingExternalMessages.length > 0) return Promise.resolve();
      if (!backendCtrl.pendingExternalMessagesSignal) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        backendCtrl.pendingExternalMessagesSignal = { promise, resolve };
      }
      return backendCtrl.pendingExternalMessagesSignal.promise;
    }

    function sendTurnPrompt(turnPrompt: string): Promise<void> {
      backendCtrl.turnCount += 1;
      backendCtrl.turnEpoch += 1;
      backendCtrl.turnInFlight = true;
      backendCtrl.buffer = '';
      backendCtrl.sidechainStreamBuffer = '';
      backendCtrl.sidechainStreamKey = '';
      return backendCtrl.backend.sendPrompt(backendCtrl.childSessionId!, turnPrompt);
    }

    async function waitForTurnComplete(sendPromptPromise: Promise<void>): Promise<void> {
      await raceExecutionRunControllerFailure(backendCtrl, sendPromptPromise);
      const initialHostBarrier = readExecutionRunControllerHostBarrier(backendCtrl);
      if (initialHostBarrier) {
        await initialHostBarrier;
      }
      throwIfExecutionRunControllerFailed(backendCtrl);
      if (backendCtrl.backend.waitForTurnCompletion) {
        await raceExecutionRunControllerFailure(backendCtrl, backendCtrl.backend.waitForTurnCompletion());
        const completionHostBarrier = readExecutionRunControllerHostBarrier(backendCtrl);
        if (completionHostBarrier) {
          await completionHostBarrier;
        }
        throwIfExecutionRunControllerFailed(backendCtrl);
      }
    }

    async function runTurnWithExternalMessages(turnPrompt: string): Promise<void> {
      backendCtrl.turnCancelReason = null;
      backendCtrl.turnCancelEpoch = null;
      const sendPromptPromise = sendTurnPrompt(turnPrompt);
      let activeEpoch = backendCtrl.turnEpoch;
      let completionPromise: Promise<void> = waitForTurnComplete(sendPromptPromise);

      while (true) {
        if (backendCtrl.cancelled) return;
        const raced = await Promise.race([
          completionPromise.then(() => ({ t: 'complete' as const })).catch((e) => ({ t: 'error' as const, e })),
          waitForExternalMessage().then(() => ({ t: 'external' as const })),
        ]);

        if (raced.t === 'complete') break;
        if (raced.t === 'error') {
          const e = raced.e;
          if (
            backendCtrl.turnCancelReason === 'steer'
            && backendCtrl.turnCancelEpoch === activeEpoch
            && isAbortLikeError(e)
          ) {
            backendCtrl.turnCancelReason = null;
            backendCtrl.turnCancelEpoch = null;
            continue;
          }
          throw e;
        }

        // external message
        const next = backendCtrl.pendingExternalMessages.shift() ?? null;
        if (!next) continue;

        const hasSteer = typeof backendCtrl.backend.sendSteerPrompt === 'function';
        const delivery = normalizeExecutionRunSendDelivery(next.delivery);
        const action = resolveInFlightDeliveryAction({ delivery, hasSteer });

        if (action === 'busy') {
          next.reject(new Error('Run is busy'));
          continue;
        }

        if (action === 'steer') {
          try {
            await backendCtrl.backend.sendSteerPrompt!(backendCtrl.childSessionId!, next.message);
            next.resolve();
          } catch (e: any) {
            next.reject(e instanceof Error ? e : new Error('Steer failed'));
          }
          continue;
        }

        // cancel_and_send
        backendCtrl.turnCancelReason = 'steer';
        backendCtrl.turnCancelEpoch = activeEpoch;
        await backendCtrl.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'steer' });
        void Promise.resolve()
          .then(() => backendCtrl.backend.cancel(backendCtrl.childSessionId!))
          .catch(() => {});

        void completionPromise.catch((error) => {
          if (isAbortLikeError(error)) return;
          logger.debug('[ExecutionRuns] canceled turn completion rejected (ignored)', error);
        });

        const updateText = String(next.message ?? '').trim();
        if (updateText) {
          effectiveInstructions = effectiveInstructions
            ? `${effectiveInstructions}\n\nUser update:\n${updateText}`
            : `User update:\n${updateText}`;
        }
        const updatedPrompt = profile.buildPrompt({ ...start, instructions: effectiveInstructions });
        const updatedSendPromise = sendTurnPrompt(updatedPrompt);
        // ACK as soon as the bounded runtime adopts the replacement turn. Waiting for the backend
        // send promise to settle can incorrectly surface "Run is busy" even though the follow-up
        // prompt has already been accepted into the run state machine.
        next.resolve();
        void updatedSendPromise.catch((error) => {
          logger.debug('[ExecutionRuns] replacement turn send rejected after external ACK', error);
        });
        activeEpoch = backendCtrl.turnEpoch;
        backendCtrl.turnCancelReason = null;
        backendCtrl.turnCancelEpoch = null;
        completionPromise = waitForTurnComplete(updatedSendPromise);
      }

      backendCtrl.turnInFlight = false;
      await backendCtrl.streamWriter?.flushAll({ reason: 'turn-end' });
    }

    const runPromise = runTurnWithExternalMessages(prompt);

    async function probeTurnLiveness(): Promise<unknown> {
      if (!backendCtrl.childSessionId || typeof backendCtrl.backend.probeTurnLiveness !== 'function') {
        return null;
      }
      try {
        return await backendCtrl.backend.probeTurnLiveness(backendCtrl.childSessionId);
      } catch (error) {
        logger.debug('[ExecutionRuns] backend turn liveness probe failed; continuing bounded wait', error);
        return null;
      }
    }

    async function waitForRunPromise(): Promise<void> {
      const timeoutMs = args.boundedTimeoutMs;
      if (typeof timeoutMs !== 'number') {
        await runPromise;
        return;
      }
      const boundedTimeoutMs = timeoutMs;

      async function readRunPromiseOutcomeIfSettled(): Promise<
        | { type: 'complete' }
        | { type: 'error'; error: unknown }
        | { type: 'pending' }
      > {
        return readRunPromiseOutcomeAfterDelay(0);
      }

      async function readRunPromiseOutcomeAfterDelay(delayMs: number): Promise<
        | { type: 'complete' }
        | { type: 'error'; error: unknown }
        | { type: 'pending' }
      > {
        return Promise.race([
          runPromise.then(() => ({ type: 'complete' as const })).catch((error) => ({ type: 'error' as const, error })),
          new Promise<{ type: 'pending' }>((resolve) => {
            const timer = setTimeout(() => resolve({ type: 'pending' }), delayMs);
            timer.unref?.();
          }),
        ]);
      }

      function resolveUnprobeableLivenessSettleGraceMs(): number {
        return Math.min(
          Math.max(boundedTimeoutMs, UNPROBEABLE_LIVENESS_SETTLE_GRACE_MS),
          MAX_UNPROBEABLE_LIVENESS_SETTLE_GRACE_MS,
        );
      }

      while (true) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const outcome = await Promise.race([
          runPromise.then(() => ({ type: 'complete' as const })).catch((error) => ({ type: 'error' as const, error })),
          new Promise<{ type: 'timeout' }>((resolve) => {
            timeout = setTimeout(() => resolve({ type: 'timeout' }), boundedTimeoutMs);
            timeout.unref?.();
          }),
        ]);
        if (timeout) clearTimeout(timeout);

        if (outcome.type === 'complete') return;
        if (outcome.type === 'error') throw outcome.error;

        const livenessProbe = await probeTurnLiveness();
        if (!livenessProbe || typeof livenessProbe !== 'object') {
          const graceMs = resolveUnprobeableLivenessSettleGraceMs();
          logger.debug('[ExecutionRuns] bounded timeout interval elapsed without backend liveness proof; waiting for settlement grace', {
            runId,
            callId,
            sidechainId,
            timeoutMs: boundedTimeoutMs,
            graceMs,
          });
          const graceOutcome = await readRunPromiseOutcomeAfterDelay(graceMs);
          if (graceOutcome.type === 'complete') return;
          if (graceOutcome.type === 'error') throw graceOutcome.error;
        }
        if (
          livenessProbe
          && typeof livenessProbe === 'object'
          && (livenessProbe as { active?: unknown }).active === true
        ) {
          logger.debug('[ExecutionRuns] bounded timeout elapsed while backend turn is still active', {
            runId,
            callId,
            sidechainId,
            timeoutMs: boundedTimeoutMs,
            livenessProbe,
          });
          continue;
        }

        const finalOutcome = await readRunPromiseOutcomeIfSettled();
        if (finalOutcome.type === 'complete') return;
        if (finalOutcome.type === 'error') throw finalOutcome.error;

        void runPromise.catch(() => {});
        throw createExecutionRunTimeoutError({
          timeoutMs: boundedTimeoutMs,
          errorCode: 'provider_inactivity_timeout',
          livenessProbe,
        });
      }
    }

    await waitForRunPromise();

    if (backendCtrl.cancelled) {
      return;
    }

    const rawText = backendCtrl.buffer.trim();
    const finishedAtMs = args.getNowMs();
    let completion = profile.onBoundedComplete({
      start,
      rawText,
      finishedAtMs,
      ...(params.structuredOutputRecovery ? { structuredOutputRecovery: params.structuredOutputRecovery } : {}),
    });

    const errorCode = (completion as any)?.toolResultOutput?.error?.code;
    const shouldRepair =
      completion.status === 'failed'
      && errorCode === 'invalid_output'
      && typeof profile.buildInvalidOutputRepairPrompt === 'function';

    if (shouldRepair) {
      const repairPrompt = profile.buildInvalidOutputRepairPrompt?.({ start, rawText }) ?? [
        'Your previous response did not include the required final JSON object.',
        'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
        '',
        'Content to convert:',
        rawText,
      ].join('\n');

      // Reset buffers so the second pass is parsed deterministically.
      backendCtrl.buffer = '';
      backendCtrl.sidechainStreamBuffer = '';
      backendCtrl.sidechainStreamKey = '';
      backendCtrl.turnInFlight = false;

      await runTurnWithExternalMessages(repairPrompt);

      const repairedRawText = backendCtrl.buffer.trim();
      completion = profile.onBoundedComplete({
        start,
        rawText: repairedRawText,
        finishedAtMs,
        ...(params.structuredOutputRecovery ? { structuredOutputRecovery: params.structuredOutputRecovery } : {}),
      });
    }

    const sidechainMessage = (() => {
      const prose = profile.computeSidechainStreamText?.({ fullText: rawText })?.trim() ?? '';
      if (prose) return prose;
      const summary = String(completion.summary ?? '').trim();
      return summary || (completion.status === 'succeeded' ? 'Completed.' : 'Failed.');
    })();

    const streamed =
      params.ioMode === 'streaming'
      && Boolean(backendCtrl.streamWriter)
      && backendCtrl.sidechainStreamBuffer.trim().length > 0;
    const shouldEmitFinalSidechainMessageWhenStreamed = profile.emitFinalSidechainMessageWhenStreamed === true;
    if (shouldMaterializeInTranscript && (shouldEmitFinalSidechainMessageWhenStreamed || !streamed)) {
      // Even when streaming progress, emit a final terminal summary line so users get a clear completion status.
      if (sidechainMessage && sidechainMessage.trim().length > 0) {
        args.sendAcp(args.parentProvider, { type: 'message', message: sidechainMessage.trim(), sidechainId });
      }
    }

    await backendCtrl.streamWriter?.flushAll({ reason: 'turn-end' });

    args.finishRun(
      runId,
      { status: completion.status, summary: completion.summary, finishedAtMs },
      { output: completion.toolResultOutput, meta: completion.toolResultMeta },
      completion.structuredMeta,
    );
  } catch (e: any) {
    if (backendCtrl.cancelled) return;
    const message = e instanceof Error ? e.message : 'Execution failed';
    const executionRunErrorCode = readExecutionRunErrorCode(e) ?? 'execution_run_failed';
    if (isExecutionRunTimeoutError(e)) {
      try {
        if (backendCtrl.childSessionId) await backendCtrl.backend.cancel(backendCtrl.childSessionId);
      } catch {
        // best effort
      }
      await backendCtrl.streamWriter?.flushAll({ reason: 'abort', interruptedReason: message });
      const finishedAtMs = args.getNowMs();
      const livenessProbe = e && typeof e === 'object' ? (e as ExecutionRunTimeoutError).livenessProbe : null;
      args.finishRun(
        runId,
        { status: 'timeout', summary: message, finishedAtMs, error: { code: executionRunErrorCode, message } },
        {
          output: {
            status: 'timeout',
            summary: message,
            runId,
            callId,
            sidechainId,
            finishedAtMs,
            startedAtMs,
            error: { code: executionRunErrorCode, message },
            ...(livenessProbe === undefined ? {} : { livenessProbe }),
          },
          isError: true,
        },
      );
      return;
    }
    await backendCtrl.streamWriter?.flushAll({ reason: 'abort', interruptedReason: message });
    const finishedAtMs = args.getNowMs();
    args.finishRun(
      runId,
      { status: 'failed', summary: message, finishedAtMs, error: { code: 'execution_run_failed', message } },
      {
        output: {
          status: 'failed',
          summary: message,
          runId,
          callId,
          sidechainId,
          finishedAtMs,
          startedAtMs,
          error: { code: 'execution_run_failed', message },
        },
        isError: true,
      },
    );
  } finally {
    try {
      await backendCtrl.backend.dispose();
    } catch {
      // ignore
    }
    try {
      await backendCtrl.terminalMarkerWritePromise;
    } catch {
      // ignore
    }
    backendCtrl.resolveTerminal();
  }
}
