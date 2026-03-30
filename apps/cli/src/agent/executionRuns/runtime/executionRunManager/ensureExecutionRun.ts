import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { resumeBackendControllerForResumableRun } from '@/agent/executionRuns/runtime/resumeBackendController';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import {
  areExecutionRunBackendTargetsEqual,
  resolveExecutionRunBuiltInAgentId,
} from '@/agent/executionRuns/runtime/backendTargets';

export async function ensureExecutionRun(args: Readonly<{
  runId: string;
  params: Readonly<{ resume?: boolean }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: (opts: {
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    modelId?: string;
    start?: any;
  }) => AgentBackend;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  getNowMs: () => number;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  voiceAgentManager: VoiceAgentManager;
  onPublicStateUpdated?: (runId: string) => void;
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
    const resumeHandle =
      run.resumeHandle
      && areExecutionRunBackendTargetsEqual(run.resumeHandle.backendTarget, run.backendTarget)
      && (run.resumeHandle.kind === 'vendor_session.v1' || run.resumeHandle.kind === 'voice_agent_sessions.v1')
        ? run.resumeHandle
        : null;
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

      const builtInAgentId = resolveExecutionRunBuiltInAgentId(run.backendTarget);
      if (!builtInAgentId) {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
      }

      const startedVoice = await args.voiceAgentManager.start({
        agentId: builtInAgentId as any,
        ...(typeof config.profileId === 'string' && config.profileId.trim().length > 0
          ? { profileId: config.profileId.trim() }
          : {}),
        contextSessionId: run.sessionId,
        chatModelId: config.chatModelId,
        commitModelId: config.commitModelId,
        commitIsolation: config.commitIsolation,
        permissionPolicy: config.permissionPolicy,
        idleTtlSeconds: config.idleTtlSeconds,
        initialContext: config.initialContext,
        initialContextMode: config.initialContextMode,
        verbosity: config.verbosity,
        ...(typeof config.bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs: config.bootstrapTimeoutMs } : {}),
        disabledActionIds: config.disabledActionIds,
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
    createBackend: ({ backendId, backendTarget, permissionMode }) => args.createBackend({ runId: args.runId, backendId, backendTarget, permissionMode }),
    sendAcp: args.sendAcp,
    parentProvider: args.parentProvider,
    streamedTranscriptSession: args.streamedTranscriptSession,
    writeActivityMarker: args.writeActivityMarker,
    getNowMs: args.getNowMs,
    ...(args.onPublicStateUpdated ? { onPublicStateUpdated: args.onPublicStateUpdated } : {}),
    requireReplayCapture: run.runClass === 'long_lived',
    onModelOutput: () => {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    },
  });
  if (!resumed.ok) return resumed;
  await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
  return { ok: true };
}
