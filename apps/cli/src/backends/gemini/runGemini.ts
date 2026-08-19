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
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { configuration } from '@/configuration';
import packageJson from '../../../package.json';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { emitReadyIfIdle as emitReadyIfIdleShared } from '@/agent/runtime/emitReadyIfIdle';
import { hashObject } from '@/utils/deterministicJson';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { resolveReadyNotificationAssistantText } from '@/agent/runtime/readyNotificationAssistantText';
import type { ReadyNotificationTurnContext } from '@/agent/runtime/runPermissionModePromptLoop';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { stopCaffeinate } from '@/integrations/caffeinate';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import {
  resolveSessionPendingQueueDeliveryTiming,
  resolveSessionPendingQueueMaxPopPerWake,
} from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import type { MessageBatch } from '@/agent/runtime/sessionInput/types';
import { normalizePendingDeliveryLocalIds } from '@/agent/runtime/session/pendingDelivery/undeliverableProviderPrompt';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PendingQueueDeliveryBlockedReason } from '@/api/session/pendingQueueV2Transport';
import { createCurrentSessionTranscriptPort } from '@/api/session/createCurrentSessionTranscriptPort';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import { formatGeminiErrorForUi } from '@/backends/gemini/utils/formatGeminiErrorForUi';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permission/permissionModeMetadata';
import {
  resolveAppendSystemPromptBaseOverride,
  resolveAppendSystemPromptModeOverride,
  resolveAppendSystemPromptQueueKeyValue,
} from '@/agent/runtime/permission/appendSystemPromptField';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { initializeRuntimeOverridesSynchronizer } from '@/agent/runtime/runtimeOverridesSynchronizer';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { resolveAttachedRunRuntimeContext } from '@/agent/runtime/resolveAttachedRunRuntimeContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { startSessionHeartbeatLoop } from '@/agent/runtime/session/startSessionHeartbeatLoop';
import { readNewestSessionModelsMetadataStateV1 } from '@happier-dev/agents';

import type { GeminiBackendResult } from '@/backends/gemini/acp/backend';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import { abortPendingAcpPermissionRequests } from '@/agent/acp/backend/permissions/acpPermissionFinalization';
import {
  recordSessionTurnCompleted,
  surfacePrimarySessionRuntimeIssue,
} from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { GeminiDiffProcessor } from '@/backends/gemini/utils/diffProcessor';
import type { GeminiMode, CodexMessagePayload } from '@/backends/gemini/types';
import type { PermissionMode } from '@/api/types';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_ENV } from '@/backends/gemini/constants';
import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from '@/agent/runtime/permission/permissionModeCanonical';
import {
  readGeminiLocalConfig,
  saveGeminiModelToConfig,
  getInitialGeminiModel
} from '@/backends/gemini/utils/config';
import { createAcpSessionIdentityBinding } from '@/agent/acp/runtime/sessionIdentityBinding';
import { createVendorResumeIdMetadataPublisher } from '@/session/metadata/createVendorResumeIdMetadataPublisher';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import {
  parseOptionsFromText,
  hasIncompleteOptions,
  formatOptionsXml,
} from '@/backends/gemini/utils/optionsParser';
import { ConversationHistory } from '@/backends/gemini/utils/conversationHistory';
import { createGeminiBackendMessageHandler } from '@/backends/gemini/runtime/createGeminiBackendMessageHandler';
import { reportGeminiConnectedServiceRuntimeAuthFailureBestEffort } from '@/backends/gemini/connectedServices/surfaceGeminiConnectedServiceRuntimeAuthFailure';
import {
  createGeminiTurnMessageState,
  resolveGeminiTurnCompletionSignal,
  resetGeminiTurnMessageStateAfterTurn,
  resetGeminiTurnMessageStateForPrompt,
} from '@/backends/gemini/runtime/geminiTurnMessageState';
import { createGeminiBackendInstance } from '@/backends/gemini/runtime/createGeminiBackendInstance';
import {
  ensureGeminiAcpSession,
  importGeminiAcpSessionReplay,
} from '@/backends/gemini/runtime/ensureGeminiAcpSession';
import { resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt } from '@/backends/gemini/runtime/freshSessionSystemPromptState';
import { sendGeminiPromptWithRetry } from '@/backends/gemini/runtime/sendGeminiPromptWithRetry';
import {
  createGeminiAcpProviderInputOutcomeBridge,
  type GeminiAcpProviderInputOutcomeBridge,
} from '@/backends/gemini/runtime/geminiAcpProviderInputOutcome';
import { createGeminiTerminalUi } from '@/backends/gemini/runtime/createGeminiTerminalUi';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { resolveGeminiQueuedPromptWithReplaySeed } from '@/backends/gemini/runtime/resolveGeminiQueuedPromptWithReplaySeed';
import { formatGeminiPromptDebugSummary } from '@/backends/gemini/runtime/formatGeminiPromptDebugSummary';
import { buildGeminiPromptForMessage } from '@/backends/gemini/utils/buildGeminiPromptForMessage';
import { resolveGeminiSystemPromptText } from '@/backends/gemini/prompting/resolveGeminiSystemPromptText';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';


function buildGeminiTurnOutcomeError(outcome: AcpTurnOutcome | null | undefined | void): Error {
  if (!outcome) return new Error('Gemini turn ended without assistant output');
  switch (outcome.kind) {
    case 'failed':
      return outcome.error;
    case 'refused':
      return new Error('Gemini refused the turn');
    case 'timed_out':
      return new Error(`Gemini turn timed out after ${outcome.capMs}ms`);
    case 'completed':
      return new Error(`Gemini turn ended with stop reason ${outcome.stopReason}`);
    case 'aborted':
      return new Error(`Gemini turn was ${outcome.stopReason}`);
  }
}

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
  accountSettingsContext?: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext | null;
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
  // Use only the identity carried by the exact selected materialization. Looking up an ambient
  // `gemini/default` profile can bind Code Assist project resolution to a different account.
  const { GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL_ENV } = await import(
    '@/backends/gemini/connectedServices/materializeGeminiConnectedServiceAuth'
  );
  const materializedProviderEmail = process.env[GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL_ENV]?.trim();
  const currentUserEmail = materializedProviderEmail || undefined;

  //
  // Create session
  //

  const accountSettings = opts.accountSettingsContext?.settings ?? null;
  const pendingQueueDrainMaxPopPerWake = resolveSessionPendingQueueMaxPopPerWake(accountSettings);
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
  let providerInputOutcomeBridge: GeminiAcpProviderInputOutcomeBridge | null = null;

  const bindProviderInputOutcomeProducer = (targetSession: ApiSessionClient): void => {
    providerInputOutcomeBridge = createGeminiAcpProviderInputOutcomeBridge(targetSession);
  };

  /**
   * Apply a pending session swap. Called between message processing cycles.
   * This ensures session swaps happen at safe points, not during message processing.
   */
  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[gemini] Applying pending session swap');
      session = pendingSessionSwap;
      bindProviderInputOutcomeProducer(session);
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
        bindProviderInputOutcomeProducer(session);
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
  bindProviderInputOutcomeProducer(session);
  reconnectionHandle = initializedSession.reconnectionHandle;
  const geminiSessionIdPublisher = createVendorResumeIdMetadataPublisher({
    agentId: 'gemini',
    getMetadataSnapshot: () => session.getMetadataSnapshot(),
    updateMetadata: (updater) => session.updateMetadata(updater),
  });
  const geminiSessionIdentity = createAcpSessionIdentityBinding({
    persistBound: geminiSessionIdPublisher.persistBound,
  });

  const promptArtifactBodyCache = new Map<string, string | null>();
  const resolveFreshSessionSystemPrompt = async (baseOverride?: string | null): Promise<string> =>
    await resolveGeminiSystemPromptText({
      credentials: opts.credentials,
      settings: opts.accountSettingsContext?.settings ?? null,
      profileId: session.getMetadataSnapshot()?.profileId ?? null,
      baseOverride,
      executionRunsFeatureEnabled: resolveCliFeatureDecision({
        featureId: 'execution.runs',
        env: process.env,
      }).state === 'enabled',
      sessionId: session.sessionId,
      runtimeDirectory: resolveAttachedRunRuntimeContext({
        session,
        metadata,
        fallbackDirectory: process.cwd(),
      }).runtimeDirectory,
      machineId,
      cache: promptArtifactBodyCache,
    });

  const messageQueue = new MessageQueue2<GeminiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
    appendSystemPrompt: resolveAppendSystemPromptQueueKeyValue(mode),
    replaySeedAllowed: mode.replaySeedAllowed !== false,
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

  const turnMessageState = createGeminiTurnMessageState();

  session.onUserMessage(async (message, deliveryInfo) => {
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

    const originalUserMessage = message.content.text;
    const mode: GeminiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage, // Store original message separately
      ...resolveAppendSystemPromptModeOverride(message.meta),
      localId: message.localId ?? null,
      replaySeedAllowed: parseSpecialCommand(originalUserMessage).type === null,
    };
    const pendingProviderAction = deliveryInfo?.pendingProviderAction;
    const rejectPendingQueueInputBeforeProviderEffect = (
      reason: 'provider_rejected_before_acceptance' | 'steering_unavailable',
    ): boolean => {
      if (deliveryInfo?.providerAcceptancePending !== true) return false;
      return providerInputOutcomeBridge?.observeRejectedBeforeEffect({
        userMessageLocalIds: message.localId ? [message.localId] : [],
        reason,
      }) === true;
    };
    if (
      pendingProviderAction === 'steer'
    ) {
      if (!rejectPendingQueueInputBeforeProviderEffect('steering_unavailable') && deliveryInfo?.providerAcceptancePending !== true) {
        const localIds = message.localId ? [message.localId] : [];
        await session.blockPendingMessageDelivery?.({
          localIds,
          reason: 'steering_unavailable',
        });
      }
      return;
    }
    const queueDeliveryOptions = {
      ...(pendingProviderAction ? { pendingProviderAction } : {}),
      userMessageLocalId: message.localId ?? null,
      providerAcceptancePending: deliveryInfo?.providerAcceptancePending === true,
    };
    if (pendingProviderAction === 'interrupt_and_send' && turnMessageState.thinking) {
      const localIds = message.localId ? [message.localId] : [];
      await (async () => {
        let interrupted = false;
        try {
          interrupted = await handleAbort();
        } catch {
          interrupted = false;
        }
        if (!interrupted) {
          if (!rejectPendingQueueInputBeforeProviderEffect('provider_rejected_before_acceptance') && deliveryInfo?.providerAcceptancePending !== true) {
            await session.blockPendingMessageDelivery?.({
              localIds,
              reason: 'provider_rejected_before_acceptance',
            });
          }
          return;
        }
        messageQueue.unshift(originalUserMessage, mode, queueDeliveryOptions);
      })();
      return;
    }
    if (pendingProviderAction) {
      messageQueue.unshift(originalUserMessage, mode, queueDeliveryOptions);
    } else {
      messageQueue.push(originalUserMessage, mode, queueDeliveryOptions);
    }
    
    // Record user message in conversation history for context preservation
    conversationHistory.addUserMessage(originalUserMessage);
  });

  const turnAssistantPreviewTracker = createTurnAssistantPreviewTracker();
  const transcriptStream = createStreamedTranscriptWriter({
    provider: 'gemini',
    session: createCurrentSessionTranscriptPort(() => session),
  });
  const keepAliveInterval = startSessionHeartbeatLoop({
    getThinking: () => turnMessageState.thinking,
    getMode: () => 'remote',
    keepAlive: (thinking, mode) => session.keepAlive(thinking, mode),
  });

  // Resumed ACP sessions must not re-append the shared prompt library prompt.
  let shouldPrependAppendSystemPromptOnNextFreshSessionPrompt = true;

  const sendReady = (context?: ReadyNotificationTurnContext) => {
    const includeAssistantPreviewText =
      opts.accountSettingsContext?.settings?.notificationsSettingsV1?.readyIncludeMessageText !== false;
    sendReadyWithPushNotification({
      session,
      pushSender: api.push(),
      waitingForCommandLabel: 'Gemini',
      logPrefix: '[Gemini]',
      sessionTitle: getSessionNotificationTitle(session.getMetadataSnapshot.bind(session)),
      assistantPreviewText: resolveReadyNotificationAssistantText({
        includeMessageText: includeAssistantPreviewText,
        explicitAssistantText: turnAssistantPreviewTracker.getPreview(),
        session,
        turnToken: context?.turnToken ?? null,
        startSeqExclusive: context?.startSeqExclusive ?? null,
      }),
      accountSettings: opts.accountSettingsContext?.settings ?? null,
      settingsSecretsReadKeys: opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
      includeAssistantPreviewText,
      shouldSendPush: () => shouldSendReadyPushNotification(opts.accountSettingsContext?.settings ?? null),
    });
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let geminiBackend: GeminiBackendResult['backend'] | null = null;
  let providerInputConsumer: SessionProviderInputConsumer<GeminiMode, string> | null = null;
  let providerInputAdmissionClosed = false;
  let providerInputDispatchDrain: Promise<void> = Promise.resolve();
  const closeProviderInputAdmission = (): Promise<void> => {
    providerInputAdmissionClosed = true;
    if (providerInputConsumer) {
      providerInputDispatchDrain = providerInputConsumer.closeProviderInputAdmissionAndWaitForDispatches();
    }
    return providerInputDispatchDrain;
  };
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;
  let storedResumeId: string | null = (() => {
    const raw = typeof opts.resume === 'string' ? opts.resume.trim() : '';
    return raw ? raw : null;
  })();

  const lastGeminiSessionIdPublished: { value: string | null } = { value: null };

  async function handleAbort(): Promise<boolean> {
    if (!turnMessageState.thinking && !turnMessageState.isResponseInProgress) {
      logger.debug('[Gemini] Abort requested with no active turn; ignoring stale abort');
      return false;
    }

    logger.debug('[Gemini] Abort requested - stopping current task');
    await permissionHandler.abortPendingRequestsAndFlush('Aborted by user');
    await transcriptStream.flushAll({
      reason: 'abort',
      interruptedReason: 'abort-requested',
    });
    turnMessageState.thinking = false;
    turnMessageState.isResponseInProgress = false;
    session.keepAlive(false, 'remote');
    
    // Send turn_aborted event (like Codex) when abort is requested
    session.sendAgentMessage('gemini', {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    
    // Reset diff processor
    diffProcessor.reset();
    
    try {
      abortController.abort();
      messageQueue.reset();
      if (geminiBackend && acpSessionId) {
        await geminiBackend.cancel(acpSessionId);
      }
      logger.debug('[Gemini] Abort completed - session remains active');
      return true;
    } catch (error) {
      logger.debug('[Gemini] Error during abort:', error);
      return false;
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

  const runtimeContext = resolveAttachedRunRuntimeContext({
    session,
    metadata,
    fallbackDirectory: process.cwd(),
  });
  const mcpSession = applyRunnerMcpSessionContext(session, {
    getPermissionMode: () => currentPermissionMode ?? initialPermissionMode,
    getBackendTarget: () => ({ kind: 'builtInAgent', agentId: 'gemini' }),
    getCurrentSessionLocation: () => ({
      path: runtimeContext.runtimeDirectory,
      host: initialMachineMetadata.host,
      machineId,
    }),
  });

  const { happierMcpServer, mcpServers } = await resolveRunnerMcpServers({
    session: mcpSession,
    credentials: opts.credentials,
    accountSettings: opts.accountSettingsContext?.settings ?? null,
    machineId,
    directory: runtimeContext.runtimeDirectory,
    sessionMetadata: mcpSession.getMetadataSnapshot?.() ?? runtimeContext.sessionMetadataSnapshot ?? runtimeContext.resolvedMetadata,
    commandMode: 'current-process',
  });

  terminationHandlers = registerRunnerTerminationHandlers({
    process,
    exit: (code) => process.exit(code),
    sessionExitReport: { sessionId: session.sessionId },
    onTerminationRequested: () => {
      session.beginRuntimeTermination?.();
      void closeProviderInputAdmission();
    },
    onTerminate: async () => {
      shouldExit = true;
      await handleAbort();
      // A terminated runtime leaves the Session inactive, never archived: archiving is a
      // user-intent action owned by setSessionArchivedState.

      stopCaffeinate();

      // Best-effort cleanup (mirrors the finally block).
      logger.debug('[gemini]: Termination cleanup start');
      try {
        await closeProviderInputAdmission();
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
    pushSender: api.push(),
    getAccountSettings: () => opts.accountSettingsContext?.settings ?? null,
    getAccountSettingsSecretsReadKeys: () => opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
    onAbortRequested: async () => {
      await handleAbort();
    },
    alwaysAutoApproveToolNameIncludes: ['geminireasoning', 'codexreasoning'],
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
  function setupGeminiMessageHandler(backend: GeminiBackendResult['backend']): void {
    backend.onMessage(
      createGeminiBackendMessageHandler({
        session,
        messageBuffer,
        state: turnMessageState,
        diffProcessor,
        transcriptStream,
        turnAssistantPreviewTracker,
      }),
    );
  }

  const adoptGeminiBackend = (
    backendResult: GeminiBackendResult,
    opts: { reason: 'initial' | 'mode-change'; modelToUse: string | null | undefined },
  ): GeminiBackendResult['backend'] => {
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
	    let pending: MessageBatch<GeminiMode, string> | null = null;

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
	    let didReplaySeedBootstrap = false;
	    const inputConsumer = createSessionProviderInputConsumer<GeminiMode, string>({
	      messageQueue,
	      session: {
	        materializeNextPendingMessageSafely: (materializeOpts) =>
	          session.materializeNextPendingMessageSafely(materializeOpts),
	        shouldAttemptPendingMaterialization: () => session.shouldAttemptPendingMaterialization?.() ?? true,
	        reconcilePendingQueueState: (reconcileOpts) => session.reconcilePendingQueueState?.(reconcileOpts),
	        waitForPendingEligibilityUpdate: (signal) => session.waitForPendingEligibilityUpdate(signal),
	      },
	      pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
	      resolvePendingQueueDeliveryTiming: () => resolveSessionPendingQueueDeliveryTiming(
	        getActiveAccountSettingsSnapshot()?.settings ?? accountSettings,
	      ),
	      onMetadataUpdate: syncControlsFromMetadata,
	    });
      providerInputConsumer = inputConsumer;
      if (providerInputAdmissionClosed) {
        providerInputDispatchDrain = inputConsumer.closeProviderInputAdmissionAndWaitForDispatches();
      }

    while (!shouldExit) {
      let message: MessageBatch<GeminiMode, string> | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[gemini] Main loop: waiting for messages from queue...');
        const waitSignal = abortController.signal;
        const batch = await inputConsumer.waitForNextInput({ abortSignal: waitSignal });
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
        
        // Reset permission handler on mode change (like Codex)
        permissionHandler.reset();
        
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
        await geminiSessionIdentity.reset();
        const openedSession = await geminiSessionIdentity.open({
          intent: { kind: 'create' },
          openSession: () => activeBackend.startSession(),
        });
        acpSessionId = openedSession.identity.vendorSessionId;
        logger.debug(`[gemini] New ACP session started: ${acpSessionId}`);
        shouldPrependAppendSystemPromptOnNextFreshSessionPrompt =
          resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt({ startedFreshSession: true });
        
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

      let readyTurnContext: ReadyNotificationTurnContext | undefined;
      let promptTurnOutcome: AcpTurnOutcome | void = undefined;
      let promptTurnError: unknown = null;
      let didAttemptProviderSend = false;
      let didConfirmProviderAccepted = false;
      let didBeginProviderPromptAttempt = false;
      let didObserveEffectMayHaveOccurred = false;
      const pendingDeliveryLocalIds = normalizePendingDeliveryLocalIds(message.userMessageLocalIds ?? []);
      const providerOutcomeIdentity = pendingDeliveryLocalIds.length === 1
        ? {
            userMessageLocalIds: pendingDeliveryLocalIds,
          }
        : null;
      let appliedModelIdForPrompt: string | null = null;
      // Retiring the replay seed belongs to provider ACCEPTANCE of the prompt the seed was
      // prefixed to — not to that prompt's turn completing. `sendGeminiPromptWithRetry`
      // signals acceptance and only then awaits the whole turn, so gating retirement on the
      // dispatch's return let an accepted-then-aborted turn leave the seed live and prefix
      // the entire carry-over context onto the next message.
      let pendingReplaySeedSettlement: (() => Promise<unknown>) | null = null;
      let replaySeedSettlement: Promise<unknown> | null = null;
      const awaitReplaySeedSettlement = async (): Promise<void> => {
        const settlement = replaySeedSettlement;
        if (!settlement) return;
        replaySeedSettlement = null;
        await settlement;
      };
      transcriptStream.setCommitProvenance({ kind: 'non_dependent', source: 'external' });
      const confirmProviderAccepted = (): void => {
        const settle = pendingReplaySeedSettlement;
        pendingReplaySeedSettlement = null;
        // The seed owner reports its own failures and never rejects; the promise is awaited
        // below so retirement is durable before the next prompt resolves.
        if (settle) replaySeedSettlement = settle();
        if (didConfirmProviderAccepted) return;
        if (!providerOutcomeIdentity) return;
        didConfirmProviderAccepted = providerInputOutcomeBridge?.observeAccepted({
          ...providerOutcomeIdentity,
          appliedModelId: appliedModelIdForPrompt,
        }) === true;
      };
      const observeRejectedBeforeProviderEffect = (
        reason: Extract<PendingQueueDeliveryBlockedReason, 'runtime_disposed_before_delivery' | 'provider_rejected_before_acceptance'>,
      ): void => {
        if (didConfirmProviderAccepted) return;
        if (!providerOutcomeIdentity) return;
        providerInputOutcomeBridge?.observeRejectedBeforeEffect({
          ...providerOutcomeIdentity,
          reason,
        });
      };
      const observeEffectMayHaveOccurred = (): void => {
        if (didConfirmProviderAccepted || didObserveEffectMayHaveOccurred) return;
        if (!providerOutcomeIdentity) return;
        didObserveEffectMayHaveOccurred = providerInputOutcomeBridge?.observeEffectMayHaveOccurred(
          providerOutcomeIdentity,
        ) === true;
      };
      try {
        const startSeqExclusive = session.getLastObservedMessageSeq();
        const turnToken = session.beginTurnAssistantTextSnapshot({ startSeqExclusive });
        readyTurnContext = { turnToken, startSeqExclusive };
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
            const requestedResumeId = storedResumeId;
            const openedSession = await geminiSessionIdentity.open({
              intent: requestedResumeId
                ? { kind: 'resume', expectedVendorSessionId: requestedResumeId }
                : { kind: 'create' },
              openSession: async () => {
                const ensuredSession = await ensureGeminiAcpSession({
                  backend: activeBackend,
                  session,
                  permissionHandler,
                  messageBuffer,
                  storedResumeId: requestedResumeId,
                  currentPromptText: message.message,
                  deferReplayImport: true,
                  onDebug: (msg) => logger.debug(msg),
                });
                return {
                  sessionId: ensuredSession.acpSessionId,
                  replay: ensuredSession.deferredReplay ?? null,
                };
              },
            });
            acpSessionId = openedSession.identity.vendorSessionId;
            storedResumeId = requestedResumeId ? null : storedResumeId;
            if (Array.isArray(openedSession.result.replay) && openedSession.result.replay.length > 0) {
              try {
                await importGeminiAcpSessionReplay({
                  session,
                  permissionHandler,
                  remoteSessionId: acpSessionId,
                  replay: openedSession.result.replay,
                  currentPromptText: message.message,
                });
              } catch (error) {
                logger.debug('[gemini] Failed to import ACP replay history (non-fatal)', { error });
              }
            }
            shouldPrependAppendSystemPromptOnNextFreshSessionPrompt =
              resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt({
                startedFreshSession: openedSession.identity.operation === 'create',
              });
            wasSessionCreated = true;
            currentModeHash = message.hash;
            
            // Model info is already shown in status bar via updateDisplayedModel
            logger.debug(`[gemini] Displaying model in UI: ${geminiTerminalUi.getDisplayedModel() || DEFAULT_GEMINI_MODEL}, displayedModel: ${geminiTerminalUi.getDisplayedModel()}`);
          }
        }
        
        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }
         
        // Reset accumulator when sending a new prompt (not when tool calls start)
        // Reset accumulated response for new prompt
        // This ensures a new assistant message will be created (not updating previous one)
        resetGeminiTurnMessageStateForPrompt(turnMessageState, message.message, (thinking) => {
          session.keepAlive(thinking, 'remote');
        });
        turnAssistantPreviewTracker.reset();
        
        if (!geminiBackend || !acpSessionId) {
          throw new Error('Gemini backend or session not initialized');
        }
        
        let promptToSend = message.message;
        
        // Inject conversation history context if model was just changed
        if (injectHistoryContext && conversationHistory.hasHistory()) {
          const historyContext = conversationHistory.getContextForNewSession();
          promptToSend = historyContext + promptToSend;
          logger.debug(`[gemini] Injected conversation history context (${historyContext.length} chars)`);
          // Don't clear history - keep accumulating for future model changes
        }

        const replaySeedResolution = await resolveGeminiQueuedPromptWithReplaySeed({
          sessionClient: session,
          text: promptToSend,
          localId: message.mode?.localId ?? null,
          replaySeedAllowed: message.mode?.replaySeedAllowed !== false,
          didBootstrap: didReplaySeedBootstrap,
        });
        didReplaySeedBootstrap = replaySeedResolution.didBootstrap;
        promptToSend = replaySeedResolution.text;
        if (replaySeedResolution.seedApplied) {
          pendingReplaySeedSettlement = replaySeedResolution.settleReplaySeedOnProviderAcceptance;
        }

        if (shouldPrependAppendSystemPromptOnNextFreshSessionPrompt) {
          const systemPromptText = await resolveFreshSessionSystemPrompt(
            resolveAppendSystemPromptBaseOverride(message.mode),
          );
          const builtPrompt = buildGeminiPromptForMessage({
            isFirstMessage: true,
            userText: promptToSend,
            systemPromptText,
          });
          promptToSend = builtPrompt.prompt;
          shouldPrependAppendSystemPromptOnNextFreshSessionPrompt = builtPrompt.nextIsFirstMessage;
        }

        logger.debug(formatGeminiPromptDebugSummary(promptToSend));

        const dispatchOutcome = await inputConsumer.runProviderInputDispatch({
          abortSignal: abortController.signal,
          dispatch: async () => {
            const modelState = readNewestSessionModelsMetadataStateV1(session.getMetadataSnapshot());
            appliedModelIdForPrompt = message.mode.model
              ?? (modelState?.provider === 'gemini' ? modelState.currentModelId : null);
            didAttemptProviderSend = true;
            return await sendGeminiPromptWithRetry({
              backend: geminiBackend!,
              acpSessionId: acpSessionId!,
              prompt: promptToSend,
              messageBuffer,
              session,
              onDebug: (msg) => logger.debug(msg),
              maxRetries: 3,
              retryDelayMs: 2_000,
              waitForResponseTimeoutMs: 120_000,
              onProviderPromptAccepted: confirmProviderAccepted,
              onProviderPromptAttemptStarted: () => {
                didBeginProviderPromptAttempt = true;
              },
              onProviderPromptEffectMayHaveOccurred: observeEffectMayHaveOccurred,
            });
          },
        });
        if (dispatchOutcome.status === 'cancelled') {
          const error = new Error('Provider input admission closed');
          error.name = 'AbortError';
          throw error;
        }
        // Retirement was already started by `confirmProviderAccepted`; awaiting it here keeps
        // an ordinary turn's ordering unchanged. An accepted prompt whose turn then fails
        // skips this line, so the `finally` below awaits it instead.
        await awaitReplaySeedSettlement();
        promptTurnOutcome = dispatchOutcome.value;
        
        // Mark as not first message after sending prompt
        if (first) {
          first = false;
        }
      } catch (error) {
        promptTurnError = error;
        if (didBeginProviderPromptAttempt || didObserveEffectMayHaveOccurred) {
          observeEffectMayHaveOccurred();
        } else {
          observeRejectedBeforeProviderEffect(
            didAttemptProviderSend ? 'provider_rejected_before_acceptance' : 'runtime_disposed_before_delivery',
          );
        }
        logger.debug('[gemini] Error in gemini session:', error);
        const isAbortError = error instanceof Error && error.name === 'AbortError';

        if (isAbortError) {
          await transcriptStream.flushAll({
            reason: 'abort',
            interruptedReason: 'abort-error',
          });
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          await transcriptStream.flushAll({
            reason: 'abort',
            interruptedReason: 'turn-error',
          });
          const errorMsg = formatGeminiErrorForUi(error, geminiTerminalUi.getDisplayedModel());
          
          messageBuffer.addMessage(errorMsg, 'status');
          // Use sendAgentMessage for consistency with ACP format
          session.sendAgentMessage('gemini', {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        // Gemini confirmed delivery but the turn then failed, was aborted, or the backend was
        // disposed. Retirement is already in flight; drain it here so the next prompt reads a
        // settled seed instead of prefixing the whole carry-over context a second time.
        await awaitReplaySeedSettlement();
        // Metadata updates can arrive while a turn is in-flight. Sync again at turn-end so the
        // next turn observes the latest session-scoped control overrides.
        syncControlsFromMetadata();

        await abortPendingAcpPermissionRequests(
          permissionHandler,
          promptTurnError ? 'Gemini turn failed' : 'Gemini turn ended',
          (error) => {
            logger.debug('[Gemini] Failed to abort pending permission requests at turn boundary', error);
          },
        );

        // Reset permission handler and diff processor after turn (like Codex)
        permissionHandler.reset();
        diffProcessor.completeTurn(); // Emit per-turn diffs (if any), then reset
        const hasAssistantOutput = turnMessageState.accumulatedResponse.trim().length > 0;
        const hadToolCallInTurn = turnMessageState.hadToolCallInTurn;
        const hadThinkingInTurn = turnMessageState.hadThinkingInTurn;
        const hadPermissionInTurn = turnMessageState.hadPermissionInTurn;
        
        // Send accumulated response to mobile app ONLY when turn is complete
        // This prevents message fragmentation from Gemini's chunked responses
        if (hasAssistantOutput) {
          const { text: messageText, options } = parseOptionsFromText(turnMessageState.accumulatedResponse);
          
          // Record assistant response in conversation history for context preservation
          conversationHistory.addAssistantMessage(messageText);
          
          // Mobile app parses options from text via parseMarkdown
          let finalMessageText = messageText;
          if (options.length > 0) {
            const optionsXml = formatOptionsXml(options);
            finalMessageText = messageText + optionsXml;
            logger.debug(`[gemini] Found ${options.length} options in response`);
          } else if (hasIncompleteOptions(turnMessageState.accumulatedResponse)) {
            logger.debug(`[gemini] Warning: Incomplete options block detected`);
          }
          
          const messagePayload: CodexMessagePayload = {
            type: 'message',
            message: finalMessageText,
            id: randomUUID(),
            ...(options.length > 0 && { options }),
          };
          
          logger.debug(`[gemini] Sending complete message to mobile (length: ${finalMessageText.length})`);
          session.sendAgentMessage('gemini', messagePayload);
          turnMessageState.accumulatedResponse = '';
          turnMessageState.isResponseInProgress = false;
        }

        await transcriptStream.flushAll({ reason: 'turn-end' });

        const completionSignal = resolveGeminiTurnCompletionSignal({
          outcome: promptTurnError
            ? promptTurnError instanceof Error && promptTurnError.name === 'AbortError'
              ? { kind: 'aborted', stopReason: 'cancelled' }
              : { kind: 'failed', error: promptTurnError instanceof Error ? promptTurnError : new Error(String(promptTurnError)) }
            : promptTurnOutcome,
          hasAssistantOutput,
          hadToolCallInTurn,
          hadThinkingInTurn,
          hadPermissionInTurn,
        });

        if (completionSignal === 'task_complete') {
          session.sendAgentMessage('gemini', {
            type: 'task_complete',
            id: randomUUID(),
          });
          await recordSessionTurnCompleted({ session, provider: 'gemini' });
        } else if (completionSignal === 'turn_cancelled') {
          await surfacePrimarySessionRuntimeIssue({
            provider: 'gemini',
            session,
            sessionSeq: session.getLastObservedMessageSeq(),
            cause: 'cancelled',
          });
        } else {
          const turnFailureError = promptTurnError ?? buildGeminiTurnOutcomeError(promptTurnOutcome);
          // Connected-services producer: await the structured daemon result so handled recovery
          // owns the visible projection and only an unhandled result reaches the existing fallback.
          const runtimeAuthResult = await reportGeminiConnectedServiceRuntimeAuthFailureBestEffort({
            session,
            error: turnFailureError,
            logPrefix: '[gemini]',
          });
          if (runtimeAuthResult?.recoveryReport?.handled !== true) {
            await surfacePrimarySessionRuntimeIssue({
              provider: 'gemini',
              session,
              sessionSeq: session.getLastObservedMessageSeq(),
              cause: 'status_error',
              error: runtimeAuthResult
                ? Object.assign(
                    turnFailureError instanceof Error ? turnFailureError : new Error(String(turnFailureError)),
                    { runtimeAuthClassification: runtimeAuthResult.classification },
                  )
                : turnFailureError,
            });
          }
        }
        
        // Reset tracking flags
        resetGeminiTurnMessageStateAfterTurn(turnMessageState);
        session.keepAlive(turnMessageState.thinking, 'remote');
        
        const drainResult = !shouldExit
          ? await inputConsumer.drainPending({
              reason: 'gemini-turn-complete',
              logPrefix: '[Gemini]',
              abortSignal: abortController.signal,
            })
          : null;
        if (drainResult?.materialized === 0 && drainResult.stoppedReason === 'no_pending') {
          // Use same logic as Codex - emit ready if idle (no pending operations, no queue)
          emitReadyIfIdleShared({
            pending: turnMessageState.thinking || turnMessageState.isResponseInProgress,
            queueSize: () => messageQueue.size(),
            shouldExit,
            sendReady: () => sendReady(readyTurnContext),
          });
        }

        // Message processing complete - safe to apply any pending session swap
        isProcessingMessage = false;
        applyPendingSessionSwap();

        logger.debug(`[gemini] Main loop: turn completed, continuing to next iteration (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    terminationHandlers?.dispose();
    await closeProviderInputAdmission();
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
