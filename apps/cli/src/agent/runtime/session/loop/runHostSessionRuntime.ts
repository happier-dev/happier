import { randomUUID } from 'node:crypto';

import type {
  AccountSettings,
  AgentProviderBindingLaunchMaterializationV1,
  BackendTargetRefV2Input,
  SessionModelSelectionV1,
  ProviderBoundModelRef,
  SessionModelTransitionRequestV1,
} from '@happier-dev/protocol';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agent-runtime';
import {
  buildBackendTargetKeyV2,
  applySessionProviderBindingMetadataV1,
  convertBackendTargetRefV2ToV1,
  readBackendTargetRefV2,
  SessionModelSelectionV1Schema,
  SessionModelTransitionRequestV1Schema,
  SessionModelTransitionResultV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ApiClient } from '@/api/api';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  ApiSessionClient,
  ApiSessionClientOptions,
  StartupSessionPublisherAuthorityClaimResult,
} from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { PushNotificationClient } from '@/api/pushNotifications';
import { createCurrentSessionTranscriptPort } from '@/api/session/createCurrentSessionTranscriptPort';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { MachineMetadata, Metadata, PermissionMode } from '@/api/types';
import type { McpServerConfig } from '@/agent';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import {
  captureSessionLaunchControlMetadata,
  createSessionMetadata,
  type CreateSessionMetadataOptions,
  type SessionLaunchControlMetadata,
} from '@/agent/runtime/createSessionMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import {
  initializeBackendRunSession,
  type InitializeBackendRunSessionOptions,
} from '@/agent/runtime/initializeBackendRunSession';
import { createPreparedDeferredStartupBootstrap } from '@/agent/runtime/startup/createPreparedDeferredStartupBootstrap';
import type { DeferredStartupBootstrapResult } from '@/agent/runtime/startup/deferredStartupTypes';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import {
  runPermissionModePromptLoop,
  type PromptLoopBoundaryReason,
  type PromptLoopCheckpointLifecycle,
  type PromptLoopResetReason,
} from '@/agent/runtime/runPermissionModePromptLoop';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/prompts/library/resolveCliMemoryRecallGuidanceEnabled';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import {
  resolveSessionPendingQueueDeliveryTiming,
  resolveSessionPendingQueueMaxPopPerWake,
} from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import { resolveAttachedRunRuntimeContext } from '@/agent/runtime/resolveAttachedRunRuntimeContext';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { observeCanonicalSessionStateMetadata } from '@/agent/runtime/state/observeCanonicalSessionStateMetadata';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
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
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/session/input/_types';
import {
  createSessionProviderInputOutcomeNormalizer,
  type HostProviderInputOutcomeEvidence,
} from '@/agent/runtime/session/input/providerInputOutcome';
import { registerSessionProviderInputAdmissionRpc } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { createSessionProviderInputConsumerSessionAdapter } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { resolveInitialHostSessionModelSelection } from '@/agent/runtime/session/loop/resolveInitialModelSelection';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import type { RuntimeTurnOperations, RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { AgentSessionRuntimeEventV1 } from '@happier-dev/protocol/runtime';
import {
  createInitialHostRuntimeActivityMutation,
  createHostRuntimeActivityProjection,
  resolveAgentRuntimeActivitySubscriber,
  type HostRuntimeActivityProjection,
} from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import type { RuntimeActivityApplicability } from '@/agent/runtime/session/activity/runtimeActivityApplicability';
import type { TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';
import type { SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import type { MetadataUpdatePort, SessionStateFacet, SessionStateSyncEngine } from '@happier-dev/agents';
import {
  getAgentModelConfig,
  isAgentId,
  resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import { createModelIntentMetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents/session/controls/checkpoints';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { buildScopedProcessEnv, normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import { isAgentSessionContinuationUnreachableError } from '@/session/shared/spawnSessionContract';
import { consumeProviderBindingLaunchHandoffFromEnvironments } from '@/plugins/runtime/providerBindings/handoff';
import { beginProviderBindingRuntimeDiagnosticRedaction } from '@/plugins/runtime/providerBindings/runtimeDiagnosticRedaction';
import { logger } from '@/ui/logger';
import {
  consumePersistedTakeoverAdmissionFromEnv,
  parsePersistedTakeoverAdmission,
  type HostPrivatePersistedTakeoverAdmission,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import {
  admitPersistedTakeoverBeforeRuntime as admitPersistedTakeoverBeforeRuntimeViaDaemon,
  reportPersistedTakeoverRuntimeBound as reportPersistedTakeoverRuntimeBoundViaDaemon,
} from '@/agent/runtime/startupSideEffects';
import {
  registerAgentSessionRealtimeVoiceRpc,
  type AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';
import {
  createSessionModelTransitionCoordinator,
  mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult,
  type AuthorizedSessionModelTransitionTarget,
} from '@/providers/sessions/sessionModelTransitionCoordinator';
import { createSessionModelTransitionAuthorizer } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import {
  tryCreateDaemonAgentRuntimeTurnContributionsBridge,
  tryCreateDaemonSessionModelTransitionProviderAuthorizer,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient';
import { resolveNativeAgentModelApplyPolicy } from '@/providers/sessions/resolveModelSelectionApplyPolicy';
import { applyActiveModelFacts } from '@/providers/sessions/applyActiveModelFacts';

type AgentSessionModelsSource = Parameters<AgentSessionHostServices['models']['bind']>[0];
type TransformSessionInputBeforeCommit = NonNullable<
  ApiSessionClientOptions['transformSessionInputBeforeCommit']
>;

function createScopedSessionInputTransformer(
  bridge: SessionLoopLifecycleDeps['daemonTurnContributionsBridge'],
): TransformSessionInputBeforeCommit | undefined {
  if (!bridge) return undefined;
  return async (payload) => {
    const rawSessionId = payload.sessionId;
    if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) {
      throw new Error('Session input transform requires a canonical session id');
    }
    const transformed = await bridge.transformSessionInput({
      sessionId: rawSessionId.trim(),
      payload,
    });
    return { ...transformed };
  };
}

export type HostRuntimeReplacementLifecycle = Readonly<{
  beforeReplacement(): Promise<void>;
  onSuccessorBound(): void | Promise<void>;
  onSuccessorUsable(): Promise<void>;
}>;

export type HostSessionRuntimeHookRuntime = Readonly<{
  setRuntimeReplacementLifecycle?: (lifecycle: HostRuntimeReplacementLifecycle) => void;
  subscribeCanonicalAgentSessionEvents?: (
    handler: (event: AgentSessionRuntimeEventV1) => void,
  ) => () => void;
  models?: AgentSessionModelsSource;
  setOnPromptAcceptedByProvider?: (handler: ((info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
  }>) => void) | null) => void;
  setOnPromptDeliveryOutcome?: (
    handler: ((outcome: HostProviderInputOutcomeEvidence) => void) | null,
  ) => void;
  setOnPromptTerminallyRejectedBeforeProvider?: (handler: ((info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
    deliveryBlockedReason?: string;
  }>) => void) | null) => void;
  setOnPromptDeliveryBlockerCleared?: (handler: ((info: Readonly<{
    deliveryBlockedReason?: string;
  }>) => void) | null) => void;
  sendPromptWithMeta?: (params: {
    text: string;
    localId?: string | null;
    localIds?: readonly string[];
    structuredInput?: RuntimeTurnPromptMeta['structuredInput'];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }) => Promise<void>;
  shouldResumeAfterPermissionModeChange?: () => boolean;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
  steerPrompt?: (
    prompt: string,
    options?: Readonly<{
      localId?: string | null;
      localIds?: readonly string[];
      userMessageSeq?: number | null;
      userMessageSeqs?: readonly number[];
    }>,
  ) => Promise<void>;
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
  applyConnectedServiceAuthGeneration?: SessionRuntimeControls['applyConnectedServiceAuthGeneration'];
  readConnectedServiceRuntimeIdentity?: SessionRuntimeControls['readConnectedServiceRuntimeIdentity'];
  enableUsageLimitWaitResume?: SessionRuntimeControls['enableUsageLimitWaitResume'];
  cancelUsageLimitWaitResume?: SessionRuntimeControls['cancelUsageLimitWaitResume'];
  checkUsageLimitRecoveryNow?: SessionRuntimeControls['checkUsageLimitRecoveryNow'];
  consumeUsageLimitResetCredit?: SessionRuntimeControls['consumeUsageLimitResetCredit'];
  clearTerminalComposer?: SessionRuntimeControls['clearTerminalComposer'];
  interruptPendingInputAndRun?: SessionRuntimeControls['interruptPendingInputAndRun'];
  handleUserMessage?: SessionRuntimeControls['handleUserMessage'];
}> & RuntimeTurnOperations;

export type HostSessionRuntimeFactoryParams = Readonly<{
  directory: string;
  metadata: Metadata;
  machineId: string;
  session: ApiSessionClient;
  transcriptSession: TranscriptSessionPort;
  messageQueue?: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  accountSettings?: AccountSettings | null;
  providerBindingMaterialization?: AgentProviderBindingLaunchMaterializationV1;
  pendingQueueDrainMaxPopPerWake?: number;
  pendingQueueDeliveryTiming?: AccountSettings['sessionPendingQueueDeliveryTiming'];
  permissionHandler: ProviderEnforcedPermissionHandler;
  getPermissionMode: () => PermissionMode;
  setThinking: (value: boolean) => void;
  memoryRecallGuidanceEnabled: boolean;
  sessionState?: SessionStateSyncEngine;
  recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

export type HostSessionRuntimeInitialModelSelection = SessionModelSelectionV1;

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
    set(_target, prop, value) {
      return Reflect.set(getSession(), prop, value);
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

function resolveHostActiveModelSelection(params: Readonly<{
  agentTargetKey: string;
  runtimeSelection?: SessionModelSelectionV1;
}>): ProviderBoundModelRef {
  return params.runtimeSelection?.ref
    ?? {
      agentTargetKey: params.agentTargetKey,
      providerConnectionId: null,
      modelId: 'default',
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
  modelSelection?: SessionModelSelectionV1;
  existingSessionId?: string;
  sessionAttachFilePath?: string;
  resume?: string;
  accountSettingsContext?: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext | null;
  environmentVariables?: Record<string, string>;
  unsetEnvironmentVariables?: readonly string[];
  resolveLateEnvironment?: import('@/plugins/runtime/runtimeCore/plugin/sessionLaunch').HostPrivateLateSessionEnvironmentResolver;
  launchControlMetadata?: SessionLaunchControlMetadata;
  /**
   * Host-private, attempt-scoped correlation for an explicit persisted takeover.
   *
   * This value is consumed by the host loop and is never projected into runtime factory params,
   * session metadata, plugin input, or the ordinary respawn path.
   */
  persistedTakeoverAdmission?: HostPrivatePersistedTakeoverAdmission;
};

export type HostSessionRuntimePushSender = Pick<PushNotificationClient, 'sendToAllDevices' | 'sendToAllDevicesAsync'>;

export type HostSessionRuntimeStartupSeed = Readonly<{
  permissionMode: PermissionMode;
  permissionModeUpdatedAt: number;
  permissionModeSource:
    | import('@/settings/permissions/permissionModeSeed').PermissionModeSeedSource
    | 'released_cache_v1';
  modelSelection: SessionModelSelectionV1 | null;
}>;

export type HostSessionRuntimeLoopApi = Readonly<{
  push: () => HostSessionRuntimePushSender;
}>;

export type HostSessionRuntimeConfig = {
  flavor: CreateSessionMetadataOptions['flavor'];
  policyAgentId: string;
  /** Daemon-carrier-local retirement authority; never inferred from runtime diagnostics. */
  daemonAgentRuntimeCarrierRetirementSignal?: AbortSignal;
  agentSessionRealtimeVoiceAuthority?: AgentSessionRealtimeVoiceAuthority;
  backendDisplayName: string;
  uiLogPrefix: string;
  providerName: string;
  waitingForCommandLabel: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  providerSessionMetadataKey?: string | null;
  checkpointToolProtocol?: RuntimeCheckpointToolProtocolV1;
  supportsMcpServers?: boolean;
  runtimeActivityApplicability: RuntimeActivityApplicability;
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
  sessionState?: Readonly<{
    facet?: SessionStateFacet | null;
    capabilities?: SessionStateCapabilitiesV1;
  }>;
  startupBootstrap?: Readonly<{
    resolveSeed?: (params: Readonly<{
      opts: HostSessionRuntimeRunOptions;
      seed: HostSessionRuntimeStartupSeed;
    }>) => HostSessionRuntimeStartupSeed | Promise<HostSessionRuntimeStartupSeed>;
    shouldCreate?: (params: {
      opts: HostSessionRuntimeRunOptions;
      seed: HostSessionRuntimeStartupSeed;
    }) => boolean;
    create: (params: {
      opts: HostSessionRuntimeRunOptions & Readonly<{ launchControlMetadata: SessionLaunchControlMetadata }>;
      seed: HostSessionRuntimeStartupSeed;
      createPreparedDeferredStartupBootstrap: typeof createPreparedDeferredStartupBootstrap;
    }) =>
      DeferredStartupBootstrapResult
      | Promise<DeferredStartupBootstrapResult>;
    writeRuntimeOverrides?: (params: Readonly<{
      permissionMode: PermissionMode;
      permissionModeUpdatedAt: number;
      modelSelection: SessionModelSelectionV1 | null;
    }>) => void;
  }>;
};

export type HostSessionRuntimeDeps = {
  initializeBackendApiContextFn?: typeof initializeBackendApiContext;
  createPreparedDeferredStartupBootstrapFn?: typeof createPreparedDeferredStartupBootstrap;
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
  admitPersistedTakeoverBeforeRuntimeFn?: (
    correlation: HostPrivatePersistedTakeoverAdmission,
  ) => Promise<void>;
  reportPersistedTakeoverRuntimeBoundFn?: (
    correlation: HostPrivatePersistedTakeoverAdmission,
  ) => Promise<void>;
};

function readPersistedTakeoverAdmission(
  value: HostPrivatePersistedTakeoverAdmission | undefined,
): HostPrivatePersistedTakeoverAdmission | null {
  if (value === undefined) return null;
  try {
    return parsePersistedTakeoverAdmission(value);
  } catch {
    throw new Error('Persisted takeover admission requires bounded operationId and attemptId values');
  }
}

export async function runHostSessionRuntime(
  opts: HostSessionRuntimeRunOptions,
  config: HostSessionRuntimeConfig,
  deps: HostSessionRuntimeDeps = {},
): Promise<void> {
  const initializeBackendApiContextFn = deps.initializeBackendApiContextFn ?? initializeBackendApiContext;
  const createPreparedDeferredStartupBootstrapFn =
    deps.createPreparedDeferredStartupBootstrapFn ?? createPreparedDeferredStartupBootstrap;
  const createSessionMetadataFn = deps.createSessionMetadataFn ?? createSessionMetadata;
  const initializeBackendRunSessionFn = deps.initializeBackendRunSessionFn ?? initializeBackendRunSession;
  const resolveRunnerMcpServersFn = deps.resolveRunnerMcpServersFn ?? resolveRunnerMcpServers;
  const createProviderEnforcedPermissionHandlerFn = deps.createProviderEnforcedPermissionHandlerFn ?? createProviderEnforcedPermissionHandler;
  const createPermissionModeQueueStateFn = deps.createPermissionModeQueueStateFn ?? createPermissionModeQueueState;
  const runSessionLoopLifecycleFn = deps.runSessionLoopLifecycleFn ?? runSessionLoopLifecycle;
  const daemonTurnContributionsBridge =
    deps.sessionLoopLifecycleDeps?.daemonTurnContributionsBridge
    ?? tryCreateDaemonAgentRuntimeTurnContributionsBridge()
    ?? undefined;
  const transformSessionInputBeforeCommit = createScopedSessionInputTransformer(
    daemonTurnContributionsBridge,
  );

  const persistedTakeoverAdmissionFromEnv =
    consumePersistedTakeoverAdmissionFromEnv();
  const persistedTakeoverAdmission = readPersistedTakeoverAdmission(
    opts.persistedTakeoverAdmission
      ?? persistedTakeoverAdmissionFromEnv
      ?? undefined,
  );
  const runtimeOpts = createCanonicalHostSessionRuntimeRunOptions(opts);
  const hasLateEnvironmentAdmission =
    typeof runtimeOpts.resolveLateEnvironment === 'function';
  // Canonicalization owns this scoped clone, so deletion prevents later launch projection
  // without mutating the caller's run options.
  const providerBindingHandoff = consumeProviderBindingLaunchHandoffFromEnvironments([
    ...(runtimeOpts.environmentVariables ? [runtimeOpts.environmentVariables] : []),
    process.env,
  ]);
  const selectedProviderConnectionId = runtimeOpts.modelSelection?.ref.providerConnectionId;
  const providerBindingModel = providerBindingHandoff?.sessionBindingMetadata.model;
  if (
    selectedProviderConnectionId !== null
    && selectedProviderConnectionId !== undefined
    && !hasLateEnvironmentAdmission
  ) {
    const binding = providerBindingHandoff?.sessionBindingMetadata;
    if (!providerBindingHandoff || !binding || binding.connectionId !== selectedProviderConnectionId) {
      throw new Error('Provider-bound model selection requires a validated provider binding handoff');
    }
    if (
      providerBindingModel === undefined
      || providerBindingModel.id !== runtimeOpts.modelSelection?.ref.modelId
    ) {
      throw new Error('Provider binding handoff model does not match the selected model');
    }
    if (providerBindingHandoff.materialization.kind !== binding.materialization) {
      throw new Error('Provider binding handoff materialization does not match its session metadata');
    }
  } else if (
    (selectedProviderConnectionId === null
      || selectedProviderConnectionId === undefined)
    && providerBindingHandoff
  ) {
    throw new Error('Native model selection cannot include a provider binding handoff');
  }
  const providerBindingMaterialization = providerBindingHandoff?.materialization;
  const providerBindingMetadataUpdate = providerBindingHandoff?.sessionBindingMetadata
    ?? (runtimeOpts.modelSelection?.ref.providerConnectionId === null ? null : undefined);
  const providerBindingRuntimeDiagnosticRedaction = beginProviderBindingRuntimeDiagnosticRedaction({
    agentId: config.policyAgentId,
    providerBindingActive: providerBindingHandoff !== undefined,
    environment: buildScopedProcessEnv({
      baseEnv: process.env,
      explicitEnv: runtimeOpts.environmentVariables,
      unsetEnvKeys: runtimeOpts.unsetEnvironmentVariables,
    }),
  });
  let disposeAgentSessionRealtimeVoiceRpc: (() => void) | null = null;
  try {
  const sessionTag = randomUUID();
  connectionState.setBackend(config.backendDisplayName);

  const policyAgentId = config.policyAgentId;
  const modelTargetKey = runtimeOpts.backendTarget
    ? buildBackendTargetKeyV2(readBackendTargetRefV2(runtimeOpts.backendTarget))
    : buildBackendTargetKeyV2({ kind: 'backend', backendId: policyAgentId, sourceKind: 'built_in' });
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
  let runtimeActivityProjection: HostRuntimeActivityProjection | null = null;
  let agentRuntimeActivityBinding: ReturnType<HostRuntimeActivityProjection['bindAgentRuntime']> | null = null;
  let executionRunsActivityBinding: ReturnType<HostRuntimeActivityProjection['bindExecutionRuns']> | null = null;
  let unsubscribeRuntimeActivityEvents: (() => void) | null = null;
  let unsubscribeExecutionRunActivity: (() => void) | null = null;
  let runtimeActivitySubscriptionEpoch = 0;
  let runtimeActivitySourceSessionId: string | null = null;
  let modelTransitionCoordinator: ReturnType<
    typeof createSessionModelTransitionCoordinator
  > | null = null;
  const runtimeState = { thinking: false };
  const appliedModelByPendingLocalId = new Map<string, Readonly<{
    provider: string;
    selection: ProviderBoundModelRef;
  }>>();
  let reconnectionHandle: { cancel: () => void } | null = null;
  let startupCoordinatorStart: (() => void | Promise<void>) | null = null;
  let commitPendingFirstInputAfterRuntimeReady: (() => Promise<void>) | null = null;
  let deferredStartupStart: DeferredStartupBootstrapResult['start'] = null;
  let startupBootstrapCancel: (() => void) | null = null;
  let startupBootstrapCleanup: (() => void | Promise<void>) | null = null;
  let pendingAttachedProviderBindingMetadataUpdate = false;

  const observeRuntimeActivityPublication = (
    publication: Promise<void>,
    source: string,
  ): void => {
    void publication
      .catch(() => {
        logger.debug(
          `${config.uiLogPrefix} Runtime Activity ${source} publication failed (non-fatal)`,
          {
            error: 'runtime_activity_publication_failed',
            source,
          },
        );
      })
      .catch(() => undefined);
  };

  const reportFireAndForgetRuntimeActivityError = (): void => {
    logger.debug(`${config.uiLogPrefix} Runtime Activity background publication failed (non-fatal)`, {
      error: 'runtime_activity_background_publication_failed',
    });
  };

  const runtimeActivityApplicability = config.runtimeActivityApplicability;

  const stopAgentRuntimeActivitySubscription = (): void => {
    runtimeActivitySubscriptionEpoch += 1;
    const unsubscribe = unsubscribeRuntimeActivityEvents;
    unsubscribeRuntimeActivityEvents = null;
    try {
      unsubscribe?.();
    } catch {
      logger.debug(
        `${config.uiLogPrefix} Runtime Activity subscriber disposal failed after logical fencing (non-fatal)`,
        {
          error: 'runtime_activity_subscriber_disposal_failed',
        },
      );
    }
  };

  const bindAgentRuntimeActivityProducer = (
    producer: HostSessionRuntimeHookRuntime,
    sourceSessionId: string,
  ): void => {
    const subscribeRuntimeActivity = resolveAgentRuntimeActivitySubscriber({
      applicability: runtimeActivityApplicability,
      subscribeCanonicalAgentSessionEvents: producer.subscribeCanonicalAgentSessionEvents,
    });
    stopAgentRuntimeActivitySubscription();
    agentRuntimeActivityBinding = null;
    runtimeActivitySourceSessionId = null;
    if (!subscribeRuntimeActivity) return;

    const projection = runtimeActivityProjection;
    if (!projection) throw new Error('Runtime Activity producer binding requires an active projection');
    const subscriptionEpoch = ++runtimeActivitySubscriptionEpoch;
    let activatedBinding: ReturnType<HostRuntimeActivityProjection['bindAgentRuntime']> | null = null;
    const bufferedEvents: AgentSessionRuntimeEventV1[] = [];
    const observeEvent = (event: AgentSessionRuntimeEventV1): void => {
      if (runtimeActivitySubscriptionEpoch !== subscriptionEpoch) return;
      const binding = activatedBinding;
      if (!binding) {
        bufferedEvents.push(event);
        return;
      }
      const expectedSourceSessionId = runtimeActivitySourceSessionId;
      if (!expectedSourceSessionId || event.sessionId !== expectedSourceSessionId) return;
      const targetSessionId = session.sessionId;
      observeRuntimeActivityPublication(
        binding.observeEvent(event.sessionId === targetSessionId
          ? event
          : { ...event, sessionId: targetSessionId }),
        'agent-runtime',
      );
    };
    const unsubscribe = subscribeRuntimeActivity(observeEvent);
    activatedBinding = projection.bindAgentRuntime({ applicability: 'supported' });
    agentRuntimeActivityBinding = activatedBinding;
    runtimeActivitySourceSessionId = sourceSessionId;
    unsubscribeRuntimeActivityEvents = unsubscribe;
    for (const event of bufferedEvents.splice(0)) observeEvent(event);
  };

  const augmentSessionMetadata = (metadata: Metadata): Metadata => {
    const augmented = config.augmentSessionMetadata ? config.augmentSessionMetadata(metadata) : metadata;
    return providerBindingMetadataUpdate !== undefined
      ? applySessionProviderBindingMetadataV1(augmented, providerBindingMetadataUpdate) as Metadata
      : augmented;
  };
  const applySessionSwap = async (newSession: ApiSessionClient): Promise<void> => {
    const previousSession = typeof session === 'undefined' ? null : session;
    const retainsRuntimeActivityProjection = runtimeActivityProjection !== null
      && previousSession?.sessionId === newSession.sessionId;
    const retainedRuntimeActivitySourceSessionId = runtimeActivitySourceSessionId
      ?? previousSession?.sessionId
      ?? newSession.sessionId;
    if (previousSession && previousSession !== newSession) {
      previousSession.deactivateDurableMutationDelivery();
      try {
        await newSession.stageInitialDurableMutationSnapshots();
      } catch (error) {
        await previousSession.activateDurableMutationDelivery();
        throw error;
      }
      if (retainsRuntimeActivityProjection) {
        unsubscribeExecutionRunActivity?.();
        unsubscribeExecutionRunActivity = null;
        await executionRunsActivityBinding?.revoke();
        executionRunsActivityBinding = null;
      } else {
        stopAgentRuntimeActivitySubscription();
        await agentRuntimeActivityBinding?.revoke();
        await executionRunsActivityBinding?.revoke();
        unsubscribeExecutionRunActivity?.();
        unsubscribeExecutionRunActivity = null;
        agentRuntimeActivityBinding = null;
        executionRunsActivityBinding = null;
        runtimeActivityProjection?.dispose();
        runtimeActivityProjection = null;
      }
    }
    await newSession.activateDurableMutationDelivery();
    session = newSession;
    if (previousSession && previousSession !== newSession) {
      await previousSession.close();
    }
    await newSession.flushDurableMutationDelivery();
    if (retainsRuntimeActivityProjection) {
      if (previousSession !== newSession) {
        executionRunsActivityBinding = runtimeActivityProjection!.bindExecutionRuns();
        unsubscribeExecutionRunActivity = newSession.subscribeExecutionRunActivitySnapshots((activeCount) => {
          const binding = executionRunsActivityBinding;
          if (!binding) return;
          observeRuntimeActivityPublication(
            binding.observeSnapshot(activeCount > 0
              ? { state: 'active', activeCount }
              : { state: 'idle', activeCount: 0 }),
            'execution-run',
          );
        });
        await runtimeActivityProjection!.reofferCurrentSnapshot();
      }
    } else {
      runtimeActivityProjection = createHostRuntimeActivityProjection({
        sessionId: newSession.sessionId,
        agentRuntimeApplicability: runtimeActivityApplicability,
        enqueueRegisteredSessionStateFieldMutation: (mutation) =>
          newSession.enqueueRegisteredSessionStateFieldMutation(mutation),
        onFireAndForgetPublicationError: reportFireAndForgetRuntimeActivityError,
      });
      executionRunsActivityBinding = runtimeActivityProjection.bindExecutionRuns();
      unsubscribeExecutionRunActivity = newSession.subscribeExecutionRunActivitySnapshots((activeCount) => {
        const binding = executionRunsActivityBinding;
        if (!binding) return;
        observeRuntimeActivityPublication(
          binding.observeSnapshot(activeCount > 0
            ? { state: 'active', activeCount }
            : { state: 'idle', activeCount: 0 }),
          'execution-run',
        );
      });
      if (runtimeForInFlightSteer) {
        bindAgentRuntimeActivityProducer(
          runtimeForInFlightSteer,
          retainedRuntimeActivitySourceSessionId,
        );
      }
      await runtimeActivityProjection.reofferCurrentSnapshot();
    }
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

  const accountSettings = runtimeOpts.accountSettingsContext?.settings ?? null;
  const initialModelSelection = await config.lifecycleHooks?.resolveInitialModelSelection?.({
    opts: runtimeOpts,
    accountSettings,
    nowMs: Date.now(),
  }) ?? null;
  const modelSelection = resolveInitialHostSessionModelSelection({
    agentTargetKey: modelTargetKey,
    runtimeSelection: runtimeOpts.modelSelection,
    lifecycleSelection: initialModelSelection ?? undefined,
  });
  const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
    agentId: policyAgentId,
    backendTarget: runtimeOpts.backendTarget
      ? convertBackendTargetRefV2ToV1(readBackendTargetRefV2(runtimeOpts.backendTarget))
      : undefined,
    explicitPermissionMode: runtimeOpts.permissionMode,
    accountSettings,
  });
  const canonicalStartupSeed: HostSessionRuntimeStartupSeed = Object.freeze({
    permissionMode: permissionModeSeed.mode,
    permissionModeUpdatedAt:
      typeof runtimeOpts.permissionModeUpdatedAt === 'number'
        ? runtimeOpts.permissionModeUpdatedAt
        : Date.now(),
    permissionModeSource: permissionModeSeed.source,
    modelSelection: modelSelection ?? null,
  });
  const startupSeed = await config.startupBootstrap?.resolveSeed?.({
    opts: runtimeOpts,
    seed: canonicalStartupSeed,
  }) ?? canonicalStartupSeed;
  const createPreparedDeferredStartupBootstrapForRuntime:
    typeof createPreparedDeferredStartupBootstrap = async (params) =>
      await createPreparedDeferredStartupBootstrapFn({
        ...params,
        transformSessionInputBeforeCommit,
        createInitialRegisteredSessionStateFieldMutations: (sessionId) => [
          createInitialHostRuntimeActivityMutation({
            sessionId,
            agentRuntimeApplicability: runtimeActivityApplicability,
          }),
        ],
      });
  const startupBootstrap =
    config.startupBootstrap?.create && (config.startupBootstrap.shouldCreate?.({
      opts: runtimeOpts,
      seed: startupSeed,
    }) ?? true)
      ? await config.startupBootstrap.create({
          opts: runtimeOpts,
          seed: startupSeed,
          createPreparedDeferredStartupBootstrap:
            createPreparedDeferredStartupBootstrapForRuntime,
        })
      : null;

  if (startupBootstrap) {
    api = startupBootstrap.api;
    machineId = startupBootstrap.machineId;
    metadata = startupBootstrap.metadata;
    session = startupBootstrap.session;
    initialPermissionMode = startupSeed.permissionMode;
    reconnectionHandle = startupBootstrap.reconnectionHandle;
    deferredStartupStart = startupBootstrap.start ?? null;
    startupBootstrapCancel = startupBootstrap.cancel ?? null;
    startupBootstrapCleanup = startupBootstrap.cleanup ?? null;
  } else {
    const initializedApiContext = await initializeBackendApiContextFn({
      credentials: runtimeOpts.credentials,
      machineMetadata: config.machineMetadata,
    });
    const initializationApi = initializedApiContext.api;
    api = initializationApi;
    machineId = initializedApiContext.machineId;
    const runtimeSessionApi: Pick<ApiClient, 'getOrCreateSession' | 'sessionSyncClient'> = {
      getOrCreateSession: (options) => initializationApi.getOrCreateSession(options),
      sessionSyncClient: (sessionRow) => {
        return initializationApi.sessionSyncClient(sessionRow, {
          initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
            sessionId: sessionRow.id,
            agentRuntimeApplicability: runtimeActivityApplicability,
          })],
          durableMutationDeliveryInitiallyActive: false,
          transformSessionInputBeforeCommit,
        });
      },
    };

    initialPermissionMode = startupSeed.permissionMode;
    const createdSessionMetadata = createSessionMetadataFn({
      flavor: config.flavor,
      machineId,
      directory: runtimeOpts.directory,
      startedBy: runtimeOpts.startedBy,
      terminalRuntime: runtimeOpts.terminalRuntime ?? null,
      permissionMode: initialPermissionMode,
      permissionModeUpdatedAt: startupSeed.permissionModeUpdatedAt,
      sessionModeId: runtimeOpts.sessionModeId,
      sessionModeUpdatedAt: runtimeOpts.sessionModeUpdatedAt,
      modelSelectionIntent: startupSeed.modelSelection
        ? {
            v: 1,
            updatedAt: startupSeed.modelSelection.updatedAt,
            selection: startupSeed.modelSelection.ref,
          }
        : undefined,
      augmentMetadata: augmentSessionMetadata,
      launchControlMetadata: runtimeOpts.launchControlMetadata,
    });
    metadata = createdSessionMetadata.metadata;
    config.beforeInitializeSession?.({ metadata, opts: runtimeOpts });

    const initializedSession = await initializeBackendRunSessionFn({
      api: runtimeSessionApi,
      sessionTag,
      metadata,
      state: createdSessionMetadata.state,
      existingSessionId: runtimeOpts.existingSessionId,
      ...(runtimeOpts.sessionAttachFilePath ? { sessionAttachFilePath: runtimeOpts.sessionAttachFilePath } : {}),
      uiLogPrefix: config.uiLogPrefix,
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: startupSeed.permissionMode,
        permissionModeUpdatedAt: startupSeed.permissionModeUpdatedAt,
        modelSelection: startupSeed.modelSelection ?? undefined,
      }),
      onSessionSwap: async (newSession) => {
        await sessionSwapStrategy.requestSessionSwap({
          nextSession: newSession,
          applyImmediately: () => applySessionSwap(newSession),
        });
      },
      startupSideEffectsOrder: config.initializeSession?.startupSideEffectsOrder,
      onAttachMetadataSnapshotMissing: config.onAttachMetadataSnapshotMissing,
      onAttachMetadataSnapshotError: config.onAttachMetadataSnapshotError,
      deferPendingFirstInputCommitUntilRuntimeReady:
        daemonTurnContributionsBridge !== undefined,
    });

    session = initializedSession.session;
    commitPendingFirstInputAfterRuntimeReady =
      initializedSession.commitPendingFirstInputAfterRuntimeReady ?? null;
    if (initializedSession.attachedToExistingSession && providerBindingMetadataUpdate !== undefined) {
      const binding = providerBindingMetadataUpdate;
      pendingAttachedProviderBindingMetadataUpdate = true;
      metadata = applySessionProviderBindingMetadataV1(
        runtimeContextMetadataFallback(metadata, session),
        binding,
      ) as Metadata;
    }
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
  runtimeActivityProjection = createHostRuntimeActivityProjection({
    sessionId: session.sessionId,
    agentRuntimeApplicability: runtimeActivityApplicability,
    enqueueRegisteredSessionStateFieldMutation: (mutation) =>
      session.enqueueRegisteredSessionStateFieldMutation(mutation),
    onFireAndForgetPublicationError: reportFireAndForgetRuntimeActivityError,
  });
  executionRunsActivityBinding = runtimeActivityProjection.bindExecutionRuns();
  unsubscribeExecutionRunActivity = session.subscribeExecutionRunActivitySnapshots((activeCount) => {
    const binding = executionRunsActivityBinding;
    if (!binding) return;
    observeRuntimeActivityPublication(
      binding.observeSnapshot(activeCount > 0
        ? { state: 'active', activeCount }
        : { state: 'idle', activeCount: 0 }),
      'execution-run',
    );
  });
  const currentLifecycleSession = createCurrentSessionClient(() => session, currentControlRpcRegistrar.registrar);
  let modelTransitionMetadataSession: Pick<
    ApiSessionClient,
    'getMetadataSnapshot' | 'updateMetadata'
  > = currentLifecycleSession;
  let deferRuntimeModelsFlushDuringAuthorityPreparation = false;
  registerSessionRollbackRpcHandler(
    currentControlRpcRegistrar.registrar,
    () => resolveSessionRollbackRuntimeFacet(runtimeForSessionRollback),
  );

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

  const observeProviderInputOutcome = createSessionProviderInputOutcomeNormalizer({
    getTarget: () => session,
    takeAppliedModel: (localId) => {
      const appliedModel = appliedModelByPendingLocalId.get(localId) ?? null;
      appliedModelByPendingLocalId.delete(localId);
      return appliedModel;
    },
    discardAppliedModel: (localId) => {
      appliedModelByPendingLocalId.delete(localId);
    },
  });
  let inputConsumer: SessionProviderInputConsumer<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt> | null = null;
  const inFlightSteerController: InFlightSteerController = {
    readActiveModelSelection: () =>
      modelTransitionCoordinator?.readActiveTarget().selection ?? null,
    supportsInFlightSteer: () => runtimeForInFlightSteer?.supportsInFlightSteer?.() === true,
    isTurnInFlight: () => runtimeForInFlightSteer?.isTurnInFlight?.() === true,
    canSteerPrompt: () => (
      runtimeForInFlightSteer?.canSteerPrompt?.()
      ?? runtimeForInFlightSteer?.isTurnInFlight?.()
      ?? false
    ) === true,
    isProviderInputAdmitted: () => inputConsumer?.readProviderInputAdmission().kind === 'admitted',
    runProviderInputDispatch: async (dispatchOpts) => {
      const consumer = inputConsumer;
      if (!consumer) {
        return { status: 'cancelled' };
      }
      return await consumer.runProviderInputDispatch(dispatchOpts);
    },
    steerText: async (text, options) => {
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
    rejectPromptBeforeProvider: (info) => {
      observeProviderInputOutcome({ type: 'rejected_before_write', ...info });
    },
    reportPromptEffectMayHaveOccurred: (info) => {
      observeProviderInputOutcome({
        type: 'possible_write',
        reason: 'provider_steer_outcome_unknown',
        ...info,
      });
    },
    interruptActiveTurn: async () => {
      const interrupt = abortRequestedCallback;
      if (!interrupt) {
        return { status: 'unsupported', reason: 'runtime_without_interrupt' };
      }
      await interrupt();
      return { status: 'interrupted' };
    },
    onPromptQueuedDuringTurn: () => {
      runtimeForInFlightSteer?.notifyPromptQueuedDuringTurn?.();
    },
    // Lane Q: a mode-changing message may steer only when the active runtime can own the delta
    // mid-turn. The runtime can swap, so the capability resolves at call time; a runtime without
    // the hook reports `unsupported`, after which ambient input queues and exact claimed steer
    // input is rejected.
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
    agentTargetKey: modelTargetKey,
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
  const runtimeMetadata = pendingAttachedProviderBindingMetadataUpdate
    ? metadata
    : runtimeContext.resolvedMetadata;
  const runtimeDirectory = pendingAttachedProviderBindingMetadataUpdate
    ? (
        config.resolveRuntimeDirectory?.({
          session,
          metadata: runtimeMetadata,
        })
        ?? runtimeMetadata.path
        ?? ''
      )
    : runtimeContext.runtimeDirectory;
  const runtimeSessionMetadataSnapshot =
    pendingAttachedProviderBindingMetadataUpdate
      ? runtimeMetadata
      : runtimeContext.sessionMetadataSnapshot;
  const transcriptSession = createCurrentSessionTranscriptPort(() => session);
  const { messageQueue } = permissionModeState;
  const pendingQueueDrainMaxPopPerWake = resolveSessionPendingQueueMaxPopPerWake(
    runtimeOpts.accountSettingsContext?.settings ?? null,
  );
  const readPendingQueueDeliveryTiming = () => resolveSessionPendingQueueDeliveryTiming(
    getActiveAccountSettingsSnapshot()?.settings
      ?? runtimeOpts.accountSettingsContext?.settings
      ?? null,
  );
  const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming();
  inputConsumer = createSessionProviderInputConsumer({
    messageQueue,
    session: createSessionProviderInputConsumerSessionAdapter(currentLifecycleSession),
    reconcileWhenEmpty: 'skip',
    pendingQueueDeliveryTiming,
    resolvePendingQueueDeliveryTiming: readPendingQueueDeliveryTiming,
    refreshBeforeQueuedBatch: false,
    pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
  });
  registerSessionProviderInputAdmissionRpc({
    consumer: inputConsumer,
    rpcHandlerRegistrar: currentControlRpcRegistrar.registrar,
  });
  let lastPendingQueueDeliveryTiming = pendingQueueDeliveryTiming;
  const unsubscribePendingQueueDeliveryTiming = subscribeActiveAccountSettingsSnapshot(() => {
    const nextPendingQueueDeliveryTiming = readPendingQueueDeliveryTiming();
    const broadenedEligibility = lastPendingQueueDeliveryTiming === 'after_runtime_idle'
      && nextPendingQueueDeliveryTiming === 'after_foreground_ready';
    lastPendingQueueDeliveryTiming = nextPendingQueueDeliveryTiming;
    if (broadenedEligibility) {
      currentLifecycleSession.wakePendingMaterialization?.();
    }
  });
  const runnerMcpAccountSettings = config.resolveRunnerMcpServersAccountSettings
    ? config.resolveRunnerMcpServersAccountSettings({
      opts: runtimeOpts,
      session,
      metadata: runtimeSessionMetadataSnapshot ?? runtimeMetadata,
    })
    : runtimeOpts.accountSettingsContext?.settings ?? null;
  const supportsMcpServers = (config.supportsMcpServers ?? true) && resolveAgentToolsDelivery(policyAgentId) === 'native_mcp';
  const runnerMcpSession = applyRunnerMcpSessionContext(currentLifecycleSession, {
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
    getBackendTarget: () => runtimeOpts.backendTarget ? readBackendTargetRefV2(runtimeOpts.backendTarget) : null,
    getCurrentSessionLocation: () => ({
      path: runtimeDirectory,
      host: config.machineMetadata.host,
      machineId,
    }),
  });
  const { happierMcpServer, mcpServers } = supportsMcpServers
    ? await resolveRunnerMcpServersFn({
      session: runnerMcpSession,
      credentials: runtimeOpts.credentials,
      accountSettings: runnerMcpAccountSettings,
      machineId,
      directory: runtimeDirectory,
      sessionMetadata: runtimeSessionMetadataSnapshot ?? runtimeMetadata,
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
    session: currentLifecycleSession,
    transcriptSession,
    messageQueue,
    messageBuffer,
    mcpServers,
    accountSettings: runnerMcpAccountSettings,
    ...(providerBindingMaterialization ? { providerBindingMaterialization } : {}),
    pendingQueueDrainMaxPopPerWake,
    pendingQueueDeliveryTiming,
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    setThinking: (value) => {
      runtimeState.thinking = value;
    },
    memoryRecallGuidanceEnabled,
    sessionState: sessionStateBridge.engine,
  };
  if (persistedTakeoverAdmission) {
    const admitPersistedTakeoverBeforeRuntime =
      deps.admitPersistedTakeoverBeforeRuntimeFn
      ?? ((correlation: HostPrivatePersistedTakeoverAdmission) =>
        admitPersistedTakeoverBeforeRuntimeViaDaemon({
          sessionId: currentLifecycleSession.sessionId,
          metadata: runtimeMetadata,
          correlation,
        }));
    await admitPersistedTakeoverBeforeRuntime(persistedTakeoverAdmission);
  }
  let createdRuntime: SharedHostSessionRuntimeFactoryResult<HostSessionRuntimeHookRuntime>;
  if (!config.createSessionRuntime) {
    throw new Error('Host session runtime config must define createSessionRuntime');
  }
  try {
    createdRuntime = await config.createSessionRuntime(sessionRuntimeParams);
  } catch (error) {
    if (isAgentSessionContinuationUnreachableError(error)) {
      await currentLifecycleSession.close().catch(() => {
        logger.debug(
          `${config.uiLogPrefix} Failed to close session after continuation verification failure (non-fatal)`,
          {
            error: 'continuation_session_close_failed',
          },
        );
      });
      try {
        unsubscribePendingQueueDeliveryTiming();
      } catch {
        logger.debug(
          `${config.uiLogPrefix} Failed to unsubscribe pending delivery timing after continuation verification failure (non-fatal)`,
          {
            error: 'continuation_pending_delivery_timing_unsubscribe_failed',
          },
        );
      }
      sessionStateMetadataObserver.dispose();
      try {
        reconnectionHandle?.cancel();
      } catch {
        logger.debug(
          `${config.uiLogPrefix} Failed to cancel reconnection after continuation verification failure (non-fatal)`,
          {
            error: 'continuation_reconnection_cancel_failed',
          },
        );
      }
      try {
        happierMcpServer.stop();
      } catch {
        logger.debug(
          `${config.uiLogPrefix} Failed to stop MCP server after continuation verification failure (non-fatal)`,
          {
            error: 'continuation_mcp_server_stop_failed',
          },
        );
      }
      try {
        await startupBootstrapCleanup?.();
      } catch {
        logger.debug(
          `${config.uiLogPrefix} Failed to clean up startup bootstrap after continuation verification failure (non-fatal)`,
          {
            error: 'continuation_startup_bootstrap_cleanup_failed',
          },
        );
      }
    }
    throw error;
  }
  const {
    runtime,
    nativeRuntime,
    terminalRemoteModeLoop,
  } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
  const hookRuntime = (nativeRuntime ?? runtime) as HostSessionRuntimeHookRuntime;
  hookRuntime.setOnPromptDeliveryOutcome?.(observeProviderInputOutcome);
  hookRuntime.setOnPromptAcceptedByProvider?.((info) => {
    observeProviderInputOutcome({ type: 'provider_accepted', ...info });
  });
  hookRuntime.setOnPromptTerminallyRejectedBeforeProvider?.((info) => {
    observeProviderInputOutcome({
      type: 'rejected_before_write',
      ...info,
      ...(info.deliveryBlockedReason ? { reason: info.deliveryBlockedReason } : {}),
    });
  });
  hookRuntime.setOnPromptDeliveryBlockerCleared?.(() => {
    currentLifecycleSession.wakePendingMaterialization?.();
  });
  let runtimeModelsPublisher:
    | ReturnType<typeof createSessionRuntimeModelsPublisher>
    | null = null;
  const disposeRuntimeModelsPublisher = (): void => {
    runtimeModelsPublisher?.dispose();
  };
  const initialActiveSelection = resolveHostActiveModelSelection({
    agentTargetKey: modelTargetKey,
    runtimeSelection: startupSeed.modelSelection ?? undefined,
  });
  const initialActiveTargetBasis: AuthorizedSessionModelTransitionTarget = {
    selection: initialActiveSelection,
    policy: 'live',
    providerBinding: providerBindingHandoff && providerBindingModel
      ? {
          connectionId: providerBindingHandoff.sessionBindingMetadata.connectionId,
          model: providerBindingModel,
          materialization: providerBindingHandoff.materialization,
        }
      : null,
    sessionBindingMetadata: providerBindingHandoff?.sessionBindingMetadata ?? null,
    runtimeBindingBasis:
      providerBindingHandoff?.sessionBindingMetadata.runtimeBindingBasis
      ?? null,
    // This basis exists only so the canonical authorizer can bind its current
    // authorization proof before the target is published or coordinator-owned.
    revalidateBeforeEffect: async () => false,
  };
  let modelTransitionOwnerCurrent = true;
  let adoptedModelSelection = startupSeed.modelSelection;
  let lastAcceptedModelIntentUpdatedAt = startupSeed.modelSelection?.updatedAt ?? 0;
  let permissionModeAuthoritativelyAdopted =
    startupSeed.permissionModeSource !== 'fallback';
  let runtimeOverrideInitialSyncComplete = false;
  let permissionModeTimestampCommitPending = false;
  const publishRuntimeOverrides = (): void => {
    if (
      !runtimeOverrideInitialSyncComplete
      || !permissionModeAuthoritativelyAdopted
      || permissionModeTimestampCommitPending
    ) return;
    config.startupBootstrap?.writeRuntimeOverrides?.({
      permissionMode:
        permissionModeState.getCurrentPermissionMode()
        ?? startupSeed.permissionMode,
      permissionModeUpdatedAt:
        permissionModeState.getCurrentPermissionModeUpdatedAt()
        || startupSeed.permissionModeUpdatedAt,
      modelSelection: adoptedModelSelection,
    });
  };
  const daemonModelTransitionAuthorizer =
    tryCreateDaemonSessionModelTransitionProviderAuthorizer(
      session.sessionId,
    );
  const authorizeModelTransition = createSessionModelTransitionAuthorizer({
    sessionId: session.sessionId,
    machineId,
    agentId: policyAgentId,
    agentTargetKey: modelTargetKey,
    nativeModelApplyPolicy: isAgentId(policyAgentId)
      ? resolveNativeAgentModelApplyPolicy(getAgentModelConfig(policyAgentId))
      : 'live',
    readActiveTarget: () =>
      modelTransitionCoordinator?.readActiveTarget()
      ?? initialActiveTargetBasis,
    ...(daemonModelTransitionAuthorizer
      ? { authorizeProviderTarget: daemonModelTransitionAuthorizer }
      : {}),
  });
  const initialActiveTarget =
    authorizeModelTransition.bindCurrentAuthorizationProof(
      initialActiveTargetBasis,
    );
  modelTransitionCoordinator = createSessionModelTransitionCoordinator({
    runId: sessionTag,
    agentTargetKey: modelTargetKey,
    initialActiveTarget,
    isCurrentRun: () => modelTransitionOwnerCurrent,
    authorize: authorizeModelTransition,
    publishIntent: async (selection) => {
      const candidate = createModelIntentMetadataCasCandidate({
        selection,
        nowMs: () => Math.max(Date.now(), lastAcceptedModelIntentUpdatedAt + 1),
      });
      await modelTransitionMetadataSession.updateMetadata(candidate.update);
      const state = candidate.readState();
      if (state.accepted && state.updatedAt !== null) {
        lastAcceptedModelIntentUpdatedAt = Math.max(
          lastAcceptedModelIntentUpdatedAt,
          state.updatedAt,
        );
      }
      return {
        accepted: state.accepted,
        updatedAt: state.updatedAt ?? lastAcceptedModelIntentUpdatedAt,
      };
    },
    applyRuntime: async (target) => {
      if (
        target.selection.providerConnectionId !== null
        && target.providerBinding === null
      ) {
        return {
          status: 'unsupported',
          reason: 'authorized_provider_binding_unavailable',
        };
      }
      const outcome = await hookRuntime.updateSessionRuntimeConfig({
        modelId: target.selection.modelId,
        ...(target.providerBinding
          ? { providerBinding: target.providerBinding }
          : {}),
      });
      return mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult(
        outcome,
      );
    },
    publishActive: async (target) => {
      await modelTransitionMetadataSession.updateMetadata((current) =>
        applyActiveModelFacts(current, target, policyAgentId));
      if (!deferRuntimeModelsFlushDuringAuthorityPreparation) {
        await runtimeModelsPublisher?.flush();
      }
      adoptedModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: lastAcceptedModelIntentUpdatedAt || Date.now(),
        ref: target.selection,
      });
      publishRuntimeOverrides();
    },
    fencePromptAdmission: async (epochId) => {
      await inputConsumer.enforceProviderInputAdmission({
        kind: 'action_required',
        reason: 'generation_pending',
        serviceId: 'host-runtime',
        groupId: 'model-transition',
        epochId,
      });
    },
    clearPromptAdmission: async (epochId) => {
      const result = await inputConsumer.clearProviderInputAdmission({
        serviceId: 'host-runtime',
        groupId: 'model-transition',
        epochId,
      });
      if (result.status !== 'cleared') {
        throw new Error('Model transition input admission fence could not be cleared');
      }
    },
    transferPromptAdmission: async (epochId, dispatchOpts) =>
      await inputConsumer.runProviderInputDispatchFromAdmission({
        admission: {
          kind: 'action_required',
          reason: 'generation_pending',
          serviceId: 'host-runtime',
          groupId: 'model-transition',
          epochId,
        },
        ...dispatchOpts,
      }),
    readRuntimeModelId: () => {
      const modelId =
        hookRuntime.models?.read().currentModelId;
      return typeof modelId === 'string' && modelId.trim().length > 0
        ? modelId.trim()
        : null;
    },
    ...(hookRuntime.models
      ? {
          subscribeRuntimeModelChanges: (
            handler: (currentModelId?: string | null) => void,
          ) =>
            {
              const subscription = hookRuntime.models!.subscribe((snapshot) =>
                handler(snapshot.currentModelId));
              return () => subscription.dispose();
            },
        }
      : {}),
  });
  let claimedSessionAuthorityPreparation:
    | Promise<StartupSessionPublisherAuthorityClaimResult>
    | null = null;
  currentControlRpcRegistrar.registrar.registerHandler(
    SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
    async (rawRequest) => {
      const request: SessionModelTransitionRequestV1 =
        SessionModelTransitionRequestV1Schema.parse(rawRequest);
      const authorityPreparation = claimedSessionAuthorityPreparation;
      if (!authorityPreparation) {
        throw new Error(
          'Session model transition refused before claimed-session authority preparation',
        );
      }
      const authority = await authorityPreparation;
      if (authority.status !== 'claimed') {
        throw new Error(
          'Session model transition refused without authoritative publisher routing',
        );
      }
      return SessionModelTransitionResultV1Schema.parse(
        await modelTransitionCoordinator!.submit(request.selection, {
          source: 'command',
        }),
      );
    },
  );
  runtimeForInFlightSteer = hookRuntime;
  bindAgentRuntimeActivityProducer(hookRuntime, session.sessionId);

  const prepareClaimedSessionAuthority = async (
    claimedSession: ApiSessionClient,
    options: Readonly<{ deferRuntimeModelsFlush: boolean }>,
  ): Promise<StartupSessionPublisherAuthorityClaimResult> => {
    const previousMetadataSession = modelTransitionMetadataSession;
    const previousDeferredFlush =
      deferRuntimeModelsFlushDuringAuthorityPreparation;
    modelTransitionMetadataSession = claimedSession;
    deferRuntimeModelsFlushDuringAuthorityPreparation =
      options.deferRuntimeModelsFlush;
    try {
      const publisherAuthority =
        await claimedSession.claimCurrentSessionPublisherAuthorityForStartup();
      await claimedSession.refreshSessionSnapshotFromServerRequired({
        reason: 'startup-drain',
      });

      if (
        pendingAttachedProviderBindingMetadataUpdate
        && providerBindingMetadataUpdate !== undefined
      ) {
        const binding = providerBindingMetadataUpdate;
        await claimedSession.updateMetadata((current) =>
          applySessionProviderBindingMetadataV1(
            current,
            binding,
          ) as typeof current);
        pendingAttachedProviderBindingMetadataUpdate = false;
      }

      const freshIntent =
        resolveModelSelectionIntentFromSessionMetadata(
          claimedSession.getMetadataSnapshot(),
          modelTargetKey,
        );
      if (freshIntent) {
        lastAcceptedModelIntentUpdatedAt = Math.max(
          lastAcceptedModelIntentUpdatedAt,
          freshIntent.updatedAt,
        );
        if (freshIntent.selection !== null) {
          adoptedModelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: freshIntent.updatedAt,
            ref: freshIntent.selection,
          });
          const result = await modelTransitionCoordinator!.submit(
            freshIntent.selection,
            { source: 'metadata' },
          );
          if (!result.ok) {
            throw new Error(
              `Startup model intent reconciliation failed: ${result.status}${
                result.reason ? ` (${result.reason})` : ''
              }`,
            );
          }
        }
      }

      const activeTarget =
        modelTransitionCoordinator!.readActiveTarget();
      await claimedSession.updateMetadata((current) =>
        applyActiveModelFacts(
          current,
          activeTarget,
          policyAgentId,
        ));
      if (!runtimeModelsPublisher && hookRuntime.models) {
        runtimeModelsPublisher = createSessionRuntimeModelsPublisher({
          agentId: config.policyAgentId,
          session: currentLifecycleSession,
          source: hookRuntime.models,
        });
      }
      if (!options.deferRuntimeModelsFlush) {
        await runtimeModelsPublisher?.flush();
      }
      await claimedSession.activateDurableMutationDelivery();
      return publisherAuthority;
    } catch (error) {
      claimedSession.deactivateDurableMutationDelivery();
      throw error;
    } finally {
      modelTransitionMetadataSession = previousMetadataSession;
      deferRuntimeModelsFlushDuringAuthorityPreparation =
        previousDeferredFlush;
    }
  };

  if (deferredStartupStart) {
    startupCoordinatorStart = async () => {
      await deferredStartupStart?.({
        prepareSession: async (claimedSession) => {
          const preparation = prepareClaimedSessionAuthority(claimedSession, {
            deferRuntimeModelsFlush: true,
          });
          claimedSessionAuthorityPreparation = preparation;
          await preparation;
        },
      });
    };
  } else {
    try {
      const preparation = prepareClaimedSessionAuthority(session, {
        deferRuntimeModelsFlush: false,
      });
      claimedSessionAuthorityPreparation = preparation;
      await preparation;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
  if (commitPendingFirstInputAfterRuntimeReady) {
    const previousStartupCoordinatorStart = startupCoordinatorStart;
    startupCoordinatorStart = async () => {
      await previousStartupCoordinatorStart?.();
      const commit = commitPendingFirstInputAfterRuntimeReady;
      commitPendingFirstInputAfterRuntimeReady = null;
      await commit?.();
    };
  }

  await runtimeActivityProjection.reofferCurrentSnapshot();
  let runtimeReplacementEpoch = 0;
  let activeRuntimeReplacementEpoch: string | null = null;
  hookRuntime.setRuntimeReplacementLifecycle?.({
    beforeReplacement: async () => {
      const epochId = `runtime-replacement:${++runtimeReplacementEpoch}`;
      activeRuntimeReplacementEpoch = epochId;
      await inputConsumer.enforceProviderInputAdmission({
        kind: 'action_required',
        reason: 'generation_pending',
        serviceId: 'host-runtime',
        groupId: 'primary-runtime',
        epochId,
      });
      try {
        stopAgentRuntimeActivitySubscription();
        await agentRuntimeActivityBinding?.revoke();
      } catch (error) {
        if (runtimeActivityApplicability === 'supported') {
          bindAgentRuntimeActivityProducer(hookRuntime, session.sessionId);
        }
        const clearResult = await inputConsumer.clearProviderInputAdmission({
          serviceId: 'host-runtime',
          groupId: 'primary-runtime',
          epochId,
        }).catch(() => {
          logger.debug(
            `${config.uiLogPrefix} Runtime replacement admission restore failed after Activity publication rejection`,
            {
              error: 'runtime_replacement_admission_restore_failed',
            },
          );
          return null;
        });
        if (clearResult?.status === 'cleared' && activeRuntimeReplacementEpoch === epochId) {
          activeRuntimeReplacementEpoch = null;
        }
        throw error;
      }
    },
    onSuccessorBound: () => {
      bindAgentRuntimeActivityProducer(hookRuntime, session.sessionId);
    },
    onSuccessorUsable: async () => {
      const epochId = activeRuntimeReplacementEpoch;
      if (!epochId) return;
      await runtimeActivityProjection?.reofferCurrentSnapshot();
      const result = await inputConsumer.clearProviderInputAdmission({
        serviceId: 'host-runtime',
        groupId: 'primary-runtime',
        epochId,
      });
      if (result.status !== 'cleared') {
        throw new Error('Runtime replacement input admission could not be reopened for the exact successor epoch');
      }
      activeRuntimeReplacementEpoch = null;
    },
  });
  runtimeForSessionRollback = nativeRuntime;
  const unsubscribeRuntimePublication = subscribeSessionRuntimePublicationToMetadata({
    session: currentLifecycleSession,
    sessionState: sessionStateBridge.engine,
    runtime,
    providerSessionMetadataKey: config.providerSessionMetadataKey,
  });
  if (nativeRuntime) {
    const voiceAuthority = config.agentSessionRealtimeVoiceAuthority;
    if (voiceAuthority) {
      disposeAgentSessionRealtimeVoiceRpc =
        registerAgentSessionRealtimeVoiceRpc({
          rpc: currentControlRpcRegistrar.registrar,
          runtime: nativeRuntime,
          getHappierSessionId: () => session.sessionId,
          ownerId: sessionTag,
          agentGeneration: voiceAuthority.generation,
          policyAgentRef: voiceAuthority.policyAgentRef,
          resolveDeclaration: voiceAuthority.resolveDeclaration,
          isGenerationCurrent: voiceAuthority.isCurrent,
          resolveProviderGeneration: voiceAuthority.resolveProviderGeneration,
          resolveRetirementSignal: voiceAuthority.resolveRetirementSignal,
          resolveConversation: voiceAuthority.resolveConversation,
        }).dispose;
    }
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
      ...(typeof nativeRuntime.applyConnectedServiceAuthGeneration === 'function'
        ? { applyConnectedServiceAuthGeneration: nativeRuntime.applyConnectedServiceAuthGeneration.bind(nativeRuntime) }
        : {}),
      ...(typeof nativeRuntime.readConnectedServiceRuntimeIdentity === 'function'
        ? { readConnectedServiceRuntimeIdentity: nativeRuntime.readConnectedServiceRuntimeIdentity.bind(nativeRuntime) }
        : {}),
      ...(typeof nativeRuntime.enableUsageLimitWaitResume === 'function' ? { enableUsageLimitWaitResume: nativeRuntime.enableUsageLimitWaitResume.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.cancelUsageLimitWaitResume === 'function' ? { cancelUsageLimitWaitResume: nativeRuntime.cancelUsageLimitWaitResume.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.checkUsageLimitRecoveryNow === 'function' ? { checkUsageLimitRecoveryNow: nativeRuntime.checkUsageLimitRecoveryNow.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.consumeUsageLimitResetCredit === 'function' ? { consumeUsageLimitResetCredit: nativeRuntime.consumeUsageLimitResetCredit.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.clearTerminalComposer === 'function' ? { clearTerminalComposer: nativeRuntime.clearTerminalComposer.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.interruptPendingInputAndRun === 'function'
        ? { interruptPendingInputAndRun: nativeRuntime.interruptPendingInputAndRun.bind(nativeRuntime) }
        : {}),
      ...(typeof nativeRuntime.handleUserMessage === 'function' ? { handleUserMessage: nativeRuntime.handleUserMessage.bind(nativeRuntime) } : {}),
    });
    await config.lifecycleHooks?.onRuntimeCreated?.({ session, runtime: nativeRuntime });
  }
  if (persistedTakeoverAdmission) {
    const reportPersistedTakeoverRuntimeBound =
      deps.reportPersistedTakeoverRuntimeBoundFn
      ?? ((correlation: HostPrivatePersistedTakeoverAdmission) =>
        reportPersistedTakeoverRuntimeBoundViaDaemon({
          sessionId: currentLifecycleSession.sessionId,
          metadata: runtimeMetadata,
          correlation,
        }));
    await reportPersistedTakeoverRuntimeBound(persistedTakeoverAdmission);
  }
  const originalOnAfterStart = config.onAfterStart;
  config.onAfterStart = async (params) => {
    await originalOnAfterStart?.(params);
    await sessionStateMetadataObserver.mirrorCurrentDisplayTitle('reconciliation');
    runtimeOverrideInitialSyncComplete = true;
    publishRuntimeOverrides();
  };
  const runtimePermissionModeState = {
    ...permissionModeState,
    setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
      permissionModeState.setCurrentPermissionMode(mode);
      permissionModeTimestampCommitPending =
        runtimeOverrideInitialSyncComplete && mode !== undefined;
      permissionModeAuthoritativelyAdopted =
        permissionModeAuthoritativelyAdopted
        || (
          runtimeOverrideInitialSyncComplete
          && mode !== undefined
          && mode !== startupSeed.permissionMode
        );
    },
    setCurrentPermissionModeUpdatedAt: (updatedAt: number) => {
      permissionModeState.setCurrentPermissionModeUpdatedAt(updatedAt);
      permissionModeTimestampCommitPending = false;
      permissionModeAuthoritativelyAdopted =
        permissionModeAuthoritativelyAdopted
        || (
          runtimeOverrideInitialSyncComplete
          && updatedAt > 0
          && updatedAt !== startupSeed.permissionModeUpdatedAt
        );
      publishRuntimeOverrides();
    },
  };

  try {
    await runSessionLoopLifecycleFn({
      opts: runtimeOpts,
      config,
      api,
      session: currentLifecycleSession,
      runtime,
      hookRuntime,
      terminalRemoteModeLoop,
      messageBuffer,
      permissionHandler,
      permissionModeState: runtimePermissionModeState,
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
            cancel: startupBootstrapCancel,
            cleanup: startupBootstrapCleanup,
          }
        : null,
      runtimeState,
      setAbortRequestedCallback: (callback) => {
        abortRequestedCallback = callback;
      },
      transitionModelSelection: async (
        selection,
        source,
        runWithActiveSelection,
      ) =>
        await modelTransitionCoordinator!.submit(selection, {
          source,
          ...(source === 'prompt' && runWithActiveSelection
            ? { runWithActiveSelection }
            : {}),
        }),
      readActiveModelSelection: () => modelTransitionCoordinator!.readActiveTarget().selection,
      onProviderPromptDispatchPrepared: ({ localIds, selection }) => {
        const appliedModel = Object.freeze({
          provider: policyAgentId,
          selection,
        });
        for (const localId of localIds) {
          appliedModelByPendingLocalId.set(localId, appliedModel);
        }
      },
      deps: {
        ...(deps.sessionLoopLifecycleDeps ?? {}),
        daemonTurnContributionsBridge,
        cleanupBackendRunResourcesFn: deps.cleanupBackendRunResourcesFn ?? deps.sessionLoopLifecycleDeps?.cleanupBackendRunResourcesFn,
        createRuntimeOverrideSynchronizersFn: deps.createRuntimeOverrideSynchronizersFn ?? deps.sessionLoopLifecycleDeps?.createRuntimeOverrideSynchronizersFn,
        registerRunnerTerminationHandlersFn: deps.registerRunnerTerminationHandlersFn ?? deps.sessionLoopLifecycleDeps?.registerRunnerTerminationHandlersFn,
        sendReadyWithPushNotificationFn: deps.sendReadyWithPushNotificationFn ?? deps.sessionLoopLifecycleDeps?.sendReadyWithPushNotificationFn,
        archiveAndCloseRuntimeSessionFn: deps.archiveAndCloseRuntimeSessionFn ?? deps.sessionLoopLifecycleDeps?.archiveAndCloseRuntimeSessionFn,
        registerKillSessionHandlerFn: deps.registerKillSessionHandlerFn ?? deps.sessionLoopLifecycleDeps?.registerKillSessionHandlerFn,
        renderFn: deps.renderFn ?? deps.sessionLoopLifecycleDeps?.renderFn,
        startRemoteModeStaticControlFn: deps.startRemoteModeStaticControlFn ?? deps.sessionLoopLifecycleDeps?.startRemoteModeStaticControlFn,
        remoteOnlyTerminalDisplayComponent: deps.remoteOnlyTerminalDisplayComponent ?? deps.sessionLoopLifecycleDeps?.remoteOnlyTerminalDisplayComponent,
        onBeforeSessionClose: async (params) => {
          await runtimeModelsPublisher?.stopAndDrain();
          await deps.sessionLoopLifecycleDeps?.onBeforeSessionClose?.(params);
        },
        runPermissionModePromptLoopFn: async (loopParams) => await (deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop)({
          ...loopParams,
          inputConsumer,
          runtime: loopParams.runtime,
        }),
      },
      initialResumeId: (() => {
        const explicitResumeId = typeof runtimeOpts.resume === 'string' ? runtimeOpts.resume.trim() : '';
        if (explicitResumeId) return explicitResumeId;
        return config.resolveInitialResumeId?.({ opts: runtimeOpts, session, metadata: runtimeMetadata })?.trim() ?? '';
      })(),
    });
  } finally {
    await modelTransitionCoordinator.dispose();
    modelTransitionOwnerCurrent = false;
    modelTransitionCoordinator = null;
    hookRuntime.setOnPromptDeliveryOutcome?.(null);
    hookRuntime.setOnPromptAcceptedByProvider?.(null);
    hookRuntime.setOnPromptTerminallyRejectedBeforeProvider?.(null);
    hookRuntime.setOnPromptDeliveryBlockerCleared?.(null);
    currentLifecycleSession.setSessionRuntimeControls(null);
    config.onAfterStart = originalOnAfterStart;
    sessionStateMetadataObserver.dispose();
    disposeRuntimeModelsPublisher();
    stopAgentRuntimeActivitySubscription();
    unsubscribeExecutionRunActivity?.();
    runtimeActivityProjection?.dispose();
    unsubscribePendingQueueDeliveryTiming();
    unsubscribeRuntimePublication();
    if (!startupCoordinatorStart) {
      await startupBootstrapCleanup?.();
    }
  }
  } finally {
    disposeAgentSessionRealtimeVoiceRpc?.();
    providerBindingRuntimeDiagnosticRedaction.close();
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
): HostSessionRuntimeRunOptions & Readonly<{ launchControlMetadata: SessionLaunchControlMetadata }> {
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
    ...(opts.modelSelection ? { modelSelection: SessionModelSelectionV1Schema.parse(opts.modelSelection) } : {}),
    existingSessionId: opts.existingSessionId,
    ...(opts.sessionAttachFilePath ? { sessionAttachFilePath: opts.sessionAttachFilePath } : {}),
    resume: opts.resume,
    accountSettingsContext: opts.accountSettingsContext ?? null,
    ...(opts.environmentVariables ? { environmentVariables: { ...opts.environmentVariables } } : {}),
    ...(opts.unsetEnvironmentVariables
      ? { unsetEnvironmentVariables: normalizeUnsetEnvKeys(opts.unsetEnvironmentVariables) }
      : {}),
    ...(opts.resolveLateEnvironment
      ? { resolveLateEnvironment: opts.resolveLateEnvironment }
      : {}),
    launchControlMetadata: opts.launchControlMetadata ?? captureSessionLaunchControlMetadata({
      explicitEnvironment: opts.environmentVariables ?? null,
    }),
  };
}
