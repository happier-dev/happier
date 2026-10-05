import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { createWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createWidgetRefreshActionDepsV1 } from './widgetRefreshActionDeps';
import { createWidgetDefinitionActionDepsV1 } from './widgetDefinitionActionDeps';
import { executeComposerIngressAction } from './composerIngressActionRuntime';
import { createWidgetCompanionActionDepsV1 } from './widgetCompanionActionDeps';
import { readWidgetEntityMovementAdmission } from './widgetEntityMovement';
import type { WidgetInstanceRefV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { forgetHistoricalEncryptionKey } from '@/sync/ops/account/forgetHistoricalEncryptionKey';
import { recoverHistoricalAutomationTemplates } from '@/sync/ops/account/recoverHistoricalAutomationTemplates';
import { startAgentSignInRpc, checkAgentSignInRpc } from '@/agents/machineAgents/signIn/api';
import {
  buildSessionPermissionRespondRpcParamsV1,
  buildMachineAgentsDetectRequest,
  projectMachineAgentsDetectResponse,
  MachineAgentInventoryUnavailableError,
  approvalArtifactBodyMatchesHeaderV1,
  buildApprovalRequestArtifactHeaderV1,
  ApprovalRequestSchema,
  normalizeActionsSettingsV1,
  buildBackendTargetKeyV2,
  createActionExecutor,
  createPromptDocInLibrary,
  setPromptDocFavorite,
  listPromptLibrary,
  readPromptDocInLibrary,
  updatePromptDocInLibrary,
  listPromptInvocationsInLibrary,
  resolvePromptInvocationInLibrary,
  getActionSpec,
  createLaunchProfilePublisherV1,
  createWorkBoardArtifactPortV1,
  createArtifactAccessActionsV1,
  createAccountRoleActionExecutorV1,
  isRoleActionIdV1,
  RoleActionInputSchemasV1,
  RoleActionOutputSchemasV1,
  PluginRoleDeclarationV1Schema,
  resolveInvocationAuthority,
  getSharedBlockingApprovalCoordinator,
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  PluginWebhookActionHttpPathsV1,
  type PluginWebhookPresentUserActionIdV1,
  projectPluginFailureText,
  requiresExactDaemonApprovalReplay,
  SessionModelTransitionRequestV1Schema,
  SessionModelTransitionResultV1Schema,
  type ActionExecutorContext,
  type ActionExecutorDeps,
  type ActionExecuteResult,
  type ActionId,
  type AutomationV3Settings,
  type ArtifactPublicLinkIssuedV1,
  type ApprovalRequest,
  type SessionModelTransitionRequestV1,
  type SessionModelTransitionResultV1,
  type SessionInputAdmissionResultV1,
  MemorySearchResultV1Schema,
  supportsMachineOperationProtocolCapabilityV1,
  supportsMachineSessionSpawnProtocolVersionV1,
  readServerEnabledBit,
  projectSessionFollowSourceKeyPreparationAfterSetV1,
  type SessionFollowActionOutputV1,
  type SessionFollowSourceKeyPreparationResultV1,
} from '@happier-dev/protocol';
import { loadDaemonMergedProjectionInputs, loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { machineWorkspaceFileSearch } from '@/sync/ops/machineWorkspaceFileSearch';
import { randomUUID } from '@/platform/randomUUID';
import { executeCurrentUiContextAction, executeCurrentUiContextContributedAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import { buildMachineAgentInventoryDescriptors } from '@/agents/machineAgents/machineAgentCatalog';
import {
  startAgentInstallJobRpc,
  readAgentInstallJobRpc,
  cancelAgentInstallJobRpc,
} from '@/agents/machineAgents/installJobs/api';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  projectSessionBoardAdapterFailureV1,
  projectSessionBoardFeatureDecisionFailureV1,
  type SessionBoardActionFailureV1,
  type SessionBoardOutcomeUnknownDetailsV1,
} from '@happier-dev/protocol/sessions/board';
import {
    resolveAmbientProviderConnectionForModelIntent,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
  createModelIntentMetadataCasCandidate,
  runModelIntentAtAuthoritativeDisposition,
} from '@happier-dev/agents/session/state/metadataWriters';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HappyError } from '@/utils/errors/errors';

import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { createWidgetCatalogActionDepsV1 } from './widgetCatalogActionDeps';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureMountedWorkspaceAction, invokeWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { invokeSessionCanvasAction } from '@/components/sessions/canvas/sessionSplitCanvasRuntime';
import { invokeWorkflowConversationBinding } from './workflowAuthoringAction';
import { invokeSessionListOrganizationAction } from '@/components/sessions/shell/drag/sessionListOrganizationAction';
import { createSessionOrganizationMutationScopeForAccount } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { scmReviewComparisonOfSource } from '@/sync/domains/scm/diffSummary/selection';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { createSettingsDeclarationAction, resolveSettingsDeclarationOperationApprovalRequired } from './settingsDeclarationAction';
import { getAutomationSettings, updateAutomationSettings } from '@/sync/api/automations/apiAutomations';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { createAppShellAction } from './appShellAction';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';
import { executeAppUpdateAction } from '@/updates/appUpdateActionRuntime';
import { executeExternalSessionBrowseAction } from './externalSessionBrowseAction';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import { createUiScmAction } from './scmActionDeps';
import { resolveSettingsHost, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { executeCommandPaletteAction } from '@/components/appShell/commandPalette/commandPaletteActionRuntime';
import { executeFindAction } from '@/keyboard/findActionRuntime';
import { executePromptPickerOpenAction } from '@/components/sessions/agentInput/commandMenu/promptPickerActionRuntime';
import { invokeNextPendingRequest } from '@/activity/source/pendingNavigationRuntime';
import { executeApiTokenAction, type ApiTokenActionTransport } from './apiTokenActionTransport';
import { createMachinePoolActionClient, MachinePoolActionError } from '@/sync/api/machines/machinePoolActions';
import { createRunnerActivationClient, RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { RunnerActivationCreateRequestV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { publishDisplayTitleToMetadata } from '@/sync/state/displayTitlePublish';
import { createUiExecutionRunActionDeps } from './executionRunActionDeps';
import { createMachineConnectionActionDeps } from './machineConnectionActionDeps';
import {
    forkSession as forkSessionOp,
    rollbackSessionCheckpointCode as rollbackSessionCheckpointCodeOp,
    rollbackSessionConversation as rollbackSessionConversationOp,
    sessionStopWithServerScope,
    resumeSession,
} from '@/sync/ops/sessions';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import { readAgentScopedPluginSettingsSnapshot } from '@/agents/registry/agentScopedPluginSettings';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import {
  preflightWorkspaceDestinationReplacement,
  startSessionHandoff as startSessionHandoffOp,
} from '@/sync/ops/sessionHandoffs';
import { createWorkspaceSyncRelationshipOnController } from '@/sync/ops/workspaceSyncRelationshipCreateRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import {
  sendSessionMessageWithServerScope,
  type ServerScopedSessionSendMessageResult,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { dispatchSessionSpawnNewWithReportsToPreparation } from './sessionSpawnNewAction';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  authorizeMemorySessionRange,
  authorizeMemorySearchResult,
  captureMemorySearchSessionReadAuthority,
  readMemorySearchSessionForServerScope,
  readMemorySearchSessionHydrationConcurrencyLimit,
} from '@/sync/domains/memory/hydrateMemorySearchSessionTargets';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { storage } from '@/sync/domains/state/storage';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { resolveSessionForkStrategyAvailability } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveSessionForkReplayOptions } from '@/sync/domains/sessionFork/resolveSessionForkReplayOptions';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import {
  areServerProfileIdentifiersEquivalent,
  resolveServerProfileForPortableIdentity,
  resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { openSessionForVoiceTool } from '@/voice/tools/actionImpl/openSession';
import { resolveVoiceActionSessionReference } from '@/voice/tools/actionImpl/resolveVoiceActionSessionReference';
import { acquireAdmittedSessionReferenceCorpusOptions } from '@/voice/tools/actionImpl/admittedSessionReferenceCorpus';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { setPrimaryActionSessionId, setTrackedSessionIds } from '@/voice/tools/actionImpl/sessionTargets';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { getSessionActivityForVoiceTool } from '@/voice/tools/actionImpl/sessionActivity';
import {
  getSessionRecentMessagesForVoiceTool,
  getSessionTranscriptForVoiceTool,
} from '@/voice/tools/actionImpl/sessionRecentMessages';
import { listRecentPathsForVoiceTool } from '@/voice/tools/actionImpl/pathsListRecent';
import { listProjectsForActions } from './listProjects';
import {
  listPromptInvocationsForActions,
  resolvePromptInvocationForActions,
} from './resolvePromptInvocations';
import { listSpawnProfilesForActions } from './listSpawnProfiles';
import { projectUiAiLaunchProfileSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import {
  listAgentConfigOptionsForActions,
  listAgentSessionModesForActions,
  listSpawnConnectedServicesForActions,
  resolveSessionSpawnAgentInventorySelectionForActions,
} from './agentInventoryActionDeps';
import { listMachinesForVoiceTool } from '@/voice/tools/actionImpl/machinesList';
import { listServersForVoiceTool } from '@/voice/tools/actionImpl/serversList';
import { listReviewEnginesForVoiceTool } from '@/voice/tools/actionImpl/reviewEnginesList';
import { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } from '@/voice/tools/actionImpl/agentCatalogList';
import { createReviewCommentsHttpActionExecutor } from '@/sync/domains/reviews/comments/api';
import { createPluginPermissionGrantHttpActionExecutor } from '@/sync/domains/plugins/permissions/api';
import { createPluginWebhookEndpointHttpActionExecutor } from '@/sync/api/plugins/webhooks/endpointActions';
import { sessionFollowAction } from '@/sync/api/session/sessionFollowApi';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';
import { sessionReadStateAction } from '@/sync/api/session/sessionReadStateAction';
import { executeSessionAttentionSetAction } from '@/sync/ops/sessionOrganization/setSessionAttentionStanding';
import { createSessionReportsToAction } from '@/sync/api/session/sessionReportsToAction';
import { createSessionBoardActionAdapter } from '@/sync/api/session/sessionBoardActions';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { sync } from '@/sync/sync';
import { executeListReorderAction } from './listReorderAction';
import { executeTodoSessionLinkAction } from './todoSessionLinkAction';
import { createHomeDomainActionExecutorForScope } from '@/sync/api/home/homeDomainActions';
import { createSessionOrganizationResourceAction, isSessionOrganizationResourceAction } from '@/sync/ops/sessionOrganization/sessionOrganizationAction';
import { resolveSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { writeApprovalRequestArtifact } from './approvalArtifactWriter';
import { publishAcpSessionModeOverrideToMetadata } from '@/sync/state/acpSessionModeOverridePublish';
import { createUiPromptLibraryArtifactStore, uiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { updateSkillPromptBundle } from '@/sync/ops/promptLibrary/promptBundles';
import { writePromptLibraryArtifactToExternalAsset } from '@/sync/ops/promptLibrary/exportPromptLibraryArtifact';
import { installPromptRegistryItem } from '@/sync/ops/promptLibrary/installPromptRegistryItem';
import { canRollbackConversation } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { completeSessionForkNavigation } from '@/sync/domains/sessionFork/completeSessionForkNavigation';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { createUiWorkflowAction } from './workflowActionDeps';
import { createUiNotificationActionDeps } from './notificationActionDeps';
import {
  resolveSessionActionDefaultBackend,
  resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';

import {
  isRequestedSessionModeSupported,
  isSessionModeActionAvailable,
  normalizeRequestedSessionModeId,
  resolveSessionModeActionControl,
  serializeSessionModeActionOptions,
} from './sessionModeActionSupport';
import {
  createDefaultRuntimeActionExecutor,
  type CreateDefaultRuntimeActionExecutorInput,
} from './defaultRuntimeActionExecutor';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { executeAccountPluginDataEraseAction } from '@/sync/domains/plugins/settings/accountPluginDataEraseAction';
import { invokeScopeAction } from './scopeActionFamily';
import { signOutEverywhere } from '@/sync/api/account/signOutEverywhere';
import {
    createCurrentAccountApiToken,
    listCurrentAccountApiTokens,
    revokeAllCurrentAccountApiTokens,
    updateCurrentAccountApiToken,
    revokeCurrentAccountApiToken,
} from '@/sync/api/account/apiTokens';
import {
  enrollAccountPassword,
  fetchAccountSecurity,
  requestAccountSignInEmailChange,
  setAccountTerminalPresentUserPolicy,
  submitAccountPasswordChange,
  submitAccountPasswordRemove,
} from '@/sync/api/auth/accountSecurity';

/**
 * Scope retirement discards Account-owned result content but cannot undo a sent
 * write, so the invocation reports back the exact packet the adapter froze for
 * this Home and Session before dispatch. Nothing else can be an `outcome_unknown`
 * answer: without that packet there is no ambiguous write to reconcile, and the
 * retirement stays a definite refusal.
 */
export function projectRetiredSessionBoardActionFailure(input: Readonly<{
  mutationDispatched: boolean;
  retirementStatus: string;
  recoveryDetails: SessionBoardOutcomeUnknownDetailsV1 | null;
}>): SessionBoardActionFailureV1 {
  if (!input.mutationDispatched || !input.recoveryDetails) {
    return projectSessionBoardAdapterFailureV1({ code: input.retirementStatus }, 'forbidden');
  }
  return {
    ok: false,
    errorCode: 'outcome_unknown',
    error: 'outcome_unknown',
    details: input.recoveryDetails,
  };
}

/** Canonical Action projection of the scoped sender's transport envelope. */
export function projectServerScopedSessionSendMessageResult(
  delivery: ServerScopedSessionSendMessageResult,
): SessionInputAdmissionResultV1 | Extract<ServerScopedSessionSendMessageResult, { ok: false }> {
  if (!delivery.ok) return delivery;
  const ack = delivery.ack && typeof delivery.ack === 'object' && !Array.isArray(delivery.ack)
    ? delivery.ack as Readonly<Record<string, unknown>>
    : null;
  const localId = typeof ack?.localId === 'string' ? ack.localId.trim() : '';
  if (!localId) {
    return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  }
  return ack?.accepted === true
    ? { status: 'accepted', localId }
    : { status: 'outcomeUnknown', localId, code: 'session_input_pending' };
}

  type OpenSessionOptions = Readonly<{ serverId?: string | null; query?: Readonly<Record<string, string>> }>;

function projectSessionInteractionRpcResult(result: unknown): unknown {
  return result === undefined || result === null ? { ok: true } : result;
}

export type ApprovalReplayRoute = Readonly<{
  serverId: string;
  serverIdentityId: string;
  originServerId: string;
}>;

export function isApprovalExecutionOriginCurrentForAccountContext(input: Readonly<{
  origin: Readonly<{
    serverId: string;
    serverIdentityId?: string;
    accountId?: string;
  }>;
  accountServerId: string;
  accountId: string;
}>): boolean {
  if (input.origin.accountId && input.origin.accountId !== input.accountId) return false;
  const serverIdentityId = input.origin.serverIdentityId?.trim() ?? '';
  if (serverIdentityId) {
    const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
    return resolution.kind === 'resolved'
      && resolution.profile.serverIdentityId?.trim() === serverIdentityId
      && areServerProfileIdentifiersEquivalent(resolution.profile.id, input.accountServerId);
  }
  return areServerProfileIdentifiersEquivalent(input.origin.serverId, input.accountServerId);
}

/**
 * Re-exported from the Protocol owner of `ApprovalExecutionOriginV1`: the list
 * of origin facts this client cannot verify belongs beside the schema that
 * introduces them, not in a hand-maintained consumer-side enumeration.
 */
export { requiresExactDaemonApprovalReplay };

export function resolveApprovalReplayRoute(approval: ApprovalRequest | null): ApprovalReplayRoute | null {
  if (approval?.v !== 2) return null;
  const originServerId = approval.executionOriginV1.serverId.trim();
  const serverIdentityId = approval.executionOriginV1.serverIdentityId?.trim() ?? '';
  if (!originServerId || !serverIdentityId) return null;
  const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
  if (
    resolution.kind !== 'resolved'
    || resolution.profile.serverIdentityId?.trim() !== serverIdentityId
  ) return null;
  return {
    serverId: resolution.profile.id,
    serverIdentityId,
    originServerId,
  };
}

export async function replayApprovalRequestAtExactDaemon(input: Readonly<{
  artifactId: string;
  decision: 'approve' | 'reject';
  executionTarget: Readonly<{
    /** Current-device profile id used only to route the RPC transport. */
    serverId: string;
    machineId: string;
    /** Stable Home identity used by the daemon to fail closed on a wrong route. */
    serverIdentityId?: string;
    /** Immutable creator-local profile id retained as replay currentness evidence. */
    originServerId?: string;
  }>;
  signal?: AbortSignal;
}>): Promise<unknown> {
  return await machineRpcWithServerScope({
    serverId: input.executionTarget.serverId,
    machineId: input.executionTarget.machineId,
    method: RPC_METHODS.APPROVAL_REQUEST_DECIDE,
    payload: {
      artifactId: input.artifactId,
      decision: input.decision,
      serverId: input.executionTarget.serverId,
      ...(input.executionTarget.serverIdentityId
        ? { serverIdentityId: input.executionTarget.serverIdentityId }
        : {}),
      ...(input.executionTarget.originServerId
        ? { originServerId: input.executionTarget.originServerId }
        : {}),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/**
 * Routes consumption of an already-approved built-in Action Artifact to its
 * exact daemon. No decision or authority crosses this private transport.
 */
export async function replayApprovedApprovalRequestAtExactDaemon(input: Readonly<{
  artifactId: string;
  executionTarget: Readonly<{
    /** Current-device profile id used only to route the RPC transport. */
    serverId: string;
    machineId: string;
    /** Stable Home identity retained by the replay route; not part of this payload. */
    serverIdentityId?: string;
    /** Immutable creator-local profile id retained by the replay route; not part of this payload. */
    originServerId?: string;
  }>;
  signal?: AbortSignal;
}>): Promise<ActionExecuteResult> {
  return await machineRpcWithServerScope<ActionExecuteResult, Readonly<{ artifactId: string }>>({
    serverId: input.executionTarget.serverId,
    machineId: input.executionTarget.machineId,
    method: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
    payload: { artifactId: input.artifactId },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function settleAccountSecurityAction<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HappyError && error.code) {
      return { ok: false as const, errorCode: error.code, error: error.message };
    }
    // Not reaching the Home is its own typed outcome. Left untyped it would settle as a generic
    // failure, which the form copy could not tell apart from a refusal of the person's credentials.
    // An issued mutation never reaches here as a transport error: it settles as `outcome_unknown`.
    if (isTransientConnectivityError(error)) {
      return { ok: false as const, errorCode: 'server_unreachable', error: 'server_unreachable' };
    }
    throw error;
  }
}

  function buildDefaultActionExecutor(opts?: Readonly<{
  /** An explicitly admitted API-token transport; Home owns grants and approvals. */
  apiTokenAction?: ApiTokenActionTransport;
  /** Private Machine reverse-RPC continuation: admission/approval happened in the daemon. */
  admittedClientAction?: true;
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
  openSession?: (sessionId: string, options?: OpenSessionOptions) => void | Promise<void>;
  runtimeActions?: CreateDefaultRuntimeActionExecutorInput;
  listContributedActionDefinitions?: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>;
  readContributedActionSchemas?: NonNullable<ActionExecutorDeps['readContributedActionSchemas']>;
  /** Optional surface-local policy composed with the canonical Action settings policy. */
  isActionEnabled?: NonNullable<ActionExecutorDeps['isActionEnabled']>;
  /** Optional delivery leaf used by a surface that needs specialized ingress semantics. */
  sessionSendMessage?: NonNullable<ActionExecutorDeps['sessionSendMessage']>;
  /** Mounted host resolver carrying an explicitly complete selected-Home corpus. */
  resolveSessionReference?: NonNullable<ActionExecutorDeps['resolveSessionReference']>;
  /** Current external Agent declaration supplied by a rendered lifecycle control. */
  currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
  /**
   * The Session-access family port, supplied by a surface that already knows the
   * exact Account scope, availability and staleness lifetime the request belongs
   * to. Those are per-mount facts the shared executor cannot resolve, so the
   * surface owns reachability while the executor keeps admission and validation.
   */
  sessionAccessAction?: NonNullable<ActionExecutorDeps['sessionAccessAction']>;
  /** Local keyholding-host delivery; never enters Action input, approval or result. */
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  /** Optional Session human-discussion family port bound by a mounted surface. */
  sessionDiscussionAction?: NonNullable<ActionExecutorDeps['sessionDiscussionAction']>;
  /**
   * The Home family port, bound by the caller to the exact Home and Account.
   * Without it, the shared executor rejects Home and Teams actions as unsupported.
   */
  homeDomainAction?: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  /** Subordinate target-bound transport for a confirmed workspace conflict Action. */
  workspaceSyncConflictResolve?: NonNullable<ActionExecutorDeps['workspaceSyncConflictResolve']>;
  workflowAction?: NonNullable<ActionExecutorDeps['workflowAction']>;
  /** A mounted WorkBoard binds current UI membership and its existing Account save queue. */
  workBoardArtifacts?: NonNullable<ActionExecutorDeps['workBoardArtifacts']>;
  }>, accountContext?: LazyActionAccountContext & { settings: Awaited<ReturnType<LazyActionAccountContext['readSettings']>> }): ReturnType<typeof createActionExecutor> & Readonly<{
    readWidgetMovementAdmission(ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, context: ActionExecutorContext): ReturnType<typeof readWidgetEntityMovementAdmission>;
  }> {
  const promptLibraryStore = accountContext ? createUiPromptLibraryArtifactStore(accountContext.workflowArtifacts) : uiPromptLibraryArtifactStore;
    type AgentsBackendsListArgs = Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>;
    type AgentsModelsListArgs = Readonly<{ agentId?: string; machineId?: string; serverId?: string; limit?: number; backendTargetKey?: string }>;

  const resolveSessionMachineId = (sessionId: string, metadata: { machineId?: unknown } | null | undefined): string => {
    const controlMachineId = readMachineControlTargetForSession(sessionId)?.machineId ?? '';
    if (controlMachineId) {
      return controlMachineId;
    }
    return typeof metadata?.machineId === 'string' ? String(metadata.machineId).trim() : '';
  };

  const resolveActionsSettingsSnapshot = () => {
    const raw = accountContext
      ? (accountContext.readLiveSettings() ?? accountContext.settings)?.actionsSettingsV1
      : storage.getState().settings?.actionsSettingsV1;
    return normalizeActionsSettingsV1(raw);
  };
  const executeReviewCommentAction = createReviewCommentsHttpActionExecutor(accountContext ? {
    request: accountContext.request,
    resolveEventStorageContext: async () => (await accountContext.resolveAccountEncryption()).accountMode === 'plain'
      ? { accountId: accountContext.accountId, mode: 'plain' }
      : { accountId: accountContext.accountId, mode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(accountContext.credentials) },
  } : undefined);
  const executePluginPermissionGrantAction = createPluginPermissionGrantHttpActionExecutor(accountContext ? { request: accountContext.request } : undefined);
  const executePluginWebhookAction = createPluginWebhookEndpointHttpActionExecutor(accountContext ? { request: accountContext.request } : undefined);
  const approvalCoordinator = getSharedBlockingApprovalCoordinator();
  const capturedFamilyPorts = accountContext ? createCapturedScopeFamilyPorts(accountContext) : null;
  const settingsHost = resolveSettingsHost();
  const accountRoleAction = accountContext ? createAccountRoleActionExecutorV1({
    accountId: accountContext.accountId,
    readRawAccountSettings: accountContext.readRawSettings,
    mutateAccountSettings: accountContext.mutateRawSettings,
    generateId: randomUUID,
    artifactStore: {
      ...accountContext.workflowArtifacts,
      create: async (input) => {
        await accountContext.workflowArtifacts.create(input);
        const created = await accountContext.workflowArtifacts.read(input.artifactId, { signal: input.signal });
        if (!created) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
        return { artifactId: created.artifactId, revision: created.revision };
      },
    },
    readPluginRoles: async (signal) => {
      accountContext.assertCurrent();
      signal?.throwIfAborted();
      const machineId = resolveUiAccountActionFallbackMachineId(accountContext);
      if (!machineId) return [];
      const entry = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: accountContext.serverId,
        accountLifetime: accountContext.accountLifetime, reuseFreshReady: true });
      accountContext.assertCurrent();
      signal?.throwIfAborted();
      // A missing serving daemon withdraws plugin sources, not Account-owned
      // Artifacts or built-ins; never consume retained failed projections.
      if (entry?.kind !== 'ready') return [];
      const projection = entry.inputs.pluginProjectionV2;
      return Object.values(projection?.familiesById.roles?.entriesById ?? {}).flatMap((source) => {
        if (!source.pluginId) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        if (!projection?.installedPackagesById[source.pluginId]?.occurrenceId) return [];
        const definition = PluginRoleDeclarationV1Schema.parse(source.definition);
        const { id: localId, ...role } = definition;
        return [{ pluginId: source.pluginId, localId, role }];
      });
    },
  }) : null;

  const deps: ActionExecutorDeps = {
    roleActionExecute: async (args) => {
      if (!accountContext || !accountRoleAction) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      accountContext.assertCurrent();
      const input = RoleActionInputSchemasV1[args.actionId].parse(args.input);
      if ('sessionId' in input) {
        // The Account socket authenticates a present user; autonomous callers
        // retain the Session host's authenticated provenance path.
        if (args.context.authority !== 'present_user') return { ok: false, errorCode: 'role_rpc_origin_unavailable', error: 'role_rpc_origin_unavailable' };
        const result = await sessionRpcWithServerScope<unknown, typeof input>({
          serverId: accountContext.serverId, sessionId: input.sessionId, method: args.actionId,
          payload: input, signal: args.context.signal,
        });
        accountContext.assertCurrent();
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return result;
        return RoleActionOutputSchemasV1[args.actionId].parse(result);
      }
      const result = await accountRoleAction(args);
      accountContext.assertCurrent();
      return result;
    },
    scopeAction: async ({ actionId, input, context }) => {
      context.signal?.throwIfAborted();
      return await invokeScopeAction(actionId, input);
    },
    connectedServiceAction: accountContext ? createUiConnectedServiceAction(accountContext) : undefined,
    scmActionExecute: createUiScmAction(accountContext),
    appShellAction: createAppShellAction(accountContext),
    notificationConfigurationAction: createNotificationConfigurationAction(accountContext ?? null),
    appUpdateAction: executeAppUpdateAction,
    hostExternalSessionAction: executeExternalSessionBrowseAction,
    settingsDeclarationAction: createSettingsDeclarationAction({
      host: settingsHost,
      tauriDesktop: settingsHosts.tauriDesktop(settingsHost),
      readPageGate: readSettingsPageGate,
      canUseRuntimeContributions: () => Boolean(accountContext && accountContext.readLiveSettings() !== null),
      isCurrent: () => accountContext?.accountLifetime.isCurrent() === true,
      openHumanInteraction: async (href, signal) => {
        throwIfAborted(signal);
        if (!accountContext || accountContext.readLiveSettings() === null) return false;
        accountContext.assertCurrent();
        const { router } = await import('expo-router');
        throwIfAborted(signal);
        accountContext.assertCurrent();
        if (accountContext.readLiveSettings() === null) return false;
        router.push(href as Parameters<typeof router.push>[0]);
        return true;
      },
      mutationServices: { readAgentCatalog: createVoiceAgentSettingsCatalogReader(accountContext ?? null),
        readScmDiffSummaryCatalog: createScmDiffSummarySettingsCatalogReader(accountContext ?? null) },
      isFeatureEnabled: async (featureId) => {
        const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext?.serverId });
        const settings = accountContext ? await accountContext.readSettings() : storage.getState().settings;
        return resolveRuntimeFeatureDecisionFromSnapshot({ featureId, settings, snapshot })?.state === 'enabled';
      },
      readAccountSettings: async () => {
        if (!accountContext) throw new Error('Account settings context is unavailable');
        return await accountContext.readSettings();
      },
      writeAccountSettings: async (delta) => {
        if (!accountContext) throw new Error('Account settings context is unavailable');
        await accountContext.mutateRawSettings((raw) => ({ ...raw, ...delta }));
      },
      mutateAccountSettings: async (mutate) => {
        if (!accountContext) throw new Error('Account settings context is unavailable');
        await accountContext.mutateRawSettings(mutate);
      },
      readLocalSettings: () => storage.getState().localSettings,
      writeLocalSettings: (delta) => storage.getState().applyLocalSettings(delta, { source: 'ui' }),
      ...(accountContext ? { automationSettings: {
        read: () => accountContext.runPrepared(() => getAutomationSettings(accountContext.credentials, accountContext)),
        write: (settings: AutomationV3Settings) => accountContext.runPrepared(() => updateAutomationSettings(accountContext.credentials, settings, accountContext)),
      } } : {}),
    }),
    ...(accountContext ? { workBoardArtifacts: opts?.workBoardArtifacts ?? createWorkBoardArtifactPortV1(accountContext.workflowArtifacts, {
      shouldContinue: accountContext.accountLifetime.isCurrent,
    }) } : {}),
    ...(accountContext ? { launchProfilePublish: async (input, context) => {
      context?.signal?.throwIfAborted();
      return await createLaunchProfilePublisherV1({
        readSettings: accountContext.readRawSettings,
        mutateSettings: accountContext.mutateRawSettings,
        artifactStore: { read: (artifactId, signal) => accountContext.workflowArtifacts.read(artifactId, { signal }),
          create: async ({ header, body }) => ({ artifactId: await accountContext.createArtifact(header, body) }) },
      }).publish(input, context);
    } } : {}),
    ...(accountContext ? createUiNotificationActionDeps({ account: accountContext }) : {}),
    ...(accountContext ? { artifactAction: createUiArtifactAction(accountContext, { onPublicLinkIssued: opts?.onPublicLinkIssued }) } : {}),
    ...(accountContext ? { artifactAccessAction: createArtifactAccessActionsV1({
      read: accountContext.workflowArtifacts.read,
      transport: accountContext.artifactAccessGrants,
    }) } : {}),
    ...(opts?.workflowAction
      ? { workflowAction: opts.workflowAction }
      : accountContext
        ? { workflowAction: createUiWorkflowAction({ account: accountContext }) }
        : {}),
    ...(accountContext ? {
      readAdmittedInputTypeOptions: async ({ input, context }) => createUiAccountAction({ account: accountContext })({
        actionId: 'action.options.resolve', input, context,
      }),
    } satisfies Pick<ActionExecutorDeps, 'readAdmittedInputTypeOptions'> : {}),
    resolveSessionReference: opts?.resolveSessionReference ?? (async ({ sessionId, sessionTitle, context, signal }) => {
      // An exact tuple needs no corpus. A bare id or title is resolved against the one admitted
      // corpus — a mounted pane's membership when one owns it, otherwise one acquired through the
      // canonical row-only `session.list` read — so every host answers
      // unique/ambiguous/incomplete/none from the same evidence instead of
      // failing closed forever for want of one (Lane 07.1 §3).
      const currentState = storage.getState();
      const options = normalizeSessionAddress(context.serverId, sessionId)
        ? null
        : await acquireAdmittedSessionReferenceCorpusOptions(
            currentState,
            signal ? { signal } : undefined,
          );
      return await resolveVoiceActionSessionReference({
        ...(sessionId ? { sessionId } : {}),
        ...(sessionTitle ? { sessionTitle } : {}),
        ...(context.serverId ? { serverId: context.serverId } : {}),
        ...(signal ? { signal } : {}),
        // The acquisition hydrated the admitted rows; resolve on the store after it.
      }, options ? { state: storage.getState(), options } : null);
    }),
    isApprovalExecutionOriginCurrent: async ({ origin }) => {
      if (!accountContext) return false;
      accountContext.assertCurrent();
      return isApprovalExecutionOriginCurrentForAccountContext({
        origin,
        accountServerId: accountContext.serverId,
        accountId: accountContext.accountId,
      });
    },
    sessionFollowAction: async (args) => {
      const result = await sessionFollowAction(args);
      const failed = typeof result === 'object'
        && result !== null
        && 'ok' in result
        && result.ok === false;
      if (args.actionId !== 'session.follow.sources.set' || failed) return result;

      const serverId = args.serverId ?? args.context.serverId;
      if (!serverId) return result;
      const relation = args.input as Readonly<{
        sourceSessionId: string;
        destinationSessionId: string;
      }>;
      let preparation: SessionFollowSourceKeyPreparationResultV1;
      try {
        preparation = await prepareSessionFollowSourceKey({
          serverId,
          sourceSessionId: relation.sourceSessionId,
          destinationSessionId: relation.destinationSessionId,
        });
      } catch {
        preparation = { kind: 'waiting', reason: 'runner_unreachable' };
      }
      return projectSessionFollowSourceKeyPreparationAfterSetV1(
        result as SessionFollowActionOutputV1['session.follow.sources.set'],
        preparation,
      );
    },
    ...(accountContext ? { homeHubArtifacts: createHomeHubArtifactPortV1(accountContext.homeHubArtifactTransport, {
      accountId: accountContext.accountId,
      shouldContinue: accountContext.accountLifetime.isCurrent,
      readWidgets: async signal => {
        accountContext.assertCurrent();
        const { readWidgetActionCandidatesV1 } = await import('./widgetCatalogActionDeps');
        const candidates = await readWidgetActionCandidatesV1({
          serverId: accountContext.serverId, accountId: accountContext.accountId, owner: { kind: 'home' },
        }, accountContext, signal);
        accountContext.assertCurrent();
        if ('ok' in candidates) throw Object.assign(new Error(candidates.error), { code: candidates.errorCode });
        return candidates;
      },
    }), homeHubLayoutAction: async (params: Parameters<NonNullable<ActionExecutorDeps['homeHubLayoutAction']>>[0]) => {
      // Home renderers/projection are needed only by this client-local family,
      // not every executor creation (including headless or Voice startup).
      const { createHomeHubLayoutAction } = await import('@/components/hub/layout/homeHubLayoutAction');
      return createHomeHubLayoutAction({
        isClientTargetCurrent: () => {
          accountContext.assertCurrent();
          return areServerAccountScopesEqual(getActiveServerAccountScope(), accountContext.accountLifetime.scope);
        },
      })(params);
    } } : {}),
    sessionReadStateAction,
    sessionReportsToSet: createSessionReportsToAction(accountContext ?? null),
    sessionBoardAction: async (args) => {
      const input = SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[args.actionId].parse(args.input);
      const sessionId = input.sessionId ?? args.context.defaultSessionId;
      const serverId = args.context.serverId ?? (sessionId ? opts?.resolveServerIdForSessionId?.(sessionId) : null);
      if (!sessionId || !serverId) {
        return { ok: false as const, errorCode: 'unsupported_action' as const, error: 'unsupported_action' as const };
      }
      const address = { serverId, sessionId };
      let mutationDispatched = false;
      let recoveryDetails: SessionBoardOutcomeUnknownDetailsV1 | null = null;
      const executed = await sync.withSessionSystemRecordRuntime(address, async (runtime) => {
        // The store row publishes the already-normalized projection; re-normalizing a raw
        // `effectiveAccess` field the row never carries refused every Board mutation.
        const access = runtime.session.access ?? null;
        if (!access) {
          return { ok: false as const, errorCode: 'session_board_forbidden' as const, error: 'session_board_forbidden' as const };
        }
        const snapshot = await getServerFeaturesSnapshot({ serverId });
        const decision = resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'sessions.board', settings: storage.getState().settings, snapshot });
        if (decision?.state !== 'enabled') {
          return projectSessionBoardFeatureDecisionFailureV1(args.actionId, decision);
        }
        const result = await createSessionBoardActionAdapter({
          scope: runtime.scope, session: address, repository: runtime.repository,
          request: (path, init, options) => runtime.request(path, init, options),
          contentContext: runtime.contentContext,
          onMutationPrepared: (details) => {
            recoveryDetails = details;
          },
          onMutationIssued: () => {
            mutationDispatched = true;
          },
          capabilities: { readTranscript: access.capabilities.readTranscript, editSessionRecords: access.capabilities.editSessionRecords },
        })(args);
        return result;
      });
      if (executed.status === 'ok') return executed.value;
      // Retirement discards Account-owned result content, but cannot undo a sent write.
      return projectRetiredSessionBoardActionFailure({
        mutationDispatched,
        retirementStatus: executed.status,
        recoveryDetails,
      });
    },
    listContributedActionDefinitions: opts?.listContributedActionDefinitions,
    readContributedActionSchemas: opts?.readContributedActionSchemas,
    isActionEnabled: (actionId: ActionId, ctx) =>
      {
        if (opts?.isActionEnabled && !opts.isActionEnabled(actionId, ctx)) {
          return false;
        }
        if (
          !isActionEnabledByActionsSettings(actionId, resolveActionsSettingsSnapshot(), {
            surface: ctx.surface ?? null,
            placement: ctx.placement ?? null,
          })
        ) {
          return false;
        }
        if (actionId !== 'session.mode.set') {
          return true;
        }
        const sessionId = typeof ctx.defaultSessionId === 'string' ? ctx.defaultSessionId.trim() : '';
        if (!sessionId) {
          return true;
        }
        const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
        return isSessionModeActionAvailable(session);
      },
    isActionApprovalRequired: (actionId, ctx, input) => {
      const operationSettings = actionId === 'settings.invoke' ? accountContext?.readLiveSettings() : null;
      const anchor = input && typeof input === 'object' && 'anchor' in input && typeof input.anchor === 'string' ? input.anchor : '';
      const operationSafety = actionId === 'settings.invoke'
        ? operationSettings && !resolveSettingsDeclarationOperationApprovalRequired(anchor, operationSettings) ? 'safe' : 'danger'
        : undefined;
      return isApprovalRequiredByActionsSettings(actionId, resolveActionsSettingsSnapshot(), {
        surface: ctx.surface ?? null,
        authority: ctx.authority,
        actionCaller: ctx.actionCaller,
      }, operationSafety, undefined, input);
    },
    ...createUiExecutionRunActionDeps(),
    resolveSessionSpawnAgentInventorySelection: resolveSessionSpawnAgentInventorySelectionForActions,
    runtimeActionExecute: createDefaultRuntimeActionExecutor(opts?.runtimeActions),
    uiCommandPaletteAction: executeCommandPaletteAction,
    voiceConversationAction: async ({ actionId, input, context }) => {
      throwIfAborted(context.signal);
      if (!accountContext?.readLiveSettings()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      accountContext.assertCurrent();
      const opensMicrophone = actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.recover'
        || actionId === 'ui.voice_global.hold_begin' || actionId === 'ui.voice_global.brief.request'
        || actionId === 'ui.voice_global.brief.retry';
      if (opensMicrophone) {
        const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext.serverId });
        throwIfAborted(context.signal);
        accountContext.assertCurrent();
        const settings = accountContext.readLiveSettings();
        if (!settings || resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'voice', settings, snapshot })?.state !== 'enabled') {
          return { ok: false, errorCode: 'voice_unavailable', error: 'voice_unavailable' };
        }
      }
      if (actionId.startsWith('ui.voice_global.brief.')) {
        const { executeVoiceBriefOperation } = await import('@/components/voice/brief/voiceBriefActionRuntime');
        accountContext.assertCurrent();
        throwIfAborted(context.signal);
        const operation = actionId === 'ui.voice_global.brief.request' ? 'request' : actionId === 'ui.voice_global.brief.retry' ? 'retry' : 'stop';
        const result = executeVoiceBriefOperation(operation, input as Readonly<{ expectedAttemptId?: string }>);
        return result.ok ? result.result : { ...result, error: result.errorCode };
      }
      const [{ executeVoiceConversationAction }, { router }] = await Promise.all([
        import('./voiceConversationAction'), import('expo-router'),
      ]);
      accountContext.assertCurrent();
      throwIfAborted(context.signal);
      return await executeVoiceConversationAction(actionId, input, { isCurrent: () => accountContext.accountLifetime.isCurrent() && !context.signal?.aborted, navigate: (href) => {
        accountContext.assertCurrent();
        throwIfAborted(context.signal);
        router.push(href as Parameters<typeof router.push>[0]);
      } });
    },
    uiCurrentContextAction: (request) => executeCurrentUiContextAction(request, { execute: executor.execute, context: request.context }),
    invokeContributedAction: (request) => executeCurrentUiContextContributedAction(request, { execute: executor.execute, context: request.context }),
    uiFindAction: executeFindAction,
    uiPromptPickerOpen: executePromptPickerOpenAction,
    nextPendingSession: (context) => invokeNextPendingRequest({
      expectedServerId: context.serverId,
      signal: context.signal,
    }),
    accountEncryptionAutomationTemplatesRecoverAction: async ({ context, signal }) => {
      const scope = accountContext?.accountLifetime.scope ?? getActiveServerAccountScope();
      if (!scope || (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, scope.serverId))
        || (context.runtimeAccountId && context.runtimeAccountId !== scope.accountId)) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext?.assertCurrent();
      return await recoverHistoricalAutomationTemplates({ settingsScope: scope, ...(signal ? { signal } : {}) });
    },
    accountHistoricalEncryptionKeyForgetAction: async ({ context, signal }) => {
      const scope = accountContext?.accountLifetime.scope ?? getActiveServerAccountScope();
      if (!scope || (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, scope.serverId))
        || (context.runtimeAccountId && context.runtimeAccountId !== scope.accountId)) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext?.assertCurrent();
      return await forgetHistoricalEncryptionKey({ settingsScope: scope, ...(signal ? { signal } : {}) });
    },
    accountPluginDataEraseAction: async ({ input, signal }) => await executeAccountPluginDataEraseAction(
      input,
      signal ? { signal } : undefined,
    ),
    accountSessionsSignOutEverywhereAction: async ({ input, signal }) => await signOutEverywhere(
      input,
      signal ? { signal } : undefined,
    ),
    accountApiTokensCreateAction: async ({ input, signal }) => await createCurrentAccountApiToken(
      input,
      signal ? { signal } : undefined,
    ),
    accountApiTokensListAction: async ({ input, signal }) => await listCurrentAccountApiTokens(
      input,
      signal ? { signal } : undefined,
    ),
    accountApiTokensRevokeAction: async ({ input, signal }) => await revokeCurrentAccountApiToken(
      input,
      signal ? { signal } : undefined,
    ),
    accountApiTokensRevokeAllAction: async ({ input, signal }) => await revokeAllCurrentAccountApiTokens(
      input,
      signal ? { signal } : undefined,
    ),
    accountApiTokensUpdateAction: async ({ input, signal }) => await updateCurrentAccountApiToken(
      input,
      signal ? { signal } : undefined,
    ),
    ...(accountContext ? {
      accountSecurityGetAction: async ({ signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => fetchAccountSecurity(accountContext.request, signal));
        accountContext.assertCurrent();
        return result;
      },
      accountPasswordEnrollAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => enrollAccountPassword(accountContext.request, input, signal));
        accountContext.assertCurrent();
        return result;
      },
      accountPasswordChangeAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => submitAccountPasswordChange(accountContext.request, input, signal));
        accountContext.assertCurrent();
        return result;
      },
      accountPasswordRemoveAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => submitAccountPasswordRemove(accountContext.request, input, signal));
        accountContext.assertCurrent();
        return result;
      },
      accountEmailChangeRequestAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => requestAccountSignInEmailChange(accountContext.request, input, signal));
        accountContext.assertCurrent();
        return result;
      },
      accountSecurityTerminalPresentUserSetAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => setAccountTerminalPresentUserPolicy(accountContext.request, input, signal));
        accountContext.assertCurrent();
        return result;
      },
    } : {}),

    workspaceAction: invokeWorkspaceAction,
    sessionCanvasAction: invokeSessionCanvasAction,
    workflowConversationBind: invokeWorkflowConversationBinding,
    sessionOrganizationMove: async request => {
      if (!accountContext) return { status: 'unavailable' as const };
      return await invokeSessionListOrganizationAction({
        ...request,
        mutationScope: createSessionOrganizationMutationScopeForAccount(accountContext),
      });
    },
    composerIngress: executeComposerIngressAction,
    listReorder: executeListReorderAction,
    todoSessionLink: executeTodoSessionLinkAction,
    sessionTerminalAction: invokeSessionTerminalAction,
    sessionOpen: async ({ sessionId, serverId, approvedNewDirectoryCreation, tabId, destination, signal }) => {
      const comparison = destination ? scmReviewComparisonOfSource(destination.comparison, destination.comparisonId) : null;
      if (destination && !comparison) return { ok: false, errorCode: 'invalid_parameters', error: 'comparison_selector_unavailable' };
      const query = destination && comparison ? serializeSessionPaneUrlState({ details: {
        kind: 'scmReview', comparison, view: destination.view,
        ...(typeof destination.explain === 'boolean' ? { explain: destination.explain } : {}),
      } }) : undefined;
      const workspace = tabId || destination ? captureMountedWorkspaceAction() : null;
      if (tabId) {
        if (!workspace) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' };
        const target = await workspace({ actionId: 'workspace.tabs.list', input: {}, ...(signal ? { signal } : {}) });
        if (!target.ok) return target;
        if (!('tabs' in target) || !target.tabs.some((tab) => tab.id === tabId)) return { ok: false, errorCode: 'workspace_tab_not_found', error: 'workspace_tab_not_found' };
      }
      if (approvedNewDirectoryCreation === true) {
        if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'Exact Account scope is unavailable.' };
        accountContext.assertCurrent();
        const state = storage.getState();
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({
          scope: accountContext.accountLifetime.scope,
          activeRequest: accountContext.request,
        }, async (authority) => await readSessionSnapshotForAuthority({
          authority, sessionId, isCurrent: accountContext.accountLifetime.isCurrent,
        }));
        accountContext.assertCurrent();
        const target = resolveSessionActionDefaultBackend({ session });
        // Resolve from the fresh exact-Home snapshot, not a same-id row in the focused Home.
        const machineTarget = resolveMachineControlTargetForSessionFromState({
          ...state, sessions: { [sessionId]: session }, sessionListRowsByServerId: {},
        }, { ...accountContext.accountLifetime.scope, sessionId });
        const settings = accountContext.readLiveSettings() ?? accountContext.settings;
        const pluginSettings = await readAgentScopedPluginSettingsSnapshot({
          agentId: target?.defaultAgentId ?? null, machineId: machineTarget?.machineId,
          serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
          accountSettings: settings,
        });
        accountContext.assertCurrent();
        const base = buildResumeSessionBaseOptionsFromSession({
          sessionId, session,
          resumeTargetOverride: machineTarget ? { machineId: machineTarget.machineId, directory: machineTarget.basePath } : null,
          resumeCapabilityOptions: buildResumeCapabilityOptionsFromUiState({ settings, pluginSettings, results: undefined }),
        });
        if (!machineTarget || !base) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' };
        const resumed = await resumeSession({
          ...base, serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
          approvedNewDirectoryCreation: true,
        });
        accountContext.assertCurrent();
        if (resumed.type === 'error') return { ok: false, errorCode: resumed.errorCode, error: resumed.errorMessage };
      }
      if ((tabId || destination) && workspace) {
        const outcome = await workspace({ actionId: 'workspace.tabs.open',
          input: { href: buildScopedSessionRouteHref({ sessionId, serverId, query }), ...(tabId ? { tabId } : {}) }, ...(signal ? { signal } : {}) });
        return outcome.ok ? { ok: true, status: 'opened', sessionId, serverId, ...(tabId ? { tabId } : {}), address: { serverId, sessionId } } : outcome;
      }
      return opts?.openSession
        ? (
          serverId
            ? await opts.openSession(sessionId, { serverId, ...(query ? { query } : {}) })
            : await opts.openSession(sessionId),
          {
            ok: true,
            status: 'opened',
            sessionId,
            serverId,
            address: { serverId, sessionId },
          } as const
        )
        : await openSessionForVoiceTool({
          sessionId,
          serverId,
          ...(query ? { query } : {}),
          resolveServerIdForSessionId: serverId
            ? (targetSessionId) => targetSessionId === sessionId ? serverId : opts?.resolveServerIdForSessionId?.(targetSessionId) ?? null
            : opts?.resolveServerIdForSessionId,
          resolveServerNameForSessionId: opts?.resolveServerNameForSessionId,
        });
    },

    sessionFork: async ({ sessionId, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const resolvedServerId = String(serverId ?? opts?.resolveServerIdForSessionId?.(sid) ?? '').trim();
      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      const machineId = resolveSessionMachineId(sid, metadata);

      const settings = stateAny?.settings ?? null;
      const forkPoint = { type: 'latest' } as const;
      // One fork policy for every surface. This executor has no strategy modal
      // to show, so it reads the same availability the modal renders and asks
      // for the exact route that modal would have offered. An unqualified
      // request is what let the daemon settle on Replay for an account that
      // turned Replay off.
      const availability = resolveSessionForkStrategyAvailability({
        session,
        forkPoint,
        replayEnabled: resolveHappierReplayConfig(settings ?? {}).enabled,
        // Source-context continuation is a navigation to the New Session
        // screen; this executor has no such route, so it is not one of its
        // options rather than a route it silently fails to take.
        agentSwitchingEnabled: false,
        currentAgentCapabilities: opts?.currentAgentCapabilities,
      });
      if (!availability.native && !availability.replay) {
        return { ok: false, errorCode: 'action_disabled', errorMessage: 'action_disabled' };
      }
      const replayOptions = resolveSessionForkReplayOptions({
        settings,
        executionRunsEnabled: resolveLocalFeaturePolicyEnabled('execution.runs', settings ?? {}),
      });

      const result = await forkSessionOp({
        ...(machineId ? { machineId } : {}),
        serverId: resolvedServerId || undefined,
        parentSessionId: sid,
        forkPoint,
        // `auto` is the only value that can fall through to Replay, so it stays
        // the request exactly while Replay is a route the account allows.
        ...(availability.replay ? {} : { strategy: 'native' as const }),
        ...replayOptions,
      } as any);
      if ((result as any)?.ok !== true) return result as any;

      const childSessionId = String((result as any).childSessionId ?? '').trim();
      if (childSessionId) {
        await completeSessionForkNavigation({
          childSessionId,
          parentSessionId: sid,
          ...(resolvedServerId ? { serverId: resolvedServerId } : {}),
          navigate: async (targetSessionId, navigationOptions) => {
            const navigationServerId = navigationOptions?.serverId ?? resolvedServerId;
            if (opts?.openSession) {
              if (navigationServerId) {
                await opts.openSession(targetSessionId, { serverId: navigationServerId });
              } else {
                await opts.openSession(targetSessionId);
              }
              return;
            }
            await openSessionForVoiceTool({
              sessionId: targetSessionId,
              serverId: navigationServerId,
              resolveServerIdForSessionId: navigationServerId
                ? (candidateSessionId) => candidateSessionId === targetSessionId
                  ? navigationServerId
                  : opts?.resolveServerIdForSessionId?.(candidateSessionId) ?? null
                : opts?.resolveServerIdForSessionId,
              resolveServerNameForSessionId: opts?.resolveServerNameForSessionId,
            });
          },
        });
      }
      return { ok: true, status: 'forked', parentSessionId: sid, childSessionId };
    },

    sessionStop: async ({ sessionId, serverId }) =>
      await sessionStopWithServerScope(sessionId, { serverId }),

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs, serverId }) =>
      await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
        payload: {
          sessionId,
          ...(typeof expectedStateAtMs === 'number' && Number.isFinite(expectedStateAtMs)
            ? { expectedStateAtMs }
            : {}),
        },
      }),

    sessionPendingInputInterruptAndRun: async ({ sessionId, localId, expectedStateAtMs, serverId }) =>
      await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
        payload: {
          sessionId,
          localId,
          ...(typeof expectedStateAtMs === 'number' && Number.isFinite(expectedStateAtMs)
            ? { expectedStateAtMs }
            : {}),
        },
      }),

    sessionRollback: async ({ sessionId, serverId, target }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const resolvedTarget = target ?? { type: 'latest_turn' };
      const session = (storage.getState() as any)?.sessions?.[sid] ?? null;
      if (!canRollbackConversation({
        session,
        target: resolvedTarget,
        currentAgentCapabilities: opts?.currentAgentCapabilities,
      })) {
        return { ok: false, errorCode: 'action_disabled', errorMessage: 'action_disabled' };
      }
      return await rollbackSessionConversationOp({
        sessionId: sid,
        serverId,
        target: resolvedTarget,
      });
    },

    checkpointCodeRollback: async ({ request, serverId }) =>
      await rollbackSessionCheckpointCodeOp({ request, serverId }),

    sessionHandoffTargetReplacementApprovalPreflight: async ({
      targetMachineId,
      targetPath,
      workspaceAction,
      activatesExactMirror,
      destinationIntent,
      serverId,
      operationId,
      signal,
    }) => await preflightWorkspaceDestinationReplacement({
      targetMachineId,
      targetPath: targetPath ?? '',
      serverId: serverId ?? '',
      operationId,
      workspaceAction: workspaceAction ?? { kind: 'none' },
      ...(activatesExactMirror === undefined ? {} : { activatesExactMirror }),
      ...(destinationIntent ? { destinationIntent } : {}),
      ...(signal ? { signal } : {}),
    }),

    workspaceSyncRelationshipCreate: async ({
      input,
      operationId,
      serverId,
      targetReplacementApproval,
      targetReplacementApprovalReceiptId,
      signal,
    }) => await createWorkspaceSyncRelationshipOnController({
      input,
      operationId,
      serverId: serverId ?? null,
      ...(targetReplacementApproval && targetReplacementApprovalReceiptId
        ? { targetReplacementApproval, targetReplacementApprovalReceiptId }
        : {}),
      ...(signal ? { signal } : {}),
    }),

    sessionHandoffStart: async ({
      sessionId,
      targetMachineId,
      targetPath,
      targetSessionStorageMode,
      workspaceAction,
      serverId,
      actionRequestId,
      handoffTargetReplacementApproval,
      handoffTargetReplacementApprovalReceiptId,
      handoffTargetReplacementApprovalActionInput,
      signal,
    }) => {
      const sid = String(sessionId ?? '').trim();
      const tid = String(targetMachineId ?? '').trim();
      if (!sid || !tid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };

      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      // Only the source machine is resolved here. Which storage the target
      // imports into is derived by the source daemon from the owner metadata it
      // loads itself, before the operation claim and before any stop or export,
      // so a cold or unprojected client view must not refuse a valid handoff.
      const sourceMachineId = resolveSessionMachineId(sid, metadata);

      return await startSessionHandoffOp({
        sessionId: sid,
        sourceMachineId: sourceMachineId || undefined,
        targetMachineId: tid,
        ...(targetPath ? { targetPath } : {}),
        ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
        ...(workspaceAction ? { workspaceAction } : {}),
        serverId,
        ...(actionRequestId ? { actionRequestId } : {}),
        ...(handoffTargetReplacementApproval ? { handoffTargetReplacementApproval } : {}),
        ...(handoffTargetReplacementApprovalReceiptId ? {
          handoffTargetReplacementApprovalReceiptId,
          handoffTargetReplacementApprovalActionInput,
        } : {}),
        ...(signal ? { signal } : {}),
      });
    },

    sessionSpawnNew: async ({
      context: _context,
      sessionCreationTag: _sessionCreationTag,
      legacyMetadataLabel: _legacyMetadataLabel,
      actionCaller: _actionCaller,
      callerSurface: _callerSurface,
      sessionAgentSpawnPolicyV1: _sessionAgentSpawnPolicyV1,
      actionRequestId: _actionRequestId,
      resumeActionRequest: _resumeActionRequest,
      signal,
      ...input
    }) => {
      const { placementOrigin, ...exactInput } = input;
      const serverId = resolveServerProfileScopeIdForIdentifier(input.executionTarget.serverId);
      const machine = storage.getState().machineListByServerId[serverId]
        ?.find((candidate) => candidate.id === input.executionTarget.machineId);
      if (
        input.secretReferenceOverlay
        && !supportsMachineSessionSpawnProtocolVersionV1(
          machine?.operationProtocolCapabilities,
          2,
        )
      ) {
        return {
          type: 'error' as const,
          code: 'update_required' as const,
          retryable: false as const,
          details: {
            kind: 'update_required' as const,
            operation: 'session.spawn_new' as const,
            component: 'daemon' as const,
            reason: 'session_secret_reference_overlay_update_required',
          },
        };
      }
      const supportsOrigin = !machine?.revokedAt && !machine?.replacedByMachineId
        && supportsMachineOperationProtocolCapabilityV1(machine?.operationProtocolCapabilities, 'sessionSpawnPlacementOrigin');
      return await dispatchSessionSpawnNewWithReportsToPreparation({
        payload: placementOrigin && supportsOrigin ? { ...exactInput, placementOrigin } : exactInput,
        signal,
      });
    },

    approvalRequestApprovedReplay: async ({ artifactId, request, signal }) => {
      if (!requiresExactDaemonApprovalReplay(request)) return null;
      const replayRoute = resolveApprovalReplayRoute(request);
      const machineId = request.v === 2 ? request.executionOriginV1.machineId?.trim() ?? '' : '';
      if (!replayRoute || !machineId) {
        return {
          ok: false,
          errorCode: 'approval_origin_unavailable',
          error: 'approval_origin_unavailable',
        };
      }
      return await replayApprovedApprovalRequestAtExactDaemon({
        artifactId,
        executionTarget: { ...replayRoute, machineId },
        ...(signal === undefined ? {} : { signal }),
      });
    },

    pathsListRecent: async ({ machineId, limit }) => await listRecentPathsForVoiceTool({ machineId, limit }),
    projectsList: async (args) => await listProjectsForActions(args),
    promptInvocationsList: async (args) => accountContext
      ? listPromptInvocationsInLibrary({ invocations: (await accountContext.readRawSettings()).promptInvocationsV1, request: args })
      : listPromptInvocationsForActions(args),
    promptInvocationResolve: async (args) => accountContext
      ? resolvePromptInvocationInLibrary({ invocations: (await accountContext.readRawSettings()).promptInvocationsV1,
        store: promptLibraryStore, request: args, sessionId: args.sessionId ?? null, signal: args.signal })
      : resolvePromptInvocationForActions(args),
    spawnProfilesList: async (args) => listSpawnProfilesForActions(args, accountContext
      ? projectUiAiLaunchProfileSnapshot(await accountContext.readLaunchProfileSnapshot((await accountContext.readRawSettings()).profiles)) : undefined),
    machinesList: async ({ limit }) => await listMachinesForVoiceTool({ limit }),
    ...createMachineConnectionActionDeps(),
    serversList: async ({ limit }) => await listServersForVoiceTool({ limit }),
    reviewEnginesList: async ({ sessionId, includeDisabled, scope }) => await listReviewEnginesForVoiceTool({ sessionId, includeDisabled, scope }),
    reviewCommentAction: async ({ actionId, input, signal }) => signal
      ? await executeReviewCommentAction(actionId, input, { signal })
      : await executeReviewCommentAction(actionId, input),
    pluginPermissionGrantAction: async ({ actionId, input, signal }) => signal
      ? await executePluginPermissionGrantAction(actionId, input, { signal })
      : await executePluginPermissionGrantAction(actionId, input),
    // Session access, discussions, Home governance and Teams require an exact
    // Account scope; focus can never supply it. A mounted surface supplies its
    // own port (it also owns the staleness lifetime). Without one, the ports
    // come from the captured exact Home/Account scope of this invocation, which
    // an approval replay has matched to its immutable origin before any effect
    // (`isApprovalExecutionOriginCurrent` above) — so Approval Detail, the Prompt
    // Card and the Inbox reach the same family owner as the originating surface.
    ...(opts?.sessionAccessAction ?? capturedFamilyPorts?.sessionAccessAction
      ? { sessionAccessAction: opts?.sessionAccessAction ?? capturedFamilyPorts!.sessionAccessAction }
      : {}),
    ...(opts?.sessionDiscussionAction ?? capturedFamilyPorts?.sessionDiscussionAction
      ? { sessionDiscussionAction: opts?.sessionDiscussionAction ?? capturedFamilyPorts!.sessionDiscussionAction }
      : {}),
    ...(opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction
      ? { homeDomainAction: opts?.homeDomainAction ?? capturedFamilyPorts!.homeDomainAction }
      : {}),
    ...(opts?.workspaceSyncConflictResolve ? { workspaceSyncConflictResolve: opts.workspaceSyncConflictResolve } : {}),
    // Personal Machine Pools use the same captured Account/Home transport, feature decision,
    // enablement and approval lifetime as every other immediate scoped Action.
    machinePoolAction: async (args) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      const features = await getReadyServerFeatures({ serverId: accountContext.serverId });
      if (!features || readServerEnabledBit(features, 'machines.pools') !== true) {
        return { ok: false, errorCode: 'machine_pools_unavailable', error: 'machine_pools_unavailable' };
      }
      try {
        return await createMachinePoolActionClient({ request: accountContext.request }).execute(args.actionId, args.input, {
          serverId: accountContext.serverId, ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (error) {
        if (error instanceof MachinePoolActionError) {
          return { ok: false, errorCode: error.detail?.code ?? 'machine_pool_request_failed', error: error.message, details: error.detail };
        }
        throw error;
      }
    },
    // Temporary computer activation: the same captured Account/Home transport,
    // server feature decision and approval lifetime as every other immediate
    // scoped Action. The activation client stays the one Runner transport owner.
    ephemeralRunnerAction: async (args) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      const features = await getReadyServerFeatures({ serverId: accountContext.serverId });
      if (!features || readServerEnabledBit(features, 'sessions.ephemeralRunner') !== true) {
        return { ok: false, errorCode: 'runner_unavailable', error: 'runner_unavailable' };
      }
      const client = createRunnerActivationClient(accountContext.request);
      try {
        if (args.actionId === 'sessions.runner.activation.create') {
          return await client.create(args.input as RunnerActivationCreateRequestV1);
        }
        const { activationId } = args.input as Readonly<{ activationId: string }>;
        if (args.actionId === 'sessions.runner.activation.get') {
          return await client.read(activationId, args.signal);
        }
        await client.cancel(activationId);
        return { activationId, closed: true };
      } catch (error) {
        if (error instanceof RunnerActivationClientError) {
          return { ok: false, errorCode: error.serverCode ?? error.code, error: error.message };
        }
        throw error;
      }
    },
    pluginWebhookAction: async ({ actionId, input, signal }) => {
      if (!Object.hasOwn(PluginWebhookActionHttpPathsV1, actionId)) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          error: `unsupported_action:${actionId}`,
        } as const;
      }
      const publicEndpointActionId = actionId as PluginWebhookPresentUserActionIdV1;
      return signal
        ? await executePluginWebhookAction(publicEndpointActionId, input, { signal })
        : await executePluginWebhookAction(publicEndpointActionId, input);
    },
    agentsBackendsList: async (args) => {
      const { includeDisabled, limit, machineId } = args as AgentsBackendsListArgs;
      return await listAgentBackendsForVoiceTool({ includeDisabled, limit, machineId });
    },
    workspaceFilesSearch: async ({ machineId, ...request }, context) => {
      const result = await machineWorkspaceFileSearch(machineId, request, {
        serverId: context.serverId,
        accountId: accountContext?.accountId,
        signal: context.signal,
      });
      if (!result.ok && 'errorCode' in result) {
        return { ok: false, errorCode: result.errorCode === 'method_unavailable' ? 'update_required' : 'workspace_file_search_unavailable',
          error: result.errorCode };
      }
      return result;
    },
    machinesAgentsList: async (args, context) => {
      const inputs = await loadDaemonMergedProjectionInputs({ machineId: args.machineId, serverId: args.serverId });
      if (!inputs?.pluginProjectionV2) {
        return { ok: false, errorCode: 'machine_agent_inventory_unavailable', error: 'machine_agent_inventory_unavailable' };
      }
      const agents = buildMachineAgentInventoryDescriptors(inputs).filter(({ agentId }) => !args.agentId || args.agentId === agentId);
      if (agents.length === 0) return { items: [] };
      try {
        const response = await machineRpcWithServerScope({
          machineId: args.machineId,
          serverId: args.serverId,
          method: RPC_METHODS.CAPABILITIES_DETECT,
          payload: buildMachineAgentsDetectRequest({ agents, refresh: args.refresh }),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return projectMachineAgentsDetectResponse({ agents, response });
      } catch (error) {
        if (error instanceof MachineAgentInventoryUnavailableError) {
          return { ok: false, errorCode: error.code, error: error.message };
        }
        throw error;
      }
    },
    machineAgentSignInStart: async ({ machineId, serverId, signal, ...request }) => {
      if (request.method !== 'native' || !accountContext) return await startAgentSignInRpc({ machineId, serverId, signal }, request);
      const { executeAgentSignInLifecycle } = await import('@/agents/machineAgents/signIn/useAgentSignIn');
      return await executeAgentSignInLifecycle({ machineId, serverId: accountContext.serverId, agentId: request.agentId,
        lifetime: accountContext.accountLifetime, signal }, 'start');
    },
    machineAgentSignInStatus: async ({ machineId, serverId, signal, agentId }) =>
      checkAgentSignInRpc({ machineId, serverId, signal }, agentId),
    machineAgentSignInCancel: async ({ machineId, signal, agentId, terminalId }) => {
      if (!accountContext) return { ok: false, errorCode: 'sign_in_unavailable', error: 'An exact Home Account is required.' };
      const { executeAgentSignInLifecycle } = await import('@/agents/machineAgents/signIn/useAgentSignIn');
      return await executeAgentSignInLifecycle({ machineId, serverId: accountContext.serverId, agentId,
        lifetime: accountContext.accountLifetime, signal }, 'cancel', terminalId);
    },
    machineAgentSignInRestart: async ({ machineId, signal, agentId, terminalId }) => {
      if (!accountContext) return { ok: false, errorCode: 'sign_in_unavailable', error: 'An exact Home Account is required.' };
      const { executeAgentSignInLifecycle } = await import('@/agents/machineAgents/signIn/useAgentSignIn');
      return await executeAgentSignInLifecycle({ machineId, serverId: accountContext.serverId, agentId,
        lifetime: accountContext.accountLifetime, signal }, 'restart', terminalId);
    },
    machineAgentInstallStart: async ({ machineId, serverId, signal, ...request }) =>
      await startAgentInstallJobRpc({ machineId, serverId, signal }, request),
    machineAgentInstallRead: async ({ machineId, serverId, signal, ...request }) =>
      await readAgentInstallJobRpc({ machineId, serverId, signal }, request),
    machineAgentInstallCancel: async ({ machineId, serverId, signal, ...request }) =>
      await cancelAgentInstallJobRpc({ machineId, serverId, signal }, request),
    agentsModelsList: async (args) => {
      const { agentId, machineId, serverId, limit, backendTargetKey } = args as AgentsModelsListArgs;
      return await listAgentModelsForVoiceTool({ agentId, machineId, serverId, limit, backendTargetKey });
    },
    agentsConfigOptionsList: async (args) => await listAgentConfigOptionsForActions(args),
    agentsSessionModesList: async (args) => await listAgentSessionModesForActions(args),
    spawnConnectedServicesList: async (args) => await listSpawnConnectedServicesForActions(args),

    sessionSendMessage: opts?.sessionSendMessage ?? (async ({ sessionId, message, serverId, recipient, requestedAction }) => {
      const delivery = await sendSessionMessageWithServerScope({
        sessionId,
        message,
        serverId,
        recipient,
        requestedAction,
      });
      return projectServerScopedSessionSendMessageResult(delivery);
    }),

    sessionAttentionSet: async ({ sessionId, request, serverId }) => (
        await executeSessionAttentionSetAction({ sessionId, request, serverId: serverId ?? null })
    ),

    sessionApprovalReviewerSet: async ({ sessionId, enabled, serverId }) => {
      await sync.patchSessionMetadataWithRetry(sessionId, (metadata) => ({ ...metadata, approvalReviewerEnabled: enabled }), { serverId: serverId ?? null });
      return { updated: true };
    },

    sessionTitleSet: async ({ sessionId, title, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      const normalizedTitle = String(title ?? '').trim();
      if (!sid || !normalizedTitle) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }

      const updatedAt = Date.now();
      try {
        await publishDisplayTitleToMetadata({
          sessionId: sid,
          title: normalizedTitle,
          updatedAt,
          updateSessionMetadataWithRetry: async (targetSessionId, updater) => {
            await sync.patchSessionMetadataWithRetry(
              targetSessionId,
              updater,
              { serverId: typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null },
            );
          },
        });
      } catch (error) {
        const err = new Error(error instanceof Error ? error.message : 'action_failed');
        (err as Error & { code?: string }).code = 'action_failed';
        throw err;
      }

      return { ok: true, sessionId: sid, title: normalizedTitle, updatedAt };
    },

    sessionPermissionRespond: async ({ sessionId, requestId, turnId, decision, serverId, mode, reason, answers, allowedTools, updatedPermissions, execPolicyAmendment }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const request = buildSessionPermissionRespondRpcParamsV1({
        id: reqId, decision, ...(turnId ? { turnId } : {}),
        ...(mode === undefined ? {} : { mode }),
        ...(reason === undefined ? {} : { reason }),
        ...(answers === undefined ? {} : { answers }),
        ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
        ...(updatedPermissions === undefined ? {} : { updatedPermissions }),
        ...(execPolicyAmendment === undefined ? {} : { execPolicyAmendment }),
      });
      return projectSessionInteractionRpcResult(await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: request,
      }));
    },
    sessionPermissionRemoteAction: async (args) => {
      const rejectUnavailable = (
        code: 'canceled' | 'mediationStateUnavailable' | 'ownerMachineUnavailable',
      ) => args.actionId === 'session.permission.remote.pending.list'
        || args.actionId === 'session.permission.remote.grants.list'
        ? { ok: false as const, errorCode: code, error: code }
        : { status: 'rejected' as const, code };
      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }
      try {
        const result = await sessionRpcWithServerScope({
          sessionId: args.input.sessionId,
          serverId: args.serverId,
          method: args.actionId,
          payload: args.input,
        });
        return args.signal?.aborted ? rejectUnavailable('canceled') : result;
      } catch (error) {
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        throw error;
      }
    },
    sessionUserActionAnswer: async ({ sessionId, requestId, answers, decision, reason, updatedPermissions, serverId }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const normalizedAnswers = Object.create(null) as Record<string, readonly string[]>;
      for (const entry of Array.isArray(answers) ? answers : []) {
        const question = String(entry?.question ?? '');
        if (question.trim().length > 0 && entry.values.length > 0) {
          normalizedAnswers[question] = [...entry.values];
        }
      }
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId };
      }
      const approved = decision ? decision === 'approve' : true;
      return projectSessionInteractionRpcResult(await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
        payload: {
          id: reqId,
          approved,
          ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
          ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
        },
      }));
    },
    sessionModeSet: async ({ sessionId, modeId }) => {
      const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
      const control = resolveSessionModeActionControl(session);
      const normalizedModeId = normalizeRequestedSessionModeId(control, modeId);
      if (!isRequestedSessionModeSupported(control, normalizedModeId)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      await publishAcpSessionModeOverrideToMetadata({
        sessionId,
        modeId: normalizedModeId,
        updatedAt: Date.now(),
        updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
      });
      return { ok: true, sessionId, modeId: normalizedModeId };
    },
    sessionModelSet: async (args) => {
      const { sessionId, modelId, providerConnectionId, serverId } = args;
      const normalizedSessionId = String(sessionId ?? '').trim();
      const normalizedModelId = String(modelId ?? '').trim();
      if (!normalizedSessionId || !normalizedModelId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }

      const session = storage.getState().sessions[normalizedSessionId] ?? null;
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      const hasExplicitProviderConnectionId = Object.prototype.hasOwnProperty.call(
        args,
        'providerConnectionId',
      );
      const resolveRequest = (candidateSession: typeof session) => {
        const backend = resolveSessionActionDefaultBackend({
          session: candidateSession,
        });
        const target = resolveSessionActionDefaultTarget(backend);
        if (!target) return null;
        const agentTargetKey = buildBackendTargetKeyV2(target);
        const ownerMetadata = readSessionOwnerMetadataView(candidateSession);
        const currentIntent = resolveModelSelectionIntentFromSessionMetadata(
          ownerMetadata,
          agentTargetKey,
        );
        let resolvedProviderConnectionId: string | null;
        if (hasExplicitProviderConnectionId) {
          resolvedProviderConnectionId = providerConnectionId ?? null;
        } else {
          const ambient = resolveAmbientProviderConnectionForModelIntent({
            metadata: ownerMetadata,
            agentTargetKey,
            sessionActive: candidateSession.active === true,
          });
          // Unreadable Session Provider state is not a native selection. Refuse
          // before the transition RPC or the inactive metadata CAS runs.
          if (ambient.status === 'unreadable') return { refusal: ambient.code } as const;
          resolvedProviderConnectionId = ambient.providerConnectionId;
        }
        const parsed = SessionModelTransitionRequestV1Schema.safeParse({
          v: 1,
          selection: {
            agentTargetKey,
            providerConnectionId: resolvedProviderConnectionId,
            modelId: normalizedModelId,
          },
        });
        return parsed.success
          ? {
            request: parsed.data,
            currentIntent,
            agentTargetKey,
          }
          : null;
      };
      const initialRequest = resolveRequest(session);
      if (initialRequest && 'refusal' in initialRequest) {
        return {
          ok: false,
          errorCode: initialRequest.refusal,
          error: initialRequest.refusal,
        };
      }
      if (!initialRequest) {
        return {
          ok: false,
          errorCode: 'model_selection_agent_target_unknown',
          error: 'model_selection_agent_target_unknown',
        };
      }

      const invokeActiveOwner = async (
        request: SessionModelTransitionRequestV1,
      ) => {
        let transition: SessionModelTransitionResultV1;
        try {
          const result = await sessionRpcWithServerScope<
            SessionModelTransitionResultV1,
            SessionModelTransitionRequestV1
          >({
            sessionId: normalizedSessionId,
            serverId,
            method: SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
            payload: request,
          });
          transition = SessionModelTransitionResultV1Schema.parse(result);
        } catch (error) {
          transition = SessionModelTransitionResultV1Schema.parse({
            ok: false,
            status: 'owner_unavailable',
            activeSelection: null,
            requestedSelection: request.selection,
            reason: projectPluginFailureText(error),
          });
        }
        if (!transition.ok) {
          return {
            ok: false,
            errorCode: transition.status,
            error: transition.status,
            details: {
              status: transition.status,
              activeSelection: transition.activeSelection,
              requestedSelection: transition.requestedSelection,
              ...(transition.reason ? { reason: transition.reason } : {}),
            },
          };
        }
        return {
          ...transition,
          sessionId: normalizedSessionId,
          modelId: transition.activeSelection.modelId,
        };
      };

      return await runModelIntentAtAuthoritativeDisposition({
        observedActive: session.active === true,
        invokeObservedActiveOwner: async () =>
          await invokeActiveOwner(initialRequest.request),
        updateInactiveIntent: async () => {
          const candidate = createModelIntentMetadataCasCandidate({
            selection: initialRequest.request.selection,
          });
          await sync.patchSessionMetadataWithRetry(
            normalizedSessionId,
            candidate.update,
            {
              serverId:
                typeof serverId === 'string'
                && serverId.trim().length > 0
                  ? serverId.trim()
                  : null,
              sessionExpectation: { kind: 'inactive_model_intent' },
            },
          );
          const candidateState = candidate.readState();
          if (
            !candidateState.accepted
            || candidateState.updatedAt === null
          ) {
            return {
              ok: false,
              errorCode: 'superseded',
              error: 'superseded',
              details: {
                status: 'superseded',
                activeSelection:
                  initialRequest.currentIntent?.selection ?? {
                    agentTargetKey: initialRequest.agentTargetKey,
                    providerConnectionId: null,
                    modelId: 'default',
                  },
                requestedSelection: initialRequest.request.selection,
                reason: 'accepted_intent_was_superseded',
              },
            };
          }
          return {
            ok: true,
            status: 'intent_updated',
            sessionId: normalizedSessionId,
            modelId: initialRequest.request.selection.modelId,
            selection: initialRequest.request.selection,
            updatedAt: candidateState.updatedAt,
          };
        },
        resolveAndInvokeActiveOwnerAfterConflict: async () => {
          const currentSession =
            storage.getState().sessions[normalizedSessionId] ?? null;
          if (!currentSession || currentSession.active !== true) {
            return {
              ok: false,
              errorCode: 'owner_unavailable',
              error: 'owner_unavailable',
              details: {
                status: 'owner_unavailable',
                activeSelection: null,
                requestedSelection: initialRequest.request.selection,
                reason: 'session_model_transition_owner_unproven',
              },
            };
          }
          const currentRequest = resolveRequest(currentSession);
          if (currentRequest && 'refusal' in currentRequest) {
            return {
              ok: false,
              errorCode: currentRequest.refusal,
              error: currentRequest.refusal,
            };
          }
          if (!currentRequest) {
            return {
              ok: false,
              errorCode: 'owner_unavailable',
              error: 'owner_unavailable',
              details: {
                status: 'owner_unavailable',
                activeSelection: null,
                requestedSelection: initialRequest.request.selection,
                reason:
                  'session_model_transition_owner_metadata_unavailable',
              },
            };
          }
          return await invokeActiveOwner(currentRequest.request);
        },
      });
    },
    sessionModesList: async ({ sessionId }) => {
      const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
      return {
        items: serializeSessionModeActionOptions(resolveSessionModeActionControl(session)).map((option) => ({
          id: option.value,
          label: option.label,
          ...(typeof option.description === 'string' && option.description.trim().length > 0
            ? { description: option.description }
            : {}),
        })),
      };
    },

    sessionTargetPrimarySet: async ({ sessionId, serverId }) => await setPrimaryActionSessionId({ sessionId, serverId }),
    sessionTargetTrackedSet: async (targets) => await setTrackedSessionIds({
        ...('sessionAddresses' in targets ? { sessionAddresses: targets.sessionAddresses } : { sessionIds: targets.sessionIds }),
        serverId: targets.context.serverId,
        corpus: await acquireAdmittedSessionReferenceCorpusOptions(storage.getState()) ?? undefined,
    }),
    sessionList: listSessionsForVoiceTool,
    sessionActivityGet: async (params) => await getSessionActivityForVoiceTool(params),
    sessionTranscriptGet: async ({ sessionId, serverId, projection, limit, cursor, roles, maxCharsPerMessage }) =>
      await getSessionTranscriptForVoiceTool({
        sessionId,
        ...(serverId !== undefined ? { serverId } : {}),
        ...(projection ? { projection } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(roles ? { roles } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage } : {}),
      }),
    sessionRecentMessagesGet: async ({ sessionId, serverId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) =>
      await getSessionRecentMessagesForVoiceTool({ sessionId, serverId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }),

    resetGlobalVoiceAgent: async () => {
      await resetVoiceAgentPersistenceState({
        stop: async () => await voiceSessionManager.stop(VOICE_AGENT_GLOBAL_SESSION_ID),
      });
    },
    teleportVoiceAgentToSessionRoot: async ({ sessionId }) => await teleportVoiceAgentToSessionRoot({ sessionId }),

    daemonMemorySearch: async ({ machineId, query, serverId, signal }) => {
      const accountLifetime = captureActiveServerAccountScopeLifetime();
      if (!accountLifetime) {
        return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'Account scope is unavailable.' };
      }
      const exactServerId = String(serverId ?? accountLifetime.scope.serverId).trim();
      if (!exactServerId || !areServerProfileIdentifiersEquivalent(exactServerId, accountLifetime.scope.serverId)) {
        return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'Exact Account scope is unavailable.' };
      }
      const authority = await captureMemorySearchSessionReadAuthority({
        serverId: exactServerId,
        accountId: accountLifetime.scope.accountId,
      });
      try {
        const result = MemorySearchResultV1Schema.parse(await machineRpcWithServerScope({
          machineId,
          serverId: exactServerId,
          accountId: accountLifetime.scope.accountId,
          preferScoped: true,
          method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
          payload: query,
          ...(signal ? { signal } : {}),
        }));
        if (!result.ok) return result;
        return await authorizeMemorySearchResult({
          result,
          serverId: exactServerId,
          accountId: accountLifetime.scope.accountId,
          authority,
          accountLifetime,
          readSessionForServerScope: readMemorySearchSessionForServerScope,
          concurrencyLimit: readMemorySearchSessionHydrationConcurrencyLimit(),
          ...(signal ? { signal } : {}),
        });
      } finally {
        await authority.release();
      }
    },

    daemonMemoryGetWindow: async ({ machineId, sessionId, seqFrom, seqTo, serverId, signal }) => {
      const accountLifetime = captureActiveServerAccountScopeLifetime();
      const exactServerId = String(serverId ?? accountLifetime?.scope.serverId ?? '').trim();
      if (
        !accountLifetime
        || !exactServerId
        || !areServerProfileIdentifiersEquivalent(exactServerId, accountLifetime.scope.serverId)
      ) {
        throw Object.assign(new Error('Exact Account scope is unavailable.'), { code: 'not_authenticated' as const });
      }
      const authority = await captureMemorySearchSessionReadAuthority({
        serverId: exactServerId,
        accountId: accountLifetime.scope.accountId,
      });
      try {
        const authorized = await authorizeMemorySessionRange({
          target: {
            sessionKey: `${accountLifetime.scope.accountId}:${exactServerId}:${sessionId}`,
            serverId: exactServerId,
            accountId: accountLifetime.scope.accountId,
            sessionId,
          },
          seqFrom,
          seqTo,
          authority,
          accountLifetime,
          readSessionForServerScope: readMemorySearchSessionForServerScope,
          ...(signal ? { signal } : {}),
        });
        if (!authorized) {
          throw Object.assign(new Error('Memory window is outside the current Session projection.'), {
            code: 'not_authenticated' as const,
          });
        }
        return await machineRpcWithServerScope({
          machineId,
          serverId: exactServerId,
          accountId: accountLifetime.scope.accountId,
          preferScoped: true,
          method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
          payload: { v: 1, sessionId, seqFrom, seqTo },
          ...(signal ? { signal } : {}),
        });
      } finally {
        await authority.release();
      }
    },

    daemonMemoryEnsureUpToDate: async ({ machineId, sessionId, serverId }) =>
      await machineRpcWithServerScope({
        machineId,
        serverId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        payload: sessionId ? { sessionId } : {},
      }),

    approvalsCreate: async ({ request }) => {
      const header: ArtifactHeader = buildApprovalRequestArtifactHeaderV1(request);
      const artifactId = await (accountContext ? accountContext.createArtifact(header, JSON.stringify(request)) : sync.createArtifactWithHeader(header, JSON.stringify(request)));
      approvalCoordinator.notifyApprovalUpdated({ artifactId, request });
      return { artifactId };
    },

    approvalsGet: async ({ artifactId }) => {
      const local = accountContext ? null : storage.getState().artifacts[artifactId] ?? null;
      const localBody = local?.body;
      const localHeader = local?.header;
      // The reader is body-authoritative but still indexes on the header, so a
      // locked or header-less Artifact has nothing to match against.
      if (localHeader && typeof localBody === 'string') {
        const parsed = approvalArtifactBodyMatchesHeaderV1(localHeader, localBody);
        if (parsed?.family === 'built_in') return parsed.request;
      }

      const full = await (accountContext ? accountContext.fetchArtifact(artifactId) : sync.fetchArtifactWithBody(artifactId));
      if (full) {
        if (!accountContext) storage.getState().updateArtifact(full);
        const body = full.body;
        if (typeof body !== 'string' || !full.header) return null;
        const parsed = approvalArtifactBodyMatchesHeaderV1(full.header, body);
        return parsed?.family === 'built_in' ? parsed.request : null;
      }

      return null;
    },

    approvalsUpdate: async ({ artifactId, request }) => {
      const written = await writeApprovalRequestArtifact({
        artifactId,
        request,
        read: async (id) => await (accountContext ? accountContext.fetchArtifact(id) : sync.fetchArtifactWithBody(id)),
        write: async (basis, header, body) => {
          if (accountContext) {
            await accountContext.updateArtifact(artifactId, header, body, basis);
            return;
          }
          // The focused-sync writer takes its expected versions from the cached
          // row synchronously when called; seed it with the validated read and
          // call it in the same tick so that read stays the CAS basis.
          storage.getState().updateArtifact(basis);
          try {
            await sync.updateArtifactWithHeader(artifactId, header, body);
          } catch (error) {
            // A lost CAS means another writer committed after that read. Put the
            // durable row back in the cache the executor rereads, so the loser
            // observes the winner's claim or terminal result, never its own basis.
            const latest = await sync.fetchArtifactWithBody(artifactId);
            if (latest) storage.getState().updateArtifact(latest);
            throw error;
          }
        },
      });
      if (written.ok) approvalCoordinator.notifyApprovalUpdated({ artifactId, request });
      return written;
    },

    approvalsResolveBlockingDecision: async ({ artifactId, request, decision }) =>
      await approvalCoordinator.resolveBlockingDecision({ artifactId, request, decision }),

    approvalsWaitForDecision: async ({ artifactId, request, serverId, signal }) => {
      const accountLifetime = accountContext?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
      const scopeChanged = () => Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' as const });
      if (!accountLifetime || (serverId && !areServerProfileIdentifiersEquivalent(serverId, accountLifetime.scope.serverId))) {
        throw scopeChanged();
      }
      const assertCurrent = () => {
        if (!accountLifetime.isCurrent()) throw scopeChanged();
      };
      assertCurrent();
      const decision = await approvalCoordinator.waitForDecision({
        artifactId,
        request,
        serverId,
        signal,
        subscribeChanges: (onChange, onError) => {
          const unsubscribe = subscribeHomeAccountChange((change) => {
            if (!areServerProfileIdentifiersEquivalent(change.serverId, accountLifetime.scope.serverId)
              || (change.entityIds !== undefined && !change.entityIds.includes(artifactId))) return;
            if (!accountLifetime.isCurrent()) onError(scopeChanged());
            else onChange();
          });
          const retirement = accountLifetime.onRetire(() => onError(scopeChanged()));
          return { dispose: () => { unsubscribe(); retirement.dispose(); } };
        },
        readRequest: async () => {
          assertCurrent();
          // A wake invalidates the durable Artifact, not the optimistic approval cache.
          const full = await (accountContext ? accountContext.fetchArtifact(artifactId) : sync.fetchArtifactWithBody(artifactId));
          assertCurrent();
          if (!full?.header || typeof full.body !== 'string') return null;
          const parsed = approvalArtifactBodyMatchesHeaderV1(full.header, full.body);
          return parsed?.family === 'built_in' ? parsed.request : null;
        },
      });
      return { ...decision, request: ApprovalRequestSchema.parse(decision.request) };
    },

    promptDocGet: async (args) => readPromptDocInLibrary({ store: promptLibraryStore, ...args }),
    promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store: promptLibraryStore, request, signal }),
    promptDocFavoriteSet: async ({ signal, ...request }) => setPromptDocFavorite({ store: promptLibraryStore, request, signal }),
    promptsLibraryList: async ({ signal, ...request }) => listPromptLibrary({ store: promptLibraryStore, request, signal }),
    promptDocUpdate: async ({ signal, ...request }) => updatePromptDocInLibrary({ store: promptLibraryStore, request, signal }),

    promptBundleUpdate: async ({ artifactId, title, skillMarkdown, folderId, tags }) => {
      await updateSkillPromptBundle({ artifactId, title, skillMarkdown, ...(typeof folderId !== 'undefined' ? { folderId } : {}), ...(tags ? { tags } : {}) });
      return { ok: true, artifactId };
    },

    promptAssetExport: async ({ artifactId, machineId, assetTypeId, scope, serverId, directory, targetPath, targetName, installMode }) => {
      const expectedSettingsScope = storage.getState().settingsScope ?? null;
      const result = await writePromptLibraryArtifactToExternalAsset({
        artifactId,
        machineId,
        assetTypeId,
        scope,
        serverId,
        workspacePath: directory ?? null,
        targetInput: targetPath ?? targetName ?? '',
        installMode,
        promptExternalLinks: storage.getState().settings.promptExternalLinksV1,
        previewOnly: false,
      });
      if (!result.ok || !result.nextPromptExternalLinks) {
        return { ok: false, errorCode: result.ok ? 'invalid_parameters' : (result.errorCode ?? 'invalid_parameters'), error: result.ok ? 'invalid_parameters' : result.error };
      }
      sync.applySettings({ promptExternalLinksV1: result.nextPromptExternalLinks }, {
        expectedSettingsScope,
        source: 'ui',
      });
      return { ok: true, artifactId, exported: true };
    },

    promptRegistryInstall: async ({ machineId, sourceId, itemId, configuredSources, serverId, installTarget }) => {
      const expectedSettingsScope = storage.getState().settingsScope ?? null;
      const result = await installPromptRegistryItem({
        machineId,
        sourceId,
        itemId,
        configuredSources,
        serverId,
        promptExternalLinks: storage.getState().settings.promptExternalLinksV1,
        ...(installTarget ? { installTarget } : {}),
      });
      if (!result.ok) {
        return { ok: false, errorCode: 'invalid_parameters', error: result.error, ...(result.artifactId ? { artifactId: result.artifactId } : {}) };
      }
      if (result.nextPromptExternalLinks) {
        sync.applySettings({ promptExternalLinksV1: result.nextPromptExternalLinks }, {
          expectedSettingsScope,
          source: 'ui',
        });
      }
      return { ok: true, artifactId: result.artifactId, exported: result.exported };
    },

    ...(opts?.resolveServerIdForSessionId ? { resolveServerIdForSessionId: opts.resolveServerIdForSessionId } : {}),
  };

  const companionDeps = accountContext ? createWidgetCompanionActionDepsV1(accountContext) : {};
  const areaDeps = createWidgetAreaActionDepsV1(accountContext);
  const widgetSurfaceDeps = { ...deps, widgetSurfaceActions: { ...deps.widgetSurfaceActions, ...companionDeps.widgetSurfaceActions, ...areaDeps.widgetSurfaceActions } };
  const widgetDefinitionDeps = { ...widgetSurfaceDeps, ...createWidgetDefinitionActionDepsV1(accountContext, widgetSurfaceDeps) };
  const widgetHostDeps = { ...widgetDefinitionDeps, ...createWidgetCatalogActionDepsV1(accountContext, widgetDefinitionDeps) };
  const widgetInputDeps = { ...widgetHostDeps, ...createWidgetInputActionDepsV1(accountContext, widgetHostDeps) };
  const executor = createActionExecutor({ ...widgetInputDeps, ...createWidgetRefreshActionDepsV1(accountContext, widgetInputDeps) });

  // Surface attribution is owned by the host that constructs the executor, mirroring
  // `apps/cli/src/session/actions/createCliActionExecutor.ts` (`?? 'cli'`). This factory is the
  // app client's entrypoint, so an unattributed caller is a `ui` caller — a `voice` or `plugin`
  // caller stamps its own surface and still wins. Without this the surface reaches the catalog
  // gate nullish, which now fails closed (INV-1 / DEC-2).
  const resolveContext = (context: Parameters<typeof executor.execute>[2], input: unknown): ActionExecutorContext => {
    const surface = context?.surface ?? 'ui';
    const credential = accountContext?.credentialAuthorityKind ?? getCurrentAuth()?.credentialAuthorityKind ?? 'none';
    const authority = opts?.admittedClientAction
      ? context?.authority ?? 'account_automation'
      : resolveInvocationAuthority({ credential, surface });
    // Ordinary UI callers do not author approval provenance. Retain stronger
    // invocation identities, otherwise bind one attempt at this host before
    // execute/prepare reaches the strict approval-origin owner.
    const creationKey = typeof input === 'object' && input !== null && 'creationKey' in input
      && typeof input.creationKey === 'string' ? input.creationKey.trim() : undefined;
    return {
      ...(context ?? {}),
      surface,
      authority,
      ...(opts?.admittedClientAction ? { bypassApprovals: true } : {}),
      ...(surface === 'ui' && (credential === 'account' || credential === 'terminal')
        ? { actionRequestId: context?.actionRequestId ?? (creationKey || randomUUID()) }
        : {}),
    };
  };

  return {
    readWidgetMovementAdmission: (ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, context: ActionExecutorContext) =>
      readWidgetEntityMovementAdmission(widgetInputDeps, ref, surface, resolveContext(context, { ref })),
    prepare: async (actionId, input, context) => await executor.prepare(actionId, input, resolveContext(context, input)),
    execute: async (actionId, input, context) => await executor.execute(actionId, input, resolveContext(context, input)),
    replayApprovedApprovalRequest: async (args) => await executor.replayApprovedApprovalRequest(args),
  };
}


type DefaultActionExecutorOptions = Parameters<typeof buildDefaultActionExecutor>[0];
/** UI-only projection qualifier; the captured Account owner enforces it before admission. */
export type UiActionExecutorContext = ActionExecutorContext & Readonly<{ expectedAccountId?: string }>;
type DefaultActionExecutor = Omit<ReturnType<typeof createActionExecutor>, 'execute' | 'prepare'> & Readonly<{
  execute: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['execute']>;
  prepare: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['prepare']>;
}>;
type DefaultActionExecuteContext = Pick<UiActionExecutorContext, 'expectedAccountId'> & Readonly<{
  serverId: string;
  signal?: AbortSignal;
  /** Synchronously consumes a failure only while this captured Account is still current. */
  onCurrentError?: (error: unknown) => void;
}>;

export function isActionAccountScopeChangedError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'action_account_scope_changed';
}

/**
 * Runs an immediate Action and its synchronous result consumer inside one captured Account/Home
 * lifetime. Deferred preparation deliberately retains its separate runPrepared custody below.
 */
/**
 * The Session-access, Session-discussion and Home family ports bound to one
 * captured exact Home/Account scope. They reuse each family's existing
 * transport owner — its authorization, feature, encryption and freshness
 * checks stay there — and only add the currentness of the captured scope.
 */
function createCapturedScopeFamilyPorts(account: LazyActionAccountContext): Readonly<{
  sessionAccessAction: NonNullable<ActionExecutorDeps['sessionAccessAction']>;
  sessionDiscussionAction: NonNullable<ActionExecutorDeps['sessionDiscussionAction']>;
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
}> {
  const scope = { serverId: account.serverId, accountId: account.accountId };
  const isCurrent = (): boolean => {
    try {
      account.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const readCollaborationAvailability = async () => {
    const snapshot = await getServerFeaturesSnapshot({ serverId: scope.serverId });
    const settings = storage.getState().settings;
    return resolveSessionCollaborationAvailability(resolveRuntimeFeatureDecisionFromSnapshot({
      featureId: 'sharing.session',
      settings,
      snapshot,
      scope: { scopeKind: 'spawn', serverId: scope.serverId },
    })?.state === 'enabled');
  };
  const homeDomainAction = createHomeDomainActionExecutorForScope(scope);
  const organizationResourceAction = createSessionOrganizationResourceAction(account);
  return {
    homeDomainAction: async (args) => {
      account.assertCurrent();
      if (isSessionOrganizationResourceAction(args.actionId)) return await organizationResourceAction(args);
      return await homeDomainAction(args);
    },
    sessionAccessAction: async (args) => {
      account.assertCurrent();
      const { executeSessionAccessHttpAction, SessionAccessApiError } = await import('@/sync/api/session/sessionAccessApi');
      try {
        return await executeSessionAccessHttpAction({
          scope,
          availability: await readCollaborationAvailability(),
          isCurrent,
          actionId: args.actionId,
          input: args.input,
          ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (error) {
        // The family leaf reports typed refusals by throwing; the executor's
        // port contract is the failure envelope.
        if (error instanceof SessionAccessApiError) {
          return { ok: false as const, errorCode: error.code, error: error.code };
        }
        throw error;
      }
    },
    sessionDiscussionAction: async (args) => {
      account.assertCurrent();
      const sessionId = typeof (args.input as { sessionId?: unknown } | null)?.sessionId === 'string'
        ? (args.input as { sessionId: string }).sessionId
        : args.context.defaultSessionId;
      if (!sessionId) return { ok: false as const, errorCode: 'session_discussion_not_found', error: 'session_discussion_not_found' };
      const session = { serverId: scope.serverId, sessionId };
      const availability = await readCollaborationAvailability();
      const { createSessionDiscussionActionAdapter } = await import('@/sync/api/session/sessionDiscussionActions');
      const result = await sync.withSessionSystemRecordRuntime(session, async (runtime) => {
        if (runtime.scope.accountId !== scope.accountId || !isCurrent()) {
          return { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        return await createSessionDiscussionActionAdapter({
          request: runtime.request,
          contentContext: runtime.contentContext,
          session,
          availability,
        })(args);
      });
      return result.status === 'ok'
        ? result.value
        : { ok: false as const, errorCode: result.status, error: result.status };
    },
  };
}

export async function withDefaultActionExecuteContext<TResult>(
  opts: DefaultActionExecutorOptions,
  context: DefaultActionExecuteContext,
  work: (executor: ReturnType<typeof buildDefaultActionExecutor>, account: LazyActionAccountContext) => Promise<TResult>,
  executedActionId?: ActionId,
): Promise<TResult> {
  const account = await captureLazyActionAccountContext(context.serverId, context.signal);
  try {
    try {
      if (context.expectedAccountId !== undefined && account.accountId !== context.expectedAccountId) {
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
      }
      const settings = await account.readSettings();
      account.assertCurrent();
      context.signal?.throwIfAborted();
      const result = await work(buildDefaultActionExecutor(opts, { ...account, settings }), account);
      const effectClass = executedActionId ? getActionSpec(executedActionId).sideEffectClass : undefined;
      // Return an effect's actual disposition to its captured invoker. Retirement
      // suppresses Account projection publication, but cannot rewrite an acknowledgement.
      // Reads still require current custody before disclosing Account content.
      account.assertResultCurrent(effectClass);
      return result;
    } catch (error) {
      if (!context.onCurrentError) throw error;
      // Account-currentness failures are custody refusals, not failures belonging to the stale
      // projection. Every other failure may be synchronously projected before this lifetime ends.
      if (isActionAccountScopeChangedError(error)) throw error;
      account.assertCurrent();
      context.onCurrentError(error);
      account.assertCurrent();
      throw error;
    }
  } finally {
    account.dispose();
  }
}

/** Read-only drag admission borrows the complete Action dependency composition and exact Account lifetime. */
export async function readDefaultWidgetMovementAdmission(ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, signal?: AbortSignal) {
  return withDefaultActionExecuteContext(undefined, { serverId: surface.serverId, expectedAccountId: surface.accountId, signal },
    executor => executor.readWidgetMovementAdmission(ref, surface, { surface: 'ui', serverId: surface.serverId, signal }));
}

export function createDefaultActionExecutor(opts?: DefaultActionExecutorOptions): DefaultActionExecutor {
  let unscoped: ReturnType<typeof createActionExecutor> | undefined;
  const ordinary = () => unscoped ?? (unscoped = buildDefaultActionExecutor(opts));
  // Capture an implicit UI Home at invocation, then use the same credential
  // lifetime as explicitly scoped callers. Other surfaces retain their existing targeting.
  const resolveInvocationServerId = (actionId: ActionId, context?: UiActionExecutorContext) => context?.serverId
    ?? ((isRoleActionIdV1(actionId) || (context?.surface ?? 'ui') === 'ui')
      ? getActiveServerAccountScope()?.serverId : undefined);
  const apiTokenTransport = async (): Promise<ApiTokenActionTransport | null> => {
    if (opts?.apiTokenAction) return opts.apiTokenAction;
    if (getCurrentAuth()?.credentialAuthorityKind !== 'api_token') return null;
    const scoped = (await import('@/sync/sync')).sync.getEmbedSessionRequestContext();
    if (!scoped || !scoped.isCurrent()) throw new Error('action_account_scope_changed');
    return { request: scoped.request, target: { kind: 'session', sessionId: scoped.sessionId } };
  };
  const accountScopeFailure = (error: unknown) => isActionAccountScopeChangedError(error)
    ? { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }
    : null;
  return {
    execute: async (actionId, input, context) => {
      const api = await apiTokenTransport();
      if (api) return await executeApiTokenAction(api, actionId, input, context);
      const serverId = resolveInvocationServerId(actionId, context);
      if (!serverId) return await ordinary().execute(actionId, input, context);
      try {
        return await withDefaultActionExecuteContext(opts, { ...context, serverId }, async (executor, account) => (
          await executor.execute(actionId, input, {
            ...context,
            serverId,
            ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
            runtimeAccountId: account.accountId,
          })
        ), actionId);
      } catch (error) {
        const failure = accountScopeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    prepare: async (actionId, input, context) => {
      const api = await apiTokenTransport();
      if (api) return { kind: 'ready', invocation: { run: async () => await executeApiTokenAction(api, actionId, input, context) } };
      const serverId = resolveInvocationServerId(actionId, context);
      if (!serverId) return await ordinary().prepare(actionId, input, context);
      const account = await captureLazyActionAccountContext(serverId, context?.signal);
      try {
        if (context?.expectedAccountId !== undefined && account.accountId !== context.expectedAccountId) {
          throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        }
        const settings = await account.readSettings();
        account.assertCurrent();
        context?.signal?.throwIfAborted();
        const prepared = await buildDefaultActionExecutor(opts, { ...account, settings }).prepare(actionId, input, {
          ...context,
          serverId,
          ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
          runtimeAccountId: account.accountId,
        });
        account.assertCurrent();
        account.dispose();
        if (prepared.kind === 'settled') return prepared;
        let result: ReturnType<typeof prepared.invocation.run> | undefined;
        return {
          kind: 'ready',
          invocation: {
            run: () => {
              result ??= account.runPrepared(() => prepared.invocation.run(), getActionSpec(actionId).sideEffectClass);
              return result;
            },
          },
        };
      } catch (error) {
        account.dispose();
        const failure = accountScopeFailure(error);
        if (failure) return { kind: 'settled', result: failure };
        throw error;
      }
    },
    replayApprovedApprovalRequest: async (args) => {
      const api = await apiTokenTransport();
      if (api) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      return await ordinary().replayApprovedApprovalRequest(args);
    },
  };
}
import { createVoiceAgentSettingsCatalogReader } from './voiceAgentSettingsCatalog';
import { createWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
