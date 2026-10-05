import { randomUUID } from 'node:crypto';

import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { AttachRetainedRunSessionInput, ExecutionRunState } from './executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
  type ConnectedServiceBindingsV2,
  type ProviderBoundModelRef,
  type SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import { resumeBackendControllerForResumableRun } from './resumeBackendController';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type { ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import type { ExecutionRunProfileContributionCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { isExecutionRunControllerCurrent, settleExecutionRunController } from './settleExecutionRunController';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';
import { resolveExecutionRunResumeBackendOptions, type ExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';

export type ExecutionRunEnsureResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: string;
      error: string;
      resumeFailureKind: 'permanent' | 'indeterminate';
    }>;

export async function ensureExecutionRun(args: Readonly<{
  runId: string;
  params: Readonly<{
    resume?: boolean;
    /** Host-only: the caller will couple bounded recovery to an admitted input. */
    inputFollowsResume?: boolean;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: ExecutionRunResumeBackendOptions & {
    runId?: string;
    controllerOccurrenceId: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    start?: ExecutionRunBackendStartContext;
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
  attachRetainedRunSessionInput?: AttachRetainedRunSessionInput;
}>): Promise<ExecutionRunEnsureResult> {
  let run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found', resumeFailureKind: 'indeterminate' };

  const wantsResume = args.params.resume === true;
  let ctrl = args.controllers.get(args.runId) ?? null;
  if (run.status !== 'running' && ctrl?.cancelled) {
    const retiringVoiceAgentId = ctrl.kind === 'voice_agent' ? ctrl.voiceAgentId : null;
    await ctrl.terminalPromise;
    if (retiringVoiceAgentId) {
      await args.voiceAgentManager.waitForRetirement(retiringVoiceAgentId);
    }
    run = args.runs.get(args.runId);
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found', resumeFailureKind: 'indeterminate' };
    ctrl = args.controllers.get(args.runId) ?? null;
  }
  let lifecycle = resolveExecutionRunLifecycle(run, ctrl);
  if (lifecycle.projection.state === 'current') return { ok: true };
  if (lifecycle.projection.state === 'recovering') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume already in progress', resumeFailureKind: 'indeterminate' };

  if (!wantsResume) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running', resumeFailureKind: 'indeterminate' };
  if (lifecycle.projection.state === 'recoverable_with_input' && args.params.inputFollowsResume !== true) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume requires input', resumeFailureKind: 'permanent' };
  }
  if (lifecycle.projection.state === 'unavailable') {
    if (lifecycle.unavailableReason === 'provider_state_missing') {
      return {
        ok: false, errorCode: 'execution_run_provider_state_missing',
        error: run.error?.message ?? 'Provider session state is missing', resumeFailureKind: 'permanent',
      };
    }
    const error = lifecycle.unavailableReason === 'not_resumable'
      ? 'Not resumable'
      : lifecycle.unavailableReason === 'unsupported'
        ? 'Not supported'
        : 'Missing resume handle';
    return { ok: false, errorCode: 'execution_run_not_allowed', error, resumeFailureKind: 'permanent' };
  }

  if (run.intent === 'voice_agent') {
    await args.voiceAgentManager.waitForRetirement(args.runId);
    run = args.runs.get(args.runId);
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found', resumeFailureKind: 'indeterminate' };
    ctrl = args.controllers.get(args.runId) ?? null;
    lifecycle = resolveExecutionRunLifecycle(run, ctrl);
    if (lifecycle.projection.state === 'current') return { ok: true };
    if (lifecycle.projection.state === 'recovering') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume already in progress', resumeFailureKind: 'indeterminate' };
    if (lifecycle.projection.state !== 'recoverable') {
      const error = lifecycle.unavailableReason === 'unsupported' ? 'Not supported' : 'Missing resume handle';
      return { ok: false, errorCode: 'execution_run_not_allowed', error, resumeFailureKind: 'permanent' };
    }
    const config = run.voiceAgentConfig ?? null;
    if (!config) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing voice agent config', resumeFailureKind: 'permanent' };
    const resumeHandle = run.resumeHandle!;

    const voiceRun = run;
    const resumeBackendOptions = resolveExecutionRunResumeBackendOptions({ run });

    const needsBudget = Boolean(args.budgetRegistry && run.status !== 'running');
    if (needsBudget && args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(args.runId, run.intent)) {
      return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded', resumeFailureKind: 'indeterminate' };
    }

    const controllerOccurrenceId = randomUUID();
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const voiceCtrl: ExecutionRunVoiceAgentController = {
      kind: 'voice_agent',
      controllerOccurrenceId,
      voiceAgentId: args.runId,
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

    const isCurrentResumeOccurrence = (): boolean => (
      args.runs.get(args.runId) === run
      && isExecutionRunControllerCurrent({
        runId: args.runId,
        controller: voiceCtrl,
        controllers: args.controllers,
      })
    );

    const retireVoiceResumeOccurrence = async (): Promise<boolean> => {
      const owned = isExecutionRunControllerCurrent({
        runId: args.runId,
        controller: voiceCtrl,
        controllers: args.controllers,
      });
      if (owned) {
        voiceCtrl.cancelled = true;
        if (needsBudget) args.budgetRegistry?.releaseExecutionRun(args.runId);
      }
      await settleExecutionRunController({
        runId: args.runId,
        controller: voiceCtrl,
        controllers: args.controllers,
      });
      return owned;
    };

    try {
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
        ...(resumeBackendOptions.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: resumeBackendOptions.sessionConfigOptionOverrides }
          : {}),
        ...(resumeBackendOptions.connectedServices !== undefined
          ? { connectedServices: resumeBackendOptions.connectedServices }
          : {}),
        commitIsolation: config.commitIsolation,
        permissionIntent: config.permissionIntent,
        idleTtlSeconds: config.idleTtlSeconds,
        initialContext: config.initialContext,
        initialContextMode: config.initialContextMode,
        ...(config.voicePolicy ? { voicePolicy: config.voicePolicy } : {}),
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
            ...resumeBackendOptions,
            runId: args.runId,
            controllerOccurrenceId,
            backendId,
            backendTarget,
            modelId,
            // Voice owns separate chat/commit selections; never inherit the
            // admitted chat model selection into the commit role.
            modelSelection,
            ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
            permissionMode: permissionIntent,
            workspaceWrites: voiceRun.workspaceWrites,
            ...(args.params.causalPermissionAuthority
              ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
              : {}),
            start: {
              ...resumeBackendOptions.start,
              ...(start ?? {}),
            },
            ...(connectedServices !== undefined ? { connectedServices } : {}),
          }),
      });
      if (!isCurrentResumeOccurrence()) {
        await args.voiceAgentManager.stop({ voiceAgentId: startedVoice.voiceAgentId }).catch(() => {});
        await retireVoiceResumeOccurrence();
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
      }

      const nextResumeHandle = args.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId) ?? resumeHandle;
      const resumedRun: ExecutionRunState = {
        ...run,
        status: 'running',
        finishedAtMs: undefined,
        error: undefined,
        resumeHandle: nextResumeHandle,
        voiceAgentConfig: config,
      };
      args.runs.set(args.runId, resumedRun);

      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
      if (
        args.runs.get(args.runId)?.status !== 'running'
        || !isExecutionRunControllerCurrent({
          runId: args.runId,
          controller: voiceCtrl,
          controllers: args.controllers,
        })
      ) {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
      }
      args.onPublicStateUpdated?.(args.runId);
      return { ok: true };
    } catch (error: unknown) {
      await retireVoiceResumeOccurrence();
      const message = error instanceof Error ? error.message : 'Resume failed';
      return { ok: false, errorCode: 'execution_run_not_allowed', error: message, resumeFailureKind: 'indeterminate' };
    }
  }

  const resumed = await resumeBackendControllerForResumableRun({
    runId: args.runId,
    run,
    runs: args.runs,
    controllers: args.controllers,
    budgetRegistry: args.budgetRegistry,
    createRuntime: ({ controllerOccurrenceId, backendId, backendTarget, permissionMode, causalPermissionAuthority, accountSettings }) =>
      args.createRuntime({
        runId: args.runId,
        controllerOccurrenceId,
        backendId,
        backendTarget,
        permissionMode,
        ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
        accountSettings,
      }),
    sendAcp: args.sendAcp,
    parentProvider: args.parentProvider,
    streamedTranscriptSession: args.streamedTranscriptSession,
    getPermissionRequestStore: args.getPermissionRequestStore,
    writeActivityMarker: args.writeActivityMarker,
    getNowMs: args.getNowMs,
    profileCatalog: args.profileCatalog,
    ...(args.params.causalPermissionAuthority
      ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
      : {}),
    ...(args.onPublicStateUpdated ? { onPublicStateUpdated: args.onPublicStateUpdated } : {}),
    requireReplayCapture: run.runClass === 'long_lived',
    onModelOutput: () => {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    },
    ...(args.attachRetainedRunSessionInput
      ? { attachRetainedRunSessionInput: args.attachRetainedRunSessionInput }
      : {}),
  });
  if (!resumed.ok) return resumed;
  const resumedController = args.controllers.get(args.runId) ?? null;
  const resumedRun = args.runs.get(args.runId) ?? null;
  await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });
  if (
    !resumedController
    || !resumedRun
    || args.runs.get(args.runId) !== resumedRun
    || !isExecutionRunControllerCurrent({
      runId: args.runId,
      controller: resumedController,
      controllers: args.controllers,
    })
  ) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
  }
  return { ok: true };
}
