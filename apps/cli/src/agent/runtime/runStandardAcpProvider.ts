import { randomUUID } from 'node:crypto';

import { render } from 'ink';
import React from 'react';

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { MachineMetadata, Metadata, PermissionMode } from '@/api/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { archiveAndCloseSession } from '@/agent/runtime/archiveAndCloseSession';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { createAcpRuntimeOverrideSynchronizers } from '@/agent/runtime/createAcpRuntimeOverrideSynchronizers';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { createSessionMetadata, type CreateSessionMetadataOptions } from '@/agent/runtime/createSessionMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import type { InFlightSteerController } from '@/agent/runtime/permission/bindPermissionModeQueue';
import type { Credentials } from '@/persistence';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

type RuntimeForLoop = {
  beginTurn: () => void;
  startOrLoad: (opts: { resumeId?: string }) => Promise<unknown>;
  sendPrompt: (message: string) => Promise<void>;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  steerPrompt?: (message: string) => Promise<void>;
  flushTurn: () => void;
  reset: () => Promise<void>;
  getSessionId: () => string | null;
  cancel: () => Promise<void>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string | number | boolean | null) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
};

type TerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit: () => void | Promise<void>;
};

export type StandardAcpProviderRunOptions = {
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
};

export type StandardAcpProviderConfig = {
  flavor: CreateSessionMetadataOptions['flavor'];
  backendDisplayName: string;
  uiLogPrefix: string;
  providerName: string;
  waitingForCommandLabel: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  machineMetadata: MachineMetadata;
  terminalDisplay: React.ComponentType<TerminalDisplayProps>;
  formatPromptErrorMessage: (error: unknown) => string;
  createRuntime: (params: {
    directory: string;
    metadata: Metadata;
    session: ApiSessionClient;
    messageBuffer: MessageBuffer;
    mcpServers: Awaited<ReturnType<typeof createHappierMcpBridge>>['mcpServers'];
    permissionHandler: ProviderEnforcedPermissionHandler;
    getPermissionMode: () => PermissionMode;
    setThinking: (value: boolean) => void;
  }) => RuntimeForLoop;
  resolveRuntimeDirectory?: (params: { session: ApiSessionClient; metadata: Metadata }) => string;
  createSendReady?: (params: { session: ApiSessionClient; api: ApiClient }) => () => void;
  beforeInitializeSession?: (params: { metadata: Metadata; opts: StandardAcpProviderRunOptions }) => void;
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void;
  onAttachMetadataSnapshotError?: (error: unknown) => void;
  onAfterStart?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  onAfterReset?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
};

type StandardAcpProviderDeps = {
  initializeBackendApiContextFn?: typeof initializeBackendApiContext;
  createSessionMetadataFn?: typeof createSessionMetadata;
  initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
  createHappierMcpBridgeFn?: typeof createHappierMcpBridge;
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
  const createHappierMcpBridgeFn = deps.createHappierMcpBridgeFn ?? createHappierMcpBridge;
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

  const initialPermissionMode = normalizePermissionModeToIntent(opts.permissionMode ?? 'default') ?? 'default';
  const { state, metadata } = createSessionMetadataFn({
    flavor: config.flavor,
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
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
    },
    onAttachMetadataSnapshotMissing: config.onAttachMetadataSnapshotMissing,
    onAttachMetadataSnapshotError: config.onAttachMetadataSnapshotError,
  });

  session = initializedSession.session;
  const reconnectionHandle = initializedSession.reconnectionHandle;

  const { happierMcpServer, mcpServers } = await createHappierMcpBridgeFn(session);

  let abortRequestedCallback: (() => void | Promise<void>) | null = null;
  permissionHandler = createProviderEnforcedPermissionHandlerFn({
    session,
    logPrefix: config.uiLogPrefix,
    onAbortRequested: () => abortRequestedCallback?.(),
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
  });
  const { messageQueue } = permissionModeState;

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;
  if (hasTTY) {
    console.clear();
    inkInstance = renderFn(React.createElement(config.terminalDisplay, {
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

  const runtimeDirectory = config.resolveRuntimeDirectory
    ? config.resolveRuntimeDirectory({ session, metadata })
    : metadata.path;
  const runtime = config.createRuntime({
    directory: runtimeDirectory,
    metadata,
    session,
    messageBuffer,
    mcpServers,
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    setThinking: (value) => {
      thinking = value;
    },
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
      unmountUi: () => inkInstance?.unmount(),
    });
  };

  const handleAbort = async () => {
    logger.debug(`${config.uiLogPrefix} Abort requested`);
    session.sendAgentMessage(config.agentMessageType, { type: 'turn_aborted', id: randomUUID() });
    permissionHandler.reset();
    messageQueue.reset();
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
      });
    });

  try {
    await runPermissionModePromptLoopFn({
      providerName: config.providerName,
      agentMessageType: config.agentMessageType,
      explicitPermissionMode,
      session,
      messageQueue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) => createAcpRuntimeOverrideSynchronizers({
        session,
        runtime,
        isStarted,
      }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => session.keepAlive(thinking, 'remote'),
      setThinking: (value) => {
        thinking = value;
      },
      sendReady,
      currentPermissionModeUpdatedAt: permissionModeState.getCurrentPermissionModeUpdatedAt(),
      setCurrentPermissionMode: permissionModeState.setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: permissionModeState.setCurrentPermissionModeUpdatedAt,
      initialResumeId: opts.resume,
      onAfterStart: config.onAfterStart ? () => config.onAfterStart?.({ session, runtime }) : undefined,
      onAfterReset: config.onAfterReset ? () => config.onAfterReset?.({ session, runtime }) : undefined,
      formatPromptErrorMessage: config.formatPromptErrorMessage,
    });
  } finally {
    terminationHandlers.dispose();
    await cleanupOnce();
  }
}
