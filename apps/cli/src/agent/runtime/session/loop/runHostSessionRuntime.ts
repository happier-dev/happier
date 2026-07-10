import { randomUUID } from 'node:crypto';

import type {
  AccountSettings,
  BackendTargetRefV2Input,
  PendingDeliveryBlockedReason,
  SessionModelSelectionV1,
} from '@happier-dev/protocol';
import {
  buildBackendTargetKeyV2,
  convertBackendTargetRefV2ToV1,
  isPendingDeliveryBlockedReason,
  readBackendTargetRefV2,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { mergeUserMessageDeliveryWatermarkModeV1 } from '@/api/session/deliveredUserMessageSeq';
import type { ProviderAcceptancePendingMaterializationPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';
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
import type { DeferredStartupBootstrapResult } from '@/agent/runtime/startup/deferredStartupTypes';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import {
  runPermissionModePromptLoop,
  type PromptLoopBoundaryReason,
  type PromptLoopCheckpointLifecycle,
  type PromptLoopResetReason,
} from '@/agent/runtime/runPermissionModePromptLoop';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
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
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import {
  normalizePermissionModeQueuedPromptLocalIds,
  normalizePermissionModeQueuedPromptUserMessageSeqs,
  readHighestPermissionModeQueuedPromptUserMessageSeq,
} from '@/agent/runtime/permissions/queuedPrompt';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { observeCanonicalSessionStateMetadata } from '@/agent/runtime/state/observeCanonicalSessionStateMetadata';
import { runSessionLoopLifecycle, type SessionLoopLifecycleDeps } from '@/agent/runtime/session/loop/lifecycle';
import {
  applyInitialPromptTitleSeedToMetadata,
  resolveInitialPromptTitleSeed,
} from '@/agent/runtime/session/title/initialPromptTitleSeed';
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
import { resolveInitialHostSessionModelSelection } from '@/agent/runtime/session/loop/resolveInitialModelSelection';
import type { RuntimeTurnOperations, RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';
import type { SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import type { MetadataUpdatePort, SessionStateFacet, SessionStateSyncEngine } from '@happier-dev/agents';
import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents/session/controls/checkpoints';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';

export type HostSessionRuntimeHookRuntime = Readonly<{
  sendPromptWithMeta?: (params: {
    text: string;
    localId?: string | null;
    localIds?: readonly string[];
    providerClaimedPendingLocalIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }) => Promise<void>;
  /**
   * HF-1 provider-acceptance watermark seam (unified terminal): the host defers the session's
   * owed-delivery watermark and confirms accepted row seqs through this handler.
   */
  setOnPromptAcceptedByProvider?: (
    handler: (info: Readonly<{
      localInputId?: string | null;
      localInputIds?: readonly string[];
      localId?: string | null;
      localIds?: readonly string[];
      userMessageSeq?: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: PendingDeliveryBlockedReason;
    }>) => void,
  ) => void;
  /**
   * Deterministic pre-provider terminalization seam: prompts rejected before provider custody
   * for non-retryable input reasons are blocked through canonical pending delivery actions so
   * restart cannot rematerialize the same poison prompt without recording provider custody.
   */
  setOnPromptTerminallyRejectedBeforeProvider?: (
    handler: (info: Readonly<{
      localInputId?: string | null;
      localInputIds?: readonly string[];
      localId?: string | null;
      localIds?: readonly string[];
      userMessageSeq?: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: PendingDeliveryBlockedReason;
    }>) => void,
  ) => void;
  setOnPromptDeliveryBlockerCleared?: (
    handler: (info?: Readonly<{
      deliveryBlockedReason?: PendingDeliveryBlockedReason;
    }>) => void,
  ) => void;
  /**
   * HF-2 undeliverable-prompt handback: prompts still queued/unaccepted at runtime dispose are
   * handed back so the host re-pends them into the message queue instead of losing them.
   */
  setOnUndeliverablePrompts?: (
    handler: (prompts: ReadonlyArray<Readonly<{
      text: string;
      localInputId?: string | null;
      localInputIds?: readonly string[];
      localId?: string | null;
      localIds?: readonly string[];
      userMessageSeq?: number | null;
      userMessageSeqs?: readonly number[];
    }>>) => void,
  ) => void;
  shouldResumeAfterPermissionModeChange?: () => boolean;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
  steerPrompt?: (
    prompt: string,
    options?: Readonly<{
      localId?: string | null;
      localIds?: readonly string[];
      providerClaimedPendingLocalIds?: readonly string[];
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
  handleUserMessage?: SessionRuntimeControls['handleUserMessage'];
}> & RuntimeTurnOperations;

type HostRuntimePromptIdentity = Readonly<{
  text?: string;
  localInputId?: string | null;
  localInputIds?: readonly string[];
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
  deliveryBlockedReason?: PendingDeliveryBlockedReason;
}>;

type HostRuntimeUndeliverablePrompt = HostRuntimePromptIdentity & Readonly<{
  text: string;
}>;

function normalizeHostRuntimePromptLocalIds(identity: HostRuntimePromptIdentity): readonly string[] {
  const localIds = [
    ...(identity.localIds ?? []),
    ...(identity.localInputIds ?? []),
  ];
  return normalizePermissionModeQueuedPromptLocalIds({
    text: identity.text ?? '',
    localId: identity.localId ?? identity.localInputId ?? null,
    ...(localIds.length === 0 ? {} : { localIds }),
  });
}

function normalizeHostRuntimePromptSeqs(identity: HostRuntimePromptIdentity): readonly number[] {
  return normalizePermissionModeQueuedPromptUserMessageSeqs({
    text: identity.text ?? '',
    localId: null,
    ...(identity.userMessageSeq === undefined ? {} : { userMessageSeq: identity.userMessageSeq }),
    ...(identity.userMessageSeqs ? { userMessageSeqs: identity.userMessageSeqs } : {}),
  });
}

function readHostRuntimeConsumedPromptIdentity(
  identity: HostRuntimePromptIdentity,
): Parameters<ApiSessionClient['confirmUserMessageDeliveredToProvider']>[0] | null {
  const localIds = normalizeHostRuntimePromptLocalIds(identity);
  const userMessageSeqs = normalizeHostRuntimePromptSeqs(identity);
  const userMessageSeq = userMessageSeqs.length === 0
    ? null
    : readHighestPermissionModeQueuedPromptUserMessageSeq({
        text: identity.text ?? '',
        localId: null,
        userMessageSeqs,
      });
  if (localIds.length === 0 && userMessageSeq === null && userMessageSeqs.length === 0) {
    return null;
  }
  return {
    ...(localIds.length === 0 ? {} : { localIds }),
    userMessageSeq,
    ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
  };
}

function hostRuntimePromptIdentitiesOverlap(
  left: HostRuntimePromptIdentity,
  right: HostRuntimePromptIdentity,
): boolean {
  const leftLocalIds = normalizeHostRuntimePromptLocalIds(left);
  const rightLocalIds = normalizeHostRuntimePromptLocalIds(right);
  if (leftLocalIds.length > 0 && rightLocalIds.some((localId) => leftLocalIds.includes(localId))) {
    return true;
  }

  const leftSeqs = normalizeHostRuntimePromptSeqs(left);
  const rightSeqs = normalizeHostRuntimePromptSeqs(right);
  return leftSeqs.length > 0 && rightSeqs.some((seq) => leftSeqs.includes(seq));
}

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
  pendingQueueDeliveryTiming?: AccountSettings['sessionPendingQueueDeliveryTiming'];
  permissionHandler: ProviderEnforcedPermissionHandler;
  getPermissionMode: () => PermissionMode;
  setThinking: (value: boolean) => void;
  memoryRecallGuidanceEnabled: boolean;
  sessionState?: SessionStateSyncEngine;
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
  resume?: string;
  accountSettingsContext?: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext | null;
  environmentVariables?: Record<string, string>;
  unsetEnvironmentVariables?: readonly string[];
  launchControlMetadata?: SessionLaunchControlMetadata;
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
  userMessageDeliveryWatermarkMode?: 'queueHandoff' | 'providerAcceptance';
  providerAcceptancePendingMaterialization?: ProviderAcceptancePendingMaterializationPolicy;
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

  const usesProviderAcceptanceWatermark = config.userMessageDeliveryWatermarkMode === 'providerAcceptance';
  const sessionMetadataWatermarkMode = usesProviderAcceptanceWatermark ? 'providerAcceptance' : 'queueHandoff';
  const providerAcceptancePendingMaterialization =
    config.providerAcceptancePendingMaterialization ?? 'claimUntilProviderAccept';
  const initialPromptTitleSeed = resolveInitialPromptTitleSeed({
    environmentVariables: runtimeOpts.environmentVariables ?? null,
  });
  const augmentSessionMetadataWithDeliveryWatermarkMode = (metadata: Metadata): Metadata => {
    const augmented = config.augmentSessionMetadata ? config.augmentSessionMetadata(metadata) : metadata;
    return applyInitialPromptTitleSeedToMetadata(
      mergeUserMessageDeliveryWatermarkModeV1(augmented, sessionMetadataWatermarkMode).metadata,
      initialPromptTitleSeed,
    );
  };
  let watermarkDeferredToProviderAcceptance = false;
  const sessionsWithDeferredWatermark = new WeakSet<ApiSessionClient>();
  const deferDeliveredWatermarkToProviderAcceptance = (targetSession: ApiSessionClient): void => {
    watermarkDeferredToProviderAcceptance = true;
    if (sessionsWithDeferredWatermark.has(targetSession)) return;
    targetSession.deferDeliveredUserMessageWatermarkToProviderAcceptance({
      pendingMaterialization: providerAcceptancePendingMaterialization,
    });
    sessionsWithDeferredWatermark.add(targetSession);
  };
  const applySessionSwap = async (newSession: ApiSessionClient): Promise<void> => {
    session = newSession;
    if (watermarkDeferredToProviderAcceptance) {
      deferDeliveredWatermarkToProviderAcceptance(newSession);
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

  const startupBootstrap =
    config.startupBootstrap?.create && (config.startupBootstrap.shouldCreate?.({ opts: runtimeOpts }) ?? true)
      ? await config.startupBootstrap.create({ opts: runtimeOpts })
      : null;

  if (startupBootstrap) {
    api = startupBootstrap.api;
    machineId = startupBootstrap.machineId;
    metadata = startupBootstrap.metadata;
    session = startupBootstrap.session;
    if (usesProviderAcceptanceWatermark) {
      // Opt in as soon as the session exists, before daemon/UI first-turn commits can persist a
      // handoff watermark. The runtime seam is validated immediately after runtime creation.
      deferDeliveredWatermarkToProviderAcceptance(session);
    }
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
    const modelTargetKey = runtimeOpts.backendTarget
      ? buildBackendTargetKeyV2(readBackendTargetRefV2(runtimeOpts.backendTarget))
      : buildBackendTargetKeyV2({ kind: 'backend', backendId: policyAgentId, sourceKind: 'built_in' });
    const modelSelection = resolveInitialHostSessionModelSelection({
      agentTargetKey: modelTargetKey,
      runtimeSelection: runtimeOpts.modelSelection,
      lifecycleSelection: initialModelSelection ?? undefined,
    });
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
      modelSelectionIntent: modelSelection
        ? { v: 1, updatedAt: modelSelection.updatedAt, selection: modelSelection.ref }
        : undefined,
      augmentMetadata: augmentSessionMetadataWithDeliveryWatermarkMode,
      launchControlMetadata: runtimeOpts.launchControlMetadata,
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
      startupMetadataOverrides: createStartupMetadataOverrides({
        ...runtimeOpts,
        modelSelection,
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
    });

    session = initializedSession.session;
    if (usesProviderAcceptanceWatermark) {
      // Opt in as soon as the session exists, before daemon/UI first-turn commits can persist a
      // handoff watermark. The runtime seam is validated immediately after runtime creation.
      deferDeliveredWatermarkToProviderAcceptance(session);
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
  const currentLifecycleSession = createCurrentSessionClient(() => session, currentControlRpcRegistrar.registrar);
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

  const inFlightSteerController: InFlightSteerController = {
    supportsInFlightSteer: () => runtimeForInFlightSteer?.supportsInFlightSteer?.() === true,
    isTurnInFlight: () => runtimeForInFlightSteer?.isTurnInFlight?.() === true,
    canSteerPrompt: () => (
      runtimeForInFlightSteer?.canSteerPrompt?.()
      ?? runtimeForInFlightSteer?.isTurnInFlight?.()
      ?? false
    ) === true,
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
  const deferredUndeliverableProviderPromptReplayBatches: HostRuntimeUndeliverablePrompt[][] = [];
  let deferUndeliverableProviderPromptReplayDepth = 0;
  const handleUndeliverableProviderPromptReplays = (
    prompts: ReadonlyArray<HostRuntimeUndeliverablePrompt>,
  ): void => {
    for (let index = prompts.length - 1; index >= 0; index -= 1) {
      const prompt = prompts[index];
      const localIds = normalizeHostRuntimePromptLocalIds(prompt);
      const userMessageSeqs = normalizeHostRuntimePromptSeqs(prompt);
      const userMessageSeq = userMessageSeqs.length === 0
        ? null
        : readHighestPermissionModeQueuedPromptUserMessageSeq({
            text: prompt.text,
            localId: null,
            userMessageSeqs,
          });
      try {
        messageQueue.unshift(
          {
            text: prompt.text,
            localId: localIds[0] ?? null,
            ...(localIds.length === 0 ? {} : { localIds }),
            ...(userMessageSeq === null ? {} : { userMessageSeq }),
            ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
          },
          {
            permissionMode: permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
            suppressUserEcho: true,
            providerPromptAlreadyResolved: true,
          },
        );
      } catch {
        // The queue can already be closed during final teardown; the watermark stays behind
        // these seqs, so the server redelivers them on the next resume.
      }
    }
  };
  const flushDeferredUndeliverableProviderPromptReplays = (): void => {
    const batches = deferredUndeliverableProviderPromptReplayBatches.splice(
      0,
      deferredUndeliverableProviderPromptReplayBatches.length,
    );
    for (const batch of batches) {
      if (batch.length > 0) handleUndeliverableProviderPromptReplays(batch);
    }
  };
  const removeAcceptedDeferredUndeliverableProviderPromptReplays = (
    acceptance: HostRuntimePromptIdentity,
  ): void => {
    for (const batch of deferredUndeliverableProviderPromptReplayBatches) {
      for (let index = batch.length - 1; index >= 0; index -= 1) {
        const prompt = batch[index];
        if (hostRuntimePromptIdentitiesOverlap(prompt, acceptance)) {
          batch.splice(index, 1);
        }
      }
    }
  };
  const withDeferredUndeliverableProviderPromptReplay = async <T>(
    work: () => Promise<T>,
  ): Promise<T> => {
    deferUndeliverableProviderPromptReplayDepth += 1;
    try {
      return await work();
    } finally {
      deferUndeliverableProviderPromptReplayDepth -= 1;
      if (deferUndeliverableProviderPromptReplayDepth === 0) {
        flushDeferredUndeliverableProviderPromptReplays();
      }
    }
  };
  const createPromptLoopRuntimeWithDeferredUndeliverableProviderPromptReplay = (
    runtime: HostSessionRuntimeHookRuntime,
  ): HostSessionRuntimeHookRuntime => {
    const wrapped: HostSessionRuntimeHookRuntime = {
      ...runtime,
      sendTurnPrompt: async (prompt, meta) => await withDeferredUndeliverableProviderPromptReplay(
        async () => await runtime.sendTurnPrompt.call(runtime, prompt, meta),
      ),
      steerInFlightTurn: async (message, meta) => await withDeferredUndeliverableProviderPromptReplay(
        async () => await runtime.steerInFlightTurn.call(runtime, message, meta),
      ),
    };
    if (typeof runtime.sendPromptWithMeta !== 'function') return wrapped;
    return {
      ...wrapped,
      sendPromptWithMeta: async (prompt) => await withDeferredUndeliverableProviderPromptReplay(
        async () => await runtime.sendPromptWithMeta?.call(runtime, prompt),
      ),
    };
  };
  const runnerMcpAccountSettings = config.resolveRunnerMcpServersAccountSettings
    ? config.resolveRunnerMcpServersAccountSettings({
      opts: runtimeOpts,
      session,
      metadata: runtimeContext.sessionMetadataSnapshot ?? runtimeMetadata,
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
    session: currentLifecycleSession,
    transcriptSession,
    messageQueue,
    messageBuffer,
    mcpServers,
    accountSettings: runnerMcpAccountSettings,
    pendingQueueDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(runtimeOpts.accountSettingsContext?.settings ?? null),
    pendingQueueDeliveryTiming: resolveSessionPendingQueueDeliveryTiming(runtimeOpts.accountSettingsContext?.settings ?? null),
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
  const providerAcceptanceRuntime = (nativeRuntime ?? runtime) as HostSessionRuntimeHookRuntime;
  runtimeForInFlightSteer = providerAcceptanceRuntime;
  runtimeForSessionRollback = nativeRuntime;
  // HF-1 (A3-HIGH-1): provider-acceptance watermarking is an explicit plan contract. The host
  // stops queue-handoff persistence only for runtimes that expose positive provider custody;
  // resolved dispatch promises and rejection-only cleanup are not provider-custody evidence.
  const hasProviderAcceptanceSeam =
    typeof providerAcceptanceRuntime.setOnPromptAcceptedByProvider === 'function';
  if (usesProviderAcceptanceWatermark && !hasProviderAcceptanceSeam) {
    throw new Error(
      `${config.backendDisplayName} requested provider-acceptance delivery watermarking, but its runtime does not expose a provider-acceptance seam.`,
    );
  }
  if (usesProviderAcceptanceWatermark) {
    deferDeliveredWatermarkToProviderAcceptance(session);
  }
  if (usesProviderAcceptanceWatermark && typeof providerAcceptanceRuntime.setOnPromptAcceptedByProvider === 'function') {
    providerAcceptanceRuntime.setOnPromptAcceptedByProvider((acceptance) => {
      const normalizedAcceptance = readHostRuntimeConsumedPromptIdentity(acceptance);
      if (normalizedAcceptance) {
        removeAcceptedDeferredUndeliverableProviderPromptReplays(acceptance);
        session.confirmUserMessageDeliveredToProvider(normalizedAcceptance);
      }
    });
  }
  if (
    usesProviderAcceptanceWatermark
    && typeof providerAcceptanceRuntime.setOnPromptTerminallyRejectedBeforeProvider === 'function'
  ) {
    const retryableBlockedPendingReasons = [
      'terminal_composer_draft',
      'runtime_config_blocked',
      'provider_unavailable_before_acceptance',
    ] as const satisfies readonly PendingDeliveryBlockedReason[];
    const retryableBlockedPendingLocalIds = new Map<PendingDeliveryBlockedReason, Set<string>>();
    const pendingRetryableBlockWrites = new Map<PendingDeliveryBlockedReason, number>();
    const retryableClearObservedWhileEmpty = new Set<PendingDeliveryBlockedReason>();
    const isRetryableBlockedPendingReason = (reason: PendingDeliveryBlockedReason): boolean =>
      reason === 'terminal_composer_draft'
      || reason === 'runtime_config_blocked'
      || reason === 'provider_unavailable_before_acceptance';
    const retryableReasonsForClear = (
      reason?: PendingDeliveryBlockedReason,
    ): readonly PendingDeliveryBlockedReason[] => {
      if (!reason) return retryableBlockedPendingReasons;
      return isRetryableBlockedPendingReason(reason) ? [reason] : [];
    };
    const incrementRetryableBlockWrite = (reason: PendingDeliveryBlockedReason): void => {
      pendingRetryableBlockWrites.set(reason, (pendingRetryableBlockWrites.get(reason) ?? 0) + 1);
    };
    const decrementRetryableBlockWrite = (reason: PendingDeliveryBlockedReason): void => {
      const nextCount = Math.max(0, (pendingRetryableBlockWrites.get(reason) ?? 0) - 1);
      if (nextCount === 0) {
        pendingRetryableBlockWrites.delete(reason);
      } else {
        pendingRetryableBlockWrites.set(reason, nextCount);
      }
    };
    const rememberRetryableBlockedPendingLocalIds = (
      reason: PendingDeliveryBlockedReason,
      localIds: readonly string[],
    ): void => {
      if (!isRetryableBlockedPendingReason(reason)) return;
      let remembered = retryableBlockedPendingLocalIds.get(reason);
      if (!remembered) {
        remembered = new Set();
        retryableBlockedPendingLocalIds.set(reason, remembered);
      }
      for (const localId of localIds) remembered.add(localId);
    };
    const retryBlockedPendingLocalIdsOnce = (reason?: PendingDeliveryBlockedReason): void => {
      for (const blockedReason of retryableReasonsForClear(reason)) {
        const localIds = retryableBlockedPendingLocalIds.get(blockedReason);
        if (!localIds || localIds.size === 0) {
          if ((pendingRetryableBlockWrites.get(blockedReason) ?? 0) > 0) {
            retryableClearObservedWhileEmpty.add(blockedReason);
          }
          continue;
        }
        if ((pendingRetryableBlockWrites.get(blockedReason) ?? 0) === 0) {
          retryableClearObservedWhileEmpty.delete(blockedReason);
        }
        retryableBlockedPendingLocalIds.delete(blockedReason);
        for (const localId of localIds) {
          void session.retryPendingMessageDelivery?.({ localId });
        }
      }
    };
    providerAcceptanceRuntime.setOnPromptTerminallyRejectedBeforeProvider((acceptance) => {
      const normalizedAcceptance = readHostRuntimeConsumedPromptIdentity(acceptance);
      const localIds = normalizedAcceptance?.localIds ?? [];
      if (localIds.length > 0) {
        const reason = isPendingDeliveryBlockedReason(acceptance.deliveryBlockedReason)
          ? acceptance.deliveryBlockedReason
          : 'provider_rejected_before_acceptance';
        if (isRetryableBlockedPendingReason(reason)) incrementRetryableBlockWrite(reason);
        void session.blockPendingMessageDelivery({
          localIds,
          reason,
        }).then((blocked) => {
          if (!blocked) return;
          rememberRetryableBlockedPendingLocalIds(reason, localIds);
          if (retryableClearObservedWhileEmpty.has(reason)) {
            retryBlockedPendingLocalIdsOnce(reason);
          }
        }).finally(() => {
          if (!isRetryableBlockedPendingReason(reason)) return;
          decrementRetryableBlockWrite(reason);
          if (
            (pendingRetryableBlockWrites.get(reason) ?? 0) === 0
            && (retryableBlockedPendingLocalIds.get(reason)?.size ?? 0) === 0
          ) {
            retryableClearObservedWhileEmpty.delete(reason);
          }
        });
      }
    });
    providerAcceptanceRuntime.setOnPromptDeliveryBlockerCleared?.((info) => {
      retryBlockedPendingLocalIdsOnce(info?.deliveryBlockedReason);
    });
  }
  // HF-2 (F-1): prompts the disposed runtime could not deliver re-enter the local queue (FIFO via
  // reverse unshift, seq preserved) so a relaunch/reset delivers them instead of dropping them.
  if (nativeRuntime && typeof nativeRuntime.setOnUndeliverablePrompts === 'function') {
    nativeRuntime.setOnUndeliverablePrompts((prompts) => {
      if (deferUndeliverableProviderPromptReplayDepth > 0) {
        deferredUndeliverableProviderPromptReplayBatches.push(Array.from(prompts));
        return;
      }
      handleUndeliverableProviderPromptReplays(prompts);
    });
  }
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
      hookRuntime: providerAcceptanceRuntime,
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
        runPermissionModePromptLoopFn: async (loopParams) => await (deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop)({
          ...loopParams,
          runtime: createPromptLoopRuntimeWithDeferredUndeliverableProviderPromptReplay(loopParams.runtime),
        }),
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
    resume: opts.resume,
    accountSettingsContext: opts.accountSettingsContext ?? null,
    ...(opts.environmentVariables ? { environmentVariables: { ...opts.environmentVariables } } : {}),
    ...(opts.unsetEnvironmentVariables
      ? { unsetEnvironmentVariables: normalizeUnsetEnvKeys(opts.unsetEnvironmentVariables) }
      : {}),
    launchControlMetadata: opts.launchControlMetadata ?? captureSessionLaunchControlMetadata({
      explicitEnvironment: opts.environmentVariables ?? null,
    }),
  };
}
