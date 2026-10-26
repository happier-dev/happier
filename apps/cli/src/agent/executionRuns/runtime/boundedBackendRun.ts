import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import type { ExecutionRunManagerStartParams } from '@/agent/executionRuns/runtime/executionRunTypes';
import { resetExecutionRunBackendOutput, type ExecutionRunController, type ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';
import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from '@/agent/executionRuns/runtime/turnDelivery';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/executionRuns/runtime/backendTargets';
import {
  createExecutionRunSendOutcomeUnknownError,
  createExecutionRunTimeoutError,
  isExecutionRunTimeoutError,
  readExecutionRunErrorCode,
  type ExecutionRunTimeoutError,
} from '@/agent/executionRuns/runtime/executionRunErrors';
import { buildReviewGuidanceBlock } from '@/agent/reviews/prompt/buildStandardReviewPrompt';
import { logger } from '@/ui/logger';
import { disposeExecutionRunBackendController, settleExecutionRunControllerOccurrence } from './settleExecutionRunControllerOccurrence';

function stripTrailingJsonObjectFromText(text: string): string {
  const trimmed = String(text ?? '');
  if (!trimmed.trim()) return '';

  // Best-effort: remove the last parseable JSON object from the end of the text.
  // This is intended for intents (plan/delegate) where we want to show human-readable
  // prose in the transcript but keep strict JSON for structured meta.
  const t = trimmed.trimEnd();
  for (let index = t.length - 1; index >= 0; index -= 1) {
    if (t[index] !== '{') continue;
    const candidate = t.slice(index);
    try {
      JSON.parse(candidate);
      return t.slice(0, index).trimEnd();
    } catch {
      // keep scanning
    }
  }
  return trimmed.trim();
}

export async function executeBoundedBackendRun(args: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  startedAtMs: number;
  params: ExecutionRunManagerStartParams;
  controllers: Map<string, ExecutionRunController>;
  sendAcp: AcpSendFn;
  parentProvider: ACPProvider;
  getNowMs: () => number;
  boundedTimeoutMs: number | null;
  finishRun: FinishExecutionRun;
}>): Promise<void> {
  const { runId, callId, sidechainId, startedAtMs, params } = args;
  const profile = resolveExecutionRunIntentProfile(params.intent);
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
      resetExecutionRunBackendOutput(backendCtrl);
      return backendCtrl.backend.sendPrompt(backendCtrl.childSessionId!, turnPrompt);
    }

    async function waitForTurnComplete(sendPromptPromise: Promise<void>): Promise<void> {
      await sendPromptPromise;
      if (backendCtrl.backend.waitForResponseComplete) {
        await backendCtrl.backend.waitForResponseComplete();
      }
    }

    async function runTurnWithExternalMessages(turnPrompt: string): Promise<void> {
      backendCtrl.turnCancelReason = null;
      backendCtrl.turnCancelEpoch = null;
      // Provider completion and external-send admission mutate this state across awaited
      // boundaries. Read it through one live accessor so neither the compiler nor this loop treats
      // a pre-await narrowing as current evidence.
      const readTurnCancellation = () => ({
        reason: backendCtrl.turnCancelReason,
        epoch: backendCtrl.turnCancelEpoch,
      });
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
          const cancellation = readTurnCancellation();
          if (
            cancellation.reason === 'steer'
            && cancellation.epoch === activeEpoch
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
          } catch {
            // The provider operation was invoked, so a rejection alone cannot prove the steer was
            // refused before effect. Preserve exclusive custody and tell the caller not to retry.
            if (backendCtrl.turnEpoch === activeEpoch) {
              backendCtrl.turnCancelReason = 'outcome_unknown';
              backendCtrl.turnCancelEpoch = activeEpoch;
            }
            next.reject(createExecutionRunSendOutcomeUnknownError());
          }
          continue;
        }

        // cancel_and_send
        backendCtrl.turnCancelReason = 'steer';
        backendCtrl.turnCancelEpoch = activeEpoch;
        await backendCtrl.streamWriter?.flushAll({ reason: 'abort', interruptedReason: 'steer' });

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
        // ACK as soon as the bounded runtime adopts the replacement turn. Waiting for the backend
        // send promise to settle can incorrectly surface "Run is busy" even though the follow-up
        // prompt has already been accepted into the run state machine.
        next.resolve();
        await backendCtrl.backend.cancel(backendCtrl.childSessionId!);
        if (backendCtrl.cancelled) return;
        const updatedSendPromise = sendTurnPrompt(updatedPrompt);
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
        logger.debug('[ExecutionRuns] backend turn liveness probe failed; falling back to bounded timeout', error);
        return null;
      }
    }

    async function waitForRunPromise(): Promise<void> {
      const timeoutMs = args.boundedTimeoutMs;
      if (typeof timeoutMs !== 'number') {
        await runPromise;
        return;
      }

      async function readRunPromiseOutcomeIfSettled(): Promise<
        | { type: 'complete' }
        | { type: 'error'; error: unknown }
        | { type: 'pending' }
      > {
        return Promise.race([
          runPromise.then(() => ({ type: 'complete' as const })).catch((error) => ({ type: 'error' as const, error })),
          new Promise<{ type: 'pending' }>((resolve) => {
            const timer = setTimeout(() => resolve({ type: 'pending' }), 0);
            timer.unref?.();
          }),
        ]);
      }

      while (true) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const outcome = await Promise.race([
          runPromise.then(() => ({ type: 'complete' as const })).catch((error) => ({ type: 'error' as const, error })),
          new Promise<{ type: 'timeout' }>((resolve) => {
            timeout = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
            timeout.unref?.();
          }),
        ]);
        if (timeout) clearTimeout(timeout);

        if (outcome.type === 'complete') return;
        if (outcome.type === 'error') throw outcome.error;

        const livenessProbe = await probeTurnLiveness();
        if (
          livenessProbe
          && typeof livenessProbe === 'object'
          && (livenessProbe as { active?: unknown }).active === true
        ) {
          logger.debug('[ExecutionRuns] bounded timeout elapsed while backend turn is still active', {
            runId,
            callId,
            sidechainId,
            timeoutMs,
            livenessProbe,
          });
          continue;
        }
        if (!livenessProbe || typeof livenessProbe !== 'object') {
          logger.debug('[ExecutionRuns] bounded timeout interval elapsed without backend liveness proof; timing out', {
            runId,
            callId,
            sidechainId,
            timeoutMs,
          });
        }

        const finalOutcome = await readRunPromiseOutcomeIfSettled();
        if (finalOutcome.type === 'complete') return;
        if (finalOutcome.type === 'error') throw finalOutcome.error;

        void runPromise.catch(() => {});
        throw createExecutionRunTimeoutError({
          timeoutMs,
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
    });

    const errorCode = (completion as any)?.toolResultOutput?.error?.code;
    const shouldRepair =
      completion.status === 'failed'
      && errorCode === 'invalid_output'
      && (params.intent === 'review' || params.intent === 'plan' || params.intent === 'delegate');

    if (shouldRepair) {
      const repairPrompt = (() => {
        if (params.intent === 'review') {
          return [
            'Your previous response did not include the required final JSON object.',
            'If you have already completed the review, convert your conclusions into the required JSON now.',
            'If you have not yet inspected the workspace or gathered enough evidence, continue the review first using the available read-only tools, then return ONLY valid JSON (parsable by JSON.parse).',
            'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
            buildReviewGuidanceBlock(),
            '',
            'Content to convert:',
            rawText,
          ].join('\n');
        }

        if (params.intent === 'plan') {
          return [
            'Your previous response did not include the required final JSON object.',
            'Do not run any tools. Return ONLY valid JSON (parsable by JSON.parse).',
            'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
            'Return a single JSON object with this shape:',
            '{',
            '  "summary": "Ok",',
            '  "sections": [{ "title": "Steps", "items": ["Step 1"] }],',
            '  "risks": [],',
            '  "milestones": [],',
            '  "recommendedBackendId": "claude"',
            '}',
            '',
            'Content to convert:',
            rawText,
          ].join('\n');
        }

        // delegate
        return [
          'Your previous response did not include the required final JSON object.',
          'Do not run any tools. Return ONLY valid JSON (parsable by JSON.parse).',
          'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
          'Return a single JSON object with this shape:',
          '{',
          '  "summary": "Ok",',
          '  "deliverables": [{ "id": "d1", "title": "Deliverable", "details": "Optional details" }]',
          '}',
          '',
          'Content to convert:',
          rawText,
        ].join('\n');
      })();

      // Reset buffers so the second pass is parsed deterministically.
      resetExecutionRunBackendOutput(backendCtrl);
      backendCtrl.turnInFlight = false;

      await runTurnWithExternalMessages(repairPrompt);

      const repairedRawText = backendCtrl.buffer.trim();
      completion = profile.onBoundedComplete({
        start,
        rawText: repairedRawText,
        finishedAtMs,
      });
    }

    const sidechainMessage = (() => {
      // Avoid leaking strict JSON into the transcript for structured intents.
      if (params.intent === 'review') {
        const summary = String(completion.summary ?? '').trim();
        return summary || (completion.status === 'succeeded' ? 'Review completed.' : 'Review failed.');
      }

      if (params.intent === 'plan' || params.intent === 'delegate') {
        const prose = stripTrailingJsonObjectFromText(rawText).trim();
        if (prose) return prose;
        const summary = String(completion.summary ?? '').trim();
        return summary || (completion.status === 'succeeded' ? 'Completed.' : 'Failed.');
      }

      return rawText;
    })();

    const streamed =
      params.ioMode === 'streaming'
      && Boolean(backendCtrl.streamWriter)
      && backendCtrl.sidechainStreamBuffer.trim().length > 0;
    if (shouldMaterializeInTranscript && params.intent === 'review') {
      // Even when streaming progress, emit a final terminal summary line so users get a clear completion status.
      if (sidechainMessage && sidechainMessage.trim().length > 0) {
        args.sendAcp(args.parentProvider, { type: 'message', message: sidechainMessage.trim(), sidechainId });
      }
    } else if (shouldMaterializeInTranscript && !streamed && sidechainMessage && sidechainMessage.trim().length > 0) {
      args.sendAcp(args.parentProvider, { type: 'message', message: sidechainMessage.trim(), sidechainId });
    }

    await backendCtrl.streamWriter?.flushAll({ reason: 'turn-end' });

    await args.finishRun(
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
      await args.finishRun(
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
    await args.finishRun(
      runId,
      { status: 'failed', summary: message, finishedAtMs, error: { code: executionRunErrorCode, message } },
      {
        output: {
          status: 'failed',
          summary: message,
          runId,
          callId,
          sidechainId,
          finishedAtMs,
          startedAtMs,
          error: { code: executionRunErrorCode, message },
        },
        isError: true,
      },
    );
  } finally {
    try {
      await disposeExecutionRunBackendController(backendCtrl);
    } catch {
      // ignore
    }
    try {
      await backendCtrl.terminalMarkerWritePromise;
    } catch {
      // ignore
    }
    settleExecutionRunControllerOccurrence(args.controllers, runId, backendCtrl);
  }
}
