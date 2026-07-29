import {
  readPendingLocalId,
  RuntimeEventV1Schema,
  validatePluginHookPayloadV1,
  type SessionPendingQueueDeliveryTiming,
  type ProviderBoundModelRef,
  type SessionModelTransitionResultV1,
} from '@happier-dev/protocol';

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
  type RuntimeTurnSessionOpenIntent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  initializePermissionModeStateSync,
} from '@/agent/runtime/permissions/modeStateSync';
import {
  createSessionProviderInputConsumerSessionAdapter,
  waitForNextPermissionModeMessage,
} from '@/agent/runtime/waitForNextPermissionModeMessage';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  normalizePermissionModeQueuedPromptLocalIds,
  normalizePermissionModeQueuedPromptUserMessageSeqs,
  readHighestPermissionModeQueuedPromptUserMessageSeq,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  resolveProviderPromptWithReplaySeed,
} from '@/agent/runtime/replaySeed/replaySeedV1';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import {
  createSessionProviderInputConsumer,
  PendingQueueMaterializationAuthError,
} from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type {
  DrainPendingResult,
  MessageBatch,
  SessionProviderInputConsumer,
} from '@/agent/runtime/session/input/_types';
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
import { logger } from '@/ui/logger';

export type PermissionModePromptLoopTurnOperations = RuntimeTurnOperations & Readonly<{
  supportsInFlightSteer?: () => boolean;
  canSteerPrompt?: () => boolean;
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

export type PromptLoopOverrideSynchronizer = Readonly<{
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
}>;

export type PromptLoopPermissionHandler = Readonly<
  Pick<ProviderEnforcedPermissionHandler, 'setPermissionMode'> & {
    reset: () => void | Promise<void>;
  }
>;

type QueuedPermissionModeMessage = {
  message: PermissionModeQueuedPrompt;
  mode: PermissionModeQueuedPromptMode;
  hash: string;
};

export type PromptLoopResetReason =
  | 'mode_change'
  | 'clear';

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

function readRuntimeRestartModeHash(mode: QueuedPermissionModeMessage['mode']): string {
  return JSON.stringify({
    permissionMode: mode.permissionMode,
    appendSystemPrompt: mode.appendSystemPrompt ?? null,
    suppressUserEcho: mode.suppressUserEcho === true,
    providerPromptAlreadyResolved: mode.providerPromptAlreadyResolved === true,
  });
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

function observeLocalSpecialCommandSettlement(params: Readonly<{
  session: ApiSessionClient;
  message: PermissionModeQueuedPrompt;
  outcome:
    | Readonly<{ kind: 'accepted' }>
    | Readonly<{ kind: 'rejected_before_effect'; diagnosticMessage: string }>;
}>): void {
  const identity = readQueuedPromptDeliveryIdentity(params.message);
  if (identity.localIds.length !== 1) return;
  const localId = identity.localIds[0]!;
  const sharedIdentity = {
    localId,
    userMessageSeq: identity.userMessageSeq,
    ...(identity.userMessageSeqs.length > 0 ? { userMessageSeqs: identity.userMessageSeqs } : {}),
  };
  if (params.outcome.kind === 'accepted') {
    params.session.observeProviderInputSettlement({
      kind: 'accepted',
      ...sharedIdentity,
    });
    return;
  }
  params.session.observeProviderInputSettlement({
    kind: 'rejected_before_effect',
    ...sharedIdentity,
    reason: 'provider_rejected_before_acceptance',
    diagnostic: {
      code: 'local_special_command_rejected',
      severity: 'error',
      message: params.outcome.diagnosticMessage,
    },
    retryable: false,
  });
}

function observeModelTransitionFailureSettlement(params: Readonly<{
  session: ApiSessionClient;
  message: PermissionModeQueuedPrompt;
  transition: Extract<SessionModelTransitionResultV1, { ok: false }>;
}>): void {
  const identity = readQueuedPromptDeliveryIdentity(params.message);
  if (identity.localIds.length === 0) return;
  const status = params.transition.status;
  const reversibleReason =
    status === 'owner_unavailable'
      ? 'provider_unavailable_before_acceptance'
      : status === 'reconciliation_required'
        ? 'runtime_config_blocked'
        : null;
  for (const localId of identity.localIds) {
    params.session.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq:
        identity.localIds.length === 1 ? identity.userMessageSeq : null,
      reason: reversibleReason ?? 'provider_rejected_before_acceptance',
      diagnostic: {
        code: `session_model_transition_${status}`,
        severity: 'error',
        message:
          params.transition.reason
          ?? `Structured model transition failed: ${status}`,
      },
      retryable: reversibleReason !== null,
    });
  }
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
  errorPolicy?: 'fallback' | 'throw';
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
    if (params.errorPolicy === 'throw') {
      throw error;
    }
    logger.debug('[plugins] agent.context.before failed; using original provider prompt');
    return params.prompt;
  }
}

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
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
  inputConsumer?: SessionProviderInputConsumer<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  resolveFreshSessionSystemPrompt?: (args: {
    baseOverride?: string | null;
  }) => Promise<string | null | undefined>;
  transformAgentContextBeforeDispatch?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  transformAgentContextErrorPolicy?: 'fallback' | 'throw';
  transitionModelSelectionBeforePrompt?: (
    selection: ProviderBoundModelRef,
    runWithActiveSelection: (
      transferPromptAdmission: (opts: Readonly<{
        abortSignal: AbortSignal;
        dispatch: () => Promise<void>;
      }>) => Promise<
        | Readonly<{ status: 'dispatched'; value: void }>
        | Readonly<{ status: 'cancelled' }>
      >,
    ) => Promise<void>,
  ) => Promise<SessionModelTransitionResultV1>;
  readActiveModelSelection?: () => ProviderBoundModelRef;
  onProviderPromptDispatchPrepared?: (input: Readonly<{
    localIds: readonly string[];
    selection: ProviderBoundModelRef;
  }>) => void;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let wasStarted = false;
  let currentRuntimeRestartModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
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
  const inputConsumer = opts.inputConsumer ?? createSessionProviderInputConsumer({
    messageQueue: opts.messageQueue,
    session: createSessionProviderInputConsumerSessionAdapter(opts.session),
    reconcileWhenEmpty: 'skip',
    pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
    refreshBeforeQueuedBatch: false,
    pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
  });
  let activeTurnPendingPumpController: AbortController | null = null;
  const stopActiveTurnPendingPump = (): void => {
    const controller = activeTurnPendingPumpController;
    if (!controller) return;
    activeTurnPendingPumpController = null;
    controller.abort('permission-mode-prompt-loop:turn-not-steerable');
  };
  const startActiveTurnPendingPump = (): void => {
    if (
      opts.runtime.supportsInFlightSteer?.() !== true
      || opts.runtime.canSteerPrompt?.() !== true
    ) return;
    if (activeTurnPendingPumpController) return;
    const controller = new AbortController();
    activeTurnPendingPumpController = controller;
    void inputConsumer.pumpPendingWhileActive({
      abortSignal: controller.signal,
      maxPopPerWake: pendingQueueDrainMaxPopPerWake,
      shouldContinue: () => (
        turnInFlight
        && opts.runtime.canSteerPrompt?.() === true
      ),
      logPrefix: `[${opts.providerName}]`,
      reason: 'active-turn-steerable',
    }).catch(() => {
      logger.debug(`[${opts.providerName}] Active-turn Pending pump stopped after non-fatal error`);
    }).finally(() => {
      if (activeTurnPendingPumpController === controller) {
        activeTurnPendingPumpController = null;
      }
    });
  };

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
  let nextSessionIsFresh = normalizedResumeId.length === 0;
  let announceInitialResume = normalizedResumeId.length > 0;
  let strictInitialResumePending = opts.strictInitialResume === true && normalizedResumeId.length > 0;
  if (normalizedResumeId) {
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
        await opts.session.refreshSessionSnapshotFromServerBestEffort({ reason: 'primaryTurnRuntimeState' });
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
    const startedFreshSessionForTurn = nextSessionIsFresh;
    nextSessionIsFresh = false;
    if (announceInitialResume) {
      announceInitialResume = false;
      opts.messageBuffer.addMessage('Resuming previous context…', 'status');
    }

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
      const pendingDrainResult = await inputConsumer.drainPending({
        shouldContinue: async () => (await (opts.beforePendingMaterialize?.() ?? true)) !== false,
        logPrefix: `[${opts.providerName}]`,
        reason: 'permission-mode-eager-start',
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
          beforeCollectQueuedBatch: async () => {
            // The metadata wake is armed by the input consumer before this callback runs. Re-read
            // the already-projected snapshot here so an update that landed during post-turn
            // lifecycle work cannot fall between the previous sync and the next one-shot wait.
            syncPermissionModeFromMetadata();
            overrideSync.syncFromMetadata();
            if (!turnInFlight) {
              await overrideSync.flushPendingAfterStart();
            }
            opts.messageQueue.discardMatching((queuedMessage, queuedMode) =>
              isQueuedPromptAlreadyLocallyConsumed(opts.session, queuedMessage, queuedMode),
            );
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
          inputConsumer,
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

    if (isQueuedPromptAlreadyLocallyConsumed(opts.session, message.message, message.mode)) {
      continue;
    }

    opts.permissionHandler.setPermissionMode(message.mode.permissionMode);

    const runtimeRestartModeHash = readRuntimeRestartModeHash(message.mode);
    if (
      wasStarted
      && currentRuntimeRestartModeHash
      && runtimeRestartModeHash !== currentRuntimeRestartModeHash
    ) {
      const resumeId = opts.runtime.readSessionIdentity().sessionId;
      currentRuntimeRestartModeHash = runtimeRestartModeHash;
      const shouldResumeAfterPermissionModeChange =
        typeof opts.runtime.shouldResumeAfterPermissionModeChange === 'function'
          ? opts.runtime.shouldResumeAfterPermissionModeChange()
          : true;
      const nextSessionOpenIntent: RuntimeTurnSessionOpenIntent =
        resumeId && shouldResumeAfterPermissionModeChange
          ? {
              kind: 'resume',
              providerSessionId: resumeId,
              importHistory: false,
            }
          : { kind: 'create' };

      opts.messageBuffer.addMessage(`Restarting ${opts.providerName} session (permission settings changed)…`, 'status');
      await opts.onBeforeReset?.({ reason: 'mode_change' });
      resetAssistantTextSnapshotTurnScope(opts.session, 'mode_change');
      await opts.permissionHandler.reset();
      await opts.runtime.resetOrDisposeRuntime(undefined, nextSessionOpenIntent);
      wasStarted = false;
      nextSessionIsFresh = nextSessionOpenIntent.kind === 'create';
      runtimePermissionModeApplied = null;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'mode_change' });
      opts.setThinking(false);
      opts.keepAlive();
      await opts.onAfterLoopBoundary?.({ reason: 'mode_change_reset' });

      pending = message;
      continue;
    }

    currentRuntimeRestartModeHash = runtimeRestartModeHash;
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
      await opts.permissionHandler.reset();
      await opts.runtime.resetOrDisposeRuntime(undefined, { kind: 'create' });
      wasStarted = false;
      nextSessionIsFresh = true;
      runtimePermissionModeApplied = null;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'clear' });
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      await opts.onAfterLoopBoundary?.({ reason: 'clear_reset' });
      observeLocalSpecialCommandSettlement({
        session: opts.session,
        message: message.message,
        outcome: { kind: 'accepted' },
      });
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
    try {
      turnInFlight = true;
      let shouldApplyFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt && !providerPromptAlreadyResolved;
      pendingFreshSessionSystemPrompt = false;
      const promptDeliveryIdentity = readQueuedPromptDeliveryIdentity(message.message);
      const { localIds, userMessageSeq, userMessageSeqs } = promptDeliveryIdentity;
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
      const runProviderInputDispatch = async (
        dispatch: () => Promise<void>,
      ): Promise<'dispatched' | 'cancelled'> => {
        if (!inputConsumer) {
          await dispatch();
          return 'dispatched';
        }
        return (
          await inputConsumer.runProviderInputDispatch({
            abortSignal: opts.getAbortSignal(),
            dispatch,
          })
        ).status;
      };
      const transitionAndDispatchProviderInput = async (
        dispatch: () => Promise<void>,
      ): Promise<'dispatched' | 'cancelled'> => {
        const requestedSelection = message.mode.modelSelection;
        if (!requestedSelection) {
          return await runProviderInputDispatch(dispatch);
        }
        if (!opts.transitionModelSelectionBeforePrompt) {
          const transition = {
            ok: false,
            status: 'owner_unavailable',
            activeSelection: null,
            requestedSelection,
            reason: 'Structured model transition owner is unavailable',
          } as const;
          observeModelTransitionFailureSettlement({
            session: opts.session,
            message: message.message,
            transition,
          });
          throw new Error(transition.reason);
        }

        let dispatchStatus: 'dispatched' | 'cancelled' | null = null;
        const transition = await opts.transitionModelSelectionBeforePrompt(
          requestedSelection,
          async (transferPromptAdmission) => {
            dispatchStatus = (
              await transferPromptAdmission({
                abortSignal: opts.getAbortSignal(),
                dispatch,
              })
            ).status;
          },
        );
        if (!transition.ok) {
          observeModelTransitionFailureSettlement({
            session: opts.session,
            message: message.message,
            transition,
          });
          throw new Error(
            transition.reason
              ?? `Structured model transition failed: ${transition.status}`,
          );
        }
        if (dispatchStatus === null) {
          throw new Error(
            'Structured model transition owner did not enter canonical prompt custody',
          );
        }
        return dispatchStatus;
      };
      if (special.type === 'compact') {
        let compactFailureMessage: string | null = null;
        const dispatchCompactContext = async (): Promise<void> => {
          try {
            if (typeof opts.runtime.compactContext === 'function') {
              await opts.runtime.compactContext(special.originalMessage ?? message.message.text.trim());
            } else {
              throw new Error('/compact is not supported by this runtime');
            }
          } catch (error) {
            if (isAbortLikeError(error)) throw error;
            compactFailureMessage = opts.formatPromptErrorMessage(error);
            opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: compactFailureMessage });
          }
        };
        if (
          await transitionAndDispatchProviderInput(dispatchCompactContext)
          === 'cancelled'
        ) {
          shouldSendReady = false;
          continue;
        }
        opts.setThinking(false);
        opts.keepAlive();
        await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
        if (shouldSendReady) {
          opts.sendReady();
        }
        observeLocalSpecialCommandSettlement({
          session: opts.session,
          message: message.message,
          outcome: compactFailureMessage === null
            ? { kind: 'accepted' }
            : { kind: 'rejected_before_effect', diagnosticMessage: compactFailureMessage },
        });
        confirmLocallyConsumedPrompt(opts.session, message.message);
        continue;
      }
      const dispatchProviderPrompt = async (): Promise<void> => {
        assistantTextSnapshotScope = beginAssistantTextSnapshotTurnScope(opts.session);
        opts.runtime.beginTurnLifecycle();
        beganTurn = true;
        startActiveTurnPendingPump();

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
          errorPolicy: opts.transformAgentContextErrorPolicy,
          sessionId: opts.session.sessionId,
          agentId: opts.agentMessageType,
          prompt: providerPrompt,
          timestampMs: nowMs,
        });

        await runCheckpointHook(() => opts.checkpointLifecycle?.onBeforePromptDispatch?.({
          messageId: currentCheckpointMessageId!,
          prompt: dispatchPrompt,
        }));

        if (localIds.length > 0 && opts.readActiveModelSelection && opts.onProviderPromptDispatchPrepared) {
          opts.onProviderPromptDispatchPrepared({
            localIds,
            selection: opts.readActiveModelSelection(),
          });
        }
        const promptDeliveryMeta = {
          ...(localId === null ? {} : { localId }),
          ...(localIds.length === 0 ? {} : { localIds }),
          ...(userMessageSeq === null ? {} : { userMessageSeq }),
          ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
          ...(message.message.structuredInput
            ? { structuredInput: message.message.structuredInput }
            : {}),
        };
        const providerSend = typeof opts.runtime.sendPromptWithMeta === 'function'
          ? opts.runtime.sendPromptWithMeta({
            text: dispatchPrompt,
            ...promptDeliveryMeta,
          })
          : Object.keys(promptDeliveryMeta).length === 0
            ? opts.runtime.sendTurnPrompt(dispatchPrompt)
            : opts.runtime.sendTurnPrompt(dispatchPrompt, promptDeliveryMeta);
        // Runtime adapters update exact steerability synchronously when provider dispatch
        // acquires a live turn. Re-check only at that lifecycle edge; no cadence or inferred
        // turn-in-flight state is allowed to start the Pending pump.
        startActiveTurnPendingPump();
        await providerSend;
        strictInitialResumePending = false;
      };
      if (
        await transitionAndDispatchProviderInput(dispatchProviderPrompt)
        === 'cancelled'
      ) {
        shouldSendReady = false;
        continue;
      }
    } catch (error) {
      if (
        strictInitialResumePending
        && !(error instanceof StrictInitialResumeError)
        && !isAbortLikeError(error)
      ) {
        strictInitialResumePending = false;
        const formatted = opts.formatPromptErrorMessage(error);
        opts.messageBuffer.addMessage(`Resume failed; cannot continue: ${formatted}`, 'status');
        opts.session.sendAgentMessage(opts.agentMessageType, {
          type: 'message',
          message: `Resume failed; cannot continue: ${formatted}`,
        });
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw new StrictInitialResumeError('Strict initial resume failed', error);
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
      stopActiveTurnPendingPump();
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
