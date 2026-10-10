import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { projectAutomationEligibleEventsCatalogV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { StoredContentPublicSharesListResponseV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { createWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createUiProjectWorkerActionV1 } from './projectWorkerAction';
import { createUiProjectContextAction } from './projectContextAction';
import { readUiMemoryInheritedContext, readUiMemoryScopeContext } from './readUiMemoryInheritedContext';
import { createWidgetRefreshActionDepsV1 } from './widgetRefreshActionDeps';
import { createWidgetDefinitionActionDepsV1 } from './widgetDefinitionActionDeps';
import { executeComposerIngressAction } from './composerIngressActionRuntime';
import { createWidgetCompanionActionDepsV1 } from './widgetCompanionActionDeps';
import { readWidgetEntityMovementAdmission } from './widgetEntityMovement';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, readWidgetActionSurfacePortV1, flattenWidgetLayoutWidgetsV1, type WidgetInstanceRefV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { forgetHistoricalEncryptionKey } from '@/sync/ops/account/forgetHistoricalEncryptionKey';
import { recoverHistoricalAutomationTemplates } from '@/sync/ops/account/recoverHistoricalAutomationTemplates';
import { startAgentSignInRpc, checkAgentSignInRpc } from '@/agents/machineAgents/signIn/api';
import { buildSessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { buildMachineAgentsDetectRequest, projectMachineAgentsDetectResponse, MachineAgentInventoryUnavailableError } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema, requiresExactDaemonApprovalReplay, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { normalizeActionsSettingsV1, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD, type CurrentSessionPresentationActionResultV1 } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createUiProviderActionExecuteV1 } from './providerActionDeps';
import { isSessionStateFieldActionId } from '@happier-dev/protocol/actions';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { ActionOperationActionIdV1Schema, ActionOperationActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/actionOperations';
import { PROJECT_SOURCE_ACTION_SPECS_V1 } from '@happier-dev/protocol/actions/specs/projectSources';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, isProjectActionIdV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { MachineWorkSummaryGetInputV1Schema } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { ProjectContextUpdateInputV1Schema } from '@happier-dev/protocol/projects/projectContextV1';
import { decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { createTerminalUtf8ProjectionDecoder, TERMINAL_OUTPUT_GAP_MARKER } from '@/sync/domains/terminal/stream/runtime';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { createPromptDocInLibrary, setPromptDocFavorite, listPromptLibrary, readPromptDocInLibrary, updatePromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { resolvePromptDocCreateActionInputV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { MEMORY_DOCUMENT_ACTION_IDS_V1, MemoryActionInputSchemasV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readPromptLibraryCatalogProjectionInContext, mutatePromptLibraryRoleOverrideInContext, writePromptLibraryRecordAndPublishInContext,
  requireUpdatedPromptLibraryMutation, PromptLibraryRowOperationError } from '@/sync/api/account/apiPromptLibraryCatalog';
import type { PromptExternalLinksV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionBackendTargetSelection } from '@happier-dev/protocol/actions/resolveActionBackendTargetSelection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createLaunchProfilePublisherV1 } from '@happier-dev/protocol/launchProfiles/publishLaunchProfile';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { readProfileCatalogProjectionInContext, writeProfileRecordInContext } from '@/sync/api/account/apiProfileCatalog';
import { AcpCatalogOperationError, readAcpCatalogInContext, updateAcpCatalogInContext } from '@/sync/api/account/apiAcpCatalog';
import { createWorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createArtifactAccessActionsV1 } from '@happier-dev/protocol/actions/executor/artifactAccessActions';
import { createAccountRoleActionExecutorV1, createRoleArtifactStoreV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { isRoleActionIdV1 } from '@happier-dev/protocol/prompts/roles/roleActionIdsV1';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { readUiPluginRoleSources } from '@/sync/ops/roles/roleSources';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { PluginWebhookActionHttpPathsV1, type PluginWebhookPresentUserActionIdV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { projectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';
import { SessionModelTransitionRequestV1Schema, SessionModelTransitionResultV1Schema, type SessionModelTransitionRequestV1, type SessionModelTransitionResultV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import type { ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';
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
  sessionBoardActionUsesLayoutV1,
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
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { prepareRequesterSessionForSpawn, resolveRequesterSessionSpawnDisposition } from './requesterSessionSpawnPreparation';
import { createUiArtifactAction } from './artifactActionDeps';
import { createUiProfileActionExecuteV1 } from './profileActionDeps';
import { createUiMcpServerActionExecuteV1 } from './mcpServerActionDeps';
import { createUiRemoteHostActionExecuteV1 } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { createUiHomeRuntimeActionExecute } from './homeRuntimeActionDeps';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { createWidgetCatalogActionDepsV1 } from './widgetCatalogActionDeps';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureMountedWorkspaceAction, invokeWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { invokeSessionCanvasAction } from '@/components/sessions/canvas/sessionSplitCanvasRuntime';
import { invokeWorkflowConversationBinding } from './workflowAuthoringAction';
import { openSessionAuthoringDraft } from './sessionAuthoringOpenAction';
import { invokeSessionListOrganizationAction } from '@/components/sessions/shell/drag/sessionListOrganizationAction';
import { createSessionOrganizationMutationScopeForAccount, writeSessionOrganizationPin } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { scmReviewComparisonOfSource } from '@/sync/domains/scm/diffSummary/selection';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createSettingsDeclarationAction, resolveSettingsDeclarationOperationApprovalRequired } from './settingsDeclarationAction';
import { createSettingsOwnerActionExecutor } from './settingsOwnerActionExecutor';
import { getAutomationSettings, updateAutomationSettings } from '@/sync/api/automations/apiAutomations';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { createAppShellAction } from './appShellAction';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';
import { executeAppUpdateAction } from '@/updates/appUpdateActionRuntime';
import { executeExternalSessionBrowseAction } from './externalSessionBrowseAction';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import { createUiUsageActionPorts } from './usageActionDeps';
import { createUiUsageSourceActionPort } from './usageSourceActionDeps';
import { createUiScmAction } from './scmActionDeps';
import { createUiFilesystemAction, resolveUiFilesystemTransferCustodyFailure } from './filesystemActionDeps';
import { createUiProjectDefinitionAction } from './projectDefinitionActionDeps';
import { createUiProjectAction } from './projectActionDeps';
import { resolveSettingsHost, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { executeCommandPaletteAction } from '@/components/appShell/commandPalette/commandPaletteActionRuntime';
import { executeFindAction } from '@/keyboard/findActionRuntime';
import { executePromptPickerOpenAction } from '@/components/sessions/agentInput/commandMenu/promptPickerActionRuntime';
import { invokeNextPendingRequest } from '@/activity/source/pendingNavigationRuntime';
import { executeApiTokenAction, type ApiTokenActionTransport } from './apiTokenActionTransport';
import { createMachinePoolActionClient, MachinePoolActionError } from '@/sync/api/machines/machinePoolActions';
import { createMachinePresetActionClient, MachinePresetActionError } from '@/sync/api/machines/managedMachinePresets';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { executeManagedMachineNativeAction } from '@/sync/api/machines/managedMachineOrigination';
import { createUiManagedMachineReferenceReader } from './managedMachineReferenceDeps';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createRunnerActivationClient, RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { RunnerActivationCreateRequestV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { writeUiSessionStateField, type UiSessionStateMetadataPreprocess } from '@/sync/state/engine';
import { admitDeclaredSessionVoicePreferenceV1, readBuiltInSessionVoiceDeclarationV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createUiExecutionRunActionDeps } from './executionRunActionDeps';
import { createMachineConnectionActionDeps } from './machineConnectionActionDeps';
import {
    forkSession as forkSessionOp,
    rollbackSessionCheckpointCode as rollbackSessionCheckpointCodeOp,
    rollbackSessionConversation as rollbackSessionConversationOp,
    sessionStopWithServerScope,
    sessionArchiveWithServerScope,
    sessionUnarchiveWithServerScope,
    sessionRespondToPermission,
    sessionRespondToUserAction,
    sessionAbort,
    resumeSession,
} from '@/sync/ops/sessions';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { buildResumeCapabilityOptionsFromUiState, buildResumeSessionExtrasFromUiState } from '@/agents/registry/registryUiBehavior';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { applyPermissionModeSelectionEffect } from '@/sync/domains/permissions/permissionModeApply';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { loadSessionPermissionModes, loadSessionPermissionModeUpdatedAts, saveSessionPermissionModes,
  saveSessionPermissionModeUpdatedAts } from '@/sync/domains/state/sessionPersistence';
import { nowServerMs } from '@/sync/runtime/time';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { fireAndForget } from '@/utils/system/fireAndForget';
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
  projectServerScopedSessionSendMessageResult,
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
  getServerProfileById,
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
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { canUsePrivateProjectAccountAction, createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { setProjectVisibilityV1 } from '@happier-dev/protocol/projects/projectVisibilityV1';
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
  resolveAgentInventoryProbeTarget,
  probeAgentModelsForActions,
  type AgentInventoryProbeTarget,
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
import { createUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { admitSessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
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
  /** Private presentation leaf for this invocation; never enters Action custody. */
  openRoute?: (route: string) => void | Promise<void>;
  /** Mounted output host presentation; admission and operation lookup remain Action-owned. */
  actionOperationOpenOutput?: (address: Readonly<{ serverId: string; machineId: string; operationId: string }>) => void | Promise<void>;
  /** Surface-local custody notification, fired only by the admitted Provider RPC transport. */
  onProviderRpcDispatched?: () => void;
  /** An explicitly admitted API-token transport; Home owns grants and approvals. */
  apiTokenAction?: ApiTokenActionTransport;
  /** Private Machine reverse-RPC continuation: admission/approval happened in the daemon. */
  admittedClientActionId?: ActionId;
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
  openSession?: (sessionId: string, options?: OpenSessionOptions) => void | Promise<void>;
  runtimeActions?: CreateDefaultRuntimeActionExecutorInput;
  /** Native/process task transport for local client Actions; admission stays with this executor. */
  homeRuntimeRunner?: SystemTaskRunner;
  listContributedActionDefinitions?: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>;
  readContributedActionSchemas?: NonNullable<ActionExecutorDeps['readContributedActionSchemas']>;
  /** Optional surface-local policy composed with the canonical Action settings policy. */
  isActionEnabled?: NonNullable<ActionExecutorDeps['isActionEnabled']>;
  /** Optional delivery leaf used by a surface that needs specialized ingress semantics. */
  sessionSendMessage?: NonNullable<ActionExecutorDeps['sessionSendMessage']>;
  /** Trusted per-invocation precondition, evaluated on the metadata CAS candidate. */
  sessionStateMetadataPreprocess?: UiSessionStateMetadataPreprocess;
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
  /** Captured SCM transport; Action schemas, eligibility and approval remain host-owned. */
  scmActionExecute?: NonNullable<ActionExecutorDeps['scmActionExecute']>;
  machineAccessAction?: NonNullable<ActionExecutorDeps['machineAccessAction']>;
  machineWorkSummaryGet?: NonNullable<ActionExecutorDeps['machineWorkSummaryGet']>;
  usageSourceDismiss?: Parameters<typeof createUiUsageSourceActionPort>[1];
  /** A mounted recap preview may provide the same client rasterization boundary. */
  usageRecapRender?: Parameters<typeof createUiUsageActionPorts>[1];
  projectWorkerAction?: NonNullable<ActionExecutorDeps['projectWorkerAction']>;
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
  /** Host-page defaults remain outside Action input and personal persisted copies. */
  resolveWidgetAreaPresets?: Parameters<typeof createWidgetAreaActionDepsV1>[1];
  widgetAreaIsCurrent?: () => boolean;
  }>, accountContext?: LazyActionAccountContext & { settings: Awaited<ReturnType<LazyActionAccountContext['readSettings']>> }): ReturnType<typeof createActionExecutor> & Readonly<{
    readWidgetMovementAdmission(ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, context: ActionExecutorContext): ReturnType<typeof readWidgetEntityMovementAdmission>;
    readWidgetInputDescriptor(request: Parameters<NonNullable<ReturnType<typeof createWidgetInputActionDepsV1>['readWidgetInputDescriptor']>>[0]): ReturnType<NonNullable<ReturnType<typeof createWidgetInputActionDepsV1>['readWidgetInputDescriptor']>>;
  }> {
  const promptLibraryStore = accountContext ? createUiPromptLibraryArtifactStore(accountContext.workflowArtifacts, accountContext) : null;
  const withPromptLibraryStore = <T>(run: (store: PromptLibraryArtifactStore) => Promise<T>, signal?: AbortSignal): Promise<T> =>
    promptLibraryStore ? run(promptLibraryStore) : withUiPromptLibraryArtifactStore(run, { signal });
  const capturePromptExternalLinks = async (signal?: AbortSignal) => {
    if (!accountContext) throw new PromptLibraryRowOperationError('scope-retired');
    const projection = await readPromptLibraryCatalogProjectionInContext(accountContext, signal);
    const read = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key: 'external-links', rawSettings: projection.rawSettings });
    if (read.status !== 'ready' || read.record.key !== 'external-links') throw new PromptLibraryRowOperationError(
      read.status === 'unavailable' ? read.reason : 'invalid-stored-content');
    return { value: read.record.value, write: async (value: PromptExternalLinksV1) => {
      requireUpdatedPromptLibraryMutation(await writePromptLibraryRecordAndPublishInContext(accountContext, {
        record: { key: 'external-links', value }, expectedRevision: read.revision,
        ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}),
      }, signal));
    } };
  };
  const runtimeActionExecute = createDefaultRuntimeActionExecutor(opts?.runtimeActions, accountContext?.accountLifetime);
    type AgentsBackendsListArgs = Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>;
  const resolveNativeInventoryProbeTarget = async (args: Readonly<{
    agentId?: string; machineId?: string; serverId?: string; backendTargetKey?: string;
  }>): Promise<AgentInventoryProbeTarget | null> => {
    const selected = resolveActionBackendTargetSelection(args);
    if (!selected.ok) return null;
    const target = selected.selection.canonicalBackendTarget;
    if (target?.configuredBackendId || target?.sourceKind === 'configured') {
      if (!accountContext || !args.machineId) return null;
      const { catalog } = await readAcpCatalogInContext(accountContext);
      accountContext.assertCurrent();
      if (catalog.status !== 'ready') return null;
      const projection = await loadDaemonMergedProjectionInputs({
        machineId: args.machineId, serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
      });
      accountContext.assertCurrent();
      if (!projection) return null;
      const entry = getResolvedBackendCatalogEntries({
        ...projection, enabledAgentIds: [], acpCatalogSnapshot: catalog,
        backendEnabledByTargetKey: (accountContext.readLiveSettings() ?? accountContext.settings).backendEnabledByTargetKey,
      }).find(candidate => candidate.backendTargetKey === selected.selection.backendTargetKey);
      return entry ? { agentId: entry.catalogAgentId ?? entry.agentId, backendTargetParam: target } : null;
    }
    const resolved = resolveAgentInventoryProbeTarget(args);
    return resolved.ok ? { ...resolved.target, backendTargetParam: target ?? resolved.target.backendTargetParam } : null;
  };

  const resolveSessionMachineId = (sessionId: string, serverId?: string): string => {
    const exactServerId = String(serverId ?? '').trim();
    return readMachineControlTargetForSession(exactServerId
      ? { sessionId, serverId: exactServerId }
      : sessionId)?.machineId ?? '';
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
  const machineAccessAction = opts?.machineAccessAction ?? capturedFamilyPorts?.machineAccessAction;
  const settingsHost = resolveSettingsHost();
  const accountRoleAction = accountContext ? createAccountRoleActionExecutorV1({
    accountId: accountContext.accountId,
    readRawAccountSettings: accountContext.readRawSettings,
    mutateAccountRoleOverrides: (mutation, context) => mutatePromptLibraryRoleOverrideInContext(accountContext, mutation, context.signal),
    generateId: randomUUID,
    artifactStore: createRoleArtifactStoreV1(accountContext.workflowArtifacts),
    readPluginRoles: signal => readUiPluginRoleSources(accountContext, signal),
  }) : null;

  const deps: ActionExecutorDeps = {
    buildApprovalPreview: async ({ actionId, input, context, defaultPreview }) => {
      if (actionId !== 'session.spawn_new' || !accountContext || !machineAccessAction) return defaultPreview;
      const parsed = SessionSpawnNewInputV2Schema.safeParse(input);
      if (!parsed.success || !areServerProfileIdentifiersEquivalent(parsed.data.executionTarget.serverId, accountContext.serverId)) return defaultPreview;
      const machineId = parsed.data.executionTarget.machineId;
      const access = await machineAccessAction({ actionId: 'machines.access.grants.list',
        input: { serverId: accountContext.serverId, machineId }, context, ...(context.signal ? { signal: context.signal } : {}) });
      accountContext.assertCurrent();
      const disposition = resolveRequesterSessionSpawnDisposition({ accountId: accountContext.accountId, machineId, access });
      if (disposition.kind !== 'requester') return defaultPreview;
      const [{ AGENT_IDS }, { projectSessionCredentialSignInPurposes },
        { projectConnectedServiceRegistryEntries }, { resolveQualifiedConnectedServiceRegistryDisplayName },
        routeOwner] = await Promise.all([
        import('@/agents/catalog/catalog'),
        import('@/components/sessions/new/modules/connectedServicesNewSessionBindings'),
        import('@/sync/domains/connectedServices/connectedServiceRegistry'),
        import('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName'),
        import('@/providers/session/resolveSessionRoutePresentation'),
      ]);
      const projection = await loadDaemonMergedProjectionInputs({ machineId, serverId: accountContext.serverId,
        accountLifetime: accountContext.accountLifetime });
      accountContext.assertCurrent();
      const agent = getResolvedBackendCatalogEntries({ ...projection, enabledAgentIds: AGENT_IDS })
        .find(entry => entry.backendTargetKey === buildBackendTargetKeyV2(parsed.data.agentTarget))?.agentCatalogEntry;
      const targetRegistry = { entries: projectConnectedServiceRegistryEntries({ scopeKey: accountContext.serverId, status: 'ready',
        descriptors: Object.values(projection?.pluginProjectionV2?.familiesById.connectedAccounts?.entriesById ?? {}),
        conflicts: [], errorReason: null }) };
      const resolveServiceTitle = (service: Parameters<typeof resolveQualifiedConnectedServiceRegistryDisplayName>[1]) =>
        resolveQualifiedConnectedServiceRegistryDisplayName(targetRegistry, service, t);
      const signInPurposes: string[] = [];
      const selection = parsed.data.modelSelection?.ref;
      const selectedConnectionId = selection?.providerConnectionId;
      let nativePurposesKnown = !selectedConnectionId;
      let suppressedServiceIds: readonly string[] | undefined;
      if (selectedConnectionId && selection) {
        const [{ readProviderCatalogForMutationInContext }, { DaemonProviderModelProjectionResponseV1Schema }] = await Promise.all([
          import('@/sync/api/account/apiProviderCatalog'), import('@happier-dev/protocol/rpc'),
        ]);
        const [catalog, projected] = await Promise.all([
          readProviderCatalogForMutationInContext(accountContext, context.signal),
          deps.providerActionExecute?.({ actionId: 'providers.models.projection', input: {
            machineId, agentTargetKey: buildBackendTargetKeyV2(parsed.data.agentTarget),
            currentSelection: selection, sourceConnectionId: selectedConnectionId, refreshPolicy: 'current_only',
          } }, context),
        ]);
        accountContext.assertCurrent();
        const providerProjection = DaemonProviderModelProjectionResponseV1Schema.safeParse(projected?.ok ? projected.result : null);
        const selectedSource = providerProjection.success && providerProjection.data.status === 'success'
          ? providerProjection.data.groups.find(group => group.connectionId === selectedConnectionId) : null;
        nativePurposesKnown = Boolean(selectedSource);
        suppressedServiceIds = selectedSource?.suppressedConnectedServiceIds;
        const connection = catalog.status === 'ready' ? catalog.catalog.connections.find(connection => connection.id === selectedConnectionId) : null;
        if (connection) {
          const source = routeOwner.readProviderConnectionDisclosureSource({ connection, projection: projection?.pluginProjectionV2,
            machineId, resolveServiceTitle });
          const route = routeOwner.resolveSessionRoutePresentation({ phase: 'draft', selection: parsed.data.modelSelection?.ref ?? null,
            sources: [selectedSource ?? source.source], native: { label: '', authSource: 'unknown', connectedCount: 0 } }).applied;
          signInPurposes.push(...routeOwner.projectProviderRouteSignInPurposes({ route, machineId,
            secretBindings: catalog.status === 'ready' ? catalog.catalog.secretBindingsByConnectionId[selectedConnectionId] : undefined,
            credentialSlotId: source.credentialSlotId, managedSignInPurposes: source.managedSignInPurposes }));
        }
      }
      // A selected Provider may replace native sign-ins only through its actual Agent adapter projection.
      // An unavailable projection supplies no authority to guess which native purposes still materialize.
      if (nativePurposesKnown) signInPurposes.push(...projectSessionCredentialSignInPurposes({ declarations: agent?.connectedAccounts ?? [],
        bindings: parsed.data.connectedServices, resolveServiceTitle, suppressedServiceIds,
        formatNativeTitle: service => t('machineRequester.nativeSignInPurpose', { service }) }));
      return { ...defaultPreview, requesterCredentialDisclosure: disposition.disclosure,
        summary: [t('machineRequester.fullSignIn', { machine: machineId }),
          t('machineRequester.osVisibility', { owner: disposition.disclosure.custodian.displayName
            || disposition.disclosure.custodian.accountId, machine: machineId }),
          ...(signInPurposes.length ? [t('machineRequester.signInPurposes', { purposes: [...new Set(signInPurposes)].join(', ') })] : []),
        ].join('\n\n') };
    },
    ...(promptLibraryStore?.organization ? { artifactFolders: promptLibraryStore.organization, promptStacks: promptLibraryStore.organization } : {}),
    ...(accountContext && promptLibraryStore ? { memoryLibrary: {
      serverId: accountContext.serverId, store: promptLibraryStore, randomId: randomUUID,
      isSameServerId: serverId => areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId),
      readExposure: async (artifactId, context) => {
        accountContext.assertCurrent();
        if (!deps.artifactAccessAction || !deps.artifactAction) throw Object.assign(new Error('memory_exposure_unavailable'), { code: 'memory_exposure_unavailable' });
        const grants = ArtifactAccessGrantsListResponseV1Schema.parse(await deps.artifactAccessAction({
          actionId: 'artifact.access.grants.list', input: { artifactId }, context, signal: context.signal }));
        const publicShares = grants.access === 'owner' ? StoredContentPublicSharesListResponseV1Schema.parse(await deps.artifactAction({
          actionId: 'artifact.public_link.list', input: { artifactId }, context, signal: context.signal })) : null;
        accountContext.assertCurrent();
        return { grants, publicShares };
      },
      readSession: async (ref, context) => {
        accountContext.assertCurrent(); context.signal?.throwIfAborted();
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({
          scope: accountContext.accountLifetime.scope, activeRequest: accountContext.request,
        }, authority => readSessionSnapshotForAuthority({ authority, sessionId: ref.sessionId, isCurrent: accountContext.accountLifetime.isCurrent }));
        accountContext.assertCurrent(); context.signal?.throwIfAborted();
        const metadata = readSessionOwnerMetadataView(session);
        if (!metadata) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
        return { metadata, revision: session.metadataVersion };
      },
      readInheritedContext: (snapshot, context) => readUiMemoryInheritedContext(accountContext, snapshot, context),
      readScopeContext: (target, context) => readUiMemoryScopeContext(accountContext, target, context),
      readArtifactHeaders: async (refs, context) => {
        accountContext.assertCurrent();
        if ((accountContext.credentialAuthorityKind === 'api_token' || context.externalActionCredential
          || context.externalActionExecutionAuthorization)
          && refs.some(ref => ref.serverId && !areServerProfileIdentifiersEquivalent(ref.serverId, accountContext.serverId))) {
          throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
        }
        return withUiPromptLibraryArtifactReader(reader => Promise.all(refs.map(async ref =>
          (await reader.readArtifactHeader(ref))?.header ?? null)), {
          serverId: accountContext.serverId, accountContext, signal: context.signal,
        });
      },
    } } : {}),
    filesystemActionExecute: createUiFilesystemAction(accountContext ?? undefined),
    currentSessionPresentationApply: async ({ input, context, signal }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const sessionId = context.defaultSessionId?.trim();
      if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      accountContext.assertCurrent();
      const result = await sessionRpcWithServerScope<CurrentSessionPresentationActionResultV1 | ActionExecuteFailure, typeof input>({
        serverId: accountContext.serverId,
        sessionId,
        method: CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD,
        payload: input,
        // The existing presentation service owns the command's ACK budget.
        timeoutMs: null,
        ...(signal ? { signal } : {}),
      });
      accountContext.assertResultCurrent(getActionSpec('session.presentation.apply').sideEffectClass);
      return result;
    },
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
    usageActions: accountContext ? createUiUsageActionPorts(accountContext, opts?.usageRecapRender) : undefined,
    usageSourceAction: accountContext ? createUiUsageSourceActionPort(accountContext, opts?.usageSourceDismiss) : undefined,
    scmActionExecute: opts?.scmActionExecute ?? createUiScmAction(accountContext),
    appShellAction: createAppShellAction(accountContext),
    notificationConfigurationAction: createNotificationConfigurationAction(accountContext ?? null),
    appUpdateAction: executeAppUpdateAction,
    hostExternalSessionAction: executeExternalSessionBrowseAction,
    settingsDeclarationAction: createSettingsDeclarationAction({
      serverId: accountContext?.serverId,
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
        ...(accountContext ? { readConnectedAccountPurposes: async (signal?: AbortSignal) => {
          const { readAdmittedConnectedAccountCatalogInContext } = await import('@/sync/api/account/apiConnectedAccountCatalog');
          const snapshot = await readAdmittedConnectedAccountCatalogInContext(accountContext, 'purposes', signal);
          accountContext.assertCurrent();
          return snapshot.status === 'ready' && snapshot.record.key === 'purposes' ? snapshot.record.value : null;
        } } : {}),
        readScmDiffSummaryCatalog: createScmDiffSummarySettingsCatalogReader(accountContext ?? null),
        ...(accountContext ? { executeSettingsOwnerAction: createSettingsOwnerActionExecutor(
            request => executor.execute(request.actionId, request.input, request.context), accountContext,
          ) } : {}),
        ...(accountContext ? { purgeAccountSettingsHistory: async (versions: readonly number[], signal?: AbortSignal) => {
          signal?.throwIfAborted(); accountContext.assertCurrent();
          const { purgeAccountSettingsHistoryVersions } = await import('@/sync/engine/settings/accountSettingsHistoryRestore');
          return accountContext.runPrepared(() => purgeAccountSettingsHistoryVersions({
            credentials: accountContext.credentials, settingsScope: accountContext.accountLifetime.scope, versions, signal,
            requestContext: { request: accountContext.request, isCurrent: () => {
              try { accountContext.assertCurrent(); signal?.throwIfAborted(); return true; } catch { return false; }
            } },
          }), 'danger');
        } } : {}),
      },
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
      mutateAccountSettings: async (mutate, options) => {
        if (!accountContext) throw new Error('Account settings context is unavailable');
        return await accountContext.mutateRawSettings(mutate, options);
      },
      ...(accountContext ? { readAccountSettingsSnapshot: accountContext.readRawSettingsSnapshot,
        accountScope: accountContext.accountLifetime.scope } : {}),
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
      let capturedRow: Readonly<{ record: ProfileRecordV1; revision: number }> | null = null;
      return await createLaunchProfilePublisherV1({
        profileStore: {
          read: async (profileId, signal) => {
            accountContext.assertCurrent();
            const { catalog } = await readProfileCatalogProjectionInContext(accountContext, signal);
            accountContext.assertCurrent();
            if (catalog.status !== 'ready' || catalog.source !== 'destination') {
              throw Object.assign(new Error('profile_catalog_unavailable'), { code: 'profile_catalog_unavailable' });
            }
            capturedRow = catalog.records.find(row => row.record.id === profileId) ?? null;
            return capturedRow;
          },
          updateDefinition: async ({ profileId, expectedRevision, artifactId }, signal) => {
            accountContext.assertCurrent();
            if (!capturedRow || capturedRow.record.id !== profileId || capturedRow.revision !== expectedRevision) {
              throw Object.assign(new Error('profile_revision_conflict'), { code: 'profile_revision_conflict' });
            }
            const result = await writeProfileRecordInContext(accountContext, {
              record: { ...capturedRow.record, definition: { kind: 'artifact', artifactId } },
              expectedRevision, operation: 'update',
            }, signal);
            if (result.status !== 'updated') {
              throw Object.assign(new Error(`profile_row_${result.status}`), { code: `profile_row_${result.status}` });
            }
          },
        },
        artifactStore: { read: (artifactId, signal) => accountContext.workflowArtifacts.read(artifactId, { signal }),
          create: async ({ header, body, signal, savedBy }) => {
            const created = await accountContext.createArtifactDocument({ header, body, signal,
              savedBy });
            return { artifactId: created.artifactId };
          } },
      }).publish(input, { ...context, ...(context?.context ? { context: { ...context.context,
        runtimeAccountId: accountContext.accountId } } : {}) });
    } } : {}),
    ...(accountContext ? createUiNotificationActionDeps({ account: accountContext }) : {}),
    ...(accountContext ? { artifactAction: createUiArtifactAction(accountContext, { onPublicLinkIssued: opts?.onPublicLinkIssued }) } : {}),
    ...(accountContext ? {
      profileActionExecute: createUiProfileActionExecuteV1(accountContext, { onRpcDispatched: opts?.onProviderRpcDispatched }),
      mcpServerAction: createUiMcpServerActionExecuteV1(accountContext),
      providerActionExecute: createUiProviderActionExecuteV1(accountContext, { onRpcDispatched: opts?.onProviderRpcDispatched }),
    } : {}),
    ...(accountContext ? { remoteHostActionExecute: createUiRemoteHostActionExecuteV1(accountContext, opts?.openRoute) } : {}),
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
      readWidgets: async (signal, layout) => {
        accountContext.assertCurrent();
        const { readWidgetActionCandidatesV1, canReadActiveWidgetCatalogV1 } = await import('./widgetCatalogActionDeps');
        const needsInstalledCatalog = canReadActiveWidgetCatalogV1(accountContext)
          || (layout && flattenWidgetLayoutWidgetsV1(layout.items).some(({ instance }) => instance.definition.kind === 'installed')) === true;
        const candidates = needsInstalledCatalog ? await readWidgetActionCandidatesV1({
          serverId: accountContext.serverId, accountId: accountContext.accountId, owner: { kind: 'home' },
        }, accountContext, signal) : [];
        accountContext.assertCurrent();
        if ('ok' in candidates) throw Object.assign(new Error(candidates.error), { code: candidates.errorCode });
        const referenced = new Set(layout ? flattenWidgetLayoutWidgetsV1(layout.items).flatMap(({ instance }) => instance.definition.kind === 'artifact' ? [instance.definition.artifactId] : []) : []);
        if (referenced.size === 0) return candidates;
        const definitions = await widgetDefinitionDeps.widgetDefinitionArtifacts?.list(signal) ?? [];
        accountContext.assertCurrent();
        const { describeWidgetDefinitionSummaryV1 } = await import('@/components/widgets/widgetCatalog');
        return [...candidates, ...definitions.filter(summary => referenced.has(summary.artifactId)).map(summary => describeWidgetDefinitionSummaryV1(summary,
          summary.sourceDefinition ? candidates.find(candidate => isSameWidgetDefinitionV1(
            widgetCandidateDefinitionV1(candidate), summary.sourceDefinition!)) : null))];
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
        if (sessionBoardActionUsesLayoutV1(args.actionId, input) && decision?.state !== 'enabled') {
          return projectSessionBoardFeatureDecisionFailureV1(args.actionId, decision);
        }
        const result = await createSessionBoardActionAdapter({
          scope: runtime.scope, session: address, repository: runtime.repository,
          request: (path, init, options) => runtime.request(path, init, options),
          contentContext: runtime.contentContext,
          boardEnabled: decision?.state === 'enabled',
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
    runtimeActionExecute: async (args) => {
      const featureId = getActionRequiredServerFeatureId(args.actionId);
      if (featureId === 'browser.automation') {
        const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext?.serverId ?? args.context.serverId ?? undefined });
        accountContext?.assertCurrent();
        throwIfAborted(args.context.signal);
        const settings = accountContext
          ? (accountContext.readLiveSettings() ?? accountContext.settings)
          : storage.getState().settings;
        if (resolveRuntimeFeatureDecisionFromSnapshot({ featureId, settings, snapshot })?.state !== 'enabled') {
          return { ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_automation_unavailable' };
        }
      }
      return await runtimeActionExecute(args);
    },
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
    accountHomeContinuationAction: (request) => executeCurrentUiContextAction(request),
    sessionAuthoringOpen: openSessionAuthoringDraft,
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
      { ...(signal ? { signal } : {}), ...(accountContext ? { accountContext } : {}) },
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
        accountContext.assertResultCurrent(getActionSpec('account.password.enroll').sideEffectClass);
        return result;
      },
      accountPasswordChangeAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => submitAccountPasswordChange(accountContext.request, input, signal));
        accountContext.assertResultCurrent(getActionSpec('account.password.change').sideEffectClass);
        return result;
      },
      accountPasswordRemoveAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => submitAccountPasswordRemove(accountContext.request, input, signal));
        accountContext.assertResultCurrent(getActionSpec('account.password.remove').sideEffectClass);
        return result;
      },
      accountEmailChangeRequestAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => requestAccountSignInEmailChange(accountContext.request, input, signal));
        accountContext.assertResultCurrent(getActionSpec('account.email.change.request').sideEffectClass);
        return result;
      },
      accountSecurityTerminalPresentUserSetAction: async ({ input, signal }) => {
        accountContext.assertCurrent();
        const result = await settleAccountSecurityAction(() => setAccountTerminalPresentUserPolicy(accountContext.request, input, signal));
        accountContext.assertResultCurrent(getActionSpec('account.security.terminalPresentUser.set').sideEffectClass);
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
    sessionOrganizationPinSet: async ({ sessionId, request, serverId, signal }) => {
      if (!accountContext) return { ok: false, errorCode: 'action_account_scope_unavailable', error: 'action_account_scope_unavailable' };
      if (!serverId || !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      signal?.throwIfAborted();
      try {
        return await writeSessionOrganizationPin({
          scope: createSessionOrganizationMutationScopeForAccount(accountContext),
          sessionId,
          ...request,
        });
      } catch (error) {
        if (error instanceof HappyError && error.code === 'session_not_bot') {
          return { ok: false, errorCode: error.code, error: error.message };
        }
        throw error;
      }
    },
    composerIngress: executeComposerIngressAction,
    listReorder: executeListReorderAction,
    todoSessionLink: executeTodoSessionLinkAction,
    sessionTerminalAction: invokeSessionTerminalAction,
    actionOperationAction: async ({ actionId, input, signal }) => {
      try {
        return await executeActionOperationActionV1({
          actionId, input, ...(signal ? { signal } : {}),
          transport: async request => await machineRpcWithServerScope({
            ...request,
            ...(actionId === 'action.operations.get' && 'waitForTerminal' in input && input.waitForTerminal
              ? { operationTimeoutMs: null } : {}),
          }),
          openOutput: async address => {
            signal?.throwIfAborted();
            accountContext?.assertCurrent();
            if (opts?.actionOperationOpenOutput) {
              await opts.actionOperationOpenOutput(address);
              signal?.throwIfAborted();
              accountContext?.assertCurrent();
              return;
            }
            const { openActionOperationDetail } = await import('@/components/inbox/actionOperations/openActionOperationDetail');
            signal?.throwIfAborted();
            accountContext?.assertCurrent();
            openActionOperationDetail({ serverId: address.serverId, operationId: address.operationId });
          },
          copyOutput: async output => {
            signal?.throwIfAborted();
            accountContext?.assertCurrent();
            const decoder = createTerminalUtf8ProjectionDecoder();
            let text = '';
            for (const frame of output.frames) {
              if (frame.t === 'gap') {
                decoder.reset();
                text += TERMINAL_OUTPUT_GAP_MARKER;
              } else if (frame.t === 'bytes') text += decoder.decode(decodeTerminalStreamBytesFrame(frame));
            }
            text += decoder.flush();
            if (!await setClipboardStringSafe(text)) return { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' };
            return undefined;
          },
        });
      } catch (error) {
        if (isActionAccountScopeChangedError(error)) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        throw error;
      }
    },
    sessionOpen: async ({ sessionId, serverId, intent, approvedNewDirectoryCreation, actionRequestId, tabId, destination, signal }) => {
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
      if (intent === 'resume' || approvedNewDirectoryCreation === true) {
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
          permissionOverride: getPermissionModeOverrideForSpawn(session),
          modelOverride: target?.agentTarget || target?.backendTarget
            ? getModelOverrideForSpawn(session, resolveBackendTargetKeyV2(target.agentTarget ?? target.backendTarget!))
            : null,
          resumeTargetOverride: machineTarget ? { machineId: machineTarget.machineId, directory: machineTarget.basePath } : null,
          resumeCapabilityOptions: {
            ...buildResumeCapabilityOptionsFromUiState({ settings, pluginSettings, results: undefined }),
            currentAgentCapabilities: opts?.currentAgentCapabilities,
          },
        });
        if (!machineTarget || !base) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' };
        if (target?.defaultAgentId) {
          fireAndForget(ensureAgentInstallablesBackground({
            agentId: target.defaultAgentId, machineId: base.machineId,
            serverId: accountContext.serverId, settings, resumeSessionId: base.resume ?? null,
          }), { tag: `session.open.installables.${target.defaultAgentId}` });
        }
        const resumed = await resumeSession({
          ...base, serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
          ...(approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true,
            executionAuthorization: { provenance: 'user_request' as const, requestId: actionRequestId ?? randomUUID() },
          } : {}),
          ...(target?.defaultAgentId ? buildResumeSessionExtrasFromUiState({
            agentId: target.defaultAgentId, settings, pluginSettings, session,
          }) : {}),
        });
        accountContext.assertCurrent();
        if (resumed.type === 'error') return { ok: false, errorCode: resumed.errorCode, error: resumed.errorMessage };
        if (intent === 'resume') return { ok: true, status: 'opened', sessionId, serverId, address: { serverId, sessionId } };
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

    sessionFork: async ({ sessionId, serverId, forkPoint, strategy, replaySummaryRunner, replayMaxSeedChars, requestId }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const resolvedServerId = String(serverId ?? opts?.resolveServerIdForSessionId?.(sid) ?? '').trim();
      const state = storage.getState();
      const session = state.sessions[sid] ?? null;
      const machineId = resolveSessionMachineId(sid, resolvedServerId);

      const settings = state.settings;
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
      // Explicit Native intent is resolved/refused by the daemon lifecycle owner.
      // Its live capability need not be in this presentation's projection cache.
      if (((strategy === undefined || strategy === 'auto') && !availability.native && !availability.replay)
        || (strategy === 'replay' && !availability.replay)) {
        return { ok: false, errorCode: 'action_disabled', errorMessage: 'action_disabled' };
      }
      const replayOptions = resolveSessionForkReplayOptions({
        settings,
        executionRunsEnabled: resolveLocalFeaturePolicyEnabled('execution.runs', settings ?? {}),
      });
      const resolvedStrategy = strategy === undefined || strategy === 'auto'
        ? availability.replay ? strategy : 'native'
        : strategy;

      const result = await forkSessionOp({
        ...(machineId ? { machineId } : {}),
        serverId: resolvedServerId || undefined,
        parentSessionId: sid,
        forkPoint,
        // `auto` is the only value that can fall through to Replay, so it stays
        // the request exactly while Replay is a route the account allows.
        ...(resolvedStrategy ? { strategy: resolvedStrategy } : {}),
        ...replayOptions,
        ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
        ...(replayMaxSeedChars !== undefined ? { replayMaxSeedChars } : {}),
        ...(requestId ? { requestId } : {}),
      });
      if (!result.ok) return result;

      const childSessionId = result.childSessionId;
      // A strategy chooser owns its child hydration, restored draft and navigation.
      // Returning the exact fork result keeps a second navigation out of that flow.
      if (strategy !== undefined) return result;
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

    sessionArchiveSet: async ({ sessionId, archived, serverId }) => archived
      ? await sessionArchiveWithServerScope(sessionId, { serverId })
      : await sessionUnarchiveWithServerScope(sessionId, { serverId }),

    sessionPermissionModeSet: async ({ sessionId, permissionMode, applyTiming, serverId }) => {
      if (!isPermissionMode(permissionMode) || !accountContext) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      accountContext.assertCurrent();
      const scope = accountContext.accountLifetime.scope;
      const isActiveScope = areServerAccountScopesEqual(scope, getActiveServerAccountScope());
      let updatedAt = nowServerMs();
      await applyPermissionModeSelectionEffect({
        sessionId, mode: permissionMode, applyTiming: applyTiming ?? 'immediate',
        updateSessionPermissionMode: (sid, mode) => {
          accountContext.assertCurrent();
          if (isActiveScope) {
            storage.getState().updateSessionPermissionMode(sid, mode);
            updatedAt = storage.getState().sessions[sid]?.permissionModeUpdatedAt ?? updatedAt;
          } else {
            saveSessionPermissionModes({ ...loadSessionPermissionModes(scope), [sid]: mode }, scope);
            saveSessionPermissionModeUpdatedAts({ ...loadSessionPermissionModeUpdatedAts(scope), [sid]: updatedAt }, scope);
          }
        },
        getSessionPermissionModeUpdatedAt: () => updatedAt,
        publishSessionPermissionModeToMetadata: async (payload) => {
          accountContext.assertCurrent();
          await sync.publishSessionPermissionModeToMetadata({ ...payload, serverId: serverId ?? scope.serverId,
            accountLifetime: accountContext.accountLifetime });
        },
      });
      return { ok: true };
    },

    sessionTurnCancel: async ({ sessionId, serverId }) => {
      await sessionAbort(sessionId, serverId ? { serverId } : undefined);
      return { requested: true };
    },

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

    sessionPendingWithdraw: async ({ sessionId, localId, serverId, targetExecutionRunId }) => {
      accountContext?.assertCurrent();
      if (accountContext && serverId !== undefined
          && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      return { outcome: await sync.withdrawPendingMessage(sessionId, localId, {
        serverId: accountContext?.serverId ?? serverId,
        ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}),
        ...(targetExecutionRunId ? { targetExecutionRunId } : {}),
      }) };
    },
    sessionPendingResetStartSet: async ({ sessionId, localId, serverId, reset }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      return sync.updatePendingRequestedAction(sessionId, localId, { v: 1, kind: 'reset_start', reset }, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
      });
    },
    sessionPendingResetStartCancel: async ({ sessionId, localId, serverId }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      return { outcome: await sync.withdrawPendingMessage(sessionId, localId, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
      }) };
    },

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
        currentAgentCapabilities: opts?.currentAgentCapabilities,
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

      // Only the source machine is resolved here. Which storage the target
      // imports into is derived by the source daemon from the owner metadata it
      // loads itself, before the operation claim and before any stop or export,
      // so a cold or unprojected client view must not refuse a valid handoff.
      const sourceMachineId = resolveSessionMachineId(sid, serverId ?? undefined);

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
      context,
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
      if (machine?.isShared && !accountContext) return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
      let requesterBootstrap: Awaited<ReturnType<typeof prepareRequesterSessionForSpawn>> | undefined;
      if (accountContext) {
        accountContext.assertCurrent();
        if (accountContext.serverId !== serverId) return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
        if (!machineAccessAction) return { type: 'error' as const, code: 'target_unavailable' as const, retryable: true as const };
        const access = await machineAccessAction({ actionId: 'machines.access.grants.list',
          input: { serverId, machineId: input.executionTarget.machineId }, context, ...(signal ? { signal } : {}) });
        accountContext.assertCurrent();
        const disposition = resolveRequesterSessionSpawnDisposition({ accountId: accountContext.accountId,
          machineId: input.executionTarget.machineId, access });
        if (disposition.kind === 'refused') return disposition.result;
        if (disposition.kind === 'requester') {
          const custodian = disposition.disclosure.custodian;
          requesterBootstrap = await prepareRequesterSessionForSpawn({ accountContext });
          signal?.throwIfAborted();
          const currentAccess = await machineAccessAction({ actionId: 'machines.access.grants.list',
            input: { serverId, machineId: input.executionTarget.machineId }, context, ...(signal ? { signal } : {}) });
          accountContext.assertCurrent();
          const currentDisposition = resolveRequesterSessionSpawnDisposition({ accountId: accountContext.accountId,
            machineId: input.executionTarget.machineId, access: currentAccess });
          if (currentDisposition.kind === 'refused') return currentDisposition.result;
          if (currentDisposition.kind !== 'requester' || currentDisposition.disclosure.custodian.accountId !== custodian.accountId) {
            return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
          }
        }
      }
      accountContext?.assertCurrent();
      return await dispatchSessionSpawnNewWithReportsToPreparation({
        payload: placementOrigin && supportsOrigin ? { ...exactInput, placementOrigin } : exactInput,
        ...(requesterBootstrap ? { requesterBootstrap } : {}),
        signal,
      });
    },

    approvalRequestApprovedReplay: async ({ artifactId, request, context, requestId, signal }) => {
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
      if (accountContext && request.v === 2 && !context.externalActionCredential
        && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization
        && (!context.actionCaller || context.actionCaller.kind === 'host')) {
        if (!requestId || context.surface !== 'ui' || context.authority !== 'present_user'
          || !isApprovalExecutionOriginCurrentForAccountContext({ origin: request.executionOriginV1,
            accountServerId: accountContext.serverId, accountId: accountContext.accountId })) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        const execution = await executeOriginalAccountMachineAction({ account: accountContext,
          actionId: 'approval.request.decide', requestId, machineId, foreignTargetOnly: true,
          input: { artifactId, decision: 'approve', serverId: accountContext.serverId,
            serverIdentityId: replayRoute.serverIdentityId, originServerId: replayRoute.originServerId },
          ...(signal ? { signal } : {}) });
        accountContext.assertResultCurrent(getActionSpec('approval.request.decide').sideEffectClass);
        if (execution) return execution;
      }
      return await replayApprovedApprovalRequestAtExactDaemon({
        artifactId,
        executionTarget: { ...replayRoute, machineId },
        ...(signal === undefined ? {} : { signal }),
      });
    },

    pathsListRecent: async ({ machineId, limit }) => await listRecentPathsForVoiceTool({ machineId, limit }),
    projectDefinitionAction: createUiProjectDefinitionAction(accountContext),
    projectAction: createUiProjectAction(accountContext),
    projectsContextUpdate: createUiProjectContextAction(accountContext),
    projectsWorkspaceUpdate: async (input, context) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      return createUiProjectAccountRowsClient(accountContext).updateWorkspace({ ...input, signal: context?.signal }, context);
    },
    projectsWorkspaceForget: async (input, context) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      return createUiProjectAccountRowsClient(accountContext).forgetWorkspace({ ...input, signal: context?.signal }, context);
    },
    projectsList: async (args, context) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (!canUsePrivateProjectAccountAction(accountContext, context)) return { ok: false, errorCode: 'project_account_access_denied', error: 'project_account_access_denied' };
      if (accountContext && args.serverId !== undefined && args.serverId !== accountContext.serverId) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const rows = await createUiProjectAccountRowsClient(accountContext).read(context?.signal);
      return listProjectsForActions(args, rows);
    },
    projectsVisibilitySet: async (input, context) => {
      if (!accountContext || !canUsePrivateProjectAccountAction(accountContext, context)) return { ok: false, errorCode: 'project_visibility_access_denied' };
      return setProjectVisibilityV1({
        accountScope: () => {
          try { accountContext.assertCurrent(); return { serverId: accountContext.serverId, accountId: accountContext.accountId }; }
          catch { return null; }
        }, mutateOrganization: createUiProjectAccountRowsClient(accountContext).mutateOrganization,
      }, input, context);
    },
    projectsOpen: async (input, context) => {
      accountContext?.assertCurrent();
      if (accountContext && !context.externalActionCredential && !context.externalActionExecutionAuthorization
        && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host')) {
        if (!areServerProfileIdentifiersEquivalent(accountContext.serverId, input.serverId)
          || context.surface !== 'ui' || context.authority !== 'present_user'
          || !context.actionRequestId || !canUsePrivateProjectAccountAction(accountContext, context)) {
          return { kind: 'refused', code: 'admission_unavailable' };
        }
        const execution = await executeOriginalAccountMachineAction({ account: accountContext, actionId: 'projects.open',
          input: { ...input, serverId: accountContext.serverId }, machineId: input.machineId,
          requestId: context.actionRequestId, foreignTargetOnly: true, ...(context.signal ? { signal: context.signal } : {}) });
        accountContext.assertResultCurrent(getActionSpec('projects.open').sideEffectClass);
        if (execution) {
          if (!execution.ok) return execution;
          const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
          if (approval.success && approval.data.actionId === 'projects.open') return approval.data;
          return OpenProjectResultV1Schema.parse(execution.result);
        }
      }
      try { return OpenProjectResultV1Schema.parse(await machineRpcWithServerScope({
        serverId: input.serverId,
        machineId: input.machineId,
        accountId: accountContext?.accountId,
        method: RPC_METHODS.PROJECTS_OPEN,
        payload: input,
        signal: context.signal,
        operationTimeoutMs: null,
      })); } catch (error) {
        if (readRpcRequestDisposition(error) === 'notSent') return { kind: 'refused', code: 'machine_unreachable' };
        throw error;
      }
    },
    ...(accountContext ? createProjectSourceActionDeps(accountContext) : {}),
    promptInvocationsList: async (args) => {
      if (!accountContext) return listPromptInvocationsForActions(args);
      const projection = await readPromptLibraryCatalogProjectionInContext(accountContext);
      const source = readPromptLibraryCatalogRecordV1({ ...projection, key: 'invocations' });
      return listPromptInvocationsForActions(args, { invocations: source.status === 'ready' ? source.record.value : null,
        assertCurrent: accountContext.assertCurrent });
    },
    promptInvocationResolve: async (args) => {
      if (!accountContext) return resolvePromptInvocationForActions(args);
      const projection = await readPromptLibraryCatalogProjectionInContext(accountContext, args.signal);
      const source = readPromptLibraryCatalogRecordV1({ ...projection, key: 'invocations' });
      return withUiPromptLibraryArtifactReader((reader) => resolvePromptInvocationForActions(args, {
        invocations: source.status === 'ready' ? source.record.value : null,
        store: createUiPromptLibraryArtifactStore(accountContext.workflowArtifacts), readArtifact: reader.readArtifact,
        assertCurrent: accountContext.assertCurrent,
      }), { accountContext, signal: args.signal });
    },
    spawnProfilesList: async (args) => listSpawnProfilesForActions(args, accountContext
      ? projectUiAiLaunchProfileSnapshot(await accountContext.readLaunchProfileSnapshot((await accountContext.readRawSettings()).profiles)) : undefined),
    machinesList: async ({ serverId, limit }) => await listMachinesForVoiceTool({ serverId, limit }),
    ...createMachineConnectionActionDeps({ ...(accountContext ? { account: accountContext } : {}) }),
    serversList: async ({ limit }) => await listServersForVoiceTool({ limit }),
    readAccountAcpCatalog: async ({ signal }) => {
      if (!accountContext) return { status: 'unavailable', reason: 'unauthorized' };
      const { catalog } = await readAcpCatalogInContext(accountContext, signal);
      accountContext.assertCurrent();
      return catalog;
    },
    updateAccountAcpCatalogSettings: async (input) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      try {
        const receipt = await updateAcpCatalogInContext(accountContext, input);
        if (!receipt) return { ok: false, errorCode: 'acp_catalog_unavailable', error: 'acp_catalog_unavailable' };
        return { ok: true, ...receipt };
      } catch (error) {
        const code = error instanceof AcpCatalogOperationError ? error.code : 'acp_catalog_unavailable';
        return { ok: false, errorCode: code, error: code,
          ...(error instanceof AcpCatalogOperationError && (code === 'conflict' || code === 'settings-conflict')
            && error.cause !== undefined ? { details: error.cause } : {}) };
      }
    },
    reviewEnginesList: async ({ sessionId, machineId, includeDisabled, scope }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      const preferences = settingsParse(await accountContext.readRawSettings());
      const { catalog } = await readAcpCatalogInContext(accountContext);
      accountContext.assertCurrent();
      const result = await listReviewEnginesForVoiceTool({ sessionId, machineId, includeDisabled, scope, serverId: accountContext.serverId,
        acpCatalogSnapshot: catalog, backendEnabledByTargetKey: preferences.backendEnabledByTargetKey ?? null });
      accountContext.assertCurrent();
      return result;
    },
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
    ...(opts?.machineWorkSummaryGet ?? capturedFamilyPorts?.machineWorkSummaryGet
      ? { machineWorkSummaryGet: opts?.machineWorkSummaryGet ?? capturedFamilyPorts!.machineWorkSummaryGet }
      : {}),
    ...(machineAccessAction
      ? { machineAccessAction }
      : {}),
    ...(opts?.sessionDiscussionAction ?? capturedFamilyPorts?.sessionDiscussionAction
      ? { sessionDiscussionAction: opts?.sessionDiscussionAction ?? capturedFamilyPorts!.sessionDiscussionAction }
      : {}),
    ...(opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction
      ? { homeDomainAction: opts?.homeDomainAction ?? capturedFamilyPorts!.homeDomainAction }
      : {}),
    homeRuntimeTaskRpc: async ({ machineId, method, request, context }) => {
      if (!accountContext) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      accountContext.assertCurrent();
      try {
        return await machineRpcWithServerScope({ machineId, serverId: accountContext.serverId,
          accountId: accountContext.accountId,
          method: method === 'detect' ? RPC_METHODS.CAPABILITIES_DETECT : RPC_METHODS.CAPABILITIES_INVOKE,
          payload: request, operationTimeoutMs: null, preferScoped: true,
          ...(context.actionRequestId ? { requestId: context.actionRequestId } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        if (readRpcRequestDisposition(error) === 'notSent') return { ok: false, errorCode: 'request_not_sent', error: 'request_not_sent' };
        throw error;
      }
    },
    homeRuntimeActionExecute: createUiHomeRuntimeActionExecute(accountContext, opts?.homeRuntimeRunner),
    ...(opts?.workspaceSyncConflictResolve ? { workspaceSyncConflictResolve: opts.workspaceSyncConflictResolve } : {}),
    ...(accountContext ? { managedMachineReferences: createUiManagedMachineReferenceReader(accountContext) } : {}),
    managedMachineAction: async (args) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      accountContext.assertCurrent();
      if (args.actionId !== 'machines.managed.list' && args.actionId !== 'machines.managed.get' && args.actionId !== 'machines.managed.cancel'
        && args.actionId !== 'machines.managed.setup.skip') {
        try {
          const execution = await executeManagedMachineNativeAction({ account: accountContext, ...args });
          return execution.ok ? execution.result : execution;
        } catch (error) {
          if (error instanceof ManagedMachineActionError) return { ok: false, errorCode: error.code, error: error.code };
          throw error;
        }
      }
      const input = ManagedMachineActionInputSchemasV1[args.actionId].parse(args.input);
      if (!accountContext.serverIdentityId) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      if (input.homeId !== accountContext.serverIdentityId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      try {
        const result = await createManagedMachineActionClient({ request: accountContext.request }).execute(args.actionId, input, { signal: args.signal });
        accountContext.assertCurrent();
        return result;
      } catch (error) {
        if (error instanceof ManagedMachineActionError) return { ok: false, errorCode: error.code, error: error.code };
        throw error;
      }
    },
    machinePresetAction: async (args) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      // The local profile routes requests; only its stable Home identity qualifies recipes.
      if (!accountContext.serverIdentityId) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${args.actionId}` };
      if (args.input.homeId !== accountContext.serverIdentityId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      try {
        return await createMachinePresetActionClient({ request: accountContext.request }).execute(args.actionId, args.input, {
          ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (error) {
        if (error instanceof MachinePresetActionError) {
          return { ok: false, errorCode: [404, 405, 501].includes(error.status) ? 'unsupported_action' : 'machine_preset_request_failed', error: error.message };
        }
        throw error;
      }
    },
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
      if (!accountContext) throw new AcpCatalogOperationError('not_authenticated');
      const preferences = settingsParse(await accountContext.readRawSettings());
      const { catalog } = await readAcpCatalogInContext(accountContext);
      accountContext.assertCurrent();
      return listAgentBackendsForVoiceTool({ includeDisabled, limit, machineId, serverId: accountContext.serverId,
        acpCatalogSnapshot: catalog, backendEnabledByTargetKey: preferences.backendEnabledByTargetKey ?? null });
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
    workflowEventsList: async (args, context) => {
      const catalog = await machineContributionRegistryProjectionDescribe(args.machineId, {
        serverId: args.serverId, signal: context.signal, accountLifetime: accountContext?.accountLifetime,
      });
      if (!catalog.supported || catalog.automationEligibleEvents === undefined) {
        return { ok: false, errorCode: 'workflow_event_catalog_unavailable', error: 'workflow_event_catalog_unavailable' };
      }
      return { machineId: args.machineId, events: projectAutomationEligibleEventsCatalogV1(catalog.automationEligibleEvents) };
    },
    machinesAgentsList: async (args, context) => {
      const roster = await machineContributionRegistryProjectionDescribe(args.machineId, {
        serverId: args.serverId,
        selection: 'agents',
        signal: context.signal,
        accountLifetime: accountContext?.accountLifetime,
      });
      if (!roster.supported) {
        return { ok: false, errorCode: 'machine_agent_inventory_unavailable', error: 'machine_agent_inventory_unavailable' };
      }
      const agents = buildMachineAgentInventoryDescriptors({ pluginProjectionV2: roster.projection })
        .filter(({ agentId }) => !args.agentId || args.agentId === agentId);
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
      if (args.probe) {
        const target = await resolveNativeInventoryProbeTarget(args);
        if (!target || !args.machineId) return { items: [], source: 'unavailable' };
        const result = await probeAgentModelsForActions({ ...args, machineId: args.machineId, probe: args.probe }, target);
        accountContext?.assertCurrent();
        return result;
      }
      const { agentId, machineId, serverId, limit, backendTargetKey } = args;
      return await listAgentModelsForVoiceTool({ agentId, machineId, serverId, limit, backendTargetKey });
    },
    agentsConfigOptionsList: async (args) => {
      const target = args.probe ? await resolveNativeInventoryProbeTarget(args) : undefined;
      if (args.probe && !target) return { items: [], source: 'unavailable' };
      const result = await listAgentConfigOptionsForActions(args, target ?? undefined);
      accountContext?.assertCurrent();
      return result;
    },
    agentsSessionModesList: async (args) => {
      const target = args.probe ? await resolveNativeInventoryProbeTarget(args) : undefined;
      if (args.probe && !target) return { items: [], source: 'unavailable' };
      const result = await listAgentSessionModesForActions(args, target ?? undefined);
      accountContext?.assertCurrent();
      return result;
    },
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

    sessionStateFieldSet: async (write) => {
      const { sessionId, fieldId, value, actionId, context, serverId } = write;
      const sid = String(sessionId ?? '').trim();
      if (!sid) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      const updatedAt = Date.now();
      context.signal?.throwIfAborted();
      if (fieldId === 'intent.voicePreference' && value !== null) {
        const builtIn = readBuiltInSessionVoiceDeclarationV1(value.providerContributionId);
        const entry = createDefaultVoiceProviderRegistry().get(value.providerContributionId);
        const declaration = builtIn ?? entry?.declaration;
        const providerConfig = builtIn ? Object.fromEntries((builtIn.settings?.fields ?? []).map(field => [field.id, field.default ?? null]))
          : entry?.providerSettings?.defaultConfig;
        if (!declaration || !providerConfig) return { ok: false, errorCode: 'override_unsupported', error: 'override_unsupported' };
        const admitted = admitDeclaredSessionVoicePreferenceV1({ providerContributionId: value.providerContributionId,
          declaration, providerConfig, preference: value });
        if (admitted.kind === 'unavailable') return { ok: false, errorCode: admitted.reason, error: admitted.reason };
      }
      if (fieldId === 'intent.context') {
        await withUiPromptLibraryArtifactReader(reader => admitSessionContextIntentV1(value, reader.readArtifactHeader), {
          serverId, signal: context.signal,
        });
        context.signal?.throwIfAborted();
      }
      const result = await writeUiSessionStateField({
        sessionId: sid, fieldId,
        value: fieldId === 'display.title' ? { title: String(value), updatedAt } : value,
        metadataReason: `ui-${actionId}`,
        ...(opts?.sessionStateMetadataPreprocess ? { metadataPreprocess: opts.sessionStateMetadataPreprocess } : {}),
        updateSessionMetadataWithRetry: async (targetSessionId, updater) => {
          context.signal?.throwIfAborted();
          let committedRevision: number | undefined;
          await sync.patchSessionMetadataWithRetry(targetSessionId, (metadata) => {
            context.signal?.throwIfAborted();
            return updater(metadata);
          }, { serverId: serverId ?? null,
            ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}),
            onMetadataCommitted: (revision) => { committedRevision = revision; },
            ...('expectedMetadataRevision' in write ? { expectedMetadataRevision: write.expectedMetadataRevision } : {}) });
          if (committedRevision === undefined) throw new Error('Session metadata acknowledgement is unavailable');
          return { version: committedRevision };
        },
      });
      if (!result.ok) return { ok: false, errorCode: result.reason, error: result.reason };
      return { ok: true, sessionId: sid, ...(fieldId === 'display.title' ? { title: value, updatedAt }
        : fieldId === 'display.bot' ? { bot: value } : fieldId === 'intent.memoryEnabled' ? { enabled: value }
        : fieldId === 'intent.voicePreference' ? { preference: value }
        : fieldId === 'intent.context' ? { updated: true } : { showToolCalls: value }), version: result.version };
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
      await sessionRespondToPermission(sessionId, request, serverId ? { serverId } : undefined);
      accountContext?.assertCurrent();
      // Feedback follows the applied response, including approved replay. A
      // deferred approval request must not look like a completed permission edit.
      if (serverId && !areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)) return { ok: true };
      if (request.approved && request.mode === 'acceptEdits') storage.getState().updateSessionPermissionMode(sessionId, 'acceptEdits');
      if (request.decision === 'abort') {
        const session = storage.getState().sessions[sessionId];
        const metadata = session ? readSessionOwnerMetadataView(session) : null;
        const resolution = serverId ? await resolveServerCredentialAccountScope(serverId) : null;
        const behavior = resolveSessionPermissionBehavior({
          agentId: resolveAgentIdForPermissionUi({ metadata, flavor: metadata?.flavor, toolName: '' }), metadata,
          accountScope: resolution?.kind === 'bound' ? resolution.scope : serverId ? null : undefined,
        });
        accountContext?.assertCurrent();
        if (behavior?.footer?.forceReadOnlyAfterStop) storage.getState().updateSessionPermissionMode(sessionId, 'read-only');
      }
      return { ok: true };
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
      return projectSessionInteractionRpcResult(await sessionRespondToUserAction(sessionId, {
          id: reqId,
          approved,
          ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
          ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
        }, serverId ? { serverId } : undefined));
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
      if (args.captureBefore || args.expected) accountContext?.assertCurrent();
      if (args.teamCredentialModel !== undefined && (args.captureBefore || args.expected)) {
        return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
      }
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
          ...(args.captureBefore !== undefined ? { captureBefore: args.captureBefore } : {}),
          ...(args.expected ? { expected: args.expected } : {}),
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
        if (args.expected?.owner === 'inactive') {
          return { ok: false, errorCode: 'superseded', error: 'superseded' };
        }
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
          if (args.expected?.owner === 'active') {
            return { ok: false, errorCode: 'superseded', error: 'superseded' };
          }
          const candidate = createModelIntentMetadataCasCandidate({
            selection: initialRequest.request.selection,
            captureBefore: args.captureBefore,
            ...(accountContext ? { ownerScope: { serverId: accountContext.serverId, accountId: accountContext.accountId, sessionId: normalizedSessionId } } : {}),
            ...(args.expected ? { expected: args.expected } : {}),
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
              errorCode: candidateState.refusal === 'unsupported' ? 'unsupported' : 'superseded',
              error: candidateState.refusal === 'unsupported' ? 'unsupported' : 'superseded',
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
            ...(candidateState.reversal ? { reversal: candidateState.reversal } : {}),
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

    searchConversations: async ({ input, context }) => {
      if (!accountContext) throw new Error('Exact Account context is unavailable');
      accountContext.assertCurrent();
      const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext.serverId });
      const settings = accountContext.readLiveSettings() ?? accountContext.settings;
      const { resolveConversationSearchProviders } = await import('@/sync/domains/memory/useMemorySearchProvider');
      const providers = resolveConversationSearchProviders({
        homeSearchEnabled: resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'search', settings, snapshot })?.state === 'enabled',
        homeCapability: snapshot.status === 'ready' ? snapshot.features.capabilities.homeSearch : undefined,
        daemonEnabled: resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'memory.search', settings, snapshot })?.state === 'enabled',
      });
      const { searchConversationsForAccount } = await import('@/sync/ops/searchConversations');
      return await searchConversationsForAccount({ ...input, providers,
        accountLifetime: accountContext.accountLifetime, signal: context.signal });
    },

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
        const result = await searchDaemonMemory({
          ...query,
          machineId,
          serverId: exactServerId,
          accountId: accountLifetime.scope.accountId,
          ...(signal ? { signal } : {}),
        });
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

    daemonMemoryGetWindow: async ({ machineId, serverId, signal, ...request }) => {
      const accountLifetime = accountContext?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
      const exactServerId = String(serverId ?? accountLifetime?.scope.serverId ?? '').trim();
      if (
        !accountLifetime
        || !exactServerId
        || !areServerProfileIdentifiersEquivalent(exactServerId, accountLifetime.scope.serverId)
      ) {
        throw Object.assign(new Error('Exact Account scope is unavailable.'), { code: 'not_authenticated' as const });
      }
      if (request.source !== undefined) {
        if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Exact Account scope is unavailable.'), { code: 'not_authenticated' as const });
        const result = await machineRpcWithServerScope({ machineId, serverId: exactServerId,
          accountId: accountLifetime.scope.accountId, preferScoped: true,
          method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, payload: { ...request, v: 1 }, ...(signal ? { signal } : {}),
        });
        if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Exact Account scope is unavailable.'), { code: 'not_authenticated' as const });
        return result;
      }
      const { sessionId, seqFrom, seqTo } = request;
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

    approvalsResolveBlockingDecision: async ({ artifactId, request, decision, decisionAuthority }) =>
      await approvalCoordinator.resolveBlockingDecision({ artifactId, request, decision, decisionAuthority }),

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
      return { ...decision, request: StoredApprovalRequestSchema.parse(decision.request) };
    },

    promptDocGet: async (args) => withPromptLibraryStore((store) => readPromptDocInLibrary({ store, ...args }), args.signal),
    promptDocCreate: async ({ signal, ...request }) => withPromptLibraryStore((store) => createPromptDocInLibrary({ store, request: resolvePromptDocCreateActionInputV1(request), signal }), signal),
    promptDocFavoriteSet: async ({ signal, ...request }) => withPromptLibraryStore((store) => setPromptDocFavorite({ store, request, signal }), signal),
    promptsLibraryList: async ({ signal, ...request }) => withPromptLibraryStore((store) => listPromptLibrary({ store, request, signal }), signal),
    promptDocUpdate: async ({ signal, ...request }) => withPromptLibraryStore((store) => updatePromptDocInLibrary({ store, request, signal }), signal),

    promptBundleUpdate: async ({ artifactId, title, skillMarkdown, folderId, tags }) => {
      await withPromptLibraryStore((store) => updateSkillPromptBundle({ artifactId, title, skillMarkdown, ...(typeof folderId !== 'undefined' ? { folderId } : {}), ...(tags ? { tags } : {}) }, store));
      return { ok: true, artifactId };
    },

    promptAssetExport: async ({ artifactId, machineId, assetTypeId, scope, serverId, directory, targetPath, targetName, installMode, signal }) => {
      const libraryServerIdentityId = accountContext?.serverIdentityId;
      const machineServerIdentityId = getServerProfileById(serverId ?? accountContext?.serverId ?? '')?.serverIdentityId;
      if (!libraryServerIdentityId || !machineServerIdentityId) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      const links = await capturePromptExternalLinks(signal);
      const result = await withPromptLibraryStore((store) => writePromptLibraryArtifactToExternalAsset({
        artifactId,
        machineId,
        machineTarget: { serverIdentityId: machineServerIdentityId, machineId },
        libraryServerIdentityId,
        assetTypeId,
        scope,
        serverId,
        workspacePath: directory ?? null,
        targetInput: targetPath ?? targetName ?? '',
        installMode,
        promptExternalLinks: links.value,
        previewOnly: false,
      }, store), signal);
      if (!result.ok || !result.nextPromptExternalLinks) {
        return { ok: false, errorCode: result.ok ? 'invalid_parameters' : (result.errorCode ?? 'invalid_parameters'), error: result.ok ? 'invalid_parameters' : result.error };
      }
      try {
        await links.write(result.nextPromptExternalLinks);
      } catch (error) {
        if (!(error instanceof PromptLibraryRowOperationError)) throw error;
        return { ok: false, errorCode: error.code, error: error.code, details: { artifactId, exported: true } };
      }
      return { ok: true, artifactId, exported: true };
    },

    promptRegistryInstall: async ({ machineId, sourceId, itemId, configuredSources, serverId, installTarget, signal }) => {
      const libraryServerIdentityId = accountContext?.serverIdentityId;
      const machineServerIdentityId = getServerProfileById(serverId ?? accountContext?.serverId ?? '')?.serverIdentityId;
      if (!libraryServerIdentityId || !machineServerIdentityId) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      const links = await capturePromptExternalLinks(signal);
      const result = await withPromptLibraryStore((store) => installPromptRegistryItem({
        machineId,
        machineTarget: { serverIdentityId: machineServerIdentityId, machineId },
        libraryServerIdentityId,
        sourceId,
        itemId,
        configuredSources,
        serverId,
        promptExternalLinks: links.value,
        ...(signal ? { signal } : {}),
        ...(installTarget ? { installTarget } : {}),
      }, store), signal);
      if (!result.ok) {
        return { ok: false, errorCode: result.errorCode ?? 'invalid_parameters', error: result.error,
          ...(result.artifactId ? { artifactId: result.artifactId } : {}),
          ...(result.exported === true ? { details: { exported: true, response: result.response,
            ...(result.artifactId ? { artifactId: result.artifactId } : {}) } } : {}) };
      }
      if (result.nextPromptExternalLinks) {
        try {
          await links.write(result.nextPromptExternalLinks);
        } catch (error) {
          if (!(error instanceof PromptLibraryRowOperationError)) throw error;
          return { ok: false, errorCode: error.code, error: error.code,
            details: { ...(result.artifactId ? { artifactId: result.artifactId } : {}), exported: result.exported,
              ...(result.response ? { response: result.response } : {}) } };
        }
      }
      return { ok: true, artifactId: result.artifactId, exported: result.exported };
    },

    ...(opts?.resolveServerIdForSessionId ? { resolveServerIdForSessionId: opts.resolveServerIdForSessionId } : {}),
  };

  const companionDeps = accountContext ? createWidgetCompanionActionDepsV1(accountContext) : {};
  const areaDeps = createWidgetAreaActionDepsV1(accountContext, opts?.resolveWidgetAreaPresets, opts?.widgetAreaIsCurrent);
  const widgetSurfaceDeps = { ...deps, ...areaDeps, widgetSurfaceActions: { ...deps.widgetSurfaceActions, ...companionDeps.widgetSurfaceActions, ...areaDeps.widgetSurfaceActions } };
  const widgetDefinitionDeps = { ...widgetSurfaceDeps, ...createWidgetDefinitionActionDepsV1(accountContext, widgetSurfaceDeps) };
  const widgetHostDeps = { ...widgetDefinitionDeps, ...createWidgetCatalogActionDepsV1(accountContext, widgetDefinitionDeps) };
  const widgetInputDeps = { ...widgetHostDeps, ...createWidgetInputActionDepsV1(accountContext, widgetHostDeps) };
  const executor = createActionExecutor({ ...widgetInputDeps, ...createWidgetRefreshActionDepsV1(accountContext, widgetInputDeps),
    ...(opts?.projectWorkerAction ? { projectWorkerAction: opts.projectWorkerAction }
      : accountContext ? { projectWorkerAction: createUiProjectWorkerActionV1(accountContext) } : {}),
  });

  // Surface attribution is owned by the host that constructs the executor, mirroring
  // `apps/cli/src/session/actions/createCliActionExecutor.ts` (`?? 'cli'`). This factory is the
  // app client's entrypoint, so an unattributed caller is a `ui` caller — a `voice` or `plugin`
  // caller stamps its own surface and still wins. Without this the surface reaches the catalog
  // gate nullish, which now fails closed (INV-1 / DEC-2).
  const resolveContext = (context: Parameters<typeof executor.execute>[2], input: unknown, actionId?: ActionId): ActionExecutorContext => {
    const surface = context?.surface ?? 'ui';
    const credential = accountContext?.credentialAuthorityKind ?? getCurrentAuth()?.credentialAuthorityKind ?? 'none';
    const authority = opts?.admittedClientActionId
      ? context?.authority ?? 'account_automation'
      : resolveInvocationAuthority({ credential, surface });
    // Ordinary UI callers do not author approval provenance. Retain stronger
    // invocation identities, otherwise bind one attempt at this host before
    // execute/prepare reaches the strict approval-origin owner.
    const creationKey = typeof input === 'object' && input !== null && 'creationKey' in input
      && typeof input.creationKey === 'string' ? input.creationKey.trim() : undefined;
    return {
      ...(context ?? {}),
      actionsSettings: resolveActionsSettingsSnapshot(),
      surface,
      authority,
      ...(accountContext ? { managedMachineCreationEnabled: accountContext.settings.managedMachineCreationEnabled } : {}),
      ...(opts?.admittedClientActionId ? { bypassApprovals: actionId === opts.admittedClientActionId } : {}),
      ...(surface === 'ui' && (credential === 'account' || credential === 'terminal')
        ? { actionRequestId: context?.actionRequestId ?? (creationKey || randomUUID()) }
        : {}),
    };
  };

  return {
    // A genuine present-user native invocation has one installed Action policy
    // and approval owner. Do not create a second local Ask before its relay.
    executeNativeManagedAction: async (actionId: ManagedMachineActionIdV1, input: unknown, context?: ActionExecutorContext) => {
      if (!accountContext) return { ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const resolvedContext = resolveContext(context, input, actionId);
      const preferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, resolvedContext);
      if (preferenceFailure) return preferenceFailure;
      return await executeManagedMachineNativeAction({ account: accountContext, actionId, input,
        context: resolvedContext, ...(context?.signal ? { signal: context.signal } : {}) });
    },
    readWidgetInputDescriptor: async request => {
      const port = readWidgetActionSurfacePortV1(widgetInputDeps, request.ref.surface);
      if (!port || !widgetInputDeps.readWidgetInputDescriptor) return null;
      const current = await port.read(request.ref.surface, request.context, request.signal);
      if ('ok' in current || !current.instances.some(row => row.instance.id === request.ref.instanceId && sameStrictJsonValue(row.instance, request.instance))) return null;
      return widgetInputDeps.readWidgetInputDescriptor(request);
    },
    readWidgetMovementAdmission: (ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, context: ActionExecutorContext) =>
      readWidgetEntityMovementAdmission(widgetInputDeps, ref, surface, resolveContext(context, { ref })),
    prepare: async (actionId, input, context) => await executor.prepare(actionId, input, resolveContext(context, input, actionId)),
    execute: async (actionId, input, context) => await executor.execute(actionId, input, resolveContext(context, input, actionId)),
    replayApprovedApprovalRequest: async (args) => await executor.replayApprovedApprovalRequest(args),
  };
}


type DefaultActionExecutorOptions = Parameters<typeof buildDefaultActionExecutor>[0];
/** UI-only projection qualifier; the captured Account owner enforces it before admission. */
export type UiActionExecutorContext = ActionExecutorContext & Readonly<{
  expectedAccountId?: string;
  /** Destination-owner navigation leaf, consumed only in this invocation. */
  openRoute?: (route: string) => void | Promise<void>;
}>;
type DefaultActionExecutor = Omit<ReturnType<typeof createActionExecutor>, 'execute' | 'prepare'> & Readonly<{
  execute: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['execute']>;
  prepare: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['prepare']>;
}>;
type DefaultActionExecuteContext = Pick<UiActionExecutorContext, 'expectedAccountId' | 'externalActionCredential' | 'openRoute'> & Readonly<{
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

function assertExpectedActionAccount(account: Pick<LazyActionAccountContext, 'accountId'>, context?: Pick<UiActionExecutorContext, 'expectedAccountId' | 'externalActionCredential'>): void {
  if ((context?.expectedAccountId !== undefined && account.accountId !== context.expectedAccountId)
    || (context?.externalActionCredential && account.accountId !== context.externalActionCredential.accountId)) {
    throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
  }
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
  machineAccessAction: NonNullable<ActionExecutorDeps['machineAccessAction']>;
  machineWorkSummaryGet: NonNullable<ActionExecutorDeps['machineWorkSummaryGet']>;
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
    machineWorkSummaryGet: async ({ input, signal }) => {
      account.assertCurrent();
      if (input.serverId !== account.serverId) return { ok: false as const, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const result = await machineRpcWithServerScope({ serverId: account.serverId, accountId: account.accountId,
        machineId: input.machineId, method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, payload: input, preferScoped: true,
        ...(signal ? { signal } : {}) });
      account.assertCurrent();
      return result;
    },
    machineAccessAction: async (args) => {
      account.assertCurrent();
      const { executeMachineAccessHttpAction, MachineAccessApiError } = await import('@/sync/api/machines/machineAccessApi');
      try {
        return await executeMachineAccessHttpAction({ scope, isCurrent, actionId: args.actionId, input: args.input,
          ...(args.signal ? { signal: args.signal } : {}) });
      } catch (error) {
        if (error instanceof MachineAccessApiError) return { ok: false as const, errorCode: error.code, error: error.code };
        throw error;
      }
    },
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
      assertExpectedActionAccount(account, context);
      const settings = await account.readSettings();
      account.assertCurrent();
      context.signal?.throwIfAborted();
      const result = await work(buildDefaultActionExecutor({ ...opts, ...(context.openRoute ? { openRoute: context.openRoute } : {}) }, { ...account, settings }), account);
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

/** Execute through the complete UI Action owner while borrowing an already-captured Account lifetime. */
export async function executeDefaultActionInCapturedAccount(
  account: LazyActionAccountContext,
  actionId: ActionId,
  input: unknown,
  context?: UiActionExecutorContext,
) {
  assertExpectedActionAccount(account, context);
  const settings = await account.readSettings();
  account.assertCurrent();
  context?.signal?.throwIfAborted();
  const result = await buildDefaultActionExecutor(undefined, { ...account, settings }).execute(actionId, input, {
    ...context,
    serverId: account.serverId,
    ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
    runtimeAccountId: account.accountId,
  });
  account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
  return result;
}

/** Read-only drag admission borrows the complete Action dependency composition and exact Account lifetime. */
export async function readDefaultWidgetMovementAdmission(ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, signal?: AbortSignal, widgetAreaContext?: ActionExecutorContext['widgetAreaContext']) {
  // The destination Account owns the layout, not necessarily the signed-in editor.
  // Capture the real invoking Account through the same Action context as execution.
  return withDefaultActionExecuteContext(undefined, { serverId: surface.serverId, signal },
    executor => executor.readWidgetMovementAdmission(ref, surface, { surface: 'ui', serverId: surface.serverId, signal, ...(widgetAreaContext ? { widgetAreaContext } : {}) }));
}

/** Sharing reviews reuse the admitted input descriptor with the same complete host composition. */
export async function readDefaultWidgetShareInputDescriptorV1(input: Readonly<{
  ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; scope: Readonly<{ serverId: string; accountId: string }>; signal?: AbortSignal;
}>) {
  return withDefaultActionExecuteContext(undefined, { ...input.scope, expectedAccountId: input.scope.accountId, signal: input.signal },
    executor => executor.readWidgetInputDescriptor({ ref: input.ref, instance: input.instance, admission: 'configuration',
      context: { surface: 'ui', serverId: input.scope.serverId, signal: input.signal }, signal: input.signal }));
}

// A qualified Account Action selects its input Home on every surface. Only
// unqualified UI actions fall back to the currently focused Home.
export function resolveDefaultActionInvocationServerId(actionId: ActionId, input: unknown, context?: UiActionExecutorContext): string | undefined {
    if (context?.serverId) return context.serverId;
    if (isProjectActionIdV1(actionId) && actionId !== 'projects.trust.list' && actionId !== 'projects.trust.revoke') {
      const qualified = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (qualified.success) return qualified.data.workspace.serverId;
    }
    if (isSessionStateFieldActionId(actionId)) {
      const qualified = getActionSpec(actionId).inputSchema.safeParse(input);
      const target = qualified.success ? qualified.data : null;
      if (target && typeof target === 'object' && 'serverId' in target && typeof target.serverId === 'string') return target.serverId;
    }
    if (actionId === 'session.spawn_new') {
      const qualified = SessionSpawnNewInputV2Schema.safeParse(input);
      if (qualified.success) return qualified.data.executionTarget.serverId;
    }
    if (actionId === 'machines.work.summary.get') {
      const qualified = MachineWorkSummaryGetInputV1Schema.safeParse(input);
      if (qualified.success) return qualified.data.serverId;
    }
    const memoryAction = MEMORY_DOCUMENT_ACTION_IDS_V1.find(id => id === actionId);
    if (memoryAction) {
      const qualified = MemoryActionInputSchemasV1[memoryAction].safeParse(input);
      if (qualified.success) {
        const target = qualified.data;
        const serverId = 'ref' in target ? target.ref.serverId
          : 'sessionRef' in target ? target.sessionRef.serverId
            : 'scope' in target ? target.scope === 'project' ? target.projectRef.serverId : undefined : target.serverId;
        if (serverId) return serverId;
      }
    }
    const operationAction = ActionOperationActionIdV1Schema.safeParse(actionId);
    if (operationAction.success) {
      const qualified = ActionOperationActionInputSchemasV1[operationAction.data].safeParse(input);
      if (qualified.success) return qualified.data.serverId;
    }
    const sourceAction = PROJECT_SOURCE_ACTION_SPECS_V1.find(spec => spec.id === actionId);
    if (sourceAction) {
      const qualified = sourceAction.inputSchema.safeParse(input);
      if (qualified.success) return qualified.data.serverId;
    }
    if (actionId === 'projects.context.update') {
      const qualified = ProjectContextUpdateInputV1Schema.safeParse(input);
      if (qualified.success) return qualified.data.target.serverId;
    }
    return (isRoleActionIdV1(actionId) || (context?.surface ?? 'ui') === 'ui')
      ? getActiveServerAccountScope()?.serverId : undefined;
}

export function createDefaultActionExecutor(opts?: DefaultActionExecutorOptions): DefaultActionExecutor {
  let unscoped: ReturnType<typeof createActionExecutor> | undefined;
  const ordinary = () => unscoped ?? (unscoped = buildDefaultActionExecutor(opts));
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
  const nativeAction = (actionId: ActionId): ManagedMachineActionIdV1 | null => {
    // An admitted replay retains its existing strict approval custody. Ordinary
    // relay ingress cannot consume a local Artifact's bypass proof.
    if (opts?.admittedClientActionId) return null;
    const parsed = ManagedMachineActionIdV1Schema.safeParse(actionId);
    return parsed.success && parsed.data !== 'machines.managed.list'
      && parsed.data !== 'machines.managed.get' && parsed.data !== 'machines.managed.cancel'
      && parsed.data !== 'machines.managed.setup.skip'
      && parsed.data !== 'machines.managed.references.get' ? parsed.data : null;
  };
  return {
    execute: async (actionId, input, context) => {
      const { openRoute, ...actionContext } = context ?? {};
      const custodyFailure = resolveUiFilesystemTransferCustodyFailure(actionId, input);
      if (custodyFailure) return custodyFailure;
      const api = await apiTokenTransport();
      if (api) return await executeApiTokenAction(api, actionId, input, actionContext);
      const serverId = resolveDefaultActionInvocationServerId(actionId, input, context);
      if (!serverId) return await ordinary().execute(actionId, input, actionContext);
      try {
        return await withDefaultActionExecuteContext(opts, { ...actionContext, openRoute, serverId }, async (executor, account) => {
          const capturedContext = {
            ...actionContext,
            serverId,
            ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
            runtimeAccountId: account.accountId,
          };
          const native = nativeAction(actionId);
          return native ? await executor.executeNativeManagedAction(native, input, capturedContext)
            : await executor.execute(actionId, input, capturedContext);
        }, actionId);
      } catch (error) {
        const failure = accountScopeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    prepare: async (actionId, input, context) => {
      const { openRoute, ...actionContext } = context ?? {};
      const custodyFailure = resolveUiFilesystemTransferCustodyFailure(actionId, input);
      if (custodyFailure) return { kind: 'settled', result: custodyFailure };
      const api = await apiTokenTransport();
      if (api) return { kind: 'ready', invocation: { run: async () => await executeApiTokenAction(api, actionId, input, actionContext) } };
      const serverId = resolveDefaultActionInvocationServerId(actionId, input, context);
      if (!serverId) return await ordinary().prepare(actionId, input, actionContext);
      const account = await captureLazyActionAccountContext(serverId, context?.signal);
      try {
        assertExpectedActionAccount(account, context);
        const settings = await account.readSettings();
        account.assertCurrent();
        context?.signal?.throwIfAborted();
        const executor = buildDefaultActionExecutor({ ...opts, ...(openRoute ? { openRoute } : {}) }, { ...account, settings });
        const capturedContext = {
          ...actionContext,
          serverId,
          ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
          runtimeAccountId: account.accountId,
        };
        const native = nativeAction(actionId);
        const preferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, {
          managedMachineCreationEnabled: settings.managedMachineCreationEnabled,
        });
        const prepared = native
          ? preferenceFailure ? { kind: 'settled' as const, result: preferenceFailure }
            : { kind: 'ready' as const, invocation: { run: async () => await executor.executeNativeManagedAction(native, input, capturedContext) } }
          : await executor.prepare(actionId, input, capturedContext);
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
