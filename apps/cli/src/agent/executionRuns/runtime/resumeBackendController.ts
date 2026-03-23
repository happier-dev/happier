import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunBackendController, ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { areExecutionRunBackendTargetsEqual } from '@/agent/executionRuns/runtime/backendTargets';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createBackendControllerMessageHandler } from '@/agent/executionRuns/runtime/createBackendControllerMessageHandler';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';

export async function resumeBackendControllerForResumableRun(args: Readonly<{
  runId: string;
  run: ExecutionRunState;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  createBackend: (opts: { runId?: string; backendId: string; backendTarget?: BackendTargetRefV1; permissionMode: string }) => AgentBackend;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: ACPProvider;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
  requireReplayCapture?: boolean;
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

  const vendorSessionId =
    args.run.resumeHandle?.kind === 'vendor_session.v1' && areExecutionRunBackendTargetsEqual(args.run.resumeHandle.backendTarget, args.run.backendTarget)
      ? args.run.resumeHandle.vendorSessionId
      : null;
  if (!vendorSessionId) {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle' };
  }

  const backend = args.createBackend({
    runId: args.runId,
    backendId: args.run.backendId,
    backendTarget: args.run.backendTarget,
    permissionMode: args.run.permissionMode,
  });
  const wantsReplayCapture = args.requireReplayCapture === true;
  const canResume = wantsReplayCapture
    ? Boolean(backend.loadSessionWithReplayCapture)
    : Boolean(backend.loadSessionWithReplayCapture || backend.loadSession);
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
    onPublicStateUpdated: args.onPublicStateUpdated,
    onModelOutput: args.onModelOutput,
  });
  backend.onMessage(onMessage);

  try {
    const loaded = backend.loadSessionWithReplayCapture
      ? await backend.loadSessionWithReplayCapture(vendorSessionId)
      : await backend.loadSession!(vendorSessionId);
    resumeCtrl.childSessionId = loaded.sessionId;
    args.controllers.set(args.runId, resumeCtrl);
    args.runs.set(args.runId, {
      ...args.run,
      status: 'running',
      finishedAtMs: undefined,
      error: undefined,
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: args.run.backendTarget, vendorSessionId: loaded.sessionId },
    });
    args.onPublicStateUpdated?.(args.runId);
    return { ok: true };
  } catch (e: any) {
    await backend.dispose().catch(() => {});
    args.budgetRegistry?.releaseExecutionRun(args.runId);
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Resume failed' };
  }
}
