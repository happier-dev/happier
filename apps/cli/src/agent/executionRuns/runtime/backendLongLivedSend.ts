import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import type { ExecutionRunController } from '@/agent/executionRuns/runtime/executionRunControllers';
import type { FinishExecutionRun } from '@/agent/executionRuns/runtime/executionRunFinishRun';
import { resumeBackendControllerForResumableRun } from '@/agent/executionRuns/runtime/resumeBackendController';

export async function sendBackendLongLivedRun(args: Readonly<{
  runId: string;
  params: Readonly<{ message: string; resume?: boolean }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: (opts: { backendId: string; permissionMode: string }) => AgentBackend;
  maxTurns: number | null;
  getNowMs: () => number;
  finishRun: FinishExecutionRun;
  sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: string;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
}>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
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

  if (!backendCtrl || !backendCtrl.childSessionId) {
    if (wantsResume && run.retentionPolicy === 'resumable') {
      const resumed = await resumeBackendControllerForResumableRun({
        runId: args.runId,
        run,
        runs: args.runs,
        controllers: args.controllers,
        budgetRegistry: args.budgetRegistry,
        createBackend: args.createBackend,
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

  if (typeof args.maxTurns === 'number' && ctrl2.turnCount >= args.maxTurns) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Turn limit exceeded' };
  }

  ctrl2.buffer = '';
  try {
    ctrl2.turnCount += 1;
    await ctrl2.backend.sendPrompt(ctrl2.childSessionId, args.params.message);
    if (ctrl2.backend.waitForResponseComplete) {
      await ctrl2.backend.waitForResponseComplete();
    }
  } catch (e: any) {
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
    ctrl2.resolveTerminal();
    args.controllers.delete(args.runId);
    return { ok: false, errorCode: 'execution_run_failed', error: message };
  }

  const rawText = ctrl2.buffer.trim();
  if (rawText.length > 0) {
    args.sendAcp(args.parentProvider, { type: 'message', message: rawText, sidechainId: run.sidechainId });
  }

  // Force a post-send marker write so callers can immediately observe activity updates
  // even if a best-effort onMessage marker write is in-flight/throttled.
  await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });

  return { ok: true };
}
