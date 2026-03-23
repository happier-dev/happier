import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
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

type SendAcp = (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;

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
) => void;

function normalizeVoiceAgentModelId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === 'default' ? '' : trimmed;
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
      accountSettings?: Readonly<Record<string, unknown>> | null;
      start?: ExecutionRunBackendStartContext;
    }) => AgentBackend;
  getNowMs: () => number;
  budgetRegistry: ExecutionBudgetRegistry | null;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
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
  const profile = resolveExecutionRunIntentProfile(args.params.intent);
  const shouldMaterializeInTranscript = profile.transcriptMaterialization !== 'none';
  const sendAcp = shouldMaterializeInTranscript ? args.sendAcp : (() => {});

  const runId = `run_${randomUUID()}`;
  const callId = `subagent_run_${randomUUID()}`;
  const sidechainId = callId;

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
  args.runs.set(runId, {
    runId,
    callId,
    sidechainId,
    sessionId: args.params.sessionId,
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
    status: 'running',
    startedAtMs,
    resumeHandle: null,
  });
  args.onPublicStateUpdated?.(runId);

  // Persist a daemon-visible marker so machine-wide UIs can see the run immediately.
  const startMarkerPayload = {
    pid: process.pid,
    happySessionId: args.params.sessionId,
    runId,
    callId,
    sidechainId,
    intent: args.params.intent,
    backendTarget: args.params.backendTarget,
    ...(args.params.display ? { display: args.params.display } : {}),
    permissionMode: args.params.permissionMode,
    runClass: args.params.runClass,
    ioMode: args.params.ioMode,
    retentionPolicy: args.params.retentionPolicy,
    status: 'running',
    startedAtMs,
    updatedAtMs: startedAtMs,
    resumeHandle: null,
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
        permissionMode: args.params.permissionMode,
        retentionPolicy: args.params.retentionPolicy,
        runClass: args.params.runClass,
        ioMode: args.params.ioMode,
      },
      id: randomUUID(),
    });
  }

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
      await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
      return { runId, callId, sidechainId };
    }

    const backend = args.createBackend({
      runId,
      backendId,
      backendTarget: args.params.backendTarget,
      permissionMode: args.params.permissionMode,
      accountSettings: args.params.accountSettings ?? null,
      start: args.params,
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
      onPublicStateUpdated: args.onPublicStateUpdated,
    });

    backend.onMessage(onMessage);

    if (args.params.runClass === 'bounded') {
      // Provision the backend session and run kickoff asynchronously so the caller can dismiss
      // the UI draft card immediately after the SubAgentRun tool-call is injected.
      void (async () => {
        try {
          const childSessionId = await (async () => {
            const handle = args.params.retentionPolicy === 'resumable' ? (args.params.resumeHandle ?? null) : null;
            const wantsResume =
              handle?.kind === 'vendor_session.v1' && areExecutionRunBackendTargetsEqual(handle.backendTarget, args.params.backendTarget)
                ? handle.vendorSessionId
                : null;
            if (wantsResume) {
              if (!backend.loadSessionWithReplayCapture && !backend.loadSession) {
                const err: any = new Error('Backend does not support resume');
                err.code = 'execution_run_not_allowed';
                throw err;
              }
              const loaded = backend.loadSessionWithReplayCapture
                ? await backend.loadSessionWithReplayCapture(wantsResume as any)
                : await backend.loadSession!(wantsResume as any);
              return loaded.sessionId;
            }
            const started = await backend.startSession();
            return started.sessionId;
          })();
          ctrl.childSessionId = childSessionId;

          const existing = args.runs.get(runId);
          if (existing && args.params.retentionPolicy === 'resumable' && backendSupportsResume) {
            args.runs.set(runId, {
              ...existing,
              resumeHandle: { kind: 'vendor_session.v1', backendTarget: args.params.backendTarget, vendorSessionId: childSessionId },
            });
            void args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
            args.onPublicStateUpdated?.(runId);
          }

          void args
            .executeBoundedRun({ runId, callId, sidechainId, startedAtMs, params: args.params })
            .finally(() => {
              // Ensure terminal promise resolves even if executeBoundedRun throws unexpectedly.
              const ctrl = args.controllers.get(runId);
              ctrl?.resolveTerminal();
              args.controllers.delete(runId);
            });
        } catch (e: any) {
          const message = e instanceof Error ? e.message : 'Execution failed';
          const finishedAtMs = args.getNowMs();
          const code = e instanceof VoiceAgentError ? e.code : 'execution_run_failed';
          try {
            args.finishRun(
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
          const ctrl = args.controllers.get(runId) ?? null;
          if (ctrl) {
            try {
              if (ctrl.kind === 'backend') await ctrl.backend.dispose();
            } catch {
              // best effort
            }
            ctrl.resolveTerminal();
            args.controllers.delete(runId);
          }
        }
      })();

      return { runId, callId, sidechainId };
    }

    // Long-lived runs are expected to be usable immediately after start(); await session provisioning
    // so follow-up execution.run.send calls don't race the vendor session startup.
    const childSessionId = await (async () => {
      const handle = args.params.retentionPolicy === 'resumable' ? (args.params.resumeHandle ?? null) : null;
      const wantsResume =
        handle?.kind === 'vendor_session.v1' && areExecutionRunBackendTargetsEqual(handle.backendTarget, args.params.backendTarget)
          ? handle.vendorSessionId
          : null;
      if (wantsResume) {
        if (!backend.loadSessionWithReplayCapture && !backend.loadSession) {
          const err: any = new Error('Backend does not support resume');
          err.code = 'execution_run_not_allowed';
          throw err;
        }
        const loaded = backend.loadSessionWithReplayCapture
          ? await backend.loadSessionWithReplayCapture(wantsResume as any)
          : await backend.loadSession!(wantsResume as any);
        return loaded.sessionId;
      }
      const started = await backend.startSession();
      return started.sessionId;
    })();
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

    return { runId, callId, sidechainId };
  } catch (e: any) {
    const message = e instanceof Error ? e.message : 'Execution failed';
    const finishedAtMs = args.getNowMs();
    const code = e instanceof VoiceAgentError ? e.code : 'execution_run_failed';
    try {
      args.finishRun(
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
    const ctrl = args.controllers.get(runId) ?? null;
    if (ctrl) {
      try {
        if (ctrl.kind === 'backend') await ctrl.backend.dispose();
      } catch {
        // best effort
      }
      ctrl.resolveTerminal();
      args.controllers.delete(runId);
    }
    throw e;
  }
}
