import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { randomUUID } from 'node:crypto';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1, SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';

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

export async function resumeBackendControllerForResumableRun(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: {
    runId?: string;
    controllerOccurrenceId: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }) => ExecutionRunHostRuntime;
  sendAcp: ExecutionRunTranscriptPublisher;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
  requireReplayCapture?: boolean;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  attachRetainedRunSessionInput?: AttachRetainedRunSessionInput;
}>): Promise<ExecutionRunEnsureResult> {
  if (args.run.retentionPolicy !== 'resumable') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not resumable', resumeFailureKind: 'permanent' };
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
  const resumeFailure = (error: unknown): ExecutionRunEnsureResult => {
    const missing = error instanceof Error && 'code' in error && error.code === 'AGENT_RESUME_PROVIDER_STATE_MISSING';
    const errorCode = missing ? 'execution_run_provider_state_missing' : 'execution_run_failed';
    const message = error instanceof Error ? error.message : 'Resume failed';
    // Only the exact retained occurrence may publish this definitive result.
    // Keep its provider identity for inspection; an unavailable handle never
    // authorizes substitution of a new provider thread.
    if (missing && args.runs.get(args.runId) === args.run && !args.controllers.has(args.runId)) {
      args.runs.set(args.runId, { ...args.run, error: { code: errorCode, message } });
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
      accountSettings: args.run.runtimeSettings?.accountSettings ?? null,
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

  const isCurrentResumeOccurrence = (): boolean => (
    args.runs.get(args.runId) === args.run
    && isExecutionRunControllerCurrent({
      runId: args.runId,
      controller: resumeCtrl,
      controllers: args.controllers,
    })
  );

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
      resumeCtrl.releaseSessionInputAttachment = attachment?.release;
    }
    args.runs.set(args.runId, {
      ...args.run,
      status: 'running',
      finishedAtMs: undefined,
      error: undefined,
      resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(args.run.backendTarget), providerSessionId },
    });
    args.onPublicStateUpdated?.(args.runId);
    return { ok: true };
  } catch (error: unknown) {
    await retireResumeOccurrence();
    return resumeFailure(error);
  }
}
