import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunManagerStartParams } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunController, ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';

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
      backendId: params.backendId,
      instructions: params.instructions ?? '',
      permissionMode: params.permissionMode,
      retentionPolicy: params.retentionPolicy,
      runClass: params.runClass,
      ioMode: params.ioMode,
      startedAtMs,
    } as const;
    const prompt = profile.buildPrompt(start);

    async function runOneTurn(turnPrompt: string): Promise<void> {
      await backendCtrl.backend.sendPrompt(backendCtrl.childSessionId!, turnPrompt);
      if (backendCtrl.backend.waitForResponseComplete) {
        await backendCtrl.backend.waitForResponseComplete();
      }
    }

    const runPromise = runOneTurn(prompt);

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

    // Review runs rely on a strict trailing JSON object for structured findings. Models sometimes violate
    // this contract; for resilience we attempt ONE deterministic "repair" pass.
    if (params.intent === 'review') {
      const errorCode = (completion as any)?.toolResultOutput?.error?.code;
      if (completion.status === 'failed' && errorCode === 'invalid_output') {
        const repairPrompt = [
          'Your previous response did not include the required final JSON object.',
          'Return ONLY valid JSON with this shape:',
          '{',
          '  "summary": string,',
          '  "findings": Array<{',
          '    "id": string,',
          '    "title": string,',
          '    "severity": "blocker"|"high"|"medium"|"low"|"nit",',
          '    "category": "correctness"|"security"|"performance"|"maintainability"|"testing"|"style"|"docs",',
          '    "summary": string,',
          '    "filePath"?: string,',
          '    "startLine"?: number,',
          '    "endLine"?: number,',
          '    "suggestion"?: string,',
          '    "patch"?: string',
          '  }>',
          '}',
          '',
          'Content to convert:',
          rawText,
        ].join('\n');

        // Reset buffers so the second pass is parsed deterministically.
        backendCtrl.buffer = '';
        backendCtrl.sidechainStreamBuffer = '';
        backendCtrl.sidechainStreamKey = '';
        backendCtrl.turnCount += 1;

        await runOneTurn(repairPrompt);

        const repairedRawText = backendCtrl.buffer.trim();
        completion = profile.onBoundedComplete({
          start,
          rawText: repairedRawText,
          finishedAtMs,
        });
      }
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

    const streamed = params.ioMode === 'streaming' && backendCtrl.sidechainStreamBuffer.trim().length > 0;
    if (shouldMaterializeInTranscript && params.intent === 'review') {
      // Even when streaming progress, emit a final terminal summary line so users get a clear completion status.
      if (sidechainMessage && sidechainMessage.trim().length > 0) {
        args.sendAcp(args.parentProvider, { type: 'message', message: sidechainMessage.trim(), sidechainId });
      }
    } else if (shouldMaterializeInTranscript && !streamed && sidechainMessage && sidechainMessage.trim().length > 0) {
      args.sendAcp(args.parentProvider, { type: 'message', message: sidechainMessage.trim(), sidechainId });
    }

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
