import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessage, McpServerConfig } from '@/agent';
import type { CatalogAgentId } from '@/backends/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
} from '@/agent/acp/bridge/acpCommonHandlers';
import { forwardAcpMessageDelta } from '@/agent/acp/bridge/acpSessionForwarding';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import { importAcpReplaySidechainV1 } from '@/agent/acp/history/importAcpReplaySidechain';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { getAgentModelConfig, type AgentId } from '@happier-dev/agents';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';

export type AcpRuntime = Readonly<{
  getSessionId: () => string | null;
  /**
   * Whether this runtime supports "steering" additional user input into an already running turn.
   */
  supportsInFlightSteer: () => boolean;
  /**
   * Whether a turn is currently in-flight for this runtime (between beginTurn and flushTurn).
   */
  isTurnInFlight: () => boolean;
  beginTurn: () => void;
  cancel: () => Promise<void>;
  reset: () => Promise<void>;
  startOrLoad: (opts: { resumeId?: string | null; importHistory?: boolean }) => Promise<string>;
  /**
   * Request a provider-native ACP session mode change (e.g. "plan" vs "code") when supported.
   * No-op when unsupported or when the session has not been started/loaded.
   */
  setSessionMode: (modeId: string) => Promise<void>;
  /**
   * Request a provider-native ACP session model change when supported.
   * No-op when unsupported or when the session has not been started/loaded.
   */
  setSessionModel: (modelId: string) => Promise<void>;
  /**
   * Request an ACP session config option change when supported.
   * No-op when unsupported or when the session has not been started/loaded.
   */
  setSessionConfigOption: (configId: string, value: string | number | boolean | null) => Promise<void>;
  /**
   * Send additional user text into the currently running turn when supported.
   *
   * This should NOT start a new turn and should NOT abort the current turn.
   */
  steerPrompt: (prompt: string) => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  flushTurn: () => void;
}>;

export type AcpRuntimeBackend = AgentBackend & {
  /**
   * Optional provider-native ACP session mode change (e.g. "plan" vs "code").
   */
  setSessionMode?: (sessionId: string, modeId: string) => Promise<void>;
  /**
   * Optional provider-native ACP session model change (UNSTABLE in ACP; may be unsupported).
   */
  setSessionModel?: (sessionId: string, modelId: string) => Promise<void>;
  /**
   * Optional ACP session config option change.
   */
  setSessionConfigOption?: (sessionId: string, configId: string, value: string | number | boolean | null) => Promise<unknown>;
  /**
   * Optional: send additional user input into an already running turn.
   */
  sendSteerPrompt?: (sessionId: string, prompt: string) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function abortAcpRuntimeTurnIfNeeded(
  runtime: Pick<AcpRuntime, 'isTurnInFlight' | 'cancel'> | null | undefined,
): Promise<boolean> {
  if (!runtime) return false;
  if (runtime.isTurnInFlight() !== true) return false;
  await runtime.cancel();
  return true;
}

export function createAcpRuntime(params: {
  provider: CatalogAgentId;
  directory: string;
  session: AcpRuntimeSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  ensureBackend: () => Promise<AcpRuntimeBackend>;
  /**
   * Defensive controls for the tool-call name cache (callId -> toolName).
   *
   * Some backends may emit tool-calls without ever emitting the corresponding tool-result (e.g. cancellations,
   * abrupt disconnects, or errors). This cache is therefore bounded and TTL-evicted to avoid unbounded growth.
   */
  toolCallCache?: {
    maxEntries?: number;
    ttlMs?: number;
  };
  /**
   * Optional hook to create a separate backend for replay capture (used for sidechains).
   * When omitted, a new catalog ACP backend is created on-demand.
   */
  createReplayBackend?: () => Promise<AcpRuntimeBackend>;
  /**
   * Optional hook to publish vendor session id metadata after start/load/prompt.
   */
  onSessionIdChange?: (sessionId: string | null) => void;
  /**
   * Optional in-flight steer support.
   *
   * This is a provider/runtime capability flag, not a UI/queue policy.
   */
  inFlightSteer?: {
    enabled?: boolean;
  };
  /**
   * Optional pending-queue integration used to materialize server-backed pending messages
   * while a steer-capable turn is in-flight.
   */
  pendingQueue?: {
    waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
    popPendingMessage: () => Promise<boolean>;
    maxPopPerWake?: number;
    /**
     * Whether the runtime should pop server-pending messages while a turn is in-flight.
     *
     * This is intentionally opt-in because popping pending messages during a running turn
     * effectively "auto-delivers" them (often via in-flight steer) which can defeat
     * user-facing "queue for review" / "queue in Pending" semantics.
     *
     * The baseline message loop already pops pending messages while idle; this only affects
     * the extra in-flight pump used to avoid stranding pending messages while sendPrompt() is running.
     */
    drainDuringTurn?: boolean;
    /**
     * Fallback polling interval used while a steer-capable turn is in-flight.
     *
     * Some pending-queue updates may not publish metadata wake signals, so polling avoids
     * stranding newly enqueued messages mid-turn.
     */
    pollIntervalMs?: number;
  };
  /**
   * Optional lifecycle hooks for per-provider turn processing.
   *
   * These hooks are intentionally generic (no provider branching inside the core runtime).
   * Providers can opt into observing tool results and emitting synthetic tool calls/results at
   * turn boundaries (e.g. per-turn diffs), while keeping all provider-specific parsing in their
   * backend folders.
   */
  hooks?: {
    onBeginTurn?: () => void;
    onToolResult?: (params: { toolName: string; callId: string; result: unknown }) => void;
    onPermissionRequest?: (params: { permissionId: string; toolName: string; payload: unknown; reason: string }) => void;
    onBeforeFlushTurn?: (params: {
      /**
       * Send an additional tool-call into the session transcript.
       * Returns the generated callId so the caller can emit a matching tool-result.
       */
      sendToolCall: (params: { toolName: string; input: unknown; callId?: string }) => string;
      /**
       * Send an additional tool-result into the session transcript.
       */
      sendToolResult: (params: { callId: string; output: unknown }) => void;
    }) => void;
  };
}): AcpRuntime {
  let backend: AcpRuntimeBackend | null = null;
  let backendPromise: Promise<AcpRuntimeBackend> | null = null;
  let sessionId: string | null = null;

  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let taskStartedSent = false;
  let turnAborted = false;
  let turnStreamKey: string | null = null;
  let didStreamModelOutputToSession = false;
  let loadingSession = false;
  let turnInFlight = false;
  const inFlightSteerEnabled = params.inFlightSteer?.enabled === true;
  const acpTraceMarkersEnabled = (() => {
    const raw = (
      process.env.HAPPIER_E2E_ACP_TRACE_MARKERS ??
      process.env.HAPPY_E2E_ACP_TRACE_MARKERS ??
      ''
    )
      .toString()
      .trim()
      .toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  })();
  let pendingPumpController: AbortController | null = null;

  const stopPendingPump = () => {
    if (!pendingPumpController) return;
    try {
      pendingPumpController.abort('acp-runtime:stop-pending-pump');
    } catch {
      // ignore
    }
    pendingPumpController = null;
  };

  const startPendingPumpIfNeeded = () => {
    if (!inFlightSteerEnabled) return;
    if (!params.pendingQueue) return;
    if (params.pendingQueue.drainDuringTurn !== true) return;
    if (pendingPumpController) return;

    const controller = new AbortController();
    pendingPumpController = controller;
    const maxPopPerWake = Math.max(1, params.pendingQueue.maxPopPerWake ?? 25);
    const pollIntervalMs = Math.max(5, params.pendingQueue.pollIntervalMs ?? 2_000);

    const waitForPollWake = async (): Promise<boolean> =>
      await new Promise<boolean>((resolve) => {
        if (controller.signal.aborted) return resolve(false);
        const timer = setTimeout(() => resolve(true), pollIntervalMs);
        timer.unref?.();
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(false);
          },
          { once: true },
        );
      });

    void (async () => {
      const drainPendingOnce = async (): Promise<void> => {
        // Best-effort: materialize a bounded number of pending messages per wake to avoid tight loops.
        for (let i = 0; i < maxPopPerWake; i += 1) {
          if (controller.signal.aborted) break;
          const did = await params.pendingQueue!.popPendingMessage().catch(() => false);
          if (!did) break;
        }
      };

      // Drain immediately once to avoid stranding already-enqueued pending messages while we wait
      // for a "metadata update" wake signal.
      await drainPendingOnce();

      while (!controller.signal.aborted) {
        // Pending queue updates do not always publish a metadata wake signal (version skew / transport races).
        // Poll as a fallback so newly enqueued messages can still be drained mid-turn for in-flight steer.
        //
        // IMPORTANT: avoid leaking `metadata-updated` listeners by canceling the losing wait when polling wins.
        const iteration = new AbortController();
        const abortIteration = (reason: string) => {
          try {
            iteration.abort(reason);
          } catch {
            // ignore
          }
        };
        const onGlobalAbort = () => abortIteration('acp-runtime:pending-pump:global-abort');
        controller.signal.addEventListener('abort', onGlobalAbort, { once: true });

        const winner = await Promise.race([
          params.pendingQueue!
            .waitForMetadataUpdate(iteration.signal)
            .then(() => 'metadata')
            .catch(() => 'metadata'),
          waitForPollWake().then(() => 'poll'),
        ]);
        controller.signal.removeEventListener('abort', onGlobalAbort);
        if (winner === 'poll') {
          // Cancel the still-pending metadata wait so it can remove its listeners.
          abortIteration('acp-runtime:pending-pump:poll-wake');
        }
        if (controller.signal.aborted) break;

        await drainPendingOnce();
      }
    })();
  };

  const toolCallCacheMaxEntries = Math.max(1, params.toolCallCache?.maxEntries ?? 1_000);
  const toolCallCacheTtlMs = Math.max(1, params.toolCallCache?.ttlMs ?? 10 * 60_000);
  const toolNameByCallId = new Map<string, { toolName: string; createdAtMs: number }>();
  const toolCallIdQueue: string[] = [];

  const clearToolCallCache = () => {
    toolNameByCallId.clear();
    toolCallIdQueue.length = 0;
  };

  const compactToolCallQueue = () => {
    // We lazily remove callIds from the queue (the Map is the source of truth). Compact occasionally to
    // avoid unbounded growth when tool-results arrive out of order.
    const maxQueueLen = toolCallCacheMaxEntries * 4;
    if (toolCallIdQueue.length <= maxQueueLen) return;
    let write = 0;
    for (const callId of toolCallIdQueue) {
      if (toolNameByCallId.has(callId)) {
        toolCallIdQueue[write] = callId;
        write += 1;
      }
    }
    toolCallIdQueue.length = write;
  };

  const evictToolCallCache = (nowMs: number) => {
    // TTL eviction: because the queue is insertion-ordered, we only need to consider the head.
    while (toolCallIdQueue.length > 0) {
      const oldestCallId = toolCallIdQueue[0]!;
      const entry = toolNameByCallId.get(oldestCallId);
      if (!entry) {
        toolCallIdQueue.shift();
        continue;
      }
      if (nowMs - entry.createdAtMs > toolCallCacheTtlMs) {
        toolNameByCallId.delete(oldestCallId);
        toolCallIdQueue.shift();
        continue;
      }
      break;
    }

    // Size eviction: remove oldest entries until within bounds.
    while (toolNameByCallId.size > toolCallCacheMaxEntries && toolCallIdQueue.length > 0) {
      const oldestCallId = toolCallIdQueue.shift()!;
      toolNameByCallId.delete(oldestCallId);
    }

    // Defensive: if the queue was desynced (shouldn't happen), keep memory bounded.
    if (toolNameByCallId.size > toolCallCacheMaxEntries && toolCallIdQueue.length === 0) {
      toolNameByCallId.clear();
    }

    compactToolCallQueue();
  };

  const recordToolCall = (callId: string, toolName: string) => {
    const nowMs = Date.now();
    toolNameByCallId.set(callId, { toolName, createdAtMs: nowMs });
    toolCallIdQueue.push(callId);
    evictToolCallCache(nowMs);
  };

  const resetTurnState = () => {
    accumulatedResponse = '';
    isResponseInProgress = false;
    taskStartedSent = false;
    turnAborted = false;
    turnStreamKey = null;
    didStreamModelOutputToSession = false;
  };

  const publishSessionId = () => {
    params.onSessionIdChange?.(sessionId);
  };

  const attachMessageHandler = (b: AcpRuntimeBackend) => {
    const forwarder = createAcpAgentMessageForwarder({
      sendAcp: (provider, body) => params.session.sendAgentMessage(provider, body),
      provider: params.provider,
      makeId: () => randomUUID(),
    });

    b.onMessage((msg: AgentMessage) => {
      if (loadingSession) {
        if (msg.type === 'status' && msg.status === 'error') {
          turnAborted = true;
          params.session.sendAgentMessage(params.provider, { type: 'turn_aborted', id: randomUUID() });
        }
        return;
      }

      switch (msg.type) {
        case 'model-output': {
          const fullText = typeof (msg as any).fullText === 'string' ? String((msg as any).fullText) : '';
          let deltaRaw = typeof (msg as any).textDelta === 'string' ? String((msg as any).textDelta) : '';
          if (!deltaRaw && fullText) {
            if (fullText.startsWith(accumulatedResponse)) {
              deltaRaw = fullText.slice(accumulatedResponse.length);
            } else {
              // Defensive: if a provider restarts and sends a divergent fullText, restart accumulation.
              accumulatedResponse = '';
              deltaRaw = fullText;
            }
          }
          if (acpTraceMarkersEnabled && sessionId && deltaRaw.includes('ACP_STUB_')) {
            // Trace only deterministic stub markers (never arbitrary assistant text) so provider harness
            // can coordinate mid-turn steer without requiring tool-calls or vendor credentials.
            recordToolTraceEvent({
              direction: 'inbound',
              sessionId,
              protocol: 'acp',
              provider: params.provider,
              kind: 'trace-marker',
              payload: { text: deltaRaw },
            });
          }
          handleAcpModelOutputDelta({
            delta: deltaRaw,
            messageBuffer: params.messageBuffer,
            getIsResponseInProgress: () => isResponseInProgress,
            setIsResponseInProgress: (value) => { isResponseInProgress = value; },
            appendToAccumulatedResponse: (delta) => { accumulatedResponse += delta; },
          });

          if (deltaRaw) {
            if (!turnStreamKey) {
              turnStreamKey = `acp:turn:${randomUUID()}`;
            }
            forwardAcpMessageDelta({
              sendAcp: params.session.sendAgentMessage.bind(params.session),
              provider: params.provider,
              delta: deltaRaw,
              streamMetaKey: 'happierStreamKey',
              streamKey: turnStreamKey,
            });
            didStreamModelOutputToSession = true;
          }
          break;
        }

        case 'status': {
          if (msg.status === 'running') {
            handleAcpStatusRunning({
              session: params.session,
              agent: params.provider,
              messageBuffer: params.messageBuffer,
              onThinkingChange: params.onThinkingChange,
              getTaskStartedSent: () => taskStartedSent,
              setTaskStartedSent: (value) => { taskStartedSent = value; },
              makeId: () => randomUUID(),
            });

            if (acpTraceMarkersEnabled && sessionId) {
              // Provider-agnostic trace marker used by the e2e harness to enqueue an in-flight steer
              // step while the turn is running (without relying on vendor-specific assistant output).
              recordToolTraceEvent({
                direction: 'inbound',
                sessionId,
                protocol: 'acp',
                provider: params.provider,
                kind: 'trace-marker',
                payload: { event: 'acp_status_running' },
              });
            }
          }

          if (msg.status === 'error') {
            turnAborted = true;
            clearToolCallCache();
            params.session.sendAgentMessage(params.provider, { type: 'turn_aborted', id: randomUUID() });
          }
          break;
        }

        case 'tool-call': {
          params.messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
          recordToolCall(msg.callId, msg.toolName);
          forwarder.forward(msg);
          break;
        }

        case 'tool-result': {
          const callId = msg.callId;
          evictToolCallCache(Date.now());
          const originToolName = toolNameByCallId.get(callId)?.toolName ?? msg.toolName;
          const resultRecord =
            msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)
              ? (msg.result as Record<string, unknown>)
              : null;
          const maybeStream =
            !!resultRecord && (typeof resultRecord.stdoutChunk === 'string' || resultRecord._stream === true);
          if (!maybeStream) {
            const outputText = typeof msg.result === 'string'
              ? msg.result
              : JSON.stringify(msg.result ?? '').slice(0, 200);
            params.messageBuffer.addMessage(`Result: ${outputText}`, 'result');
          }
          forwarder.forward(msg);

          if (typeof originToolName === 'string' && originToolName.length > 0) {
            try {
              params.hooks?.onToolResult?.({ toolName: originToolName, callId, result: msg.result });
            } catch (e) {
              logger.debug(`[${params.provider}] onToolResult hook failed (non-fatal)`, e);
            }
          }

          // Provider-agnostic sidechain import: if a Task tool-result includes a vendor session id,
          // capture its replay in a separate backend and import it as a sidechain thread.
          if (typeof originToolName === 'string' && originToolName.toLowerCase() === 'task') {
            const record = asRecord(msg.result);
            const metadata = record ? asRecord(record.metadata) : null;
            const metadataSessionIdRaw = metadata?.sessionId;
            const metadataSessionId = typeof metadataSessionIdRaw === 'string' ? metadataSessionIdRaw : null;
            const outputValue = record?.output;
            const outputText = typeof outputValue === 'string' ? outputValue : null;
            const contentText = typeof (record as any)?.content === 'string' ? String((record as any).content) : null;
            const fallbackSidechainText = (() => {
              const raw = (contentText ?? outputText ?? '').trim();
              if (!raw) return '';
              // Strip embedded task metadata blocks so the sidechain preview is mostly the assistant output.
              return raw.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, '').trim();
            })();
            const embeddedSessionId = outputText
              ? (() => {
                  const match = outputText.match(/<task_metadata>[\s\S]*?session_id:\s*([^\s<]+)[\s\S]*?<\/task_metadata>/i);
                  return match?.[1] ? String(match[1]) : null;
                })()
              : null;
            const remoteSessionId = (metadataSessionId ?? embeddedSessionId)?.trim() || '';

            if (remoteSessionId) {
              const createReplayBackend = params.createReplayBackend ?? (async () => {
                const created = await createCatalogAcpBackend(params.provider, {
                  cwd: params.directory,
                  mcpServers: params.mcpServers,
                  permissionHandler: params.permissionHandler,
                });
                return created.backend as AcpRuntimeBackend;
              });

              void (async () => {
                let replayBackend: AcpRuntimeBackend | null = null;
                let replayImported = false;
                try {
                  replayBackend = await createReplayBackend();
                  const canReplay = Boolean(replayBackend.loadSessionWithReplayCapture);
                  if (canReplay) {
                    const loaded = await replayBackend.loadSessionWithReplayCapture!(remoteSessionId);
                    const replay = loaded.replay;
                    if (Array.isArray(replay) && replay.length > 0) {
                      await importAcpReplaySidechainV1({
                        session: params.session,
                        provider: params.provider,
                        remoteSessionId,
                        sidechainId: callId,
                        replay: replay as unknown[],
                      });
                      replayImported = true;
                      return;
                    }
                  }
                } catch (e) {
                  logger.debug(`[${params.provider}] Failed to import Task sidechain replay (non-fatal)`, e);
                } finally {
                  // Fallback: if we can't replay-import, at least persist the Task output as a sidechain message.
                  if (!replayImported && fallbackSidechainText) {
                    try {
                      await params.session.sendAgentMessageCommitted(
                        params.provider,
                        { type: 'message', message: fallbackSidechainText, sidechainId: callId },
                        { localId: randomUUID(), meta: { importedFrom: 'acp-sidechain', remoteSessionId, sidechainId: callId } },
                      );
                    } catch (e) {
                      logger.debug(`[${params.provider}] Failed to persist Task sidechain fallback message (non-fatal)`, e);
                    }
                  }
                  toolNameByCallId.delete(callId);
                  if (replayBackend) {
                    try {
                      await replayBackend.dispose();
                    } catch (e) {
                      logger.debug(`[${params.provider}] Failed to dispose replay backend (non-fatal)`, e);
                    }
                  }
                }
              })();
            } else {
              toolNameByCallId.delete(callId);
            }
          } else {
            toolNameByCallId.delete(callId);
          }
          break;
        }

        case 'fs-edit': {
          params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
          forwarder.forward(msg);
          break;
        }

        case 'terminal-output': {
          const data = typeof (msg as any).data === 'string' ? String((msg as any).data) : '';
          if (data) {
            params.messageBuffer.addMessage(data, 'result');
          }
          forwarder.forward(msg);
          break;
        }

        case 'token-count': {
          forwarder.forward(msg);
          break;
        }

        case 'permission-request': {
          const payloadRecord = asRecord((msg as any).payload);
          const toolNameRaw = typeof payloadRecord?.toolName === 'string' ? payloadRecord.toolName : typeof (msg as any).reason === 'string' ? (msg as any).reason : '';
          const toolName = typeof toolNameRaw === 'string' && toolNameRaw.trim() ? toolNameRaw.trim() : 'unknown_tool';
          const permissionId = typeof (msg as any).id === 'string' && (msg as any).id.trim() ? String((msg as any).id).trim() : randomUUID();
          const reason = typeof (msg as any).reason === 'string' ? String((msg as any).reason) : toolName;
          try {
            params.hooks?.onPermissionRequest?.({ permissionId, toolName, payload: (msg as any).payload, reason });
          } catch (e) {
            logger.debug(`[${params.provider}] Failed to run permission-request hook (non-fatal)`, e);
          }
          forwarder.forward(msg);
          break;
        }

        case 'event': {
          const name = msg.name;
          if (name === 'available_commands_update') {
            const payload = msg.payload;
            const payloadRecord = asRecord(payload);
            const details = normalizeAvailableCommands(payloadRecord?.availableCommands ?? payload);
            publishSlashCommandsToMetadata({ session: params.session, details });
          }
          if (name === 'session_modes_state') {
            const payloadRecord = asRecord(msg.payload);
            const currentModeIdRaw = payloadRecord?.currentModeId;
            const currentModeId = typeof currentModeIdRaw === 'string' ? currentModeIdRaw : '';
            const availableModesRaw = payloadRecord?.availableModes;
            const availableModes = Array.isArray(availableModesRaw)
              ? availableModesRaw
                  .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                  .map((m: any) => ({
                    id: String(m.id),
                    name: String(m.name),
                    ...(typeof m.description === 'string' ? { description: String(m.description) } : {}),
                  }))
              : [];
            if (currentModeId && availableModes.length > 0) {
              updateMetadataBestEffort(
                params.session,
                (metadata) => ({
                  ...metadata,
                  acpSessionModesV1: {
                    v: 1,
                    provider: params.provider,
                    updatedAt: Date.now(),
                    currentModeId,
                    availableModes,
                  },
                }),
                `[${params.provider}]`,
                'session_modes_state',
              );
            }
          }
          if (name === 'session_models_state') {
            const payloadRecord = asRecord(msg.payload);
            const currentModelIdRaw = payloadRecord?.currentModelId;
            const currentModelId = typeof currentModelIdRaw === 'string' ? currentModelIdRaw : '';
            const availableModelsRaw = payloadRecord?.availableModels;
            const availableModels = Array.isArray(availableModelsRaw)
              ? availableModelsRaw
                  .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                  .map((m: any) => ({
                    id: String(m.id),
                    name: String(m.name),
                    ...(typeof m.description === 'string' ? { description: String(m.description) } : {}),
                  }))
              : [];
            if (currentModelId && availableModels.length > 0) {
              updateMetadataBestEffort(
                params.session,
                (metadata) => ({
                  ...metadata,
                  acpSessionModelsV1: {
                    v: 1,
                    provider: params.provider,
                    updatedAt: Date.now(),
                    currentModelId,
                    availableModels,
                  },
                }),
                `[${params.provider}]`,
                'session_models_state',
              );
            }
          }
          if (name === 'config_options_state' || name === 'config_options_update') {
            const payloadRecord = asRecord(msg.payload);
            const configOptionsRaw = payloadRecord?.configOptions;
            const configOptions = Array.isArray(configOptionsRaw)
              ? configOptionsRaw
                  .filter((o: any) => o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.type === 'string')
                  .map((o: any) => {
                    const base: any = {
                      id: String(o.id),
                      name: String(o.name),
                      type: String(o.type),
                      currentValue: (o as any).currentValue,
                    };
                    if (typeof o.description === 'string') base.description = String(o.description);
                    if (Array.isArray(o.options)) {
                      base.options = o.options
                        .filter((opt: any) => opt && (opt.value !== undefined) && typeof opt.name === 'string')
                        .map((opt: any) => {
                          const out: any = { value: opt.value, name: String(opt.name) };
                          if (typeof opt.description === 'string') out.description = String(opt.description);
                          return out;
                        });
                    }
                    return base;
                  })
              : [];
            const derivedModels = (() => {
              const findModelOpt = (o: any) => {
                const id = typeof o?.id === 'string' ? o.id.trim().toLowerCase() : '';
                const name = typeof o?.name === 'string' ? o.name.trim().toLowerCase() : '';
                return id === 'model' || name === 'model';
              };
              const modelOpt = configOptions.find(findModelOpt) as any;
              if (!modelOpt || !Array.isArray(modelOpt.options) || modelOpt.options.length === 0) return null;

              const currentValue = modelOpt.currentValue;
              const currentModelId =
                typeof currentValue === 'string'
                  ? currentValue
                  : (typeof currentValue === 'number' && Number.isFinite(currentValue) ? String(currentValue) : (typeof currentValue === 'boolean' ? (currentValue ? 'true' : 'false') : ''));
              if (!currentModelId) return null;

              const availableModels = modelOpt.options
                .filter((opt: any) => opt && opt.value !== undefined && typeof opt.name === 'string')
                .map((opt: any) => ({
                  id: String(opt.value),
                  name: String(opt.name),
                  ...(typeof opt.description === 'string' ? { description: String(opt.description) } : {}),
                }))
                .filter((m: any) => m.id && m.name);
              if (availableModels.length === 0) return null;

              return { currentModelId, availableModels };
            })();

            updateMetadataBestEffort(
              params.session,
              (metadata) => {
                const now = Date.now();
                const next: any = {
                  ...metadata,
                  acpConfigOptionsV1: {
                    v: 1,
                    provider: params.provider,
                    updatedAt: now,
                    configOptions,
                  },
                };

                if (derivedModels) {
                  next.acpSessionModelsV1 = {
                    v: 1,
                    provider: params.provider,
                    updatedAt: now,
                    currentModelId: derivedModels.currentModelId,
                    availableModels: derivedModels.availableModels,
                  };
                }

                return next as any;
              },
              `[${params.provider}]`,
              'config_options_state',
            );
          }
          if (name === 'current_mode_update') {
            const payloadRecord = asRecord(msg.payload);
            const currentModeIdRaw = payloadRecord?.currentModeId;
            const currentModeId = typeof currentModeIdRaw === 'string' ? currentModeIdRaw : '';
            if (currentModeId) {
              updateMetadataBestEffort(
                params.session,
                (metadata) => {
                  const prev = metadata.acpSessionModesV1;
                  const availableModes = Array.isArray(prev?.availableModes) ? prev.availableModes : [];
                  return {
                    ...metadata,
                    acpSessionModesV1: {
                      v: 1,
                      provider: params.provider,
                      updatedAt: Date.now(),
                      currentModeId,
                      availableModes,
                    },
                  };
                },
                `[${params.provider}]`,
                'current_mode_update',
              );
            }
          }
          if (name === 'current_model_update') {
            const payloadRecord = asRecord(msg.payload);
            const currentModelIdRaw = payloadRecord?.currentModelId;
            const currentModelId = typeof currentModelIdRaw === 'string' ? currentModelIdRaw : '';
            if (currentModelId) {
              updateMetadataBestEffort(
                params.session,
                (metadata) => {
                  const prev = (metadata as any).acpSessionModelsV1 as any;
                  const availableModels = Array.isArray(prev?.availableModels) ? prev.availableModels : [];
                  return {
                    ...metadata,
                    acpSessionModelsV1: {
                      v: 1,
                      provider: params.provider,
                      updatedAt: Date.now(),
                      currentModelId,
                      availableModels,
                    },
                  };
                },
                `[${params.provider}]`,
                'current_model_update',
              );
            }
          }
          if (name === 'thinking') {
            const payloadRecord = asRecord(msg.payload);
            const textRaw = payloadRecord?.text;
            const text = typeof textRaw === 'string' ? textRaw : '';
            if (text) {
              params.session.sendAgentMessage(params.provider, { type: 'thinking', text });
            }
          }
          break;
        }
      }
    });
  };

  const ensureBackend = async (): Promise<AcpRuntimeBackend> => {
    if (backend) return backend;
    if (backendPromise) return await backendPromise;
    backendPromise = (async () => {
      const created = await params.ensureBackend();
      backend = created;
      attachMessageHandler(created);
      logger.debug(`[${params.provider}] ACP backend created`);
      return created;
    })();
    try {
      return await backendPromise;
    } finally {
      backendPromise = null;
    }
  };

  return {
    getSessionId: () => sessionId,
    supportsInFlightSteer: () => inFlightSteerEnabled,
    isTurnInFlight: () => turnInFlight,

    beginTurn(): void {
      turnInFlight = true;
      turnAborted = false;
      resetTurnState();
      startPendingPumpIfNeeded();
      try {
        params.hooks?.onBeginTurn?.();
      } catch (e) {
        logger.debug(`[${params.provider}] onBeginTurn hook failed (non-fatal)`, e);
      }
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      const b = await ensureBackend();
      try {
        await b.cancel(sessionId);
      } finally {
        // Cancel should behave like a turn boundary: don't keep steering/pending state alive.
        turnInFlight = false;
        stopPendingPump();
        clearToolCallCache();
      }
    },

    async reset(): Promise<void> {
      sessionId = null;
      turnInFlight = false;
      resetTurnState();
      loadingSession = false;
      clearToolCallCache();
      stopPendingPump();
      publishSessionId();

      if (backend) {
        try {
          await backend.dispose();
        } catch (e) {
          logger.debug(`[${params.provider}] Failed to dispose backend (non-fatal)`, e);
        }
        backend = null;
      }
    },

    async startOrLoad(opts: { resumeId?: string | null; importHistory?: boolean } = {}): Promise<string> {
      const b = await ensureBackend();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      const importHistory = opts.importHistory !== false;
      if (resumeId) {
        if (!b.loadSession && !b.loadSessionWithReplayCapture) {
          throw new Error(`${params.provider} ACP backend does not support loading sessions`);
        }

        loadingSession = true;
        let replay: unknown[] | null = null;
        try {
          if (b.loadSessionWithReplayCapture && importHistory) {
            const loaded = await b.loadSessionWithReplayCapture(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
            replay = Array.isArray(loaded.replay) ? loaded.replay : null;
          } else if (b.loadSession) {
            const loaded = await b.loadSession(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
          } else if (b.loadSessionWithReplayCapture) {
            const loaded = await b.loadSessionWithReplayCapture(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
          } else {
            throw new Error(`${params.provider} ACP backend does not support loading sessions`);
          }
        } finally {
          loadingSession = false;
        }

        if (replay && importHistory) {
          importAcpReplayHistoryV1({
            session: params.session,
            provider: params.provider,
            remoteSessionId: resumeId,
            replay: replay as unknown[],
            permissionHandler: params.permissionHandler,
          }).catch((e) => {
            logger.debug(`[${params.provider}] Failed to import replay history (non-fatal)`, e);
          });
        }
      } else {
        const started = await b.startSession();
        sessionId = started.sessionId;
      }

      publishSessionId();
      return sessionId!;
    },

    async setSessionMode(modeId: string): Promise<void> {
      const normalizedModeId = typeof modeId === 'string' ? modeId.trim() : '';
      if (!normalizedModeId) return;
      if (!sessionId) return;

      const b = await ensureBackend();
      if (!b.setSessionMode) return;
      await b.setSessionMode(sessionId, normalizedModeId);
    },

    async setSessionModel(modelId: string): Promise<void> {
      const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
      if (!normalizedModelId) return;
      if (!sessionId) return;

      const modelConfigOptionId = (() => {
        try {
          return getAgentModelConfig(params.provider as AgentId).acpModelConfigOptionId ?? 'model';
        } catch (error) {
          logger.debug(
            `[${params.provider}] Failed to resolve provider model config option id; falling back to "model"`,
            error
          );
          return 'model';
        }
      })();

      const b = await ensureBackend();
      if (b.setSessionModel) {
        try {
          await b.setSessionModel(sessionId, normalizedModelId);
          return;
        } catch (e: any) {
          // Some ACP agents may not support `session/set_model` but may expose an equivalent
          // `model` config option. Fall back best-effort; callers already treat this as non-fatal.
          if (!b.setSessionConfigOption) throw e;

          const msg = typeof e?.message === 'string' ? e.message : '';
          const codeCandidate =
            typeof e?.code === 'number'
              ? e.code
              : (typeof e?.error?.code === 'number' ? e.error.code : null);
          const isMethodNotFound = codeCandidate === -32601 || /method not found/i.test(msg);
          const isUnsupported =
            isMethodNotFound ||
            msg.includes('session/set_model') ||
            msg.includes('set_model') ||
            msg.includes('unstable_setSessionModel') ||
            msg.includes('setSessionModel');
          if (!isUnsupported) throw e;

          await b.setSessionConfigOption(sessionId, modelConfigOptionId, normalizedModelId);
          return;
        }
      }

      if (b.setSessionConfigOption) {
        await b.setSessionConfigOption(sessionId, modelConfigOptionId, normalizedModelId);
      }
    },

    async setSessionConfigOption(configId: string, value: string | number | boolean | null): Promise<void> {
      const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
      if (!normalizedConfigId) return;
      const normalizedValue = (() => {
        if (typeof value === 'string') {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return null;
      })();
      if (!normalizedValue) return;
      if (!sessionId) return;

      const b = await ensureBackend();
      if (!b.setSessionConfigOption) return;
      await b.setSessionConfigOption(sessionId, normalizedConfigId, normalizedValue);
    },

    async steerPrompt(prompt: string): Promise<void> {
      if (!inFlightSteerEnabled) {
        throw new Error(`${params.provider} runtime does not support in-flight steer`);
      }
      if (!sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      // Provider-agnostic trace marker so the provider harness can assert that the second message
      // was routed through in-flight steer (STIR-style) instead of interrupting the turn.
      //
      // This is emitted before awaiting the backend RPC so harness-level assertions reflect routing
      // (which is what we control) even when a vendor blocks/queues steer prompts internally.
      if (acpTraceMarkersEnabled) {
        recordToolTraceEvent({
          direction: 'outbound',
          sessionId,
          protocol: 'acp',
          provider: params.provider,
          kind: 'trace-marker',
          payload: { event: 'acp_in_flight_steer' },
        });
      }

      const b = await ensureBackend();
      if (b.sendSteerPrompt) {
        await b.sendSteerPrompt(sessionId, prompt);
      } else {
        throw new Error(`${params.provider} ACP backend does not support in-flight steer`);
      }
      publishSessionId();
    },

    async sendPrompt(prompt: string): Promise<void> {
      if (!sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      const b = await ensureBackend();
      await b.sendPrompt(sessionId, prompt);
      if (b.waitForResponseComplete) {
        await b.waitForResponseComplete(120_000);
      }
      publishSessionId();
    },

    flushTurn(): void {
      turnInFlight = false;
      stopPendingPump();
      if (!turnAborted) {
        try {
          params.hooks?.onBeforeFlushTurn?.({
            sendToolCall: ({ toolName, input, callId }) => {
              const resolvedCallId = typeof callId === 'string' && callId.length > 0 ? callId : randomUUID();
              params.session.sendAgentMessage(params.provider, {
                type: 'tool-call',
                callId: resolvedCallId,
                name: toolName,
                input,
                id: randomUUID(),
              });
              return resolvedCallId;
            },
            sendToolResult: ({ callId, output }) => {
              params.session.sendAgentMessage(params.provider, {
                type: 'tool-result',
                callId,
                output,
                id: randomUUID(),
              });
            },
          });
        } catch (e) {
          logger.debug(`[${params.provider}] onBeforeFlushTurn hook failed (non-fatal)`, e);
        }
      }

      if (!didStreamModelOutputToSession && accumulatedResponse.trim()) {
        params.session.sendAgentMessage(params.provider, { type: 'message', message: accumulatedResponse });
      }

      if (!turnAborted) {
        params.session.sendAgentMessage(params.provider, { type: 'task_complete', id: randomUUID() });
      }

      resetTurnState();
    },
  };
}
