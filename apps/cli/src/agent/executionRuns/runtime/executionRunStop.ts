import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import type { ExecutionRunController } from '@/agent/executionRuns/runtime/executionRunControllers';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';

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
  if (ctrl.kind === 'backend') {
    try {
      if (ctrl.childSessionId) {
        await ctrl.backend.cancel(ctrl.childSessionId);
      }
    } catch {
      // best effort
    }
  } else {
    try {
      await args.voiceAgentManager.stop({ voiceAgentId: ctrl.voiceAgentId });
    } catch {
      // best-effort
    }
  }

  const finishedAtMs = args.getNowMs();
  const output = {
    status: 'cancelled',
    summary: 'Cancelled',
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    backendId: run.backendId,
    intent: run.intent,
    startedAtMs: run.startedAtMs,
    finishedAtMs,
  };

  args.finishRun(args.runId, { status: 'cancelled', summary: 'Cancelled', finishedAtMs }, { output });
  if (ctrl.kind === 'backend') {
    try {
      await ctrl.backend.dispose();
    } catch {
      // ignore
    }
  }
  ctrl.resolveTerminal();
  args.controllers.delete(args.runId);
  return { ok: true };
}
