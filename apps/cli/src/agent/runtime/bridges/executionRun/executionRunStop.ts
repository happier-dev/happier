import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from './executionRunFinishRun';
import { settleExecutionRunController } from './settleExecutionRunController';

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
    backendTarget: run.backendTarget,
    intent: run.intent,
    startedAtMs: run.startedAtMs,
    finishedAtMs,
  };

  try {
    await args.finishRun(args.runId, { status: 'cancelled', summary: 'Cancelled', finishedAtMs }, { output });
  } finally {
    await settleExecutionRunController({
      runId: args.runId,
      controller: ctrl,
      controllers: args.controllers,
    });
  }
  return { ok: true };
}
