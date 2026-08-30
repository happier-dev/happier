import { randomUUID } from 'node:crypto';

import type {
  AccountSettings,
  AgentProviderBindingLaunchMaterializationV1,
  BackendTargetRefV2Input,
  SessionModelSelectionV1,
  ProviderBoundModelRef,
  SessionModelTransitionRequestV1,
  SessionActiveModelSelectionV1,
  AgentSessionRuntimeEvent,
  SessionPendingMessageComposerAdmissionAcceptedRequestV1,
  SessionPendingMessageComposerAdmissionAbandonedRequestV1,
  SessionMetadataPublisherPreconditionV1,
} from '@happier-dev/protocol';
import type {
  AgentSessionHostServices,
  AgentSessionModelsSource,
  AgentSessionRuntime,
  AgentSessionRuntimeAuthControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  buildBackendTargetKeyV2,
  applySessionProviderBindingMetadataV1,
  convertBackendTargetRefV2ToV1,
  projectAgentSessionProviderBindingV1,
  readBackendTargetRefV2,
  SessionCreationCorrespondenceV1Schema,
  SessionCreationTagV1Schema,
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
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
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
import {
  extractComposerStagedMediaAdmissionSettlement,
  HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createPreparedDeferredStartupBootstrap } from '@/agent/runtime/startup/createPreparedDeferredStartupBootstrap';
import { adaptAgentSessionRuntimeAuthControl } from './runtimeAuthControlAdapter';
import type { DeferredStartupBootstrapResult } from '@/agent/runtime/startup/deferredStartupTypes';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import {
  runPermissionModePromptLoop,
  type PromptLoopBoundaryReason,
  type PromptLoopCheckpointLifecycle,
  type PromptLoopResetReason,
} from '@/agent/runtime/runPermissionModePromptLoop';
import type { AgentCompositionToolSelection } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
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
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
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
  readProviderSessionIdSessionState,
  resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import { applyProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  applyDisplayTitleSessionMetadata,
  createModelIntentMetadataCasCandidate,
} from '@happier-dev/agents/session/state/metadataWriters';
import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents/session/controls/checkpoints';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { buildScopedProcessEnv, normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import { isAgentSessionContinuationUnreachableError } from '@/session/shared/spawnSessionContract';
import {
  createLocalAgentNativeResumeRecordStore,
  hasMatchingAgentNativeReturnIdentity,
  invalidateFailedAgentNativeReturnIdentity,
  isAgentNativeResumeIdentityMismatchError,
} from '@/session/agentTransition/agentNativeReturn';
import {
  consumeProviderBindingLaunchHandoffFromEnvironments,
  type ProviderBindingLaunchHandoffV1,
} from '@/plugins/runtime/providerBindings/handoff';
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
import {
  createSessionModelTransitionAuthorizer,
  type SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { resolveNativeAgentModelApplyPolicy } from '@/providers/sessions/resolveNativeAgentModelApplyPolicy';
import { applyActiveModelFacts } from '@/providers/sessions/applyActiveModelFacts';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { notifyComposerAttachmentsAfterMessageAccepted } from '@/session/composer/notifyComposerAttachmentsAfterMessageAccepted';

type TransformSessionInputBeforeCommit = NonNullable<
  ApiSessionClientOptions['transformSessionInputBeforeCommit']
>;
type AfterComposerAttachmentMessageAccepted = NonNullable<
  ApiSessionClientOptions['afterComposerAttachmentMessageAccepted']
>;
type MachineAdmissionTransport = NonNullable<
  ApiSessionClientOptions['machineAdmissionTransport']
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
    const stagedMedia = extractComposerStagedMediaAdmissionSettlement(transformed);
    if (!stagedMedia.settlement) return { ...stagedMedia.transformed };
    if (!bridge.settleComposerStagedMedia) {
      throw new Error('Daemon staged-media settlement authority is unavailable');
    }

    let settledOutcome: 'accepted' | 'definitiveFailure' | null = null;
    const settle = async (outcome: 'accepted' | 'definitiveFailure'): Promise<void> => {
      if (settledOutcome !== null) return;
      await bridge.settleComposerStagedMedia!({
        sessionId: rawSessionId.trim(),
        outcome,
        settlement: stagedMedia.settlement!,
      });
      settledOutcome = outcome;
    };
    return {
      transformed: { ...stagedMedia.transformed },
      settlement: {
        onAccepted: async () => await settle('accepted'),
        onDefinitiveAdmissionFailure: async () => await settle('definitiveFailure'),
        stagedMediaHandles: stagedMedia.settlement.releaseIntents.map(({ handle }) => handle),
        createdWorkspaceRelativePaths: stagedMedia.settlement.createdWorkspaceRelativePaths,
        workingDirectory: stagedMedia.settlement.workingDirectory,
      },
    };
  };
}

function createScopedComposerAttachmentAcceptanceNotifier(
  bridge: SessionLoopLifecycleDeps['daemonTurnContributionsBridge'],
): AfterComposerAttachmentMessageAccepted | undefined {
  if (!bridge) return undefined;
  return async ({ attachment, event, signal }) => {
    await bridge.afterComposerAttachmentMessageAccepted({
      sessionId: event.sessionId,
      attachment,
      event,
      signal,
    });
  };
}

function createPendingMessageComposerAdmissionAcceptedControl(
  bridge: SessionLoopLifecycleDeps['daemonTurnContributionsBridge'],
  getSessionId: () => string,
): ((request: SessionPendingMessageComposerAdmissionAcceptedRequestV1) => Promise<void>) | undefined {
  if (!bridge) return undefined;
  return async (request) => {
    const sessionId = getSessionId();
    if (request.sessionId !== sessionId) {
      throw new Error('Pending Composer acceptance belongs to a different Session');
    }

    notifyComposerAttachmentsAfterMessageAccepted({
      sessionId,
      localId: request.localId,
      attachments: request.structuredInput.composerAttachments ?? [],
      notify: createScopedComposerAttachmentAcceptanceNotifier(bridge),
      signal: new AbortController().signal,
    });

    const stagedAttachments = (request.structuredInput.composerAttachments ?? []).filter(
      (attachment) => attachment.content?.kind === 'sessionMedia',
    );
    const releaseIntents = request.stagedMediaHandles.flatMap((handle, index) => {
      const attachment = stagedAttachments[index];
      return attachment
        ? [{
            handle,
            executionTarget: handle.executionTarget,
            owner: handle.owner,
            claimant: {
              composer: { kind: 'session' as const, sessionId },
              attachmentInstanceId: attachment.instanceId,
            },
          }]
        : [];
    });
    if (releaseIntents.length !== request.stagedMediaHandles.length) {
      throw new Error('Accepted pending Composer media settlement is missing its attachment custody');
    }
    if (releaseIntents.length > 0) {
      if (!bridge.settleComposerStagedMedia) {
        throw new Error('Daemon staged-media settlement authority is unavailable');
      }
      await bridge.settleComposerStagedMedia({
        sessionId,
        outcome: 'accepted',
        settlement: {
          v: 1,
          releaseIntents,
          createdWorkspaceRelativePaths: [],
          workingDirectory: 'accepted-pending-message',
        },
      });
    }

  };
}

function createPendingMessageComposerAdmissionAbandonedControl(
  bridge: SessionLoopLifecycleDeps['daemonTurnContributionsBridge'],
  getSessionId: () => string,
): ((request: SessionPendingMessageComposerAdmissionAbandonedRequestV1) => Promise<void>) | undefined {
  if (!bridge) return undefined;
  return async (request) => {
    const sessionId = getSessionId();
    if (request.sessionId !== sessionId) {
      throw new Error('Pending Composer abandonment belongs to a different Session');
    }
    const stagedAttachments = (request.structuredInput.composerAttachments ?? []).filter(
      (attachment) => attachment.content?.kind === 'sessionMedia',
    );
    const releaseIntents = request.stagedMediaHandles.flatMap((handle, index) => {
      const attachment = stagedAttachments[index];
      return attachment
        ? [{
            handle,
            executionTarget: handle.executionTarget,
            owner: handle.owner,
            claimant: {
              composer: { kind: 'session' as const, sessionId },
              attachmentInstanceId: attachment.instanceId,
            },
          }]
        : [];
    });
    if (releaseIntents.length !== request.stagedMediaHandles.length) {
      throw new Error('Abandoned pending Composer media settlement is missing its attachment custody');
    }
    if (!bridge.settleComposerStagedMedia) {
      throw new Error('Daemon staged-media settlement authority is unavailable');
    }
    await bridge.settleComposerStagedMedia({
      sessionId,
      outcome: 'definitiveFailure',
      settlement: {
        v: 1,
        releaseIntents,
        createdWorkspaceRelativePaths: [...request.sessionMediaCleanup.createdWorkspaceRelativePaths],
        workingDirectory: request.sessionMediaCleanup.workingDirectory,
      },
    });
  };
}

function createScopedMachineAdmissionTransport(
  bridge: SessionLoopLifecycleDeps['daemonTurnContributionsBridge'],
): MachineAdmissionTransport | undefined {
  const admitSessionInput = bridge?.admitSessionInput;
  if (!admitSessionInput) return undefined;
  return async (request, options) => await admitSessionInput({
    sessionId: request.sessionId,
    request,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export type HostRuntimeReplacementLifecycle = Readonly<{
  beforeReplacement(): Promise<void>;
  onSuccessorProviderBindingAdmitted?: (
    handoff: ProviderBindingLaunchHandoffV1,
  ) => Promise<void>;
  onSuccessorBound(): void | Promise<void>;
  onSuccessorUsable(): Promise<void>;
}>;

export type HostSessionRuntimeHookRuntime = Readonly<{
  setRuntimeReplacementLifecycle?: (lifecycle: HostRuntimeReplacementLifecycle) => void;
  connectedServiceApplicationSettled?: AgentSessionRuntime['connectedServiceApplicationSettled'];
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
  shouldResumeAfterPermissionModeChange?: () => boolean;
  supportsInFlightSteer?: () => boolean;
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
  canInterruptForPendingInput?: () => boolean;
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
  runtimeAuth?: AgentSessionRuntimeAuthControl;
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
  agentTargetKey: string;
  session: ApiSessionClient;
  transcriptSession: TranscriptSessionPort;
  messageQueue?: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  accountSettings?: AccountSettings | null;
  providerBindingMaterialization?: AgentProviderBindingLaunchMaterializationV1;
  /** True only for the exact matching local cross-agent native-return record. */
  strictNativeResumeIdentity?: boolean;
  pendingQueueDrainMaxPopPerWake?: number;
  pendingQueueDeliveryTiming?: AccountSettings['sessionPendingQueueDeliveryTiming'];
  permissionHandler: ProviderEnforcedPermissionHandler;
  getPermissionMode: () => PermissionMode;
  setThinking: (value: boolean) => void;
  memoryRecallGuidanceEnabled: boolean;
  sessionState?: SessionStateSyncEngine;
  recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
  runnerProcessIdentity: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null;
  startupModelSelection: ProviderBoundModelRef | null;
  runWithTerminalModelSelection: <T>(
    effect: (
      selection: ProviderBoundModelRef | null,
      runWithCurrentPublisherPermit: <U>(
        localEffect: () => Promise<U>,
      ) => Promise<
        | Readonly<{ status: 'completed'; value: U }>
        | Readonly<{ status: 'blocked' }>
      >,
    ) => Promise<T>,
  ) => Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked' }>
  >;
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
  session: Pick<ApiSessionClient, 'updateMetadataAsCurrentPublisher'>,
): MetadataUpdatePort {
  return {
    update: async (_sessionId, updater) => {
      try {
        await session.updateMetadataAsCurrentPublisher(
          (metadata) => updater(metadata) as typeof metadata,
        );
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
  credentials: import('@/persistence').StoredCredentials;
  /** Opaque host-derived tag for an admitted create-or-rejoin request. */
  sessionCreationTag?: import('@happier-dev/protocol').SessionCreationTagV1;
  /** Immutable correspondence admitted with sessionCreationTag. */
  sessionCreationCorrespondence?: import('@happier-dev/protocol').SessionCreationCorrespondenceV1;
  /** Mutable presentation state to write within a fresh canonical create envelope. */
  initialTitle?: string;
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
  providerRequirements?: unknown;
  publishHostRuntimeEvent?: (event: AgentSessionRuntimeEvent) => void;
  agentSessionRealtimeVoiceAuthority?: AgentSessionRealtimeVoiceAuthority;
  backendDisplayName: string;
  uiLogPrefix: string;
  providerName: string;
  waitingForCommandLabel: string;
  agentMessageType: ACPProvider;
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
  createSendReady?: (params: { session: ApiSessionClient; api: HostSessionRuntimeLoopApi }) => () => void | Promise<void>;
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
  /** Exact runtime-registry currentness for a mediated permission source. */
  isMediatorPluginCurrent?: (pluginId: string) => boolean;
  /** Exact runtime-registry currentness for a mediator contribution. */
  isMediatorContributionCurrent?: (mediator: Readonly<{
    pluginId: string;
    contributionLocalId: string;
  }>) => boolean;
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
  daemonModelTransitionAuthorizer?:
    SessionModelTransitionProviderTargetAuthorizer;
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
  registerKillSessionHandlerFn?: SessionLoopLifecycleDeps['registerKillSessionHandlerFn'];
  renderFn?: SessionLoopLifecycleDeps['renderFn'];
  startRemoteModeStaticControlFn?: SessionLoopLifecycleDeps['startRemoteModeStaticControlFn'];
  remoteOnlyTerminalDisplayComponent?: SessionLoopLifecycleDeps['remoteOnlyTerminalDisplayComponent'];
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  runSessionLoopLifecycleFn?: typeof runSessionLoopLifecycle;
  sessionLoopLifecycleDeps?: SessionLoopLifecycleDeps;
  admitPersistedTakeoverBeforeRuntimeFn?: (
    correlation: HostPrivatePersistedTakeoverAdmission & Readonly<{
      publisherPrecondition: SessionMetadataPublisherPreconditionV1;
    }>,
  ) => Promise<void>;
  reportPersistedTakeoverRuntimeBoundFn?: (
    correlation: HostPrivatePersistedTakeoverAdmission & Readonly<{
      publisherPrecondition: SessionMetadataPublisherPreconditionV1;
    }>,
  ) => Promise<void>;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
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

function assertProviderBindingHandoffMatchesSelection(input: Readonly<{
  selection: ProviderBoundModelRef;
  handoff: ProviderBindingLaunchHandoffV1;
}>): NonNullable<ProviderBindingLaunchHandoffV1['sessionBindingMetadata']['model']> {
  const connectionId = input.selection.providerConnectionId;
  const binding = input.handoff.sessionBindingMetadata;
  const model = binding.model;
  if (
    connectionId === null
    || binding.connectionId !== connectionId
    || model === undefined
  ) {
    throw new Error('Provider-bound model selection requires a validated provider binding handoff');
  }
  if (model.id !== input.selection.modelId) {
    throw new Error('Provider binding handoff model does not match the selected model');
  }
  if (input.handoff.materialization.kind !== binding.materialization) {
    throw new Error('Provider binding handoff materialization does not match its session metadata');
  }
  return model;
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
    deps.sessionLoopLifecycleDeps?.daemonTurnContributionsBridge;
  const transformSessionInputBeforeCommit = createScopedSessionInputTransformer(
    daemonTurnContributionsBridge,
  );
  const afterComposerAttachmentMessageAccepted =
    createScopedComposerAttachmentAcceptanceNotifier(
      daemonTurnContributionsBridge,
    );
  const machineAdmissionTransport = createScopedMachineAdmissionTransport(
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
  if (
    selectedProviderConnectionId !== null
    && selectedProviderConnectionId !== undefined
    && !hasLateEnvironmentAdmission
  ) {
    if (!providerBindingHandoff) {
      throw new Error('Provider-bound model selection requires a validated provider binding handoff');
    }
    assertProviderBindingHandoffMatchesSelection({
      selection: runtimeOpts.modelSelection!.ref,
      handoff: providerBindingHandoff,
    });
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
    ...(Object.prototype.hasOwnProperty.call(
      config,
      'providerRequirements',
    )
      ? { providerRequirements: config.providerRequirements }
      : {}),
    environment: buildScopedProcessEnv({
      baseEnv: process.env,
      explicitEnv: runtimeOpts.environmentVariables,
      unsetEnvKeys: runtimeOpts.unsetEnvironmentVariables,
    }),
  });
  let disposeAgentSessionRealtimeVoiceRpc: (() => void) | null = null;
  try {
  const sessionTag = runtimeOpts.sessionCreationTag
    ? SessionCreationTagV1Schema.parse(runtimeOpts.sessionCreationTag)
    : randomUUID();
  const sessionCreationCorrespondence = runtimeOpts.sessionCreationCorrespondence
    ? SessionCreationCorrespondenceV1Schema.parse(runtimeOpts.sessionCreationCorrespondence)
    : null;
  if (
    sessionCreationCorrespondence !== null
    && sessionCreationCorrespondence.sessionCreationTag !== sessionTag
  ) {
    throw new Error('Session creation correspondence does not match the admitted creation tag');
  }
  const selfProcessIdentity = await (
    deps.readProcessIdentityByPidFn ?? readProcessIdentityByPid
  )(process.pid);
  const runnerProcessIdentity =
    selfProcessIdentity === null
    || typeof selfProcessIdentity.processStartTimeMs !== 'number'
      ? null
      : {
          pid: selfProcessIdentity.pid,
          processStartTimeMs: selfProcessIdentity.processStartTimeMs,
        };
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
  let modelTransitionOwnerCurrent = true;
  let modelTransitionAdmissionFenced = false;
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
  let pendingSessionInitializedHook:
    | Readonly<{ attachedToExistingSession: boolean }>
    | null = null;
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
      subscribeAgentSessionRuntimeEvents: (handler) => producer.subscribeRuntimeEvents((message) => {
        if ('kind' in message) handler(message);
      }),
    });
    stopAgentRuntimeActivitySubscription();
    agentRuntimeActivityBinding = null;
    runtimeActivitySourceSessionId = null;
    if (!subscribeRuntimeActivity) return;

    const projection = runtimeActivityProjection;
    if (!projection) throw new Error('Runtime Activity producer binding requires an active projection');
    const subscriptionEpoch = ++runtimeActivitySubscriptionEpoch;
    let activatedBinding: ReturnType<HostRuntimeActivityProjection['bindAgentRuntime']> | null = null;
    const bufferedEvents: AgentSessionRuntimeEvent[] = [];
    const observeEvent = (event: AgentSessionRuntimeEvent): void => {
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
        afterComposerAttachmentMessageAccepted,
        machineAdmissionTransport,
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
          afterComposerAttachmentMessageAccepted,
          machineAdmissionTransport,
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
      augmentMetadata: (current) => {
        const augmented = augmentSessionMetadata?.(current) ?? current;
        const withInitialTitle = runtimeOpts.initialTitle
          ? applyDisplayTitleSessionMetadata(augmented, {
              title: runtimeOpts.initialTitle,
              staleBehavior: 'bump-if-value-changed',
            })
          : augmented;
        return sessionCreationCorrespondence
          ? { ...withInitialTitle, sessionCreationCorrespondenceV1: sessionCreationCorrespondence }
          : withInitialTitle;
      },
      launchControlMetadata: runtimeOpts.launchControlMetadata,
    });
    metadata = createdSessionMetadata.metadata;
    config.beforeInitializeSession?.({ metadata, opts: runtimeOpts });
    const requireDaemonAckOnAttach =
      typeof runtimeOpts.existingSessionId === 'string'
      && runtimeOpts.existingSessionId.trim().length > 0
      && String(
        process.env[
          HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY
        ] ?? '',
      ).trim().length > 0
      && String(
        process.env[
          HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY
        ] ?? '',
      ).trim().length > 0;

    const initializedSession = await initializeBackendRunSessionFn({
      api: runtimeSessionApi,
      sessionTag,
      ...(sessionCreationCorrespondence
        ? { organizationPlacement: sessionCreationCorrespondence.recipe.organization }
        : {}),
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
      ...(requireDaemonAckOnAttach
        ? { requireDaemonAckOnAttach: true }
        : {}),
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
    pendingSessionInitializedHook = {
      attachedToExistingSession: initializedSession.attachedToExistingSession,
    };
  }

  let claimedSessionForAuthorityPreparation: ApiSessionClient | null = null;
  let claimedSessionAuthorityPreparation:
    | Promise<StartupSessionPublisherAuthorityClaimResult>
    | null = null;
  let takeoverAdmissionPublisherPrecondition:
    | SessionMetadataPublisherPreconditionV1
    | null = null;
  let hostOwnsSessionConstructionCleanup = deferredStartupStart === null;
  let lifecycleOwnsConstructionResources = false;
  let unsubscribePendingQueueDeliveryTimingForConstructionCleanup:
    | (() => void)
    | null = null;
  let mcpServerForConstructionCleanup: { stop: () => void } | null = null;
  let sessionStateMetadataObserverForConstructionCleanup:
    | { dispose: () => void }
    | null = null;
  let constructedRuntimeForConstructionCleanup:
    | HostSessionRuntimeHookRuntime
    | null = null;
  let constructionFailureCleanupPromise: Promise<void> | null = null;
  const cleanupFailedConstruction = (
    continuationUnreachable: boolean,
  ): Promise<void> => {
    constructionFailureCleanupPromise ??= (async () => {
      const cleanupLabel = continuationUnreachable
        ? 'continuation verification failure'
        : 'runtime construction failure';
      const cleanupCodePrefix = continuationUnreachable
        ? 'continuation'
        : 'runtime_construction';
      const runCleanupStep = async (
        action: string,
        effect: () => void | Promise<void>,
      ): Promise<void> => {
        try {
          await effect();
        } catch {
          logger.debug(
            `${config.uiLogPrefix} Failed to ${action} after ${cleanupLabel} (non-fatal)`,
            {
              error: `${cleanupCodePrefix}_${action
                .toLowerCase()
                .replaceAll(/[^a-z0-9]+/g, '_')}_failed`,
            },
          );
        }
      };

      await runCleanupStep('deactivate durable delivery', () => {
        session.deactivateDurableMutationDelivery();
      });
      await runCleanupStep('dispose constructed runtime', async () => {
        await constructedRuntimeForConstructionCleanup?.resetOrDisposeRuntime();
        constructedRuntimeForConstructionCleanup = null;
      });
      await runCleanupStep('unsubscribe execution-run Activity', () => {
        unsubscribeExecutionRunActivity?.();
        unsubscribeExecutionRunActivity = null;
      });
      await runCleanupStep('dispose runtime Activity projection', () => {
        stopAgentRuntimeActivitySubscription();
        runtimeActivityProjection?.dispose();
        runtimeActivityProjection = null;
      });
      await runCleanupStep('unsubscribe pending delivery timing', () => {
        unsubscribePendingQueueDeliveryTimingForConstructionCleanup?.();
        unsubscribePendingQueueDeliveryTimingForConstructionCleanup = null;
      });
      await runCleanupStep('dispose session-state metadata observer', () => {
        sessionStateMetadataObserverForConstructionCleanup?.dispose();
        sessionStateMetadataObserverForConstructionCleanup = null;
      });
      await runCleanupStep('cancel reconnection', () => {
        reconnectionHandle?.cancel();
      });
      await runCleanupStep('stop MCP server', () => {
        mcpServerForConstructionCleanup?.stop();
        mcpServerForConstructionCleanup = null;
      });
      await runCleanupStep('clean up startup bootstrap', async () => {
        await startupBootstrapCleanup?.();
      });
      await runCleanupStep('close session', async () => {
        await session.close();
      });
    })();
    return constructionFailureCleanupPromise;
  };
  const establishClaimedSessionCustody = async (
    claimedSession: ApiSessionClient,
  ): Promise<StartupSessionPublisherAuthorityClaimResult> => {
    const publisherAuthority =
      await claimedSession.claimCurrentSessionPublisherAuthorityForStartup();
    await claimedSession.refreshSessionSnapshotFromServerRequired({
      reason: 'startup-drain',
    });

    if (persistedTakeoverAdmission) {
      takeoverAdmissionPublisherPrecondition =
        publisherAuthority.status === 'claimed'
          ? await claimedSession.readCurrentPublisherPreconditionForStartup()
          : null;
      if (!takeoverAdmissionPublisherPrecondition) {
        throw Object.assign(
          new Error('Takeover admission requires exact current publisher authority'),
          {
            code: 'takeover_admission_publisher_authority_unavailable' as const,
            retryable: false as const,
          },
        );
      }
      const admitPersistedTakeoverBeforeRuntime =
        deps.admitPersistedTakeoverBeforeRuntimeFn
        ?? ((correlation: HostPrivatePersistedTakeoverAdmission & Readonly<{
          publisherPrecondition: SessionMetadataPublisherPreconditionV1;
        }>) =>
          admitPersistedTakeoverBeforeRuntimeViaDaemon({
            sessionId: claimedSession.sessionId,
            metadata: runtimeContextMetadataFallback(metadata, claimedSession),
            correlation,
          }));
      await admitPersistedTakeoverBeforeRuntime({
        ...persistedTakeoverAdmission,
        publisherPrecondition: takeoverAdmissionPublisherPrecondition,
      });
    }

    if (
      pendingAttachedProviderBindingMetadataUpdate
      && providerBindingMetadataUpdate !== undefined
    ) {
      const binding = providerBindingMetadataUpdate;
      const updateBinding = (current: Metadata) =>
        applySessionProviderBindingMetadataV1(
          current,
          binding,
        ) as typeof current;
      if (publisherAuthority.status === 'claimed') {
        await claimedSession.updateMetadataAsCurrentPublisher(updateBinding);
      } else {
        await claimedSession.updateMetadata(updateBinding);
      }
      pendingAttachedProviderBindingMetadataUpdate = false;
    }

    if (publisherAuthority.status === 'unsupported') {
      modelTransitionOwnerCurrent = false;
    }
    if (!persistedTakeoverAdmission) {
      await claimedSession.activateDurableMutationDelivery();
    }
    return publisherAuthority;
  };

  try {
    if (deferredStartupStart) {
      await deferredStartupStart({
        prepareSession: async (claimedSession) => {
          claimedSessionForAuthorityPreparation = claimedSession;
          const preparation = establishClaimedSessionCustody(claimedSession);
          claimedSessionAuthorityPreparation = preparation;
          await preparation;
        },
      });
      deferredStartupStart = null;
      const attachedSession = claimedSessionForAuthorityPreparation;
      if (!attachedSession) {
        throw new Error(
          'Deferred Session startup completed without transferring real Session custody',
        );
      }
      session = attachedSession;
      hostOwnsSessionConstructionCleanup = true;
    } else {
      claimedSessionForAuthorityPreparation = session;
      const preparation = establishClaimedSessionCustody(session);
      claimedSessionAuthorityPreparation = preparation;
      await preparation;
    }
    if (pendingSessionInitializedHook) {
      await config.lifecycleHooks?.onSessionInitialized?.({
        session,
        opts: runtimeOpts,
        metadata: runtimeContextMetadataFallback(metadata, session),
        attachedToExistingSession:
          pendingSessionInitializedHook.attachedToExistingSession,
        machineId,
      });
      pendingSessionInitializedHook = null;
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
    | 'checkCurrentPublisherAuthority'
    | 'getMetadataSnapshot'
    | 'updateMetadataAsCurrentPublisher'
  > = currentLifecycleSession;
  const checkCurrentModelPublisherAuthority = async (): Promise<boolean> => {
    if (!modelTransitionOwnerCurrent) return false;
    const current = await modelTransitionMetadataSession
      .checkCurrentPublisherAuthority()
      .catch(() => false);
    if (!current) modelTransitionOwnerCurrent = false;
    return current;
  };
  const runWithCurrentModelPublisherPermit = async <T>(
    localEffect: () => Promise<T>,
  ): Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked' }>
  > => {
    if (!await checkCurrentModelPublisherAuthority()) {
      return { status: 'blocked' };
    }
    return {
      status: 'completed',
      // Consume the exact-current check with this immediate local invocation.
      value: await localEffect(),
    };
  };
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
    ...(config.isMediatorPluginCurrent
      ? { isMediatorPluginCurrent: config.isMediatorPluginCurrent }
      : {}),
    ...(config.isMediatorContributionCurrent
      ? { isMediatorContributionCurrent: config.isMediatorContributionCurrent }
      : {}),
  });
  permissionHandler.setPermissionMode(initialPermissionMode);

  const acceptedEffectByPendingLocalId = new Map<string, () => void>();
  const registerProviderAcceptedEffect = (
    localId: string,
    onAccepted: (() => void) | null,
  ): void => {
    if (onAccepted) acceptedEffectByPendingLocalId.set(localId, onAccepted);
    else acceptedEffectByPendingLocalId.delete(localId);
  };
  const observeAcceptedEffect = (localId: string): void => {
    const effect = acceptedEffectByPendingLocalId.get(localId);
    if (!effect) return;
    acceptedEffectByPendingLocalId.delete(localId);
    try {
      effect();
    } catch {
      // Provider acceptance is authoritative. A replay-metadata effect cannot invalidate it.
    }
  };
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
    observeAcceptedEffect,
    discardAcceptedEffect: (localId) => {
      acceptedEffectByPendingLocalId.delete(localId);
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
    registerProviderAcceptedEffect,
    steerText: async (text, options) => {
      const runtime = runtimeForInFlightSteer;
      if (!runtime?.steerPrompt) {
        throw new Error('in-flight steer is not available');
      }
      if (options === undefined) {
        await runtime.steerPrompt(text);
        return;
      }
      const promptMeta = options;
      const localId = typeof promptMeta.localId === 'string' && promptMeta.localId.length > 0
        ? promptMeta.localId
        : null;
      await runtime.steerPrompt(text, promptMeta);
      if (
        localId
        && typeof runtime.setOnPromptDeliveryOutcome !== 'function'
        && typeof runtime.setOnPromptAcceptedByProvider !== 'function'
      ) {
        observeAcceptedEffect(localId);
      }
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
      if (runtimeForInFlightSteer?.canInterruptForPendingInput?.() === false) {
        return { status: 'deferred_until_turn_end' };
      }
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
  let connectedServiceApplicationSettledHandler: ((request: Readonly<{
    serviceId: string;
    groupId: string;
  }>) => Promise<void>) | null = null;
  registerSessionProviderInputAdmissionRpc({
    consumer: inputConsumer,
    rpcHandlerRegistrar: currentControlRpcRegistrar.registrar,
    onApplicationSettled: async (request) => {
      await connectedServiceApplicationSettledHandler?.(request);
    },
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
  unsubscribePendingQueueDeliveryTimingForConstructionCleanup =
    unsubscribePendingQueueDeliveryTiming;
  const runnerMcpAccountSettings = config.resolveRunnerMcpServersAccountSettings
    ? config.resolveRunnerMcpServersAccountSettings({
      opts: runtimeOpts,
      session,
      metadata: runtimeSessionMetadataSnapshot ?? runtimeMetadata,
    })
    : runtimeOpts.accountSettingsContext?.settings ?? null;
  const supportsMcpServers = (config.supportsMcpServers ?? true) && resolveAgentToolsDelivery(policyAgentId) === 'native_mcp';
  let activeAgentCompositionToolSelection: AgentCompositionToolSelection | null = null;
  const runnerMcpSession = applyRunnerMcpSessionContext(currentLifecycleSession, {
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
    // The MCP server is constructed before the native runtime. This closure is
    // intentionally read at tool-call time: it is null before construction and
    // after the canonical active-turn witness is cleared.
    getActiveTurnCausalPermissionAuthority: () =>
      runtimeForInFlightSteer?.readActiveTurnCausalPermissionAuthority?.() ?? null,
    getBackendTarget: () => runtimeOpts.backendTarget ? readBackendTargetRefV2(runtimeOpts.backendTarget) : null,
    getCurrentSessionLocation: () => ({
      path: runtimeDirectory,
      host: config.machineMetadata.host,
      machineId,
    }),
    getActiveAgentCompositionToolSelection: () => activeAgentCompositionToolSelection,
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
  mcpServerForConstructionCleanup = happierMcpServer;
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
  sessionStateMetadataObserverForConstructionCleanup =
    sessionStateMetadataObserver;
  const initialResumeId = (() => {
    const explicitResumeId = typeof runtimeOpts.resume === 'string' ? runtimeOpts.resume.trim() : '';
    if (explicitResumeId) return explicitResumeId;
    return config.resolveInitialResumeId?.({ opts: runtimeOpts, session, metadata: runtimeMetadata })?.trim() ?? '';
  })();
  const nativeReturnRecordStore = initialResumeId
    ? createLocalAgentNativeResumeRecordStore()
    : null;
  const isTrackedNativeReturn = nativeReturnRecordStore !== null
    && await hasMatchingAgentNativeReturnIdentity({
      store: nativeReturnRecordStore,
      sessionId: currentLifecycleSession.sessionId,
      targetAgentId: policyAgentId,
      vendorResumeId: initialResumeId,
    });
  const strictInitialResumeMetadataKey = typeof config.providerSessionMetadataKey === 'string'
    && config.providerSessionMetadataKey.trim().length > 0
    ? config.providerSessionMetadataKey.trim()
    : null;
  const clearTrackedNativeReturnIdentity = async (): Promise<void> => {
    if (!isTrackedNativeReturn || !initialResumeId) return;
    await currentLifecycleSession.updateMetadataAsCurrentPublisher((metadata) => {
      const current = metadata as Record<string, unknown>;
      const currentProviderSessionId = strictInitialResumeMetadataKey
        ? (typeof current[strictInitialResumeMetadataKey] === 'string'
          ? current[strictInitialResumeMetadataKey].trim()
          : '')
        : readProviderSessionIdSessionState(metadata).value ?? '';
      if (currentProviderSessionId !== initialResumeId) return metadata;
      return applyProviderSessionIdSessionMetadata(current, {
        metadataKey: strictInitialResumeMetadataKey,
        value: null,
      }) as typeof metadata;
    });
  };
  const invalidateTrackedNativeReturnIdentity = async (resumeId: string): Promise<void> => {
    if (!nativeReturnRecordStore || !isTrackedNativeReturn) return;
    await invalidateFailedAgentNativeReturnIdentity({
      store: nativeReturnRecordStore,
      sessionId: currentLifecycleSession.sessionId,
      targetAgentId: policyAgentId,
      vendorResumeId: resumeId,
    });
    await clearTrackedNativeReturnIdentity();
  };
  const sessionRuntimeParams: HostSessionRuntimeFactoryParams = {
    directory: runtimeDirectory,
    metadata: runtimeMetadata,
    machineId,
    agentTargetKey: modelTargetKey,
    session: currentLifecycleSession,
    transcriptSession,
    messageQueue,
    messageBuffer,
    mcpServers,
    accountSettings: runnerMcpAccountSettings,
    ...(providerBindingMaterialization ? { providerBindingMaterialization } : {}),
    ...(isTrackedNativeReturn ? { strictNativeResumeIdentity: true } : {}),
    pendingQueueDrainMaxPopPerWake,
    pendingQueueDeliveryTiming,
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    setThinking: (value) => {
      runtimeState.thinking = value;
    },
    memoryRecallGuidanceEnabled,
    sessionState: sessionStateBridge.engine,
    runnerProcessIdentity,
    startupModelSelection: startupSeed.modelSelection?.ref ?? null,
    runWithTerminalModelSelection: async (effect) => {
      if (!modelTransitionCoordinator) {
        if (
          !modelTransitionOwnerCurrent
          || modelTransitionAdmissionFenced
        ) {
          return { status: 'blocked' };
        }
        return {
          status: 'completed',
          value: await effect(
            startupSeed.modelSelection?.ref ?? null,
            runWithCurrentModelPublisherPermit,
          ),
        };
      }
      if (
        !modelTransitionOwnerCurrent
        || modelTransitionAdmissionFenced
      ) {
        return { status: 'blocked' };
      }
      return await modelTransitionCoordinator.runWithStableActiveTarget(
        async (target, runWithCurrentPublisherPermit) =>
          await effect(target.selection, runWithCurrentPublisherPermit),
      );
    },
  };
  let createdRuntime: SharedHostSessionRuntimeFactoryResult<HostSessionRuntimeHookRuntime>;
  if (!config.createSessionRuntime) {
    throw new Error('Host session runtime config must define createSessionRuntime');
  }
  // Only a genuine same-machine native return removes its old projection while
  // the provider decides whether it can accept that exact id. Other resumes
  // retain their durable identity and log-path metadata unchanged.
  await clearTrackedNativeReturnIdentity();
  try {
    createdRuntime = await config.createSessionRuntime(sessionRuntimeParams);
  } catch (error) {
    if (isAgentNativeResumeIdentityMismatchError(error)) {
      await invalidateTrackedNativeReturnIdentity(initialResumeId);
    }
    throw error;
  }
  const {
    runtime,
    nativeRuntime,
    terminalRemoteModeLoop,
    admittedProviderBindingHandoff,
  } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
  const hookRuntime = (nativeRuntime ?? runtime) as HostSessionRuntimeHookRuntime;
  connectedServiceApplicationSettledHandler =
    typeof hookRuntime.connectedServiceApplicationSettled === 'function'
      ? hookRuntime.connectedServiceApplicationSettled.bind(hookRuntime)
      : null;
  constructedRuntimeForConstructionCleanup = hookRuntime;
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
  const activeProviderBindingHandoff =
    admittedProviderBindingHandoff ?? providerBindingHandoff;
  if (initialActiveSelection.providerConnectionId !== null) {
    if (!activeProviderBindingHandoff) {
      throw new Error('Provider-bound model selection requires a validated provider binding handoff');
    }
    assertProviderBindingHandoffMatchesSelection({
      selection: initialActiveSelection,
      handoff: activeProviderBindingHandoff,
    });
  } else if (activeProviderBindingHandoff) {
    throw new Error('Native model selection cannot include a provider binding handoff');
  }
  const initialActiveTargetBasis: AuthorizedSessionModelTransitionTarget = {
    selection: initialActiveSelection,
    policy: 'live',
    providerBinding: activeProviderBindingHandoff
      ? projectAgentSessionProviderBindingV1({
          metadata: activeProviderBindingHandoff.sessionBindingMetadata,
          materialization: activeProviderBindingHandoff.materialization,
        })
      : null,
    sessionBindingMetadata:
      activeProviderBindingHandoff?.sessionBindingMetadata ?? null,
    runtimeBindingBasis:
      activeProviderBindingHandoff?.sessionBindingMetadata.runtimeBindingBasis
      ?? null,
    // This basis exists only so the canonical authorizer can bind its current
    // authorization proof before the target is published or coordinator-owned.
    revalidateBeforeEffect: async () => false,
  };
  const createActiveSelectionFact = (
    target: AuthorizedSessionModelTransitionTarget,
    source: SessionActiveModelSelectionV1['source'],
  ): SessionActiveModelSelectionV1 | null =>
    runnerProcessIdentity
      ? {
          v: 1,
          selection: target.selection,
          source,
          runner: runnerProcessIdentity,
        }
      : null;
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
    deps.daemonModelTransitionAuthorizer;
  // An Agent that contributes no bundled model config keeps the live policy.
  const policyAgentModelConfig = getAgentModelConfig(policyAgentId);
  const authorizeModelTransition = createSessionModelTransitionAuthorizer({
    sessionId: session.sessionId,
    machineId,
    agentId: policyAgentId,
    agentTargetKey: modelTargetKey,
    nativeModelApplyPolicy: policyAgentModelConfig
      ? resolveNativeAgentModelApplyPolicy(policyAgentModelConfig)
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
  let latestExactActiveSelectionFact =
    startupSeed.modelSelection
    && startupSeed.modelSelection.ref.agentTargetKey
      === initialActiveTarget.selection.agentTargetKey
    && startupSeed.modelSelection.ref.providerConnectionId
      === initialActiveTarget.selection.providerConnectionId
    && startupSeed.modelSelection.ref.modelId
      === initialActiveTarget.selection.modelId
      ? createActiveSelectionFact(
          initialActiveTarget,
          'runtime_apply',
        )
      : null;
  modelTransitionCoordinator = createSessionModelTransitionCoordinator({
    runId: sessionTag,
    agentTargetKey: modelTargetKey,
    initialActiveTarget,
    isCurrentRun: () => modelTransitionOwnerCurrent,
    checkCurrentPublisherAuthority:
      checkCurrentModelPublisherAuthority,
    authorize: authorizeModelTransition,
    publishIntent: async (selection) => {
      const candidate = createModelIntentMetadataCasCandidate({
        selection,
        nowMs: () => Math.max(Date.now(), lastAcceptedModelIntentUpdatedAt + 1),
      });
      await modelTransitionMetadataSession
        .updateMetadataAsCurrentPublisher(candidate.update);
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
      const activeSelectionV1 = createActiveSelectionFact(
        target,
        'runtime_apply',
      );
      const publishActive = async (): Promise<void> => {
        await modelTransitionMetadataSession
          .updateMetadataAsCurrentPublisher((current) =>
            applyActiveModelFacts(
              current,
              target,
              policyAgentId,
              activeSelectionV1,
            ));
      };
      try {
        if (runtimeModelsPublisher && activeSelectionV1) {
          await runtimeModelsPublisher.publishActiveSelection({
            selection: target.selection,
            activeSelectionV1,
            publishActive,
          });
        } else {
          await publishActive();
          if (!deferRuntimeModelsFlushDuringAuthorityPreparation) {
            await runtimeModelsPublisher?.flush();
          }
        }
        latestExactActiveSelectionFact = activeSelectionV1;
      } catch (error) {
        if (
          typeof (error as { code?: unknown } | null)?.code === 'string'
          && (error as { code: string }).code
            === 'session_publisher_authority_lost'
        ) {
          modelTransitionOwnerCurrent = false;
        }
        throw error;
      }
      adoptedModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: lastAcceptedModelIntentUpdatedAt || Date.now(),
        ref: target.selection,
      });
      publishRuntimeOverrides();
    },
    revokeActiveSelectionProof: async (selection) => {
      if (
        latestExactActiveSelectionFact
        && latestExactActiveSelectionFact.selection.agentTargetKey
          === selection.agentTargetKey
        && latestExactActiveSelectionFact.selection.providerConnectionId
          === selection.providerConnectionId
        && latestExactActiveSelectionFact.selection.modelId
          === selection.modelId
      ) {
        latestExactActiveSelectionFact = null;
      }
      if (runtimeModelsPublisher) {
        await runtimeModelsPublisher.releaseActiveSelectionAuthority({
          selection,
        });
        return;
      }
      const activeTarget =
        modelTransitionCoordinator?.readActiveTarget()
        ?? initialActiveTarget;
      if (
        activeTarget.selection.agentTargetKey !== selection.agentTargetKey
        || activeTarget.selection.providerConnectionId
          !== selection.providerConnectionId
        || activeTarget.selection.modelId !== selection.modelId
      ) {
        return;
      }
      await modelTransitionMetadataSession
        .updateMetadataAsCurrentPublisher((current) =>
          applyActiveModelFacts(
            current,
            activeTarget,
            policyAgentId,
            null,
          ));
    },
    fencePromptAdmission: async (epochId) => {
      modelTransitionAdmissionFenced = true;
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
      modelTransitionAdmissionFenced = false;
    },
    transferPromptAdmission: async (epochId, dispatchOpts) => {
      const result = await inputConsumer.runProviderInputDispatchFromAdmission({
        admission: {
          kind: 'action_required',
          reason: 'generation_pending',
          serviceId: 'host-runtime',
          groupId: 'model-transition',
          epochId,
        },
        ...dispatchOpts,
      });
      modelTransitionAdmissionFenced = false;
      return result;
    },
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
        throw Object.assign(
          new Error(
            'Session model transition refused because this server does not support exact publisher-authority checks',
          ),
          {
            code: authority.reason,
            retryable: false,
          },
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

  const completeClaimedSessionAuthorityPreparation = async (
    claimedSession: ApiSessionClient,
    publisherAuthority: StartupSessionPublisherAuthorityClaimResult,
  ): Promise<StartupSessionPublisherAuthorityClaimResult> => {
    const previousMetadataSession = modelTransitionMetadataSession;
    modelTransitionMetadataSession = claimedSession;
    try {
      if (publisherAuthority.status === 'unsupported') {
        return publisherAuthority;
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
      await claimedSession.updateMetadataAsCurrentPublisher((current) =>
        applyActiveModelFacts(
          current,
          activeTarget,
          policyAgentId,
          latestExactActiveSelectionFact?.selection.agentTargetKey
            === activeTarget.selection.agentTargetKey
          && latestExactActiveSelectionFact.selection.providerConnectionId
            === activeTarget.selection.providerConnectionId
          && latestExactActiveSelectionFact.selection.modelId
            === activeTarget.selection.modelId
            ? latestExactActiveSelectionFact
            : null,
        ));
      if (!runtimeModelsPublisher && hookRuntime.models) {
        runtimeModelsPublisher = createSessionRuntimeModelsPublisher({
          agentId: config.policyAgentId,
          agentTargetKey: modelTargetKey,
          runnerProcessIdentity,
          initialActiveSelection: latestExactActiveSelectionFact,
          session: currentLifecycleSession,
          source: hookRuntime.models,
        });
      }
      await runtimeModelsPublisher?.flush();
      return publisherAuthority;
    } finally {
      modelTransitionMetadataSession = previousMetadataSession;
    }
  };

  const claimedSession = claimedSessionForAuthorityPreparation;
  const preparation = claimedSessionAuthorityPreparation;
  if (!claimedSession || !preparation) {
    throw new Error('Session runtime startup requires established Session custody');
  }
  await completeClaimedSessionAuthorityPreparation(
    claimedSession,
    await preparation,
  );
  if (commitPendingFirstInputAfterRuntimeReady) {
    startupCoordinatorStart = async () => {
      const commit = commitPendingFirstInputAfterRuntimeReady;
      commitPendingFirstInputAfterRuntimeReady = null;
      await commit?.();
    };
  }

  await runtimeActivityProjection.reofferCurrentSnapshot();
  let runtimeReplacementEpoch = 0;
  let activeRuntimeReplacementEpoch: string | null = null;
  const admitSuccessorProviderBindingHandoff = async (
    handoff: ProviderBindingLaunchHandoffV1,
  ): Promise<void> => {
    const coordinator = modelTransitionCoordinator;
    if (!coordinator) {
      throw new Error('Runtime replacement requires an active model transition coordinator');
    }
    const activeTarget = coordinator.readActiveTarget();
    assertProviderBindingHandoffMatchesSelection({
      selection: activeTarget.selection,
      handoff,
    });
    const admittedTarget = authorizeModelTransition.bindCurrentAuthorizationProof({
      selection: activeTarget.selection,
      policy: activeTarget.policy,
      providerBinding: projectAgentSessionProviderBindingV1({
        metadata: handoff.sessionBindingMetadata,
        materialization: handoff.materialization,
      }),
      sessionBindingMetadata: handoff.sessionBindingMetadata,
      runtimeBindingBasis:
        handoff.sessionBindingMetadata.runtimeBindingBasis ?? null,
      revalidateBeforeEffect: async () => false,
    });
    await coordinator.admitReplacementTarget(admittedTarget);
  };
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
    onSuccessorProviderBindingAdmitted:
      admitSuccessorProviderBindingHandoff,
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
    const acceptPendingMessageComposerAdmission =
      createPendingMessageComposerAdmissionAcceptedControl(
        daemonTurnContributionsBridge,
        () => currentLifecycleSession.sessionId,
      );
    const abandonPendingMessageComposerAdmission =
      createPendingMessageComposerAdmissionAbandonedControl(
        daemonTurnContributionsBridge,
        () => currentLifecycleSession.sessionId,
      );
    const voiceAuthority = config.agentSessionRealtimeVoiceAuthority;
    if (voiceAuthority) {
      disposeAgentSessionRealtimeVoiceRpc =
        registerAgentSessionRealtimeVoiceRpc({
          rpc: currentControlRpcRegistrar.registrar,
          runtime: nativeRuntime,
          getHappierSessionId: () => session.sessionId,
          ownerId: sessionTag,
          agentGeneration: voiceAuthority.generation,
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
      ...(nativeRuntime.runtimeAuth
        ? adaptAgentSessionRuntimeAuthControl(nativeRuntime.runtimeAuth)
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
      ...(acceptPendingMessageComposerAdmission ? { acceptPendingMessageComposerAdmission } : {}),
      ...(abandonPendingMessageComposerAdmission ? { abandonPendingMessageComposerAdmission } : {}),
    });
    await config.lifecycleHooks?.onRuntimeCreated?.({ session, runtime: nativeRuntime });
  }
  if (persistedTakeoverAdmission) {
    const publisherPrecondition = takeoverAdmissionPublisherPrecondition;
    if (!publisherPrecondition) {
      throw new Error('Takeover admission publisher authority was not established');
    }
    const reportPersistedTakeoverRuntimeBound =
      deps.reportPersistedTakeoverRuntimeBoundFn
      ?? ((correlation: HostPrivatePersistedTakeoverAdmission & Readonly<{
        publisherPrecondition: SessionMetadataPublisherPreconditionV1;
      }>) =>
        reportPersistedTakeoverRuntimeBoundViaDaemon({
          sessionId: currentLifecycleSession.sessionId,
          metadata: runtimeMetadata,
          correlation,
        }));
    await reportPersistedTakeoverRuntimeBound({
      ...persistedTakeoverAdmission,
      publisherPrecondition,
    });
    await session.activateDurableMutationDelivery();
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

  lifecycleOwnsConstructionResources = true;
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
      setActiveAgentCompositionToolSelection: (selection) => {
        activeAgentCompositionToolSelection = selection;
      },
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
          ...(
            typeof hookRuntime.setOnPromptDeliveryOutcome === 'function'
            || typeof hookRuntime.setOnPromptAcceptedByProvider === 'function'
              ? { registerProviderAcceptedEffect }
              : {}
          ),
        }),
      },
      initialResumeId,
      onStrictInitialResumeFailure: async ({ resumeId }) => {
        await invalidateTrackedNativeReturnIdentity(resumeId);
      },
    });
  } finally {
    await modelTransitionCoordinator.dispose();
    modelTransitionOwnerCurrent = false;
    modelTransitionCoordinator = null;
    hookRuntime.setOnPromptDeliveryOutcome?.(null);
    hookRuntime.setOnPromptAcceptedByProvider?.(null);
    hookRuntime.setOnPromptTerminallyRejectedBeforeProvider?.(null);
    hookRuntime.setOnPromptDeliveryBlockerCleared?.(null);
    acceptedEffectByPendingLocalId.clear();
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
  } catch (error) {
    if (!lifecycleOwnsConstructionResources) {
      if (hostOwnsSessionConstructionCleanup) {
        await cleanupFailedConstruction(
          isAgentSessionContinuationUnreachableError(error),
        );
      } else {
        try {
          await startupBootstrapCleanup?.();
        } catch {
          logger.debug(
            `${config.uiLogPrefix} Failed to clean up startup bootstrap after deferred startup failure (non-fatal)`,
            { error: 'deferred_startup_bootstrap_cleanup_failed' },
          );
        }
      }
    }
    throw error;
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
    ...(opts.sessionCreationTag
      ? { sessionCreationTag: SessionCreationTagV1Schema.parse(opts.sessionCreationTag) }
      : {}),
    ...(opts.sessionCreationCorrespondence
      ? { sessionCreationCorrespondence: SessionCreationCorrespondenceV1Schema.parse(opts.sessionCreationCorrespondence) }
      : {}),
    ...(typeof opts.initialTitle === 'string' && opts.initialTitle.trim().length > 0
      ? { initialTitle: opts.initialTitle.trim() }
      : {}),
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
