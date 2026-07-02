import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolveAppendSystemPromptBaseOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  initializePermissionModeStateSync,
} from '@/agent/runtime/permissions/modeStateSync';
import { waitForNextPermissionModeMessage } from '@/agent/runtime/waitForNextPermissionModeMessage';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import {
  resolveProviderPromptWithReplaySeed,
} from '@/agent/runtime/replaySeed/replaySeedV1';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import { createSessionProviderPendingDrainAdapter } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { DrainPendingResult } from '@/agent/runtime/session/input/_types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import {
  beginAssistantTextSnapshotTurnScope,
  completeAssistantTextSnapshotTurnScope,
  resetAssistantTextSnapshotTurnScope,
  type AssistantTextSnapshotTurnScope,
} from '@/agent/runtime/turns/assistantTextSnapshotTurnScope';
import { configuration } from '@/configuration';

export type PermissionModePromptLoopTurnOperations = RuntimeTurnOperations & Readonly<{
  compactContext?: (command: string) => Promise<void>;
  sendPromptWithMeta?: (params: { text: string; localId?: string | null }) => Promise<void>;
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
  mode: { permissionMode: PermissionMode; appendSystemPrompt?: string | null; suppressUserEcho?: boolean };
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

function readCheckpointRuntimeMessage(message: unknown): CheckpointRuntimeMessage | null {
  return message && typeof message === 'object' ? message as CheckpointRuntimeMessage : null;
}

function readCheckpointTurnId(message: CheckpointRuntimeMessage): string | null {
  return typeof message.id === 'string' && message.id.trim().length > 0 ? message.id : null;
}

function mapCheckpointFinalStatus(message: CheckpointRuntimeMessage): 'completed' | 'aborted' | 'interrupted' | 'unknown' {
  if (message.type === 'task_complete') return 'completed';
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

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<{
    permissionMode: PermissionMode;
    appendSystemPrompt?: string | null;
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
  resolveFreshSessionSystemPrompt?: (args: {
    baseOverride?: string | null;
  }) => Promise<string | null | undefined>;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let wasStarted = false;
  let currentModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
  let storedSessionIdForResume: { value: string; origin: 'initial' | 'restart' } | null = null;
  let turnInFlight = false;
  let pendingFreshSessionSystemPrompt = false;
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
        if ((message.type === 'task_complete' || message.type === 'turn_aborted') && turnId) {
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
      shouldAttemptPendingMaterialization: () => opts.session.shouldAttemptPendingMaterialization?.() ?? true,
      reconcilePendingQueueState: (reconcileOpts) => opts.session.reconcilePendingQueueState?.(reconcileOpts),
    }, { maxPopPerWake: pendingQueueDrainMaxPopPerWake }).drainPending({
      shouldContinue: async () => (await (opts.beforePendingMaterialize?.() ?? true)) !== false,
      logPrefix: `[${opts.providerName}]`,
      reason: 'permission-mode-eager-start',
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
      const next = await waitForNextPermissionModeMessage({
        messageQueue: opts.messageQueue,
        abortSignal: opts.getAbortSignal(),
        session: opts.session,
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
      });
      if (!next) continue;
      message = { message: next.message, mode: next.mode, hash: next.hash };
    }
    if (!message) continue;

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

    const special = parseSpecialCommand(message.message.text);
    if (special.type === 'clear') {
      opts.messageBuffer.addMessage(`Resetting ${opts.providerName} session…`, 'status');
      await opts.onBeforeReset?.({ reason: 'clear' });
      resetAssistantTextSnapshotTurnScope(opts.session, 'clear');
      await opts.runtime.resetOrDisposeRuntime();
      wasStarted = false;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'clear' });
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      await opts.onAfterLoopBoundary?.({ reason: 'clear_reset' });
      opts.sendReady();
      continue;
    }

    let shouldSendReady = true;
    let suppressFlushTurnFailure = false;
    let beganTurn = false;
    let currentCheckpointMessageId: string | null = null;
    let assistantTextSnapshotScope: AssistantTextSnapshotTurnScope | null = null;
    try {
      turnInFlight = true;
      let shouldApplyFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt;
      pendingFreshSessionSystemPrompt = false;
      const localId = typeof message.message.localId === 'string' && message.message.localId ? message.message.localId : null;
      if (!wasStarted) {
        const runtimeStart = await ensureRuntimeStarted();
        if (runtimeStart.exitRequested) {
          shouldSendReady = false;
          return;
        }
        shouldApplyFreshSessionSystemPrompt =
          runtimeStart.startedFreshSessionForTurn || shouldApplyFreshSessionSystemPrompt;
      }
      await waitForCommittedUserPromptBoundary(opts.session, localId);
      const special = parseSpecialCommand(message.message.text);
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
        continue;
      }
      assistantTextSnapshotScope = beginAssistantTextSnapshotTurnScope(opts.session);
      opts.runtime.beginTurnLifecycle();
      beganTurn = true;

      currentCheckpointMessageId = localId ?? message.hash;
      activeCheckpointMessageId = currentCheckpointMessageId;
      activeCheckpointTurnId = null;
      activeCheckpointFinalStatus = 'unknown';
      const nowMs = Date.now();
      const seedResolution = await resolveProviderPromptWithReplaySeed({
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

      await runCheckpointHook(() => opts.checkpointLifecycle?.onBeforePromptDispatch?.({
        messageId: currentCheckpointMessageId!,
        prompt: providerPrompt,
      }));

      if (typeof opts.runtime.sendPromptWithMeta === 'function') {
        await opts.runtime.sendPromptWithMeta({ text: providerPrompt, localId });
      } else {
        await opts.runtime.sendTurnPrompt(providerPrompt);
      }
    } catch (error) {
      if (error instanceof StrictInitialResumeError) {
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw error;
      }
      if (!isAbortLikeError(error)) {
        opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: opts.formatPromptErrorMessage(error) });
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
            opts.session.sendAgentMessage(opts.agentMessageType, {
              type: 'message',
              message: opts.formatPromptErrorMessage(completionError),
            });
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
      }
    }
  }

  } finally {
    resetAssistantTextSnapshotTurnScope(opts.session, 'session_end');
    unsubscribeCheckpointRuntimeMessages();
    await runCheckpointHook(() => opts.checkpointLifecycle?.onSessionEnd?.());
  }
}
