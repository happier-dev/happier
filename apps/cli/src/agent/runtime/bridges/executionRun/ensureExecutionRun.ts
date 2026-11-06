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
import { createExecutionRunResumeMaterialization, resumeBackendControllerForResumableRun, type ExecutionRunResumeMaterializationHooks } from './resumeBackendController';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type { RegisterExecutionRunOccurrence } from './runOccurrenceWitness';
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
    signal?: AbortSignal;
    /** Host-only: the caller will couple bounded recovery to an admitted input. */
    inputFollowsResume?: boolean;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
  }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: ExecutionRunResumeBackendOptions & ExecutionRunResumeMaterializationHooks & {
    runId?: string;
    controllerOccurrenceId: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
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
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean; resumed?: boolean }>) => Promise<void>;
  voiceAgentManager: VoiceAgentManager;
  onPublicStateUpdated?: (runId: string) => void;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  readNativeOfferedModel?: ExecutionRunController['readNativeOfferedModel'];
  nativeModelRegistry?: ExecutionRunController['nativeModelRegistry'];
  attachRetainedRunSessionInput?: AttachRetainedRunSessionInput;
  registerRunOccurrence?: RegisterExecutionRunOccurrence;
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
    if (needsBudget && args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(args.runId, run.intent, run.requesterWorkAttributionV1)) {
      return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded', resumeFailureKind: 'indeterminate' };
    }

    const controllerOccurrenceId = randomUUID();
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const voiceCtrl: ExecutionRunVoiceAgentController = {
      kind: 'voice_agent',
      ...(args.profileCatalog ? { profileCatalog: args.profileCatalog } : {}),
      readNativeOfferedModel: args.readNativeOfferedModel,
      nativeModelRegistry: args.nativeModelRegistry,
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

    const materialization = createExecutionRunResumeMaterialization({
      runId: args.runId, run, runs: args.runs,
      isCurrentOccurrence: () => isExecutionRunControllerCurrent({
        runId: args.runId, controller: voiceCtrl, controllers: args.controllers,
      }),
    });
    materialization.publishProvisioning();
    voiceCtrl.resumeMaterialization = materialization;
    const releaseOccurrence = args.registerRunOccurrence?.({ runId: args.runId, sidechainId: run.sidechainId, controller: voiceCtrl });
    if (releaseOccurrence) voiceCtrl.releaseSessionInputAttachment = async () => releaseOccurrence();
    const isCurrentResumeOccurrence = materialization.isCurrent;

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

    let startedVoice: Awaited<ReturnType<VoiceAgentManager['start']>> | null = null;
    try {
      startedVoice = await args.voiceAgentManager.start({
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
        ...(config.commitConnectedServices !== undefined ? { commitConnectedServices: config.commitConnectedServices } : {}),
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
        ...(args.params.signal ? { signal: args.params.signal } : {}),
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
            ...(args.params.actionRequestAttributionV1 ? { actionRequestAttributionV1: args.params.actionRequestAttributionV1 } : {}),
            start: {
              ...resumeBackendOptions.start,
              ...(start ?? {}),
            },
            ...(connectedServices !== undefined ? { connectedServices } : {}),
            ...materialization.hooks,
          }),
      });
      if (!isCurrentResumeOccurrence()) {
        await args.voiceAgentManager.stop({ voiceAgentId: startedVoice.voiceAgentId }).catch(() => {});
        await retireVoiceResumeOccurrence();
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
      }

      const nextResumeHandle = args.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId) ?? resumeHandle;
      const current = args.runs.get(args.runId)!;
      const preparedRegistration = materialization.readRegistration();
      const resumedRun: ExecutionRunState = {
        ...current,
        status: 'running',
        finishedAtMs: undefined,
        error: undefined,
        resumeHandle: nextResumeHandle,
        voiceAgentConfig: config,
        ...(preparedRegistration ? { launch: {
          ...(current.launch ?? {}), connectedServicesRegistration: preparedRegistration,
        } } : {}),
      };
      args.runs.set(args.runId, resumedRun);

      await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true, resumed: true });
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
      if (!startedVoice) materialization.rollback();
      await retireVoiceResumeOccurrence();
      const message = error instanceof Error ? error.message : 'Resume failed';
      return { ok: false, errorCode: 'execution_run_not_allowed', error: message, resumeFailureKind: 'indeterminate' };
    } finally {
      delete voiceCtrl.resumeMaterialization;
    }
  }

  const resumed = await resumeBackendControllerForResumableRun({
    runId: args.runId,
    run,
    runs: args.runs,
    controllers: args.controllers,
    budgetRegistry: args.budgetRegistry,
    createRuntime: ({ controllerOccurrenceId, backendId, backendTarget, permissionMode, causalPermissionAuthority, accountSettings, onConnectedServicesSelection, onConnectedServicesRegistration }) =>
      args.createRuntime({
        runId: args.runId,
        controllerOccurrenceId,
        backendId,
        backendTarget,
        permissionMode,
        ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
        ...(args.params.actionRequestAttributionV1 ? { actionRequestAttributionV1: args.params.actionRequestAttributionV1 } : {}),
        accountSettings,
        onConnectedServicesSelection,
        onConnectedServicesRegistration,
      }),
    sendAcp: args.sendAcp,
    parentProvider: args.parentProvider,
    streamedTranscriptSession: args.streamedTranscriptSession,
    getPermissionRequestStore: args.getPermissionRequestStore,
    writeActivityMarker: args.writeActivityMarker,
    getNowMs: args.getNowMs,
    profileCatalog: args.profileCatalog,
    readNativeOfferedModel: args.readNativeOfferedModel,
    nativeModelRegistry: args.nativeModelRegistry,
    ...(args.params.causalPermissionAuthority
      ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
      : {}),
    ...(args.params.actionRequestAttributionV1 ? { actionRequestAttributionV1: args.params.actionRequestAttributionV1 } : {}),
    ...(args.onPublicStateUpdated ? { onPublicStateUpdated: args.onPublicStateUpdated } : {}),
    requireReplayCapture: run.runClass === 'long_lived',
    onModelOutput: () => {
      void args.writeActivityMarker(args.runId, args.getNowMs());
    },
    ...(args.attachRetainedRunSessionInput
      ? { attachRetainedRunSessionInput: args.attachRetainedRunSessionInput }
      : {}),
    ...(args.registerRunOccurrence ? { registerRunOccurrence: args.registerRunOccurrence } : {}),
  });
  if (!resumed.ok) return resumed;
  const resumedController = args.controllers.get(args.runId) ?? null;
  const resumedRun = args.runs.get(args.runId) ?? null;
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
