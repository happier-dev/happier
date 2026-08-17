import { publishOpenCodeNativeTodosWorkState } from '../workState.js';
import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';
import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeSessionOpenRequest } from './operations.js';
import {
  buildOpenCodeRuntimeIssue,
  publishOpenCodeTurnCancelled,
  publishOpenCodeRuntimeEvent,
  publishOpenCodeTurnFailed,
} from './openCodeRuntimeEvents.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { isOpenCodeServerAuthFailure } from './openCodeServerClient.js';
import type { OpenCodeMcpRegistrationResult } from './mcpRegistration.js';
import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import type { OpenCodeToolPart } from './foregroundToolTracker.js';
import { createOpenCodeForegroundToolTracker } from './foregroundToolTracker.js';
import {
  OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
  createOpenCodeManagedServerTurnInterruptionSupervisor,
} from './managedServerTurnInterruptionSupervisor.js';
import { attachOpenCodeProviderEventSubscriptionIfNeeded } from './providerEvents.js';
import {
  buildOpenCodePermissionApprovalRequest,
  mapOpenCodeApprovalResultToReply,
  readOpenCodePermissionAsk,
  readOpenCodeApprovalReplyMessage,
  readOpenCodePermissionRequestId,
} from './permissionBridge.js';
import type { OpenCodePromptModel } from './promptConfig.js';
import { normalizeOpenCodePromptConfigUpdate } from './promptConfig.js';
import { maybeFailOnOpenCodeRetryStatus } from './retryFailure.js';
import { publishOpenCodeProviderSessionId } from './sessionIdentity.js';
import {
  createOpenCodeServerRuntimeState,
  claimOpenCodeActiveTurnForTerminalEvent,
  readEventSessionId,
  readOpenCodeToolCallKey,
  readOpenCodeToolPart,
  readProviderEvent,
  readStatusType,
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
import { createOpenCodeHappierAuthoredProviderUserMessageIds } from './happierAuthoredProviderUserMessages.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';

function readOpenCodeProviderErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return normalizeString(data?.message)
    || normalizeString(record?.message)
    || normalizeString(record?.name);
}

class OpenCodePromptIdentityUnresolvedError extends Error {
  readonly code = 'opencode_prompt_identity_unresolved';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenCodePromptIdentityUnresolvedError';
  }
}

class OpenCodePromptTurnRetiredBeforeDispatchError extends Error {
  readonly code = 'opencode_prompt_turn_retired_before_dispatch';

  constructor() {
    super('OpenCode prompt turn was cancelled before prompt submission');
    this.name = 'OpenCodePromptTurnRetiredBeforeDispatchError';
  }
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

function readOpenCodeForkMessageId(request: Extract<
  OpenCodeSessionOpenRequest,
  { kind: 'fork' }
>): string | null {
  if (request.source.providerCheckpoint === undefined) return null;
  const checkpoint = asRecord(request.source.providerCheckpoint);
  if (
    normalizeString(checkpoint?.kind) !== 'opencode_exclusive_message_id'
    || !normalizeString(checkpoint?.messageId)
  ) {
    throw new Error('OpenCode fork checkpoint is not an opencode_exclusive_message_id checkpoint');
  }
  return normalizeString(checkpoint?.messageId);
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
  ctx: OpenCodeRuntimeContext;
  directory: string;
  happierSessionId: string;
  client: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  readManagedServiceSnapshot?: () => ManagedServiceSnapshot | null | undefined;
  mcpRegistration: Promise<OpenCodeMcpRegistrationResult>;
}>): OpenCodeRuntimeTurnOperations {
  const client = params.client;
  const state = createOpenCodeServerRuntimeState();
  const foregroundToolTracker = createOpenCodeForegroundToolTracker();
  const messageHandlers = new Set<(message: OpenCodeRuntimeEvent) => void>();
  const handledPermissionRequestKeys = new Set<string>();
  const handledQuestionRequestKeys = new Set<string>();
  const pendingQuestionRequestKeys = new Set<string>();
  const pendingPermissionRequestKeys = new Set<string>();
  const pendingPermissionDecisionAbortControllers = new Set<AbortController>();
  const observedAutomaticCompactionMessageIds = new Set<string>();
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
  let nextAssistantHistoryRefreshAtMs = 0;
  let serverConnectedDeferred = createDeferred<void>();
  let serverConnected = false;

  const markProviderUserMessageAsHappierAuthored = async (messageId: string): Promise<void> => {
    await happierAuthoredProviderUserMessageIds.add(messageId);
  };

  const wakeServerConnectedWaiters = (): void => {
    const deferred = serverConnectedDeferred;
    serverConnectedDeferred = createDeferred<void>();
    deferred.resolve();
  };

  const resetServerConnectedReadiness = (): void => {
    serverConnected = false;
    wakeServerConnectedWaiters();
  };

  const markServerConnected = (): void => {
    serverConnected = true;
    wakeServerConnectedWaiters();
  };

  const markServerReadinessUnavailableFallback = (error: unknown): void => {
    const snapshot = params.readManagedServiceSnapshot?.();
    if (!snapshot || snapshot.state !== 'healthy') return;
    params.ctx.logger.debug('[OpenCodeServer] provider event subscription unavailable before server.connected; falling back to managed-server health readiness', {
      error,
    });
    serverConnected = true;
    wakeServerConnectedWaiters();
  };

  const waitForServerConnectedBeforePrompt = async (turnId: string): Promise<boolean> => {
    for (;;) {
      const snapshot = params.readManagedServiceSnapshot?.();
      if (!snapshot) return true;
      if (serverConnected && snapshot.state === 'healthy') {
        return true;
      }
      if (snapshot.state === 'stopped' || snapshot.state === 'failed') return false;
      if (state.disposed || !state.turnInFlight || state.activeTurnId !== turnId) return false;
      await serverConnectedDeferred.promise;
    }
  };

  const publishMessage = (message: OpenCodeRuntimeEvent): void => {
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
    if (!provider) return null;
    const models = asRecord(provider?.models);
    if (!models) return null;
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
    if (!parsed.hasModel) return null;
    const trimmed = normalizeString(modelId);
    if (!trimmed || trimmed === 'default') return null;
    let providers: Awaited<ReturnType<OpenCodeServerClient['providersList']>>;
    try {
      providers = await client.providersList();
    } catch (error) {
      if (parsed.model) return parsed.model;
      throw error;
    }
    if (parsed.model) {
      return findModelForProvider(
        providers,
        parsed.model.providerID,
        parsed.model.modelID,
      );
    }
    const config = await client.globalConfigGet().catch(() => ({}));
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

  const resolveRequiredPromptModel = async (modelId: string): Promise<OpenCodePromptModel> => {
    const resolvedModel = await resolvePromptModel(modelId);
    if (!resolvedModel) {
      throw new Error(`OpenCode model "${normalizeString(modelId)}" is not selectable`);
    }
    return resolvedModel;
  };

  const resolveEffectivePromptModel = async (): Promise<OpenCodePromptModel | null> => {
    if (promptModel) return promptModel;
    const config = await client.globalConfigGet().catch(() => ({}));
    const configuredDefault = normalizeString(asRecord(config)?.model);
    if (!configuredDefault || configuredDefault === 'default') return null;
    return await resolvePromptModel(configuredDefault);
  };

  const publishRuntimeEvent = (event: OpenCodeRuntimeEvent): void => {
    publishMessage(event);
  };

  const abortPendingPermissionDecisions = (reason: string): void => {
    if (pendingPermissionDecisionAbortControllers.size === 0) return;
    const abortReason = new Error(reason);
    for (const controller of pendingPermissionDecisionAbortControllers) {
      if (!controller.signal.aborted) controller.abort(abortReason);
    }
    pendingPermissionDecisionAbortControllers.clear();
  };

  const retirePendingQuestions = (): void => {
    pendingQuestionRequestKeys.clear();
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
    retirePendingQuestions();
    state.currentTurnObservedMessageIds.clear();
    state.currentTurnObservedToolCallKeys.clear();
    state.currentTurnPublishedToolCallKeys.clear();
    state.currentTurnPublishedToolResultKeys.clear();
    state.currentTurnProviderUserMessageId = null;
    state.currentTurnProviderUserMessageIds.clear();
    state.currentTurnProviderPromptTexts.clear();
    state.currentTurnPromptSubmittedAtMs = null;
    state.currentTurnPromptAcceptedAtMs = null;
    state.currentTurnIdleObserved = false;
    state.currentTurnTerminalAssistantMessageIds.clear();
    state.currentTurnPublishedAssistantMessageIds.clear();
    pendingPermissionRequestKeys.clear();
    currentTurnPermissionRejectionMessage = null;
    nextAssistantHistoryRefreshAtMs = 0;
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

  const readProjectedTranscriptText = (message: unknown): string => {
    const record = asRecord(message);
    if (!record) return '';
    const contentText = normalizeString(record.content);
    return contentText || extractOpenCodeProjectedText(
      Array.isArray(record.parts) ? record.parts : [],
      { context: 'direct_transcript' },
    );
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

  type CurrentProviderUserMessageAnchorResolution =
    | Readonly<{
        status: 'resolved';
        index: number;
      }>
    | Readonly<{ status: 'missing' | 'ambiguous' }>;

  const resolveCurrentProviderUserMessageAnchor = (
    messages: readonly unknown[],
  ): CurrentProviderUserMessageAnchorResolution => {
    const messageIdMatches: number[] = [];
    const promptFallbackMatches: number[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const projection = classifyOpenCodeMessageForProjection(message);
      if (projection.kind !== 'user_transcript') continue;
      const messageIdMatchesCurrentTurn = Boolean(
        projection.messageId && state.currentTurnProviderUserMessageIds.has(projection.messageId),
      );
      if (messageIdMatchesCurrentTurn) {
        messageIdMatches.push(index);
        continue;
      }
      if (
        providerUserMessageMatchesCurrentPrompt(message)
        && providerUserMessageHasCurrentTurnPromptTimestamp(projection)
      ) {
        promptFallbackMatches.push(index);
      }
    }
    const matches = messageIdMatches.length > 0 ? messageIdMatches : promptFallbackMatches;
    if (matches.length === 0) return { status: 'missing' };
    if (matches.length > 1) return { status: 'ambiguous' };
    return {
      status: 'resolved',
      index: matches[0]!,
    };
  };

  const adoptCurrentProviderUserMessageFromAuthoritativeInventory = async (
    messages: readonly unknown[],
  ): Promise<
    | Readonly<{ status: 'resolved'; providerUserMessageId: string }>
    | Readonly<{ status: 'missing' | 'ambiguous' }>
  > => {
    const resolution = resolveCurrentProviderUserMessageAnchor(messages);
    if (resolution.status !== 'resolved') return resolution;
    const projection = classifyOpenCodeMessageForProjection(messages[resolution.index]);
    if (projection.kind !== 'user_transcript' || !projection.messageId) {
      return { status: 'missing' };
    }
    state.currentTurnProviderUserMessageId = projection.messageId;
    state.currentTurnProviderUserMessageIds.add(projection.messageId);
    await markProviderUserMessageAsHappierAuthored(projection.messageId);
    observeCurrentTurnMessageId(projection.messageId);
    return {
      status: 'resolved',
      providerUserMessageId: projection.messageId,
    };
  };

  const markCurrentProviderUserMessageFromHistoryBestEffort = async (
    reason: string,
  ): Promise<void> => {
    if (!state.turnInFlight || !state.providerSessionId) return;
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
    await adoptCurrentProviderUserMessageFromAuthoritativeInventory(messages);
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
    const currentProviderUserMessageAnchorIndex = currentProviderUserMessageAnchor.status === 'resolved'
      ? currentProviderUserMessageAnchor.index
      : -1;
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
          state.currentTurnProviderUserMessageId !== null
          && readNonBlankOpaqueIdentifier(projection.info?.parentID) === state.currentTurnProviderUserMessageId
        );
      if (!belongsToCurrentTurn) continue;
      const record = asRecord(message);
      const parts = Array.isArray(record?.parts) ? record.parts : [];
      const text = readProjectedTranscriptText(message);
      for (const rawPart of parts) {
        const toolPart = readOpenCodeToolPart(rawPart);
        if (!toolPart) continue;
        foregroundToolTracker.observeToolPart({ part: toolPart });
        observeCurrentTurnToolPart(toolPart);
        publishOpenCodeToolPartRuntimeEvents({
          part: toolPart,
          state,
          happierSessionId: params.happierSessionId,
          publishRuntimeEvent,
        });
      }
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
          state.currentTurnTerminalAssistantMessageIds.add(messageId);
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

  const reconcileExactCurrentTurnTerminalAssistantFromAuthoritativeInventoryBestEffort = async (
    forceHistoryRefresh = false,
  ): Promise<
    AssistantHistoryProjectionResult
  > => {
    const providerSessionId = state.providerSessionId;
    let providerUserMessageId = state.currentTurnProviderUserMessageId;
    if (!state.turnInFlight || !providerSessionId || !providerUserMessageId) {
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    }
    if (state.currentTurnTerminalAssistantMessageIds.size > 0) {
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    }
    const now = Date.now();
    if (!forceHistoryRefresh && now < nextAssistantHistoryRefreshAtMs) {
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    }
    nextAssistantHistoryRefreshAtMs = now + 1_000;

    let messages: readonly unknown[];
    try {
      messages = await client.sessionMessages({ sessionId: providerSessionId });
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] exact-parent terminal assistant inventory reconciliation failed (non-fatal)', {
        error,
      });
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    }

    const providerUserMessageResolution =
      await adoptCurrentProviderUserMessageFromAuthoritativeInventory(messages);
    if (providerUserMessageResolution.status === 'resolved') {
      providerUserMessageId = providerUserMessageResolution.providerUserMessageId;
    }

    const candidatesByMessageId = new Map<string, Readonly<{
      message: unknown;
      providerErrorFingerprint: string | null;
      text: string;
    }>>();
    for (const message of messages) {
      const projection = classifyOpenCodeMessageForProjection(message);
      const messageId = readNonBlankOpaqueIdentifier(projection.info?.id);
      if (projection.kind !== 'assistant_transcript' || !messageId) continue;
      if (readNonBlankOpaqueIdentifier(projection.info?.sessionID) !== providerSessionId) continue;
      if (readNonBlankOpaqueIdentifier(projection.info?.parentID) !== providerUserMessageId) continue;
      if (classifyOpenCodeAssistantCompletion(message).kind !== 'terminal_success') continue;

      const text = readProjectedTranscriptText(message);
      const providerError = projection.info?.error;
      let providerErrorFingerprint: string | null = null;
      if (providerError !== undefined && providerError !== null) {
        try {
          providerErrorFingerprint = JSON.stringify(providerError) ?? 'unserializable-provider-error';
        } catch {
          providerErrorFingerprint = 'unserializable-provider-error';
        }
      }
      const existing = candidatesByMessageId.get(messageId);
      if (
        existing
        && (
          existing.text !== text
          || existing.providerErrorFingerprint !== providerErrorFingerprint
        )
      ) {
        return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
      }
      candidatesByMessageId.set(messageId, { message, providerErrorFingerprint, text });
    }
    if (candidatesByMessageId.size !== 1) return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;

    const [messageId, candidate] = candidatesByMessageId.entries().next().value ?? [];
    if (!messageId || !candidate) return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    const providerMessageKey = buildOpenCodeProviderSessionMessageKey(providerSessionId, messageId);
    if (state.emittedAssistantMessageIds.has(providerMessageKey)) {
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    }
    observeCurrentTurnMessageId(messageId);
    return await publishObservedAssistantMessagesFromHistory([candidate.message]);
  };

  const markPromptResponseMessagesAsCurrentTurnEvidence = (
    messages: readonly unknown[],
    providerUserMessageId: string,
  ): readonly unknown[] => {
    if (!state.turnInFlight) return [];
    const currentTurnMessages: unknown[] = [];
    for (const message of messages) {
      const projection = classifyOpenCodeMessageForProjection(message);
      if (!projection.messageId) continue;
      const belongsToCurrentTurn = projection.kind === 'user_transcript'
        ? projection.messageId === providerUserMessageId
        : (
          projection.kind === 'assistant_transcript'
          && readNonBlankOpaqueIdentifier(projection.info?.parentID) === providerUserMessageId
        );
      if (!belongsToCurrentTurn) continue;
      currentTurnMessages.push(message);
      observeCurrentTurnMessageId(projection.messageId);
    }
    return currentTurnMessages;
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

  const completeTurnIfReady = async (
    status: unknown,
    historyProjection: AssistantHistoryProjectionResult = EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT,
  ): Promise<void> => {
    const hasTerminalAssistantHistory = historyProjection.terminalAssistantMessageCount > 0
      || state.currentTurnTerminalAssistantMessageIds.size > 0;
    if (!hasTerminalAssistantHistory) {
      const statusType = readStatusType(status);
      const providerIsIdle = statusType !== 'busy';
      const noLiveProviderWork = !turnHasLiveForegroundWork();
      const acceptedAtMs = state.currentTurnPromptAcceptedAtMs;
      const assistantGraceExpired = acceptedAtMs !== null
        && Date.now() - acceptedAtMs >= 60_000;
      const terminalWithoutText = historyProjection.emptyTerminalAssistantMessageCount > 0
        || historyProjection.currentTurnAssistantWithPartsCount > 0;
      const permissionDenied = currentTurnPermissionRejectionMessage !== null;
      if (
        providerIsIdle
        && noLiveProviderWork
        && (terminalWithoutText || permissionDenied || assistantGraceExpired)
      ) {
        const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
        if (!turnId) return;
        const emittedAtMs = Date.now();
        const issue = permissionDenied
          ? buildOpenCodeRuntimeIssue({
              code: 'opencode_permission_denied',
              source: 'permission_blocked',
              message: currentTurnPermissionRejectionMessage,
              occurredAt: emittedAtMs,
            })
          : buildOpenCodeRuntimeIssue({
              code: 'opencode_empty_provider_response',
              source: 'agent_session_error',
              message: terminalWithoutText
                ? 'OpenCode completed without publishing assistant text.'
                : 'OpenCode did not publish assistant text before the completion grace expired.',
              occurredAt: emittedAtMs,
            });
        resetCurrentTurnObservations();
        await publishOpenCodeTurnFailed({
          publishRuntimeEvent,
          sessionId: params.happierSessionId,
          turnId,
          emittedAtMs,
          issue,
        });
      }
      return;
    }
    await completeOpenCodeTurnIfReady({
      publishRuntimeEvent,
      state,
      foregroundToolTracker,
      happierSessionId: params.happierSessionId,
      resetCurrentTurnObservations,
      status,
      hasTerminalAssistantHistory,
      hasLiveProviderWork: turnHasLiveForegroundWork,
    });
  };

  const inspectPromptSubmissionResponseForFinality = async (
    response: unknown,
    providerUserMessageId: string,
  ): Promise<void> => {
    const messages = normalizeOpenCodePromptResponseMessages(response);
    if (messages.length === 0) return;
    const currentTurnMessages = markPromptResponseMessagesAsCurrentTurnEvidence(
      messages,
      providerUserMessageId,
    );
    if (currentTurnMessages.length === 0) return;
    const historyProjection = await publishObservedAssistantMessagesFromHistory(currentTurnMessages).catch((error: unknown) => {
      params.ctx.logger.debug('[OpenCodeServer] prompt response assistant transcript projection failed', { error });
      return EMPTY_ASSISTANT_HISTORY_PROJECTION_RESULT;
    });
    if (await failCurrentTurnForPromptResponseError(historyProjection)) return;
    await completeTurnIfReady({}, historyProjection);
  };

  const readTerminalManagedServerFailure = (): Readonly<{
    source: 'agent_process_exit' | 'agent_session_error';
    message: string;
  }> | null => {
    const snapshot = params.readManagedServiceSnapshot?.();
    if (!snapshot || (snapshot.state !== 'failed' && snapshot.state !== 'stopped')) return null;
    const hasProcessExit = snapshot.diagnostics.some((diagnostic) => (
      diagnostic.code.includes('process_exited')
      || diagnostic.code.includes('process_failed')
    ));
    const details = snapshot.diagnostics.flatMap((diagnostic) => (
      diagnostic.message ? [diagnostic.message] : [diagnostic.code]
    ));
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

  // If the exact managed-service handle is lost mid-turn, reconcile once and fail unresolved work
  // without completion, aborting the already-lost process, or replaying the prompt.
  const failActiveTurnDueToManagedServiceLoss = async (input: Readonly<{
    sanitizedPreview: string;
  }>): Promise<void> => {
    const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
    if (!turnId) return;
    const emittedAtMs = Date.now();
    resetCurrentTurnObservations();
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

  const hasUnreconciledActiveLiveKnownToolWork = (): boolean =>
    foregroundToolTracker.hasActiveToolCalls() || pendingPermissionRequestKeys.size > 0;

  const managedServerTurnInterruptionSupervisor = createOpenCodeManagedServerTurnInterruptionSupervisor({
    logger: params.ctx.logger,
    isTurnActive: () => state.turnInFlight && state.activeTurnId !== null,
    readManagedServiceSnapshot: () => params.readManagedServiceSnapshot?.() ?? null,
    reconcileLiveKnownToolStateFromHistory: async () => {
      const providerSessionId = state.providerSessionId;
      if (!providerSessionId) return;
      const messages = await client.sessionMessages({ sessionId: providerSessionId });
      for (const message of messages) {
        const record = asRecord(message);
        const parts = Array.isArray(record?.parts) ? record.parts : [];
        for (const rawPart of parts) {
          const part = readOpenCodeToolPart(rawPart);
          if (part) foregroundToolTracker.observeToolPart({ part });
        }
      }
    },
    hasUnreconciledActiveLiveKnownToolWork,
    failActiveTurnDueToManagedServiceLoss,
    resetProviderWorkForInterruptedTurn: () => {
      foregroundToolTracker.reset();
      abortPendingPermissionDecisions('OpenCode managed server interrupted the active turn');
      pendingPermissionRequestKeys.clear();
    },
    clearOrphanedProviderWork: () => {
      foregroundToolTracker.reset();
      abortPendingPermissionDecisions('OpenCode managed service lost active work');
      pendingPermissionRequestKeys.clear();
    },
    describeActiveProviderWorkForLog: () => {
      const work = foregroundToolTracker.describe();
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

  const turnHasLiveForegroundWork = (): boolean => {
    if (pendingPermissionRequestKeys.size > 0 || pendingQuestionRequestKeys.size > 0) return true;
    return foregroundToolTracker.hasActiveToolCalls();
  };

  const failCurrentTurnForProviderSessionError = async (
    error: unknown,
    options: Readonly<{ historyAlreadyInspected?: boolean }> = {},
  ): Promise<boolean> => {
    if (options.historyAlreadyInspected !== true) {
      await markCurrentProviderUserMessageFromHistoryBestEffort('agent_session_error');
    }
    const turnId = claimOpenCodeActiveTurnForTerminalEvent(state);
    if (!turnId) return false;
    const emittedAtMs = Date.now();
    const message = formatOpenCodeServerPromptErrorMessage(error);
    const isAuthFailure = openCodeProviderSessionErrorLooksAuthFailure({ error, formattedMessage: message });
    foregroundToolTracker.reset();
    resetCurrentTurnObservations();
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

  const failCurrentTurnForPromptResponseError = async (
    historyProjection: AssistantHistoryProjectionResult,
  ): Promise<boolean> => {
    if (historyProjection.providerSessionError === null) return false;
    return await failCurrentTurnForProviderSessionError(
      historyProjection.providerSessionError,
      { historyAlreadyInspected: true },
    );
  };

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

  const handleQuestionAsked = async (
    properties: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const requestId = normalizeString(properties.id);
    const providerSessionId = normalizeString(properties.sessionID);
    if (
      !requestId
      || !providerSessionId
      || providerSessionId !== state.providerSessionId
    ) return;
    const requestKey = `${providerSessionId}:${requestId}`;
    if (handledQuestionRequestKeys.has(requestKey)) return;
    handledQuestionRequestKeys.add(requestKey);
    if (handledQuestionRequestKeys.size > 512) {
      const oldest = handledQuestionRequestKeys.values().next().value;
      if (typeof oldest === 'string') handledQuestionRequestKeys.delete(oldest);
    }
    const questions = Array.isArray(properties.questions)
      ? properties.questions.map(asRecord).filter(
          (question): question is Readonly<Record<string, unknown>> => question !== null,
        )
      : [];
    if (questions.length === 0) {
      await client.questionReject({ requestId });
      return;
    }
    const internalTitleQuestions = questions.every((question) => {
      const header = normalizeString(question.header).toLowerCase();
      const prompt = normalizeString(question.question).toLowerCase();
      const options = Array.isArray(question.options)
        ? question.options.map(asRecord).filter(
            (option): option is Readonly<Record<string, unknown>> => option !== null,
          )
        : [];
      return (header === 'title' || header === 'title update')
        && prompt.startsWith('(internal)')
        && question.multiple !== true
        && options.length === 1
        && normalizeString(options[0]?.label).toLowerCase() === 'ok';
    });
    if (internalTitleQuestions) {
      await client.questionReply({
        requestId,
        answers: questions.map(() => ['OK']),
      });
      return;
    }

    const hostQuestions = questions.map((question, questionIndex) => {
      const id = `${requestId}:${questionIndex}`;
      const prompt = normalizeString(question.question)
        || normalizeString(question.header);
      const options = Array.isArray(question.options)
        ? question.options.map(asRecord).filter(
            (option): option is Readonly<Record<string, unknown>> => (
              option !== null && normalizeString(option.label).length > 0
            ),
          )
        : [];
      if (options.length === 0) {
        return { id, prompt, type: 'text' as const, required: true };
      }
      return {
        id,
        prompt,
        type: question.multiple === true ? 'multipleChoice' as const : 'singleChoice' as const,
        required: true,
        choices: options.map((option, optionIndex) => ({
          id: `${id}:choice:${optionIndex}`,
          label: normalizeString(option.label),
          ...(normalizeString(option.description)
            ? { description: normalizeString(option.description) }
            : {}),
        })) as [
          { id: string; label: string; description?: string },
          ...{ id: string; label: string; description?: string }[],
        ],
        allowCustom: question.multiple !== true,
      };
    });
    if (
      hostQuestions.some((question) => !question.prompt)
      || hostQuestions.length === 0
    ) {
      await client.questionReject({ requestId });
      return;
    }

    pendingQuestionRequestKeys.add(requestKey);
    const questionProviderSessionId = state.providerSessionId;
    const questionIsStillCurrent = (): boolean => (
      pendingQuestionRequestKeys.has(requestKey)
      && state.providerSessionId === questionProviderSessionId
      && !params.ctx.abort.signal.aborted
    );
    try {
      const result = await params.ctx.ui.askQuestions({
        kind: 'questions',
        title: 'OpenCode question',
        questions: hostQuestions as [typeof hostQuestions[number], ...typeof hostQuestions[number][]],
      });
      if (!questionIsStillCurrent()) return;
      if (result.status !== 'answered') {
        await client.questionReject({ requestId });
        return;
      }
      const answers = hostQuestions.map((hostQuestion, questionIndex) => {
        const answer = result.answers[hostQuestion.id];
        if (!answer) return [] as string[];
        if (answer.kind === 'text') return [answer.value];
        const originalOptions = Array.isArray(questions[questionIndex]?.options)
          ? (questions[questionIndex]?.options as readonly unknown[])
              .map(asRecord)
              .filter(
                (option): option is Readonly<Record<string, unknown>> => option !== null,
              )
          : [];
        const renderChoice = (
          choice: Readonly<{ kind: 'choice'; choiceId: string }>
            | Readonly<{ kind: 'custom'; value: string }>,
        ): string => {
          if (choice.kind === 'custom') return choice.value;
          const index = Number.parseInt(choice.choiceId.split(':').at(-1) ?? '', 10);
          return normalizeString(originalOptions[index]?.label);
        };
        if (answer.kind === 'singleChoice') return [renderChoice(answer.answer)].filter(Boolean);
        return answer.answers.map(renderChoice).filter(Boolean);
      });
      await client.questionReply({ requestId, answers });
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] question handling failed closed', {
        requestId,
        error,
      });
      if (!questionIsStillCurrent()) return;
      await client.questionReject({ requestId }).catch((replyError: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] question rejection failed', {
          requestId,
          error: replyError,
        });
      });
    } finally {
      pendingQuestionRequestKeys.delete(requestKey);
    }
  };

  const handlePermissionAsked = async (properties: Readonly<Record<string, unknown>>): Promise<void> => {
    const ask = readOpenCodePermissionAsk(properties, state.providerSessionId);
    if (!ask) {
      const requestId = readOpenCodePermissionRequestId(properties);
      if (!requestId || !rememberPermissionRequest(requestId)) return;
      await client.permissionReply({
        requestId,
        reply: 'reject',
        message: 'OpenCode permission request was malformed or ambiguous.',
      }).catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] malformed permission rejection failed', {
          requestId,
          error,
        });
      });
      return;
    }
    if (!rememberPermissionRequest(ask.requestId)) return;

    let reply: 'once' | 'always' | 'reject' = 'reject';
    let message: string | null = null;
    const requestKey = buildPermissionRequestKey(ask.requestId);
    const requestTurnId = state.activeTurnId;
    const requestProviderSessionId = state.providerSessionId;
    const requestIsTurnScoped = requestTurnId !== null;
    const permissionRequestIsStillCurrent = (): boolean => {
      return !state.disposed
        && !params.ctx.abort.signal.aborted
        && (!requestIsTurnScoped || pendingPermissionRequestKeys.has(requestKey))
        && (!requestIsTurnScoped || state.activeTurnId === requestTurnId)
        && state.providerSessionId === requestProviderSessionId;
    };
    const permissionRequestMatchesTurnAndSession = (): boolean => (
      requestIsTurnScoped
      && pendingPermissionRequestKeys.has(requestKey)
      && state.activeTurnId === requestTurnId
      && state.providerSessionId === requestProviderSessionId
    );
    const prepareCurrentPermissionReply = async (): Promise<boolean> => {
      if (permissionRequestIsStillCurrent()) return true;
      if (permissionRequestMatchesTurnAndSession()) {
        await managedServerTurnInterruptionSupervisor.observeManagedServiceSnapshot();
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
          buildOpenCodePermissionApprovalRequest(ask),
          {
            signal: permissionDecisionSignal?.signal ?? params.ctx.abort.signal,
          },
        );
        reply = mapOpenCodeApprovalResultToReply(decision);
        message = readOpenCodeApprovalReplyMessage(decision);
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
      // Lane H/S2: catch up on externally-authored (e.g. TUI) turns when no Happier turn is active.
      // Self-gates on `turnInFlight`, so it is a no-op during an active turn (live path owns it).
      await projectExternalSessionMessagesBestEffort();
      return;
    }

    if (type === 'session.error') {
      // OpenCode emits this before the terminal assistant message is committed. Treat it only as a
      // nonterminal lifecycle hint; exact-parent authoritative history owns turn failure attribution.
      return;
    }

    if (type === 'permission.asked') {
      await handlePermissionAsked(properties);
      return;
    }

    if (type === 'question.asked') {
      await handleQuestionAsked(properties);
      return;
    }

    if (type === 'session.status') {
      await handleStatus(
        asRecord(properties.status) ?? properties.status,
        { forceHistoryRefresh: true },
      );
      return;
    }

    if (type === 'session.idle') {
      await handleStatus({ type: 'idle' }, { forceHistoryRefresh: true });
      return;
    }

    if (type === 'message.part.updated' || type === 'message.part.created') {
      const rawPart = asRecord(properties.part);
      observeCurrentTurnMessageId(normalizeString(rawPart?.messageID));
      const part = readOpenCodeToolPart(rawPart);
      if (!part) return;
      if (!state.turnInFlight) return;
      foregroundToolTracker.observeToolPart({
        part,
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
      const info = asRecord(properties.info);
      const messageId = normalizeString(info?.id);
      observeCurrentTurnMessageId(messageId);
      if (
        messageId
        && info?.summary === true
        && normalizeString(info.role) === 'assistant'
        && !observedAutomaticCompactionMessageIds.has(messageId)
      ) {
        observedAutomaticCompactionMessageIds.add(messageId);
        const emittedAtMs = Date.now();
        publishRuntimeEvent({
          kind: 'context-compaction',
          sessionId: params.happierSessionId,
          emittedAtMs,
          compactionId: messageId,
          phase: 'started',
          trigger: 'automatic',
        });
        publishRuntimeEvent({
          kind: 'context-compaction',
          sessionId: params.happierSessionId,
          emittedAtMs,
          compactionId: messageId,
          phase: 'completed',
          trigger: 'automatic',
        });
      }
      if (state.turnInFlight && state.currentTurnIdleObserved) {
        await settleCurrentTurnFromAuthoritativeInventoryAfterIdle(true);
      }
      return;
    }

    if (type === 'message.part.delta') {
      observeCurrentTurnMessageId(normalizeString(properties.messageID));
      return;
    }
  };

  let authoritativeRequestInventoryRefreshInFlight: Promise<void> | null = null;
  const refreshAuthoritativeRequestInventories = async (): Promise<void> => {
    if (authoritativeRequestInventoryRefreshInFlight) {
      await authoritativeRequestInventoryRefreshInFlight;
      return;
    }
    const work = (async () => {
      const [permissionsResult, questionsResult] = await Promise.allSettled([
        client.permissionList(),
        client.questionList(),
      ]);
      if (permissionsResult.status === 'fulfilled') {
        for (const rawPermission of permissionsResult.value) {
          const permission = asRecord(rawPermission);
          if (!permission) continue;
          void handlePermissionAsked(permission).catch((error: unknown) => {
            params.ctx.logger.debug('[OpenCodeServer] active permission handling failed (non-fatal)', { error });
          });
        }
      } else {
        params.ctx.logger.debug('[OpenCodeServer] active permission inventory refresh failed (non-fatal)', {
          error: permissionsResult.reason,
        });
      }
      if (questionsResult.status === 'fulfilled') {
        for (const rawQuestion of questionsResult.value) {
          const question = asRecord(rawQuestion);
          if (!question) continue;
          void handleQuestionAsked(question).catch((error: unknown) => {
            params.ctx.logger.debug('[OpenCodeServer] active question handling failed (non-fatal)', { error });
          });
        }
      } else {
        params.ctx.logger.debug('[OpenCodeServer] active question inventory refresh failed (non-fatal)', {
          error: questionsResult.reason,
        });
      }
    })();
    authoritativeRequestInventoryRefreshInFlight = work;
    try {
      await work;
    } finally {
      if (authoritativeRequestInventoryRefreshInFlight === work) {
        authoritativeRequestInventoryRefreshInFlight = null;
      }
    }
  };

  const handleProviderObservation = async (event: unknown): Promise<void> => {
    const { type, properties } = readProviderEvent(event);
    if (!type) return;
    const eventSessionId = readEventSessionId(properties);
    if (eventSessionId && state.providerSessionId && eventSessionId !== state.providerSessionId) return;

    if (type === 'message.updated') {
      const info = asRecord(properties.info);
      const messageId = normalizeString(info?.id);
      if (!state.turnInFlight) {
        if (state.providerSessionId && normalizeString(info?.sessionID) === state.providerSessionId) {
          // Replayable events are content-free invalidations outside a Happier turn. The
          // authoritative message inventory remains the sole transcript owner.
          await projectExternalSessionMessagesBestEffort();
        }
        return;
      }
      if (
        !messageId
        || normalizeString(info?.role) !== 'assistant'
        || normalizeString(info?.sessionID) !== state.providerSessionId
        || normalizeString(info?.parentID) !== state.currentTurnProviderUserMessageId
      ) {
        return;
      }
      await handleProviderEvent(event);
      return;
    }

    if (type === 'message.part.updated' || type === 'message.part.created' || type === 'message.part.delta') {
      if (!state.turnInFlight || !state.providerSessionId) return;
      const part = type === 'message.part.delta' ? properties : asRecord(properties.part);
      const messageId = normalizeString(part?.messageID);
      if (
        !messageId
        || normalizeString(part?.sessionID) !== state.providerSessionId
        || state.currentTurnProviderUserMessageIds.has(messageId)
        || !state.currentTurnObservedMessageIds.has(messageId)
      ) {
        return;
      }
      await handleProviderEvent(event);
      return;
    }

    if (type === 'todo.updated') {
      await publishNativeTodosWorkState().catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to refresh todos after provider observation', { error });
      });
      return;
    }

    if (type === 'permission.asked' || type === 'question.asked') {
      await refreshAuthoritativeRequestInventories();
    }
  };

  const stopNativeRetry = async (): Promise<void> => {
    if (!state.providerSessionId) return;
    await client.sessionAbort({ sessionId: state.providerSessionId }).catch((error: unknown) => {
      params.ctx.logger.debug('[OpenCodeServer] session abort failed while stopping a native retry', {
        error,
      });
    });
  };

  const settleCurrentTurnFromAuthoritativeInventoryAfterIdle = async (
    forceHistoryRefresh = false,
  ): Promise<void> => {
    if (!state.turnInFlight || !state.currentTurnIdleObserved) return;
    const historyProjection = await reconcileExactCurrentTurnTerminalAssistantFromAuthoritativeInventoryBestEffort(
      forceHistoryRefresh,
    );
    if (await failCurrentTurnForPromptResponseError(historyProjection)) return;
    await completeTurnIfReady({ type: 'idle' }, historyProjection);
  };

  const handleStatus = async (
    status: unknown,
    options: Readonly<{ forceHistoryRefresh?: boolean }> = {},
  ): Promise<void> => {
    await managedServerTurnInterruptionSupervisor.observeManagedServiceSnapshot();
    await maybeFailOnOpenCodeRetryStatus({
      ctx: params.ctx,
      publishRuntimeEvent,
      status,
      state,
      happierSessionId: params.happierSessionId,
      stopNativeRetry,
    });
    if (await failCurrentTurnForProviderErrorStatus(status)) return;
    const statusType = readStatusType(status);
    if (statusType === 'busy') {
      state.currentTurnIdleObserved = false;
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
      state.currentTurnIdleObserved = true;
      await settleCurrentTurnFromAuthoritativeInventoryAfterIdle(options.forceHistoryRefresh === true);
    }
  };

  return {
    beginTurnLifecycle(turnId) {
      state.activeTurnId = turnId;
      state.turnInFlight = true;
      resetCurrentTurnObservations();
      managedServerTurnInterruptionSupervisor.captureTurnStartSnapshot();
      void publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
        kind: 'turn-start',
        sessionId: params.happierSessionId,
        turnId: state.activeTurnId,
        emittedAtMs: Date.now(),
      }).catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish turn-start event', { error });
      });
    },
    async openSession(request) {
      if (request.kind === 'resume') {
        state.providerSessionId = normalizeString(request.providerSessionId);
      } else if (request.kind === 'fork') {
        const parentProviderSessionId = normalizeString(request.source.providerSessionId);
        if (!parentProviderSessionId) {
          throw new Error('OpenCode fork requires a parent provider session id');
        }
        const messageId = readOpenCodeForkMessageId(request);
        const forked = await client.sessionFork({
          sessionId: parentProviderSessionId,
          ...(messageId ? { messageId } : {}),
        });
        state.providerSessionId = forked.id;
      } else {
        const created = await client.sessionCreate({ directory: params.directory });
        state.providerSessionId = created.id;
      }
      if (!state.providerSessionId) {
        throw new Error('OpenCode session open did not produce a provider session id');
      }
      await publishOpenCodeProviderSessionId({
        ctx: params.ctx,
        providerSessionId: state.providerSessionId,
        reason: 'opencode_session_started',
      });
      foregroundToolTracker.reset();
      state.emittedAssistantMessageIds.clear();
      observedAutomaticCompactionMessageIds.clear();
      await happierAuthoredProviderUserMessageIds.hydrate();
      handledPermissionRequestKeys.clear();
      abortPendingPermissionDecisions('OpenCode provider session reset');
      pendingPermissionRequestKeys.clear();
      handledQuestionRequestKeys.clear();
      retirePendingQuestions();
      attachOpenCodeProviderEventSubscriptionIfNeeded({
        client,
        ctx: params.ctx,
        state,
        handleProviderEvent,
        handleProviderObservation,
        onSubscriptionUnavailable: markServerReadinessUnavailableFallback,
      });
      return state.providerSessionId;
    },
    async sendTurnPrompt(prompt, meta) {
      if (!state.activeTurnId) {
        throw new Error('OpenCode prompt submission requires an active host turn lifecycle');
      }
      if (!state.providerSessionId) await this.openSession({ kind: 'create' });
      const providerSessionId = state.providerSessionId;
      const turnId = state.activeTurnId;
      if (!providerSessionId || !turnId) throw new Error('OpenCode session failed to initialize');

      const assertPromptTurnStillOwnsDispatch = (): void => {
        if (
          state.disposed
          || !state.turnInFlight
          || state.activeTurnId !== turnId
          || state.providerSessionId !== providerSessionId
        ) {
          throw new OpenCodePromptTurnRetiredBeforeDispatchError();
        }
      };

      const serverReadyForPrompt = await waitForServerConnectedBeforePrompt(turnId);
      if (!serverReadyForPrompt) {
        throw new Error('OpenCode server became unavailable before prompt submission');
      }

      state.currentTurnProviderPromptTexts.clear();
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
      const failPromptIdentityResolution = async (
        message: string,
        cause?: unknown,
      ): Promise<OpenCodePromptIdentityUnresolvedError> => {
        const failedTurnId = claimOpenCodeActiveTurnForTerminalEvent(state);
        if (failedTurnId) {
          const emittedAtMs = Date.now();
          resetCurrentTurnObservations();
          await publishOpenCodeTurnFailed({
            publishRuntimeEvent,
            sessionId: params.happierSessionId,
            turnId: failedTurnId,
            emittedAtMs,
            issue: buildOpenCodeRuntimeIssue({
              code: 'opencode_prompt_identity_unresolved',
              source: 'agent_session_error',
              message,
              occurredAt: emittedAtMs,
            }),
          });
        }
        return new OpenCodePromptIdentityUnresolvedError(
          message,
          cause === undefined ? undefined : { cause },
        );
      };
      try {
        const mcpRegistration = await params.mcpRegistration;
        assertPromptTurnStillOwnsDispatch();
        if (mcpRegistration.requiredHappier.status === 'failed') {
          const registrationError = mcpRegistration.requiredHappier.error;
          const detail = registrationError instanceof Error
            ? registrationError.message
            : formatOpenCodeServerPromptErrorMessage(registrationError);
          throw new Error(
            `required Happier MCP registration failed${detail ? `: ${detail}` : ''}`,
            { cause: registrationError },
          );
        }
        state.currentTurnProviderUserMessageIds.clear();
        state.currentTurnTerminalAssistantMessageIds.clear();
        state.currentTurnProviderUserMessageId = null;
        state.currentTurnIdleObserved = false;
        const perPromptModelId = normalizeString(meta?.modelId);
        const modelForPrompt = perPromptModelId
          ? await resolveRequiredPromptModel(perPromptModelId)
          : promptModel;
        assertPromptTurnStillOwnsDispatch();
        const promptSubmission = await client.sessionPromptAsync({
          sessionId: providerSessionId,
          text: prompt,
          ...(meta?.promptParts ? { parts: meta.promptParts } : {}),
          ...(modelForPrompt ? { model: modelForPrompt } : {}),
          ...(state.promptVariant ? { variant: state.promptVariant } : {}),
          ...(state.promptConfig ? { config: state.promptConfig } : {}),
        });
        let authoritativeMessages: readonly unknown[];
        try {
          authoritativeMessages = await client.sessionMessages({ sessionId: providerSessionId });
        } catch (error) {
          throw await failPromptIdentityResolution(
            'OpenCode accepted the prompt, but its authoritative message inventory could not be read to establish input custody.',
            error,
          );
        }
        const providerUserMessageResolution =
          await adoptCurrentProviderUserMessageFromAuthoritativeInventory(authoritativeMessages);
        if (providerUserMessageResolution.status !== 'resolved') {
          throw await failPromptIdentityResolution(
            providerUserMessageResolution.status === 'ambiguous'
              ? 'OpenCode accepted the prompt, but its authoritative message inventory contained multiple matching native user messages.'
              : 'OpenCode accepted the prompt, but its authoritative message inventory did not contain a matching native user message.',
          );
        }
        const providerUserMessageId = providerUserMessageResolution.providerUserMessageId;
        state.currentTurnPromptAcceptedAtMs = Date.now();
        queueMicrotask(() => {
          void inspectPromptSubmissionResponseForFinality(
            promptSubmission,
            providerUserMessageId,
          ).catch((error: unknown) => {
            params.ctx.logger.debug('[OpenCodeServer] failed to inspect prompt response evidence', { error });
          });
        });
        return {
          providerUserMessageId,
          ...(modelForPrompt
            ? { effectiveModelId: `${modelForPrompt.providerID}/${modelForPrompt.modelID}` }
            : {}),
        };
      } catch (error) {
        if (
          error instanceof OpenCodePromptIdentityUnresolvedError
          || error instanceof OpenCodePromptTurnRetiredBeforeDispatchError
        ) throw error;
        await failPromptSubmission(error);
        throw error;
      }
    },
    async steerInFlightTurn(message, meta) {
      return await this.sendTurnPrompt(message, meta);
    },
    async waitForTurnCompletion() {
      if (!state.turnInFlight || !state.activeTurnId || !state.providerSessionId) return;
      await managedServerTurnInterruptionSupervisor.observeManagedServiceSnapshot();
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
        stopNativeRetry,
      });
      if (await failCurrentTurnForProviderErrorStatus(status)) return;
      if (readStatusType(status) === 'busy') {
        return;
      }
      const historyProjection = await reconcileExactCurrentTurnTerminalAssistantFromAuthoritativeInventoryBestEffort();
      if (await failCurrentTurnForPromptResponseError(historyProjection)) return;
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
      retirePendingQuestions();
      if (turnId) {
        resetCurrentTurnObservations();
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
        const requestedModelId = normalizeString(update.modelId);
        if (!requestedModelId || requestedModelId === 'default') {
          promptModel = null;
        } else {
          promptModel = await resolveRequiredPromptModel(requestedModelId);
        }
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
    async compactContext(request) {
      const providerSessionId = state.providerSessionId;
      if (!providerSessionId) {
        throw new Error('OpenCode context compaction requires an open provider session');
      }
      const model = await resolveEffectivePromptModel();
      if (!model) {
        throw new Error('OpenCode context compaction requires a resolved model');
      }
      publishRuntimeEvent({
        kind: 'context-compaction',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        compactionId: request.compactionId,
        phase: 'started',
        trigger: 'manual',
      });
      try {
        await client.sessionSummarize({
          sessionId: providerSessionId,
          model,
          auto: false,
        });
        publishRuntimeEvent({
          kind: 'context-compaction',
          sessionId: params.happierSessionId,
          emittedAtMs: Date.now(),
          compactionId: request.compactionId,
          phase: 'completed',
          trigger: 'manual',
        });
      } catch (error) {
        publishRuntimeEvent({
          kind: 'context-compaction',
          sessionId: params.happierSessionId,
          emittedAtMs: Date.now(),
          compactionId: request.compactionId,
          phase: 'failed',
          trigger: 'manual',
          diagnostic: {
            code: 'opencode_compaction_failed',
            severity: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
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
      handledPermissionRequestKeys.clear();
      abortPendingPermissionDecisions('OpenCode runtime disposed');
      pendingPermissionRequestKeys.clear();
      handledQuestionRequestKeys.clear();
      retirePendingQuestions();
      resetCurrentTurnObservations();
      state.emittedAssistantMessageIds.clear();
      observedAutomaticCompactionMessageIds.clear();
      happierAuthoredProviderUserMessageIds.clearMemory();
      foregroundToolTracker.reset();
      resetServerConnectedReadiness();
    },
  };
}
