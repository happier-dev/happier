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

export type PermissionModePromptLoopTurnOperations = RuntimeTurnOperations & Readonly<{
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
  mode: { permissionMode: PermissionMode; appendSystemPrompt?: string | null };
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

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
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
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  resolveFreshSessionSystemPrompt?: (args: {
    baseOverride?: string | null;
  }) => Promise<string | null | undefined>;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let wasStarted = false;
  let currentModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
  let storedSessionIdForResume: { value: string; origin: 'initial' | 'restart' } | null = null;
  let didReplaySeedBootstrap = false;
  let turnInFlight = false;
  let pendingFreshSessionSystemPrompt = false;

  const normalizedResumeId = typeof opts.initialResumeId === 'string' ? opts.initialResumeId.trim() : '';
  if (normalizedResumeId) {
    storedSessionIdForResume = { value: normalizedResumeId, origin: 'initial' };
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
      } catch {
        // Best-effort only: prompt delivery must not block on snapshot refresh failures.
      }
      return;
    }
    if (typeof opts.session.ensureMetadataSnapshot === 'function') {
      try {
        await opts.session.ensureMetadataSnapshot();
      } catch {
        // Best-effort only.
      }
    }
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
    await refreshSessionSnapshotBeforeTurnBestEffort();
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    return { startedFreshSessionForTurn, exitRequested: false };
  };

  if ((opts.startRuntimeBeforeFirstPrompt === true || normalizedResumeId.length > 0) && !wasStarted) {
    await refreshSessionSnapshotBeforeTurnBestEffort();
    overrideSync.syncFromMetadata();
    const eagerStart = await ensureRuntimeStarted();
    if (eagerStart.exitRequested) return;
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
          if (!turnInFlight) {
            overrideSync.syncFromMetadata();
            await overrideSync.flushPendingAfterStart();
            await refreshSessionSnapshotBeforeTurnBestEffort();
            syncPermissionModeFromMetadata();
            overrideSync.syncFromMetadata();
          }
        },
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
    await refreshSessionSnapshotBeforeTurnBestEffort();
    overrideSync.syncFromMetadata();
    await overrideSync.flushPendingAfterStart();
    await refreshSessionSnapshotBeforeTurnBestEffort();
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    opts.messageBuffer.addMessage(message.message.text, 'user');

    const special = parseSpecialCommand(message.message.text);
    if (special.type === 'clear') {
      opts.messageBuffer.addMessage(`Resetting ${opts.providerName} session…`, 'status');
      await opts.onBeforeReset?.({ reason: 'clear' });
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
    try {
      turnInFlight = true;
      let shouldApplyFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt;
      pendingFreshSessionSystemPrompt = false;
      if (!wasStarted) {
        const runtimeStart = await ensureRuntimeStarted();
        if (runtimeStart.exitRequested) {
          shouldSendReady = false;
          return;
        }
        shouldApplyFreshSessionSystemPrompt =
          runtimeStart.startedFreshSessionForTurn || shouldApplyFreshSessionSystemPrompt;
      }
      opts.runtime.beginTurnLifecycle();
      beganTurn = true;

      const localId = typeof message.message.localId === 'string' && message.message.localId ? message.message.localId : null;
      const special = parseSpecialCommand(message.message.text);
      const nowMs = Date.now();
      const seedResolution = await resolveProviderPromptWithReplaySeed({
        session: opts.session,
        userText: message.message.text,
        allowSeed: special.type === null,
        localId,
        nowMs,
        refreshMetadataBeforeRead: !didReplaySeedBootstrap,
      });
      didReplaySeedBootstrap = true;
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
          await opts.runtime.waitForTurnCompletion();
        }
        // Metadata updates can arrive while we're mid-turn.
        overrideSync.syncFromMetadata();
        opts.setThinking(false);
        opts.keepAlive();
        await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
        if (shouldSendReady) {
          opts.sendReady();
        }
      }
    }
  }
}
