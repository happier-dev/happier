import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import { createAcpPendingQueuePump } from './createAcpPendingQueuePump';
import { createBoundedToolCallNameCache } from './createBoundedToolCallNameCache';
import type { RuntimeTurnConfigUpdate, RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createAcpRuntimeLifecycleMethods } from './createAcpRuntimeLifecycleMethods';
import { attachAcpRuntimeMessageHandler } from './attachAcpRuntimeMessageHandler';
import type { AcpRuntimeBackend } from './acpRuntimeBackendContract';
export type { AcpRuntimeBackend } from './acpRuntimeBackendContract';

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
  flushTurn: () => Promise<void>;
}>;

export type AcpRuntimeWithTurnOperations = AcpRuntime & RuntimeTurnOperations;

export async function abortAcpRuntimeTurnIfNeeded(
  runtime: Pick<AcpRuntime, 'isTurnInFlight' | 'cancel'> | null | undefined,
): Promise<boolean> {
  if (!runtime) return false;
  if (runtime.isTurnInFlight() !== true) return false;
  await runtime.cancel();
  return true;
}

export function createAcpRuntime(params: {
  provider: string;
  directory: string;
  happierSessionId?: string;
  session: AcpRuntimeSessionClient;
  transcriptSession?: TranscriptSessionPort;
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
     * Whether the runtime should pop server-pending messages once after session start/load.
     *
     * This covers inactive-session resume: the process is awake again, but no turn has started
     * until the server-backed pending message is materialized into the normal transcript.
     */
    drainAfterStartOrLoad?: boolean;
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
  /**
   * Legacy compatibility toggle for native ACP runtimes.
   *
   * Shared change-title guidance now belongs to the centralized coding prompt base.
   */
  changeTitleInstruction?: {
    enabled?: boolean;
  };
  memoryRecallGuidance?: {
    enabled?: boolean;
    machineId?: string | null;
  };
}): AcpRuntimeWithTurnOperations {
  const state = {
    backend: null as AcpRuntimeBackend | null,
    backendPromise: null as Promise<AcpRuntimeBackend> | null,
    sessionId: null as string | null,
    accumulatedResponse: '',
    isResponseInProgress: false,
    taskStartedSent: false,
    turnAborted: false,
    loadingSession: false,
    turnInFlight: false,
  };
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
  const pendingQueuePump = createAcpPendingQueuePump({
    enabled: inFlightSteerEnabled,
    pendingQueue: params.pendingQueue,
  });

  const toolCallCacheMaxEntries = Math.max(1, params.toolCallCache?.maxEntries ?? 1_000);
  const toolCallCacheTtlMs = Math.max(1, params.toolCallCache?.ttlMs ?? 10 * 60_000);
  const toolCallNameCache = createBoundedToolCallNameCache({
    maxEntries: toolCallCacheMaxEntries,
    ttlMs: toolCallCacheTtlMs,
  });
  const streamedTranscriptWriter = createStreamedTranscriptWriter({
    provider: params.provider,
    session: params.transcriptSession ?? params.session,
  });

  const clearToolCallCache = () => toolCallNameCache.clear();
  const recordToolCall = (callId: string, toolName: string) => toolCallNameCache.record(callId, toolName);

  const publishSessionId = () => {
    params.onSessionIdChange?.(state.sessionId);
  };

  const attachMessageHandler = (b: AcpRuntimeBackend) => {
    attachAcpRuntimeMessageHandler({
      backend: b,
      provider: params.provider,
      directory: params.directory,
      session: params.session,
      messageBuffer: params.messageBuffer,
      mcpServers: params.mcpServers,
      permissionHandler: params.permissionHandler,
      hooks: params.hooks,
      createReplayBackend: params.createReplayBackend,
      onThinkingChange: params.onThinkingChange,
      toolCallNameCache,
      streamedTranscriptWriter,
      acpTraceMarkersEnabled,
      clearToolCallCache,
      recordToolCall,
      state,
    });
  };

  const ensureBackend = async (): Promise<AcpRuntimeBackend> => {
    if (state.backend) return state.backend;
    if (state.backendPromise) return await state.backendPromise;
    state.backendPromise = (async () => {
      const created = await params.ensureBackend();
      state.backend = created;
      attachMessageHandler(created);
      logger.debug(`[${params.provider}] ACP backend created`);
      return created;
    })();
    try {
      return await state.backendPromise;
    } finally {
      state.backendPromise = null;
    }
  };

  const lifecycleMethods = createAcpRuntimeLifecycleMethods({
    provider: params.provider,
    session: params.session,
    permissionHandler: params.permissionHandler,
    hooks: params.hooks,
    ensureBackend,
    createReplayBackend: params.createReplayBackend,
    publishSessionId,
    clearToolCallCache,
    state,
    inFlightSteerEnabled,
    acpTraceMarkersEnabled,
    pendingQueuePump,
    streamedTranscriptWriter,
    onThinkingChange: params.onThinkingChange,
  });

  const runtime: AcpRuntimeWithTurnOperations = {
    getSessionId: () => state.sessionId,
    supportsInFlightSteer: () => inFlightSteerEnabled,
    isTurnInFlight: () => state.turnInFlight,
    beginTurnLifecycle: () => {
      runtime.beginTurn();
    },
    async startOrLoadSession(opts) {
      await runtime.startOrLoad({
        resumeId: opts?.resumeId ?? null,
        ...(typeof opts?.importHistory === 'boolean' ? { importHistory: opts.importHistory } : {}),
      });
    },
    async sendTurnPrompt(prompt: string) {
      await runtime.sendPrompt(prompt);
    },
    async steerInFlightTurn(prompt: string) {
      await runtime.steerPrompt(prompt);
    },
    async waitForTurnCompletion() {
      await runtime.flushTurn();
    },
    subscribeRuntimeMessages() {
      return () => {};
    },
    async respondToPermission() {},
    async cancelTurn() {
      await runtime.cancel();
    },
    readSessionIdentity() {
      return { sessionId: runtime.getSessionId() };
    },
    async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
      if (typeof update.modeId === 'string') {
        await runtime.setSessionMode(update.modeId);
      }
      if (typeof update.modelId === 'string') {
        await runtime.setSessionModel(update.modelId);
      }
      if (update.configOption) {
        await runtime.setSessionConfigOption(update.configOption.id, update.configOption.value);
      }
    },
    async resetOrDisposeRuntime() {
      await runtime.reset();
    },
    beginTurn: lifecycleMethods.beginTurn,
    cancel: lifecycleMethods.cancel,
    reset: lifecycleMethods.reset,
    startOrLoad: lifecycleMethods.startOrLoad,
    setSessionMode: lifecycleMethods.setSessionMode,
    setSessionModel: lifecycleMethods.setSessionModel,
    setSessionConfigOption: lifecycleMethods.setSessionConfigOption,
    steerPrompt: lifecycleMethods.steerPrompt,
    sendPrompt: lifecycleMethods.sendPrompt,
    flushTurn: lifecycleMethods.flushTurn,
  };

  return runtime;
}
