import {
  createSessionRuntimeActivityPublisher,
  type ManagedServerSnapshotV1,
  type PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { publishOpenCodeNativeTodosWorkState } from '../workState.js';
import {
  createOpenCodeConnectedServiceRuntimeAuthAdapter,
  resolveOpenCodeRuntimeAuthSelection,
} from '../../auth/services/runtime/failure.js';
import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import {
  buildOpenCodeRuntimeIssue,
  publishOpenCodeTurnCancelled,
  publishOpenCodeRuntimeEvent,
  publishOpenCodeTurnFailed,
} from './openCodeRuntimeEvents.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerClient, isOpenCodeServerAuthFailure } from './openCodeServerClient.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import {
  openCodeBackgroundTaskWakeIndicatesAllTasksComplete,
  openCodeToolPartLooksLikeBackgroundTaskLaunch,
  readOpenCodeBackgroundTaskWakeSource,
  readOpenCodeBackgroundTaskLaunchRuntimeSourceId,
  readOpenCodeBackgroundTaskWakeRuntimeSourceId,
  openCodeToolPartLooksLikeBackgroundOutputContinuation,
} from './openCodeBackgroundTaskSignals.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import type { OpenCodeToolPart } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import { createOpenCodeProviderActivityTracker } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import {
  refreshOpenCodeProviderActivityFromHistory,
  refreshOpenCodeProviderActivityFromHistoryMessages,
} from './providerActivity/history.js';
import {
  resolveOpenCodeManagedServerGenerationIdentity,
  type OpenCodeManagedServerGenerationIdentity,
} from './providerActivity/managedServerGeneration.js';
import {
  OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
  createOpenCodeManagedServerTurnInterruptionSupervisor,
} from './providerActivity/managedServerTurnInterruptionSupervisor.js';
import { attachOpenCodeProviderEventSubscriptionIfNeeded } from './providerEvents.js';
import {
  buildOpenCodePermissionDecisionRequest,
  mapOpenCodePermissionDecisionToReply,
  readOpenCodePermissionAsk,
  readOpenCodePermissionReplyMessage,
} from './permissionBridge.js';
import type { OpenCodePromptModel } from './promptConfig.js';
import { normalizeOpenCodePromptConfigUpdate } from './promptConfig.js';
import { maybeFailOnOpenCodeRetryStatus } from './retryFailure.js';
import { publishOpenCodeProviderSessionId } from './sessionIdentity.js';
import {
  createOpenCodeServerRuntimeState,
  createOpenCodeTurnId,
  claimOpenCodeActiveTurnForTerminalEvent,
  readEventSessionId,
  readOpenCodeToolCallKey,
  readOpenCodeToolPart,
  readProviderEvent,
  readStatusType,
  recordOpenCodeProviderAutonomousBackgroundWake,
} from './state.js';
import {
  classifyOpenCodeAssistantCompletion,
  classifyOpenCodeMessageForProjection,
  extractOpenCodeProjectedText,
} from './transcript/projection/index.js';
import { publishOpenCodeToolPartRuntimeEvents } from './toolEvents.js';
import {
  buildOpenCodeProviderSessionMessageKey,
  buildOpenCodeRuntimeTranscriptLocalId,
} from './transcript/identity.js';
import { completeOpenCodeTurnIfReady } from './turnCompletion.js';
import { beginOpenCodeProviderAutonomousBackgroundTurnIfNeeded } from './turnStart.js';
import { createOpenCodeHappierAuthoredProviderUserMessageIds } from './happierAuthoredProviderUserMessages.js';

const OPEN_CODE_IDLE_ASSISTANT_HISTORY_GRACE_MS = 60_000;
const OPEN_CODE_HISTORY_FINALITY_INITIAL_BACKOFF_MS = 250;
const OPEN_CODE_HISTORY_FINALITY_MAX_BACKOFF_MS = 2_000;

function readOpenCodeProviderErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return normalizeString(data?.message)
    || normalizeString(record?.message)
    || normalizeString(record?.name);
}

function readOpenCodeProviderErrorStatus(error: unknown): number | null {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const status = record?.status ?? data?.status ?? record?.statusCode ?? data?.statusCode;
  if (typeof status === 'number' && Number.isFinite(status)) return Math.trunc(status);
  const normalized = normalizeString(status);
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function openCodeProviderSessionErrorLooksAuthFailure(params: Readonly<{
  error: unknown;
  formattedMessage: string;
}>): boolean {
  const status = readOpenCodeProviderErrorStatus(params.error);
  if (status === 401 || status === 403) return true;
  const record = asRecord(params.error);
  const data = asRecord(record?.data);
  const haystack = [
    normalizeString(record?.name),
    normalizeString(data?.name),
    normalizeString(record?.code),
    normalizeString(data?.code),
    readOpenCodeProviderErrorMessage(params.error),
    params.formattedMessage,
  ].filter((value): value is string => Boolean(value)).join('\n').toLowerCase();
  return /\b(401|403|unauthori[sz]ed|forbidden|auth|credential|token refresh failed)\b/u.test(haystack);
}

function normalizeOpenCodePromptResponseMessages(response: unknown): readonly unknown[] {
  if (Array.isArray(response)) return response;
  const record = asRecord(response);
  if (!record) return [];
  const messages = record.messages;
  if (Array.isArray(messages)) return messages;
  const message = record.message;
  if (message !== undefined && message !== null) {
    const nested = normalizeOpenCodePromptResponseMessages(message);
    if (nested.length > 0) return nested;
  }
  const projection = classifyOpenCodeMessageForProjection(response);
  return projection.kind === 'unknown' ? [] : [response];
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createOpenCodeServerRuntimeController(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  baseUrl: string;
  client?: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  readManagedServerSnapshot?: () => ManagedServerSnapshotV1 | null | undefined;
  setThinking?: (thinking: boolean) => void;
}>): OpenCodeRuntimeTurnOperations {
  const client = params.client ?? createOpenCodeServerClient({
    fetch: params.ctx.fetch,
    baseUrl: params.baseUrl,
    directory: params.directory,
  });
  const state = createOpenCodeServerRuntimeState();
  const providerActivityTracker = createOpenCodeProviderActivityTracker();
  const runtimeActivityPublisher = createSessionRuntimeActivityPublisher({
    session: params.ctx.sessions.current,
  });
  const runtimeAuthAdapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();
  const messageHandlers = new Set<(message: RuntimeEventV1) => void>();
  const accumulatedBackgroundWakeTextByPartKey = new Map<string, string>();
  const handledPermissionRequestKeys = new Set<string>();
  const pendingPermissionRequestKeys = new Set<string>();
  const pendingPermissionDecisionAbortControllers = new Set<AbortController>();
  let currentTurnPermissionRejectionMessage: string | null = null;
  // Lane H/S2: in-memory dedupe gate for externally-authored (e.g. OpenCode TUI) user messages
  // mirrored into the Happier transcript while no Happier turn is active. Assistant dedupe reuses the
  // existing `state.emittedAssistantMessageIds`. Both pair with deterministic provider-session/message
  // localIds so a re-mirror after reconnect/resume cannot duplicate (server-side localId dedupe).
  const observedExternalUserMessageIds = new Set<string>();
  const happierAuthoredProviderUserMessageIds = createOpenCodeHappierAuthoredProviderUserMessageIds({
    ctx: params.ctx,
    readProviderSessionId: () => state.providerSessionId,
  });
  let passiveTranscriptProjectionInFlight = false;
  let passiveTranscriptProjectionRerunRequested = false;
  let promptModel: OpenCodePromptModel | null = null;
  let serverConnectedDeferred = createDeferred<void>();
  let serverConnectedGenerationKey: string | null = null;
  let historyFinalityNextPollingReadAtMs = 0;
  let historyFinalityPollingBackoffMs = 0;

  function publishRuntimeActivityUpdate(promise: Promise<void>, reason: string): void {
    void promise.catch((error) => {
      params.ctx.logger.debug(`[OpenCodeServer] failed to publish runtime activity ${reason}`, { error });
    });
  }

  function publishDetachedRuntimeActivity(sourceId: string): void {
    publishRuntimeActivityUpdate(
      runtimeActivityPublisher.markSourceActive({
        sourceId,
        sourceKind: 'provider_detached_task',
      }),
      'opencode_detached_task_active',
    );
  }

  function clearDetachedRuntimeActivity(sourceId: string | null, reason: string): void {
    publishRuntimeActivityUpdate(
      sourceId
        ? runtimeActivityPublisher.clearSource(sourceId)
        : runtimeActivityPublisher.clearAllSources(),
      reason,
    );
  }

  const markProviderUserMessageAsHappierAuthored = async (messageId: string): Promise<void> => {
    await happierAuthoredProviderUserMessageIds.add(messageId);
  };

  // --- Lane E: generation-aware managed-server crash recovery -------------------------------------
  // `../dev` has no in-place restart and no client-side identity-change event; the generic host owns
  // the managed server and the plugin observes it via `readManagedServerSnapshot`. The runtime derives
  // a generation identity from the snapshot and polls it at completion/status points; a mid-turn
  // generation change with unreconciled live-known tool work fails the turn exactly once.
  const readManagedServerGenerationIdentity = (): OpenCodeManagedServerGenerationIdentity | null => {
    const snapshot = params.readManagedServerSnapshot?.();
    if (!snapshot) return null;
    return resolveOpenCodeManagedServerGenerationIdentity(snapshot);
  };

  const wakeServerConnectedWaiters = (): void => {
    const deferred = serverConnectedDeferred;
    serverConnectedDeferred = createDeferred<void>();
    deferred.resolve();
  };

  const resetServerConnectedReadiness = (): void => {
    serverConnectedGenerationKey = null;
    wakeServerConnectedWaiters();
  };

  const readManagedServerGenerationForReadiness = (): OpenCodeManagedServerGenerationIdentity | null => {
    const identity = readManagedServerGenerationIdentity();
    if (!identity) return null;
    if (
      serverConnectedGenerationKey !== null
      && serverConnectedGenerationKey !== identity.generationKey
    ) {
      resetServerConnectedReadiness();
    }
    return identity;
  };

  const markServerConnected = (): void => {
    serverConnectedGenerationKey = readManagedServerGenerationIdentity()?.generationKey ?? null;
    wakeServerConnectedWaiters();
  };

  const markServerReadinessUnavailableFallback = (error: unknown): void => {
    const identity = readManagedServerGenerationForReadiness();
    if (!identity) return;
    params.ctx.logger.debug('[OpenCodeServer] provider event subscription unavailable before server.connected; falling back to managed-server health readiness', {
      error,
      managedServerGenerationKey: identity.generationKey.slice(0, 12),
    });
    serverConnectedGenerationKey = identity.generationKey;
    wakeServerConnectedWaiters();
  };

  const waitForServerConnectedBeforePrompt = async (turnId: string): Promise<boolean> => {
    for (;;) {
      const identity = readManagedServerGenerationForReadiness();
      if (!identity) return true;
      if (serverConnectedGenerationKey === identity.generationKey) return true;
      if (state.disposed || !state.turnInFlight || state.activeTurnId !== turnId) return false;
      await serverConnectedDeferred.promise;
    }
  };

  const publishMessage = (message: RuntimeEventV1): void => {
    for (const handler of messageHandlers) handler(message);
  };

  const modelIsSelectable = (input: Readonly<{
    providerID: string;
    modelID: string;
    modelRecord?: unknown;
  }>): boolean => {
    const providerID = normalizeString(input.providerID);
    const modelID = normalizeString(input.modelID);
    if (!providerID || !modelID) return false;
    const modelRecord = asRecord(input.modelRecord);
    if (!modelRecord) return true;
    const status = normalizeString(modelRecord.status);
    if (status && status !== 'active') return false;
    const capabilities = asRecord(modelRecord.capabilities);
    const inputCapabilities = asRecord(capabilities?.input);
    if (inputCapabilities?.text === false) return false;
    return true;
  };

  const findModelForProvider = (
    providers: Awaited<ReturnType<OpenCodeServerClient['providersList']>>,
    providerID: string,
    modelID: string,
  ): OpenCodePromptModel | null => {
    const normalizedProviderId = normalizeString(providerID);
    const normalizedModelId = normalizeString(modelID);
    if (!normalizedProviderId || !normalizedModelId) return null;
    const provider = providers.find((entry) => normalizeString(entry.id) === normalizedProviderId);
    const models = asRecord(provider?.models);
    if (!models) {
      return modelIsSelectable({ providerID: normalizedProviderId, modelID: normalizedModelId })
        ? { providerID: normalizedProviderId, modelID: normalizedModelId }
        : null;
    }
    const modelRecord = models[normalizedModelId]
      ?? Object.values(models).find((candidate) => normalizeString(asRecord(candidate)?.id) === normalizedModelId);
    if (!modelRecord) return null;
    const resolvedModelId = normalizeString(asRecord(modelRecord)?.id) || normalizedModelId;
    return modelIsSelectable({ providerID: normalizedProviderId, modelID: resolvedModelId, modelRecord })
      ? { providerID: normalizedProviderId, modelID: resolvedModelId }
      : null;
  };

  const readDefaultProviderIdFromModelId = (modelId: unknown): string => {
    const trimmed = normalizeString(modelId);
    const separatorIndex = trimmed.indexOf('/');
    if (separatorIndex <= 0) return '';
    return trimmed.slice(0, separatorIndex);
  };

  const resolvePromptModel = async (modelId: string): Promise<OpenCodePromptModel | null> => {
    const parsed = normalizeOpenCodePromptConfigUpdate({ modelId });
    if (parsed.model || !parsed.hasModel) return parsed.model;
    const trimmed = normalizeString(modelId);
    if (!trimmed || trimmed === 'default') return null;
    const [config, providers] = await Promise.all([
      client.globalConfigGet().catch(() => ({})),
      client.providersList().catch(() => []),
    ]);
    const defaultProviderId = readDefaultProviderIdFromModelId(asRecord(config)?.model);
    const defaultProviderMatch = defaultProviderId
      ? findModelForProvider(providers, defaultProviderId, trimmed)
      : null;
    if (defaultProviderMatch) return defaultProviderMatch;
    const matches = providers
      .map((provider) => findModelForProvider(providers, provider.id, trimmed))
      .filter((candidate): candidate is OpenCodePromptModel => candidate !== null);
    return matches.length === 1 ? matches[0] : null;
  };

  const publishRuntimeEvent = (event: RuntimeEventV1): void => {
    publishMessage(event);
  };

  const setThinking = (thinking: boolean): void => {
    params.setThinking?.(thinking);
  };

  const abortPendingPermissionDecisions = (reason: string): void => {
    if (pendingPermissionDecisionAbortControllers.size === 0) return;
    const abortReason = new Error(reason);
    for (const controller of pendingPermissionDecisionAbortControllers) {
      if (!controller.signal.aborted) controller.abort(abortReason);
    }
    pendingPermissionDecisionAbortControllers.clear();
  };

  const createTurnScopedPermissionDecisionSignal = (): Readonly<{
    signal: AbortSignal;
    isAborted(): boolean;
    dispose(): void;
  }> => {
    const controller = new AbortController();
    pendingPermissionDecisionAbortControllers.add(controller);
    const signal = params.ctx.abort.compose([params.ctx.abort.signal, controller.signal]);
    return {
      signal,
      isAborted: () => signal.aborted || controller.signal.aborted,
      dispose() {
        pendingPermissionDecisionAbortControllers.delete(controller);
      },
    };
  };

  const restartCurrentTurnAssistantHistoryGrace = (): void => {
    if (!state.turnInFlight || !state.activeTurnId) return;
    state.currentTurnPromptAcceptedAtMs = Date.now();
  };

  const resetCurrentTurnObservations = (): void => {
    abortPendingPermissionDecisions('OpenCode turn no longer owns pending permission decisions');
    state.currentTurnObservedMessageIds.clear();
    state.currentTurnObservedToolCallKeys.clear();
    state.currentTurnPublishedToolCallKeys.clear();
    state.currentTurnPublishedToolResultKeys.clear();
    state.currentTurnProviderUserMessageIds.clear();
    state.currentTurnProviderPromptTexts.clear();
    state.currentTurnPromptSubmittedAtMs = null;
    state.currentTurnPromptAcceptedAtMs = null;
    state.currentTurnPublishedAssistantMessageIds.clear();
    pendingPermissionRequestKeys.clear();
    currentTurnPermissionRejectionMessage = null;
    historyFinalityNextPollingReadAtMs = 0;
    historyFinalityPollingBackoffMs = 0;
  };

  const observeCurrentTurnMessageId = (messageId: string): void => {
    if (!state.turnInFlight || !messageId) return;
    state.currentTurnObservedMessageIds.add(messageId);
  };

  const observeCurrentTurnToolPart = (part: OpenCodeToolPart): void => {
    if (!state.turnInFlight) return;
    if (part.messageID) state.currentTurnObservedMessageIds.add(part.messageID);
    state.currentTurnObservedToolCallKeys.add(readOpenCodeToolCallKey(part));
  };

  const publishNativeTodosWorkState = async (): Promise<void> => {
    await publishOpenCodeNativeTodosWorkState({
      ctx: params.ctx,
      client,
      providerSessionId: state.providerSessionId,
    });
  };

  const refreshProviderActivityFromHistory = async (): Promise<void> => {
    await refreshOpenCodeProviderActivityFromHistory({
      client,
      state,
      tracker: providerActivityTracker,
    });
  };

  const refreshProviderActivityFromHistoryMessages = (messages: readonly unknown[]): void => {
    refreshOpenCodeProviderActivityFromHistoryMessages({
      messages,
      state,
      tracker: providerActivityTracker,
    });
  };

  const readProjectedTranscriptText = (message: unknown): string => {
    const record = asRecord(message);
    if (!record) return '';
    const contentText = normalizeString(record.content);
    return contentText || extractOpenCodeProjectedText(
      Array.isArray(record.parts) ? record.parts : [],
      { context: 'direct_transcript' },
    );
  };

  const publishObservedToolPartsFromCurrentTurnHistoryMessage = (
    parts: readonly unknown[],
  ): void => {
    for (const rawPart of parts) {
      const part = readOpenCodeToolPart(rawPart);
      if (!part) continue;
      providerActivityTracker.observeToolPart({
        part,
        source: 'history',
        partId: normalizeString(asRecord(rawPart)?.id) || null,
      });
      observeCurrentTurnToolPart(part);
      publishOpenCodeToolPartRuntimeEvents({
        part,
        state,
        happierSessionId: params.happierSessionId,
        publishRuntimeEvent,
      });
    }
  };

  const providerUserMessageMatchesCurrentPrompt = (message: unknown): boolean => {
    if (state.currentTurnProviderPromptTexts.size === 0) return false;
    const text = readProjectedTranscriptText(message);
    if (!text) return false;
    for (const promptText of state.currentTurnProviderPromptTexts) {
      if (promptText && text.includes(promptText)) return true;
    }
    return false;
  };

  const providerUserMessageHasCurrentTurnPromptTimestamp = (
    projection: ReturnType<typeof classifyOpenCodeMessageForProjection>,
  ): boolean => {
    const submittedAtMs = state.currentTurnPromptSubmittedAtMs;
    return submittedAtMs !== null
      && projection.createdAtMs > 0
      && projection.createdAtMs >= submittedAtMs;
  };

  type CurrentProviderUserMessageAnchor = Readonly<{
    index: number;
    source: 'message_id' | 'prompt_text_timestamp';
  }>;

  const resolveCurrentProviderUserMessageAnchor = (
    messages: readonly unknown[],
  ): CurrentProviderUserMessageAnchor | null => {
    let promptFallback: CurrentProviderUserMessageAnchor | null = null;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const projection = classifyOpenCodeMessageForProjection(message);
      if (projection.kind !== 'user_transcript') continue;
      const messageIdMatchesCurrentTurn = Boolean(
        projection.messageId && state.currentTurnProviderUserMessageIds.has(projection.messageId),
      );
      if (messageIdMatchesCurrentTurn) return { index, source: 'message_id' };
      if (
        providerUserMessageMatchesCurrentPrompt(message)
        && providerUserMessageHasCurrentTurnPromptTimestamp(projection)
      ) {
        promptFallback = { index, source: 'prompt_text_timestamp' };
      }
    }
    return promptFallback;
  };

  const markCurrentProviderUserMessageFromHistoryBestEffort = async (
    reason: string,
  ): Promise<void> => {
    if (!state.turnInFlight || !state.providerSessionId) return;
    if (state.currentTurnProviderUserMessageIds.size > 0) return;
    let messages: readonly unknown[];
    try {
      messages = await client.sessionMessages({ sessionId: state.providerSessionId });
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] failed to mark current provider user message before terminal turn', {
        error,
        reason,
      });
      return;
    }
    const anchor = resolveCurrentProviderUserMessageAnchor(messages);
    if (!anchor) return;
    const projection = classifyOpenCodeMessageForProjection(messages[anchor.index]);
    if (projection.kind !== 'user_transcript' || !projection.messageId) return;
    state.currentTurnProviderUserMessageIds.add(projection.messageId);
    await markProviderUserMessageAsHappierAuthored(projection.messageId);
    observeCurrentTurnMessageId(projection.messageId);
  };

  type AssistantHistoryProjectionResult = Readonly<{
    emptyTerminalAssistantMessageCount: number;
    currentTurnAssistantWithPartsCount: number;
    terminalAssistantMessageCount: number;
    publishedAssistantMessageCount: number;
    providerSessionError: unknown | null;
  }>;

  const EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT: AssistantHistoryProjectionResult = {
    emptyTerminalAssistantMessageCount: 0,
    currentTurnAssistantWithPartsCount: 0,
    terminalAssistantMessageCount: 0,
    publishedAssistantMessageCount: 0,
    providerSessionError: null,
  };

  const publishObservedAssistantMessagesFromHistory = async (
    messages: readonly unknown[],
  ): Promise<AssistantHistoryProjectionResult> => {
    if (!state.turnInFlight || !state.providerSessionId) return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    const currentProviderUserMessageAnchor = resolveCurrentProviderUserMessageAnchor(messages);
    const currentProviderUserMessageAnchorIndex = currentProviderUserMessageAnchor?.index ?? -1;
    let emptyTerminalAssistantMessageCount = 0;
    let currentTurnAssistantWithPartsCount = 0;
    let terminalAssistantMessageCount = 0;
    let publishedAssistantMessageCount = 0;
    let providerSessionError: unknown | null = null;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const projection = classifyOpenCodeMessageForProjection(message);
      if (projection.kind === 'user_transcript') {
        if (index === currentProviderUserMessageAnchorIndex && projection.messageId) {
          state.currentTurnProviderUserMessageIds.add(projection.messageId);
          await markProviderUserMessageAsHappierAuthored(projection.messageId);
          observeCurrentTurnMessageId(projection.messageId);
        }
        continue;
      }
      if (projection.kind !== 'assistant_transcript') continue;
      const messageId = projection.messageId;
      if (!messageId) continue;
      const belongsToCurrentTurn = state.currentTurnObservedMessageIds.has(messageId)
        || (
          currentProviderUserMessageAnchorIndex >= 0
          && index > currentProviderUserMessageAnchorIndex
        );
      if (!belongsToCurrentTurn) continue;
      const record = asRecord(message);
      const parts = Array.isArray(record?.parts) ? record.parts : [];
      publishObservedToolPartsFromCurrentTurnHistoryMessage(parts);
      const text = readProjectedTranscriptText(message);
      if (providerSessionError === null) {
        const info = asRecord(record?.info);
        const error = info?.error;
        if (error !== undefined && error !== null) {
          providerSessionError = error;
        }
      }
      if (parts.length > 0) currentTurnAssistantWithPartsCount += 1;
      const completion = classifyOpenCodeAssistantCompletion(message);
      if (completion.kind === 'terminal_success') {
        if (text) {
          terminalAssistantMessageCount += 1;
        } else if (parts.length === 0) {
          emptyTerminalAssistantMessageCount += 1;
        }
      }
      const providerMessageKey = buildOpenCodeProviderSessionMessageKey(state.providerSessionId, messageId);
      if (state.emittedAssistantMessageIds.has(providerMessageKey)) continue;
      if (!text) continue;
      await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
        kind: 'transcript-agent-message-committed',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        agentId: 'opencode',
        localId: buildOpenCodeRuntimeTranscriptLocalId(state.providerSessionId, messageId),
        body: {
          type: 'message',
          message: text,
        },
        meta: {
          source: 'opencode-server-history',
          providerSessionId: state.providerSessionId,
        },
      });
      state.emittedAssistantMessageIds.add(providerMessageKey);
      state.currentTurnPublishedAssistantMessageIds.add(providerMessageKey);
      publishedAssistantMessageCount += 1;
    }
    return {
      emptyTerminalAssistantMessageCount,
      currentTurnAssistantWithPartsCount,
      terminalAssistantMessageCount,
      publishedAssistantMessageCount,
      providerSessionError,
    };
  };

  const markPromptResponseMessagesAsCurrentTurnEvidence = async (messages: readonly unknown[]): Promise<void> => {
    if (!state.turnInFlight) return;
    for (const message of messages) {
      const projection = classifyOpenCodeMessageForProjection(message);
      if (!projection.messageId) continue;
      observeCurrentTurnMessageId(projection.messageId);
      if (projection.kind === 'user_transcript') {
        state.currentTurnProviderUserMessageIds.add(projection.messageId);
        await markProviderUserMessageAsHappierAuthored(projection.messageId);
      }
    }
  };

  // Origin-agnostic transcript projection (Lane H / S2). Mirrors settled messages this OpenCode
  // session produced regardless of which surface authored them — crucially, messages typed directly
  // in an attached OpenCode TUI while no Happier turn is active. Idempotency / mirror-only invariants:
  // - Runs ONLY when no Happier turn is in flight; the live projection path owns the session's
  //   messages during an active turn (single-owner — no double projection).
  // - Dedupe: `observedExternalUserMessageIds` (users) + `state.emittedAssistantMessageIds`
  //   (assistants), each paired with a deterministic `opencode:<providerSessionId>:<messageId>`
  //   localId so a re-mirror after reconnect/resume cannot duplicate (server-side localId dedupe).
  // - Mirror-only: user messages are emitted as `transcript-user-text` (a transcript-write-only
  //   event — never re-enqueued to the provider); assistant messages as
  //   `transcript-agent-message-committed`. Neither fabricates a turn lifecycle.
  // - Settled-only: user messages, and assistant messages with `terminal_success` completion (so
  //   partial in-progress assistant text is never committed).
  const projectExternalSessionMessagesBestEffort = async (): Promise<void> => {
    if (state.turnInFlight || !state.providerSessionId) return;
    if (passiveTranscriptProjectionInFlight) {
      passiveTranscriptProjectionRerunRequested = true;
      return;
    }
    passiveTranscriptProjectionInFlight = true;
    try {
      do {
        passiveTranscriptProjectionRerunRequested = false;
        if (state.turnInFlight || !state.providerSessionId) return;
        let messages: readonly unknown[];
        try {
          messages = await client.sessionMessages({ sessionId: state.providerSessionId });
        } catch (error) {
          params.ctx.logger.debug('[OpenCodeServer] passive transcript projection: history read failed (non-fatal)', { error });
          return;
        }
        let latestUserMessageOrigin: 'external' | 'happier_authored' | null = null;
        for (const message of messages) {
          if (state.turnInFlight) return;
          const projection = classifyOpenCodeMessageForProjection(message);
          const messageId = projection.messageId;
          if (!messageId) continue;
          const text = readProjectedTranscriptText(message);
          if (!text) continue;
          if (projection.kind === 'user_transcript') {
            const providerMessageKey = buildOpenCodeProviderSessionMessageKey(state.providerSessionId, messageId);
            const isHappierAuthored = await happierAuthoredProviderUserMessageIds.markIfHappierAuthoredProviderUserMessage({
              messageId,
              text,
              createdAtMs: projection.createdAtMs,
            });
            if (isHappierAuthored) {
              latestUserMessageOrigin = 'happier_authored';
              continue;
            }
            latestUserMessageOrigin = 'external';
            if (observedExternalUserMessageIds.has(providerMessageKey)) continue;
            observedExternalUserMessageIds.add(providerMessageKey);
            await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
              kind: 'transcript-user-text',
              sessionId: params.happierSessionId,
              emittedAtMs: Date.now(),
              text,
              localId: buildOpenCodeRuntimeTranscriptLocalId(state.providerSessionId, messageId),
              meta: {
                source: 'opencode-server-external',
                providerSessionId: state.providerSessionId,
              },
            });
            continue;
          }
          if (projection.kind !== 'assistant_transcript') continue;
          if (classifyOpenCodeAssistantCompletion(message).kind !== 'terminal_success') continue;
          const providerMessageKey = buildOpenCodeProviderSessionMessageKey(state.providerSessionId, messageId);
          if (latestUserMessageOrigin === 'happier_authored') {
            state.emittedAssistantMessageIds.add(providerMessageKey);
            continue;
          }
          if (state.emittedAssistantMessageIds.has(providerMessageKey)) continue;
          state.emittedAssistantMessageIds.add(providerMessageKey);
          await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
            kind: 'transcript-agent-message-committed',
            sessionId: params.happierSessionId,
            emittedAtMs: Date.now(),
            agentId: 'opencode',
            localId: buildOpenCodeRuntimeTranscriptLocalId(state.providerSessionId, messageId),
            body: {
              type: 'message',
              message: text,
            },
            meta: {
              source: 'opencode-server-external',
              providerSessionId: state.providerSessionId,
            },
          });
        }
      } while (passiveTranscriptProjectionRerunRequested);
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] passive transcript projection failed (non-fatal)', { error });
    } finally {
      passiveTranscriptProjectionInFlight = false;
    }
  };

  type FinalityHistoryPass = 'idle' | 'polling';

  const readProviderHistoryForFinality = async (
    pass: FinalityHistoryPass,
  ): Promise<readonly unknown[] | null> => {
    if (!state.providerSessionId) return null;
    if (pass === 'polling') {
      const now = Date.now();
      if (historyFinalityNextPollingReadAtMs > 0 && now < historyFinalityNextPollingReadAtMs) {
        return null;
      }
    }
    try {
      const messages = await client.sessionMessages({ sessionId: state.providerSessionId });
      if (pass === 'polling') {
        historyFinalityNextPollingReadAtMs = Date.now() + historyFinalityPollingBackoffMs;
        historyFinalityPollingBackoffMs = historyFinalityPollingBackoffMs === 0
          ? OPEN_CODE_HISTORY_FINALITY_INITIAL_BACKOFF_MS
          : Math.min(historyFinalityPollingBackoffMs * 2, OPEN_CODE_HISTORY_FINALITY_MAX_BACKOFF_MS);
      }
      return messages;
    } catch (error) {
      if (pass === 'polling') {
        historyFinalityNextPollingReadAtMs = Date.now() + historyFinalityPollingBackoffMs;
        historyFinalityPollingBackoffMs = historyFinalityPollingBackoffMs === 0
          ? OPEN_CODE_HISTORY_FINALITY_INITIAL_BACKOFF_MS
          : Math.min(historyFinalityPollingBackoffMs * 2, OPEN_CODE_HISTORY_FINALITY_MAX_BACKOFF_MS);
      }
      params.ctx.logger.debug(`[OpenCodeServer] history refresh failed before ${pass} finality check`, { error });
      params.ctx.logger.debug(`[OpenCodeServer] assistant transcript projection failed before ${pass} finality check`, { error });
      return null;
    }
  };

  const inspectProviderHistoryForFinality = async (
    pass: FinalityHistoryPass,
  ): Promise<AssistantHistoryProjectionResult> => {
    const messages = await readProviderHistoryForFinality(pass);
    if (!messages) return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    try {
      refreshProviderActivityFromHistoryMessages(messages);
    } catch (error) {
      params.ctx.logger.debug(`[OpenCodeServer] history refresh failed before ${pass} finality check`, { error });
    }
    return await publishObservedAssistantMessagesFromHistory(messages).catch((error: unknown) => {
      params.ctx.logger.debug(`[OpenCodeServer] assistant transcript projection failed before ${pass} finality check`, { error });
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    });
  };

  const completeTurnIfReady = async (
    status: unknown,
    historyProjection: AssistantHistoryProjectionResult = EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT,
  ): Promise<void> => {
    await completeOpenCodeTurnIfReady({
      publishRuntimeEvent,
      state,
      providerActivityTracker,
      happierSessionId: params.happierSessionId,
      resetCurrentTurnObservations,
      setThinking,
      status,
      hasTerminalAssistantHistory: historyProjection.terminalAssistantMessageCount > 0,
      hasLiveProviderWork: turnHasLiveProviderWorkForCurrentGeneration,
    });
  };

  const inspectPromptSubmissionResponseForFinality = async (response: unknown): Promise<void> => {
    const messages = normalizeOpenCodePromptResponseMessages(response);
    if (messages.length === 0) return;
    await markPromptResponseMessagesAsCurrentTurnEvidence(messages);
    try {
      refreshProviderActivityFromHistoryMessages(messages);
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] prompt response activity refresh failed', { error });
    }
    const historyProjection = await publishObservedAssistantMessagesFromHistory(messages).catch((error: unknown) => {
      params.ctx.logger.debug('[OpenCodeServer] prompt response assistant transcript projection failed', { error });
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    });
    if (await failCurrentTurnForProviderSessionHistoryError(historyProjection)) return;
    if (await failCurrentTurnForMissingAssistantResponse(historyProjection)) return;
    if (currentTurnShouldWaitForAssistantHistory(historyProjection)) return;
    await completeTurnIfReady({}, historyProjection);
  };

  const readTerminalManagedServerFailure = (): Readonly<{
    source: 'agent_process_exit' | 'agent_session_error';
    message: string;
  }> | null => {
    const snapshot = params.readManagedServerSnapshot?.();
    if (!snapshot || (snapshot.state !== 'unhealthy' && snapshot.state !== 'stopped')) return null;
    const diagnostics = snapshot.diagnostics;
    const hasProcessExit = diagnostics?.exitCode !== undefined || diagnostics?.exitSignal !== undefined;
    if (snapshot.state === 'stopped' && !hasProcessExit && !snapshot.lastErrorMessage) return null;
    const details = [
      snapshot.lastErrorMessage,
      hasProcessExit
        ? `exitCode=${diagnostics?.exitCode ?? 'null'} exitSignal=${diagnostics?.exitSignal ?? 'null'}`
        : null,
      diagnostics?.stderrTail,
      diagnostics?.stdoutTail,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return {
      source: hasProcessExit ? 'agent_process_exit' : 'agent_session_error',
      message: formatOpenCodeServerPromptErrorMessage(
        details.length > 0
          ? details.join('\n')
          : `OpenCode managed server became ${snapshot.state}`,
      ),
    };
  };

  const failCurrentTurnForManagedServerTerminalFailure = async (): Promise<boolean> => {
    const failure = readTerminalManagedServerFailure();
    if (!failure) return false;
    const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
    if (!turnId) return false;
    const emittedAtMs = Date.now();
    resetCurrentTurnObservations();
    setThinking(false);
    await publishOpenCodeTurnFailed({
      publishRuntimeEvent,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs,
      issue: buildOpenCodeRuntimeIssue({
        code: 'opencode_managed_server_unhealthy',
        source: failure.source,
        message: failure.message,
        occurredAt: emittedAtMs,
      }),
    });
    return true;
  };

  // Generation-aware crash recovery (Lane E): the managed `opencode serve` process was replaced
  // mid-turn and the in-flight tool work could not be reconciled from durable history. Fails the turn
  // once with the canonical server-restart issue code. NO completion, NO sessionAbort (the old process
  // is gone), NO prompt replay.
  const failActiveTurnDueToManagedServerRestart = async (input: Readonly<{
    sanitizedPreview: string;
  }>): Promise<void> => {
    const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
    if (!turnId) return;
    const emittedAtMs = Date.now();
    resetCurrentTurnObservations();
    setThinking(false);
    await publishOpenCodeTurnFailed({
      publishRuntimeEvent,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs,
      issue: buildOpenCodeRuntimeIssue({
        code: OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
        source: 'stream_error',
        message: input.sanitizedPreview,
        occurredAt: emittedAtMs,
      }),
    });
  };

  // ONE bounded reconciliation of the active turn's live-known tool work from the replacement server's
  // durable history. Bounded: a single pass over the provider session's messages × parts, scoped to
  // tool calls observed during the current turn. A now-terminal tool clears its tracker entry
  // (`observeToolPart` deletes on terminal status), so genuinely-completed work no longer reads active.
  const reconcileLiveKnownToolStateFromHistory = async (): Promise<void> => {
    if (!state.turnInFlight || !state.providerSessionId) return;
    if (state.currentTurnObservedToolCallKeys.size === 0) return;
    let rawMessages: readonly unknown[];
    try {
      rawMessages = await client.sessionMessages({ sessionId: state.providerSessionId });
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] live-known reconcile: history read failed (non-fatal)', { error });
      return;
    }
    for (const rawMessage of rawMessages) {
      const record = asRecord(rawMessage);
      const parts = Array.isArray(record?.parts) ? record.parts : [];
      for (const rawPart of parts) {
        const part = readOpenCodeToolPart(rawPart);
        if (!part) continue;
        if (!state.currentTurnObservedToolCallKeys.has(readOpenCodeToolCallKey(part))) continue;
        providerActivityTracker.observeToolPart({
          part,
          source: 'history',
          partId: normalizeString(asRecord(rawPart)?.id) || null,
        });
      }
    }
  };

  // True if any live-known tool call of the active turn is still active after a bounded reconcile from
  // the replacement server's durable history. Reconciliation DELETES tracker entries for tools that
  // are now terminal in the new server's history and re-stamps surviving non-terminal tools to the
  // current generation; a tool that VANISHED from the new server is never re-observed, so its
  // old-generation tracker entry survives. Either kind of surviving entry (genuinely-persisting
  // current-generation work OR vanished old-generation work) means the in-flight tool work did not
  // cleanly reconcile across the restart, so the fail decision is generation-AGNOSTIC. (The separate
  // completion gate stays generation-aware so an UNDETECTED generation change cannot wedge an idle
  // turn forever.)
  const hasUnreconciledActiveLiveKnownToolWork = (_currentGenerationKey: string | null): boolean =>
    providerActivityTracker.hasActiveProviderWork() || pendingPermissionRequestKeys.size > 0;

  const managedServerTurnInterruptionSupervisor = createOpenCodeManagedServerTurnInterruptionSupervisor({
    logger: params.ctx.logger,
    isTurnActive: () => state.turnInFlight && state.activeTurnId !== null,
    readOpenCodeManagedServerGenerationIdentity: readManagedServerGenerationIdentity,
    setObservedGenerationKey: (generationKey) => providerActivityTracker.setObservedGenerationKey(generationKey),
    reconcileLiveKnownToolStateFromHistory,
    hasUnreconciledActiveLiveKnownToolWork,
    failActiveTurnDueToManagedServerRestart,
    resetProviderWorkForInterruptedTurn: () => {
      providerActivityTracker.resetForProviderSession(state.providerSessionId);
      abortPendingPermissionDecisions('OpenCode managed server interrupted the active turn');
      pendingPermissionRequestKeys.clear();
    },
    clearOrphanedProviderWork: (currentGenerationKey) => {
      providerActivityTracker.clearActiveWork({
        reason: 'managed_server_generation_replaced',
        generationKey: currentGenerationKey,
      });
      abortPendingPermissionDecisions('OpenCode managed server generation replaced active work');
      pendingPermissionRequestKeys.clear();
    },
    describeActiveProviderWorkForLog: () => {
      const work = providerActivityTracker.getProviderWorkState();
      const pendingPermissionRequestCount = pendingPermissionRequestKeys.size;
      if (!work.active && pendingPermissionRequestCount === 0) return { active: false };
      if (!work.active) {
        return {
          active: true,
          pendingPermissionRequestCount,
        };
      }
      return {
        active: true,
        activeToolCallCount: work.activeToolCallCount,
        pendingPermissionRequestCount,
      };
    },
    getProviderSessionId: () => state.providerSessionId,
  });

  // Liveness for the turn-completion gate: a turn is only "still working" when it has active provider
  // work NOT orphaned by a replaced managed-server generation. Closes the F4 wedge where an orphaned
  // old-generation non-terminal tool would otherwise read as eternal work and block completion.
  const turnHasLiveProviderWorkForCurrentGeneration = (): boolean => {
    if (pendingPermissionRequestKeys.size > 0) return true;
    const currentGenerationKey = managedServerTurnInterruptionSupervisor.getCurrentGenerationKey();
    if (currentGenerationKey === null) return providerActivityTracker.hasActiveProviderWork();
    return providerActivityTracker.hasActiveProviderWorkNotOrphanedByGeneration(currentGenerationKey);
  };

  const failCurrentTurnForProviderSessionError = async (error: unknown): Promise<boolean> => {
    await markCurrentProviderUserMessageFromHistoryBestEffort('agent_session_error');
    const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
    if (!turnId) return false;
    const emittedAtMs = Date.now();
    const message = formatOpenCodeServerPromptErrorMessage(error);
    const isAuthFailure = openCodeProviderSessionErrorLooksAuthFailure({ error, formattedMessage: message });
    if (isAuthFailure) {
      const classification = runtimeAuthAdapter.classifyRuntimeAuthFailure({
        target: { agentId: 'opencode', targetId: params.happierSessionId },
        error,
        selection: resolveOpenCodeRuntimeAuthSelection({
          env: params.env,
          error,
        }),
      });
      if (classification) {
        void params.ctx.sessions.current.auth.services.refreshRuntimeAuth({
          agentId: 'opencode',
          serviceId: classification.serviceId,
          targetId: params.happierSessionId,
          env: params.env ?? null,
          classification,
          reason: 'provider_session_auth_failure',
        }).catch((refreshError: unknown) => {
          params.ctx.logger.debug('[OpenCodeServer] connected-service runtime auth recovery report failed', {
            errorName: refreshError instanceof Error ? refreshError.name : typeof refreshError,
          });
        });
      }
    }
    providerActivityTracker.resetForProviderSession(state.providerSessionId);
    resetCurrentTurnObservations();
    setThinking(false);
    await publishOpenCodeTurnFailed({
      publishRuntimeEvent,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs,
      issue: buildOpenCodeRuntimeIssue({
        code: 'opencode_provider_session_error',
        source: isAuthFailure ? 'auth_error' : 'agent_session_error',
        message,
        occurredAt: emittedAtMs,
      }),
    });
    return true;
  };

  const failCurrentTurnForProviderSessionHistoryError = async (
    historyProjection: AssistantHistoryProjectionResult,
  ): Promise<boolean> => {
    if (historyProjection.providerSessionError === null) return false;
    return await failCurrentTurnForProviderSessionError(historyProjection.providerSessionError);
  };

  const failCurrentTurnForMissingAssistantResponse = async (
    historyProjection: AssistantHistoryProjectionResult,
  ): Promise<boolean> => {
    if (!state.turnInFlight || !state.activeTurnId) return false;
    if (state.currentTurnProviderPromptTexts.size === 0) return false;
    if (state.currentTurnPublishedAssistantMessageIds.size > 0) return false;
    if (providerActivityTracker.hasActiveProviderWork()) return false;
    if (pendingPermissionRequestKeys.size > 0) return false;
    const hasNoAssistantHistoryEvidence =
      historyProjection.currentTurnAssistantWithPartsCount === 0
      && historyProjection.emptyTerminalAssistantMessageCount === 0
      && historyProjection.terminalAssistantMessageCount === 0
      && historyProjection.providerSessionError === null;
    if (hasNoAssistantHistoryEvidence && !currentTurnAssistantHistoryWaitExpired()) {
      return false;
    }
    const emittedAtMs = Date.now();
    if (currentTurnPermissionRejectionMessage) {
      const message = currentTurnPermissionRejectionMessage;
      await markCurrentProviderUserMessageFromHistoryBestEffort('permission_rejected');
      const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
      if (!turnId) return false;
      providerActivityTracker.resetForProviderSession(state.providerSessionId);
      resetCurrentTurnObservations();
      setThinking(false);
      await publishOpenCodeTurnFailed({
        publishRuntimeEvent,
        sessionId: params.happierSessionId,
        turnId,
        emittedAtMs,
        issue: buildOpenCodeRuntimeIssue({
          code: 'opencode_permission_denied',
          source: 'permission_blocked',
          message,
          occurredAt: emittedAtMs,
        }),
      });
      return true;
    }
    let message = 'OpenCode reported the turn idle without returning an assistant message. Check provider credentials, model availability, and OpenCode logs.';
    if (historyProjection.currentTurnAssistantWithPartsCount > 0) {
      message = 'OpenCode completed provider tool work but returned no assistant message. Check provider credentials, model availability, and OpenCode logs.';
    } else if (historyProjection.emptyTerminalAssistantMessageCount > 0) {
      message = 'OpenCode completed the turn but returned an empty assistant message. Check provider credentials, model availability, and OpenCode logs.';
    } else if (hasNoAssistantHistoryEvidence) {
      message = 'OpenCode accepted the prompt but did not publish assistant, tool, or error history before the inactivity timeout. Check provider credentials, model availability, and OpenCode logs.';
    }
    await markCurrentProviderUserMessageFromHistoryBestEffort('missing_assistant_response');
    const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
    if (!turnId) return false;
    providerActivityTracker.resetForProviderSession(state.providerSessionId);
    resetCurrentTurnObservations();
    setThinking(false);
    await publishOpenCodeTurnFailed({
      publishRuntimeEvent,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs,
      issue: buildOpenCodeRuntimeIssue({
        code: 'opencode_empty_provider_response',
        source: 'agent_session_error',
        message,
        occurredAt: emittedAtMs,
      }),
    });
    return true;
  };

  const currentTurnAssistantHistoryWaitExpired = (): boolean => (
    state.currentTurnPromptAcceptedAtMs !== null
    && Date.now() - state.currentTurnPromptAcceptedAtMs >= OPEN_CODE_IDLE_ASSISTANT_HISTORY_GRACE_MS
  );

  const currentTurnShouldWaitForAssistantHistory = (
    historyProjection: AssistantHistoryProjectionResult,
  ): boolean => (
    state.turnInFlight
    && state.currentTurnProviderPromptTexts.size > 0
    && state.currentTurnPublishedAssistantMessageIds.size === 0
    && !providerActivityTracker.hasActiveProviderWork()
    && historyProjection.currentTurnAssistantWithPartsCount === 0
    && historyProjection.emptyTerminalAssistantMessageCount === 0
    && historyProjection.terminalAssistantMessageCount === 0
    && historyProjection.providerSessionError === null
    && !currentTurnAssistantHistoryWaitExpired()
  );

  const failCurrentTurnForProviderErrorStatus = async (status: unknown): Promise<boolean> => {
    if (readStatusType(status) !== 'error') return false;
    return await failCurrentTurnForProviderSessionError(asRecord(status)?.error ?? status);
  };

  const buildPermissionRequestKey = (requestId: string): string => (
    `${state.providerSessionId ?? ''}:${requestId}`
  );

  const rememberPermissionRequest = (requestId: string): boolean => {
    const key = buildPermissionRequestKey(requestId);
    if (handledPermissionRequestKeys.has(key)) return false;
    handledPermissionRequestKeys.add(key);
    if (handledPermissionRequestKeys.size > 512) {
      const oldest = handledPermissionRequestKeys.values().next().value;
      if (typeof oldest === 'string') handledPermissionRequestKeys.delete(oldest);
    }
    return true;
  };

  const handlePermissionAsked = async (properties: Readonly<Record<string, unknown>>): Promise<void> => {
    const ask = readOpenCodePermissionAsk(properties, state.providerSessionId);
    if (!ask) return;
    if (!rememberPermissionRequest(ask.requestId)) return;

    let reply: 'once' | 'always' | 'reject' = 'reject';
    let message: string | null = null;
    const requestKey = buildPermissionRequestKey(ask.requestId);
    const requestTurnId = state.activeTurnId;
    const requestProviderSessionId = state.providerSessionId;
    const requestGenerationKey = readManagedServerGenerationIdentity()?.generationKey ?? null;
    const requestIsTurnScoped = requestTurnId !== null;
    const permissionRequestIsStillCurrent = (): boolean => (
      (!requestIsTurnScoped || pendingPermissionRequestKeys.has(requestKey))
      && (!requestIsTurnScoped || state.activeTurnId === requestTurnId)
      && state.providerSessionId === requestProviderSessionId
      && (readManagedServerGenerationIdentity()?.generationKey ?? null) === requestGenerationKey
    );
    const permissionRequestMatchesTurnAndSession = (): boolean => (
      requestIsTurnScoped
      && pendingPermissionRequestKeys.has(requestKey)
      && state.activeTurnId === requestTurnId
      && state.providerSessionId === requestProviderSessionId
    );
    const prepareCurrentPermissionReply = async (): Promise<boolean> => {
      if (permissionRequestIsStillCurrent()) return true;
      if (permissionRequestMatchesTurnAndSession()) {
        await managedServerTurnInterruptionSupervisor.observeManagedServerGeneration();
      }
      return false;
    };
    if (requestIsTurnScoped) pendingPermissionRequestKeys.add(requestKey);
    const permissionDecisionSignal = requestIsTurnScoped
      ? createTurnScopedPermissionDecisionSignal()
      : null;
    try {
      try {
        const decision = await params.ctx.sessions.current.permissions.requestDecision(
          buildOpenCodePermissionDecisionRequest(ask),
          permissionDecisionSignal ? { signal: permissionDecisionSignal.signal } : undefined,
        );
        reply = mapOpenCodePermissionDecisionToReply(decision);
        message = readOpenCodePermissionReplyMessage(decision);
      } catch (error) {
        if (permissionDecisionSignal?.isAborted() || !permissionRequestIsStillCurrent()) return;
        params.ctx.logger.debug('[OpenCodeServer] permission request failed closed', { error });
        message = 'OpenCode permission request failed closed.';
      }

      if (!await prepareCurrentPermissionReply()) return;

      try {
        await client.permissionReply({
          requestId: ask.requestId,
          reply,
          ...(message ? { message } : {}),
        });
        if (requestIsTurnScoped && await prepareCurrentPermissionReply()) {
          if (reply === 'reject') {
            currentTurnPermissionRejectionMessage = message
              ? `OpenCode permission request was denied: ${message}`
              : 'OpenCode permission request was denied.';
          }
          restartCurrentTurnAssistantHistoryGrace();
        }
      } catch (error) {
        if (!await prepareCurrentPermissionReply()) return;
        params.ctx.logger.debug('[OpenCodeServer] permission reply failed', { error });
        if (!requestIsTurnScoped && state.activeTurnId !== null) return;
        if (state.providerSessionId) {
          await client.sessionAbort({ sessionId: state.providerSessionId }).catch((abortError: unknown) => {
            params.ctx.logger.debug('[OpenCodeServer] session abort failed after permission reply failure', {
              error: abortError,
            });
          });
        }
        await failCurrentTurnForProviderSessionError(error);
      }
    } finally {
      permissionDecisionSignal?.dispose();
      if (requestIsTurnScoped) pendingPermissionRequestKeys.delete(requestKey);
    }
  };

  const handleProviderEvent = async (event: unknown): Promise<void> => {
    const { type, properties } = readProviderEvent(event);
    if (!type) return;
    const eventSessionId = readEventSessionId(properties);
    if (eventSessionId && state.providerSessionId && eventSessionId !== state.providerSessionId) return;

    if (type === 'todo.updated') {
      await publishNativeTodosWorkState().catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish todo work-state update', { error });
      });
      return;
    }

    if (type === 'server.connected') {
      markServerConnected();
      await refreshProviderActivityFromHistory();
      // Lane H/S2: catch up on externally-authored (e.g. TUI) turns when no Happier turn is active.
      // Self-gates on `turnInFlight`, so it is a no-op during an active turn (live path owns it).
      await projectExternalSessionMessagesBestEffort();
      return;
    }

    if (type === 'session.error') {
      await failCurrentTurnForProviderSessionError(properties.error ?? properties);
      return;
    }

    if (type === 'permission.asked') {
      await handlePermissionAsked(properties);
      return;
    }

    if (type === 'session.status') {
      await handleStatus(asRecord(properties.status) ?? properties.status);
      return;
    }

    if (type === 'session.idle') {
      await handleStatus({ type: 'idle' });
      return;
    }

    if (type === 'message.part.updated' || type === 'message.part.created') {
      const rawPart = asRecord(properties.part);
      const rawPartText = normalizeString(rawPart?.text);
      observeCurrentTurnMessageId(normalizeString(rawPart?.messageID));
      const backgroundWakeSource = rawPartText
        ? readOpenCodeBackgroundTaskWakeSource(rawPartText)
        : null;
      if (backgroundWakeSource) {
        recordProviderAutonomousBackgroundWake({
          source: backgroundWakeSource,
          messageId: normalizeString(rawPart?.messageID),
          runtimeActivitySourceId: readOpenCodeBackgroundTaskWakeRuntimeSourceId(rawPartText),
          clearAllRuntimeActivitySources: openCodeBackgroundTaskWakeIndicatesAllTasksComplete(rawPartText),
        });
        return;
      }
      const part = readOpenCodeToolPart(rawPart);
      if (!part) return;
      if (openCodeToolPartLooksLikeBackgroundTaskLaunch(part)) {
        publishDetachedRuntimeActivity(readOpenCodeBackgroundTaskLaunchRuntimeSourceId(part));
      }
      const isBackgroundOutputContinuation =
        openCodeToolPartLooksLikeBackgroundOutputContinuation(part);
      if (
        !state.turnInFlight &&
        (state.pendingProviderAutonomousBackgroundWake ||
          isBackgroundOutputContinuation)
      ) {
        await beginProviderAutonomousBackgroundTurnIfNeeded({
          reason: isBackgroundOutputContinuation
            ? 'background-output-tool'
            : 'background-wake',
        });
      }
      providerActivityTracker.observeToolPart({
        part,
        source: 'live',
        partId: normalizeString(rawPart?.id) || null,
      });
      observeCurrentTurnToolPart(part);
      publishOpenCodeToolPartRuntimeEvents({
        part,
        state,
        happierSessionId: params.happierSessionId,
        publishRuntimeEvent,
      });
      return;
    }

    if (type === 'message.updated') {
      observeCurrentTurnMessageId(normalizeString(asRecord(properties.info)?.id));
      return;
    }

    if (type === 'message.part.delta') {
      const messageId = normalizeString(properties.messageID);
      const partId = normalizeString(properties.partID);
      const delta = normalizeString(properties.delta);
      if (!state.providerSessionId || !messageId || !partId || !delta) return;
      observeCurrentTurnMessageId(messageId);
      const key = `${state.providerSessionId}:${messageId}:${partId}`;
      const accumulated = accumulatedBackgroundWakeTextByPartKey.get(key) ?? '';
      const nextAccumulated = delta.startsWith(accumulated) ? delta : accumulated + delta;
      accumulatedBackgroundWakeTextByPartKey.set(key, nextAccumulated);
      const backgroundWakeSource = readOpenCodeBackgroundTaskWakeSource(nextAccumulated);
      if (!backgroundWakeSource) return;
      recordProviderAutonomousBackgroundWake({
        source: backgroundWakeSource,
        messageId,
        runtimeActivitySourceId: readOpenCodeBackgroundTaskWakeRuntimeSourceId(nextAccumulated),
        clearAllRuntimeActivitySources: openCodeBackgroundTaskWakeIndicatesAllTasksComplete(nextAccumulated),
      });
      return;
    }
  };

  const recordProviderAutonomousBackgroundWake = (input: Readonly<{
    source: 'native-background-task' | 'oh-my-openagent-background-task';
    messageId?: string | null;
    runtimeActivitySourceId?: string | null;
    clearAllRuntimeActivitySources?: boolean;
  }>): void => {
    if (input.runtimeActivitySourceId) {
      clearDetachedRuntimeActivity(input.runtimeActivitySourceId, 'opencode_background_task_wake');
    } else if (input.clearAllRuntimeActivitySources === true) {
      clearDetachedRuntimeActivity(null, 'opencode_background_task_wake_all_complete');
    }
    recordOpenCodeProviderAutonomousBackgroundWake({
      state,
      source: input.source,
      messageId: input.messageId,
    });
  };

  const beginProviderAutonomousBackgroundTurnIfNeeded = async (input: Readonly<{
    reason: 'background-wake' | 'background-output-tool';
  }>): Promise<boolean> => beginOpenCodeProviderAutonomousBackgroundTurnIfNeeded({
    publishRuntimeEvent,
    state,
    happierSessionId: params.happierSessionId,
    setThinking,
    reason: input.reason,
  });

  const handleStatus = async (status: unknown): Promise<void> => {
    // Lane E: observe a possible mid-turn managed-server generation change before processing status.
    // Awaited so a detected replacement deterministically reconciles-or-fails before completion.
    await managedServerTurnInterruptionSupervisor.observeManagedServerGeneration();
    await maybeFailOnOpenCodeRetryStatus({
      ctx: params.ctx,
      publishRuntimeEvent,
      status,
      state,
      happierSessionId: params.happierSessionId,
    });
    if (await failCurrentTurnForProviderErrorStatus(status)) return;
    const statusType = readStatusType(status);
    if (statusType === 'busy') {
      if (state.pendingProviderAutonomousBackgroundWake) {
        await beginProviderAutonomousBackgroundTurnIfNeeded({
          reason: 'background-wake',
        });
      }
      setThinking(true);
      return;
    }
    if (statusType === 'idle') {
      // Lane H/S2: an idle with no Happier turn in flight is an externally-authored (e.g. TUI) turn
      // settling; mirror it into the transcript. During an active Happier turn the live completion
      // path below owns projection (the passive path self-gates on `turnInFlight`).
      if (!state.turnInFlight) {
        await projectExternalSessionMessagesBestEffort();
        return;
      }
      const historyProjection = await inspectProviderHistoryForFinality('idle');
      if (await failCurrentTurnForProviderSessionHistoryError(historyProjection)) return;
      if (await failCurrentTurnForMissingAssistantResponse(historyProjection)) return;
      if (currentTurnShouldWaitForAssistantHistory(historyProjection)) return;
      await completeTurnIfReady(status, historyProjection);
    }
  };

  return {
    beginTurnLifecycle() {
      state.activeTurnId = createOpenCodeTurnId();
      state.turnInFlight = true;
      resetCurrentTurnObservations();
      // Lane E: stamp the managed-server generation this turn starts against.
      managedServerTurnInterruptionSupervisor.captureTurnStartGeneration();
      setThinking(true);
      void publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
        kind: 'turn-start',
        sessionId: params.happierSessionId,
        turnId: state.activeTurnId,
        emittedAtMs: Date.now(),
      }).catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish turn-start event', { error });
      });
    },
    async startOrLoadSession(opts = {}) {
      const resumeId = normalizeString(opts.resumeId);
      if (resumeId) {
        state.providerSessionId = resumeId;
      } else {
        const created = await client.sessionCreate({ directory: params.directory });
        state.providerSessionId = created.id;
      }
      await publishOpenCodeProviderSessionId({
        ctx: params.ctx,
        providerSessionId: state.providerSessionId,
        reason: 'opencode_session_started',
      });
      providerActivityTracker.resetForProviderSession(state.providerSessionId);
      clearDetachedRuntimeActivity(null, 'opencode_provider_session_reset');
      state.emittedAssistantMessageIds.clear();
      await happierAuthoredProviderUserMessageIds.hydrate();
      handledPermissionRequestKeys.clear();
      abortPendingPermissionDecisions('OpenCode provider session reset');
      pendingPermissionRequestKeys.clear();
      state.pendingProviderAutonomousBackgroundWake = null;
      accumulatedBackgroundWakeTextByPartKey.clear();
      attachOpenCodeProviderEventSubscriptionIfNeeded({
        client,
        ctx: params.ctx,
        state,
        handleProviderEvent,
        onSubscriptionUnavailable: markServerReadinessUnavailableFallback,
      });
      return state.providerSessionId;
    },
    async sendTurnPrompt(prompt, meta) {
      if (!state.activeTurnId) this.beginTurnLifecycle();
      if (!state.providerSessionId) await this.startOrLoadSession();
      const providerSessionId = state.providerSessionId;
      const turnId = state.activeTurnId;
      if (!providerSessionId || !turnId) throw new Error('OpenCode session failed to initialize');

      const serverReadyForPrompt = await waitForServerConnectedBeforePrompt(turnId);
      if (!serverReadyForPrompt) return;

      state.currentTurnProviderPromptTexts.add(prompt);
      const promptSubmittedAtMs = Date.now();
      state.currentTurnPromptSubmittedAtMs = promptSubmittedAtMs;
      happierAuthoredProviderUserMessageIds.recordPendingPromptAnchor({
        text: prompt,
        submittedAtMs: promptSubmittedAtMs,
      });
      const failPromptSubmission = async (error: unknown): Promise<void> => {
        await markCurrentProviderUserMessageFromHistoryBestEffort('prompt_submission_failed');
        const failedTurnId = claimOpenCodeActiveTurnForTerminalEvent(state);
        if (failedTurnId) {
          const emittedAtMs = Date.now();
          resetCurrentTurnObservations();
          setThinking(false);
          await publishOpenCodeTurnFailed({
            publishRuntimeEvent,
            sessionId: params.happierSessionId,
            turnId: failedTurnId,
            emittedAtMs,
            issue: buildOpenCodeRuntimeIssue({
              code: 'opencode_prompt_submission_failed',
              source: isOpenCodeServerAuthFailure(error) ? 'auth_error' : 'agent_session_error',
              message: formatOpenCodeServerPromptErrorMessage(error),
              occurredAt: emittedAtMs,
            }),
          });
        }
      };
      try {
        const perPromptModelId = normalizeString(meta?.modelId);
        const modelForPrompt = perPromptModelId
          ? await resolvePromptModel(perPromptModelId)
          : promptModel;
        const promptSubmission = client.sessionPromptAsync({
          sessionId: providerSessionId,
          text: prompt,
          ...(modelForPrompt ? { model: modelForPrompt } : {}),
          ...(state.promptVariant ? { variant: state.promptVariant } : {}),
          ...(state.promptConfig ? { config: state.promptConfig } : {}),
        });
        state.currentTurnPromptAcceptedAtMs = Date.now();
        void promptSubmission.then(
          (response) => {
            queueMicrotask(() => {
              void inspectPromptSubmissionResponseForFinality(response).catch((error: unknown) => {
                params.ctx.logger.debug('[OpenCodeServer] failed to inspect prompt response evidence', { error });
              });
            });
          },
          (error: unknown) => {
            void failPromptSubmission(error).catch((publishError: unknown) => {
              params.ctx.logger.debug('[OpenCodeServer] failed to publish prompt submission failure', {
                error: publishError,
              });
            });
          },
        );
      } catch (error) {
        await failPromptSubmission(error);
        throw error;
      }
    },
    async steerInFlightTurn(message, meta) {
      await this.sendTurnPrompt(message, meta);
    },
    async waitForTurnCompletion() {
      if (!state.turnInFlight || !state.activeTurnId || !state.providerSessionId) return;
      // Lane E: observe a possible mid-turn managed-server generation change and let the supervisor
      // run its reconcile-once-then-fail policy deterministically before the completion gate.
      await managedServerTurnInterruptionSupervisor.observeManagedServerGeneration();
      if (!state.turnInFlight || !state.activeTurnId || !state.providerSessionId) return;
      let status: unknown;
      try {
        status = await client.sessionStatus({ sessionId: state.providerSessionId });
      } catch (error) {
        if (await failCurrentTurnForManagedServerTerminalFailure()) return;
        params.ctx.logger.debug('[OpenCodeServer] status poll failed during turn completion', { error });
        return;
      }
      await maybeFailOnOpenCodeRetryStatus({
        ctx: params.ctx,
        publishRuntimeEvent,
        status,
        state,
        happierSessionId: params.happierSessionId,
      });
      if (await failCurrentTurnForProviderErrorStatus(status)) return;
      let historyProjection = EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
      if (readStatusType(status) === 'busy') {
        setThinking(true);
        return;
      } else {
        historyProjection = await inspectProviderHistoryForFinality('polling');
        if (await failCurrentTurnForProviderSessionHistoryError(historyProjection)) return;
        if (await failCurrentTurnForMissingAssistantResponse(historyProjection)) return;
        if (currentTurnShouldWaitForAssistantHistory(historyProjection)) return;
      }
      await completeTurnIfReady(status, historyProjection);
    },
    subscribeRuntimeEvents(handler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    async cancelTurn() {
      const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
      if (turnId) {
        resetCurrentTurnObservations();
        setThinking(false);
        wakeServerConnectedWaiters();
      }
      if (state.providerSessionId) {
        await client.sessionAbort({ sessionId: state.providerSessionId }).catch((error: unknown) => {
          params.ctx.logger.debug('[OpenCodeServer] session abort failed during cancel', { error });
        });
      }
      if (turnId) {
        await publishOpenCodeTurnCancelled({
          publishRuntimeEvent,
          sessionId: params.happierSessionId,
          turnId,
          reason: 'cancelled',
          emittedAtMs: Date.now(),
        });
      }
    },
    async listSkills(input = {}) {
      const directory = normalizeString(input.directory) || params.directory;
      return await client.appSkills({ directory });
    },
    readSessionIdentity() {
      return { sessionId: state.providerSessionId };
    },
    isHappierAuthoredProviderUserMessageId(messageId) {
      return happierAuthoredProviderUserMessageIds.has(messageId);
    },
    async updateSessionRuntimeConfig(update) {
      const promptConfigUpdate = normalizeOpenCodePromptConfigUpdate(update);
      if (promptConfigUpdate.hasModel) {
        promptModel = promptConfigUpdate.model ?? await resolvePromptModel(normalizeString(update.modelId));
      }
      if (promptConfigUpdate.variant) {
        state.promptVariant = promptConfigUpdate.variant;
      }
      if (promptConfigUpdate.hasConfig) {
        state.promptConfig = promptConfigUpdate.config;
      }
      params.ctx.experimental.telemetry.emit({
        kind: 'opencode.runtime_config_update',
        update,
      });
    },
    handleProviderEvent,
    async resetOrDisposeRuntime() {
      state.disposed = true;
      state.subscriptionAbort?.abort('disposed');
      state.subscriptionAbort = null;
      if (state.subscriptionReconnectTimer) {
        clearTimeout(state.subscriptionReconnectTimer);
        state.subscriptionReconnectTimer = null;
      }
      state.providerSessionId = null;
      state.activeTurnId = null;
      state.turnInFlight = false;
      promptModel = null;
      state.pendingProviderAutonomousBackgroundWake = null;
      handledPermissionRequestKeys.clear();
      abortPendingPermissionDecisions('OpenCode runtime disposed');
      pendingPermissionRequestKeys.clear();
      accumulatedBackgroundWakeTextByPartKey.clear();
      resetCurrentTurnObservations();
      state.emittedAssistantMessageIds.clear();
      happierAuthoredProviderUserMessageIds.clearMemory();
      providerActivityTracker.resetForProviderSession(null);
      clearDetachedRuntimeActivity(null, 'opencode_runtime_disposed');
      resetServerConnectedReadiness();
      setThinking(false);
    },
  };
}
