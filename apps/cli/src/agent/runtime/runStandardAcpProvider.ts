import { randomUUID } from 'node:crypto';

import { render } from 'ink';
import React from 'react';
import { resolveAgentIdFromFlavor } from '@happier-dev/agents';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { MachineMetadata, Metadata, PermissionMode } from '@/api/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { archiveAndCloseSession } from '@/agent/runtime/archiveAndCloseSession';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { createSessionMetadata, type CreateSessionMetadataOptions } from '@/agent/runtime/createSessionMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { getLatestAssistantMessagePreview, getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import type { InFlightSteerController } from '@/agent/runtime/permission/bindPermissionModeQueue';
import type { Credentials } from '@/persistence';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/promptLibrary/resolveCliMemoryRecallGuidanceEnabled';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveAttachedRunRuntimeContext } from '@/agent/runtime/resolveAttachedRunRuntimeContext';

type RuntimeForLoop = {
  beginTurn: () => void;
  startOrLoad: (opts: { resumeId?: string }) => Promise<unknown>;
  sendPrompt: (message: string) => Promise<void>;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  steerPrompt?: (message: string) => Promise<void>;
  flushTurn: () => void | Promise<void>;
  reset: () => Promise<void>;
  getSessionId: () => string | null;
  cancel: () => Promise<void>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string | number | boolean | null) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
};

type KeepAliveMode = 'local' | 'remote';

type TerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit: () => void | Promise<void>;
};

type TerminalDisplayController = Readonly<{
  mount: () => void;
  unmount: () => Promise<void>;
  isMounted: () => boolean;
}>;

export type StandardAcpProviderRunOptions = {
  credentials: Credentials;
  backendTarget?: BackendTargetRefV1;
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
};

export type StandardAcpProviderConfig = {
  flavor: CreateSessionMetadataOptions['flavor'];
  backendDisplayName: string;
  uiLogPrefix: string;
  providerName: string;
  waitingForCommandLabel: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  supportsMcpServers?: boolean;
  machineMetadata: MachineMetadata;
  terminalDisplay: React.ComponentType<TerminalDisplayProps>;
  formatPromptErrorMessage: (error: unknown) => string;
  /**
   * Optional: provide a stable key used to batch messages and detect "effective" permission-mode changes.
   *
   * When omitted, permissionMode itself is used as the key.
   */
  resolvePermissionModeQueueKey?: (permissionMode: PermissionMode) => string;
  createRuntime: (params: {
    directory: string;
    metadata: Metadata;
    machineId: string;
    session: ApiSessionClient;
    messageBuffer: MessageBuffer;
    mcpServers: Record<string, import('@/agent').McpServerConfig>;
    permissionHandler: ProviderEnforcedPermissionHandler;
    getPermissionMode: () => PermissionMode;
    setThinking: (value: boolean) => void;
    memoryRecallGuidanceEnabled: boolean;
  }) => RuntimeForLoop;
  resolveRuntimeDirectory?: (params: { session: ApiSessionClient; metadata: Metadata }) => string;
  createSendReady?: (params: { session: ApiSessionClient; api: ApiClient }) => () => void;
  beforeInitializeSession?: (params: { metadata: Metadata; opts: StandardAcpProviderRunOptions }) => void;
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void;
  onAttachMetadataSnapshotError?: (error: unknown) => void;
  onSessionSwap?: (params: { session: ApiSessionClient }) => void | Promise<void>;
  onAfterStart?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  onAfterReset?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  onDispose?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  startRuntimeBeforeFirstPrompt?: boolean;
  onTerminalDisplayControllerReady?: (controller: TerminalDisplayController) => void;
  shouldRenderTerminalDisplay?: (params: { opts: StandardAcpProviderRunOptions; session: ApiSessionClient; metadata: Metadata }) => boolean;
  resolveKeepAliveMode?: () => KeepAliveMode;
};

type StandardAcpProviderDeps = {
  initializeBackendApiContextFn?: typeof initializeBackendApiContext;
  createSessionMetadataFn?: typeof createSessionMetadata;
  initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
  resolveRunnerMcpServersFn?: typeof resolveRunnerMcpServers;
  createProviderEnforcedPermissionHandlerFn?: typeof createProviderEnforcedPermissionHandler;
  createPermissionModeQueueStateFn?: typeof createPermissionModeQueueState;
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  sendReadyWithPushNotificationFn?: typeof sendReadyWithPushNotification;
  registerKillSessionHandlerFn?: typeof registerKillSessionHandler;
  archiveAndCloseSessionFn?: typeof archiveAndCloseSession;
  cleanupBackendRunResourcesFn?: typeof cleanupBackendRunResources;
  renderFn?: typeof render;
};

export async function runStandardAcpProvider(
  opts: StandardAcpProviderRunOptions,
  config: StandardAcpProviderConfig,
  deps: StandardAcpProviderDeps = {},
): Promise<void> {
  const initializeBackendApiContextFn = deps.initializeBackendApiContextFn ?? initializeBackendApiContext;
  const createSessionMetadataFn = deps.createSessionMetadataFn ?? createSessionMetadata;
  const initializeBackendRunSessionFn = deps.initializeBackendRunSessionFn ?? initializeBackendRunSession;
  const resolveRunnerMcpServersFn = deps.resolveRunnerMcpServersFn ?? resolveRunnerMcpServers;
  const createProviderEnforcedPermissionHandlerFn = deps.createProviderEnforcedPermissionHandlerFn ?? createProviderEnforcedPermissionHandler;
  const createPermissionModeQueueStateFn = deps.createPermissionModeQueueStateFn ?? createPermissionModeQueueState;
  const runPermissionModePromptLoopFn = deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop;
  const sendReadyWithPushNotificationFn = deps.sendReadyWithPushNotificationFn ?? sendReadyWithPushNotification;
  const registerKillSessionHandlerFn = deps.registerKillSessionHandlerFn ?? registerKillSessionHandler;
  const archiveAndCloseSessionFn = deps.archiveAndCloseSessionFn ?? archiveAndCloseSession;
  const cleanupBackendRunResourcesFn = deps.cleanupBackendRunResourcesFn ?? cleanupBackendRunResources;
  const renderFn = deps.renderFn ?? render;

  const sessionTag = randomUUID();
  const explicitPermissionMode = opts.permissionMode;

  connectionState.setBackend(config.backendDisplayName);

  const { api, machineId } = await initializeBackendApiContextFn({
    credentials: opts.credentials,
    machineMetadata: config.machineMetadata,
  });

  // This runtime only hosts ACP providers. If a custom flavor string is not recognized,
  // keep policy/tooling decisions in the ACP family instead of inheriting a built-in default.
  const policyAgentId = resolveAgentIdFromFlavor(config.flavor) ?? 'customAcp';
  const accountSettings = opts.accountSettingsContext?.settings ?? null;
  const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
    agentId: policyAgentId,
    backendTarget: opts.backendTarget,
    explicitPermissionMode: opts.permissionMode,
    accountSettings,
  });
  const initialPermissionMode = permissionModeSeed.mode;
  const { state, metadata } = createSessionMetadataFn({
    flavor: config.flavor,
    acpProviderId: config.flavor,
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
  config.beforeInitializeSession?.({ metadata, opts });

  let session: ApiSessionClient;
  let permissionHandler: ProviderEnforcedPermissionHandler;
  const initializedSession = await initializeBackendRunSessionFn({
    api,
    sessionTag,
    metadata,
    state,
    existingSessionId: opts.existingSessionId,
    uiLogPrefix: config.uiLogPrefix,
    startupMetadataOverrides: createStartupMetadataOverrides(opts),
    onSessionSwap: async (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
      await config.onSessionSwap?.({ session: newSession });
    },
    onAttachMetadataSnapshotMissing: config.onAttachMetadataSnapshotMissing,
    onAttachMetadataSnapshotError: config.onAttachMetadataSnapshotError,
  });

  session = initializedSession.session;
  const reconnectionHandle = initializedSession.reconnectionHandle;

  let abortRequestedCallback: (() => void | Promise<void>) | null = null;
  permissionHandler = createProviderEnforcedPermissionHandlerFn({
    session,
    logPrefix: config.uiLogPrefix,
    pushSender: api.push(),
    getAccountSettings: () => opts.accountSettingsContext?.settings ?? null,
    getAccountSettingsSecretsReadKeys: () => opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
    onAbortRequested: () => abortRequestedCallback?.(),
    toolTrace: { protocol: 'acp', provider: config.agentMessageType },
  });
  permissionHandler.setPermissionMode(initialPermissionMode);

  // Used by the message-queue binding to optionally steer additional user input into an in-flight turn.
  // This is late-bound because the queue binding is initialized before the runtime is created.
  let runtimeForInFlightSteer: RuntimeForLoop | null = null;
  const inFlightSteerController: InFlightSteerController = {
    supportsInFlightSteer: () => runtimeForInFlightSteer?.supportsInFlightSteer?.() === true,
    isTurnInFlight: () => runtimeForInFlightSteer?.isTurnInFlight?.() === true,
    steerText: async (text: string) => {
      const runtime = runtimeForInFlightSteer;
      if (!runtime?.steerPrompt) {
        throw new Error('in-flight steer is not available');
      }
      await runtime.steerPrompt(text);
    },
  };

  const permissionModeState = createPermissionModeQueueStateFn({
    session,
    initialPermissionMode,
    inFlightSteer: inFlightSteerController,
    resolvePermissionModeQueueKey: config.resolvePermissionModeQueueKey,
  });
  const { messageQueue } = permissionModeState;
  const promptArtifactBodyCache = new Map<string, string | null>();
  const runtimeContext = resolveAttachedRunRuntimeContext({
    session,
    metadata,
    resolveRuntimeDirectory: config.resolveRuntimeDirectory,
  });
  const runtimeMetadata = runtimeContext.resolvedMetadata;

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  const shouldRenderTerminalDisplay = config.shouldRenderTerminalDisplay?.({ opts, session, metadata: runtimeMetadata }) ?? true;
  let inkInstance: ReturnType<typeof render> | null = null;
  const mountTerminalDisplay = (): void => {
    if (!hasTTY || inkInstance) return;
    console.clear();
    inkInstance = renderFn(React.createElement(config.terminalDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: async () => {
        shouldExit = true;
        await handleAbort();
      },
    }), { exitOnCtrlC: false, patchConsole: false });
  };
  const unmountTerminalDisplay = async (): Promise<void> => {
    if (!inkInstance) return;
    inkInstance.unmount();
    inkInstance = null;
  };
  config.onTerminalDisplayControllerReady?.({
    mount: mountTerminalDisplay,
    unmount: unmountTerminalDisplay,
    isMounted: () => inkInstance !== null,
  });
  if (hasTTY && shouldRenderTerminalDisplay) {
    mountTerminalDisplay();
  }

  let thinking = false;
  let shouldExit = false;
  let abortController = new AbortController();
  const getKeepAliveMode = (): KeepAliveMode => config.resolveKeepAliveMode?.() ?? 'remote';
  session.keepAlive(thinking, getKeepAliveMode());
  const keepAliveInterval = setInterval(() => session.keepAlive(thinking, getKeepAliveMode()), 2000);

  const runtimeDirectory = runtimeContext.runtimeDirectory;
  const supportsMcpServers = (config.supportsMcpServers ?? true) && resolveAgentToolsDelivery(policyAgentId) === 'native_mcp';
  const { happierMcpServer, mcpServers } = supportsMcpServers
    ? await resolveRunnerMcpServersFn({
      session,
      credentials: opts.credentials,
      accountSettings: opts.accountSettingsContext?.settings ?? null,
      machineId,
      directory: runtimeDirectory,
      sessionMetadata: runtimeContext.sessionMetadataSnapshot ?? runtimeMetadata,
    })
    : { happierMcpServer: { url: '', stop: () => {} }, mcpServers: {} };
  const memoryRecallGuidanceEnabled = await resolveCliMemoryRecallGuidanceEnabled();
  const runtime = config.createRuntime({
    directory: runtimeDirectory,
    metadata: runtimeMetadata,
    machineId,
    session,
    messageBuffer,
    mcpServers,
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    setThinking: (value) => {
      thinking = value;
    },
    memoryRecallGuidanceEnabled,
  });
  runtimeForInFlightSteer = runtime;

  let cleanupRan = false;
  const cleanupOnce = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    await cleanupBackendRunResourcesFn({
      keepAliveInterval,
      reconnectionHandle,
      stopMcpServer: () => happierMcpServer.stop(),
      resetRuntime: () => runtime.reset(),
      unmountUi: unmountTerminalDisplay,
    });
    await config.onDispose?.({ session, runtime });
  };

  const handleAbort = async () => {
    logger.debug(`${config.uiLogPrefix} Abort requested`);
    session.sendAgentMessage(config.agentMessageType, { type: 'turn_aborted', id: randomUUID() });
    permissionHandler.reset();
    try {
      abortController.abort();
      abortController = new AbortController();
      await runtime.cancel();
    } catch (error) {
      logger.debug(`${config.uiLogPrefix} Failed to cancel current operation (non-fatal)`, error);
    }
  };
  abortRequestedCallback = handleAbort;

  const terminationHandlers = registerRunnerTerminationHandlers({
    process,
    exit: (code) => process.exit(code),
    onTerminate: async (_event, outcome) => {
      shouldExit = true;
      await handleAbort();
      try {
        if (outcome.archive) {
          await archiveAndCloseSessionFn(session);
        }
      } finally {
        await cleanupOnce();
      }
    },
  });

  const handleKillSession = async () => {
    logger.debug(`${config.uiLogPrefix} Kill session requested`);
    terminationHandlers.requestTermination({ kind: 'killSession' });
    await terminationHandlers.whenTerminated;
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandlerFn(session.rpcHandlerManager, handleKillSession);

  const sendReady = config.createSendReady
    ? config.createSendReady({ session, api })
    : (() => {
      sendReadyWithPushNotificationFn({
        session,
        pushSender: api.push(),
        waitingForCommandLabel: config.waitingForCommandLabel,
        logPrefix: config.uiLogPrefix,
        sessionTitle: getSessionNotificationTitle(session.getMetadataSnapshot?.bind(session) ?? null),
        assistantPreviewText: getLatestAssistantMessagePreview(messageBuffer),
        accountSettings: opts.accountSettingsContext?.settings ?? null,
        settingsSecretsReadKeys: opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
        includeAssistantPreviewText:
          opts.accountSettingsContext?.settings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
        shouldSendPush: () => shouldSendReadyPushNotification(opts.accountSettingsContext?.settings ?? null),
      });
    });

  const initialResumeId = typeof opts.resume === 'string' ? opts.resume.trim() : '';

  try {
    await runPermissionModePromptLoopFn({
      providerName: config.providerName,
      agentMessageType: config.agentMessageType,
      explicitPermissionMode,
      session,
      messageQueue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) => createRuntimeOverrideSynchronizers({
        session,
        runtime,
        isStarted,
      }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => session.keepAlive(thinking, getKeepAliveMode()),
      setThinking: (value) => {
        thinking = value;
      },
      sendReady,
      currentPermissionModeUpdatedAt: permissionModeState.getCurrentPermissionModeUpdatedAt(),
      setCurrentPermissionMode: permissionModeState.setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: permissionModeState.setCurrentPermissionModeUpdatedAt,
      initialResumeId: initialResumeId || undefined,
      strictInitialResume: initialResumeId.length > 0,
      startRuntimeBeforeFirstPrompt: config.startRuntimeBeforeFirstPrompt === true,
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) =>
        await resolveEffectiveCodingPromptText({
          credentials: opts.credentials,
          settings: opts.accountSettingsContext?.settings ?? null,
          profileId: session.getMetadataSnapshot()?.profileId ?? null,
          baseOverride,
          executionRunsFeatureEnabled: resolveCliFeatureDecision({
            featureId: 'execution.runs',
            env: process.env,
          }).state === 'enabled',
          providerId: policyAgentId,
          toolDelivery: resolveAgentToolsDelivery(policyAgentId),
          toolDeliverySessionId: runtime.getSessionId(),
          toolDeliveryDirectory: runtimeDirectory,
          memoryMachineId: machineId,
          memoryRecallGuidanceEnabled,
          cache: promptArtifactBodyCache,
        }),
      onAfterStart: config.onAfterStart ? () => config.onAfterStart?.({ session, runtime }) : undefined,
      onAfterReset: config.onAfterReset ? () => config.onAfterReset?.({ session, runtime }) : undefined,
      formatPromptErrorMessage: config.formatPromptErrorMessage,
    });
  } finally {
    terminationHandlers.dispose();
    await cleanupOnce();
  }
}
