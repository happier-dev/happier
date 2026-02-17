import type { AgentBackend, AgentMessageHandler } from '@/agent/core/AgentBackend';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunBackendController, ExecutionRunController } from '@/agent/executionRuns/controllers/types';

export async function resumeBackendControllerForResumableRun(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: (opts: { runId?: string; backendId: string; permissionMode: string }) => AgentBackend;
  onModelOutput?: () => void;
  requireReplayCapture?: boolean;
}>): Promise<
  | { ok: true }
  | { ok: false; errorCode: string; error: string }
> {
  if (args.run.retentionPolicy !== 'resumable') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not resumable' };
  }

  if (args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(args.runId, args.run.intent)) {
    return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded' };
  }

  const vendorSessionId =
    args.run.resumeHandle?.kind === 'vendor_session.v1' && args.run.resumeHandle.backendId === args.run.backendId
      ? args.run.resumeHandle.vendorSessionId
      : null;
  if (!vendorSessionId) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle' };
  }

  const backend = args.createBackend({ runId: args.runId, backendId: args.run.backendId, permissionMode: args.run.permissionMode });
  const wantsReplayCapture = args.requireReplayCapture === true;
  const canResume = wantsReplayCapture
    ? Boolean(backend.loadSessionWithReplayCapture)
    : Boolean(backend.loadSessionWithReplayCapture || backend.loadSession);
  if (!canResume) {
    await backend.dispose().catch(() => {});
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return {
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: wantsReplayCapture ? 'Backend does not support resumable long-lived runs' : 'Backend does not support resume',
    };
  }

  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const resumeCtrl: ExecutionRunBackendController = {
    kind: 'backend',
    backend,
    childSessionId: null,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    cancelled: false,
    turnCount: 0,
    lastMarkerWriteAtMs: 0,
    terminalPromise,
    resolveTerminal,
  };

  const onMessage: AgentMessageHandler = (msg) => {
    if (msg.type !== 'model-output') return;
    if (typeof (msg as any).fullText === 'string') {
      resumeCtrl.buffer = String((msg as any).fullText);
    } else if (typeof (msg as any).textDelta === 'string') {
      resumeCtrl.buffer += String((msg as any).textDelta);
    }
    args.onModelOutput?.();
  };
  backend.onMessage(onMessage);

  try {
    const loaded = backend.loadSessionWithReplayCapture
      ? await backend.loadSessionWithReplayCapture(vendorSessionId)
      : await backend.loadSession!(vendorSessionId);
    resumeCtrl.childSessionId = loaded.sessionId;
    args.controllers.set(args.runId, resumeCtrl);
    args.runs.set(args.runId, {
      ...args.run,
      status: 'running',
      finishedAtMs: undefined,
      error: undefined,
      resumeHandle: { kind: 'vendor_session.v1', backendId: args.run.backendId, vendorSessionId: loaded.sessionId },
    });
    return { ok: true };
  } catch (e: any) {
    await backend.dispose().catch(() => {});
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Resume failed' };
  }
}
