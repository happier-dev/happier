import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@/agent';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata, PermissionMode } from '@/api/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { configuration } from '@/configuration';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import {
  isChangeTitleToolNameAlias,
  normalizeOpenCodeAppSkills,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { isAbortLikeError } from '@/agent/executionRuns/runtime/turnDelivery';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import {
  ProviderPromptSubmissionRejectedBeforeEffectError,
  ProviderPromptSubmissionUnconfirmedError,
  type ProviderPromptWithMeta,
} from '@/agent/runtime/providerPromptSubmission';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import type { DrainPendingOptions, DrainPendingResult } from '@/agent/runtime/sessionInput/types';

import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from './types';
import {
  createOpenCodeServerRuntimeClient,
  type OpenCodeGlobalEventDelivery,
  type OpenCodeServerRuntimeClient,
} from './client';
import { extractOpenCodeTextHistoryItems, importOpenCodeTextHistoryCommitted } from './openCodeSessionMessageImport';
import { extractOpenCodeTaskChildSessionId, importOpenCodeTaskSidechainBestEffort } from './openCodeTaskSidechainImport';
import { createOpenCodeTranscriptStreamBridge } from './openCodeTranscriptStreamBridge';
import { asRecord, normalizeString, normalizeStringArray } from './openCodeParsing';
import { extractOpenCodeErrorText } from './openCodeErrorText';
import {
  createOpenCodeConnectedServiceRuntimeAuthAdapter,
  resolveOpenCodeRuntimeAuthSelection,
} from '../connectedServices/createOpenCodeConnectedServiceRuntimeAuthAdapter';
import { extractOpenCodeSessionMessageId, parseOpenCodeToolPart } from './openCodeMessageParsing';
import { canonicalizeOpenCodeConfiguredMcpToolName } from './openCodeMcpToolNames';
import {
  isKnownUnavailableOpenCodeModel,
  parseOpenCodeModelId,
  resolveOpenCodeDefaultProviderIdFromModelId,
} from './openCodeModelParsing';
import { parsePermissionRequest } from './openCodePermissionParsing';
import { readOpenCodeUsageTelemetryFromMessageInfo } from './openCodeUsageTelemetry';
import { mapOpenCodeCompactionEventToAgentMessage, type OpenCodeCompactionAgentMessage } from './openCodeCompactionEvents';
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
import { buildOpenCodeTodoWorkState, OPEN_CODE_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES } from './workState';
import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { raceWithTimeout } from './raceWithTimeout';
import {
  buildOpenCodeProviderToolCallKey,
  createOpenCodeForegroundToolTracker,
  isTerminalOpenCodeToolPartStatus,
} from './runtime/createOpenCodeForegroundToolTracker';
import {
  createOpenCodeManagedServerTurnInterruptionSupervisor,
  OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
  type OpenCodeManagedServerTurnInterruptionSupervisor,
} from './runtime/createOpenCodeManagedServerTurnInterruptionSupervisor';
import { resolveOpenCodeServerControlPollIntervals } from './runtime/controlPollIntervals';
import {
  verifyOpenCodeBrokerReadyForConnectedSession,
  type OpenCodeBrokerReadiness,
} from '@/backends/opencode/brokerPlugin';
import {
  classifyOpenCodeAssistantCompletion,
  classifyOpenCodeMessageForProjection,
  classifyOpenCodePartForProjection,
} from '../transcriptProjection';
import {
  readOpenCodeNestedRecord,
  readOpenCodeTimestampMs,
} from '../transcriptProjection/openCodeProjectionParsing';

function mergeSessionWorkStateIntoMetadata(
  metadata: Metadata,
  params: Omit<Parameters<typeof mergeSessionWorkStateMetadataV1>[0], 'metadata'>,
): Metadata {
  return mergeSessionWorkStateMetadataV1({ ...params, metadata }) as unknown as Metadata;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type RequiredMcpServerReadinessOutcome = Readonly<
  | { status: 'ready' }
  | { status: 'failed'; error: unknown }
  | { status: 'superseded' }
>;

type OpenCodeToolObservationProvenance = Readonly<
  | { source: 'provider-live-subscription' }
  | { source: 'control-plane-history' }
>;

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

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function openCodeRetryStatusLooksLikeRateLimit(message: string): boolean {
  return /\brate\s+limit\b/iu.test(message);
}

function openCodeRetryStatusLooksLikeUsageLimit(message: string): boolean {
  return /\b(usage\s+limit|quota|limit\s+reached|insufficient\s+credits|billing)\b/iu.test(message);
}

function buildOpenCodeRetryStatusError(status: Record<string, unknown>): Error {
  const message = normalizeString(status.message) || 'OpenCode session is waiting before retrying';
  const retryNextAt = normalizeNonNegativeInteger(status.next);
  const retryAfterMs = retryNextAt === null ? null : Math.max(0, retryNextAt - Date.now());
  const attempt = normalizeNonNegativeInteger(status.attempt);
  const error = new Error(message);
  error.name = openCodeRetryStatusLooksLikeRateLimit(message)
    ? 'GoUsageLimitError'
    : openCodeRetryStatusLooksLikeUsageLimit(message)
    ? 'FreeUsageLimitError'
    : 'OpenCodeRetryStatusError';
  return Object.assign(error, {
    code: 'opencode_session_retry',
    type: 'opencode_session_retry',
    ...(retryAfterMs === null ? {} : { headers: { 'retry-after-ms': String(retryAfterMs) } }),
    ...(attempt === null ? {} : { metadata: { attempt } }),
  });
}

const OPENCODE_IDLE_WITHOUT_TERMINAL_ASSISTANT_CODE = 'opencode_idle_without_terminal_assistant';
export const OPENCODE_PROMPT_NOT_DISPATCHED_CODE = 'opencode_prompt_not_dispatched';

/**
 * Provider-owned runtime-issue code surfaced when a CONNECTED OpenCode session's auth broker is not
 * materialized/reachable before its first prompt. The session is failed closed rather than falling
 * back to native/upstream OpenCode auth (the stored broker marker is itself non-functional without
 * the plugin). `SessionRuntimeIssueV1.code` is an open string, so no protocol registration is needed.
 */
export const OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE = 'opencode_connected_auth_not_materialized';

function openCodeErrorLooksLikeContextOverflow(error: unknown): boolean {
  const text = (extractOpenCodeErrorText(error) ?? '').trim().toLowerCase();
  if (!text) return false;
  return (
    /\bcontext\s+(length|window|limit|overflow)\b/u.test(text)
    || /\b(maximum|max)\s+(context|token|tokens)\b/u.test(text)
    || /\btoken\s+(limit|budget|window)\b/u.test(text)
    || /\btoo\s+many\s+tokens\b/u.test(text)
  );
}

function buildOpenCodePromptOptionPayload(configOverrides: Readonly<Record<string, unknown>>): Readonly<{
  variant?: string;
  config?: Record<string, unknown>;
}> {
  const variant = typeof configOverrides.variant === 'string' ? configOverrides.variant.trim() : '';
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configOverrides)) {
    if (key === 'variant') continue;
    config[key] = value;
  }
  return {
    ...(variant ? { variant } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export type OpenCodeServerRuntimeDeps = Readonly<{
  createClient?: typeof createOpenCodeServerRuntimeClient;
}>;

export type OpenCodeHappierMcpAdmission = Readonly<
  | { kind: 'required' }
  | { kind: 'not_available_for_execution_run' }
>;

export function createOpenCodeServerRuntime(params: {
  directory: string;
  env?: NodeJS.ProcessEnv;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  happierMcpAdmission: OpenCodeHappierMcpAdmission;
  permissionHandler: ProviderEnforcedPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
  pendingQueue?: Readonly<{
    drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
    shouldDrainPendingMessages?: () => boolean;
    maxPopPerWake?: number;
    drainAfterStartOrLoad?: boolean;
  }>;
}, deps: OpenCodeServerRuntimeDeps = {}) {
  const provider: ACPProvider = 'opencode';
  const createClient = deps.createClient ?? createOpenCodeServerRuntimeClient;
  const env = params.env ?? process.env;
  let connectedBrokerPreflight: Promise<OpenCodeBrokerReadiness> | null = null;
  const runtimeAuthAdapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();
  const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'opencode-server' });
  let activeLifecycleMarkerId: string | null = null;
  const ensureActiveLifecycleMarkerId = (): string => {
    activeLifecycleMarkerId ??= randomUUID();
    return activeLifecycleMarkerId;
  };
  const surfaceOpenCodeRuntimeFailure = (
    cause: 'status_error' | 'session_error' | 'stream_error' | 'permission_blocked',
    error: unknown,
    providerTurnId: string | null = activeLifecycleMarkerId,
  ): void => {
    const runtimeAuthClassification = runtimeAuthAdapter.classifyRuntimeAuthFailure({
      target: { agentId: provider, targetId: params.session.sessionId },
      error,
      selection: resolveOpenCodeRuntimeAuthSelection({
        selections: readConnectedServiceChildSelectionsFromEnv(env),
        error,
      }),
    });
    const errorWithClassification = runtimeAuthClassification
      ? error instanceof Error
        ? Object.assign(error, { runtimeAuthClassification })
        : { ...(asRecord(error) ?? {}), runtimeAuthClassification }
      : error;
    if (runtimeAuthClassification) {
      void reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: params.session.sessionId,
        switchesThisTurn: 0,
        classification: runtimeAuthClassification,
        logPrefix: '[opencode]',
      }).then((recoveryReport) => {
        projectConnectedServiceRuntimeAuthRecoveryReport({
          report: recoveryReport,
          classification: runtimeAuthClassification,
          sendGenericStatusMessage: (message) => {
            params.session.sendSessionEvent({ type: 'message', message });
            return true;
          },
          commitTypedProjection: (projection) => {
            if (!projection.transcriptEvent) return false;
            params.session.sendSessionEvent(projection.transcriptEvent);
            return true;
          },
        });
      });
    }
    void surfacePrimarySessionRuntimeIssue({
      cause,
      provider,
      providerTurnId,
      error: errorWithClassification,
      session: params.session,
    }).catch((surfaceError) => {
      logger.debug('[opencode] Failed to persist primary session runtime issue (non-fatal)', surfaceError);
    });
  };

  let client: OpenCodeServerRuntimeClient | null = null;
  let sessionId: string | null = null;
  let subscriptionAbort: AbortController | null = null;
  let serverConnectedDeferred = createDeferred<void>();
  let serverConnectedGenerationKey: string | null = null;
  let currentContextWindowTokens: number | null = null;
  const observedCompactionLifecycleIds = new Set<string>();
  let manualCompactionSequence = 0;
  let activeManualCompaction: { lifecycleId: string; terminalObserved: boolean } | null = null;

  const isTerminalCompactionPhase = (phase: OpenCodeCompactionAgentMessage['phase']): boolean => (
    phase === 'completed' || phase === 'failed' || phase === 'cancelled'
  );

  const sendContextCompactionEvent = (event: OpenCodeCompactionAgentMessage): void => {
    const lifecycleId = normalizeString(event.lifecycleId);
    if (event.phase === 'progress' && lifecycleId && observedCompactionLifecycleIds.has(lifecycleId)) {
      return;
    }
    if ((event.phase === 'started' || event.phase === 'progress') && lifecycleId) {
      observedCompactionLifecycleIds.add(lifecycleId);
    }
    params.session.sendAgentMessage(provider, event);
    if (isTerminalCompactionPhase(event.phase) && lifecycleId) {
      observedCompactionLifecycleIds.delete(lifecycleId);
    }
  };

  let selectedAgent: string | null = null;
  let selectedModel: OpenCodeModelRef | null = null;
  let selectedModelWasQualifiedOverride = false;
  const configOverrides: Record<string, unknown> = {};
  let omitCustomMessageIdForResumedSession = false;
  let ensuredMcpServersForDirectory = false;
  let mcpServerRegistrationInFlight: Promise<void> | null = null;
  let mcpServerRegistrationRerunRequested = false;
  const ensuredMcpServerNames = new Set<string>();
  const requiredMcpServerName = params.happierMcpAdmission.kind === 'required'
    ? 'happier'
    : null;
  let requiredMcpServerReadiness = {
    deferred: createDeferred<RequiredMcpServerReadinessOutcome>(),
  };
  if (
    requiredMcpServerName
    && !Object.prototype.hasOwnProperty.call(params.mcpServers, requiredMcpServerName)
  ) {
    requiredMcpServerReadiness.deferred.resolve({
      status: 'failed',
      error: new Error('required Happier MCP server configuration is missing'),
    });
  }

  let turnDeferred: Deferred<void> | null = null;
  let turnInFlight = false;
  let turnPromptActive = false;
  let turnActivitySeen = false;
  let turnLastActivityAtMs = 0;
  let watchdogFired = false;
  let turnUserMessageId: string | null = null;
  let turnPromptLocalId: string | null = null;
  let turnPromptTextForBackfill = '';
  let turnPromptEffectiveTextForBackfill = '';
  let turnPrePromptMessageIdsAll: ReadonlySet<string> | null = null;
  let turnPreexistingMessageIds: ReadonlySet<string> | null = null;
  const turnUserMessageIds = new Set<string>();
  const turnAssistantMessageIds = new Set<string>();
  const turnStreamedAssistantMessageIds = new Set<string>();
  const turnLiveKnownAssistantMessageIds = new Set<string>();
  const turnLiveKnownToolCallKeys = new Set<string>();
  let turnAssistantTranscriptActivitySeen = false;
  let turnTerminalAssistantEvidenceSeen = false;
  let turnRequiresPostToolAssistantCompletion = false;
  let idleWithoutTerminalAssistantTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSignalSeen = false;
  let idleSignalSeenViaControlPlane = false;
  let statusPollBusySeen = false;
  let resolveOnIdleInFlight = false;
  let turnControlAbort: AbortController | null = null;
  const foregroundToolTracker = createOpenCodeForegroundToolTracker();
  // Generation-aware crash recovery (Lane E). Assigned after its dependency helpers are defined; all
  // references are null-safe so the synchronous module body can wire it before any method runs.
  let managedServerTurnSupervisor: OpenCodeManagedServerTurnInterruptionSupervisor | null = null;
  const currentManagedServerGenerationKey = (): string | null =>
    managedServerTurnSupervisor?.getCurrentGenerationKey() ?? null;
  // Liveness must only count work backed by the CURRENT managed-server generation. Work observed
  // under a replaced generation is orphaned and must not keep a turn alive (closes the F4 wedge).
  const hasLiveProviderWorkForCurrentGeneration = (): boolean => {
    const generationKey = currentManagedServerGenerationKey();
    if (!generationKey) return foregroundToolTracker.hasActiveProviderWork();
    return foregroundToolTracker.hasActiveProviderWorkNotOrphanedByGeneration(generationKey);
  };
  // True if any live-known tool call of the active turn is still active after a bounded reconcile —
  // i.e. it stayed non-terminal/missing in the replacement server's durable history.
  const hasUnreconciledActiveLiveKnownToolWork = (): boolean => {
    const workState = foregroundToolTracker.getProviderWorkState();
    if (!workState.active) return false;
    for (const tool of workState.activeToolCalls) {
      if (turnLiveKnownToolCallKeys.has(tool.key)) return true;
    }
    return false;
  };
  let turnAwaitingUserResponseCount = 0;
  let compactionInProgress = false;
  let retryBackoffUntilMs: number | null = null;
  let firstGenericRetryAtMs: number | null = null;
  let genericRetryNoticeSentForTurn = false;
  let handledPermissionIds: Set<string> | null = null;
  let handledQuestionIds: Set<string> | null = null;
  let inFlightPermissionIds: Set<string> | null = null;
  let inFlightQuestionIds: Set<string> | null = null;
  let pendingFailClosedQuestionRejectionKeys: Set<string> | null = null;
  let userMessageIdLastTimestampMs = 0;
  let userMessageIdCounter = 0;
  const observedRemoteTextMessageIds = new Set<string>();
  let suppressSessionErrorAbortNotificationForSessionId: string | null = null;
  let abortSuppressionGeneration = 0;
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
  const suppressedLivePartKeys = new Set<string>();
  const suppressedLiveMessageKeys = new Set<string>();
  const toolCallSentByCallId = new Set<string>();
  const toolResultSentByCallId = new Set<string>();
  const observedToolPartByCallKey = new Map<string, NonNullable<ReturnType<typeof parseOpenCodeToolPart>>>();

  const buildOpenCodeToolCallKey = buildOpenCodeProviderToolCallKey;
  const buildLivePartKey = (remoteSessionId: string, partId: string): string => `${remoteSessionId}:${partId}`;
  const buildLiveMessageKey = (remoteSessionId: string, messageId: string): string => `${remoteSessionId}:${messageId}`;
  let discardSuppressedLiveMessageStream: ((remoteSessionId: string, messageId: string) => void) | null = null;

  const suppressLiveMessageProjection = (remoteSessionId: string, messageId: string): void => {
    if (!remoteSessionId || !messageId) return;
    suppressedLiveMessageKeys.add(buildLiveMessageKey(remoteSessionId, messageId));
    pendingInlinePartSnapshotsByMessagePartKey.delete(`${remoteSessionId}:${messageId}:reasoning`);
    pendingInlinePartSnapshotsByMessagePartKey.delete(`${remoteSessionId}:${messageId}:text`);
    discardSuppressedLiveMessageStream?.(remoteSessionId, messageId);
  };

  const suppressLivePartProjection = (remoteSessionId: string, partId: string, messageId: string): void => {
    if (remoteSessionId && partId) suppressedLivePartKeys.add(buildLivePartKey(remoteSessionId, partId));
    suppressLiveMessageProjection(remoteSessionId, messageId);
  };

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

  const observeAssistantCompletionInfoForActiveTurn = (info: Record<string, unknown>): boolean => {
    if (!turnPromptActive) return false;
    const projection = classifyOpenCodeMessageForProjection(info);
    const completion = classifyOpenCodeAssistantCompletion(info);
    const messageID = completion.messageId || projection.messageId || normalizeString(info.id);
    if (!messageID) return false;

    if (completion.kind === 'ignored_internal') {
      suppressLiveMessageProjection(sessionId ?? '', messageID);
      return false;
    }
    if (projection.kind !== 'assistant_transcript') return false;

    noteAssistantMessageIdForActiveTurn(messageID);
    turnLiveKnownAssistantMessageIds.add(messageID);
    turnAssistantTranscriptActivitySeen = true;
    markTurnActivity();

    if (completion.kind === 'continuation') {
      turnRequiresPostToolAssistantCompletion = true;
      turnTerminalAssistantEvidenceSeen = false;
      return false;
    }

    if (completion.kind === 'terminal_success') {
      compactionInProgress = false;
      turnTerminalAssistantEvidenceSeen = true;
      turnRequiresPostToolAssistantCompletion = false;
      clearIdleWithoutTerminalAssistantTimer();
      return true;
    }

    return false;
  };

  const refreshLiveKnownOpenCodeStateFromControlPlaneBestEffort = async (): Promise<void> => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!sessionId) return;
    if (turnLiveKnownAssistantMessageIds.size === 0 && turnLiveKnownToolCallKeys.size === 0) return;

    const c = await ensureClient();
    const sessionIds = new Set<string>();
    sessionIds.add(sessionId);
    for (const callKey of turnLiveKnownToolCallKeys) {
      const separatorIndex = callKey.indexOf(':');
      const remoteSessionId = separatorIndex > 0 ? callKey.slice(0, separatorIndex) : '';
      if (remoteSessionId) sessionIds.add(remoteSessionId);
    }

    let clearedCount = 0;
    for (const remoteSessionId of sessionIds) {
      let rawMessages: unknown;
      try {
        rawMessages = await c.sessionMessagesList({ sessionId: remoteSessionId });
      } catch (error) {
        logger.debug('[OpenCodeServer] failed to refresh live-known OpenCode state from session history (non-fatal)', {
          sessionId: remoteSessionId,
          error,
        });
        continue;
      }
      if (!Array.isArray(rawMessages)) continue;

      for (const rawMessage of rawMessages) {
        const message = asRecord(rawMessage);
        if (!message) continue;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        for (const rawPart of parts) {
          const parsed = parseOpenCodeToolPart(rawPart);
          if (!parsed) continue;
          if (parsed.sessionID !== remoteSessionId) continue;
          const callKey = buildOpenCodeToolCallKey(parsed.sessionID, parsed.callID);
          if (!turnLiveKnownToolCallKeys.has(callKey)) continue;
          observedToolPartByCallKey.set(callKey, parsed);
          const status = normalizeString(parsed.state.status);
          if (!isTerminalOpenCodeToolPartStatus(status)) continue;
          await sendToolFromPart(parsed, null, turnChangeCollectorEpoch, { source: 'control-plane-history' });
          clearedCount += 1;
        }
      }
    }

    if (clearedCount > 0) {
      logger.debug('[OpenCodeServer] refreshed terminal live-known OpenCode tool calls from session history', {
        clearedCount,
      });
    }
  };

  const refreshCurrentTurnForegroundToolStateFromHistoryBestEffort = async (): Promise<void> => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!sessionId) return;

    let rawMessages: unknown;
    try {
      const c = await ensureClient();
      rawMessages = await c.sessionMessagesList({ sessionId });
    } catch (error) {
      logger.debug('[OpenCodeServer] failed to refresh current-turn foreground tool state from session history (non-fatal)', {
        sessionId,
        error,
      });
      return;
    }
    if (!Array.isArray(rawMessages)) return;

    for (const rawMessage of rawMessages) {
      const message = asRecord(rawMessage);
      if (!message) continue;
      const info = asRecord(message.info);
      const messageId = normalizeString(info?.id);
      if (messageId && turnPrePromptMessageIdsAll?.has(messageId)) continue;
      const messageMatchesLiveTurn = messageId ? turnLiveKnownAssistantMessageIds.has(messageId) : false;
      const parts = Array.isArray(message.parts) ? message.parts : [];
      for (const rawPart of parts) {
        const parsed = parseOpenCodeToolPart(rawPart);
        if (!parsed) continue;
        if (parsed.sessionID !== sessionId) continue;
        const callKey = buildOpenCodeToolCallKey(parsed.sessionID, parsed.callID);
        if (!messageMatchesLiveTurn && !turnLiveKnownToolCallKeys.has(callKey)) continue;
        observedToolPartByCallKey.set(callKey, parsed);
        foregroundToolTracker.observeToolPart({
          part: parsed,
          source: 'history',
          partId: normalizeString(asRecord(rawPart)?.id),
        });
      }
    }
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
    connectedBrokerPreflight = null;
    resetServerConnectedReadiness();
    client = await createClient({
      directory: params.directory,
      env,
      messageBuffer: params.messageBuffer,
      onManagedServerIdentityChanged: (change) => {
        connectedBrokerPreflight = null;
        resetServerConnectedReadiness();
        managedServerTurnSupervisor?.handleManagedServerIdentityChange(change);
      },
    });
    return client;
  };

  const readCurrentServerConnectedGenerationKey = (): string =>
    client?.getManagedServerIdentity()?.generationKey ?? 'untracked';

  const resetServerConnectedReadiness = (): void => {
    serverConnectedGenerationKey = null;
    serverConnectedDeferred.resolve();
    serverConnectedDeferred = createDeferred<void>();
  };

  const markServerConnected = (): void => {
    serverConnectedGenerationKey = readCurrentServerConnectedGenerationKey();
    serverConnectedDeferred.resolve();
  };

  const isActivePromptTurn = (turn: Deferred<void>, targetSessionId: string): boolean =>
    turnDeferred === turn && turnPromptActive && sessionId === targetSessionId;

  const waitForServerConnectedBeforePrompt = async (
    turn: Deferred<void>,
    targetSessionId: string,
  ): Promise<boolean> => {
    for (;;) {
      if (!isActivePromptTurn(turn, targetSessionId)) return false;
      const expectedGenerationKey = readCurrentServerConnectedGenerationKey();
      if (serverConnectedGenerationKey === expectedGenerationKey) return true;

      const pendingReadiness = serverConnectedDeferred.promise;
      const outcome = await Promise.race([
        pendingReadiness.then(() => ({ type: 'server_connected' as const })),
        turn.promise.then(
          () => ({ type: 'turn_resolved' as const }),
          (error: unknown) => ({ type: 'turn_rejected' as const, error }),
        ),
      ]);
      if (outcome.type === 'turn_rejected') throw outcome.error;
      if (outcome.type === 'turn_resolved') return false;
    }
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
          if (isKnownUnavailableOpenCodeModel({ providerID: providerId, modelID: modelId })) continue;
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
      const availableModelIds = new Set(availableModels.map((model) => model.id));
      const selectedModelId = selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : '';
      const currentModelId =
        (selectedModelId && availableModelIds.has(selectedModelId) ? selectedModelId : '')
        || (defaultModelId && availableModelIds.has(defaultModelId) ? defaultModelId : '')
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

  const publishNativeTodosWorkStateBestEffort = () => {
    void (async () => {
      if (!sessionId) return;
      const c = await ensureClient();
      const todos = await c.sessionTodo({ sessionId });
      const updatedAt = Date.now();
      const snapshot = buildOpenCodeTodoWorkState({
        backendId: provider,
        agentId: provider,
        updatedAt,
        todos,
      });
      await params.session.updateMetadata((prev) => mergeSessionWorkStateIntoMetadata(prev, {
        nextOwned: snapshot,
        ownedSourceFamilies: OPEN_CODE_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES,
      }));
    })().catch((error) => {
      logger.debug('[OpenCodeServer] Failed publishing native todo work-state metadata (non-fatal)', error);
    });
  };

  const resolveCompactionModel = async (clientForResolve: OpenCodeServerRuntimeClient): Promise<OpenCodeModelRef> => {
    if (selectedModel) return selectedModel;

    const config = await clientForResolve.globalConfigGet().catch(() => ({}));
    const configModelId = normalizeString((config as Record<string, unknown>).model);
    const parsedConfigModel = configModelId ? parseOpenCodeModelId(configModelId) : null;
    if (parsedConfigModel) return parsedConfigModel;

    const providers = await clientForResolve.providersList().catch(() => []);
    for (const providerInfo of providers) {
      const providerId = normalizeString(providerInfo.id);
      if (!providerId) continue;
      const models = asRecord(providerInfo.models);
      if (!models) continue;
      for (const [modelKey, modelValue] of Object.entries(models)) {
        const model = asRecord(modelValue);
        const modelID = normalizeString(model?.id) || modelKey;
        if (isKnownUnavailableOpenCodeModel({ providerID: providerId, modelID })) continue;
        const status = normalizeString(model?.status);
        if (status && status !== 'active') continue;
        const capabilities = asRecord(model?.capabilities);
        const input = capabilities ? asRecord(capabilities.input) : null;
        if (input && input.text === false) continue;
        return {
          providerID: providerId,
          modelID: normalizeString(model?.id) || modelKey,
        };
      }
    }

    throw new Error('OpenCode server compactContext requires an active model');
  };

  const modelIsSelectable = (model: Readonly<{
    providerID: string;
    modelID: string;
    modelRecord?: unknown;
  }>): boolean => {
    const providerID = normalizeString(model.providerID);
    const modelID = normalizeString(model.modelID);
    if (!providerID || !modelID) return false;
    if (isKnownUnavailableOpenCodeModel({ providerID, modelID })) return false;

    const record = asRecord(model.modelRecord);
    if (!record) return true;
    const status = normalizeString(record.status);
    if (status && status !== 'active') return false;
    const capabilities = asRecord(record.capabilities);
    const input = capabilities ? asRecord(capabilities.input) : null;
    if (input && input.text === false) return false;
    return true;
  };

  const findModelForProvider = (
    providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> }>,
    providerID: string,
    modelID: string,
  ): OpenCodeModelRef | null => {
    const normalizedProviderId = normalizeString(providerID);
    const normalizedModelId = normalizeString(modelID);
    if (!normalizedProviderId || !normalizedModelId) return null;

    const providerInfo = providers.find((providerRecord) => normalizeString(providerRecord.id) === normalizedProviderId);
    const models = asRecord(providerInfo?.models);
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

  const validateQualifiedModelAgainstProviderInventory = async (
    model: OpenCodeModelRef,
  ): Promise<OpenCodeModelRef> => {
    const c = await ensureClient();
    let providers: Awaited<ReturnType<OpenCodeServerRuntimeClient['providersList']>>;
    try {
      providers = await c.providersList();
    } catch {
      // Preserve OpenCode custom-model behavior when the provider inventory is unavailable. A
      // successful inventory response is authoritative; a transport/runtime failure is not.
      return model;
    }

    const providerInfo = providers.find(
      (providerRecord) => normalizeString(providerRecord.id) === model.providerID,
    );
    if (asRecord(providerInfo?.models)) {
      const inventoryMatch = findModelForProvider(
        providers,
        model.providerID,
        model.modelID,
      );
      if (inventoryMatch) return inventoryMatch;
    }

    const modelId = `${model.providerID}/${model.modelID}`;
    throw new ProviderPromptSubmissionRejectedBeforeEffectError(
      'provider_rejected_before_acceptance',
      new Error(`OpenCode model is not available from the current provider inventory: ${modelId}`),
    );
  };

  const resolveModelOverride = async (
    rawModelId: string,
    options: Readonly<{ validateQualifiedModel?: boolean }> = {},
  ): Promise<OpenCodeModelRef | null> => {
    const trimmed = rawModelId.trim();
    if (!trimmed) return null;

    const parsed = parseOpenCodeModelId(trimmed);
    if (parsed) {
      if (!modelIsSelectable(parsed)) return null;
      return options.validateQualifiedModel === true
        ? await validateQualifiedModelAgainstProviderInventory(parsed)
        : parsed;
    }

    const c = await ensureClient();
    const [config, providers] = await Promise.all([
      c.globalConfigGet().catch(() => ({})),
      c.providersList().catch(() => []),
    ]);
    const defaultProviderId = resolveOpenCodeDefaultProviderIdFromModelId(
      normalizeString((config as Record<string, unknown>).model),
    );
    const defaultProviderMatch = defaultProviderId
      ? findModelForProvider(providers, defaultProviderId, trimmed)
      : null;
    if (defaultProviderMatch) return defaultProviderMatch;

    const matches = providers
      .map((providerInfo) => findModelForProvider(providers, providerInfo.id, trimmed))
      .filter((candidate): candidate is OpenCodeModelRef => candidate !== null);
    if (matches.length === 1) return matches[0];

    if (defaultProviderId) {
      return modelIsSelectable({ providerID: defaultProviderId, modelID: trimmed })
        ? { providerID: defaultProviderId, modelID: trimmed }
        : null;
    }

    throw new Error(`Invalid OpenCode model id: ${rawModelId}`);
  };

  const resolvePromptModelOverride = async (meta: unknown): Promise<OpenCodeModelRef | undefined> => {
    const rawModelId = normalizeString(asRecord(meta)?.model).trim();
    if (rawModelId) {
      return (await resolveModelOverride(rawModelId, { validateQualifiedModel: true })) ?? undefined;
    }
    if (!selectedModel) return undefined;
    return selectedModelWasQualifiedOverride
      ? await validateQualifiedModelAgainstProviderInventory(selectedModel)
      : selectedModel;
  };

  const isPrePromptMessageId = (messageId: string): boolean => {
    if (!messageId) return false;
    return turnPrePromptMessageIdsAll?.has(messageId)
      ?? turnPreexistingMessageIds?.has(messageId)
      ?? false;
  };

  const isCurrentTurnObservationMessageId = (messageId: string): boolean => {
    if (!turnPromptActive || !messageId) return false;
    if (turnUserMessageId === messageId || turnUserMessageIds.has(messageId)) return false;
    if (isPrePromptMessageId(messageId)) return false;
    return turnLiveKnownAssistantMessageIds.has(messageId) || turnAssistantMessageIds.has(messageId);
  };

  const isExactCurrentTurnAssistantObservation = (info: Record<string, unknown>): boolean => {
    if (!turnPromptActive || !sessionId || !turnUserMessageId) return false;
    if (normalizeString(info.sessionID) !== sessionId) return false;
    const projection = classifyOpenCodeMessageForProjection(info);
    const messageId = projection.messageId || normalizeString(info.id);
    if (projection.kind !== 'assistant_transcript' || !messageId || isPrePromptMessageId(messageId)) return false;
    return readNonBlankOpaqueIdentifier(info.parentID) === turnUserMessageId;
  };

  let scheduleAuthoritativeRequestInventoryRefresh: () => void = () => {};

  const handleUntrustedObservation = (evt: OpenCodeGlobalEvent): Promise<void> | void => {
    const type = normalizeString(evt.payload.type);
    const props = asRecord(evt.payload.properties);

    if (type === 'message.updated') {
      const info = asRecord(props?.info);
      if (!info) return;
      const observedSessionId = normalizeString(info.sessionID);
      if (!turnPromptActive) {
        if (sessionId && observedSessionId === sessionId) {
          // The event is only a content-free invalidation. The inventory reader remains the
          // authority for externally authored transcript rows.
          scheduleExternalSessionTranscriptProjection();
        }
        return;
      }
      if (!isExactCurrentTurnAssistantObservation(info)) return;
      return handleEvent(evt);
    }

    if (
      type === 'message.part.updated'
      || type === 'message.part.created'
      || type === 'message.part.delta'
    ) {
      if (!turnPromptActive) return;
      const part = type === 'message.part.delta' ? props : asRecord(props?.part);
      if (!part) return;
      const observedSessionId = normalizeString(part.sessionID);
      const messageId = normalizeString(part.messageID);
      if (!observedSessionId || !messageId) return;
      if (observedSessionId === sessionId) {
        if (!isCurrentTurnObservationMessageId(messageId)) return;
        return handleEvent(evt);
      }
      // A child session is admitted only after the current parent turn's Task tool established the
      // exact sidechain mapping. Old or unrelated global-bus frames therefore remain inert.
      if (resolveSidechainIdForRemoteSession(observedSessionId)) {
        return handleEvent(evt);
      }
      return;
    }

    if (type === 'todo.updated') {
      const observedSessionId = normalizeString(props?.sessionID)
        || normalizeString(asRecord(props?.session)?.id);
      if (!observedSessionId || observedSessionId === sessionId) {
        // The SSE frame is a wake-up only; the inventory reader remains authoritative.
        publishNativeTodosWorkStateBestEffort();
      }
      return;
    }

    if (type === 'question.asked' || type === 'permission.asked') {
      const observedSessionId = normalizeString(props?.sessionID);
      if (
        observedSessionId
        && (observedSessionId === sessionId || sidechainIdByRemoteSessionId.has(observedSessionId))
      ) {
        // GlobalBus can replay the original event shape after reconnect. Treat it only as a wake:
        // the provider's current pending-request lists are the authority for content and liveness.
        scheduleAuthoritativeRequestInventoryRefresh();
      }
    }
  };

  const attachSubscriptionIfNeeded = async (): Promise<void> => {
    if (subscriptionAbort) return;
    const c = await ensureClient();
    const controller = new AbortController();
    subscriptionAbort = controller;

    void c.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (evt, delivery: OpenCodeGlobalEventDelivery) => {
        const eventType = normalizeString(evt.payload.type);
        if (delivery.provenance === 'connection-boundary' && eventType !== 'server.connected') {
          return;
        }
        const eventSequence = nextProviderEventSequence + 1;
        nextProviderEventSequence = eventSequence;
        const processEvent = (): Promise<void> | void => {
          try {
            return delivery.provenance === 'untrusted-observation'
              ? handleUntrustedObservation(evt)
              : handleEvent(evt);
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
          const tracked = Promise.resolve(work)
            .catch((error) => {
              logger.debug('[OpenCodeServer] Failed handling async event (non-fatal)', error);
            })
            .finally(() => {
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
  let activeKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let activeKeepAliveOpen = false;

  const stopActiveKeepAliveTimer = (): void => {
    if (!activeKeepAliveTimer) return;
    clearInterval(activeKeepAliveTimer);
    activeKeepAliveTimer = null;
  };

  const startActiveKeepAliveTimer = (): void => {
    if (activeKeepAliveTimer) return;
    activeKeepAliveTimer = setInterval(() => {
      params.session.keepAlive(true, 'remote');
    }, activeKeepAliveIntervalMs);
    activeKeepAliveTimer.unref?.();
  };

  const markOpenCodeSessionActive = (): void => {
    startActiveKeepAliveTimer();
    if (activeKeepAliveOpen) return;
    activeKeepAliveOpen = true;
    params.session.keepAlive(true, 'remote');
  };

  const markOpenCodeSessionInactive = (): void => {
    stopActiveKeepAliveTimer();
    if (!activeKeepAliveOpen) return;
    activeKeepAliveOpen = false;
    params.session.keepAlive(false, 'remote');
  };

  const setThinking = (value: boolean) => {
    if (value === currentThinking) {
      if (value) {
        startActiveKeepAliveTimer();
      } else {
        markOpenCodeSessionInactive();
      }
      return;
    }
    currentThinking = value;
    if (value) {
      markOpenCodeSessionActive();
    } else {
      markOpenCodeSessionInactive();
    }
    params.onThinkingChange(value);
  };

  const openCodePrimarySessionHasActiveProviderWork = (): boolean =>
    foregroundToolTracker.hasActiveProviderWork() || compactionInProgress;

  const settleThinkingOnOpenCodeIdleSignal = (): void => {
    if (
      openCodePrimarySessionHasActiveProviderWork()
      || (Boolean(turnDeferred) && (!turnTerminalAssistantEvidenceSeen || turnRequiresPostToolAssistantCompletion))
    ) {
      markOpenCodeSessionActive();
      return;
    }
    setThinking(false);
  };

  const settleThinkingAfterProviderWorkUpdate = (): void => {
    if (openCodePrimarySessionHasActiveProviderWork()) {
      markOpenCodeSessionActive();
      return;
    }
    if (turnPromptActive) {
      if (idleSignalSeen && turnTerminalAssistantEvidenceSeen && !turnRequiresPostToolAssistantCompletion) {
        setThinking(false);
      }
      return;
    }
    setThinking(false);
  };

  const clearIdleWithoutTerminalAssistantTimer = (): void => {
    if (!idleWithoutTerminalAssistantTimer) return;
    clearTimeout(idleWithoutTerminalAssistantTimer);
    idleWithoutTerminalAssistantTimer = null;
  };

  const resetTurnEventState = () => {
    clearIdleWithoutTerminalAssistantTimer();
    pendingTurnToolForwardingWork = new Set<Promise<void>>();
    clearStreamWriters();
    turnStreamKey = null;
    turnPromptActive = false;
    turnActivitySeen = false;
    turnLastActivityAtMs = 0;
    watchdogFired = false;
    turnUserMessageId = null;
    turnPromptLocalId = null;
    turnPromptTextForBackfill = '';
    turnPromptEffectiveTextForBackfill = '';
    turnPrePromptMessageIdsAll = null;
    turnPreexistingMessageIds = null;
    turnUserMessageIds.clear();
    turnAssistantMessageIds.clear();
    turnStreamedAssistantMessageIds.clear();
    turnLiveKnownAssistantMessageIds.clear();
    turnLiveKnownToolCallKeys.clear();
    turnAssistantTranscriptActivitySeen = false;
    turnTerminalAssistantEvidenceSeen = false;
    turnRequiresPostToolAssistantCompletion = false;
    idleSignalSeen = false;
    idleSignalSeenViaControlPlane = false;
    statusPollBusySeen = false;
    resolveOnIdleInFlight = false;
    turnAwaitingUserResponseCount = 0;
    compactionInProgress = false;
    retryBackoffUntilMs = null;
    firstGenericRetryAtMs = null;
    genericRetryNoticeSentForTurn = false;
    sidechainIdByRemoteSessionId.clear();
    sidechainStreamSeenBySidechainId.clear();
    pendingTaskSidechainImportsBySidechainId.clear();
    pendingTaskChildSessionDiscoveryCallKeys.clear();
    accumulatedTextByPartKey.clear();
    pendingInlinePartSnapshotsByMessagePartKey.clear();
    partTypeByPartKey.clear();
    suppressedLivePartKeys.clear();
    suppressedLiveMessageKeys.clear();
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
    pendingFailClosedQuestionRejectionKeys = null;
    activeLifecycleMarkerId = null;
  };

  const armSessionAbortErrorSuppression = (targetSessionId: string): number => {
    abortSuppressionGeneration += 1;
    suppressSessionErrorAbortNotificationForSessionId = targetSessionId;
    return abortSuppressionGeneration;
  };

  const clearSessionAbortErrorSuppression = (targetSessionId: string, generation: number): void => {
    if (
      abortSuppressionGeneration === generation
      && suppressSessionErrorAbortNotificationForSessionId === targetSessionId
    ) {
      suppressSessionErrorAbortNotificationForSessionId = null;
    }
  };

  const abortOpenCodeSessionAfterFailedTurn = (targetSessionId: string): void => {
    const generation = armSessionAbortErrorSuppression(targetSessionId);
    const runAbort = (async () => {
      const c = await ensureClient();
      const abortPromise = c.sessionAbort({ sessionId: targetSessionId });
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
    })();
    void runAbort
      .catch((error) => {
        logger.debug('[OpenCodeServer] OpenCode session abort after failed turn failed (non-fatal)', {
          sessionId: targetSessionId,
          error,
        });
      })
      .finally(() => {
        clearSessionAbortErrorSuppression(targetSessionId, generation);
      });
  };

  const markTurnActivity = (): void => {
    clearIdleWithoutTerminalAssistantTimer();
    turnActivitySeen = true;
    turnLastActivityAtMs = Date.now();
    retryBackoffUntilMs = null;
    firstGenericRetryAtMs = null;
  };

  const sleepUntilAbort = async (signal: AbortSignal, delayMs: number): Promise<void> => {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        cleanup();
        clearTimeout(timer);
        resolve();
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };

  const fireTurnDeadlockGuard = (input?: {
    error?: Error;
    cause?: 'stream_error' | 'status_error';
    interruptedReason?: string;
    diagnostics?: string;
  }): void => {
    if (watchdogFired || !turnDeferred || !turnPromptActive) return;
    watchdogFired = true;
    const diagnostics = input?.diagnostics ? ` (${input.diagnostics})` : '';
    const error = input?.error ?? new Error(`OpenCode turn timed out after ${turnInactivityTimeoutMs}ms without provider progress${diagnostics}`);
    const cause = input?.cause ?? 'stream_error';
    const interruptedReason = input?.interruptedReason ?? 'turn_deadlock_guard';
    if (sessionId) abortOpenCodeSessionAfterFailedTurn(sessionId);
    try {
      turnControlAbort?.abort();
    } catch {
      // ignore
    }
    setThinking(false);
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason });
    surfaceOpenCodeRuntimeFailure(cause, error);
    rejectTurn(error);
  };

  type FinalTurnLivenessProbeResult = {
    active: boolean;
    diagnostics: string;
  };

  const refreshActivityFromFinalTurnLivenessProbe = (): void => {
    markTurnActivity();
    markOpenCodeSessionActive();
  };

  const buildFinalTurnLivenessProbeDiagnostics = (input: {
    status: string;
    statusError?: string;
    providerWork: boolean;
    userWaits: number;
    toolForwarding: number;
    taskDiscovery: number;
    taskImports: number;
    compaction: boolean;
  }): string => {
    const parts = [
      `final liveness probe: status=${input.status}`,
      `providerWork=${input.providerWork ? 'yes' : 'no'}`,
      `userWaits=${input.userWaits}`,
      `toolForwarding=${input.toolForwarding}`,
      `taskDiscovery=${input.taskDiscovery}`,
      `taskImports=${input.taskImports}`,
      `compaction=${input.compaction ? 'yes' : 'no'}`,
    ];
    if (input.statusError) parts.push(`statusError=${input.statusError}`);
    return parts.join(', ');
  };

  const probeFinalTurnLivenessBeforeDeadlockAbort = async (): Promise<FinalTurnLivenessProbeResult> => {
    // Generation-aware: orphaned work from a replaced managed server must not early-exit the probe.
    const providerWork = hasLiveProviderWorkForCurrentGeneration();
    const userWaits = turnAwaitingUserResponseCount;
    const toolForwarding = pendingTurnToolForwardingWork.size;
    const taskDiscovery = pendingTaskChildSessionDiscoveryCallKeys.size;
    const taskImports = pendingTaskSidechainImportsBySidechainId.size;
    const compaction = compactionInProgress || Boolean(activeManualCompaction);

    if (providerWork || userWaits > 0 || toolForwarding > 0 || taskDiscovery > 0 || taskImports > 0 || compaction) {
      refreshActivityFromFinalTurnLivenessProbe();
      return {
        active: true,
        diagnostics: buildFinalTurnLivenessProbeDiagnostics({
          status: 'not_checked_local_activity',
          providerWork,
          userWaits,
          toolForwarding,
          taskDiscovery,
          taskImports,
          compaction,
        }),
      };
    }

    let status = 'not_checked';
    let statusError: string | undefined;
    if (sessionId) {
      try {
        const c = await ensureClient();
        const statuses = await c.sessionStatusList();
        resetControlPlaneFailures('status');
        const map = statuses && typeof statuses === 'object' && !Array.isArray(statuses)
          ? (statuses as Record<string, unknown>)
          : null;
        const rec = map ? map[sessionId] : null;
        const statusType = normalizeString(asRecord(rec)?.type);
        status = statusType || (rec == null ? 'missing' : 'unknown');
        if (statusType === 'busy') {
          statusPollBusySeen = true;
          refreshActivityFromFinalTurnLivenessProbe();
          return {
            active: true,
            diagnostics: buildFinalTurnLivenessProbeDiagnostics({
              status,
              providerWork,
              userWaits,
              toolForwarding,
              taskDiscovery,
              taskImports,
              compaction,
            }),
          };
        }
        if (statusType === 'retry' && rec && typeof rec === 'object' && !Array.isArray(rec)) {
          failActiveTurnOnRetryStatus(rec as Record<string, unknown>);
          return {
            active: true,
            diagnostics: buildFinalTurnLivenessProbeDiagnostics({
              status,
              providerWork,
              userWaits,
              toolForwarding,
              taskDiscovery,
              taskImports,
              compaction,
            }),
          };
        }
      } catch (error) {
        maybeAbortTurnOnControlPlaneFailure('status', error);
        status = 'error';
        statusError = extractOpenCodeErrorText(error) ?? String(error);
      }
    }

    return {
      active: false,
      diagnostics: buildFinalTurnLivenessProbeDiagnostics({
        status,
        statusError,
        providerWork,
        userWaits,
        toolForwarding,
        taskDiscovery,
        taskImports,
        compaction,
      }),
    };
  };

  const runTurnDeadlockGuard = async (signal: AbortSignal): Promise<void> => {
    const checkEveryMs = Math.max(250, Math.min(1_000, Math.floor(turnInactivityTimeoutMs / 4)));
    while (!signal.aborted) {
      await sleepUntilAbort(signal, checkEveryMs);
      if (signal.aborted) return;
      if (!turnDeferred || !turnPromptActive || watchdogFired) continue;

      const nowMs = Date.now();
      // Generation-aware: only work backed by the current managed-server generation keeps the turn
      // alive. Orphaned work from a replaced server must not refresh the clock forever (F4 wedge).
      if (hasLiveProviderWorkForCurrentGeneration() || turnAwaitingUserResponseCount > 0 || compactionInProgress || activeManualCompaction) {
        turnLastActivityAtMs = nowMs;
        continue;
      }

      if (firstGenericRetryAtMs !== null) {
        if (nowMs - firstGenericRetryAtMs > retryMaxWaitMs) {
          fireTurnDeadlockGuard({
            error: new Error(`OpenCode retry did not recover within ${retryMaxWaitMs}ms`),
            cause: 'status_error',
            interruptedReason: 'retry_timeout',
          });
          continue;
        }
      }

      if (retryBackoffUntilMs !== null && nowMs < retryBackoffUntilMs) {
        turnLastActivityAtMs = nowMs;
        continue;
      }
      if (retryBackoffUntilMs !== null) {
        retryBackoffUntilMs = null;
      }

      if (nowMs - turnLastActivityAtMs >= turnInactivityTimeoutMs) {
        const finalLiveness = await probeFinalTurnLivenessBeforeDeadlockAbort();
        if (finalLiveness.active) continue;
        fireTurnDeadlockGuard({ diagnostics: finalLiveness.diagnostics });
      }
    }
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
    turnInFlight = false;
    resetTurnEventState();
    beginFreshTurnChangeCollection();
    d.resolve();
  };

  const rejectTurn = (error: unknown) => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    turnInFlight = false;
    // Turns can be rejected from background callbacks; attach a handler to avoid unhandledRejection warnings.
    void d.promise.catch(() => undefined);
    resetTurnEventState();
    beginFreshTurnChangeCollection();
    d.reject(error);
  };

  const failActiveTurnOnRetryStatus = (statusRec: Record<string, unknown>): void => {
    if (!turnDeferred || !turnPromptActive) return;
    const error = buildOpenCodeRetryStatusError(statusRec);
    if (error.name === 'OpenCodeRetryStatusError') {
      const nextRetryAtMs = normalizeNonNegativeInteger(statusRec.next);
      retryBackoffUntilMs = nextRetryAtMs;
      firstGenericRetryAtMs ??= Date.now();
      if (!genericRetryNoticeSentForTurn) {
        genericRetryNoticeSentForTurn = true;
        params.session.sendAgentMessage(provider, {
          type: 'message',
          message: 'OpenCode hit a transient provider error and is retrying.',
        });
      }
      return;
    }
    if (sessionId) abortOpenCodeSessionAfterFailedTurn(sessionId);
    setThinking(false);
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'session_error' });
    surfaceOpenCodeRuntimeFailure('status_error', error);
    rejectTurn(error);
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

  const { pollSleepMs, turnActivePollSleepMs } = resolveOpenCodeServerControlPollIntervals(env);

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

  const turnInactivityTimeoutMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 240_000;
    return Math.max(10_000, Math.min(1_800_000, configured));
  })();

  const retryMaxWaitMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_RETRY_MAX_WAIT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 600_000;
    return Math.max(60_000, Math.min(3_600_000, configured));
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

  const statusPollEnabled = (() => {
    const raw = normalizeEnvVar(env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED);
    if (!raw) return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
  })();

  const activeKeepAliveIntervalMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_ACTIVE_KEEPALIVE_INTERVAL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60_000;
    return Math.max(25, Math.min(300_000, configured));
  })();

  const idleWithoutTerminalAssistantTimeoutMs = (() => {
    const raw = Number.parseInt(String(env.HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
    return Math.max(25, Math.min(300_000, configured));
  })();

  type ControlPlaneFailureKind = 'status';
  type ControlPlaneFailureState = { count: number; firstFailureAtMs: number | null };

  const controlPlaneFailures: Record<ControlPlaneFailureKind, ControlPlaneFailureState> = {
    status: { count: 0, firstFailureAtMs: null },
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
    const terminalMarkerId = ensureActiveLifecycleMarkerId();
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'control_plane_failure' }).finally(() => {
      surfaceOpenCodeRuntimeFailure('stream_error', error, terminalMarkerId);
    });
    rejectTurn(error ?? new Error('OpenCode control-plane polling failed'));
  };

  const shouldTreatMessageIdAsTurnActivity = (messageID: string): boolean => {
    if (!turnPromptActive) return false;
    if (!messageID) return false;
    if (turnAssistantMessageIds.has(messageID)) return true;
    if (turnUserMessageIds.has(messageID)) return false;
    if (turnUserMessageId && messageID === turnUserMessageId) return false;
    if (isPrePromptMessageId(messageID)) return false;
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
    if (turnStreamedAssistantMessageIds.has(messageID)) return;
    if (isPrePromptMessageId(messageID) && messageID !== turnUserMessageId) return;
    turnAssistantMessageIds.add(messageID);
    turnLiveKnownAssistantMessageIds.add(messageID);
  };

  const abortTurnFailClosedDueToPermissionProtocolError = (error: unknown) => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;

    setThinking(false);
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'permission_protocol_error' }).finally(() => {
      surfaceOpenCodeRuntimeFailure('permission_blocked', error);
    });
    rejectTurn(error ?? new Error('OpenCode permission request could not be validated'));
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
      clearIdleWithoutTerminalAssistantTimer();
      markOpenCodeSessionActive();
      return;
    }
    if (statusType === 'retry' && rec && typeof rec === 'object' && !Array.isArray(rec)) {
      failActiveTurnOnRetryStatus(rec as Record<string, unknown>);
      return;
    }
    if (statusType !== 'idle' && !missingImpliesIdle) return;
    idleSignalSeen = true;
    idleSignalSeenViaControlPlane = true;
    settleThinkingOnOpenCodeIdleSignal();
  };

  const maybeResolveTurnOnIdleSignal = async () => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!idleSignalSeen) return;
    if (completedProviderEventSequence < nextProviderEventSequence) return;
    if (resolveOnIdleInFlight) return;
    resolveOnIdleInFlight = true;
    try {
      await refreshCurrentTurnForegroundToolStateFromHistoryBestEffort();
      if (foregroundToolTracker.hasActiveProviderWork()) {
        clearIdleWithoutTerminalAssistantTimer();
        return;
      }
      if (turnAwaitingUserResponseCount > 0) return;
      if ((inFlightPermissionIds?.size ?? 0) > 0 || (inFlightQuestionIds?.size ?? 0) > 0) return;
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
      await refreshCurrentTurnForegroundToolStateFromHistoryBestEffort();
      if (foregroundToolTracker.hasActiveProviderWork()) return;
      if (completedProviderEventSequence < nextProviderEventSequence) return;
      if (pendingTaskChildSessionDiscoveryCallKeys.size > 0) return;

      if (
        !turnTerminalAssistantEvidenceSeen
        || turnRequiresPostToolAssistantCompletion
        || turnStreamedAssistantMessageIds.size === 0
      ) {
        await reconcileCurrentTurnTerminalAssistantFromAuthoritativeInventoryBestEffort();
      }

      // Ensure Task sidechain imports are committed before the turn completes, otherwise
      // downstream scenarios can miss the imported sidechain transcript (e.g. provider tests
      // that assert Task subagent output is present synchronously after task_complete).
      const pendingSidechainImports = Array.from(pendingTaskSidechainImportsBySidechainId.values());
      if (pendingSidechainImports.length > 0) {
        const sidechainOutcome = await raceWithTimeout(
          Promise.allSettled(pendingSidechainImports).then(() => undefined),
          idlePendingToolForwardingTimeoutMs,
        );
        if (sidechainOutcome.type === 'timeout') {
          logger.debug('[OpenCodeServer] Pending Task sidechain imports timed out before idle turn completion (non-fatal)', {
            timeoutMs: idlePendingToolForwardingTimeoutMs,
            pendingCount: pendingSidechainImports.length,
            sessionId,
            turnUserMessageId,
          });
        } else if (sidechainOutcome.type === 'rejected') {
          logger.debug('[OpenCodeServer] Pending Task sidechain imports failed before idle turn completion (non-fatal)', {
            sessionId,
            turnUserMessageId,
            error: sidechainOutcome.error,
          });
        }
      }

      if (!turnTerminalAssistantEvidenceSeen || turnRequiresPostToolAssistantCompletion) {
        scheduleIdleWithoutTerminalAssistantFallback();
        return;
      }

      const flushOutcome = await raceWithTimeout(
        flushStreamWritersForSidechainBoundary(null),
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
      setThinking(false);
      params.session.sendAgentMessage(provider, { type: 'task_complete', id: ensureActiveLifecycleMarkerId() });
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
      const messageId = readNonBlankOpaqueIdentifier(item.messageId) ?? '';
      if (!messageId) continue;
      observedRemoteTextMessageIds.add(messageId);
    }
  };

  // Origin-agnostic transcript projection (Lane H / S2). Mirrors messages that THIS Happier session's
  // OpenCode session (and its known sidechains) produced regardless of which surface authored them —
  // crucially, messages typed directly in an attached OpenCode TUI while no Happier turn is active.
  //
  // Idempotency / mirror-only invariants:
  // - `observedRemoteTextMessageIds` is the in-memory dedupe gate; the live-turn projection path
  //   populates it for every turn-owned message, so this passive path only mirrors external turns.
  // - `importOpenCodeTextHistoryCommitted` commits with a deterministic `buildImportLocalId`, so a
  //   re-import after reconnect/resume cannot duplicate (server-side localId dedupe), and the
  //   imported user message is marked passive (never re-enqueued back to OpenCode).
  // - Only SETTLED messages are mirrored: user messages, and assistant messages with terminal
  //   completion evidence (so partial in-progress assistant text is never committed).
  let passiveTranscriptProjectionInFlight = false;
  let passiveTranscriptProjectionRerunRequested = false;

  const buildSettledExternalTranscriptItems = (rawMessages: unknown[]): ReturnType<typeof extractOpenCodeTextHistoryItems> => {
    const settledMessageIds = new Set<string>();
    for (const rawMessage of rawMessages) {
      const rec = asRecord(rawMessage);
      if (!rec) continue;
      const projection = classifyOpenCodeMessageForProjection(rec);
      if (!projection.messageId) continue;
      if (projection.kind === 'user_transcript') {
        settledMessageIds.add(projection.messageId);
        continue;
      }
      if (
        projection.kind === 'assistant_transcript'
        && classifyOpenCodeAssistantCompletion(rec).kind === 'terminal_success'
      ) {
        settledMessageIds.add(projection.messageId);
      }
    }
    return extractOpenCodeTextHistoryItems(rawMessages).filter(
      (item) => settledMessageIds.has(item.messageId) && !observedRemoteTextMessageIds.has(item.messageId),
    );
  };

  const projectExternalSessionMessagesBestEffort = async (): Promise<void> => {
    if (!sessionId) return;
    // While a Happier turn is active, the live projection path owns this session's messages; passive
    // mirroring is only for externally (e.g. TUI) authored turns when no Happier turn is in flight.
    if (turnPromptActive) return;
    if (passiveTranscriptProjectionInFlight) {
      passiveTranscriptProjectionRerunRequested = true;
      return;
    }
    passiveTranscriptProjectionInFlight = true;
    try {
      do {
        passiveTranscriptProjectionRerunRequested = false;
        if (!sessionId || turnPromptActive) return;
        const c = await ensureClient();
        // Ownership: only this session's OpenCode session id and its discovered sidechains.
        const ownedSessions: Array<Readonly<{ remoteSessionId: string; sidechainId: string | null }>> = [
          { remoteSessionId: sessionId, sidechainId: null },
          ...Array.from(sidechainIdByRemoteSessionId.entries()).map(([remoteSessionId, sidechainId]) => ({
            remoteSessionId,
            sidechainId,
          })),
        ];
        for (const owned of ownedSessions) {
          let raw: unknown;
          try {
            raw = await c.sessionMessagesList({ sessionId: owned.remoteSessionId });
          } catch (error) {
            logger.debug('[OpenCodeServer] passive transcript projection: list failed (non-fatal)', {
              sessionId: owned.remoteSessionId,
              error,
            });
            continue;
          }
          const items = buildSettledExternalTranscriptItems(Array.isArray(raw) ? raw : []);
          if (items.length === 0) continue;
          await importOpenCodeTextHistoryCommitted({
            session: params.session,
            provider,
            remoteSessionId: owned.remoteSessionId,
            items,
            importedFrom: owned.sidechainId ? 'acp-sidechain' : 'acp-history',
            ...(owned.sidechainId ? { sidechainId: owned.sidechainId } : {}),
          });
          markObservedTextHistoryItems(items);
        }
      } while (passiveTranscriptProjectionRerunRequested);
    } catch (error) {
      logger.debug('[OpenCodeServer] passive transcript projection failed (non-fatal)', error);
    } finally {
      passiveTranscriptProjectionInFlight = false;
    }
  };

  const scheduleExternalSessionTranscriptProjection = (): void => {
    void projectExternalSessionMessagesBestEffort();
  };

  const resolveOrCreateUserMessageId = async (localIdRaw: string | null | undefined): Promise<string | null> => {
    const localId = readNonBlankOpaqueIdentifier(localIdRaw) ?? '';
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
    const localId = readNonBlankOpaqueIdentifier(paramsForBackfill.localIdRaw) ?? '';
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

  const buildTranscriptStreamArgsForMessage = (remoteSessionId: string, messageID: string) => ({
    streamKey: getStreamKeyForMessage(remoteSessionId, messageID),
    remoteSessionId,
    messageId: messageID,
    sidechainId: resolveSidechainIdForRemoteSession(remoteSessionId),
  });

  discardSuppressedLiveMessageStream = (remoteSessionId, messageID) => {
    transcriptStreamBridge.discardStream(buildTranscriptStreamArgsForMessage(remoteSessionId, messageID));
  };

  const enableDurableCommitsForLiveMessageProjection = (remoteSessionId: string, messageID: string): void => {
    if (!remoteSessionId || !messageID) return;
    transcriptStreamBridge.enableDurableCommitsForStream(buildTranscriptStreamArgsForMessage(remoteSessionId, messageID));
  };

  const clearStreamWriters = () => {
    transcriptStreamBridge.clear();
  };

  const flushAndClearStreamWriters = async (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => {
    await transcriptStreamBridge.flushAll(opts);
  };

  const flushStreamWritersForSidechainBoundary = async (sidechainId: string | null): Promise<void> => {
    await transcriptStreamBridge.flushStreamsMatching({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === sidechainId,
    });
  };

  const rememberVendorAssignedUserMessageIdBestEffort = async (
    localId: string,
    messageId: string,
  ): Promise<void> => {
    try {
      await params.session.updateMetadata((prev) => {
        const base = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
        return upsertOpenCodeUserMessageIdInMetadata({ metadata: base, localId, messageId }) as Metadata;
      });
    } catch {
      // Best-effort: current-turn reconciliation still owns the in-memory exact identity.
    }
  };

  const reconcileCurrentTurnTerminalAssistantFromAuthoritativeInventoryBestEffort = async (): Promise<boolean> => {
    if (!turnDeferred || !turnPromptActive || !sessionId) return false;
    const prePromptMessageIds = turnPrePromptMessageIdsAll;
    if (!prePromptMessageIds) return false;

    let rawMessages: unknown;
    try {
      const c = await ensureClient();
      rawMessages = c.sessionMessagesListRaw
        ? await c.sessionMessagesListRaw({ sessionId })
        : await c.sessionMessagesList({ sessionId });
    } catch (error) {
      logger.debug('[OpenCodeServer] failed to reconcile current-turn terminal assistant from authoritative inventory (non-fatal)', {
        sessionId,
        error,
      });
      return false;
    }
    if (!Array.isArray(rawMessages)) return false;

    let currentUserMessageId = readNonBlankOpaqueIdentifier(turnUserMessageId);
    if (!currentUserMessageId) {
      const promptTexts = new Set(
        [turnPromptTextForBackfill, turnPromptEffectiveTextForBackfill]
          .map((text) => text.trim())
          .filter((text) => text.length > 0),
      );
      const matchingUserIds = new Set(
        extractOpenCodeTextHistoryItems(rawMessages)
          .filter((item) => (
            item.role === 'user'
            && !prePromptMessageIds.has(item.messageId)
            && promptTexts.has(item.text.trim())
          ))
          .map((item) => item.messageId),
      );
      if (matchingUserIds.size !== 1) return false;
      currentUserMessageId = matchingUserIds.values().next().value ?? null;
      if (!currentUserMessageId) return false;
      turnUserMessageId = currentUserMessageId;
      turnUserMessageIds.add(currentUserMessageId);
      observedRemoteTextMessageIds.add(currentUserMessageId);
      const localId = readNonBlankOpaqueIdentifier(turnPromptLocalId);
      if (localId) {
        await rememberVendorAssignedUserMessageIdBestEffort(localId, currentUserMessageId);
      }
    }

    const candidatesByMessageId = new Map<string, Readonly<{
      info: Record<string, unknown>;
      providerError: unknown | null;
      providerErrorFingerprint: string | null;
      text: string;
    }>>();
    for (const rawMessage of rawMessages) {
      const message = asRecord(rawMessage);
      if (!message) continue;
      const info = asRecord(message.info);
      if (!info) continue;
      if (normalizeString(info.sessionID) !== sessionId) continue;
      const projection = classifyOpenCodeMessageForProjection(info);
      const messageId = readNonBlankOpaqueIdentifier(projection.messageId);
      if (projection.kind !== 'assistant_transcript' || !messageId) continue;
      if (prePromptMessageIds.has(messageId)) continue;
      if (readNonBlankOpaqueIdentifier(info.parentID) !== currentUserMessageId) continue;
      const providerError = info.error ?? null;
      const providerErrorCompletedAtMs = providerError === null
        ? null
        : readOpenCodeTimestampMs(
          readOpenCodeNestedRecord(info, 'time')?.completed,
          { allowSecondsNumber: false },
        );
      if (
        providerErrorCompletedAtMs === null
        && classifyOpenCodeAssistantCompletion(info).kind !== 'terminal_success'
      ) {
        continue;
      }

      const text = extractOpenCodeTextHistoryItems([message])
        .find((item) => item.role === 'assistant' && item.messageId === messageId)?.text ?? '';
      let providerErrorFingerprint: string | null = null;
      if (providerError !== null) {
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
        return false;
      }
      candidatesByMessageId.set(messageId, {
        info,
        providerError,
        providerErrorFingerprint,
        text,
      });
    }
    if (candidatesByMessageId.size !== 1) return false;

    const [messageId, candidate] = candidatesByMessageId.entries().next().value ?? [];
    if (!messageId || !candidate) return false;
    if (candidate.providerError !== null) {
      const failureText = extractOpenCodeErrorText(candidate.providerError);
      const failureError = failureText
        ? new Error(failureText)
        : candidate.providerError instanceof Error
          ? candidate.providerError
          : new Error('OpenCode provider session error');
      const terminalMarkerId = ensureActiveLifecycleMarkerId();
      setThinking(false);
      await flushAndClearStreamWriters({
        reason: 'abort',
        interruptedReason: 'provider_session_error',
      });
      surfaceOpenCodeRuntimeFailure('session_error', candidate.providerError, terminalMarkerId);
      rejectTurn(failureError);
      return false;
    }
    if (candidate.text) {
      enableDurableCommitsForLiveMessageProjection(sessionId, messageId);
      applyInlinePartTextSnapshot({
        text: candidate.text,
        partType: 'text',
        remoteSessionId: sessionId,
        messageID: messageId,
        sidechainId: null,
      });
    }
    observedRemoteTextMessageIds.add(messageId);
    return observeAssistantCompletionInfoForActiveTurn(candidate.info);
  };

  const buildIdleWithoutTerminalAssistantIssue = (providerTurnId: string): SessionRuntimeIssueV1 => ({
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: OPENCODE_IDLE_WITHOUT_TERMINAL_ASSISTANT_CODE,
    source: 'stream_error',
    occurredAt: Date.now(),
    provider,
    providerTurnId,
    sanitizedPreview: turnRequiresPostToolAssistantCompletion
      ? 'OpenCode became idle after tool calls without producing a final assistant response.'
      : turnAssistantTranscriptActivitySeen
        ? 'OpenCode became idle after assistant text without producing a completed assistant message.'
        : 'OpenCode became idle before producing assistant activity.',
  });

  // Canonical OpenCode turn-failure emitter. The idle-without-terminal-assistant fallback, the
  // managed-server-restart recovery (Lane E), and the connected-broker preflight (Lane C) all need
  // the identical terminal sequence: emit a `turn_failed` transcript marker, persist the failure via
  // `sessionTurnLifecycle.failTurn`, stop the thinking indicator, flush+clear the stream writers, and
  // reject the active turn promise. The issue remains the one failure projection; an exact leaf may
  // additionally preserve proven provider-dispatch phase in the rejected Error without creating a
  // second turn-failure path. Single-fire is structurally preserved: the guard short-circuits once
  // `rejectTurn` synchronously nulls `turnDeferred`. NONE of these paths replay the prompt or call
  // sessionAbort.
  const createProviderUnavailableBeforeAcceptanceError = (
    issue: SessionRuntimeIssueV1,
  ): ProviderPromptSubmissionRejectedBeforeEffectError & Readonly<{
    code: string;
    issue: SessionRuntimeIssueV1;
  }> => Object.assign(
    new ProviderPromptSubmissionRejectedBeforeEffectError(
      'provider_unavailable_before_acceptance',
      new Error(issue.sanitizedPreview ?? issue.code),
    ),
    {
      code: issue.code,
      issue,
    },
  );

  const emitOpenCodeTurnFailure = (input: Readonly<{
    issue: SessionRuntimeIssueV1;
    error?: Error;
  }>): void => {
    if (!turnDeferred || !turnPromptActive) return;
    const { issue } = input;
    const code = issue.code;
    const providerTurnId = issue.providerTurnId ?? ensureActiveLifecycleMarkerId();
    const error = input.error ?? Object.assign(new Error(issue.sanitizedPreview ?? code), {
      code,
      issue,
    });
    const failureMarker = {
      type: 'turn_failed',
      id: providerTurnId,
      code,
      reason: code,
      issue,
    } satisfies ACPMessageData & {
      type: 'turn_failed';
      code: string;
      reason: string;
    };
    setThinking(false);
    void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: code }).finally(() => {
      params.session.sendAgentMessage(provider, failureMarker);
      void params.session.sessionTurnLifecycle?.failTurn({
        provider,
        providerTurnId,
        issue,
      }).catch((failError: unknown) => {
        logger.debug(`[OpenCodeServer] failed to persist turn failure (non-fatal) [${code}]`, failError);
      });
    });
    rejectTurn(error);
  };

  const failTurnAfterIdleWithoutTerminalAssistant = (): void => {
    if (!turnDeferred || !turnPromptActive) return;
    idleWithoutTerminalAssistantTimer = null;
    const providerTurnId = ensureActiveLifecycleMarkerId();
    emitOpenCodeTurnFailure({ issue: buildIdleWithoutTerminalAssistantIssue(providerTurnId) });
  };

  const scheduleIdleWithoutTerminalAssistantFallback = (): void => {
    if (idleWithoutTerminalAssistantTimer) return;
    idleWithoutTerminalAssistantTimer = setTimeout(
      failTurnAfterIdleWithoutTerminalAssistant,
      idleWithoutTerminalAssistantTimeoutMs,
    );
    idleWithoutTerminalAssistantTimer.unref?.();
  };

  // Generation-aware crash recovery (Lane E): the managed `opencode serve` process was replaced
  // mid-turn and the in-flight tool work could not be reconciled from durable history. Mirrors the
  // idle-without-terminal-assistant failure shape but is keyed on the server-restart issue code and
  // never calls `client.sessionAbort` (the old process is already gone) nor replays the prompt.
  const failActiveTurnDueToManagedServerRestart = (input: Readonly<{
    sanitizedPreview: string;
  }>): void => {
    if (!turnDeferred || !turnPromptActive) return;
    const providerTurnId = ensureActiveLifecycleMarkerId();
    // No task_complete, no client.sessionAbort, no prompt replay (the old process is already gone).
    emitOpenCodeTurnFailure({
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
        source: 'stream_error',
        occurredAt: Date.now(),
        provider,
        providerTurnId,
        sanitizedPreview: input.sanitizedPreview,
      },
    });
  };

  // Fail-closed connected-service broker preflight (Lane C, plan §5 item 5). For a CONNECTED OpenCode
  // session whose Happier auth broker is not materialized/reachable, fail the active turn with a clear
  // auth-materialization issue instead of forwarding the prompt — the stored broker marker is itself
  // non-functional, so falling back to native/upstream OpenCode auth must never happen. Mirrors the
  // canonical idle/managed-server-restart turn-failure shape (no prompt replay, no sessionAbort).
  const failTurnDueToConnectedBrokerNotReady = (reason: string): void => {
    if (!turnDeferred || !turnPromptActive) return;
    const providerTurnId = ensureActiveLifecycleMarkerId();
    const issue: SessionRuntimeIssueV1 = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE,
      source: 'stream_error',
      occurredAt: Date.now(),
      provider,
      providerTurnId,
      sanitizedPreview:
        'OpenCode connected-service authentication is not materialized for this session '
        + `(${reason}). The session was stopped to avoid falling back to unmanaged OpenCode auth.`,
    };
    // No prompt replay, no native/upstream fallback (the stored broker marker is non-functional).
    emitOpenCodeTurnFailure({
      issue,
      error: createProviderUnavailableBeforeAcceptanceError(issue),
    });
  };

  const createPromptNotDispatchedError = (reason: string): Error & {
    code: typeof OPENCODE_PROMPT_NOT_DISPATCHED_CODE;
    issue: SessionRuntimeIssueV1;
  } => {
    const providerTurnId = activeLifecycleMarkerId ?? ensureActiveLifecycleMarkerId();
    const issue: SessionRuntimeIssueV1 = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: OPENCODE_PROMPT_NOT_DISPATCHED_CODE,
      source: 'provider_session_error',
      occurredAt: Date.now(),
      provider,
      providerTurnId,
      sanitizedPreview:
        'OpenCode prompt was not dispatched before provider dispatch '
        + `(${reason}). The turn was failed instead of confirming provider delivery.`,
    };
    const error = new Error(issue.sanitizedPreview) as Error & {
      code: typeof OPENCODE_PROMPT_NOT_DISPATCHED_CODE;
      issue: SessionRuntimeIssueV1;
    };
    error.code = OPENCODE_PROMPT_NOT_DISPATCHED_CODE;
    error.issue = issue;
    return error;
  };

  const throwPromptNotDispatched = (reason: string): never => {
    const error = createPromptNotDispatchedError(reason);
    if (turnDeferred && turnPromptActive) {
      emitOpenCodeTurnFailure({ issue: error.issue });
    }
    throw error;
  };

  const awaitPreDispatchTurnSettlement = async (
    turn: Deferred<void>,
    reason: string,
  ): Promise<never> => {
    await turn.promise;
    throw createPromptNotDispatchedError(reason);
  };

  // Memoized once-per-session preflight: the broker readiness is a launch-time fact (plugin assets +
  // daemon bridge reachability), so verify it once and enforce the verdict on every turn (fail-closed).
  const ensureConnectedBrokerPreflight = (): Promise<OpenCodeBrokerReadiness> => {
    connectedBrokerPreflight ??= verifyOpenCodeBrokerReadyForConnectedSession(env);
    return connectedBrokerPreflight;
  };

  const waitForConnectedBrokerPreflightBeforePrompt = async (
    turn: Deferred<void>,
    targetSessionId: string,
  ): Promise<OpenCodeBrokerReadiness | null> => {
    for (;;) {
      if (!isActivePromptTurn(turn, targetSessionId)) return null;
      const preflightGenerationKey = readCurrentServerConnectedGenerationKey();
      const outcome = await Promise.race([
        ensureConnectedBrokerPreflight().then(
          (readiness) => ({ type: 'readiness' as const, readiness }),
          (error: unknown) => ({ type: 'readiness_rejected' as const, error }),
        ),
        turn.promise.then(
          () => ({ type: 'turn_resolved' as const }),
          (error: unknown) => ({ type: 'turn_rejected' as const, error }),
        ),
      ]);

      if (outcome.type === 'turn_rejected') throw outcome.error;
      if (outcome.type === 'turn_resolved') return null;
      if (outcome.type === 'readiness_rejected') throw outcome.error;
      if (!isActivePromptTurn(turn, targetSessionId)) return null;

      const serverReadyForPrompt = await waitForServerConnectedBeforePrompt(turn, targetSessionId);
      if (!serverReadyForPrompt) return null;
      if (preflightGenerationKey !== readCurrentServerConnectedGenerationKey()) {
        continue;
      }

      return outcome.readiness;
    }
  };

  managedServerTurnSupervisor = createOpenCodeManagedServerTurnInterruptionSupervisor({
    isTurnActive: () => Boolean(turnDeferred) && turnPromptActive,
    getManagedServerIdentity: () => client?.getManagedServerIdentity() ?? null,
    setObservedGenerationKey: (generationKey) => foregroundToolTracker.setObservedGenerationKey(generationKey),
    reconcileLiveKnownToolStateFromHistory: () => refreshLiveKnownOpenCodeStateFromControlPlaneBestEffort(),
    hasUnreconciledActiveLiveKnownToolWork: () => hasUnreconciledActiveLiveKnownToolWork(),
    failActiveTurnDueToManagedServerRestart: (failInput) => failActiveTurnDueToManagedServerRestart(failInput),
    resetProviderWorkForInterruptedTurn: () => {
      foregroundToolTracker.clearActiveWork({ reason: 'turn_reset' });
    },
    clearOrphanedProviderWork: (currentGenerationKey) => {
      foregroundToolTracker.clearActiveWork({
        reason: 'managed_server_generation_replaced',
        generationKey: currentGenerationKey,
      });
    },
    describeActiveProviderWorkForLog: () => {
      const workState = foregroundToolTracker.getProviderWorkState();
      if (!workState.active) return { activeToolCallCount: 0 };
      return {
        activeToolCallCount: workState.activeToolCallCount,
        activeToolCalls: workState.activeToolCalls.map((tool) => ({
          key: tool.key,
          sessionId: tool.sessionId,
          toolName: tool.toolName,
          status: tool.status,
          ...(tool.observedGenerationKey ? { observedGenerationKey: tool.observedGenerationKey.slice(0, 12) } : {}),
        })),
      };
    },
    getProviderSessionId: () => sessionId,
    getActiveSidechainSessionIds: () => Array.from(sidechainIdByRemoteSessionId.keys()),
  });

  const sendDelta = (delta: string, remoteSessionId: string, messageID: string, sidechainId: string | null) => {
    markTurnActivity();
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);
    if (!sidechainId && sessionId && remoteSessionId === sessionId) {
      turnStreamedAssistantMessageIds.add(messageID);
      turnLiveKnownAssistantMessageIds.add(messageID);
      turnAssistantTranscriptActivitySeen = true;
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
    markTurnActivity();
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
      markTurnActivity();
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
    markTurnActivity();
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
    provenance: OpenCodeToolObservationProvenance,
  ) => {
    if (!part) return;
    const status = normalizeString(part.state.status);
    const isTerminalStatus = isTerminalOpenCodeToolPartStatus(status);
    const callId = part.callID;
    const callKey = buildOpenCodeToolCallKey(part.sessionID, callId);

    // History is recovery evidence for the current foreground turn, never live producer input.
    // Keep foreground tool settlement reconcilable after a dropped/replaced stream, but do not
    // forward transcript tool lifecycle, refresh the current-turn clock, or synthesize attention.
    // The discriminant is supplied by this provider adapter, not parsed from editor-controlled
    // message bytes, so persisted rows cannot promote themselves into the live path.
    if (provenance.source === 'control-plane-history') {
      observedToolPartByCallKey.set(callKey, part);
      foregroundToolTracker.observeToolPart({ part, source: 'history' });
      return;
    }

    markTurnActivity();
    if (sidechainId) sidechainStreamSeenBySidechainId.add(sidechainId);

    if (turnPromptActive) {
      turnLiveKnownToolCallKeys.add(callKey);
    }
    foregroundToolTracker.observeToolPart({ part, source: 'live' });
    if (!isTerminalStatus) {
      markOpenCodeSessionActive();
    }
    const messageID = part.messageID;
    const toolRaw = normalizeString(part.tool).trim();
    const toolLower = toolRaw.toLowerCase();
    observedToolPartByCallKey.set(callKey, part);
    const isChangeTitleTool =
      toolLower === preferredOpenCodeChangeTitleToolName.toLowerCase() || isChangeTitleToolNameAlias(toolLower);
    if (isChangeTitleTool) {
      if (isTerminalStatus) settleThinkingAfterProviderWorkUpdate();
      return;
    }

    // Task sidechains must be registered without awaiting, because SSE consumers do not await
    // event handlers and related child-session events (questions/deltas) can arrive immediately.
    if (toolLower === 'task') {
      const metadata = asRecord(part.state.metadata) ?? {};
      const outputText = normalizeString(part.state.output);
      const remoteSessionId = extractOpenCodeTaskChildSessionId({ output: outputText, metadata });
      if (remoteSessionId && remoteSessionId !== sessionId) {
        sidechainIdByRemoteSessionId.set(remoteSessionId, callId);
        pendingTaskChildSessionDiscoveryCallKeys.delete(callKey);
      } else if (isTerminalStatus) {
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
      (hasMeaningfulInput || Boolean(commandHint) || isTerminalStatus);

    if (shouldEmitToolCallNow) {
      try {
        await flushStreamWritersForSidechainBoundary(sidechainId);
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

    if (isTerminalStatus && !toolResultSentByCallId.has(callKey)) {
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
        const error = normalizeString(part.state.error) || `${status || 'tool'} failed`;
        const output = {
          status: 'failed',
          error,
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : null),
        };
        params.session.sendAgentMessage(
          provider,
          { type: 'tool-result', callId, output, id: randomUUID(), isError: true, ...(sidechainId ? { sidechainId } : null) },
          { meta },
        );
      }
    }
    if (isTerminalStatus) settleThinkingAfterProviderWorkUpdate();
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

    const rejectionKey = `${req.sessionID}\u0000${req.id}`;
    const rejectionKeysForOwningTurn = pendingFailClosedQuestionRejectionKeys ?? new Set<string>();
    pendingFailClosedQuestionRejectionKeys = rejectionKeysForOwningTurn;
    if (rejectionKeysForOwningTurn.has(rejectionKey)) {
      const c = await ensureClient();
      await c.questionReject({ requestId: req.id });
      rejectionKeysForOwningTurn.delete(rejectionKey);
      return;
    }

    setThinking(false);
    idleSignalSeen = false;
    idleSignalSeenViaControlPlane = false;
    if (turnPromptActive) markTurnActivity();

    const questions = req.questions
      .map((q) => (asRecord(q) ?? null))
      .filter(Boolean) as Array<Record<string, unknown>>;

    if (questions.length > 0 && questions.every(openCodeQuestionRecordLooksLikeInternalTitleUpdate)) {
      const c = await ensureClient();
      await c.questionReply({ requestId: req.id, answers: questions.map(() => ['OK']) });
      return;
    }

    params.session.sendAgentMessage(provider, { type: 'task_started', id: ensureActiveLifecycleMarkerId() });

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

    turnAwaitingUserResponseCount += 1;
    let decision: Awaited<ReturnType<typeof params.permissionHandler.handleToolCall>>;
    try {
      decision = await params.permissionHandler.handleToolCall(req.id, 'AskUserQuestion', askUserQuestionInput);
    } catch (error) {
      logger.debug('[OpenCodeServer] question handler threw; rejecting question request (fail-closed)', {
        requestId: req.id,
        sessionId: req.sessionID,
      }, error);
      params.session.sendAgentMessage(provider, {
        type: 'message',
        message: 'Question request handling failed. For safety, the request was rejected.',
      });
      rejectionKeysForOwningTurn.add(rejectionKey);
      try {
        const c = await ensureClient();
        await c.questionReject({ requestId: req.id });
        rejectionKeysForOwningTurn.delete(rejectionKey);
      } catch (replyError) {
        logger.debug('[OpenCodeServer] failed to reject question request after handler error', {
          requestId: req.id,
          sessionId: req.sessionID,
        }, replyError);
        throw replyError;
      }
      return;
    } finally {
      turnAwaitingUserResponseCount = Math.max(0, turnAwaitingUserResponseCount - 1);
    }
    if (decision.decision === 'approved' || decision.decision === 'approved_for_session' || decision.decision === 'approved_execpolicy_amendment') {
      const answersByKey = decision.answers;
      const answers = answersByKey && typeof answersByKey === 'object' && !Array.isArray(answersByKey) ? answersByKey : {};
      const answerArray = buildQuestionAnswersArray({ questions, answersByQuestionKey: answers });
      const c = await ensureClient();
      await c.questionReply({ requestId: req.id, answers: answerArray });
      params.session.sendAgentMessage(provider, {
        type: 'tool-result',
        callId: req.id,
        output: { answers },
        id: randomUUID(),
      });
      return;
    }

    const c = await ensureClient();
    await c.questionReject({ requestId: req.id });
  };

  const handlePermissionAsked = async (req: OpenCodePermissionRequest) => {
    if (req.sessionID !== sessionId && !sidechainIdByRemoteSessionId.has(req.sessionID)) return;
    setThinking(false);
    idleSignalSeen = false;
    idleSignalSeenViaControlPlane = false;
    if (turnPromptActive) markTurnActivity();

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
      turnAwaitingUserResponseCount += 1;
      try {
        decision = await params.permissionHandler.handleToolCall(
          resolved.localRequestId,
          resolved.toolName,
          resolved.toolInput,
        );
      } finally {
        turnAwaitingUserResponseCount = Math.max(0, turnAwaitingUserResponseCount - 1);
      }
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

  let authoritativeRequestInventoryRefreshInFlight: Promise<void> | null = null;
  scheduleAuthoritativeRequestInventoryRefresh = () => {
    if (authoritativeRequestInventoryRefreshInFlight) return;
    const work = (async () => {
      const c = await ensureClient();
      const [permissionsResult, questionsResult] = await Promise.allSettled([
        c.permissionList(),
        c.questionList(),
      ]);

      if (permissionsResult.status === 'fulfilled') {
        for (const raw of permissionsResult.value) {
          const request = parsePermissionRequest(raw);
          if (request) handlePermissionAskedBestEffort(request);
        }
      } else {
        logger.debug('[OpenCodeServer] failed to refresh active permission requests (non-fatal)', {
          sessionId,
          error: permissionsResult.reason,
        });
      }

      if (questionsResult.status === 'fulfilled') {
        for (const raw of questionsResult.value) {
          const request = parseQuestionRequest(raw);
          if (request) handleQuestionAskedBestEffort(request);
        }
      } else {
        logger.debug('[OpenCodeServer] failed to refresh active question requests (non-fatal)', {
          sessionId,
          error: questionsResult.reason,
        });
      }
    })();
    authoritativeRequestInventoryRefreshInFlight = work;
    void work
      .catch((error) => {
        logger.debug('[OpenCodeServer] active request inventory refresh failed (non-fatal)', {
          sessionId,
          error,
        });
      })
      .finally(() => {
        if (authoritativeRequestInventoryRefreshInFlight === work) {
          authoritativeRequestInventoryRefreshInFlight = null;
        }
      });
  };

  const handleSessionNextGuardEvent = (type: string, propsRaw: unknown): boolean => {
    if (!type.startsWith('session.next.')) return false;
    const rec = asRecord(propsRaw);
    if (!rec) return false;
    const eventSessionId = normalizeString(rec.sessionID)
      || normalizeString(rec.sessionId)
      || normalizeString(asRecord(rec.session)?.id);
    if (!eventSessionId || eventSessionId !== sessionId) return true;

    if (type === 'session.next.retried') {
      const errorRecord = asRecord(rec.error);
      const message = normalizeString(rec.message)
        || extractOpenCodeErrorText(rec.error)
        || normalizeString(errorRecord?.message)
        || 'OpenCode session is waiting before retrying';
      failActiveTurnOnRetryStatus({
        type: 'retry',
        attempt: rec.attempt ?? errorRecord?.attempt,
        message,
        next: rec.next ?? errorRecord?.next,
      });
      return true;
    }

    if (type.startsWith('session.next.tool.')) {
      if (!turnPromptActive) return true;
      const callId = normalizeString(rec.callID)
        || normalizeString(rec.callId)
        || normalizeString(rec.toolCallID)
        || normalizeString(rec.toolCallId)
        || normalizeString(rec.id);
      if (callId) {
        const terminal = (
          type === 'session.next.tool.success'
          || type === 'session.next.tool.completed'
          || type === 'session.next.tool.failed'
          || type === 'session.next.tool.cancelled'
          || type === 'session.next.tool.canceled'
          || type === 'session.next.tool.aborted'
        );
        foregroundToolTracker.observeSessionNextTool({
          sessionId: eventSessionId,
          callId,
          terminal,
          source: 'session-next',
        });
        if (!terminal) {
          markOpenCodeSessionActive();
        } else {
          settleThinkingAfterProviderWorkUpdate();
        }
      }
      markTurnActivity();
      return true;
    }

    if (!turnPromptActive) return true;

    if (
      type.startsWith('session.next.text.')
      || type.startsWith('session.next.reasoning.')
      || type.startsWith('session.next.step.')
    ) {
      markTurnActivity();
      return true;
    }

    return false;
  };

  const handleEvent = (evt: OpenCodeGlobalEvent): Promise<void> | void => {
    const payload = evt.payload;
    const type = normalizeString(payload.type);
    const props = payload.properties;
    shapeLogger.log(`event:${type || 'unknown'}`, payload);

    if (type === 'server.connected') {
      markServerConnected();
      // Origin-agnostic catch-up after (re)connect: mirror any external (e.g. TUI-authored) turns
      // that landed while disconnected. Idempotent via the dedupe gate + deterministic import ids.
      scheduleExternalSessionTranscriptProjection();
      return refreshLiveKnownOpenCodeStateFromControlPlaneBestEffort();
    }

    const compactionEvent = mapOpenCodeCompactionEventToAgentMessage(evt, sessionId);
    if (compactionEvent) {
      compactionInProgress = !isTerminalCompactionPhase(compactionEvent.phase);
      const manualCompaction = activeManualCompaction;
      if (manualCompaction && compactionEvent.providerSessionId === sessionId) {
        if (isTerminalCompactionPhase(compactionEvent.phase)) {
          manualCompaction.terminalObserved = true;
          sendContextCompactionEvent({
            ...compactionEvent,
            lifecycleId: manualCompaction.lifecycleId,
            trigger: 'manual',
          });
        }
        return;
      }
      sendContextCompactionEvent(compactionEvent);
      return;
    }

    if (handleSessionNextGuardEvent(type, props)) return;

    if (type === 'todo.updated') {
      const eventSessionId = normalizeString(asRecord(props)?.sessionID)
        || normalizeString(asRecord(asRecord(props)?.session)?.id);
      if (!eventSessionId || eventSessionId === sessionId) {
        publishNativeTodosWorkStateBestEffort();
      }
      return;
    }

    if (type === 'message.updated') {
      const info = asRecord(asRecord(props)?.info);
      if (!info) return;
      const infoSessionId = normalizeString(info.sessionID);
      if (!infoSessionId || infoSessionId !== sessionId) return;
      const projection = classifyOpenCodeMessageForProjection(info);
      const infoMessageId = projection.messageId || normalizeString(info.id);
      // Origin-agnostic projection (S2): a message materialized for this session while no Happier
      // turn owns it (e.g. typed in an attached OpenCode TUI). Mirror it into the transcript. The
      // passive pass only commits SETTLED messages and dedupes via `observedRemoteTextMessageIds`.
      if (
        !turnPromptActive
        && (projection.kind === 'user_transcript' || projection.kind === 'assistant_transcript')
        && infoMessageId
        && !observedRemoteTextMessageIds.has(infoMessageId)
      ) {
        scheduleExternalSessionTranscriptProjection();
      }
      if (projection.kind === 'user_transcript' && infoMessageId) {
        noteUserMessageIdForActiveTurn(infoMessageId);
      }
      if (infoMessageId && (projection.kind === 'compaction_internal' || projection.kind === 'ignored_internal')) {
        suppressLiveMessageProjection(infoSessionId, infoMessageId);
      } else if (infoMessageId && projection.kind === 'assistant_transcript') {
        enableDurableCommitsForLiveMessageProjection(infoSessionId, infoMessageId);
      }
      if (infoMessageId && (
        projection.kind === 'assistant_transcript'
        || projection.kind === 'compaction_internal'
        || projection.kind === 'ignored_internal'
      )) {
        const terminalEvidenceSeen = observeAssistantCompletionInfoForActiveTurn(info);
        if (projection.kind === 'assistant_transcript') {
          if (flushPendingInlineSnapshotsForMessage({ remoteSessionId: infoSessionId, messageID: infoMessageId }) && idleSignalSeen) {
            void maybeResolveTurnOnIdleSignal();
          } else if (terminalEvidenceSeen && idleSignalSeen) {
            void maybeResolveTurnOnIdleSignal();
          }
        } else if (idleSignalSeen) {
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
      const projection = classifyOpenCodePartForProjection(part, { context: 'live_transcript' });
      const partType = projection.partType || normalizeString(part.type);
      if (partID && partType) partTypeByPartKey.set(`${sessionID}:${partID}`, partType);
      const maybeTool = parseOpenCodeToolPart(part);
      if (maybeTool) {
        if (turnPromptActive) {
          idleSignalSeen = false;
          idleSignalSeenViaControlPlane = false;
        }
        const observedTurnChangeCollectorEpoch = turnChangeCollectorEpoch;
        const toolWork = sendToolFromPart(
          maybeTool,
          sidechainId,
          observedTurnChangeCollectorEpoch,
          { source: 'provider-live-subscription' },
        ).catch((error) => {
          logger.debug('[OpenCodeServer] tool handler failed (non-fatal)', error);
        });
        void trackPendingTurnToolForwardingWork(toolWork).finally(() => {
          if (observedTurnChangeCollectorEpoch === turnChangeCollectorEpoch && idleSignalSeen && turnPromptActive) {
            void maybeResolveTurnOnIdleSignal();
          }
        });
        return toolWork;
      }
      const messageID = normalizeString(part.messageID);
      if (projection.kind === 'ignored_internal' || (sessionID === sessionId && compactionInProgress && !sidechainId)) {
        suppressLivePartProjection(sessionID, partID, messageID);
        return;
      }
      const inlineText = (
        projection.kind === 'transcript_text' || projection.kind === 'reasoning_text'
          ? projection.text
          : ''
      );
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
      const partType = partTypeByPartKey.get(`${sessionID}:${partID}`) ?? '';
      const accumulationKey = `${sessionID}:${messageID}:${partType === 'reasoning' ? 'reasoning' : 'text'}`;
      const accumulated = accumulatedTextByPartKey.get(accumulationKey) ?? '';
      const nextAccumulated = delta.startsWith(accumulated) ? delta : accumulated + delta;
      accumulatedTextByPartKey.set(accumulationKey, nextAccumulated);
      if (
        suppressedLivePartKeys.has(buildLivePartKey(sessionID, partID))
        || suppressedLiveMessageKeys.has(buildLiveMessageKey(sessionID, messageID))
        || (sessionID === sessionId && compactionInProgress && !sidechainId)
      ) {
        suppressLivePartProjection(sessionID, partID, messageID);
        return;
      }
      if (sessionID === sessionId) {
        if (!shouldTreatMessageIdAsTurnActivity(messageID)) return;
      } else {
        if (!turnPromptActive) return;
      }
      if (turnPromptActive) {
        idleSignalSeen = false;
        idleSignalSeenViaControlPlane = false;
      }
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
      if (statusType === 'busy') {
        clearIdleWithoutTerminalAssistantTimer();
        setThinking(true);
        markOpenCodeSessionActive();
      }
      if (statusType === 'retry' && statusRec) {
        failActiveTurnOnRetryStatus(statusRec);
        return;
      }
      if (statusType === 'idle') {
        if (turnPromptActive) {
          idleSignalSeen = true;
          idleSignalSeenViaControlPlane = false;
          void maybeResolveTurnOnIdleSignal();
        }
        settleThinkingOnOpenCodeIdleSignal();
      }
      return;
    }

    if (type === 'session.idle') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      if (turnPromptActive) {
        idleSignalSeen = true;
        idleSignalSeenViaControlPlane = false;
        void maybeResolveTurnOnIdleSignal();
      }
      settleThinkingOnOpenCodeIdleSignal();
      return;
    }

    if (type === 'session.error') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      const isExpectedExplicitCancelError = suppressSessionErrorAbortNotificationForSessionId === sessionID;
      const detail = extractOpenCodeErrorText(rec.error);
      if (!isExpectedExplicitCancelError && openCodeErrorLooksLikeContextOverflow(rec.error ?? rec)) {
        compactionInProgress = true;
        setThinking(false);
        void flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'context_overflow_compaction' }).catch(() => {});
        const sanitizedErrorPreview = formatErrorForUi(rec.error ?? rec, { maxChars: 1_000 }).trim();
        sendContextCompactionEvent({
          type: 'context-compaction',
          phase: 'started',
          provider: 'opencode',
          source: 'provider-status',
          trigger: 'overflow',
          lifecycleId: `opencode:context-compaction:${sessionID}:context-overflow`,
          providerSessionId: sessionID,
          ...(sanitizedErrorPreview ? { sanitizedErrorPreview } : {}),
        });
        return;
      }
      const failureError = detail ? new Error(detail) : rec.error ?? new Error('OpenCode session error');
      const isAbortLikeSessionError = isAbortLikeError(failureError);
      const terminalMarkerId = ensureActiveLifecycleMarkerId();
      setThinking(false);
      const surfaceSessionError = (): void => {
        if (!isExpectedExplicitCancelError) {
          if (isAbortLikeSessionError) {
            params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: terminalMarkerId });
          } else {
            surfaceOpenCodeRuntimeFailure('session_error', rec.error ?? failureError, terminalMarkerId);
          }
        }
      };
      const flushPromise = flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'session_error' });
      if (turnPromptActive) {
        void flushPromise.finally(surfaceSessionError);
      } else {
        void flushPromise.catch(() => {});
        surfaceSessionError();
      }
      rejectTurn(failureError);
      return;
    }

    return;
  };

  const resetRuntimeState = () => {
    turnDeferred = null;
    turnInFlight = false;
    resetTurnEventState();
  };

  const invalidateMcpServersForCurrentDirectory = (): void => {
    ensuredMcpServersForDirectory = false;
    if (!requiredMcpServerName) return;
    requiredMcpServerReadiness.deferred.resolve({ status: 'superseded' });
    requiredMcpServerReadiness = {
      deferred: createDeferred<RequiredMcpServerReadinessOutcome>(),
    };
    if (!Object.prototype.hasOwnProperty.call(params.mcpServers, requiredMcpServerName)) {
      requiredMcpServerReadiness.deferred.resolve({
        status: 'failed',
        error: new Error('required Happier MCP server configuration is missing'),
      });
    }
  };

  const registerMcpServersForCurrentDirectoryBestEffort = async (): Promise<void> => {
    if (ensuredMcpServersForDirectory) return;
    if (!params.mcpServers || Object.keys(params.mcpServers).length === 0) return;
    const requiredReadinessForRegistration = requiredMcpServerReadiness;
    let c: OpenCodeServerRuntimeClient;
    try {
      c = await ensureClient();
    } catch (error) {
      if (
        requiredMcpServerName
        && requiredMcpServerReadiness === requiredReadinessForRegistration
      ) {
        requiredReadinessForRegistration.deferred.resolve({ status: 'failed', error });
      }
      throw error;
    }
    let hadFailures = false;
    for (const [name, cfg] of Object.entries(params.mcpServers)) {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) continue;
      const cmd = typeof cfg?.command === 'string' ? cfg.command.trim() : '';
      if (!cmd) {
        if (
          serverName === requiredMcpServerName
          && requiredMcpServerReadiness === requiredReadinessForRegistration
        ) {
          requiredReadinessForRegistration.deferred.resolve({
            status: 'failed',
            error: new Error('required Happier MCP server command is missing'),
          });
        }
        hadFailures = true;
        continue;
      }
      const args = Array.isArray(cfg.args) ? cfg.args.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : [];
      const env = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
        ? Object.fromEntries(
            Object.entries(cfg.env).filter(([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string'),
          )
        : undefined;

      try {
        const registrationStatus = await c.mcpAdd({
          name: serverName,
          config: {
            type: 'local',
            enabled: true,
            command: [cmd, ...args],
            ...(env && Object.keys(env).length > 0 ? { environment: env } : {}),
          },
        });
        if (registrationStatus.status !== 'connected') {
          const detail = 'error' in registrationStatus ? `: ${registrationStatus.error}` : '';
          throw new Error(
            `OpenCode MCP server "${serverName}" returned status "${registrationStatus.status}"${detail}`,
          );
        }
        ensuredMcpServerNames.add(serverName);
        if (
          serverName === requiredMcpServerName
          && requiredMcpServerReadiness === requiredReadinessForRegistration
        ) {
          requiredReadinessForRegistration.deferred.resolve({ status: 'ready' });
        }
      } catch (error) {
        hadFailures = true;
        if (
          serverName === requiredMcpServerName
          && requiredMcpServerReadiness === requiredReadinessForRegistration
        ) {
          requiredReadinessForRegistration.deferred.resolve({ status: 'failed', error });
        }
        logger.debug(
          serverName === requiredMcpServerName
            ? '[OpenCodeServer] Required Happier MCP server registration failed; prompt admission will fail closed'
            : '[OpenCodeServer] Failed to register MCP server (non-fatal)',
          { serverName, error },
        );
      }
    }
    ensuredMcpServersForDirectory = hadFailures !== true;
  };

  const scheduleMcpServersForCurrentDirectoryBestEffort = (): void => {
    if (ensuredMcpServersForDirectory) return;
    if (mcpServerRegistrationInFlight) {
      mcpServerRegistrationRerunRequested = true;
      return;
    }
    mcpServerRegistrationRerunRequested = false;
    mcpServerRegistrationInFlight = registerMcpServersForCurrentDirectoryBestEffort()
      .catch((error) => {
        logger.debug('[OpenCodeServer] MCP server registration failed (non-fatal)', error);
      })
      .finally(() => {
        mcpServerRegistrationInFlight = null;
        if (!mcpServerRegistrationRerunRequested) return;
        mcpServerRegistrationRerunRequested = false;
        ensuredMcpServersForDirectory = false;
        scheduleMcpServersForCurrentDirectoryBestEffort();
      });
  };

  const waitForRequiredMcpServerBeforePrompt = async (
    turn: Deferred<void>,
    targetSessionId: string,
  ): Promise<RequiredMcpServerReadinessOutcome | null> => {
    if (!requiredMcpServerName) return { status: 'ready' };
    for (;;) {
      if (!isActivePromptTurn(turn, targetSessionId)) return null;
      const readiness = requiredMcpServerReadiness;
      const outcome = await Promise.race([
        readiness.deferred.promise.then((result) => ({ type: 'readiness' as const, result })),
        turn.promise.then(
          () => ({ type: 'turn_resolved' as const }),
          (error: unknown) => ({ type: 'turn_rejected' as const, error }),
        ),
      ]);

      if (outcome.type === 'turn_rejected') throw outcome.error;
      if (outcome.type === 'turn_resolved') return null;
      if (!isActivePromptTurn(turn, targetSessionId)) return null;
      if (readiness !== requiredMcpServerReadiness || outcome.result.status === 'superseded') {
        continue;
      }
      return outcome.result;
    }
  };

  const drainPendingAfterStartOrLoad = async (): Promise<void> => {
    const pendingQueue = params.pendingQueue;
    if (pendingQueue?.drainAfterStartOrLoad !== true) return;

    const drainOptions: DrainPendingOptions = {
      logPrefix: '[OpenCodeServer]',
      reason: 'opencode_server_start_or_load',
    };
    if (pendingQueue.maxPopPerWake !== undefined) {
      drainOptions.maxPopPerWake = pendingQueue.maxPopPerWake;
    }
    if (pendingQueue.shouldDrainPendingMessages) {
      drainOptions.shouldContinue = pendingQueue.shouldDrainPendingMessages;
    }

    await pendingQueue.drainPending(drainOptions);
  };

  const preferredOpenCodeChangeTitleToolName = resolvePreferredChangeTitleToolNameForProvider('opencode');
  return {
    getSessionId: () => sessionId,
    shouldResumeAfterPermissionModeChange: () => true,
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => turnInFlight,
    probeTurnLiveness: probeFinalTurnLivenessBeforeDeadlockAbort,

    beginTurn(): void {
      abortSuppressionGeneration += 1;
      suppressSessionErrorAbortNotificationForSessionId = null;
      turnInFlight = true;
      pendingTurnToolForwardingWork = new Set<Promise<void>>();
      turnPromptActive = false;
      turnActivitySeen = false;
      idleSignalSeen = false;
      idleSignalSeenViaControlPlane = false;
      beginFreshTurnChangeCollection();
      activeLifecycleMarkerId = randomUUID();
      params.session.sendAgentMessage(provider, { type: 'task_started', id: activeLifecycleMarkerId });
      setThinking(true);
    },

    async listSkills(): Promise<unknown> {
      const c = await ensureClient();
      return {
        supported: true,
        skills: normalizeOpenCodeAppSkills(await c.appSkills()),
      };
    },

    async startOrLoad(opts: { resumeId?: string | null } = {}): Promise<string> {
      invalidateMcpServersForCurrentDirectory();
      await attachSubscriptionIfNeeded();
      const c = await ensureClient();

      scheduleMcpServersForCurrentDirectoryBestEffort();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (resumeId) {
        const existing = await c.sessionGet({ sessionId: resumeId });
        sessionId = existing.id ?? resumeId;
        foregroundToolTracker.resetForProviderSession(sessionId);
        omitCustomMessageIdForResumedSession = true;
        const sessionDirectory = normalizeString(existing.directory).trim();
        if (sessionDirectory) {
          try {
            if (c.setDirectoryOverride(sessionDirectory)) {
              resetServerConnectedReadiness();
            }
          } catch {
            // non-fatal
          }
          invalidateMcpServersForCurrentDirectory();
          scheduleMcpServersForCurrentDirectoryBestEffort();
        }
        await c.sessionUpdate({ sessionId: sessionId!, permission: [...resolveSessionPermissionRuleset()] as unknown[] });
        publishDynamicSessionOptionsBestEffort();
        publishNativeTodosWorkStateBestEffort();
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

        await drainPendingAfterStartOrLoad();
        return sessionId!;
      }

      const created: OpenCodeSession = await c.sessionCreate({ permission: [...resolveSessionPermissionRuleset()] as unknown[] });
      sessionId = created.id;
      foregroundToolTracker.resetForProviderSession(sessionId);
      omitCustomMessageIdForResumedSession = false;
      const createdDirectory = normalizeString(created.directory).trim();
      if (createdDirectory) {
        try {
          if (c.setDirectoryOverride(createdDirectory)) {
            resetServerConnectedReadiness();
          }
        } catch {
          // non-fatal
        }
        invalidateMcpServersForCurrentDirectory();
        scheduleMcpServersForCurrentDirectoryBestEffort();
      }
      publishDynamicSessionOptionsBestEffort();
      publishNativeTodosWorkStateBestEffort();
      await drainPendingAfterStartOrLoad();
      return sessionId!;
    },

    async sendPrompt(prompt: string): Promise<void> {
      const resumeBackfillLocalId = omitCustomMessageIdForResumedSession
        ? `opencode-resume-local-${randomUUID()}`
        : null;
      await this.sendPromptWithMeta?.({ text: prompt, localId: resumeBackfillLocalId });
    },

    async sendPromptWithMeta(paramsWithMeta: ProviderPromptWithMeta): Promise<void> {
      const promptSessionId = sessionId;
      if (!promptSessionId) throw new Error('OpenCode server session was not started');
      const c = await ensureClient();
      const effectiveText = typeof paramsWithMeta.text === 'string' ? paramsWithMeta.text : '';

      const shouldOmitCustomMessageId = omitCustomMessageIdForResumedSession === true;
      const messageID = shouldOmitCustomMessageId
        ? undefined
        : (await resolveOrCreateUserMessageId(paramsWithMeta.localId ?? null)) ?? undefined;
      if (messageID) observedRemoteTextMessageIds.add(messageID);
      const agent = selectedAgent ?? undefined;
      const promptOptions = buildOpenCodePromptOptionPayload(configOverrides);
      turnDeferred = createDeferred<void>();
      // A turn can be aborted from a background poll/SSE callback before sendPromptWithMeta reaches its await.
      // Attach a handler immediately so Node does not treat the rejection as unhandled.
      void turnDeferred.promise.catch(() => undefined);
      const thisTurnDeferred = turnDeferred;
      turnPromptActive = true;
      turnActivitySeen = false;
      turnLastActivityAtMs = Date.now();
      managedServerTurnSupervisor?.captureTurnStartGeneration();
      watchdogFired = false;
      idleSignalSeen = false;
      idleSignalSeenViaControlPlane = false;
      turnUserMessageId = messageID ?? null;
      turnPromptLocalId = readNonBlankOpaqueIdentifier(paramsWithMeta.localId);
      turnPromptTextForBackfill = paramsWithMeta.text;
      turnPromptEffectiveTextForBackfill = effectiveText;
      turnPrePromptMessageIdsAll = null;
      turnPreexistingMessageIds = null;
      handledPermissionIds = new Set<string>();
      handledQuestionIds = new Set<string>();
      inFlightPermissionIds = new Set<string>();
      inFlightQuestionIds = new Set<string>();

      const serverReadyForPrompt = await waitForServerConnectedBeforePrompt(thisTurnDeferred, promptSessionId);
      if (!serverReadyForPrompt) {
        throwPromptNotDispatched('server readiness ended before prompt_async');
      }

      // Fail-closed connected-service broker preflight after the server has reported connected but
      // before any prompt reaches OpenCode. No-op for native + direct-API-key sessions (the preflight
      // returns ready). For a connected brokered session whose broker is not materialized/reachable,
      // fail the turn closed instead of letting the prompt fall through to unmanaged OpenCode auth.
      const brokerReadiness = await waitForConnectedBrokerPreflightBeforePrompt(thisTurnDeferred, promptSessionId);
      if (brokerReadiness === null) {
        throwPromptNotDispatched('connected broker preflight ended before prompt_async');
      } else if (brokerReadiness.ready === false) {
        failTurnDueToConnectedBrokerNotReady(brokerReadiness.reason);
        await thisTurnDeferred.promise;
        return;
      }

      const requiredMcpReadiness = await waitForRequiredMcpServerBeforePrompt(thisTurnDeferred, promptSessionId);
      if (requiredMcpReadiness === null) {
        throwPromptNotDispatched('required Happier MCP readiness ended before prompt_async');
      } else if (requiredMcpReadiness.status === 'failed') {
        const detail = requiredMcpReadiness.error instanceof Error
          ? requiredMcpReadiness.error.message
          : formatErrorForUi(requiredMcpReadiness.error, { maxChars: 1_000 }).trim();
        throwPromptNotDispatched(
          `required Happier MCP registration failed${detail ? `: ${detail}` : ''}`,
        );
      }

      const controlAbort = new AbortController();
      turnControlAbort = controlAbort;
      const deadlockGuardLoop = runTurnDeadlockGuard(controlAbort.signal).catch((error) => {
        logger.debug('[OpenCodeServer] turn deadlock guard failed (non-fatal)', error);
      });
      let prePromptMessageIdsForBackfill: Set<string> | null = null;

      if (controlAbort.signal.aborted) {
        // Abort handling (runtime.cancel) will reject the turn; do not attempt to send another prompt.
        await awaitPreDispatchTurnSettlement(thisTurnDeferred, 'control abort fired before prompt_async');
      }
      let model: OpenCodeModelRef | undefined;
      try {
        model = await resolvePromptModelOverride(paramsWithMeta.meta);
      } catch (error) {
        setThinking(false);
        await flushAndClearStreamWriters({
          reason: 'abort',
          interruptedReason: 'provider_session_error',
        });
        surfaceOpenCodeRuntimeFailure('session_error', error);
        rejectTurn(error);
        throw error;
      }

      if (!isActivePromptTurn(thisTurnDeferred, promptSessionId)) {
        await awaitPreDispatchTurnSettlement(thisTurnDeferred, 'active prompt turn ended before prompt_async');
      }

      try {
        const raw = c.sessionMessagesListRaw
          ? await c.sessionMessagesListRaw({ sessionId: promptSessionId })
          : await c.sessionMessagesList({ sessionId: promptSessionId });
        if (!Array.isArray(raw)) throw new Error('OpenCode session message inventory was malformed');
        const items = raw;
        const ids: string[] = [];
        for (const row of items) {
          const id = extractOpenCodeSessionMessageId(row);
          if (id) ids.push(id);
        }
        prePromptMessageIdsForBackfill = new Set<string>(ids);
        turnPrePromptMessageIdsAll = prePromptMessageIdsForBackfill;
        const tail = ids.length > turnPreexistingSnapshotLimit ? ids.slice(ids.length - turnPreexistingSnapshotLimit) : ids;
        turnPreexistingMessageIds = new Set<string>(tail);
      } catch {
        // Best-effort: fall back to turnPromptActive-only gating.
        turnPreexistingMessageIds = null;
        turnPrePromptMessageIdsAll = null;
      }

      if (!isActivePromptTurn(thisTurnDeferred, promptSessionId)) {
        await awaitPreDispatchTurnSettlement(thisTurnDeferred, 'active prompt turn ended before prompt_async');
      }

      try {
        const promptAsyncPromise = c.sessionPromptAsync({
          sessionId: promptSessionId,
          messageId: messageID,
          agent,
          model,
          ...promptOptions,
          parts: [{ type: 'text', text: effectiveText }],
        });
        const promptAsyncOutcome = await Promise.race([
          promptAsyncPromise.then(
            () => ({ type: 'prompt_resolved' as const }),
            (error: unknown) => ({ type: 'prompt_rejected' as const, error }),
          ),
          thisTurnDeferred.promise.then(
            () => ({ type: 'turn_resolved' as const }),
            (error: unknown) => ({ type: 'turn_rejected' as const, error }),
          ),
        ]);
        if (promptAsyncOutcome.type === 'turn_rejected') {
          await deadlockGuardLoop.catch(() => {});
          throw promptAsyncOutcome.error;
        }
        if (promptAsyncOutcome.type === 'turn_resolved') {
          await deadlockGuardLoop.catch(() => {});
          if (paramsWithMeta.onProviderPromptSubmitted) {
            throw new ProviderPromptSubmissionUnconfirmedError();
          }
          return;
        }
        if (promptAsyncOutcome.type === 'prompt_rejected') {
          throw promptAsyncOutcome.error;
        }
      } catch (error) {
        if (!turnDeferred) {
          throw error;
        }
        setThinking(false);
        await flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'prompt_async_error' });
        if (isAbortLikeError(error)) {
          params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: ensureActiveLifecycleMarkerId() });
        } else {
          surfaceOpenCodeRuntimeFailure('stream_error', error);
        }
        rejectTurn(error);
        throw error;
      }
      await paramsWithMeta.onProviderPromptSubmitted?.();
      paramsWithMeta.onProviderPromptAccepted?.();
      if (shouldOmitCustomMessageId && !turnUserMessageId) {
        const vendorAssignedUserMessageId = await backfillVendorAssignedUserMessageIdBestEffort({
          localIdRaw: paramsWithMeta.localId ?? null,
          promptText: paramsWithMeta.text,
          promptTextAlternates: [effectiveText],
          prePromptMessageIds: prePromptMessageIdsForBackfill,
        });
        if (
          vendorAssignedUserMessageId
          && isActivePromptTurn(thisTurnDeferred, promptSessionId)
        ) {
          turnUserMessageId = vendorAssignedUserMessageId;
          noteUserMessageIdForActiveTurn(vendorAssignedUserMessageId);
        }
      }

      const pollControlPlaneOnce = async () => {
        if (controlAbort.signal.aborted) return;
        try {
          await pollIdleStatusFromControlPlaneBestEffort();
        } catch (error) {
          logger.debug('[OpenCodeServer] status polling step failed (non-fatal)', {
            sessionId,
            error,
          });
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
        await deadlockGuardLoop.catch(() => {});
      }
    },

    async compactContext(command: string): Promise<void> {
      if (!sessionId) throw new Error('OpenCode server session was not started');
      const c = await ensureClient();
      const model = await resolveCompactionModel(c);
      manualCompactionSequence += 1;
      const manualCompaction = {
        lifecycleId: `opencode:context-compaction:${sessionId}:manual:${manualCompactionSequence}`,
        terminalObserved: false,
      };
      activeManualCompaction = manualCompaction;
      compactionInProgress = true;
      turnPromptActive = true;
      turnActivitySeen = false;
      managedServerTurnSupervisor?.captureTurnStartGeneration();
      idleSignalSeen = false;
      idleSignalSeenViaControlPlane = false;
      turnUserMessageId = null;
      turnPromptLocalId = null;
      turnPromptTextForBackfill = command;
      turnPromptEffectiveTextForBackfill = command;
      turnPrePromptMessageIdsAll = null;
      turnPreexistingMessageIds = null;

      sendContextCompactionEvent({
        type: 'context-compaction',
        phase: 'started',
        provider: 'opencode',
        source: 'user-command',
        trigger: 'manual',
        lifecycleId: manualCompaction.lifecycleId,
        providerSessionId: sessionId,
      });

      try {
        await c.sessionSummarize({ sessionId, model, auto: false });
        if (!manualCompaction.terminalObserved) {
          sendContextCompactionEvent({
            type: 'context-compaction',
            phase: 'completed',
            provider: 'opencode',
            source: 'runtime',
            trigger: 'manual',
            lifecycleId: manualCompaction.lifecycleId,
            providerSessionId: sessionId,
          });
        }
      } catch (error) {
        if (!manualCompaction.terminalObserved) {
          const sanitizedErrorPreview = formatErrorForUi(error, { maxChars: 1_000 }).trim();
          sendContextCompactionEvent({
            type: 'context-compaction',
            phase: 'failed',
            provider: 'opencode',
            source: 'runtime',
            trigger: 'manual',
            lifecycleId: manualCompaction.lifecycleId,
            providerSessionId: sessionId,
            ...(sanitizedErrorPreview ? { sanitizedErrorPreview } : {}),
          });
        }
        setThinking(false);
        await flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'compact_context_error' });
        rejectTurn(error);
        throw error;
      } finally {
        if (activeManualCompaction === manualCompaction) {
          activeManualCompaction = null;
        }
        compactionInProgress = false;
      }
    },

    flushTurn(): void {
      turnInFlight = false;
      setThinking(false);
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      const cancelledSessionId = sessionId;
      const cancelledProviderTurnId =
        turnInFlight || turnDeferred || turnPromptActive || activeLifecycleMarkerId
          ? ensureActiveLifecycleMarkerId()
          : null;
      const c = await ensureClient();
      const suppressionGeneration = armSessionAbortErrorSuppression(cancelledSessionId);
      const abortPromise = c.sessionAbort({ sessionId: cancelledSessionId });

      try {
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
      } finally {
        clearSessionAbortErrorSuppression(cancelledSessionId, suppressionGeneration);
      }

      setThinking(false);
      await flushAndClearStreamWriters({ reason: 'abort', interruptedReason: 'cancelled' });
      if (cancelledProviderTurnId) {
        await surfacePrimarySessionRuntimeIssue({
          cause: 'cancelled',
          provider,
          providerTurnId: cancelledProviderTurnId,
          session: params.session,
        }).catch((error) => {
          logger.debug('[opencode] Failed to persist explicit turn cancellation (non-fatal)', error);
        });
      }
      rejectTurn(new Error('OpenCode session aborted'));
      resetRuntimeState();
      foregroundToolTracker.resetForProviderSession(cancelledSessionId);
    },

    async reset(): Promise<void> {
      rejectTurn(new Error('OpenCode runtime reset'));
      resetRuntimeState();
      connectedBrokerPreflight = null;
      resetServerConnectedReadiness();
      setThinking(false);
      sessionId = null;
      foregroundToolTracker.resetForProviderSession(null);
      selectedAgent = null;
      selectedModel = null;
      currentContextWindowTokens = null;
      omitCustomMessageIdForResumedSession = false;
      suppressSessionErrorAbortNotificationForSessionId = null;
      for (const key of Object.keys(configOverrides)) delete configOverrides[key];
      invalidateMcpServersForCurrentDirectory();
      mcpServerRegistrationRerunRequested = false;
      if (ensuredMcpServerNames.size > 0) {
        try {
          const c = await ensureClient();
          const names = [...ensuredMcpServerNames];
          ensuredMcpServerNames.clear();
      selectedModelWasQualifiedOverride = false;
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
      selectedModel = await resolveModelOverride(trimmed);
      publishDynamicSessionOptionsBestEffort();
    },
  };
}
        selectedModelWasQualifiedOverride = false;
      selectedModelWasQualifiedOverride = parseOpenCodeModelId(trimmed) !== null;
