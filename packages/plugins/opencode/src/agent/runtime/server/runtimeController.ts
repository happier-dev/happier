import { readOpenCodeNativeChildOutcome, type OpenCodeNativeChildStatus } from './nativeChildOutcome.js';
import { randomUUID } from 'node:crypto';
import { normalizeOpenCodePaidUsage } from '../../usage/paidUsage.js';
import { isOpenCodeModelSelectable } from '../../models/eligibility.js';
import { buildOpenCodePreflightModels } from '../../preflight/models.js';
import type { OpenCodeModelCatalogSnapshot, OpenCodeModeCatalogSnapshot } from './operations.js';
import { publishOpenCodeNativeTodosWorkState } from '../workState.js';
import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';
import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeSessionOpenRequest } from './operations.js';
import {
  buildOpenCodeRuntimeIssue,
  publishOpenCodeTurnCancelled,
  publishOpenCodeRuntimeEvent,
  publishOpenCodeTurnFailed,
  projectOpenCodeRuntimeScope,
} from './openCodeRuntimeEvents.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { isOpenCodeServerAuthFailure, OpenCodeServerUnsupportedOperationError } from './openCodeServerClient.js';
import { OpenCodeSkillIdentityError } from './openCodeV2Wire.js';
import type { OpenCodeMcpRegistrationResult, OpenCodeSessionMcpProjection } from './mcpRegistration.js';
import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import type { OpenCodeToolPart } from './foregroundToolTracker.js';
import { isTerminalOpenCodeToolPartStatus, createOpenCodeForegroundToolTracker } from './foregroundToolTracker.js';
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
  classifyOpenCodePartForProjection,
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
import { buildOpenCodeSessionScopedPermissionRuleset } from '../../permissions/policy.js';
import type { OpenCodeRuntimeEvent, OpenCodeRuntimeScope } from './runtimeEvents.js';
import type { OpenCodeServerDialect } from './dialect.js';
import { normalizeSlashCommandName, readLeadingSlashCommandName } from '@happier-dev/plugin-sdk/sessions';

function readOpenCodeProviderErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return normalizeString(data?.message)
    || normalizeString(record?.message)
    || normalizeString(record?.name);
}

function isPromptRejectedBeforeProviderEffect(error: unknown): boolean {
  return error instanceof OpenCodeSkillIdentityError || error instanceof OpenCodeServerUnsupportedOperationError;
}

function projectOpenCodeNativeChildStatus(
  part: OpenCodeToolPart,
): 'running' | 'completed' | 'failed' | 'aborted' {
  if (part.state.status === 'completed') {
    const metadata = asRecord(part.state.metadata);
    return metadata?.background === true || metadata?.status === 'running' ? 'running' : 'completed';
  }
  if (part.state.status === 'error' || part.state.status === 'failed') return 'failed';
  if (
    part.state.status === 'cancelled'
    || part.state.status === 'canceled'
    || part.state.status === 'aborted'
  ) return 'aborted';
  return 'running';
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
  // `kind` is Happier's own checkpoint vocabulary; `messageId` is the id
  // OpenCode minted and the fork route addresses verbatim.
  const messageId = readNonBlankOpaqueIdentifier(checkpoint?.messageId);
  if (normalizeString(checkpoint?.kind) !== 'opencode_exclusive_message_id' || !messageId) {
    throw new Error('OpenCode fork checkpoint is not an opencode_exclusive_message_id checkpoint');
  }
  return messageId;
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
  scope: OpenCodeRuntimeScope;
  client: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  dialect?: OpenCodeServerDialect;
  readManagedServiceSnapshot?: () => ManagedServiceSnapshot | null | undefined;
  mcpRegistration: Promise<OpenCodeMcpRegistrationResult>;
  mcpProjection: OpenCodeSessionMcpProjection;
}>): OpenCodeRuntimeTurnOperations {
  const client = params.client;
  const sessionPermissions = buildOpenCodeSessionScopedPermissionRuleset(params.permissionMode, params.mcpProjection);
  const state = createOpenCodeServerRuntimeState();
  const foregroundToolTracker = createOpenCodeForegroundToolTracker();
  const messageHandlers = new Set<(message: OpenCodeRuntimeEvent) => void>();
  const handledPermissionRequestKeys = new Set<string>();
  const handledQuestionRequestKeys = new Set<string>();
  const pendingQuestionRequestKeys = new Set<string>();
  const pendingPermissionRequestKeys = new Set<string>();
  const pendingPermissionDecisionAbortControllers = new Set<AbortController>();
  const observedAutomaticCompactionMessageIds = new Set<string>();
  let activeManualCompactionId: string | null = null;
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
  let historicalIdentityReconciliationPending = false;
  let promptModel: OpenCodePromptModel | null = null;
  let promptAgent: string | null = null;
  let modelCatalog: OpenCodeModelCatalogSnapshot = { observedAt: 0, models: null };
  let modeCatalog: OpenCodeModeCatalogSnapshot = { observedAt: 0, modes: null, currentModeId: null };
  let commandCatalog: Array<Readonly<{ name: string; description?: string }>> | null = null;
  let providerObservedBusy = false;
  let nativeCommandTurnId: string | null = null;
  let nativeCommandResponsePending = false;
  const liveMessageProjectionById = new Map<string, 'assistant' | 'suppressed'>();
  const livePartTypes = new Map<string, string>();
  const livePartTexts = new Map<string, string>();
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

  const refreshCommandCatalog = async () => {
    const raw = await client.appCommands({ directory: params.directory });
    commandCatalog = (Array.isArray(raw) ? raw : []).flatMap((item) => {
      const record = asRecord(item);
      const name = normalizeString(record?.name);
      if (!name) return [];
      const description = normalizeString(record?.description);
      return [{ name, ...(description ? { description } : {}) }];
    });
    publishRuntimeEvent({ kind: 'available-commands', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now(), commands: commandCatalog });
    return commandCatalog;
  };

  const resolveNativeCommand = async (prompt: string) => {
    const name = readLeadingSlashCommandName(prompt);
    if (!name) return null;
    const commands = await refreshCommandCatalog();
    const known = commands.find((command) => normalizeSlashCommandName(command.name) === name);
    if (!known) return null;
    const match = /^\s*\/[^\s]+(?:\s([\s\S]*))?$/u.exec(prompt);
    return match ? { command: known.name, arguments: match[1] ?? '' } : null;
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
    return isOpenCodeModelSelectable({ providerID: normalizedProviderId, modelID: resolvedModelId, modelRecord })
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
      params.ctx.logger.warn('[OpenCodeServer] Failed to observe model inventory', { error });
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
  const paidUsageFingerprints = new Map<string, string>();
  const publishPaidUsage = (info: Readonly<Record<string, unknown>> | null): void => {
    if (!info || info.role !== 'assistant') return;
    const nativeSessionId = readNonBlankOpaqueIdentifier(info.sessionID);
    const inferenceId = readNonBlankOpaqueIdentifier(info.id);
    const time = asRecord(info.time);
    if (!nativeSessionId || !inferenceId || (!time?.completed && !info.finish && !info.error && info.nativeAccountingComplete !== true)) return;
    const usage = normalizeOpenCodePaidUsage(info, params.dialect ?? 'v1'); if (!usage) return;
    const modelId = readNonBlankOpaqueIdentifier(info.modelID);
    const key = JSON.stringify([nativeSessionId, inferenceId]);
    const fingerprint = JSON.stringify([modelId, usage]);
    if (paidUsageFingerprints.get(key) === fingerprint) return;
    paidUsageFingerprints.set(key, fingerprint);
    publishRuntimeEvent({ kind: 'usage-observed', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now(),
      observationId: key, source: 'opencode-native-accounting', scope: 'turn_delta', ...(modelId ? { modelId } : {}),
      accounting: { nativeSessionId, inferenceId, inputIncludesCache: usage.inputIncludesCache, outputIncludesReasoning: usage.outputIncludesReasoning,
        historyComplete: false },
      tokens: usage.tokens, ...(usage.cost ? { cost: usage.cost } : {}) });
  };
  const refreshSettledNativeAccounting = async (nativeSessionId: string): Promise<void> => {
    try {
      for (const message of await client.sessionMessages({ sessionId: nativeSessionId })) {
        publishPaidUsage(asRecord(asRecord(message)?.info));
      }
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] settled native accounting read failed (non-fatal)', { error });
    }
  };
  const refreshModelCatalog = async (): Promise<void> => {
    try {
      const providers = await client.providersList();
      const observedAt = Date.now();
      const blocks = providers.flatMap((provider) => Object.entries(provider.models ?? {}).flatMap(([id, raw]) => {
        const record = asRecord(raw);
        return record ? [{ fullId: `${provider.id}/${normalizeString(record.id) || id}`, record }] : [];
      }));
      modelCatalog = { observedAt, models: buildOpenCodePreflightModels(blocks, observedAt) };
      publishRuntimeEvent({ kind: 'model-catalog-observed', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: observedAt });
    } catch {
      // A failed observation is not an authoritative withdrawal of the last usable inventory.
      params.ctx.logger.warn('[OpenCodeServer] model inventory observation failed', { operation: 'model_inventory' });
    }
  };
  const refreshModeCatalog = async (seedInitialNativeDefault = false): Promise<void> => {
    try {
      const agents = await client.agentsList();
      const modes = agents.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) }));
      const observedAt = Date.now();
      // Released V1 Agent.list orders the configured default first; its TUI initializes
      // the first visible non-subagent. This is only a fresh-session startup fact,
      // never a substitute for a resumed session or later local TUI selection.
      const initialDefault = seedInitialNativeDefault && (params.dialect ?? 'v1') === 'v1'
        ? agents.find((agent) => agent.mode !== 'subagent' && agent.hidden !== true)?.id
        : null;
      modeCatalog = { ...modeCatalog, modes, observedAt, currentModeId: modeCatalog.currentModeId ?? initialDefault ?? null };
      publishRuntimeEvent({ kind: 'mode-catalog-observed', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: observedAt });
    } catch {
      params.ctx.logger.warn('[OpenCodeServer] mode inventory observation failed', { operation: 'mode_inventory' });
    }
  };
  const refreshAcceptedMode = async (): Promise<void> => {
    if (!state.providerSessionId) return;
    try {
      const currentModeId = await client.sessionReadAgent({ sessionId: state.providerSessionId });
      if (!currentModeId || currentModeId === modeCatalog.currentModeId) return;
      modeCatalog = { ...modeCatalog, currentModeId, observedAt: Date.now() };
      publishRuntimeEvent({ kind: 'mode-catalog-observed', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now() });
    } catch {
      params.ctx.logger.warn('[OpenCodeServer] current mode observation failed', { operation: 'current_mode' });
    }
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
    for (const keys of [state.currentTurnPublishedToolCallKeys, state.currentTurnPublishedToolResultKeys]) {
      for (const key of keys) if (!nativeToolParts.get(key)?.nativeChildLaunch) keys.delete(key);
    }
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
      publishPaidUsage(asRecord(asRecord(message)?.info));
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
          scope: params.scope,
          publishRuntimeEvent,
          mcpProjection: params.mcpProjection,
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
        ...projectOpenCodeRuntimeScope(params.scope),
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
        const projectionSessionId = state.providerSessionId;
        const scopeCurrent = (): boolean => !state.disposed && !state.turnInFlight && state.providerSessionId === projectionSessionId;
        let messages: readonly unknown[];
        try {
          messages = await client.sessionMessages({ sessionId: projectionSessionId });
        } catch (error) {
          params.ctx.logger.warn('opencode_passive_transcript_projection_failed', { phase: 'history_read' });
          params.ctx.logger.debug('[OpenCodeServer] passive transcript projection: history read failed (non-fatal)', { error });
          return;
        }
        if (!scopeCurrent()) return;
        for (const message of messages) publishPaidUsage(asRecord(asRecord(message)?.info));
        if (historicalIdentityReconciliationPending) {
          try {
            const transcripts = params.ctx.sessions.current.transcripts;
            if (!transcripts) throw new Error('Bound transcript identity reconciliation is unavailable');
            const facts = messages.flatMap((message) => {
              const projection = classifyOpenCodeMessageForProjection(message);
              if (!projection.messageId || (projection.kind !== 'user_transcript' && projection.kind !== 'assistant_transcript')) return [];
              if (projection.kind === 'assistant_transcript' && classifyOpenCodeAssistantCompletion(message).kind !== 'terminal_success') return [];
              return [{ sourceMessageId: projection.messageId, role: projection.kind === 'user_transcript' ? 'user' as const : 'assistant' as const,
                localId: buildOpenCodeRuntimeTranscriptLocalId(projectionSessionId, projection.messageId) }];
            });
            const reconciliation = await transcripts.reconcileSourceIdentities({ providerSessionId: projectionSessionId, facts });
            if (!scopeCurrent()) return;
            happierAuthoredProviderUserMessageIds.hydrateCommittedIdentities(reconciliation.hostAuthoredUserMessageIds);
            const committed = new Set(reconciliation.committedSourceMessageIds);
            for (const fact of facts) {
              if (!committed.has(fact.sourceMessageId) && reconciliation.coverage.complete) continue;
              const key = buildOpenCodeProviderSessionMessageKey(projectionSessionId, fact.sourceMessageId);
              if (fact.role === 'user') observedExternalUserMessageIds.add(key);
              else state.emittedAssistantMessageIds.add(key);
            }
            if (!reconciliation.coverage.complete) {
              params.ctx.logger.warn('opencode_history_reconciliation_incomplete', { phase: 'committed_identity_baseline',
                unmappedUsers: reconciliation.coverage.unmappedUsers, unmappedAgents: reconciliation.coverage.unmappedAgents });
              await transcripts.publishSessionEvent({ type: 'message', message: 'Some earlier OpenCode messages could not be reconciled safely because their saved message identities are incomplete. New messages will continue to sync.' });
              if (!scopeCurrent()) return;
            }
            historicalIdentityReconciliationPending = false;
          } catch (error) {
            if (!scopeCurrent()) return;
            params.ctx.logger.warn('opencode_history_reconciliation_incomplete', { phase: 'baseline_read' });
            params.ctx.logger.debug('[OpenCodeServer] committed transcript identities unavailable (non-fatal)', { error });
            return;
          }
        }
        let latestUserMessageOrigin: 'external' | 'happier_authored' | null = null;
        for (const message of messages) {
          if (!scopeCurrent()) return;
          const projection = classifyOpenCodeMessageForProjection(message);
          const messageId = projection.messageId;
          if (!messageId) continue;
          const text = readProjectedTranscriptText(message);
          if (!text) continue;
          if (projection.kind === 'user_transcript') {
            const providerMessageKey = buildOpenCodeProviderSessionMessageKey(projectionSessionId, messageId);
            const isHappierAuthored = await happierAuthoredProviderUserMessageIds.markIfHappierAuthoredProviderUserMessage({
              messageId,
              text,
              createdAtMs: projection.createdAtMs,
            });
            if (!scopeCurrent()) return;
            if (isHappierAuthored) {
              latestUserMessageOrigin = 'happier_authored';
              continue;
            }
            latestUserMessageOrigin = 'external';
            if (observedExternalUserMessageIds.has(providerMessageKey)) continue;
            observedExternalUserMessageIds.add(providerMessageKey);
            await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
              kind: 'transcript-user-text',
              ...projectOpenCodeRuntimeScope(params.scope),
              emittedAtMs: Date.now(),
              text,
              localId: buildOpenCodeRuntimeTranscriptLocalId(projectionSessionId, messageId),
              meta: {
                source: 'opencode-server-external',
                providerSessionId: projectionSessionId,
              },
            });
            continue;
          }
          if (projection.kind !== 'assistant_transcript') continue;
          if (classifyOpenCodeAssistantCompletion(message).kind !== 'terminal_success') continue;
          const providerMessageKey = buildOpenCodeProviderSessionMessageKey(projectionSessionId, messageId);
          if (latestUserMessageOrigin === 'happier_authored') {
            state.emittedAssistantMessageIds.add(providerMessageKey);
            continue;
          }
          if (state.emittedAssistantMessageIds.has(providerMessageKey)) continue;
          state.emittedAssistantMessageIds.add(providerMessageKey);
          await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
            kind: 'transcript-agent-message-committed',
            ...projectOpenCodeRuntimeScope(params.scope),
            emittedAtMs: Date.now(),
            agentId: 'opencode',
            localId: buildOpenCodeRuntimeTranscriptLocalId(projectionSessionId, messageId),
            body: {
              type: 'message',
              message: text,
            },
            meta: {
              source: 'opencode-server-external',
              providerSessionId: projectionSessionId,
            },
          });
        }
      } while (passiveTranscriptProjectionRerunRequested);
    } catch (error) {
      params.ctx.logger.warn('opencode_passive_transcript_projection_failed', { phase: 'history_commit' });
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
          scope: params.scope,
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
      scope: params.scope,
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
      scope: params.scope,
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
      scope: params.scope,
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
      scope: params.scope,
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
    const requestId = readNonBlankOpaqueIdentifier(properties.id) ?? '';
    const providerSessionId = readNonBlankOpaqueIdentifier(properties.sessionID) ?? '';
    if (
      !requestId
      || !providerSessionId
      || (providerSessionId !== state.providerSessionId && !providerNativeChildSessions.has(providerSessionId))
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
      await client.questionReject({ sessionId: providerSessionId, requestId });
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
        sessionId: providerSessionId,
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
      await client.questionReject({ sessionId: providerSessionId, requestId });
      return;
    }

    const childAttention = providerNativeChildSessions.get(providerSessionId)?.attentionAbortController;
    if (!childAttention) pendingQuestionRequestKeys.add(requestKey);
    const questionProviderSessionId = state.providerSessionId;
    const questionIsStillCurrent = (): boolean => (
      (childAttention
        ? !childAttention.signal.aborted
          && providerNativeChildSessions.get(providerSessionId)?.attentionAbortController === childAttention
        : pendingQuestionRequestKeys.has(requestKey))
      && !state.disposed
      && state.providerSessionId === questionProviderSessionId
      && !params.ctx.abort.signal.aborted
    );
    try {
      const result = await params.ctx.ui.askQuestions({
        kind: 'questions',
        title: 'OpenCode question',
        questions: hostQuestions as [typeof hostQuestions[number], ...typeof hostQuestions[number][]],
      }, childAttention ? { lifetime: 'occurrence', signal: params.ctx.abort.compose([params.ctx.abort.signal, childAttention.signal]) } : undefined);
      if (!questionIsStillCurrent()) return;
      if (result.status !== 'answered') {
        await client.questionReject({ sessionId: providerSessionId, requestId });
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
      await client.questionReply({ sessionId: providerSessionId, requestId, answers });
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] question handling failed closed', {
        requestId,
        error,
      });
      if (!questionIsStillCurrent()) return;
      await client.questionReject({
        sessionId: providerSessionId,
        requestId,
      }).catch((replyError: unknown) => {
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
    const childRequestSessionId = readEventSessionId(properties);
    const childAttention = providerNativeChildSessions.get(childRequestSessionId)?.attentionAbortController;
    const isChildRequest = childAttention !== undefined;
    const ask = readOpenCodePermissionAsk(properties, isChildRequest ? childRequestSessionId : state.providerSessionId);
    if (!ask) {
      const requestId = readOpenCodePermissionRequestId(properties);
      if (!requestId || !rememberPermissionRequest(requestId)) return;
      await client.permissionReply({
        // The request was unparseable, so its own `sessionID` is not
        // trustworthy; the session this runtime owns is.
        sessionId: isChildRequest ? childRequestSessionId : state.providerSessionId,
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
    const requestIsTurnScoped = !isChildRequest && requestTurnId !== null;
    const permissionRequestIsStillCurrent = (): boolean => {
      return !state.disposed
        && !params.ctx.abort.signal.aborted
        && (!requestIsTurnScoped || pendingPermissionRequestKeys.has(requestKey))
        && (!requestIsTurnScoped || state.activeTurnId === requestTurnId)
        && state.providerSessionId === requestProviderSessionId
        && (!childAttention || (!childAttention.signal.aborted
          && providerNativeChildSessions.get(childRequestSessionId)?.attentionAbortController === childAttention));
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
            signal: permissionDecisionSignal?.signal ?? (childAttention
              ? params.ctx.abort.compose([params.ctx.abort.signal, childAttention.signal])
              : params.ctx.abort.signal),
            ...(childAttention ? { lifetime: 'occurrence' as const } : {}),
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
          sessionId: ask.providerSessionId ?? requestProviderSessionId,
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
        if (isChildRequest) {
          params.ctx.logger.warn('opencode_child_permission_reply_failed', { childSessionId: childRequestSessionId });
          return;
        }
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

  const providerNativeChildSessions = new Map<string, Readonly<{ info: Record<string, unknown>; status: OpenCodeNativeChildStatus; attentionAbortController: AbortController }>>();
  const childTextParts = new Map<string, { sessionId: string; messageId: string; partId: string; partType: string; text: string }>();
  const childToolEventKeys = new Set<string>();
  // Released V2 separates tool name, input and result across native frames.
  const nativeToolParts = new Map<string, OpenCodeToolPart>();
  const retireNativeChildren = (): void => {
    for (const child of providerNativeChildSessions.values()) child.attentionAbortController.abort('OpenCode child scope closed');
    providerNativeChildSessions.clear();
    childTextParts.clear();
    childToolEventKeys.clear();
    nativeToolParts.clear();
    state.currentTurnPublishedToolCallKeys.clear();
    state.currentTurnPublishedToolResultKeys.clear();
  };

  const flushChildText = (childSessionId: string, messageId?: string): void => {
    for (const [key, part] of childTextParts) {
      if (part.sessionId !== childSessionId || (messageId && part.messageId !== messageId) || !part.text) continue;
      publishRuntimeEvent({
        kind: 'transcript-agent-message-committed', ...projectOpenCodeRuntimeScope(params.scope),
        emittedAtMs: Date.now(), agentId: 'opencode',
        localId: `opencode:child:${JSON.stringify([childSessionId, part.messageId, part.partId])}`,
        body: { type: part.partType === 'reasoning' ? 'thinking' : 'message', message: part.text, sidechainId: childSessionId },
        meta: { importedFrom: 'acp-sidechain', remoteSessionId: childSessionId, sidechainId: childSessionId },
      });
      childTextParts.delete(key);
    }
  };

  const handleProviderNativeChildEvent = async (type: string, properties: Record<string, unknown>, childSessionId: string): Promise<void> => {
    const child = providerNativeChildSessions.get(childSessionId);
    if (!child) return;
    if (type === 'session.status' && readStatusType(properties.status) === 'busy') {
      await observeProviderNativeChildSession(child.info, 'running', { resume: true });
      return;
    }
    if (child.status !== 'running') return;
    if (type === 'question.asked') { await handleQuestionAsked(properties); return; }
    if (type === 'permission.asked') { await handlePermissionAsked(properties); return; }
    const outcome = properties.executionOutcome;
    if (outcome === 'succeeded' || outcome === 'failed' || (outcome === 'interrupted' && properties.interruptionReason !== 'shutdown')) {
      flushChildText(childSessionId);
      await observeProviderNativeChildSession(child.info, outcome === 'succeeded' ? 'completed' : outcome === 'failed' ? 'failed' : 'aborted');
      return;
    }
    if (type === 'session.idle' || (type === 'session.status' && readStatusType(properties.status) === 'idle')) {
      const messages = await client.sessionMessages({ sessionId: childSessionId });
      const status = readOpenCodeNativeChildOutcome(messages);
      if (status) { flushChildText(childSessionId); await observeProviderNativeChildSession(child.info, status); }
      else params.ctx.logger.warn('opencode_child_outcome_unproven', { childSessionId });
      return;
    }
    if (type === 'message.updated') {
      const info = asRecord(properties.info);
      publishPaidUsage(info);
      const status = readOpenCodeNativeChildOutcome([{ info }]);
      if (status) { flushChildText(childSessionId); await observeProviderNativeChildSession(child.info, status); }
      return;
    }
    if (type === 'message.part.updated' || type === 'message.part.created') {
      const part = asRecord(properties.part);
      const tool = readOpenCodeToolPart(part);
      if (tool) {
        for (const phase of ['call', ...(isTerminalOpenCodeToolPartStatus(tool.state.status) ? ['result'] : [])]) {
          const key = JSON.stringify([childSessionId, tool.callID, phase]);
          if (childToolEventKeys.has(key)) continue;
          childToolEventKeys.add(key);
          publishRuntimeEvent({ kind: 'transcript-agent-message-committed', ...projectOpenCodeRuntimeScope(params.scope),
            emittedAtMs: Date.now(), agentId: 'opencode', localId: `opencode:child-tool:${key}`,
            body: phase === 'call'
              ? { type: 'tool-call', callId: tool.callID, name: tool.tool, input: tool.state.input ?? {}, sidechainId: childSessionId }
              : { type: 'tool-result', callId: tool.callID, output: tool.state.output ?? {}, sidechainId: childSessionId,
                ...(tool.state.status === 'completed' ? {} : { isError: true }) },
            meta: { importedFrom: 'acp-sidechain', remoteSessionId: childSessionId, sidechainId: childSessionId },
          });
        }
        return;
      }
      const projection = classifyOpenCodePartForProjection(part, { context: 'live_transcript' });
      const partId = readNonBlankOpaqueIdentifier(part?.id);
      const messageId = readNonBlankOpaqueIdentifier(part?.messageID);
      if (!partId || !messageId || (projection.kind !== 'transcript_text' && projection.kind !== 'reasoning_text')) return;
      childTextParts.set(JSON.stringify([childSessionId, partId]), { sessionId: childSessionId, messageId, partId, partType: projection.partType, text: projection.text });
      return;
    }
    if (type === 'message.part.delta' || type.startsWith('session.next.text.') || type.startsWith('session.next.reasoning.')) {
      const partType = normalizeString(properties.partType) || (type.includes('.reasoning.') ? 'reasoning' : 'text');
      const partId = readNonBlankOpaqueIdentifier(properties.partID) ?? readNonBlankOpaqueIdentifier(properties.textID) ?? readNonBlankOpaqueIdentifier(properties.reasoningID);
      const messageId = readNonBlankOpaqueIdentifier(properties.messageID) ?? readNonBlankOpaqueIdentifier(properties.assistantMessageID);
      if (!partId || !messageId) return;
      const key = JSON.stringify([childSessionId, partId]);
      const previous = childTextParts.get(key)?.text ?? '';
      const delta = typeof properties.delta === 'string' ? properties.delta : '';
      const snapshot = typeof properties.text === 'string' ? properties.text : null;
      childTextParts.set(key, { sessionId: childSessionId, messageId, partId, partType,
        text: snapshot ?? previous + delta });
      if (type.endsWith('.ended')) flushChildText(childSessionId, messageId);
    }
  };

  const observeProviderNativeChildSession = async (
    rawInfo: unknown,
    status: OpenCodeNativeChildStatus,
    options?: Readonly<{ resume?: boolean }>,
  ): Promise<void> => {
    const info = asRecord(rawInfo);
    const childSessionId = readNonBlankOpaqueIdentifier(info?.id);
    const parentSessionId = readNonBlankOpaqueIdentifier(info?.parentID);
    const subagents = params.ctx.sessions.current.subagents;
    if (
      !subagents
      || !info
      || !childSessionId
      || !parentSessionId
      || parentSessionId !== state.providerSessionId
    ) return;
    const previous = providerNativeChildSessions.get(childSessionId);
    if (previous && previous.status !== 'running' && !options?.resume) return;
    const attentionAbortController = !previous || (options?.resume && previous.status !== 'running')
      ? new AbortController()
      : previous.attentionAbortController;
    if (status !== 'running') attentionAbortController.abort('OpenCode child ended');
    providerNativeChildSessions.set(childSessionId, { info, status, attentionAbortController });
    const title = typeof info?.title === 'string' ? info.title : undefined;
    const agentKind = readNonBlankOpaqueIdentifier(info?.agent);
    await subagents.observe({
      observationId: childSessionId,
      status,
      detail: {
        origin: 'agent',
        kind: 'native',
        agentRef: {
          agentId: 'opencode',
          ...(agentKind ? { agentKind } : {}),
        },
        vendorRef: {
          agentSessionId: childSessionId,
          vendorSource: 'opencode',
        },
        ...(title === undefined ? {} : { label: title }),
        agentMetadata: { parentProviderSessionId: parentSessionId },
        ...(params.scope.kind === 'session' ? { transcript: { parentSessionId: params.scope.sessionId, sidechainId: childSessionId } } : {}),
      },
    }, { signal: params.ctx.abort.signal });
  };

  const refreshProviderNativeChildSessions = async (
    expectedChildSessionId?: string,
    expectedStatus?: 'running' | 'completed' | 'failed' | 'aborted',
  ): Promise<void> => {
    if (!state.providerSessionId || !params.ctx.sessions.current.subagents) return;
    const inventory = await client.sessionChildInventory({
      parentSessionId: state.providerSessionId,
      ...(expectedChildSessionId ? { childSessionId: expectedChildSessionId } : {}),
    });
    if (!inventory) return;
    for (const child of inventory) {
      if (
        expectedChildSessionId
        && readNonBlankOpaqueIdentifier(asRecord(child.info)?.id) !== expectedChildSessionId
      ) continue;
      const status = child.status ?? expectedStatus;
      if (status) await observeProviderNativeChildSession(child.info, status);
      else params.ctx.logger.warn('opencode_child_outcome_unproven', { childSessionId: readNonBlankOpaqueIdentifier(asRecord(child.info)?.id) });
    }
  };

  const handleProviderEvent = async (event: unknown): Promise<void> => {
    const { type, properties } = readProviderEvent(event);
    if (!type) return;
    const eventDirectory = normalizeString(asRecord(event)?.directory);
    if (eventDirectory && eventDirectory !== params.directory) return;
    const eventSessionId = readEventSessionId(properties);

    if (type.startsWith('session.next.tool.')) {
      if (!eventSessionId || (eventSessionId !== state.providerSessionId && !providerNativeChildSessions.has(eventSessionId))) return;
      const callID = readNonBlankOpaqueIdentifier(properties.id);
      if (!callID) return;
      const key = readOpenCodeToolCallKey({ sessionID: eventSessionId, callID });
      const previous = nativeToolParts.get(key);
      const content = Array.isArray(properties.content) ? properties.content : [];
      const output = type.endsWith('.success')
        ? content.flatMap((rawPart) => {
          const part = asRecord(rawPart);
          return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
        }).join('\n')
        : type.endsWith('.failed') ? { error: properties.error } : previous?.state.output;
      const part = readOpenCodeToolPart({
        type: 'tool', sessionID: eventSessionId, callID,
        messageID: properties.assistantMessageID ?? previous?.messageID,
        tool: properties.name ?? previous?.tool,
        state: {
          status: type.endsWith('.success') ? 'completed' : type.endsWith('.failed') ? 'error' : 'running',
          input: properties.input ?? previous?.state.input,
          output,
          metadata: { ...asRecord(previous?.state.metadata), ...asRecord(properties.metadata) },
        },
      });
      if (!part || (eventSessionId === state.providerSessionId && !part.nativeChildLaunch)) return;
      nativeToolParts.set(key, part);
      if (type.endsWith('.input.started') || type.endsWith('.input.delta') || type.endsWith('.input.ended')) return;
      await handleProviderEvent({ payload: { type: 'message.part.updated', properties: { part: { type: 'tool', ...part } } } });
      return;
    }

    if (eventSessionId && (type === 'session.next.step.ended' || type === 'session.next.step.failed'
      || type === 'session.next.compaction.ended')) await refreshSettledNativeAccounting(eventSessionId);

    if (type === 'session.created') {
      await observeProviderNativeChildSession(properties.info, 'running');
      return;
    }
    if (eventSessionId && state.providerSessionId && eventSessionId !== state.providerSessionId) {
      await handleProviderNativeChildEvent(type, properties, eventSessionId);
      return;
    }

    if (type.startsWith('session.next.')) {
      const messageId = readNonBlankOpaqueIdentifier(properties.messageID)
        ?? readNonBlankOpaqueIdentifier(properties.assistantMessageID)
        ?? '';
      observeCurrentTurnMessageId(messageId);
      if (messageId && (type.startsWith('session.next.text.') || type.startsWith('session.next.reasoning.'))) {
        if (!liveMessageProjectionById.has(messageId)) liveMessageProjectionById.set(messageId, 'assistant');
        if (liveMessageProjectionById.get(messageId) === 'assistant') beginProviderTurnIfNeeded();
      }
      if (
        type === 'session.next.compaction.started'
        || type === 'session.next.compaction.ended'
      ) {
        if (activeManualCompactionId) {
          if (type.endsWith('.ended')) {
            const compactionId = activeManualCompactionId;
            activeManualCompactionId = null;
            const error = asRecord(properties.error);
            publishRuntimeEvent({
              kind: 'context-compaction',
              ...projectOpenCodeRuntimeScope(params.scope),
              emittedAtMs: Date.now(),
              compactionId,
              phase: error ? 'failed' : 'completed',
              trigger: 'manual',
              ...(error ? { diagnostic: {
                code: 'opencode_compaction_failed',
                severity: 'error',
                message: readOpenCodeProviderErrorMessage(error) || 'OpenCode compaction failed',
              } } : {}),
            });
          }
          return;
        }
        if (!messageId) return;
        const reason = normalizeString(properties.reason).toLowerCase();
        publishRuntimeEvent({
          kind: 'context-compaction',
          ...projectOpenCodeRuntimeScope(params.scope),
          emittedAtMs: Date.now(),
          compactionId: messageId,
          phase: type.endsWith('.started') ? 'started' : 'completed',
          trigger: reason === 'auto' || reason === 'threshold' || reason === 'overflow'
            ? 'automatic'
            : 'manual',
        });
      }
      return;
    }

    if (type === 'todo.updated') {
      await publishNativeTodosWorkState().catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish todo work-state update', { error });
      });
      return;
    }

    if (type === 'server.connected') {
      markServerConnected();
      await refreshModelCatalog();
      await refreshModeCatalog();
      await refreshAcceptedMode();
      await refreshCommandCatalog().catch((error: unknown) => params.ctx.logger.warn('opencode_command_catalog_read_failed', { error }));
      await refreshProviderNativeChildSessions().catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to refresh provider-native child sessions (non-fatal)', {
          error,
        });
      });
      // Lane H/S2: catch up on externally-authored (e.g. TUI) turns when no Happier turn is active.
      // Self-gates on `turnInFlight`, so it is a no-op during an active turn (live path owns it).
      await projectExternalSessionMessagesBestEffort();
      return;
    }
    if (type === 'provider.updated' || type === 'model.updated') {
      await refreshModelCatalog();
      return;
    }
    if (type === 'agent.updated') {
      await refreshModeCatalog();
      return;
    }
    if (type === 'session.updated') {
      await refreshAcceptedMode();
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
      const partId = readNonBlankOpaqueIdentifier(rawPart?.id);
      if (partId) livePartTypes.set(partId, normalizeString(rawPart?.type));
      const messageId = readNonBlankOpaqueIdentifier(rawPart?.messageID) ?? '';
      const textProjection = classifyOpenCodePartForProjection(rawPart, { context: 'live_transcript' });
      if (partId && textProjection.kind === 'ignored_internal') livePartTypes.set(partId, 'suppressed');
      if (partId && liveMessageProjectionById.get(messageId) === 'assistant' && state.turnInFlight
        && (textProjection.kind === 'transcript_text' || textProjection.kind === 'reasoning_text')) {
        const previous = livePartTexts.get(partId) ?? '';
        if (textProjection.text.startsWith(previous)) {
          publishLiveText(messageId, textProjection.partType, textProjection.text.slice(previous.length));
        } else {
          params.ctx.logger.warn('opencode_live_text_snapshot_replaced', { messageId, partId });
        }
        livePartTexts.set(partId, textProjection.text);
      }
      observeCurrentTurnMessageId(readNonBlankOpaqueIdentifier(rawPart?.messageID) ?? '');
      const part = readOpenCodeToolPart(rawPart);
      if (!part) return;
      const childMetadata = asRecord(part.state.metadata);
      const providerNativeChildSessionId = readNonBlankOpaqueIdentifier(childMetadata?.sessionId) ?? readNonBlankOpaqueIdentifier(childMetadata?.sessionID);
      if (providerNativeChildSessionId) {
        await refreshProviderNativeChildSessions(
          providerNativeChildSessionId,
          projectOpenCodeNativeChildStatus(part),
        ).catch((error: unknown) => {
          params.ctx.logger.debug(
            '[OpenCodeServer] failed to refresh provider-native child session after tool update (non-fatal)',
            { error },
          );
        });
      }
      if (part.nativeChildLaunch) nativeToolParts.set(readOpenCodeToolCallKey(part), part);
      if (!state.turnInFlight && !part.nativeChildLaunch) return;
      if (state.turnInFlight) {
        foregroundToolTracker.observeToolPart({ part });
        observeCurrentTurnToolPart(part);
      }
      publishOpenCodeToolPartRuntimeEvents({
        part,
        state,
        scope: params.scope,
        publishRuntimeEvent,
        mcpProjection: params.mcpProjection,
      });
      return;
    }

    if (type === 'message.updated') {
      const info = asRecord(properties.info);
      publishPaidUsage(info);
      const messageId = readNonBlankOpaqueIdentifier(info?.id) ?? '';
      const messageProjection = classifyOpenCodeMessageForProjection({ info });
      if (messageId && messageProjection.kind === 'assistant_transcript'
        && (!asRecord(info?.time)?.completed || liveMessageProjectionById.get(messageId) === 'assistant'
          || (state.currentTurnProviderUserMessageId !== null
            && readNonBlankOpaqueIdentifier(info?.parentID) === state.currentTurnProviderUserMessageId))) {
        liveMessageProjectionById.set(messageId, 'assistant');
      } else if (messageId && messageProjection.kind !== 'unknown') {
        liveMessageProjectionById.set(messageId, 'suppressed');
      }
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
          ...projectOpenCodeRuntimeScope(params.scope),
          emittedAtMs,
          compactionId: messageId,
          phase: 'started',
          trigger: 'automatic',
        });
        publishRuntimeEvent({
          kind: 'context-compaction',
          ...projectOpenCodeRuntimeScope(params.scope),
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
      const messageId = readNonBlankOpaqueIdentifier(properties.messageID) ?? '';
      const partId = readNonBlankOpaqueIdentifier(properties.partID) ?? '';
      const nativePartType = normalizeString(properties.partType);
      if (livePartTypes.get(partId) === 'suppressed') return;
      const partType = nativePartType || livePartTypes.get(partId);
      if ((nativePartType === 'text' || nativePartType === 'reasoning') && !liveMessageProjectionById.has(messageId)) {
        liveMessageProjectionById.set(messageId, 'assistant');
      }
      if (!messageId || liveMessageProjectionById.get(messageId) !== 'assistant' || (partType !== 'text' && partType !== 'reasoning')) return;
      beginProviderTurnIfNeeded();
      observeCurrentTurnMessageId(messageId);
      const text = typeof properties.delta === 'string' ? properties.delta : '';
      if (partId) livePartTexts.set(partId, (livePartTexts.get(partId) ?? '') + text);
      publishLiveText(messageId, partType, text);
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
      const messageId = readNonBlankOpaqueIdentifier(info?.id) ?? '';
      if (!state.turnInFlight) {
        if (
          state.providerSessionId
          && readNonBlankOpaqueIdentifier(info?.sessionID) === state.providerSessionId
        ) {
          // Replayable events are content-free invalidations outside a Happier turn. The
          // authoritative message inventory remains the sole transcript owner.
          await projectExternalSessionMessagesBestEffort();
        }
        return;
      }
      if (
        !messageId
        || normalizeString(info?.role) !== 'assistant'
        || readNonBlankOpaqueIdentifier(info?.sessionID) !== state.providerSessionId
        || readNonBlankOpaqueIdentifier(info?.parentID) !== state.currentTurnProviderUserMessageId
      ) {
        return;
      }
      await handleProviderEvent(event);
      return;
    }

    if (type === 'message.part.updated' || type === 'message.part.created' || type === 'message.part.delta') {
      if (!state.turnInFlight || !state.providerSessionId) return;
      const part = type === 'message.part.delta' ? properties : asRecord(properties.part);
      const messageId = readNonBlankOpaqueIdentifier(part?.messageID) ?? '';
      if (
        !messageId
        || readNonBlankOpaqueIdentifier(part?.sessionID) !== state.providerSessionId
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

    if (type === 'server.connected' || type === 'permission.asked' || type === 'question.asked') {
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
      scope: params.scope,
      stopNativeRetry,
    });
    if (await failCurrentTurnForProviderErrorStatus(status)) return;
    const statusType = readStatusType(status);
    if (statusType === 'busy') {
      providerObservedBusy = true;
      beginProviderTurnIfNeeded();
      state.currentTurnIdleObserved = false;
      return;
    }
    if (statusType === 'idle') {
      providerObservedBusy = false;
      if (nativeCommandTurnId !== null && state.activeTurnId === nativeCommandTurnId) {
        if (nativeCommandResponsePending) return;
        await completeOpenCodeTurnIfReady({ publishRuntimeEvent, state, foregroundToolTracker, scope: params.scope,
          resetCurrentTurnObservations, status, hasLiveProviderWork: turnHasLiveForegroundWork });
        nativeCommandTurnId = null;
        await projectExternalSessionMessagesBestEffort();
        return;
      }
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

  const beginProviderTurnIfNeeded = (): void => {
    if (state.disposed || state.turnInFlight || !state.providerSessionId) return;
    state.activeTurnId = randomUUID();
    state.turnInFlight = true;
    resetCurrentTurnObservations();
    nativeCommandTurnId = state.activeTurnId;
    nativeCommandResponsePending = false;
    managedServerTurnInterruptionSupervisor.captureTurnStartSnapshot();
    publishRuntimeEvent({ kind: 'turn-start', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now(),
      turnId: state.activeTurnId, startedBy: 'provider' });
  };

  const publishLiveText = (messageId: string, partType: string, text: string): void => {
    if (!text || !state.activeTurnId || !state.providerSessionId) return;
    publishRuntimeEvent({ kind: 'message-delta', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now(),
      turnId: state.activeTurnId, channel: partType === 'reasoning' ? 'reasoning' : 'assistant', text,
      ...(partType === 'text' ? { messageId: buildOpenCodeRuntimeTranscriptLocalId(state.providerSessionId, messageId) } : {}),
    });
  };

  return {
    beginTurnLifecycle(turnId) {
      state.activeTurnId = turnId;
      state.turnInFlight = true;
      resetCurrentTurnObservations();
      managedServerTurnInterruptionSupervisor.captureTurnStartSnapshot();
      void publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
        kind: 'turn-start',
        ...projectOpenCodeRuntimeScope(params.scope),
        turnId: state.activeTurnId,
        emittedAtMs: Date.now(),
      }).catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish turn-start event', { error });
      });
    },
    async openSession(request) {
      if (request.kind === 'resume') {
        // OpenCode minted this id: resume the exact session, never a re-minted one.
        state.providerSessionId = readNonBlankOpaqueIdentifier(request.providerSessionId);
        if (state.providerSessionId) {
          await client.sessionUpdatePermissions({
            sessionId: state.providerSessionId,
            permissions: sessionPermissions,
          });
        }
      } else if (request.kind === 'fork') {
        const parentProviderSessionId = readNonBlankOpaqueIdentifier(request.source.providerSessionId);
        if (!parentProviderSessionId) {
          throw new Error('OpenCode fork requires a parent provider session id');
        }
        const messageId = readOpenCodeForkMessageId(request);
        const forked = await client.sessionFork({
          sessionId: parentProviderSessionId,
          ...(messageId ? { messageId } : {}),
        });
        state.providerSessionId = forked.id;
        await client.sessionUpdatePermissions({
          sessionId: state.providerSessionId,
          permissions: sessionPermissions,
        });
      } else {
        const created = await client.sessionCreate({
          directory: params.directory,
          permissions: sessionPermissions,
        });
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
      liveMessageProjectionById.clear();
      livePartTypes.clear();
      livePartTexts.clear();
      state.emittedAssistantMessageIds.clear();
      observedExternalUserMessageIds.clear();
      historicalIdentityReconciliationPending = request.kind === 'resume';
      observedAutomaticCompactionMessageIds.clear();
      await happierAuthoredProviderUserMessageIds.hydrate();
      handledPermissionRequestKeys.clear();
      retireNativeChildren();
      abortPendingPermissionDecisions('OpenCode provider session reset');
      pendingPermissionRequestKeys.clear();
      handledQuestionRequestKeys.clear();
      retirePendingQuestions();
      await refreshModelCatalog();
      await refreshModeCatalog(request.kind === 'create');
      await refreshAcceptedMode();
      await refreshCommandCatalog().catch((error: unknown) => params.ctx.logger.warn('opencode_command_catalog_read_failed', { error }));
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
      const nativeCommand = await resolveNativeCommand(prompt);

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

      if (!nativeCommand) {
        state.currentTurnProviderPromptTexts.clear();
        state.currentTurnProviderPromptTexts.add(prompt);
      }
      const promptSubmittedAtMs = Date.now();
      state.currentTurnPromptSubmittedAtMs = promptSubmittedAtMs;
      if (!nativeCommand) happierAuthoredProviderUserMessageIds.recordPendingPromptAnchor({
        text: prompt,
        submittedAtMs: promptSubmittedAtMs,
      });
      const failPromptSubmission = async (error: unknown): Promise<void> => {
        if (!nativeCommand) await markCurrentProviderUserMessageFromHistoryBestEffort('prompt_submission_failed');
        const failedTurnId = claimOpenCodeActiveTurnForTerminalEvent(state);
        if (failedTurnId) {
          const emittedAtMs = Date.now();
          resetCurrentTurnObservations();
          await publishOpenCodeTurnFailed({
            publishRuntimeEvent,
            scope: params.scope,
            turnId: failedTurnId,
            emittedAtMs,
            issue: buildOpenCodeRuntimeIssue({
              code: isPromptRejectedBeforeProviderEffect(error)
                ? 'opencode_prompt_rejected'
                : 'opencode_prompt_submission_failed',
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
            scope: params.scope,
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
        // Only a *refused* registration fails admission closed. A server with
        // no dynamic MCP route at all (`unsupported`) costs this session
        // Happier's MCP-backed tools, which the registration owner already
        // reported on a default-on signal, and is not a reason to block
        // ordinary prompting.
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
        if (!nativeCommand || meta?.delivery !== 'steer') {
          state.currentTurnProviderUserMessageIds.clear();
          state.currentTurnTerminalAssistantMessageIds.clear();
          state.currentTurnProviderUserMessageId = null;
          state.currentTurnIdleObserved = false;
        }
        const perPromptModelId = normalizeString(meta?.modelId);
        const modelForPrompt = perPromptModelId
          ? await resolveRequiredPromptModel(perPromptModelId)
          : promptModel;
        assertPromptTurnStillOwnsDispatch();
        if (nativeCommand) {
          if (state.promptConfig) throw new Error('OpenCode native commands do not support legacy prompt config fields');
          if (meta?.delivery !== 'steer') {
            nativeCommandTurnId = turnId;
            nativeCommandResponsePending = true;
          }
          const retired = createDeferred<never>();
          const retirePendingCallback = (event: OpenCodeRuntimeEvent): void => {
            if ('turnId' in event && event.turnId === turnId && (event.kind === 'turn-cancelled' || event.kind === 'turn-failed')) {
              retired.reject(new OpenCodePromptTurnRetiredBeforeDispatchError());
            }
          };
          messageHandlers.add(retirePendingCallback);
          try {
            await Promise.race([retired.promise, client.sessionCommand({ sessionId: providerSessionId, ...nativeCommand,
              parts: (meta?.promptParts ?? []).filter((part, index) => !(index === 0 && part.type === 'text' && part.text === prompt)),
              ...(modelForPrompt ? { model: modelForPrompt } : {}),
              ...(promptAgent ? { agent: promptAgent } : {}),
              ...(state.promptVariant ? { variant: state.promptVariant } : {}),
              ...(meta?.delivery ? { delivery: meta.delivery } : {}),
            })]);
            if (meta?.delivery !== 'steer') assertPromptTurnStillOwnsDispatch();
          } finally {
            messageHandlers.delete(retirePendingCallback);
            if (nativeCommandTurnId === turnId) nativeCommandResponsePending = false;
          }
          if (meta?.delivery !== 'steer' && state.activeTurnId === turnId && !providerObservedBusy) {
            await handleStatus({ type: 'idle' }, { forceHistoryRefresh: true });
          }
          return { providerUserMessageId: null, ...(modelForPrompt ? { effectiveModelId: `${modelForPrompt.providerID}/${modelForPrompt.modelID}` } : {}) };
        }
        const promptSubmission = await client.sessionPromptAsync({
          sessionId: providerSessionId,
          text: prompt,
          ...(meta?.promptParts ? { parts: meta.promptParts } : {}),
          ...(modelForPrompt ? { model: modelForPrompt } : {}),
          ...(promptAgent ? { agent: promptAgent } : {}),
          ...(state.promptVariant ? { variant: state.promptVariant } : {}),
          ...(state.promptConfig ? { config: state.promptConfig } : {}),
        });
        void refreshCommandCatalog().catch((error: unknown) => params.ctx.logger.warn('opencode_command_catalog_read_failed', { error }));
        const admittedMessageId = readNonBlankOpaqueIdentifier(asRecord(promptSubmission)?.id);
        let providerUserMessageId: string;
        if (admittedMessageId) {
          providerUserMessageId = admittedMessageId;
          state.currentTurnProviderUserMessageId = admittedMessageId;
          state.currentTurnProviderUserMessageIds.add(admittedMessageId);
          await markProviderUserMessageAsHappierAuthored(admittedMessageId);
          observeCurrentTurnMessageId(admittedMessageId);
        } else {
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
          providerUserMessageId = providerUserMessageResolution.providerUserMessageId;
        }
        state.currentTurnPromptAcceptedAtMs = Date.now();
        if (promptAgent && (params.dialect ?? 'v1') === 'v1') {
          modeCatalog = { ...modeCatalog, currentModeId: promptAgent, observedAt: state.currentTurnPromptAcceptedAtMs };
          publishRuntimeEvent({ kind: 'mode-catalog-observed', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: state.currentTurnPromptAcceptedAtMs });
        }
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
        if (meta?.delivery === 'steer' && isPromptRejectedBeforeProviderEffect(error)) throw error;
        if (
          error instanceof OpenCodePromptIdentityUnresolvedError
          || error instanceof OpenCodePromptTurnRetiredBeforeDispatchError
        ) throw error;
        await failPromptSubmission(error);
        throw error;
      }
    },
    async steerInFlightTurn(message, meta) {
      return await this.sendTurnPrompt(message, { ...meta, delivery: 'steer' });
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
        scope: params.scope,
        stopNativeRetry,
      });
      if (await failCurrentTurnForProviderErrorStatus(status)) return;
      if (readStatusType(status) === 'busy') {
        providerObservedBusy = true;
        return;
      }
      if (nativeCommandTurnId !== null && state.activeTurnId === nativeCommandTurnId) {
        await handleStatus(status, { forceHistoryRefresh: true });
        return;
      }
      const historyProjection = await reconcileExactCurrentTurnTerminalAssistantFromAuthoritativeInventoryBestEffort();
      if (await failCurrentTurnForPromptResponseError(historyProjection)) return;
      await completeTurnIfReady(status, historyProjection);
    },
    subscribeRuntimeEvents(handler) {
      messageHandlers.add(handler);
      if (commandCatalog) handler({ kind: 'available-commands', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now(), commands: commandCatalog });
      return () => {
        messageHandlers.delete(handler);
      };
    },
    async cancelTurn() {
      const turnId = state.turnInFlight ? state.activeTurnId : null;
      if (!turnId) return;
      if (state.providerSessionId) {
        await client.sessionAbort({ sessionId: state.providerSessionId });
      }
      if (!state.turnInFlight || state.activeTurnId !== turnId) return;
      claimOpenCodeActiveTurnForTerminalEvent(state);
      retirePendingQuestions();
      resetCurrentTurnObservations();
      providerObservedBusy = false;
      nativeCommandTurnId = null;
      nativeCommandResponsePending = false;
      wakeServerConnectedWaiters();
      await publishOpenCodeTurnCancelled({
        publishRuntimeEvent,
        scope: params.scope,
        turnId,
        reason: 'cancelled',
        emittedAtMs: Date.now(),
      });
    },
    async listSkills(input = {}) {
      const directory = normalizeString(input.directory) || params.directory;
      return await client.appSkills({ directory });
    },
    readSessionIdentity() {
      return { sessionId: state.providerSessionId };
    },
    readModelCatalog() {
      return modelCatalog;
    },
    readModeCatalog() {
      return modeCatalog;
    },
    isHappierAuthoredProviderUserMessageId(messageId) {
      return happierAuthoredProviderUserMessageIds.has(messageId);
    },
    async updateSessionRuntimeConfig(update) {
      const promptConfigUpdate = normalizeOpenCodePromptConfigUpdate(update);
      const providerSessionId = state.providerSessionId;
      if (!providerSessionId) throw new Error('OpenCode session configuration requires an open provider session');
      const modeId = normalizeString(update.modeId);
      if (modeId) {
        await client.sessionSetAgent({ sessionId: providerSessionId, agent: modeId });
        promptAgent = modeId;
        if (params.dialect === 'v2') {
          modeCatalog = { ...modeCatalog, currentModeId: modeId, observedAt: Date.now() };
          publishRuntimeEvent({ kind: 'mode-catalog-observed', ...projectOpenCodeRuntimeScope(params.scope), emittedAtMs: Date.now() });
        }
      }
      if (promptConfigUpdate.hasModel) {
        const requestedModelId = normalizeString(update.modelId);
        if (!requestedModelId || requestedModelId === 'default') {
          promptModel = null;
        } else {
          const selectedModel = await resolveRequiredPromptModel(requestedModelId);
          await client.sessionSetModel({ sessionId: providerSessionId, model: selectedModel, variant: state.promptVariant });
          promptModel = selectedModel;
        }
      }
      if (promptConfigUpdate.variant) {
        await client.sessionSetModel({ sessionId: providerSessionId, model: promptModel, variant: promptConfigUpdate.variant });
        state.promptVariant = promptConfigUpdate.variant;
      }
      if (promptConfigUpdate.hasConfig) {
        state.promptConfig = promptConfigUpdate.config;
      }
      params.ctx.experimental.telemetry.emit({
        kind: 'opencode.runtime_config_update',
        update,
      });
      return params.dialect === 'v2' ? 'applied' : 'deferred';
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
        ...projectOpenCodeRuntimeScope(params.scope),
        emittedAtMs: Date.now(),
        compactionId: request.compactionId,
        phase: 'started',
        trigger: 'manual',
      });
      try {
        activeManualCompactionId = request.compactionId;
        await client.sessionSummarize({
          sessionId: providerSessionId,
          model,
          auto: false,
        });
        if ((params.dialect ?? 'v1') === 'v1') {
          activeManualCompactionId = null;
          publishRuntimeEvent({
            kind: 'context-compaction',
            ...projectOpenCodeRuntimeScope(params.scope),
            emittedAtMs: Date.now(),
            compactionId: request.compactionId,
            phase: 'completed',
            trigger: 'manual',
          });
        }
      } catch (error) {
        activeManualCompactionId = null;
        publishRuntimeEvent({
          kind: 'context-compaction',
          ...projectOpenCodeRuntimeScope(params.scope),
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
      paidUsageFingerprints.clear();
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
      providerObservedBusy = false;
      nativeCommandTurnId = null;
      nativeCommandResponsePending = false;
      liveMessageProjectionById.clear();
      livePartTypes.clear();
      livePartTexts.clear();
      promptModel = null;
      promptAgent = null;
      handledPermissionRequestKeys.clear();
      retireNativeChildren();
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
