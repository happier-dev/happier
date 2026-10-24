import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { resumeBackendControllerForResumableRun, type ResumedExecutionRunBackend } from '@/agent/executionRuns/runtime/resumeBackendController';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
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
  /** Async backend factory owning launch rehydration; see resumeBackendControllerForResumableRun. */
  createBackend: () => Promise<ResumedExecutionRunBackend>;
  isSessionClosing?: () => boolean;
  sendAcp: AcpSendFn;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  getNowMs: () => number;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean; resumed?: boolean }>) => Promise<void>;
  admitRuntimeActivity: (runId: string) => Promise<void>;
  rollbackRuntimeActivityAfterFailedAdmission: (reason: string) => Promise<void>;
  terminalRuntimeActivityAfterFailedAdmission: (runId: string, reason: string) => Promise<void>;
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

      const previousRun = args.runs.get(args.runId) ?? run;
      args.runs.set(args.runId, {
        ...run,
        status: 'running',
        finishedAtMs: undefined,
        error: undefined,
      });
      try {
        await args.admitRuntimeActivity(args.runId);
      } catch (error) {
        args.runs.set(args.runId, previousRun);
        if (needsBudget) args.budgetRegistry?.releaseExecutionRun(args.runId);
        await args.rollbackRuntimeActivityAfterFailedAdmission('execution-run-resume-admission-rolled-back');
        return {
          ok: false,
          errorCode: 'execution_run_runtime_activity_unavailable',
          error: error instanceof Error ? error.message : 'Runtime activity admission failed',
        };
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

      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true, resumed: true });
      return { ok: true };
    } catch (e: any) {
      args.runs.set(args.runId, run);
      if (needsBudget) args.budgetRegistry?.releaseExecutionRun(args.runId);
      const message = e instanceof Error ? e.message : 'Resume failed';
      try {
        await args.terminalRuntimeActivityAfterFailedAdmission(args.runId, 'execution_run_resume_failed');
      } catch (terminalError) {
        return {
          ok: false,
          errorCode: 'execution_run_runtime_activity_unavailable',
          error: terminalError instanceof Error ? terminalError.message : 'Runtime activity terminal publication failed',
        };
      }
      return { ok: false, errorCode: 'execution_run_not_allowed', error: message };
    }
  }

  const resumed = await resumeBackendControllerForResumableRun({
    runId: args.runId,
    run,
    runs: args.runs,
    controllers: args.controllers,
    budgetRegistry: args.budgetRegistry,
    createBackend: args.createBackend,
    isSessionClosing: args.isSessionClosing,
    sendAcp: args.sendAcp,
    parentProvider: args.parentProvider,
    streamedTranscriptSession: args.streamedTranscriptSession,
    writeActivityMarker: args.writeActivityMarker,
    getNowMs: args.getNowMs,
    admitRuntimeActivity: args.admitRuntimeActivity,
    rollbackRuntimeActivityAfterFailedAdmission: args.rollbackRuntimeActivityAfterFailedAdmission,
    terminalRuntimeActivityAfterFailedAdmission: args.terminalRuntimeActivityAfterFailedAdmission,
    ...(args.onPublicStateUpdated ? { onPublicStateUpdated: args.onPublicStateUpdated } : {}),
    requireReplayCapture: run.runClass === 'long_lived',
    onModelOutput: () => {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    },
  });
  if (!resumed.ok) return resumed;
  return { ok: true };
}
