import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessage, McpServerConfig } from '@/agent';
import type { CatalogAgentId } from '@/backends/types';
import type { AcpPermissionHandler, SessionConfigOption } from '@/agent/acp/AcpBackend';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
} from '@/agent/acp/bridge/acpCommonHandlers';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import { isThinkingToolName } from '@/agent/acp/bridge/thinkingToolCall';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import { importAcpReplaySidechainV1 } from '@/agent/acp/history/importAcpReplaySidechain';
import { abortPendingAcpPermissionRequests } from '@/agent/acp/backend/permissions/acpPermissionFinalization';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { extractAcpMediaContentBlocks } from '@/agent/acp/media/extractAcpMediaContentBlocks';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { isAbortLikeError } from '@/agent/executionRuns/runtime/turnDelivery';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentState, Metadata } from '@/api/types';
import {
  getAgentModelConfig,
  getAgentSessionModeDescriptor,
  readNewestSessionModelsMetadataStateV1,
  type AgentId,
} from '@happier-dev/agents';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { TurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import {
  createAcpSessionIdentityBinding,
  AcpSessionIdentityBindingError,
  type AcpSessionIdentityPublication,
  type AcpSessionOpenIntent,
} from '@/agent/acp/runtime/sessionIdentityBinding';
import {
  recordSessionTurnCompleted,
  surfacePrimarySessionRuntimeIssue,
} from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import {
  collectAcpModelScopedConfigOptions,
  normalizeConfigOptionsArray,
  publishAcpSessionModelsState,
} from '@/agent/acp/runtime/sessionModelsState';
import {
  isAcpModeConfigOptionLike,
  isAcpModelConfigOptionLike,
} from '@/agent/acp/configOptionChoiceNormalization';
import {
  computePendingSessionModeOverrideApplication,
} from '@/agent/runtime/permission/permissionModeFromMetadata';
import { createSessionProviderPendingDrainAdapter } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type {
  PendingMaterializationReconcileWhenEmpty,
  PendingMaterializationResult,
  SessionProviderInputConsumer,
} from '@/agent/runtime/sessionInput/types';
import { resolveSessionMediaDedupeKey } from '@/session/sessionMedia/sessionMediaDedupeKey';
import {
  SESSION_MEDIA_MESSAGE_META_KIND_V1,
  type SessionMediaItemV1,
  TranscriptRawAgentEventV1Schema,
  type TranscriptRawAgentEventV1,
} from '@happier-dev/protocol';

const DEFAULT_SESSION_CONTROL_TIMEOUT_MS = 15_000;

type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;
type RuntimeSessionMediaSource = RuntimeSessionMediaMessage['media'][number];
type RuntimeSessionMediaPersistResult = readonly SessionMediaItemV1[] | void;
type AcpPendingQueueCommon = {
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  maxPopPerWake?: number;
  drainDuringTurn?: boolean;
  drainAfterStartOrLoad?: boolean;
  pollIntervalMs?: number;
};
type AcpPendingQueueWithConsumer = AcpPendingQueueCommon & {
  inputConsumer: Pick<SessionProviderInputConsumer<never, never>, 'drainPending'>;
};
type AcpPendingQueueLegacyAdapter = AcpPendingQueueCommon & {
  inputConsumer?: undefined;
  popPendingMessage: () => Promise<boolean>;
  materializeNextPendingMessageSafely?: ((opts?: {
    reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
  }) => Promise<PendingMaterializationResult>) | undefined;
  shouldAttemptMaterialization?: (() => boolean) | undefined;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => Promise<unknown> | unknown) | undefined;
};
type AcpPendingQueue = AcpPendingQueueWithConsumer | AcpPendingQueueLegacyAdapter;

type SessionModelConfigUpdate = Readonly<{
  modelId: string;
  configUpdates?: ReadonlyArray<Readonly<{
    configId: string;
    value: string | number | boolean | null;
  }>>;
}> | null;

type SessionConfigOptionUpdate =
  | Readonly<{
    configId: string;
    value: string | number | boolean | null;
  }>
  | Readonly<{ modelId: string }>
  | null;

type DerivedSessionModelsFromConfigOptions = Readonly<{
  currentModelId: string;
  availableModels: ReadonlyArray<Readonly<{
    id: string;
    name: string;
    description?: string;
    modelOptions?: ReadonlyArray<SessionConfigOption>;
  }>>;
}>;

function resolveSessionControlTimeoutMs(): number {
  const raw = (process.env.HAPPIER_ACP_SESSION_CONTROL_TIMEOUT_MS ?? '').toString().trim();
  if (!raw) return DEFAULT_SESSION_CONTROL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_CONTROL_TIMEOUT_MS;
  return Math.trunc(parsed);
}

function normalizeSessionConfigOptionValue(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

function stringifySessionConfigOptionValue(value: string | number | boolean | null | undefined): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

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
  startOrLoad: (opts: { resumeId?: string | null; importHistory?: boolean; deferPendingDrain?: boolean }) => Promise<string>;
  /**
   * Drain post-start pending messages after callers have completed startup control synchronization.
   */
  drainPendingAfterStartOrLoad: () => Promise<void>;
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
  steerPrompt: (prompt: string, options?: AcpRuntimeSteerPromptOptions) => Promise<void>;
  compactContext: (command: string) => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  flushTurn: () => Promise<void>;
}>;

export type AcpRuntimeSteerPromptOptions = Readonly<{
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

function normalizeSteerPromptLocalIds(options: AcpRuntimeSteerPromptOptions | undefined): string[] {
  const values = [
    ...(typeof options?.localId === 'string' ? [options.localId] : []),
    ...(options?.localIds ?? []),
  ];
  const seen = new Set<string>();
  const localIds: string[] = [];
  for (const value of values) {
    const localId = typeof value === 'string' ? value.trim() : '';
    if (!localId || seen.has(localId)) continue;
    seen.add(localId);
    localIds.push(localId);
  }
  return localIds;
}

function normalizeSteerPromptSeqs(options: AcpRuntimeSteerPromptOptions | undefined): number[] {
  const values = [
    ...(typeof options?.userMessageSeq === 'number' ? [options.userMessageSeq] : []),
    ...(options?.userMessageSeqs ?? []),
  ];
  const seqs: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || seqs.includes(value)) continue;
    seqs.push(value);
  }
  return seqs;
}

function confirmSteerPromptDeliveredToProvider(
  session: AcpRuntimeSessionClient,
  options: AcpRuntimeSteerPromptOptions | undefined,
): void {
  if (typeof session.confirmUserMessageDeliveredToProvider !== 'function') return;
  const localIds = normalizeSteerPromptLocalIds(options);
  const seqs = normalizeSteerPromptSeqs(options);
  if (localIds.length === 0 && seqs.length === 0) return;
  const highestSeq = seqs.length === 0 ? null : Math.max(...seqs);
  session.confirmUserMessageDeliveredToProvider(highestSeq, {
    localIds: localIds.length === 0 ? null : localIds,
  });
}

export type AcpRuntimeBackend = Omit<AgentBackend, 'waitForResponseComplete'> & {
  waitForResponseComplete?: (timeoutMs?: number | null) => Promise<AcpTurnOutcome | void>;
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
   * Optional latest ACP session config options snapshot.
   */
  getSessionConfigOptionsState?: () => ReadonlyArray<SessionConfigOption> | null;
  /**
   * Optional: send additional user input into an already running turn.
   */
  sendSteerPrompt?: (sessionId: string, prompt: string, options?: AcpRuntimeSteerPromptOptions) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeContextCompactionPayload(payloadRecord: Record<string, unknown>): ACPMessageData | null {
  if (payloadRecord.type !== 'context-compaction') return null;

  const rawPhase = payloadRecord.phase;
  const legacyDetected = rawPhase === 'detected';
  const phase =
    rawPhase === 'started' ||
    rawPhase === 'progress' ||
    rawPhase === 'completed' ||
    rawPhase === 'failed' ||
    rawPhase === 'cancelled'
      ? rawPhase
      : legacyDetected
        ? 'completed'
        : null;
  if (!phase) return null;

  const source =
    payloadRecord.source === 'provider-event' ||
    payloadRecord.source === 'provider-status' ||
    payloadRecord.source === 'provider-hook' ||
    payloadRecord.source === 'transcript-inference' ||
    payloadRecord.source === 'user-command' ||
    payloadRecord.source === 'runtime'
      ? payloadRecord.source
      : legacyDetected
        ? 'transcript-inference'
        : undefined;
  const trigger =
    payloadRecord.trigger === 'manual' ||
    payloadRecord.trigger === 'auto' ||
    payloadRecord.trigger === 'threshold' ||
    payloadRecord.trigger === 'overflow' ||
    payloadRecord.trigger === 'unknown'
      ? payloadRecord.trigger
      : undefined;
  const tokenCountBefore = readFiniteNumber(payloadRecord.tokenCountBefore) ?? readFiniteNumber(payloadRecord.tokensBefore);
  const tokenCountAfter = readFiniteNumber(payloadRecord.tokenCountAfter) ?? readFiniteNumber(payloadRecord.tokensAfter);
  const retryAttempt = readFiniteNumber(payloadRecord.retryAttempt);
  const sanitizedErrorPreview = readNonEmptyString(payloadRecord.sanitizedErrorPreview) ?? readNonEmptyString(payloadRecord.errorMessage);
  const continuation = payloadRecord.continuation === 'paused' ? 'paused' : undefined;
  const pauseReason = payloadRecord.pauseReason === 'provider-idle-after-compaction' ? 'provider-idle-after-compaction' : undefined;

  const normalized: ACPMessageData = {
    type: 'context-compaction',
    phase,
    ...(readNonEmptyString(payloadRecord.lifecycleId) ? { lifecycleId: readNonEmptyString(payloadRecord.lifecycleId) } : {}),
    ...(readNonEmptyString(payloadRecord.provider) ? { provider: readNonEmptyString(payloadRecord.provider) } : {}),
    ...(readNonEmptyString(payloadRecord.backendId) ? { backendId: readNonEmptyString(payloadRecord.backendId) } : {}),
    ...(readNonEmptyString(payloadRecord.agentId) ? { agentId: readNonEmptyString(payloadRecord.agentId) } : {}),
    ...(trigger ? { trigger } : {}),
    ...(source ? { source } : {}),
    ...(readNonEmptyString(payloadRecord.providerEventId) ? { providerEventId: readNonEmptyString(payloadRecord.providerEventId) } : {}),
    ...(readNonEmptyString(payloadRecord.providerSessionId) ? { providerSessionId: readNonEmptyString(payloadRecord.providerSessionId) } : {}),
    ...(readNonEmptyString(payloadRecord.turnId) ? { turnId: readNonEmptyString(payloadRecord.turnId) } : {}),
    ...(tokenCountBefore !== undefined ? { tokenCountBefore } : {}),
    ...(tokenCountAfter !== undefined ? { tokenCountAfter } : {}),
    ...(readNonEmptyString(payloadRecord.tokenCountSource) ? { tokenCountSource: readNonEmptyString(payloadRecord.tokenCountSource) } : {}),
    ...(retryAttempt !== undefined ? { retryAttempt: Math.max(0, Math.trunc(retryAttempt)) } : {}),
    ...(readNonEmptyString(payloadRecord.errorCode) ? { errorCode: readNonEmptyString(payloadRecord.errorCode) } : {}),
    ...(sanitizedErrorPreview ? { sanitizedErrorPreview } : {}),
    ...(continuation ? { continuation } : {}),
    ...(pauseReason ? { pauseReason } : {}),
  };

  return normalized;
}

function parseConnectedServiceRuntimeAuthRecoveryEvent(
  payload: unknown,
): Extract<TranscriptRawAgentEventV1, { type: 'connected-service-runtime-auth-recovery' }> | null {
  const parsed = TranscriptRawAgentEventV1Schema.safeParse(payload);
  if (!parsed.success || parsed.data.type !== 'connected-service-runtime-auth-recovery') return null;
  return parsed.data;
}

export async function abortAcpRuntimeTurnIfNeeded(
  runtime: Pick<AcpRuntime, 'isTurnInFlight' | 'cancel'> | null | undefined,
): Promise<boolean> {
  if (!runtime) return false;
  if (runtime.isTurnInFlight() !== true) return false;
  await runtime.cancel();
  return true;
}

function resolveAcpPendingQueueInputConsumer(
  pendingQueue: AcpPendingQueue,
): Pick<SessionProviderInputConsumer<never, never>, 'drainPending'> {
  if ('inputConsumer' in pendingQueue && pendingQueue.inputConsumer) {
    return pendingQueue.inputConsumer;
  }

  return createSessionProviderPendingDrainAdapter({
    waitForMetadataUpdate: pendingQueue.waitForMetadataUpdate,
    popPendingMessage: pendingQueue.popPendingMessage,
    materializeNextPendingMessageSafely: pendingQueue.materializeNextPendingMessageSafely,
    shouldAttemptPendingMaterialization: pendingQueue.shouldAttemptMaterialization,
    reconcilePendingQueueState: pendingQueue.reconcilePendingQueueState,
  });
}

export function createAcpRuntime(params: {
  provider: string;
  directory: string;
  happierSessionId?: string;
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
  /** Explicit owner for vendor session identity persistence. */
  sessionIdentity: AcpSessionIdentityPublication;
  /**
   * Provider-owned projection from an opaque resume reference to the vendor
   * session id that a successful load must return. The provider still receives
   * the original reference; the generic identity binder remains strict.
   */
  resolveExpectedVendorSessionIdForResume?: (resumeReference: string) => string | null;
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
  /**
   * Optional pending-queue drain integration.
   *
   * Prefer `inputConsumer` for new callers. The legacy shape remains only as a compatibility
   * adapter for provider wrappers outside this generic ACP lane.
   */
  pendingQueue?: AcpPendingQueue;
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
  sessionMedia?: {
    persist: (message: RuntimeSessionMediaMessage) => Promise<RuntimeSessionMediaPersistResult> | RuntimeSessionMediaPersistResult;
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
  /**
   * Optional provider-owned resolver for translating user-facing/CLI model ids into
   * ACP-native config option values plus companion config updates.
   */
  resolveSessionModelConfigUpdate?: (params: Readonly<{
    modelId: string;
    configOptions: ReadonlyArray<SessionConfigOption> | null;
  }>) => SessionModelConfigUpdate;
  /**
   * Optional provider-owned derivation for ACP agents whose model config values encode
   * model-scoped parameters (for example Cursor's `gpt-5.5[reasoning=medium]` values).
   */
  deriveSessionModelsFromConfigOptions?: (
    configOptions: ReadonlyArray<SessionConfigOption>,
  ) => DerivedSessionModelsFromConfigOptions | null;
  /**
   * Optional provider-owned resolver for translating user-facing virtual config controls
   * into ACP-native config/model updates.
   */
  resolveSessionConfigOptionUpdate?: (params: Readonly<{
    configId: string;
    value: string | number | boolean | null;
    configOptions: ReadonlyArray<SessionConfigOption> | null;
  }>) => SessionConfigOptionUpdate;
  startupOverrides?: {
    mode?: { modeId: string; updatedAt?: number } | null;
    model?: { modelId: string; updatedAt?: number } | null;
  };
  turnAssistantPreviewTracker?: TurnAssistantPreviewTracker;
}): AcpRuntime {
  let backend: AcpRuntimeBackend | null = null;
  let backendPromise: Promise<AcpRuntimeBackend> | null = null;
  let sessionId: string | null = null;
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let taskStartedSent = false;
  let turnAborted = false;
  let pendingTurnOutcome: AcpTurnOutcome | null = null;
  let loadingSession = false;
  let turnInFlight = false;
  let currentTurnId: string | null = null;
  let turnMediaGeneration = 0;
  let startOrLoadFlight: Readonly<{ intentKey: string; promise: Promise<string> }> | null = null;
  let postStartPendingDrainFlight: Promise<void> | null = null;
  let startupDrainController: AbortController | null = null;
  let postStartDrainController: AbortController | null = null;
  let completedStartOrLoadIntentKey: string | null = null;
  let resetInProgress = false;
  let resetFlight: Promise<void> | null = null;
  let runtimeGeneration = 0;
  const assertRuntimeGeneration = (expectedGeneration: number): void => {
    if (runtimeGeneration === expectedGeneration) return;
    throw new AcpSessionIdentityBindingError(
      'ACP_SESSION_IDENTITY_STALE_GENERATION',
      'ACP session startup completed after the runtime generation was reset',
    );
  };
  const inFlightSteerEnabled = params.inFlightSteer?.enabled === true;
  const publishInFlightSteerCapabilities = (available: boolean): void => {
    const sessionWithAgentState = params.session as unknown as {
      updateAgentState?: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    };
    if (typeof sessionWithAgentState.updateAgentState !== 'function') return;
    // Lane P (O-design Seam A): publish WHY steering is unavailable. ACP availability tracks the
    // turn window, so enabled-but-unavailable is an unsafe window; disabled is backend-unsupported.
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
  let pendingPumpController: AbortController | null = null;
  const pendingQueueInputConsumer = params.pendingQueue
    ? resolveAcpPendingQueueInputConsumer(params.pendingQueue)
    : null;
  const persistedMediaDedupeKeys = new Set<string>();
  const pendingSessionMediaPersistPromises: Promise<void>[] = [];
  let persistedSessionMediaItems: SessionMediaItemV1[] = [];
  const identityBinding = createAcpSessionIdentityBinding({
    persistBound: params.sessionIdentity.kind === 'persist-bound'
      ? params.sessionIdentity.persistBound
      : async () => {},
  });

  const stopPendingPump = () => {
    if (!pendingPumpController) return;
    try {
      pendingPumpController.abort('acp-runtime:stop-pending-pump');
    } catch {
      // ignore
    }
    pendingPumpController = null;
  };

  const drainPendingMessagesOnce = async (controller?: AbortController): Promise<void> => {
    if (!params.pendingQueue || !pendingQueueInputConsumer) return;
    let result;
    try {
      result = await pendingQueueInputConsumer.drainPending({
        maxPopPerWake: params.pendingQueue.maxPopPerWake,
        abortSignal: controller?.signal,
        logPrefix: '[ACP]',
        reason: controller ? 'acp-pending-pump' : 'acp-start-or-load',
      });
    } catch (error) {
      logger.debug(`[${params.provider}] Pending queue drain failed (non-fatal)`, error);
      stopPendingPump();
      return;
    }
    if (result.stoppedReason === 'auth_failure') {
      stopPendingPump();
    }
  };

  const startPendingPumpIfNeeded = () => {
    if (!inFlightSteerEnabled) return;
    if (!params.pendingQueue) return;
    if (params.pendingQueue.drainDuringTurn !== true) return;
    if (pendingPumpController) return;

    const controller = new AbortController();
    pendingPumpController = controller;
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
      // Drain immediately once to avoid stranding already-enqueued pending messages while we wait
      // for a "metadata update" wake signal.
      await drainPendingMessagesOnce(controller);

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

        await drainPendingMessagesOnce(controller);
      }
    })().catch((error) => {
      logger.debug(`[${params.provider}] Pending queue pump stopped after non-fatal drain error`, error);
      stopPendingPump();
    });
  };

  const toolCallCacheMaxEntries = Math.max(1, params.toolCallCache?.maxEntries ?? 1_000);
  const toolCallCacheTtlMs = Math.max(1, params.toolCallCache?.ttlMs ?? 10 * 60_000);
  const toolNameByCallId = new Map<string, { toolName: string; createdAtMs: number }>();
  const toolCallIdQueue: string[] = [];
  const streamedTranscriptWriter = createStreamedTranscriptWriter({
    provider: params.provider,
    session: params.session,
  });
  let pendingTurnBoundaryStreamFlush: Promise<void> | null = null;

  const closeOpenStreamedTranscriptSegmentsBeforeTurn = () => {
    const boundaryFlush = streamedTranscriptWriter.flushAll({ reason: 'turn-end' }).then(
      () => undefined,
      (error) => {
        logger.debug(`[${params.provider}] Failed to flush streamed transcript segments at turn boundary (non-fatal)`, error);
      },
    );
    const trackedBoundaryFlush = boundaryFlush.finally(() => {
      if (pendingTurnBoundaryStreamFlush === trackedBoundaryFlush) {
        pendingTurnBoundaryStreamFlush = null;
      }
    });
    pendingTurnBoundaryStreamFlush = trackedBoundaryFlush;
  };

  const waitForPendingTurnBoundaryStreamFlush = async () => {
    await pendingTurnBoundaryStreamFlush;
  };

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

  const ensureCurrentTurnId = (): string => {
    if (!currentTurnId) currentTurnId = randomUUID();
    return currentTurnId;
  };

  const resetTurnState = () => {
    accumulatedResponse = '';
    isResponseInProgress = false;
    taskStartedSent = false;
    turnAborted = false;
    pendingTurnOutcome = null;
    currentTurnId = null;
    turnMediaGeneration += 1;
    pendingSessionMediaPersistPromises.length = 0;
    persistedSessionMediaItems = [];
    persistedMediaDedupeKeys.clear();
    params.turnAssistantPreviewTracker?.reset();
  };

  const rememberTurnOutcome = (outcome: AcpTurnOutcome | void): void => {
    if (!outcome) return;
    pendingTurnOutcome = outcome;
    if (outcome.kind !== 'completed') {
      turnAborted = true;
    }
  };

  const createRuntimeHandledTurnAbortError = (cause: unknown): Error => {
    const error = new Error(`${params.provider} ACP runtime turn aborted`);
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
  };

  const rethrowPromptError = (error: unknown): never => {
    if (turnAborted && !isAbortLikeError(error)) {
      throw createRuntimeHandledTurnAbortError(error);
    }
    throw error;
  };

  const filterNewSessionMedia = (items: readonly RuntimeSessionMediaSource[]): RuntimeSessionMediaSource[] => {
    const media: RuntimeSessionMediaSource[] = [];
    for (const item of items) {
      const dedupeKey = resolveSessionMediaDedupeKey(item);
      if (persistedMediaDedupeKeys.has(dedupeKey)) continue;
      persistedMediaDedupeKeys.add(dedupeKey);
      media.push(item);
    }
    return media;
  };

  const persistSessionMediaSources = async (
    source: string,
    items: readonly RuntimeSessionMediaSource[],
  ): Promise<SessionMediaItemV1[]> => {
    const media = filterNewSessionMedia(items);
    if (media.length === 0) return [];
    if (!params.sessionMedia) {
      logger.debug(`[${params.provider}] Session media emitted before media persister is wired; dropping transient sources`);
      return [];
    }
    const persisted = await Promise.resolve(params.sessionMedia.persist({ type: 'session-media', source, media }));
    return Array.isArray(persisted) ? [...persisted] : [];
  };

  const persistSessionMediaMessage = (msg: RuntimeSessionMediaMessage): void => {
    const generation = turnMediaGeneration;
    const persistPromise = persistSessionMediaSources(msg.source, msg.media)
      .then((items) => {
        if (generation !== turnMediaGeneration) return;
        if (items.length === 0) return;
        persistedSessionMediaItems.push(...items);
      })
      .catch((error) => {
        logger.debug(`[${params.provider}] Failed to persist session media (non-fatal)`, error);
      });
    pendingSessionMediaPersistPromises.push(persistPromise);
  };

  const drainPendingSessionMediaPersistence = async (): Promise<void> => {
    const pending = pendingSessionMediaPersistPromises.splice(0, pendingSessionMediaPersistPromises.length);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  };

  const buildSessionMediaEnvelope = (media: readonly SessionMediaItemV1[]): Record<string, unknown> => ({
    kind: SESSION_MEDIA_MESSAGE_META_KIND_V1,
    payload: {
      media,
    },
  });

  const buildSessionMediaMeta = (
    media: readonly SessionMediaItemV1[],
    existingMeta?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const envelope = buildSessionMediaEnvelope(media);
    const base = existingMeta ? { ...existingMeta } : {};
    if (base.happier !== undefined) {
      return {
        ...base,
        happierMedia: envelope,
      };
    }
    return {
      ...base,
      happier: envelope,
    };
  };

  const extractToolResultSessionMedia = (
    callId: string,
    result: unknown,
  ): RuntimeSessionMediaSource[] => {
    const candidates: unknown[] = [result];
    const record = asRecord(result);
    if (record) {
      if (record.output !== undefined) candidates.push(record.output);
      if (record.result !== undefined) candidates.push(record.result);
      if (record.content !== undefined) candidates.push(record.content);
    }

    const byDedupeKey = new Map<string, RuntimeSessionMediaSource>();
    for (const candidate of candidates) {
      const extracted = extractAcpMediaContentBlocks(candidate, {
        source: 'acp-tool-result',
        originSource: 'tool-output',
        toolCallId: callId,
        dedupePrefix: 'acp:tool-result',
      });
      for (const item of extracted.media) {
        byDedupeKey.set(resolveSessionMediaDedupeKey(item), item);
      }
    }
    return [...byDedupeKey.values()];
  };

  const forwardToolResultWithMedia = (
    msg: Extract<AgentMessage, { type: 'tool-result' }>,
    forward: (next: AgentMessage) => void,
  ): void => {
    const media = extractToolResultSessionMedia(msg.callId, msg.result);
    if (media.length === 0 || !params.sessionMedia) {
      forward(msg);
      return;
    }

    const forwardPromise = persistSessionMediaSources('acp-tool-result', media)
      .then((items) => {
        if (items.length === 0) {
          forward(msg);
          return;
        }
        forward({
          ...msg,
          meta: buildSessionMediaMeta(items, msg.meta),
        });
      })
      .catch((error) => {
        logger.debug(`[${params.provider}] Failed to persist tool-result session media (non-fatal)`, error);
        forward(msg);
      });
    pendingSessionMediaPersistPromises.push(forwardPromise);
  };

  const surfaceStatusError = (detailRaw: unknown) => {
    if (isAbortLikeError(detailRaw)) return false;
    const providerTurnId = currentTurnId ?? (turnInFlight ? ensureCurrentTurnId() : null);
    void (async () => {
      let compatibilityMarkerId = providerTurnId;
      if (turnInFlight && !taskStartedSent && params.session.sessionTurnLifecycle) {
        const handle = await params.session.sessionTurnLifecycle.beginTurn({
          provider: params.provider,
          ...(providerTurnId ? { providerTurnId } : {}),
        });
        compatibilityMarkerId = handle.turnId;
      }
      await surfacePrimarySessionRuntimeIssue({
        cause: 'status_error',
        provider: params.provider,
        providerTurnId,
        error: detailRaw,
        session: params.session,
      });
      if (turnInFlight && compatibilityMarkerId && params.session.sessionTurnLifecycle) {
        params.session.sendAgentMessage(params.provider, {
          type: 'turn_failed',
          id: compatibilityMarkerId,
        });
      }
    })().catch((error) => {
      logger.debug(`[${params.provider}] Failed to persist primary session runtime issue (non-fatal)`, error);
    });
    return true;
  };

  const attachMessageHandler = (b: AcpRuntimeBackend) => {
    const forwarder = createAcpAgentMessageForwarder({
      sendAcp: (provider, body, opts) => params.session.sendAgentMessage(provider, body, opts),
      provider: params.provider,
      makeId: () => randomUUID(),
    });

    b.onMessage((msg: AgentMessage) => {
      if (loadingSession) {
        if (msg.type === 'status' && msg.status === 'error') {
          turnAborted = true;
          if (!surfaceStatusError(msg.detail)) {
            params.session.sendAgentMessage(params.provider, { type: 'turn_aborted', id: ensureCurrentTurnId() });
          }
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
          params.turnAssistantPreviewTracker?.replace(accumulatedResponse);

          if (deltaRaw) {
            streamedTranscriptWriter.appendAssistantDelta(deltaRaw);
          }
          break;
        }

        case 'status': {
          if (msg.status === 'running') {
            if (turnInFlight) {
              handleAcpStatusRunning({
                session: params.session,
                agent: params.provider,
                getTaskStartedSent: () => taskStartedSent,
                setTaskStartedSent: (value) => { taskStartedSent = value; },
                makeId: () => ensureCurrentTurnId(),
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
          }

          if (msg.status === 'error') {
            const shouldSurfaceFailure = !turnAborted && !isAbortLikeError(msg.detail);
            void abortPendingAcpPermissionRequests(params.permissionHandler, 'ACP runtime status:error', (error) => {
              logger.debug(`[${params.provider}] Failed to abort pending permission requests after status:error`, error);
            });
            void streamedTranscriptWriter.flushAll({ reason: 'abort', interruptedReason: 'status-error' }).finally(() => {
              if (shouldSurfaceFailure) {
                surfaceStatusError(msg.detail);
              } else {
                params.session.sendAgentMessage(params.provider, { type: 'turn_aborted', id: ensureCurrentTurnId() });
              }
            });
            turnAborted = true;
            clearToolCallCache();
            params.onThinkingChange(false);
            params.session.keepAlive(false, 'remote');
          }
          if (msg.status === 'idle' && !turnInFlight) {
            params.onThinkingChange(false);
            params.session.keepAlive(false, 'remote');
          }
          break;
        }

        case 'tool-call': {
          if (isThinkingToolName(msg.toolName)) {
            forwarder.forward(msg);
            break;
          }

          void streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' });
          params.messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
          recordToolCall(msg.callId, msg.toolName);
          forwarder.forward(msg);
          break;
        }

        case 'tool-result': {
          const callId = msg.callId;
          evictToolCallCache(Date.now());
          const originToolName = toolNameByCallId.get(callId)?.toolName ?? msg.toolName;
          if (typeof originToolName === 'string' && isThinkingToolName(originToolName)) {
            forwarder.forward(msg);
            break;
          }
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
          forwardToolResultWithMedia(msg, (next) => forwarder.forward(next));

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
                    const created = await createCatalogAcpBackend(params.provider as CatalogAgentId, {
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

        case 'session-media': {
          persistSessionMediaMessage(msg);
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
          void streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' }).finally(() => {
            forwarder.forward(msg);
          });
          break;
        }

        case 'event': {
          const name = msg.name;
          if (name === 'connected-service-runtime-auth-recovery') {
            const recoveryEvent = parseConnectedServiceRuntimeAuthRecoveryEvent(msg.payload);
            if (recoveryEvent) {
              params.session.sendSessionEvent?.(recoveryEvent);
            }
          }
          if (name === 'context_compaction') {
            const payloadRecord = asRecord(msg.payload);
            const normalizedPayload = payloadRecord ? normalizeContextCompactionPayload(payloadRecord) : null;
            if (normalizedPayload) {
              params.session.sendAgentMessage(params.provider, normalizedPayload);
            }
          }
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
                (metadata) => {
                  const sessionModes = {
                    v: 1 as const,
                    provider: params.provider,
                    updatedAt: Date.now(),
                    currentModeId,
                    availableModes,
                  };
                  return {
                    ...metadata,
                    sessionModesV1: sessionModes,
                    acpSessionModesV1: sessionModes,
                  };
                },
                `[${params.provider}]`,
                'session_modes_state',
              );
            }
          }
          if (name === 'session_models_state') {
            publishAcpSessionModelsState({
              session: params.session,
              provider: params.provider,
              payload: msg.payload,
              logPrefix: `[${params.provider}]`,
              reason: 'session_models_state',
              requireAvailableModels: true,
            });
          }
          if (name === 'config_options_state' || name === 'config_options_update') {
            const payloadRecord = asRecord(msg.payload);
            const configOptions = normalizeConfigOptionsArray(payloadRecord?.configOptions);
            const derivedModels = (() => {
              const providerDerivedModels = params.deriveSessionModelsFromConfigOptions?.(configOptions) ?? null;
              if (providerDerivedModels) return providerDerivedModels;

              const modelOpt = configOptions.find(isAcpModelConfigOptionLike) as any;
              if (!modelOpt || !Array.isArray(modelOpt.options) || modelOpt.options.length === 0) return null;
              const modelScopedOptions = collectAcpModelScopedConfigOptions(configOptions);

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
                  ...(modelScopedOptions.length > 0 ? { modelOptions: modelScopedOptions } : {}),
                }))
                .filter((m: any) => m.id && m.name);
              if (availableModels.length === 0) return null;

              return { currentModelId, availableModels };
            })();
            const derivedModes = (() => {
              const modeOpt = configOptions.find(isAcpModeConfigOptionLike);
              if (!modeOpt || !Array.isArray(modeOpt.options) || modeOpt.options.length === 0) return null;

              const currentModeId = stringifySessionConfigOptionValue(modeOpt.currentValue);
              if (!currentModeId) return null;

              const availableModes = modeOpt.options
                .map((opt) => ({
                  id: stringifySessionConfigOptionValue(opt.value),
                  name: opt.name,
                  ...(typeof opt.description === 'string' ? { description: opt.description } : {}),
                }))
                .filter((mode) => mode.id && mode.name);
              if (availableModes.length === 0) return null;

              return { currentModeId, availableModes };
            })();

            updateMetadataBestEffort(
              params.session,
              (metadata) => {
                const now = Date.now();
                const next: any = {
                  ...metadata,
                  sessionConfigOptionsV1: {
                    v: 1,
                    provider: params.provider,
                    updatedAt: now,
                    configOptions,
                  },
                };
                next.acpConfigOptionsV1 = next.sessionConfigOptionsV1;

                if (derivedModels) {
                  next.sessionModelsV1 = {
                    v: 1,
                    provider: params.provider,
                    updatedAt: now,
                    currentModelId: derivedModels.currentModelId,
                    availableModels: derivedModels.availableModels,
                  };
                  next.acpSessionModelsV1 = next.sessionModelsV1;
                }
                if (derivedModes) {
                  const sessionModes = {
                    v: 1 as const,
                    provider: params.provider,
                    updatedAt: now,
                    currentModeId: derivedModes.currentModeId,
                    availableModes: derivedModes.availableModes,
                  };
                  next.sessionModesV1 = sessionModes;
                  next.acpSessionModesV1 = sessionModes;
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
                  const prev = metadata.sessionModesV1 ?? metadata.acpSessionModesV1;
                  const availableModes = Array.isArray(prev?.availableModes) ? prev.availableModes : [];
                  const sessionModes = {
                    v: 1 as const,
                    provider: params.provider,
                    updatedAt: Date.now(),
                    currentModeId,
                    availableModes,
                  };
                  return {
                    ...metadata,
                    sessionModesV1: sessionModes,
                    acpSessionModesV1: sessionModes,
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
                  const prev = readNewestSessionModelsMetadataStateV1(
                    metadata as unknown as Record<string, unknown>,
                  ) as Metadata['sessionModelsV1'] | null;
                  const availableModels = Array.isArray(prev?.availableModels) ? prev.availableModels : [];
                  const sessionModelsV1 = {
                    v: 1 as const,
                    provider: params.provider,
                    updatedAt: Date.now(),
                    currentModelId,
                    availableModels,
                  };
                  return {
                    ...metadata,
                    sessionModelsV1,
                    acpSessionModelsV1: sessionModelsV1,
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
              streamedTranscriptWriter.appendThinkingDelta(text);
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

  const resolveAcpModeConfigOptionId = (): string => {
    try {
      return getAgentSessionModeDescriptor(params.provider as AgentId).acpModeConfigOptionId ?? 'mode';
    } catch (error) {
      logger.debug(
        `[${params.provider}] Failed to resolve provider mode config option id; falling back to "mode"`,
        error
      );
      return 'mode';
    }
  };

  const resolveAcpModeSetMethod = (): 'set_mode' | 'config_option' => {
    try {
      const descriptor = getAgentSessionModeDescriptor(params.provider as AgentId);
      return descriptor.acpModeSetMethod
        ?? (descriptor.runtimeSwitch === 'acp-config-option' ? 'config_option' : 'set_mode');
    } catch (error) {
      logger.debug(
        `[${params.provider}] Failed to resolve provider mode set method; falling back to session/set_mode`,
        error
      );
      return 'set_mode';
    }
  };

  const applySessionModeControl = async (modeId: string): Promise<void> => {
    const normalizedModeId = typeof modeId === 'string' ? modeId.trim() : '';
    if (!normalizedModeId) return;
    if (!sessionId) {
      throw new Error(`${params.provider} ACP session was not started`);
    }

    const activeSessionId = sessionId;
    const b = await ensureBackend();
    const modeConfigOptionId = resolveAcpModeConfigOptionId();
    const modeSetMethod = resolveAcpModeSetMethod();

    if (modeSetMethod === 'config_option') {
      if (b.setSessionConfigOption) {
        await b.setSessionConfigOption(activeSessionId, modeConfigOptionId, normalizedModeId);
        return;
      }
      if (!b.setSessionMode) return;
    }

    if (b.setSessionMode) {
      const controlTimeoutMs = resolveSessionControlTimeoutMs();
      const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, error: new Error('ACP session/set_mode timed out') }),
          controlTimeoutMs,
        );
        timer.unref?.();
      });

      const outcome = await Promise.race([
        b
          .setSessionMode(activeSessionId, normalizedModeId)
          .then(() => ({ ok: true as const }))
          .catch((error) => ({ ok: false as const, error })),
        timeoutPromise,
      ]);
      if (outcome.ok) return;

      const e = outcome.error;
      if (!b.setSessionConfigOption) throw e;
      try {
        await b.setSessionConfigOption(activeSessionId, modeConfigOptionId, normalizedModeId);
        return;
      } catch {
        throw e;
      }
    }

    if (b.setSessionConfigOption) {
      await b.setSessionConfigOption(activeSessionId, modeConfigOptionId, normalizedModeId);
    }
  };

  const applySessionModelControl = async (modelId: string): Promise<void> => {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) return;
    if (!sessionId) {
      throw new Error(`${params.provider} ACP session was not started`);
    }
    const activeSessionId = sessionId;

    const controlTimeoutMs = resolveSessionControlTimeoutMs();
    const modelConfigOptionId = (() => {
      try {
        return getAgentModelConfig(params.provider as AgentId).acpModelConfigOptionId ?? null;
      } catch (error) {
        logger.debug(
          `[${params.provider}] Failed to resolve provider model config option id; config-option fallback is unavailable`,
          error
        );
        return null;
      }
    })();
    const modelSetMethod = (() => {
      try {
        return getAgentModelConfig(params.provider as AgentId).acpModelSetMethod ?? 'set_model';
      } catch (error) {
        logger.debug(
          `[${params.provider}] Failed to resolve provider model set method; falling back to session/set_model`,
          error
        );
        return 'set_model';
      }
    })();

    const b = await ensureBackend();
    const providerResolvedModelUpdate = params.resolveSessionModelConfigUpdate?.({
      modelId: normalizedModelId,
      configOptions: b.getSessionConfigOptionsState?.() ?? null,
    });
    if (providerResolvedModelUpdate === null) return;
    const resolvedModelUpdate = providerResolvedModelUpdate ?? { modelId: normalizedModelId };
    const resolvedModelId = typeof resolvedModelUpdate.modelId === 'string'
      ? resolvedModelUpdate.modelId.trim()
      : normalizedModelId;
    if (!resolvedModelId) return;
    const applyCompanionConfigUpdates = async (): Promise<void> => {
      if (!b.setSessionConfigOption) return;
      const updates = resolvedModelUpdate.configUpdates ?? [];
      for (const update of updates) {
        const configId = typeof update.configId === 'string' ? update.configId.trim() : '';
        if (!configId || configId === modelConfigOptionId) continue;
        const value = normalizeSessionConfigOptionValue(update.value);
        if (value === null) continue;
        await b.setSessionConfigOption(activeSessionId, configId, value);
      }
    };
    if (modelSetMethod === 'config_option') {
      if (b.setSessionConfigOption && modelConfigOptionId) {
        await b.setSessionConfigOption(activeSessionId, modelConfigOptionId, resolvedModelId);
        await applyCompanionConfigUpdates();
        return;
      }
      if (!b.setSessionModel) return;
    }

    if (b.setSessionModel) {
      const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, error: new Error('ACP session/set_model timed out') }),
          controlTimeoutMs,
        );
        timer.unref?.();
      });

      const outcome = await Promise.race([
        b
          .setSessionModel(activeSessionId, resolvedModelId)
          .then(() => ({ ok: true as const }))
          .catch((error) => ({ ok: false as const, error })),
        timeoutPromise,
      ]);
      if (outcome.ok) {
        await applyCompanionConfigUpdates();
        return;
      }

      const e = outcome.error;
      // Some ACP agents may not support `session/set_model` but may expose an equivalent
      // `model` config option. Fall back best-effort; callers already treat this as non-fatal.
      if (!b.setSessionConfigOption || !modelConfigOptionId) throw e;

      try {
        await b.setSessionConfigOption(activeSessionId, modelConfigOptionId, resolvedModelId);
        await applyCompanionConfigUpdates();
        return;
      } catch {
        // If the fallback also fails, surface the original error so callers can retry.
        throw e;
      }
    }

    if (b.setSessionConfigOption && modelConfigOptionId) {
      await b.setSessionConfigOption(activeSessionId, modelConfigOptionId, resolvedModelId);
      await applyCompanionConfigUpdates();
    }
  };

  const applyStartupModelOverride = async (): Promise<void> => {
    const explicitModelId = typeof params.startupOverrides?.model?.modelId === 'string'
      ? params.startupOverrides.model.modelId.trim()
      : '';
    // Metadata-owned model changes are applied by the runtime override synchronizer after
    // startOrLoad and before the pending queue drains. This path is only for an explicit
    // caller-owned startup override, and a rejection must remain observable to that caller.
    if (!explicitModelId || explicitModelId === 'default') return;
    await applySessionModelControl(explicitModelId);
  };

  const applyStartupModeOverride = async (): Promise<void> => {
    const explicitModeId = typeof params.startupOverrides?.mode?.modeId === 'string'
      ? params.startupOverrides.mode.modeId.trim()
      : '';
    const pendingMode = explicitModeId && explicitModeId !== 'default'
      ? { modeId: explicitModeId, updatedAt: params.startupOverrides?.mode?.updatedAt ?? 0 }
      : computePendingSessionModeOverrideApplication({
          metadata: params.session.getMetadataSnapshot?.() ?? null,
          lastAppliedUpdatedAt: 0,
        });
    if (!pendingMode) return;
    try {
      await applySessionModeControl(pendingMode.modeId);
    } catch (error) {
      logger.debug(`[${params.provider}] Failed to apply startup mode override before pending drain (non-fatal)`, error);
    }
  };

  return {
    getSessionId: () => sessionId,
    supportsInFlightSteer: () => inFlightSteerEnabled,
    isTurnInFlight: () => turnInFlight,

    beginTurn(): void {
      closeOpenStreamedTranscriptSegmentsBeforeTurn();
      turnInFlight = true;
      publishInFlightSteerCapabilities(true);
      turnAborted = false;
      resetTurnState();
      ensureCurrentTurnId();
      startPendingPumpIfNeeded();
      params.onThinkingChange(true);
      params.session.keepAlive(true, 'remote');
      try {
        params.hooks?.onBeginTurn?.();
      } catch (e) {
        logger.debug(`[${params.provider}] onBeginTurn hook failed (non-fatal)`, e);
      }
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      await streamedTranscriptWriter.flushAll({ reason: 'abort', interruptedReason: 'cancelled' });
      const b = await ensureBackend();
      try {
        await b.cancel(sessionId);
      } finally {
        await abortPendingAcpPermissionRequests(params.permissionHandler, 'ACP runtime cancelled', (error) => {
          logger.debug(`[${params.provider}] Failed to abort pending permission requests after cancel`, error);
        });
        if (turnInFlight && params.session.sessionTurnLifecycle) {
          const providerTurnId = currentTurnId ?? ensureCurrentTurnId();
          try {
            if (!taskStartedSent) {
              await params.session.sessionTurnLifecycle.beginTurn({
                provider: params.provider,
                providerTurnId,
              });
            }
            await params.session.sessionTurnLifecycle.cancelTurn({
              provider: params.provider,
              providerTurnId,
            });
          } catch (error) {
            logger.debug(`[${params.provider}] Failed to persist ACP runtime cancellation (non-fatal)`, error);
          }
        }
        // Cancel should behave like a turn boundary: don't keep steering/pending state alive.
        turnInFlight = false;
        publishInFlightSteerCapabilities(false);
        params.onThinkingChange(false);
        params.session.keepAlive(false, 'remote');
        stopPendingPump();
        clearToolCallCache();
      }
    },

    async reset(): Promise<void> {
      if (resetFlight) return await resetFlight;
      const operation = (async (): Promise<void> => {
        resetInProgress = true;
        const startupFlight = startOrLoadFlight?.promise ?? null;
        const deferredDrainFlight = postStartPendingDrainFlight;
        runtimeGeneration += 1;
        const identityReset = identityBinding.reset();
        startupDrainController?.abort('acp-runtime:generation-reset');
        postStartDrainController?.abort('acp-runtime:generation-reset');
        startOrLoadFlight = null;
        postStartPendingDrainFlight = null;
        completedStartOrLoadIntentKey = null;
        sessionId = null;
        turnInFlight = false;
        publishInFlightSteerCapabilities(false);
        resetTurnState();
        loadingSession = false;
        clearToolCallCache();
        stopPendingPump();
        params.onThinkingChange(false);
        params.session.keepAlive(false, 'remote');

        try {
          const backendCreation = backendPromise;
          if (backendCreation) {
            await backendCreation.catch(() => undefined);
          }
          if (backend) {
            try {
              await backend.dispose();
            } catch (e) {
              logger.debug(`[${params.provider}] Failed to dispose backend (non-fatal)`, e);
            }
            backend = null;
          }
          await identityReset;
          await startupFlight?.catch(() => undefined);
          await deferredDrainFlight?.catch(() => undefined);
        } finally {
          startupDrainController = null;
          postStartDrainController = null;
          resetInProgress = false;
        }
      })();
      resetFlight = operation;
      try {
        await operation;
      } finally {
        if (resetFlight === operation) resetFlight = null;
      }
    },

    async startOrLoad(opts: { resumeId?: string | null; importHistory?: boolean; deferPendingDrain?: boolean } = {}): Promise<string> {
      if (resetInProgress) {
        throw new AcpSessionIdentityBindingError(
          'ACP_SESSION_IDENTITY_RESET_REQUIRED',
          'Wait for the ACP runtime reset to complete before opening a session',
        );
      }
      const hasResumeIntent = typeof opts.resumeId === 'string';
      const resumeId = hasResumeIntent ? opts.resumeId!.trim() : '';
      const intentKey = hasResumeIntent ? `resume:${resumeId}` : 'create';
      if (startOrLoadFlight) {
        if (startOrLoadFlight.intentKey === intentKey) return await startOrLoadFlight.promise;
        throw new AcpSessionIdentityBindingError(
          'ACP_SESSION_IDENTITY_INTENT_CONFLICT',
          'A different ACP session open intent is already in progress',
        );
      }
      if (completedStartOrLoadIntentKey) {
        if (completedStartOrLoadIntentKey === intentKey && sessionId) return sessionId;
        throw new AcpSessionIdentityBindingError(
          'ACP_SESSION_IDENTITY_INTENT_CONFLICT',
          'The ACP runtime generation is already bound to a different session open intent',
        );
      }

      const operationPromise = (async (): Promise<string> => {
        const operationGeneration = runtimeGeneration;
        const importHistory = opts.importHistory === true;
        const intent: AcpSessionOpenIntent = hasResumeIntent
          ? {
              kind: 'resume',
              expectedVendorSessionId: params.resolveExpectedVendorSessionIdForResume
                ? params.resolveExpectedVendorSessionIdForResume(resumeId) ?? ''
                : resumeId,
            }
          : { kind: 'create' };
        const opened = await identityBinding.open({
          intent,
          openSession: async (identityContext) => {
            const b = await ensureBackend();
            identityContext.assertCurrent();
            if (!resumeId) return await b.startSession();
            if (!b.loadSession && !b.loadSessionWithReplayCapture) {
              throw new Error(`${params.provider} ACP backend does not support loading sessions`);
            }

            loadingSession = true;
            try {
              if (b.loadSessionWithReplayCapture && importHistory) {
                const loaded = await b.loadSessionWithReplayCapture(resumeId);
                return {
                  sessionId: loaded.sessionId,
                  replay: Array.isArray(loaded.replay) ? loaded.replay : null,
                };
              }
              if (b.loadSession) return await b.loadSession(resumeId);
              return await b.loadSessionWithReplayCapture!(resumeId);
            } finally {
              loadingSession = false;
            }
          },
        });
        assertRuntimeGeneration(operationGeneration);
        sessionId = opened.identity.vendorSessionId;

        if (resumeId) {
          const replay = Array.isArray(opened.result.replay) ? opened.result.replay : null;
          if (replay && importHistory) {
            await importAcpReplayHistoryV1({
              session: params.session,
              provider: params.provider,
              remoteSessionId: resumeId,
              replay: replay as unknown[],
              permissionHandler: params.permissionHandler,
            }).catch((e) => {
              logger.debug(`[${params.provider}] Failed to import replay history (non-fatal)`, e);
            });
            assertRuntimeGeneration(operationGeneration);
          }
        }

        await applyStartupModeOverride();
        assertRuntimeGeneration(operationGeneration);
        await applyStartupModelOverride();
        assertRuntimeGeneration(operationGeneration);
        if (params.pendingQueue?.drainAfterStartOrLoad === true && opts.deferPendingDrain !== true) {
          const controller = new AbortController();
          startupDrainController = controller;
          try {
            await drainPendingMessagesOnce(controller);
            assertRuntimeGeneration(operationGeneration);
          } finally {
            if (startupDrainController === controller) startupDrainController = null;
          }
        }
        assertRuntimeGeneration(operationGeneration);
        completedStartOrLoadIntentKey = intentKey;
        return opened.identity.vendorSessionId;
      })();
      startOrLoadFlight = { intentKey, promise: operationPromise };
      try {
        return await operationPromise;
      } finally {
        if (startOrLoadFlight?.promise === operationPromise) startOrLoadFlight = null;
      }
    },

    async drainPendingAfterStartOrLoad(): Promise<void> {
      if (params.pendingQueue?.drainAfterStartOrLoad !== true) return;
      if (postStartPendingDrainFlight) return await postStartPendingDrainFlight;
      if (!completedStartOrLoadIntentKey || !sessionId) return;

      const operationGeneration = runtimeGeneration;
      const controller = new AbortController();
      const operation = (async (): Promise<void> => {
        assertRuntimeGeneration(operationGeneration);
        await drainPendingMessagesOnce(controller);
        assertRuntimeGeneration(operationGeneration);
      })();
      postStartDrainController = controller;
      postStartPendingDrainFlight = operation;
      try {
        await operation;
      } finally {
        if (postStartDrainController === controller) postStartDrainController = null;
        if (postStartPendingDrainFlight === operation) postStartPendingDrainFlight = null;
      }
    },

    async setSessionMode(modeId: string): Promise<void> {
      await applySessionModeControl(modeId);
    },

    async setSessionModel(modelId: string): Promise<void> {
      await applySessionModelControl(modelId);
    },

    async setSessionConfigOption(configId: string, value: string | number | boolean | null): Promise<void> {
      const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
      if (!normalizedConfigId) return;
      const normalizedValue = normalizeSessionConfigOptionValue(value);
      if (normalizedValue === null) return;
      if (!sessionId) return;

      const b = await ensureBackend();
      const resolvedUpdate = params.resolveSessionConfigOptionUpdate?.({
        configId: normalizedConfigId,
        value: normalizedValue,
        configOptions: b.getSessionConfigOptionsState?.() ?? null,
      }) ?? { configId: normalizedConfigId, value: normalizedValue };
      if (resolvedUpdate === null) return;
      if ('modelId' in resolvedUpdate) {
        await applySessionModelControl(resolvedUpdate.modelId);
        return;
      }

      const resolvedConfigId = typeof resolvedUpdate.configId === 'string'
        ? resolvedUpdate.configId.trim()
        : '';
      if (!resolvedConfigId) return;
      const resolvedValue = normalizeSessionConfigOptionValue(resolvedUpdate.value);
      if (resolvedValue === null) return;
      if (!b.setSessionConfigOption) return;
      await b.setSessionConfigOption(sessionId, resolvedConfigId, resolvedValue);
    },

    async steerPrompt(prompt: string, options?: AcpRuntimeSteerPromptOptions): Promise<void> {
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
        if (options === undefined) {
          await b.sendSteerPrompt(sessionId, prompt);
        } else {
          await b.sendSteerPrompt(sessionId, prompt, options);
        }
        confirmSteerPromptDeliveredToProvider(params.session, options);
      } else {
        throw new Error(`${params.provider} ACP backend does not support in-flight steer`);
      }
    },

    async sendPrompt(prompt: string): Promise<void> {
      if (!sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      const b = await ensureBackend();
      try {
        await b.sendPrompt(sessionId, prompt);
        if (b.waitForResponseComplete) {
          rememberTurnOutcome(await b.waitForResponseComplete());
        }
      } catch (error) {
        rethrowPromptError(error);
      }
    },

    async compactContext(command: string): Promise<void> {
      if (!sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      const b = await ensureBackend();
      try {
        if (b.compactContext) {
          await b.compactContext(sessionId, command);
        } else {
          await b.sendPrompt(sessionId, command);
        }
        if (b.waitForResponseComplete) {
          rememberTurnOutcome(await b.waitForResponseComplete());
        }
      } catch (error) {
        rethrowPromptError(error);
      }
    },

    async flushTurn(): Promise<void> {
      await waitForPendingTurnBoundaryStreamFlush();
      await drainPendingSessionMediaPersistence();
      const sessionMediaMeta = persistedSessionMediaItems.length > 0
        ? buildSessionMediaMeta(persistedSessionMediaItems)
        : null;
      const attachedSessionMediaToAssistantRow = sessionMediaMeta
        ? streamedTranscriptWriter.mergeAssistantMeta(sessionMediaMeta)
        : false;
      await streamedTranscriptWriter.flushAll(
        turnAborted
          ? { reason: 'abort', interruptedReason: 'turn-aborted' }
          : { reason: 'turn-end' },
      );
      await abortPendingAcpPermissionRequests(
        params.permissionHandler,
        turnAborted ? 'ACP runtime turn aborted' : 'ACP runtime turn ended',
        (error) => {
          logger.debug(`[${params.provider}] Failed to abort pending permission requests at turn boundary`, error);
        },
      );
      if (sessionMediaMeta && !attachedSessionMediaToAssistantRow && !turnAborted) {
        await params.session.sendAgentMessageCommitted(
          params.provider,
          { type: 'message', message: '' },
          { localId: randomUUID(), meta: sessionMediaMeta },
        );
      }
      turnInFlight = false;
      publishInFlightSteerCapabilities(false);
      stopPendingPump();
      params.onThinkingChange(false);
      params.session.keepAlive(false, 'remote');
      if (pendingTurnOutcome && pendingTurnOutcome.kind !== 'completed') {
        const providerTurnId = ensureCurrentTurnId();
        if (!taskStartedSent && params.session.sessionTurnLifecycle) {
          await params.session.sessionTurnLifecycle.beginTurn({
            provider: params.provider,
            providerTurnId,
          });
        }
        const markerType = pendingTurnOutcome.kind === 'aborted' ? 'turn_cancelled' : 'turn_aborted';
        params.session.sendAgentMessage(params.provider, { type: markerType, id: providerTurnId });
        if (params.session.sessionTurnLifecycle) {
          await params.session.sessionTurnLifecycle.cancelTurn({
            provider: params.provider,
            providerTurnId,
          });
        }
      }
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

      if (!turnAborted) {
        const providerTurnId = ensureCurrentTurnId();
        if (!taskStartedSent && params.session.sessionTurnLifecycle) {
          await params.session.sessionTurnLifecycle.beginTurn({
            provider: params.provider,
            providerTurnId,
          });
        }
        params.session.sendAgentMessage(params.provider, { type: 'task_complete', id: providerTurnId });
        await recordSessionTurnCompleted({
          session: params.session,
          provider: params.provider,
          providerTurnId,
        });
      }

      resetTurnState();
    },
  };
}
