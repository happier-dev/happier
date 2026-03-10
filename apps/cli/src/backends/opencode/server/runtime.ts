import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@/agent';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import { configuration } from '@/configuration';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { buildChangeTitleInstruction, shouldAppendChangeTitleInstruction } from '@/agent/runtime/changeTitleInstruction';
import { CHANGE_TITLE_TOOL_NAME_ALIASES, isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from './types';
import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from './client';
import { extractOpenCodeTextHistoryItems, importOpenCodeTextHistoryCommitted } from './openCodeSessionMessageImport';
import { extractOpenCodeTaskChildSessionId, importOpenCodeTaskSidechainBestEffort } from './openCodeTaskSidechainImport';
import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';
import { asRecord, normalizeString, normalizeStringArray } from './openCodeParsing';
import { extractOpenCodeErrorText } from './openCodeErrorText';
import { extractOpenCodeSessionMessageId, parseOpenCodeToolPart } from './openCodeMessageParsing';
import { canonicalizeOpenCodeConfiguredMcpToolName, resolveOpenCodeChangeTitleToolNameForMcpClient } from './openCodeMcpToolNames';
import { modelSupportsToolCalls, parseOpenCodeModelId, resolveOpenCodeDefaultProviderIdFromModelId } from './openCodeModelParsing';
import { parsePermissionRequest } from './openCodePermissionParsing';
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
import { buildOpenCodeSessionPermissionRuleset } from '@/agent/runtime/permission/openCodeFamilyPermissionPolicy';

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

function normalizeEnvVar(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type OpenCodeServerRuntimeDeps = Readonly<{
  createClient?: typeof createOpenCodeServerRuntimeClient;
}>;

export function createOpenCodeServerRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: ProviderEnforcedPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
}, deps: OpenCodeServerRuntimeDeps = {}) {
  const provider: ACPProvider = 'opencode';
  const createClient = deps.createClient ?? createOpenCodeServerRuntimeClient;

  let client: OpenCodeServerRuntimeClient | null = null;
  let sessionId: string | null = null;
  let subscriptionAbort: AbortController | null = null;

  let selectedAgent: string | null = null;
  let selectedModel: OpenCodeModelRef | null = null;
  const configOverrides: Record<string, unknown> = {};
  let omitCustomMessageIdOnFirstPromptAfterResume = false;
  let didSendChangeTitleInstructionForSession = false;
  let ensuredMcpServersForDirectory = false;
  const ensuredMcpServerNames = new Set<string>();

  let turnDeferred: Deferred<void> | null = null;
  let turnInFlight = false;
  let turnPromptActive = false;
  let turnActivitySeen = false;
  let turnUserMessageId: string | null = null;
  let turnPrePromptMessageIdsAll: ReadonlySet<string> | null = null;
  let turnPreexistingMessageIds: ReadonlySet<string> | null = null;
  const turnStreamedAssistantMessageIds = new Set<string>();
  const turnBackfilledAssistantMessageIds = new Set<string>();
  let turnAssistantBackfillAttempts = 0;
  let turnAssistantBackfillFirstAttemptAtMs: number | null = null;
  let turnAssistantBackfillIdleAttempted = false;
  let idleSignalSeen = false;
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
  let queuedLiveHistorySyncAllowAssistantReplies = false;

  let turnStreamKey: string | null = null;
  const accumulatedTextByPartKey = new Map<string, string>();

  const resolveSessionPermissionRuleset = (): ReadonlyArray<{ permission: string; pattern: string; action: 'ask' | 'allow' | 'deny' }> =>
    buildOpenCodeSessionPermissionRuleset(params.getPermissionMode?.() ?? 'default');

  const partTypeByPartKey = new Map<string, string>();
  const toolCallSentByCallId = new Set<string>();
  const toolResultSentByCallId = new Set<string>();

  const ensureClient = async (): Promise<OpenCodeServerRuntimeClient> => {
    if (client) return client;
    client = await createClient({
      directory: params.directory,
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
      const defaultProviderId = defaultModelId ? resolveOpenCodeDefaultProviderIdFromModelId(defaultModelId) : '';

      const includedProviders = (Array.isArray(providers) ? providers : []).filter((p) => {
        const id = normalizeString((p as any)?.id);
        if (!id) return false;
        if (defaultProviderId && id === defaultProviderId) return true;
        const env = Array.isArray((p as any)?.env) ? (p as any).env : [];
        if (!Array.isArray(env) || env.length === 0) return false;
        return env.some((k: unknown) => {
          const key = normalizeString(k);
          if (!key) return false;
          return normalizeEnvVar(process.env[key]) !== '';
        });
      });

      const availableModels: Array<{ id: string; name: string; description?: string }> = [];
      for (const p of includedProviders) {
        const providerId = normalizeString((p as any)?.id);
        if (!providerId) continue;
        const modelsRec = asRecord((p as any)?.models);
        if (!modelsRec) continue;
        const keys = Object.keys(modelsRec).sort();
        for (const key of keys) {
          const modelRec = modelsRec[key];
          if (!modelSupportsToolCalls(modelRec)) continue;
          const modelId = normalizeString(asRecord(modelRec)?.id) || key;
          const fullId = `${providerId}/${modelId}`;
          const name = normalizeString(asRecord(modelRec)?.name) || modelId;
          const description = normalizeString(asRecord(modelRec)?.family) || '';
          availableModels.push({ id: fullId, name, ...(description ? { description } : {}) });
        }
      }

      const availableModes = (Array.isArray(agents) ? agents : [])
        .map((a) => ({ id: normalizeString((a as any)?.name), name: normalizeString((a as any)?.name), description: normalizeString((a as any)?.description) }))
        .filter((a) => a.id && a.name)
        .map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) }));

      const currentModeId = selectedAgent
        ?? (availableModes.find((m) => m.id === 'build')?.id ?? availableModes[0]?.id ?? 'build');
      const currentModelId = selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : (defaultModelId || 'default');

      const snapshot = await params.session.ensureMetadataSnapshot({ timeoutMs: 60_000 }).catch(() => null);
      if (!snapshot) return;

      const updatedAt = Date.now();
      await params.session.updateMetadata((prev) => ({
        ...prev,
        acpSessionModesV1: {
          v: 1,
          provider,
          updatedAt,
          currentModeId,
          availableModes,
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
        const processEvent = (): Promise<void> | void => {
          try {
            return handleEvent(evt);
          } catch (error) {
            logger.debug('[OpenCodeServer] Failed handling event (non-fatal)', error);
          }
        };

        const trackPendingEventWork = (work: Promise<void>): Promise<void> => {
          const tracked = work.finally(() => {
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
        if (!isPromiseLike(maybePendingWork)) return maybePendingWork;
        return trackPendingEventWork(Promise.resolve(maybePendingWork));
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      logger.debug('[OpenCodeServer] Global event subscription failed (non-fatal)', error);
    });
  };

  let currentThinking = false;
  let pendingEventWork: Promise<void> | null = null;
  const setThinking = (value: boolean) => {
    if (value === currentThinking) return;
    currentThinking = value;
    params.session.keepAlive(value, 'remote');
    params.onThinkingChange(value);
  };

  const resetTurnEventState = () => {
    clearStreamWriters();
    turnStreamKey = null;
    turnPromptActive = false;
    turnActivitySeen = false;
    turnUserMessageId = null;
    turnPrePromptMessageIdsAll = null;
    turnPreexistingMessageIds = null;
    turnStreamedAssistantMessageIds.clear();
    turnBackfilledAssistantMessageIds.clear();
    turnAssistantBackfillAttempts = 0;
    turnAssistantBackfillFirstAttemptAtMs = null;
    turnAssistantBackfillIdleAttempted = false;
    idleSignalSeen = false;
    statusPollBusySeen = false;
    resolveOnIdleInFlight = false;
    sidechainIdByRemoteSessionId.clear();
    sidechainStreamSeenBySidechainId.clear();
    pendingTaskSidechainImportsBySidechainId.clear();
    pendingTaskChildSessionDiscoveryCallKeys.clear();
      accumulatedTextByPartKey.clear();
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

  const resolveTurn = () => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    resetTurnEventState();
    d.resolve();
  };

  const rejectTurn = (error: unknown) => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    resetTurnEventState();
    d.reject(error);
  };

  const pollSleepMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 25 ? Math.trunc(raw) : configuration.pendingQueueIdleWakePollIntervalMs;
    // Clamp to keep control-plane polling responsive without excessive churn.
    return Math.max(25, Math.min(2_000, configured));
  })();

  const turnPreexistingSnapshotLimit = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_TURN_PREEXISTING_SNAPSHOT_LIMIT ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
    return Math.max(10, Math.min(2_000, configured));
  })();

  const abortTimeoutMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_500;
    // Keep abort responsive but allow slow local servers a moment to drain.
    return Math.max(25, Math.min(30_000, configured));
  })();

  const prePromptIdleWaitMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_PREPROMPT_IDLE_WAIT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 30_000;
    return Math.max(0, Math.min(300_000, configured));
  })();

  const streamDeltaFlushIntervalMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 50;
    return Math.max(0, Math.min(2_000, configured));
  })();

  const streamDeltaMaxChars = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_MAX_CHARS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 8_000;
    return Math.max(256, Math.min(200_000, configured));
  })();

  const controlPlaneMaxConsecutiveFailures = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 3;
    return Math.max(1, Math.min(100, configured));
  })();

  const controlPlaneFailureGraceMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000;
    return Math.max(250, Math.min(300_000, configured));
  })();

  const controlPlaneDisconnectMessage = (() => {
    const raw = normalizeEnvVar(process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_MESSAGE);
    return raw || 'OpenCode server connection lost. Please restart OpenCode and try again.';
  })();

  const statusPollEnabled = (() => {
    const raw = normalizeEnvVar(process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED);
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
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_MAX_ATTEMPTS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60;
    return Math.max(1, Math.min(100, configured));
  })();

  const assistantBackfillGraceMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_GRACE_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60_000;
    return Math.max(100, Math.min(300_000, configured));
  })();

  let controlPlaneFailureCount = 0;
  let controlPlaneFirstFailureAtMs: number | null = null;

  const resetControlPlaneFailures = () => {
    controlPlaneFailureCount = 0;
    controlPlaneFirstFailureAtMs = null;
  };

  const maybeAbortTurnOnControlPlaneFailure = (error: unknown) => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;

    const nowMs = Date.now();
    if (controlPlaneFirstFailureAtMs == null) {
      controlPlaneFirstFailureAtMs = nowMs;
      controlPlaneFailureCount = 0;
    }
    controlPlaneFailureCount += 1;

    const exceededConsecutive = controlPlaneFailureCount >= controlPlaneMaxConsecutiveFailures;
    const exceededGrace = Number.isFinite(nowMs) && controlPlaneFirstFailureAtMs != null
      ? nowMs - controlPlaneFirstFailureAtMs >= controlPlaneFailureGraceMs
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
    if (turnUserMessageId && messageID === turnUserMessageId) return false;
    if (turnPreexistingMessageIds && turnPreexistingMessageIds.has(messageID)) return false;
    if (turnBackfilledAssistantMessageIds.has(messageID)) return false;
    return true;
  };

  const listPendingPermissionRequests = async (): Promise<OpenCodePermissionRequest[]> => {
    const c = await ensureClient();
    const raw = await c.permissionList().catch(() => []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => parsePermissionRequest(item))
      .filter((item): item is OpenCodePermissionRequest => Boolean(item))
      .filter((item) => item.sessionID === sessionId || sidechainIdByRemoteSessionId.has(item.sessionID));
  };

  const listPendingQuestionRequests = async (): Promise<OpenCodeQuestionRequest[]> => {
    const c = await ensureClient();
    const raw = await c.questionList().catch(() => []);
    if (!Array.isArray(raw)) return [];
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
      resetControlPlaneFailures();
    } catch (error) {
      maybeAbortTurnOnControlPlaneFailure(error);
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
  };

  const maybeResolveTurnOnIdleSignal = async () => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!idleSignalSeen) return;
    if (!turnActivitySeen) return;
    if (resolveOnIdleInFlight) return;
    resolveOnIdleInFlight = true;
    try {
      // When idle is observed via SSE, the status poll loop may not run again before we resolve.
      // Backfill assistant text one final time on idle to avoid ending the turn without the final response.
      if (!turnAssistantBackfillIdleAttempted) {
        await backfillAssistantTextFromControlPlaneBestEffort();
      }
      const permissions = await listPendingPermissionRequests();
      const questions = await listPendingQuestionRequests();
      const handledPerms = handledPermissionIds ?? new Set<string>();
      const handledQs = handledQuestionIds ?? new Set<string>();
      const inFlightPerms = inFlightPermissionIds ?? new Set<string>();
      const inFlightQs = inFlightQuestionIds ?? new Set<string>();
      const hasUnhandled =
        permissions.some((p) => !handledPerms.has(p.id) || inFlightPerms.has(p.id)) ||
        questions.some((q) => !handledQs.has(q.id) || inFlightQs.has(q.id));
      if (hasUnhandled) return;
      if (!turnDeferred) return;
      if (pendingTaskChildSessionDiscoveryCallKeys.size > 0) return;

      // Ensure Task sidechain imports are committed before the turn completes, otherwise
      // downstream scenarios can miss the imported sidechain transcript (e.g. provider tests
      // that assert Task subagent output is present synchronously after task_complete).
      const pendingSidechainImports = Array.from(pendingTaskSidechainImportsBySidechainId.values());
      if (pendingSidechainImports.length > 0) {
        await Promise.allSettled(pendingSidechainImports);
      }

      await flushAndClearStreamWriters({ reason: 'turn-end' });
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
    prePromptMessageIds: ReadonlySet<string> | null;
  }): Promise<void> => {
    const localId = typeof paramsForBackfill.localIdRaw === 'string' ? paramsForBackfill.localIdRaw.trim() : '';
    if (!localId) return;
    if (!sessionId) return;
    if (resolveOpenCodeUserMessageIdFromMetadata(params.session.getMetadataSnapshot(), localId)) return;

    let raw: unknown;
    try {
      const c = await ensureClient();
      raw = await c.sessionMessagesList({ sessionId });
    } catch {
      return;
    }

    const items = extractOpenCodeTextHistoryItems(Array.isArray(raw) ? raw : []);
    if (items.length === 0) return;

    const unseenUserItems = items.filter((item) => {
      if (item.role !== 'user') return false;
      return !paramsForBackfill.prePromptMessageIds || !paramsForBackfill.prePromptMessageIds.has(item.messageId);
    });
    if (unseenUserItems.length === 0) return;

    const normalizedPromptText = paramsForBackfill.promptText.trim();
    let candidateMessageId: string | null = null;
    for (let index = unseenUserItems.length - 1; index >= 0; index -= 1) {
      const item = unseenUserItems[index]!;
      if (item.text.trim() === normalizedPromptText) {
        candidateMessageId = item.messageId;
        break;
      }
    }
    if (!candidateMessageId) {
      candidateMessageId = unseenUserItems[unseenUserItems.length - 1]!.messageId;
    }
    if (!candidateMessageId) return;

    try {
      await params.session.updateMetadata((prev) => {
        const base = prev && typeof prev === 'object' ? (prev as any as Record<string, unknown>) : {};
        return upsertOpenCodeUserMessageIdInMetadata({ metadata: base, localId, messageId: candidateMessageId! }) as any;
      });
    } catch {
      // Best-effort: do not block prompt completion on metadata persistence.
    }

    observedRemoteTextMessageIds.add(candidateMessageId);
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
      maybeAbortTurnOnControlPlaneFailure(error);
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
    draftFlushIntervalMs: streamDeltaFlushIntervalMs,
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

  const sendToolFromPart = async (part: ReturnType<typeof parseOpenCodeToolPart>, sidechainId: string | null) => {
    if (!part) return;
    turnActivitySeen = true;
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);

      const status = normalizeString(part.state.status);
      const callId = part.callID;
      const callKey = `${part.sessionID}:${callId}`;
      const messageID = part.messageID;
      const toolRaw = normalizeString(part.tool).trim();
      const toolLower = toolRaw.toLowerCase();
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

      const canonicalMcpToolName =
        canonicalizeOpenCodeConfiguredMcpToolName(toolRaw, params.mcpServers);
      const toolNameForAcp = canonicalMcpToolName ?? (toolLower === 'grep' ? 'search' : toolRaw);
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
          await flushAndClearStreamWriters({ reason: 'tool-call-boundary' });
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

      if (idleSignalSeen && turnPromptActive) {
        void maybeResolveTurnOnIdleSignal();
      }
    }
  };

  const handleQuestionAsked = async (req: OpenCodeQuestionRequest) => {
    if (req.sessionID !== sessionId && !sidechainIdByRemoteSessionId.has(req.sessionID)) return;

    setThinking(false);
    idleSignalSeen = false;
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

    const decision = await params.permissionHandler.handleToolCall(req.id, req.permission, {
      permission: req.permission,
      patterns: req.patterns,
      always: req.always,
      metadata: req.metadata,
    });

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

  const handleEvent = (evt: OpenCodeGlobalEvent) => {
    const payload = evt.payload;
    const type = normalizeString(payload.type);
    const props = payload.properties;

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
        void sendToolFromPart(maybeTool, sidechainId).catch((error) => {
          logger.debug('[OpenCodeServer] tool handler failed (non-fatal)', error);
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
      if (!req) return;
      handlePermissionAskedBestEffort(req);
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
        void maybeResolveTurnOnIdleSignal();
      }
      return;
    }

    if (type === 'session.error') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      setThinking(false);
      void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'session_error' }).finally(() => {
        params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
      });
      const detail = extractOpenCodeErrorText(rec.error);
      if (detail) {
        params.session.sendAgentMessage(provider, { type: 'message', message: detail });
      }
      rejectTurn(rec.error ?? new Error('OpenCode session error'));
      return;
    }
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

  const preferredOpenCodeChangeTitleToolName = resolveOpenCodeChangeTitleToolNameForMcpClient('happier');
  const changeTitleInstruction = buildChangeTitleInstruction({ preferredToolName: preferredOpenCodeChangeTitleToolName });

  return {
    getSessionId: () => sessionId,
    shouldResumeAfterPermissionModeChange: () => false,
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => turnInFlight,

    beginTurn(): void {
      turnInFlight = true;
      turnPromptActive = false;
      turnActivitySeen = false;
      idleSignalSeen = false;
      params.session.sendAgentMessage(provider, { type: 'task_started', id: randomUUID() });
      setThinking(true);
    },

    async startOrLoad(opts: { resumeId?: string | null } = {}): Promise<string> {
      didSendChangeTitleInstructionForSession = false;
      ensuredMcpServersForDirectory = false;
      await attachSubscriptionIfNeeded();
      const c = await ensureClient();

      await ensureMcpServersForCurrentDirectoryBestEffort();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (resumeId) {
        const existing = await c.sessionGet({ sessionId: resumeId });
        sessionId = existing.id ?? resumeId;
        omitCustomMessageIdOnFirstPromptAfterResume = true;
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
        publishDynamicSessionOptionsBestEffort();
        const snapshot = params.session.getMetadataSnapshot();
        const existingVendorSessionId = typeof (snapshot as any)?.opencodeSessionId === 'string'
          ? String((snapshot as any).opencodeSessionId).trim()
          : '';
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
      omitCustomMessageIdOnFirstPromptAfterResume = false;
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
      await this.sendPromptWithMeta?.({ text: prompt, localId: null });
    },

    async sendPromptWithMeta(paramsWithMeta: { text: string; localId?: string | null }): Promise<void> {
      if (!sessionId) throw new Error('OpenCode server session was not started');
      const c = await ensureClient();

      const effectiveText = (() => {
        const raw = typeof paramsWithMeta.text === 'string' ? paramsWithMeta.text : '';
        if (!raw.trim()) return raw;
        if (didSendChangeTitleInstructionForSession) return raw;
        const lower = raw.toLowerCase();
        const alreadyMentionsChangeTitle =
          lower.includes(preferredOpenCodeChangeTitleToolName.toLowerCase()) ||
          CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias));
        if (alreadyMentionsChangeTitle) {
          didSendChangeTitleInstructionForSession = true;
          return raw;
        }
        if (!shouldAppendChangeTitleInstruction(raw)) return raw;
        didSendChangeTitleInstructionForSession = true;
        return `${raw}\n\n${changeTitleInstruction}`;
      })();

      const shouldOmitCustomMessageId = omitCustomMessageIdOnFirstPromptAfterResume === true;
      const messageID = shouldOmitCustomMessageId
        ? undefined
        : (await resolveOrCreateUserMessageId(paramsWithMeta.localId ?? null)) ?? undefined;
      if (messageID) observedRemoteTextMessageIds.add(messageID);
      const agent = selectedAgent ?? undefined;
      const model = selectedModel ?? undefined;
      const config = Object.keys(configOverrides).length > 0 ? { ...configOverrides } : undefined;
      turnDeferred = createDeferred<void>();
      const thisTurnDeferred = turnDeferred;
      turnPromptActive = true;
      turnActivitySeen = false;
      idleSignalSeen = false;
      turnUserMessageId = messageID ?? null;
      turnPrePromptMessageIdsAll = null;
      turnPreexistingMessageIds = null;
      handledPermissionIds = new Set<string>();
      handledQuestionIds = new Set<string>();
      inFlightPermissionIds = new Set<string>();
      inFlightQuestionIds = new Set<string>();
      const controlAbort = new AbortController();
      turnControlAbort = controlAbort;
      let prePromptMessageIdsForBackfill: Set<string> | null = null;

      await waitForIdleBeforePromptBestEffort({ client: c, sessionId, signal: controlAbort.signal });
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
        if (shouldOmitCustomMessageId) {
          omitCustomMessageIdOnFirstPromptAfterResume = false;
        }
      } catch (error) {
        setThinking(false);
        await flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'prompt_async_error' });
        const detail = extractOpenCodeErrorText(error);
        if (detail) {
          params.session.sendAgentMessage(provider, { type: 'message', message: detail });
        }
        params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
        rejectTurn(error);
        throw error;
      }

      const pollControlPlaneOnce = async () => {
        if (controlAbort.signal.aborted) return;
        const perms = await listPendingPermissionRequests();
        const qs = await listPendingQuestionRequests();
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
            }, pollSleepMs);
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
      omitCustomMessageIdOnFirstPromptAfterResume = false;
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
