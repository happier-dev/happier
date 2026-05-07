import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@/agent';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata, PermissionMode } from '@/api/types';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import { configuration } from '@/configuration';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { isChangeTitleToolNameAlias } from '@happier-dev/protocol';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { isAbortLikeError } from '@/agent/executionRuns/runtime/turnDelivery';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';

import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from './types';
import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from './client';
import { extractOpenCodeTextHistoryItems, importOpenCodeTextHistoryCommitted } from './openCodeSessionMessageImport';
import { extractOpenCodeRuntimeRenderableTextFromPart } from './openCodeRenderableText';
import { extractOpenCodeTaskChildSessionId, importOpenCodeTaskSidechainBestEffort } from './openCodeTaskSidechainImport';
import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';
import { asRecord, normalizeString, normalizeStringArray } from './openCodeParsing';
import { extractOpenCodeErrorText } from './openCodeErrorText';
import { extractOpenCodeSessionMessageId, parseOpenCodeToolPart } from './openCodeMessageParsing';
import { canonicalizeOpenCodeConfiguredMcpToolName } from './openCodeMcpToolNames';
import { parseOpenCodeModelId, resolveOpenCodeDefaultProviderIdFromModelId } from './openCodeModelParsing';
import { parsePermissionRequest } from './openCodePermissionParsing';
import { readOpenCodeUsageTelemetryFromMessageInfo } from './openCodeUsageTelemetry';
import {
  buildQuestionAnswersArray,
  extractBashCommandHint,
  hasAnyMeaningfulInputFields,
  looksLikeFreeformQuestionHintLabel,
  openCodeQuestionRecordLooksLikeInternalTitleUpdate,
  parseQuestionRequest,
} from './openCodeQuestionParsing';
import {
  createOpenCodeAscendingMessageId,
  resolveOpenCodeUserMessageIdFromMetadata,
  upsertOpenCodeUserMessageIdInMetadata,
} from './openCodeUserMessageIds';
import { buildOpenCodeSessionPermissionRuleset } from '@/backends/openCodeFamily/permission/openCodeFamilyPermissionPolicy';
import { resolvePreferredChangeTitleToolNameForProvider } from '@/agent/prompting/coding/providerToolAliasRegistry';
import { extractOpenCodeFileDiff } from '../utils/extractOpenCodeFileDiff';
import { readOpenCodeSessionRuntimeHandleFromMetadata } from '../utils/opencodeSessionAffinity';
import { extractOpenCodeSessionDiffPayload } from './extractOpenCodeSessionDiffPayload';
import { buildOpenCodeThinkingModelOptionsFromVariants } from '../modelOptions/openCodeThinkingModelOption';
import { readContextWindowTokensFromModelRecord } from '@/backends/modelCapabilities/contextWindowTokens';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function isPromiseLike<T>(value: PromiseLike<T> | T | void): value is PromiseLike<T> {
  return Boolean(value) && typeof (value as PromiseLike<T>).then === 'function';
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<
  | { type: 'resolved'; value: T }
  | { type: 'rejected'; error: unknown }
  | { type: 'timeout' }
> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ type: 'resolved' as const, value })).catch((error) => ({ type: 'rejected' as const, error })),
      new Promise<{ type: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function normalizeEnvVar(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldSurfaceOpenCodeErrorDetail(detail: unknown): detail is string {
  if (typeof detail !== 'string') return false;
  const trimmed = detail.trim();
  if (!trimmed) return false;
  return !isAbortLikeError(trimmed);
}

class OpenCodeControlPlaneRequestListError extends Error {
  readonly requestKind: 'permission' | 'question';

  readonly cause: unknown;

  constructor(requestKind: 'permission' | 'question', cause: unknown) {
    const detail = extractOpenCodeErrorText(cause);
    super(detail ? `OpenCode ${requestKind} list failed: ${detail}` : `OpenCode ${requestKind} list failed`);
    this.name = 'OpenCodeControlPlaneRequestListError';
    this.requestKind = requestKind;
    this.cause = cause;
  }
}

export type OpenCodeServerRuntimeDeps = Readonly<{
  createClient?: typeof createOpenCodeServerRuntimeClient;
}>;

export function createOpenCodeServerRuntime(params: {
  directory: string;
  env?: NodeJS.ProcessEnv;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: ProviderEnforcedPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
}, deps: OpenCodeServerRuntimeDeps = {}) {
  const provider: ACPProvider = 'opencode';
  const createClient = deps.createClient ?? createOpenCodeServerRuntimeClient;
  const env = params.env ?? process.env;
  const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'opencode-server' });

  let client: OpenCodeServerRuntimeClient | null = null;
  let sessionId: string | null = null;
  let subscriptionAbort: AbortController | null = null;
  let currentContextWindowTokens: number | null = null;

  let selectedAgent: string | null = null;
  let selectedModel: OpenCodeModelRef | null = null;
  const configOverrides: Record<string, unknown> = {};
  let omitCustomMessageIdForResumedSession = false;
  let ensuredMcpServersForDirectory = false;
  const ensuredMcpServerNames = new Set<string>();

  let turnDeferred: Deferred<void> | null = null;
  let turnInFlight = false;
  let turnPromptActive = false;
  let turnActivitySeen = false;
  let turnUserMessageId: string | null = null;
  let turnPromptLocalId: string | null = null;
  let turnPromptTextForBackfill = '';
  let turnPromptEffectiveTextForBackfill = '';
  let turnPrePromptMessageIdsAll: ReadonlySet<string> | null = null;
  let turnPreexistingMessageIds: ReadonlySet<string> | null = null;
  const turnUserMessageIds = new Set<string>();
  const turnAssistantMessageIds = new Set<string>();
  const turnStreamedAssistantMessageIds = new Set<string>();
  const turnBackfilledAssistantMessageIds = new Set<string>();
  let turnAssistantBackfillAttempts = 0;
  let turnAssistantBackfillFirstAttemptAtMs: number | null = null;
  let turnAssistantBackfillIdleAttempted = false;
  let idleSignalSeen = false;
  let idleSignalSeenViaControlPlane = false;
  let statusPollBusySeen = false;
  let resolveOnIdleInFlight = false;
  let turnControlAbort: AbortController | null = null;
  let handledPermissionIds: Set<string> | null = null;
  let handledQuestionIds: Set<string> | null = null;
  let inFlightPermissionIds: Set<string> | null = null;
  let inFlightQuestionIds: Set<string> | null = null;
  let userMessageIdLastTimestampMs = 0;
  let userMessageIdCounter = 0;
  const observedRemoteTextMessageIds = new Set<string>();
  let liveHistorySyncPromise: Promise<void> | null = null;
  let suppressSessionErrorAbortNotificationForSessionId: string | null = null;
  let queuedLiveHistorySyncAllowAssistantReplies = false;
  const turnChangeCollector = new TurnChangeSetCollector({
    provider,
    snapshotUnifiedDiff: true,
  });
  let turnChangeCollectorEpoch = 0;
  let turnStartSeqInclusive = 0;

  let turnStreamKey: string | null = null;
  const accumulatedTextByPartKey = new Map<string, string>();
  const pendingInlinePartSnapshotsByMessagePartKey = new Map<string, {
    text: string;
    partType: string;
    remoteSessionId: string;
    messageID: string;
    sidechainId: string | null;
  }>();

  const resolveSessionPermissionRuleset = (): ReadonlyArray<{ permission: string; pattern: string; action: 'ask' | 'allow' | 'deny' }> =>
    buildOpenCodeSessionPermissionRuleset(params.getPermissionMode?.() ?? 'default');

  const partTypeByPartKey = new Map<string, string>();
  const toolCallSentByCallId = new Set<string>();
  const toolResultSentByCallId = new Set<string>();
  const observedToolPartByCallKey = new Map<string, NonNullable<ReturnType<typeof parseOpenCodeToolPart>>>();

  const buildOpenCodeToolCallKey = (remoteSessionId: string, callId: string): string => `${remoteSessionId}:${callId}`;

  const resolveOpenCodeToolNameForAcp = (toolRaw: string): string => {
    const normalizedTool = toolRaw.trim();
    const toolLower = normalizedTool.toLowerCase();
    const canonicalMcpToolName =
      canonicalizeOpenCodeConfiguredMcpToolName(normalizedTool, params.mcpServers);
    return canonicalMcpToolName ?? (toolLower === 'grep' ? 'search' : normalizedTool);
  };

  const buildOpenCodePermissionFallbackInput = (metadata: Record<string, unknown>): Record<string, unknown> => {
    const filePath =
      normalizeString((metadata as any).filePath)
      || normalizeString((metadata as any).filepath)
      || normalizeString((metadata as any).path);
    const parentDir = normalizeString((metadata as any).parentDir);
    const out: Record<string, unknown> = {};
    if (filePath) {
      out.filePath = filePath;
      out.filepath = filePath;
    }
    if (parentDir) {
      out.parentDir = parentDir;
    }
    return out;
  };

  const findToolPartForPermissionRequest = async (
    req: OpenCodePermissionRequest,
  ): Promise<NonNullable<ReturnType<typeof parseOpenCodeToolPart>> | null> => {
    const remoteCallId = normalizeString(req.tool?.callID);
    const remoteMessageId = normalizeString(req.tool?.messageID);
    if (!remoteCallId || !remoteMessageId) return null;

    const callKey = buildOpenCodeToolCallKey(req.sessionID, remoteCallId);
    const observed = observedToolPartByCallKey.get(callKey);
    if (observed) {
      return observed;
    }

    try {
      const c = await ensureClient();
      const rawMessages = await c.sessionMessagesList({ sessionId: req.sessionID });
      if (!Array.isArray(rawMessages)) return null;

      for (const rawMessage of rawMessages) {
        const message = asRecord(rawMessage);
        if (!message) continue;
        const info = asRecord(message.info);
        if (normalizeString(info?.id) !== remoteMessageId) continue;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        for (const rawPart of parts) {
          const parsed = parseOpenCodeToolPart(rawPart);
          if (!parsed) continue;
          if (parsed.sessionID !== req.sessionID || parsed.callID !== remoteCallId) continue;
          observedToolPartByCallKey.set(callKey, parsed);
          return parsed;
        }
      }
    } catch (error) {
      logger.debug('[OpenCodeServer] failed to resolve blocked tool part for permission request (non-fatal)', {
        requestId: req.id,
        sessionId: req.sessionID,
        toolCallId: remoteCallId,
      }, error);
    }

    return null;
  };

  const resolvePermissionAskedToolBridge = async (req: OpenCodePermissionRequest): Promise<{
    localRequestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }> => {
    const localRequestId = normalizeString(req.tool?.callID) || req.id;
    const matchedToolPart = await findToolPartForPermissionRequest(req);
    const partInput = matchedToolPart ? (asRecord((matchedToolPart.state as any).input) ?? {}) : {};
    const fallbackInput = buildOpenCodePermissionFallbackInput(req.metadata);
    const rawInput =
      Object.keys(partInput).length > 0
        ? { ...fallbackInput, ...partInput }
        : fallbackInput;
    const toolName = matchedToolPart
      ? resolveOpenCodeToolNameForAcp(normalizeString(matchedToolPart.tool))
      : req.permission;
    const title = matchedToolPart ? normalizeString((matchedToolPart.state as any).title) : '';

    return {
      localRequestId,
      toolName,
      toolInput: {
        ...rawInput,
        permissionId: localRequestId,
        providerPermissionId: req.id,
        sessionId: req.sessionID,
        toolCallId: localRequestId,
        toolName,
        patterns: req.patterns,
        always: req.always,
        metadata: req.metadata,
        permission: {
          id: req.id,
          kind: req.permission,
          patterns: req.patterns,
          always: req.always,
          metadata: req.metadata,
          toolName,
          ...(title ? { title } : null),
        },
        toolCall: {
          toolCallId: localRequestId,
          rawInput,
          status: 'pending',
          kind: req.permission,
          ...(title ? { title } : null),
        },
      },
    };
  };

  const ensureClient = async (): Promise<OpenCodeServerRuntimeClient> => {
    if (client) return client;
    client = await createClient({
      directory: params.directory,
      env,
      messageBuffer: params.messageBuffer,
    });
    return client;
  };

  const publishDynamicSessionOptionsBestEffort = () => {
    void (async () => {
      if (!sessionId) return;
      const c = await ensureClient();

      const [config, agents, providers] = await Promise.all([
        c.globalConfigGet().catch(() => ({})),
        c.agentsList().catch(() => []),
        c.providersList().catch(() => []),
      ]);

      const defaultModelId = typeof (config as any)?.model === 'string' ? String((config as any).model).trim() : '';
      const includedProviders = (Array.isArray(providers) ? providers : []).filter((p) => {
        const id = normalizeString((p as any)?.id);
        if (!id) return false;
        return asRecord((p as any)?.models) !== null;
      });

      type SessionModelEntry = NonNullable<NonNullable<Metadata['sessionModelsV1']>['availableModels']>[number];
      const variantCandidate = typeof configOverrides.variant === 'string' ? String(configOverrides.variant).trim() : null;
      const availableModels: SessionModelEntry[] = [];
      for (const p of includedProviders) {
        const providerId = normalizeString((p as any)?.id);
        if (!providerId) continue;
        const modelsRec = asRecord((p as any)?.models);
        if (!modelsRec) continue;
        const keys = Object.keys(modelsRec).sort();
        for (const key of keys) {
          const modelRec = modelsRec[key];
          const modelId = normalizeString(asRecord(modelRec)?.id) || key;
          const modelStatus = normalizeString(asRecord(modelRec)?.status);
          if (modelStatus && modelStatus !== 'active') continue;
          const capabilities = asRecord((asRecord(modelRec) as any)?.capabilities);
          const input = capabilities ? asRecord((capabilities as any)?.input) : null;
          if (input && (input as any).text === false) continue;
          const fullId = `${providerId}/${modelId}`;
          const name = normalizeString(asRecord(modelRec)?.name) || modelId;
          const description = normalizeString(asRecord(modelRec)?.family) || '';
          const supportsReasoning = capabilities ? capabilities.reasoning === true : false;
          const contextWindowTokens = readContextWindowTokensFromModelRecord(asRecord(modelRec) ?? {});
          const modelOptions: SessionModelEntry['modelOptions'] | null = supportsReasoning
            ? (buildOpenCodeThinkingModelOptionsFromVariants((asRecord(modelRec) as any)?.variants, variantCandidate) as SessionModelEntry['modelOptions'])
            : null;
          availableModels.push({
            id: fullId,
            name,
            ...(description ? { description } : {}),
            ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
            ...(modelOptions ? { modelOptions } : {}),
          });
        }
      }

      const availableModes = (Array.isArray(agents) ? agents : [])
        .map((a) => ({ id: normalizeString((a as any)?.name), name: normalizeString((a as any)?.name), description: normalizeString((a as any)?.description) }))
        .filter((a) => a.id && a.name)
        .map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) }));

      const currentModeId = selectedAgent
        ?? (availableModes.find((m) => m.id === 'build')?.id ?? availableModes[0]?.id ?? 'build');
      const currentModelId =
        (selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : '')
        || defaultModelId
        || availableModels[0]?.id
        || '';
      currentContextWindowTokens =
        availableModels.find((model) => model.id === currentModelId)?.contextWindowTokens ?? null;
      const snapshot = await params.session.ensureMetadataSnapshot({ timeoutMs: 60_000 }).catch(() => null);
      if (!snapshot) return;

      const updatedAt = Date.now();
      await params.session.updateMetadata((prev) => ({
        ...prev,
        sessionModesV1: {
          v: 1,
          provider,
          updatedAt,
          currentModeId,
          availableModes,
        },
        acpSessionModesV1: {
          v: 1,
          provider,
          updatedAt,
          currentModeId,
          availableModes,
        },
        sessionModelsV1: {
          v: 1,
          provider,
          updatedAt,
          currentModelId,
          availableModels,
        },
        acpSessionModelsV1: {
          v: 1,
          provider,
          updatedAt,
          currentModelId,
          availableModels,
        },
      }));
    })().catch((error) => {
      logger.debug('[OpenCodeServer] Failed publishing session options metadata (non-fatal)', error);
    });
  };

  const attachSubscriptionIfNeeded = async (): Promise<void> => {
    if (subscriptionAbort) return;
    const c = await ensureClient();
    const controller = new AbortController();
    subscriptionAbort = controller;

    void c.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (evt) => {
        const eventSequence = nextProviderEventSequence + 1;
        nextProviderEventSequence = eventSequence;
        const processEvent = (): Promise<void> | void => {
          try {
            return handleEvent(evt);
          } catch (error) {
            logger.debug('[OpenCodeServer] Failed handling event (non-fatal)', error);
          }
        };

        const finalizeEvent = (): void => {
          completedProviderEventSequence = Math.max(completedProviderEventSequence, eventSequence);
          if (idleSignalSeen && turnPromptActive) {
            void maybeResolveTurnOnIdleSignal();
          }
        };

        const trackPendingEventWork = (work: Promise<void>): Promise<void> => {
          const tracked = Promise.resolve(work).finally(() => {
            finalizeEvent();
            if (pendingEventWork === tracked) pendingEventWork = null;
          });
          pendingEventWork = tracked;
          return tracked;
        };

        if (pendingEventWork) {
          return trackPendingEventWork(
            pendingEventWork.then(async () => {
              await processEvent();
            }),
          );
        }

        const maybePendingWork = processEvent();
        if (!isPromiseLike(maybePendingWork)) {
          finalizeEvent();
          return maybePendingWork;
        }
        return trackPendingEventWork(Promise.resolve(maybePendingWork));
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      logger.debug('[OpenCodeServer] Global event subscription failed (non-fatal)', error);
    });
  };

  let currentThinking = false;
  let pendingEventWork: Promise<void> | null = null;
  let nextProviderEventSequence = 0;
  let completedProviderEventSequence = 0;
  let pendingTurnToolForwardingWork = new Set<Promise<void>>();
  const setThinking = (value: boolean) => {
    if (value === currentThinking) return;
    currentThinking = value;
    params.session.keepAlive(value, 'remote');
    params.onThinkingChange(value);
  };

  const resetTurnEventState = () => {
    pendingTurnToolForwardingWork = new Set<Promise<void>>();
    clearStreamWriters();
    turnStreamKey = null;
    turnPromptActive = false;
    turnActivitySeen = false;
    turnUserMessageId = null;
    turnPromptLocalId = null;
    turnPromptTextForBackfill = '';
    turnPromptEffectiveTextForBackfill = '';
    turnPrePromptMessageIdsAll = null;
    turnPreexistingMessageIds = null;
    turnUserMessageIds.clear();
    turnAssistantMessageIds.clear();
    turnStreamedAssistantMessageIds.clear();
    turnBackfilledAssistantMessageIds.clear();
    turnAssistantBackfillAttempts = 0;
    turnAssistantBackfillFirstAttemptAtMs = null;
    turnAssistantBackfillIdleAttempted = false;
    idleSignalSeen = false;
    idleSignalSeenViaControlPlane = false;
    statusPollBusySeen = false;
    resolveOnIdleInFlight = false;
    sidechainIdByRemoteSessionId.clear();
    sidechainStreamSeenBySidechainId.clear();
    pendingTaskSidechainImportsBySidechainId.clear();
    pendingTaskChildSessionDiscoveryCallKeys.clear();
      accumulatedTextByPartKey.clear();
      pendingInlinePartSnapshotsByMessagePartKey.clear();
      partTypeByPartKey.clear();
      toolCallSentByCallId.clear();
      toolResultSentByCallId.clear();
    if (turnControlAbort) {
      try {
        turnControlAbort.abort();
      } catch {
        // ignore
      }
    }
    turnControlAbort = null;
    handledPermissionIds = null;
    handledQuestionIds = null;
    inFlightPermissionIds = null;
    inFlightQuestionIds = null;
  };

  const beginFreshTurnChangeCollection = (): void => {
    turnChangeCollectorEpoch += 1;
    turnChangeCollector.beginTurn();
    turnStartSeqInclusive = params.session.getLastObservedMessageSeq?.() ?? 0;
  };

  const resolveTurn = () => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    resetTurnEventState();
    beginFreshTurnChangeCollection();
    d.resolve();
  };

  const rejectTurn = (error: unknown) => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    // Turns can be rejected from background callbacks; attach a handler to avoid unhandledRejection warnings.
    void d.promise.catch(() => undefined);
    resetTurnEventState();
    beginFreshTurnChangeCollection();
    d.reject(error);
  };

  const collectNativeTurnDiffBestEffort = async (): Promise<void> => {
    if (!sessionId) return;
    if (!turnUserMessageId) return;
    const messageId = turnUserMessageId;
    const c = await ensureClient();
    const diffOutcome = await raceWithTimeout(c.sessionDiff({ sessionId, messageId }), nativeSessionDiffTimeoutMs);
    if (diffOutcome.type === 'timeout') {
      logger.debug('[OpenCodeServer] Native session diff timed out (non-fatal)', {
        sessionId,
        messageId,
        timeoutMs: nativeSessionDiffTimeoutMs,
      });
      return;
    }
    if (diffOutcome.type === 'rejected') {
      logger.debug('[OpenCodeServer] Native session diff failed (non-fatal)', {
        sessionId,
        messageId,
        error: diffOutcome.error,
      });
      return;
    }
    const raw = diffOutcome.value;
    const payload = extractOpenCodeSessionDiffPayload(raw);
    if (payload.unifiedDiffs.length > 0) {
      turnChangeCollector.observeUnifiedDiffSnapshot({
        unifiedDiff: payload.unifiedDiffs.join('\n'),
        source: 'provider_native',
        confidence: 'exact',
      });
      return;
    }
    for (const diff of payload.textDiffs) {
      turnChangeCollector.observeTextDiff({
        filePath: diff.filePath,
        oldText: diff.oldText,
        newText: diff.newText,
        source: 'provider_native',
        confidence: 'exact',
      });
    }
  };

  const emitTurnDiffToolIfPresent = async (): Promise<void> => {
    const endSeqInclusive = params.session.getLastObservedMessageSeq?.() ?? turnStartSeqInclusive;
    const turnChangeSet = turnChangeCollector.flushTurn({
      sessionId: params.session.sessionId,
      turnId: turnUserMessageId ?? `opencode-server-turn-${randomUUID()}`,
      seqRange: {
        startSeqInclusive: turnStartSeqInclusive,
        endSeqInclusive: Math.max(turnStartSeqInclusive, endSeqInclusive),
      },
      status: 'completed',
    });
    if (!turnChangeSet) return;
    emitCanonicalTurnDiffTool({
      turnChangeSet,
      protocol: 'acp',
      rawToolName: 'OpenCodeDiff',
      sendToolCall: ({ toolName, input, callId }) => {
        const resolvedCallId = callId ?? randomUUID();
        params.session.sendAgentMessage(
          provider,
          { type: 'tool-call', callId: resolvedCallId, name: toolName, input, id: randomUUID() },
        );
        return resolvedCallId;
      },
      sendToolResult: ({ callId, output }) => {
        params.session.sendAgentMessage(
          provider,
          { type: 'tool-result', callId, output, id: randomUUID() },
        );
      },
    });
  };

  const pollSleepMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 25 ? Math.trunc(raw) : configuration.pendingQueueIdleWakePollIntervalMs;
    // Clamp to keep control-plane polling responsive without excessive churn.
    return Math.max(25, Math.min(2_000, configured));
  })();

  const turnActivePollSleepMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 25 ? Math.trunc(raw) : Math.min(pollSleepMs, 250);
    return Math.max(25, Math.min(2_000, configured));
  })();

  const turnPreexistingSnapshotLimit = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_TURN_PREEXISTING_SNAPSHOT_LIMIT ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
    return Math.max(10, Math.min(2_000, configured));
  })();

  const abortTimeoutMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_500;
    // Keep abort responsive but allow slow local servers a moment to drain.
    return Math.max(25, Math.min(30_000, configured));
  })();

  const nativeSessionDiffTimeoutMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_SESSION_DIFF_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_500;
    return Math.max(25, Math.min(30_000, configured));
  })();

  const idlePendingToolForwardingTimeoutMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_IDLE_PENDING_TOOL_FORWARDING_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_500;
    return Math.max(25, Math.min(30_000, configured));
  })();

  const prePromptIdleWaitMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_PREPROMPT_IDLE_WAIT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 30_000;
    return Math.max(0, Math.min(300_000, configured));
  })();

  const streamDeltaMaxChars = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_MAX_CHARS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 8_000;
    return Math.max(256, Math.min(200_000, configured));
  })();

  const controlPlaneMaxConsecutiveFailures = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 3;
    return Math.max(1, Math.min(100, configured));
  })();

  const controlPlaneFailureGraceMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000;
    return Math.max(250, Math.min(300_000, configured));
  })();

  const controlPlaneDisconnectMessage = (() => {
    const raw = normalizeEnvVar(env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_MESSAGE);
    return raw || 'OpenCode server connection lost. Please restart OpenCode and try again.';
  })();

  const statusPollEnabled = (() => {
    const raw = normalizeEnvVar(env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED);
    if (!raw) return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
  })();

  const waitForIdleBeforePromptBestEffort = async (opts: {
    client: OpenCodeServerRuntimeClient;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<void> => {
    if (!statusPollEnabled) return;
    if (prePromptIdleWaitMs <= 0) return;
    const startedAtMs = Date.now();
    // If the session is currently busy (e.g. tool still running after an abort),
    // wait a bounded amount of time for it to become idle before sending a new prompt.
    while (!opts.signal.aborted && Date.now() - startedAtMs < prePromptIdleWaitMs) {
      let statuses: unknown;
      try {
        statuses = await opts.client.sessionStatusList();
      } catch (error) {
        logger.debug('[OpenCodeServer] pre-prompt status polling failed (non-fatal)', error);
        return;
      }
      const rec =
        statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? (statuses as any)[opts.sessionId] : null;
      const statusType = normalizeString(asRecord(rec)?.type);
      if (statusType !== 'busy') return;

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          cleanup();
          clearTimeout(timer);
          resolve();
        };
        const cleanup = () => {
          opts.signal.removeEventListener('abort', onAbort);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, pollSleepMs);
        timer.unref?.();
        opts.signal.addEventListener('abort', onAbort, { once: true });
        if (opts.signal.aborted) onAbort();
      });
    }
  };

  const assistantBackfillMaxAttempts = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_MAX_ATTEMPTS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60;
    return Math.max(1, Math.min(100, configured));
  })();

  const assistantBackfillGraceMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_GRACE_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60_000;
    return Math.max(100, Math.min(300_000, configured));
  })();

  type ControlPlaneFailureKind = 'status' | 'permission' | 'question' | 'messages';
  type ControlPlaneFailureState = { count: number; firstFailureAtMs: number | null };

  const controlPlaneFailures: Record<ControlPlaneFailureKind, ControlPlaneFailureState> = {
    status: { count: 0, firstFailureAtMs: null },
    permission: { count: 0, firstFailureAtMs: null },
    question: { count: 0, firstFailureAtMs: null },
    messages: { count: 0, firstFailureAtMs: null },
  };

  const resetControlPlaneFailures = (kind: ControlPlaneFailureKind) => {
    controlPlaneFailures[kind].count = 0;
    controlPlaneFailures[kind].firstFailureAtMs = null;
  };

  const maybeAbortTurnOnControlPlaneFailure = (kind: ControlPlaneFailureKind, error: unknown) => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;

    const state = controlPlaneFailures[kind];
    const nowMs = Date.now();
    if (state.firstFailureAtMs == null) {
      state.firstFailureAtMs = nowMs;
      state.count = 0;
    }
    state.count += 1;

    const exceededConsecutive = state.count >= controlPlaneMaxConsecutiveFailures;
    const exceededGrace = Number.isFinite(nowMs) && state.firstFailureAtMs != null
      ? nowMs - state.firstFailureAtMs >= controlPlaneFailureGraceMs
      : false;

    if (!exceededConsecutive && !exceededGrace) return;

    setThinking(false);
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'control_plane_failure' }).finally(() => {
      params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
    });
    const detail = extractOpenCodeErrorText(error);
    const message = detail ? `${controlPlaneDisconnectMessage}\n\nDetails: ${detail}` : controlPlaneDisconnectMessage;
    params.session.sendAgentMessage(provider, { type: 'message', message });
    rejectTurn(error ?? new Error('OpenCode control-plane polling failed'));
  };

  const shouldTreatMessageIdAsTurnActivity = (messageID: string): boolean => {
    if (!turnPromptActive) return false;
    if (!messageID) return false;
    if (turnAssistantMessageIds.has(messageID)) return true;
    if (turnUserMessageIds.has(messageID)) return false;
    if (turnUserMessageId && messageID === turnUserMessageId) return false;
    if (turnPreexistingMessageIds && turnPreexistingMessageIds.has(messageID)) return false;
    if (turnBackfilledAssistantMessageIds.has(messageID)) return false;
    return true;
  };

  const shouldTreatInlineSnapshotMessageIdAsTurnActivity = (messageID: string): boolean => {
    return shouldTreatMessageIdAsTurnActivity(messageID);
  };

  const noteUserMessageIdForActiveTurn = (messageID: string): void => {
    if (!turnPromptActive) return;
    if (!messageID) return;
    turnUserMessageIds.add(messageID);
    observedRemoteTextMessageIds.add(messageID);
  };

  const inlineTextMatchesCurrentPromptForActiveTurn = (text: string): boolean => {
    if (!turnPromptActive) return false;
    if (turnUserMessageId) return false;
    const normalized = text.trim();
    if (!normalized) return false;
    const rawPrompt = turnPromptTextForBackfill.trim();
    const effectivePrompt = turnPromptEffectiveTextForBackfill.trim();
    return normalized === rawPrompt || (effectivePrompt.length > 0 && normalized === effectivePrompt);
  };

  const noteAssistantMessageIdForActiveTurn = (messageID: string): void => {
    if (!turnPromptActive) return;
    if (!messageID) return;
    if (turnBackfilledAssistantMessageIds.has(messageID)) return;
    if (turnStreamedAssistantMessageIds.has(messageID)) return;
    if (turnPreexistingMessageIds?.has(messageID) && messageID !== turnUserMessageId) return;
    turnAssistantMessageIds.add(messageID);
  };

  const abortTurnFailClosedDueToPermissionProtocolError = (error: unknown) => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;

    setThinking(false);
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'permission_protocol_error' }).finally(() => {
      params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
    });
    const detail = extractOpenCodeErrorText(error);
    const message = detail
      ? `OpenCode permission request could not be validated. For safety, the turn was aborted.\n\nDetails: ${detail}`
      : 'OpenCode permission request could not be validated. For safety, the turn was aborted.';
    params.session.sendAgentMessage(provider, { type: 'message', message });
    rejectTurn(error ?? new Error('OpenCode permission request could not be validated'));
  };

  const listPendingPermissionRequests = async (): Promise<OpenCodePermissionRequest[]> => {
    const c = await ensureClient();
    let raw: unknown;
    try {
      raw = await c.permissionList();
    } catch (error) {
      const failure = new OpenCodeControlPlaneRequestListError('permission', error);
      maybeAbortTurnOnControlPlaneFailure('permission', failure);
      throw failure;
    }
    if (!Array.isArray(raw)) {
      const failure = new OpenCodeControlPlaneRequestListError('permission', new Error('OpenCode permission list returned invalid data'));
      maybeAbortTurnOnControlPlaneFailure('permission', failure);
      throw failure;
    }
    const parsed: OpenCodePermissionRequest[] = [];
    for (const item of raw) {
      const rec = asRecord(item);
      const itemSessionId = normalizeString(rec?.sessionID);
      if (!itemSessionId) {
        const failure = new OpenCodeControlPlaneRequestListError('permission', new Error('OpenCode permission list contained a malformed request (missing sessionID)'));
        abortTurnFailClosedDueToPermissionProtocolError(failure);
        return [];
      }
      if (itemSessionId !== sessionId && !sidechainIdByRemoteSessionId.has(itemSessionId)) continue;
      const req = parsePermissionRequest(item);
      if (!req) {
        const failure = new OpenCodeControlPlaneRequestListError('permission', new Error('OpenCode permission list contained a malformed request'));
        abortTurnFailClosedDueToPermissionProtocolError(failure);
        return [];
      }
      parsed.push(req);
    }
    resetControlPlaneFailures('permission');
    return parsed;
  };

  const listPendingQuestionRequests = async (): Promise<OpenCodeQuestionRequest[]> => {
    const c = await ensureClient();
    let raw: unknown;
    try {
      raw = await c.questionList();
    } catch (error) {
      const failure = new OpenCodeControlPlaneRequestListError('question', error);
      maybeAbortTurnOnControlPlaneFailure('question', failure);
      throw failure;
    }
    if (!Array.isArray(raw)) {
      const failure = new OpenCodeControlPlaneRequestListError('question', new Error('OpenCode question list returned invalid data'));
      maybeAbortTurnOnControlPlaneFailure('question', failure);
      throw failure;
    }
    resetControlPlaneFailures('question');
    return raw
      .map((item) => parseQuestionRequest(item))
      .filter((item): item is OpenCodeQuestionRequest => Boolean(item))
      .filter((item) => item.sessionID === sessionId || sidechainIdByRemoteSessionId.has(item.sessionID));
  };

  const pollIdleStatusFromControlPlaneBestEffort = async (): Promise<void> => {
    if (!statusPollEnabled) return;
    if (!sessionId) return;
    if (!turnPromptActive) return;
    if (idleSignalSeen) return;
    const c = await ensureClient();
    let statuses: unknown;
    try {
      statuses = await c.sessionStatusList();
      resetControlPlaneFailures('status');
    } catch (error) {
      maybeAbortTurnOnControlPlaneFailure('status', error);
      return;
    }
    const map = statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? (statuses as any as Record<string, unknown>) : null;
    const rec = map ? map[sessionId] : null;
    const statusType = normalizeString(asRecord(rec)?.type);

    // OpenCode (>= 1.2.17) only returns *busy* sessions from /session/status. When the session becomes idle
    // it is omitted from the response map, so interpret "missing entry" as idle once we have evidence
    // that the turn had activity (or we observed it as busy at least once).
    const missingImpliesIdle = rec == null && (statusPollBusySeen || turnActivitySeen);
    if (statusType === 'busy') {
      statusPollBusySeen = true;
      return;
    }
    if (statusType !== 'idle' && !missingImpliesIdle) return;
    setThinking(false);
    idleSignalSeen = true;
    idleSignalSeenViaControlPlane = true;
  };

  const maybeResolveTurnOnIdleSignal = async () => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!idleSignalSeen) return;
    if (!turnActivitySeen && !(idleSignalSeenViaControlPlane && statusPollBusySeen)) return;
    if (completedProviderEventSequence < nextProviderEventSequence) return;
    if (resolveOnIdleInFlight) return;
    resolveOnIdleInFlight = true;
    try {
      // When idle is observed via SSE, the status poll loop may not run again before we resolve.
      // Backfill assistant text one final time on idle to avoid ending the turn without the final response.
      if (!turnAssistantBackfillIdleAttempted) {
        await backfillAssistantTextFromControlPlaneBestEffort();
      }
      let permissions: OpenCodePermissionRequest[];
      let questions: OpenCodeQuestionRequest[];
      try {
        permissions = await listPendingPermissionRequests();
        questions = await listPendingQuestionRequests();
      } catch (error) {
        return;
      }
      const handledPerms = handledPermissionIds ?? new Set<string>();
      const handledQs = handledQuestionIds ?? new Set<string>();
      const inFlightPerms = inFlightPermissionIds ?? new Set<string>();
      const inFlightQs = inFlightQuestionIds ?? new Set<string>();
      const hasUnhandled =
        permissions.some((p) => !handledPerms.has(p.id) || inFlightPerms.has(p.id)) ||
        questions.some((q) => !handledQs.has(q.id) || inFlightQs.has(q.id));
      if (hasUnhandled) return;
      if (!turnDeferred) return;

      if (pendingTurnToolForwardingWork.size > 0) {
        const forwardingOutcome = await raceWithTimeout(
          Promise.allSettled(Array.from(pendingTurnToolForwardingWork)).then(() => undefined),
          idlePendingToolForwardingTimeoutMs,
        );
        if (forwardingOutcome.type === 'timeout') {
          logger.debug('[OpenCodeServer] Pending tool forwarding timed out before idle turn completion (non-fatal)', {
            timeoutMs: idlePendingToolForwardingTimeoutMs,
            pendingCount: pendingTurnToolForwardingWork.size,
            sessionId,
            turnUserMessageId,
          });
        }
      }

      if (!turnDeferred) return;
      if (completedProviderEventSequence < nextProviderEventSequence) return;
      if (pendingTaskChildSessionDiscoveryCallKeys.size > 0) return;

      // Ensure Task sidechain imports are committed before the turn completes, otherwise
      // downstream scenarios can miss the imported sidechain transcript (e.g. provider tests
      // that assert Task subagent output is present synchronously after task_complete).
      const pendingSidechainImports = Array.from(pendingTaskSidechainImportsBySidechainId.values());
      if (pendingSidechainImports.length > 0) {
        await Promise.allSettled(pendingSidechainImports);
      }

      const flushOutcome = await raceWithTimeout(
        flushAndClearStreamWriters({ reason: 'tool-call-boundary' }),
        idlePendingToolForwardingTimeoutMs,
      );
      if (flushOutcome.type === 'timeout') {
        logger.debug('[OpenCodeServer] Stream flush timed out before idle turn completion (non-fatal)', {
          timeoutMs: idlePendingToolForwardingTimeoutMs,
          sessionId,
          turnUserMessageId,
        });
      } else if (flushOutcome.type === 'rejected') {
        logger.debug('[OpenCodeServer] Stream flush failed before idle turn completion (non-fatal)', {
          sessionId,
          turnUserMessageId,
          error: flushOutcome.error,
        });
      }
      if (!turnUserMessageId && turnPromptLocalId) {
        turnUserMessageId = await backfillVendorAssignedUserMessageIdBestEffort({
          localIdRaw: turnPromptLocalId,
          promptText: turnPromptTextForBackfill,
          promptTextAlternates: [turnPromptEffectiveTextForBackfill],
          prePromptMessageIds: turnPrePromptMessageIdsAll,
        });
      }
      await collectNativeTurnDiffBestEffort();
      await emitTurnDiffToolIfPresent();
      params.session.sendAgentMessage(provider, { type: 'task_complete', id: randomUUID() });
      resolveTurn();
    } finally {
      resolveOnIdleInFlight = false;
    }
  };

  const ensureTurnStreamKey = (): string => {
    if (!turnStreamKey) {
      turnStreamKey = `opencode:turn:${randomUUID()}`;
    }
    return turnStreamKey;
  };

  const sidechainIdByRemoteSessionId = new Map<string, string>();
  const sidechainStreamSeenBySidechainId = new Set<string>();
  const pendingTaskSidechainImportsBySidechainId = new Map<string, Promise<void>>();
  const pendingTaskChildSessionDiscoveryCallKeys = new Set<string>();

  const resolveSidechainIdForRemoteSession = (remoteSessionId: string): string | null => {
    if (!remoteSessionId) return null;
    if (remoteSessionId === sessionId) return null;
    return sidechainIdByRemoteSessionId.get(remoteSessionId) ?? null;
  };

  const markObservedTextHistoryItems = (items: ReadonlyArray<{ messageId: string }>): void => {
    for (const item of items) {
      const messageId = typeof item.messageId === 'string' ? item.messageId.trim() : '';
      if (!messageId) continue;
      observedRemoteTextMessageIds.add(messageId);
    }
  };

  const resolveOrCreateUserMessageId = async (localIdRaw: string | null | undefined): Promise<string | null> => {
    const localId = typeof localIdRaw === 'string' ? localIdRaw.trim() : '';
    if (!localId) return null;
    const snapshot = params.session.getMetadataSnapshot();
    const existing = resolveOpenCodeUserMessageIdFromMetadata(snapshot, localId);
    if (existing) return existing;

    const nowMs = Date.now();
    if (nowMs !== userMessageIdLastTimestampMs) {
      userMessageIdLastTimestampMs = nowMs;
      userMessageIdCounter = 0;
    }
    userMessageIdCounter += 1;
    if (userMessageIdCounter > 0xfff) {
      userMessageIdLastTimestampMs = nowMs + 1;
      userMessageIdCounter = 1;
    }

    const created = createOpenCodeAscendingMessageId({
      nowMs: userMessageIdLastTimestampMs,
      counter: userMessageIdCounter,
      entropySeed: localId,
    });

    try {
      await params.session.updateMetadata((prev) => {
        const base = prev && typeof prev === 'object' ? (prev as any as Record<string, unknown>) : {};
        return upsertOpenCodeUserMessageIdInMetadata({ metadata: base, localId, messageId: created }) as any;
      });
    } catch {
      // Best-effort: do not block prompt sending on metadata persistence.
    }

    return resolveOpenCodeUserMessageIdFromMetadata(params.session.getMetadataSnapshot(), localId) ?? created;
  };

  const backfillVendorAssignedUserMessageIdBestEffort = async (paramsForBackfill: {
    localIdRaw: string | null | undefined;
    promptText: string;
    promptTextAlternates?: readonly string[];
    prePromptMessageIds: ReadonlySet<string> | null;
  }): Promise<string | null> => {
    const localId = typeof paramsForBackfill.localIdRaw === 'string' ? paramsForBackfill.localIdRaw.trim() : '';
    if (!localId) return null;
    if (!sessionId) return null;
    const existing = resolveOpenCodeUserMessageIdFromMetadata(params.session.getMetadataSnapshot(), localId);
    if (existing) return existing;

    let raw: unknown;
    try {
      const c = await ensureClient();
      raw = await c.sessionMessagesList({ sessionId });
    } catch {
      return null;
    }

    const items = extractOpenCodeTextHistoryItems(Array.isArray(raw) ? raw : []);
    if (items.length === 0) return null;

    const unseenUserItems = items.filter((item) => {
      if (item.role !== 'user') return false;
      return !paramsForBackfill.prePromptMessageIds || !paramsForBackfill.prePromptMessageIds.has(item.messageId);
    });
    if (unseenUserItems.length === 0) return null;

    const normalizedPromptTexts = new Set(
      [paramsForBackfill.promptText, ...(paramsForBackfill.promptTextAlternates ?? [])]
        .map((text) => text.trim())
        .filter((text) => text.length > 0),
    );
    let candidateMessageId: string | null = null;
    for (let index = unseenUserItems.length - 1; index >= 0; index -= 1) {
      const item = unseenUserItems[index]!;
      if (normalizedPromptTexts.has(item.text.trim())) {
        candidateMessageId = item.messageId;
        break;
      }
    }
    if (!candidateMessageId) {
      candidateMessageId = unseenUserItems[unseenUserItems.length - 1]!.messageId;
    }
    if (!candidateMessageId) return null;

    try {
      await params.session.updateMetadata((prev) => {
        const base = prev && typeof prev === 'object' ? (prev as any as Record<string, unknown>) : {};
        return upsertOpenCodeUserMessageIdInMetadata({ metadata: base, localId, messageId: candidateMessageId! }) as any;
      });
    } catch {
      // Best-effort: do not block prompt completion on metadata persistence.
    }

    observedRemoteTextMessageIds.add(candidateMessageId);
    return candidateMessageId;
  };

  const getStreamKeyForMessage = (remoteSessionId: string, messageID: string): string => {
    const normalized = typeof messageID === 'string' ? messageID.trim() : '';
    if (!normalized) return ensureTurnStreamKey();
    const sessionPart = remoteSessionId ? `:ses:${remoteSessionId}` : '';
    return `${ensureTurnStreamKey()}${sessionPart}:msg:${normalized}`;
  };

  const splitBackfilledTextIntoChunks = (text: string): string[] => {
    if (!text) return [];
    if (text.length === 1) return [text];

    const maxChunkChars = Math.max(256, Math.min(32_000, Math.floor(streamDeltaMaxChars / 2)));
    if (text.length > maxChunkChars) {
      const chunks: string[] = [];
      for (let idx = 0; idx < text.length; idx += maxChunkChars) {
        chunks.push(text.slice(idx, idx + maxChunkChars));
      }
      if (chunks.length >= 2) return chunks;
      if (chunks.length === 1 && chunks[0]!.length > 1) {
        const mid = Math.floor(chunks[0]!.length / 2);
        return [chunks[0]!.slice(0, mid), chunks[0]!.slice(mid)];
      }
      return chunks;
    }

    const mid = Math.floor(text.length / 2);
    const windowSize = 256;
    const windowStart = Math.max(0, mid - windowSize);
    const windowEnd = Math.min(text.length - 1, mid + windowSize);
    const window = text.slice(windowStart, windowEnd);
    const newlineIndex = window.lastIndexOf('\n');
    const splitIndex = newlineIndex >= 0 ? windowStart + newlineIndex + 1 : mid;
    const first = text.slice(0, splitIndex);
    const second = text.slice(splitIndex);
    if (!second) return [text.slice(0, mid), text.slice(mid)];
    return [first, second];
  };

  const backfillAssistantTextFromControlPlaneBestEffort = async (): Promise<void> => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!sessionId) return;
    if (turnStreamedAssistantMessageIds.size > 0 && !idleSignalSeen) return;

    const nowMs = Date.now();
    if (turnAssistantBackfillFirstAttemptAtMs == null) {
      turnAssistantBackfillFirstAttemptAtMs = nowMs;
    }
    const isIdleFinalAttempt = idleSignalSeen && !turnAssistantBackfillIdleAttempted;
    if (isIdleFinalAttempt) {
      turnAssistantBackfillIdleAttempted = true;
    } else {
      if (turnAssistantBackfillAttempts >= assistantBackfillMaxAttempts) return;
      if (nowMs - turnAssistantBackfillFirstAttemptAtMs > assistantBackfillGraceMs) return;
      turnAssistantBackfillAttempts += 1;
    }

    const c = await ensureClient();
    let raw: unknown;
    try {
      raw = await c.sessionMessagesList({ sessionId });
    } catch (error) {
      maybeAbortTurnOnControlPlaneFailure('messages', error);
      return;
    }

    const items = extractOpenCodeTextHistoryItems(Array.isArray(raw) ? raw : []);
    if (items.length === 0) return;

    const prePrompt = turnPrePromptMessageIdsAll;
    const unseenAssistants = items.filter((item) => {
      if (item.role !== 'assistant') return false;
      if (turnBackfilledAssistantMessageIds.has(item.messageId)) return false;
      if (turnStreamedAssistantMessageIds.has(item.messageId)) return false;
      if (prePrompt && prePrompt.has(item.messageId)) return false;
      if (turnPreexistingMessageIds && turnPreexistingMessageIds.has(item.messageId)) return false;
      return true;
    });
    if (unseenAssistants.length === 0) return;

    for (const item of unseenAssistants) {
      const messageID = item.messageId;
      if (!messageID) continue;
      const text = item.text ?? '';
      if (!text) continue;
      const chunks = splitBackfilledTextIntoChunks(text);
      if (chunks.length === 0) continue;

      turnBackfilledAssistantMessageIds.add(messageID);
      turnStreamedAssistantMessageIds.add(messageID);
      observedRemoteTextMessageIds.add(messageID);
      for (const chunk of chunks) {
        if (!chunk) continue;
        transcriptStreamBridge.appendAssistantDelta({
          deltaText: chunk,
          streamKey: getStreamKeyForMessage(sessionId, messageID),
          remoteSessionId: sessionId,
          messageId: messageID,
          sidechainId: null,
        });
      }
      turnActivitySeen = true;
    }
  };

  const importLiveCommittedTextHistoryBestEffort = async (opts?: { allowAssistantReplies?: boolean }): Promise<void> => {
    if (opts?.allowAssistantReplies === true) {
      queuedLiveHistorySyncAllowAssistantReplies = true;
    }
    if (liveHistorySyncPromise) {
      await liveHistorySyncPromise;
      return;
    }

    const runSync = (async () => {
      while (true) {
        const allowAssistantReplies = queuedLiveHistorySyncAllowAssistantReplies;
        queuedLiveHistorySyncAllowAssistantReplies = false;

        if (turnPromptActive) return;
        if (!sessionId) return;
        const c = await ensureClient();
        let raw: unknown;
        try {
          raw = await c.sessionMessagesList({ sessionId });
        } catch {
          return;
        }

        const items = extractOpenCodeTextHistoryItems(Array.isArray(raw) ? raw : []);
        if (items.length > 0) {
          const unseen = items.filter((item) => {
            if (observedRemoteTextMessageIds.has(item.messageId)) return false;
            if (item.role === 'assistant' && !allowAssistantReplies) return false;
            return true;
          });
          if (unseen.length > 0) {
            await importOpenCodeTextHistoryCommitted({
              session: params.session,
              provider,
              remoteSessionId: sessionId,
              items: unseen,
              importedFrom: 'acp-live-sync',
            });
            markObservedTextHistoryItems(unseen);
          }
        }

        if (!queuedLiveHistorySyncAllowAssistantReplies) return;
      }
    })();

    const currentPromise = runSync.finally(() => {
      if (liveHistorySyncPromise === currentPromise) {
        liveHistorySyncPromise = null;
      }
    });
    liveHistorySyncPromise = currentPromise;
    await currentPromise;
  };

  const buildSidechainMeta = (
    meta: Record<string, unknown>,
    remoteSessionId: string,
    sidechainId: string | null,
  ): Record<string, unknown> => {
    if (!sidechainId) return meta;
    const streamKey = typeof (meta as any).happierStreamKey === 'string' ? String((meta as any).happierStreamKey) : '';
    return {
      ...meta,
      importedFrom: 'acp-sidechain',
      remoteSessionId,
      sidechainId,
      ...(streamKey ? { happierSidechainStreamKey: streamKey } : null),
    };
  };

  const transcriptStreamBridge = createOpenCodeTranscriptStreamBridge({
    provider,
    session: params.session,
  });

  const clearStreamWriters = () => {
    transcriptStreamBridge.clear();
  };

  const flushAndClearStreamWriters = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => {
    await transcriptStreamBridge.flushAll(opts);
  };

  const sendDelta = (delta: string, remoteSessionId: string, messageID: string, sidechainId: string | null) => {
    turnActivitySeen = true;
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);
    if (!sidechainId && sessionId && remoteSessionId === sessionId) {
      turnStreamedAssistantMessageIds.add(messageID);
      observedRemoteTextMessageIds.add(messageID);
    }
    transcriptStreamBridge.appendAssistantDelta({
      deltaText: delta,
      streamKey: getStreamKeyForMessage(remoteSessionId, messageID),
      remoteSessionId,
      messageId: messageID,
      sidechainId,
    });
  };

  const sendThinkingDelta = (delta: string, remoteSessionId: string, messageID: string, sidechainId: string | null) => {
    if (!delta) return;
    turnActivitySeen = true;
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);
    transcriptStreamBridge.appendThinkingDelta({
      deltaText: delta,
      streamKey: getStreamKeyForMessage(remoteSessionId, messageID),
      remoteSessionId,
      messageId: messageID,
      sidechainId,
    });
  };

  const applyInlinePartTextSnapshot = (paramsForSnapshot: {
    text: string;
    partType: string;
    remoteSessionId: string;
    messageID: string;
    sidechainId: string | null;
  }) => {
    const { text, partType, remoteSessionId, messageID, sidechainId } = paramsForSnapshot;
    if (!text) return;

    const normalizedPartType = partType === 'reasoning' ? 'reasoning' : 'text';
    const accumulationKey = `${remoteSessionId}:${messageID}:${normalizedPartType}`;
    const accumulated = accumulatedTextByPartKey.get(accumulationKey) ?? '';
    if (accumulated === text) return;
    accumulatedTextByPartKey.set(accumulationKey, text);

    if (normalizedPartType === 'reasoning') {
      if (!accumulated) {
        sendThinkingDelta(text, remoteSessionId, messageID, sidechainId);
        return;
      }
      if (text.startsWith(accumulated)) {
        const deltaOut = text.slice(accumulated.length);
        if (!deltaOut) return;
        sendThinkingDelta(deltaOut, remoteSessionId, messageID, sidechainId);
        return;
      }
      transcriptStreamBridge.overrideThinkingText({
        text,
        streamKey: getStreamKeyForMessage(remoteSessionId, messageID),
        remoteSessionId,
        messageId: messageID,
        sidechainId,
      });
      turnActivitySeen = true;
      if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);
      return;
    }

    if (!accumulated) {
      sendDelta(text, remoteSessionId, messageID, sidechainId);
      return;
    }
    if (text.startsWith(accumulated)) {
      const deltaOut = text.slice(accumulated.length);
      if (!deltaOut) return;
      sendDelta(deltaOut, remoteSessionId, messageID, sidechainId);
      return;
    }
    turnActivitySeen = true;
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);
    if (!sidechainId && sessionId && remoteSessionId === sessionId) {
      turnStreamedAssistantMessageIds.add(messageID);
      observedRemoteTextMessageIds.add(messageID);
    }
    transcriptStreamBridge.overrideAssistantText({
      text,
      streamKey: getStreamKeyForMessage(remoteSessionId, messageID),
      remoteSessionId,
      messageId: messageID,
      sidechainId,
    });
  };

  const queuePendingInlinePartSnapshot = (paramsForSnapshot: {
    text: string;
    partType: string;
    remoteSessionId: string;
    messageID: string;
    sidechainId: string | null;
  }) => {
    const normalizedPartType = paramsForSnapshot.partType === 'reasoning' ? 'reasoning' : 'text';
    pendingInlinePartSnapshotsByMessagePartKey.set(
      `${paramsForSnapshot.remoteSessionId}:${paramsForSnapshot.messageID}:${normalizedPartType}`,
      {
        ...paramsForSnapshot,
        partType: normalizedPartType,
      },
    );
  };

  const flushPendingInlineSnapshotsForMessage = (paramsForMessage: {
    remoteSessionId: string;
    messageID: string;
  }): boolean => {
    const keys = [
      `${paramsForMessage.remoteSessionId}:${paramsForMessage.messageID}:reasoning`,
      `${paramsForMessage.remoteSessionId}:${paramsForMessage.messageID}:text`,
    ];
    let applied = false;
    for (const key of keys) {
      const snapshot = pendingInlinePartSnapshotsByMessagePartKey.get(key);
      if (!snapshot) continue;
      pendingInlinePartSnapshotsByMessagePartKey.delete(key);
      applyInlinePartTextSnapshot(snapshot);
      applied = true;
    }
    return applied;
  };

  const sendToolFromPart = async (
    part: ReturnType<typeof parseOpenCodeToolPart>,
    sidechainId: string | null,
    observedTurnChangeCollectorEpoch: number,
  ) => {
    if (!part) return;
    turnActivitySeen = true;
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);

      const status = normalizeString(part.state.status);
      const callId = part.callID;
      const callKey = buildOpenCodeToolCallKey(part.sessionID, callId);
      const messageID = part.messageID;
      const toolRaw = normalizeString(part.tool).trim();
      const toolLower = toolRaw.toLowerCase();
      observedToolPartByCallKey.set(callKey, part);
      const isChangeTitleTool =
        toolLower === preferredOpenCodeChangeTitleToolName.toLowerCase() || isChangeTitleToolNameAlias(toolLower);
      if (isChangeTitleTool) return;

      // Task sidechains must be registered without awaiting, because SSE consumers do not await
      // event handlers and related child-session events (questions/deltas) can arrive immediately.
      if (toolLower === 'task') {
        const metadata = asRecord(part.state.metadata) ?? {};
        const outputText = normalizeString(part.state.output);
        const remoteSessionId = extractOpenCodeTaskChildSessionId({ output: outputText, metadata });
        if (remoteSessionId && remoteSessionId !== sessionId) {
          sidechainIdByRemoteSessionId.set(remoteSessionId, callId);
          pendingTaskChildSessionDiscoveryCallKeys.delete(callKey);
        } else if (status === 'completed' || status === 'error') {
          pendingTaskChildSessionDiscoveryCallKeys.delete(callKey);
        } else {
          pendingTaskChildSessionDiscoveryCallKeys.add(callKey);
        }
      }

      const toolNameForAcp = resolveOpenCodeToolNameForAcp(toolRaw);
      const meta = buildSidechainMeta(
        { opencodeMessageId: messageID, opencodeRemoteSessionId: part.sessionID },
        part.sessionID,
        sidechainId,
      );
      const rawInput = (part.state as any).input ?? {};
      const hasMeaningfulInput = hasAnyMeaningfulInputFields(rawInput);
      const isBashLike = part.tool === 'bash' || part.tool === 'Bash' || part.tool === 'execute' || part.tool === 'Terminal';
      const commandHint = isBashLike ? extractBashCommandHint(rawInput) : '';
      const shouldEmitToolCallNow =
        !toolCallSentByCallId.has(callKey) &&
        (hasMeaningfulInput || Boolean(commandHint) || status === 'completed' || status === 'error');

      if (shouldEmitToolCallNow) {
        try {
          await flushAndClearStreamWriters({ reason: 'tool-call-boundary' });
        } catch (error) {
          logger.debug('[OpenCodeServer] tool-call boundary transcript flush failed (non-fatal)', {
            error,
            sessionId: part.sessionID,
            messageId: messageID,
            callId,
          });
        }
        toolCallSentByCallId.add(callKey);
        params.session.sendAgentMessage(
          provider,
          { type: 'tool-call', callId, name: toolNameForAcp, input: rawInput, id: randomUUID(), ...(sidechainId ? { sidechainId } : null) },
          { meta },
        );
      }

    if ((status === 'completed' || status === 'error') && !toolResultSentByCallId.has(callKey)) {
      toolResultSentByCallId.add(callKey);
      if (status === 'completed') {
        const output = {
          output: normalizeString(part.state.output),
          title: normalizeString(part.state.title),
          metadata: asRecord(part.state.metadata) ?? {},
          attachments: Array.isArray((part.state as any).attachments) ? (part.state as any).attachments : undefined,
        };
        const fileDiff = extractOpenCodeFileDiff(output);
        if (fileDiff && observedTurnChangeCollectorEpoch === turnChangeCollectorEpoch) {
          turnChangeCollector.observeTextDiff({
            filePath: fileDiff.filePath,
            oldText: fileDiff.oldText,
            newText: fileDiff.newText,
            source: 'provider_tool',
            confidence: 'exact',
          });
        } else if (fileDiff) {
          logger.debug('[OpenCodeServer] Dropping stale tool diff after turn boundary (non-fatal)', {
            sessionId: part.sessionID,
            callId,
          });
        }
        params.session.sendAgentMessage(
          provider,
          { type: 'tool-result', callId, output, id: randomUUID(), ...(sidechainId ? { sidechainId } : null) },
          { meta },
        );

        if (toolLower === 'task') {
          const remoteSessionId = extractOpenCodeTaskChildSessionId({ output: output.output, metadata: output.metadata });
          if (remoteSessionId) {
            if (!pendingTaskSidechainImportsBySidechainId.has(callId)) {
              const importPromise = (async () => {
                if (sidechainStreamSeenBySidechainId.has(callId)) return;
                const c = await ensureClient();
                const imported = await importOpenCodeTaskSidechainBestEffort({
                  client: c,
                  session: params.session,
                  provider,
                  remoteSessionId,
                  sidechainId: callId,
                });
                if (imported) return;
                const fallback = output.output.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, '').trim();
                if (!fallback) return;
                await params.session.sendAgentMessageCommitted(
                  provider,
                  { type: 'message', message: fallback, sidechainId: callId },
                  { localId: randomUUID(), meta: { importedFrom: 'acp-sidechain', remoteSessionId, sidechainId: callId } },
                );
              })().catch((error) => {
                logger.debug('[OpenCodeServer] Failed to import Task sidechain (non-fatal)', error);
              });

              pendingTaskSidechainImportsBySidechainId.set(callId, importPromise);
              void importPromise.finally(() => {
                if (pendingTaskSidechainImportsBySidechainId.get(callId) === importPromise) {
                  pendingTaskSidechainImportsBySidechainId.delete(callId);
                }
              });
            }
          }
        }
      } else {
        const metadata = asRecord(part.state.metadata);
        const output = {
          status: 'failed',
          error: normalizeString(part.state.error),
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : null),
        };
        params.session.sendAgentMessage(
          provider,
          { type: 'tool-result', callId, output, id: randomUUID(), isError: true, ...(sidechainId ? { sidechainId } : null) },
          { meta },
        );
      }
    }
  };

  const trackPendingTurnToolForwardingWork = (work: Promise<void>): Promise<void> => {
    const pendingWorkForObservedTurn = pendingTurnToolForwardingWork;
    pendingWorkForObservedTurn.add(work);
    return work.finally(() => {
      pendingWorkForObservedTurn.delete(work);
    });
  };

  const handleQuestionAsked = async (req: OpenCodeQuestionRequest) => {
    if (req.sessionID !== sessionId && !sidechainIdByRemoteSessionId.has(req.sessionID)) return;

    setThinking(false);
    idleSignalSeen = false;
    idleSignalSeenViaControlPlane = false;
    if (turnPromptActive) turnActivitySeen = true;

    const questions = req.questions
      .map((q) => (asRecord(q) ?? null))
      .filter(Boolean) as Array<Record<string, unknown>>;

    if (questions.length > 0 && questions.every(openCodeQuestionRecordLooksLikeInternalTitleUpdate)) {
      const c = await ensureClient();
      await c.questionReply({ requestId: req.id, answers: questions.map(() => ['OK']) });
      return;
    }

    params.session.sendAgentMessage(provider, { type: 'task_started', id: randomUUID() });

    const askUserQuestionInput = {
      questions: questions.map((q) => ({
        question: normalizeString(q.question),
        header: normalizeString(q.header),
        ...(() => {
          const rawOptions = Array.isArray(q.options) ? q.options : [];
          const options = rawOptions
            .map((opt) => (asRecord(opt) ?? null))
            .filter((opt): opt is Record<string, unknown> => Boolean(opt))
            .map((opt) => ({
              label: normalizeString(opt.label),
              description: normalizeString(opt.description),
            }))
            .filter((opt) => opt.label.trim().length > 0);

          // OpenCode represents some freeform prompts as a single “type now” option with a `locations` field,
          // but Happier’s AskUserQuestion should treat these as typed answers (not a real selection).
          const hasLocations = Array.isArray((q as any).locations);
          const hintOption = options.find((opt) => looksLikeFreeformQuestionHintLabel(opt.label)) ?? null;
          const isSingleOptionHint = options.length === 1 && hintOption !== null;

          // If the question offers multiple suggestions plus a freeform “type your own answer” option, model it as:
          // - structured options (excluding the hint option)
          // - plus a freeform text input (placeholder/description taken from the hint option)
          if (q.multiple !== true && hintOption !== null && options.length > 1) {
            const placeholder = hintOption.label.trim();
            const description = hintOption.description.trim();
            return {
              options: options.filter((opt) => opt !== hintOption),
              ...(placeholder || description
                ? { freeform: { ...(placeholder ? { placeholder } : null), ...(description ? { description } : null) } }
                : null),
            };
          }

          const isFreeform = hasLocations || options.length === 0 || (q.multiple !== true && isSingleOptionHint);
          if (!isFreeform) return { options };

          const placeholder = hintOption?.label?.trim() ?? '';
          const description = hintOption?.description?.trim() ?? '';
          return {
            options: [],
            ...(placeholder || description
              ? { freeform: { ...(placeholder ? { placeholder } : null), ...(description ? { description } : null) } }
              : null),
          };
        })(),
        multiSelect: q.multiple === true,
      })),
    };

    const decision = await params.permissionHandler.handleToolCall(req.id, 'AskUserQuestion', askUserQuestionInput);
    const c = await ensureClient();

    if (decision.decision === 'approved' || decision.decision === 'approved_for_session' || decision.decision === 'approved_execpolicy_amendment') {
      const answersByKey = (decision as any).answers as Record<string, string> | undefined;
      const answers = answersByKey && typeof answersByKey === 'object' && !Array.isArray(answersByKey) ? answersByKey : {};
      const answerArray = buildQuestionAnswersArray({ questions, answersByQuestionKey: answers });
      await c.questionReply({ requestId: req.id, answers: answerArray });
      params.session.sendAgentMessage(provider, {
        type: 'tool-result',
        callId: req.id,
        output: { answers },
        id: randomUUID(),
      });
      return;
    }

    if (decision.decision === 'abort') {
      await c.questionReject({ requestId: req.id });
      return;
    }

    await c.questionReject({ requestId: req.id });
  };

  const handlePermissionAsked = async (req: OpenCodePermissionRequest) => {
    if (req.sessionID !== sessionId && !sidechainIdByRemoteSessionId.has(req.sessionID)) return;
    setThinking(false);
    idleSignalSeen = false;
    idleSignalSeenViaControlPlane = false;
    if (turnPromptActive) turnActivitySeen = true;

    const mode = params.getPermissionMode?.() ?? 'default';
    const c = await ensureClient();

    // Mirror Happier permission mode semantics for provider-native permission prompts.
    if (mode === 'read-only' || mode === 'plan') {
      await c.permissionReply({ requestId: req.id, reply: 'reject' });
      return;
    }
    if (mode === 'yolo' || mode === 'acceptEdits' || mode === 'bypassPermissions') {
      await c.permissionReply({ requestId: req.id, reply: 'once' });
      return;
    }

    let decision: Awaited<ReturnType<typeof params.permissionHandler.handleToolCall>>;
    try {
      const resolved = await resolvePermissionAskedToolBridge(req);
      decision = await params.permissionHandler.handleToolCall(
        resolved.localRequestId,
        resolved.toolName,
        resolved.toolInput,
      );
    } catch (error) {
      logger.debug('[OpenCodeServer] permission handler threw; rejecting permission request (fail-closed)', {
        requestId: req.id,
        permission: req.permission,
        sessionId: req.sessionID,
      }, error);
      params.session.sendAgentMessage(provider, {
        type: 'message',
        message: 'Permission request handling failed. For safety, the request was rejected.',
      });
      try {
        await c.permissionReply({ requestId: req.id, reply: 'reject' });
      } catch (replyError) {
        logger.debug('[OpenCodeServer] failed to reject permission request after handler error (non-fatal)', {
          requestId: req.id,
          sessionId: req.sessionID,
        }, replyError);
      }
      return;
    }

    if (decision.decision === 'approved_for_session') {
      // Happier owns "always allow" persistence and scope. Always reply "once" to OpenCode so
      // vendor-side approvals never leak across sessions via a shared server process.
      await c.permissionReply({ requestId: req.id, reply: 'once' });
      return;
    }
    if (decision.decision === 'approved' || decision.decision === 'approved_execpolicy_amendment') {
      await c.permissionReply({ requestId: req.id, reply: 'once' });
      return;
    }
    await c.permissionReply({ requestId: req.id, reply: 'reject' });
  };

  const ensureHandledPermissionIds = (): Set<string> => {
    if (!handledPermissionIds) handledPermissionIds = new Set<string>();
    return handledPermissionIds;
  };

  const ensureHandledQuestionIds = (): Set<string> => {
    if (!handledQuestionIds) handledQuestionIds = new Set<string>();
    return handledQuestionIds;
  };

  const ensureInFlightPermissionIds = (): Set<string> => {
    if (!inFlightPermissionIds) inFlightPermissionIds = new Set<string>();
    return inFlightPermissionIds;
  };

  const ensureInFlightQuestionIds = (): Set<string> => {
    if (!inFlightQuestionIds) inFlightQuestionIds = new Set<string>();
    return inFlightQuestionIds;
  };

  const handleQuestionAskedBestEffort = (req: OpenCodeQuestionRequest) => {
    if (req.sessionID !== sessionId && !sidechainIdByRemoteSessionId.has(req.sessionID)) return;
    const handled = ensureHandledQuestionIds();
    const inFlight = ensureInFlightQuestionIds();
    if (handled.has(req.id) || inFlight.has(req.id)) return;
    inFlight.add(req.id);
    void handleQuestionAsked(req)
      .then(() => {
        handled.add(req.id);
      })
      .catch((error) => {
        logger.debug('[OpenCodeServer] question handler failed (non-fatal)', error);
      })
      .finally(() => {
        inFlight.delete(req.id);
      });
  };

  const handlePermissionAskedBestEffort = (req: OpenCodePermissionRequest) => {
    if (req.sessionID !== sessionId && !sidechainIdByRemoteSessionId.has(req.sessionID)) return;
    const handled = ensureHandledPermissionIds();
    const inFlight = ensureInFlightPermissionIds();
    if (handled.has(req.id) || inFlight.has(req.id)) return;
    inFlight.add(req.id);
    void handlePermissionAsked(req)
      .then(() => {
        handled.add(req.id);
      })
      .catch((error) => {
        logger.debug('[OpenCodeServer] permission handler failed (non-fatal)', error);
      })
      .finally(() => {
        inFlight.delete(req.id);
      });
  };

  const handleEvent = (evt: OpenCodeGlobalEvent): Promise<void> | void => {
    const payload = evt.payload;
    const type = normalizeString(payload.type);
    const props = payload.properties;
    shapeLogger.log(`event:${type || 'unknown'}`, payload);

    if (type === 'message.updated') {
      const info = asRecord(asRecord(props)?.info);
      if (!info) return;
      const infoSessionId = normalizeString(info.sessionID);
      if (!infoSessionId || infoSessionId !== sessionId) return;
      const infoRole = normalizeString(info.role).trim().toLowerCase();
      const infoMessageId = normalizeString(info.id);
      if (infoRole === 'user' && infoMessageId) {
        noteUserMessageIdForActiveTurn(infoMessageId);
      }
      if (infoRole === 'assistant' && infoMessageId) {
        noteAssistantMessageIdForActiveTurn(infoMessageId);
        if (flushPendingInlineSnapshotsForMessage({ remoteSessionId: infoSessionId, messageID: infoMessageId }) && idleSignalSeen) {
          void maybeResolveTurnOnIdleSignal();
        }
      }

      const usageTelemetry = readOpenCodeUsageTelemetryFromMessageInfo({
        info,
        fallbackContextWindowTokens: currentContextWindowTokens,
      });
      if (!usageTelemetry) return;

      params.session.sendAgentMessage(provider, {
        type: 'token_count',
        id: randomUUID(),
        key: `opencode-session:${infoSessionId}`,
        used: usageTelemetry.used,
        size: usageTelemetry.size,
        ...(usageTelemetry.model ? { model: usageTelemetry.model } : {}),
        ...(usageTelemetry.cost ? { cost: usageTelemetry.cost } : {}),
      });
      return;
    }

    if (type === 'message.part.updated' || type === 'message.part.created') {
      const part = asRecord(asRecord(props)?.part);
      if (!part) return;
      const sessionID = normalizeString(part.sessionID);
      if (!sessionID) return;
      const sidechainId = sessionID === sessionId ? null : resolveSidechainIdForRemoteSession(sessionID);
      if (sessionID !== sessionId && !sidechainId) return;
      const partID = normalizeString(part.id);
      const partType = normalizeString(part.type);
      if (partID && partType) partTypeByPartKey.set(`${sessionID}:${partID}`, partType);

      const maybeTool = parseOpenCodeToolPart(part);
      if (maybeTool) {
        if (turnPromptActive) {
          idleSignalSeen = false;
          idleSignalSeenViaControlPlane = false;
        }
        const observedTurnChangeCollectorEpoch = turnChangeCollectorEpoch;
        const toolWork = sendToolFromPart(maybeTool, sidechainId, observedTurnChangeCollectorEpoch).catch((error) => {
          logger.debug('[OpenCodeServer] tool handler failed (non-fatal)', error);
        });
        void trackPendingTurnToolForwardingWork(toolWork).finally(() => {
          if (observedTurnChangeCollectorEpoch === turnChangeCollectorEpoch && idleSignalSeen && turnPromptActive) {
            void maybeResolveTurnOnIdleSignal();
          }
        });
        return toolWork;
      }
      const inlineText = extractOpenCodeRuntimeRenderableTextFromPart(part);
      const messageID = normalizeString(part.messageID);
      if (
        turnPromptActive
        && inlineText
        && messageID
        && sessionID === sessionId
        && (turnUserMessageIds.has(messageID) || inlineTextMatchesCurrentPromptForActiveTurn(inlineText))
      ) {
        noteUserMessageIdForActiveTurn(messageID);
        return;
      }
      if (turnPromptActive && inlineText && messageID) {
        if (sessionID === sessionId) {
          if (!shouldTreatInlineSnapshotMessageIdAsTurnActivity(messageID)) {
            if (turnUserMessageId && messageID === turnUserMessageId) {
              queuePendingInlinePartSnapshot({
                text: inlineText,
                partType,
                remoteSessionId: sessionID,
                messageID,
                sidechainId,
              });
            }
            return;
          }
        } else if (!sidechainId) {
          return;
        }
        idleSignalSeen = false;
        idleSignalSeenViaControlPlane = false;
        applyInlinePartTextSnapshot({
          text: inlineText,
          partType,
          remoteSessionId: sessionID,
          messageID,
          sidechainId,
        });
        return;
      }
      if (!turnPromptActive && sessionID === sessionId) {
        void importLiveCommittedTextHistoryBestEffort({ allowAssistantReplies: false });
      }
      return;
    }

    if (type === 'message.part.delta') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID) return;
      const sidechainId = sessionID === sessionId ? null : resolveSidechainIdForRemoteSession(sessionID);
      if (sessionID !== sessionId && !sidechainId) return;
      const messageID = normalizeString(rec.messageID);
      const partID = normalizeString(rec.partID);
      const delta = normalizeString(rec.delta);
      if (!messageID || !partID || !delta) return;
      if (sessionID === sessionId) {
        if (!shouldTreatMessageIdAsTurnActivity(messageID)) return;
      } else {
        if (!turnPromptActive) return;
      }
      if (turnPromptActive) {
        idleSignalSeen = false;
        idleSignalSeenViaControlPlane = false;
      }
      const partType = partTypeByPartKey.get(`${sessionID}:${partID}`) ?? '';
      const accumulationKey = `${sessionID}:${messageID}:${partType === 'reasoning' ? 'reasoning' : 'text'}`;
      const accumulated = accumulatedTextByPartKey.get(accumulationKey) ?? '';
        const nextAccumulated = delta.startsWith(accumulated) ? delta : accumulated + delta;
        accumulatedTextByPartKey.set(accumulationKey, nextAccumulated);

        const deltaOut = delta.startsWith(accumulated) ? delta.slice(accumulated.length) : delta;
        if (!deltaOut) return;
      if (partType === 'reasoning') {
        sendThinkingDelta(deltaOut, sessionID, messageID, sidechainId);
      } else {
        sendDelta(deltaOut, sessionID, messageID, sidechainId);
      }
      return;
    }

    if (type === 'question.asked') {
      const req = parseQuestionRequest(props);
      if (!req) return;
      handleQuestionAskedBestEffort(req);
      return;
    }

    if (type === 'permission.asked') {
      const req = parsePermissionRequest(props);
      if (req) {
        handlePermissionAskedBestEffort(req);
        return;
      }

      const rec = asRecord(props);
      const requestId = normalizeString(rec?.id);
      const rawSessionId = normalizeString(rec?.sessionID);
      const belongsToThisRuntime = rawSessionId && (rawSessionId === sessionId || sidechainIdByRemoteSessionId.has(rawSessionId));
      if (belongsToThisRuntime && requestId) {
        void (async () => {
          params.session.sendAgentMessage(provider, {
            type: 'message',
            message: 'OpenCode emitted a malformed permission request. For safety, it was rejected.',
          });
          const c = await ensureClient();
          await c.permissionReply({ requestId, reply: 'reject' });
        })().catch((error) => {
          logger.debug('[OpenCodeServer] failed to reject malformed permission request (non-fatal)', {
            requestId,
            sessionId: rawSessionId,
          }, error);
          abortTurnFailClosedDueToPermissionProtocolError(error);
        });
        return;
      }

      if (belongsToThisRuntime) {
        const failure = new Error('OpenCode emitted a malformed permission request (missing id)');
        abortTurnFailClosedDueToPermissionProtocolError(failure);
      }
      return;
    }

    if (type === 'session.status') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      const statusRec = asRecord(rec.status);
      const statusType = normalizeString(statusRec?.type);
      if (!turnPromptActive && (statusType === 'busy' || statusType === 'idle')) {
        void importLiveCommittedTextHistoryBestEffort({ allowAssistantReplies: statusType === 'idle' });
      }
      if (statusType === 'busy') {
        setThinking(true);
      }
      if (statusType === 'idle') {
        setThinking(false);
        if (turnPromptActive) {
          idleSignalSeen = true;
          idleSignalSeenViaControlPlane = false;
          void maybeResolveTurnOnIdleSignal();
        }
      }
      return;
    }

    if (type === 'session.idle') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      if (!turnPromptActive) {
        void importLiveCommittedTextHistoryBestEffort({ allowAssistantReplies: true });
      }
      setThinking(false);
      if (turnPromptActive) {
        idleSignalSeen = true;
        idleSignalSeenViaControlPlane = false;
        void maybeResolveTurnOnIdleSignal();
      }
      return;
    }

    if (type === 'session.error') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      const isExpectedExplicitCancelError = suppressSessionErrorAbortNotificationForSessionId === sessionID;
      setThinking(false);
      void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'session_error' }).finally(() => {
        if (!isExpectedExplicitCancelError) {
          params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
        }
      });
      const detail = extractOpenCodeErrorText(rec.error);
      if (!isExpectedExplicitCancelError && shouldSurfaceOpenCodeErrorDetail(detail)) {
        params.session.sendAgentMessage(provider, { type: 'message', message: detail });
      }
      rejectTurn(detail ? new Error(detail) : rec.error ?? new Error('OpenCode session error'));
      return;
    }

    return;
  };

  const resetRuntimeState = () => {
    turnDeferred = null;
    turnInFlight = false;
    resetTurnEventState();
  };

  const ensureMcpServersForCurrentDirectoryBestEffort = async (): Promise<void> => {
    if (ensuredMcpServersForDirectory) return;
    if (!params.mcpServers || Object.keys(params.mcpServers).length === 0) return;
    const c = await ensureClient();
    let hadFailures = false;
    for (const [name, cfg] of Object.entries(params.mcpServers)) {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) continue;
      const cmd = typeof cfg?.command === 'string' ? cfg.command.trim() : '';
      if (!cmd) continue;
      const args = Array.isArray(cfg.args) ? cfg.args.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : [];
      const env = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
        ? Object.fromEntries(
            Object.entries(cfg.env).filter(([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string'),
          )
        : undefined;

      try {
        await c.mcpAdd({
          name: serverName,
          config: {
            type: 'local',
            enabled: true,
            command: [cmd, ...args],
            ...(env && Object.keys(env).length > 0 ? { environment: env } : {}),
          },
        });
        ensuredMcpServerNames.add(serverName);
      } catch (error) {
        hadFailures = true;
        logger.debug('[OpenCodeServer] Failed to register MCP server (non-fatal)', { serverName, error });
      }
    }
    ensuredMcpServersForDirectory = hadFailures !== true;
  };

  const preferredOpenCodeChangeTitleToolName = resolvePreferredChangeTitleToolNameForProvider('opencode');
  return {
    getSessionId: () => sessionId,
    shouldResumeAfterPermissionModeChange: () => true,
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => turnInFlight,

    beginTurn(): void {
      suppressSessionErrorAbortNotificationForSessionId = null;
      turnInFlight = true;
      pendingTurnToolForwardingWork = new Set<Promise<void>>();
      turnPromptActive = false;
      turnActivitySeen = false;
      idleSignalSeen = false;
      idleSignalSeenViaControlPlane = false;
      beginFreshTurnChangeCollection();
      params.session.sendAgentMessage(provider, { type: 'task_started', id: randomUUID() });
      setThinking(true);
    },

    async startOrLoad(opts: { resumeId?: string | null } = {}): Promise<string> {
      ensuredMcpServersForDirectory = false;
      await attachSubscriptionIfNeeded();
      const c = await ensureClient();

      await ensureMcpServersForCurrentDirectoryBestEffort();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (resumeId) {
        const existing = await c.sessionGet({ sessionId: resumeId });
        sessionId = existing.id ?? resumeId;
        omitCustomMessageIdForResumedSession = true;
        const sessionDirectory = normalizeString((existing as any)?.directory).trim();
        if (sessionDirectory) {
          try {
            c.setDirectoryOverride(sessionDirectory);
          } catch {
            // non-fatal
          }
          ensuredMcpServersForDirectory = false;
          await ensureMcpServersForCurrentDirectoryBestEffort();
        }
        await c.sessionUpdate({ sessionId: sessionId!, permission: [...resolveSessionPermissionRuleset()] as unknown[] });
        publishDynamicSessionOptionsBestEffort();
        const snapshot = params.session.getMetadataSnapshot();
        const existingVendorSessionId = readOpenCodeSessionRuntimeHandleFromMetadata(snapshot).vendorSessionId ?? '';
        const marker = snapshot && typeof snapshot === 'object' ? (snapshot as any).opencodeResumeHistoryImportV1 : null;
        const shouldSkipHistoryImport =
          (existingVendorSessionId && existingVendorSessionId === resumeId) ||
          Boolean(marker && typeof marker === 'object' && (marker as any).v === 1 && String((marker as any).remoteSessionId ?? '') === resumeId);
        if (shouldSkipHistoryImport) {
          try {
            const raw = await c.sessionMessagesList({ sessionId: resumeId });
            markObservedTextHistoryItems(extractOpenCodeTextHistoryItems(Array.isArray(raw) ? raw : []));
          } catch {
            // non-fatal
          }
        }

        // Best-effort: import remote history into a fresh Happier session when resuming. This powers
        // the provider contract scenario `acp_resume_fresh_session_imports_history`.
        void (async () => {
          try {
            // If we're resuming inside an existing Happier session that already has an OpenCode sessionId,
            // do not import remote history again (avoids transcript duplication and resume flakiness).
            if (shouldSkipHistoryImport) {
              return;
            }
            const raw = await c.sessionMessagesList({ sessionId: resumeId });
            const items = extractOpenCodeTextHistoryItems(raw);
            if (items.length === 0) return;
            await importOpenCodeTextHistoryCommitted({
              session: params.session,
              provider,
              remoteSessionId: resumeId,
              items,
              importedFrom: 'acp-history',
            });
            markObservedTextHistoryItems(items);
            await params.session.updateMetadata((prev) => ({
              ...(prev as any),
              opencodeResumeHistoryImportV1: { v: 1, remoteSessionId: resumeId, importedAtMs: Date.now() },
            }));
          } catch (error) {
            logger.debug('[OpenCodeServer] Failed to import resume history (non-fatal)', error);
          }
        })();

        return sessionId!;
      }

      const created: OpenCodeSession = await c.sessionCreate({ permission: [...resolveSessionPermissionRuleset()] as unknown[] });
      sessionId = created.id;
      omitCustomMessageIdForResumedSession = false;
      const createdDirectory = normalizeString((created as any)?.directory).trim();
      if (createdDirectory) {
        try {
          c.setDirectoryOverride(createdDirectory);
        } catch {
          // non-fatal
        }
        ensuredMcpServersForDirectory = false;
        await ensureMcpServersForCurrentDirectoryBestEffort();
      }
      publishDynamicSessionOptionsBestEffort();
      return sessionId!;
    },

    async sendPrompt(prompt: string): Promise<void> {
      const resumeBackfillLocalId = omitCustomMessageIdForResumedSession
        ? `opencode-resume-local-${randomUUID()}`
        : null;
      await this.sendPromptWithMeta?.({ text: prompt, localId: resumeBackfillLocalId });
    },

    async sendPromptWithMeta(paramsWithMeta: { text: string; localId?: string | null }): Promise<void> {
      if (!sessionId) throw new Error('OpenCode server session was not started');
      const c = await ensureClient();

      const effectiveText = typeof paramsWithMeta.text === 'string' ? paramsWithMeta.text : '';

      const shouldOmitCustomMessageId = omitCustomMessageIdForResumedSession === true;
      const messageID = shouldOmitCustomMessageId
        ? undefined
        : (await resolveOrCreateUserMessageId(paramsWithMeta.localId ?? null)) ?? undefined;
      if (messageID) observedRemoteTextMessageIds.add(messageID);
      const agent = selectedAgent ?? undefined;
      const model = selectedModel ?? undefined;
      const config = Object.keys(configOverrides).length > 0 ? { ...configOverrides } : undefined;
      turnDeferred = createDeferred<void>();
      // A turn can be aborted from a background poll/SSE callback before sendPromptWithMeta reaches its await.
      // Attach a handler immediately so Node does not treat the rejection as unhandled.
      void turnDeferred.promise.catch(() => undefined);
      const thisTurnDeferred = turnDeferred;
      turnPromptActive = true;
      turnActivitySeen = false;
      idleSignalSeen = false;
      idleSignalSeenViaControlPlane = false;
      turnUserMessageId = messageID ?? null;
      turnPromptLocalId = typeof paramsWithMeta.localId === 'string' ? paramsWithMeta.localId.trim() : null;
      turnPromptTextForBackfill = paramsWithMeta.text;
      turnPromptEffectiveTextForBackfill = effectiveText;
      turnPrePromptMessageIdsAll = null;
      turnPreexistingMessageIds = null;
      handledPermissionIds = new Set<string>();
      handledQuestionIds = new Set<string>();
      inFlightPermissionIds = new Set<string>();
      inFlightQuestionIds = new Set<string>();
      const controlAbort = new AbortController();
      turnControlAbort = controlAbort;
      let prePromptMessageIdsForBackfill: Set<string> | null = null;

      if (!shouldOmitCustomMessageId) {
        await waitForIdleBeforePromptBestEffort({ client: c, sessionId, signal: controlAbort.signal });
      }
      if (controlAbort.signal.aborted) {
        // Abort handling (runtime.cancel) will reject the turn; do not attempt to send another prompt.
        await thisTurnDeferred.promise;
        return;
      }

      try {
        const raw = await c.sessionMessagesList({ sessionId });
        const items = Array.isArray(raw) ? raw : [];
        const ids: string[] = [];
        for (const row of items) {
          const id = extractOpenCodeSessionMessageId(row);
          if (id) ids.push(id);
        }
        if (ids.length > 0) {
          prePromptMessageIdsForBackfill = new Set<string>(ids);
          turnPrePromptMessageIdsAll = prePromptMessageIdsForBackfill;
          const tail = ids.length > turnPreexistingSnapshotLimit ? ids.slice(ids.length - turnPreexistingSnapshotLimit) : ids;
          turnPreexistingMessageIds = new Set<string>(tail);
        }
      } catch {
        // Best-effort: fall back to turnPromptActive-only gating.
        turnPreexistingMessageIds = null;
        turnPrePromptMessageIdsAll = null;
      }

      try {
        await c.sessionPromptAsync({
          sessionId,
          messageId: messageID,
          agent,
          model,
          config,
          parts: [{ type: 'text', text: effectiveText }],
        });
      } catch (error) {
        setThinking(false);
        await flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'prompt_async_error' });
        const detail = extractOpenCodeErrorText(error);
        if (shouldSurfaceOpenCodeErrorDetail(detail)) {
          params.session.sendAgentMessage(provider, { type: 'message', message: detail });
        }
        params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
        rejectTurn(error);
        throw error;
      }

      const pollControlPlaneOnce = async () => {
        if (controlAbort.signal.aborted) return;
        let perms: OpenCodePermissionRequest[];
        let qs: OpenCodeQuestionRequest[];
        try {
          perms = await listPendingPermissionRequests();
          qs = await listPendingQuestionRequests();
        } catch (error) {
          return;
        }
        await pollIdleStatusFromControlPlaneBestEffort();
        await backfillAssistantTextFromControlPlaneBestEffort();
        const permIds = handledPermissionIds ?? new Set<string>();
        const qIds = handledQuestionIds ?? new Set<string>();
        const permInFlight = inFlightPermissionIds ?? new Set<string>();
        const qInFlight = inFlightQuestionIds ?? new Set<string>();
        for (const req of perms) {
          if (permIds.has(req.id) || permInFlight.has(req.id)) continue;
          permInFlight.add(req.id);
          try {
            await handlePermissionAsked(req);
            permIds.add(req.id);
          } catch (error) {
            logger.debug('[OpenCodeServer] permission handler failed (non-fatal)', error);
          } finally {
            permInFlight.delete(req.id);
          }
        }
        for (const req of qs) {
          if (qIds.has(req.id) || qInFlight.has(req.id)) continue;
          qInFlight.add(req.id);
          try {
            await handleQuestionAsked(req);
            qIds.add(req.id);
          } catch (error) {
            logger.debug('[OpenCodeServer] question handler failed (non-fatal)', error);
          } finally {
            qInFlight.delete(req.id);
          }
        }
        void maybeResolveTurnOnIdleSignal();
      };

      const pollLoop = (async () => {
        await pollControlPlaneOnce();
        while (!controlAbort.signal.aborted) {
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              cleanup();
              clearTimeout(timer);
              resolve();
            };
            const cleanup = () => {
              controlAbort.signal.removeEventListener('abort', onAbort);
            };

            const timer = setTimeout(() => {
              cleanup();
              resolve();
            }, turnPromptActive && !idleSignalSeen ? turnActivePollSleepMs : pollSleepMs);
            timer.unref?.();

            controlAbort.signal.addEventListener('abort', onAbort, { once: true });
            if (controlAbort.signal.aborted) {
              cleanup();
              clearTimeout(timer);
              resolve();
            }
          });
          await pollControlPlaneOnce();
        }
      })().catch((error) => {
        logger.debug('[OpenCodeServer] control-plane polling loop failed (non-fatal)', error);
      });

      try {
        await thisTurnDeferred.promise;
        if (shouldOmitCustomMessageId) {
          await backfillVendorAssignedUserMessageIdBestEffort({
            localIdRaw: paramsWithMeta.localId ?? null,
            promptText: paramsWithMeta.text,
            promptTextAlternates: [effectiveText],
            prePromptMessageIds: prePromptMessageIdsForBackfill,
          });
        }
      } finally {
        try {
          controlAbort.abort();
        } catch {
          // ignore
        }
        await pollLoop.catch(() => {});
      }
    },

    flushTurn(): void {
      turnInFlight = false;
      setThinking(false);
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      const c = await ensureClient();
      suppressSessionErrorAbortNotificationForSessionId = sessionId;
      const abortPromise = c.sessionAbort({ sessionId });

      const outcome = await Promise.race([
        abortPromise.then(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), abortTimeoutMs);
          timer.unref?.();
        }),
      ]).catch(() => 'done' as const);

      if (outcome === 'timeout') {
        void abortPromise.catch(() => {});
      }

      setThinking(false);
      await flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'cancelled' });
      rejectTurn(new Error('OpenCode session aborted'));
      resetRuntimeState();
    },

    async reset(): Promise<void> {
      resetRuntimeState();
      setThinking(false);
      sessionId = null;
      selectedAgent = null;
      selectedModel = null;
      currentContextWindowTokens = null;
      omitCustomMessageIdForResumedSession = false;
      suppressSessionErrorAbortNotificationForSessionId = null;
      for (const key of Object.keys(configOverrides)) delete configOverrides[key];
      ensuredMcpServersForDirectory = false;
      if (ensuredMcpServerNames.size > 0) {
        try {
          const c = await ensureClient();
          const names = [...ensuredMcpServerNames];
          ensuredMcpServerNames.clear();
          await Promise.all(names.map(async (name) => await c.mcpDisconnect({ name }).catch(() => {})));
        } catch {
          ensuredMcpServerNames.clear();
        }
      }
      if (subscriptionAbort) {
        try {
          subscriptionAbort.abort();
        } catch {
          // ignore
        }
        subscriptionAbort = null;
      }
      if (client) {
        try {
          await client.dispose();
        } catch (e) {
          logger.debug('[OpenCodeServer] Failed to dispose client (non-fatal)', e);
        }
        client = null;
      }
    },

    async setSessionMode(modeId: string): Promise<void> {
      const trimmed = typeof modeId === 'string' ? modeId.trim() : '';
      selectedAgent = trimmed.length > 0 ? trimmed : null;
      publishDynamicSessionOptionsBestEffort();
    },

    async setSessionConfigOption(configId: string, value: string | number | boolean | null): Promise<void> {
      const normalizedId = typeof configId === 'string' ? configId.trim() : '';
      if (!normalizedId) return;
      if (normalizedId === 'reasoning_effort') {
        if (value === null) {
          delete configOverrides.variant;
          return;
        }
        const variant = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
        if (!variant) {
          delete configOverrides.variant;
          return;
        }
        configOverrides.variant = variant;
        return;
      }
      if (value === null) {
        delete configOverrides[normalizedId];
        return;
      }
      configOverrides[normalizedId] = value;
    },

    async setSessionModel(modelId: string): Promise<void> {
      const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
      if (!trimmed) {
        selectedModel = null;
        publishDynamicSessionOptionsBestEffort();
        return;
      }
      const parsed = parseOpenCodeModelId(trimmed);
      if (!parsed) throw new Error(`Invalid OpenCode model id: ${modelId}`);
      selectedModel = parsed;
      publishDynamicSessionOptionsBestEffort();
    },
  };
}
