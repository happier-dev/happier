import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { randomUUID } from 'node:crypto';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1, ExecutionRunConnectedServicesLaunchV1, SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';

import type { AttachRetainedRunSessionInput, ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunBackendController, ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { failureSignal } from '@/agent/executionRuns/controllers/failureSignal';
import { areExecutionRunBackendTargetsEqual } from './backendTargets';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createExecutionRunControllerMessageHandler } from './messages/sessionStateEmission';
import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { createExecutionRunSidechainStreamText } from './sidechainStreamText';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type { ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import { isExecutionRunControllerCurrent, settleExecutionRunController } from './settleExecutionRunController';
import type { ExecutionRunEnsureResult } from './ensureExecutionRun';
import type { ExecutionRunConnectedServicesSelectionReport } from './runtime/create';

export type ExecutionRunResumeMaterializationHooks = Readonly<{
  onConnectedServicesSelection?: (selection: ExecutionRunConnectedServicesSelectionReport) => void | Promise<void>;
  onConnectedServicesRegistration?: (registration: ExecutionRunConnectedServicesLaunchV1) => void | Promise<void>;
}>;

export type ExecutionRunResumeMaterializationAuthority = Readonly<{
  occurrenceId: string;
  isCurrent(): boolean;
}>;

/** Borrow the existing controller's exact resume attempt, without another registry. */
export function captureExecutionRunResumeMaterialization(args: Readonly<{
  runId: string;
  occurrenceId: string;
  controllers: ReadonlyMap<string, ExecutionRunController>;
}>): ExecutionRunResumeMaterializationAuthority | null {
  const controller = args.controllers.get(args.runId);
  const materialization = controller?.resumeMaterialization;
  if (!controller || controller.controllerOccurrenceId !== args.occurrenceId
    || !materialization?.isCurrent()) return null;
  const isCurrent = () => materialization.isCurrent()
    && (controller.kind !== 'backend' || !controller.backend.getRuntimeLifetimeSignal().aborted);
  // Issued materialization remains bound to this controller after native open.
  // Only new captures require the in-flight resume; Stop/replacement retires both.
  return isCurrent() ? Object.freeze({ occurrenceId: args.occurrenceId, isCurrent }) : null;
}

/** One admission/held-registration owner for each genuinely claimed resume. */
export function createExecutionRunResumeMaterialization(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  isCurrentOccurrence: () => boolean;
}>): Readonly<{
  hooks: Required<ExecutionRunResumeMaterializationHooks>;
  publishProvisioning(): void;
  isCurrent(): boolean;
  rollback(): ExecutionRunState | null;
  readRegistration(): ExecutionRunConnectedServicesLaunchV1 | undefined;
}> {
  let preparedRegistration: ExecutionRunConnectedServicesLaunchV1 | undefined;
  let preparedSelection: ExecutionRunConnectedServicesSelectionReport | undefined;
  const isCurrent = () => args.runs.get(args.runId)?.status === 'running' && args.isCurrentOccurrence();
  return {
    hooks: {
      onConnectedServicesSelection(selection) {
        if (!isCurrent()) throw new Error('Execution-run resume selection is no longer current');
        const current = args.runs.get(args.runId)!;
        preparedSelection = selection;
        args.runs.set(args.runId, { ...current, launch: {
          ...(current.launch ?? {}),
          connectedServicesSelection: selection.connectedServicesBindings,
          ...(selection.agentContribution ? { connectedServicesSelectionAgent: selection.agentContribution } : {}),
        } });
      },
      onConnectedServicesRegistration(registration) {
        if (registration.runKey !== args.runId || !isCurrent()) {
          throw new Error('Execution-run resume registration is no longer current');
        }
        preparedRegistration = registration;
      },
    },
    publishProvisioning() {
      const current = args.runs.get(args.runId);
      if (!current || !args.isCurrentOccurrence()) throw new Error('Execution-run resume occurrence is no longer current');
      // This is a real provider provisioning attempt. The existing running
      // phase admits its selection; registration/marker wait for successful load.
      args.runs.set(args.runId, { ...current, status: 'running' });
    },
    isCurrent,
    rollback() {
      if (!isCurrent()) return null;
      const current = args.runs.get(args.runId)!;
      const retainedRun = {
        ...current,
        status: args.run.status,
        ...(preparedSelection ? { launch: {
          ...(current.launch ?? {}),
          ...(current.launch?.connectedServicesSelection === preparedSelection.connectedServicesBindings
            ? { connectedServicesSelection: args.run.launch?.connectedServicesSelection } : {}),
          ...(current.launch?.connectedServicesSelectionAgent === preparedSelection.agentContribution
            ? { connectedServicesSelectionAgent: args.run.launch?.connectedServicesSelectionAgent } : {}),
        } } : {}),
      };
      args.runs.set(args.runId, retainedRun);
      return retainedRun;
    },
    readRegistration: () => preparedRegistration,
  };
}

export async function resumeBackendControllerForResumableRun(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: ExecutionRunResumeMaterializationHooks & {
    runId?: string;
    controllerOccurrenceId: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }) => ExecutionRunHostRuntime;
  sendAcp: ExecutionRunTranscriptPublisher;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean; resumed?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
  requireReplayCapture?: boolean;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  readNativeOfferedModel?: ExecutionRunController['readNativeOfferedModel'];
  nativeModelRegistry?: ExecutionRunController['nativeModelRegistry'];
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
  attachRetainedRunSessionInput?: AttachRetainedRunSessionInput;
  registerRunOccurrence?: (params: Parameters<AttachRetainedRunSessionInput>[0]) => () => void;
}>): Promise<ExecutionRunEnsureResult> {
  if (args.run.retentionPolicy !== 'resumable') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not resumable', resumeFailureKind: 'permanent' };
  }

  const retiringController = args.controllers.get(args.runId);
  if (retiringController && args.runs.get(args.runId)?.status !== 'running') {
    // Terminal publication can precede transcript/marker custody. Join that exact
    // occurrence's settlement before admitting a replacement, without reopening it.
    await retiringController.terminalPromise;
  }
  if (args.controllers.has(args.runId)) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume already in progress', resumeFailureKind: 'indeterminate' };
  }

  if (args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(args.runId, args.run.intent, args.run.requesterWorkAttributionV1)) {
    return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded', resumeFailureKind: 'indeterminate' };
  }

  const providerSessionId =
    args.run.resumeHandle?.kind === 'provider_session.v1' && areExecutionRunBackendTargetsEqual(convertBackendTargetRefV2ToV1(args.run.resumeHandle.backendTarget), args.run.backendTarget)
      ? args.run.resumeHandle.providerSessionId
      : null;
  if (!providerSessionId) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle', resumeFailureKind: 'permanent' };
  }

  const controllerOccurrenceId = randomUUID();
  let retainedRun = args.run;
  const materialization = createExecutionRunResumeMaterialization({
    runId: args.runId, run: args.run, runs: args.runs,
    isCurrentOccurrence: () => isExecutionRunControllerCurrent({
      runId: args.runId, controller: resumeCtrl, controllers: args.controllers,
    }),
  });
  const resumeFailure = (error: unknown): ExecutionRunEnsureResult => {
    const missing = error instanceof Error && 'code' in error && error.code === 'AGENT_RESUME_PROVIDER_STATE_MISSING';
    const errorCode = missing ? 'execution_run_provider_state_missing' : 'execution_run_failed';
    const message = error instanceof Error ? error.message : 'Resume failed';
    // Only the exact retained occurrence may publish this definitive result.
    // Keep its provider identity for inspection; an unavailable handle never
    // authorizes substitution of a new provider thread.
    if (missing && args.runs.get(args.runId) === retainedRun && !args.controllers.has(args.runId)) {
      args.runs.set(args.runId, { ...retainedRun, error: { code: errorCode, message } });
      args.onPublicStateUpdated?.(args.runId);
    }
    return { ok: false, errorCode, error: message, resumeFailureKind: missing ? 'permanent' : 'indeterminate' };
  };
  let backend: ExecutionRunHostRuntime;
  try {
    backend = args.createRuntime({
      runId: args.runId,
      controllerOccurrenceId,
      backendId: args.run.backendId,
      backendTarget: args.run.backendTarget,
      permissionMode: args.run.permissionMode,
      ...(args.causalPermissionAuthority
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : {}),
      ...(args.actionRequestAttributionV1 ? { actionRequestAttributionV1: args.actionRequestAttributionV1 } : {}),
      accountSettings: args.run.runtimeSettings?.accountSettings ?? null,
      ...materialization.hooks,
    });
  } catch (error: unknown) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return resumeFailure(error);
  }
  const wantsReplayCapture = args.requireReplayCapture === true;
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const resumeCtrl: ExecutionRunBackendController = {
    kind: 'backend',
    ...(args.profileCatalog ? { profileCatalog: args.profileCatalog } : {}),
    readNativeOfferedModel: args.readNativeOfferedModel,
    nativeModelRegistry: args.nativeModelRegistry,
    controllerOccurrenceId,
    backend,
    backendSupportsResume: false,
    runtimeId: null,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: (() => {
      const profile = args.profileCatalog
        ? resolveExecutionRunIntentProfileFromCatalog(
            args.profileCatalog,
            args.run.intent,
            args.run.profileId,
            args.run.profileSourceCustody,
          )
        : resolveExecutionRunIntentProfile(args.run.intent);
      const shouldMaterializeInTranscript = args.run.sessionId !== null
        && profile.transcriptMaterialization !== 'none';
      return shouldMaterializeInTranscript && args.streamedTranscriptSession && args.run.ioMode === 'streaming'
        ? createStreamedTranscriptWriter({
            provider: args.parentProvider,
            session: args.streamedTranscriptSession,
          })
        : null;
    })(),
    cancelled: false,
    turnCount: typeof args.run.turnCount === 'number' && Number.isFinite(args.run.turnCount) && args.run.turnCount >= 0
      ? Math.floor(args.run.turnCount)
      : 0,
    turnEpoch: 0,
    turnInFlight: false,
    turnCancelReason: null,
    turnCancelEpoch: null,
    admittedLiveInterventions: [],
    admittedLiveInterventionsSignal: null,
    lastMarkerWriteAtMs: 0,
    failureSignal: failureSignal(),
    pendingHostBarrier: Promise.resolve(),
    terminalPromise,
    resolveTerminal,
  };
  args.controllers.set(args.runId, resumeCtrl);
  materialization.publishProvisioning();
  resumeCtrl.resumeMaterialization = materialization;
  const releaseOccurrence = args.registerRunOccurrence?.({
    runId: args.runId, sidechainId: args.run.sidechainId, controller: resumeCtrl,
  });
  if (releaseOccurrence) resumeCtrl.releaseSessionInputAttachment = async () => releaseOccurrence();
  const isCurrentResumeOccurrence = materialization.isCurrent;

  const rollbackProvisionalResume = (): void => {
    if (resumeCtrl.runtimeId !== null) return;
    retainedRun = materialization.rollback() ?? retainedRun;
  };

  const retireResumeOccurrence = async (): Promise<boolean> => {
    const owned = isExecutionRunControllerCurrent({
      runId: args.runId,
      controller: resumeCtrl,
      controllers: args.controllers,
    });
    if (owned) {
      // Release while the exact controller claim is still current. Settling first
      // would open a window where a successor can acquire the same run token and
      // then have that successor token released by this stale occurrence.
      resumeCtrl.cancelled = true;
      args.budgetRegistry?.releaseExecutionRun(args.runId);
    }
    await settleExecutionRunController({
      runId: args.runId,
      controller: resumeCtrl,
      controllers: args.controllers,
    });
    return owned;
  };

  try {
    const canResume = await backend.readResumeSupport({ captureReplay: wantsReplayCapture });
    if (!isCurrentResumeOccurrence()) {
      await retireResumeOccurrence();
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
    }
    if (!canResume) {
      rollbackProvisionalResume();
      await retireResumeOccurrence();
      return {
        ok: false,
        errorCode: 'execution_run_not_allowed',
        error: wantsReplayCapture ? 'Backend does not support resumable long-lived runs' : 'Backend does not support resume',
        resumeFailureKind: 'permanent',
      };
    }
    resumeCtrl.backendSupportsResume = true;

    const profile = args.profileCatalog
      ? resolveExecutionRunIntentProfileFromCatalog(
          args.profileCatalog,
          args.run.intent,
          args.run.profileId,
          args.run.profileSourceCustody,
        )
      : resolveExecutionRunIntentProfile(args.run.intent);
    const shouldMaterializeInTranscript = args.run.sessionId !== null
      && profile.transcriptMaterialization !== 'none';
    const sendAcp: ExecutionRunTranscriptPublisher = shouldMaterializeInTranscript
      ? args.sendAcp
      : async () => {};
    const computeSidechainStreamText = createExecutionRunSidechainStreamText(profile);

    const loaded = await backend.provisionRuntime({
      resumeRuntimeId: providerSessionId,
      ...(wantsReplayCapture ? { captureReplay: true } : {}),
    });
    if (!isCurrentResumeOccurrence()) {
      await backend.cancel(loaded.runtimeId).catch(() => {});
      await retireResumeOccurrence();
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
    }
    resumeCtrl.runtimeId = loaded.runtimeId;
    const onMessage = createExecutionRunControllerMessageHandler({
      ctrl: resumeCtrl,
      runId: args.runId,
      sidechainId: args.run.sidechainId,
      ioMode: args.run.ioMode,
      computeSidechainStreamText,
      sendAcp,
      parentProvider: args.parentProvider,
      runs: args.runs,
      backendSupportsResume: true,
      writeActivityMarker: args.writeActivityMarker,
      getNowMs: args.getNowMs,
      getPermissionRequestStore: args.getPermissionRequestStore,
      onPublicStateUpdated: args.onPublicStateUpdated,
      onModelOutput: args.onModelOutput,
    });
    backend.subscribeMessages(onMessage);
    if (resumeCtrl.backend.interaction && args.run.sessionId && args.attachRetainedRunSessionInput) {
      const attachment = args.attachRetainedRunSessionInput({
        runId: args.runId,
        sidechainId: args.run.sidechainId,
        controller: resumeCtrl,
      });
      const releaseOccurrence = resumeCtrl.releaseSessionInputAttachment;
      resumeCtrl.releaseSessionInputAttachment = async () => {
        await releaseOccurrence?.();
        await attachment?.release();
      };
    }
    const current = args.runs.get(args.runId)!;
    const preparedRegistration = materialization.readRegistration();
    args.runs.set(args.runId, {
      ...current,
      status: 'running',
      finishedAtMs: undefined,
      error: undefined,
      resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(args.run.backendTarget), providerSessionId },
      ...(preparedRegistration ? { launch: {
        ...(current.launch ?? {}), connectedServicesRegistration: preparedRegistration,
      } } : {}),
    });
    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true, resumed: true });
    if (!isCurrentResumeOccurrence()) {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was superseded', resumeFailureKind: 'indeterminate' };
    }
    args.onPublicStateUpdated?.(args.runId);
    return { ok: true };
  } catch (error: unknown) {
    rollbackProvisionalResume();
    await retireResumeOccurrence();
    return resumeFailure(error);
  } finally {
    delete resumeCtrl.resumeMaterialization;
  }
}
