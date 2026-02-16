import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { resumeBackendControllerForResumableRun } from '@/agent/executionRuns/runtime/resumeBackendController';

export async function ensureExecutionRun(args: Readonly<{
  runId: string;
  params: Readonly<{ resume?: boolean }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: (opts: { runId?: string; backendId: string; permissionMode: string; modelId?: string; start?: any }) => AgentBackend;
  getNowMs: () => number;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  voiceAgentManager: VoiceAgentManager;
}>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
  const run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

  const wantsResume = args.params.resume === true;
  const ctrl = args.controllers.get(args.runId) ?? null;
  if (run.status === 'running' && ctrl) return { ok: true };

  if (!wantsResume) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  if (run.retentionPolicy !== 'resumable') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not resumable' };
  if (ctrl && ctrl.kind === 'voice_agent' && run.intent !== 'voice_agent') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
  }

  if (run.intent === 'voice_agent') {
    if (run.ioMode !== 'streaming') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
    const config = run.voiceAgentConfig ?? null;
    if (!config) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing voice agent config' };
    const resumeHandle = run.resumeHandle && run.resumeHandle.backendId === run.backendId ? run.resumeHandle : null;
    if (!resumeHandle) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle' };

    const needsBudget = Boolean(args.budgetRegistry && run.status !== 'running');
    if (needsBudget && args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(args.runId, run.intent)) {
      return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded' };
    }

    try {
      let resolveTerminal!: () => void;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });

      const startedVoice = await args.voiceAgentManager.start({
        agentId: run.backendId as any,
        chatModelId: config.chatModelId,
        commitModelId: config.commitModelId,
        commitIsolation: config.commitIsolation,
        permissionPolicy: config.permissionPolicy,
        idleTtlSeconds: config.idleTtlSeconds,
        initialContext: config.initialContext,
        verbosity: config.verbosity,
        resumeHandle,
      });

      const voiceCtrl: ExecutionRunVoiceAgentController = {
        kind: 'voice_agent',
        voiceAgentId: startedVoice.voiceAgentId,
        cancelled: false,
        lastMarkerWriteAtMs: 0,
        terminalPromise,
        resolveTerminal,
        transcript: config.transcript,
        externalStreamIdByInternal: new Map(),
        internalStreamIdByExternal: new Map(),
        persistedDoneByExternalStreamId: new Set(),
      };
      args.controllers.set(args.runId, voiceCtrl);

      const nextResumeHandle = args.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId) ?? resumeHandle;
      args.runs.set(args.runId, {
        ...run,
        status: 'running',
        finishedAtMs: undefined,
        error: undefined,
        resumeHandle: nextResumeHandle,
        voiceAgentConfig: config,
      });

      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
      return { ok: true };
    } catch (e: any) {
      if (needsBudget) args.budgetRegistry?.releaseExecutionRun(args.runId);
      const message = e instanceof Error ? e.message : 'Resume failed';
      return { ok: false, errorCode: 'execution_run_not_allowed', error: message };
    }
  }

  const resumed = await resumeBackendControllerForResumableRun({
    runId: args.runId,
    run,
    runs: args.runs,
    controllers: args.controllers,
    budgetRegistry: args.budgetRegistry,
    createBackend: ({ backendId, permissionMode }) => args.createBackend({ runId: args.runId, backendId, permissionMode }),
    requireReplayCapture: run.runClass === 'long_lived',
    onModelOutput: () => {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    },
  });
  if (!resumed.ok) return resumed;
  await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
  return { ok: true };
}
