import { randomUUID } from 'node:crypto';

import { render } from 'ink';
import React from 'react';
import { resolveAgentIdFromFlavor } from '@happier-dev/agents';
import { readPendingLocalId, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type {
  ApiSessionClient,
  SessionProviderInputOutcomeObserver,
  SessionProviderInputOutcomeProducer,
} from '@/api/session/sessionClient';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { MachineMetadata, Metadata, PermissionMode } from '@/api/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import {
  resolveRuntimeAwarePendingForegroundSteerability,
  resolveSessionPendingQueueDeliveryTiming,
  resolveSessionPendingQueueMaxPopPerWake,
} from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import { createSessionMetadata, type CreateSessionMetadataOptions } from '@/agent/runtime/createSessionMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { runPermissionModePromptLoop, type ReadyNotificationTurnContext } from '@/agent/runtime/runPermissionModePromptLoop';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { resolveReadyNotificationAssistantText } from '@/agent/runtime/readyNotificationAssistantText';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { createTurnAssistantPreviewTracker, type TurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import type { InFlightSteerController, InFlightSteerDeliveryIdentity } from '@/agent/runtime/permission/bindPermissionModeQueue';
import type { Credentials } from '@/persistence';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/promptLibrary/resolveCliMemoryRecallGuidanceEnabled';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import type { AgentToolsDeliveryAvailabilityResolver } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveAttachedRunRuntimeContext } from '@/agent/runtime/resolveAttachedRunRuntimeContext';
import { configuration } from '@/configuration';
import {
  createLocalAgentNativeResumeRecordStore,
  prepareAgentNativeReturnStrictResume,
} from '@/session/agentTransition/agentNativeReturn';
import { withCurrentHappierSessionId } from '@/agent/runtime/session/currentSessionIdEnv';

type RuntimeForLoop = {
  beginTurn: () => void;
  startOrLoad: (opts: { resumeId?: string }) => Promise<unknown>;
  drainPendingAfterStartOrLoad?: () => Promise<void>;
  sendPrompt: (message: string) => Promise<void>;
  compactContext?: (command: string) => Promise<void>;
  refreshGoal?: () => Promise<unknown>;
  setGoal?: (objective: string | undefined, options?: Readonly<{ status?: string; tokenBudget?: number | null }>) => Promise<unknown>;
  clearGoal?: () => Promise<unknown>;
  listVendorPlugins?: () => Promise<unknown>;
  listSkills?: () => Promise<unknown>;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  steerPrompt?: (message: string, identity?: InFlightSteerDeliveryIdentity) => Promise<void>;
  flushTurn: () => void | Promise<void>;
  reset: () => Promise<void>;
  getSessionId: () => string | null;
  cancel: () => Promise<void>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string | number | boolean | null) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
};

const KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS = 100;

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
    getAbortSignal: () => AbortSignal;
    setThinking: (value: boolean) => void;
    memoryRecallGuidanceEnabled: boolean;
    processEnv?: NodeJS.ProcessEnv;
    toolDelivery: 'native_mcp' | 'shell_bridge' | 'unsupported';
    pendingQueueDrainMaxPopPerWake?: number;
    providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
    turnAssistantPreviewTracker: TurnAssistantPreviewTracker;
    startupOverrides?: {
      mode?: { modeId: string; updatedAt?: number } | null;
      model?: { modelId: string; updatedAt?: number } | null;
    };
  }) => RuntimeForLoop;
  resolveRuntimeDirectory?: (params: { session: ApiSessionClient; metadata: Metadata }) => string;
  createSendReady?: (params: { session: ApiSessionClient; api: ApiClient }) => (context?: ReadyNotificationTurnContext) => void;
  beforeInitializeSession?: (params: { metadata: Metadata; opts: StandardAcpProviderRunOptions }) => void;
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void;
  onAttachMetadataSnapshotError?: (error: unknown) => void;
  onSessionSwap?: (params: { session: ApiSessionClient }) => void | Promise<void>;
  onAfterStart?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  onAfterReset?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  onDispose?: (params: { session: ApiSessionClient; runtime: RuntimeForLoop }) => void | Promise<void>;
  startRuntimeBeforeFirstPrompt?: boolean;
  failClosedOnResumeFailure?: boolean;
  /**
   * True when the backend applies the effective coding system prompt at process
   * spawn without waiting for the first message — e.g. pi, where the spawn flag
   * (`--append-system-prompt`) carries residual user content and the tools-bridge
   * extension appends the Happier base blocks (session title, response options,
   * attachments, linked workspace, memory recall) from its launch flags before the
   * first LLM call. The fresh-session first-message prepend then carries only an
   * explicit per-message base override, which cannot ride either path, instead of
   * duplicating the spawn-delivered system prompt.
   */
  deliversSystemPromptAtSpawn?: boolean;
  onTerminalDisplayControllerReady?: (controller: TerminalDisplayController) => void;
  shouldRenderTerminalDisplay?: (params: { opts: StandardAcpProviderRunOptions; session: ApiSessionClient; metadata: Metadata }) => boolean;
  resolveKeepAliveMode?: () => KeepAliveMode;
  resolveToolsDeliveryAvailability?: AgentToolsDeliveryAvailabilityResolver;
};

type StandardAcpProviderDeps = {
  initializeBackendApiContextFn?: typeof initializeBackendApiContext;
  createSessionMetadataFn?: typeof createSessionMetadata;
  initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
  resolveRunnerMcpServersFn?: typeof resolveRunnerMcpServers;
  createProviderEnforcedPermissionHandlerFn?: typeof createProviderEnforcedPermissionHandler;
  createPermissionModeQueueStateFn?: typeof createPermissionModeQueueState;
  createSessionProviderInputConsumerFn?: typeof createSessionProviderInputConsumer;
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  sendReadyWithPushNotificationFn?: typeof sendReadyWithPushNotification;
  registerKillSessionHandlerFn?: typeof registerKillSessionHandler;
  cleanupBackendRunResourcesFn?: typeof cleanupBackendRunResources;
  renderFn?: typeof render;
  /** Protected local handoff storage is the only mocked runtime boundary here. */
  createLocalAgentNativeResumeRecordStoreFn?: typeof createLocalAgentNativeResumeRecordStore;
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
  const createSessionProviderInputConsumerFn = deps.createSessionProviderInputConsumerFn ?? createSessionProviderInputConsumer;
  const runPermissionModePromptLoopFn = deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop;
  const sendReadyWithPushNotificationFn = deps.sendReadyWithPushNotificationFn ?? sendReadyWithPushNotification;
  const registerKillSessionHandlerFn = deps.registerKillSessionHandlerFn ?? registerKillSessionHandler;
  const cleanupBackendRunResourcesFn = deps.cleanupBackendRunResourcesFn ?? cleanupBackendRunResources;
  const renderFn = deps.renderFn ?? render;
  const createLocalAgentNativeResumeRecordStoreFn =
    deps.createLocalAgentNativeResumeRecordStoreFn ?? createLocalAgentNativeResumeRecordStore;

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
  const pendingQueueDrainMaxPopPerWake = resolveSessionPendingQueueMaxPopPerWake(accountSettings);
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
  let providerInputOutcomeObserver: SessionProviderInputOutcomeObserver | null = null;
  const bindProviderInputOutcomeProducer = (targetSession: ApiSessionClient): void => {
    const producer = Object.freeze({
      providerId: policyAgentId,
      mode: 'acp',
      matchesCurrentSession: ({ metadata: currentMetadata }) => (
        currentMetadata !== null
        && typeof currentMetadata === 'object'
        && (currentMetadata as Record<string, unknown>).flavor === config.flavor
      ),
    }) satisfies SessionProviderInputOutcomeProducer;
    providerInputOutcomeObserver = targetSession.bindProviderInputOutcomeProducer(producer);
  };
  let permissionHandler: ProviderEnforcedPermissionHandler;
  let rebindPermissionModeQueueSession: ((session: ApiSessionClient) => void) | null = null;
  let rebindOverrideSynchronizerSession: ((session: ApiSessionClient) => Promise<void>) | null = null;
  let pendingPermissionModeQueueSessionSwap: ApiSessionClient | null = null;
  // Used by the message-queue binding to optionally steer additional user input into an in-flight turn.
  // This is late-bound because the queue binding is initialized before the runtime is created.
  let runtimeForInFlightSteer: RuntimeForLoop | null = null;
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
      bindProviderInputOutcomeProducer(newSession);
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
      if (rebindPermissionModeQueueSession) {
        rebindPermissionModeQueueSession(newSession);
      } else {
        pendingPermissionModeQueueSessionSwap = newSession;
      }
      if (runtimeForInFlightSteer) {
        newSession.setSessionRuntimeControls?.(runtimeForInFlightSteer);
      }
      const swapFailures: unknown[] = [];
      try {
        await rebindOverrideSynchronizerSession?.(newSession);
      } catch (error) {
        swapFailures.push(error);
        logger.debug(`${config.uiLogPrefix} Failed to rebind runtime override synchronizers after session swap (non-fatal)`, error);
      }
      try {
        await config.onSessionSwap?.({ session: newSession });
      } catch (error) {
        swapFailures.push(error);
        logger.debug(`${config.uiLogPrefix} Provider session-swap hook failed (non-fatal)`, error);
      }
      if (swapFailures.length === 1) {
        throw swapFailures[0];
      }
      if (swapFailures.length > 1) {
        throw new AggregateError(swapFailures, `${config.uiLogPrefix} Session-swap hooks failed`);
      }
    },
    onAttachMetadataSnapshotMissing: config.onAttachMetadataSnapshotMissing,
    onAttachMetadataSnapshotError: config.onAttachMetadataSnapshotError,
  });

  session = initializedSession.session;
  bindProviderInputOutcomeProducer(session);
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

  const inFlightSteerController: InFlightSteerController = {
    supportsInFlightSteer: () => runtimeForInFlightSteer?.supportsInFlightSteer?.() === true,
    isTurnInFlight: () => runtimeForInFlightSteer?.isTurnInFlight?.() === true,
    steerText: async (text: string, identity?: InFlightSteerDeliveryIdentity) => {
      const runtime = runtimeForInFlightSteer;
      if (!runtime?.steerPrompt) {
        throw new Error('in-flight steer is not available');
      }
      const outcome = await providerInputConsumer.runProviderInputDispatch({
        abortSignal: abortController.signal,
        dispatch: async () => {
          if (identity === undefined) {
            await runtime.steerPrompt!(text);
            return;
          }
          await runtime.steerPrompt!(text, identity);
          const localIds = [...new Set([
            ...(identity.localId === undefined ? [] : [identity.localId]),
            ...(identity.localIds ?? []),
          ].map(readPendingLocalId).filter((value): value is string => value !== null))];
          if (localIds.length === 1) {
            providerInputOutcomeObserver?.({ kind: 'accepted', localId: localIds[0] });
          }
        },
      });
      if (outcome.status === 'cancelled') {
        const error = new Error('Provider input admission closed');
        error.name = 'AbortError';
        throw error;
      }
    },
    cancelActiveTurn: async () => {
      const runtime = runtimeForInFlightSteer;
      if (!runtime) {
        throw new Error('active-turn cancellation is not available');
      }
      await runtime.cancel();
    },
  };

  const permissionModeState = createPermissionModeQueueStateFn({
    session,
    initialPermissionMode,
    inFlightSteer: inFlightSteerController,
    resolvePermissionModeQueueKey: config.resolvePermissionModeQueueKey,
  });
  rebindPermissionModeQueueSession = permissionModeState.rebindSession;
  if (pendingPermissionModeQueueSessionSwap) {
    rebindPermissionModeQueueSession(pendingPermissionModeQueueSessionSwap);
    pendingPermissionModeQueueSessionSwap = null;
  }
  const { messageQueue } = permissionModeState;
  const promptArtifactBodyCache = new Map<string, string | null>();
  const turnAssistantPreviewTracker = createTurnAssistantPreviewTracker();
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
  let lastKeepAliveSentAt = 0;
  let lastKeepAliveSignature: string | null = null;
  const sendKeepAlive = (): void => {
    const now = Date.now();
    const mode = getKeepAliveMode();
    const signature = `${session.sessionId}:${thinking ? 'thinking' : 'idle'}:${mode}`;
    if (lastKeepAliveSignature === signature && now - lastKeepAliveSentAt < KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS) return;
    session.keepAlive(thinking, mode);
    lastKeepAliveSignature = signature;
    lastKeepAliveSentAt = now;
  };
  const setThinkingState = (value: boolean): void => {
    if (thinking === value) return;
    thinking = value;
    sendKeepAlive();
  };
  sendKeepAlive();
  const keepAliveTickIntervalMs = Math.min(configuration.sessionKeepAliveIdleMs, configuration.sessionKeepAliveThinkingMs);
  const keepAliveInterval = setInterval(() => {
    const cadenceMs = thinking ? configuration.sessionKeepAliveThinkingMs : configuration.sessionKeepAliveIdleMs;
    if (Date.now() - lastKeepAliveSentAt >= cadenceMs) {
      sendKeepAlive();
    }
  }, keepAliveTickIntervalMs);
  keepAliveInterval.unref?.();

  const runtimeDirectory = runtimeContext.runtimeDirectory;
  const toolDelivery = resolveAgentToolsDelivery(policyAgentId, {
    directory: runtimeDirectory,
    environmentVariables: process.env,
  }, config.resolveToolsDeliveryAvailability);
  const supportsMcpServers = (config.supportsMcpServers ?? true) && toolDelivery === 'native_mcp';
  const mcpSession = applyRunnerMcpSessionContext(session, {
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    getBackendTarget: () => opts.backendTarget ?? null,
    getCurrentSessionLocation: () => ({
      path: runtimeDirectory,
      host: config.machineMetadata.host,
      machineId,
    }),
  });
  const { happierMcpServer, mcpServers } = supportsMcpServers
    ? await resolveRunnerMcpServersFn({
      session: mcpSession,
      credentials: opts.credentials,
      accountSettings: opts.accountSettingsContext?.settings ?? null,
      machineId,
      directory: runtimeDirectory,
      sessionMetadata: runtimeContext.sessionMetadataSnapshot ?? runtimeMetadata,
    })
    : { happierMcpServer: { url: '', stop: () => {} }, mcpServers: {} };
  const memoryRecallGuidanceEnabled = await resolveCliMemoryRecallGuidanceEnabled();
  const providerInputConsumer = createSessionProviderInputConsumerFn({
    messageQueue,
    session,
    pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
    resolvePendingQueueDeliveryTiming: () => resolveSessionPendingQueueDeliveryTiming(
      opts.accountSettingsContext?.settings ?? null,
    ),
    resolveActiveTurnSteerability: () => {
      const runtime = runtimeForInFlightSteer;
      return resolveRuntimeAwarePendingForegroundSteerability({
        hasActiveProviderTurn: runtime?.isTurnInFlight?.() === true,
        canSteerPrompt: runtime?.supportsInFlightSteer?.() === true && typeof runtime.steerPrompt === 'function',
      });
    },
  });
  const runtime = config.createRuntime({
    directory: runtimeDirectory,
    metadata: runtimeMetadata,
    machineId,
    session,
    messageBuffer,
    mcpServers,
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    getAbortSignal: () => abortController.signal,
    setThinking: setThinkingState,
    memoryRecallGuidanceEnabled,
    processEnv: withCurrentHappierSessionId(process.env, session.sessionId),
    toolDelivery,
    pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: providerInputConsumer as SessionProviderInputConsumer<unknown, unknown>,
    turnAssistantPreviewTracker,
  });
  runtime.drainPendingAfterStartOrLoad = async () => {
    await providerInputConsumer.drainPending({ reason: 'standard-acp-start-or-load' });
  };
  runtimeForInFlightSteer = runtime;
  session.setSessionRuntimeControls?.(runtime);

  let cleanupPromise: Promise<void> | null = null;
  let explicitAbortPromise: Promise<void> | null = null;
  let providerInputDispatchDrain: Promise<void> | null = null;
  const closeProviderInputAdmission = (): Promise<void> => {
    providerInputDispatchDrain ??= providerInputConsumer.closeProviderInputAdmissionAndWaitForDispatches();
    return providerInputDispatchDrain;
  };
  let apiSessionClosedForCleanup = false;
  const closeApiSessionForCleanup = async () => {
    if (apiSessionClosedForCleanup) return;
    apiSessionClosedForCleanup = true;
    try {
      await session.close();
    } catch (error) {
      logger.debug(`${config.uiLogPrefix} Failed to close API session during session cleanup (non-fatal)`, error);
    }
  };
  const cleanupOnce = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await closeProviderInputAdmission();
      // The provider loop can unwind as soon as explicit Stop closes input admission. Join the
      // already-started typed provider cancellation before closing the API or disposing the
      // backend, otherwise cleanup can reject that same turn as a provider failure.
      await explicitAbortPromise;
      try {
        await permissionHandler.abortPendingRequestsAndFlush('Session ended');
      } catch (error) {
        logger.debug(`${config.uiLogPrefix} Failed to clean up pending permissions during session cleanup (non-fatal)`, error);
      }
      await closeApiSessionForCleanup();
      await initializedSession.disposeRuntimeActivity?.().catch((error) => {
        logger.debug(`${config.uiLogPrefix} Failed to dispose runtime Activity during session cleanup (non-fatal)`, error);
      });
      await cleanupBackendRunResourcesFn({
        keepAliveInterval,
        reconnectionHandle,
        stopMcpServer: () => happierMcpServer.stop(),
        resetRuntime: () => runtime.reset(),
        unmountUi: unmountTerminalDisplay,
      });
      await config.onDispose?.({ session, runtime });
    })();
    return cleanupPromise;
  };

  const handleAbort = (): Promise<void> => {
    if (explicitAbortPromise) return explicitAbortPromise;
    const operation = (async () => {
      logger.debug(`${config.uiLogPrefix} Abort requested`);
      await permissionHandler.abortPendingRequestsAndFlush('Aborted by user');
      session.sendAgentMessage(config.agentMessageType, { type: 'turn_aborted', id: randomUUID() });
      abortController.abort();
      try {
        await runtime.cancel();
      } catch (error) {
        logger.debug(`${config.uiLogPrefix} Failed to cancel current operation (non-fatal)`, error);
      } finally {
        abortController = new AbortController();
      }
    })();
    explicitAbortPromise = operation;
    const clearExplicitAbort = (): void => {
      if (explicitAbortPromise === operation) explicitAbortPromise = null;
    };
    void operation.then(clearExplicitAbort, clearExplicitAbort);
    return operation;
  };
  abortRequestedCallback = handleAbort;

  const terminationHandlers = registerRunnerTerminationHandlers({
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
      // user-intent action owned by setSessionArchivedState. cleanupOnce closes the API
      // session so the Session projection becomes inactive and stays resumable.
      await cleanupOnce();
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
    : ((context?: ReadyNotificationTurnContext) => {
      const includeAssistantPreviewText =
        opts.accountSettingsContext?.settings?.notificationsSettingsV1?.readyIncludeMessageText !== false;
      sendReadyWithPushNotificationFn({
        session,
        pushSender: api.push(),
        waitingForCommandLabel: config.waitingForCommandLabel,
        logPrefix: config.uiLogPrefix,
        sessionTitle: getSessionNotificationTitle(session.getMetadataSnapshot?.bind(session) ?? null),
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
    });

  const initialResumeId = typeof opts.resume === 'string' ? opts.resume.trim() : '';
  const nativeReturnRecordStore = initialResumeId
    ? createLocalAgentNativeResumeRecordStoreFn()
    : null;
  const trackedNativeReturn = nativeReturnRecordStore !== null
    ? await prepareAgentNativeReturnStrictResume({
      store: nativeReturnRecordStore,
      sessionId: session.sessionId,
      targetAgentId: policyAgentId,
      vendorResumeId: initialResumeId,
      updateMetadata: async (updater) => await session.updateMetadata((metadata) =>
        updater(metadata as Record<string, unknown>) as typeof metadata,
      ),
    })
    : null;
  const toolDeliverySessionId = toolDelivery === 'shell_bridge'
    ? session.sessionId
    : runtime.getSessionId();

  try {
    // A local native return removes only its own prior projection before the
    // strict provider-open path. Ordinary resumes retain their existing id.
    await trackedNativeReturn?.clearBeforeProviderOpen();
    await runPermissionModePromptLoopFn({
      providerName: config.providerName,
      providerId: policyAgentId,
      agentMessageType: config.agentMessageType,
      explicitPermissionMode,
      session,
      providerInputOutcomeObserver: (outcome) => providerInputOutcomeObserver?.(outcome),
      messageQueue,
      inputConsumer: providerInputConsumer,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) => {
        const synchronizer = createRuntimeOverrideSynchronizers({
          session,
          runtime,
          isStarted,
        });
        rebindOverrideSynchronizerSession = synchronizer.rebindSession;
        return synchronizer;
      },
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: sendKeepAlive,
      setThinking: setThinkingState,
      sendReady,
      currentPermissionModeUpdatedAt: permissionModeState.getCurrentPermissionModeUpdatedAt(),
      setCurrentPermissionMode: permissionModeState.setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: permissionModeState.setCurrentPermissionModeUpdatedAt,
      initialResumeId: initialResumeId || undefined,
      strictInitialResume: initialResumeId.length > 0,
      onStrictInitialResumeFailure: trackedNativeReturn?.isTracked
        ? async () => {
          await trackedNativeReturn.invalidateOnMismatch();
        }
        : undefined,
      failClosedOnResumeFailure: config.failClosedOnResumeFailure === true,
      startRuntimeBeforeFirstPrompt: config.startRuntimeBeforeFirstPrompt === true,
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) => {
        if (config.deliversSystemPromptAtSpawn !== true) {
          return await resolveEffectiveCodingPromptText({
            credentials: opts.credentials,
            settings: opts.accountSettingsContext?.settings ?? null,
            profileId: session.getMetadataSnapshot()?.profileId ?? null,
            baseOverride,
            executionRunsFeatureEnabled: resolveCliFeatureDecision({
              featureId: 'execution.runs',
              env: process.env,
            }).state === 'enabled',
            providerId: policyAgentId,
            toolDelivery,
            toolDeliverySessionId,
            toolDeliveryDirectory: runtimeDirectory,
            memoryMachineId: machineId,
            memoryRecallGuidanceEnabled,
            cache: promptArtifactBodyCache,
          });
        }
        // The backend delivers the effective coding system prompt at process
        // spawn. Pi uses one canonically ordered protected bridge config when its
        // native extension binds, or --append-system-prompt for the fallback. The
        // first-message prepend must not duplicate either path; only an explicit
        // per-message base override, unavailable at spawn, still rides here.
        return typeof baseOverride === 'string' && baseOverride.trim()
          ? baseOverride.trim()
          : '';
      },
      onAfterStart: config.onAfterStart ? () => config.onAfterStart?.({ session, runtime }) : undefined,
      onAfterReset: config.onAfterReset ? () => config.onAfterReset?.({ session, runtime }) : undefined,
      formatPromptErrorMessage: config.formatPromptErrorMessage,
    });
  } finally {
    terminationHandlers.dispose();
    await cleanupOnce();
  }
}
type SessionControlTerminalFailure =
  | Readonly<{ kind: 'model'; requested: string; error: unknown }>
  | Readonly<{ kind: 'config'; configId: string; requested: string; error: unknown }>;

export function reportSessionControlTerminalFailure(params: Readonly<{
  failure: SessionControlTerminalFailure;
  provider: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  session: Pick<ApiSessionClient, 'sendAgentMessage'>;
  messageBuffer: Pick<MessageBuffer, 'addMessage'>;
  formatError: (error: unknown) => string;
}>): void {
  const message = params.formatError(params.failure.error);
  params.session.sendAgentMessage(params.provider, { type: 'message', message });
  params.messageBuffer.addMessage(message, 'status');
}
