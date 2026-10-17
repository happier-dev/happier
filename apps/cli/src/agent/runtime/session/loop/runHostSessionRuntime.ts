import { randomUUID } from 'node:crypto';
import { createRepositoryCheckpointCodeRollback } from '@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { createInvocationSavedSecretOperationContextV1, refreshSavedSecretCatalogForOperation, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { formatProcessOwnerTag, PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { joinCurrentWindowsSessionProcessCustody } from '@/subprocess/supervision/processCustody';
import { buildToolIdleTimeoutEnvironmentOverlay } from '@/processes/toolIdleTimeouts';
import { readMachineResourcesPolicySnapshot } from '@/api/machine/machineResourcesPolicy';

import type {
  AccountSettings,
  AgentExecutionTargetV1,
  AgentProviderBindingLaunchMaterializationV1,
  BackendTargetRefV2,
  BackendTargetRefV2Input,
  SessionModelSelectionV1,
  ProviderBoundModelRef,
  SessionModelTransitionRequestV1,
  SessionActiveModelSelectionV1,
  AgentSessionRuntimeEvent,
  SessionPendingMessageComposerAdmissionAcceptedRequestV1,
  SessionPendingMessageComposerAdmissionAbandonedRequestV1,
  SessionMetadataPublisherPreconditionV1,
  SessionContextUsageSnapshotV1,
  WorkerUpdateV1,
  TranscriptRawAgentEventV1,
} from '@happier-dev/protocol';
import type {
  AgentSessionHostServices,
  AgentSessionModelsSource,
  AgentSessionModesSource,
  AgentSessionRuntime,
  AgentSessionRuntimeAuthControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { BackendTargetRefV2InputSchema, convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { applySessionProviderBindingMetadataV1, projectAgentSessionProviderBindingV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { SESSION_FOLLOW_WAKE_EVENT_MESSAGE } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionModelTransitionRequestV1Schema, SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { renderWorkerUpdatePromptBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { SessionModelMutationScopeV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { WORKFLOW_STEP_INPUT_EVENT_MESSAGE, isSessionContextOnlyHostInput } from '@/session/shared/sessionTurnLifecycle';
import { createWorkflowOriginContextInputPort } from '@/agent/runtime/session/contextOnly/workflowOriginInput';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { readAppliedParentConnectedServices } from '@/daemon/controlClient';
import type { ExecutionRunAppliedParentSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { filterSuppressedConnectedServiceBindings } from '@/providers/spawn/authorize';
import { resolveAutomationWorkerAccountEncryption } from '@/daemon/automation/automationWorker';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '@/api/session/transcriptMessageLookup';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { clearInitialGoalFromEnv, readInitialGoalFromEnv } from '@/daemon/spawn/initialGoal';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiClient } from '@/api/api';
import type { RpcHandlerManagerLike } from '@/api/rpc/types';
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
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';
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
import type { RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import {
  runPermissionModePromptLoop,
  projectSessionComposerAttachmentDispatchInput,
  type PromptLoopBoundaryReason,
  type PromptLoopCheckpointLifecycle,
  type PromptLoopResetReason,
} from '@/agent/runtime/runPermissionModePromptLoop';
import type { AgentCompositionToolSelection } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  readAccountRoleOverridesFromSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { projectMcpToolLaunchPolicies } from '@/mcp/runtime/projectMcpToolLaunchPolicy';
import type { McpServerIdentity } from '@/mcp/runtime/assignMcpWireNames';
import type { McpToolPolicyContext } from '@/mcp/runtime/resolveMcpToolIdentity';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { resolveRunnerSkills, type RunnerSkillsResult } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { readAppliedSessionSkillDelivery } from '@/prompts/skills/runtime/reapplySessionSkills';
import { resolveCapabilityApplyAgentFacts } from '@/session/runtime/capabilityApplyFacts';
import { publishRunnerSkillNotice } from '@/prompts/skills/runtime/publishRunnerSkillNotice';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createWorkspaceWritesPolicyPreparation } from '@/session/roles/workspaceWritesPolicyPreparation';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createSessionPromptPlanResolver, type SessionPromptPlanResolver } from '@/agent/prompting/coding/sessionPromptPlan';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { registerHappierSessionAgentToolRpc } from '@/mcp/startHappyServer';
import { DaemonPluginToolCatalogUnavailableError } from '@/mcp/pluginToolCatalogError';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { classifyPrimarySessionRuntimeIssue, readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
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
import { createModelIntentV2MetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
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
import {
  publishSessionFollowWakeInvalidation,
  readSessionFollowWakeInvalidationGeneration,
  waitForSessionFollowWakeInvalidation,
} from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import type { SessionProviderInputConsumer } from '@/agent/runtime/session/input/_types';
import {
  bindSessionProviderInputOutcome,
  createSessionProviderInputOutcomeNormalizer,
  type SessionProviderInputOutcomePort,
} from '@/agent/runtime/session/input/providerInputOutcome';
import { registerSessionProviderInputAdmissionRpc } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { clearSessionGuardStateOnRunnerStart, type SessionGuardNoticeOwner } from '@/agent/runtime/session/input/sessionGuardNoticeRpc';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { notifyDaemonSessionActivityChanged } from '@/daemon/controlClient';
import { createSessionProviderInputConsumerSessionAdapter } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { commitRuntimeSessionEvent } from '@/agent/runtime/session/transcripts/publishRuntimeSessionEvent';
import { resolveInitialHostSessionModelSelection } from '@/agent/runtime/session/loop/resolveInitialModelSelection';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { createSessionRuntimeModesPublisher } from '@/agent/runtime/controls/sessionRuntimeModesPublisher';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { HostCurrentSessionPresentationService } from '@/agent/runtime/state/currentSessionUiTypes';
import { createCurrentSessionPresentationHost, type CurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import {
  createInitialHostRuntimeActivityMutation,
  createHostRuntimeActivityProjection,
  type HostRuntimeActivityProjection,
  type HostRuntimeActivitySnapshot,
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
  type SessionAppliedModelTransitionUnavailableReason,
} from '@/providers/sessions/sessionModelTransitionCoordinator';
import {
  createSessionModelTransitionAuthorizer,
  type SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { resolveNativeAgentModelApplyPolicy } from '@/providers/sessions/resolveNativeAgentModelApplyPolicy';
import { applyActiveModelFacts } from '@/providers/sessions/applyActiveModelFacts';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { notifyComposerAttachmentsAfterMessageAccepted } from '@/session/composer/notifyComposerAttachmentsAfterMessageAccepted';
import {
  fitWorkerUpdateWithinHostContextAllowance,
  type HostContextOnlyInputPort,
  type HostPreparedContext,
} from '@/agent/runtime/session/contextOnly/hostContextOnlyInput';
import { createWorkflowStepWithdrawal } from '@/agent/runtime/session/contextOnly/workflowStepWithdrawal';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import {
  createSessionFollowSourceHydrator,
} from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import type { SessionFollowSourceMaterialController } from '@/agent/runtime/session/follow/sessionFollowSourceMaterialResolver';
import { measureSessionFollowUtf8Bytes, resolveSessionFollowContextUtf8AllowanceV1 } from '@/agent/runtime/session/follow/sessionFollowContextBudget';

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

export type HostSessionRuntimeHookRuntime = SessionProviderInputOutcomePort & Readonly<{
  readAppliedTeamCredentialModel?: () => import('@happier-dev/protocol').TeamCredentialProviderModelSelectionV1 | null | undefined;
  openedWithoutConnectedServices?: () => boolean;
  prepareRunTeamCredentialProviderBinding?: SessionRuntimeControls['prepareRunTeamCredentialProviderBinding'];
  managedProviderRunServices?: SessionRuntimeControls['managedProviderRunServices'];
  setRuntimeReplacementLifecycle?: (lifecycle: HostRuntimeReplacementLifecycle) => void;
  connectedServiceApplicationSettled?: AgentSessionRuntime['connectedServiceApplicationSettled'];
  models?: AgentSessionModelsSource;
  modes?: AgentSessionModesSource;
  shouldResumeAfterPermissionModeChange?: () => boolean;
  supportsInFlightSteer?: () => boolean;
  isProviderNativeCommand?: InFlightSteerController['isProviderNativeCommand'];
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
  canInterruptForPendingInput?: () => boolean;
  steerPrompt?: (
    prompt: string,
    options?: RuntimeTurnPromptMeta,
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
  refreshSkills?: AgentSessionRuntime['refreshSkills'];
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
  readActiveTurnInputId?: SessionRuntimeControls['readActiveTurnInputId'];
  handleUserMessage?: SessionRuntimeControls['handleUserMessage'];
}> & RuntimeTurnOperations;

export type HostSessionRuntimeFactoryParams = Readonly<{
  directory: string;
  metadata: Metadata;
  /** Verified invocation placement, never reconstructed from persisted Session metadata. */
  currentTerminalMetadata?: Readonly<Pick<Metadata, 'terminal' | 'startedBy'>>;
  machineId: string;
  agentTargetKey: string;
  session: ApiSessionClient;
  transcriptSession: TranscriptSessionPort;
  /** The logical Session's presentation survives native runtime replacement. */
  currentSessionPresentation: () => HostCurrentSessionPresentationService;
  messageQueue?: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  resolveMcpToolNaming?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionMcpService['resolveToolNaming'];
  mcpServersStrictMode?: boolean;
  mcpToolPolicy?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionOpenRequest['mcpToolPolicy'];
  mcpServerIdentities?: Readonly<Record<string, McpServerIdentity>>;
  resolvedMcpServers?: readonly import('@/mcp/runtimeTypes').ResolvedSessionMcpServer[];
  getMcpToolContext?: () => McpToolPolicyContext | null;
  resolveMcpToolPolicy?: (permissionMode: string) => import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionOpenRequest['mcpToolPolicy'];
  skills?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionOpenRequest['skills'];
  accountSettings?: AccountSettings | null;
  resolveAccountSettingsSnapshot?: (input?: Readonly<{ mcpServerCatalog?: boolean; savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[]; signal?: AbortSignal }>) => Promise<import('@/settings/accountSettings/activeAccountSettingsSnapshot').ActiveAccountSettingsSnapshot | null>;
  /** Explicit scope for Account-settings consumers; Session scope is fail-closed. */
  accountSettingsAuthority?: HostSessionRuntimeAuthority['scope'];
  /** Explicit runtime credential reader for scoped compositions; ordinary hosts use their existing persistence reader. */
  readCredentials?: () => Promise<import('@/persistence').StoredCredentials | null>;
  providerBindingMaterialization?: AgentProviderBindingLaunchMaterializationV1;
  /** True only for the exact matching local cross-agent native-return record. */
  strictNativeResumeIdentity?: boolean;
  pendingQueueDrainMaxPopPerWake?: number;
  pendingQueueDeliveryTiming?: AccountSettings['sessionPendingQueueDeliveryTiming'];
  permissionHandler: ProviderEnforcedPermissionHandler;
  getPermissionMode: () => PermissionMode;
  getWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
  resolveFreshSessionSystemPrompt?: SessionPromptPlanResolver;
  // Effective thinking/keepalive is host-owned: the session loop's
  // `setThinkingState` is the single writer, because it is the only path that
  // also publishes the keepalive that carries the fact. Session-runtime
  // factories are deliberately given no thinking authority.
  memoryRecallGuidanceEnabled: boolean;
  sessionState?: SessionStateSyncEngine;
  waitForProviderSessionIdPublication?: (providerSessionId: string, signal: AbortSignal) => Promise<void>;
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
  rpcHandlerManager?: RpcHandlerManagerLike,
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
  /** Caller content is composed by the session PromptPlan owner, never delivered separately. */
  agentSessionStartupInstructionsV1?: import('@happier-dev/protocol').AgentSessionStartupInstructionsV1;
  /** Opaque host-derived tag for an admitted create-or-rejoin request. */
  sessionCreationTag?: import('@happier-dev/protocol').SessionCreationTagV1;
  /** Immutable correspondence admitted with sessionCreationTag. */
  sessionCreationCorrespondence?: import('@happier-dev/protocol').SessionCreationCorrespondenceV1;
  /** Informational origin written only into a fresh Session creation envelope. */
  placementOrigin?: import('@happier-dev/protocol').MachinePoolSelectionOriginV1;
  /** Mutable presentation state to write within a fresh canonical create envelope. */
  initialTitle?: string;
  initialAccess?: import('@happier-dev/protocol').SessionInitialAccessDraftV1;
  primaryTeamId?: string | null;
  teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
  directory?: string;
  runtimeDescriptorV1?: import('@happier-dev/protocol').RuntimeDescriptorV1;
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
  sessionAttachSecret?: import('@/agent/runtime/sessionAttach').SessionAttachSecret;
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

export type CanonicalHostSessionRuntimeRunOptions = Omit<
  HostSessionRuntimeRunOptions,
  'backendTarget'
> & Readonly<{
  backendTarget?: BackendTargetRefV2 | AgentExecutionTargetV1;
}>;

export type HostSessionRuntimePushSender = Pick<PushNotificationClient, 'sendToAllDevices' | 'sendToAllDevicesAsync'>;

/**
 * Explicit credentials and scope for host-owned Action/MCP composition.
 * Ordinary runtimes omit this and retain Account authority; restricted
 * runtimes provide their verified Session principal's transport credentials
 * with no Account credential.
 */
export type HostSessionRuntimeAuthority = Readonly<{
  sessionCredentials: import('@/persistence').StoredCredentials;
} & (
  | {
      scope: 'account';
      accountCredentials: import('@/persistence').StoredCredentials;
    }
  | {
      scope: 'session';
      accountCredentials: null;
    }
)>;

export type HostSessionRuntimeStartupSeed = Readonly<{
  permissionMode: PermissionMode;
  permissionModeUpdatedAt: number;
  permissionModeSource:
    | import('@/settings/permissions/permissionModeSeed').PermissionModeSeedSource
    | 'released_cache_v1';
  modelSelection: SessionModelSelectionV1 | null;
}>;

export type HostSessionRuntimeLoopApi = Readonly<{
  push: () => HostSessionRuntimePushSender | null;
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
  mcpServerIdentities?: Readonly<Record<string, McpServerIdentity>>;
  runtimeActivityApplicability: RuntimeActivityApplicability;
  /** Reads the acknowledged current delivery, including live reload and refusal. */
  readSkillDelivery?: () => import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionSkillDelivery | undefined;
  skillUsageAccount?: import('@/prompts/skills/store/skillUsage').SkillUsageAccount;
  /** Scoped source DEKs for restricted runtimes; ordinary runtimes omit this. */
  sessionFollowSourceMaterialResolver?: SessionFollowSourceMaterialController | null;
  hostContextOnlyInput?: HostContextOnlyInputPort;
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
    retainedTerminalRecovery?: InitializeBackendRunSessionOptions['retainedTerminalRecovery'];
  }>;
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void;
  onAttachMetadataSnapshotError?: (error: unknown) => void;
  onSessionSwap?: (params: { session: ApiSessionClient }) => void | Promise<void>;
  onAfterStart?: (params: { session: ApiSessionClient; runtime: HostSessionRuntimeHookRuntime }) => void | Promise<void>;
  onAfterReset?: (params: { session: ApiSessionClient; runtime: HostSessionRuntimeHookRuntime }) => void | Promise<void>;
  onDispose?: (params: { session: ApiSessionClient; runtime: HostSessionRuntimeHookRuntime }) => void | Promise<void>;
  lifecycleHooks?: HostSessionRuntimeLifecycleHooks;
  /** Process signals/exits are caller-owned for compositions with a close-decision UI. */
  processLifecycleOwnership?: 'self' | 'caller';
  startRuntimeBeforeFirstPrompt?: boolean;
  onTerminalDisplayControllerReady?: (controller: TerminalDisplayController) => void;
  onRuntimeStopReady?: (stop: () => Promise<void>) => void;
  shouldRenderTerminalDisplay?: (params: { opts: HostSessionRuntimeRunOptions; session: ApiSessionClient; metadata: Metadata }) => boolean;
  resolveRunnerMcpServersAccountSettings?: (params: { opts: HostSessionRuntimeRunOptions; session: ApiSessionClient; metadata: Metadata }) => AccountSettings | null;
  /** Exact host-admitted Action policy; restricted runtimes must not consult ambient Account settings. */
  runtimeActionSettingsProvider?: RuntimeActionSettingsProvider;
  /** Exact caller-owned executable registry for daemonless scoped runtimes. */
  pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
  pluginMcpRuntimeRegistry?: PluginRuntimeRegistryLease['registry'];
  /** Reviewed activation-local MCP material already resolved by the canonical owner. */
  resolvedMcpServers?: Record<string, McpServerConfig>;
  /** Explicit host Action/MCP authority; absent for ordinary Account runtimes. */
  runtimeAuthority?: HostSessionRuntimeAuthority;
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
  /** Test seam for the canonical Follow hydrator; production always uses the incumbent owner. */
  createSessionFollowSourceHydratorFn?: typeof createSessionFollowSourceHydrator;
  createSessionMetadataFn?: typeof createSessionMetadata;
  initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
  resolveRunnerMcpServersFn?: typeof resolveRunnerMcpServers;
  createProviderEnforcedPermissionHandlerFn?: typeof createProviderEnforcedPermissionHandler;
  createPermissionModeQueueStateFn?: typeof createPermissionModeQueueState;
  /** Test/embedding seam for the canonical Follow hydrator factory; production uses the owner directly. */
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
  const startupStartedAt = performance.now();
  let startupPhaseStartedAt = startupStartedAt;
  let startupPhase = 'entered';
  const recordStartupPhase = (phase: string): void => {
    const now = performance.now();
    logger.infoFile(`${config.uiLogPrefix} Startup phase`, {
      phase,
      durationMs: Math.round(now - startupPhaseStartedAt),
      elapsedMs: Math.round(now - startupStartedAt),
      processUptimeMs: Math.round(process.uptime() * 1_000),
    });
    startupPhaseStartedAt = now;
    startupPhase = phase;
  };
  recordStartupPhase('entered');
  const startupRegistrationLifetime = new AbortController();
  let currentSessionPresentationHost: CurrentSessionPresentationHost | null = null;
  let runtimeStopRequested = false;
  let runtimeStopDelegate: (() => Promise<void>) | null = null;
  let runtimeStopDispatchPromise: Promise<void> | null = null;
  let resolveRuntimeStop!: () => void;
  let rejectRuntimeStop!: (error: unknown) => void;
  const runtimeStopCompletion = new Promise<void>((resolve, reject) => {
    resolveRuntimeStop = resolve;
    rejectRuntimeStop = reject;
  });
  const dispatchRuntimeStop = (): void => {
    if (!runtimeStopRequested || runtimeStopDelegate === null || runtimeStopDispatchPromise !== null) {
      return;
    }
    runtimeStopDispatchPromise = runtimeStopDelegate().then(
      () => resolveRuntimeStop(),
      (error) => rejectRuntimeStop(error),
    );
  };
  const requestRuntimeStop = (): Promise<void> => {
    runtimeStopRequested = true;
    dispatchRuntimeStop();
    return runtimeStopCompletion;
  };
  // This is the stable ordinary Session/process terminal owner. Expose it before
  // deferred Session attachment so a materialization/Stop race cannot fall back
  // to bootstrap-key cleanup or admit an Agent before termination is observed.
  config.onRuntimeStopReady?.(requestRuntimeStop);

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
  const teamModelIntentCandidate = (() => {
    const binding = opts.teamCredentialBindings?.find((candidate) => candidate.slot.kind === 'provider_model');
    const selection = opts.modelSelection;
    return binding?.slot.kind === 'provider_model'
      && binding.resourceId !== null
      && typeof opts.primaryTeamId === 'string'
      && selection
      ? createModelIntentV2MetadataCasCandidate({
          selection: {
            v: 2,
            updatedAt: selection.updatedAt,
            ref: {
              source: 'team_resource',
              resourceId: binding.resourceId,
              teamId: opts.primaryTeamId,
              expectedResourceRevision: binding.expectedResourceRevision,
              deliveryMode: binding.deliveryMode,
              agentTargetKey: selection.ref.agentTargetKey,
              modelId: selection.ref.modelId,
            },
          },
        })
      : null;
  })();
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
  const canonicalRuntimeOpts = createCanonicalHostSessionRuntimeRunOptions(opts);
  const runtimeAuthority: HostSessionRuntimeAuthority = config.runtimeAuthority ?? {
    scope: 'account',
    sessionCredentials: canonicalRuntimeOpts.credentials,
    accountCredentials: canonicalRuntimeOpts.credentials,
  };
  // A restricted Session/Runner runtime must not expose the hosting Account's
  // settings through any downstream lifecycle or plugin callback. Sanitize the
  // one canonical options object once, before any settings-dependent callback
  // can run, instead of relying on every consumer to remember the scope.
  const runtimeOpts = runtimeAuthority.scope === 'session'
    ? { ...canonicalRuntimeOpts, accountSettingsContext: null }
    : canonicalRuntimeOpts;
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
  recordStartupPhase('process_identity');
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
    ? buildBackendTargetKeyV2(runtimeOpts.backendTarget)
    : buildBackendTargetKeyV2({ kind: 'backend', backendId: policyAgentId, sourceKind: 'built_in' });
  let api: HostSessionRuntimeLoopApi;
  let machineId: string;
  let metadata: Metadata;
  let session: ApiSessionClient;
  let initialPermissionMode: PermissionMode;
  let permissionHandler: ProviderEnforcedPermissionHandler;
  let abortRequestedCallback: (() => void | Promise<void>) | null = null;
  let readHostTurnAbortSignal: (() => AbortSignal) | undefined;
  let currentControlRpcRegistrar: ReturnType<typeof createSwapAwareRpcHandlerRegistrar> | null = null;
  let rebindPermissionModeQueueSession: ((session: ApiSessionClient) => void) | null = null;
  let pendingPermissionModeQueueSessionSwap: ApiSessionClient | null = null;
  let runtimeForInFlightSteer: HostSessionRuntimeHookRuntime | null = null;
  let readMcpToolContext: () => McpToolPolicyContext | null = () => null;
  let applyMcpAccountPolicyUpdate: (() => void) | null = null;
  let runtimeForSessionRollback: HostSessionRuntimeHookRuntime | null = null;
  let runtimeActivityProjection: HostRuntimeActivityProjection | null = null;
  let agentRuntimeActivityBinding: ReturnType<HostRuntimeActivityProjection['bindAgentRuntime']> | null = null;
  let executionRunsActivityBinding: ReturnType<HostRuntimeActivityProjection['bindExecutionRuns']> | null = null;
  let unsubscribeExecutionRunActivity: (() => void) | null = null;
  let runtimeActivitySourceSessionId: string | null = null;
  let modelTransitionCoordinator: ReturnType<
    typeof createSessionModelTransitionCoordinator
  > | null = null;
  let modelMutationScope: SessionModelMutationScopeV1 | undefined;
  let modelTransitionOwnerCurrent = true;
  let modelTransitionAdmissionFenced = false;
  let latestSessionContextUsage: SessionContextUsageSnapshotV1 | null = null;
  let ownerActivityDelivery: 'rich_sender' | 'home_required' = 'home_required';
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
  let sessionIsNew: boolean | undefined;
  let initialSessionId: string | undefined;
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

  const reportRuntimeActivityPublicationError = (_error: unknown, snapshot: HostRuntimeActivitySnapshot): void => {
    logger.warn(`${config.uiLogPrefix} Runtime Activity publication failed (non-fatal)`, {
      error: 'runtime_activity_publication_failed',
      ...snapshot,
    });
  };

  const runtimeActivityApplicability = config.runtimeActivityApplicability;

  const bindAgentRuntimeActivityProducer = (sourceSessionId: string): void => {
    agentRuntimeActivityBinding = null;
    runtimeActivitySourceSessionId = null;
    if (runtimeActivityApplicability !== 'supported') return;
    const projection = runtimeActivityProjection;
    if (!projection) throw new Error('Runtime Activity producer binding requires an active projection');
    agentRuntimeActivityBinding = projection.bindAgentRuntime({ applicability: 'supported' });
    runtimeActivitySourceSessionId = sourceSessionId;
  };

  const observeAgentRuntimeActivityEvent = (event: AgentSessionRuntimeEvent): void => {
    const binding = agentRuntimeActivityBinding;
    if (!binding || event.sessionId !== runtimeActivitySourceSessionId) return;
    const targetSessionId = session.sessionId;
    observeRuntimeActivityPublication(
      binding.observeEvent(event.sessionId === targetSessionId
        ? event
        : { ...event, sessionId: targetSessionId }),
      'agent-runtime',
    );
  };

  const augmentSessionMetadata = (metadata: Metadata): Metadata => {
    const base = config.augmentSessionMetadata ? config.augmentSessionMetadata(metadata) : metadata;
    const augmented = teamModelIntentCandidate
      ? teamModelIntentCandidate.update(base)
      : base;
    return providerBindingMetadataUpdate !== undefined
      ? applySessionProviderBindingMetadataV1(augmented, providerBindingMetadataUpdate) as Metadata
      : augmented;
  };
  const applySessionSwap = async (newSession: ApiSessionClient): Promise<void> => {
    const previousSession = typeof session === 'undefined' ? null : session;
    const roleContext = (previousSession as import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionWithContext<ApiSessionClient> | null)
      ?.getSessionRoleContext;
    newSession.setOwnerActivityDelivery(ownerActivityDelivery);
    if (previousSession && previousSession.sessionId !== newSession.sessionId) {
      latestSessionContextUsage = null;
    }
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
    if (previousSession && previousSession.sessionId !== newSession.sessionId) {
      currentSessionPresentationHost?.retire();
    }
    session = newSession;
    if (roleContext) applyRunnerMcpSessionContext(newSession, { getSessionRoleContext: roleContext });
    currentSessionPresentationHost?.bindCurrentSession();
    process.env[PROCESS_OWNER_ENV_KEY] = formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir,
      owner: { kind: 'session', sessionId: newSession.sessionId } });
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
        onPublicationError: reportRuntimeActivityPublicationError,
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
          retainedRuntimeActivitySourceSessionId,
        );
      }
      await runtimeActivityProjection.reofferCurrentSnapshot();
    }
    if (modelMutationScope) {
      // Replace the current scope so receipts already issued keep their exact
      // Session identity while the existing model owner follows this binding.
      modelMutationScope = { ...modelMutationScope, sessionId: newSession.sessionId };
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
  recordStartupPhase('startup_seed');
  const createPreparedDeferredStartupBootstrapForRuntime:
    typeof createPreparedDeferredStartupBootstrap = async (params) =>
      await createPreparedDeferredStartupBootstrapFn({
        ...params,
        hostProcessStartTimeMs: runnerProcessIdentity?.processStartTimeMs,
        retainedTerminalRecovery: config.initializeSession?.retainedTerminalRecovery,
        augmentSessionMetadata,
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

  recordStartupPhase('deferred_bootstrap');
  if (startupBootstrap) {
    sessionIsNew = !startupBootstrap.attachedToExistingSession;
    api = startupBootstrap.api;
    machineId = startupBootstrap.machineId;
    metadata = startupBootstrap.metadata;
    session = startupBootstrap.session;
    initialSessionId = session.sessionId;
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
    recordStartupPhase('api_context');
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
      runtimeDescriptorV1: runtimeOpts.runtimeDescriptorV1,
      machineId,
      hostProcessStartTimeMs: runnerProcessIdentity?.processStartTimeMs,
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
        return {
          ...withInitialTitle,
          ...(sessionCreationCorrespondence
            ? { sessionCreationCorrespondenceV1: sessionCreationCorrespondence }
            : {}),
          ...(runtimeOpts.placementOrigin
            ? { placementOrigin: runtimeOpts.placementOrigin }
            : {}),
        };
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
      credentials: runtimeOpts.credentials,
      sessionTag,
      ...(runtimeOpts.initialAccess !== undefined ? { initialAccess: runtimeOpts.initialAccess } : {}),
      ...(runtimeOpts.primaryTeamId !== undefined ? { primaryTeamId: runtimeOpts.primaryTeamId } : {}),
      ...(runtimeOpts.teamCredentialBindings !== undefined ? { teamCredentialBindings: runtimeOpts.teamCredentialBindings } : {}),
      ...(sessionCreationCorrespondence
        ? { organizationPlacement: sessionCreationCorrespondence.recipe.organization }
        : {}),
      metadata,
      state: createdSessionMetadata.state,
      existingSessionId: runtimeOpts.existingSessionId,
      ...(runtimeOpts.sessionAttachFilePath ? { sessionAttachFilePath: runtimeOpts.sessionAttachFilePath } : {}),
      ...(runtimeOpts.sessionAttachSecret ? { sessionAttachSecret: runtimeOpts.sessionAttachSecret } : {}),
      uiLogPrefix: config.uiLogPrefix,
      terminalAgentLabel: config.policyAgentId,
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
      retainedTerminalRecovery: config.initializeSession?.retainedTerminalRecovery,
      onAttachMetadataSnapshotMissing: config.onAttachMetadataSnapshotMissing,
      onAttachMetadataSnapshotError: config.onAttachMetadataSnapshotError,
      deferPendingFirstInputCommitUntilRuntimeReady:
        daemonTurnContributionsBridge !== undefined,
      ...(requireDaemonAckOnAttach
        ? { requireDaemonAckOnAttach: true }
        : {}),
    });

    session = initializedSession.session;
    initialSessionId = session.sessionId;
    sessionIsNew = !initializedSession.attachedToExistingSession;
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
  recordStartupPhase('session_construction');

  process.env[PROCESS_OWNER_ENV_KEY] = formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir,
    owner: { kind: 'session', sessionId: session.sessionId } });
  const startupCustody = await joinCurrentWindowsSessionProcessCustody();
  if (startupCustody?.state === 'unavailable') logger.debug('[session] Windows process custody unavailable');

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
  let unsubscribeSessionLiveWorkForConstructionCleanup: (() => void) | null = null;
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
        runtimeActivityProjection?.dispose();
        runtimeActivityProjection = null;
      });
      await runCleanupStep('unsubscribe pending delivery timing', () => {
        unsubscribePendingQueueDeliveryTimingForConstructionCleanup?.();
        unsubscribePendingQueueDeliveryTimingForConstructionCleanup = null;
        unsubscribeSessionLiveWorkForConstructionCleanup?.();
        unsubscribeSessionLiveWorkForConstructionCleanup = null;
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
  const terminalizeBeforeAgentAdmission = async (): Promise<boolean> => {
    if (!runtimeStopRequested) return false;
    try {
      await session.endSessionAndClose();
      await cleanupFailedConstruction(false);
      resolveRuntimeStop();
      return true;
    } catch (error) {
      rejectRuntimeStop(error);
      throw error;
    }
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
      && claimedSession.hasOwnerMetadataAuthority()
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
      initialSessionId = session.sessionId;
      hostOwnsSessionConstructionCleanup = true;
    } else {
      claimedSessionForAuthorityPreparation = session;
      const preparation = establishClaimedSessionCustody(session);
      claimedSessionAuthorityPreparation = preparation;
      await preparation;
    }
    if (await terminalizeBeforeAgentAdmission()) return;
    recordStartupPhase('session_custody');
  currentControlRpcRegistrar = createSwapAwareRpcHandlerRegistrar(() => session.rpcHandlerManager);
  runtimeActivityProjection = createHostRuntimeActivityProjection({
    sessionId: session.sessionId,
    agentRuntimeApplicability: runtimeActivityApplicability,
    enqueueRegisteredSessionStateFieldMutation: (mutation) =>
      session.enqueueRegisteredSessionStateFieldMutation(mutation),
    onPublicationError: reportRuntimeActivityPublicationError,
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
  const presentationHost = createCurrentSessionPresentationHost({
    session: currentLifecycleSession,
    signal: startupRegistrationLifetime.signal,
  });
  currentSessionPresentationHost = presentationHost;
  // Home, credentials and Account lifetime come from the admitted Session once.
  // Finite material reads may refresh their snapshot without selecting another Home or Account.
  const sessionOpenContext = {
    home: session.getServerBinding(),
    credentials: runtimeAuthority.accountCredentials,
    scopeKey: runtimeAuthority.accountCredentials
      ? runtimeOpts.accountSettingsContext?.scopeKey ?? resolveAccountSettingsScopeKey(runtimeAuthority.accountCredentials)
      : null,
    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
  };
  const isSessionOpenAccountCurrent = () => sessionOpenContext.scopeKey !== null
    && getActiveAccountSettingsSnapshot()?.scopeKey === sessionOpenContext.scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === sessionOpenContext.lifetimeToken;
  let capturedOpenAccountOperation: SavedSecretOperationContextV1 | undefined;
  const readSessionOpenAccountOperation = (): SavedSecretOperationContextV1 | undefined => {
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!sessionOpenContext.credentials) return undefined;
    if (!snapshot || !isSessionOpenAccountCurrent()) {
      // Once this open admitted Account material, a later consumer cannot fall
      // back to ambient state and capture the replacement lifetime as its own.
      if (capturedOpenAccountOperation) throw Object.assign(new Error('context_source_unavailable'), {
        code: 'context_source_unavailable', reason: 'scope-retired',
      });
      return undefined;
    }
    if (!capturedOpenAccountOperation) {
      capturedOpenAccountOperation = runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl, () =>
        createInvocationSavedSecretOperationContextV1({ credentials: sessionOpenContext.credentials!, snapshot,
          readSourceSnapshot: () => isSessionOpenAccountCurrent() ? getActiveAccountSettingsSnapshot() : null,
          serverHttpBaseUrl: sessionOpenContext.home.serverUrl, isCurrent: async () => isSessionOpenAccountCurrent() }));
    }
    return capturedOpenAccountOperation;
  };
  // Daemon launches already captured this policy in their admitted environment.
  // Manual/deferred launches read it only after the real Session supplies its Home.
  if (runtimeOpts.startedBy !== 'daemon' && runtimeAuthority.scope === 'account') {
    const initialPolicySession = session;
    const policy = await readMachineResourcesPolicySnapshot({
      machineId,
      readMachine: async () => runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl,
        async () => (await ApiClient.create(runtimeAuthority.accountCredentials)).getMachine(machineId)),
      isCurrent: () => session === initialPolicySession,
    });
    Object.assign(process.env, buildToolIdleTimeoutEnvironmentOverlay({
      environment: buildScopedProcessEnv({
        baseEnv: process.env,
        explicitEnv: runtimeOpts.environmentVariables,
        unsetEnvKeys: runtimeOpts.unsetEnvironmentVariables,
      }),
      policy,
      unsetEnvKeys: runtimeOpts.unsetEnvironmentVariables,
    }));
  }
  if (pendingSessionInitializedHook) {
    await config.lifecycleHooks?.onSessionInitialized?.({
      session,
      opts: runtimeOpts,
      metadata: runtimeContextMetadataFallback(metadata, session),
      attachedToExistingSession: pendingSessionInitializedHook.attachedToExistingSession,
      machineId,
    });
    pendingSessionInitializedHook = null;
  }
  const accountCredentials = runtimeAuthority.accountCredentials;
  const workflowAccountId = accountCredentials ? readAccountIdFromToken(accountCredentials.token) : null;
  let currentWorkflowInput: Readonly<{ sessionId: string; port: HostContextOnlyInputPort }> | undefined;
  const readWorkflowDispatchFact = async (localInputId: string, signal: AbortSignal) => {
    const originSessionId = currentLifecycleSession.sessionId;
    const lookup = await findTranscriptEncryptedMessageByLocalIdV2({
      token: runtimeAuthority.sessionCredentials.token, serverUrl: resolveServerHttpBaseUrl(),
      sessionId: originSessionId, localId: localInputId, signal,
    });
    if (currentLifecycleSession.sessionId !== originSessionId) throw new Error('workflow_origin_session_changed');
    if (lookup.type === 'not_found') return 'not_dispatched' as const;
    if (lookup.type !== 'found') throw lookup.error;
    const crypto = session.getStoredContentEncryptionContext();
    const content = openSessionMessageContent({ ...(crypto.mode === 'plain'
      ? { mode: 'plain' as const, ctx: null } : crypto), content: lookup.message.content });
    if (!isSessionContextOnlyHostInput(content)) throw new Error('workflow_origin_input_commitment_invalid');
    return 'dispatched' as const;
  };
  const readWorkflowInputPort = (): HostContextOnlyInputPort | undefined => {
    if (config.hostContextOnlyInput) return config.hostContextOnlyInput;
    // Restricted ephemeral runners have no Account authority and are not persistent origin Sessions.
    if (!accountCredentials || !workflowAccountId) return undefined;
    const originSessionId = currentLifecycleSession.sessionId;
    if (currentWorkflowInput?.sessionId !== originSessionId) {
      currentWorkflowInput = { sessionId: originSessionId, port: createWorkflowOriginContextInputPort({
        accountId: workflowAccountId, originSessionId, machineId,
        storage: createWorkflowRunStorageClient({ token: accountCredentials.token, machineId }),
        resolveEncryption: async (signal) => await resolveAutomationWorkerAccountEncryption({
          token: accountCredentials.token, credentials: accountCredentials, signal,
        }),
        readDispatchFact: async (localInputId, signal) => {
          if (currentLifecycleSession.sessionId !== originSessionId) throw new Error('workflow_origin_session_changed');
          return await readWorkflowDispatchFact(localInputId, signal);
        },
        onDispatchedInput: (input) => workflowStepWithdrawal.observeWorkflowStepDispatched(input),
        onError: (error) => logger.debug(`${config.uiLogPrefix} Workflow origin context unavailable`, {
          error: error instanceof Error ? error.message : 'unknown_error',
        }),
      }) };
    }
    return currentWorkflowInput.port;
  };
  // Canonical production Follow consumer: exactly one reconciler per host Session runtime,
  // bound to the destination-owned lifecycle proxy (so swaps/reconnects keep one owner and
  // never duplicate accepted context) and the canonical source-content hydrator. The server
  // remains the feature/authorization gate: when `sessions.following` is off or the edge is
  // revoked, observe returns empty/unsupported and this resolves to no optional context.
  // The production wrapper resolves capacity from the current provider usage/model pair at
  // final composition, falling back only to the measured owner-local V1 allowance when those
  // facts are unavailable.
  // Restricted runtimes inject only their process-local prepared source DEKs into this
  // same hydrator; they do not construct another Follow reconciler or source reader.
  const createSessionFollowSourceHydratorFn = deps.createSessionFollowSourceHydratorFn
    ?? createSessionFollowSourceHydrator;
  const defaultSessionFollowContextReconciler = createSessionFollowContextReconciler({
    session: currentLifecycleSession,
    hydrateObservation: createSessionFollowSourceHydratorFn({
      session: currentLifecycleSession,
      credentials: runtimeOpts.credentials,
      sourceMaterialResolver: config.sessionFollowSourceMaterialResolver,
    }),
    sourceMaterialController: config.sessionFollowSourceMaterialResolver,
  });
  const effectivePrepareHostContext = async ({ signal, requiredPrompt, contextOnlyWorkerUpdate, contextOnlyWorkerLocalId, deliveryIntent = 'natural' }: Readonly<{
    signal: AbortSignal;
    requiredPrompt: string;
    contextOnlyWorkerUpdate?: WorkerUpdateV1;
    contextOnlyWorkerLocalId?: string;
    deliveryIntent?: 'natural' | 'wake';
  }>): Promise<HostPreparedContext | null> => {
    const activeModelId = modelTransitionCoordinator?.readActiveTarget().selection.modelId ?? null;
    const allowance = resolveSessionFollowContextUtf8AllowanceV1({
      requiredPrompt,
      activeModelId,
      contextUsage: latestSessionContextUsage,
    });
    const fittedWake = contextOnlyWorkerUpdate
      ? fitWorkerUpdateWithinHostContextAllowance(contextOnlyWorkerUpdate, allowance.maxUtf8Bytes)
      : undefined;
    if (fittedWake === null) return {
      updates: [], contextOnlyWorkerUpdate: null, contextOnlyWorkerDisposition: 'deferred', acknowledgeAccepted: () => undefined,
    };
    let remainingBytes = Math.max(0, allowance.maxUtf8Bytes - (fittedWake
      ? measureSessionFollowUtf8Bytes(renderWorkerUpdatePromptBlockV1(fittedWake)) + 2
      : 0));
    const workerCandidates = [
      ...(await currentLifecycleSession.prepareExecutionRunWorkerUpdates?.({ signal }) ?? []),
      ...(await readWorkflowInputPort()?.prepareWorkerUpdates?.({ signal, maxUtf8Bytes: remainingBytes }) ?? []),
    ];
    const workerItems = workerCandidates.flatMap((candidate) => {
      if (candidate.localId === contextOnlyWorkerLocalId) return [];
      const update = fitWorkerUpdateWithinHostContextAllowance(candidate.update, Math.max(0, remainingBytes - 2));
      if (!update) return [];
      remainingBytes -= measureSessionFollowUtf8Bytes(renderWorkerUpdatePromptBlockV1(update)) + 2;
      return [{ ...candidate, update }];
    });
    const follow = await defaultSessionFollowContextReconciler({
      signal,
      maxFollowContextUtf8Bytes: remainingBytes,
      deliveryIntent: contextOnlyWorkerUpdate ? 'wake' : deliveryIntent,
    });
    if (!follow && workerItems.length === 0 && !fittedWake) return null;
    return {
      updates: follow?.updates ?? [],
      workerUpdates: [...workerItems.map((item) => item.update), ...(follow?.workerUpdates ?? [])],
      workerUpdateEvents: [...workerItems.map(({ localId, update }) => ({ localId, update })), ...(follow?.workerUpdateEvents ?? [])],
      ...(follow?.wakeEventLocalId ? { wakeEventLocalId: follow.wakeEventLocalId } : {}),
      ...(fittedWake ? { contextOnlyWorkerUpdate: fittedWake } : {}),
      recheckAdmission: async (recheckSignal) => {
        if (follow && !await follow.recheckAdmission(recheckSignal)) return false;
        for (const item of workerItems) if (!await item.recheckAdmission(recheckSignal)) return false;
        return !recheckSignal.aborted;
      },
      acknowledgeAccepted: (input) => {
        follow?.acknowledgeAccepted(input);
        for (const item of workerItems) item.acknowledgeAccepted();
      },
    };
  };
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
  const activityPushSender = api.push();
  // Same rich-sender definition as the incumbent Activity owner
  // (sendReadyWithPushNotification): null/absence means Home delivery.
  ownerActivityDelivery = typeof activityPushSender?.sendToAllDevicesAsync === 'function'
    || typeof activityPushSender?.sendToAllDevices === 'function'
    ? 'rich_sender'
    : 'home_required';
  session.setOwnerActivityDelivery?.(ownerActivityDelivery);
  const roleAccountScopeKey = sessionOpenContext.scopeKey;
  const roleAccountLifetimeToken = sessionOpenContext.lifetimeToken;
  const readRoleAccountSnapshot = () => {
    if (runtimeAuthority.scope !== 'account') return null;
    return readSessionOpenAccountOperation()?.readSnapshot() ?? null;
  };
  const readRoleSources = createRoleSourceReader(runtimeAuthority.scope === 'account' && runtimeAuthority.accountCredentials
    ? { artifactStore: runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl,
          () => createCredentialedAccountArtifactStore(runtimeAuthority.accountCredentials!)),
        accountId: readAccountIdFromToken(runtimeAuthority.accountCredentials.token) ?? undefined,
        readRawAccountSettings: async () => {
          const current = readRoleAccountSnapshot();
          if (!current?.rawSettings || current.source === 'none') {
            throw Object.assign(new Error('role_overrides_unavailable'), {
              code: 'role_overrides_unavailable', reason: 'source-unavailable', contextSource: 'account_lifetime',
            });
          }
          return current.rawSettings;
        }, }
    : {});
  const sessionRoleContext = createSessionRoleContext({
    readOperationContext: readSessionOpenAccountOperation,
    readMetadata: () => currentLifecycleSession.getMetadataSnapshot?.() ?? runtimeMetadata,
    readRoleSources,
    readAccountRoleOverrides: () => {
      if (runtimeAuthority.scope !== 'account') return { status: 'ready', overrides: {} };
      const snapshot = readRoleAccountSnapshot();
      return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot)
        : { status: 'unavailable', reason: 'source-unavailable' };
    },
    prepareAccountRoleOverrides: async (signal) => {
      if (runtimeAuthority.scope === 'account' && roleAccountScopeKey && runtimeAuthority.accountCredentials) {
        await runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl, () =>
          prepareActiveAccountRoleOverrides({ credentials: runtimeAuthority.accountCredentials!,
            scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken,
            operationContext: readSessionOpenAccountOperation(), signal }));
      }
    },
    readDefaultEngine: () => ({ agentTargetKey: modelTargetKey }),
    readOrganization: (signal) => session.readRolePromptOrganization(signal),
  });
  const prepareWorkspaceWritesPolicy = createWorkspaceWritesPolicyPreparation({
    update: async (workspaceWrites) => await runtimeForInFlightSteer?.updateSessionRuntimeConfig({ workspaceWrites }),
  });
  const resolveSessionRolePromptContext = (signal?: AbortSignal) => sessionRoleContext.resolvePromptContext(signal);
  const prepareSessionRolePromptPolicy = async () => {
    await sessionRoleContext.prepare();
    const workspaceWrites = sessionRoleContext.readWorkspaceWrites();
    if (runtimeForInFlightSteer) {
      const prepared = await prepareWorkspaceWritesPolicy(workspaceWrites);
      if (!prepared.ok) throw Object.assign(new Error(prepared.errorCode), { code: prepared.errorCode });
    }
  };
  let resolveFreshSessionSystemPrompt: SessionPromptPlanResolver | null = null;
  permissionHandler = createProviderEnforcedPermissionHandlerFn({
    session,
    logPrefix: config.uiLogPrefix,
    pushSender: activityPushSender,
    getAccountSettings: () => runtimeOpts.accountSettingsContext?.settings ?? null,
    getCodingPromptBehavior: () => resolveFreshSessionSystemPrompt?.readCodingPromptBehavior?.() ?? null,
    getWorkspaceWrites: sessionRoleContext.readWorkspaceWrites,
    getMcpToolContext: () => readMcpToolContext(),
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

  const acceptedEffectByPendingLocalId = new Map<string, Array<() => void>>();
  const registerProviderAcceptedEffect = (
    localId: string,
    onAccepted: (() => void) | null,
  ): void => {
    if (!onAccepted) {
      acceptedEffectByPendingLocalId.delete(localId);
      return;
    }
    const effects = acceptedEffectByPendingLocalId.get(localId);
    if (effects) effects.push(onAccepted);
    else acceptedEffectByPendingLocalId.set(localId, [onAccepted]);
  };
  const observeAcceptedEffect = (localId: string): void => {
    const effects = acceptedEffectByPendingLocalId.get(localId);
    if (!effects) return;
    acceptedEffectByPendingLocalId.delete(localId);
    for (const effect of effects) {
      try {
        effect();
      } catch {
        // Acceptance is authoritative; one settlement cannot invalidate another.
      }
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
    readActivePermissionMode: () => permissionHandler.getPermissionMode(),
    readActiveModelSelection: () =>
      modelTransitionCoordinator?.readActiveTarget().selection ?? null,
    supportsInFlightSteer: () => runtimeForInFlightSteer?.supportsInFlightSteer?.() === true,
    isProviderNativeCommand: (prompt) => runtimeForInFlightSteer?.isProviderNativeCommand?.(prompt) === true,
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
    prepareHostContext: effectivePrepareHostContext,
    readStructuredInputDispatchServices: () => {
      const targetSession = currentLifecycleSession;
      return {
        sessionId: targetSession.sessionId,
        retainPromptComposition: async composition => {
          await targetSession.enqueueSessionEventCommitted({ type: 'prompt-composition', composition });
        },
        catalogs: {
          ...(runtimeForInFlightSteer?.listSkills ? { listSkills: () => runtimeForInFlightSteer!.listSkills!() } : {}),
          ...(runtimeForInFlightSteer?.listVendorPlugins ? { listVendorPlugins: () => runtimeForInFlightSteer!.listVendorPlugins!() } : {}),
        },
        ...(daemonTurnContributionsBridge ? {
          resolveComposerReference: async (input) => await daemonTurnContributionsBridge.resolveComposerReference({
            sessionId: currentLifecycleSession.sessionId,
            ...input,
          }),
          resolveComposerAttachmentForDispatch: async (input) => await daemonTurnContributionsBridge.resolveComposerAttachment(input),
        } : {}),
      };
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
      const promptMeta = options;
      await runtime.steerPrompt(text, promptMeta);
    },
    rejectPromptBeforeProvider: (info) => {
      if (info.preparationFailure) {
        for (const localInputId of info.localIds ?? []) {
          observeProviderInputOutcome({
            type: 'input-rejected',
            localInputId,
            userMessageSeq: info.userMessageSeq,
            ...(info.userMessageSeqs ? { userMessageSeqs: info.userMessageSeqs } : {}),
            diagnostic: { code: info.preparationFailure.code, severity: 'error' },
            retryable: info.preparationFailure.retryable,
          });
        }
        return;
      }
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
      const outcome = await apply(delta);
      if (outcome.status === 'applied' || outcome.status === 'scheduled_in_turn') {
        const mode = parseAgentPermissionIntentV1Alias(delta.permissionMode);
        if (mode) permissionHandler.setPermissionMode(mode);
      }
      return outcome;
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
  const checkpointCodeRollback = createRepositoryCheckpointCodeRollback({
    session: currentLifecycleSession,
    runtimeDirectory,
  });
  registerSessionRollbackRpcHandler(
    currentControlRpcRegistrar.registrar,
    () => ({
      ...resolveSessionRollbackRuntimeFacet(runtimeForSessionRollback),
      checkpointCodeRollback,
    }),
  );
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
    runtimeAuthority.scope === 'session'
      ? null
      : getActiveAccountSettingsSnapshot()?.settings
        ?? runtimeOpts.accountSettingsContext?.settings
        ?? null,
  );
  const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming();
  let observedSessionFollowWakeGeneration = readSessionFollowWakeInvalidationGeneration() - 1;
  const workflowStepWithdrawal = createWorkflowStepWithdrawal({
    reportWithdrawn: async (input) => { await readWorkflowInputPort()?.reportWorkflowStepWithdrawn(input); },
  });
  const commitContextOnlyHostEvent = async (localId: string, event: TranscriptRawAgentEventV1): Promise<void> => {
    await commitRuntimeSessionEvent({
      session: currentLifecycleSession, agentId: config.agentMessageType, localId,
      event,
    });
  };
  const commitContextOnlyWorkerEvents = async (
    localId: string, events: readonly Readonly<{ localId: string; update: WorkerUpdateV1 }>[], fallback: TranscriptRawAgentEventV1,
  ): Promise<void> => {
    if (!events.some((event) => event.localId === localId)) {
      await commitContextOnlyHostEvent(localId, fallback);
    }
    for (const event of events) {
      await commitContextOnlyHostEvent(event.localId, { type: 'worker-update', update: event.update });
    }
  };
  inputConsumer = createSessionProviderInputConsumer({
    messageQueue,
    session: createSessionProviderInputConsumerSessionAdapter(currentLifecycleSession),
    reconcileWhenEmpty: 'skip',
    pendingQueueDeliveryTiming,
    resolvePendingQueueDeliveryTiming: readPendingQueueDeliveryTiming,
    refreshBeforeQueuedBatch: false,
    pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
    waitForContextOnlyInputChange: async (signal) => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        return await Promise.race([
          waitForSessionFollowWakeInvalidation(readSessionFollowWakeInvalidationGeneration(), controller.signal),
          ...(currentLifecycleSession.waitForExecutionRunWorkerUpdateChange
            ? [currentLifecycleSession.waitForExecutionRunWorkerUpdateChange(controller.signal)] : []),
          ...(readWorkflowInputPort() ? [readWorkflowInputPort()!.waitForChange(controller.signal)] : []),
        ]);
      } finally {
        controller.abort();
        signal.removeEventListener('abort', abort);
      }
    },
    takeContextOnlyInput: async (signal) => {
      const source = await readWorkflowInputPort()?.take(signal)
        ?? await currentLifecycleSession.takeExecutionRunWorkerUpdate?.(signal);
      if (signal.aborted) return null;
      if (source) {
        const localId = source.kind === 'workflow_step' ? source.localInputId : source.localId;
        const mode = {
          permissionMode: permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
          suppressUserEcho: true, providerPromptAlreadyResolved: true,
        };
        if (source.kind === 'workflow_step') {
          await workflowStepWithdrawal.offerWorkflowStepInput({ localInputId: localId });
          return {
            message: { text: source.text, localId, causalPermissionAuthority: source.causalPermissionAuthority, hostContextOnly: {
              ...source, withdrawal: workflowStepWithdrawal,
              isWorkflowStepDeliverable: async (input) => await readWorkflowInputPort()?.isWorkflowStepDeliverable(input) ?? false,
              commitHostEvent: () => commitContextOnlyHostEvent(localId, { type: 'message', message: WORKFLOW_STEP_INPUT_EVENT_MESSAGE }),
            } },
            mode, isolate: true, hash: localId,
          };
        }
        return {
          message: { text: '', localId, hostContextOnly: {
            kind: source.kind, update: source.update, recheckAdmission: source.recheckAdmission,
            acknowledgeAccepted: source.acknowledgeAccepted,
            commitHostEvent: (events) => commitContextOnlyWorkerEvents(localId, events ?? [{ localId, update: source.update }], { type: 'worker-update', update: source.update }),
          } },
          mode, isolate: true, hash: localId,
        };
      }
      const currentGeneration = readSessionFollowWakeInvalidationGeneration();
      if (currentGeneration === observedSessionFollowWakeGeneration) return null;
      observedSessionFollowWakeGeneration = currentGeneration;
      const prepared = await effectivePrepareHostContext({
        signal,
        requiredPrompt: '',
        deliveryIntent: 'wake',
      });
      if (!prepared?.recheckAdmission || signal.aborted) return null;
      const localId = prepared.wakeEventLocalId;
      if (!localId) return null;
      return {
        message: {
          text: '',
          localId,
          hostContextOnly: {
            kind: 'session_follow', prepared: { ...prepared, recheckAdmission: prepared.recheckAdmission },
            commitHostEvent: (events) => commitContextOnlyWorkerEvents(localId, events ?? prepared.workerUpdateEvents ?? [],
              { type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }),
          },
        },
        mode: {
          permissionMode: permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
          suppressUserEcho: true,
          providerPromptAlreadyResolved: true,
        },
        isolate: true,
        hash: localId,
      };
    },
  });
  let connectedServiceApplicationSettledHandler: ((request: Readonly<{
    serviceId: string;
    groupId: string;
  }>) => Promise<void>) | null = null;
  const unsubscribeSessionLiveWork = inputConsumer.subscribeLiveWork(() => {
    void notifyDaemonSessionActivityChanged(currentLifecycleSession.sessionId).catch(() => {
      logger.debug('[HOST RUNTIME] Session activity invalidation could not reach daemon');
    });
  });
  unsubscribeSessionLiveWorkForConstructionCleanup = unsubscribeSessionLiveWork;
  const guardNotice: SessionGuardNoticeOwner = {
    get session() { return currentLifecycleSession; },
    machineId,
    agentId: config.agentMessageType,
    notify: async event => {
      const operationContext = readSessionOpenAccountOperation();
      if (!operationContext || runtimeAuthority.scope !== 'account') throw new Error('Guard notification Account scope is unavailable');
      await dispatchActivityNotificationAsync({
        settings: undefined,
        operationContext,
        expoPushSender: activityPushSender,
        event,
      });
    },
  };
  await clearSessionGuardStateOnRunnerStart(guardNotice);
  recordStartupPhase('host_input_setup');
  registerSessionProviderInputAdmissionRpc({
    consumer: inputConsumer,
    guardNotice,
    rpcHandlerRegistrar: currentControlRpcRegistrar.registrar,
    onApplicationSettled: async (request) => {
      await connectedServiceApplicationSettledHandler?.(request);
    },
  });
  let lastPendingQueueDeliveryTiming = pendingQueueDeliveryTiming;
  let observeCapabilityAccountSettings: (() => void) | null = null;
  const unsubscribePendingQueueDeliveryTiming = runtimeAuthority.scope === 'session'
    ? () => undefined
    : subscribeActiveAccountSettingsSnapshot(() => {
      applyMcpAccountPolicyUpdate?.();
      observeCapabilityAccountSettings?.();
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
  const runnerMcpAccountSettings = runtimeAuthority.scope === 'account'
    && config.resolveRunnerMcpServersAccountSettings
    ? config.resolveRunnerMcpServersAccountSettings({
      opts: runtimeOpts,
      session,
      metadata: runtimeSessionMetadataSnapshot ?? runtimeMetadata,
    })
    : runtimeAuthority.scope === 'account'
      ? runtimeOpts.accountSettingsContext?.settings ?? null
      : null;
  // A Session-scoped runtime must never materialize Account settings or saved
  // secrets. The explicit authority is the only owner of this distinction;
  // absence of encryption material is not used as a scope signal.
  const effectiveRunnerMcpAccountSettings = runtimeAuthority.accountCredentials
    ? runnerMcpAccountSettings
    : null;
  const agentToolsDelivery = resolveAgentToolsDelivery(
    policyAgentId,
    config.pluginRuntimeRegistryLease?.registry.contributes,
  );
  const receivesUserMcpServers = agentReceivesUserMcpServersV1(agentToolsDelivery);
  const mcpToolControl = (config.pluginRuntimeRegistryLease?.registry.contributes ?? readAgentCatalogSnapshot()).catalogEntriesById[policyAgentId]?.mcpToolControl;
  const mcpAccountLifetimeToken = sessionOpenContext.lifetimeToken;
  const mcpAccountScopeKey = sessionOpenContext.scopeKey;
  const resolveMcpAccountSettingsSnapshot: NonNullable<HostSessionRuntimeFactoryParams['resolveAccountSettingsSnapshot']> = async input => {
    if (effectiveRunnerMcpAccountSettings === null || !runtimeAuthority.accountCredentials || !mcpAccountScopeKey) return null;
    const current = isSessionOpenAccountCurrent;
    if (!current()) return null;
    await runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl, () =>
      prepareActiveMcpServerCatalog({ credentials: runtimeAuthority.accountCredentials!, scopeKey: mcpAccountScopeKey,
        lifetimeToken: mcpAccountLifetimeToken, signal: input?.signal }));
    if (input?.savedSecretReferences?.length) {
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!current() || !snapshot) return null;
      const serverHttpBaseUrl = sessionOpenContext.home.serverUrl;
      return await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        const operationContext = readSessionOpenAccountOperation();
        if (!operationContext) return null;
        const admitted = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: mcpAccountScopeKey,
          references: input.savedSecretReferences, operationContext, signal: input.signal });
        return current() ? admitted : null;
      });
    }
    return current() ? readSessionOpenAccountOperation()?.readSnapshot() ?? null : null;
  };
  const activeRunnerMcpAccountSnapshot = receivesUserMcpServers ? await resolveMcpAccountSettingsSnapshot() : null;
  const runnerMcpSavedSecretResources = activeRunnerMcpAccountSnapshot?.savedSecretResources;
  let runnerSkills: RunnerSkillsResult | null = null;
  let activeAgentCompositionToolSelection: AgentCompositionToolSelection | null = null;
  const runnerMcpSession = applyRunnerMcpSessionContext(currentLifecycleSession, {
    getSessionRoleContext: () => sessionRoleContext,
    getCurrentSessionSkillItems: () => runnerSkills && !runnerSkills.unavailable
      ? runnerSkills.plan.items.filter(item => item.state === 'delivered')
        .map(({ skillId, name, digest }) => ({ skillId, name, digest }))
      : null,
    getCurrentResolvedRoles: sessionRoleContext.readResolvedRoles,
    getPluginMcpRuntimeRegistry: () => config.pluginMcpRuntimeRegistry ?? config.pluginRuntimeRegistryLease?.registry ?? null,
    readRoleSources,
    getCurrentWorkspaceWrites: sessionRoleContext.readWorkspaceWrites,
    prepareWorkspaceWritesPolicy,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
    // The Session tool bridge is registered before the native runtime. This closure is
    // intentionally read at tool-call time: it is null before construction and
    // after the canonical active-turn witness is cleared.
    getActiveTurnPermissionWitness: () => {
      const witness = runtimeForInFlightSteer?.readActiveTurnPermissionWitness?.() ?? null;
      if (!witness) return null;
      const workDepth = currentLifecycleSession.getHostTurnWorkDepth?.(witness.turnId);
      return {
        turnId: witness.turnId,
        ...(witness.causalPermissionAuthority ? { causalPermissionAuthority: witness.causalPermissionAuthority } : {}),
        ...(workDepth === undefined ? {} : { workDepth }),
      };
    },
    getActiveTurnAdmissionWitness: () => runtimeForInFlightSteer?.readActiveTurnAdmissionWitness?.() ?? null,
    getRuntimeLifetimeSignal: () => runtimeForInFlightSteer?.getRuntimeLifetimeSignal?.() ?? null,
    getHostTurnAbortSignal: () => readHostTurnAbortSignal?.() ?? null,
    getBackendTarget: () => runtimeOpts.backendTarget
      ? readBackendTargetRefV2(runtimeOpts.backendTarget)
      : null,
    getCurrentSessionLocation: () => ({
      path: runtimeDirectory,
      host: config.machineMetadata.host,
      machineId,
    }),
    getActiveAgentCompositionToolSelection: () => activeAgentCompositionToolSelection,
  });
  if (agentToolsDelivery !== 'unsupported') {
    registerHappierSessionAgentToolRpc(runnerMcpSession, {
      sessionCredentials: runtimeAuthority.sessionCredentials,
      credentials: runtimeAuthority.accountCredentials,
      authorityScope: runtimeAuthority.scope,
      accountSettings: effectiveRunnerMcpAccountSettings,
      // An explicit Session-scoped authority is also the live settings
      // authority. Do not let the getter fall back to the ambient Account
      // snapshot after construction; that would make a later tool call regain
      // Account policy even though the Runner was admitted only for its
      // Session. Ordinary Account runtimes retain the existing snapshot path.
      getAccountSettings: runtimeAuthority.scope === 'session'
        ? () => effectiveRunnerMcpAccountSettings
        : () => getActiveAccountSettingsSnapshot()?.settings ?? runnerMcpAccountSettings,
      ...(config.runtimeActionSettingsProvider
        ? { actionsSettingsProvider: config.runtimeActionSettingsProvider }
        : {}),
      ...(config.pluginRuntimeRegistryLease
        ? { pluginRuntimeRegistryLease: config.pluginRuntimeRegistryLease }
        : {}),
    });
  }
  currentLifecycleSession.bindMcpRequestAuthPort(daemonTurnContributionsBridge?.mcpRequestAuth);
  const { happierMcpServer, mcpServers, mcpServersStrictMode, mcpServerIdentities, mcpToolPolicy, resolveMcpToolNaming, resolvedServers, reach: runnerMcpReach } = receivesUserMcpServers
    ? await runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl, () => resolveRunnerMcpServersFn({
      session: runnerMcpSession,
      credentials: runtimeAuthority.sessionCredentials,
      accountCredentials: runtimeAuthority.accountCredentials,
      accountSettings: effectiveRunnerMcpAccountSettings,
      accountSettingsSnapshot: activeRunnerMcpAccountSnapshot,
      operationContext: readSessionOpenAccountOperation(),
      ...(config.runtimeActionSettingsProvider
        ? { actionsSettingsProvider: config.runtimeActionSettingsProvider }
        : {}),
      ...(config.pluginRuntimeRegistryLease
        ? { pluginRuntimeRegistryLease: config.pluginRuntimeRegistryLease }
        : {}),
      ...(runnerMcpSavedSecretResources
        ? { savedSecretResources: runnerMcpSavedSecretResources }
        : {}),
      machineId,
      directory: runtimeDirectory,
      agentId: policyAgentId,
      agentAcceptsUserMcp: receivesUserMcpServers,
      mcpToolControl,
      mcpPermissionHandler: permissionHandler,
      includeHappierMcpServer: agentToolsDelivery === 'native_mcp',
      sessionMetadata: runtimeSessionMetadataSnapshot ?? runtimeMetadata,
      ...(config.resolvedMcpServers ? { resolvedMcpServers: config.resolvedMcpServers } : {}),
    }))
    : { happierMcpServer: { stop: () => undefined }, mcpServers: {}, mcpServersStrictMode: undefined, mcpServerIdentities: undefined, mcpToolPolicy: undefined, resolveMcpToolNaming: undefined, resolvedServers: undefined, reach: undefined };
  readMcpToolContext = () => ({ mcpServerIdentities: mcpServerIdentities ?? {},
    prepareCatalog: () => resolveMcpAccountSettingsSnapshot(),
    catalog: mcpAccountScopeKey && getActiveAccountSettingsSnapshot()?.scopeKey === mcpAccountScopeKey
      && getActiveAccountSettingsSnapshotLifetimeToken() === mcpAccountLifetimeToken
      ? getActiveAccountSettingsSnapshot()?.mcpServerCatalog ?? null : null });
  const resolveMcpToolPolicy = (mode: string) => {
    const context = readMcpToolContext();
    const catalog = context?.catalog;
    return projectMcpToolLaunchPolicies({ mcpServerIdentities: context?.mcpServerIdentities ?? {},
      catalog: catalog?.status === 'ready' && catalog.authority === 'active' ? catalog.catalog : { v: 1, servers: [], bindings: [] },
      control: mcpToolControl, permissionMode: parseAgentPermissionIntentV1Alias(mode) ?? 'default' });
  };
  let lastMcpToolPolicy = mcpToolPolicy;
  applyMcpAccountPolicyUpdate = () => {
    if (mcpToolControl?.approval !== 'native' || !runtimeForInFlightSteer) return;
    const next = resolveMcpToolPolicy(permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode);
    if (JSON.stringify(next) === JSON.stringify(lastMcpToolPolicy)) return;
    lastMcpToolPolicy = next;
    void runtimeForInFlightSteer.updateSessionRuntimeConfig({ mcpToolPolicy: next }).then(outcome => {
      if (outcome.status !== 'applied') logger.warn('[HOST RUNTIME] MCP tool policy configuration update was not applied');
    }).catch(() => {
      logger.warn('[HOST RUNTIME] MCP tool policy configuration update failed');
    });
  };
  mcpServerForConstructionCleanup = happierMcpServer;
  recordStartupPhase('mcp_preparation');
  if (runtimeAuthority.scope === 'account' && runtimeAuthority.accountCredentials) {
    const accountSnapshot = getActiveAccountSettingsSnapshot();
    runnerSkills = await runWithServerHttpBaseUrl(sessionOpenContext.home.serverUrl, () => resolveRunnerSkills({
      ownerKey: currentLifecycleSession.sessionId,
      agentId: policyAgentId, machineId, directory: runtimeDirectory,
      sessionMetadata: runtimeSessionMetadataSnapshot ?? runtimeMetadata,
      credentials: runtimeAuthority.accountCredentials,
      accountSnapshot: accountSnapshot?.scopeKey === mcpAccountScopeKey ? accountSnapshot : null,
      operationContext: readSessionOpenAccountOperation(),
      contributes: config.pluginRuntimeRegistryLease?.registry.contributes,
      agentHasActionChannel: agentToolsDelivery !== 'unsupported',
      isCurrent: () => getActiveAccountSettingsSnapshot()?.scopeKey === mcpAccountScopeKey
        && getActiveAccountSettingsSnapshotLifetimeToken() === mcpAccountLifetimeToken,
    }));
    await publishRunnerSkillNotice(currentLifecycleSession, runnerSkills);
  }
  recordStartupPhase('skills_preparation');
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
    const explicitResumeId = readNonBlankOpaqueIdentifier(runtimeOpts.resume);
    if (explicitResumeId) return explicitResumeId;
    return readNonBlankOpaqueIdentifier(
      config.resolveInitialResumeId?.({ opts: runtimeOpts, session, metadata: runtimeMetadata }),
    ) ?? '';
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
        ? readNonBlankOpaqueIdentifier(current[strictInitialResumeMetadataKey]) ?? ''
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
  // Resolve an Artifact-backed selected role before the native process captures
  // its launch-only ceiling; unknown sources must not launch with a guessed policy.
  if (readSessionRolesV1(currentLifecycleSession.getMetadataSnapshot?.() ?? runtimeMetadata)?.roleId) {
    await sessionRoleContext.resolveRoles(startupRegistrationLifetime.signal);
  }
  resolveFreshSessionSystemPrompt = createSessionPromptPlanResolver({
    opts: runtimeOpts, session: currentLifecycleSession, agentId: policyAgentId,
    serverId: sessionOpenContext.home.serverId,
    machineId, directory: runtimeDirectory, memoryRecallGuidanceEnabled,
    readNativeSessionId: () => runtimeForInFlightSteer?.readSessionIdentity().sessionId ?? null,
    resolveRoleContext: resolveSessionRolePromptContext,
    daemonBridge: daemonTurnContributionsBridge,
    readSessionSkills: () => runnerSkills,
    readOperationContext: readSessionOpenAccountOperation,
  });
  let runtimePublicationMetadata: ReturnType<typeof subscribeSessionRuntimePublicationToMetadata> | null = null;
  const sessionRuntimeParams: HostSessionRuntimeFactoryParams = {
    directory: runtimeDirectory,
    metadata: runtimeMetadata,
    ...(runtimeOpts.terminalRuntime ? {
      currentTerminalMetadata: {
        terminal: buildTerminalMetadataFromRuntimeFlags(runtimeOpts.terminalRuntime),
        startedBy: runtimeOpts.startedBy ?? 'terminal',
      },
    } : {}),
    machineId,
    agentTargetKey: modelTargetKey,
    session: currentLifecycleSession,
    transcriptSession,
    currentSessionPresentation: presentationHost.bindCurrentSession,
    messageQueue,
    messageBuffer,
    mcpServers,
    resolveMcpToolNaming,
    mcpServerIdentities,
    ...(mcpServersStrictMode !== undefined ? { mcpServersStrictMode } : {}),
    resolvedMcpServers: resolvedServers,
    mcpToolPolicy,
    getMcpToolContext: () => readMcpToolContext(),
    ...(mcpToolControl?.approval === 'native' ? { resolveMcpToolPolicy: (mode: string) => {
      const next = resolveMcpToolPolicy(mode);
      lastMcpToolPolicy = next;
      return next;
    } } : {}),
    ...(runnerSkills?.delivery ? { skills: runnerSkills.delivery } : {}),
    accountSettings: runnerMcpAccountSettings,
    resolveAccountSettingsSnapshot: resolveMcpAccountSettingsSnapshot,
    accountSettingsAuthority: runtimeAuthority.scope,
    ...(runtimeAuthority.scope === 'session'
      ? { readCredentials: async () => runtimeAuthority.sessionCredentials }
      : {}),
    ...(providerBindingMaterialization ? { providerBindingMaterialization } : {}),
    ...(isTrackedNativeReturn ? { strictNativeResumeIdentity: true } : {}),
    pendingQueueDrainMaxPopPerWake,
    pendingQueueDeliveryTiming,
    permissionHandler,
    getPermissionMode: () => permissionModeState.getCurrentPermissionMode() ?? 'default',
    getWorkspaceWrites: sessionRoleContext.readWorkspaceWrites,
    resolveFreshSessionSystemPrompt,
    memoryRecallGuidanceEnabled,
    sessionState: sessionStateBridge.engine,
    waitForProviderSessionIdPublication: async (providerSessionId, signal) => {
      if (!runtimePublicationMetadata) {
        // A resumed runtime can bind while its factory opens; its existing
        // committed identity already supplies the hosted-reader proof.
        signal.throwIfAborted();
        const metadata = currentLifecycleSession.getMetadataSnapshot();
        if (metadata && readProviderSessionIdSessionState(metadata).value === providerSessionId) return;
        throw Object.assign(new Error('Native Session identity publisher is not bound'), {
          code: 'native_agent_identity_publication_unavailable',
        });
      }
      await runtimePublicationMetadata.waitForProviderSessionIdPublication(providerSessionId, signal);
    },
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
  if (await terminalizeBeforeAgentAdmission()) return;
  try {
    createdRuntime = await config.createSessionRuntime(sessionRuntimeParams);
    recordStartupPhase('agent_runtime_open');
  } catch (error) {
    if (isAgentNativeResumeIdentityMismatchError(error)) {
      await invalidateTrackedNativeReturnIdentity(initialResumeId);
    }
    throw error;
  }
  const {
    runtime,
    nativeRuntime,
    terminalRemoteModeLoop: initialTerminalRemoteModeLoop,
    admittedProviderBindingHandoff,
    skillsDelivered,
  } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
  let terminalRemoteModeLoop = initialTerminalRemoteModeLoop;
  let presentationOwnsCurrentTerminalDisplay = false;
  const hookRuntime = (nativeRuntime ?? runtime) as HostSessionRuntimeHookRuntime;
  if (skillsDelivered === false && runnerSkills?.delivery) {
    await publishRunnerSkillNotice(currentLifecycleSession, runnerSkills, false);
  }
  constructedRuntimeForConstructionCleanup = hookRuntime;
  const parentRegistrationStartedAt = performance.now();
  // The accepted native open already admits ordinary input. Registration is
  // needed by child inheritance and later auth changes, which join this same
  // startup operation before using the daemon's applied authority.
  const initialParentSelectionRegistration = hookRuntime.openedWithoutConnectedServices?.()
    ? readAppliedParentConnectedServices({
      sessionId: currentLifecycleSession.sessionId, runnerPid: process.pid,
      agentId: policyAgentId, initialEmpty: true,
    }, { signal: startupRegistrationLifetime.signal }).catch(() => ({ status: 'unavailable' as const })).then((result) => {
      logger.info(`${config.uiLogPrefix} Startup parent selection registration`, {
        status: result.status,
        durationMs: Math.round(performance.now() - parentRegistrationStartedAt),
      });
    })
    : Promise.resolve();
  if (typeof hookRuntime.setOnPromptDeliveryOutcome !== 'function') {
    throw new Error(
      'An admitted host Session runtime must provide the canonical provider delivery outcome port',
    );
  }
  connectedServiceApplicationSettledHandler =
    typeof hookRuntime.connectedServiceApplicationSettled === 'function'
      ? hookRuntime.connectedServiceApplicationSettled.bind(hookRuntime)
      : null;
  if (await terminalizeBeforeAgentAdmission()) return;
  const unbindProviderInputOutcome = bindSessionProviderInputOutcome({
    runtime: hookRuntime,
    observe: observeProviderInputOutcome,
    wakePendingMaterialization: () => currentLifecycleSession.wakePendingMaterialization?.(),
  });
  let runtimeModelsPublisher:
    | ReturnType<typeof createSessionRuntimeModelsPublisher>
    | null = null;
  let runtimeModesPublisher: ReturnType<typeof createSessionRuntimeModesPublisher> | null = null;
  const disposeRuntimeModelsPublisher = (): void => {
    runtimeModelsPublisher?.dispose();
    runtimeModesPublisher?.dispose();
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
    get sessionId() { return session.sessionId; },
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
  const modelMutationAccountCredentials = runtimeAuthority.scope === 'account' ? runtimeAuthority.accountCredentials : null;
  const modelMutationAccountId = modelMutationAccountCredentials ? readAccountIdFromToken(modelMutationAccountCredentials.token) : null;
  modelMutationScope = modelMutationAccountId ? {
    serverId: modelMutationAccountCredentials?.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId,
    accountId: modelMutationAccountId,
    sessionId: session.sessionId,
  } : undefined;
  modelTransitionCoordinator = createSessionModelTransitionCoordinator({
    runId: sessionTag,
    agentTargetKey: modelTargetKey,
    get ownerScope() { return modelMutationScope; },
    initialActiveTarget,
    isCurrentRun: () => modelTransitionOwnerCurrent,
    checkCurrentPublisherAuthority:
      checkCurrentModelPublisherAuthority,
    authorize: authorizeModelTransition,
    publishIntent: async (selection, expected, requiredBefore) => {
      const candidate = createModelIntentMetadataCasCandidate({
        selection,
        nowMs: () => Math.max(Date.now(), lastAcceptedModelIntentUpdatedAt + 1),
        ...(modelMutationScope ? { ownerScope: modelMutationScope } : {}),
        ...(requiredBefore ? { captureBefore: true, requiredBefore } : {}),
        ...(expected && modelMutationScope ? { expected: { owner: 'inactive', scope: modelMutationScope, ...expected } } : {}),
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
    async (rawRequest, rpcContext) => {
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
        'unarm' in request ? await modelTransitionCoordinator!.unarm(rpcContext?.callerInputConstraints)
        : await modelTransitionCoordinator!.submit(request.selection, {
          source: 'command',
          ...(request.applyTiming ? { applyTiming: request.applyTiming } : {}),
          ...(request.captureBefore !== undefined ? { captureBefore: request.captureBefore } : {}),
          ...(request.expected ? { expected: request.expected } : {}),
          ...(rpcContext?.callerInputConstraints ? { callerInputConstraints: rpcContext.callerInputConstraints } : {}),
        }),
      );
    },
  );
  runtimeForInFlightSteer = hookRuntime;
  applyMcpAccountPolicyUpdate?.();
  bindAgentRuntimeActivityProducer(session.sessionId);

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

      if (claimedSession.hasOwnerMetadataAuthority()) {
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
        if (!runtimeModesPublisher && hookRuntime.modes) {
          runtimeModesPublisher = createSessionRuntimeModesPublisher({
            agentId: config.policyAgentId,
            session: currentLifecycleSession,
            source: hookRuntime.modes,
          });
        }
        await runtimeModesPublisher?.flush();
      }
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
  recordStartupPhase('model_authority_publication');
  if (createdRuntime.prepareStartupPresentation) {
    const presentation = await createdRuntime.prepareStartupPresentation();
    terminalRemoteModeLoop = presentation.terminalRemoteModeLoop;
    presentationOwnsCurrentTerminalDisplay = presentation.ownsCurrentTerminalDisplay;
  }
  recordStartupPhase('startup_presentation');
  const initialGoal = readInitialGoalFromEnv();
  if (initialGoal || commitPendingFirstInputAfterRuntimeReady) {
    startupCoordinatorStart = async () => {
      if (initialGoal) {
        if (typeof nativeRuntime?.setGoal !== 'function') {
          throw new Error('Initial goal control is unavailable for the opened Agent runtime');
        }
        const goalOptions = {
          ...(initialGoal.status && initialGoal.status !== 'active' && initialGoal.status !== 'pending'
            ? { status: initialGoal.status }
            : {}),
          ...('tokenBudget' in initialGoal ? { tokenBudget: initialGoal.tokenBudget } : {}),
        };
        const result = await nativeRuntime.setGoal(
          initialGoal.objective,
          Object.keys(goalOptions).length > 0 ? goalOptions : undefined,
        );
        if (result && typeof result === 'object' && (
          ('ok' in result && result.ok === false)
          || ('status' in result && ['unavailable', 'unsupported', 'rejected'].includes(String(result.status)))
        )) {
          throw new Error('Initial goal was refused by the opened Agent runtime');
        }
        clearInitialGoalFromEnv();
      }
      const commit = commitPendingFirstInputAfterRuntimeReady;
      commitPendingFirstInputAfterRuntimeReady = null;
      await commit?.();
    };
  }

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
        await agentRuntimeActivityBinding?.revoke();
      } catch (error) {
        if (runtimeActivityApplicability === 'supported') {
          bindAgentRuntimeActivityProducer(session.sessionId);
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
      bindAgentRuntimeActivityProducer(session.sessionId);
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
  const capabilitySelectionAgentFacts = await resolveCapabilityApplyAgentFacts({ agentId: policyAgentId,
    registry: config.pluginRuntimeRegistryLease?.registry,
    metadata: { runtimeDescriptorV1: nativeRuntime?.runtimeDescriptorV1 ?? runtimeOpts.runtimeDescriptorV1 }, sessionRunning: true });
  const unsubscribeRuntimePublication = subscribeSessionRuntimePublicationToMetadata({
    session: currentLifecycleSession,
    sessionState: sessionStateBridge.engine,
    runtime,
    providerSessionMetadataKey: config.providerSessionMetadataKey,
    publishOwnerMetadata: currentLifecycleSession.hasOwnerMetadataAuthority(),
    capabilitySelection: capabilitySelectionAgentFacts,
    resolveCapabilitySelectionForDescriptor: descriptor => resolveCapabilityApplyAgentFacts({ agentId: policyAgentId,
      registry: config.pluginRuntimeRegistryLease?.registry,
      metadata: { runtimeDescriptorV1: descriptor }, sessionRunning: true }),
  });
  runtimePublicationMetadata = unsubscribeRuntimePublication;
  if (nativeRuntime) {
    const runtimeAuthControl = nativeRuntime.runtimeAuth;
    const runtimeAuthControls = runtimeAuthControl
      ? adaptAgentSessionRuntimeAuthControl({
          apply: async (request) => {
            await initialParentSelectionRegistration;
            return await runtimeAuthControl.apply(request);
          },
          readIdentity: (request) => runtimeAuthControl.readIdentity(request),
        })
      : null;
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
          resolveSystemAppendBlocks: async ({ sessionId, signal }) => {
            if (currentLifecycleSession.sessionId !== sessionId) throw new Error('Voice Session changed');
            const credentials = runtimeAuthority.scope === 'account' ? runtimeAuthority.accountCredentials : runtimeAuthority.sessionCredentials;
            const accountId = credentials ? readAccountIdFromToken(credentials.token) : null;
            const serverId = credentials?.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
            const prepared = await resolveCliVoicePromptPreparation({
              credentials,
              sessionMetadata: currentLifecycleSession.getMetadataSnapshot?.() ?? runtimeMetadata,
              roleContext: await sessionRoleContext.resolvePromptContext(signal, { modality: 'voice' }),
              machineId, directory: runtimeDirectory, signal,
              serverId, scope: accountId ? { serverId, accountId, sessionId } : null,
            });
            if (currentLifecycleSession.sessionId !== sessionId) throw new Error('Voice Session changed');
            return prepared.systemAppendBlocks;
          },
          ownerId: sessionTag,
          agentGeneration: voiceAuthority.occurrenceId,
          isOccurrenceCurrent: voiceAuthority.isCurrent,
          resolveProviderOccurrenceId: voiceAuthority.resolveProviderOccurrenceId,
          resolveRetirementSignal: voiceAuthority.resolveRetirementSignal,
          resolveConversation: voiceAuthority.resolveConversation,
        }).dispose;
    }
    currentLifecycleSession.setSessionRuntimeControls({
      readCodingPromptBehavior: () => resolveFreshSessionSystemPrompt?.readCodingPromptBehavior?.() ?? null,
      readEffectiveInputConfiguration: () => ({
        modelSelection: modelTransitionCoordinator?.readActiveTarget().selection ?? null,
        permissionMode: permissionModeState.getCurrentPermissionMode() ?? initialPermissionMode,
      }),
      readAppliedChildSelection: async (): Promise<ExecutionRunAppliedParentSelection> => {
        const unavailable = (
          reason: 'model_coordinator_unavailable' | 'model_transition_unavailable'
            | 'native_applied_selection_unavailable' | 'team_model_mismatch' | 'team_route_mismatch'
            | 'connected_services_read_failed' | 'connected_services_unavailable' | 'session_retired'
            | 'applied_target_changed' | 'native_applied_selection_changed',
          transition?: Readonly<{
            phase: 'before_connected_services' | 'after_connected_services';
            reason: SessionAppliedModelTransitionUnavailableReason;
          }>,
        ): ExecutionRunAppliedParentSelection => {
          logger.infoFile(`${config.uiLogPrefix} Applied parent selection unavailable`, {
            sessionId: currentLifecycleSession.sessionId, runnerPid: process.pid, reason,
            ...(transition ? { transitionPhase: transition.phase, transitionReason: transition.reason } : {}),
          });
          return { status: 'unavailable' };
        };
        await initialParentSelectionRegistration;
        if (!modelTransitionCoordinator) return unavailable('model_coordinator_unavailable');
        const before = await modelTransitionCoordinator.readAppliedTarget();
        if (before.status !== 'applied') return unavailable('model_transition_unavailable', {
          phase: 'before_connected_services', reason: before.reason,
        });
        const appliedTarget = before.target;
        const teamCredentialModel = hookRuntime.readAppliedTeamCredentialModel?.();
        if (teamCredentialModel === undefined) return unavailable('native_applied_selection_unavailable');
        if (teamCredentialModel && teamCredentialModel.modelId !== appliedTarget.selection.modelId) return unavailable('team_model_mismatch');
        if (teamCredentialModel && appliedTarget.selection.providerConnectionId !== null) return unavailable('team_route_mismatch');
        const connected = await readAppliedParentConnectedServices({
          sessionId: currentLifecycleSession.sessionId, runnerPid: process.pid, agentId: policyAgentId,
        }, { signal: startupRegistrationLifetime.signal }).catch(() => null);
        if (startupRegistrationLifetime.signal.aborted) return unavailable('session_retired');
        if (!modelTransitionCoordinator) return unavailable('model_coordinator_unavailable');
        const after = await modelTransitionCoordinator.readAppliedTarget();
        if (connected === null) return unavailable('connected_services_read_failed');
        if (connected.status !== 'applied') return unavailable('connected_services_unavailable');
        if (after.status !== 'applied') return unavailable('model_transition_unavailable', {
          phase: 'after_connected_services', reason: after.reason,
        });
        if (after.target !== appliedTarget) return unavailable('applied_target_changed');
        if (JSON.stringify(hookRuntime.readAppliedTeamCredentialModel?.()) !== JSON.stringify(teamCredentialModel)) {
          return unavailable('native_applied_selection_changed');
        }
        const unknownNativeModel = !teamCredentialModel && appliedTarget.selection.modelId === 'default'
          && appliedTarget.selection.providerConnectionId === null;
        return {
          status: 'applied',
          backendTarget: runtimeOpts.backendTarget ?? { kind: 'backend', backendId: policyAgentId },
          modelId: unknownNativeModel ? null : appliedTarget.selection.modelId,
          ...(teamCredentialModel ? { teamCredentialModel } : unknownNativeModel ? {} : { modelSelection: appliedTarget.selection }),
          connectedServices: filterSuppressedConnectedServiceBindings({
            bindings: connected.connectedServices,
            suppressConnectedServiceIds: appliedTarget.runtimeBindingBasis?.agentSupport.authIsolation.suppressConnectedServiceIds ?? [],
          }).bindings,
        };
      },
      ...(readWorkflowInputPort() ? { withdrawWorkflowStepInput: async (input: Readonly<{ localInputId: string }>) => {
        if (!config.hostContextOnlyInput && await readWorkflowDispatchFact(input.localInputId, new AbortController().signal) === 'dispatched') {
          workflowStepWithdrawal.observeWorkflowStepDispatched(input);
        }
        return workflowStepWithdrawal.withdrawWorkflowStepInput(input);
      } } : {}),
      ...(daemonTurnContributionsBridge
        ? {
            resolveComposerReference: async (input) =>
              await daemonTurnContributionsBridge.resolveComposerReference({
                sessionId: currentLifecycleSession.sessionId,
                ...input,
              }),
            resolveComposerAttachmentForDispatch: async (input) =>
              await daemonTurnContributionsBridge.resolveComposerAttachment(
                projectSessionComposerAttachmentDispatchInput(input, currentLifecycleSession.sessionId),
              ),
          }
        : {}),
      ...(nativeRuntime.managedProviderRunServices ? { managedProviderRunServices: nativeRuntime.managedProviderRunServices } : {}),
      ...(typeof nativeRuntime.prepareRunTeamCredentialProviderBinding === 'function'
        ? { prepareRunTeamCredentialProviderBinding: nativeRuntime.prepareRunTeamCredentialProviderBinding.bind(nativeRuntime) }
        : {}),
      ...(typeof nativeRuntime.refreshGoal === 'function' ? { refreshGoal: nativeRuntime.refreshGoal.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.setGoal === 'function' ? { setGoal: nativeRuntime.setGoal.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.clearGoal === 'function' ? { clearGoal: nativeRuntime.clearGoal.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.listVendorPlugins === 'function' ? { listVendorPlugins: nativeRuntime.listVendorPlugins.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.listSkills === 'function' ? { listSkills: nativeRuntime.listSkills.bind(nativeRuntime) } : {}),
      readSkillDelivery: () => readAppliedSessionSkillDelivery({
        current: runnerSkills,
        initialDelivery: sessionRuntimeParams.skills,
        skillsDelivered,
      }),
      ...(typeof nativeRuntime.startInlineReview === 'function' ? { startInlineReview: nativeRuntime.startInlineReview.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.invalidateConnectedServiceAuthTransports === 'function'
        ? { invalidateConnectedServiceAuthTransports: nativeRuntime.invalidateConnectedServiceAuthTransports.bind(nativeRuntime) }
        : {}),
      ...(runtimeAuthControls
        ? runtimeAuthControls
        : {}),
      ...(typeof nativeRuntime.enableUsageLimitWaitResume === 'function' ? { enableUsageLimitWaitResume: nativeRuntime.enableUsageLimitWaitResume.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.cancelUsageLimitWaitResume === 'function' ? { cancelUsageLimitWaitResume: nativeRuntime.cancelUsageLimitWaitResume.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.checkUsageLimitRecoveryNow === 'function' ? { checkUsageLimitRecoveryNow: nativeRuntime.checkUsageLimitRecoveryNow.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.consumeUsageLimitResetCredit === 'function' ? { consumeUsageLimitResetCredit: nativeRuntime.consumeUsageLimitResetCredit.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.clearTerminalComposer === 'function' ? { clearTerminalComposer: nativeRuntime.clearTerminalComposer.bind(nativeRuntime) } : {}),
      ...(typeof nativeRuntime.interruptPendingInputAndRun === 'function'
        ? { interruptPendingInputAndRun: nativeRuntime.interruptPendingInputAndRun.bind(nativeRuntime) }
        : {}),
      ...(typeof nativeRuntime.readActiveTurnInputId === 'function'
        ? { readActiveTurnInputId: nativeRuntime.readActiveTurnInputId.bind(nativeRuntime) }
        : {}),
      cancelActiveTurn: nativeRuntime.cancelTurn.bind(nativeRuntime),
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
  // Activity publication waits for durable delivery, which takeover starts only
  // after the exact runtime binding is acknowledged.
  await runtimeActivityProjection.reofferCurrentSnapshot();
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
  recordStartupPhase('runtime_controls');
  try {
    await runSessionLoopLifecycleFn({
      opts: runtimeOpts,
      config: {
        ...config,
        mcpServerIdentities,
        readSkillDelivery: () => readAppliedSessionSkillDelivery({ current: runnerSkills,
          initialDelivery: sessionRuntimeParams.skills, skillsDelivered }),
        skillUsageAccount: runtimeAuthority.scope === 'account' && runtimeAuthority.accountCredentials
          && readAccountIdFromToken(runtimeAuthority.accountCredentials.token)
          ? { accountId: readAccountIdFromToken(runtimeAuthority.accountCredentials.token)!,
              serverHttpBaseUrl: currentLifecycleSession.getServerBinding().serverUrl }
          : undefined,
        ...(presentationOwnsCurrentTerminalDisplay ? { shouldRenderTerminalDisplay: () => false } : {}),
        onRuntimeStopReady: (stop) => {
          runtimeStopDelegate = stop;
          dispatchRuntimeStop();
        },
        publishHostRuntimeEvent: (event) => {
          observeAgentRuntimeActivityEvent(event);
          unsubscribeRuntimePublication.observeRuntimeEvent(event);
          if (event.kind === 'usage-observed' && event.context) {
            latestSessionContextUsage = event.context;
            publishSessionFollowWakeInvalidation();
          }
          config.publishHostRuntimeEvent?.(event);
        },
      },
      api,
      session: currentLifecycleSession,
      sessionIsNew: currentLifecycleSession.sessionId === initialSessionId ? sessionIsNew : false,
      runtime,
      hookRuntime,
      terminalRemoteModeLoop,
      capabilitySelection: {
        agent: capabilitySelectionAgentFacts,
        initialSkillRules: runnerSkills?.reach,
        initialMcpRules: runnerMcpReach,
        readMcpRules: () => {
          if (!isSessionOpenAccountCurrent() || !runnerMcpReach) return null;
          const snapshot = readSessionOpenAccountOperation()?.readSnapshot();
          if (snapshot?.mcpServerCatalog?.status !== 'ready' || snapshot.mcpServerCatalog.authority !== 'active') return null;
          const settings = readMcpServersSettingsFromAccountSettings(snapshot);
          return { context: runnerMcpReach.context, settings,
            mcpPluginItems: runnerMcpReach.mcpPluginItems.map(item => ({ ...item,
              rules: settings.bindings.filter(rule => rule.serverId === item.itemId) })) };
        },
        readSkillRules: () => {
          if (!isSessionOpenAccountCurrent() || !runnerSkills?.reach) return null;
          const snapshot = readSessionOpenAccountOperation()?.readSnapshot();
          if (!snapshot?.promptLibraryCatalog) return null;
          const read = readPromptLibraryCatalogRecordV1({ catalog: snapshot.promptLibraryCatalog, key: 'skill-rules',
            rawSettings: snapshot.source === 'none' ? undefined : snapshot.rawSettings });
          return read.status === 'ready' && read.record.key === 'skill-rules'
            ? { context: runnerSkills.reach.context, rules: read.record.value.rules } : null;
        },
        subscribeAccountSettings: listener => {
          observeCapabilityAccountSettings = listener;
          return () => { if (observeCapabilityAccountSettings === listener) observeCapabilityAccountSettings = null; };
        },
        ...(runtimeAuthority.scope === 'account' && runtimeAuthority.accountCredentials ? { skillsRunner: {
          readInput: () => ({
            ownerKey: currentLifecycleSession.sessionId, agentId: policyAgentId, machineId, directory: runtimeDirectory,
            sessionMetadata: currentLifecycleSession.getMetadataSnapshot(), credentials: runtimeAuthority.accountCredentials,
            accountSnapshot: readSessionOpenAccountOperation()?.readSnapshot() ?? null,
            operationContext: readSessionOpenAccountOperation(),
            contributes: config.pluginRuntimeRegistryLease?.registry.contributes, agentHasActionChannel: agentToolsDelivery !== 'unsupported',
            isCurrent: () => getActiveAccountSettingsSnapshot()?.scopeKey === mcpAccountScopeKey
              && getActiveAccountSettingsSnapshotLifetimeToken() === mcpAccountLifetimeToken,
          }),
          runtime: nativeRuntime,
          onApplied: (result: RunnerSkillsResult) => {
            runnerSkills = result;
            void publishRunnerSkillNotice(currentLifecycleSession, result).catch(error =>
              logger.debug('[HOST RUNTIME] Skill notice publication failed', { error: String(error) }));
          },
        } } : {}),
      },
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
      registerProviderAcceptedEffect,
      resolveSessionRolePromptContext,
      resolveFreshSessionSystemPrompt,
      prepareSessionRolePromptPolicy,
      setAbortRequestedCallback: (callback, readSignal) => {
        abortRequestedCallback = callback;
        readHostTurnAbortSignal = readSignal;
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
          startupRegistrationLifetime.abort();
          await runtimeModelsPublisher?.stopAndDrain();
          await runtimeModesPublisher?.stopAndDrain();
          await deps.sessionLoopLifecycleDeps?.onBeforeSessionClose?.(params);
        },
        runPermissionModePromptLoopFn: async (loopParams) => await (deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop)({
          ...loopParams,
          inputConsumer,
          prepareHostContext: effectivePrepareHostContext,
        }),
      },
      initialResumeId,
      onStrictInitialResumeFailure: async ({ resumeId, error }) => {
        if (isAgentNativeResumeIdentityMismatchError(error)) {
          await invalidateTrackedNativeReturnIdentity(resumeId);
        }
      },
    });
  } finally {
    await modelTransitionCoordinator.dispose();
    modelTransitionOwnerCurrent = false;
    modelTransitionCoordinator = null;
    unbindProviderInputOutcome();
    acceptedEffectByPendingLocalId.clear();
    currentLifecycleSession.setSessionRuntimeControls(null);
    config.onAfterStart = originalOnAfterStart;
    sessionStateMetadataObserver.dispose();
    disposeRuntimeModelsPublisher();
    unsubscribeExecutionRunActivity?.();
    runtimeActivityProjection?.dispose();
    unsubscribePendingQueueDeliveryTiming();
    unsubscribeSessionLiveWork();
    unsubscribeRuntimePublication();
    if (!startupCoordinatorStart) {
      await startupBootstrapCleanup?.();
    }
  }
  } catch (error) {
    if (runtimeStopRequested) rejectRuntimeStop(error);
    let preparationFailurePublished = false;
    if (!lifecycleOwnsConstructionResources) {
      if (hostOwnsSessionConstructionCleanup) {
        if (!runtimeStopRequested) logger.infoFile(`${config.uiLogPrefix} Session construction failed`, {
          sessionId: session.sessionId,
          phase: startupPhase,
          ...readSessionPreparationFailureDiagnostic(error),
        });
        const startupIssue = !runtimeStopRequested ? classifyPrimarySessionRuntimeIssue({
          cause: 'session_error', error, provider: policyAgentId,
        }) : null;
        if (startupIssue && (error instanceof DaemonPluginToolCatalogUnavailableError
          || error instanceof PromptStackPreparationError
          || startupIssue.code === 'preparation_pending' && startupIssue.source === 'dependency_failure')) {
          // Required preparation resolves after Session custody, before the live loop owns a
          // turn lifecycle. Publish through that same canonical owner before
          // releasing durable delivery; an unavailable prerequisite is not idle.
          await createSessionTurnLifecycle({ session, agentId: policyAgentId }).failTurn({
            issue: startupIssue,
            allocateWhenIdle: true,
          });
          preparationFailurePublished = startupIssue.code === 'preparation_pending'
            && startupIssue.source === 'dependency_failure';
        }
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
    // Required context can become unavailable before a native runtime exists.
    // Its typed failure and retained input already own recovery; after normal
    // construction cleanup, do not promote that refusal to an unhandled CLI crash.
    if (preparationFailurePublished) return;
    throw error;
  }
  } finally {
    startupRegistrationLifetime.abort();
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
): CanonicalHostSessionRuntimeRunOptions & Readonly<{ launchControlMetadata: SessionLaunchControlMetadata }> {
  const parsedAgentTarget = opts.backendTarget
    ? AgentExecutionTargetV1Schema.safeParse(opts.backendTarget)
    : null;
  return {
    credentials: opts.credentials,
    ...(opts.initialAccess !== undefined ? { initialAccess: opts.initialAccess } : {}),
    ...(opts.primaryTeamId !== undefined ? { primaryTeamId: opts.primaryTeamId } : {}),
    ...(opts.teamCredentialBindings !== undefined ? { teamCredentialBindings: opts.teamCredentialBindings } : {}),
    ...(opts.sessionCreationTag
      ? { sessionCreationTag: SessionCreationTagV1Schema.parse(opts.sessionCreationTag) }
      : {}),
    ...(opts.sessionCreationCorrespondence
      ? { sessionCreationCorrespondence: SessionCreationCorrespondenceV1Schema.parse(opts.sessionCreationCorrespondence) }
      : {}),
    ...(opts.placementOrigin
      ? { placementOrigin: MachinePoolSelectionOriginV1Schema.parse(opts.placementOrigin) }
      : {}),
    ...(typeof opts.initialTitle === 'string' && opts.initialTitle.trim().length > 0
      ? { initialTitle: opts.initialTitle.trim() }
      : {}),
    directory: opts.directory,
    ...(opts.backendTarget
      ? {
          backendTarget: parsedAgentTarget?.success
            ? parsedAgentTarget.data
            : readBackendTargetRefV2(BackendTargetRefV2InputSchema.parse(opts.backendTarget)),
        }
      : {}),
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
    ...(opts.sessionAttachSecret ? { sessionAttachSecret: opts.sessionAttachSecret } : {}),
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
