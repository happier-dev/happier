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

type PromptRuntime = {
  beginTurn: () => void;
  startOrLoad: (opts: { resumeId?: string }) => Promise<unknown>;
  sendPrompt: (message: string) => Promise<void>;
  flushTurn: () => void;
  reset: () => Promise<void>;
  getSessionId: () => string | null;
};

type OverrideSynchronizer = {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
};

type QueuedPermissionModeMessage = {
  message: string;
  mode: { permissionMode: PermissionMode };
  hash: string;
};

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<{ permissionMode: PermissionMode }>;
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
  onAfterStart?: (() => void | Promise<void>) | null;
  onAfterReset?: (() => void | Promise<void>) | null;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let wasStarted = false;
  let currentModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
  let storedSessionIdForResume: string | null = null;

  const normalizedResumeId = typeof opts.initialResumeId === 'string' ? opts.initialResumeId.trim() : '';
  if (normalizedResumeId) {
    storedSessionIdForResume = normalizedResumeId;
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

  overrideSync.syncFromMetadata();

  while (!opts.shouldExit()) {
    let message: QueuedPermissionModeMessage | null = pending;
    pending = null;

    if (!message) {
      const next = await waitForNextPermissionModeMessage({
        messageQueue: opts.messageQueue,
        abortSignal: opts.getAbortSignal(),
        session: opts.session,
        onMetadataUpdate: () => {
          syncPermissionModeFromMetadata();
          overrideSync.syncFromMetadata();
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
      if (resumeId) storedSessionIdForResume = resumeId;

      opts.messageBuffer.addMessage(`Restarting ${opts.providerName} session (permission settings changed)…`, 'status');
      await opts.runtime.reset();
      wasStarted = false;
      await opts.onAfterReset?.();
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();

      pending = message;
      continue;
    }

    currentModeHash = message.hash;
    opts.messageBuffer.addMessage(message.message, 'user');

    const special = parseSpecialCommand(message.message);
    if (special.type === 'clear') {
      opts.messageBuffer.addMessage(`Resetting ${opts.providerName} session…`, 'status');
      await opts.runtime.reset();
      wasStarted = false;
      await opts.onAfterReset?.();
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      opts.sendReady();
      continue;
    }

    try {
      opts.runtime.beginTurn();
      if (!wasStarted) {
        const resumeId = storedSessionIdForResume?.trim();
        if (resumeId) {
          storedSessionIdForResume = null; // consume once
          opts.messageBuffer.addMessage('Resuming previous context…', 'status');
          try {
            await opts.runtime.startOrLoad({ resumeId });
          } catch {
            opts.messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
            opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: 'Resume failed; starting a new session.' });
            await opts.runtime.startOrLoad({});
          }
        } else {
          await opts.runtime.startOrLoad({});
        }
        await opts.onAfterStart?.();
        wasStarted = true;
        await overrideSync.flushPendingAfterStart();
      }
      await opts.runtime.sendPrompt(message.message);
    } catch (error) {
      opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: opts.formatPromptErrorMessage(error) });
    } finally {
      opts.runtime.flushTurn();
      // Metadata updates can arrive while we're mid-turn.
      overrideSync.syncFromMetadata();
      opts.setThinking(false);
      opts.keepAlive();
      opts.sendReady();
    }
  }
}
