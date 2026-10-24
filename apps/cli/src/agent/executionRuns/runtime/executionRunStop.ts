import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';
import { disposeExecutionRunBackendController, settleExecutionRunControllerOccurrence } from '@/agent/executionRuns/runtime/settleExecutionRunControllerOccurrence';
import { logger } from '@/ui/logger';

export async function stopExecutionRun(args: Readonly<{
  runId: string;
  runs: ReadonlyMap<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
  getNowMs: () => number;
  finishRun: FinishExecutionRun;
}>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
  const run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  if (run.status !== 'running') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  const ctrl = args.controllers.get(args.runId);
  if (!ctrl) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };

  ctrl.cancelled = true;
  const leafCancellation = Promise.resolve().then(async () => {
    if (ctrl.kind === 'backend') {
      if (ctrl.childSessionId && !ctrl.disposalPromise) {
        await ctrl.backend.cancel(ctrl.childSessionId);
      }
      return;
    }
    await args.voiceAgentManager.stop({ voiceAgentId: ctrl.voiceAgentId });
  });
  ctrl.cancellationPromise = leafCancellation;
  if (ctrl.kind === 'voice_agent') ctrl.disposalPromise = leafCancellation;
  void leafCancellation.catch((error) => {
    logger.warn('[EXECUTION RUN] Provider cancellation failed after host stop', {
      runId: args.runId,
      controllerKind: ctrl.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const finishedAtMs = args.getNowMs();
  const output = {
    status: 'cancelled',
    summary: 'Cancelled',
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    backendTarget: run.backendTarget,
    intent: run.intent,
    startedAtMs: run.startedAtMs,
    finishedAtMs,
  };

  try {
    await args.finishRun(args.runId, { status: 'cancelled', summary: 'Cancelled', finishedAtMs }, { output });
  } finally {
    try {
      await ctrl.terminalMarkerWritePromise;
    } catch {
      // ignore
    }
    if (ctrl.kind === 'backend') {
      const leafDisposal = disposeExecutionRunBackendController(ctrl);
      void leafDisposal.catch((error) => {
        logger.warn('[EXECUTION RUN] Backend disposal failed after host stop', {
          runId: args.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    settleExecutionRunControllerOccurrence(args.controllers, args.runId, ctrl);
  }
  return { ok: true };
}
