import { randomUUID } from 'node:crypto';

import type { AccountSettings, BackendTargetRefV2Input } from '@happier-dev/protocol';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { PushNotificationClient } from '@/api/pushNotifications';
import { createCurrentSessionTranscriptPort } from '@/api/session/createCurrentSessionTranscriptPort';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { MachineMetadata, Metadata, PermissionMode } from '@/api/types';
import type { McpServerConfig } from '@/agent';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { createSessionMetadata, type CreateSessionMetadataOptions } from '@/agent/runtime/createSessionMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import {
  initializeBackendRunSession,
  type InitializeBackendRunSessionOptions,
} from '@/agent/runtime/initializeBackendRunSession';
import type { DeferredStartupBootstrapResult } from '@/agent/runtime/startup/deferredStartupTypes';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import type {
  PromptLoopBoundaryReason,
  PromptLoopCheckpointLifecycle,
  PromptLoopResetReason,
  runPermissionModePromptLoop,
} from '@/agent/runtime/runPermissionModePromptLoop';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/prompts/library/resolveCliMemoryRecallGuidanceEnabled';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveSessionPendingQueueMaxPopPerWake } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import { resolveAttachedRunRuntimeContext } from '@/agent/runtime/resolveAttachedRunRuntimeContext';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { observeCanonicalSessionStateMetadata } from '@/agent/runtime/state/observeCanonicalSessionStateMetadata';
import { runSessionLoopLifecycle, type SessionLoopLifecycleDeps } from '@/agent/runtime/session/loop/lifecycle';
import {
  registerSessionRollbackRpcHandler,
  resolveSessionRollbackRuntimeFacet,
  type SessionRollbackRuntimeFacet,
} from '@/agent/runtime/session/loop/sessionRollbackRpc';
import {
  resolveHostSessionRuntimeFactoryResult,
  type HostSessionRuntimeFactoryResult as SharedHostSessionRuntimeFactoryResult,
} from '@/agent/runtime/session/loop/factoryResult';
import { createSwapAwareRpcHandlerRegistrar } from '@/agent/runtime/session/loop/createSwapAwareRpcHandlerRegistrar';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';
import type { SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import type { MetadataUpdatePort, SessionStateFacet, SessionStateSyncEngine } from '@happier-dev/agents';
import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents/session/controls/checkpoints';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

export type HostSessionRuntimeHookRuntime = Readonly<{
  sendPromptWithMeta?: (params: { text: string; localId?: string | null }) => Promise<void>;
  shouldResumeAfterPermissionModeChange?: () => boolean;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
  steerPrompt?: (prompt: string, options?: Readonly<{ localId?: string | null }>) => Promise<void>;
  notifyPromptQueuedDuringTurn?: () => void;
  /**
   * Lane Q: apply a steered message's permission-mode delta to the RUNNING turn so the message
   * can steer instead of deferring to turn end. Runtimes without the capability leave it
   * undefined; their mode-changing messages keep the queue path.
   */
  applyConfigDeltaInFlight?: (delta: Readonly<{ permissionMode: string }>) => Promise<
    Readonly<
      | { status: 'applied' }
      | { status: 'scheduled_in_turn' }
      | { status: 'unsupported'; reason?: string | undefined }
      | { status: 'failed'; reason?: string | undefined }
    >
  >;
  getSessionId?: () => string | null;
  refreshGoal?: SessionRuntimeControls['refreshGoal'];
  setGoal?: SessionRuntimeControls['setGoal'];
  clearGoal?: SessionRuntimeControls['clearGoal'];
  listVendorPlugins?: SessionRuntimeControls['listVendorPlugins'];
  listSkills?: SessionRuntimeControls['listSkills'];
  startInlineReview?: SessionRuntimeControls['startInlineReview'];
  invalidateConnectedServiceAuthTransports?: SessionRuntimeControls['invalidateConnectedServiceAuthTransports'];
  enableUsageLimitWaitResume?: SessionRuntimeControls['enableUsageLimitWaitResume'];
  cancelUsageLimitWaitResume?: SessionRuntimeControls['cancelUsageLimitWaitResume'];
  checkUsageLimitRecoveryNow?: SessionRuntimeControls['checkUsageLimitRecoveryNow'];
  handleUserMessage?: SessionRuntimeControls['handleUserMessage'];
}> & RuntimeTurnOperations;

export type HostSessionRuntimeFactoryParams = Readonly<{
  directory: string;
  metadata: Metadata;
  machineId: string;
  session: ApiSessionClient;
  transcriptSession: TranscriptSessionPort;
  messageQueue?: MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  accountSettings?: AccountSettings | null;
  pendingQueueDrainMaxPopPerWake?: number;
  permissionHandler: ProviderEnforcedPermissionHandler;
  getPermissionMode: () => PermissionMode;
  setThinking: (value: boolean) => void;
  memoryRecallGuidanceEnabled: boolean;
  sessionState?: SessionStateSyncEngine;
}>;

export type HostSessionRuntimeInitialModelSelection = Readonly<{
  modelId?: string;
  modelUpdatedAt?: number;
}>;

export type HostSessionRuntimeSessionSwapStrategy = Readonly<{
  requestSessionSwap: (params: Readonly<{
    nextSession: ApiSessionClient;
    applyImmediately: () => Promise<void>;
  }>) => Promise<void> | void;
  flushPendingSessionSwap?: () => Promise<void> | void;
}>;

export type HostSessionRuntimeLifecycleHooks = Readonly<{
  resolveInitialModelSelection?: (params: Readonly<{
    opts: HostSessionRuntimeRunOptions;
    accountSettings: Record<string, unknown> | null;
    nowMs: number;
  }>) =>
    | HostSessionRuntimeInitialModelSelection
    | null
    | Promise<HostSessionRuntimeInitialModelSelection | null>;
  createSessionSwapStrategy?: (params: Readonly<{
    applySessionSwap: (nextSession: ApiSessionClient) => Promise<void>;
  }>) => HostSessionRuntimeSessionSwapStrategy;
  onRuntimeCreated?: (params: Readonly<{
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  onSessionInitialized?: (params: Readonly<{
    session: ApiSessionClient;
    opts: HostSessionRuntimeRunOptions;
    metadata: Metadata;
    attachedToExistingSession: boolean;
    machineId: string;
  }>) => void | Promise<void>;
  onBeforeReset?: (params: Readonly<{
    reason: PromptLoopResetReason;
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  onAfterReset?: (params: Readonly<{
    reason: PromptLoopResetReason;
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  onAfterLoopBoundary?: (params: Readonly<{
    reason: PromptLoopBoundaryReason;
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  onBeforeDispose?: (params: Readonly<{
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  onBeforeArchive?: (params: Readonly<{
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
    metadataTimeoutMs: number;
  }>) => void | Promise<void>;
  createCheckpointLifecycle?: (params: Readonly<{
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
    runtimeDirectory: string;
    policyAgentId: string;
  }>) => PromptLoopCheckpointLifecycle | null | Promise<PromptLoopCheckpointLifecycle | null>;
}>;

function createCurrentSessionClient(
  getSession: () => ApiSessionClient,
  rpcHandlerManager?: RpcHandlerRegistrar,
): ApiSessionClient {
  return new Proxy({} as ApiSessionClient, {
    get(_target, prop, receiver) {
      if (prop === 'rpcHandlerManager' && rpcHandlerManager) {
        return rpcHandlerManager;
      }
      const session = getSession();
      const value = Reflect.get(session, prop, receiver);
      return typeof value === 'function' ? value.bind(session) : value;
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(getSession(), prop, value, receiver);
    },
  });
}

function createActiveSessionStateMetadataPort(
  session: Pick<ApiSessionClient, 'updateMetadata'>,
): MetadataUpdatePort {
  return {
    update: async (_sessionId, updater) => {
      try {
        await session.updateMetadata((metadata) => updater(metadata) as typeof metadata);
        return { ok: true, version: 0 };
      } catch (error) {
        const code = typeof (error as { code?: unknown } | null)?.code === 'string'
          ? (error as { code: string }).code
          : 'unknown_error';
        if (code === 'unsupported' || code === 'conflict' || code === 'forbidden' || code === 'unknown_error') {
          return { ok: false, reason: code };
        }
        return { ok: false, reason: 'unknown_error' };
      }
    },
  };
}

export type HostSessionKeepAliveMode = 'terminal' | 'remote';
type PermissionToolTrace = Readonly<{
  protocol: ToolTraceProtocol;
  provider: string;
}>;

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

export type HostSessionRuntimeRunOptions = {
  credentials: import('@/persistence').Credentials;
  directory?: string;
  backendTarget?: BackendTargetRefV2Input;
  startedBy?: 'daemon' | 'terminal';
  terminalRuntime?: import('@/terminal/runtime/terminalRuntimeFlags').TerminalRuntimeFlags | null;
  startingMode?: TerminalRemoteSessionMode | 'local';
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  sessionModeId?: string;
  sessionModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  existingSessionId?: string;
  resume?: string;
  accountSettingsContext?: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext | null;
  environmentVariables?: Record<string, string>;
};

export type HostSessionRuntimePushSender = Pick<PushNotificationClient, 'sendToAllDevices' | 'sendToAllDevicesAsync'>;

export type HostSessionRuntimeLoopApi = Readonly<{
  push: () => HostSessionRuntimePushSender;
}>;

export type HostSessionRuntimeConfig = {
  flavor: CreateSessionMetadataOptions['flavor'];
  policyAgentId: string;
  backendDisplayName: string;
  uiLogPrefix: string;
  providerName: string;
  waitingForCommandLabel: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  checkpointToolProtocol?: RuntimeCheckpointToolProtocolV1;
  supportsMcpServers?: boolean;
  machineMetadata: MachineMetadata;
  terminalDisplay: React.ComponentType<TerminalDisplayProps>;
  formatPromptErrorMessage: (error: unknown) => string;
  resolvePermissionModeQueueKey?: (permissionMode: PermissionMode) => string;
  augmentSessionMetadata?: (metadata: Metadata) => Metadata;
  createSessionRuntime?: (
    params: HostSessionRuntimeFactoryParams,
  ) => SharedHostSessionRuntimeFactoryResult<HostSessionRuntimeHookRuntime>
    | Promise<SharedHostSessionRuntimeFactoryResult<HostSessionRuntimeHookRuntime>>;
  resolveRuntimeDirectory?: (params: { session: ApiSessionClient; metadata: Metadata }) => string;
  createSendReady?: (params: { session: ApiSessionClient; api: HostSessionRuntimeLoopApi }) => () => void;
  beforeInitializeSession?: (params: { metadata: Metadata; opts: HostSessionRuntimeRunOptions }) => void;
  resolveInitialResumeId?: (params: { opts: HostSessionRuntimeRunOptions; session: ApiSessionClient; metadata: Metadata }) => string | null | undefined;
  initializeSession?: Readonly<{
    startupSideEffectsOrder?: InitializeBackendRunSessionOptions['startupSideEffectsOrder'];
  }>;
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void;
  onAttachMetadataSnapshotError?: (error: unknown) => void;
  onSessionSwap?: (params: { session: ApiSessionClient }) => void | Promise<void>;
  onAfterStart?: (params: { session: ApiSessionClient; runtime: HostSessionRuntimeHookRuntime }) => void | Promise<void>;
  onAfterReset?: (params: { session: ApiSessionClient; runtime: HostSessionRuntimeHookRuntime }) => void | Promise<void>;
  onDispose?: (params: { session: ApiSessionClient; runtime: HostSessionRuntimeHookRuntime }) => void | Promise<void>;
  lifecycleHooks?: HostSessionRuntimeLifecycleHooks;
  startRuntimeBeforeFirstPrompt?: boolean;
  onTerminalDisplayControllerReady?: (controller: TerminalDisplayController) => void;
  shouldRenderTerminalDisplay?: (params: { opts: HostSessionRuntimeRunOptions; session: ApiSessionClient; metadata: Metadata }) => boolean;
  resolveRunnerMcpServersAccountSettings?: (params: { opts: HostSessionRuntimeRunOptions; session: ApiSessionClient; metadata: Metadata }) => AccountSettings | null;
  resolveKeepAliveMode?: () => HostSessionKeepAliveMode;
  resolvePermissionToolTrace?: (params: {
    opts: HostSessionRuntimeRunOptions;
    session: ApiSessionClient;
    metadata: Metadata;
  }) => PermissionToolTrace | null;
  sessionRollbackRpc?: Readonly<{
    resolveRuntimeFacet?: (runtime: HostSessionRuntimeHookRuntime | null) => SessionRollbackRuntimeFacet | null;
  }>;
  sessionState?: Readonly<{
    facet?: SessionStateFacet | null;
    capabilities?: SessionStateCapabilitiesV1;
  }>;
  startupBootstrap?: Readonly<{
    shouldCreate?: (params: { opts: HostSessionRuntimeRunOptions }) => boolean;
    create: (params: { opts: HostSessionRuntimeRunOptions }) =>
      DeferredStartupBootstrapResult
      | Promise<DeferredStartupBootstrapResult>;
  }>;
};

export type HostSessionRuntimeDeps = {
  initializeBackendApiContextFn?: typeof initializeBackendApiContext;
  createSessionMetadataFn?: typeof createSessionMetadata;
  initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
  resolveRunnerMcpServersFn?: typeof resolveRunnerMcpServers;
  createProviderEnforcedPermissionHandlerFn?: typeof createProviderEnforcedPermissionHandler;
  createPermissionModeQueueStateFn?: typeof createPermissionModeQueueState;
  cleanupBackendRunResourcesFn?: SessionLoopLifecycleDeps['cleanupBackendRunResourcesFn'];
  createRuntimeOverrideSynchronizersFn?: SessionLoopLifecycleDeps['createRuntimeOverrideSynchronizersFn'];
  registerRunnerTerminationHandlersFn?: SessionLoopLifecycleDeps['registerRunnerTerminationHandlersFn'];
  sendReadyWithPushNotificationFn?: SessionLoopLifecycleDeps['sendReadyWithPushNotificationFn'];
  archiveAndCloseRuntimeSessionFn?: SessionLoopLifecycleDeps['archiveAndCloseRuntimeSessionFn'];
  registerKillSessionHandlerFn?: SessionLoopLifecycleDeps['registerKillSessionHandlerFn'];
  renderFn?: SessionLoopLifecycleDeps['renderFn'];
  startRemoteModeStaticControlFn?: SessionLoopLifecycleDeps['startRemoteModeStaticControlFn'];
  remoteOnlyTerminalDisplayComponent?: SessionLoopLifecycleDeps['remoteOnlyTerminalDisplayComponent'];
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  runSessionLoopLifecycleFn?: typeof runSessionLoopLifecycle;
  sessionLoopLifecycleDeps?: SessionLoopLifecycleDeps;
};

export async function runHostSessionRuntime(
  opts: HostSessionRuntimeRunOptions,
  config: HostSessionRuntimeConfig,
  deps: HostSessionRuntimeDeps = {},
): Promise<void> {
  const initializeBackendApiContextFn = deps.initializeBackendApiContextFn ?? initializeBackendApiContext;
  const createSessionMetadataFn = deps.createSessionMetadataFn ?? createSessionMetadata;
  const initializeBackendRunSessionFn = deps.initializeBackendRunSessionFn ?? initializeBackendRunSession;
  const resolveRunnerMcpServersFn = deps.resolveRunnerMcpServersFn ?? resolveRunnerMcpServers;
  const createProviderEnforcedPermissionHandlerFn = deps.createProviderEnforcedPermissionHandlerFn ?? createProviderEnforcedPermissionHandler;
  const createPermissionModeQueueStateFn = deps.createPermissionModeQueueStateFn ?? createPermissionModeQueueState;
  const runSessionLoopLifecycleFn = deps.runSessionLoopLifecycleFn ?? runSessionLoopLifecycle;

  const runtimeOpts = createCanonicalHostSessionRuntimeRunOptions(opts);
  const sessionTag = randomUUID();
  connectionState.setBackend(config.backendDisplayName);

  const policyAgentId = config.policyAgentId;
  let api: HostSessionRuntimeLoopApi;
  let machineId: string;
  let metadata: Metadata;
  let session: ApiSessionClient;
  let initialPermissionMode: PermissionMode;
  let permissionHandler: ProviderEnforcedPermissionHandler;
  let abortRequestedCallback: (() => void | Promise<void>) | null = null;
  let currentControlRpcRegistrar: ReturnType<typeof createSwapAwareRpcHandlerRegistrar> | null = null;
  let rebindPermissionModeQueueSession: ((session: ApiSessionClient) => void) | null = null;
  let pendingPermissionModeQueueSessionSwap: ApiSessionClient | null = null;
  let runtimeForInFlightSteer: HostSessionRuntimeHookRuntime | null = null;
  let runtimeForSessionRollback: HostSessionRuntimeHookRuntime | null = null;
  const runtimeState = { thinking: false };
  let reconnectionHandle: { cancel: () => void } | null = null;
  let startupCoordinatorStart: (() => void | Promise<void>) | null = null;
  let startupBootstrapCleanup: (() => void | Promise<void>) | null = null;

  const applySessionSwap = async (newSession: ApiSessionClient): Promise<void> => {
    session = newSession;
    currentControlRpcRegistrar?.rebindTo(newSession.rpcHandlerManager);
    permissionHandler?.updateSession(newSession);
    if (rebindPermissionModeQueueSession) {
      rebindPermissionModeQueueSession(newSession);
    } else {
      pendingPermissionModeQueueSessionSwap = newSession;
    }
    await config.onSessionSwap?.({ session: newSession });
  };

  const sessionSwapStrategy = config.lifecycleHooks?.createSessionSwapStrategy?.({
    applySessionSwap,
  }) ?? {
    requestSessionSwap: async ({ applyImmediately }) => {
      await applyImmediately();
    },
  } satisfies HostSessionRuntimeSessionSwapStrategy;

  const startupBootstrap =
    config.startupBootstrap?.create && (config.startupBootstrap.shouldCreate?.({ opts: runtimeOpts }) ?? true)
      ? await config.startupBootstrap.create({ opts: runtimeOpts })
      : null;

  if (startupBootstrap) {
    api = startupBootstrap.api;
    machineId = startupBootstrap.machineId;
    metadata = startupBootstrap.metadata;
    session = startupBootstrap.session;
    initialPermissionMode = runtimeOpts.permissionMode ?? 'default';
    reconnectionHandle = startupBootstrap.reconnectionHandle;
    startupCoordinatorStart = startupBootstrap.start ?? null;
    startupBootstrapCleanup = startupBootstrap.cleanup ?? null;
  } else {
    const initializedApiContext = await initializeBackendApiContextFn({
      credentials: runtimeOpts.credentials,
      machineMetadata: config.machineMetadata,
    });
    const initializationApi = initializedApiContext.api;
    api = initializationApi;
    machineId = initializedApiContext.machineId;

    const accountSettings = runtimeOpts.accountSettingsContext?.settings ?? null;
    const initialModelSelection = await config.lifecycleHooks?.resolveInitialModelSelection?.({
      opts: runtimeOpts,
      accountSettings,
      nowMs: Date.now(),
    }) ?? null;
    const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
      agentId: policyAgentId,
      backendTarget: runtimeOpts.backendTarget ? convertBackendTargetRefV2ToV1(readBackendTargetRefV2(runtimeOpts.backendTarget)) : undefined,
      explicitPermissionMode: runtimeOpts.permissionMode,
      accountSettings,
    });
    initialPermissionMode = permissionModeSeed.mode;
    const createdSessionMetadata = createSessionMetadataFn({
      flavor: config.flavor,
      machineId,
      directory: runtimeOpts.directory,
      startedBy: runtimeOpts.startedBy,
      terminalRuntime: runtimeOpts.terminalRuntime ?? null,
      permissionMode: initialPermissionMode,
      permissionModeUpdatedAt: typeof runtimeOpts.permissionModeUpdatedAt === 'number' ? runtimeOpts.permissionModeUpdatedAt : Date.now(),
      sessionModeId: runtimeOpts.sessionModeId,
      sessionModeUpdatedAt: runtimeOpts.sessionModeUpdatedAt,
      modelId: runtimeOpts.modelId ?? initialModelSelection?.modelId,
      modelUpdatedAt: runtimeOpts.modelUpdatedAt ?? initialModelSelection?.modelUpdatedAt,
      augmentMetadata: config.augmentSessionMetadata,
    });
    metadata = createdSessionMetadata.metadata;
    config.beforeInitializeSession?.({ metadata, opts: runtimeOpts });

    const initializedSession = await initializeBackendRunSessionFn({
      api: initializationApi,
      sessionTag,
      metadata,
      state: createdSessionMetadata.state,
      existingSessionId: runtimeOpts.existingSessionId,
      uiLogPrefix: config.uiLogPrefix,
      startupMetadataOverrides: createStartupMetadataOverrides(runtimeOpts),
      onSessionSwap: async (newSession) => {
        await sessionSwapStrategy.requestSessionSwap({
          nextSession: newSession,
          applyImmediately: () => applySessionSwap(newSession),
        });
      },
      startupSideEffectsOrder: config.initializeSession?.startupSideEffectsOrder,
      onAttachMetadataSnapshotMissing: config.onAttachMetadataSnapshotMissing,
      onAttachMetadataSnapshotError: config.onAttachMetadataSnapshotError,
    });

    session = initializedSession.session;
    reconnectionHandle = initializedSession.reconnectionHandle;
    await config.lifecycleHooks?.onSessionInitialized?.({
      session,
      opts: runtimeOpts,
      metadata: runtimeContextMetadataFallback(metadata, session),
      attachedToExistingSession: initializedSession.attachedToExistingSession,
      machineId,
    });
  }
  currentControlRpcRegistrar = createSwapAwareRpcHandlerRegistrar(() => session.rpcHandlerManager);
  const currentLifecycleSession = createCurrentSessionClient(() => session, currentControlRpcRegistrar.registrar);
  if (config.sessionRollbackRpc) {
    registerSessionRollbackRpcHandler(
      currentControlRpcRegistrar.registrar,
      () => config.sessionRollbackRpc?.resolveRuntimeFacet?.(runtimeForSessionRollback)
        ?? resolveSessionRollbackRuntimeFacet(runtimeForSessionRollback),
    );
  }

  permissionHandler = createProviderEnforcedPermissionHandlerFn({
    session,
    logPrefix: config.uiLogPrefix,
    pushSender: api.push(),
    getAccountSettings: () => runtimeOpts.accountSettingsContext?.settings ?? null,
    getAccountSettingsSecretsReadKeys: () => runtimeOpts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
    onAbortRequested: () => abortRequestedCallback?.(),
    toolTrace: config.resolvePermissionToolTrace?.({
      opts: runtimeOpts,
      session,
      metadata: runtimeContextMetadataFallback(metadata, session),
    }) ?? null,
  });
  permissionHandler.setPermissionMode(initialPermissionMode);

  const inFlightSteerController: InFlightSteerController = {
    supportsInFlightSteer: () => runtimeForInFlightSteer?.supportsInFlightSteer?.() === true,
    isTurnInFlight: () => runtimeForInFlightSteer?.isTurnInFlight?.() === true,
    canSteerPrompt: () => (
      runtimeForInFlightSteer?.canSteerPrompt?.()
      ?? runtimeForInFlightSteer?.isTurnInFlight?.()
      ?? false
    ) === true,
    steerText: async (text: string, options?: Readonly<{ localId?: string | null }>) => {
      const runtime = runtimeForInFlightSteer;
      if (!runtime?.steerPrompt) {
        throw new Error('in-flight steer is not available');
      }
      if (options === undefined) {
        await runtime.steerPrompt(text);
        return;
      }
      await runtime.steerPrompt(text, options);
    },
    onPromptQueuedDuringTurn: () => {
      runtimeForInFlightSteer?.notifyPromptQueuedDuringTurn?.();
    },
    // Lane Q: a mode-changing message may steer only when the active runtime can own the delta
    // mid-turn. The runtime can swap, so the capability resolves at call time; a runtime without
    // the hook reports `unsupported` and the message keeps the queue path.
    applyConfigDeltaInFlight: async (delta) => {
      const apply = runtimeForInFlightSteer?.applyConfigDeltaInFlight;
      if (typeof apply !== 'function') {
        return { status: 'unsupported', reason: 'runtime_without_in_flight_config_capability' };
      }
      return apply(delta);
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

  const runtimeContext = resolveAttachedRunRuntimeContext({
    session,
    metadata,
    resolveRuntimeDirectory: config.resolveRuntimeDirectory,
  });
  const runtimeMetadata = runtimeContext.resolvedMetadata;
  const runtimeDirectory = runtimeContext.runtimeDirectory;
  const transcriptSession = createCurrentSessionTranscriptPort(() => session);
  const { messageQueue } = permissionModeState;
  const runnerMcpAccountSettings = config.resolveRunnerMcpServersAccountSettings
    ? config.resolveRunnerMcpServersAccountSettings({
      opts: runtimeOpts,
      session,
      metadata: runtimeContext.sessionMetadataSnapshot ?? runtimeMetadata,
    })
    : runtimeOpts.accountSettingsContext?.settings ?? null;
  const supportsMcpServers = (config.supportsMcpServers ?? true) && resolveAgentToolsDelivery(policyAgentId) === 'native_mcp';
  const { happierMcpServer, mcpServers } = supportsMcpServers
    ? await resolveRunnerMcpServersFn({
      session,
      credentials: runtimeOpts.credentials,
      accountSettings: runnerMcpAccountSettings,
      machineId,
      directory: runtimeDirectory,
      sessionMetadata: runtimeContext.sessionMetadataSnapshot ?? runtimeMetadata,
    })
    : { happierMcpServer: { stop: () => undefined }, mcpServers: {} };
  const memoryRecallGuidanceEnabled = await resolveCliMemoryRecallGuidanceEnabled();
  const messageBuffer = new MessageBuffer();
  const sessionStateBridge = createCliRuntimeSessionStateBridge({
    credentials: runtimeOpts.credentials,
    session: currentLifecycleSession,
    facet: config.sessionState?.facet ?? null,
    capabilities: config.sessionState?.capabilities ?? config.sessionState?.facet?.capabilities ?? {},
    metadataPort: createActiveSessionStateMetadataPort(currentLifecycleSession),
  });
  const sessionStateMetadataObserver = observeCanonicalSessionStateMetadata({
    session: currentLifecycleSession,
    sessionState: sessionStateBridge.engine,
  });
  const sessionRuntimeParams: HostSessionRuntimeFactoryParams = {
    directory: runtimeDirectory,
    metadata: runtimeMetadata,
    machineId,
    session,
    transcriptSession,
    messageQueue,
    messageBuffer,
    mcpServers,
    accountSettings: runnerMcpAccountSettings,
    pendingQueueDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(runtimeOpts.accountSettingsContext?.settings ?? null),
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    setThinking: (value) => {
      runtimeState.thinking = value;
    },
    memoryRecallGuidanceEnabled,
    sessionState: sessionStateBridge.engine,
  };
  let createdRuntime: SharedHostSessionRuntimeFactoryResult<HostSessionRuntimeHookRuntime>;
  if (config.createSessionRuntime) {
    createdRuntime = await config.createSessionRuntime(sessionRuntimeParams);
  } else {
    throw new Error('Host session runtime config must define createSessionRuntime');
  }
  const { runtime, nativeRuntime } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
  runtimeForInFlightSteer = nativeRuntime;
  runtimeForSessionRollback = nativeRuntime;
  const unsubscribeRuntimePublication = subscribeSessionRuntimePublicationToMetadata({
    session: currentLifecycleSession,
    sessionState: sessionStateBridge.engine,
    runtime,
  });
  if (nativeRuntime) {
    currentLifecycleSession.setSessionRuntimeControls({
      ...(typeof nativeRuntime.refreshGoal === 'function' ? { refreshGoal: nativeRuntime.refreshGoal.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.setGoal === 'function' ? { setGoal: nativeRuntime.setGoal.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.clearGoal === 'function' ? { clearGoal: nativeRuntime.clearGoal.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.listVendorPlugins === 'function' ? { listVendorPlugins: nativeRuntime.listVendorPlugins.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.listSkills === 'function' ? { listSkills: nativeRuntime.listSkills.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.startInlineReview === 'function' ? { startInlineReview: nativeRuntime.startInlineReview.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.invalidateConnectedServiceAuthTransports === 'function'
        ? { invalidateConnectedServiceAuthTransports: nativeRuntime.invalidateConnectedServiceAuthTransports.bind(nativeRuntime) }
        : {}),
      ...(typeof nativeRuntime.enableUsageLimitWaitResume === 'function' ? { enableUsageLimitWaitResume: nativeRuntime.enableUsageLimitWaitResume.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.cancelUsageLimitWaitResume === 'function' ? { cancelUsageLimitWaitResume: nativeRuntime.cancelUsageLimitWaitResume.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.checkUsageLimitRecoveryNow === 'function' ? { checkUsageLimitRecoveryNow: nativeRuntime.checkUsageLimitRecoveryNow.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.handleUserMessage === 'function' ? { handleUserMessage: nativeRuntime.handleUserMessage.bind(nativeRuntime) } : {}),
    });
    await config.lifecycleHooks?.onRuntimeCreated?.({ session, runtime: nativeRuntime });
  }
  const originalOnAfterStart = config.onAfterStart;
  config.onAfterStart = async (params) => {
    await originalOnAfterStart?.(params);
    await sessionStateMetadataObserver.mirrorCurrentDisplayTitle('reconciliation');
  };

  try {
    await runSessionLoopLifecycleFn({
      opts: runtimeOpts,
      config,
      api,
      session: currentLifecycleSession,
      runtime,
      hookRuntime: nativeRuntime,
      messageBuffer,
      permissionHandler,
      permissionModeState,
      sessionSwapStrategy,
      runtimeDirectory,
      runtimeMetadata,
      machineId,
      memoryRecallGuidanceEnabled,
      policyAgentId,
      happyMcpServerStop: () => happierMcpServer.stop(),
      reconnectionHandle,
      startupCoordinator: startupCoordinatorStart || startupBootstrapCleanup
        ? {
            start: startupCoordinatorStart,
            cleanup: startupBootstrapCleanup,
          }
        : null,
      runtimeState,
      setAbortRequestedCallback: (callback) => {
        abortRequestedCallback = callback;
      },
      deps: {
        ...(deps.sessionLoopLifecycleDeps ?? {}),
        cleanupBackendRunResourcesFn: deps.cleanupBackendRunResourcesFn ?? deps.sessionLoopLifecycleDeps?.cleanupBackendRunResourcesFn,
        createRuntimeOverrideSynchronizersFn: deps.createRuntimeOverrideSynchronizersFn ?? deps.sessionLoopLifecycleDeps?.createRuntimeOverrideSynchronizersFn,
        registerRunnerTerminationHandlersFn: deps.registerRunnerTerminationHandlersFn ?? deps.sessionLoopLifecycleDeps?.registerRunnerTerminationHandlersFn,
        sendReadyWithPushNotificationFn: deps.sendReadyWithPushNotificationFn ?? deps.sessionLoopLifecycleDeps?.sendReadyWithPushNotificationFn,
        archiveAndCloseRuntimeSessionFn: deps.archiveAndCloseRuntimeSessionFn ?? deps.sessionLoopLifecycleDeps?.archiveAndCloseRuntimeSessionFn,
        registerKillSessionHandlerFn: deps.registerKillSessionHandlerFn ?? deps.sessionLoopLifecycleDeps?.registerKillSessionHandlerFn,
        renderFn: deps.renderFn ?? deps.sessionLoopLifecycleDeps?.renderFn,
        startRemoteModeStaticControlFn: deps.startRemoteModeStaticControlFn ?? deps.sessionLoopLifecycleDeps?.startRemoteModeStaticControlFn,
        remoteOnlyTerminalDisplayComponent: deps.remoteOnlyTerminalDisplayComponent ?? deps.sessionLoopLifecycleDeps?.remoteOnlyTerminalDisplayComponent,
        runPermissionModePromptLoopFn: deps.runPermissionModePromptLoopFn,
      },
      initialResumeId: (() => {
        const explicitResumeId = typeof runtimeOpts.resume === 'string' ? runtimeOpts.resume.trim() : '';
        if (explicitResumeId) return explicitResumeId;
        return config.resolveInitialResumeId?.({ opts: runtimeOpts, session, metadata: runtimeMetadata })?.trim() ?? '';
      })(),
    });
  } finally {
    currentLifecycleSession.setSessionRuntimeControls(null);
    config.onAfterStart = originalOnAfterStart;
    sessionStateMetadataObserver.dispose();
    unsubscribeRuntimePublication();
    if (!startupCoordinatorStart) {
      await startupBootstrapCleanup?.();
    }
  }
}

function runtimeContextMetadataFallback(
  metadata: Metadata,
  session: ApiSessionClient,
): Metadata {
  const snapshot = session.getMetadataSnapshot();
  return snapshot ?? metadata;
}

function createCanonicalHostSessionRuntimeRunOptions(
  opts: HostSessionRuntimeRunOptions,
): HostSessionRuntimeRunOptions {
  return {
    credentials: opts.credentials,
    directory: opts.directory,
    ...(opts.backendTarget ? { backendTarget: readBackendTargetRefV2(opts.backendTarget) } : {}),
    startedBy: opts.startedBy,
    terminalRuntime: opts.terminalRuntime ?? null,
    startingMode: opts.startingMode,
    permissionMode: opts.permissionMode,
    permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
    sessionModeId: typeof opts.sessionModeId === 'string' ? opts.sessionModeId.trim() || undefined : undefined,
    sessionModeUpdatedAt: opts.sessionModeUpdatedAt,
    modelId: opts.modelId,
    modelUpdatedAt: opts.modelUpdatedAt,
    existingSessionId: opts.existingSessionId,
    resume: opts.resume,
    accountSettingsContext: opts.accountSettingsContext ?? null,
    ...(opts.environmentVariables ? { environmentVariables: { ...opts.environmentVariables } } : {}),
  };
}
