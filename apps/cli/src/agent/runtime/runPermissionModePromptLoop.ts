import { RuntimeEventV1Schema, validatePluginHookPayloadV1, type SessionPendingQueueDeliveryTiming } from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolveAppendSystemPromptBaseOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import {
  isRuntimeTurnFailureAlreadySurfaced,
  type RuntimeTurnOperations,
  type RuntimeTurnPromptMeta,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  initializePermissionModeStateSync,
} from '@/agent/runtime/permissions/modeStateSync';
import { waitForNextPermissionModeMessage } from '@/agent/runtime/waitForNextPermissionModeMessage';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import {
  normalizePermissionModeQueuedPromptLocalIds,
  normalizePermissionModeQueuedPromptProviderClaimedPendingLocalIds,
  normalizePermissionModeQueuedPromptUserMessageSeqs,
  readHighestPermissionModeQueuedPromptUserMessageSeq,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  resolveProviderPromptWithReplaySeed,
} from '@/agent/runtime/replaySeed/replaySeedV1';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import {
  createSessionProviderPendingDrainAdapter,
  PendingQueueMaterializationAuthError,
} from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { DrainPendingResult, MessageBatch } from '@/agent/runtime/session/input/_types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/session/metadataWaitRetryBackoff';
import {
  beginAssistantTextSnapshotTurnScope,
  completeAssistantTextSnapshotTurnScope,
  resetAssistantTextSnapshotTurnScope,
  type AssistantTextSnapshotTurnScope,
} from '@/agent/runtime/turns/assistantTextSnapshotTurnScope';
import {
  readProviderAcceptedUserMessageSeqV1,
  readUserMessageDeliveryWatermarkModeV1,
} from '@/api/session/deliveredUserMessageSeq';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

export type PermissionModePromptLoopTurnOperations = RuntimeTurnOperations & Readonly<{
  compactContext?: (command: string) => Promise<void>;
  sendPromptWithMeta?: (params: {
    text: string;
  } & RuntimeTurnPromptMeta) => Promise<void>;
  sendTurnPrompt: (
    prompt: string,
    meta?: RuntimeTurnPromptMeta,
  ) => Promise<void>;
  shouldResumeAfterPermissionModeChange?: () => boolean;
}>;

type PermissionModePromptLoopExitResult = Readonly<{
  type: 'exit';
  code?: number | null;
}>;

export type PromptLoopOverrideSynchronizer = Readonly<{
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
}>;

export type PromptLoopPermissionHandler = Readonly<
  Pick<ProviderEnforcedPermissionHandler, 'reset' | 'setPermissionMode'>
>;

type QueuedPermissionModeMessage = {
  message: PermissionModeQueuedPrompt;
  mode: {
    permissionMode: PermissionMode;
    appendSystemPrompt?: string | null;
    model?: string;
    suppressUserEcho?: boolean;
    providerPromptAlreadyResolved?: boolean;
  };
  hash: string;
};

export type PromptLoopResetReason =
  | 'mode_change'
  | 'clear'
  | 'resume_fallback'
  | 'strict_initial_resume_failure';

export type PromptLoopBoundaryReason =
  | 'turn_completed'
  | 'mode_change_reset'
  | 'clear_reset';

export type PromptLoopCheckpointLifecycle = Readonly<{
  onBeforePromptDispatch?: (params: Readonly<{
    messageId: string;
    prompt: string;
  }>) => void | Promise<void>;
  onTurnStarted?: (params: Readonly<{
    messageId: string;
    turnId: string;
  }>) => void | Promise<void>;
  onTurnFinal?: (params: Readonly<{
    messageId: string;
    turnId: string;
    status: 'completed' | 'aborted' | 'interrupted' | 'unknown';
  }>) => void | Promise<void>;
  onTurnAbortedBeforeStart?: (params: Readonly<{
    messageId: string;
  }>) => void | Promise<void>;
  onSessionEnd?: () => void | Promise<void>;
}>;

type CheckpointRuntimeMessage = Readonly<{
  type?: unknown;
  id?: unknown;
  reason?: unknown;
}>;

type PromptLoopStatusPublisherOptions = Readonly<{
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  messageBuffer: MessageBuffer;
  session: ApiSessionClient;
}>;

class StrictInitialResumeError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'StrictInitialResumeError';
    this.cause = cause;
  }
}

function isPermissionModePromptLoopExitResult(value: unknown): value is PermissionModePromptLoopExitResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.type === 'exit';
}

async function parkAfterPendingMaterializationAuthFailure(params: Readonly<{
  messageQueue: MessageQueue2<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt>;
  session: ApiSessionClient;
  abortSignal: AbortSignal;
}>): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(params.abortSignal.reason);
  params.abortSignal.addEventListener('abort', onAbort, { once: true });
  if (params.abortSignal.aborted) controller.abort(params.abortSignal.reason);

  try {
    const winner = await Promise.race([
      params.messageQueue.waitForMessagesSignal(controller.signal).then(() => 'queue' as const),
      params.session.waitForMetadataUpdate(controller.signal).then((ok) => ok ? 'metadata' as const : 'metadata-unavailable' as const),
    ]);
    controller.abort('permission-mode-auth-park-wake');
    if (winner === 'metadata-unavailable' && !params.abortSignal.aborted) {
      await waitForSessionMetadataRetryBackoff({
        abortSignal: params.abortSignal,
        backoffMs: DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
      });
    }
  } finally {
    params.abortSignal.removeEventListener('abort', onAbort);
    controller.abort('permission-mode-auth-park-dispose');
  }
}

function readCheckpointRuntimeMessage(message: unknown): CheckpointRuntimeMessage | null {
  const parsedRuntimeEvent = RuntimeEventV1Schema.safeParse(message);
  if (parsedRuntimeEvent.success) {
    const runtimeEvent = parsedRuntimeEvent.data;
    switch (runtimeEvent.kind) {
      case 'turn-start':
        return { type: 'task_started', id: runtimeEvent.turnId };
      case 'turn-complete':
        return { type: 'task_complete', id: runtimeEvent.turnId };
      case 'turn-cancelled':
        return { type: 'turn_aborted', id: runtimeEvent.turnId, reason: runtimeEvent.reason };
      case 'turn-failed':
        return { type: 'turn_failed', id: runtimeEvent.turnId };
      default:
        return null;
    }
  }
  return message && typeof message === 'object' ? message as CheckpointRuntimeMessage : null;
}

function readCheckpointTurnId(message: CheckpointRuntimeMessage): string | null {
  return typeof message.id === 'string' && message.id.trim().length > 0 ? message.id : null;
}

function readCommittedUserMessageSeq(message: PermissionModeQueuedPrompt): number | null {
  return readHighestPermissionModeQueuedPromptUserMessageSeq(message);
}

function readQueuedModelOverride(mode: QueuedPermissionModeMessage['mode']): string | null {
  const model = typeof mode.model === 'string' ? mode.model.trim() : '';
  return model.length > 0 ? model : null;
}

type QueuedPromptDeliveryIdentity = Readonly<{
  localIds: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;

function readQueuedPromptDeliveryIdentity(message: PermissionModeQueuedPrompt): QueuedPromptDeliveryIdentity {
  return {
    localIds: normalizePermissionModeQueuedPromptLocalIds(message),
    userMessageSeq: readCommittedUserMessageSeq(message),
    userMessageSeqs: normalizePermissionModeQueuedPromptUserMessageSeqs(message),
  };
}

function hasQueuedPromptDeliveryIdentity(identity: QueuedPromptDeliveryIdentity): boolean {
  return identity.localIds.length > 0 || identity.userMessageSeq !== null || identity.userMessageSeqs.length > 0;
}

function confirmLocallyConsumedPrompt(session: ApiSessionClient, message: PermissionModeQueuedPrompt): void {
  const identity = readQueuedPromptDeliveryIdentity(message);
  if (!hasQueuedPromptDeliveryIdentity(identity)) return;
  session.confirmUserMessageLocallyConsumed?.(identity);
}

function normalizeUserMessageDeliverySeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readProviderAcceptedUserMessageSeq(session: ApiSessionClient): number | null {
  const metadata = session.getMetadataSnapshot() as Readonly<Record<string, unknown>> | null;
  const watermarkMode = readUserMessageDeliveryWatermarkModeV1(metadata);

  if (watermarkMode === 'providerAcceptance') {
    return normalizeUserMessageDeliverySeq(session.getProviderAcceptedUserMessageSeq?.())
      ?? readProviderAcceptedUserMessageSeqV1(metadata);
  }

  if (typeof session.getProviderAcceptedUserMessageSeq === 'function') {
    return normalizeUserMessageDeliverySeq(session.getProviderAcceptedUserMessageSeq());
  }

  return readProviderAcceptedUserMessageSeqV1(metadata);
}

function readPendingQueueMaterializedLocalIds(
  session: ApiSessionClient,
  message: PermissionModeQueuedPrompt,
): string[] {
  const hasPendingQueueMaterializedLocalId =
    (session as ApiSessionClient & { hasPendingQueueMaterializedLocalId?: (localId: string) => boolean })
      .hasPendingQueueMaterializedLocalId;
  if (typeof hasPendingQueueMaterializedLocalId !== 'function') return [];
  return normalizePermissionModeQueuedPromptLocalIds(message)
    .filter((localId) => hasPendingQueueMaterializedLocalId.call(session, localId));
}

function readQueuedLocalIdsNeedingCommittedBoundary(
  message: PermissionModeQueuedPrompt,
): string[] {
  const providerClaimedLocalIds = new Set(
    normalizePermissionModeQueuedPromptProviderClaimedPendingLocalIds(message),
  );
  return normalizePermissionModeQueuedPromptLocalIds(message)
    .filter((localId) => !providerClaimedLocalIds.has(localId));
}

function isQueuedPromptPendingQueueMaterialized(session: ApiSessionClient, message: PermissionModeQueuedPrompt): boolean {
  return readPendingQueueMaterializedLocalIds(session, message).length > 0;
}

function isLocalSpecialCommandPrompt(message: PermissionModeQueuedPrompt, mode?: QueuedPermissionModeMessage['mode']): boolean {
  if (mode?.providerPromptAlreadyResolved === true) return false;
  return parseSpecialCommand(message.text).type !== null;
}

function isQueuedPromptAlreadyLocallyConsumed(
  session: ApiSessionClient,
  message: PermissionModeQueuedPrompt,
  mode?: QueuedPermissionModeMessage['mode'],
): boolean {
  if (!isLocalSpecialCommandPrompt(message, mode)) return false;
  const hasUserMessageLocalConsumption = session.hasUserMessageLocalConsumption;
  if (typeof hasUserMessageLocalConsumption !== 'function') return false;
  const identity = readQueuedPromptDeliveryIdentity(message);
  if (!hasQueuedPromptDeliveryIdentity(identity)) return false;
  return hasUserMessageLocalConsumption.call(session, identity);
}

function isQueuedPromptAlreadyAcceptedByProvider(
  session: ApiSessionClient,
  message: PermissionModeQueuedPrompt,
): boolean {
  const hasUserMessageProviderAcceptance = session.hasUserMessageProviderAcceptance;
  if (typeof hasUserMessageProviderAcceptance !== 'function') return false;
  const identity = readQueuedPromptDeliveryIdentity(message);
  if (!hasQueuedPromptDeliveryIdentity(identity)) return false;
  return hasUserMessageProviderAcceptance.call(session, identity);
}

function isQueuedPromptAlreadyDelivered(
  session: ApiSessionClient,
  message: PermissionModeQueuedPrompt,
  mode?: QueuedPermissionModeMessage['mode'],
): boolean {
  if (isQueuedPromptAlreadyLocallyConsumed(session, message, mode)) return true;
  if (isQueuedPromptAlreadyAcceptedByProvider(session, message)) return true;
  if (isQueuedPromptPendingQueueMaterialized(session, message)) return false;
  const deliveredSeq = readProviderAcceptedUserMessageSeq(session);
  if (deliveredSeq === null) return false;
  const seqs = normalizePermissionModeQueuedPromptUserMessageSeqs(message);
  if (seqs.length === 0) return false;
  return seqs.every((seq) => seq <= deliveredSeq);
}

function discardDeliveredQueuedPrompts(params: Readonly<{
  session: ApiSessionClient;
  messageQueue: MessageQueue2<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt>;
}>): number {
  return params.messageQueue.discardMatching((message, mode) =>
    isQueuedPromptAlreadyDelivered(params.session, message, mode),
  );
}

function mapCheckpointFinalStatus(message: CheckpointRuntimeMessage): 'completed' | 'aborted' | 'interrupted' | 'unknown' {
  if (message.type === 'task_complete') return 'completed';
  if (message.type === 'turn_failed') return 'aborted';
  if (message.type === 'turn_aborted') {
    return typeof message.reason === 'string' && /\b(interrupted|interrupt|user)\b/i.test(message.reason)
      ? 'interrupted'
      : 'aborted';
  }
  return 'unknown';
}

async function runCheckpointHook(fn: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch {
    // Checkpoint evidence is best-effort and must not block turn lifecycle.
  }
}

function normalizePositiveSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function readEagerPendingDrainFailureMessage(result: DrainPendingResult): string | null {
  if (result.stoppedReason === 'auth_failure') {
    return 'Pending prompts could not be restored after startup because session authentication failed; reconnect and retry.';
  }
  if (result.stoppedReason === 'error') {
    return 'Pending prompts could not be restored after startup; please retry once the session is reachable.';
  }
  return null;
}

function publishPromptLoopStatus(
  opts: PromptLoopStatusPublisherOptions,
  message: string,
): void {
  opts.messageBuffer.addMessage(message, 'status');
  opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message });
}

async function waitForCommittedUserPromptBoundary(
  session: ApiSessionClient,
  localId: string | null,
): Promise<number | null> {
  const trimmedLocalId = typeof localId === 'string' ? localId.trim() : '';
  if (!trimmedLocalId) return null;

  const syncSeq = normalizePositiveSeq(session.getCommittedUserMessageSeq?.(trimmedLocalId));
  if (syncSeq !== null) return syncSeq;

  return normalizePositiveSeq(await session.waitForCommittedUserMessageSeq?.(trimmedLocalId, {
    timeoutMs: configuration.promptLoopUserMessageSeqWaitTimeoutMs,
    pollMs: configuration.promptLoopUserMessageSeqWaitPollMs,
  }));
}

async function waitForCommittedUserPromptBoundaries(
  session: ApiSessionClient,
  localIds: readonly string[],
): Promise<number[]> {
  const seqs: number[] = [];
  for (const localId of localIds) {
    const seq = await waitForCommittedUserPromptBoundary(session, localId);
    if (seq !== null && !seqs.includes(seq)) {
      seqs.push(seq);
    }
  }
  return seqs;
}

function hasCommittedUserPromptBoundaryApi(session: ApiSessionClient): boolean {
  return typeof session.getCommittedUserMessageSeq === 'function'
    || typeof session.waitForCommittedUserMessageSeq === 'function';
}

function areQueuedLocalPromptBoundariesResolved(params: Readonly<{
  session: ApiSessionClient;
  localIds: readonly string[];
  queuedSeqs: readonly number[];
  committedSeqs: readonly number[];
}>): boolean {
  if (params.localIds.length === 0) return true;
  if (!hasCommittedUserPromptBoundaryApi(params.session)) return true;

  const resolvedSeqs = new Set<number>();
  for (const seq of params.queuedSeqs) {
    resolvedSeqs.add(seq);
  }
  for (const seq of params.committedSeqs) {
    resolvedSeqs.add(seq);
  }
  return resolvedSeqs.size >= params.localIds.length;
}

function shouldWaitForQueuedPromptCommittedBoundaries(params: Readonly<{
  session: ApiSessionClient;
  localIdsNeedingCommittedBoundary: readonly string[];
  queuedSeqs: readonly number[];
}>): boolean {
  if (params.localIdsNeedingCommittedBoundary.length === 0) return false;
  if (!hasCommittedUserPromptBoundaryApi(params.session)) return false;
  return params.queuedSeqs.length < params.localIdsNeedingCommittedBoundary.length;
}

function requeueAfterCommittedUserPromptBoundaryMiss(
  message: QueuedPermissionModeMessage,
): QueuedPermissionModeMessage {
  return {
    ...message,
    mode: {
      ...message.mode,
      suppressUserEcho: true,
    },
  };
}

function readAgentContextMessageContentText(message: unknown): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  const content = (message as Readonly<Record<string, unknown>>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.flatMap((part) => (
    part && typeof part === 'object' && !Array.isArray(part) && typeof (part as Readonly<Record<string, unknown>>).text === 'string'
      ? [(part as Readonly<Record<string, string>>).text]
      : []
  )).join('');
  return text.length > 0 ? text : null;
}

function renderAgentContextMessagesPrompt(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  const parts = messages.flatMap((message) => {
    const text = readAgentContextMessageContentText(message);
    return text !== null && text.length > 0 ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n\n') : null;
}

async function transformAgentContextPromptBeforeDispatch(params: Readonly<{
  transformAgentContextBeforeDispatch?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  sessionId: string;
  agentId: string;
  prompt: string;
  timestampMs: number;
}>): Promise<string> {
  if (!params.transformAgentContextBeforeDispatch) {
    return params.prompt;
  }
  try {
    const transformed = await params.transformAgentContextBeforeDispatch({
      sessionId: params.sessionId,
      agentId: params.agentId,
      runtimeFamily: 'hostSession',
      prompt: params.prompt,
      messages: [{ role: 'user', content: params.prompt }],
      timestampMs: params.timestampMs,
    });
    const validation = validatePluginHookPayloadV1({
      hookId: 'agent.context.before',
      payload: transformed,
    });
    if (!validation.success) {
      logger.debug('[plugins] agent.context.before returned an invalid payload; using original provider prompt', {
        error: validation.message,
      });
      return params.prompt;
    }
    if (!transformed || typeof transformed !== 'object' || Array.isArray(transformed)) {
      return params.prompt;
    }
    const transformedPrompt = typeof transformed.prompt === 'string' ? transformed.prompt : params.prompt;
    if (transformedPrompt !== params.prompt) {
      return transformedPrompt;
    }
    return renderAgentContextMessagesPrompt(transformed.messages) ?? transformedPrompt;
  } catch (error) {
    logger.debug('[plugins] agent.context.before failed; using original provider prompt', { error });
    return params.prompt;
  }
}

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<{
    permissionMode: PermissionMode;
    appendSystemPrompt?: string | null;
    model?: string;
    suppressUserEcho?: boolean;
  }, PermissionModeQueuedPrompt>;
  permissionHandler: PromptLoopPermissionHandler;
  runtime: PermissionModePromptLoopTurnOperations;
  createOverrideSynchronizer: (isStarted: () => boolean) => PromptLoopOverrideSynchronizer;
  messageBuffer: MessageBuffer;
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal;
  keepAlive: () => void;
  setThinking: (value: boolean) => void;
  sendReady: () => void;
  currentPermissionModeUpdatedAt: number;
  setCurrentPermissionMode: (mode: PermissionMode) => void;
  setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
  initialResumeId?: string;
  strictInitialResume?: boolean;
  startRuntimeBeforeFirstPrompt?: boolean;
  onAfterStart?: (() => void | Promise<void>) | null;
  onBeforeReset?: ((params: { reason: PromptLoopResetReason }) => void | Promise<void>) | null;
  onAfterReset?: ((params: { reason: PromptLoopResetReason }) => void | Promise<void>) | null;
  onAfterLoopBoundary?: ((params: { reason: PromptLoopBoundaryReason }) => void | Promise<void>) | null;
  checkpointLifecycle?: PromptLoopCheckpointLifecycle | null;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  pendingQueueDrainMaxPopPerWake?: number;
  pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  resolveFreshSessionSystemPrompt?: (args: {
    baseOverride?: string | null;
  }) => Promise<string | null | undefined>;
  transformAgentContextBeforeDispatch?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let wasStarted = false;
  let currentModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
  let storedSessionIdForResume: { value: string; origin: 'initial' | 'restart' } | null = null;
  let turnInFlight = false;
  let pendingFreshSessionSystemPrompt = false;
  let runtimePermissionModeApplied: PermissionMode | null = null;
  let activeCheckpointMessageId: string | null = null;
  let activeCheckpointTurnId: string | null = null;
  let activeCheckpointFinalStatus: 'completed' | 'aborted' | 'interrupted' | 'unknown' = 'unknown';
  let snapshotFreshForNextPromptBoundary = false;
  const pendingQueueDrainMaxPopPerWake = Math.max(
    1,
    Math.trunc(opts.pendingQueueDrainMaxPopPerWake ?? PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE),
  );

  const unsubscribeCheckpointRuntimeMessages = (() => {
    if (!opts.checkpointLifecycle) return () => undefined;
    try {
      return opts.runtime.subscribeRuntimeEvents((rawMessage) => {
        const message = readCheckpointRuntimeMessage(rawMessage);
        if (!message || typeof message.type !== 'string') return;
        const messageId = activeCheckpointMessageId;
        if (!messageId) return;
        const turnId = readCheckpointTurnId(message);
        if (message.type === 'task_started' && turnId) {
          activeCheckpointTurnId = turnId;
          void runCheckpointHook(() => opts.checkpointLifecycle?.onTurnStarted?.({ messageId, turnId }));
          return;
        }
        if (
          (message.type === 'task_complete' || message.type === 'turn_aborted' || message.type === 'turn_failed')
          && turnId
        ) {
          activeCheckpointTurnId = activeCheckpointTurnId ?? turnId;
          activeCheckpointFinalStatus = mapCheckpointFinalStatus(message);
        }
      });
    } catch {
      return () => undefined;
    }
  })();

  const normalizedResumeId = typeof opts.initialResumeId === 'string' ? opts.initialResumeId.trim() : '';
  if (normalizedResumeId) {
    storedSessionIdForResume = { value: normalizedResumeId, origin: 'initial' };
    snapshotFreshForNextPromptBoundary = opts.session.getMetadataSnapshot() !== null;
  }

  const overrideSync = opts.createOverrideSynchronizer(() => wasStarted);

  const permissionModeStateSync = await initializePermissionModeStateSync({
    explicitPermissionMode: opts.explicitPermissionMode,
    session: opts.session,
    currentPermissionModeUpdatedAt: opts.currentPermissionModeUpdatedAt,
    take: 50,
    applyMode: ({ mode, updatedAt }) => {
      opts.setCurrentPermissionMode(mode);
      opts.setCurrentPermissionModeUpdatedAt(updatedAt);
      opts.permissionHandler.setPermissionMode(mode);
    },
  });
  opts.setCurrentPermissionModeUpdatedAt(permissionModeStateSync.permissionModeUpdatedAt);

  const syncPermissionModeFromMetadata = () => {
    const updatedAt = permissionModeStateSync.syncFromMetadata(opts.session.getMetadataSnapshot());
    opts.setCurrentPermissionModeUpdatedAt(updatedAt);
  };

  const refreshSessionSnapshotBeforeTurnBestEffort = async (): Promise<void> => {
    if (typeof opts.session.refreshSessionSnapshotFromServerBestEffort === 'function') {
      try {
        await opts.session.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });
        snapshotFreshForNextPromptBoundary = true;
      } catch {
        // Best-effort only: prompt delivery must not block on snapshot refresh failures.
      }
      return;
    }
    if (typeof opts.session.ensureMetadataSnapshot === 'function') {
      try {
        await opts.session.ensureMetadataSnapshot();
        snapshotFreshForNextPromptBoundary = true;
      } catch {
        // Best-effort only.
      }
    }
  };

  const ensureFreshSessionSnapshotBeforeTurnBestEffort = async (): Promise<void> => {
    if (snapshotFreshForNextPromptBoundary) {
      return;
    }
    await refreshSessionSnapshotBeforeTurnBestEffort();
  };

  overrideSync.syncFromMetadata();

  const ensureRuntimeStarted = async (): Promise<{ startedFreshSessionForTurn: boolean; exitRequested: boolean }> => {
    if (wasStarted) return { startedFreshSessionForTurn: false, exitRequested: false };

    const resume = storedSessionIdForResume;
    const resumeId = typeof resume?.value === 'string' ? resume.value.trim() : '';
    let strictAbort: StrictInitialResumeError | null = null;
    let startedFreshSessionForTurn = false;

    if (resumeId) {
      storedSessionIdForResume = null; // consume once
      opts.messageBuffer.addMessage('Resuming previous context…', 'status');
      try {
        // Avoid importing ACP replay history into Happier on normal resume; Happier transcript is the source of truth.
        const startResult = await opts.runtime.startOrLoadSession({ resumeId, importHistory: false });
        if (isPermissionModePromptLoopExitResult(startResult)) {
          return { startedFreshSessionForTurn: false, exitRequested: true };
        }
      } catch (error) {
        const shouldFailClosed =
          opts.strictInitialResume === true && resume?.origin === 'initial';
        if (shouldFailClosed) {
          const formatted = opts.formatPromptErrorMessage(error);
          opts.messageBuffer.addMessage(`Resume failed; cannot continue: ${formatted}`, 'status');
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: `Resume failed; cannot continue: ${formatted}` });
          try {
            await opts.onBeforeReset?.({ reason: 'strict_initial_resume_failure' });
            await opts.runtime.resetOrDisposeRuntime();
            runtimePermissionModeApplied = null;
            await opts.onAfterReset?.({ reason: 'strict_initial_resume_failure' });
          } catch {
            // ignore cleanup failure
          }
          strictAbort = new StrictInitialResumeError('Strict initial resume failed', error);
        } else {
          opts.messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: 'Resume failed; starting a new session.' });
          await opts.onBeforeReset?.({ reason: 'resume_fallback' });
          await opts.runtime.resetOrDisposeRuntime();
          runtimePermissionModeApplied = null;
          await opts.onAfterReset?.({ reason: 'resume_fallback' });
          const startResult = await opts.runtime.startOrLoadSession({});
          if (isPermissionModePromptLoopExitResult(startResult)) {
            return { startedFreshSessionForTurn: false, exitRequested: true };
          }
          startedFreshSessionForTurn = true;
        }
      }
    } else {
      const startResult = await opts.runtime.startOrLoadSession({});
      if (isPermissionModePromptLoopExitResult(startResult)) {
        return { startedFreshSessionForTurn: false, exitRequested: true };
      }
      startedFreshSessionForTurn = true;
    }

    if (strictAbort) throw strictAbort;

    await opts.onAfterStart?.();
    wasStarted = true;
    await overrideSync.flushPendingAfterStart();
    if (!snapshotFreshForNextPromptBoundary) {
      await refreshSessionSnapshotBeforeTurnBestEffort();
    }
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    return { startedFreshSessionForTurn, exitRequested: false };
  };

  try {
    if ((opts.startRuntimeBeforeFirstPrompt === true || normalizedResumeId.length > 0) && !wasStarted) {
      if (!snapshotFreshForNextPromptBoundary) {
        await refreshSessionSnapshotBeforeTurnBestEffort();
      }
      overrideSync.syncFromMetadata();
      const eagerStart = await ensureRuntimeStarted();
      if (eagerStart.exitRequested) return;
      const materializeNextPendingMessageSafely = opts.session.materializeNextPendingMessageSafely;
      const pendingDrainResult = await createSessionProviderPendingDrainAdapter({
        waitForMetadataUpdate: async () => false,
        getMetadataSnapshot: () => opts.session.getMetadataSnapshot(),
        popPendingMessage: () => opts.session.popPendingMessage(),
        ...(materializeNextPendingMessageSafely
          ? {
              materializeNextPendingMessageSafely: (materializeOpts) =>
                materializeNextPendingMessageSafely.call(opts.session, materializeOpts),
            }
          : {}),
        shouldAttemptPendingMaterialization: (attemptOpts) =>
          opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true,
        reconcilePendingQueueState: (reconcileOpts) => opts.session.reconcilePendingQueueState?.(reconcileOpts),
      }, { maxPopPerWake: pendingQueueDrainMaxPopPerWake }).drainPending({
        shouldContinue: async () => (await (opts.beforePendingMaterialize?.() ?? true)) !== false,
        logPrefix: `[${opts.providerName}]`,
        reason: 'permission-mode-eager-start',
        activeTurnDeliveryPolicy: 'allow_live_delivery',
        ...(opts.pendingQueueDeliveryTiming === 'after_runtime_idle' ? { deliveryTiming: 'after_runtime_idle' } : {}),
      });
      const pendingDrainFailureMessage = readEagerPendingDrainFailureMessage(pendingDrainResult);
      if (pendingDrainFailureMessage) {
        publishPromptLoopStatus(opts, pendingDrainFailureMessage);
      }
      pendingFreshSessionSystemPrompt = eagerStart.startedFreshSessionForTurn;
    }

    while (!opts.shouldExit()) {
    let message: QueuedPermissionModeMessage | null = pending;
    pending = null;

    if (!message) {
      let next: MessageBatch<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt> | null;
      try {
        next = await waitForNextPermissionModeMessage({
          messageQueue: opts.messageQueue,
          abortSignal: opts.getAbortSignal(),
          session: opts.session,
          beforeCollectQueuedBatch: () => {
            discardDeliveredQueuedPrompts({
              session: opts.session,
              messageQueue: opts.messageQueue,
            });
          },
          beforePendingMaterialize: opts.beforePendingMaterialize,
          onMetadataUpdate: async () => {
            await refreshSessionSnapshotBeforeTurnBestEffort();
            syncPermissionModeFromMetadata();
            overrideSync.syncFromMetadata();
            if (!turnInFlight) {
              await overrideSync.flushPendingAfterStart();
            }
          },
          pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
          pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
        });
      } catch (error) {
        if (!(error instanceof PendingQueueMaterializationAuthError)) throw error;
        logger.debug('[INPUT-CONSUMER] Parking permission-mode prompt loop after pending materialization auth failure');
        await parkAfterPendingMaterializationAuthFailure({
          messageQueue: opts.messageQueue,
          session: opts.session,
          abortSignal: opts.getAbortSignal(),
        });
        continue;
      }
      if (!next) continue;
      message = { message: next.message, mode: next.mode, hash: next.hash };
    }
    if (!message) continue;

    if (isQueuedPromptAlreadyDelivered(opts.session, message.message, message.mode)) {
      continue;
    }

    opts.permissionHandler.setPermissionMode(message.mode.permissionMode);

    if (wasStarted && currentModeHash && message.hash !== currentModeHash) {
      const resumeId = opts.runtime.readSessionIdentity().sessionId;
      currentModeHash = message.hash;
      const shouldResumeAfterPermissionModeChange =
        typeof opts.runtime.shouldResumeAfterPermissionModeChange === 'function'
          ? opts.runtime.shouldResumeAfterPermissionModeChange()
          : true;
      if (resumeId && shouldResumeAfterPermissionModeChange) {
        storedSessionIdForResume = { value: resumeId, origin: 'restart' };
      } else {
        storedSessionIdForResume = null;
      }

      opts.messageBuffer.addMessage(`Restarting ${opts.providerName} session (permission settings changed)…`, 'status');
      await opts.onBeforeReset?.({ reason: 'mode_change' });
      resetAssistantTextSnapshotTurnScope(opts.session, 'mode_change');
      await opts.runtime.resetOrDisposeRuntime();
      wasStarted = false;
      runtimePermissionModeApplied = null;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'mode_change' });
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();
      await opts.onAfterLoopBoundary?.({ reason: 'mode_change_reset' });

      pending = message;
      continue;
    }

    currentModeHash = message.hash;
    await ensureFreshSessionSnapshotBeforeTurnBestEffort();
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    await overrideSync.flushPendingAfterStart();
    if (!message.mode.suppressUserEcho) {
      opts.messageBuffer.addMessage(message.message.text, 'user');
    }

    const providerPromptAlreadyResolved = message.mode.providerPromptAlreadyResolved === true;
    const special = providerPromptAlreadyResolved
      ? { type: null } as const
      : parseSpecialCommand(message.message.text);
    if (special.type === 'clear') {
      opts.messageBuffer.addMessage(`Resetting ${opts.providerName} session…`, 'status');
      await opts.onBeforeReset?.({ reason: 'clear' });
      resetAssistantTextSnapshotTurnScope(opts.session, 'clear');
      await opts.runtime.resetOrDisposeRuntime();
      wasStarted = false;
      runtimePermissionModeApplied = null;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'clear' });
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      await opts.onAfterLoopBoundary?.({ reason: 'clear_reset' });
      confirmLocallyConsumedPrompt(opts.session, message.message);
      opts.sendReady();
      continue;
    }

    let shouldSendReady = true;
    let suppressFlushTurnFailure = false;
    let beganTurn = false;
    let handledPreTurnFailure = false;
    let currentCheckpointMessageId: string | null = null;
    let assistantTextSnapshotScope: AssistantTextSnapshotTurnScope | null = null;
    const providerClaimedPendingLocalIdsForTurn =
      normalizePermissionModeQueuedPromptProviderClaimedPendingLocalIds(message.message);
    let didAttemptProviderSend = false;
    try {
      turnInFlight = true;
      let shouldApplyFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt && !providerPromptAlreadyResolved;
      pendingFreshSessionSystemPrompt = false;
      const localIds = normalizePermissionModeQueuedPromptLocalIds(message.message);
      const localId = localIds[0] ?? null;
      currentCheckpointMessageId = localId ?? message.hash;
      if (!wasStarted) {
        const runtimeStart = await ensureRuntimeStarted();
        if (runtimeStart.exitRequested) {
          shouldSendReady = false;
          return;
        }
        shouldApplyFreshSessionSystemPrompt =
          !providerPromptAlreadyResolved
          && (runtimeStart.startedFreshSessionForTurn || shouldApplyFreshSessionSystemPrompt);
      }
      if (runtimePermissionModeApplied !== message.mode.permissionMode) {
        await opts.runtime.updateSessionRuntimeConfig({ permissionMode: message.mode.permissionMode });
        runtimePermissionModeApplied = message.mode.permissionMode;
      }
      const queuedModelOverride = readQueuedModelOverride(message.mode);
      const batchUserMessageSeqs = normalizePermissionModeQueuedPromptUserMessageSeqs(message.message);
      const localIdsNeedingCommittedBoundary = readQueuedLocalIdsNeedingCommittedBoundary(message.message);
      const shouldWaitForCommittedBoundaries = shouldWaitForQueuedPromptCommittedBoundaries({
        session: opts.session,
        localIdsNeedingCommittedBoundary,
        queuedSeqs: batchUserMessageSeqs,
      });
      const boundarySeqs = shouldWaitForCommittedBoundaries
        ? await waitForCommittedUserPromptBoundaries(opts.session, localIdsNeedingCommittedBoundary)
        : [];
      if (shouldWaitForCommittedBoundaries) {
        if (!areQueuedLocalPromptBoundariesResolved({
          session: opts.session,
          localIds: localIdsNeedingCommittedBoundary,
          queuedSeqs: batchUserMessageSeqs,
          committedSeqs: boundarySeqs,
        })) {
          pending = requeueAfterCommittedUserPromptBoundaryMiss(message);
          pendingFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt || shouldApplyFreshSessionSystemPrompt;
          shouldSendReady = false;
          continue;
        }
      }
      if (special.type === 'compact') {
        try {
          if (typeof opts.runtime.compactContext === 'function') {
            await opts.runtime.compactContext(special.originalMessage ?? message.message.text.trim());
          } else {
            throw new Error('/compact is not supported by this runtime');
          }
        } catch (error) {
          if (!isAbortLikeError(error)) {
            opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: opts.formatPromptErrorMessage(error) });
          }
        }
        opts.setThinking(false);
        opts.keepAlive();
        await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
        if (shouldSendReady) {
          opts.sendReady();
        }
        confirmLocallyConsumedPrompt(opts.session, message.message);
        continue;
      }
      assistantTextSnapshotScope = beginAssistantTextSnapshotTurnScope(opts.session);
      opts.runtime.beginTurnLifecycle();
      beganTurn = true;

      activeCheckpointMessageId = currentCheckpointMessageId;
      activeCheckpointTurnId = null;
      activeCheckpointFinalStatus = 'unknown';
      const nowMs = Date.now();
      const seedResolution = providerPromptAlreadyResolved
        ? {
            providerPrompt: message.message.text,
          }
        : await resolveProviderPromptWithReplaySeed({
            session: opts.session,
            userText: message.message.text,
            allowSeed: special.type === null,
            localId,
            nowMs,
            refreshMetadataBeforeRead: false,
          });
      snapshotFreshForNextPromptBoundary = false;
      const explicitBaseOverride = shouldApplyFreshSessionSystemPrompt
        ? resolveAppendSystemPromptBaseOverride(message.mode)
        : undefined;
      const freshSessionSystemPrompt = shouldApplyFreshSessionSystemPrompt
        ? await opts.resolveFreshSessionSystemPrompt?.({
            baseOverride: explicitBaseOverride,
          })
        : undefined;
      const effectiveAppendSystemPrompt = typeof freshSessionSystemPrompt === 'string'
        ? freshSessionSystemPrompt.trim()
        : '';
      const providerPrompt =
        shouldApplyFreshSessionSystemPrompt && effectiveAppendSystemPrompt.trim().length > 0
          ? `${effectiveAppendSystemPrompt.trim()}\n\n${seedResolution.providerPrompt}`
          : seedResolution.providerPrompt;
      const dispatchPrompt = await transformAgentContextPromptBeforeDispatch({
        transformAgentContextBeforeDispatch: opts.transformAgentContextBeforeDispatch,
        sessionId: opts.session.sessionId,
        agentId: opts.agentMessageType,
        prompt: providerPrompt,
        timestampMs: nowMs,
      });

      await runCheckpointHook(() => opts.checkpointLifecycle?.onBeforePromptDispatch?.({
        messageId: currentCheckpointMessageId!,
        prompt: dispatchPrompt,
      }));

      // HF-1 watermark custody: the batch's max committed user-row seq rides into the dispatch so
      // a provider-acceptance runtime can confirm the owed-delivery watermark at acceptance.
      for (const seq of boundarySeqs) {
        if (!batchUserMessageSeqs.includes(seq)) {
          batchUserMessageSeqs.push(seq);
        }
      }
      const batchUserMessageSeq = batchUserMessageSeqs.length === 0
        ? null
        : Math.max(...batchUserMessageSeqs);
      const promptDeliveryMeta = {
        ...(localId === null ? {} : { localId }),
        ...(localIds.length === 0 ? {} : { localIds }),
        ...(queuedModelOverride === null ? {} : { modelId: queuedModelOverride }),
        ...(providerClaimedPendingLocalIdsForTurn.length === 0
          ? {}
          : { providerClaimedPendingLocalIds: providerClaimedPendingLocalIdsForTurn }),
        ...(batchUserMessageSeq === null ? {} : { userMessageSeq: batchUserMessageSeq }),
        ...(batchUserMessageSeqs.length === 0 ? {} : { userMessageSeqs: batchUserMessageSeqs }),
      };
      if (typeof opts.runtime.sendPromptWithMeta === 'function') {
        didAttemptProviderSend = true;
        await opts.runtime.sendPromptWithMeta({
          text: dispatchPrompt,
          ...promptDeliveryMeta,
        });
      } else if (Object.keys(promptDeliveryMeta).length === 0) {
        didAttemptProviderSend = true;
        await opts.runtime.sendTurnPrompt(dispatchPrompt);
      } else {
        didAttemptProviderSend = true;
        await opts.runtime.sendTurnPrompt(dispatchPrompt, promptDeliveryMeta);
      }
    } catch (error) {
      if (providerClaimedPendingLocalIdsForTurn.length > 0) {
        await opts.session.blockPendingMessageDelivery({
          localIds: providerClaimedPendingLocalIdsForTurn,
          reason: didAttemptProviderSend
            ? 'provider_rejected_before_acceptance'
            : 'runtime_disposed_before_delivery',
        });
      }

      if (error instanceof StrictInitialResumeError) {
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw error;
      }
      if (!isAbortLikeError(error) && !isRuntimeTurnFailureAlreadySurfaced(error)) {
        opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: opts.formatPromptErrorMessage(error) });
        if (currentCheckpointMessageId) {
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'turn_failed', id: currentCheckpointMessageId });
        }
        handledPreTurnFailure = !beganTurn;
      }
    } finally {
      turnInFlight = false;
      if (beganTurn) {
        if (suppressFlushTurnFailure) {
          try {
            await opts.runtime.waitForTurnCompletion();
          } catch {}
        } else {
          // A turn-completion failure (e.g. a classified terminal injection/acceptance failure
          // from the Claude unified host) must NOT escape the loop into a process-killing fatal:
          // surface it to the transcript and let the loop re-enter on the next queued message.
          // Abort-like errors are the shutdown signal and are re-thrown so teardown proceeds.
          try {
            await opts.runtime.waitForTurnCompletion();
          } catch (completionError) {
            if (isAbortLikeError(completionError)) {
              throw completionError;
            }
            if (!isRuntimeTurnFailureAlreadySurfaced(completionError)) {
              opts.session.sendAgentMessage(opts.agentMessageType, {
                type: 'message',
                message: opts.formatPromptErrorMessage(completionError),
              });
            }
          }
        }
        if (currentCheckpointMessageId && !activeCheckpointTurnId) {
          activeCheckpointTurnId = currentCheckpointMessageId;
          await runCheckpointHook(() => opts.checkpointLifecycle?.onTurnStarted?.({
            messageId: currentCheckpointMessageId!,
            turnId: activeCheckpointTurnId!,
          }));
        }
        if (currentCheckpointMessageId && activeCheckpointTurnId) {
          const checkpointMessageId = currentCheckpointMessageId;
          const checkpointTurnId = activeCheckpointTurnId;
          await runCheckpointHook(() => opts.checkpointLifecycle?.onTurnFinal?.({
            messageId: checkpointMessageId,
            turnId: checkpointTurnId,
            status: activeCheckpointFinalStatus,
          }));
        } else if (currentCheckpointMessageId) {
          await runCheckpointHook(() => opts.checkpointLifecycle?.onTurnAbortedBeforeStart?.({
            messageId: currentCheckpointMessageId!,
          }));
        }
        activeCheckpointMessageId = null;
        activeCheckpointTurnId = null;
        activeCheckpointFinalStatus = 'unknown';
        // Metadata updates can arrive while we're mid-turn.
        overrideSync.syncFromMetadata();
        opts.setThinking(false);
        opts.keepAlive();
        await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
        if (shouldSendReady) {
          opts.sendReady();
        }
        completeAssistantTextSnapshotTurnScope(opts.session, assistantTextSnapshotScope);
      } else if (handledPreTurnFailure) {
        if (currentCheckpointMessageId) {
          await runCheckpointHook(() => opts.checkpointLifecycle?.onTurnAbortedBeforeStart?.({
            messageId: currentCheckpointMessageId!,
          }));
        }
        activeCheckpointMessageId = null;
        activeCheckpointTurnId = null;
        activeCheckpointFinalStatus = 'unknown';
        opts.setThinking(false);
        opts.keepAlive();
        if (shouldSendReady) {
          opts.sendReady();
        }
      }
    }
  }

  } finally {
    resetAssistantTextSnapshotTurnScope(opts.session, 'session_end');
    unsubscribeCheckpointRuntimeMessages();
    await runCheckpointHook(() => opts.checkpointLifecycle?.onSessionEnd?.());
  }
}
