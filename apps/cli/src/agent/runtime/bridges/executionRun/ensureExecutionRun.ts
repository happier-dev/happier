import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
  convertBackendTargetRefV2ToV1,
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
  type ConnectedServiceBindingsV1,
  type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import { resumeBackendControllerForResumableRun } from './resumeBackendController';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { areExecutionRunBackendTargetsEqual } from './backendTargets';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type { ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import type { ExecutionRunProfileContributionCatalog } from '@/agent/executionRuns/profiles/intentRegistry';

export async function ensureExecutionRun(args: Readonly<{
  runId: string;
  params: Readonly<{ resume?: boolean }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: {
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    start?: any;
  }) => ExecutionRunHostRuntime;
  sendAcp: ExecutionRunTranscriptPublisher;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  getNowMs: () => number;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  voiceAgentManager: VoiceAgentManager;
  onPublicStateUpdated?: (runId: string) => void;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
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
      && areExecutionRunBackendTargetsEqual(convertBackendTargetRefV2ToV1(run.resumeHandle.backendTarget), run.backendTarget)
      && (run.resumeHandle.kind === 'provider_session.v1' || run.resumeHandle.kind === 'voice_agent_sessions.v1')
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

      const startedVoice = await args.voiceAgentManager.start({
        voiceAgentId: args.runId,
        backendTarget: run.backendTarget,
        ...(typeof config.profileId === 'string' && config.profileId.trim().length > 0
          ? { profileId: config.profileId.trim() }
          : {}),
        contextSessionId: run.sessionId,
        chatModelId: config.chatModelId,
        commitModelId: config.commitModelId,
        ...(config.chatModelSelection ? { chatModelSelection: config.chatModelSelection } : {}),
        ...(config.commitModelSelection ? { commitModelSelection: config.commitModelSelection } : {}),
        ...(run.launch?.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: run.launch.sessionConfigOptionOverrides }
          : {}),
        commitIsolation: config.commitIsolation,
        permissionIntent: config.permissionIntent,
        idleTtlSeconds: config.idleTtlSeconds,
        initialContext: config.initialContext,
        initialContextMode: config.initialContextMode,
        verbosity: config.verbosity,
        ...(typeof config.bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs: config.bootstrapTimeoutMs } : {}),
        disabledActionIds: config.disabledActionIds,
        resumeHandle,
      }, {
        createRuntime: ({
          backendTarget,
          backendId,
          modelId,
          modelSelection,
          sessionConfigOptionOverrides,
          permissionIntent,
          start,
          connectedServices,
        }) =>
          args.createRuntime({
            runId: args.runId,
            backendId,
            backendTarget,
            modelId,
            ...(modelSelection ? { modelSelection } : {}),
            ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
            permissionMode: permissionIntent,
            ...(start ? { start } : {}),
            ...(connectedServices !== undefined ? { connectedServices } : {}),
          }),
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
        pendingTranscriptTurnByExternalStreamId: new Map(),
        terminalReadByExternalStreamId: new Map(),
        readInFlightByExternalStreamId: new Map(),
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
      args.onPublicStateUpdated?.(args.runId);
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
    createRuntime: ({ backendId, backendTarget, permissionMode, accountSettings }) =>
      args.createRuntime({ runId: args.runId, backendId, backendTarget, permissionMode, accountSettings }),
    sendAcp: args.sendAcp,
    parentProvider: args.parentProvider,
    streamedTranscriptSession: args.streamedTranscriptSession,
    getPermissionRequestStore: args.getPermissionRequestStore,
    writeActivityMarker: args.writeActivityMarker,
    getNowMs: args.getNowMs,
    profileCatalog: args.profileCatalog,
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
