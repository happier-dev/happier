import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
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
import { forwardAcpMessageDelta } from '@/agent/acp/bridge/acpSessionForwarding';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import { computeSidechainStreamText } from '@/agent/executionRuns/runtime/sidechainStreamText';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';

type SendAcp = (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;

type FinishRunNext = Omit<
  ExecutionRunState,
  | 'runId'
  | 'callId'
  | 'sidechainId'
  | 'sessionId'
  | 'depth'
  | 'intent'
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
  createBackend: (opts: {
    runId?: string;
    backendId: string;
    permissionMode: string;
    modelId?: string;
    start?: ExecutionRunManagerStartParams;
  }) => AgentBackend;
  getNowMs: () => number;
  budgetRegistry: ExecutionBudgetRegistry | null;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  enqueueMarkerWrite: (runId: string, write: () => Promise<void>) => Promise<void>;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  finishRun: FinishRun;
  executeBoundedRun: ExecuteBoundedRun;
  send: (runId: string, params: Readonly<{ message: string; resume?: boolean }>) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  voiceAgentManager: VoiceAgentManager;
  getDepthByCallId: (callId: string) => number | null;
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
  args.runs.set(runId, {
    runId,
    callId,
    sidechainId,
    sessionId: args.params.sessionId,
    depth,
    intent: args.params.intent,
    backendId: args.params.backendId,
    instructions: args.params.instructions ?? '',
    ...(args.params.display ? { display: args.params.display } : {}),
    permissionMode: args.params.permissionMode,
    retentionPolicy: args.params.retentionPolicy,
    runClass: args.params.runClass,
    ioMode: args.params.ioMode,
    status: 'running',
    startedAtMs,
    resumeHandle: null,
  });

  // Persist a daemon-visible marker so machine-wide UIs can see the run immediately.
  const startMarkerPayload = {
    pid: process.pid,
    happySessionId: args.params.sessionId,
    runId,
    callId,
    sidechainId,
    intent: args.params.intent,
    backendId: args.params.backendId,
    ...(args.params.display ? { display: args.params.display } : {}),
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
        intent: args.params.intent,
        backendId: args.params.backendId,
        instructions: args.params.instructions ?? '',
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
      const initialContext = [String(args.params.initialContext ?? '').trim(), String(args.params.instructions ?? '').trim()]
        .filter((t) => t.length > 0)
        .join('\n\n');

      const chatModelId = String(args.params.chatModelId ?? 'default');
      const commitModelId = String(args.params.commitModelId ?? 'default');
      const commitIsolation = args.params.commitIsolation === true;
      const idleTtlSeconds = typeof args.params.idleTtlSeconds === 'number' ? args.params.idleTtlSeconds : 600;
      const verbosity = args.params.verbosity === 'balanced' ? 'balanced' : 'short';
      const bootstrapMode = args.params.bootstrapMode === 'ready_handshake' ? 'ready_handshake' : 'none';

      const startedVoice = await args.voiceAgentManager.start({
        agentId: args.params.backendId as any,
        chatModelId,
        commitModelId,
        commitIsolation,
        permissionPolicy,
        idleTtlSeconds,
        initialContext,
        verbosity,
        bootstrapMode,
      });

      const resumeHandle = args.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId);
      const existing = args.runs.get(runId);
      if (existing) {
        args.runs.set(runId, {
          ...existing,
          resumeHandle: resumeHandle ?? existing.resumeHandle ?? null,
          voiceAgentConfig: {
            chatModelId,
            commitModelId,
            commitIsolation,
            permissionPolicy,
            idleTtlSeconds,
            initialContext,
            verbosity,
            transcript: { persistenceMode, epoch },
          },
        });
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

    const backend = args.createBackend({ runId, backendId: args.params.backendId, permissionMode: args.params.permissionMode, start: args.params });
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend,
      childSessionId: null,
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
      cancelled: false,
      turnCount: 0,
      lastMarkerWriteAtMs: 0,
      terminalPromise,
      resolveTerminal,
    };
    args.controllers.set(runId, ctrl);

    const forwarder = createAcpAgentMessageForwarder({
      sendAcp,
      provider: args.parentProvider,
      sidechainId,
      makeId: () => randomUUID(),
    });

    const onMessage: AgentMessageHandler = (msg) => {
      if (msg.type === 'event' && msg.name === 'vendor_session_id') {
        const vendorSessionId = (msg.payload as any)?.sessionId;
        if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
          ctrl.childSessionId = vendorSessionId as SessionId;
          const run = args.runs.get(runId);
          if (run?.retentionPolicy === 'resumable') {
            args.runs.set(runId, {
              ...run,
              resumeHandle: { kind: 'vendor_session.v1', backendId: run.backendId, vendorSessionId },
            });
          }
        }
        return;
      }

      forwarder.forward(msg as any);

      if (msg.type !== 'model-output') return;
      const prevFullText = ctrl.buffer;
      if (typeof (msg as any).fullText === 'string') {
        ctrl.buffer = String((msg as any).fullText);
      } else if (typeof (msg as any).textDelta === 'string') {
        ctrl.buffer += String((msg as any).textDelta);
      }

      // Streaming: emit best-effort sidechain transcript updates.
      if (args.params.ioMode === 'streaming') {
        const streamKey = `${sidechainId}:turn:${ctrl.turnCount}`;
        if (!ctrl.sidechainStreamKey || ctrl.sidechainStreamKey !== streamKey) {
          ctrl.sidechainStreamKey = streamKey;
          ctrl.sidechainStreamBuffer = '';
        }

        const nextStreamText = computeSidechainStreamText(args.params.intent, ctrl.buffer);
        if (typeof nextStreamText === 'string') {
          const prevStreamText = ctrl.sidechainStreamBuffer;

          const delta = (() => {
            if (nextStreamText.startsWith(prevStreamText)) {
              return nextStreamText.slice(prevStreamText.length);
            }

            // Fallback: if the backend reports cumulative fullText but it diverges (vendor bug/restarts),
            // emit the delta between previous and current fullText as best-effort.
            if (ctrl.buffer === prevFullText) return '';
            return nextStreamText;
          })();

          if (delta && delta.length > 0) {
            ctrl.sidechainStreamBuffer = nextStreamText;
            forwardAcpMessageDelta({
              sendAcp,
              provider: args.parentProvider,
              delta,
              sidechainId,
              streamMetaKey: 'happierSidechainStreamKey',
              streamKey,
            });
          }
        }
      }

      // Best-effort: reflect activity for machine-wide run listing.
      void args.writeActivityMarker(runId, args.getNowMs());
    };

    backend.onMessage(onMessage);

    if (args.params.runClass === 'bounded') {
      // Provision the backend session and run kickoff asynchronously so the caller can dismiss
      // the UI draft card immediately after the SubAgentRun tool-call is injected.
      void (async () => {
        try {
          const childSessionId = await (async () => {
            const handle = args.params.retentionPolicy === 'resumable' ? (args.params.resumeHandle ?? null) : null;
            const wantsResume =
              handle?.kind === 'vendor_session.v1' && handle.backendId === args.params.backendId ? handle.vendorSessionId : null;
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
          if (existing && args.params.retentionPolicy === 'resumable') {
            args.runs.set(runId, {
              ...existing,
              resumeHandle: { kind: 'vendor_session.v1', backendId: args.params.backendId, vendorSessionId: childSessionId },
            });
            void args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
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
                  backendId: args.params.backendId,
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
      const wantsResume = handle?.kind === 'vendor_session.v1' && handle.backendId === args.params.backendId ? handle.vendorSessionId : null;
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
    if (existing && args.params.retentionPolicy === 'resumable') {
      args.runs.set(runId, {
        ...existing,
        resumeHandle: { kind: 'vendor_session.v1', backendId: args.params.backendId, vendorSessionId: childSessionId },
      });
      await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
    }

    if (typeof args.params.instructions === 'string' && args.params.instructions.trim().length > 0) {
      const start = {
        sessionId: args.params.sessionId,
        runId,
        callId,
        sidechainId,
        intent: args.params.intent,
        backendId: args.params.backendId,
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
            backendId: args.params.backendId,
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
