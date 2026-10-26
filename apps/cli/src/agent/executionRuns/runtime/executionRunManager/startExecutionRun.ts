import { randomUUID } from 'node:crypto';
import { buildExecutionRunConnectedServicesLaunchV1 } from '@/daemon/connectedServices/runsBridge/contract';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import {
  projectExecutionRunRequestedConfiguration,
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import type {
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from '@/agent/executionRuns/runtime/executionRunTypes';
import type {
  ExecutionRunBackendController,
  ExecutionRunController,
  ExecutionRunVoiceAgentController,
} from '@/agent/executionRuns/controllers/types';
import { VoiceAgentError, type VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import { createBackendControllerMessageHandler } from '@/agent/executionRuns/runtime/createBackendControllerMessageHandler';
import {
  areExecutionRunBackendTargetsEqual,
  resolveExecutionRunBuiltInAgentId,
  resolveExecutionRunRuntimeBackendId,
} from '@/agent/executionRuns/runtime/backendTargets';
import { disposeExecutionRunBackendController, settleExecutionRunControllerOccurrence } from '@/agent/executionRuns/runtime/settleExecutionRunControllerOccurrence';

type SendAcp = AcpSendFn;

type FinishRunNext = Omit<
  ExecutionRunState,
  | 'runId'
  | 'callId'
  | 'sidechainId'
  | 'sessionId'
  | 'depth'
  | 'intent'
  | 'backendTarget'
  | 'backendId'
  | 'instructions'
  | 'permissionMode'
  | 'retentionPolicy'
  | 'runClass'
  | 'ioMode'
  | 'startedAtMs'
  | 'resumeHandle'
> & {
  status: ExecutionRunState['status'];
  finishedAtMs: number;
};

type FinishRun = (
  runId: string,
  next: FinishRunNext,
  toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
  structuredMeta?: ExecutionRunStructuredMeta,
) => void | Promise<void>;

function normalizeVoiceAgentModelId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === 'default' ? '' : trimmed;
}

/**
 * Backend session provisioning owns process spawn plus the complete provider handshake. The
 * backend adapters already surface process exit and their own phase-specific readiness failures;
 * this is only the final aggregate backstop for an adapter that never settles at all. Keep it well
 * above observed loaded starts so it does not terminate valid admission work.
 */
const BACKEND_PROVISION_TIMEOUT_ENV_KEY = 'HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS';
const DEFAULT_BACKEND_PROVISION_TIMEOUT_MS = 30 * 60_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

function readBackendProvisionTimeoutMs(): number {
  const raw = process.env[BACKEND_PROVISION_TIMEOUT_ENV_KEY];
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_BACKEND_PROVISION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BACKEND_PROVISION_TIMEOUT_MS;
  return Math.min(parsed, MAX_NODE_TIMER_DELAY_MS);
}

export class ExecutionRunBackendProvisionTimeoutError extends Error {
  readonly code = 'execution_run_backend_provision_timeout' as const;

  constructor(params: Readonly<{ backendId: string; timeoutMs: number }>) {
    super(`Execution run backend session provisioning timed out after ${params.timeoutMs}ms (${params.backendId})`);
    this.name = 'ExecutionRunBackendProvisionTimeoutError';
  }
}

async function awaitBackendProvisionBounded<T>(
  provision: Promise<T>,
  backendId: string,
  onLateProvision: (value: T) => void | Promise<void>,
): Promise<T> {
  const timeoutMs = readBackendProvisionTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  let observationOpen = true;
  const observedProvision = provision.then(
    async (value) => {
      if (observationOpen) return value;
      await onLateProvision(value);
      return value;
    },
    async (error: unknown) => {
      if (observationOpen) throw error;
      return await new Promise<T>(() => {});
    },
  );
  const backstop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      observationOpen = false;
      reject(new ExecutionRunBackendProvisionTimeoutError({ backendId, timeoutMs }));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([observedProvision, backstop]);
  } finally {
    observationOpen = false;
    clearTimeout(timer);
  }
}

type ExecuteBoundedRun = (args: {
  runId: string;
  callId: string;
  sidechainId: string;
  startedAtMs: number;
  params: ExecutionRunManagerStartParams;
}) => Promise<void>;

export async function startExecutionRun(args: Readonly<{
  params: ExecutionRunManagerStartParams;
  parentProvider: ACPProvider;
  sendAcp: SendAcp;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
    createBackend: (opts: {
      runId?: string;
      backendId: string;
      backendTarget?: BackendTargetRefV1;
      permissionMode: string;
      modelId?: string;
      sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
      accountSettings?: Readonly<Record<string, unknown>> | null;
      start?: ExecutionRunBackendStartContext;
      connectedServicesEnv?: Readonly<Record<string, string>> | null;
      connectedServicesCleanup?: (() => Promise<void>) | null;
    }) => AgentBackend;
  getNowMs: () => number;
  budgetRegistry: ExecutionBudgetRegistry | null;
  admitRuntimeActivity: (runId: string) => Promise<void>;
  rollbackRuntimeActivityAfterFailedAdmission: (reason: string) => Promise<void>;
  waitForRuntimeActivityTerminal: (runId: string) => Promise<void>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  isSessionClosing?: () => boolean;
  enqueueMarkerWrite: (runId: string, write: () => Promise<void>) => Promise<void>;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  finishRun: FinishRun;
  executeBoundedRun: ExecuteBoundedRun;
  send: (
    runId: string,
    params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>,
  ) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  voiceAgentManager: VoiceAgentManager;
  getDepthByCallId: (callId: string) => number | null;
  onPublicStateUpdated?: (runId: string) => void;
}>): Promise<ExecutionRunStartResult> {
  const startRequestId = typeof args.params.startRequestId === 'string' ? args.params.startRequestId.trim() : '';
  const profile = resolveExecutionRunIntentProfile(args.params.intent);
  const shouldMaterializeInTranscript = profile.transcriptMaterialization !== 'none';
  const sendAcp = shouldMaterializeInTranscript ? args.sendAcp : (() => {});

  const runId = `run_${randomUUID()}`;
  const callId = `subagent_run_${randomUUID()}`;
  const sidechainId = callId;
  const requestedConfiguration = projectExecutionRunRequestedConfiguration({
    modelId: args.params.modelId,
    sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides,
  });
  const startResult: ExecutionRunStartResult = {
    runId,
    callId,
    sidechainId,
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
  };

  const depth = (() => {
    const parentRunId = typeof args.params.parentRunId === 'string' ? args.params.parentRunId.trim() : '';
    if (parentRunId) {
      const parent = args.runs.get(parentRunId);
      return parent ? parent.depth + 1 : 0;
    }
    const parentCallId = typeof args.params.parentCallId === 'string' ? args.params.parentCallId.trim() : '';
    if (parentCallId) {
      const parentDepth = args.getDepthByCallId(parentCallId);
      return typeof parentDepth === 'number' ? parentDepth + 1 : 0;
    }
    return 0;
  })();

  if (args.budgetRegistry && !args.budgetRegistry.tryAcquireExecutionRun(runId, args.params.intent)) {
    const err: any = new Error('Execution run budget exceeded');
    err.code = 'execution_run_budget_exceeded';
    throw err;
  }

  const startedAtMs = args.getNowMs();
  const backendId = resolveExecutionRunRuntimeBackendId(args.params.backendTarget);
  // Immutable launch record: capture the re-resolvable launch intent so every resume recreates the
  // backend with the SAME model, config overrides, and connected-service account (fail-closed) rather
  // than ambient auth + default model. Safe inputs only — no credentials/env values/closures.
  const launch = {
    ...(args.params.launchOrigin ? { launchOrigin: args.params.launchOrigin } : {}),
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
    ...(args.params.modelId ? { modelId: args.params.modelId } : {}),
    ...(args.params.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
      : {}),
    ...(args.params.connectedServicesSelection
      ? { connectedServicesSelection: args.params.connectedServicesSelection }
      : {}),
    ...(args.params.connectedServicesRegistration
      ? { connectedServicesRegistration: args.params.connectedServicesRegistration }
      : {}),
  } as const;
  args.runs.set(runId, {
    runId,
    callId,
    sidechainId,
    sessionId: args.params.sessionId,
    ...(startRequestId ? { startRequestId } : {}),
    ...(args.params.startRequestFingerprint ? { startRequestFingerprint: args.params.startRequestFingerprint } : {}),
    depth,
    intent: args.params.intent,
    backendTarget: args.params.backendTarget,
    backendId,
    instructions: args.params.instructions ?? '',
    ...(typeof args.params.intentInput !== 'undefined' ? { intentInput: args.params.intentInput } : {}),
    ...(args.params.display ? { display: args.params.display } : {}),
    permissionMode: args.params.permissionMode,
    retentionPolicy: args.params.retentionPolicy,
    runClass: args.params.runClass,
    ioMode: args.params.ioMode,
    notifyParentOnCompletion: args.params.notifyParentOnCompletion
      ?? (args.params.accountSettings?.executionRunsNotifyParentOnCompletionDefault === true),
    ...(Object.keys(launch).length > 0 ? { launch } : {}),
    status: 'running',
    startedAtMs,
    resumeHandle: null,
  });

  try {
    // The canonical map is the complete contribution owner. Insert the provisional run first, but
    // expose no marker, transcript, controller, backend, or public callback until its report lands.
    await args.admitRuntimeActivity(runId);
  } catch (error) {
    args.runs.delete(runId);
    args.budgetRegistry?.releaseExecutionRun(runId);
    await args.rollbackRuntimeActivityAfterFailedAdmission('execution-run-start-admission-rolled-back');
    throw error;
  }
  args.onPublicStateUpdated?.(runId);

  // Persist a daemon-visible marker so machine-wide UIs can see the run immediately.
  const startMarkerPayload = {
    pid: process.pid,
    happySessionId: args.params.sessionId,
    runId,
    callId,
    sidechainId,
    ...(startRequestId ? { startRequestId } : {}),
    ...(args.params.startRequestFingerprint ? { startRequestFingerprint: args.params.startRequestFingerprint } : {}),
    intent: args.params.intent,
    backendTarget: args.params.backendTarget,
    ...(args.params.display ? { display: args.params.display } : {}),
    ...(args.params.launchOrigin ? { launchOrigin: args.params.launchOrigin } : {}),
    permissionMode: args.params.permissionMode,
    runClass: args.params.runClass,
    ioMode: args.params.ioMode,
    retentionPolicy: args.params.retentionPolicy,
    status: 'running',
    ...(args.params.notifyParentOnCompletion
      ?? (args.params.accountSettings?.executionRunsNotifyParentOnCompletionDefault === true)
      ? { notifyParentOnCompletion: true }
      : {}),
    startedAtMs,
    updatedAtMs: startedAtMs,
    resumeHandle: null,
    ...(args.params.connectedServicesRegistration ? {
      executionRunConnectedServicesLaunchV1: buildExecutionRunConnectedServicesLaunchV1(
        args.params.connectedServicesRegistration,
      ),
    } : {}),
  } as const;
  await args.enqueueMarkerWrite(runId, () => writeExecutionRunMarker(startMarkerPayload)).catch(() => {});

  // Materialize the run in transcript (tool-call).
  if (shouldMaterializeInTranscript) {
    sendAcp(args.parentProvider, {
      type: 'tool-call',
      callId,
      name: 'SubAgentRun',
      input: {
        runId,
        intent: args.params.intent,
        backendTarget: args.params.backendTarget,
        instructions: args.params.instructions ?? '',
        ...(typeof args.params.intentInput !== 'undefined' ? { intentInput: args.params.intentInput } : {}),
        ...(args.params.display ? { display: args.params.display } : {}),
        ...(args.params.launchOrigin ? { launchOrigin: args.params.launchOrigin } : {}),
        ...(requestedConfiguration ? { requestedConfiguration } : {}),
        permissionMode: args.params.permissionMode,
        retentionPolicy: args.params.retentionPolicy,
        runClass: args.params.runClass,
        ioMode: args.params.ioMode,
      },
      id: randomUUID(),
    });
  }

  let controllerOccurrence: ExecutionRunController | null = null;
  try {
    if (args.params.intent === 'voice_agent' && args.params.ioMode === 'streaming') {
      let resolveTerminal!: () => void;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });

      const epochRaw = Number(args.params.transcript?.epoch ?? 0);
      const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
      const persistenceMode = args.params.transcript?.persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';

      const permissionPolicy = args.params.permissionMode === 'no_tools' ? 'no_tools' : 'read_only';
      const profileId =
        typeof args.params.profileId === 'string' && args.params.profileId.trim().length > 0
          ? args.params.profileId.trim()
          : null;
      const initialContext = [String(args.params.initialContext ?? '').trim(), String(args.params.instructions ?? '').trim()]
        .filter((t) => t.length > 0)
        .join('\n\n');

      const chatModelId = normalizeVoiceAgentModelId(args.params.chatModelId);
      const commitModelId = normalizeVoiceAgentModelId(args.params.commitModelId);
      const commitIsolation = args.params.commitIsolation === true;
      const idleTtlSeconds = typeof args.params.idleTtlSeconds === 'number' ? args.params.idleTtlSeconds : 600;
      const initialContextMode = args.params.initialContextMode === 'first_turn' ? 'first_turn' : 'bootstrap';
      const verbosity = args.params.verbosity === 'balanced' ? 'balanced' : 'short';
      const bootstrapMode = args.params.bootstrapMode === 'ready_handshake' ? 'ready_handshake' : 'none';
      const bootstrapTimeoutMs =
        typeof args.params.bootstrapTimeoutMs === 'number' && Number.isFinite(args.params.bootstrapTimeoutMs) && args.params.bootstrapTimeoutMs > 0
          ? Math.floor(args.params.bootstrapTimeoutMs)
          : undefined;
      const disabledActionIds = Array.isArray(args.params.disabledActionIds)
        ? args.params.disabledActionIds.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];

      const builtInAgentId = resolveExecutionRunBuiltInAgentId(args.params.backendTarget);
      if (!builtInAgentId) {
        throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', 'Voice agent runs require a built-in backend');
      }

      const startedVoice = await args.voiceAgentManager.start({
        agentId: builtInAgentId as any,
        ...(profileId ? { profileId } : {}),
        contextSessionId: args.params.sessionId,
        chatModelId,
        commitModelId,
        commitIsolation,
        permissionPolicy,
        idleTtlSeconds,
        initialContext,
        initialContextMode,
        verbosity,
        bootstrapMode,
        ...(typeof bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs } : {}),
        disabledActionIds,
        // R3-2: consume the daemon-materialized CS env (else voice runs execute native = fail-closed
        // violation) and own the run-scoped release exactly once at voice-agent dispose (else the
        // materialized run root leaks).
        ...(args.params.connectedServicesEnv ? { connectedServicesEnv: args.params.connectedServicesEnv } : {}),
        ...(args.params.connectedServicesCleanup ? { connectedServicesCleanup: args.params.connectedServicesCleanup } : {}),
      });

      const resumeHandle = args.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId);
      const existing = args.runs.get(runId);
      if (existing) {
        args.runs.set(runId, {
          ...existing,
          resumeHandle: resumeHandle ?? existing.resumeHandle ?? null,
          voiceAgentConfig: {
            ...(profileId ? { profileId } : {}),
            chatModelId,
            commitModelId,
            commitIsolation,
            permissionPolicy,
            idleTtlSeconds,
            initialContext,
            initialContextMode,
            verbosity,
            ...(typeof bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs } : {}),
            disabledActionIds,
            transcript: { persistenceMode, epoch },
          },
        });
        args.onPublicStateUpdated?.(runId);
      }

      const ctrl: ExecutionRunVoiceAgentController = {
        kind: 'voice_agent',
        voiceAgentId: startedVoice.voiceAgentId,
        cancelled: false,
        lastMarkerWriteAtMs: 0,
        terminalPromise,
        resolveTerminal,
        transcript: { persistenceMode, epoch },
        externalStreamIdByInternal: new Map(),
        internalStreamIdByExternal: new Map(),
        persistedDoneByExternalStreamId: new Set(),
      };
      args.controllers.set(runId, ctrl);
      controllerOccurrence = ctrl;
      args.onPublicStateUpdated?.(runId);
      await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
      return startResult;
    }

    const backend = args.createBackend({
      runId,
      backendId,
      backendTarget: args.params.backendTarget,
      permissionMode: args.params.permissionMode,
      ...(args.params.modelId ? { modelId: args.params.modelId } : {}),
      ...(args.params.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
        : {}),
      accountSettings: args.params.accountSettings ?? null,
      start: args.params,
      ...(args.params.connectedServicesEnv ? { connectedServicesEnv: args.params.connectedServicesEnv } : {}),
      ...(args.params.connectedServicesCleanup ? { connectedServicesCleanup: args.params.connectedServicesCleanup } : {}),
    });
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const backendSupportsResume = Boolean(backend.loadSessionWithReplayCapture || backend.loadSession);
    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend,
      backendSupportsResume,
      childSessionId: null,
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
      streamWriter:
        shouldMaterializeInTranscript && args.streamedTranscriptSession && args.params.ioMode === 'streaming'
          ? createStreamedTranscriptWriter({
              provider: args.parentProvider,
              session: args.streamedTranscriptSession,
            })
          : null,
      cancelled: false,
      turnCount: 0,
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
    args.controllers.set(runId, ctrl);
    controllerOccurrence = ctrl;

    const onMessage: AgentMessageHandler = createBackendControllerMessageHandler({
      ctrl,
      runId,
      sidechainId,
      intent: args.params.intent,
      ioMode: args.params.ioMode,
      sendAcp,
      parentProvider: args.parentProvider,
      runs: args.runs,
      backendSupportsResume,
      writeActivityMarker: args.writeActivityMarker,
      getNowMs: args.getNowMs,
      isCurrentController: () => args.controllers.get(runId) === ctrl,
      onPublicStateUpdated: args.onPublicStateUpdated,
    });

    backend.onMessage(onMessage);

    const settleProvisionedSessionAfterCancellation = async (childSessionId: SessionId): Promise<void> => {
      try {
        // Stop can dispose before provisioning returns its native session. Cancel that
        // late session while the parent is open; shutdown and timeout keep teardown final.
        if (!ctrl.disposalPromise || (ctrl.cancelled && !args.isSessionClosing?.())) {
          await backend.cancel(childSessionId);
        }
      } catch {
        // Best effort: dispose below remains the authoritative backend teardown.
      }
      try {
        await disposeExecutionRunBackendController(ctrl);
      } catch {
        // Best effort
      }
      settleExecutionRunControllerOccurrence(args.controllers, runId, ctrl);
    };

    const provisionBackendController = async (): Promise<SessionId | null> => {
      const childSessionId = await awaitBackendProvisionBounded((async () => {
        const handle = args.params.retentionPolicy === 'resumable' ? (args.params.resumeHandle ?? null) : null;
        const wantsResume =
          handle?.kind === 'vendor_session.v1' && areExecutionRunBackendTargetsEqual(handle.backendTarget, args.params.backendTarget)
            ? handle.vendorSessionId
            : null;
        if (wantsResume) {
          if (!backend.loadSessionWithReplayCapture && !backend.loadSession) {
            const error: Error & { code?: string } = new Error('Backend does not support resume');
            error.code = 'execution_run_not_allowed';
            throw error;
          }
          const loaded = backend.loadSessionWithReplayCapture
            ? await backend.loadSessionWithReplayCapture(wantsResume as any)
            : await backend.loadSession!(wantsResume as any);
          return loaded.sessionId;
        }
        const started = await backend.startSession();
        return started.sessionId;
      })(), backendId, settleProvisionedSessionAfterCancellation);
      if (ctrl.cancelled || args.controllers.get(runId) !== ctrl) {
        await settleProvisionedSessionAfterCancellation(childSessionId);
        return null;
      }
      ctrl.childSessionId = childSessionId;

      const existing = args.runs.get(runId);
      if (existing && args.params.retentionPolicy === 'resumable' && backendSupportsResume) {
        args.runs.set(runId, {
          ...existing,
          resumeHandle: { kind: 'vendor_session.v1', backendTarget: args.params.backendTarget, vendorSessionId: childSessionId },
        });
        await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
        args.onPublicStateUpdated?.(runId);
      }
      return childSessionId;
    };

    const failBackendProvisioning = async (error: unknown): Promise<void> => {
      const message = error instanceof Error ? error.message : 'Execution failed';
      const finishedAtMs = args.getNowMs();
      const code = error instanceof VoiceAgentError
        ? error.code
        : error instanceof ExecutionRunBackendProvisionTimeoutError
          ? error.code
          : 'execution_run_failed';
      try {
        await args.finishRun(
          runId,
          { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
          {
            output: {
              status: 'failed',
              summary: message,
              runId,
              callId,
              sidechainId,
              backendId,
              intent: args.params.intent,
              startedAtMs,
              finishedAtMs,
              error: { code, message },
            },
            isError: true,
          },
        );
      } catch {
        // Best effort
      }
      try {
        await disposeExecutionRunBackendController(ctrl);
      } catch {
        // Best effort
      }
      settleExecutionRunControllerOccurrence(args.controllers, runId, ctrl);
    };

    if (args.params.runClass === 'bounded') {
      // Provision the backend session and run kickoff asynchronously so the caller can dismiss
      // the UI draft card immediately after the SubAgentRun tool-call is injected.
      void (async () => {
        try {
          // QA2-F04: a never-settling backend start must fail the admitted run rather than leave it
          // running forever with no provider process.
          const childSessionId = await provisionBackendController();
          if (!childSessionId) return;

          void args.executeBoundedRun({ runId, callId, sidechainId, startedAtMs, params: args.params });
        } catch (error: unknown) {
          await failBackendProvisioning(error);
        }
      })();

      return startResult;
    }

    // The admitted run and its daemon marker already own the durable identity. Provision the
    // provider occurrence behind that handle so slow vendor startup cannot make execution.run.start
    // ambiguous. The controller's promise is also the canonical ordering point for sends that
    // arrive before the child session exists; stop continues to act on this same controller.
    const provisioningPromise = (async (): Promise<void> => {
      try {
        const childSessionId = await provisionBackendController();
        if (!childSessionId) return;

        if (typeof args.params.instructions === 'string' && args.params.instructions.trim().length > 0) {
          const start = {
            sessionId: args.params.sessionId,
            runId,
            callId,
            sidechainId,
            intent: args.params.intent,
            backendId,
            backendTarget: args.params.backendTarget,
            instructions: args.params.instructions ?? '',
            permissionMode: args.params.permissionMode,
            retentionPolicy: args.params.retentionPolicy,
            runClass: args.params.runClass,
            ioMode: args.params.ioMode,
            startedAtMs,
          } as const;
          const profile = resolveExecutionRunIntentProfile(args.params.intent);
          await args.send(runId, { message: profile.buildPrompt(start) });
        }
        if (args.controllers.get(runId) === ctrl) args.onPublicStateUpdated?.(runId);
      } catch (error: unknown) {
        await failBackendProvisioning(error);
      }
    })();
    ctrl.provisioningPromise = provisioningPromise;
    void provisioningPromise;
    return startResult;
  } catch (e: any) {
    const message = e instanceof Error ? e.message : 'Execution failed';
    const finishedAtMs = args.getNowMs();
    const code = e instanceof VoiceAgentError
      ? e.code
      : e instanceof ExecutionRunBackendProvisionTimeoutError
        ? e.code
        : 'execution_run_failed';
    try {
      await args.finishRun(
        runId,
        { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
        {
          output: {
            status: 'failed',
            summary: message,
            runId,
            callId,
            sidechainId,
            backendId,
            intent: args.params.intent,
            startedAtMs,
            finishedAtMs,
            error: { code, message },
          },
          isError: true,
        },
      );
    } catch {
      // best effort
    }
    if (controllerOccurrence) {
      try {
        if (controllerOccurrence.kind === 'backend') await disposeExecutionRunBackendController(controllerOccurrence);
      } catch {
        // best effort
      }
      settleExecutionRunControllerOccurrence(args.controllers, runId, controllerOccurrence);
    }
    await args.waitForRuntimeActivityTerminal(runId);
    throw e;
  }
}
