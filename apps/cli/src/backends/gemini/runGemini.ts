/**
 * Gemini CLI Entry Point
 * 
 * This module provides the main entry point for running the Gemini agent
 * through Happier CLI. It manages the agent lifecycle, session state, and
 * communication with the Happier server and app.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { resolve } from 'node:path';

import { logger } from '@/ui/logger';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import { Credentials } from '@/persistence';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { configuration } from '@/configuration';
import packageJson from '../../../package.json';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { emitReadyIfIdle as emitReadyIfIdleShared } from '@/agent/runtime/emitReadyIfIdle';
import { hashObject } from '@/utils/deterministicJson';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { stopCaffeinate } from '@/integrations/caffeinate';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { formatGeminiErrorForUi } from '@/backends/gemini/utils/formatGeminiErrorForUi';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permission/permissionModeMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { archiveAndCloseSession } from '@/agent/runtime/archiveAndCloseSession';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { initializeRuntimeOverridesSynchronizer } from '@/agent/runtime/runtimeOverridesSynchronizer';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';

import type { AgentBackend } from '@/agent';
import { GeminiReasoningProcessor } from '@/backends/gemini/utils/reasoningProcessor';
import { GeminiDiffProcessor } from '@/backends/gemini/utils/diffProcessor';
import type { GeminiMode, CodexMessagePayload } from '@/backends/gemini/types';
import type { PermissionMode } from '@/api/types';
import { GEMINI_MODEL_ENV } from '@/backends/gemini/constants';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from '@/agent/runtime/permission/permissionModeCanonical';
import {
  readGeminiLocalConfig,
  saveGeminiModelToConfig,
  getInitialGeminiModel
} from '@/backends/gemini/utils/config';
import { maybeUpdateGeminiSessionIdMetadata } from '@/backends/gemini/utils/geminiSessionIdMetadata';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import {
  parseOptionsFromText,
  hasIncompleteOptions,
  formatOptionsXml,
} from '@/backends/gemini/utils/optionsParser';
import { ConversationHistory } from '@/backends/gemini/utils/conversationHistory';
import { createGeminiBackendMessageHandler } from '@/backends/gemini/runtime/createGeminiBackendMessageHandler';
import {
  createGeminiTurnMessageState,
  resetGeminiTurnMessageStateAfterTurn,
  resetGeminiTurnMessageStateForPrompt,
} from '@/backends/gemini/runtime/geminiTurnMessageState';
import { createGeminiBackendInstance } from '@/backends/gemini/runtime/createGeminiBackendInstance';
import { ensureGeminiAcpSession } from '@/backends/gemini/runtime/ensureGeminiAcpSession';
import { sendGeminiPromptWithRetry } from '@/backends/gemini/runtime/sendGeminiPromptWithRetry';
import { createGeminiTerminalUi } from '@/backends/gemini/runtime/createGeminiTerminalUi';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';


/**
 * Main entry point for the gemini command with ink UI
 */
export async function runGemini(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  terminalRuntime?: import('@/terminal/runtime/terminalRuntimeFlags').TerminalRuntimeFlags | null;
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  existingSessionId?: string;
  resume?: string;
}): Promise<void> {
  //
  // Define session
  //

  
  const sessionTag = randomUUID();
  const explicitPermissionMode = opts.permissionMode;

  // Set backend for offline warnings (before any API calls)
  connectionState.setBackend('Gemini');

  const { api, machineId } = await initializeBackendApiContext({
    credentials: opts.credentials,
    machineMetadata: initialMachineMetadata,
    missingMachineIdMessage: '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues',
    skipMachineRegistration: opts.startedBy === 'daemon',
  });


  //
  // Machine
  //

  logger.debug(`Using machineId: ${machineId}`);

  //
  // Best-effort: decode connected-services id_token email (used to select per-account Google Cloud Project config).
  // Do NOT treat connected-service OAuth access_token as an API key; Gemini CLI uses oauth-personal via ~/.gemini/oauth_creds.json.
  //
  let currentUserEmail: string | undefined = undefined;
  try {
    const { resolveConnectedServiceCredentials } = await import('@/cloud/connectedServices/resolveConnectedServiceCredentials');
    const { decodeJwtPayload } = await import('@/cloud/decodeJwtPayload');

    const records = await resolveConnectedServiceCredentials({
      credentials: opts.credentials,
      api,
      bindings: [{ serviceId: 'gemini', profileId: 'default' }],
    });
    const record = records.get('gemini');
    if (record?.kind === 'oauth' && record.oauth.idToken) {
      const payload = decodeJwtPayload(record.oauth.idToken);
      const email = payload && typeof payload.email === 'string' ? payload.email : null;
      if (email) {
        currentUserEmail = email;
        logger.debug(`[Gemini] Current user email: ${currentUserEmail}`);
      }
    }
  } catch (error) {
    logger.debug('[Gemini] Failed to fetch connected-services metadata (non-fatal):', error);
  }

  //
  // Create session
  //

  const accountSettings = getActiveAccountSettingsSnapshot()?.settings ?? null;
  const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
    agentId: 'gemini',
    explicitPermissionMode: opts.permissionMode,
    accountSettings,
  });
  const initialPermissionMode: PermissionMode = permissionModeSeed.mode;

  const { state, metadata } = createSessionMetadata({
    flavor: 'gemini',
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

  // Handle server unreachable case - create offline stub with hot reconnection
  let session: ApiSessionClient;
  let reconnectionHandle: { cancel: () => void } | null = null;
  // Permission handler declared here so it can be updated in onSessionSwap callback
  // (assigned later after Happier server setup)
  let permissionHandler: ProviderEnforcedPermissionHandler;

  // Session swap synchronization to prevent race conditions during message processing
  // When a swap is requested during processing, it's queued and applied after the current cycle
  let isProcessingMessage = false;
  let pendingSessionSwap: ApiSessionClient | null = null;

  /**
   * Apply a pending session swap. Called between message processing cycles.
   * This ensures session swaps happen at safe points, not during message processing.
   */
  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[gemini] Applying pending session swap');
      session = pendingSessionSwap;
      if (permissionHandler) {
        permissionHandler.updateSession(pendingSessionSwap);
      }
      pendingSessionSwap = null;
    }
  };

  const initializedSession = await initializeBackendRunSession({
    api,
    sessionTag,
    metadata,
    state,
    existingSessionId: opts.existingSessionId,
    uiLogPrefix: '[gemini]',
    startupMetadataOverrides: createStartupMetadataOverrides(opts),
    startupSideEffectsOrder: 'persist-first',
    allowOfflineStub: true,
    onSessionSwap: (newSession) => {
      // If we're processing a message, queue the swap for later
      // This prevents race conditions where session changes mid-processing
      if (isProcessingMessage) {
        logger.debug('[gemini] Session swap requested during message processing - queueing');
        pendingSessionSwap = newSession;
      } else {
        // Safe to swap immediately
        session = newSession;
        if (permissionHandler) {
          permissionHandler.updateSession(newSession);
        }
      }
    },
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[gemini] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
  });

  session = initializedSession.session;
  reconnectionHandle = initializedSession.reconnectionHandle;

  const messageQueue = new MessageQueue2<GeminiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Conversation history for context preservation across model changes
  const conversationHistory = new ConversationHistory({ maxMessages: 20, maxCharacters: 50000 });

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
  let currentPermissionModeUpdatedAt: number = typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : 0;
  let currentModel: string | undefined = undefined;
  let currentModelOverride: string | undefined = undefined;
  let currentModelOverrideUpdatedAt: number = 0;

  const runtimePermissionModeRef = { current: currentPermissionMode ?? 'default', updatedAt: currentPermissionModeUpdatedAt };
  const runtimeModelOverrideRef = { current: currentModelOverride ?? null, updatedAt: currentModelOverrideUpdatedAt };
  let runtimeOverridesSync: Awaited<ReturnType<typeof initializeRuntimeOverridesSynchronizer>> | null = null;

  session.onUserMessage((message) => {
    // Resolve permission mode (validate) - same as Codex
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const nextPermissionMode = normalizePermissionModeToIntent(message.meta.permissionMode);
      if (nextPermissionMode) {
        const updatedAt = resolvePermissionModeUpdatedAtFromMessage(message);
        const res = maybeUpdatePermissionModeMetadata({
          currentPermissionMode,
          nextPermissionMode,
          updateMetadata: (updater) =>
            updateMetadataBestEffort(session, updater, '[Gemini]', 'permission_mode_from_user_message'),
          nowMs: () => updatedAt,
        });
        currentPermissionMode = res.currentPermissionMode;
        messagePermissionMode = currentPermissionMode;
        if (res.didChange) {
          currentPermissionModeUpdatedAt = updatedAt;
          runtimePermissionModeRef.current = currentPermissionMode ?? 'default';
          runtimePermissionModeRef.updatedAt = currentPermissionModeUpdatedAt;
          // Update permission handler with new mode
          updatePermissionMode(messagePermissionMode);
          logger.debug(`[Gemini] Permission mode updated from user message to: ${currentPermissionMode}`);
        }
      }
    } else {
      logger.debug(`[Gemini] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
    }

    // Resolve model; explicit null resets to default (undefined).
    // Precedence: message meta > session metadata override > last in-memory selection.
    let messageModel = currentModelOverride ?? currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      // If model is explicitly null, reset internal state but don't update displayed model
      // If model is provided, use it and update displayed model
      // Otherwise keep current model
      if (message.meta.model === null) {
        messageModel = undefined; // Explicitly reset - will use default/env/config
        currentModel = undefined;
        // Don't call updateDisplayedModel here - keep current displayed model
        // The backend will use the correct model from env/config/default
      } else if (message.meta.model) {
        const previousModel = currentModel;
        messageModel = message.meta.model;
        currentModel = messageModel;
        // Only update UI and show message if model actually changed
        if (previousModel !== messageModel) {
          // Save model to config file so it persists across sessions
          geminiTerminalUi.updateDisplayedModel(messageModel, true); // Update UI and save to config
          // Show model change message in UI (this will trigger UI re-render)
          messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
          logger.debug(`[Gemini] Model changed from ${previousModel} to ${messageModel}`);
        }
      }
      // If message.meta.model is undefined, keep currentModel
    }

    // Build the full prompt with appendSystemPrompt if provided
    // Only include system prompt for the first message to avoid forcing tool usage on every message
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      // Prepend system prompt to user message only for first message
      // Also add change_title instruction (like Codex does)
      // Use EXACT same format as Codex: add instruction AFTER user message
      // This matches Codex's approach exactly - instruction comes after user message
      // Codex format: system prompt + user message + change_title instruction
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: GeminiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage, // Store original message separately
    };
    messageQueue.push(fullPrompt, mode);
    
    // Record user message in conversation history for context preservation
    conversationHistory.addUserMessage(originalUserMessage);
  });

  const turnMessageState = createGeminiTurnMessageState();
  session.keepAlive(turnMessageState.thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(turnMessageState.thinking, 'remote');
  }, 2000);

  // Track if this is the first message to include system prompt only once
  let isFirstMessage = true;

  const sendReady = () => {
    sendReadyWithPushNotification({
      session,
      pushSender: api.push(),
      waitingForCommandLabel: 'Gemini',
      logPrefix: '[Gemini]',
    });
  };

  /**
   * Check if we can emit ready event
   * * Returns true when ready event was emitted
   */
  const emitReadyIfIdle = (): boolean => {
    return emitReadyIfIdleShared({
      pending: turnMessageState.thinking || turnMessageState.isResponseInProgress,
      queueSize: () => messageQueue.size(),
      shouldExit,
      sendReady,
    });
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let geminiBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;
  let storedResumeId: string | null = (() => {
    const raw = typeof opts.resume === 'string' ? opts.resume.trim() : '';
    return raw ? raw : null;
  })();

  const lastGeminiSessionIdPublished: { value: string | null } = { value: null };

  async function handleAbort() {
    logger.debug('[Gemini] Abort requested - stopping current task');
    
    // Send turn_aborted event (like Codex) when abort is requested
    session.sendAgentMessage('gemini', {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    
    // Abort reasoning processor and reset diff processor
    reasoningProcessor.abort();
    diffProcessor.reset();
    
    try {
      abortController.abort();
      messageQueue.reset();
      if (geminiBackend && acpSessionId) {
        await geminiBackend.cancel(acpSessionId);
      }
      logger.debug('[Gemini] Abort completed - session remains active');
    } catch (error) {
      logger.debug('[Gemini] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  let terminationHandlers: ReturnType<typeof registerRunnerTerminationHandlers> | null = null;

  //
  // Initialize Ink UI
  //

  const messageBuffer = new MessageBuffer();
  const hasTTY = resolveHasTTY({
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    startedBy: opts.startedBy,
  });
  const initialDisplayedModel = getInitialGeminiModel();
  
  // Log initial values
  const localConfig = readGeminiLocalConfig();
  logger.debug(`[gemini] Initial model setup: env[GEMINI_MODEL_ENV]=${process.env[GEMINI_MODEL_ENV] || 'not set'}, localConfig=${localConfig.model || 'not set'}, displayedModel=${initialDisplayedModel}`);

  const geminiTerminalUi = createGeminiTerminalUi({
    messageBuffer,
    hasTTY,
    stdin: process.stdin,
    logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
    initialModel: initialDisplayedModel,
    onExit: async () => {
      logger.debug('[gemini]: Exiting agent via Ctrl-C');
      shouldExit = true;
      await handleAbort();
    },
    onDebug: (message) => logger.debug(message),
    saveModelToConfig: saveGeminiModelToConfig,
  });
  geminiTerminalUi.mount();

  //
  // Start Happier MCP server and create Gemini backend
  //

  const { happierMcpServer, mcpServers } = await createHappierMcpBridge(session, {
    commandMode: 'current-process',
  });

  terminationHandlers = registerRunnerTerminationHandlers({
    process,
    exit: (code) => process.exit(code),
    onTerminate: async (_event, outcome) => {
      shouldExit = true;
      await handleAbort();

      try {
        if (outcome.archive) {
          await archiveAndCloseSession(session);
        }
      } catch (e) {
        logger.debug('[Gemini] Failed to archive session during termination (non-fatal)', e);
      }

      stopCaffeinate();

      // Best-effort cleanup (mirrors the finally block).
      logger.debug('[gemini]: Termination cleanup start');
      try {
        if (reconnectionHandle) {
          reconnectionHandle.cancel();
        }

        try {
          session.sendSessionDeath();
          await session.flush();
          await session.close();
        } catch (e) {
          logger.debug('[gemini]: Error while closing session', e);
        }

        if (geminiBackend) {
          const backendToDispose = geminiBackend;
          await backendToDispose.dispose();
        }

        happierMcpServer.stop();
        await geminiTerminalUi.unmount();
        clearInterval(keepAliveInterval);
        messageBuffer.clear();
      } catch (e) {
        logger.debug('[gemini]: Termination cleanup failure (non-fatal)', e);
      }
    },
  });

  const handleKillSession = async () => {
    logger.debug('[Gemini] Kill session requested - terminating process');
    terminationHandlers?.requestTermination({ kind: 'killSession' });
    await terminationHandlers?.whenTerminated;
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Create permission handler for tool approval (variable declared earlier for onSessionSwap)
  permissionHandler = createProviderEnforcedPermissionHandler({
    session,
    logPrefix: '[Gemini]',
    onAbortRequested: handleAbort,
    alwaysAutoApproveToolNameIncludes: ['geminireasoning', 'codexreasoning'],
  });
  
  // Create reasoning processor for handling thinking/reasoning chunks
  const reasoningProcessor = new GeminiReasoningProcessor((message) => {
    // Callback to send messages directly from the processor
    session.sendAgentMessage('gemini', message);
  });
  
  // Create diff processor for handling file edit events and diff tracking
  const diffProcessor = new GeminiDiffProcessor((message) => {
    // Callback to send messages directly from the processor
    session.sendAgentMessage('gemini', message);
  });
  
  // Update permission handler when permission mode changes
  const updatePermissionMode = (mode: PermissionMode) => {
    permissionHandler.setPermissionMode(mode);
  };

  /**
   * Set up message handler for Gemini backend
   * This function is called when backend is created or recreated
   */
  function setupGeminiMessageHandler(backend: AgentBackend): void {
    backend.onMessage(
      createGeminiBackendMessageHandler({
        session,
        messageBuffer,
        state: turnMessageState,
        reasoningProcessor,
        diffProcessor,
      }),
    );
  }

  const adoptGeminiBackend = (
    backendResult: { backend: AgentBackend; model: string; modelSource: string },
    opts: { reason: 'initial' | 'mode-change'; modelToUse: string | null | undefined },
  ): AgentBackend => {
    const backend = backendResult.backend;
    setupGeminiMessageHandler(backend);

    const actualModel = backendResult.model;
    if (opts.reason === 'mode-change') {
      logger.debug(`[gemini] Model change - modelToUse=${opts.modelToUse}, actualModel=${actualModel} (from ${backendResult.modelSource})`);
    } else {
      logger.debug(`[gemini] Backend created, model will be: ${actualModel} (from ${backendResult.modelSource})`);
    }
    logger.debug(`[gemini] Calling updateDisplayedModel with: ${actualModel}`);
    geminiTerminalUi.updateDisplayedModel(actualModel, false);
    conversationHistory.setCurrentModel(actualModel);
    return backend;
  };

  // Note: Backend will be created dynamically in the main loop based on model from first message
  // This allows us to support model changes by recreating the backend

  let first = true;

  try {
	    let currentModeHash: string | null = null;
	    let pending: { message: string; mode: GeminiMode; isolate: boolean; hash: string } | null = null;

	    runtimeOverridesSync = await initializeRuntimeOverridesSynchronizer({
	      explicitPermissionMode:
	        typeof explicitPermissionMode === 'string'
	          ? normalizePermissionModeToIntent(explicitPermissionMode) ?? undefined
	          : undefined,
	      sessionKind: typeof opts.existingSessionId === 'string' && opts.existingSessionId.trim() ? 'attach' : 'fresh',
	      take: configuration.startupPermissionSeedTranscriptTake,
	      session: {
	        getMetadataSnapshot: () => session.getMetadataSnapshot(),
	        fetchLatestUserPermissionIntentFromTranscript: (args) => session.fetchLatestUserPermissionIntentFromTranscript(args),
	      },
	      permissionMode: runtimePermissionModeRef,
	      modelOverride: runtimeModelOverrideRef,
	      onPermissionModeApplied: () => {
	        currentPermissionMode = runtimePermissionModeRef.current;
	        currentPermissionModeUpdatedAt = runtimePermissionModeRef.updatedAt;
	        updatePermissionMode(runtimePermissionModeRef.current);
	        logger.debug(`[Gemini] Permission mode updated from sync to: ${runtimePermissionModeRef.current}`);
	      },
	      onModelOverrideApplied: () => {
	        currentModelOverride = runtimeModelOverrideRef.current ?? undefined;
	        currentModelOverrideUpdatedAt = runtimeModelOverrideRef.updatedAt;
	        logger.debug(`[Gemini] Model override updated from sync to: ${runtimeModelOverrideRef.current ?? 'default'}`);
	      },
	    });
	    runtimeOverridesSync.syncFromMetadata();
	    void runtimeOverridesSync.seedFromSession().catch(() => {
	      // Best-effort only.
	    });

	    const syncControlsFromMetadata = () => {
	      runtimeOverridesSync?.syncFromMetadata();
	    };

    while (!shouldExit) {
      let message: { message: string; mode: GeminiMode; isolate: boolean; hash: string } | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[gemini] Main loop: waiting for messages from queue...');
        const waitSignal = abortController.signal;
        const batch = await waitForMessagesOrPending({
          messageQueue,
          abortSignal: waitSignal,
          popPendingMessage: () => session.popPendingMessage(),
          waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
          onMetadataUpdate: syncControlsFromMetadata,
        });
        if (!batch) {
          if (waitSignal.aborted && !shouldExit) {
            logger.debug('[gemini] Main loop: wait aborted, continuing...');
            continue;
          }
          logger.debug('[gemini] Main loop: no batch received, breaking...');
          break;
        }
        logger.debug(`[gemini] Main loop: received message from queue (length: ${batch.message.length})`);
        message = batch;
      }

      if (!message) {
        break;
      }

      // Track if we need to inject conversation history (after model change)
      let injectHistoryContext = false;
      
      // Handle mode change (like Codex) - restart session if permission mode or model changed
      if (wasSessionCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug('[Gemini] Mode changed – restarting Gemini session');
        messageBuffer.addMessage('═'.repeat(40), 'status');
        
        // Check if we have conversation history to preserve
        if (conversationHistory.hasHistory()) {
          messageBuffer.addMessage(`Switching model (preserving ${conversationHistory.size()} messages of context)...`, 'status');
          injectHistoryContext = true;
          logger.debug(`[Gemini] Will inject conversation history: ${conversationHistory.getSummary()}`);
        } else {
          messageBuffer.addMessage('Starting new Gemini session (mode changed)...', 'status');
        }
        
        // Reset permission handler and reasoning processor on mode change (like Codex)
        permissionHandler.reset();
        reasoningProcessor.abort();
        
        // Dispose old backend and create new one with new model
        if (geminiBackend) {
          const backendToDispose = geminiBackend;
          await backendToDispose.dispose();
          geminiBackend = null;
        }

        // Create new backend with new model
        const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
        const backendResult = await createGeminiBackendInstance({
          cwd: process.cwd(),
          mcpServers,
          permissionHandler,
          currentUserEmail,
          permissionMode: message.mode.permissionMode,
          model: modelToUse,
        });
        geminiBackend = adoptGeminiBackend(backendResult, { reason: 'mode-change', modelToUse });
        
        logger.debug('[gemini] Starting new ACP session with model:', backendResult.model);
        const activeBackend = geminiBackend;
        if (!activeBackend) {
          throw new Error('Gemini backend not initialized after mode change');
        }
        const { sessionId } = await activeBackend.startSession();
        acpSessionId = sessionId;
        logger.debug(`[gemini] New ACP session started: ${acpSessionId}`);
        maybeUpdateGeminiSessionIdMetadata({
          getGeminiSessionId: () => acpSessionId,
          updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
          lastPublished: lastGeminiSessionIdPublished,
        });
        
        // Update permission handler with current permission mode
        updatePermissionMode(message.mode.permissionMode);
        
        wasSessionCreated = true;
        currentModeHash = message.hash;
        first = false; // Not first message anymore
      }

      currentModeHash = message.hash;
      // Show only original user message in UI, not the full prompt with system prompt
      const userMessageToShow = message.mode?.originalUserMessage || message.message;
      messageBuffer.addMessage(userMessageToShow, 'user');

      // Mark that we're processing a message to synchronize session swaps
      isProcessingMessage = true;

      try {
        if (first || !wasSessionCreated) {
          // First message or session not created yet - create backend and start session
          if (!geminiBackend) {
            const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
            const backendResult = await createGeminiBackendInstance({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              currentUserEmail,
              permissionMode: message.mode.permissionMode,
              model: modelToUse,
            });
            geminiBackend = adoptGeminiBackend(backendResult, { reason: 'initial', modelToUse });
          }
          
          // Start session if not started
          if (!acpSessionId) {
            logger.debug('[gemini] Starting ACP session...');
            // Update permission handler with current permission mode before starting session
            updatePermissionMode(message.mode.permissionMode);
            const activeBackend = geminiBackend;
            if (!activeBackend) {
              throw new Error('Gemini backend not initialized before session bootstrap');
            }
            const ensuredSession = await ensureGeminiAcpSession({
              backend: activeBackend,
              session,
              permissionHandler,
              messageBuffer,
              storedResumeId,
              onDebug: (msg) => logger.debug(msg),
            });
            acpSessionId = ensuredSession.acpSessionId;
            storedResumeId = ensuredSession.storedResumeId;
            maybeUpdateGeminiSessionIdMetadata({
              getGeminiSessionId: () => acpSessionId,
              updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
              lastPublished: lastGeminiSessionIdPublished,
            });
            wasSessionCreated = true;
            currentModeHash = message.hash;
            
            // Model info is already shown in status bar via updateDisplayedModel
            logger.debug(`[gemini] Displaying model in UI: ${geminiTerminalUi.getDisplayedModel() || 'gemini-2.5-pro'}, displayedModel: ${geminiTerminalUi.getDisplayedModel()}`);
          }
        }
        
        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }
         
        // Reset accumulator when sending a new prompt (not when tool calls start)
        // Reset accumulated response for new prompt
        // This ensures a new assistant message will be created (not updating previous one)
        resetGeminiTurnMessageStateForPrompt(turnMessageState, message.message);
        
        if (!geminiBackend || !acpSessionId) {
          throw new Error('Gemini backend or session not initialized');
        }
        
        // The prompt already includes system prompt and change_title instruction (added in onUserMessage handler)
        // This is done in the message queue, so message.message already contains everything
        let promptToSend = message.message;
        
        // Inject conversation history context if model was just changed
        if (injectHistoryContext && conversationHistory.hasHistory()) {
          const historyContext = conversationHistory.getContextForNewSession();
          promptToSend = historyContext + promptToSend;
          logger.debug(`[gemini] Injected conversation history context (${historyContext.length} chars)`);
          // Don't clear history - keep accumulating for future model changes
        }
        
        logger.debug(`[gemini] Sending prompt to Gemini (length: ${promptToSend.length}): ${promptToSend.substring(0, 100)}...`);
        logger.debug(`[gemini] Full prompt: ${promptToSend}`);
        
        await sendGeminiPromptWithRetry({
          backend: geminiBackend,
          acpSessionId,
          prompt: promptToSend,
          messageBuffer,
          session,
          onDebug: (msg) => logger.debug(msg),
          maxRetries: 3,
          retryDelayMs: 2_000,
          waitForResponseTimeoutMs: 120_000,
        });
        
        // Mark as not first message after sending prompt
        if (first) {
          first = false;
        }
      } catch (error) {
        logger.debug('[gemini] Error in gemini session:', error);
        const isAbortError = error instanceof Error && error.name === 'AbortError';

        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          const errorMsg = formatGeminiErrorForUi(error, geminiTerminalUi.getDisplayedModel());
          
          messageBuffer.addMessage(errorMsg, 'status');
          // Use sendAgentMessage for consistency with ACP format
          session.sendAgentMessage('gemini', {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        // Metadata updates can arrive while a turn is in-flight. Sync again at turn-end so the
        // next turn observes the latest session-scoped control overrides.
        syncControlsFromMetadata();

        // Reset permission handler, reasoning processor, and diff processor after turn (like Codex)
        permissionHandler.reset();
        reasoningProcessor.abort(); // Use abort to properly finish any in-progress tool calls
        diffProcessor.completeTurn(); // Emit per-turn diffs (if any), then reset
        
        // Send accumulated response to mobile app ONLY when turn is complete
        // This prevents message fragmentation from Gemini's chunked responses
        if (turnMessageState.accumulatedResponse.trim()) {
          const { text: messageText, options } = parseOptionsFromText(turnMessageState.accumulatedResponse);
          
          // Record assistant response in conversation history for context preservation
          conversationHistory.addAssistantMessage(messageText);
          
          // Mobile app parses options from text via parseMarkdown
          let finalMessageText = messageText;
          if (options.length > 0) {
            const optionsXml = formatOptionsXml(options);
            finalMessageText = messageText + optionsXml;
            logger.debug(`[gemini] Found ${options.length} options in response:`, options);
          } else if (hasIncompleteOptions(turnMessageState.accumulatedResponse)) {
            logger.debug(`[gemini] Warning: Incomplete options block detected`);
          }
          
          const messagePayload: CodexMessagePayload = {
            type: 'message',
            message: finalMessageText,
            id: randomUUID(),
            ...(options.length > 0 && { options }),
          };
          
          logger.debug(`[gemini] Sending complete message to mobile (length: ${finalMessageText.length}): ${finalMessageText.substring(0, 100)}...`);
          session.sendAgentMessage('gemini', messagePayload);
          turnMessageState.accumulatedResponse = '';
          turnMessageState.isResponseInProgress = false;
        }
        
        // Send task_complete ONCE at the end of turn (not on every idle)
        // This signals to the UI that the agent has finished processing
        session.sendAgentMessage('gemini', {
          type: 'task_complete',
          id: randomUUID(),
        });
        
        // Reset tracking flags
        resetGeminiTurnMessageStateAfterTurn(turnMessageState);
        session.keepAlive(turnMessageState.thinking, 'remote');
        
        const popped = !shouldExit ? await session.popPendingMessage() : false;
        if (!popped) {
          // Use same logic as Codex - emit ready if idle (no pending operations, no queue)
          emitReadyIfIdle();
        }

        // Message processing complete - safe to apply any pending session swap
        isProcessingMessage = false;
        applyPendingSessionSwap();

        logger.debug(`[gemini] Main loop: turn completed, continuing to next iteration (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    terminationHandlers?.dispose();
    // Clean up resources
    logger.debug('[gemini]: Final cleanup start');

    // Cancel offline reconnection if still running
    if (reconnectionHandle) {
      logger.debug('[gemini]: Cancelling offline reconnection');
      reconnectionHandle.cancel();
    }

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (e) {
      logger.debug('[gemini]: Error while closing session', e);
    }

    if (geminiBackend) {
      const backendToDispose = geminiBackend;
      await backendToDispose.dispose();
    }

    happierMcpServer.stop();

    await geminiTerminalUi.unmount();

    clearInterval(keepAliveInterval);
    messageBuffer.clear();

    logger.debug('[gemini]: Final cleanup completed');
  }
}
