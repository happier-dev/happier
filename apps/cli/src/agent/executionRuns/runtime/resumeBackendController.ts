import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

import { ExecutionRunConnectedServicesUnavailableError } from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunBackendController, ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { areExecutionRunBackendTargetsEqual } from '@/agent/executionRuns/runtime/backendTargets';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import { createBackendControllerMessageHandler } from '@/agent/executionRuns/runtime/createBackendControllerMessageHandler';
import { disposeExecutionRunBackendController } from './settleExecutionRunControllerOccurrence';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';

export type ResumedExecutionRunBackend = Readonly<{
  backend: AgentBackend;
  connectedServicesRegistration?: NonNullable<ExecutionRunState['launch']>['connectedServicesRegistration'];
}>;

export async function resumeBackendControllerForResumableRun(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  /**
   * Async backend factory owned by the caller. It performs launch rehydration (re-resolve account
   * settings, re-materialize connected services from the persisted selection) and constructs the
   * backend with the run's runId isolation. It may throw — a fail-closed connected-services error is
   * mapped to a typed resume failure below.
   */
  createBackend: () => Promise<ResumedExecutionRunBackend>;
  isSessionClosing?: () => boolean;
  sendAcp: AcpSendFn;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean; resumed?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  admitRuntimeActivity: (runId: string) => Promise<void>;
  rollbackRuntimeActivityAfterFailedAdmission: (reason: string) => Promise<void>;
  terminalRuntimeActivityAfterFailedAdmission: (runId: string, reason: string) => Promise<void>;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
  requireReplayCapture?: boolean;
}>): Promise<
  | { ok: true }
  | { ok: false; errorCode: string; error: string }
> {
  if (args.isSessionClosing?.()) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Session is closing' };
  }
  if (args.run.retentionPolicy !== 'resumable') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not resumable' };
  }

  if (args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(args.runId, args.run.intent)) {
    return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded' };
  }

  const vendorSessionId =
    args.run.resumeHandle?.kind === 'vendor_session.v1' && areExecutionRunBackendTargetsEqual(args.run.resumeHandle.backendTarget, args.run.backendTarget)
      ? args.run.resumeHandle.vendorSessionId
      : null;
  if (!vendorSessionId) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle' };
  }

  const previousRun = args.runs.get(args.runId) ?? args.run;
  args.runs.set(args.runId, {
    ...args.run,
    status: 'running',
    finishedAtMs: undefined,
    error: undefined,
  });
  try {
    await args.admitRuntimeActivity(args.runId);
  } catch (error) {
    args.runs.set(args.runId, previousRun);
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    await args.rollbackRuntimeActivityAfterFailedAdmission('execution-run-resume-admission-rolled-back');
    return {
      ok: false,
      errorCode: 'execution_run_runtime_activity_unavailable',
      error: error instanceof Error ? error.message : 'Runtime activity admission failed',
    };
  }

  const failAfterAdmission = async (result: Readonly<{
    errorCode: string;
    error: string;
  }>): Promise<{ ok: false; errorCode: string; error: string }> => {
    args.runs.set(args.runId, previousRun);
    try {
      await args.terminalRuntimeActivityAfterFailedAdmission(args.runId, 'execution_run_resume_failed');
      return { ok: false, ...result };
    } catch (error) {
      return {
        ok: false,
        errorCode: 'execution_run_runtime_activity_unavailable',
        error: error instanceof Error ? error.message : 'Runtime activity terminal publication failed',
      };
    }
  };

  let backend: AgentBackend;
  let prepared: ResumedExecutionRunBackend;
  try {
    prepared = await args.createBackend();
    backend = prepared.backend;
  } catch (e: unknown) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    // Fail closed: a resumable run bound to a connected account must not recreate on ambient auth.
    if (e instanceof ExecutionRunConnectedServicesUnavailableError) {
      return await failAfterAdmission({ errorCode: e.code, error: e.message });
    }
    return await failAfterAdmission({
      errorCode: 'execution_run_failed',
      error: e instanceof Error ? e.message : 'Resume failed',
    });
  }
  const wantsReplayCapture = args.requireReplayCapture === true;
  const canResume = wantsReplayCapture
    ? Boolean(backend.loadSessionWithReplayCapture)
    : Boolean(backend.loadSessionWithReplayCapture || backend.loadSession);
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const resumeCtrl: ExecutionRunBackendController = {
    kind: 'backend',
    backend,
    backendSupportsResume: canResume,
    childSessionId: null,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: (() => {
      const profile = resolveExecutionRunIntentProfile(args.run.intent);
      const shouldMaterializeInTranscript = profile.transcriptMaterialization !== 'none';
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
    terminalPromise,
    resolveTerminal,
  };

  if (args.isSessionClosing?.() || !canResume) {
    await disposeExecutionRunBackendController(resumeCtrl).catch(() => {});
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return await failAfterAdmission({
      errorCode: 'execution_run_not_allowed',
      error: args.isSessionClosing?.()
        ? 'Session is closing'
        : wantsReplayCapture ? 'Backend does not support resumable long-lived runs' : 'Backend does not support resume',
    });
  }

  // The existing map owns an acquired backend before native load can wait for an ACK.
  args.controllers.set(args.runId, resumeCtrl);
  const isCurrentController = () => args.controllers.get(args.runId) === resumeCtrl
    && !resumeCtrl.cancelled && !resumeCtrl.disposalPromise && !args.isSessionClosing?.();

  const profile = resolveExecutionRunIntentProfile(args.run.intent);
  const shouldMaterializeInTranscript = profile.transcriptMaterialization !== 'none';
  const sendAcp = shouldMaterializeInTranscript ? args.sendAcp : (() => {});

  const onMessage = createBackendControllerMessageHandler({
    ctrl: resumeCtrl,
    runId: args.runId,
    sidechainId: args.run.sidechainId,
    intent: args.run.intent,
    ioMode: args.run.ioMode,
    sendAcp,
    parentProvider: args.parentProvider,
    runs: args.runs,
    backendSupportsResume: true,
    writeActivityMarker: args.writeActivityMarker,
    getNowMs: args.getNowMs,
    isCurrentController,
    onPublicStateUpdated: args.onPublicStateUpdated,
    onModelOutput: args.onModelOutput,
  });
  try {
    backend.onMessage(onMessage);
    const loaded = backend.loadSessionWithReplayCapture
      ? await backend.loadSessionWithReplayCapture(vendorSessionId)
      : await backend.loadSession!(vendorSessionId);
    if (!isCurrentController()) {
      await disposeExecutionRunBackendController(resumeCtrl).catch(() => {});
      args.budgetRegistry?.releaseExecutionRun(args.runId);
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was retired' };
    }
    resumeCtrl.childSessionId = loaded.sessionId;
    args.runs.set(args.runId, {
      ...args.run,
      ...(prepared.connectedServicesRegistration ? {
        launch: { ...args.run.launch, connectedServicesRegistration: prepared.connectedServicesRegistration },
      } : {}),
      status: 'running',
      finishedAtMs: undefined,
      error: undefined,
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: args.run.backendTarget, vendorSessionId: loaded.sessionId },
    });
    args.onPublicStateUpdated?.(args.runId);
    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true, resumed: true });
    return isCurrentController()
      ? { ok: true }
      : { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was retired' };
  } catch (e: unknown) {
    const retired = !isCurrentController();
    await disposeExecutionRunBackendController(resumeCtrl).catch(() => {});
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    // A queued Session stop still owns terminalization of this occurrence. Do not restore
    // its previous state or remove the controller it must settle after load unwinds.
    if (retired) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Resume was retired' };
    if (args.controllers.get(args.runId) === resumeCtrl) args.controllers.delete(args.runId);
    resumeCtrl.resolveTerminal();
    return await failAfterAdmission({
      errorCode: 'execution_run_failed',
      error: e instanceof Error ? e.message : 'Resume failed',
    });
  }
}
