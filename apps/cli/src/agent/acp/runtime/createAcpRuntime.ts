import { logger } from '@/ui/logger';
import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { createBoundedToolCallNameCache } from './createBoundedToolCallNameCache';
import type {
  RuntimeTurnConfigUpdate,
  RuntimeTurnOperations,
  RuntimeTurnSessionOpenIntent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { RuntimeEventV1 } from '@happier-dev/protocol';
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
  compactContext: (command: string) => Promise<void>;
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

const CREATE_ACP_SESSION_INTENT: RuntimeTurnSessionOpenIntent = Object.freeze({
  kind: 'create',
});

export function createAcpRuntime(params: {
  provider: string;
  transcriptProvider?: string;
  directory: string;
  happierSessionId?: string;
  session: AcpRuntimeSessionClient;
  transcriptSession?: TranscriptSessionPort;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  ensureBackend: () => Promise<AcpRuntimeBackend>;
  sessionOpenIntent?: RuntimeTurnSessionOpenIntent;
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
    classifyRuntimeAuthFailure?: (params: {
      provider: string;
      happierSessionId: string | null;
      activeSessionId: string | null;
      error: unknown;
    }) => unknown | null | Promise<unknown | null>;
    onRuntimeAuthFailure?: (params: {
      provider: string;
      happierSessionId: string | null;
      activeSessionId: string | null;
      classification: unknown;
    }) => unknown | Promise<unknown>;
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
    currentRuntimeTurnId: null as string | null,
    currentTurnId: null as string | null,
    nextSessionOpenIntent: params.sessionOpenIntent ?? CREATE_ACP_SESSION_INTENT,
  };
  const runtimeEventSubscribers = new Set<(event: RuntimeEventV1) => void>();
  const readRuntimeSessionId = (): string => {
    const sessionId = typeof params.session.sessionId === 'string' ? params.session.sessionId.trim() : '';
    return sessionId || 'local-session';
  };
  const publishRuntimeEvent = (event: Omit<RuntimeEventV1, 'sessionId' | 'emittedAtMs'>): void => {
    if (runtimeEventSubscribers.size === 0) return;
    const payload = {
      ...event,
      sessionId: readRuntimeSessionId(),
      emittedAtMs: Date.now(),
    } as RuntimeEventV1;
    for (const subscriber of runtimeEventSubscribers) {
      subscriber(payload);
    }
  };
  const inFlightSteerEnabled = params.inFlightSteer?.enabled === true;
  const publishInFlightSteerCapabilities = (available: boolean): void => {
    const sessionWithAgentState = params.session as unknown as {
      updateAgentState?: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    };
    if (typeof sessionWithAgentState.updateAgentState !== 'function') return;
    // Seam A: publish WHY steering is unavailable. ACP availability tracks the turn window, so
    // enabled-but-unavailable is an unsafe window; disabled is backend-unsupported.
    const unavailableReason = !inFlightSteerEnabled
      ? 'backend_unsupported'
      : !available
        ? 'unsafe_window'
        : null;
    updateAgentStateBestEffort(
      { updateAgentState: sessionWithAgentState.updateAgentState.bind(sessionWithAgentState) },
      (state) => ({
        ...state,
        capabilities: {
          ...(state.capabilities ?? {}),
          inFlightSteer: inFlightSteerEnabled,
          inFlightSteerSupported: inFlightSteerEnabled,
          inFlightSteerAvailable: inFlightSteerEnabled && available,
          inFlightSteerUnavailableReason: unavailableReason,
          inFlightSteerStateAt: Date.now(),
        },
      }),
      `[${params.provider}]`,
      'in_flight_steer_capabilities',
    );
  };
  publishInFlightSteerCapabilities(false);
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
  const transcriptProvider = params.transcriptProvider ?? params.provider;

  const toolCallCacheMaxEntries = Math.max(1, params.toolCallCache?.maxEntries ?? 1_000);
  const toolCallCacheTtlMs = Math.max(1, params.toolCallCache?.ttlMs ?? 10 * 60_000);
  const toolCallNameCache = createBoundedToolCallNameCache({
    maxEntries: toolCallCacheMaxEntries,
    ttlMs: toolCallCacheTtlMs,
  });
  const streamedTranscriptWriter = createStreamedTranscriptWriter({
    provider: transcriptProvider,
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
      transcriptProvider,
      happierSessionId: params.happierSessionId ?? null,
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
      publishRuntimeEvent,
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
    transcriptProvider,
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
    streamedTranscriptWriter,
    onThinkingChange: params.onThinkingChange,
    publishRuntimeEvent,
  });
  const openSessionForNextUse = async (
    opts: Readonly<{
      resumeId?: string | null;
      importHistory?: boolean;
      currentPromptText?: string | null;
    }>,
  ): Promise<string> => {
    const sessionId = await lifecycleMethods.openSession(opts);
    state.nextSessionOpenIntent = CREATE_ACP_SESSION_INTENT;
    return sessionId;
  };

  const runtime: AcpRuntimeWithTurnOperations = {
    getSessionId: () => state.sessionId,
    supportsInFlightSteer: () => inFlightSteerEnabled,
    isTurnInFlight: () => state.turnInFlight,
    beginTurnLifecycle: () => {
      runtime.beginTurn();
    },
    async sendTurnPrompt(prompt: string) {
      if (runtime.getSessionId() === null) {
        const intent = state.nextSessionOpenIntent;
        await openSessionForNextUse(intent.kind === 'resume'
          ? {
              resumeId: intent.providerSessionId,
              importHistory: intent.importHistory,
              currentPromptText: prompt,
            }
          : {
              resumeId: null,
              currentPromptText: prompt,
            });
      }
      await runtime.sendPrompt(prompt);
    },
    async steerInFlightTurn(prompt: string) {
      await runtime.steerPrompt(prompt);
    },
    async waitForTurnCompletion() {
      await runtime.flushTurn();
    },
    subscribeRuntimeEvents(handler) {
      const runtimeEventHandler = (event: RuntimeEventV1): void => {
        handler(event);
      };
      runtimeEventSubscribers.add(runtimeEventHandler);
      return () => {
        runtimeEventSubscribers.delete(runtimeEventHandler);
      };
    },
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
    async resetOrDisposeRuntime(_reason, nextSessionOpenIntent) {
      await runtime.reset();
      state.nextSessionOpenIntent = nextSessionOpenIntent ?? CREATE_ACP_SESSION_INTENT;
    },
    beginTurn: () => {
      publishInFlightSteerCapabilities(true);
      lifecycleMethods.beginTurn();
    },
    cancel: async () => {
      try {
        await lifecycleMethods.cancel();
      } finally {
        publishInFlightSteerCapabilities(false);
      }
    },
    reset: async () => {
      try {
        await lifecycleMethods.reset();
        state.nextSessionOpenIntent = CREATE_ACP_SESSION_INTENT;
      } finally {
        publishInFlightSteerCapabilities(false);
      }
    },
    setSessionMode: lifecycleMethods.setSessionMode,
    setSessionModel: lifecycleMethods.setSessionModel,
    setSessionConfigOption: lifecycleMethods.setSessionConfigOption,
    steerPrompt: lifecycleMethods.steerPrompt,
    compactContext: lifecycleMethods.compactContext,
    sendPrompt: lifecycleMethods.sendPrompt,
    flushTurn: async () => {
      try {
        await lifecycleMethods.flushTurn();
      } finally {
        publishInFlightSteerCapabilities(false);
      }
    },
  };

  return runtime;
}
