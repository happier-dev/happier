import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunManagerStartParams } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunController, ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';
import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from '@/agent/executionRuns/runtime/turnDelivery';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/executionRuns/runtime/backendTargets';
import { buildReviewGuidanceBlock } from '@/agent/reviews/prompt/buildStandardReviewPrompt';
import { logger } from '@/ui/logger';

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
  controllers: ReadonlyMap<string, ExecutionRunController>;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
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
      backendCtrl.buffer = '';
      backendCtrl.sidechainStreamBuffer = '';
      backendCtrl.sidechainStreamKey = '';
      return backendCtrl.backend.sendPrompt(backendCtrl.childSessionId!, turnPrompt);
    }

    async function waitForTurnComplete(sendPromptPromise: Promise<void>): Promise<void> {
      await sendPromptPromise;
      if (backendCtrl.backend.waitForResponseComplete) {
        const timeoutMs = args.boundedTimeoutMs;
        if (typeof timeoutMs === 'number') {
          await backendCtrl.backend.waitForResponseComplete(timeoutMs);
          return;
        }
        await backendCtrl.backend.waitForResponseComplete();
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

    const timeoutMs = args.boundedTimeoutMs;
    if (typeof timeoutMs === 'number') {
      await Promise.race([
        runPromise,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } else {
      await runPromise;
    }

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

    args.finishRun(
      runId,
      { status: completion.status, summary: completion.summary, finishedAtMs },
      { output: completion.toolResultOutput, meta: completion.toolResultMeta },
      completion.structuredMeta,
    );
  } catch (e: any) {
    if (backendCtrl.cancelled) return;
    const message = e instanceof Error ? e.message : 'Execution failed';
    if (e instanceof Error && message.startsWith('Timed out after ')) {
      try {
        if (backendCtrl.childSessionId) await backendCtrl.backend.cancel(backendCtrl.childSessionId);
      } catch {
        // best effort
      }
      await backendCtrl.streamWriter?.flushAll({ reason: 'abort', interruptedReason: message });
      const finishedAtMs = args.getNowMs();
      args.finishRun(
        runId,
        { status: 'timeout', summary: message, finishedAtMs, error: { code: 'execution_run_timeout', message } },
        {
          output: {
            status: 'timeout',
            summary: message,
            runId,
            callId,
            sidechainId,
            finishedAtMs,
            startedAtMs,
            error: { code: 'execution_run_timeout', message },
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
