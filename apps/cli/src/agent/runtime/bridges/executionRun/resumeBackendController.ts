import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ExecutionRunState } from './executionRunTypes';
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

export async function resumeBackendControllerForResumableRun(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createRuntime: (opts: {
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
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

  const providerSessionId =
    args.run.resumeHandle?.kind === 'provider_session.v1' && areExecutionRunBackendTargetsEqual(convertBackendTargetRefV2ToV1(args.run.resumeHandle.backendTarget), args.run.backendTarget)
      ? args.run.resumeHandle.providerSessionId
      : null;
  if (!providerSessionId) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle' };
  }

  const backend = args.createRuntime({
    runId: args.runId,
    backendId: args.run.backendId,
    backendTarget: args.run.backendTarget,
    permissionMode: args.run.permissionMode,
    accountSettings: args.run.runtimeSettings?.accountSettings ?? null,
  });
  const wantsReplayCapture = args.requireReplayCapture === true;
  const canResume = await backend.readResumeSupport({ captureReplay: wantsReplayCapture });
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
    backendSupportsResume: true,
    childSessionId: null,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: (() => {
      const profile = args.profileCatalog
        ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, args.run.intent, args.run.profileId)
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
    pendingExternalMessages: [],
    pendingExternalMessagesSignal: null,
    lastMarkerWriteAtMs: 0,
    failureSignal: failureSignal(),
    pendingHostBarrier: Promise.resolve(),
    terminalPromise,
    resolveTerminal,
  };

  const profile = args.profileCatalog
    ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, args.run.intent, args.run.profileId)
    : resolveExecutionRunIntentProfile(args.run.intent);
  const shouldMaterializeInTranscript = args.run.sessionId !== null
    && profile.transcriptMaterialization !== 'none';
  const sendAcp: ExecutionRunTranscriptPublisher = shouldMaterializeInTranscript
    ? args.sendAcp
    : async () => {};
  const computeSidechainStreamText = createExecutionRunSidechainStreamText(profile);

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

  try {
    const loaded = await backend.provisionSession({
      resumeSessionId: providerSessionId,
      ...(wantsReplayCapture ? { captureReplay: true } : {}),
    });
    resumeCtrl.childSessionId = loaded.sessionId;
    args.controllers.set(args.runId, resumeCtrl);
    args.runs.set(args.runId, {
      ...args.run,
      status: 'running',
      finishedAtMs: undefined,
      error: undefined,
      resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(args.run.backendTarget), providerSessionId: loaded.sessionId },
    });
    args.onPublicStateUpdated?.(args.runId);
    return { ok: true };
  } catch (e: any) {
    await backend.dispose().catch(() => {});
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Resume failed' };
  }
}
