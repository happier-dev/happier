/**
 * Auggie CLI Entry Point
 *
 * Runs the Auggie agent through Happier CLI using ACP.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/mcp/startHappyServer';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import {
  persistTerminalAttachmentInfoIfNeeded,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permissionModeMetadata';
import { applyStartupMetadataUpdateToSession, buildAcpSessionModeOverride, buildModelOverride, buildPermissionModeOverride } from '@/agent/runtime/startupMetadataUpdate';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { stopCaffeinate } from '@/integrations/caffeinate';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from '@/agent/runtime/permissionModeCanonical';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissionModeFromMetadata';
import { resolveStartupPermissionModeFromSession } from '@/agent/runtime/startupPermissionModeSeed';
import { createAcpSessionModeOverrideSynchronizer } from '@/agent/runtime/acpSessionModeOverrideSync';
import { createAcpConfigOptionOverrideSynchronizer } from '@/agent/runtime/acpConfigOptionOverrideSync';
import { createModelOverrideSynchronizer } from '@/agent/runtime/modelOverrideSync';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';

import type { McpServerConfig } from '@/agent';
import { createAuggieAcpRuntime } from '@/backends/auggie/acp/runtime';
import { waitForNextAuggieMessage } from '@/backends/auggie/utils/waitForNextAuggieMessage';
import { readAuggieAllowIndexingFromEnv } from '@/backends/auggie/utils/env';
import { AuggieTerminalDisplay } from '@/backends/auggie/ui/AuggieTerminalDisplay';

function formatAuggiePromptError(err: unknown): { message: string; isAuthError: boolean } {
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    return { message: err.message, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401') };
  }
  if (typeof err === 'string') {
    const lower = err.toLowerCase();
    return { message: err, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401') };
  }
  if (err && typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message;
    const maybeCode = (err as { code?: unknown }).code;
    const maybeDetails = (err as { data?: unknown }).data as { details?: unknown } | undefined;

    const message = typeof maybeMessage === 'string' ? maybeMessage : null;
    const details = typeof maybeDetails?.details === 'string' ? maybeDetails.details : null;
    const code = typeof maybeCode === 'number' ? maybeCode : null;

    const combined =
      details && message ? `${message}${typeof code === 'number' ? ` (code ${code})` : ''}: ${details}` : (details ?? message);
    if (combined) {
      const lower = combined.toLowerCase();
      return { message: combined, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('api key') || lower.includes('token') || lower.includes('401') };
    }

    try {
      const json = JSON.stringify(err);
      const lower = json.toLowerCase();
      return { message: json, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401') };
    } catch {
      return { message: String(err), isAuthError: false };
    }
  }
  return { message: String(err), isAuthError: false };
}

export async function runAuggie(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  terminalRuntime?: import('@/terminal/terminalRuntimeFlags').TerminalRuntimeFlags | null;
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  existingSessionId?: string;
  resume?: string;
}): Promise<void> {
  const sessionTag = randomUUID();
  const explicitPermissionMode = opts.permissionMode;

  connectionState.setBackend('Auggie');

  const api = await ApiClient.create(opts.credentials);

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings. Please report this issue on https://github.com/happier-dev/happier/issues`);
    process.exit(1);
  }
  await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });

  const initialPermissionMode = normalizePermissionModeToIntent(opts.permissionMode ?? 'default') ?? 'default';

  const allowIndexingFromEnv = readAuggieAllowIndexingFromEnv();

  const { state, metadata } = createSessionMetadata({
    flavor: 'auggie',
    machineId,
    startedBy: opts.startedBy,
    terminalRuntime: opts.terminalRuntime ?? null,
    permissionMode: initialPermissionMode,
    permissionModeUpdatedAt: typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : Date.now(),
    agentModeId: opts.agentModeId,
    agentModeUpdatedAt: opts.agentModeUpdatedAt,
    modelId: opts.modelId,
    modelUpdatedAt: opts.modelUpdatedAt,
  });

  // Persist the indexing choice in metadata so it can be inspected/toggled from the app.
  metadata.auggieAllowIndexing = allowIndexingFromEnv;

  const terminal = metadata.terminal;
  let session: ApiSessionClient;
  let permissionHandler: ProviderEnforcedPermissionHandler;
  let reconnectionHandle: { cancel: () => void } | null = null;

  const normalizedExistingSessionId = typeof opts.existingSessionId === 'string' ? opts.existingSessionId.trim() : '';

  let allowIndexing = allowIndexingFromEnv;

  if (normalizedExistingSessionId) {
    logger.debug(`[auggie] Attaching to existing Happy session: ${normalizedExistingSessionId}`);
    const baseSession = await createBaseSessionForAttach({ existingSessionId: normalizedExistingSessionId, metadata, state });
    session = api.sessionSyncClient(baseSession);

    let snapshot: unknown = null;
    let snapshotError: unknown = null;
    try {
      snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 30_000 });
    } catch (error) {
      snapshotError = error;
    }
    if (!snapshot) {
      logger.debug(
        '[auggie] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        snapshotError ?? undefined,
      );
    } else {
      applyStartupMetadataUpdateToSession({
        session,
        next: metadata,
        nowMs: Date.now(),
        permissionModeOverride: buildPermissionModeOverride({
          permissionMode: opts.permissionMode,
          permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
        }),
        acpSessionModeOverride: buildAcpSessionModeOverride({
          agentModeId: opts.agentModeId,
          agentModeUpdatedAt: opts.agentModeUpdatedAt,
        }),
        modelOverride: buildModelOverride({
          modelId: opts.modelId,
          modelUpdatedAt: opts.modelUpdatedAt,
        }),
        mode: 'attach',
      });
    }

    // If the UI has toggled indexing for this session, prefer the stored metadata.
    // Env var remains the highest priority override (useful for debugging/local runs).
    const current = session.getMetadataSnapshot?.() ?? null;
    const stored = typeof current?.auggieAllowIndexing === 'boolean' ? current.auggieAllowIndexing : null;
    if (!allowIndexingFromEnv && typeof stored === 'boolean') {
      allowIndexing = stored;
    }

    primeAgentStateForUi(session, '[Auggie]');
    await reportSessionToDaemonIfRunning({ sessionId: normalizedExistingSessionId, metadata });
    await persistTerminalAttachmentInfoIfNeeded({ sessionId: normalizedExistingSessionId, terminal });
    sendTerminalFallbackMessageIfNeeded({ session, terminal });
  } else {
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    if (!response) {
      throw new Error('Failed to create session');
    }

    const { session: initialSession, reconnectionHandle: rh } = setupOfflineReconnection({
      api,
      sessionTag,
      metadata,
      state,
      response,
      onSessionSwap: (newSession) => {
        session = newSession;
        if (permissionHandler) {
          permissionHandler.updateSession(newSession);
        }
      },
    });
    session = initialSession;
    reconnectionHandle = rh;

    primeAgentStateForUi(session, '[Auggie]');
    await reportSessionToDaemonIfRunning({ sessionId: response.id, metadata });
    await persistTerminalAttachmentInfoIfNeeded({ sessionId: response.id, terminal });
    sendTerminalFallbackMessageIfNeeded({ session, terminal });
  }

  // Start Happier MCP server for `change_title` tool exposure (bridged to ACP via happier-mcp.mjs).
  const happierMcpServer = await startHappyServer(session);

  const bridgeCommand = join(projectPath(), 'bin', 'happier-mcp.mjs');
  const mcpServers: Record<string, McpServerConfig> = {
    happier: { command: bridgeCommand, args: ['--url', happierMcpServer.url] },
  };

  let abortRequestedCallback: (() => void | Promise<void>) | null = null;
  permissionHandler = createProviderEnforcedPermissionHandler({
    session,
    logPrefix: '[Auggie]',
    onAbortRequested: () => abortRequestedCallback?.(),
  });
  permissionHandler.setPermissionMode(initialPermissionMode);

  const messageQueue = new MessageQueue2<{ permissionMode: PermissionMode }>((mode) => hashObject({
    permissionMode: mode.permissionMode,
  }));

  let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
  let currentPermissionModeUpdatedAt: number =
    typeof session.getMetadataSnapshot()?.permissionModeUpdatedAt === 'number'
      ? (session.getMetadataSnapshot()?.permissionModeUpdatedAt as number)
      : 0;

  session.onUserMessage((message) => {
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const nextPermissionMode = normalizePermissionModeToIntent(message.meta.permissionMode);
      if (nextPermissionMode) {
        const res = maybeUpdatePermissionModeMetadata({
          currentPermissionMode,
          nextPermissionMode,
          updateMetadata: (updater) => session.updateMetadata(updater),
          nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
        });
        currentPermissionMode = res.currentPermissionMode;
        messagePermissionMode = currentPermissionMode;
      }
    }

    const mode = { permissionMode: messagePermissionMode || 'default' };
    const special = parseSpecialCommand(message.content.text);
    if (special.type === 'clear') {
      messageQueue.pushIsolateAndClear(message.content.text, mode);
    } else {
      messageQueue.push(message.content.text, mode);
    }
  });

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;
  if (hasTTY) {
    console.clear();
    inkInstance = render(React.createElement(AuggieTerminalDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: async () => {
        shouldExit = true;
        await handleAbort();
      },
    }), { exitOnCtrlC: false, patchConsole: false });
  }

  let thinking = false;
  let shouldExit = false;
  let abortController = new AbortController();
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => session.keepAlive(thinking, 'remote'), 2000);

  const runtime = createAuggieAcpRuntime({
    directory: metadata.path,
    session,
    messageBuffer,
    mcpServers,
    permissionHandler,
    onThinkingChange: (value) => { thinking = value; },
    allowIndexing,
    getPermissionMode: () => currentPermissionMode ?? 'default',
  });

  const handleAbort = async () => {
    logger.debug('[Auggie] Abort requested');
    session.sendAgentMessage('auggie', { type: 'turn_aborted', id: randomUUID() });
    permissionHandler.reset();
    messageQueue.reset();
    try {
      abortController.abort();
      abortController = new AbortController();
      await runtime.cancel();
    } catch (e) {
      logger.debug('[Auggie] Failed to cancel current operation (non-fatal)', e);
    }
  };
  abortRequestedCallback = handleAbort;

  const handleKillSession = async () => {
    logger.debug('[Auggie] Kill session requested');
    shouldExit = true;
    await handleAbort();
    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }
    } finally {
      clearInterval(keepAliveInterval);
      reconnectionHandle?.cancel();
      stopCaffeinate();
      happierMcpServer.stop();
      await runtime.reset();
      inkInstance?.unmount();
      process.exit(0);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices("It's ready!", 'Auggie is waiting for your command', { sessionId: session.sessionId });
    } catch (pushError) {
      logger.debug('[Auggie] Failed to send ready push', pushError);
    }
  };

  let wasStarted = false;
  let storedSessionIdForResume: string | null = null;
  if (typeof opts.resume === 'string' && opts.resume.trim()) {
    storedSessionIdForResume = opts.resume.trim();
  }

  try {
    let currentModeHash: string | null = null;
    type QueuedMessage = { message: string; mode: { permissionMode: PermissionMode }; hash: string };
    let pending: QueuedMessage | null = null;

    const acpSessionModeSync = createAcpSessionModeOverrideSynchronizer({
      session: { getMetadataSnapshot: () => session.getMetadataSnapshot?.() ?? null },
      runtime: { setSessionMode: (modeId) => runtime.setSessionMode(modeId) },
      isStarted: () => wasStarted,
    });
    const configOptionSync = createAcpConfigOptionOverrideSynchronizer({
      session: { getMetadataSnapshot: () => session.getMetadataSnapshot?.() ?? null },
      runtime: { setSessionConfigOption: (configId, value) => runtime.setSessionConfigOption(configId, value) },
      isStarted: () => wasStarted,
    });
    const modelSync = createModelOverrideSynchronizer({
      session: { getMetadataSnapshot: () => session.getMetadataSnapshot?.() ?? null },
      runtime: { setSessionModel: (modelId) => runtime.setSessionModel(modelId) },
      isStarted: () => wasStarted,
    });

    if (typeof explicitPermissionMode !== 'string') {
      const seeded = await resolveStartupPermissionModeFromSession({ session, take: 50 });
      if (seeded && seeded.updatedAt > currentPermissionModeUpdatedAt) {
        currentPermissionModeUpdatedAt = seeded.updatedAt;
        currentPermissionMode = seeded.mode;
        permissionHandler.setPermissionMode(seeded.mode);
      }
    }

    const syncPermissionModeFromMetadata = () => {
      const resolved = resolvePermissionIntentFromMetadataSnapshot({
        metadata: session.getMetadataSnapshot(),
      });
      if (!resolved) return;
      if (resolved.updatedAt <= currentPermissionModeUpdatedAt) return;
      currentPermissionModeUpdatedAt = resolved.updatedAt;
      currentPermissionMode = resolved.intent;
      permissionHandler.setPermissionMode(resolved.intent);
    };

    const syncControlsFromMetadata = () => {
      syncPermissionModeFromMetadata();
      acpSessionModeSync.syncFromMetadata();
      configOptionSync.syncFromMetadata();
      modelSync.syncFromMetadata();
    };

    // Capture any startup override already present in the snapshot so we can apply it immediately after runtime start.
    syncControlsFromMetadata();

    while (!shouldExit) {
      let message: QueuedMessage | null = pending;
      pending = null;

      if (!message) {
        const next = await waitForNextAuggieMessage({
          messageQueue,
          abortSignal: abortController.signal,
          session,
          onMetadataUpdate: syncControlsFromMetadata,
        });
        if (!next) continue;
        message = { message: next.message, mode: next.mode, hash: next.hash };
      }
      if (!message) continue;

      permissionHandler.setPermissionMode(message.mode.permissionMode);

      if (wasStarted && currentModeHash && message.hash !== currentModeHash) {
        const resumeId = runtime.getSessionId();
        currentModeHash = message.hash;
        if (resumeId) storedSessionIdForResume = resumeId;

        messageBuffer.addMessage('Restarting Auggie session (permission settings changed)…', 'status');
        await runtime.reset();
        wasStarted = false;
        permissionHandler.reset();
        thinking = false;
        session.keepAlive(thinking, 'remote');

        pending = message;
        continue;
      }

      currentModeHash = message.hash;

      messageBuffer.addMessage(message.message, 'user');

      const special = parseSpecialCommand(message.message);
      if (special.type === 'clear') {
        messageBuffer.addMessage('Resetting Auggie session…', 'status');
        await runtime.reset();
        wasStarted = false;
        permissionHandler.reset();
        thinking = false;
        session.keepAlive(thinking, 'remote');
        messageBuffer.addMessage('Session reset.', 'status');
        sendReady();
        continue;
      }

      try {
        runtime.beginTurn();
        if (!wasStarted) {
          const resumeId = storedSessionIdForResume?.trim();
          if (resumeId) {
            storedSessionIdForResume = null; // consume once
            messageBuffer.addMessage('Resuming previous context…', 'status');
            try {
              await runtime.startOrLoad({ resumeId });
            } catch (e) {
              logger.debug('[Auggie] Resume failed; starting a new session instead', e);
              messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
              session.sendAgentMessage('auggie', { type: 'message', message: 'Resume failed; starting a new session.' });
              await runtime.startOrLoad({});
            }
          } else {
            await runtime.startOrLoad({});
          }
          wasStarted = true;
          await acpSessionModeSync.flushPendingAfterStart();
          await configOptionSync.flushPendingAfterStart();
          await modelSync.flushPendingAfterStart();
        }
        await runtime.sendPrompt(message.message);
      } catch (error) {
        logger.debug('[Auggie] Error during prompt:', error);
        const formatted = formatAuggiePromptError(error);
        const extraHint = formatted.isAuthError
          ? 'Auggie appears not authenticated. Run `auggie login` on this machine (the same user running the daemon) and try again.'
          : null;
        session.sendAgentMessage('auggie', {
          type: 'message',
          message: `Error: ${formatted.message}${extraHint ? `\n\n${extraHint}` : ''}`,
        });
      } finally {
        runtime.flushTurn();
        // Avoid missing ACP mode override updates that land while we're mid-turn.
        acpSessionModeSync.syncFromMetadata();
        configOptionSync.syncFromMetadata();
        modelSync.syncFromMetadata();
        thinking = false;
        session.keepAlive(thinking, 'remote');
        sendReady();
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    stopCaffeinate();
    happierMcpServer.stop();
    await runtime.reset();
    inkInstance?.unmount();
  }
}
