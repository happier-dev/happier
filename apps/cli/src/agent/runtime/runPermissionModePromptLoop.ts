import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  initializePermissionModeStateSync,
} from '@/agent/runtime/permission/permissionModeStateSync';
import { waitForNextPermissionModeMessage } from '@/agent/runtime/waitForNextPermissionModeMessage';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import {
  resolveProviderPromptWithReplaySeed,
} from '@/agent/runtime/replaySeed/replaySeedV1';

type PromptRuntime = {
  beginTurn: () => void;
  startOrLoad: (opts: { resumeId?: string; importHistory?: boolean }) => Promise<unknown>;
  sendPrompt: (message: string) => Promise<void>;
  sendPromptWithMeta?: (params: { text: string; localId?: string | null }) => Promise<void>;
  flushTurn: () => void | Promise<void>;
  reset: () => Promise<void>;
  getSessionId: () => string | null;
  shouldResumeAfterPermissionModeChange?: () => boolean;
};

type OverrideSynchronizer = {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
};

type QueuedPermissionModeMessage = {
  message: PermissionModeQueuedPrompt;
  mode: { permissionMode: PermissionMode; appendSystemPrompt?: string | null };
  hash: string;
};

class StrictInitialResumeError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'StrictInitialResumeError';
    this.cause = cause;
  }
}

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  permissionHandler: ProviderEnforcedPermissionHandler;
  runtime: PromptRuntime;
  createOverrideSynchronizer: (isStarted: () => boolean) => OverrideSynchronizer;
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
  onAfterReset?: (() => void | Promise<void>) | null;
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

  const ensureRuntimeStarted = async (): Promise<{ startedFreshSessionForTurn: boolean }> => {
    if (wasStarted) return { startedFreshSessionForTurn: false };

    const resume = storedSessionIdForResume;
    const resumeId = typeof resume?.value === 'string' ? resume.value.trim() : '';
    let strictAbort: StrictInitialResumeError | null = null;
    let startedFreshSessionForTurn = false;

    if (resumeId) {
      storedSessionIdForResume = null; // consume once
      opts.messageBuffer.addMessage('Resuming previous context…', 'status');
      try {
        // Avoid importing ACP replay history into Happier on normal resume; Happier transcript is the source of truth.
        await opts.runtime.startOrLoad({ resumeId, importHistory: false });
      } catch (error) {
        const shouldFailClosed =
          opts.strictInitialResume === true && resume?.origin === 'initial';
        if (shouldFailClosed) {
          const formatted = opts.formatPromptErrorMessage(error);
          opts.messageBuffer.addMessage(`Resume failed; cannot continue: ${formatted}`, 'status');
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: `Resume failed; cannot continue: ${formatted}` });
          try {
            await opts.runtime.reset();
          } catch {
            // ignore cleanup failure
          }
          strictAbort = new StrictInitialResumeError('Strict initial resume failed', error);
        } else {
          opts.messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: 'Resume failed; starting a new session.' });
          await opts.runtime.reset();
          await opts.runtime.startOrLoad({});
          startedFreshSessionForTurn = true;
        }
      }
    } else {
      await opts.runtime.startOrLoad({});
      startedFreshSessionForTurn = true;
    }

    if (strictAbort) throw strictAbort;

    await opts.onAfterStart?.();
    wasStarted = true;
    await overrideSync.flushPendingAfterStart();
    await refreshSessionSnapshotBeforeTurnBestEffort();
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    return { startedFreshSessionForTurn };
  };

  if (opts.startRuntimeBeforeFirstPrompt === true && !wasStarted) {
    await refreshSessionSnapshotBeforeTurnBestEffort();
    overrideSync.syncFromMetadata();
    const eagerStart = await ensureRuntimeStarted();
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
      const resumeId = opts.runtime.getSessionId();
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
      await opts.runtime.reset();
      wasStarted = false;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.();
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();

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
      await opts.runtime.reset();
      wasStarted = false;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.();
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      opts.sendReady();
      continue;
    }

    let shouldSendReady = true;
    let suppressFlushTurnFailure = false;
    try {
      turnInFlight = true;
      let shouldApplyFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt;
      pendingFreshSessionSystemPrompt = false;
      opts.runtime.beginTurn();
      if (!wasStarted) {
        const runtimeStart = await ensureRuntimeStarted();
        shouldApplyFreshSessionSystemPrompt =
          runtimeStart.startedFreshSessionForTurn || shouldApplyFreshSessionSystemPrompt;
      }

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
      const explicitBaseOverride = shouldApplyFreshSessionSystemPrompt && Object.prototype.hasOwnProperty.call(message.mode, 'appendSystemPrompt')
        ? (typeof message.mode.appendSystemPrompt === 'string' ? message.mode.appendSystemPrompt : null)
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
        await opts.runtime.sendPrompt(providerPrompt);
      }
    } catch (error) {
      if (error instanceof StrictInitialResumeError) {
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw error;
      }
      opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: opts.formatPromptErrorMessage(error) });
    } finally {
      turnInFlight = false;
      if (suppressFlushTurnFailure) {
        try {
          await opts.runtime.flushTurn();
        } catch {}
      } else {
        await opts.runtime.flushTurn();
      }
      // Metadata updates can arrive while we're mid-turn.
      overrideSync.syncFromMetadata();
      opts.setThinking(false);
      opts.keepAlive();
      if (shouldSendReady) {
        opts.sendReady();
      }
    }
  }
}
