import { createActionConfirmationPresenter } from './actionConfirmationPresenter';
import { requireActionSuccess } from './actionResult';
import { createPrivateLabelActionOpener, createPrivateLabelActionPreparer } from '@/sync/ops/privateLabels/privateLabelClient';
import { openMachinePoolActionOutputV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { createMachinePoolPrivateLabelClientForAccount, openMachinePoolPrivateViewV1 } from '@/sync/ops/machinePoolPrivateLabelProjection';
import { resolveAmbientTeamCredentialModelForModelIntent } from '@happier-dev/agents/session/state/metadataReaders';
import { readActionOutputDiagnostic, withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { isSessionSpawnNewActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { isComputerRuntimeActionId } from '@happier-dev/protocol/actions/executor/computer';
import { readLocalServiceControlActionRequest, resolveLocalServiceDomainActionRpcBinding } from '@happier-dev/protocol/actions/specs/localServices';
import { LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION } from '@happier-dev/protocol/local/services/actionIdsV1';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { resolveApprovalReplayRoute } from './approvalReplayRoute';
import { confirmOwnUiRefusal, executeMachineActionAtDaemon } from './executeMachineActionAtDaemon';
import { createUiPreparedSessionBirthV1 } from './preparedSessionBirth';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED, isAccountModeDowngradeUnverifiedError, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { writeSessionApprovalReviewerOverrideV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { recordReviewCommentReads } from '@/sync/domains/reviews/comments/reviewRunComments';
import type { ReviewCommentListResponseV1, ReviewCommentGetResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { SessionArchiveActionInputV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { isSessionArchiveOperationCurrent, resolveSessionArchiveAddress, type SessionArchiveOperation } from '@/sync/domains/session/listing/sessionArchiveState';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { AccountStorageCurrentnessUnavailableError } from '@/sync/encryption/accountStorageReadFailure';
import type { ApprovalStaleReason } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { executeSessionMessageReplyReview } from './sessionMessageReplyReview';
import { readSessionContinuationOnMachine, readSessionContinuationsOnMachine } from '@/sync/ops/sessionContinuationInspectionRpc';
import { projectAutomationEligibleEventsCatalogV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readRpcFailureCode } from './rpcFailureCode';
import { createThemeActionExecute } from './themeActionDeps';
import { getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import { prepareThemeProfileCss } from '@/theme/css/prepareThemeCss';
import { projectThemeSurfacePaintMap } from '@/theme/css/themeSurfacePaintMap';
import { readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { replayLiveCliApproval } from './liveCliApprovalReplay';
import { createWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createUiProjectWorkerActionV1 } from './projectWorkerAction';
import { createUiRegistryActionExecuteV1, createUiRegistryHostV1 } from '@/registries/registryHostDeps';
import { createUiSkillActionExecuteV1, refreshUiSkillActionAcknowledgements } from './skillActionDeps';
import { readUiPluginSkillV1, readUiSkillLibraryCatalogV1 } from './pluginSkillActionDeps';
import { isPluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { readFoundSkillBundle } from '@/sync/domains/transfers/runtime/transferRuntime/families/foundSkillTransfers';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { createUiProjectContextAction } from './projectContextAction';
import { createUiSessionStatusGet } from './sessionStatusAction';
import { createUiSessionHandoffRecoveryActionDeps } from './sessionHandoffRecoveryActionDeps';
import { createUiPetChooseAction } from './petChooseAction';
import { setClientEncryptionRequirement } from '@/sync/ops/settings/setClientEncryptionRequirement';
import { readSessionTranscriptForAction } from '@/sync/api/session/sessionTranscriptActions';
import { readUiMemoryInheritedContext, readUiMemoryScopeContext } from './readUiMemoryInheritedContext';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { createWidgetRefreshActionDepsV1 } from './widgetRefreshActionDeps';
import { createWidgetDefinitionActionDepsV1 } from './widgetDefinitionActionDeps';
import { executeComposerIngressAction } from './composerIngressActionRuntime';
import { createWidgetCompanionActionDepsV1 } from './widgetCompanionActionDeps';
import { readWidgetEntityMovementAdmission } from './widgetEntityMovement';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, readWidgetActionSurfacePortV1, flattenWidgetLayoutWidgetsV1, type WidgetInstanceRefV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { readWidgetActionSessionTargetV1 } from '@happier-dev/protocol/widgets/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { setModelFavoriteV1 } from '@happier-dev/protocol/providers/modelFavoritesV1';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { forgetHistoricalEncryptionKey } from '@/sync/ops/account/forgetHistoricalEncryptionKey';
import { AccountEncryptionModeChangedError, convertAccountEncryptionMode } from '@/sync/ops/account/convertAccountEncryptionMode';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { isTokenOnlyAuthCredentials } from '@/auth/storage/tokenStorage';
import { assertUiAccountEncryptionModeAllowed } from '@/sync/domains/settings/clientEncryptionRequirement';
import { AccountSettingsHistoryRestoreInvalidError, restoreAccountSettingsFromHistorySnapshot } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import type { SettingsDeclarationOperationInputV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { recoverHistoricalAutomationTemplates } from '@/sync/ops/account/recoverHistoricalAutomationTemplates';
import { startAgentSignInRpc, checkAgentSignInRpc } from '@/agents/machineAgents/signIn/api';
import { buildSessionPermissionRespondRpcParamsV1, buildSessionUserActionAnswerDetails, buildSessionUserActionAnswerMap } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { buildMachineAgentInventoryKey, buildMachineAgentsDetectRequest, projectMachineAgentsDetectResponse, projectAcpCatalogForMachineInventory, MachineAgentInventoryUnavailableError } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { agentRoutingIdAddressesContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, listApprovalArtifactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema, readApprovalRequesterDecisionV1, resolveApprovalExecutor, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { readOriginalAccountActionMachine } from '@/sync/api/externalActionAccountTransport';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { sessionGoalGet, sessionGoalSet, sessionGoalClear } from '@/sync/ops/sessionGoals';
import {
  sessionUsageLimitWaitResumeEnable, sessionUsageLimitWaitResumeCancel, sessionUsageLimitCheckNow,
  sessionUsageLimitSwitchAccountNow, sessionUsageLimitConsumeResetCredit,
  type SessionUsageLimitRecoveryOperationResult,
} from '@/sync/ops/sessionUsageLimitRecovery';
import { createActionExecutor, readHostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { completeSpawnActionResult } from '@happier-dev/protocol/actions/executor/resultProjection';
import { projectSessionReferenceFailure, resolveServerIdForSession } from '@happier-dev/protocol/actions/executor/sessionScope';
import { readActionFailureEnvelope, readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { createUiTargetActionApprovalReplay } from './targetActionApprovalReplay';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ActionSessionAddress } from '@happier-dev/protocol/actions/executor/types';
import { SessionTargetPreviewV1Schema, type SessionTargetPreviewV1, type SessionTargetSelectorV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD, type CurrentSessionPresentationActionResultV1 } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import { projectActionFailureCauseV1, createActionExecuteFailureError, parseActionExecuteFailure, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createUiProviderActionExecuteV1 } from './providerActionDeps';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2, projectSessionSpawnNewActionInputV2, type SessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { materializeSessionCreationActionInput } from '@happier-dev/protocol/actions/executor/sessionSpawn';
import { SessionSpawnNewActionResultV1Schema, readSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createUiSessionCapabilityActionDeps } from './sessionCapabilityActionDeps';
import { createUiMachineRecipesRead } from './machineRecipeActionDeps';
import { setSessionCapabilityV1 } from '@happier-dev/protocol/actions/executor/sessionCapabilities';
import { setSessionConnectedServiceAuthBinding } from '@/sync/ops/connectedServices/sessionAuthSwitch';
import { MACHINE_VITALS_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineVitals';
import { MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineResources';
import { MACHINE_ROLES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineRoles';
import { MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineIsolation';
import { MACHINE_ISOLATION_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineIsolationActionIdsV1';
import { readSyncedMachineIsolationPolicy } from '@/sync/domains/machines/machineIsolationPolicy';
import { readSyncedMachineRoles, readSyncedMachineRolesList } from '@/sync/domains/machines/roles/machineRoles';
import { resolveMachineGuardOperationTimeoutMs } from '@happier-dev/protocol/machines/guard/actionIdsV1';
import { resolveMachineAgentIsolationOperationTimeoutMs } from '@happier-dev/protocol/actions/specs/machine/agentIsolationActionIdsV1';
import { machineResourcesPolicyGet } from '@/sync/ops/machineResourcesPolicy';
import { listMachineVitalsSummariesV1, readMachineVitalsResourcesProjectionV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { filterVisibleMachines, resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { createTerminalUtf8ProjectionDecoder, TERMINAL_OUTPUT_GAP_MARKER } from '@/sync/domains/terminal/stream/runtime';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { createPromptDocInLibrary, updatePromptBundleInLibrary, setPromptDocFavorite, listPromptLibrary, readPromptDocInLibrary, updatePromptDocInLibrary, readSkillInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { SkillReadResultV1Schema, type SkillReadInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { resolvePromptDocCreateActionInputV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readSkillRulesForItemV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { readSkillUsageCatalogV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { readPromptLibraryCatalogProjectionInContext, mutatePromptLibraryRoleOverrideInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec, resolveActionExecutionPlacementForInput, type PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema, isWorkspaceSyncRelationshipWriteActionId, WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkspaceSyncRelationshipWriteActionInputV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { resolveActionBackendTargetSelection } from '@happier-dev/protocol/actions/resolveActionBackendTargetSelection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { refreshMachineAgentsAfterLaunchRefusal } from '@/agents/machineAgents/useMachineAgents';
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
import { resolveExecutorActionsSettingsV1, resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import { PluginWebhookActionHttpPathsV1, type PluginWebhookPresentUserActionIdV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { projectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';
import { SessionModelTransitionRequestV1Schema, SessionModelTransitionResultV1Schema, type SessionModelTransitionRequestV1, type SessionModelTransitionResultV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, ActionExecuteResultSchema, isActionOutcomeUnknownErrorCodeV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PendingResetStartWaitingReasonV1Schema } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import type { ArtifactPublicLinkIssuedV1, ArtifactSignedInLinkOpenedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import type { MemoryWindowV1, MemoryWindowRequestV1 } from '@happier-dev/protocol/memory/memoryWindow';
import { clearDaemonMemoryIndex } from '@/sync/domains/memory/clearDaemonMemoryIndex';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { AutonomousExchangeStatusV1Schema } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { readSessionExchangeStatus } from '@/sync/api/session/sessionExchangeApi';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { supportsSessionMessageInputJsonSchema } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';
import { readSessionMessageInputSchema } from './sessionMessageInputSchema';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowActionInputV1, SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';
import { machineWorkspaceFileSearch } from '@/sync/ops/machineWorkspaceFileSearch';
import { machineLanguageIntelligenceQuery, machineLanguageIntelligenceRestart } from '@/sync/ops/machineLanguageIntelligence';
import { DaemonWorkspaceFileReplacePreviewResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { classifyWorkspaceFileRpcError } from '@/sync/ops/machineWorkspaceFileRpcError';
import { randomUUID } from '@/platform/randomUUID';
import { executeCurrentUiContextAction, executeCurrentUiContextContributedAction, listCurrentUiContextContributedActionDefinitions } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import { executeAdmittedClientActionChildAtMachine, type AdmittedClientActionParent } from './admittedClientActionChild';
import { clientActionUnavailable, buildUiActionDispatchRequestV1, parseClientActionDispatchResult, isWorkflowHostAdmittedChildActionIdV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import type { ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { buildMachineAgentInventoryDescriptors } from '@/agents/machineAgents/machineAgentCatalog';
import { DaemonAgentInstallReadResponseSchema, DaemonAgentInstallCancelResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  sessionBoardActionUsesLayoutV1,
  projectSessionBoardAdapterFailureV1,
  projectSessionBoardFeatureDecisionFailureV1,
  type SessionBoardActionIdV1,
  type SessionBoardActionFailureV1,
  type SessionBoardOutcomeUnknownDetailsV1,
} from '@happier-dev/protocol/sessions/board';
import {
    resolveAmbientProviderConnectionForModelIntent,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
  createModelIntentMetadataCasCandidate,
  createModelIntentV2MetadataCasCandidate,
  isInactiveModelIntentSessionActiveError,
  runModelIntentAtAuthoritativeDisposition,
} from '@happier-dev/agents/session/state/metadataWriters';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { isModelRefGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountApiTokenDeploymentInputV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import type { ApiTokenDeploymentAuthoringHost } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { completeUiProjectOpenResult } from './projectOpenResult';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { createUiLanguageIntelligenceApplyAction, createUiWorkspaceFileReplaceAction } from './workspaceFileReplaceAction';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { isActionAccountScopeChangedError } from '@/sync/domains/scope/actionAccountScopeError';
import { bindPresentUserActionConfirmation } from './presentUserConfirmation';
import { admitDeploymentHomeInputV1 } from '@happier-dev/protocol/actions/executor/deploymentHomeAdmission';
import { isMachineTerminalActionId } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';

import { captureLazyActionAccountContext, captureApprovalSettlementAccount, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createUiPendingEditAction } from './pendingEdit';
import { createUiPendingSendNowAction } from './pendingSendNow';
import { readRequesterSessionSpawnDisposition, resolveRequesterSessionSpawnDisposition } from './requesterSessionSpawnPreparation';
import { createUiArtifactAction } from './artifactActionDeps';
import { createUiArtifactPublicLinkDelivery } from './artifactPublicLinkDelivery';
import { createUiBotTemplateAction, readUiOwnedSessionForAction } from './botTemplateActionDeps';
import { createUiProfileActionExecuteV1 } from './profileActionDeps';
import { createUiMcpServerActionExecuteV1 } from './mcpServerActionDeps';
import { createUiRemoteHostActionExecuteV1 } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { createUiHomeRuntimeActionExecute } from './homeRuntimeActionDeps';
import { createUiAccountLifecycleAction } from './accountLifecycleActionDeps';
import { createUiNpmRegistryProfileAction } from './npmRegistryProfileActionDeps';
import { createPluginAccountAdministrationActionDeps } from './pluginAccountAdministrationActionDeps';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { createWidgetCatalogActionDepsV1 } from './widgetCatalogActionDeps';
import { publishHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureMountedWorkspaceAction, invokeWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { captureMountedDesktopOverlayPresentation } from '@/components/appShell/workspace/desktopOverlayPresentationRuntime';
import { invokeWorkflowAuthoringAction } from './workflowAuthoringAction';
import { openSessionAuthoringDraft } from './sessionAuthoringOpenAction';
import { setSessionSpaceMembership } from '../sessionOrganization/sessionSpaceMembership';
import { invokeSessionListOrganizationAction } from '@/components/sessions/shell/drag/sessionListOrganizationAction';
import { createSessionOrganizationMutationScopeForAccount, writeSessionOrganizationPin, writeSessionOrganizationAppearance, writeSessionOrganizationWorkspaceDisplay } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { scmReviewComparisonOfSource, scmReviewViewUnavailableReason } from '@/sync/domains/scm/diffSummary/selection';
import { settingsParse } from '@/sync/domains/settings/settings';
import { applyWorkspaceFileViewerPreferenceMutationV1 } from '@happier-dev/protocol/account/settings/workspaceFileViewerPreferencesV1';
import { ScopeActionInputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { isVoiceHistoryActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { createUiSessionConfigOptionAction } from './sessionConfigOptionAction';
import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createSettingsDeclarationAction, isBuiltInLocalSettingMutation, readSettingsDeclarationOperation } from './settingsDeclarationAction';
import { executeUiApprovalProfileChange, readApprovalProfileCatalog, readBoundApprovalProfile } from '@/sync/engine/settings/approvalProfileCatalog';
import { createAtmosphereSettingServices } from './atmosphereSettingServices';
import { createSettingsOwnerActionExecutor } from './settingsOwnerActionExecutor';
import { getAutomationSettings, updateAutomationSettings } from '@/sync/api/automations/apiAutomations';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { createAppShellAction } from './appShellAction';
import { executeDesktopAppWindowClientAction } from './desktopAppWindowActionDispatch';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';
import { createBugReportSubmitAction } from './bugReportSubmitAction';
import { executeAppUpdateAction } from '@/updates/appUpdateActionRuntime';
import { createUpdatesAction, readCurrentMachineUpdateItem } from '@/updates/updatesActionRuntime';
import { startMachineAgentItemUpdate } from '@/updates/machineUpdateRuns';
import { observeMachineAgentInstallJobCancellation, startAgentInstallJob } from '@/agents/machineAgents/installJobs/installJobStore';
import { executeExternalSessionBrowseAction } from './externalSessionBrowseAction';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import { createUiUsageActionPorts } from './usageActionDeps';
import { createUiPublicProfileActionPorts } from './publicProfileActionDeps';
import { createUiUsageSourceActionPort } from './usageSourceActionDeps';
import { createUiScmAction } from './scmActionDeps';
import { createUiFilesystemAction, resolveUiFilesystemTransferCustodyFailure } from './filesystemActionDeps';
import { createUiProjectDefinitionAction } from './projectDefinitionActionDeps';
import { createUiProjectAction } from './projectActionDeps';
import { resolveSettingsHost, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { executeCommandPaletteAction } from '@/components/appShell/commandPalette/commandPaletteActionRuntime';
import { executeFindAction } from '@/keyboard/findActionRuntime';
import { executePromptPickerOpenAction, executePromptPickerAction } from '@/components/sessions/agentInput/commandMenu/promptPickerActionRuntime';
import { executePromptHistoryAction } from '@/components/sessions/agentInput/commandMenu/promptHistoryActionRuntime';
import { executeSessionMessagePinsAction } from './sessionMessagePinsAction';
import { invokeNextPendingRequest } from '@/activity/source/pendingNavigationRuntime';
import { executeApiTokenAction, type ApiTokenActionTransport } from './apiTokenActionTransport';
import { createMachinePoolActionClient, MachinePoolActionError } from '@/sync/api/machines/machinePoolActions';
import { createMachinePresetActionClient, MachinePresetActionError } from '@/sync/api/machines/managedMachinePresets';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { executeManagedMachineNativeAction, isManagedMachineRetainedControlAction, prepareUiManagedPresetAcquire } from '@/sync/api/machines/managedMachineOrigination';
import { executeUiManagedProvisionerList, prepareUiManagedProvisionerAdmission } from './managedProvisionerAction';
import { prepareUiManagedMachineWake } from './managedMachineWakePreparation';
import { executeUiMachinePresetArchive } from './machinePresetArchive';
import { readManagedMachineReadForSnapshot } from '@/sync/ops/machines/machinePresetCollectionClient';
import type { ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { subscribeActionOperationByRequestId } from '@/sync/domains/actionOperations/subscribeActionOperationByRequestId';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createUiManagedMachineReferenceReader, createUiMachineDeploymentReferenceReader } from './managedMachineReferenceDeps';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { unwrapManagedMachineReadV1, ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1, type ManagedMachineActionIdV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createUiEphemeralRunnerAction } from './ephemeralRunnerAction';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { writeUiSessionStateField } from '@/sync/state/engine';
import { admitDeclaredSessionVoicePreferenceV1, readBuiltInSessionVoiceDeclarationV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createUiExecutionRunActionDeps } from './executionRunActionDeps';
import { createUiSessionDeleteAction } from './sessionDeleteAction';
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
    sessionSwitch,
    resumeSession,
} from '@/sync/ops/sessions';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { buildResumeCapabilityOptionsFromUiState, buildResumeSessionExtrasFromUiState } from '@/agents/registry/registryUiBehavior';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { applyPermissionModeSelectionEffect } from '@/sync/domains/permissions/permissionModeApply';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { loadSessionPermissionModes, loadSessionPermissionModeUpdatedAts, saveSessionPermissionModes,
  saveSessionPermissionModeUpdatedAts } from '@/sync/domains/state/sessionPersistence';
import { captureSessionDraftCurrentness, clearSessionDraftCurrentnessLocal, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { nowServerMs } from '@/sync/runtime/time';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readAgentScopedPluginSettingsSnapshot } from '@/agents/registry/agentScopedPluginSettings';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { getSessionRunnerRuntimeStatusSnapshotResult, restartSessionRunnerForProviderBindingChange, restartSessionRunnerOnCurrentRuntime } from '@/sync/ops/sessionRunnerRestart';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import {
  preflightWorkspaceDestinationReplacement,
  startSessionHandoff as startSessionHandoffOp,
} from '@/sync/ops/sessionHandoffs';
import { createWorkspaceSyncRelationshipOnController, observeWorkspaceSyncRelationshipCreationOnController } from '@/sync/ops/workspaceSyncRelationshipCreateRpc';
import { listWorkspaceSyncRelationshipsOnController } from '@/sync/ops/workspaceSyncRelationshipsListRpc';
import { createUiWorkspaceSyncReadActionDeps } from './workspaceSyncReadActionDeps';
import {
  disableWorkspaceSyncRelationship,
  enableWorkspaceSyncRelationship,
  flushWorkspaceSyncRelationship,
  terminatePersistedWorkspaceSyncRelationship,
} from '@/sync/ops/workspaceSync';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { createExecutionRunHostApprovalReplay } from './executionRunHostApproval';
import { createApprovalArtifactAccess } from './approvalReading';
import { importBrowserProfileLoginsInContext } from './browserProfileLoginsImport';
import {
  sendSessionMessageWithServerScope,
  projectServerScopedSessionSendMessageResult,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createUiSessionSpawnNewDirectoryApprovalPreflight, dispatchSessionSpawnNewWithManagerPreparation } from './sessionSpawnNewAction';
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
import { createUiSessionRead } from './sessionReadAction';
import { getSessionActivityForVoiceTool } from '@/voice/tools/actionImpl/sessionActivity';
import {
  getSessionRecentMessagesForVoiceTool,
  getSessionTranscriptForVoiceTool,
} from '@/voice/tools/actionImpl/sessionRecentMessages';
import { listRecentPathsForVoiceTool } from '@/voice/tools/actionImpl/pathsListRecent';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { listProjectsForActions } from './listProjects';
import { createUiProjectPagesList } from './projectPagesAction';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { createUiProjectSessionDefaultsActionDeps, createUiManagedSessionDefaultsContextLoader } from '@/sync/api/projects/projectSessionDefaultsActions';
import { createUiPrepareSessionSpawnNewInput } from './prepareSessionSpawnNewInput';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE } from '@/voice/agent/projectVoiceConfiguredAgentTarget';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@happier-dev/protocol/connect/resolveConnectedServicesLaunchAuthV1';
import { resolveSpawnConnectedServicesSelectionInContext, listSpawnConnectedServicesInContext } from './agentInventoryActionDeps';
import { createProjectSourceTeamMoveDeps } from '@/sync/api/projects/projectSourceTeamMove';
import { createUiDeploymentActionDeps, createUiDeploymentWorkspaceMachineReader, isDeploymentActionFailure, recoverUiDeploymentActionResult } from '@/sync/api/deployments/deploymentActions';
import { DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, isDeploymentPromoteActionIdV1, isDeploymentAccountMachineTransportActionIdV1, isDeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentActionInputSchemasV1, DeploymentEnvironmentGetResultV1Schema, DeploymentMoveToRepositoryInputV1Schema, resolveDeploymentMoveToRepositoryExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateInstantiateInputV1Schema, resolveDeploymentTemplateExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { canUsePrivateProjectAccountAction, createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { setProjectVisibilityV1 } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { updateProjectOrganizationV1 } from '@happier-dev/protocol/projects/projectOrganizationV1';
import {
  listPromptInvocationsForActions,
  resolvePromptInvocationForActions,
} from './resolvePromptInvocations';
import { listSpawnProfilesForActions } from './listSpawnProfiles';
import { readUiProfileCatalogSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import {
  listAgentConfigOptionsForActions,
  listAgentSessionModesForActions,
  listSpawnConnectedServicesForActions,
  resolveSessionSpawnAgentInventorySelectionForActions,
  resolveAgentInventoryProbeTarget,
} from './agentInventoryActionDeps';
import { probeAgentModelsForActions, type AgentInventoryProbeTarget } from './agentInventoryProbe';
import { listMachinesForVoiceTool } from '@/voice/tools/actionImpl/machinesList';
import { listServersForVoiceTool } from '@/voice/tools/actionImpl/serversList';
import { listReviewEnginesForVoiceTool } from '@/voice/tools/actionImpl/reviewEnginesList';
import { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } from '@/voice/tools/actionImpl/agentCatalogList';
import { createReviewCommentsHttpActionExecutor } from '@/sync/domains/reviews/comments/api';
import { createPluginPermissionGrantHttpActionExecutor } from '@/sync/domains/plugins/permissions/api';
import { createPluginWebhookEndpointHttpActionExecutor } from '@/sync/api/plugins/webhooks/endpointActions';
import { sessionFollowAction } from '@/sync/api/session/sessionFollowApi';
import { readSessionFollowRuleInputs, type SessionFollowReadInputs } from '@/sync/api/session/sessionFollowRulesApi';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';
import { sessionReadStateAction } from '@/sync/api/session/sessionReadStateAction';
import { executeSessionAttentionSetAction, setSessionAttentionStanding } from '@/sync/ops/sessionOrganization/setSessionAttentionStanding';
import { createSessionManagerAction } from '@/sync/api/session/sessionManagerAction';
import { createSessionBoardActionAdapter, prepareSessionBoardItemForUi } from '@/sync/api/session/sessionBoardActions';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { readNewWorkFeatureAdmission } from './newWorkFeatureAdmission';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { sync } from '@/sync/sync';
import { executeListReorderAction } from './listReorderAction';
import { executeTodoSessionLinkAction } from './todoSessionLinkAction';
import { executeInternalTaskHostAction } from './internalTaskAction';
import { createHomeDomainActionExecutorForScope } from '@/sync/api/home/homeDomainActions';
import { createUiPersonalSavedSecretActionExecute } from '@/sync/ops/settings/personalSavedSecretActionHost';
import { createSessionOrganizationResourceAction, isSessionOrganizationResourceAction } from '@/sync/ops/sessionOrganization/sessionOrganizationAction';
import { createUiTeamCredentialUsageExportAction } from '@/sync/ops/teams/teamCredentialUsageExportAction';
import { resolveSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createApprovalArtifact, writeApprovalRequestArtifact } from './approvalArtifactWriter';
import { publishAcpSessionModeOverrideToMetadata } from '@/sync/state/acpSessionModeOverridePublish';
import { createUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { admitSessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { installPromptRegistryItemInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { canRollbackConversation } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { completeSessionForkNavigation } from '@/sync/domains/sessionFork/completeSessionForkNavigation';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { createUiTriggerSessionResolver, createUiWorkflowAction } from './workflowActionDeps';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { getAutomationDefinition } from '@/sync/api/automations/apiAutomations';
import {
  WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema,
  SessionTriggerAddRequestV1Schema, SessionTriggerUpdateRequestV1Schema, SessionTriggerListResultV1Schema,
} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { createUiOccurrenceAction } from './occurrenceAction';
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
import { createUiActionExecutionOriginContextPreparer } from './prepareActionExecutionOriginContext';
import { executeAccountPluginDataEraseAction } from '@/sync/domains/plugins/settings/accountPluginDataEraseAction';
import { createPluginExecutionOriginActionDeps } from './pluginExecutionOriginActionDeps';
import { createUiPluginSettingsAdministrationAction } from './pluginSettingsAdministrationAction';
import { invokeScopeAction } from './scopeActionFamily';
import { invokeDiagnosticAction } from '@/components/settings/diagnosis/diagnosticsActionRuntime';
import { signOutEverywhere } from '@/sync/api/account/signOutEverywhere';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { MachineServiceControlResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { invalidateLocalServiceLauncherStores } from '@/sync/domains/local/services/launch/sharedStore';
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
  actionId: SessionBoardActionIdV1;
  mutationDispatched: boolean;
  retirementStatus: string;
  recoveryDetails: SessionBoardOutcomeUnknownDetailsV1 | null;
}>): SessionBoardActionFailureV1 {
  if (!input.mutationDispatched || !input.recoveryDetails) {
    return projectSessionBoardAdapterFailureV1({ code: input.retirementStatus }, 'forbidden', input.actionId);
  }
  return {
    ok: false,
    errorCode: 'outcome_unknown',
    error: 'outcome_unknown',
    details: input.recoveryDetails,
  };
}

  type OpenSessionOptions = Readonly<{ serverId?: string | null; query?: Readonly<Record<string, string>> }>;

function projectSessionModelTransitionFailure(transition: Extract<SessionModelTransitionResultV1, { ok: false }>) {
  return {
    ok: false as const,
    errorCode: transition.status,
    error: transition.status,
    details: transition,
  };
}

function projectSessionInteractionRpcResult(result: unknown): unknown {
  return result === undefined || result === null ? { ok: true } : result;
}

function projectSessionInteractionRpcFailure(error: unknown) {
  const errorCode = readRpcFailureCode(error);
  if (!errorCode) throw error;
  return { ok: false, errorCode, errorMessage: error instanceof Error ? error.message : errorCode };
}

export { resolveApprovalReplayRoute, type ApprovalReplayRoute } from './approvalReplayRoute';

export function isApprovalExecutionOriginCurrentForAccountContext(input: Readonly<{
  origin: Readonly<{
    serverId: string;
    serverIdentityId?: string;
    accountId?: string;
  }>;
  accountServerId: string;
  accountId: string;
  reportStale?: (reason: ApprovalStaleReason) => void;
}>): boolean {
  const stale = (reason: 'account_changed' | 'home_changed') => { input.reportStale?.(reason); return false; };
  if (input.origin.accountId && input.origin.accountId !== input.accountId) return stale('account_changed');
  const serverIdentityId = input.origin.serverIdentityId?.trim() ?? '';
  if (serverIdentityId) {
    const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
    return resolution.kind === 'resolved'
      && resolution.profile.serverIdentityId?.trim() === serverIdentityId
      && areServerProfileIdentifiersEquivalent(resolution.profile.id, input.accountServerId) || stale('home_changed');
  }
  return areServerProfileIdentifiersEquivalent(input.origin.serverId, input.accountServerId) || stale('home_changed');
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
  return readMachineActionRpcResult(await machineRpcWithServerScope({
    serverId: input.executionTarget.serverId,
    machineId: input.executionTarget.machineId,
    method: RPC_METHODS.APPROVAL_REQUEST_DECIDE,
    // The approved Action owns its execution lifetime after bounded setup.
    operationTimeoutMs: null,
    payload: {
      artifactId: input.artifactId,
      decision: input.decision,
      ...(input.executionTarget.serverIdentityId
        ? { serverIdentityId: input.executionTarget.serverIdentityId }
        : {}),
      ...(input.executionTarget.originServerId
        ? { originServerId: input.executionTarget.originServerId }
        : {}),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }));
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
  return readMachineActionRpcResult(await machineRpcWithServerScope<ActionExecuteResult, Readonly<{ artifactId: string }>>({
    serverId: input.executionTarget.serverId,
    machineId: input.executionTarget.machineId,
    method: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
    operationTimeoutMs: null,
    payload: { artifactId: input.artifactId },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }));
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

export type UiSessionTargetPreview = SessionTargetPreviewV1;
type UiProtocolActionExecutor = Pick<ReturnType<typeof createActionExecutor>, 'prepare' | 'execute' | 'replayApprovedApprovalRequest' | 'executeAdmittedClientAction'> & Readonly<{
  executeConfirmed: ReturnType<typeof createActionExecutor>['execute'];
  /** Read-only selector preparation; creates neither an effect nor an approval. */
  previewSessionTargets: (target: SessionTargetSelectorV1, context?: ActionExecutorContext) => Promise<UiSessionTargetPreview>;
}>;

type SessionArchiveInvocation = {
  readonly inherited?: SessionArchiveOperation;
  readonly owned: SessionArchiveOperation[];
  readonly includeReportStops: boolean;
  readonly reportLead?: SessionAddress;
};

function createSessionArchiveInvocation(
  actionId: ActionId | undefined,
  input: unknown,
  inherited: SessionArchiveOperation | undefined,
  serverId: string,
  defaultSessionId?: string | null,
): SessionArchiveInvocation | undefined {
  if (actionId !== 'session.archive') return undefined;
  // Archive's canonical input names one lead; its catalog has no selector fanout.
  // Contextual defaults and an enclosing UI flow already carry the same exact target.
  const parsed = SessionArchiveActionInputV1Schema.safeParse(input);
  const sessionId = parsed.success ? parsed.data.sessionId : inherited?.sessionId ?? defaultSessionId;
  return { inherited, owned: [],
    includeReportStops: input !== null && typeof input === 'object' && 'alsoArchiveReports' in input && input.alsoArchiveReports === true,
    reportLead: sessionId ? resolveSessionArchiveAddress({ serverId, sessionId }) ?? undefined : undefined };
}

function finishSessionArchiveInvocation(invocation: SessionArchiveInvocation | undefined): void {
  for (const operation of invocation?.owned ?? []) storage.getState().finishSessionArchive(operation);
}

  function buildDefaultActionExecutor(opts?: Readonly<{
  /** Mounted draft destination; Action policy and draft settlement remain canonical. */
  sessionAuthoringPresentation?: import('@/components/sessions/new/newSessionSeedNavigation').SessionAuthoringPresentation;
  /** One captured Voice editor intent; never serialized into Action input or approval. */
  voiceSettingsEdit?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['voiceSettingsEdit'];
  /** Mounted History delivery; the consumer retains Account binding and delete-wins ownership. */
  voiceHistory?: import('@/voice/history/voiceHistoryActions').VoiceHistoryActionPorts;
  /** Originating message presentation, private to this speech invocation. */
  voiceSpeechSource?: import('@/voice/backends/tts/localVoiceTtsProviderControllers').VoiceReadAloudSource;
  /** Mounted model-pack progress presentation; Action policy owns admission. */
  voiceModelPackPresentation?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['voiceModelPackPresentation'];
  /** Captured profile candidate; Settings admission remains in the shared executor. */
  publicProfileAtmosphereDraft?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['publicProfileAtmosphereDraft'];
  /** One mounted Project intent; the Settings owner applies it to the fresh row after admission. */
  projectAtmosphereEdit?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['projectAtmosphereEdit'];
  /** Fresh invocation's exact Session admission objects; never serialized or shared by cached executors. */
  archiveInvocation?: SessionArchiveInvocation;
  /** Private presentation leaf for this invocation; never enters Action custody. */
  openRoute?: (route: string) => void | Promise<void>;
  /** Mounted template editor presentation; Action admission remains executor-owned. */
  openBotTemplate?: (input: import('@happier-dev/protocol/bots/templates/botTemplateActionsV1').BotTemplateOpenInputV1) => void | Promise<void>;
  /** Parsed link release retained by this mounted recipient invocation. */
  /** Mounted output host presentation; admission and operation lookup remain Action-owned. */
  actionOperationOpenOutput?: (address: Readonly<{ serverId: string; machineId: string; operationId: string; operation: ActionOperationSnapshotV1 }>) => void | Promise<void>;
  /** Surface-local custody notification, fired only by the admitted Provider RPC transport. */
  onProviderRpcDispatched?: () => void;
  /** Surface-local notification fired by the admitted SCM terminal just before its Machine RPC, after any in-place confirmation. */
  onScmDispatched?: () => void;
  /** Private native presentation; only the canonical Action policy decides whether to ask. */
  presentUserActionConfirmation?: NonNullable<ActionExecutorDeps['presentUserActionConfirmation']>;
  /** An explicitly admitted API-token transport; Home owns grants and approvals. */
  apiTokenAction?: ApiTokenActionTransport;
  /** Private Machine reverse-RPC continuation: admission/approval happened in the daemon. */
  admittedClientActionId?: ActionId;
  /** Host-owned Voice Run admission; never read from Action input or remote context. */
  readAdmittedVoiceInvocation?: () => import('@happier-dev/protocol/sessions/creation/externalActionRequesterInvocationBaseV1').ExternalActionRequesterInvocationBaseV1 | undefined;
  /** The daemon still awaiting that continuation; its Session caller's Workflow children return there. */
  admittedClientActionParent?: AdmittedClientActionParent;
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
  openSession?: (sessionId: string, options?: OpenSessionOptions) => void | Promise<void>;
  runtimeActions?: CreateDefaultRuntimeActionExecutorInput;
  /** Native/process task transport for local client Actions; admission stays with this executor. */
  homeRuntimeRunner?: SystemTaskRunner;
  /** Mounted presentation only; the existing blocking executor retains input and decision custody. */
  onBlockingApprovalPending?: (input: Readonly<{ artifactId: string; scope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope;
    signal?: AbortSignal }>) => void;
  /** Exact mounted invocation whose intent must remain live through shared approval. */
  hostActionApprovalLifetime?: Readonly<{ actionId: ActionId; signal: AbortSignal; surface: 'ui' }>;
  /** Exact mounted view command target; policy and raw terminal remain canonical. */
  scopeActionOwner?: import('./scopeActionFamily').MountedScopeActionOwner;
  /** Original mounted Pending editor; retained with this executor, never serialized for approval replay. */
  pendingMessageEditIsCurrent?: () => boolean;
  /** Exact local follow intent retained by this factory across blocking approval. */
  isExternalSessionFollowIntentCurrent?: () => boolean;
  listContributedActionDefinitions?: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>;
  readContributedActionSchemas?: NonNullable<ActionExecutorDeps['readContributedActionSchemas']>;
  /** Optional surface-local policy composed with the canonical Action settings policy. */
  isActionEnabled?: NonNullable<ActionExecutorDeps['isActionEnabled']>;
  /** Mounted device-setting lifetime guard, evaluated at the admitted persistence boundary. */
  beforeLocalSettingCommit?: () => void;
  /** Optional delivery leaf used by a surface that needs specialized ingress semantics. */
  sessionSendMessage?: NonNullable<ActionExecutorDeps['sessionSendMessage']>;
  /** Captured host constraint on the resolved recipient, evaluated once before delivery. */
  admitSessionMessageTarget?: (target: Pick<Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0],
    'sessionId' | 'serverId'>) => ActionExecuteFailure | null;
  /** Host-only Retry after a capture was staged and Send settled unsuccessfully. */
  screenCaptureSendDraftOnly?: boolean;
  /** Native-verified Capture window press; ordinary UI and automation never supply it. */
  screenCaptureWindowPress?: boolean;
  /** Final discard effect supplied by main; the Capture UI already resolved its shared Undo hold. */
  screenCaptureDiscard?: import('./screenCaptureActions').ScreenCaptureNativePort['discard'];
  /** Exact captured host Composer; never Action input, plugin metadata, or serialized authority. */
  sessionMessageComposerSubmission?: Readonly<{
    sourceComposerRef: import('@happier-dev/protocol/plugins/ui/composerRef').ComposerRefV1;
    isCurrent: () => boolean;
    legacyAttachments?: Readonly<{
      drafts: readonly import('@/components/sessions/attachments/attachmentDraftModel').AttachmentDraft[];
      config: import('@/sync/domains/transfers/ops/uploadSessionAttachment').AttachmentsUploadConfig;
      originalMessage: string;
      onUploadedDraftCheckpoint: (checkpoint: import('@/components/sessions/attachments/uploadAttachmentDraftsToSession').AttachmentTargetUploadedDraftCheckpoint) => Promise<void> | void;
      onUploadedDraftCheckpointStale: (attempt: Readonly<Pick<import('@/components/sessions/attachments/uploadAttachmentDraftsToSession').AttachmentTargetUploadedDraftCheckpoint,
        'target' | 'executionTarget' | 'messageLocalId'>> & Readonly<{
          handles: readonly import('@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1').SessionAttachmentHandleV1[];
        }>) => void;
    }>;
  }>;
  /** Captured local file sources for this invocation; approval stores descriptors only. */
  discussionAttachmentSources?: readonly import('@/sync/domains/attachments/prepareAttachmentPayloads').PreparedAttachmentSource[];
  /** Selected-Machine hook delivery; Action admission and approval stay in this executor. */
  pluginSessionHookManagementAction?: NonNullable<ActionExecutorDeps['pluginSessionHookManagementAction']>;
  /** Mounted host resolver carrying an explicitly complete selected-Home corpus. */
  resolveSessionReference?: NonNullable<ActionExecutorDeps['resolveSessionReference']>;
  /** Current external Agent declaration supplied by a rendered lifecycle control. */
  currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
  /** Exact mounted client delivery; Action admission remains in this executor. */
  currentSessionPresentationApply?: Readonly<{
    serverId: string;
    accountId: string;
    sessionId: string;
    isCurrent: () => boolean;
    apply: (args: Parameters<NonNullable<ActionExecutorDeps['currentSessionPresentationApply']>>[0])
      => Promise<CurrentSessionPresentationActionResultV1 | ActionExecuteFailure>;
  }>;
  /**
   * The Session-access family port, supplied by a surface that already knows the
   * exact Account scope, availability and staleness lifetime the request belongs
   * to. Those are per-mount facts the shared executor cannot resolve, so the
   * surface owns reachability while the executor keeps admission and validation.
   */
  sessionAccessAction?: NonNullable<ActionExecutorDeps['sessionAccessAction']>;
  /** Captured SCM transport; Action schemas, eligibility and approval remain host-owned. */
  scmActionExecute?: NonNullable<ActionExecutorDeps['scmActionExecute']>;
  /** One mounted filesystem reader/destination; this executor still owns policy and approval. */
  filesystemActionDelivery?: import('./filesystemActionDeps').UiFilesystemActionDelivery;
  /** Mounted target and credential delivery remain private to the native host. */
  npmRegistryProfileDelivery?: import('./npmRegistryProfileActionDeps').UiNpmRegistryProfileDelivery;
  /** Mounted QR lifecycle remains private while issuance uses ordinary Action admission. */
  homePairingDelivery?: import('./machineConnectionActionDeps').UiHomePairingDelivery;
  /** Original mounted Account administration intent retained by the incumbent approval waiter. */
  pluginAccountAdministrationIsCurrent?: () => boolean;
  /** Trusted raw projection already owned by the mounted administration surface. */
  pluginAccountAdministrationProjection?: () => import('@happier-dev/protocol/daemon/contributionRegistryProjection').PluginProjectionV2 | null;
  /** Exact mounted byte source; the captured library Account remains the write authority. */
  foundSkillSource?: Readonly<{
    target: import('@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1').MachineAdministrationTargetV1;
    isCurrent: () => boolean;
  }>;
  machineAccessAction?: NonNullable<ActionExecutorDeps['machineAccessAction']>;
  machineWorkSummaryGet?: NonNullable<ActionExecutorDeps['machineWorkSummaryGet']>;
  machineVitalsAction?: NonNullable<ActionExecutorDeps['machineVitalsAction']>;
  machineStorageAction?: NonNullable<ActionExecutorDeps['machineStorageAction']>;
  machineGuardAction?: NonNullable<ActionExecutorDeps['machineGuardAction']>;
  machineScheduledAction?: NonNullable<ActionExecutorDeps['machineScheduledAction']>;
  machineProcessesAction?: NonNullable<ActionExecutorDeps['machineProcessesAction']>;
  machineServiceAction?: NonNullable<ActionExecutorDeps['machineServiceAction']>;
  machineServiceControl?: NonNullable<ActionExecutorDeps['machineServiceControl']>;
  machineServiceLogsRead?: NonNullable<ActionExecutorDeps['machineServiceLogsRead']>;
  machineResourcesPolicyAction?: NonNullable<ActionExecutorDeps['machineResourcesPolicyAction']>;
  machineRolesAction?: NonNullable<ActionExecutorDeps['machineRolesAction']>;
  machineIsolationAction?: NonNullable<ActionExecutorDeps['machineIsolationAction']>;
  machineAdminAccessAction?: NonNullable<ActionExecutorDeps['machineAdminAccessAction']>;
  machineAgentIsolationAction?: NonNullable<ActionExecutorDeps['machineAgentIsolationAction']>;
  machineReboot?: NonNullable<ActionExecutorDeps['machineReboot']>;
  usageSourceDismiss?: Parameters<typeof createUiUsageSourceActionPort>[1];
  /** A mounted recap preview may provide the same client rasterization boundary. */
  usageRecapRender?: Parameters<typeof createUiUsageActionPorts>[1];
  /** Existing Resource acquisition; the Action still owns input, policy and approval. */
  usageQueryRead?: import('@happier-dev/protocol/actions/executor/usageActions').UsageActionPorts['query'];
  connectedServiceQuotaReadOptions?: Parameters<typeof createUiConnectedServiceAction>[1];
  projectWorkerAction?: NonNullable<ActionExecutorDeps['projectWorkerAction']>;
  /** Local keyholding-host delivery; never enters Action input, approval or result. */
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  consumeArtifactSignedInLinkSecret?: (lookupId: string) => Promise<string | null>;
  onArtifactSignedInLinkOpened?: (opened: ArtifactSignedInLinkOpenedV1) => void | Promise<void>;
  /** Optional Session human-discussion family port bound by a mounted surface. */
  discussionAction?: NonNullable<ActionExecutorDeps['discussionAction']>;
  /** Exact mounted canvas for local pane interactions; external callers use the focused publication. */
  /**
   * The Home family port, bound by the caller to the exact Home and Account.
   * Without it, the shared executor rejects Home and Teams actions as unsupported.
   */
  homeDomainAction?: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  teamMembershipHistoryAction?: NonNullable<ActionExecutorDeps['teamMembershipHistoryAction']>;
  savedSecretRevealAction?: NonNullable<ActionExecutorDeps['savedSecretRevealAction']>;
  /** Subordinate target-bound transport for a confirmed workspace conflict Action. */
  workspaceSyncConflictResolve?: NonNullable<ActionExecutorDeps['workspaceSyncConflictResolve']>;
  workflowAction?: NonNullable<ActionExecutorDeps['workflowAction']>;
  /** A mounted WorkBoard binds current UI membership and its existing Account save queue. */
  workBoardArtifacts?: NonNullable<ActionExecutorDeps['workBoardArtifacts']>;
  /** Host-page defaults remain outside Action input and personal persisted copies. */
  resolveWidgetAreaPresets?: Parameters<typeof createWidgetAreaActionDepsV1>[1];
  widgetAreaIsCurrent?: () => boolean;
  }>, accountContext?: LazyActionAccountContext & { settings: Awaited<ReturnType<LazyActionAccountContext['readSettings']>> }, followReadInputs?: SessionFollowReadInputs): UiProtocolActionExecutor & Readonly<{
    executeNativeManagedAction(actionId: ManagedMachineActionIdV1, input: unknown, context?: ActionExecutorContext, confirmInFlow?: boolean,
      retainedMachine?: ManagedMachineActionOutputV1<'machines.managed.get'>): Promise<ActionExecuteResult>;
    readWidgetMovementAdmission(ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, context: ActionExecutorContext): ReturnType<typeof readWidgetEntityMovementAdmission>;
    readWidgetInputDescriptor(request: Parameters<NonNullable<ReturnType<typeof createWidgetInputActionDepsV1>['readWidgetInputDescriptor']>>[0]): ReturnType<NonNullable<ReturnType<typeof createWidgetInputActionDepsV1>['readWidgetInputDescriptor']>>;
  }> {
  const claimSessionArchive = (sessionId: string, serverId: string | null | undefined) => {
    const home = serverId ?? accountContext?.serverId;
    if (!home) return null;
    const address = resolveSessionArchiveAddress({ serverId: home, sessionId });
    if (!address) return null;
    const state = storage.getState();
    const invocation = opts?.archiveInvocation;
    if (invocation?.inherited) {
      // Account retirement may remove the captured object and admit a successor.
      if (!isSessionArchiveOperationCurrent(state, invocation.inherited)) return null;
      if (isSessionArchiveOperationCurrent(state, invocation.inherited, address)) return invocation.inherited;
    }
    const retained = invocation?.owned.find(operation => {
      const captured = resolveSessionArchiveAddress(operation);
      return captured?.serverId === address.serverId && captured.sessionId === address.sessionId;
    });
    if (retained) return isSessionArchiveOperationCurrent(state, retained, address) ? retained : null;
    const operation = state.beginSessionArchive(address);
    if (operation) invocation?.owned.push(operation);
    return operation;
  };
  const finishOwnedSessionArchive = (operation: SessionArchiveOperation) => {
    const invocation = opts?.archiveInvocation;
    const owned = invocation?.owned;
    const index = owned?.indexOf(operation) ?? -1;
    // The enclosing UI flow, rather than this Action, owns an inherited lead.
    if (owned && index < 0) return;
    if (invocation && (!invocation.reportLead
      || isSessionArchiveOperationCurrent(storage.getState(), operation, invocation.reportLead))) return;
    storage.getState().finishSessionArchive(operation);
    if (owned) owned.splice(index, 1);
  };
  const isSettingsOwnerCurrent = () => accountContext
    ? accountContext.accountLifetime.isCurrent() : getActiveServerAccountScope() === null;
  // Signal-free UI/tool invocations belong to the captured Account; mounted
  // surfaces may retire their own wait earlier. The effect owner retains receipts.
  const withAccountLifetime = <T>(signal: AbortSignal | undefined, run: (signal?: AbortSignal) => Promise<T>): Promise<T> =>
    withActionAccountRequestSignal(accountContext, signal, run);
  // These leaves also serve ports whose protocol inputs do not carry a signal.
  // Their wait still belongs to the captured Action invocation and Account.
  const actionMachineRpc: typeof machineRpcWithServerScope = <R, A>(params: Parameters<typeof machineRpcWithServerScope<R, A>>[0]) =>
    withAccountLifetime(params.signal ?? accountContext?.invocationSignal,
      async signal => readMachineActionRpcResult(await machineRpcWithServerScope<R, A>({ ...params, signal })));
  const actionSessionRpc: typeof sessionRpcWithServerScope = <R, A>(params: Parameters<typeof sessionRpcWithServerScope<R, A>>[0]) =>
    withAccountLifetime(params.signal ?? accountContext?.invocationSignal,
      signal => sessionRpcWithServerScope<R, A>({ ...params, signal }));
  const usageLimitRecoveryOptions = (sessionId: string, serverId: string | null | undefined, signal?: AbortSignal) => {
    const session = storage.getState().sessions[sessionId];
    const throttle = session && (!serverId || areServerProfileIdentifiersEquivalent(session.serverId, serverId))
      ? session.lastRuntimeIssue?.temporaryThrottle : undefined;
    return { serverId, signal, machineOnly: throttle?.v === 1 && throttle.recoverability === 'retry',
      refreshMachineTargets: () => sync.refreshMachinesThrottled({ staleMs: 0, force: true }) };
  };
  const runUsageLimitRecovery = (sessionId: string, serverId: string | null | undefined,
    operation: (options: ReturnType<typeof usageLimitRecoveryOptions>) => Promise<SessionUsageLimitRecoveryOperationResult>) =>
    withAccountLifetime(accountContext?.invocationSignal, async signal => {
      const result = await operation(usageLimitRecoveryOptions(sessionId, serverId, signal));
      // The shared Action failure envelope retains the typed repair/status facts as details.
      return result.ok ? result : { ...result, details: result };
    });
  const promptLibraryStore = accountContext ? createUiPromptLibraryArtifactStore(accountContext.workflowArtifacts, accountContext) : null;
  const withPromptLibraryStore = <T>(run: (store: PromptLibraryArtifactStore) => Promise<T>, signal?: AbortSignal): Promise<T> =>
    promptLibraryStore ? run(promptLibraryStore) : withUiPromptLibraryArtifactStore(run, { signal });
  const runtimeActionExecute = createDefaultRuntimeActionExecutor({ ...opts?.runtimeActions,
    localServices: { ...opts?.runtimeActions?.localServices,
      ...(accountContext ? { catalogBinding: { lifetime: accountContext.accountLifetime,
        credentialKey: resolveAuthCredentialsScopeKey(accountContext.credentials) } } : {}),
    },
  }, accountContext?.accountLifetime, async (args) => {
    if ((isComputerRuntimeActionId(args.actionId) || Object.hasOwn(LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION, args.actionId)
      || resolveLocalServiceDomainActionRpcBinding(args.actionId)) && accountContext) {
      return await createUiAccountAction({ account: accountContext })({ ...args,
        context: { ...args.context, actionCaller: args.context.actionCaller ?? { kind: 'host' } } });
    }
    const target = args.context.externalActionTarget;
    if (!accountContext || target?.kind !== 'machine' || !target.machineId.trim()) return { ok: false, errorCode: 'runtime_action_disabled', error: 'browser_automation_unavailable' };
    const result = await executeOriginalAccountMachineAction({ account: accountContext, actionId: args.actionId,
      requestId: args.context.actionRequestId ?? randomUUID(), machineId: target.machineId, machineTarget: target, input: args.input,
      actionCaller: args.context.actionCaller,
      authority: args.context.authority, signal: args.context.signal });
    return result.ok ? result.result : result;
  });
  const readAdmittedActionId = (actionId: string, input: unknown) =>
    actionId === 'approval.request.create' && input !== null && typeof input === 'object'
      && 'actionId' in input && typeof input.actionId === 'string' ? input.actionId : actionId;
  // Public selections are forwarded unchanged to the sole receiving admission owner.
  // Prepared private birth continuations keep their existing host-owned path.
  const forwardSessionSpawnNew = async (input: SessionSpawnNewActionInputV2, context: ActionExecutorContext) => {
    const { actionCaller: _actionCaller, actionRequestId, signal } = context;
    const { placementOrigin, ...exactInput } = admitSessionSpawnNewActionInputV2(input);
    const scopedController = input.sessionPlacement?.kind === 'preset' && context.sessionCreationDefaults?.managedPresetAcquisition?.controller
      && context.sessionCreationDefaults.managedPresetControllerAccess;
    const serverId = resolveServerProfileScopeIdForIdentifier(input.executionTarget.serverId);
    const machine = storage.getState().machineListByServerId[serverId]
      ?.find((candidate) => candidate.id === input.executionTarget.machineId);
    if (!scopedController && input.authoringOrigin && !supportsMachineOperationProtocolCapabilityV1(
      machine?.operationProtocolCapabilities, 'sessionSpawnAuthoringOrigin',
    )) return { type: 'error' as const, code: 'update_required' as const, retryable: false as const,
      details: { kind: 'update_required' as const, operation: 'session.spawn_new' as const,
        component: 'daemon' as const, reason: 'session_spawn_authoring_origin_update_required' as const } };
    if (
      !scopedController && input.secretReferenceOverlay
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
    const supportsOrigin = Boolean(scopedController) || (!machine?.revokedAt && !machine?.replacedByMachineId
      && supportsMachineOperationProtocolCapabilityV1(machine?.operationProtocolCapabilities, 'sessionSpawnPlacementOrigin'));
    if (machine?.isShared && !accountContext) return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
    if (accountContext) {
      accountContext.assertCurrent();
      if (accountContext.serverId !== serverId) return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
      if (!scopedController && !machineAccessAction) return { type: 'error' as const, code: 'target_unavailable' as const, retryable: true as const };
      const disposition = scopedController ? null : await readRequesterSessionSpawnDisposition({ accountId: accountContext.accountId,
        machineId: input.executionTarget.machineId, isShared: machine?.isShared,
        readAccess: () => machineAccessAction!({ actionId: 'machines.access.grants.list',
          input: { serverId, machineId: input.executionTarget.machineId }, context: context ?? {}, ...(signal ? { signal } : {}) }) });
      accountContext.assertCurrent();
      if (disposition?.kind === 'refused') return disposition.result;
      const managedContinuation = context?.invocationServices?.managedContinuation;
      // Home admission owns runtime demand even for an owned guest absent from
      // the warm inventory. It prepares managed wake before dispatching spawn.
      if (accountContext.serverIdentityId || disposition?.kind === 'requester' || managedContinuation || context.surface === 'plugin' || context.surface === 'voice'
        || context.presentUserConfirmation || readHostReviewedParentV1(context)) {
        const needsInvocation = Boolean(context.sessionCreationDefaults) || context.surface !== 'plugin'
          && (context.surface !== 'ui' || readHostReviewedParentV1(context)
            || context.presentUserConfirmation?.inputDigest || (context.presentUserApproval && isSessionSpawnNewActionIdV1(context.presentUserApproval.actionId)));
        const invocation = needsInvocation ? projectExternalActionRequesterInvocationV1({ actionId: 'session.spawn_new',
          context: { ...context, actionCaller: context.actionCaller ?? { kind: 'host' } }, account: accountContext,
          target: { kind: 'machine', machineId: input.executionTarget.machineId },
        }) : null;
        if (needsInvocation && !invocation) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        const execution = await executeOriginalAccountMachineAction({ account: accountContext,
          actionId: 'session.spawn_new', requestId: actionRequestId ?? context?.actionRequestId ?? randomUUID(),
          machineId: input.executionTarget.machineId,
          ...(context.externalActionTarget?.kind === 'machine' ? { machineTarget: context.externalActionTarget } : {}),
          // Requester HTTP and direct Machine RPC consume the same spawn owner's budget.
          timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
          input: projectSessionSpawnNewActionInputV2(placementOrigin && supportsOrigin ? { ...exactInput, placementOrigin } : exactInput),
          ...(invocation ? { invocation } : {}),
          ...(managedContinuation ? { managedContinuation } : {}),
          actionCaller: _actionCaller, authority: context?.authority, ...(signal ? { signal } : {}) });
        accountContext.assertResultCurrent(getActionSpec('session.spawn_new').sideEffectClass);
        if (!execution.ok && isActionOutcomeUnknownErrorCodeV1(execution.errorCode)) {
          return { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'unknown' as const };
        }
        if (!execution.ok) {
          await refreshMachineAgentsAfterLaunchRefusal({
            accountLifetime: accountContext.accountLifetime, machineId: input.executionTarget.machineId,
            target: input.agentTarget, failureCode: execution.errorCode, signal,
          });
          return execution;
        }
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success) return approval.data;
        const result = readSessionSpawnNewActionResultV1(SessionSpawnNewActionResultV1Schema.parse(execution.result));
        if (result.type === 'error') await refreshMachineAgentsAfterLaunchRefusal({
          accountLifetime: accountContext.accountLifetime, machineId: input.executionTarget.machineId,
          target: input.agentTarget, failureCode: 'launchError' in result ? result.launchError?.code ?? result.code : result.code, signal,
        });
        return result;
      }
    }
    accountContext?.assertCurrent();
    const rpcInput = SessionSpawnNewActionInputV2Schema.parse(materializeSessionCreationActionInput(
      'session.spawn_new', projectSessionSpawnNewActionInputV2(placementOrigin && supportsOrigin ? { ...exactInput, placementOrigin } : exactInput), context,
    ));
    const result = await dispatchSessionSpawnNewWithManagerPreparation({
      payload: admitSessionSpawnNewActionInputV2(rpcInput),
      signal,
    });
    if (accountContext) await refreshMachineAgentsAfterLaunchRefusal({
      accountLifetime: accountContext.accountLifetime, machineId: input.executionTarget.machineId,
      target: input.agentTarget, signal,
      failureCode: 'ok' in result ? result.errorCode : result.type === 'error'
        ? 'launchError' in result ? result.launchError?.code ?? result.code : result.code : undefined,
    });
    return result;
  };
  const isMachineOwnedAdmissionAction = (actionId: string, input: unknown) => {
    if (isWorkspaceSyncRelationshipWriteActionId(actionId)) return true;
    const parsed = ActionIdSchema.safeParse(readAdmittedActionId(actionId, input));
    if (!parsed.success) return false;
    if (isSessionSpawnNewActionIdV1(parsed.data)) return true;
    if (isDeploymentAccountMachineTransportActionIdV1(parsed.data)) return true;
    const spec = getActionSpec(parsed.data);
    return spec.executionPlacement === 'machine' && spec.originalExecution?.daemonIngressSurfaces?.includes('ui') === true;
  };
  const executeMachineOwnedAction = async (args: Readonly<{
    actionId: string; input: unknown; context: ActionExecutorContext; confirmInFlow?: boolean; reviewDigest?: string;
  }>) => {
    if (isDeploymentAccountMachineTransportActionIdV1(args.actionId)) {
      if (!deploymentActionDeps?.deploymentAction) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      const input = DeploymentActionInputSchemasV1[args.actionId].safeParse(args.input);
      if (!input.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const context = args.confirmInFlow
        ? bindPresentUserActionConfirmation(args.actionId, input.data, args.context, args.reviewDigest) : args.context;
      // The existing transport selects the controller and preserves creation/read operands.
      // Its receiver compares the confirmed review with its own prepared children.
      return await deploymentActionDeps.deploymentAction(args.actionId, input.data, context);
    }
    if (args.actionId === WORKFLOW_RUN_START_ACTION_ID_V1) {
      if (!workflowAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      // The Workflow relay owns placement and uncertain admission outcomes.
      // Return its carried review to the Machine confirmation path, without
      // admitting the same request against a second, app-local review digest.
      const context = args.confirmInFlow
        ? bindPresentUserActionConfirmation(args.actionId, args.input, args.context, args.reviewDigest) : args.context;
      return workflowAction({ actionId: args.actionId, input: WorkflowRunStartRequestV1Schema.parse(args.input), context,
        ...(context.signal ? { signal: context.signal } : {}) });
    }
    // Mounted surfaces supply this target through the admitted controller, not
    // Action input, presence ranking, or the UI's default Machine selection.
    const pluginInput = args.actionId === 'approval.request.create' && args.input !== null && typeof args.input === 'object'
      && 'actionArgs' in args.input ? args.input.actionArgs : args.input;
    const machineOwnedAction = isMachineOwnedAdmissionAction(args.actionId, args.input);
    const relationshipWrite = isWorkspaceSyncRelationshipWriteActionId(args.actionId);
    let workspaceSourceMachineId: string | undefined;
    if (relationshipWrite) {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const input = WorkspaceSyncRelationshipWriteActionInputV1Schema.parse(pluginInput);
      const rows = await createUiProjectAccountRowsClient(accountContext).read(args.context.signal);
      const source = rows.status === 'ready' && rows.coverage === 'complete'
        ? resolveWorkspaceRefById(rows.workspaceRefs, input.sourceWorkspaceRefId, accountContext.serverIdentityId ?? accountContext.serverId)
        : null;
      if (source?.kind !== 'resolved') return { ok: false, errorCode: 'workspace_ref_not_ready', error: 'workspace_ref_not_ready' };
      workspaceSourceMachineId = source.ref.machineId;
      const target = args.context.externalActionTarget;
      if (target && (target.kind !== 'machine' || target.machineId !== workspaceSourceMachineId)) {
        return { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' };
      }
    }
    const originalSpec = ActionIdSchema.safeParse(args.actionId);
    const demand = originalSpec.success ? getActionSpec(originalSpec.data).machineRuntimeDemandForInput?.(pluginInput, args.context) : null;
    const serviceRequest = readLocalServiceControlActionRequest(readAdmittedActionId(args.actionId, args.input), pluginInput);
    let requestedMachineId = workspaceSourceMachineId ?? serviceRequest?.target.machineId ?? (demand?.target.kind === 'machine' ? demand.target.machineId : pluginInput !== null && typeof pluginInput === 'object'
      && 'machineId' in pluginInput && typeof pluginInput.machineId === 'string'
      ? pluginInput.machineId : undefined);
    if (readAdmittedActionId(args.actionId, args.input) === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
      const input = DeploymentActionInputSchemasV1[DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1].safeParse(pluginInput);
      if (!input.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!deploymentActionDeps) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      const selected = await deploymentActionDeps.readEnvironmentCreateController(input.data, args.context);
      if (!selected.ok) return selected;
      requestedMachineId = selected.machineId;
    }
    if (readAdmittedActionId(args.actionId, args.input) === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
      const input = DeploymentTemplateInstantiateInputV1Schema.safeParse(pluginInput);
      if (!input.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const readEnvironment = deploymentActionDeps?.deploymentAction;
      if (!readEnvironment) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      const selected = await resolveDeploymentTemplateExecutionMachineIdV1(input.data, async selector => {
        const loaded = await readEnvironment('deployments.environments.get', selector, args.context);
        return isDeploymentActionFailure(loaded) ? loaded : DeploymentEnvironmentGetResultV1Schema.parse(loaded);
      }, async ({ workspace }) => accountContext ? createUiDeploymentWorkspaceMachineReader(accountContext, args.context)(workspace)
        : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
      if (!selected.ok) return selected;
      requestedMachineId = selected.machineId;
    }
    if (readAdmittedActionId(args.actionId, args.input) === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1) {
      const input = DeploymentMoveToRepositoryInputV1Schema.safeParse(pluginInput);
      if (!input.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const selected = await resolveDeploymentMoveToRepositoryExecutionMachineIdV1(input.data,
        createUiDeploymentWorkspaceMachineReader(accountContext, args.context));
      if (!selected.ok) return selected;
      requestedMachineId = selected.machineId;
    }
    const environmentControllerAction = readAdmittedActionId(args.actionId, args.input);
    if (environmentControllerAction === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
      || environmentControllerAction === DEPLOYMENT_DEPLOY_ACTION_ID_V1 || isDeploymentPromoteActionIdV1(environmentControllerAction)
      || isDeploymentAccountMachineTransportActionIdV1(environmentControllerAction)
        && environmentControllerAction !== DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && !requestedMachineId) {
      const input = DeploymentActionInputSchemasV1[environmentControllerAction].safeParse(pluginInput);
      if (!input.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!deploymentActionDeps) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      const selected = await deploymentActionDeps.readEnvironmentController(input.data, args.context);
      if (!selected.ok) return selected;
      requestedMachineId = selected.machineId;
    }
    const mountedMachineId = args.context.executionRunTargetMachineId
      ?? (!relationshipWrite && args.context.surface !== 'plugin' ? args.context.defaultSessionMachineId : undefined);
    if (requestedMachineId && mountedMachineId && requestedMachineId !== mountedMachineId) {
      return { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' };
    }
    const machineId = requestedMachineId ?? mountedMachineId;
    if (!accountContext || !machineId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    const addressedContext = { ...args.context, externalActionTarget: args.context.externalActionTarget ?? { kind: 'machine' as const, machineId } };
    const context = args.confirmInFlow ? bindPresentUserActionConfirmation(ActionIdSchema.parse(args.actionId), args.input, addressedContext, args.reviewDigest) : addressedContext;
    if (isSessionSpawnNewActionIdV1(args.actionId)) {
      const input = SessionSpawnNewActionInputV2Schema.safeParse(args.input);
      if (!input.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!input.data.machineSetupPlanInput) {
        const result = completeSpawnActionResult(await forwardSessionSpawnNew(projectSessionSpawnNewActionInputV2(admitSessionSpawnNewActionInputV2(input.data)), context));
        return result.ok ? result.result : result;
      }
    }
    const confirmation = context.presentUserConfirmation?.inputDigest === undefined ? undefined : context.presentUserConfirmation;
    const reviewedParent = readHostReviewedParentV1(context);
    // Delegate admission with the original host origin. The receiving daemon
    // owns the retained candidate, Action policy and sole approval Artifact.
    // Mounted plugins have their own sealed pluginInvocation provenance. Do
    // not reinterpret that surface as a host Agent/CLI requester invocation.
    // Credential-free codecs still need caller provenance: an unstamped
    // managed request is automation at the receiver, even after a UI press.
    const needsInvocation = machineOwnedAction && context.surface !== 'plugin'
      && (Boolean(context.sessionCreationDefaults) || relationshipWrite || context.surface !== 'ui' || confirmation || reviewedParent
        || originalSpec.success && getActionSpec(originalSpec.data).originalExecution?.requesterCredentials === 'none'
        || context.presentUserApproval?.actionId === args.actionId
        || doesExternalActionConsumeRequesterAccountContentV1({ actionId: args.actionId, input: args.input,
          target: context.externalActionTarget }));
    const invocation = needsInvocation ? projectExternalActionRequesterInvocationV1({ actionId: args.actionId,
      context: { ...context, actionCaller: context.actionCaller ?? { kind: 'host' } }, account: accountContext,
      target: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget : { kind: 'machine', machineId },
    }) : null;
    if (needsInvocation && !invocation) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    const requestId = context.actionRequestId ?? randomUUID();
    const issued = await executeOriginalAccountMachineAction({ account: accountContext,
      actionId: args.actionId, input: args.input, machineId,
      requestId,
      actionCaller: context.actionCaller,
      machineTarget: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget : undefined,
      ...(invocation ? { invocation } : {}),
      ...(context.invocationServices?.managedContinuation ? { managedContinuation: context.invocationServices.managedContinuation } : {}),
      ...(args.actionId === 'machines.services.logs.read' && args.context.machineServiceLogsResource
        ? { machineServiceLogsGeneration: { expectedGeneration: args.context.machineServiceLogsResource.expectedGeneration } }
        : {}),
      authority: context.authority, signal: context.signal,
      ...(context.onTransportIssued ? { onTransportIssued: context.onTransportIssued } : {}) });
    const execution = await recoverUiDeploymentActionResult({ account: accountContext,
      actionId: args.actionId, input: args.input, machineId, requestId, context, execution: issued });
    if (execution.ok && args.actionId === 'machines.agents.install.cancel') {
      const cancellation = DaemonAgentInstallCancelResponseSchema.safeParse(execution.result);
      if (cancellation.success && cancellation.data.ok && args.input && typeof args.input === 'object'
          && 'jobId' in args.input && typeof args.input.jobId === 'string') {
        observeMachineAgentInstallJobCancellation({ ...accountContext.accountLifetime.scope, machineId }, args.input.jobId);
      }
    }
    return execution.ok ? args.actionId === 'projects.open'
      ? await completeUiProjectOpenResult(accountContext, execution.result, context.signal)
      : execution.result : execution;
  };
    type AgentsBackendsListArgs = Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>;
  const resolveNativeInventoryProbeTarget = async (args: Readonly<{
    agentId?: string; machineId?: string; serverId?: string; backendTargetKey?: string; signal?: AbortSignal;
  }>): Promise<AgentInventoryProbeTarget | null> => {
    const selected = resolveActionBackendTargetSelection(args);
    if (!selected.ok) return null;
    const target = selected.selection.canonicalBackendTarget;
    if (target?.configuredBackendId || target?.sourceKind === 'configured') {
      if (!accountContext || !args.machineId) return null;
      const { catalog } = await readAcpCatalogInContext(accountContext, args.signal);
      accountContext.assertCurrent();
      if (catalog.status !== 'ready') return null;
      const projection = await loadDaemonMergedProjectionInputs({
        machineId: args.machineId, serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
        sections: ['agentsById'],
        signal: args.signal ?? accountContext.invocationSignal,
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

  const resolveSessionMachineId = (sessionId: string, serverId?: string | null): string => {
    const exactServerId = String(serverId ?? '').trim();
    return readMachineControlTargetForSession(exactServerId
      ? { sessionId, serverId: exactServerId }
      : sessionId)?.machineId ?? '';
  };

  const readAccountAcpCatalog: NonNullable<ActionExecutorDeps['readAccountAcpCatalog']> = async ({ signal }) => {
    if (!accountContext) return { status: 'unavailable', reason: 'unauthorized' };
    const { catalog } = await readAcpCatalogInContext(accountContext, signal);
    accountContext.assertCurrent();
    return catalog;
  };
  const readAccountSettingsSnapshot = () => accountContext
    ? (accountContext.readLiveSettings() ?? accountContext.settings)
    : storage.getState().settings;
  const onPublicLinkIssued = opts?.onPublicLinkIssued
    ?? (accountContext ? createUiArtifactPublicLinkDelivery(accountContext) : undefined);
  const deploymentActionDeps = accountContext ? createUiDeploymentActionDeps(accountContext) : null;
  const prepareApiTokenAuthoringHost = async (deployment: AccountApiTokenDeploymentInputV1 | null | undefined,
    grantDeployApproval: 'automatic' | undefined, context: ActionExecutorContext): Promise<ApiTokenDeploymentAuthoringHost> => {
    if (deployment && accountContext && !areServerProfileIdentifiersEquivalent(deployment.serverId, accountContext.serverId)) {
      throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    let initialDeployApproval: 'automatic' | 'ask' | undefined;
    if (deployment && deployment.deployApproval === undefined && grantDeployApproval === undefined) {
      if (!deploymentActionDeps?.deploymentAction) throw Object.assign(new Error('client_required'), { code: 'client_required' });
      const { resolveInitialDeploymentApprovalV1 } = await import('@happier-dev/protocol/actions/executor/workflowRunActions');
      const initial = await resolveInitialDeploymentApprovalV1({ serverId: deployment.serverId, environmentId: deployment.environmentId,
        context, read: deploymentActionDeps.deploymentAction });
      if (!initial.ok) throw Object.assign(new Error(initial.errorCode), { code: initial.errorCode });
      initialDeployApproval = initial.mode;
    }
    return { ...(initialDeployApproval ? { initialDeployApproval } : {}), ...(accountContext ? { nativeAccount: {
      accountId: accountContext.accountId, serverId: accountContext.serverId,
      isCurrent: async () => accountContext.credentialAuthorityKind === 'account' && accountContext.accountLifetime.isCurrent(),
    } } : {}) };
  };
  const resolveActionsSettingsSnapshot = () => resolveActionsSettingsV1FromState({ settings: readAccountSettingsSnapshot() });
  const executeReviewCommentAction = createReviewCommentsHttpActionExecutor(accountContext ? {
    request: accountContext.request,
    resolveEventStorageContext: async usage => {
      const { mode } = await fetchAccountEncryptionMode(accountContext.credentials, { request: accountContext.request, usage });
      accountContext.assertCurrent();
      return mode === 'plain'
        ? { accountId: accountContext.accountId, mode }
        : { accountId: accountContext.accountId, mode, material: resolveAccountScopedCryptoMaterialFromCredentials(accountContext.credentials) };
    },
  } : undefined);
  const executePluginPermissionGrantAction = createPluginPermissionGrantHttpActionExecutor(accountContext ? { request: accountContext.request } : undefined);
  const executePluginWebhookAction = createPluginWebhookEndpointHttpActionExecutor(accountContext ? { request: accountContext.request } : undefined);
  const approvalCoordinator = getSharedBlockingApprovalCoordinator();
  const capturedFamilyPorts = accountContext ? createCapturedScopeFamilyPorts(accountContext, opts?.discussionAttachmentSources, onPublicLinkIssued) : null;
  const machineAccessAction = opts?.machineAccessAction ?? capturedFamilyPorts?.machineAccessAction;
  const workflowAction = opts?.workflowAction ?? (accountContext ? createUiWorkflowAction({ account: accountContext,
    listContributedActionDefinitions: opts?.listContributedActionDefinitions ?? listCurrentUiContextContributedActionDefinitions,
  }) : undefined);
  const projectSourceTeamMove = accountContext && deploymentActionDeps?.deploymentAction && machineAccessAction && workflowAction
    ? createProjectSourceTeamMoveDeps(accountContext, { deploymentAction: deploymentActionDeps.deploymentAction, machineAccessAction, workflowAction })
    : null;
  const settingsHost = resolveSettingsHost();
  const accountRoleAction = accountContext ? createAccountRoleActionExecutorV1({
    accountId: accountContext.accountId,
    readRawAccountSettings: accountContext.readRawSettings,
    mutateRawAccountSettings: async (mutate, signal) => { await accountContext.mutateRawSettings(mutate, { signal }); },
    mutateAccountRoleOverrides: (mutation, context) => mutatePromptLibraryRoleOverrideInContext(accountContext, mutation, context.signal),
    generateId: randomUUID,
    artifactStore: createRoleArtifactStoreV1(accountContext.workflowArtifacts),
    readPluginRoles: signal => readUiPluginRoleSources(accountContext, signal),
  }) : null;

  const connectedServiceAction = accountContext ? createUiConnectedServiceAction(accountContext, opts?.connectedServiceQuotaReadOptions) : undefined;
  const approvalArtifacts = createApprovalArtifactAccess({
    read: artifactId => accountContext ? accountContext.fetchArtifact(artifactId, { fresh: true })
      : sync.fetchArtifactWithBody(artifactId, { fresh: true }),
    // Scoped executors live for one invocation, unlike the shared fallback.
    reuseWriteBasis: Boolean(accountContext),
    ...(!accountContext ? {
      local: (artifactId: string) => storage.getState().artifacts[artifactId] ?? null,
      publish: (artifact: Parameters<ReturnType<typeof storage.getState>['updateArtifact']>[0]) => storage.getState().updateArtifact(artifact),
    } : {}),
  });
  const updateApprovalArtifact = async ({ artifactId, request, context, expectedStatus }: Readonly<{
    artifactId: string; request: ApprovalRequest | TargetActionApprovalRequestV1; context?: ActionExecutorContext;
    expectedStatus?: ApprovalRequest['status'];
  }>) => {
    // Only the known Home-open ACK and a decided terminal outcome may outlive their
    // invoking presentation/intent; target decisions keep their captured Account lifetime.
    const settlement = accountContext && request.v === 2
      ? await captureApprovalSettlementAccount(accountContext, request) : null;
    const artifactAccount = settlement ?? accountContext;
    const basis = approvalArtifacts.takeWriteBasis(artifactId);
    const acquired = artifactAccount === accountContext ? basis : null;
    try {
      const written = await writeApprovalRequestArtifact({
        artifactId, request, expectedStatus,
        read: async id => acquired ?? await (artifactAccount ? artifactAccount.fetchArtifact(id, { fresh: true }) : sync.fetchArtifactWithBody(id, { fresh: true })),
        write: async (basis, header, body) => {
          if (artifactAccount) {
            await artifactAccount.updateArtifact(artifactId, header, body, basis);
            return;
          }
          // Focused Sync borrows this validated read as its expected CAS basis.
          storage.getState().updateArtifact(basis);
          try { await sync.updateArtifactWithHeader(artifactId, header, body); }
          catch (error) {
            const latest = await sync.fetchArtifactWithBody(artifactId, { fresh: true });
            if (latest) storage.getState().updateArtifact(latest);
            throw error;
          }
        },
      });
      if (written.ok) {
        approvalCoordinator.notifyApprovalUpdated({ artifactId, request });
        // Background Home readers observe consent through the existing feed.
        if (artifactAccount) publishHomeAccountChange(artifactAccount.serverId, [artifactId], { changeKinds: ['artifact'] });
      }
      return written;
    } finally { settlement?.dispose(); }
  };
  const usageActions = accountContext ? { ...createUiUsageActionPorts(accountContext, opts?.usageRecapRender),
    ...(opts?.usageQueryRead ? { query: opts.usageQueryRead } : {}) } : undefined;
  const scmActionExecute = opts?.scmActionExecute ?? createUiScmAction(accountContext, { onDispatched: opts?.onScmDispatched });
  const publicProfileHome = opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction;
  const homeDomainAction = opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction
    ? ((args: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0]) => {
      // Section intents need the opened Account organization owner even when a mounted
      // surface supplies the ordinary Home HTTP transport for the other families.
      const owner = isSessionOrganizationResourceAction(args.actionId)
        ? capturedFamilyPorts?.homeDomainAction : undefined;
      return (owner ?? opts?.homeDomainAction ?? capturedFamilyPorts!.homeDomainAction)(args);
    })
    : undefined;
  let deps: ActionExecutorDeps = {
    browserProfileLoginsImport: ({ input, context }) => importBrowserProfileLoginsInContext(accountContext ?? null, input,
      call => actionMachineRpc({ serverId: accountContext?.serverId, accountId: accountContext?.accountId,
        machineId: call.machineId, method: call.method, payload: call.input,
        signal: context.signal, operationTimeoutMs: null }), context.signal),
    prepareHostReviewedChildren: async request => {
      // Natural Session operands resolve after this dependency graph is built.
      // Machine preparation consumes that exact Home, just as Session delivery does.
      const demand = request.machineRuntimeDemand;
      const targetSessionId = demand?.target.kind === 'session' ? demand.target.sessionId : undefined;
      let serverId = demand?.serverId ?? (targetSessionId
        ? resolveServerIdForSession(deps, request.context, targetSessionId) : request.context.serverId);
      if (!serverId && targetSessionId && deps.resolveSessionReference) {
        // A bare id without a known Home has not selected an Account. Resolve
        // it through the incumbent corpus before Machine preparation, preserving
        // unknown/ambiguous/incomplete targets instead of blaming admission.
        const resolved = await deps.resolveSessionReference({ sessionId: targetSessionId,
          context: request.context, actionId: request.actionId, signal: request.context.signal });
        if (resolved.kind !== 'unique') return projectSessionReferenceFailure(resolved);
        serverId = resolved.address.serverId;
      }
      const ownedAccount = !accountContext && demand && serverId
        ? await captureLazyActionAccountContext(serverId, request.context.signal) : undefined;
      const account = accountContext ?? ownedAccount;
      try {
        if (ownedAccount) assertExpectedActionAccount(ownedAccount, request.context);
        const refusal = await prepareUiManagedProvisionerAdmission(request, account);
        if (refusal) return refusal;
        const wake = await prepareUiManagedMachineWake(request, account);
        if (wake) {
          const execute = !('ok' in wake) ? wake.executeAdmittedAction : undefined;
          return ownedAccount && execute ? { ...wake, executeAdmittedAction: (execution: Parameters<typeof execute>[0]) =>
            ownedAccount.runPrepared(() => execute(execution), getActionSpec(request.actionId).sideEffectClass) } : wake;
        }
        return await projectSourceTeamMove?.prepareHostReviewedChildren?.(request) ?? null;
      } finally {
        ownedAccount?.dispose();
      }
    },
    buildApprovalPreview: async ({ actionId, input, context, defaultPreview }) => {
      if (actionId === 'projects.sources.moveToTeam' && projectSourceTeamMove)
        return projectSourceTeamMove.buildApprovalPreview(input, context, defaultPreview);
      if (!accountContext || !machineAccessAction) return defaultPreview;
      if (!isSessionSpawnNewActionIdV1(actionId)) {
        try {
          let machineIds: string[] = [];
          if (actionId === 'workflow.run.start') {
            if (context.externalActionTarget?.kind === 'machine') machineIds = [context.externalActionTarget.machineId];
          } else if (actionId === 'workflow.trigger.add') {
            const selected = WorkflowTriggerAddRequestV1Schema.safeParse(input);
            if (selected.success && selected.data.project) machineIds = [selected.data.project.machineId];
          } else if (actionId === 'workflow.trigger.update') {
            const selected = WorkflowTriggerUpdateRequestV1Schema.safeParse(input);
            if (selected.success) {
              if (selected.data.patch.project) machineIds = [selected.data.patch.project.machineId];
              else {
                const row = await withAccountLifetime(context.signal, signal => getAutomationDefinition(accountContext.credentials,
                  selected.data.automationId, { ...accountContext, invocationSignal: signal }));
                machineIds = row.assignments.filter(assignment => assignment.enabled).map(assignment => assignment.machineId);
              }
            }
          } else if (actionId === 'session.trigger.add') {
            const selected = SessionTriggerAddRequestV1Schema.safeParse(input);
            if (selected.success) machineIds = [(selected.data.project
              ?? (await createUiTriggerSessionResolver(accountContext)(selected.data.sessionId, { signal: context.signal })).project).machineId];
          } else if (actionId === 'session.trigger.update') {
            const selected = SessionTriggerUpdateRequestV1Schema.safeParse(input);
            if (selected.success) {
              if (selected.data.patch.project) machineIds = [selected.data.patch.project.machineId];
              else if (workflowAction) {
                const listed = await workflowAction({ actionId: 'session.trigger.list', input: { sessionId: selected.data.sessionId }, context });
                const failure = ActionExecuteFailureSchema.safeParse(listed);
                if (failure.success) return failure.data;
                const set = SessionTriggerListResultV1Schema.parse(listed).sets
                  .find(set => set.triggers.some(trigger => trigger.id === selected.data.triggerId));
                machineIds = set?.project ? [set.project.machineId] : (set?.placements ?? []).map(placement => placement.machineId);
              }
            }
          } else return defaultPreview;
          accountContext.assertCurrent();
          const disclosures = [];
          for (const machineId of new Set(machineIds)) {
            const access = await machineAccessAction({ actionId: 'machines.access.grants.list',
              input: { serverId: accountContext.serverId, machineId }, context, ...(context.signal ? { signal: context.signal } : {}) });
            accountContext.assertCurrent();
            const disposition = resolveRequesterSessionSpawnDisposition({ accountId: accountContext.accountId, machineId, access });
            if (disposition.kind === 'requester') disclosures.push(disposition.disclosure);
          }
          const disclosure = disclosures[0];
          if (!disclosure) return defaultPreview;
          return { ...defaultPreview, requesterCredentialDisclosure: disclosure, summary: [defaultPreview.summary,
            ...disclosures.flatMap(disclosure => [
              t('machineRequester.fullSignIn', { machine: disclosure.machineId, retention: actionId === 'workflow.run.start' ? 'run' : 'trigger' }),
              t('machineRequester.osVisibility', { owner: disclosure.custodian.displayName || disclosure.custodian.accountId,
                machine: disclosure.machineId }),
            ]),
          ].join('\n\n') };
        } catch (error) { return normalizeWorkflowActionThrownError(error, undefined, true); }
      }
      const parsed = SessionSpawnNewActionInputV2Schema.safeParse(input);
      if (!parsed.success || !parsed.data.executionTarget || !parsed.data.agentTarget
        || !areServerProfileIdentifiersEquivalent(parsed.data.executionTarget.serverId, accountContext.serverId)) return defaultPreview;
      const machineId = parsed.data.executionTarget.machineId;
      const machine = resolveServerScopedMachine(storage.getState(), accountContext.serverId, machineId);
      const disposition = await readRequesterSessionSpawnDisposition({ accountId: accountContext.accountId, machineId,
        isShared: machine?.isShared, readAccess: () => machineAccessAction({ actionId: 'machines.access.grants.list',
          input: { serverId: accountContext.serverId, machineId }, context, ...(context.signal ? { signal: context.signal } : {}) }) });
      accountContext.assertCurrent();
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
        accountLifetime: accountContext.accountLifetime, signal: context.signal,
        sections: ['agentsById', 'familiesById.connectedAccounts'] });
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
    ...(promptLibraryStore?.organization ? { artifactFolders: promptLibraryStore.organization, promptStacks: promptLibraryStore.organization,
      ...(accountContext ? { registryActionExecute: createUiRegistryActionExecuteV1(accountContext, promptLibraryStore.organization) } : {}),
      ...(accountContext ? { skillRules: { ...promptLibraryStore.organization,
        // A rule intent is applied to the current row. A retained UI projection can
        // miss another device's revision; CAS still refuses a race after this read.
        readCatalog: (signal, key) => key === 'skill-rules'
          ? readPromptLibraryCatalogProjectionInContext(accountContext, signal)
          : promptLibraryStore.organization!.readCatalog(signal, key),
        listSkills: async (signal?: AbortSignal, skillIds?: readonly string[]) => {
          accountContext.assertCurrent(); throwIfAborted(signal);
          const skills = await readUiSkillLibraryCatalogV1(accountContext, signal, skillIds);
          accountContext.assertCurrent(); throwIfAborted(signal);
          return skills;
        }, ruleWriteContext: () => ({ nowMs: Date.now(), newId: randomUUID }),
      } } : {}),
    } : {}),
    ...(accountContext && promptLibraryStore ? { memoryLibrary: {
      serverId: accountContext.serverId, store: promptLibraryStore, randomId: randomUUID,
      isSameServerId: serverId => areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId),
      readExposure: (artifactId, context) => accountContext.readArtifactExposure(artifactId, context.signal),
      readSession: (ref, context) => readUiOwnedSessionForAction(accountContext, ref, context),
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
    filesystemActionExecute: createUiFilesystemAction(accountContext ?? undefined, opts?.filesystemActionDelivery),
    ...(opts?.hostActionApprovalLifetime ? { hostActionApprovalLifetime: opts.hostActionApprovalLifetime }
      : opts?.filesystemActionDelivery ? { hostActionApprovalLifetime: {
      actionId: opts.filesystemActionDelivery.actionId, signal: opts.filesystemActionDelivery.signal, surface: 'ui' as const,
    } } : {}),
    sessionUpdatePost: async ({ context, ...input }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const sessionId = context.defaultSessionId?.trim();
      if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      if (context.actionCaller?.kind === 'session' && context.actionCaller.sessionId !== sessionId) {
        return { ok: false, errorCode: 'session_update_source_mismatch', error: 'session_update_source_mismatch' };
      }
      accountContext.assertCurrent();
      throwIfAborted(context.signal);
      const result = await actionSessionRpc<unknown, typeof input>({
        serverId: accountContext.serverId, sessionId, method: 'session.update.post', payload: input,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      accountContext.assertResultCurrent(getActionSpec('session.update.post').sideEffectClass);
      return result;
    },
    currentSessionPresentationApply: async ({ input, context, signal }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const sessionId = context.defaultSessionId?.trim();
      if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      accountContext.assertCurrent();
      throwIfAborted(signal);
      const mounted = opts?.currentSessionPresentationApply;
      if (mounted && context.surface === 'ui' && context.authority === 'present_user') {
        if (!areServerProfileIdentifiersEquivalent(mounted.serverId, accountContext.serverId)
          || mounted.accountId !== accountContext.accountId || !mounted.isCurrent()) {
          return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        }
        if (mounted.sessionId !== sessionId) {
          return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        }
        const result = await mounted.apply({ input, context, ...(signal ? { signal } : {}) });
        accountContext.assertResultCurrent(getActionSpec('session.presentation.apply').sideEffectClass);
        return result;
      }
      const result = await actionSessionRpc<CurrentSessionPresentationActionResultV1 | ActionExecuteFailure, typeof input>({
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
        const result = await actionSessionRpc<unknown, typeof input>({
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
      throwIfAborted(context.signal);
      accountContext?.assertCurrent();
      if (actionId === 'file.view.preference.set') {
        if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const requested = ScopeActionInputSchemas[actionId].parse(input);
        const result = await accountContext.mutateRawSettings(raw => ({
          ...applyWorkspaceFileViewerPreferenceMutationV1(raw, requested.mutation),
        }), { signal: context.signal, observeOutcome: true,
          ...(requested.expectedSettingsVersion === undefined ? {} : {
            expectedSettingsVersion: requested.expectedSettingsVersion, rebaseOnConflict: false,
          }),
        });
        try {
          const applied = requireOneShotAccountSettingsMutationApplied(result);
          return { status: 'applied', settingsVersion: applied.settingsVersion };
        } catch (error) {
          if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
            return { ok: false, errorCode: error.code, error: error.message };
          }
          throw error;
        }
      }
      return await invokeScopeAction(actionId, input, context, opts?.scopeActionOwner);
    },
    diagnosticsAction: async ({ actionId, context }) => {
      if (!accountContext) return { status: 'unavailable' };
      return await invokeDiagnosticAction(actionId, {
        context, request: accountContext.request, assertCurrent: accountContext.assertCurrent,
      });
    },
    connectedServiceAction,
    usageActions,
    publicProfileActions: accountContext && publicProfileHome && usageActions
      ? createUiPublicProfileActionPorts(accountContext, publicProfileHome, usageActions,
        (actionId, input, context) => executor.execute(actionId, input, context)) : undefined,
    usageSourceAction: accountContext ? createUiUsageSourceActionPort(accountContext, opts?.usageSourceDismiss) : undefined,
    scmActionExecute,
    appShellAction: createAppShellAction(accountContext),
    clientActionExecute: request => executeDesktopAppWindowClientAction(request, {
      screenCaptureSendDraftOnly: opts?.screenCaptureSendDraftOnly,
      screenCaptureWindowPress: opts?.screenCaptureWindowPress,
    }, {
      clientId: () => apiSocket.getSocketId(),
      dispatch: async (request, clientId) => {
        if (!accountContext) return clientActionUnavailable(request.actionId);
        const machineId = resolveUiAccountActionFallbackMachineId(accountContext, { allowUnreachableFallback: true });
        if (!machineId) return clientActionUnavailable(request.actionId);
        try {
          const response = await apiSocket.callClientAction({ machineId,
            request: buildUiActionDispatchRequestV1(request),
            answeringClient: { clientId, requireSingle: true },
            signal: request.context.signal,
          });
          return parseClientActionDispatchResult(request.actionId, response.result)
            ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        } catch (error) {
          if (readRpcFailureCode(error) === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE) {
            return clientActionUnavailable(request.actionId);
          }
          throw error;
        }
      },
    }),
    desktopWindowsOpen: async ({ input, context }) => {
      context.signal?.throwIfAborted();
      // The native lifecycle producer owns creation, reuse and placement together.
      const { openDesktopAppWindow } = await import('@/desktop/window/appWindowRuntime');
      return await openDesktopAppWindow(input);
    },
    desktopNotchSet: async args => {
      const { createDesktopNotchActionDeps } = await import('./desktopNotchActions');
      return createDesktopNotchActionDeps().desktopNotchSet(args);
    },
    desktopDisplaysList: async args => {
      const { createDesktopDisplayActionDeps } = await import('./desktopDisplayActions');
      return createDesktopDisplayActionDeps().desktopDisplaysList(args);
    },
    screenCaptureAction: async args => {
      const { createNativeScreenCaptureAction } = await import('./screenCaptureActions');
      return createNativeScreenCaptureAction({
        sendDraftOnly: opts?.screenCaptureSendDraftOnly,
        captureWindowPress: opts?.screenCaptureWindowPress,
        discard: opts?.screenCaptureDiscard,
      })(args);
    },
    notificationConfigurationAction: createNotificationConfigurationAction(accountContext ?? null),
    bugReportSubmit: createBugReportSubmitAction(accountContext ?? null),
    appUpdateAction: executeAppUpdateAction,
    updatesAction: createUpdatesAction(accountContext),
    saveClientFile: async args => {
      const { saveClientFile } = await import('@/sync/runtime/files/saveFileBytes');
      return saveClientFile(args);
    },
    saveClientBrowserDownload: async args => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const { saveBrowserDownload } = await import('@/sync/runtime/files/browserDownload');
      return saveBrowserDownload(args, accountContext.accountLifetime.scope);
    },
    externalUrlOpen: async ({ url, signal }) => {
      throwIfAborted(signal);
      accountContext?.assertCurrent();
      // Keep the platform open in this invocation: no pre-opened popup on refusal,
      // deferred task, retry, URL publication or second opener.
      return await openExternalUrl(url) ? { status: 'opened' }
        : { ok: false, errorCode: 'external_link_unavailable', error: 'external_link_unavailable' };
    },
    clipboardWrite: async ({ text, signal }) => {
      throwIfAborted(signal);
      accountContext?.assertCurrent();
      const copied = await setClipboardStringSafe(text);
      throwIfAborted(signal);
      accountContext?.assertCurrent();
      return copied ? { status: 'copied' } : { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' };
    },
    hostExternalSessionAction: args => executeExternalSessionBrowseAction(args, opts?.isExternalSessionFollowIntentCurrent),
    settingsDeclarationAction: createSettingsDeclarationAction({
      serverId: accountContext?.serverId,
      approvalProfiles: accountContext ? {
        list: () => readApprovalProfileCatalog(accountContext),
        change: (change, signal) => executeUiApprovalProfileChange(accountContext, change, signal),
      } : undefined,
      host: settingsHost,
      tauriDesktop: settingsHosts.tauriDesktop(settingsHost),
      readPageGate: readSettingsPageGate,
      canUseRuntimeContributions: () => Boolean(accountContext && accountContext.readLiveSettings() !== null),
      isCurrent: isSettingsOwnerCurrent,
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
        prepareLegacyAgentSelection: createLegacyVoiceChatSelectionPreparer(accountContext ?? null,
          createVoiceAgentSettingsCatalogReader(accountContext ?? null),
          { onBlockingApprovalPending: opts?.onBlockingApprovalPending }),
        ...(accountContext ? { importLegacyVoiceChat: async (context: ActionExecutorContext) => {
          const { importLegacyVoiceOpenAiChatProvider } = await import('@/sync/ops/settings/legacyVoiceChatImport');
          return importLegacyVoiceOpenAiChatProvider(accountContext.accountLifetime.scope, undefined, {
            actionContext: context, executorOptions: { onBlockingApprovalPending: opts?.onBlockingApprovalPending },
          });
        } } : {}),
        ...(accountContext && opts?.voiceSettingsEdit ? { voiceSettingsEdit: opts.voiceSettingsEdit } : {}),
        ...(accountContext && opts?.voiceModelPackPresentation ? { voiceModelPackPresentation: opts.voiceModelPackPresentation } : {}),
        ...(accountContext ? createAtmosphereSettingServices(accountContext) : {}),
        ...(accountContext && opts?.publicProfileAtmosphereDraft ? { publicProfileAtmosphereDraft: opts.publicProfileAtmosphereDraft } : {}),
        ...(accountContext && opts?.projectAtmosphereEdit ? { projectAtmosphereEdit: opts.projectAtmosphereEdit } : {}),
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
          throwIfAborted(signal); accountContext.assertCurrent();
          const { purgeAccountSettingsHistoryVersions } = await import('@/sync/engine/settings/accountSettingsHistoryRestore');
          return accountContext.runPrepared(() => purgeAccountSettingsHistoryVersions({
            credentials: accountContext.credentials, settingsScope: accountContext.accountLifetime.scope, versions, signal,
            requestContext: { request: accountContext.request, isCurrent: () => {
              try { accountContext.assertCurrent(); throwIfAborted(signal); return true; } catch { return false; }
            } },
          }), 'danger');
        } } : {}),
        ...(accountContext ? {
          restoreAccountSettingsHistory: async (input: Extract<SettingsDeclarationOperationInputV1, { kind: 'account_settings_history_restore' }>, signal?: AbortSignal): Promise<SettingOperationResult> => {
            throwIfAborted(signal); accountContext.assertCurrent();
            try {
              return await accountContext.runPrepared(async (): Promise<SettingOperationResult> => {
                // Plain Accounts may still hold genuine material for an encrypted historical snapshot.
                const encryption = isTokenOnlyAuthCredentials(accountContext.credentials) ? null
                  : await createEncryptionFromAuthCredentials(accountContext.credentials);
                const result = await restoreAccountSettingsFromHistorySnapshot({
                  credentials: accountContext.credentials, encryption, settingsScope: accountContext.accountLifetime.scope,
                  historyVersion: input.historyVersion, expectedSettingsVersion: input.expectedSettingsVersion, signal,
                });
                return { status: 'completed', value: result };
              }, 'danger');
            } catch (error) {
              return { status: 'unavailable', reason: error instanceof AccountSettingsHistoryRestoreInvalidError
                ? 'history_invalid' : 'history_unavailable' };
            }
          },
          convertAccountEncryptionMode: async (toMode: 'plain' | 'e2ee', signal?: AbortSignal): Promise<SettingOperationResult> => {
            throwIfAborted(signal); accountContext.assertCurrent();
            if (accountContext.readLiveSettings() === null) return { status: 'unavailable', reason: 'account_scope_unavailable' };
            try {
              return await accountContext.runPrepared(async (): Promise<SettingOperationResult> => {
                const settings = await accountContext.readSettings();
                assertUiAccountEncryptionModeAllowed({ mode: toMode, syncedSettings: settings, localSettings: settings });
                const accountMode = await accountContext.resolveAccountMode();
                const sourceEncryption = accountMode === 'e2ee' && !isTokenOnlyAuthCredentials(accountContext.credentials)
                  ? await createEncryptionFromAuthCredentials(accountContext.credentials) : null;
                const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext.serverId });
                accountContext.assertCurrent();
                const result = await convertAccountEncryptionMode({ credentials: accountContext.credentials,
                  sourceEncryption, profile: storage.getState().profile, settingsScope: accountContext.accountLifetime.scope,
                  accountEncryptionMode: accountMode, toMode, signal,
                  sessionDraftSyncEnabled: resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'sessions.drafts', settings, snapshot })?.state === 'enabled',
                  persistCredentials: (...args) => {
                    const auth = getCurrentAuth();
                    if (!auth || auth.credentials?.token !== accountContext.credentials.token) throw new Error('Account credential owner changed');
                    return auth.loginWithCredentials(...args);
                  },
                });
                return result === 'interaction_opened' ? { status: 'interaction_opened' }
                  : result ? { status: 'completed', value: result } : { status: 'cancelled' };
              }, 'danger');
            } catch (error) {
              return { status: 'unavailable', reason: error instanceof HappyError ? error.code ?? 'encryption_conversion_unavailable'
                : isAccountModeDowngradeUnverifiedError(error) ? ACCOUNT_MODE_DOWNGRADE_UNVERIFIED : 'encryption_conversion_unavailable',
                // Only a HappyError message is user-facing; other failures keep the generic copy.
                value: { ...(error instanceof HappyError ? { message: error.message } : {}),
                  ...(error instanceof AccountEncryptionModeChangedError ? { mode: error.mode } : {}),
                  ...(error instanceof HappyError && error.status !== undefined ? { status: error.status } : {}) } };
            }
          },
        } : {}),
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
      ...(accountContext ? { setClientEncryptionRequirement: (enabled: boolean) =>
        setClientEncryptionRequirement(accountContext, enabled) } : {}),
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
      writeLocalSettings: (delta) => {
        opts?.beforeLocalSettingCommit?.();
        storage.getState().applyLocalSettings(delta, { source: 'ui' });
      },
      ...(accountContext ? { automationSettings: {
        read: () => accountContext.runPrepared(() => getAutomationSettings(accountContext.credentials, accountContext)),
        write: (settings: AutomationV3Settings) => accountContext.runPrepared(() => updateAutomationSettings(accountContext.credentials, settings, accountContext)),
      } } : {}),
    }),
    ...(accountContext ? { workBoardArtifacts: opts?.workBoardArtifacts ?? createWorkBoardArtifactPortV1(accountContext.workflowArtifacts, {
      shouldContinue: accountContext.accountLifetime.isCurrent,
    }) } : {}),
    ...(accountContext ? { launchProfilePublish: async (input, context) => {
      throwIfAborted(context?.signal);
      let capturedRow: Readonly<{ record: ProfileRecordV1; revision: number }> | null = null;
      return await createLaunchProfilePublisherV1({
        profileStore: {
          read: async (profileId, signal) => {
            accountContext.assertCurrent();
            // Publication keeps private runtime attachments intact. Their migration
            // and historical maintenance belong to the scoped catalog loader.
            const { catalog } = await readProfileCatalogProjectionInContext(accountContext, signal, {
              migrateSkills: false, deferCleanup: true,
            });
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
    pluginsDevLoopAction: executeMachineOwnedAction,
    ...(opts?.pluginSessionHookManagementAction ? { pluginSessionHookManagementAction: opts.pluginSessionHookManagementAction } : {}),
    ...(accountContext ? { npmRegistryProfileAction: createUiNpmRegistryProfileAction(accountContext, opts?.npmRegistryProfileDelivery) } : {}),
    ...(accountContext ? createPluginAccountAdministrationActionDeps(accountContext, opts?.pluginAccountAdministrationIsCurrent,
      opts?.pluginAccountAdministrationProjection) : {}),
    ...(accountContext ? createPluginExecutionOriginActionDeps(accountContext) : {}),
    ...(accountContext ? { pluginSettingsAdministrationAction: createUiPluginSettingsAdministrationAction(accountContext) } : {}),
    ...(accountContext ? { automationOccurrenceAction: createUiOccurrenceAction(accountContext) } : {}),
    automationConversationAction: async (args) => args.context
      ? await executeMachineOwnedAction({ actionId: args.actionId, input: args.input, context: args.context })
      : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' },
    ...(accountContext ? { artifactAction: createUiArtifactAction(accountContext, { onPublicLinkIssued,
      consumeArtifactSignedInLinkSecret: opts?.consumeArtifactSignedInLinkSecret,
      onArtifactSignedInLinkOpened: opts?.onArtifactSignedInLinkOpened }) } : {}),
    ...(accountContext ? (() => {
      const botTemplateAction = createUiBotTemplateAction(accountContext, opts?.openBotTemplate ?? (async input => {
        const { router } = await import('expo-router');
        const { buildBotTemplateEditorRoute } = await import('@/components/sessions/bots/templates/botTemplateEditorDestination');
        router.push(buildBotTemplateEditorRoute(input));
      }), promptLibraryStore?.organization, () => deps, { onPublicLinkIssued });
      return { botTemplateAction, prepareBotTemplateInstantiation: request => botTemplateAction.prepareInstantiation(request),
        prepareBotTemplateUpdate: request => botTemplateAction.prepareUpdate(request),
        prepareBotTemplateRelease: request => botTemplateAction.prepareRelease(request) } satisfies
        Pick<ActionExecutorDeps, 'botTemplateAction' | 'prepareBotTemplateInstantiation' | 'prepareBotTemplateUpdate' | 'prepareBotTemplateRelease'>;
    })() : {}),
    ...(accountContext ? {
      themeAction: createThemeActionExecute({
        runtime: {
          preview: getThemeTryOnOwner(),
          coverage: document => prepareThemeProfileCss(document.profile).coverage,
          detailedCoverage: document => prepareThemeProfileCss(document.profile).detailedCoverage,
          surfaceMap: (document, mode) => projectThemeSurfacePaintMap(document, mode, {
            composerSurfaceStyle: storage.getState().settings.composerSurfaceStyle,
          }),
        },
        withLibrary: (operation, signal) => sync.withThemeProfileLibrary(operation,
          { expectedScope: accountContext.accountLifetime.scope, signal }),
        clientId: () => apiSocket.getSocketId(),
        readSelection: () => readThemeProfileReferenceSelection(storage.getState().localSettings.themeProfileSelection),
        dispatchClientAction: async request => {
          const machineId = resolveUiAccountActionFallbackMachineId(accountContext, { allowUnreachableFallback: true });
          if (!machineId) return clientActionUnavailable(request.actionId);
          const input = { ...request.input, includeDevices: false };
          try {
            const response = await apiSocket.callClientAction({ machineId,
              request: buildUiActionDispatchRequestV1({ ...request, input }),
              answeringClient: { clientId: apiSocket.getSocketId(), requireSingle: true, includeCandidates: true },
              signal: request.context.signal,
            });
            const execution = parseClientActionDispatchResult(request.actionId, response.result);
            if (!execution) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            if (!execution.ok) return execution;
            // The shared dispatch parser validated this exact Action's output at the network boundary.
            const result = execution.result as ThemeActionOutput;
            return { ...result, devices: response.answeringClients ?? [] };
          } catch (error) {
            if (readRpcFailureCode(error) === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE) {
              return clientActionUnavailable(request.actionId);
            }
            throw error;
          }
        },
      }),
      profileActionExecute: createUiProfileActionExecuteV1(accountContext, { onRpcDispatched: opts?.onProviderRpcDispatched }),
      mcpServerAction: createUiMcpServerActionExecuteV1(accountContext, connectedServiceAction, {
        ...(promptLibraryStore?.organization ? { registryActionExecute: createUiRegistryActionExecuteV1(accountContext, promptLibraryStore.organization) } : {}),
        ...((opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction) ? {
          personalSavedSecretActionExecute: createUiPersonalSavedSecretActionExecute(accountContext, (opts?.homeDomainAction ?? capturedFamilyPorts!.homeDomainAction)!),
        } : {}),
      }),
      providerActionExecute: createUiProviderActionExecuteV1(accountContext, { onRpcDispatched: opts?.onProviderRpcDispatched }),
    } : {}),
    ...(accountContext ? { remoteHostActionExecute: createUiRemoteHostActionExecuteV1(accountContext, opts?.openRoute, opts?.homeRuntimeRunner) } : {}),
    ...(accountContext ? { artifactAccessAction: createArtifactAccessActionsV1({
      read: (artifactId, options) => accountContext.readArtifactPublicLinkResource(artifactId, options?.signal),
      transport: accountContext.artifactAccessGrants,
      prepareSharing: (resource, signal) => prepareWidgetAreaSharingV1(accountContext, resource, signal),
    }) } : {}),
    ...(workflowAction ? { workflowAction } : {}),
    ...(accountContext ? {
      readAdmittedInputTypeOptions: async ({ input, context }) => {
        const { consumer } = getActionSpec('action.options.resolve').inputSchema.parse(input) as PublicActionInputById['action.options.resolve'];
        if (consumer?.kind === 'widget') {
          // A Board/Companion or explicitly bound Session supplies the same
          // serving runtime for field metadata and its contributed choices.
          // Consumer admission already hydrated it; do not reread the catalog.
          const session = readWidgetActionSessionTargetV1(consumer.surface, consumer.selectedSession);
          if (session) {
            const target = readMachineControlTargetForSession({ ...session, accountId: accountContext.accountId });
            if (!target) return { ok: false, errorCode: 'input_type_consumer_unavailable', error: 'input_type_consumer_unavailable' };
            context = { ...context, externalActionTarget: { kind: 'machine', machineId: target.machineId } };
          }
        }
        return createUiAccountAction({ account: accountContext })({ actionId: 'action.options.resolve', input, context });
      },
    } satisfies Pick<ActionExecutorDeps, 'readAdmittedInputTypeOptions'> : {}),
    resolveSessionReference: opts?.resolveSessionReference ?? (async ({ sessionId, sessionTitle, context, signal }) => {
      const exact = normalizeSessionAddress(context.serverId, sessionId);
      if (exact) {
        if (!accountContext || !areServerProfileIdentifiersEquivalent(exact.serverId, accountContext.serverId)
          || context.expectedAccountId && context.expectedAccountId !== accountContext.accountId
          || context.runtimeAccountId && context.runtimeAccountId !== accountContext.accountId) return { kind: 'incomplete' };
        try {
          throwIfAborted(signal); accountContext.assertCurrent();
          const hydration = await runWithServerRequestAuthorityForServerAccountScope({
            scope: accountContext.accountLifetime.scope, activeRequest: accountContext.request,
          }, authority => sync.ensureSessionVisibleForMessageRoute(exact.sessionId, {
            serverId: exact.serverId, authority, hydrateMessages: false,
            ...(signal ? { signal } : {}),
            scopeCurrentness: () => !signal?.aborted && accountContext.accountLifetime.isCurrent(),
          }));
          throwIfAborted(signal); accountContext.assertCurrent();
          if (hydration.kind === 'available') return { kind: 'unique', address: exact };
          return hydration.kind === 'missing' && hydration.cause === 'not_found' ? { kind: 'none' } : { kind: 'incomplete' };
        } catch {
          throwIfAborted(signal);
          return { kind: 'incomplete' };
        }
      }
      // Natural references use the one admitted corpus: mounted membership or
      // the canonical row-only Session listing, with its original coverage.
      const currentState = storage.getState();
      const options = await acquireAdmittedSessionReferenceCorpusOptions(
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
    prepareApprovalExecutionOriginContext: createUiActionExecutionOriginContextPreparer(accountContext),
    isApprovalExecutionOriginCurrent: async ({ origin, request, signal, reportStale }) => {
      const stale = (reason: ApprovalStaleReason) => { reportStale?.(reason); return false; };
      if (!accountContext) return stale('account_unavailable');
      try { accountContext.assertCurrent(); } catch { return stale('requester_account_unavailable'); }
      if (!isApprovalExecutionOriginCurrentForAccountContext({
        origin,
        accountServerId: accountContext.serverId,
        accountId: accountContext.accountId,
        reportStale,
      })) return false;
      const executor = resolveApprovalExecutor(request);
      // Plugins are trusted code (ruling 2026-10-29): the person approved this exact Action and
      // input, and a genuine plugin update keeps that approval (ruling 2026-11-02), so the plugin's
      // current source is not re-read here.
      // Exact-daemon families verify their signed input at that daemon. For an
      // app-owned Account proposal, verify once against the fresh Home installation
      // identity before the Artifact claim; the claim and effect consume that admission.
      const authorization = origin.externalActionExecutionAuthorization;
      if (!authorization || executor.kind !== 'app') return true;
      if (request.v !== 2 || !origin.machineId || !origin.target || !origin.externalActionInputSignature
        || origin.actionId !== request.actionId
        // Public creation authenticates proposal authoring. Its installed producer
        // signs the reviewed target/input below; the carrier never authorizes the effect.
        || (authorization.binding.actionId !== request.actionId && authorization.binding.actionId !== 'approval.request.create')
        || (origin.caller.kind === 'session' ? request.createdBy.sessionId !== origin.caller.sessionId
          : origin.caller.kind !== 'host')) return stale('credential_changed');
      const source = await readOriginalAccountActionMachine(accountContext, origin.machineId, signal);
      accountContext.assertCurrent();
      return Boolean(source && source.revokedAt === null && source.replacedByMachineId === null
        && source.installationId === authorization.binding.installationId && source.installationPublicKey
        && verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
          actionId: request.actionId, input: request.actionArgs, target: origin.target,
          ...(request.v === 2 && request.requesterConfirmation ? { requesterConfirmation: request.requesterConfirmation } : {}),
          ...(request.v === 2 && request.executionOriginV1.sessionTargetsV1 ? { sessionTargetsV1: request.executionOriginV1.sessionTargetsV1 } : {}),
          signature: origin.externalActionInputSignature, publicKey: source.installationPublicKey })) || stale('credential_changed');
    },
    sessionFollowPreview: async (args) => sessionFollowAction({ ...args, serverId: args.serverId ?? args.context.serverId, actionId: 'follow.preview' }, followReadInputs),
    readSessionFollowRules: async ({ context, serverId, signal }) => {
      if (!accountContext || !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)
        || context.expectedAccountId && context.expectedAccountId !== accountContext.accountId
        || context.runtimeAccountId && context.runtimeAccountId !== accountContext.accountId) return { kind: 'unavailable' };
      try {
        const assertCurrent = () => { throwIfAborted(signal); accountContext.assertCurrent(); };
        assertCurrent();
        const snapshot = await readSessionFollowRuleInputs(serverId, signal, {
          expectedAccountId: accountContext.accountId, ...(followReadInputs ? { rules: followReadInputs.rules } : {}),
        });
        assertCurrent();
        return snapshot.status === 'ready' ? { kind: 'complete', rules: snapshot.rules } : { kind: 'unavailable' };
      } catch {
        throwIfAborted(signal);
        return { kind: 'unavailable' };
      }
    },
    sessionFollowAction: async (args) => {
      const result = await sessionFollowAction(args, followReadInputs);
      const failed = typeof result === 'object'
        && result !== null
        && 'ok' in result
        && result.ok === false;
      if (args.actionId !== 'follow.set' || failed) return result;

      const serverId = args.serverId ?? args.context.serverId;
      if (!serverId) return result;
      const relation = args.input as SessionFollowActionInputV1['follow.set'];
      if (relation.receiver.kind !== 'session' || relation.source.kind !== 'session'
        || typeof relation.receiver.sessionId !== 'string') return result;
      let preparation: SessionFollowSourceKeyPreparationResultV1;
      try {
        preparation = await prepareSessionFollowSourceKey({
          serverId,
          sourceSessionId: relation.source.sessionId,
          destinationSessionId: relation.receiver.sessionId,
          signal: args.context.signal,
        });
      } catch {
        preparation = { kind: 'waiting', reason: 'runner_unreachable' };
      }
      return projectSessionFollowSourceKeyPreparationAfterSetV1(
        result as Extract<SessionFollowActionOutputV1['follow.set'], { source: { sourceSessionId: string } }>,
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
        const definitions = await widgetDefinitionDeps.widgetDefinitionArtifacts?.summaries([...referenced], signal) ?? [];
        accountContext.assertCurrent();
        const { describeWidgetDefinitionSummaryV1 } = await import('@/components/widgets/widgetCatalog');
        return [...candidates, ...definitions.map(summary => describeWidgetDefinitionSummaryV1(summary,
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
    sessionManagerSet: createSessionManagerAction(accountContext ?? null),
    readAgentHtmlNetworkPolicy: async () => {
      if (!accountContext) return 'ask';
      accountContext.assertCurrent();
      const settings = await accountContext.readSettings();
      accountContext.assertCurrent();
      return settings.agentHtmlNetworkPolicy;
    },
    sessionBoardPrepareItem: prepareSessionBoardItemForUi,
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
        actionId: args.actionId,
        mutationDispatched,
        retirementStatus: executed.status,
        recoveryDetails,
      });
    },
    listContributedActionDefinitions: opts?.listContributedActionDefinitions ?? listCurrentUiContextContributedActionDefinitions,
    readContributedActionSchemas: opts?.readContributedActionSchemas,
    isActionEnabled: (actionId: ActionId, ctx) =>
      {
        if (opts?.isActionEnabled && !opts.isActionEnabled(actionId, ctx)) {
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
    readApprovalProfile: accountContext ? id => readBoundApprovalProfile(accountContext, id) : undefined,
    readActionApprovalProfileId: async context => {
      const caller = context.actionCaller;
      if (caller?.kind !== 'session') return undefined;
      if (!accountContext) return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      // An unreadable caller Session leaves its profile selection unknown: refuse admission, typed.
      const session = await runWithServerRequestAuthorityForServerAccountScope({
        scope: accountContext.accountLifetime.scope, activeRequest: accountContext.request,
      }, authority => readSessionSnapshotForAuthority({ authority, sessionId: caller.sessionId,
        includeTurns: false, signal: context.signal, isCurrent: accountContext.accountLifetime.isCurrent }))
        .then(read => read.session, error => { if (error instanceof SessionSnapshotReadError) return null; throw error; });
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      if (!metadata) return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      const approvalProfileId = resolveSessionApprovalProfileReferenceV1(metadata);
      return { approvalProfileId, approvalProfileTeamOrGroupDerived: metadata.approvalProfileTeamOrGroupDerived === true };
    },
    // Host facts for the shared approval router: the person's settings (with the Source Control
    // preference) and installed Settings declarations' operations, classified like the built-ins.
    readActionsSettings: () => resolveExecutorActionsSettingsV1(readAccountSettingsSnapshot()),
    readSettingsDeclarationOperation: anchor => {
      const settings = accountContext?.readLiveSettings();
      return settings ? readSettingsDeclarationOperation(anchor, settings) : undefined;
    },
    ...createUiExecutionRunActionDeps(accountContext?.accountLifetime.scope, accountContext),
    sessionDelete: createUiSessionDeleteAction(accountContext),
    resolveSessionSpawnAgentInventorySelection: args => resolveSessionSpawnAgentInventorySelectionForActions({ ...args,
      signal: accountContext?.invocationSignal, accountLifetime: accountContext?.accountLifetime }),
    prepareLocalServiceStartApproval: async ({ input, context }) => {
      const unavailable = { ok: false as const, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      if (!accountContext || !context.surface) return unavailable;
      accountContext.assertCurrent();
      const raw = await actionMachineRpc<unknown, unknown>({ serverId: accountContext.serverId, accountId: accountContext.accountId,
        machineId: input.machineId, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
        payload: { machineId: input.machineId, startReview: { request: input, surface: context.surface } },
        ...(context.signal ? { signal: context.signal } : {}) });
      accountContext.assertCurrent();
      const response = DaemonLocalServiceLauncherSnapshotResponseV1Schema.safeParse(raw);
      return response.success && response.data.startReview ? response.data.startReview : unavailable;
    },
    runtimeActionExecute: async (args) => {
      const featureId = getActionRequiredServerFeatureId(args.actionId, args.context, args.input);
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
    uiPetChooseAction: createUiPetChooseAction(accountContext ?? null, opts?.openRoute),
    voiceConversationAction: async ({ actionId, input, context }) => {
      throwIfAborted(context.signal);
      if (!accountContext?.readLiveSettings()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      accountContext.assertCurrent();
      if (actionId === 'ui.voice_global.conversations.list') {
        const { executeVoiceConversationHistoryListAction } = await import('@/voice/history/voiceHistoryActions');
        return executeVoiceConversationHistoryListAction(input,
          () => accountContext.accountLifetime.isCurrent() && !context.signal?.aborted, {
            scope: accountContext.accountLifetime.scope, lifetime: accountContext.accountLifetime, signal: context.signal,
          });
      }
      if (actionId === 'ui.voice_global.say.start' || actionId === 'ui.voice_global.say.stop') {
        const { executeVoiceSpeechAction } = await import('./voiceSpeechAction');
        accountContext.assertCurrent();
        const settings = accountContext.readLiveSettings();
        if (!settings) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        // The Protocol executor admitted this exact Action's closed input before entering this port.
        return await executeVoiceSpeechAction(actionId, input as Parameters<typeof executeVoiceSpeechAction>[1], settings, context.signal, opts?.voiceSpeechSource);
      }
      if (isVoiceHistoryActionId(actionId)) {
        const [{ executeVoiceHistoryAction }, { getDefaultVoiceHistoryConsumer }, { saveVoiceHistoryExportArtifact }] = await Promise.all([
          import('@/voice/history/voiceHistoryActions'), import('@/voice/history/defaultVoiceHistoryConsumer'),
          import('@/voice/history/voiceHistoryExportTarget'),
        ]);
        const isCurrent = () => accountContext.accountLifetime.isCurrent() && !context.signal?.aborted
          && areServerAccountScopesEqual(getActiveServerAccountScope(), accountContext.accountLifetime.scope);
        accountContext.assertCurrent();
        // The Protocol executor admitted this exact action's input before entering the host port.
        return await executeVoiceHistoryAction({ actionId, input } as Parameters<typeof executeVoiceHistoryAction>[0], opts?.voiceHistory ?? {
          consumer: getDefaultVoiceHistoryConsumer(), saveExportArtifact: saveVoiceHistoryExportArtifact,
        }, isCurrent, async sessionId => {
          const child = context.hostReviewedChild;
          if (!child) throw new HappyError('credential_scope_denied', false, { code: 'credential_scope_denied' });
          const result = await child.invoke({ action: 'session.delete', role: 'delete', input: { sessionId } });
          requireActionSuccess(result, 'session.delete');
        });
      }
      const opensMicrophone = actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.recover'
        || actionId === 'ui.voice_global.new_conversation' || actionId === 'ui.voice_global.continue_conversation'
        || (actionId === 'ui.voice_global.set_muted' && input && typeof input === 'object' && 'muted' in input && input.muted === false)
        || actionId === 'ui.voice_global.hold_begin' || actionId === 'ui.voice_global.brief.request'
        || actionId === 'ui.voice_global.brief.retry' || actionId === 'ui.voice_global.dictation.start';
      if (opensMicrophone) {
        const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext.serverId });
        throwIfAborted(context.signal);
        accountContext.assertCurrent();
        const settings = accountContext.readLiveSettings();
        if (!settings || resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'voice', settings, snapshot })?.state !== 'enabled') {
          return { ok: false, errorCode: 'voice_unavailable', error: 'voice_unavailable' };
        }
      }
      if (actionId.startsWith('ui.voice_global.dictation.')) {
        const result = await executeCurrentUiContextAction({ actionId, input, context });
        return result.ok ? result.result : result;
      }
      if (actionId.startsWith('ui.voice_global.brief.')) {
        const { executeVoiceBriefOperationFromUi } = await import('@/components/voice/brief/voiceBriefActionRuntime');
        accountContext.assertCurrent();
        throwIfAborted(context.signal);
        const operation = actionId === 'ui.voice_global.brief.request' ? 'request' : actionId === 'ui.voice_global.brief.retry' ? 'retry'
          : actionId === 'ui.voice_global.brief.close' ? 'close' : 'stop';
        const result = await executeVoiceBriefOperationFromUi(operation, input as Readonly<{ expectedAttemptId?: string }>, async () => {
          const [{ router }, { openWorkspaceHrefOrElse }] = await Promise.all([
            import('expo-router'), import('@/components/appShell/workspace/workspaceActionRuntime'),
          ]);
          accountContext.assertCurrent();
          throwIfAborted(context.signal);
          if (opts?.openRoute) { await opts.openRoute('/'); return; }
          await openWorkspaceHrefOrElse('/', () => router.push('/'));
        });
        return result.ok ? result.result : { ...result, error: result.errorCode };
      }
      const [{ executeVoiceConversationAction }, { router }, { resolveHref }, { openWorkspaceHrefOrElse }] = await Promise.all([
        import('./voiceConversationAction'), import('expo-router'), import('expo-router/build/link/href'),
        import('@/components/appShell/workspace/workspaceActionRuntime'),
      ]);
      accountContext.assertCurrent();
      throwIfAborted(context.signal);
      return await executeVoiceConversationAction(actionId, input, { signal: context.signal, isCurrent: () => accountContext.accountLifetime.isCurrent() && !context.signal?.aborted, navigate: async (href) => {
        accountContext.assertCurrent();
        throwIfAborted(context.signal);
        const destination = href as Parameters<typeof router.push>[0];
        if (opts?.openRoute) { await opts.openRoute(resolveHref(destination)); return; }
        await openWorkspaceHrefOrElse(resolveHref(destination), () => router.push(destination));
      } });
    },
    executeOrdinaryChildAction: ({ actionId, input, context }) => {
      // Mounted commands can return before their modal reads start. Re-enter
      // the ordinary Account lifetime, without the parent's replay admission.
      const { admittedClientActionId: _parentAction, admittedClientActionParent: _parentCustody, ...ordinaryOptions } = opts ?? {};
      return createDefaultActionExecutor(ordinaryOptions).execute(actionId, input, context);
    },
    uiCurrentContextAction: (request) => executeCurrentUiContextAction(request, { execute: executor.execute, context: request.context }),
    accountHomeContinuationAction: (request) => executeCurrentUiContextAction(request),
    sessionAuthoringOpen: args => openSessionAuthoringDraft(args, accountContext ?? undefined, opts?.sessionAuthoringPresentation),
    sessionSpaceMembershipSet: args => setSessionSpaceMembership(args, accountContext ?? undefined),
    invokeContributedAction: (request) => {
      // Nested plugin Actions retain their own exact declaration. Enter the
      // UI front door so preparation binds that catalog, rather than borrowing
      // this protocol executor's already-captured parent catalog.
      const host = createDefaultActionExecutor(opts);
      return executeCurrentUiContextContributedAction(request, {
        execute: Object.assign(host.execute, { prepare: host.prepare }), context: request.context,
      }, accountContext?.accountLifetime);
    },
    uiFindAction: executeFindAction,
    uiPromptPickerOpen: executePromptPickerOpenAction,
    uiPromptPickerAction: executePromptPickerAction,
    uiPromptHistory: executePromptHistoryAction,
    sessionMessagePinsAction: async request => {
      if (!accountContext) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      throwIfAborted(request.context.signal);
      return { ok: true, result: executeSessionMessagePinsAction(accountContext, request.input) };
    },
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
    accountApiTokensCreateAction: async ({ input, signal, context }) => {
      const { prepareApiTokenDeploymentAuthoring } = await import('@happier-dev/protocol/actions/executor/workflowRunActions');
      const prepared = await prepareApiTokenDeploymentAuthoring({ actionId: 'account.apiTokens.create', value: input, context,
        host: await prepareApiTokenAuthoringHost(input.deployment, input.grant?.deployApproval, context) });
      const body = prepared.body.deployment && accountContext?.serverIdentityId
        ? { ...prepared.body, deployment: { ...prepared.body.deployment, serverId: accountContext.serverIdentityId } } : prepared.body;
      return await createCurrentAccountApiToken(body, { ...(signal ? { signal } : {}), ...(accountContext ? { accountContext } : {}) });
    },
    accountApiTokensListAction: async ({ input, signal }) => await listCurrentAccountApiTokens(
      input,
      { ...(signal ? { signal } : {}), ...(accountContext ? { accountContext } : {}) },
    ),
    accountApiTokensRevokeAction: async ({ input, signal }) => await revokeCurrentAccountApiToken(
      input,
      { ...(signal ? { signal } : {}), ...(accountContext ? { accountContext } : {}) },
    ),
    accountApiTokensRevokeAllAction: async ({ input, signal }) => await revokeAllCurrentAccountApiTokens(
      input,
      { ...(signal ? { signal } : {}), ...(accountContext ? { accountContext } : {}) },
    ),
    accountApiTokensUpdateAction: async ({ input, signal, context }) => {
      const { prepareApiTokenDeploymentAuthoring } = await import('@happier-dev/protocol/actions/executor/workflowRunActions');
      const prepared = await prepareApiTokenDeploymentAuthoring({ actionId: 'account.apiTokens.update', value: input, context,
        host: await prepareApiTokenAuthoringHost(input.deployment, input.grant?.deployApproval, context) });
      const body = prepared.body.deployment && accountContext?.serverIdentityId
        ? { ...prepared.body, deployment: { ...prepared.body.deployment, serverId: accountContext.serverIdentityId } } : prepared.body;
      return await updateCurrentAccountApiToken(body, { ...(signal ? { signal } : {}), ...(accountContext ? { accountContext } : {}) });
    },
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
    } : {}),

    workspaceAction: invokeWorkspaceAction,
    workflowAuthoringAction: request => invokeWorkflowAuthoringAction({ ...request,
      context: { ...request.context,
        // Keep the admitted binding, but enter each child's ordinary captured
        // Account/approval lifecycle rather than the parent's lower-level graph.
        ...(opts?.admittedClientActionId ? {
          executeChildAction: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => {
            const parent = opts.admittedClientActionParent;
            const caller = context?.actionCaller;
            // The Machine host admits a non-person caller's Workflow writes; only
            // the daemon holding this Session caller's parent can continue it.
            return parent && caller?.kind === 'session' && context?.authority !== 'present_user'
              && context?.serverId && context.runtimeAccountId && isWorkflowHostAdmittedChildActionIdV1(actionId)
              ? executeAdmittedClientActionChildAtMachine({ parent, serverId: context.serverId,
                accountId: context.runtimeAccountId, sessionId: caller.sessionId, actionId, input,
                ...(context.signal ? { signal: context.signal } : {}) })
              : createDefaultActionExecutor(opts).execute(actionId, input, context);
          },
        } : {}),
      },
    }),
    sessionOrganizationMove: async request => {
      if (!accountContext) return { status: 'unavailable' as const };
      return await invokeSessionListOrganizationAction({
        ...request,
        mutationScope: createSessionOrganizationMutationScopeForAccount(accountContext),
      });
    },
    sessionOrganizationAppearanceSet: async ({ input, signal }) => {
      if (!accountContext) return { ok: false, errorCode: 'action_account_scope_unavailable', error: 'action_account_scope_unavailable' };
      throwIfAborted(signal);
      const scope = createSessionOrganizationMutationScopeForAccount(accountContext);
      if ('sessionId' in input) await writeSessionOrganizationAppearance({ scope, sessionId: input.sessionId, color: input.color });
      else await writeSessionOrganizationWorkspaceDisplay({ scope, workspaceKey: input.workspaceKey, patch: { color: input.color } });
      return { status: 'applied' as const };
    },
    sessionOrganizationPinSet: async ({ sessionId, request, serverId, signal }) => {
      if (!accountContext) return { ok: false, errorCode: 'action_account_scope_unavailable', error: 'action_account_scope_unavailable' };
      if (!serverId || !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      throwIfAborted(signal);
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
    mediaAnnotation: async (args) => {
      const { executeMediaAnnotationAction } = await import('./mediaAnnotationActionRuntime');
      return executeMediaAnnotationAction(args);
    },
    listReorder: executeListReorderAction,
    todoSessionLink: executeTodoSessionLinkAction,
    internalTaskAction: executeInternalTaskHostAction,
    sessionTerminalAction: invokeSessionTerminalAction,
    actionOperationAction: async ({ actionId, input, context, signal }) => {
      try {
        if ((actionId === 'action.operations.list' || actionId === 'action.operations.get') && 'managed' in input && input.managed) {
          if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
          const execution = await executeManagedMachineNativeAction({ account: accountContext, actionId, input, context,
            ...(signal ? { signal } : {}) });
          return execution.ok ? execution.result : execution;
        }
        return await executeActionOperationActionV1({
          actionId, input, ...(signal ? { signal } : {}),
          context: { surface: context.surface, expectedAccountId: accountContext?.accountId },
          transport: async request => await actionMachineRpc({
            ...request,
            ...(actionId === 'action.operations.get' && 'waitForTerminal' in input && input.waitForTerminal
              ? { operationTimeoutMs: null } : {}),
          }),
          openOutput: async address => {
            throwIfAborted(signal);
            accountContext?.assertCurrent();
            if (opts?.actionOperationOpenOutput) {
              await opts.actionOperationOpenOutput(address);
              throwIfAborted(signal);
              accountContext?.assertCurrent();
              return;
            }
            const { openActionOperationDetail } = await import('@/components/inbox/actionOperations/openActionOperationDetail');
            throwIfAborted(signal);
            accountContext?.assertCurrent();
            openActionOperationDetail({ serverId: address.serverId, operationId: address.operationId });
          },
          copyOutput: async output => {
            throwIfAborted(signal);
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
    sessionGoalGet: async ({ sessionId, serverId, signal }) => await withAccountLifetime(signal,
      lifetime => sessionGoalGet(sessionId, { serverId, signal: lifetime })),
    sessionGoalSet: async ({ sessionId, objective, status, tokenBudget, resumeInactiveWithInitialGoal, serverId, signal }) =>
      await withAccountLifetime(signal, lifetime => sessionGoalSet(sessionId, {
        ...(objective !== undefined ? { objective } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(resumeInactiveWithInitialGoal !== undefined ? { resumeInactiveWithInitialGoal } : {}),
      }, { serverId, signal: lifetime })),
    sessionGoalClear: async ({ sessionId, serverId, signal }) => await withAccountLifetime(signal,
      lifetime => sessionGoalClear(sessionId, { serverId, signal: lifetime })),
    sessionUsageLimitWaitResumeEnable: async ({ sessionId, serverId, ...input }) =>
      runUsageLimitRecovery(sessionId, serverId, options => sessionUsageLimitWaitResumeEnable(sessionId, input, options)),
    sessionUsageLimitWaitResumeCancel: async ({ sessionId, serverId, ...input }) =>
      runUsageLimitRecovery(sessionId, serverId, options => sessionUsageLimitWaitResumeCancel(sessionId, input, options)),
    sessionUsageLimitCheckNow: async ({ sessionId, serverId, agentId, resumePromptMode }) =>
      runUsageLimitRecovery(sessionId, serverId, options => sessionUsageLimitCheckNow(sessionId, {
        provider: agentId, resumePromptMode, ...options,
      })),
    sessionUsageLimitSwitchAccountNow: async ({ sessionId, serverId, agentId }) =>
      runUsageLimitRecovery(sessionId, serverId, options => sessionUsageLimitSwitchAccountNow(sessionId, {
        provider: agentId, ...options,
      })),
    sessionUsageLimitConsumeResetCredit: async ({ sessionId, serverId, agentId, issueFingerprint }) =>
      runUsageLimitRecovery(sessionId, serverId, options => sessionUsageLimitConsumeResetCredit(sessionId, {
        provider: agentId, issueFingerprint, ...options,
      })),
    sessionOpen: async ({ sessionId, serverId, presentation, intent, resumeRequest, approvedNewDirectoryCreation, actionRequestId, tabId, destination, signal }, context) => {
      if (presentation === 'overlay') {
        const present = captureMountedDesktopOverlayPresentation();
        if (!present || !serverId) return { ok: false, errorCode: 'unavailable', error: 'desktop_overlay_unavailable' };
        return await present({ sessionId, serverId });
      }
      if (presentation === 'main' && serverId && isDesktopHost()) {
        // The desktop window owner returns a Session window first, or forwards from one to main.
        const { presentDesktopSessionInMain } = await import('@/desktop/window/appWindowRuntime');
        const presented = await presentDesktopSessionInMain({ sessionId, serverId }, signal);
        if (presented?.ok === false) return presented;
        if (presented) return { ok: true, status: 'opened', sessionId, serverId, address: { serverId, sessionId } } as const;
      }
      const comparison = destination ? scmReviewComparisonOfSource(destination.comparison, destination.comparisonId) : null;
      if (destination && !comparison) return { ok: false, errorCode: 'invalid_parameters', error: 'comparison_selector_unavailable' };
      const unavailableReason = destination ? scmReviewViewUnavailableReason(destination.view, comparison) : null;
      if (unavailableReason) return { ok: false, errorCode: unavailableReason, error: unavailableReason };
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
        // Resolve from the fresh exact-Home snapshot, not a same-id row in the focused Home.
        const machineTarget = resolveMachineControlTargetForSessionFromState({
          ...state, sessions: { [sessionId]: session }, sessionListRowsByServerId: {},
        }, { ...accountContext.accountLifetime.scope, sessionId });
        const admittedTarget = context?.admittedMachineTarget;
        if (admittedTarget && (machineTarget?.machineId !== admittedTarget.machineId
          || admittedTarget.serverId && !areServerProfileIdentifiersEquivalent(admittedTarget.serverId, accountContext.serverId))) {
          return { ok: false, errorCode: 'machine_target_mismatch', error: 'machine_target_mismatch' };
        }
        if (session.archivedAt != null) {
          const restored = await sessionUnarchiveWithServerScope(sessionId, {
            authority: { scope: accountContext.accountLifetime.scope, request: accountContext.request },
          });
          if (!restored.success) return { ok: false, errorCode: restored.code ?? 'action_failed',
            error: t('sessionInfo.failedToUnarchiveSession'), details: restored };
        }
        const target = resolveSessionActionDefaultBackend({ session });
        if (intent === 'resume' && !tabId && !destination && machineTarget) {
          const execution = await executeOriginalAccountMachineAction({ account: accountContext, actionId: 'session.open',
            requestId: actionRequestId ?? randomUUID(), machineId: machineTarget.machineId, foreignTargetOnly: true,
            input: { sessionId, serverId: accountContext.serverId, intent: 'resume',
              ...(resumeRequest ? { resumeRequest } : {}),
              ...(approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true } : {}) },
            ...(signal ? { signal } : {}) });
          if (execution) return execution.ok ? execution.result : execution;
        }
        const settings = accountContext.readLiveSettings() ?? accountContext.settings;
        const pluginSettings = await readAgentScopedPluginSettingsSnapshot({
          agentId: target?.defaultAgentId ?? null, machineId: machineTarget?.machineId,
          serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
          accountSettings: settings, signal,
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
        const backgroundAccountLifetime = captureActiveServerAccountScopeLifetime();
        if (target?.defaultAgentId && backgroundAccountLifetime
          && areServerAccountScopesEqual(backgroundAccountLifetime.scope, accountContext.accountLifetime.scope)) {
          fireAndForget(ensureAgentInstallablesBackground({
            agentId: target.defaultAgentId, machineId: base.machineId,
            serverId: accountContext.serverId, settings, resumeSessionId: base.resume ?? null,
            accountLifetime: backgroundAccountLifetime,
          }), { tag: `session.open.installables.${target.defaultAgentId}` });
        }
        const resumed = await resumeSession({
          ...base, ...(resumeRequest ? resumeRequest : {}), serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
          actionContext: context,
          executionAuthority: context?.authority ?? 'account_automation',
          executionAuthorization: { provenance: 'user_request', requestId: actionRequestId ?? randomUUID() },
          ...(approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true } : {}),
          ...(target?.defaultAgentId ? buildResumeSessionExtrasFromUiState({
            agentId: target.defaultAgentId, settings, pluginSettings, session,
          }) : {}),
        });
        accountContext.assertCurrent();
        if (resumed.type === 'error') return { ok: false, errorCode: resumed.rpcErrorCode ?? resumed.errorCode, error: resumed.errorMessage,
          ...(resumed.errorDetail ? { details: { errorDetail: resumed.errorDetail } } : {}) };
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

    sessionRuntimeRefresh: async ({ sessionId, machineId, serverId, mode, providerBindingSecurityChangeConfirmationV1, signal }) => withAccountLifetime(signal, async signal => {
      accountContext?.assertCurrent();
      throwIfAborted(signal);
      const status = await getSessionRunnerRuntimeStatusSnapshotResult({ sessionId, machineId, serverId, signal });
      accountContext?.assertCurrent();
      throwIfAborted(signal);
      if (!('state' in status)) return status;
      const result = mode === 'force_current_cli'
        ? await restartSessionRunnerForProviderBindingChange({ runtimeState: status.state,
          runnerProcessIdentity: status.runnerProcessIdentity, serverId, signal,
          ...(providerBindingSecurityChangeConfirmationV1 ? { providerBindingSecurityChangeConfirmationV1 } : {}) })
        : await restartSessionRunnerOnCurrentRuntime({ runtimeState: status.state, serverId, signal });
      return result ?? { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    }),

    sessionStop: async ({ sessionId, stopIntent, serverId, signal, context }) => {
      // Report Stop and Archive form one UI invocation. Keep the same admission
      // across both effects; its invocation finally also covers Stop/approval failure.
      const operation = opts?.archiveInvocation?.includeReportStops ? claimSessionArchive(sessionId, serverId) : null;
      if (opts?.archiveInvocation?.includeReportStops && !operation) {
        return { ok: false, errorCode: 'archive_pending', error: 'archive_pending' };
      }
      try {
        const result = await withAccountLifetime(signal, signal => sessionStopWithServerScope(sessionId, { serverId, stopIntent, signal, actionContext: context,
          ...(accountContext ? { scope: accountContext.accountLifetime.scope,
            isCurrent: accountContext.accountLifetime.isCurrent } : {}) }));
        if (!result.success && operation) finishOwnedSessionArchive(operation);
        if (result.holdRecorded === false && result.holdFailure) {
          return { ...result, ok: false, errorCode: result.holdFailure, details: result };
        }
        return result;
      } catch (error) {
        if (operation) finishOwnedSessionArchive(operation);
        throw error;
      }
    },

    sessionControlSwitch: async ({ sessionId, to, serverId, signal, context }) => withAccountLifetime(signal, async signal => {
      const switched = await sessionSwitch(sessionId, to, { serverId, signal,
        ...(context.onTransportIssued ? { onIssued: context.onTransportIssued } : {}),
        ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}) });
      return switched === true ? { switched: true } : {
        ok: false, errorCode: 'session_control_unavailable', error: 'session_control_unavailable',
      };
    }),

    sessionArchiveSet: async ({ sessionId, archived, serverId, context }) => {
      const operation = archived ? claimSessionArchive(sessionId, serverId) : null;
      if (archived && !operation) return { ok: false, errorCode: 'archive_pending', error: 'archive_pending' };
      let pendingStop = false;
      try {
        const result = archived
          ? await withAccountLifetime(context?.signal, signal => sessionArchiveWithServerScope(sessionId, { serverId, signal }))
          : await sessionUnarchiveWithServerScope(sessionId, { serverId });
        // The report cascade may now Stop and retry this same Session.
        pendingStop = opts?.archiveInvocation?.includeReportStops === true
          && result.success === false && result.code === 'session_active';
        return result.success ? result : { ok: false, errorCode: result.code ?? 'unknown_error',
          error: result.message ?? 'unknown_error', details: result };
      } finally {
        if (operation && !pendingStop) finishOwnedSessionArchive(operation);
      }
    },

    sessionPermissionModeSet: async ({ sessionId, permissionMode, applyTiming, serverId }) => {
      if (!isPermissionMode(permissionMode) || !accountContext) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      accountContext.assertCurrent();
      const scope = accountContext.accountLifetime.scope;
      if (applyTiming === 'next_prompt') {
        writeExistingSessionDraft({ scope, sessionId, patch: { nextPromptPermissionMode: permissionMode } });
        return { ok: true };
      }
      const address = { kind: 'session' as const, sessionId };
      const currentness = captureSessionDraftCurrentness({ scope, address });
      const isActiveScope = areServerAccountScopesEqual(scope, getActiveServerAccountScope());
      let updatedAt = nowServerMs();
      await applyPermissionModeSelectionEffect({
        sessionId, mode: permissionMode, applyTiming: 'immediate',
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
      clearSessionDraftCurrentnessLocal({ scope, address, currentness,
        fieldIds: ['extensions.happier.nextPromptPermissionModeV1'] });
      return { ok: true };
    },

    sessionCompact: async ({ sessionId, instructions, serverId, signal }) => actionSessionRpc({
      sessionId, serverId, signal, method: SESSION_RPC_METHODS.SESSION_COMPACT,
      payload: { ...(instructions !== undefined ? { instructions } : {}) },
    }),

    sessionTurnCancel: async ({ sessionId, serverId, signal }) => {
      await withAccountLifetime(signal, ownedSignal => sessionAbort(sessionId, { serverId: serverId ?? undefined, signal: ownedSignal }));
      return { requested: true };
    },

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs, serverId }) =>
      await actionSessionRpc({
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

    sessionPendingEdit: accountContext ? createUiPendingEditAction(accountContext, opts?.pendingMessageEditIsCurrent) : undefined,
    sessionPendingSendNow: accountContext ? createUiPendingSendNowAction(accountContext) : undefined,
    sessionPendingRequeue: async ({ sessionId, localId, targetExecutionRunId, context }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      context.signal?.throwIfAborted();
      await sync.restoreDiscardedPendingMessage(sessionId, localId, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
        ...(targetExecutionRunId ? { targetExecutionRunId } : {}),
      });
      return { ok: true };
    },
    sessionPendingActionSet: async ({ sessionId, localId, requestedAction, resumeWhenAvailable, serverId, context }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      return await sync.updatePendingRequestedAction(sessionId, localId, requestedAction, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
        ...(resumeWhenAvailable !== undefined ? { resumeWhenAvailable } : {}), signal: context.signal,
      });
    },
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
    sessionPendingMarkHandled: async ({ sessionId, localId, serverId }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      await sync.markPendingDeliveryHandled(sessionId, localId, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
      });
      return { ok: true };
    },
    sessionPendingDismiss: async ({ sessionId, localId, serverId, targetExecutionRunId }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      await sync.dismissPendingDelivery(sessionId, localId, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
        ...(targetExecutionRunId ? { targetExecutionRunId } : {}),
      });
      return { ok: true };
    },
    sessionPendingSendAsNew: async ({ sessionId, localId, serverId, targetExecutionRunId }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      const newLocalId = await sync.sendPendingDeliveryAsNew(sessionId, localId, {
        serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime,
        ...(targetExecutionRunId ? { targetExecutionRunId } : {}),
      });
      return { newLocalId };
    },
    sessionPendingResetStartSet: async ({ sessionId, localId, serverId, reset, initialInput, context }) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        throw new Error('action_account_scope_changed');
      }
      try {
        if (initialInput) return await sync.enqueuePendingResetStartInput({ sessionId, localId,
          serverId: accountContext.serverId, reset, initialInput }, accountContext.accountLifetime, context.signal);
        return await sync.updatePendingRequestedAction(sessionId, localId, { v: 1, kind: 'reset_start', reset }, {
          serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime, signal: context.signal,
        });
      } catch (error) {
        if (error instanceof Error && 'code' in error) {
          if (error.code === 'reset_start_unsupported' || error.code === 'reset_start_unconfirmed') {
            return ActionExecuteFailureSchema.parse({ ok: false, errorCode: error.code, error: error.code });
          }
          if (error.code === 'reset_start_unavailable' && 'reason' in error) {
            const reason = PendingResetStartWaitingReasonV1Schema.safeParse(error.reason);
            if (reason.success) return ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'reset_start_unavailable',
              error: 'reset_start_unavailable', details: { reason: reason.data } });
          }
        }
        throw error;
      }
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
      await actionSessionRpc({
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

    sessionRollback: async ({ sessionId, serverId, target, signal }) => {
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
      return await withAccountLifetime(signal, ownedSignal => rollbackSessionConversationOp({
        sessionId: sid,
        serverId,
        target: resolvedTarget,
        currentAgentCapabilities: opts?.currentAgentCapabilities,
        signal: ownedSignal,
      }));
    },

    checkpointCodeRollback: async ({ request, serverId, signal }) =>
      await withAccountLifetime(signal, ownedSignal => rollbackSessionCheckpointCodeOp({ request, serverId, signal: ownedSignal })),

    sessionHandoffTargetReplacementApprovalPreflight: async ({
      targetMachineId,
      targetPath,
      workspaceAction,
      activatesExactMirror,
      destinationIntent,
      replaceRelationshipId,
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
      ...(replaceRelationshipId ? { replaceRelationshipId } : {}),
      ...(signal ? { signal } : {}),
    }),

    workspaceSyncRelationshipsList: async ({ input, signal }) => await listWorkspaceSyncRelationshipsOnController({
      input, account: accountContext, ...(signal ? { signal } : {}),
    }),
    ...createUiWorkspaceSyncReadActionDeps(accountContext),
    workspaceSyncRelationshipObserveCreation: request => observeWorkspaceSyncRelationshipCreationOnController({ ...request, account: accountContext }),

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

    workspaceSyncRelationshipTerminate: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext?.assertCurrent();
      await terminatePersistedWorkspaceSyncRelationship({
        serverId: scope.serverId,
        controllerMachineId: input.controllerMachineId,
        relationshipId: input.relationshipId,
        ...(signal ? { signal } : {}),
      });
      return { v: 1 as const, relationshipId: input.relationshipId, terminated: true as const };
    },

    workspaceSyncRelationshipDisable: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext.assertCurrent();
      await disableWorkspaceSyncRelationship({ serverId: scope.serverId, ...input, ...(signal ? { signal } : {}) });
      return { v: 1 as const, relationshipId: input.relationshipId, enabled: false as const };
    },

    workspaceSyncRelationshipEnable: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext.assertCurrent();
      await enableWorkspaceSyncRelationship({ serverId: scope.serverId, ...input, ...(signal ? { signal } : {}) });
      return { v: 1 as const, relationshipId: input.relationshipId, enabled: true as const };
    },

    workspaceSyncRelationshipFlush: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext.assertCurrent();
      const status = await flushWorkspaceSyncRelationship({ serverId: scope.serverId, ...input, ...(signal ? { signal } : {}) });
      return { v: 1 as const, relationshipId: input.relationshipId, status };
    },

    ...createUiSessionHandoffRecoveryActionDeps(actionMachineRpc, accountContext ?? null),
    sessionHandoffStart: async ({
      sessionId,
      targetMachineId,
      targetPath,
      targetSessionStorageMode,
      stateTransfer,
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
        ...(stateTransfer ? { stateTransfer } : {}),
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

    ...(accountContext && homeDomainAction ? { prepareSessionSpawnNewInput: createUiPrepareSessionSpawnNewInput({
      createLoader: context => createUiManagedSessionDefaultsContextLoader(accountContext, homeDomainAction, context),
      readSettings: async () => readAccountSettingsSnapshot(),
      resolveDefaultAgentTarget: async executionTarget => {
        const inventory = await deps.agentsBackendsList!(executionTarget ? { machineId: executionTarget.machineId } : {});
        const selected = inventory.items.find(item => item.targetKey === inventory.defaultTargetKey)?.agentTarget;
        if (!selected) throw createActionExecuteFailureError({ ok: false,
          errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE, error: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
          details: { reason: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE, recoveryAction: 'open_settings' }, effectAttempted: false });
        return selected;
      },
      bindPreset: async (placement, context) => {
        const bound = await prepareUiManagedPresetAcquire({ account: accountContext,
          selection: { kind: 'preset', homeId: placement.homeId, id: placement.presetId },
          requestId: context.actionRequestId ?? randomUUID(), signal: context.signal,
          resolvePool: async input => {
            const result = await executor.execute('machines.pools.resolve', input, context);
            if (!result.ok) throw createActionExecuteFailureError(result);
            return result.result;
          },
        });
        if (bound.kind === 'refused') throw createActionExecuteFailureError({ ok: false, errorCode: bound.code, error: bound.code, effectAttempted: false });
        return { input: bound.input, ...(bound.controllerAccess ? { controllerAccess: bound.controllerAccess } : {}) };
      },
      resolveConnectedServices: async (intent, target, executionTarget, context) => {
        if (intent.kind === 'default') return undefined;
        const args = { agentId: resolveBundledAgentIdFromContributionIdentity(target.identity) ?? undefined,
          backendTargetKey: buildBackendTargetKeyV2(target), machineId: executionTarget.machineId,
          serverId: accountContext.serverId, signal: context.signal };
        const selection = await resolveSpawnConnectedServicesSelectionInContext(accountContext, args);
        if (!selection) throw createActionExecuteFailureError({ ok: false, errorCode: 'unknown_agent', error: 'unknown_agent', effectAttempted: false });
        return await resolveConnectedServicesLaunchAuthWithInventory({ intent, supportedServiceIds: selection.supportedServiceIds,
          listInventory: () => listSpawnConnectedServicesInContext(accountContext, args, selection) }) ?? undefined;
      },
    }) } : {}),
    sessionSpawnNewDirectoryApprovalPreflight: createUiSessionSpawnNewDirectoryApprovalPreflight(accountContext ?? null),
    sessionSpawnNew: async (args, continuation) => {
      const {
        context,
        admittedInput,
        creationKey,
      } = args;
      if (!admittedInput) return { type: 'error' as const, code: 'invalid_input' as const, retryable: false as const };
      if (continuation) {
        if (!accountContext) return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
        const result = await createUiPreparedSessionBirthV1(accountContext, args, continuation);
        if (result.type === 'error') await refreshMachineAgentsAfterLaunchRefusal({
          accountLifetime: accountContext.accountLifetime, machineId: admittedInput.executionTarget.machineId,
          target: admittedInput.agentTarget, failureCode: 'launchError' in result ? result.launchError?.code ?? result.code : result.code,
          signal: args.signal,
        });
        return result;
      }
      // The admitted input is the canonical (folderId) shape; the forwarder consumes the Action shape.
      return forwardSessionSpawnNew(projectSessionSpawnNewActionInputV2({ ...admittedInput, creationKey }), context ?? {});
    },

    presentUserActionConfirmation: accountContext
      ? createActionConfirmationPresenter(accountContext, { presentUserActionConfirmation: opts?.presentUserActionConfirmation, accountRoleAction })
      : undefined,

    // Refuse before consent is recorded when the daemon replay below needs the
    // person and this sign-in cannot be one (a terminal credential), so the Ask
    // stays open for a reviewer. The CLI host supplies the same refusal.
    ...(accountContext && accountContext.credentialAuthorityKind !== 'account' ? {
      approvalRequestApproveRefusal: ({ request }) => resolveApprovalExecutor(request).kind === 'daemon'
        && !(request.actionId === 'plugins.install' && readPluginInstallApprovalPendingReview(request.preview))
        ? { ok: false, errorCode: 'present_user_required', error: 'present_user_required', effectAttempted: false } : null,
    } satisfies Pick<ActionExecutorDeps, 'approvalRequestApproveRefusal'> : {}),

    approvalRequestApprovedReplay: async ({ artifactId, request, decision, context, requestId, signal, onReplayDispatched }) => {
      try {
      const requesterDecision = readApprovalRequesterDecisionV1(request, decision);
      if (requesterDecision) {
        const { subject, decision } = requesterDecision;
        const route = resolveApprovalReplayRoute(request);
        if (!accountContext || (context.surface !== 'ui' && context.surface !== 'voice') || context.authority !== 'present_user'
          || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
          || context.actionCaller && context.actionCaller.kind !== 'host'
          || subject.requesterAccountId !== accountContext.accountId) {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        if (!route || route.serverIdentityId !== accountContext.serverIdentityId) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        accountContext.assertCurrent();
        onReplayDispatched?.();
        const result = await actionSessionRpc<unknown, { artifactId: string; sessionId: string; decision: 'approve' | 'reject' | 'cancel'; decisionSource?: 'voice' }>({
          serverId: accountContext.serverId, sessionId: subject.personaSessionRef.sessionId,
          method: RPC_METHODS.APPROVAL_REQUEST_DECIDE,
          // Private authenticated transport metadata, not caller-authored Action input.
          payload: { artifactId, sessionId: subject.personaSessionRef.sessionId, decision,
            ...(context.surface === 'voice' ? { decisionSource: 'voice' as const } : {}) }, timeoutMs: null,
          ...(signal ? { signal } : {}),
        });
        accountContext.assertResultCurrent(getActionSpec('approval.request.decide').sideEffectClass);
        const settled = getActionSpec('approval.request.decide').outputSchema?.safeParse(result);
        if (settled?.success) return { ok: true, result: settled.data };
        const failure = ActionExecuteFailureSchema.safeParse(result);
        return failure.success ? failure.data : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
      }
      if (request.v !== 2) return null;
      const executor = resolveApprovalExecutor(request);
      if (executor.kind === 'unavailable') {
        return { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' };
      }
      if (executor.kind === 'live_invocation') {
        if (decision === 'reject' || decision === 'cancel') return null;
        if (approvalCoordinator.getLiveWaiterCount(artifactId) > 0
          && accountContext && (context.surface === 'ui' || context.surface === 'voice') && context.authority === 'present_user'
          && !context.externalActionCredential && !context.externalActionExecutionAuthorization
          && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host')) return null;
        const liveCliReplay = await replayLiveCliApproval({ account: accountContext ?? null, artifactId, request,
          decision, context, requestId, signal, onReplayDispatched });
        if (liveCliReplay) return liveCliReplay;
        // The canonical destination names only an original daemon invocation;
        // an absent app closure cannot transfer its private lifetime to a Machine.
        if (!executor.daemonMachineId) {
          return { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' };
        }
      }
      if (executor.kind === 'app') {
        // Returning null resumes the single Protocol replay owner, including its
        // Artifact CAS and live-only result projection, on this captured app.
        if (request.v === 2 && request.executionOriginV1.externalActionExecutionAuthorization
          && (!accountContext || (context.surface !== 'ui' && context.surface !== 'voice') || context.authority !== 'present_user'
            || context.externalActionCredential || context.externalActionExecutionAuthorization
            || context.rpcSessionAuthorization || context.actionCaller && context.actionCaller.kind !== 'host')) {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        return null;
      }
      const replayRoute = resolveApprovalReplayRoute(request);
      const machineId = executor.kind === 'daemon' ? executor.machineId : executor.daemonMachineId;
      if (!replayRoute || !machineId) {
        return {
          ok: false,
          errorCode: 'approval_origin_unavailable',
          error: 'approval_origin_unavailable',
        };
      }
      if (request.actionId === 'plugins.install'
        && readPluginInstallApprovalPendingReview(request.preview)) {
        // The exact daemon retained and evaluated this install candidate. Replay
        // its approved Artifact there directly; issuing another decision Action
        // would create a second decision boundary and never settle the candidate.
        onReplayDispatched?.();
        return await replayApprovedApprovalRequestAtExactDaemon({
          artifactId,
          executionTarget: { ...replayRoute, machineId },
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (accountContext && request.v === 2 && !context.externalActionCredential
        && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization
        && (!context.actionCaller || context.actionCaller.kind === 'host')) {
        // Only the person can carry this decision to the origin daemon; nothing about the request changed.
        if (!requestId || (context.surface !== 'ui' && context.surface !== 'voice') || context.authority !== 'present_user') {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        const execution = await executeOriginalAccountMachineAction({ account: accountContext,
          actionId: 'approval.request.decide', requestId, machineId,
          onTransportIssued: () => onReplayDispatched?.(),
          input: { artifactId, decision: decision ?? 'approve',
            serverIdentityId: replayRoute.serverIdentityId, originServerId: replayRoute.originServerId },
          ...(signal ? { signal } : {}) });
        accountContext.assertResultCurrent(getActionSpec('approval.request.decide').sideEffectClass);
        if (execution) return execution;
      }
      if (decision === 'approve') {
        onReplayDispatched?.();
        const replay = ActionExecuteResultSchema.safeParse(await replayApprovalRequestAtExactDaemon({
          artifactId, decision, executionTarget: { ...replayRoute, machineId },
          ...(signal === undefined ? {} : { signal }),
        }));
        return replay.success ? replay.data
          : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
      }
      onReplayDispatched?.();
      return await replayApprovedApprovalRequestAtExactDaemon({
        artifactId,
        executionTarget: { ...replayRoute, machineId },
        ...(signal === undefined ? {} : { signal }),
      });
      } catch (error) {
        if (readRpcRequestDisposition(error) === 'notSent') onReplayDispatched?.(false);
        throw error;
      }
    },

    machineRecipesRead: createUiMachineRecipesRead(accountContext),
    pathsListRecent: async ({ machineId, limit }) => await listRecentPathsForVoiceTool({ machineId, limit }),
    projectDefinitionAction: createUiProjectDefinitionAction(accountContext),
    projectAction: createUiProjectAction(accountContext),
    projectsContextUpdate: createUiProjectContextAction(accountContext),
    projectsWorkspaceUpdate: async (input, context) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      return createUiProjectAccountRowsClient(accountContext).updateWorkspace({ ...input, signal: context?.signal }, context);
    },
    projectsServicesPin: async (input, context) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const result = await createUiProjectAccountRowsClient(accountContext).setEnvironmentPinned({ ...input, signal: context?.signal }, context);
      return result.ok ? { ok: true, pinnedEnvironmentIds: [...result.pinnedEnvironmentIds] } : result;
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
    projectsPagesList: createUiProjectPagesList(accountContext),
    projectWorkspaceRefs: async (args, context) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (!canUsePrivateProjectAccountAction(accountContext, context)) return { ok: false, errorCode: 'project_account_access_denied', error: 'project_account_access_denied' };
      if (args.serverId !== undefined && !areServerProfileIdentifiersEquivalent(args.serverId, accountContext.serverId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const rows = await createUiProjectAccountRowsClient(accountContext).read(context?.signal);
      if (rows.status !== 'ready') return { ok: false, errorCode: 'project_account_rows_unavailable', error: 'project_account_rows_unavailable' };
      // The same visible, ordered checkouts the Projects list shows.
      return { workspaceRefs: projectProjectListV1({ serverId: accountContext.serverId, workspaceRefs: rows.workspaceRefs,
        organizations: rows.organizations, normalizeServerId: resolveServerProfileScopeIdForIdentifier }).items.map(item => item.ref) };
    },
    projectsOrganizationUpdate: async (input, context) => {
      if (!accountContext || !canUsePrivateProjectAccountAction(accountContext, context)) return { ok: false, errorCode: 'project_organization_access_denied' };
      const rows = createUiProjectAccountRowsClient(accountContext);
      return updateProjectOrganizationV1({
        normalizeServerId: resolveServerProfileScopeIdForIdentifier,
        accountScope: () => {
          try { accountContext.assertCurrent(); return { serverId: accountContext.serverId, accountId: accountContext.accountId }; }
          catch { return null; }
        }, mutateOrganization: rows.mutateOrganization, mutateSessionDefaults: rows.mutateSessionDefaults,
      }, input, context);
    },
    projectsVisibilitySet: async (input, context) => {
      if (!accountContext || !canUsePrivateProjectAccountAction(accountContext, context)) return { ok: false, errorCode: 'project_visibility_access_denied' };
      return setProjectVisibilityV1({
        normalizeServerId: resolveServerProfileScopeIdForIdentifier,
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
          return await completeUiProjectOpenResult(accountContext, execution.result, context.signal);
        }
      }
      try {
        const response = await actionMachineRpc({
          serverId: input.serverId,
          machineId: input.machineId,
          accountId: accountContext?.accountId,
          method: RPC_METHODS.PROJECTS_OPEN,
          payload: input,
          requestId: context.actionRequestId ?? undefined,
          signal: context.signal,
          operationTimeoutMs: null,
        });
        return await completeUiProjectOpenResult(accountContext, response, context.signal);
      } catch (error) {
        if (readRpcRequestDisposition(error) === 'notSent') return { kind: 'refused', code: 'machine_unreachable' };
        throw error;
      }
    },
    ...(accountContext ? createProjectSourceActionDeps(accountContext) : {}),
    ...(accountContext && homeDomainAction
      ? createUiProjectSessionDefaultsActionDeps(accountContext, homeDomainAction) : {}),
    ...(projectSourceTeamMove ? { projectSourcesMoveToTeam: projectSourceTeamMove.projectSourcesMoveToTeam } : {}),
    ...deploymentActionDeps,
    promptInvocationsList: async (args) => {
      if (!accountContext) return listPromptInvocationsForActions(args);
      const projection = await readPromptLibraryCatalogProjectionInContext(accountContext);
      const source = readPromptLibraryCatalogRecordV1({ ...projection, key: 'invocations' });
      return listPromptInvocationsForActions(args, { invocations: source.status === 'ready' ? source.record.value : null,
        ...(source.status === 'ready' ? { revision: source.revision } : {}),
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
      ? readUiProfileCatalogSnapshot(await readProfileCatalogProjectionInContext(accountContext)) : undefined),
    machinesList: async args => {
      accountContext?.assertCurrent();
      const result = await listMachinesForVoiceTool(args);
      accountContext?.assertCurrent();
      return result;
    },
    ...createMachineConnectionActionDeps({ ...(accountContext ? { account: accountContext } : {}), runner: opts?.homeRuntimeRunner,
      homePairingDelivery: opts?.homePairingDelivery }),
    serversList: async ({ limit }) => await listServersForVoiceTool({ limit }),
    readAccountAcpCatalog,
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
      const result = await listReviewEnginesForVoiceTool({ sessionId, machineId, includeDisabled, scope, serverId: accountContext.serverId,
      }, accountContext);
      accountContext.assertCurrent();
      return result;
    },
    reviewCommentAction: async ({ actionId, input, signal }) => {
      try {
        const result = await executeReviewCommentAction(actionId, input, signal ? { signal } : undefined);
        if (accountContext) {
          accountContext.assertCurrent();
          // The HTTP transport has already opened and validated these exact response schemas.
          // Keep loaded review projections current without a second read or a disposition write.
          if (actionId === 'reviews.comments.list') {
            recordReviewCommentReads((result as ReviewCommentListResponseV1).items, accountContext.accountLifetime.scope);
          } else if (actionId === 'reviews.comments.get') {
            recordReviewCommentReads([(result as ReviewCommentGetResponseV1).comment], accountContext.accountLifetime.scope);
          }
        }
        return result;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'review_comment_encryption_mode_mismatch') {
          return { ok: false, errorCode: error.code, error: error.code };
        }
        throw error;
      }
    },
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
    ...(opts?.machineVitalsAction ?? capturedFamilyPorts?.machineVitalsAction
      ? { machineVitalsAction: opts?.machineVitalsAction ?? capturedFamilyPorts!.machineVitalsAction }
      : {}),
    ...(opts?.machineStorageAction ?? capturedFamilyPorts?.machineStorageAction
      ? { machineStorageAction: opts?.machineStorageAction ?? capturedFamilyPorts!.machineStorageAction }
      : {}),
    ...(opts?.machineGuardAction ?? capturedFamilyPorts?.machineGuardAction
      ? { machineGuardAction: opts?.machineGuardAction ?? capturedFamilyPorts!.machineGuardAction }
      : {}),
    ...(opts?.machineScheduledAction ?? capturedFamilyPorts?.machineScheduledAction
      ? { machineScheduledAction: opts?.machineScheduledAction ?? capturedFamilyPorts!.machineScheduledAction }
      : {}),
    ...(opts?.machineProcessesAction ?? capturedFamilyPorts?.machineProcessesAction
      ? { machineProcessesAction: opts?.machineProcessesAction ?? capturedFamilyPorts!.machineProcessesAction }
      : {}),
    ...(opts?.machineServiceAction ?? capturedFamilyPorts?.machineServiceAction
      ? { machineServiceAction: opts?.machineServiceAction ?? capturedFamilyPorts!.machineServiceAction }
      : {}),
    ...(opts?.machineServiceControl ?? capturedFamilyPorts?.machineServiceControl
      ? { machineServiceControl: opts?.machineServiceControl ?? capturedFamilyPorts!.machineServiceControl }
      : {}),
    ...(opts?.machineServiceLogsRead ?? capturedFamilyPorts?.machineServiceLogsRead
      ? { machineServiceLogsRead: opts?.machineServiceLogsRead ?? capturedFamilyPorts!.machineServiceLogsRead }
      : {}),
    ...(opts?.machineResourcesPolicyAction ?? capturedFamilyPorts?.machineResourcesPolicyAction
      ? { machineResourcesPolicyAction: opts?.machineResourcesPolicyAction ?? capturedFamilyPorts!.machineResourcesPolicyAction }
      : {}),
    ...(opts?.machineRolesAction ?? capturedFamilyPorts?.machineRolesAction
      ? { machineRolesAction: opts?.machineRolesAction ?? ((args: Parameters<NonNullable<ActionExecutorDeps['machineRolesAction']>>[0]) => args.context.invocationServices?.managedContinuation
        ? executeMachineOwnedAction(args) : capturedFamilyPorts!.machineRolesAction(args)) }
      : {}),
    ...(opts?.machineIsolationAction ?? capturedFamilyPorts?.machineIsolationAction
      ? { machineIsolationAction: opts?.machineIsolationAction ?? capturedFamilyPorts!.machineIsolationAction }
      : {}),
    ...(opts?.machineAdminAccessAction ?? capturedFamilyPorts?.machineAdminAccessAction
      ? { machineAdminAccessAction: opts?.machineAdminAccessAction ?? capturedFamilyPorts!.machineAdminAccessAction }
      : {}),
    ...(opts?.machineAgentIsolationAction ?? capturedFamilyPorts?.machineAgentIsolationAction
      ? { machineAgentIsolationAction: opts?.machineAgentIsolationAction ?? capturedFamilyPorts!.machineAgentIsolationAction }
      : {}),
    ...(opts?.machineReboot ?? capturedFamilyPorts?.machineReboot
      ? { machineReboot: opts?.machineReboot ?? capturedFamilyPorts!.machineReboot }
      : {}),
    ...(capturedFamilyPorts ? { skillMachineActionExecute: capturedFamilyPorts.skillMachineActionExecute } : {}),
    ...(machineAccessAction
      ? { machineAccessAction }
      : {}),
    ...(opts?.discussionAction ?? capturedFamilyPorts?.discussionAction
      ? { discussionAction: opts?.discussionAction ?? capturedFamilyPorts!.discussionAction }
      : {}),
    ...(homeDomainAction ? { homeDomainAction } : {}),
    ...(accountContext ? { privateLabelOpen: createPrivateLabelActionOpener(accountContext),
      privateLabelPrepare: createPrivateLabelActionPreparer(accountContext) } : {}),
    ...(accountContext && homeDomainAction ? {
      teamCredentialUsageExport: createUiTeamCredentialUsageExportAction(accountContext, homeDomainAction),
    } : {}),
    ...(accountContext && (opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction)
      ? { personalSavedSecretActionExecute: createUiPersonalSavedSecretActionExecute(accountContext,
        (opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction)!) } : {}),
    ...(opts?.teamMembershipHistoryAction ?? capturedFamilyPorts?.teamMembershipHistoryAction
      ? { teamMembershipHistoryAction: opts?.teamMembershipHistoryAction ?? capturedFamilyPorts!.teamMembershipHistoryAction } : {}),
    ...(opts?.savedSecretRevealAction ? { savedSecretRevealAction: opts.savedSecretRevealAction } : {}),
    ...(capturedFamilyPorts ? { savedSecretRepairAction: capturedFamilyPorts.savedSecretRepairAction } : {}),
    homeRuntimeTaskRpc: async ({ machineId, method, request, context }) => {
      if (!accountContext) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      accountContext.assertCurrent();
      try {
        return await actionMachineRpc({ machineId, serverId: accountContext.serverId,
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
    ...(accountContext ? { accountLifecycleAction: (args: Parameters<NonNullable<ActionExecutorDeps['accountLifecycleAction']>>[0]) =>
      settleAccountSecurityAction(() => createUiAccountLifecycleAction(accountContext, async path => {
        if (opts?.openRoute) await opts.openRoute(path);
        else {
          const [{ router }, { openWorkspaceHrefOrElse }] = await Promise.all([
            import('expo-router'), import('@/components/appShell/workspace/workspaceActionRuntime'),
          ]);
          await openWorkspaceHrefOrElse(path, () => router.replace(path as never));
        }
      })(args)) } : {}),
    ...(opts?.workspaceSyncConflictResolve ? { workspaceSyncConflictResolve: opts.workspaceSyncConflictResolve } : {}),
    ...(accountContext ? { managedMachineReferences: createUiManagedMachineReferenceReader(accountContext),
      machineRebootReferences: async ({ input, cursor, signal }) => {
        accountContext.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(accountContext.serverId, input.serverId)) throw new Error('server_target_mismatch');
        const page = await createUiMachineDeploymentReferenceReader(accountContext)({
          homeId: accountContext.serverIdentityId ?? input.serverId, machineId: input.machineId, ...(cursor ? { cursor } : {}),
        }, signal);
        accountContext.assertCurrent();
        return page;
      },
    } : {}),
    managedMachineAction: async (args) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      accountContext.assertCurrent();
      if (args.actionId === 'machines.provisioners.list') {
        const input = ManagedMachineActionInputSchemasV1[args.actionId].parse(args.input);
        if (!input.controller) {
          if (input.homeId !== accountContext.serverIdentityId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          return await executeUiManagedProvisionerList(accountContext, input, args.signal);
        }
      }
      if (args.actionId !== 'machines.managed.list' && args.actionId !== 'machines.managed.get'
        && args.actionId !== 'machines.managed.setup.skip' && args.actionId !== 'machines.managed.birth.get') {
        try {
          const execution = await executeManagedMachineNativeAction({ account: accountContext, ...args,
            resolvePresetPool: input => executor.execute('machines.pools.resolve', input, args.context) });
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
    machineSetupPlan: async (args) => await deps.managedMachineAction!({ actionId: 'machines.setup.plan', ...args }),
    machineSetupApply: async (args) => await deps.managedMachineAction!({ actionId: 'machines.setup.apply', ...args }),
    machineSetupRemove: async (args) => await deps.managedMachineAction!({ actionId: 'machines.setup.remove', ...args }),
    machineSetupUpdatesApply: async (args) => await deps.managedMachineAction!({ actionId: 'machines.setup.updates.apply', ...args }),
    machineSetupUpdatesRollout: async (args) => await deps.managedMachineAction!({ actionId: 'machines.setup.updates.rollout', ...args }),
    machinePresetArchive: async (args) => {
      if (!accountContext?.serverIdentityId) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      return await executeUiMachinePresetArchive(args, accountContext);
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
          return { ok: false, errorCode: error.errorCode, error: error.message };
        }
        throw error;
      }
    },
    // Personal Machine Pools use the same captured Account/Home transport, feature decision,
    // enablement and approval lifetime as every other immediate scoped Action.
    machinePoolAction: async (args) => {
      if (!accountContext) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      accountContext.assertCurrent();
      const snapshot = await getServerFeaturesSnapshot({ serverId: accountContext.serverId });
      const settings = accountContext.readLiveSettings() ?? accountContext.settings;
      if (resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'machines.pools', settings, snapshot })?.state !== 'enabled') {
        return { ok: false, errorCode: 'machine_pools_unavailable', error: 'machine_pools_unavailable' };
      }
      try {
        const wire = await createMachinePoolActionClient({ request: accountContext.request }).execute(args.actionId, args.input, {
          serverId: accountContext.serverId, ...(args.signal ? { signal: args.signal } : {}),
        });
        const labels = createMachinePoolPrivateLabelClientForAccount(accountContext);
        const opened = await openMachinePoolActionOutputV1(wire, view => openMachinePoolPrivateViewV1({
          view, labels, ...(args.signal ? { signal: args.signal } : {}),
        }));
        accountContext.assertCurrent();
        return opened;
      } catch (error) {
        if (error instanceof MachinePoolActionError) {
          return { ok: false, errorCode: error.detail?.code ?? 'machine_pool_request_failed', error: error.message, details: error.detail };
        }
        throw error;
      }
    },
    ephemeralRunnerAction: createUiEphemeralRunnerAction(accountContext),
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
        accountLifetime: accountContext.accountLifetime, acpCatalogSnapshot: catalog,
        backendEnabledByTargetKey: preferences.backendEnabledByTargetKey ?? null });
    },
    workspaceFilesReplacePreview: async ({ machineId, ...request }, context) => {
      try {
        const response = await actionMachineRpc({ machineId, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW,
          payload: request, serverId: context.serverId, accountId: accountContext?.accountId,
          operationTimeoutMs: null, ...(context.signal ? { signal: context.signal } : {}) });
        const parsed = DaemonWorkspaceFileReplacePreviewResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'workspace_file_replace_unavailable', error: 'invalid_response' };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        const code = classifyWorkspaceFileRpcError(error);
        return { ok: false, errorCode: code === 'method_unavailable' ? 'update_required' : 'workspace_file_replace_unavailable', error: code };
      }
    },
    workspaceFilesReplace: createUiWorkspaceFileReplaceAction(accountContext),
    languageIntelligenceQuery: ({ machineId, request }, context) => machineLanguageIntelligenceQuery(machineId, request, {
      serverId: context.serverId, accountId: accountContext?.accountId, signal: context.signal,
    }),
    languageIntelligenceApply: createUiLanguageIntelligenceApplyAction(accountContext),
    languageIntelligenceRestart: ({ machineId, request }, context) => machineLanguageIntelligenceRestart(machineId, request, {
      serverId: context.serverId, accountId: accountContext?.accountId, signal: context.signal,
    }),
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
      const catalog = await loadDaemonMergedProjectionCacheEntry({ machineId: args.machineId,
        serverId: args.serverId, signal: context.signal, accountLifetime: accountContext?.accountLifetime, reuseFreshReady: true,
        sections: ['automationEligibleEvents'],
      });
      if (catalog?.kind !== 'ready' || catalog.inputs.automationEligibleEvents === undefined) {
        return { ok: false, errorCode: 'workflow_event_catalog_unavailable', error: 'workflow_event_catalog_unavailable' };
      }
      return { machineId: args.machineId, events: projectAutomationEligibleEventsCatalogV1(catalog.inputs.automationEligibleEvents) };
    },
    machinePluginProjectionRead: async (args, context) => {
      if (!accountContext) return null;
      const projection = await loadDaemonMergedProjectionInputs({ machineId: args.machineId,
        serverId: args.serverId ?? accountContext.serverId, accountLifetime: accountContext.accountLifetime,
        signal: args.signal ?? context.signal, sections: ['agentsById', 'familiesById.providers'] });
      accountContext.assertCurrent();
      return projection?.pluginProjectionV2 ?? null;
    },
    machinesAgentsList: async (args, context) => {
      const catalog = args.draftDefinitions ? { definitions: args.draftDefinitions }
        : projectAcpCatalogForMachineInventory(await readAccountAcpCatalog({ signal: context.signal }));
      const includesConfiguredDefinitions = !args.agentId
        || agentRoutingIdAddressesContributionIdentityV1(args.agentId, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1);
      const definitions = catalog.definitions?.filter(definition => includesConfiguredDefinitions
        && (!args.definitionId || definition.definitionId === args.definitionId)) ?? [];
      // Executable-only draft probes need no plugin roster and never carry env material.
      const roster = args.draftDefinitions ? { supported: true as const, projection: { agentsById: {} } }
        : await machineContributionRegistryProjectionDescribe(args.machineId, {
        serverId: args.serverId,
        selection: 'agents',
        signal: context.signal,
        accountLifetime: accountContext?.accountLifetime,
      });
      if (!roster.supported) {
        return { ok: false, errorCode: 'machine_agent_inventory_unavailable', error: 'machine_agent_inventory_unavailable' };
      }
      const agents = buildMachineAgentInventoryDescriptors({ pluginProjectionV2: roster.projection, definitions })
        .filter(({ agentId, definitionId }) => (!args.agentId
          || buildMachineAgentInventoryKey({ agentId: args.agentId, definitionId }) === buildMachineAgentInventoryKey({ agentId, definitionId }))
          && (!args.definitionId || args.definitionId === definitionId));
      const inventory = { definitions, ...('definitionCatalog' in catalog && catalog.definitionCatalog
        ? { definitionCatalog: catalog.definitionCatalog } : {}) };
      if (agents.length === 0) return { items: [], ...('definitionCatalog' in inventory
        ? { definitionCatalog: inventory.definitionCatalog } : {}) };
      try {
        const response = await actionMachineRpc({
          machineId: args.machineId,
          serverId: args.serverId,
          method: RPC_METHODS.CAPABILITIES_DETECT,
          payload: buildMachineAgentsDetectRequest({ agents, ...inventory, refresh: args.refresh }),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        accountContext?.assertCurrent();
        return projectMachineAgentsDetectResponse({ agents, ...inventory, response });
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
    machineAgentSignInStatus: async ({ machineId, serverId, signal, agentId }) => {
      if (!accountContext) return await checkAgentSignInRpc({ machineId, serverId, signal }, agentId);
      const { executeAgentSignInLifecycle } = await import('@/agents/machineAgents/signIn/useAgentSignIn');
      return await executeAgentSignInLifecycle({ machineId, serverId: accountContext.serverId, agentId,
        lifetime: accountContext.accountLifetime, signal }, 'status');
    },
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
    machineAgentInstallStart: async ({ machineId, signal, context, ...request }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      accountContext.assertCurrent();
      throwIfAborted(signal);
      if (request.waitForTerminal) {
        if (!context) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const result = await executeMachineOwnedAction({ actionId: 'machines.agents.install', context,
          input: { machineId, agentId: request.agentId, intent: request.intent, consent: request.consent,
            ...(request.definitionId === undefined ? {} : { definitionId: request.definitionId }),
            ...(request.force === undefined ? {} : { force: request.force }), waitForTerminal: true } });
        return readActionFailureEnvelope(result) ?? DaemonAgentInstallStartResponseSchema.parse(result);
      }
      const scope = accountContext.accountLifetime.scope;
      const item = request.intent === 'update' && request.definitionId === undefined
        ? readCurrentMachineUpdateItem(scope, machineId, { kind: 'agent-cli', agentId: request.agentId }) : null;
      if (item && item.action.kind !== 'run') return { ok: false, errorCode: 'update_target_unavailable', error: 'update_target_unavailable' };
      const options = { consent: request.consent, ...(request.force === undefined ? {} : { force: request.force }),
        ...(request.expectedDefinitionVersion === undefined ? {} : { expectedDefinitionVersion: request.expectedDefinitionVersion }) };
      const job = item ? await startMachineAgentItemUpdate(item, scope, options)
        : await startAgentInstallJob({ ...scope, machineId, agentId: request.agentId,
            ...(request.definitionId === undefined ? {} : { definitionId: request.definitionId }) }, request.intent, options);
      return { ok: true, jobId: job.jobId };
    },
    machineAgentInstallRead: async ({ machineId, jobId, cursor, waitForTerminal, context }) => {
      if (!context) throw new Error('not_authenticated');
      const result = await executeMachineOwnedAction({ actionId: 'machines.agents.install.status', context,
        input: { machineId, jobId, cursor, ...(waitForTerminal === undefined ? {} : { waitForTerminal }) } });
      return readActionFailureEnvelope(result) ?? DaemonAgentInstallReadResponseSchema.parse(result);
    },
    machineAgentInstallCancel: async ({ machineId, jobId, context }) => {
      if (!context) throw new Error('not_authenticated');
      const result = await executeMachineOwnedAction({ actionId: 'machines.agents.install.cancel', context, input: { machineId, jobId } });
      return readActionFailureEnvelope(result) ?? DaemonAgentInstallCancelResponseSchema.parse(result);
    },
    agentsModelsList: async (args) => {
      if (args.purpose === 'scm_diff_summary') {
        if (!accountContext || !args.machineId) return { items: [], source: 'unavailable' };
        const { readScmDiffSummaryModelCatalogForMachine } = await import('./scmDiffSummarySettingsCatalog');
        const catalog = await readScmDiffSummaryModelCatalogForMachine(accountContext, args.machineId, args.signal);
        return catalog ? { items: [], scmDiffSummaryCatalog: catalog } : { items: [], source: 'unavailable' };
      }
      if (args.probe) {
        const target = await resolveNativeInventoryProbeTarget(args);
        if (!target || !args.machineId) return { items: [], source: 'unavailable' };
        const result = await probeAgentModelsForActions({ ...args, machineId: args.machineId, probe: args.probe }, target);
        accountContext?.assertCurrent();
        if ('ok' in result && result.ok === false) return result;
        if (args.includeProviderProjection && args.backendTargetKey) {
          const { describeProviderModels } = await import('@/providers/actions/client');
          const projection = await describeProviderModels({ machineId: args.machineId, serverId: args.serverId ?? accountContext?.serverId ?? null,
            agentTargetKey: args.backendTargetKey, mode: 'picker' }).catch(() => null);
          accountContext?.assertCurrent();
          return { ...result, providerProjection: projection?.status === 'success'
            && projection.agentTargetKey === args.backendTargetKey ? projection : null };
        }
        return result;
      }
      const { agentId, machineId, serverId, limit, backendTargetKey, signal } = args;
      return await listAgentModelsForVoiceTool({ agentId, machineId, serverId, limit, backendTargetKey, signal });
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
    spawnConnectedServicesList: async (args, context) => await listSpawnConnectedServicesForActions({ ...args, signal: context?.signal }),

    sessionContinuationInspect: async ({ input, context, serverId }) => {
      const machineId = resolveSessionMachineId(input.sessionId, serverId);
      if ('selections' in input) {
        return { status: 'batch', inspections: machineId
          ? await readSessionContinuationsOnMachine({ ...input, machineId, serverId: serverId ?? null, signal: context.signal })
          : input.selections.map(() => ({ status: 'indeterminate' as const })) };
      }
      if (!machineId) return { status: 'indeterminate' };
      return await readSessionContinuationOnMachine({ ...input, machineId, serverId: serverId ?? null, signal: context.signal });
    },
    sessionAgentTransition: async ({ request, context, serverId }) => {
      if (!accountContext) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
      const machineId = resolveSessionMachineId(request.sessionId, serverId);
      if (!machineId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'session'
          || context.externalActionTarget.sessionId !== request.sessionId)) {
        return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
      }
      const { v: _version, ...input } = request;
      return await createUiAccountAction({ account: accountContext })({ actionId: 'session.agent.transition', input,
        context: { ...context, serverId: accountContext.serverId, runtimeAccountId: accountContext.accountId,
          externalActionTarget: { kind: 'machine', machineId } },
      });
    },
    sessionSendMessage: async (args) => {
      const targetFailure = opts?.admitSessionMessageTarget?.(args);
      if (targetFailure) return targetFailure;
      if (opts?.sessionSendMessage) return opts.sessionSendMessage(args);
      const { sessionId, message, serverId, recipient, requestedAction, displayText, messageMeta, permissionModeOverride, localId, signal } = args;
      const requiresReplyCustody = args.reply === 'wait' || args.reply === 'return' || args.wait === true;
      const authoredStructuredInput = args.authoredInput && 'message' in args.authoredInput ? args.authoredInput.structuredInput : undefined;
      const requiresTargetInputAdmission = authoredStructuredInput?.reviewComments !== undefined
        || authoredStructuredInput?.sessionAttachments !== undefined;
      const composerSubmission = opts?.sessionMessageComposerSubmission;
      if (composerSubmission && (!composerSubmission.isCurrent() || signal?.aborted)) {
        return { ok: false, errorCode: 'session_account_scope_retired', error: 'session_account_scope_retired' };
      }
      if (composerSubmission || requiresReplyCustody || requiresTargetInputAdmission || args.modelOverride !== undefined || args.providerConnectionId !== undefined
          || args.idempotencyKey !== undefined || args.attachments !== undefined || args.source !== undefined) {
        if (!args.authoredInput) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        // Dispatch has resolved the exact Home. Borrow its Account for
        // reply/input custody; the remote Action still authorizes the
        // resolved target and requester.
        const ownedAccount = !accountContext && serverId
          ? await captureLazyActionAccountContext(serverId, signal) : null;
        const account = accountContext ?? ownedAccount;
        if (!account) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        try {
          if (ownedAccount) assertExpectedActionAccount(account, args.context);
          account.assertCurrent();
          const { readSessionSnapshotForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
          const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
          const { resolveMachineControlTargetForSessionFromState } = await import('@/sync/domains/session/resolveMachineTargetForSessionFromState');
          const { session } = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope,
            activeRequest: account.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId,
              isCurrent: account.accountLifetime.isCurrent }));
          account.assertCurrent();
          throwIfAborted(signal);
          const target = resolveMachineControlTargetForSessionFromState({ ...storage.getState(),
            sessions: { [sessionId]: session }, sessionListRowsByServerId: {} }, { ...account.accountLifetime.scope, sessionId });
          if (!target) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
          if (requiresReplyCustody) {
            const machines = await withActionAccountRequestSignal(account, signal, ownedSignal => readMachineRows({
              readTransport: account.readTransport, request: (path, init) => account.request(path, { ...init, signal: ownedSignal }),
              machineIds: [target.machineId], signal: ownedSignal }));
            account.assertCurrent();
            throwIfAborted(signal);
            const row = machines.get(target.machineId);
            const machine = row?.revokedAt === null && row.replacedByMachineId === null ? row : null;
            if (!supportsMachineOperationProtocolCapabilityV1(machine?.operationProtocolCapabilities, 'sessionMessageReply')) {
              return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
            }
          }
          // Relay the validated authored variant, not its local text/metadata projection.
          let input = { ...args.authoredInput, sessionId };
          const context: ActionExecutorContext = { ...args.context, actionCaller: args.actionCaller ?? args.context.actionCaller,
            serverId: account.serverId, runtimeAccountId: account.accountId,
            externalActionTarget: { kind: 'machine', machineId: target.machineId } };
          const execute = createUiAccountAction({ account });
          let advertisedInputSchema: object;
          try {
            advertisedInputSchema = await readSessionMessageInputSchema({ account, session,
              machineId: target.machineId, context, signal });
            account.assertCurrent();
            throwIfAborted(signal);
            if (!supportsSessionMessageInputJsonSchema(advertisedInputSchema, input)) {
              return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
            }
          } catch {
            throwIfAborted(signal);
            account.assertCurrent();
            return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
          }
          if (composerSubmission?.legacyAttachments && 'message' in input) {
            if (!localId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            const { uploadSessionMessageAttachmentDrafts } = await import('@/components/sessions/attachments/uploadSessionMessageAttachmentDrafts');
            const uploaded = await uploadSessionMessageAttachmentDrafts({
              target: { serverId: account.serverId, accountId: account.accountId, sessionId },
              executionTarget: { serverId: account.serverId, machineId: target.machineId },
              drafts: composerSubmission.legacyAttachments.drafts, config: composerSubmission.legacyAttachments.config,
              onUploadedDraftCheckpoint: composerSubmission.legacyAttachments.onUploadedDraftCheckpoint,
              messageLocalId: localId, ...(signal ? { signal } : {}),
              isCurrent: () => account.accountLifetime.isCurrent() && composerSubmission.isCurrent(),
            });
            if (!uploaded) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
            if ('ok' in uploaded) return uploaded;
            const { reconcileBrowserContextPictures } = await import('@/sync/domains/session/input/browserContext');
            input = { ...input, message: composerSubmission.legacyAttachments.originalMessage,
              structuredInput: { v: 1, ...input.structuredInput, sessionAttachments: uploaded.map(attachment => attachment.attachmentHandle),
                ...(input.structuredInput?.browserContext ? { browserContext: reconcileBrowserContextPictures(input.structuredInput.browserContext, uploaded) } : {}) } };
          }
          let preparedAttachments: Awaited<ReturnType<typeof import('@/sync/domains/transfers/ops/prepareTargetComposerAttachments').prepareTargetComposerAttachments>> = null;
          if (composerSubmission && 'message' in input && input.structuredInput?.composerAttachments?.length) {
            if (!localId || !composerSubmission.isCurrent() || signal?.aborted) {
              return { ok: false, errorCode: 'session_account_scope_retired', error: 'session_account_scope_retired' };
            }
            const { prepareTargetComposerAttachments } = await import('@/sync/domains/transfers/ops/prepareTargetComposerAttachments');
            preparedAttachments = await prepareTargetComposerAttachments({
              attachments: input.structuredInput.composerAttachments,
              sourceComposerRef: composerSubmission.sourceComposerRef,
              targetComposerRef: { kind: 'session', sessionId },
              executionTarget: { serverId: account.serverId, machineId: target.machineId },
              messageLocalId: localId, signal, isCurrent: () => account.accountLifetime.isCurrent() && composerSubmission.isCurrent(),
            });
            if (!preparedAttachments) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
            const { RawIngressStructuredInputV1Schema } = await import('@happier-dev/protocol/runtime/input/structuredInputV1');
            input = { ...input, structuredInput: RawIngressStructuredInputV1Schema.parse({
              ...input.structuredInput, composerAttachments: preparedAttachments.attachments,
            }) };
            if (!composerSubmission.isCurrent() || !account.accountLifetime.isCurrent() || signal?.aborted) {
              await preparedAttachments.releaseOnRejection();
              return { ok: false, errorCode: 'session_account_scope_retired', error: 'session_account_scope_retired' };
            }
          }
          if (!supportsSessionMessageInputJsonSchema(advertisedInputSchema, input)) {
            await preparedAttachments?.releaseOnRejection();
            return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
          }
          const result = await execute({ actionId: 'session.message.send', input, context, ...(signal ? { signal } : {}) });
          const failure = ActionExecuteFailureSchema.safeParse(result);
          if (failure.success && failure.data.errorCode === 'session_attachment_upload_checkpoint_stale'
            && composerSubmission?.legacyAttachments && localId && 'message' in input) {
            composerSubmission.legacyAttachments.onUploadedDraftCheckpointStale({
              target: { serverId: account.serverId, accountId: account.accountId, sessionId },
              executionTarget: { serverId: account.serverId, machineId: target.machineId }, messageLocalId: localId,
              handles: input.structuredInput?.sessionAttachments ?? [],
            });
            await preparedAttachments?.releaseOnRejection();
            return result;
          }
          const { SessionMessageSendResultV1Schema } = await import('@happier-dev/protocol/sessions/messages/sessionInputAdmission');
          const receipt = SessionMessageSendResultV1Schema.safeParse(result);
          if (preparedAttachments && receipt.success && (receipt.data.status === 'rejected'
            || receipt.data.status === 'alreadyAccepted' || receipt.data.status === 'replied')) {
            await preparedAttachments.releaseOnRejection();
          }
          return result;
        } finally {
          ownedAccount?.dispose();
        }
      }
      const delivery = await withAccountLifetime(signal, lifetimeSignal => sendSessionMessageWithServerScope({
        sessionId,
        message,
        messageLocalId: localId,
        serverId,
        recipient,
        requestedAction,
        displayText,
        metaOverrides: permissionModeOverride ? { ...messageMeta, permissionMode: permissionModeOverride } : messageMeta,
        ...(args.callerSurface === 'voice' ? { hostAdmissionOrigin: 'voice' as const } : {}),
        signal: lifetimeSignal,
      }));
      return projectServerScopedSessionSendMessageResult(delivery);
    },

    sessionAttentionSet: async ({ sessionId, request, serverId }) => accountContext
      ? await setSessionAttentionStanding({ ...createSessionOrganizationMutationScopeForAccount(accountContext), sessionId, ...request })
      : await executeSessionAttentionSetAction({ sessionId, request, serverId: serverId ?? null }),

    sessionApprovalReviewerSet: async ({ sessionId, enabled, serverId }) => {
      await sync.patchSessionMetadataWithRetry(sessionId, (metadata) => writeSessionApprovalReviewerOverrideV1(metadata, enabled), {
        serverId: serverId ?? null,
        ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}),
      });
      return { updated: true };
    },

    sessionStateFieldSet: async (write) => {
      const { sessionId, fieldId, value, actionId, context, serverId } = write;
      const sid = String(sessionId ?? '').trim();
      if (!sid) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      const updatedAt = Date.now();
      throwIfAborted(context.signal);
      if (fieldId === 'intent.voicePreference' && value !== null) {
        const builtIn = readBuiltInSessionVoiceDeclarationV1(value.providerContributionId);
        const entry = createDefaultVoiceProviderRegistry().get(value.providerContributionId);
        const declaration = builtIn ?? (entry?.kind === 'voice.conversation-provider.v1' ? entry.declaration : undefined);
        const providerConfig = builtIn ? Object.fromEntries((builtIn.settings?.fields ?? []).map(field => [field.id, field.default ?? null]))
          : entry?.providerSettings?.defaultConfig;
        if (!declaration || !providerConfig) return { ok: false, errorCode: 'override_unsupported', error: 'override_unsupported' };
        const admitted = admitDeclaredSessionVoicePreferenceV1({ providerContributionId: value.providerContributionId,
          declaration, providerConfig, preference: value });
        if (admitted.kind === 'unavailable') return { ok: false, errorCode: admitted.reason, error: admitted.reason };
      }
      if (fieldId === 'intent.context') {
        await withUiPromptLibraryArtifactReader(reader => admitSessionContextIntentV1(value, reader.readArtifactHeader), {
          serverId, signal: context.signal, accountContext,
        });
        throwIfAborted(context.signal);
      }
      const result = await writeUiSessionStateField({
        sessionId: sid, fieldId,
        value: fieldId === 'display.title' ? { title: String(value), updatedAt } : value,
        metadataReason: `ui-${actionId}`,
        expectedMetadataRevision: 'expectedMetadataRevision' in write ? write.expectedMetadataRevision : undefined,
        expectedValue: 'expectedValue' in write ? write.expectedValue : undefined,
        updateSessionMetadataWithRetry: async (targetSessionId, updater) => {
          throwIfAborted(context.signal);
          let committedRevision: number | undefined;
          await sync.patchSessionMetadataWithRetry(targetSessionId, (metadata, metadataRevision) => {
            throwIfAborted(context.signal);
            return updater(metadata, metadataRevision);
          }, { serverId: serverId ?? null,
            ...(fieldId === 'display.title' ? { mutationIntent: 'rename_session' as const } : {}),
            ...(accountContext ? { accountLifetime: accountContext.accountLifetime,
              ...(accountContext.prepareRequest ? { prepareRequest: accountContext.prepareRequest } : {}) } : {}),
            onMetadataCommitted: (revision) => { committedRevision = revision; },
            // Field conflict detection lives in the shared registered updater.
          });
          if (committedRevision === undefined) throw new Error('Session metadata acknowledgement is unavailable');
          return { version: committedRevision };
        },
      });
      if (!result.ok) return { ok: false, errorCode: result.reason, error: result.reason };
      return { ok: true, sessionId: sid, ...(fieldId === 'display.title' ? { title: value, updatedAt }
        : fieldId === 'display.statusReason' ? { reason: value }
        : fieldId === 'display.bot' ? { bot: value } : fieldId === 'display.botFace' ? { face: value }
        : fieldId === 'intent.memoryEnabled' ? { enabled: value }
        : fieldId === 'intent.voicePreference' ? { preference: value }
        : fieldId === 'intent.approvalProfileId' ? { approvalProfileId: value }
        : fieldId === 'intent.context' ? { updated: true } : { showToolCalls: value }), version: result.version };
    },

    sessionPermissionRespond: async ({ sessionId, requestId, turnId, decision, nativeChoice, serverId, mode, reason, answers, answerDetails, allowedTools, updatedPermissions, execPolicyAmendment, signal, context }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const request = buildSessionPermissionRespondRpcParamsV1({
        id: reqId, decision, ...(turnId ? { turnId } : {}),
        ...(nativeChoice === undefined ? {} : { nativeChoice }),
        ...(mode === undefined ? {} : { mode }),
        ...(reason === undefined ? {} : { reason }),
        ...(answers === undefined ? {} : { answers }),
        ...(answerDetails === undefined ? {} : { answerDetails }),
        ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
        ...(updatedPermissions === undefined ? {} : { updatedPermissions }),
        ...(execPolicyAmendment === undefined ? {} : { execPolicyAmendment }),
      });
      try {
        await withAccountLifetime(signal, ownedSignal => sessionRespondToPermission(sessionId, request, {
          serverId: serverId ?? undefined, signal: ownedSignal,
        }));
      } catch (error) {
        return projectSessionInteractionRpcFailure(error);
      }
      // Native selections settle from the host's validated stored response and its pushed state.
      if (request.nativeChoice) return { ok: true };
      // A received effect receipt stays true for its invoker after retirement;
      // only the local feedback belongs to the still-current Account.
      if (accountContext?.accountLifetime.isCurrent() === false) return { ok: true };
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
        if (accountContext?.accountLifetime.isCurrent() === false) return { ok: true };
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
        const result = await actionSessionRpc({
          sessionId: args.input.sessionId,
          serverId: args.serverId,
          method: args.actionId,
          payload: args.input,
          signal: args.signal,
        });
        return args.signal?.aborted ? rejectUnavailable('canceled') : result;
      } catch (error) {
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        throw error;
      }
    },
    sessionUserActionAnswer: async ({ sessionId, requestId, answers, disposition, decision, reason, updatedPermissions, serverId, signal, context }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const normalizedAnswers = buildSessionUserActionAnswerMap(answers);
      const answerDetails = buildSessionUserActionAnswerDetails(answers);
      if (disposition !== 'pass_up' && !decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId };
      }
      const approved = decision ? decision === 'approve' : true;
      try {
        return projectSessionInteractionRpcResult(await withAccountLifetime(signal, ownedSignal => sessionRespondToUserAction(sessionId, disposition === 'pass_up' ? {
          id: reqId, disposition,
          ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        } : {
          id: reqId,
          approved,
          ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
          ...(Object.keys(answerDetails).length > 0 ? { answerDetails } : {}),
          ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
        }, { serverId: serverId ?? undefined, signal: ownedSignal,
        })));
      } catch (error) {
        return projectSessionInteractionRpcFailure(error);
      }
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
    sessionConfigOptionSet: createUiSessionConfigOptionAction(accountContext ?? undefined),
    ...createUiSessionCapabilityActionDeps(accountContext ?? undefined),
    sessionConnectedServicesAuthSet: setSessionConnectedServiceAuthBinding,
    sessionModelUnarm: async ({ sessionId, serverId, context }) => {
      accountContext?.assertCurrent();
      const transition = SessionModelTransitionResultV1Schema.parse(await actionSessionRpc({
        sessionId, serverId, method: SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
        payload: { v: 1, unarm: true }, signal: context.signal,
      }));
      return transition.ok ? transition : projectSessionModelTransitionFailure(transition);
    },
    ...(accountContext ? { modelFavoriteSet: (input, context) => accountContext.mutateRawSettings(
      raw => setModelFavoriteV1(raw, input), { signal: context.signal, observeOutcome: true }),
    } : {}),
    sessionModelSet: async (args) => {
      const { sessionId, modelId, providerConnectionId, serverId } = args;
      if (args.captureBefore || args.expected) accountContext?.assertCurrent();
      if (args.teamCredentialModel !== undefined && (args.captureBefore || args.expected)) {
        return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
      }
      const normalizedSessionId = String(sessionId ?? '').trim();
      const normalizedModelId = readNonBlankOpaqueIdentifier(modelId) ?? '';
      if (!normalizedSessionId || (!normalizedModelId && args.teamCredentialModel === undefined)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }

      const session = storage.getState().sessions[normalizedSessionId] ?? null;
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      const teamCredentialModel = args.teamCredentialModel ?? (
        Object.prototype.hasOwnProperty.call(args, 'providerConnectionId') ? null
          : resolveAmbientTeamCredentialModelForModelIntent(readSessionOwnerMetadataView(session), normalizedModelId)
      );
      if (teamCredentialModel) {
        if (args.captureBefore || args.expected) return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
        accountContext?.assertCurrent();
        if (args.callerInputConstraints && !isModelRefGrantedV1(args.callerInputConstraints, 'automatic')) {
          return { ok: false, errorCode: 'model_not_granted', error: 'model_not_granted' };
        }
        const requested = teamCredentialModel;
        const target = resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session }));
        if (!target || buildBackendTargetKeyV2(target) !== requested.agentTargetKey) {
          return { ok: false, errorCode: 'model_selection_agent_target_unknown', error: 'model_selection_agent_target_unknown' };
        }
        const observedActive = session.active === true;
        const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 0, ref: {
          source: 'team_resource', resourceId: requested.resourceId, teamId: requested.teamId,
          expectedResourceRevision: requested.expectedResourceRevision, deliveryMode: requested.deliveryMode,
          agentTargetKey: requested.agentTargetKey, modelId: requested.modelId,
          ...(requested.nativeDelivery ? { nativeDelivery: requested.nativeDelivery } : {}),
        } });
        const candidate = createModelIntentV2MetadataCasCandidate({ selection });
        const uncommitted = () => ({
          ok: false, errorCode: 'team_resource_active_transition_unsupported', error: 'team_resource_active_transition_unsupported',
          details: { status: 'team_resource_active_transition_unsupported', reason: 'session_activated_before_team_resource_commit' },
        });
        try {
          await sync.patchSessionMetadataWithRetry(normalizedSessionId, candidate.update, {
            serverId, ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}),
            ...(observedActive ? {} : { sessionExpectation: { kind: 'inactive_model_intent' } }),
            teamCredentialBinding: {
              operation: 'session.model.set',
              teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: requested.resourceId,
                expectedResourceRevision: requested.expectedResourceRevision, deliveryMode: requested.deliveryMode, teamId: requested.teamId,
                ...(requested.nativeDelivery ? { nativeDelivery: requested.nativeDelivery } : {}) }],
              ...(args.teamVisibilityGrantConsent ? { teamVisibilityGrantConsent: args.teamVisibilityGrantConsent } : {}),
            },
          });
          const state = candidate.readState();
          if (!state.accepted || state.updatedAt === null) return uncommitted();
          const isAmbientBrokeredNextPrompt = args.teamCredentialModel === undefined
            && requested.deliveryMode === 'brokered' && args.applyTiming === 'next_prompt';
          if (observedActive && !isAmbientBrokeredNextPrompt) {
            return { ok: false, errorCode: 'restart_required', error: 'restart_required', details: {
              status: 'restart_required', reason: 'team_resource_binding_changed', requestedTeamSelection: requested,
            } };
          }
          return { ok: true, status: 'intent_updated', sessionId: normalizedSessionId,
            selection: { ...selection, updatedAt: state.updatedAt }, updatedAt: state.updatedAt };
        } catch (error) {
          if (isInactiveModelIntentSessionActiveError(error)) return uncommitted();
          throw error;
        }
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
          ...(args.applyTiming ? { applyTiming: args.applyTiming } : {}),
          ...(args.captureBefore !== undefined ? { captureBefore: args.captureBefore } : {}),
          ...(args.expected ? { expected: args.expected } : {}),
          selection: {
            agentTargetKey,
            providerConnectionId: resolvedProviderConnectionId,
            modelId: normalizedModelId,
          },
        });
        return parsed.success && 'selection' in parsed.data
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
        request: Extract<SessionModelTransitionRequestV1, { selection: unknown }>,
      ) => {
        if (args.expected?.owner === 'inactive') {
          return { ok: false, errorCode: 'superseded', error: 'superseded' };
        }
        let transition: SessionModelTransitionResultV1;
        try {
          const result = await actionSessionRpc<
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
          return projectSessionModelTransitionFailure(transition);
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
              ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}),
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
    sessionRead: createUiSessionRead(accountContext),
    sessionStatusGet: createUiSessionStatusGet(accountContext),
    readSessionManager: async ({ address, signal }) => {
      if (!accountContext || !areServerProfileIdentifiersEquivalent(address.serverId, accountContext.serverId)) return { kind: 'unavailable' };
      try {
        const { readSessionSnapshotForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
        const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({ scope: accountContext.accountLifetime.scope,
          activeRequest: accountContext.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId: address.sessionId,
            isCurrent: accountContext.accountLifetime.isCurrent }));
        accountContext.assertCurrent();
        throwIfAborted(signal);
        const managerSessionId = readSessionManagerSessionIdV1(session);
        return { kind: 'manager', address: managerSessionId ? { serverId: accountContext.serverId, sessionId: managerSessionId } : null };
      } catch { return { kind: 'unavailable' }; }
    },
    sessionMessageReply: async ({ sessionId, requestLocalId, reply, reviewDecision, context, serverId, signal }) => {
      if (!accountContext || (serverId && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId))) {
        return { v: 1, ok: false, error: 'unavailable' };
      }
      accountContext.assertCurrent();
      if (reply) {
        const result = await actionSessionRpc({ sessionId, serverId: accountContext.serverId,
          method: SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY, payload: { sessionId, requestLocalId, reply }, signal });
        accountContext.assertResultCurrent(getActionSpec('session.message.reply').sideEffectClass);
        return result;
      }
      // Review settles the captured original input without publishing an Agent answer.
      if (context.authority !== 'present_user') return { v: 1, ok: false, error: 'forbidden' };
      return executeSessionMessageReplyReview(accountContext, { sessionId, requestLocalId, reviewDecision, signal });
    },
    sessionExchangePrepare: async ({ sessionId, originInputLocalId, serverId, signal }) => {
      if (!accountContext || (serverId && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId))) return null;
      try { return (await readSessionExchangeStatus(accountContext, sessionId, originInputLocalId, signal)).observedRevision; }
      catch { return null; }
    },
    sessionExchangeControl: async ({ sessionId, originInputLocalId, request, serverId, signal }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (serverId && !areServerProfileIdentifiersEquivalent(serverId, accountContext.serverId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const response = await accountContext.request(`/v2/sessions/${encodeURIComponent(sessionId)}/exchanges/${encodeURIComponent(originInputLocalId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}) });
      accountContext.assertCurrent();
      if (!response.ok) {
        const code = response.status === 409 ? 'exchange_revision_conflict' : response.status === 403 ? 'forbidden'
          : response.status === 404 ? 'not_found' : 'exchange_unavailable';
        return { ok: false, errorCode: code, error: code };
      }
      const parsed = AutonomousExchangeStatusV1Schema.safeParse(await response.json());
      accountContext.assertCurrent();
      return parsed.success ? parsed.data : { ok: false, errorCode: 'exchange_unavailable', error: 'exchange_unavailable' };
    },
    sessionActivityGet: async (params) => await getSessionActivityForVoiceTool(params),
    sessionEventsGet: async (_params, invocation) => {
      if (!accountContext) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
      return await createUiAccountAction({ account: accountContext })(invocation);
    },
    sessionTranscriptGet: async (input) => {
      // Natural Voice references acquire their exact Home at the target resolver,
      // after the outer executor's Account capture. Borrow that resolved Home's
      // canonical lifetime here; focus and attempt-local state confer no authority.
      let captured: LazyActionAccountContext | undefined;
      try {
        if (!accountContext && input.serverId) captured = await captureLazyActionAccountContext(input.serverId, input.signal);
        const account = accountContext ?? captured;
        if (!account) return { ok: false, errorCode: 'admission_unavailable', errorMessage: 'admission_unavailable' };
        assertExpectedActionAccount(account, input.context);
        account.assertCurrent();
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const result = input.context.surface === 'voice'
          ? await getSessionTranscriptForVoiceTool(input, scope)
          : await readSessionTranscriptForAction(input, scope);
        account.assertCurrent();
        return result;
      } catch (error) {
        if (isActionAccountScopeChangedError(error)) return { ok: false, errorCode: 'action_account_scope_changed', errorMessage: 'action_account_scope_changed' };
        if (error instanceof ActionAdmissionHomeUnreachableError) return { ok: false, errorCode: 'server_unreachable', errorMessage: 'server_unreachable' };
        throw error;
      } finally {
        captured?.dispose();
      }
    },
    sessionRecentMessagesGet: async ({ sessionId, serverId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) =>
      await getSessionRecentMessagesForVoiceTool({ sessionId, serverId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }),

    resetGlobalVoiceAgent: async () => {
      await resetVoiceAgentPersistenceState({
        stop: async () => await voiceSessionManager.stop(VOICE_AGENT_GLOBAL_SESSION_ID),
      });
    },
    teleportVoiceAgentToSessionRoot: async ({ sessionId }) => await teleportVoiceAgentToSessionRoot({ sessionId }),

    searchConversations: async ({ input: { retryUnreachableMachines, ...input }, context }) => {
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
      return await searchConversationsForAccount({ ...input, providers, retryUnreachableMachines,
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
        const result = await actionMachineRpc<MemoryWindowV1, MemoryWindowRequestV1>({ machineId, serverId: exactServerId,
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
        return await actionMachineRpc<MemoryWindowV1, MemoryWindowRequestV1>({
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
      await actionMachineRpc({
        machineId,
        serverId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        payload: sessionId ? { sessionId } : {},
      }),

    daemonMemoryClearIndex: async ({ machineId, signal }) => {
      if (!accountContext) throw new Error('Exact Account context is unavailable');
      accountContext.assertCurrent();
      await clearDaemonMemoryIndex({
        machineId,
        serverId: accountContext.serverId,
        accountId: accountContext.accountId,
        ...(signal ? { signal } : {}),
      });
      return { ok: true };
    },

    approvalsList: accountContext ? args => listApprovalArtifactsV1({ ...args,
      readPage: options => accountContext.workflowArtifacts.list(options),
      read: async artifactId => {
        const artifact = await accountContext.fetchArtifact(artifactId);
        return artifact?.header ? { header: artifact.rawHeader ?? artifact.header, body: artifact.body, updatedAt: artifact.updatedAt } : null;
      },
    }) : undefined,

    approvalsCreate: async ({ request }) => {
      const scope = accountContext?.accountLifetime.scope ?? getActiveServerAccountScope();
      if (!scope) throw new Error('approval_origin_unavailable');
      const context = accountContext ?? await captureLazyActionAccountContext(scope.serverId);
      const created = await createApprovalArtifact({ request, accountId: scope.accountId,
        read: artifactId => context.readArtifact(artifactId, { fresh: true, ownerOnly: true }),
        create: async (artifactId, header, body, idScope) => (await context.createArtifactDocument({ artifactId, header, body, idScope })).artifact,
      });
      approvalCoordinator.notifyApprovalUpdated(created);
      return created;
    },

    approvalsGet: approvalArtifacts.get,

    approvalsUpdate: updateApprovalArtifact,

    targetActionApprovalReplay: createUiTargetActionApprovalReplay({
      account: accountContext ?? null,
      hasLocalInvocation: artifactId => approvalCoordinator.getLiveWaiterCount(artifactId) > 0,
      read: async (artifactId, initialRead) => {
        const parsed = TargetActionApprovalRequestV1Schema.safeParse(initialRead
          ? initialRead.request : await deps.approvalsGet?.({ artifactId, serverId: null }));
        return parsed.success ? parsed.data : null;
      },
      update: updateApprovalArtifact,
    }),

    executionRunHostActionApprovalReplay: accountContext ? createExecutionRunHostApprovalReplay({
      read: artifactId => accountContext.fetchArtifact(artifactId, { fresh: true }),
      decide: async ({ sessionId, artifactId, decision, signal }) => actionSessionRpc({
        serverId: accountContext.serverId, sessionId, method: RPC_METHODS.APPROVAL_REQUEST_DECIDE,
        payload: { artifactId, decision }, timeoutMs: null, ...(signal ? { signal } : {}),
      }),
    }) : undefined,

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
      if (!signal?.aborted) opts?.onBlockingApprovalPending?.({ artifactId, scope: accountLifetime.scope, ...(signal ? { signal } : {}) });
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
          }, { reconnect: 'refresh' });
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
    promptDocUpdate: async ({ signal, ...request }, context) => withPromptLibraryStore((store) => updatePromptDocInLibrary({ store, request, signal,
      savedBy: artifactSavedByFromActionContextV1(context) }), signal),

    skillsRead: async ({ signal, ...request }, context) => {
      if (!request.sessionId && 'skillId' in request && accountContext && isPluginSkillIdV1(request.skillId)) {
        return readUiPluginSkillV1(accountContext, request, { ...context, signal });
      }
      if (!request.sessionId) return withPromptLibraryStore(async store => {
        const usage = deps.skillRules ? await readSkillUsageCatalogV1(deps.skillRules, signal) : null;
        const result = await readSkillInLibrary({ store, request, usage: usage?.row, signal });
        if (!('skillId' in result) || !deps.skillRules) return result;
        return { ...result, rules: await readSkillRulesForItemV1(deps.skillRules, result.skillId, signal) };
      }, signal);
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      accountContext.assertCurrent();
      const result = await actionSessionRpc<unknown, SkillReadInputV1>({
        serverId: accountContext.serverId, sessionId: request.sessionId, method: 'skills.read', payload: request,
        timeoutMs: null, ...(signal ? { signal } : {}),
      });
      accountContext.assertCurrent();
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return result;
      return SkillReadResultV1Schema.parse(result);
    },
    promptBundleUpdate: async ({ signal, ...request }) => withPromptLibraryStore(
      store => updatePromptBundleInLibrary({ store, request, signal }), signal),

    promptRegistryInstall: async ({ machineId, sourceId, itemId, serverId, signal }, context) => {
      if (accountContext && promptLibraryStore?.organization) {
        const registry = await createUiRegistryHostV1(accountContext, promptLibraryStore.organization, context);
        const source = await registry.readRegistrySource(sourceId);
        if ('token' in source && source.token) {
          const result = await registry.executeOnMachine(machineId, 'prompt_registry.install', {
            machineId, sourceId, itemId,
          });
          const receipt = result.ok ? result.result : result.details;
          if (receipt && typeof receipt === 'object' && 'artifactId' in receipt && typeof receipt.artifactId === 'string') {
            await refreshUiSkillActionAcknowledgements(accountContext, [receipt.artifactId]);
          } else if (receipt && typeof receipt === 'object' && 'skillIds' in receipt && Array.isArray(receipt.skillIds)
            && receipt.skillIds.every((id): id is string => typeof id === 'string')) {
            await refreshUiSkillActionAcknowledgements(accountContext, receipt.skillIds);
          }
          return result.ok ? result.result : result;
        }
      }
      return withPromptLibraryStore(async store => {
        if (!accountContext || !store.organization) throw new Error('registry_sources_unavailable');
        const registry = await createUiRegistryHostV1(accountContext, store.organization, context);
        return installPromptRegistryItemInLibrary({
          request: { sourceId, itemId }, signal,
          fetchItem: async ({ sourceId, itemId }) => REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(
            await registry.execute('registries.items.read', { kind: 'skill', sourceId, itemId })).item,
          installLibrary: pointer => {
            if (!deps.skillActionExecute) throw new Error('skills_install_unavailable');
            return deps.skillActionExecute({ actionId: 'skills.install', input: { source: { kind: 'registry', ...pointer } }, context });
          },
        });
      }, signal);
    },

    ...(opts?.resolveServerIdForSessionId ? { resolveServerIdForSessionId: opts.resolveServerIdForSessionId } : {}),
  };

  if (accountContext && promptLibraryStore && deps.skillRules && deps.sessionCapabilities) {
    const sessionCapabilities = deps.sessionCapabilities;
    deps = { ...deps, skillActionExecute: createUiSkillActionExecuteV1(accountContext, promptLibraryStore, deps.skillRules,
      async (sessionId, skillId, signal) => {
        accountContext.assertCurrent(); throwIfAborted(signal);
        const result = await setSessionCapabilityV1({ port: sessionCapabilities, request: { sessionId, kind: 'skill', id: skillId, state: 'on' },
          context: { surface: 'ui', serverId: accountContext.serverId, signal } });
        return result;
      }, async (machineId, path, signal) => {
        accountContext.assertCurrent(); throwIfAborted(signal);
        const source = opts?.foundSkillSource;
        if (source && (source.target.machineId !== machineId || !source.isCurrent())) {
          throw Object.assign(new Error('machine_target_mismatch'), { code: 'machine_target_mismatch' });
        }
        const result = await readFoundSkillBundle(machineId, path, {
          serverId: source?.target.serverIdentityId ?? accountContext.serverId, signal,
        });
        accountContext.assertCurrent(); throwIfAborted(signal);
        if (source && !source.isCurrent()) throw Object.assign(new Error('machine_target_mismatch'), { code: 'machine_target_mismatch' });
        return result;
      }) };
  }

  const companionDeps = accountContext ? createWidgetCompanionActionDepsV1(accountContext) : {};
  const areaDeps = createWidgetAreaActionDepsV1(accountContext, opts?.resolveWidgetAreaPresets, opts?.widgetAreaIsCurrent);
  const widgetSurfaceDeps = { ...deps, ...areaDeps, widgetSurfaceActions: { ...deps.widgetSurfaceActions, ...companionDeps.widgetSurfaceActions, ...areaDeps.widgetSurfaceActions } };
  const widgetDefinitionDeps = { ...widgetSurfaceDeps, ...createWidgetDefinitionActionDepsV1(accountContext, widgetSurfaceDeps) };
  const widgetHostDeps = { ...widgetDefinitionDeps, ...createWidgetCatalogActionDepsV1(accountContext, widgetDefinitionDeps) };
  const widgetInputDeps = { ...widgetHostDeps, ...createWidgetInputActionDepsV1(accountContext, widgetHostDeps) };
  const executor = createActionExecutor({ ...widgetInputDeps, ...createWidgetRefreshActionDepsV1(accountContext, widgetInputDeps),
    resolveServerProfileScopeId: resolveServerProfileScopeIdForIdentifier,
    ...(opts?.projectWorkerAction ? { projectWorkerAction: opts.projectWorkerAction }
      : accountContext ? { projectWorkerAction: createUiProjectWorkerActionV1(accountContext) } : {}),
  });

  // Surface attribution is owned by the host that constructs the executor, mirroring
  // `apps/cli/src/session/actions/createCliActionExecutor.ts` (`?? 'cli'`). This factory is the
  // app client's entrypoint, so an unattributed caller is a `ui` caller — a `voice` or `plugin`
  // caller stamps its own surface and still wins. Without this the surface reaches the catalog
  // gate nullish, which now fails closed (INV-1 / DEC-2).
  const resolveContext = (context: Parameters<typeof executor.execute>[2], input: unknown, actionId?: ActionId): ActionExecutorContext => {
    const voiceInvocation = opts?.readAdmittedVoiceInvocation?.();
    const surface = opts?.readAdmittedVoiceInvocation ? voiceInvocation?.surface ?? 'voice' : context?.surface ?? 'ui';
    const installedAuth = getCurrentAuth();
    const credential = accountContext?.credentialAuthorityKind ?? installedAuth?.credentialAuthorityKind ?? 'none';
    const localUiInteraction = !accountContext && credential === 'none'
      && installedAuth?.credentialAuthorityKind === 'none' && installedAuth.isAuthenticated === false
      && surface === 'ui' && context?.actionCaller?.kind === 'host'
      && !context.externalActionCredential && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization
      && !context.signal?.aborted && storage.getState().settingsScope === null && isSettingsOwnerCurrent()
      && (actionId === 'links.openExternal' || isBuiltInLocalSettingMutation(actionId, input));
    const voiceCanApproveRequests = !opts?.readAdmittedVoiceInvocation && surface === 'voice' && credential === 'account'
      && (!context?.actionCaller || context.actionCaller.kind === 'host')
      && !context?.externalActionCredential && !context?.externalActionExecutionAuthorization
      && !context?.rpcSessionAuthorization
      && readAccountSettingsSnapshot().voice.canApproveRequests === true;
    const credentialAuthority = resolveInvocationAuthority({ credential, surface, localUiInteraction,
      actionId, voiceCanApproveRequests });
    // Ordinary callers can narrow the installed credential's authority, never
    // promote it. Authenticated daemon continuations retain their admitted stamp.
    const authority = opts?.readAdmittedVoiceInvocation
      ? credential === 'account' ? voiceInvocation?.authority ?? 'account_automation' : credentialAuthority
      : opts?.admittedClientActionId
      ? context?.authority ?? 'account_automation'
      : credentialAuthority === 'present_user' ? context?.authority ?? credentialAuthority : credentialAuthority;
    const actionCaller = voiceInvocation?.caller ?? context?.actionCaller ?? (credential === 'account' && (surface === 'ui' || surface === 'voice' || surface === 'rpc') && !context?.externalActionCredential
      && !context?.externalActionExecutionAuthorization && !context?.rpcSessionAuthorization ? { kind: 'host' as const } : undefined);
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
      ...(actionCaller ? { actionCaller } : {}),
      ...(accountContext ? { managedMachineCreationEnabled: accountContext.settings.managedMachineCreationEnabled } : {}),
      ...((surface === 'ui' || surface === 'voice' || surface === 'plugin') && (credential === 'account' || credential === 'terminal')
        ? { actionRequestId: context?.actionRequestId ?? (creationKey || randomUUID()) }
        : {}),
    };
  };

  // A confirmed re-execution after a receiving executor's refusal is a new invocation of the same exact input,
  // bound (at each path's existing binding site) to the review that executor carried back.
  const freshRequest = (context: ActionExecutorContext): ActionExecutorContext => ({ ...context, actionRequestId: randomUUID() });
  const executeMachineAction = async (actionId: ActionId, input: unknown, context: ActionExecutorContext, confirmInFlow = false) => {
    // Direct Machine ingress shares the canonical Home normalization used by the core executor,
    // before input-bound consent and the signed receiving request are created.
    if (isDeploymentActionIdV1(actionId)) {
      const home = admitDeploymentHomeInputV1(input, context, resolveServerProfileScopeIdForIdentifier);
      if ('errorCode' in home) return home;
      input = home.input;
    }
    return executeMachineActionAtDaemon(actionId, input, context, async (actionInput, reviewDigest) => {
      // The relay's boundary has admitted the caller and parsed authoring input.
      // Settle omissions once; a carried review reuses these same captured facts.
      if (!reviewDigest && isSessionSpawnNewActionIdV1(actionId) && deps.prepareSessionSpawnNewInput) {
        try {
          const prepared = await deps.prepareSessionSpawnNewInput(SessionSpawnNewActionInputV2Schema.parse(actionInput), context);
          actionInput = prepared.input;
          context = { ...context, sessionCreationDefaults: prepared.defaults };
        } catch (error) {
          const failure = parseActionExecuteFailure(error);
          if (failure) return failure;
          throw error;
        }
      }
      return reviewDigest
        ? executeMachineOwnedAction({ actionId, input: actionInput, context: freshRequest(context), confirmInFlow: true, reviewDigest })
        : executeMachineOwnedAction({ actionId, input: actionInput, context, confirmInFlow });
    }, deps.presentUserActionConfirmation);
  };

  // Bind review and transport to the same portable Home before terminal approval is prepared.
  const normalizeTerminalHomeInput = (actionId: ActionId, input: unknown): unknown => {
    if (!isMachineTerminalActionId(actionId)) return input;
    const request = readRecord(input);
    if (typeof request.serverId !== 'string') return input;
    const serverId = resolveServerProfileScopeIdForIdentifier(request.serverId);
    return serverId ? { ...request, serverId } : input;
  };

  const executeAction = async (actionId: ActionId, input: unknown, context?: ActionExecutorContext, confirmInFlow = false) => {
    input = normalizeTerminalHomeInput(actionId, input);
    const resolved = resolveContext(context, input, actionId);
    if (opts?.admittedClientActionId !== actionId && !isSessionSpawnNewActionIdV1(actionId)) {
      const unavailable = await readNewWorkFeatureAdmission(actionId, input, resolved, accountContext?.serverId ?? resolved.serverId ?? undefined,
        () => accountContext ? accountContext.readSettings() : storage.getState().settings);
      if (unavailable) return unavailable;
    }
    if (opts?.admittedClientActionId === actionId) {
      return await executor.executeAdmittedClientAction(actionId, input, resolved);
    }
    return (resolved.surface !== 'plugin' || isSessionSpawnNewActionIdV1(actionId)) && isMachineOwnedAdmissionAction(actionId, input)
      ? await executeMachineAction(actionId, input, resolved, confirmInFlow)
      : await confirmOwnUiRefusal(actionId, input, resolved,
        await executor.execute(actionId, input, confirmInFlow ? bindPresentUserActionConfirmation(actionId, input, resolved) : resolved),
        deps.presentUserActionConfirmation, (confirmedInput, reviewDigest) =>
          executor.execute(actionId, confirmedInput, bindPresentUserActionConfirmation(actionId, confirmedInput, freshRequest(resolved), reviewDigest)));
  };
  return {
    previewSessionTargets: async (target, context) => {
      const input = { target, actionId: 'session.message.send' };
      const result = await executor.execute('session.targets.resolve', input, resolveContext(context, input, 'session.targets.resolve'));
      return result.ok ? SessionTargetPreviewV1Schema.parse(result.result)
        : { coverage: 'unavailable', addresses: [], error: result.errorCode };
    },
    // A genuine present-user native invocation has one installed Action policy
    // and approval owner. Do not create a second local Ask before its relay; a
    // receiving Machine that refuses for want of a presenter carries its review to this executor's confirmation.
    executeNativeManagedAction: async (actionId: ManagedMachineActionIdV1, input: unknown, context?: ActionExecutorContext, confirmInFlow = false,
      retainedMachine?: ManagedMachineActionOutputV1<'machines.managed.get'>) => {
      if (!accountContext) return { ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const resolvedContext = resolveContext(context, input, actionId);
      const preferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, resolvedContext);
      if (preferenceFailure) return preferenceFailure;
      if (deps.isActionEnabled && !deps.isActionEnabled(actionId, resolvedContext)) {
        return { ok: false as const, errorCode: 'action_disabled', error: 'action_disabled' };
      }
      const account = accountContext;
      const native = (nativeInput: unknown, nativeContext: ActionExecutorContext, confirmed: boolean, reviewDigest?: string) =>
        executeManagedMachineNativeAction({ account, actionId, input: nativeInput, context: nativeContext, confirmInFlow: confirmed,
          ...(reviewDigest ? { reviewDigest } : {}), retainedMachine,
          resolvePresetPool: poolInput => executor.execute('machines.pools.resolve', poolInput, nativeContext),
          ...(context?.signal ? { signal: context.signal } : {}) });
      return await confirmOwnUiRefusal(actionId, input, resolvedContext, await native(input, resolvedContext, confirmInFlow),
        deps.presentUserActionConfirmation, (confirmedInput, reviewDigest) =>
          native(confirmedInput, freshRequest(resolvedContext), true, reviewDigest));
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
    prepare: async (actionId, input, context, options) => {
      input = normalizeTerminalHomeInput(actionId, input);
      const resolved = resolveContext(context, input, actionId);
      if (opts?.admittedClientActionId !== actionId && !isSessionSpawnNewActionIdV1(actionId)) {
        const unavailable = await readNewWorkFeatureAdmission(actionId, input, resolved, accountContext?.serverId ?? resolved.serverId ?? undefined,
          () => accountContext ? accountContext.readSettings() : storage.getState().settings);
        if (unavailable) return { kind: 'settled', result: unavailable };
      }
      // The daemon owns implicit and explicit review for its admitted Actions.
      // Preparation must not create an app-local approval before that owner runs.
      if ((resolved.surface !== 'plugin' || isSessionSpawnNewActionIdV1(actionId)) && isMachineOwnedAdmissionAction(actionId, input)) {
        const review = options?.reviewOnly && !isSessionSpawnNewActionIdV1(actionId) ? await executor.prepare(actionId, input, resolved, options) : null;
        if (review?.kind === 'settled') return review;
        return { kind: 'ready',
          ...(review?.operation ? { operation: review.operation } : {}),
          invocation: { run: () => executeMachineAction(actionId, input, resolved) } };
      }
      // A prepared run reaches the same receiving owner as execute, so its refusal gets the same confirmation.
      const prepared = await executor.prepare(actionId, input, resolved, options);
      return prepared.kind === 'ready' ? { ...prepared, invocation: { ...prepared.invocation,
        run: async () => await confirmOwnUiRefusal(actionId, input, resolved, await prepared.invocation.run(),
          deps.presentUserActionConfirmation, (confirmedInput, reviewDigest) =>
            executor.execute(actionId, confirmedInput, bindPresentUserActionConfirmation(actionId, confirmedInput, freshRequest(resolved), reviewDigest))) } } : prepared;
    },
    executeAdmittedClientAction: (actionId, input, context) => executor.executeAdmittedClientAction(actionId, input, context),
    execute: executeAction,
    executeConfirmed: (actionId, input, context) => executeAction(actionId, input, context, true),
    replayApprovedApprovalRequest: async (args) => await executor.replayApprovedApprovalRequest(args),
  };
}


type DefaultActionExecutorOptions = Parameters<typeof buildDefaultActionExecutor>[0];
/** UI-only projection qualifier; the captured Account owner enforces it before admission. */
export type UiActionExecutorContext = import('@/components/plugins/surfaces/pluginSurfaceActionDispatch').PluginSurfaceActionExecutorContext & Readonly<{
  expectedAccountId?: string;
  /** Local read-aloud presentation only; never serialized into Action custody. */
  voiceSpeechSource?: import('@/voice/backends/tts/localVoiceTtsProviderControllers').VoiceReadAloudSource;
  /** Reviewed Delete routing only; the receiving owner still admits expectedRevision and authority. Never serialized. */
  reviewedManagedMachine?: ManagedMachineReadSnapshotV1;
  /** Exact object admitted by the enclosing UI stop/archive lifecycle. */
  archiveOperation?: SessionArchiveOperation;
  /** Destination-owner navigation leaf, consumed only in this invocation. */
  openRoute?: (route: string) => void | Promise<void>;
}>;
type DefaultActionExecutor = Omit<UiProtocolActionExecutor, 'execute' | 'prepare' | 'previewSessionTargets' | 'executeAdmittedClientAction'> & Readonly<{
  previewSessionTargets: (target: SessionTargetSelectorV1, context?: UiActionExecutorContext, readInputs?: SessionFollowReadInputs) => Promise<UiSessionTargetPreview>;
  execute: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['execute']>;
  prepare: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext,
    options?: import('@happier-dev/protocol/actions/executor/types').ActionPrepareOptions) => ReturnType<ReturnType<typeof createActionExecutor>['prepare']>;
}>;
type DefaultActionExecuteContext = Pick<UiActionExecutorContext, 'expectedAccountId' | 'externalActionCredential' | 'openRoute' | 'archiveOperation' | 'defaultSessionId' | 'contributedActionInvocation' | 'voiceSpeechSource'> & Readonly<{
  archiveInput?: unknown;
  serverId: string;
  signal?: AbortSignal;
  /** Synchronously consumes a failure only while this captured Account is still current. */
  onCurrentError?: (error: unknown) => void;
}>;

export { isActionAccountScopeChangedError } from '@/sync/domains/scope/actionAccountScopeError';

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
function createCapturedScopeFamilyPorts(account: LazyActionAccountContext,
  discussionAttachmentSources?: readonly import('@/sync/domains/attachments/prepareAttachmentPayloads').PreparedAttachmentSource[],
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>): Readonly<{
  sessionAccessAction: NonNullable<ActionExecutorDeps['sessionAccessAction']>;
  machineAccessAction: NonNullable<ActionExecutorDeps['machineAccessAction']>;
  machineWorkSummaryGet: NonNullable<ActionExecutorDeps['machineWorkSummaryGet']>;
  machineVitalsAction: NonNullable<ActionExecutorDeps['machineVitalsAction']>;
  machineStorageAction: NonNullable<ActionExecutorDeps['machineStorageAction']>;
  machineGuardAction: NonNullable<ActionExecutorDeps['machineGuardAction']>;
  machineScheduledAction: NonNullable<ActionExecutorDeps['machineScheduledAction']>;
  machineProcessesAction: NonNullable<ActionExecutorDeps['machineProcessesAction']>;
  machineServiceAction: NonNullable<ActionExecutorDeps['machineServiceAction']>;
  machineServiceControl: NonNullable<ActionExecutorDeps['machineServiceControl']>;
  machineServiceLogsRead: NonNullable<ActionExecutorDeps['machineServiceLogsRead']>;
  machineResourcesPolicyAction: NonNullable<ActionExecutorDeps['machineResourcesPolicyAction']>;
  machineRolesAction: NonNullable<ActionExecutorDeps['machineRolesAction']>;
  machineIsolationAction: NonNullable<ActionExecutorDeps['machineIsolationAction']>;
  machineAdminAccessAction: NonNullable<ActionExecutorDeps['machineAdminAccessAction']>;
  machineAgentIsolationAction: NonNullable<ActionExecutorDeps['machineAgentIsolationAction']>;
  machineReboot: NonNullable<ActionExecutorDeps['machineReboot']>;
  skillMachineActionExecute: NonNullable<ActionExecutorDeps['skillMachineActionExecute']>;
  discussionAction: NonNullable<ActionExecutorDeps['discussionAction']>;
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  teamMembershipHistoryAction: NonNullable<ActionExecutorDeps['teamMembershipHistoryAction']>;
  savedSecretRepairAction: NonNullable<ActionExecutorDeps['savedSecretRepairAction']>;
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
  // One captured Machine boundary admits before dispatch and settles from the
  // actual reply. Caller/scope retirement cannot undo an acknowledged effect;
  // reads still require current custody before disclosure.
  const machineActionRpc = async (actionId: ActionId, input: Readonly<Record<string, unknown>> & Readonly<{ machineId: string; serverId?: string }>,
    signal?: AbortSignal, requestId?: string, operationTimeoutMs?: null,
    payload: unknown = { ...input, serverId: account.serverId }) => {
    account.assertCurrent();
    throwIfAborted(signal);
    if (input.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) {
      return { ok: false as const, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    }
    const spec = getActionSpec(actionId);
    const method = spec.bindings?.rpcMethod;
    if (!method) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const result = await withActionAccountRequestSignal(account, signal, ownedSignal => machineRpcWithServerScope({ ...scope, machineId: input.machineId, method,
      payload, preferScoped: true,
      ...(spec.sideEffectClass !== 'read' || operationTimeoutMs === null ? { operationTimeoutMs: null } : {}),
      ...(requestId ? { requestId } : {}), signal: ownedSignal }));
    account.assertResultCurrent(spec.sideEffectClass);
    if (spec.sideEffectClass === 'read') throwIfAborted(signal);
    return readMachineActionRpcResult(result);
  };
  return {
    skillMachineActionExecute: async ({ actionId, input, context }) => {
      const request = SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
      const result = await machineActionRpc(actionId, request, context.signal, context.actionRequestId ?? undefined, undefined, request);
      if (actionId === 'skills.found.list' && !('directory' in request)) {
        const { SkillFoundListResultV1Schema } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');
        const found = SkillFoundListResultV1Schema.safeParse(result);
        if (found.success) {
          const { saveFoundWarmCacheEntry } = await import('@/sync/domains/state/warmCachePersistence');
          account.assertCurrent(); throwIfAborted(context.signal);
          saveFoundWarmCacheEntry(account.serverId, account.accountId, { kind: 'skill', machineId: request.machineId,
            observedAt: found.data.scannedAt, result: found.data });
        }
      }
      return result;
    },
    savedSecretRepairAction: async ({ input }) => {
      account.assertCurrent();
      const { repairApprovedSavedSecretResourceEnvelopesBestEffort } = await import('@/sync/ops/settings/savedSecretResourceOperations');
      const complete = await repairApprovedSavedSecretResourceEnvelopesBestEffort({ scope, ...input });
      return { resourceId: input.resourceId, revision: input.expectedRevision, status: complete ? 'complete' : 'incomplete' };
    },
    teamMembershipHistoryAction: async (args) => {
      account.assertCurrent();
      const { executeMembershipHistoryActionForScope } = await import('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi');
      return await executeMembershipHistoryActionForScope({ scope, isCurrent, actionId: args.actionId, input: args.input,
        availability: await readCollaborationAvailability(), ...(args.signal ? { signal: args.signal } : {}) });
    },
    machineScheduledAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined, null),
    machineProcessesAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined),
    machineServiceAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined),
    machineServiceControl: async ({ input, context, signal }) => {
      const result = await createUiAccountAction({ account })({
        actionId: 'machines.services.control', input, signal, context: { ...context,
          actionCaller: context.actionCaller ?? { kind: 'host' },
          externalActionTarget: context.externalActionTarget ?? { kind: 'machine', machineId: input.machineId },
        },
      });
      const outcome = MachineServiceControlResultV1Schema.safeParse(result);
      if (outcome.success && (outcome.data.kind === 'observed' || outcome.data.kind === 'accepted') && isCurrent()) {
        invalidateLocalServiceLauncherStores({ ...scope, machineId: input.machineId,
          credentialKey: resolveAuthCredentialsScopeKey(account.credentials) });
      }
      return result;
    },
    machineServiceLogsRead: ({ input, context, signal }) => machineActionRpc('machines.services.logs.read', input, signal, context.actionRequestId ?? undefined),
    machineAdminAccessAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined),
    machineAgentIsolationAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined,
      resolveMachineAgentIsolationOperationTimeoutMs(actionId)),
    machineReboot: ({ input, context, signal }) => machineActionRpc('machines.reboot', input, signal, context.actionRequestId ?? undefined),
    // Guard reads, Activity, Undo and Keep running are the target daemon's: Undo re-runs the captured
    // original Action there, through its own approval, so the host only carries the request.
    machineGuardAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined,
      resolveMachineGuardOperationTimeoutMs(actionId)),
    // Preserve Storage's existing operation-owned read completion as well.
    machineStorageAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined, null),
    machineResourcesPolicyAction: async ({ actionId, input, signal }) => {
      account.assertCurrent();
      if (input.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return actionId === 'machines.resources.policy.get'
        ? { status: 'unavailable' } : { status: 'unavailable', reason: 'server_target_mismatch' };
      if (actionId === 'machines.resources.policy.get') {
        return machineResourcesPolicyGet(input.machineId, { serverId: account.serverId });
      }
      const target = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS['machines.resources.policy.set'].parse(input);
      return machineActionRpc(actionId, target, signal);
    },
    machineRolesAction: async ({ actionId, input, signal }) => {
      account.assertCurrent();
      if (input.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return { status: 'unavailable' };
      if (actionId === 'machines.roles.set') {
        return machineActionRpc(actionId, MACHINE_ROLES_ACTION_INPUT_SCHEMAS['machines.roles.set'].parse(input), signal);
      }
      // List and Get read synced metadata, so a Machine's roles stay readable while it is offline.
      const machine = resolveServerScopedMachine(storage.getState(), account.serverId, input.machineId);
      return actionId === 'machines.roles.list' ? readSyncedMachineRolesList(machine) : readSyncedMachineRoles(machine);
    },
    machineIsolationAction: async ({ actionId, input, context, signal }) => {
      account.assertCurrent();
      if (input.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return { status: 'unavailable' };
      if (actionId === MACHINE_ISOLATION_SET_ACTION_ID_V1) {
        return machineActionRpc(actionId, MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS['machines.isolation.set'].parse(input), signal,
          context.actionRequestId ?? undefined);
      }
      return readSyncedMachineIsolationPolicy(resolveServerScopedMachine(storage.getState(), account.serverId, input.machineId));
    },
    machineVitalsAction: async ({ actionId, input, signal }) => {
      account.assertCurrent();
      if (input.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return { ok: false as const, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const read = async (machineId: string, method: string, payload: unknown) => {
        account.assertCurrent();
        const result = await withActionAccountRequestSignal(account, signal, ownedSignal => machineRpcWithServerScope({ serverId: account.serverId, accountId: account.accountId,
          machineId, method, payload, preferScoped: true, signal: ownedSignal }));
        account.assertCurrent();
        return readMachineActionRpcResult(result);
      };
      if (actionId !== 'machines.vitals.summaries.list') {
        const target = actionId === 'machines.vitals.get'
          ? MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.get'].parse(input)
          : MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.history.get'].parse(input);
        return await read(target.machineId, getActionSpec(actionId).bindings!.rpcMethod!, { ...target, serverId: account.serverId });
      }
      const inventory = storage.getState().machineListByServerId;
      const keys = resolveServerScopedMachineInventoryKeys({ serverId: account.serverId, machineListByServerId: inventory });
      const machines = keys.map(key => inventory[key]).find(list => list !== null && list !== undefined);
      if (!machines) return { ok: false as const, errorCode: 'machine_inventory_unavailable', error: 'machine_inventory_unavailable' };
      const result = await listMachineVitalsSummariesV1({ machines: filterVisibleMachines(machines)
        .filter(machine => !isMachineReplaced(machine))
        .map(machine => ({ machineId: machine.id, name: readMachineName(machine) ?? machine.id,
          online: isMachineReachable(account, machine), resources: readMachineVitalsResourcesProjectionV1(machine.daemonState),
          unavailable: machine.availability?.kind === 'locked' })),
        readSummary: machineId => read(machineId, RPC_METHODS.MACHINES_VITALS_GET, { serverId: account.serverId, machineId, view: 'summary' }),
        ...(signal ? { signal } : {}) });
      account.assertCurrent();
      return result;
    },
    machineWorkSummaryGet: async ({ input, signal }) => {
      account.assertCurrent();
      if (!areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) return { ok: false as const, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const result = await withActionAccountRequestSignal(account, signal, ownedSignal => machineRpcWithServerScope({ serverId: account.serverId, accountId: account.accountId,
        machineId: input.machineId, method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, payload: { ...input, serverId: account.serverId }, preferScoped: true,
        signal: ownedSignal }));
      account.assertCurrent();
      return readMachineActionRpcResult(result);
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
          ...(onPublicLinkIssued ? { onPublicLinkIssued } : {}),
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
    discussionAction: async (args) => {
      account.assertCurrent();
      const availability = await readCollaborationAvailability();
      const { executeDiscussionActionInAccountContext } = await import('@/sync/api/discussions/discussionActions');
      const result = await executeDiscussionActionInAccountContext(account, availability, args, discussionAttachmentSources);
      account.assertResultCurrent(getActionSpec(args.actionId).sideEffectClass);
      return result;
    },
  };
}

class ActionAdmissionHomeUnreachableError extends HappyError {
  constructor() {
    super('server_unreachable', true, { code: 'server_unreachable', kind: 'network' });
    Object.setPrototypeOf(this, ActionAdmissionHomeUnreachableError.prototype);
  }
}

/** A failed policy read precedes Action admission: no mutation has entered its transport. */
async function readActionAdmissionSettings(account: LazyActionAccountContext) {
  try {
    return await account.readSettings();
  } catch (error) {
    account.assertCurrent();
    if (isTransientConnectivityError(error)) {
      throw new ActionAdmissionHomeUnreachableError();
    }
    throw error;
  }
}

export async function withDefaultActionExecuteContext<TResult>(
  opts: DefaultActionExecutorOptions,
  context: DefaultActionExecuteContext,
  work: (executor: ReturnType<typeof buildDefaultActionExecutor>, account: LazyActionAccountContext,
    settings: Awaited<ReturnType<typeof readActionAdmissionSettings>>) => Promise<TResult>,
  executedActionId?: ActionId,
  followReadInputs?: SessionFollowReadInputs,
): Promise<TResult> {
  // A retained host invocation may withdraw its pending approval after its
  // intent signal ends. Its captured Account still owns that final Artifact
  // CAS; actual credential/Account retirement continues to revoke the carrier.
  const retained = opts?.hostActionApprovalLifetime;
  const account = await captureLazyActionAccountContext(context.serverId,
    retained?.signal === context.signal ? undefined : context.signal);
  const archiveInvocation = createSessionArchiveInvocation(executedActionId, context.archiveInput, context.archiveOperation, context.serverId, context.defaultSessionId);
  try {
    try {
      assertExpectedActionAccount(account, context);
      const settings = await readActionAdmissionSettings(account);
      account.assertCurrent();
      throwIfAborted(context.signal);
      const listContributedActionDefinitions = context.contributedActionInvocation?.listContributedActionDefinitions ?? opts?.listContributedActionDefinitions;
      const result = await work(buildDefaultActionExecutor({ ...opts, archiveInvocation,
        ...(context.voiceSpeechSource ? { voiceSpeechSource: context.voiceSpeechSource } : {}),
        ...(listContributedActionDefinitions ? { listContributedActionDefinitions } : {}),
        ...(context.openRoute ? { openRoute: context.openRoute } : {}) }, { ...account, settings }, followReadInputs), account, settings);
      const effectClass = executedActionId ? getActionSpec(executedActionId).sideEffectClass : undefined;
      // Return an effect's actual disposition to its captured invoker. Retirement
      // suppresses Account projection publication, but cannot rewrite an acknowledgement.
      // Reads still require current custody before disclosing Account content.
      account.assertResultCurrent(effectClass, context.signal);
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
    finishSessionArchiveInvocation(archiveInvocation);
    account.dispose();
  }
}

/** Trusted native main-to-presenter continuation. The original Action already passed admission. */
export async function executeAdmittedDesktopAppWindowAction(
  actionId: ActionId,
  input: unknown,
  context: UiActionExecutorContext & Readonly<{ serverId: string }>,
  options: import('./desktopAppWindowActionDispatch').DesktopAppWindowActionOptions = {},
): Promise<ActionExecuteResult> {
  return withDefaultActionExecuteContext({ ...options, admittedClientActionId: actionId }, { ...context, serverId: context.serverId },
    (executor, account) => executor.executeAdmittedClientAction(actionId, input,
      { ...context, runtimeAccountId: account.accountId }), actionId);
}

/** Execute through the complete UI Action owner while borrowing an already-captured Account lifetime. */
export async function executeDefaultActionInCapturedAccount(
  account: LazyActionAccountContext,
  actionId: ActionId,
  input: unknown,
  context?: UiActionExecutorContext,
) {
  const execute = async (signal?: AbortSignal) => {
    assertExpectedActionAccount(account, context);
    const settings = await readActionAdmissionSettings(account);
    account.assertCurrent();
    throwIfAborted(signal);
    const { archiveOperation, ...actionContext } = context ?? {};
    const archiveInvocation = createSessionArchiveInvocation(actionId, input, archiveOperation, account.serverId, context?.defaultSessionId);
    const admittedContext = {
      ...actionContext,
      signal,
      serverId: account.serverId,
      ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
      runtimeAccountId: account.accountId,
    };
    account.assertCurrent();
    throwIfAborted(signal);
    try {
      const result = await buildDefaultActionExecutor({ archiveInvocation }, { ...account, settings }).execute(actionId, input, admittedContext);
      account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
      return result;
    } finally {
      finishSessionArchiveInvocation(archiveInvocation);
    }
  };
  return execute(context?.signal);
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
    const declaredServerId = getActionSpec(actionId).invocationServerIdForInput?.(input);
    if (declaredServerId !== undefined) return declaredServerId;
    return (isRoleActionIdV1(actionId) || (context?.surface ?? 'ui') === 'ui')
      ? getActiveServerAccountScope()?.serverId : undefined;
}

async function resolveNativeManagedAction(actionId: ActionId, input: unknown, account: LazyActionAccountContext,
  context?: ActionExecutorContext, opts?: DefaultActionExecutorOptions,
  reviewedManagedMachine?: ManagedMachineReadSnapshotV1): Promise<Readonly<{ actionId: ManagedMachineActionIdV1;
    retainedMachine?: ManagedMachineActionOutputV1<'machines.managed.get'> }> | ActionExecuteFailure | null> {
  // An admitted replay retains its existing strict approval custody. Ordinary
  // relay ingress cannot consume a local Artifact's bypass proof.
  if (opts?.admittedClientActionId) return null;
  // Retained control runs where the resource's controller lives. The static
  // Account placement also covers resources without a controller.
  if (isManagedMachineRetainedControlAction(actionId, input)) {
    // Other surfaces retain their existing Account Action admission path.
    if (context?.surface && context.surface !== 'ui' && context.surface !== 'voice') return null;
    const parsed = ManagedMachineActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    try {
      const retainedMachine = actionId === 'machines.managed.delete' && reviewedManagedMachine
        ? readManagedMachineReadForSnapshot(reviewedManagedMachine)
        : await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', {
        homeId: parsed.data.homeId,
        managedId: 'managedMachineId' in parsed.data ? parsed.data.managedMachineId : parsed.data.managedId,
      }, { signal: account.invocationSignal });
      account.assertCurrent();
      if (!retainedMachine) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      const structural = unwrapManagedMachineReadV1(retainedMachine);
      return structural.controller ? { actionId, retainedMachine } : null;
    } catch (error) {
      if (!(error instanceof ManagedMachineActionError)) throw error;
      // The Account control owner admits power without requiring the public Manage read.
      if (actionId === 'machines.managed.power.set' && error.code === 'permission_denied') return null;
      return { ok: false, errorCode: error.code, error: error.code };
    }
  }
  if (resolveActionExecutionPlacementForInput(getActionSpec(actionId), input, context?.actionCaller, context?.surface ?? 'ui') === 'account') return null;
  const parsed = ManagedMachineActionIdV1Schema.safeParse(actionId);
  return parsed.success && parsed.data !== 'machines.managed.list'
    && parsed.data !== 'machines.managed.birth.get'
    && parsed.data !== 'machines.managed.get' && parsed.data !== 'machines.managed.cancel'
    && parsed.data !== 'machines.managed.setup.skip'
    && parsed.data !== 'machines.managed.references.get' ? { actionId: parsed.data } : null;
}

function executeManagedNativeActionWithApprovalObservation(params: Readonly<{
  actionId: ManagedMachineActionIdV1;
  requestId: string;
  serverId: string;
  accountId: string;
  execute: () => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
  return new Promise<ActionExecuteResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (result: ActionExecuteResult) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(error);
    };
    const stop = subscribeActionOperationByRequestId({
      requestId: params.requestId,
      serverId: params.serverId,
      accountId: params.accountId,
      onUpdate: operation => {
        const approval = operation.state === 'running' && operation.actionId === params.actionId
          && operation.progress?.kind === 'phase' ? operation.progress.approval : undefined;
        if (approval?.kind !== 'approval_request_created' || approval.actionId !== params.actionId) return;
        finish({ ok: true, result: approval });
      },
    });
    unsubscribe = stop;
    if (settled) unsubscribe();
    void params.execute().then(finish, fail);
  });
}

export function createDefaultActionExecutor(opts?: DefaultActionExecutorOptions): DefaultActionExecutor {
  let unscoped: ReturnType<typeof buildDefaultActionExecutor> | undefined;
  const ordinary = () => unscoped ?? (unscoped = buildDefaultActionExecutor(opts));
  const apiTokenTransport = async (): Promise<ApiTokenActionTransport | null> => {
    if (opts?.apiTokenAction) return opts.apiTokenAction;
    if (getCurrentAuth()?.credentialAuthorityKind !== 'api_token') return null;
    const scoped = (await import('@/sync/sync')).sync.getEmbedSessionRequestContext();
    if (!scoped || !scoped.isCurrent()) throw new Error('action_account_scope_changed');
    return { request: scoped.request, target: { kind: 'session', sessionId: scoped.sessionId }, onActionAcknowledged: scoped.onActionAcknowledged };
  };
  const apiTokenComposerSubmissionFailure = (actionId: ActionId) =>
    actionId === 'session.message.send' && opts?.sessionMessageComposerSubmission
      // Session-scoped token transport cannot acquire the Account/Machine
      // source custody required by the private target-preparation adapter.
      ? { ok: false as const, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' }
      : null;
  const accountScopeFailure = (error: unknown) => isActionAccountScopeChangedError(error)
    ? { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }
    : error instanceof AccountStorageCurrentnessUnavailableError
      ? { ok: false as const, errorCode: error.code, error: error.message }
    : error instanceof ActionAdmissionHomeUnreachableError
      ? { ok: false as const, errorCode: 'server_unreachable', error: 'server_unreachable' }
      : null;
  const executeAction = async (actionId: ActionId, input: unknown, context?: UiActionExecutorContext, confirmInFlow = false): Promise<ActionExecuteResult> => {
    if (confirmInFlow) {
      const parsed = getActionSpec(actionId).inputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      input = parsed.data;
    }
    const { openRoute, archiveOperation, reviewedManagedMachine, voiceSpeechSource, ...actionContext } = context ?? {};
    const custodyFailure = opts?.filesystemActionDelivery?.actionId === actionId ? null : resolveUiFilesystemTransferCustodyFailure(actionId, input);
    if (custodyFailure) return custodyFailure;
    const api = await apiTokenTransport();
    if (api) {
      const failure = apiTokenComposerSubmissionFailure(actionId);
      return failure ?? await executeApiTokenAction(api, actionId, input, actionContext);
    }
    const serverId = resolveDefaultActionInvocationServerId(actionId, input, context);
    if (!serverId) return await (confirmInFlow ? ordinary().executeConfirmed : ordinary().execute)(actionId, input, actionContext);
    try {
      const execute = (signal?: AbortSignal) => withDefaultActionExecuteContext(opts, { ...actionContext, signal, openRoute, archiveOperation, voiceSpeechSource, archiveInput: input, serverId }, async (executor, account) => {
        const native = await resolveNativeManagedAction(actionId, input, account, actionContext, opts, reviewedManagedMachine);
        if (native && 'ok' in native) return native;
        const actionRequestId = native || confirmInFlow ? actionContext.actionRequestId ?? randomUUID() : actionContext.actionRequestId;
        const capturedContext = {
          ...actionContext,
          signal,
          serverId,
          ...(actionRequestId ? { actionRequestId } : {}),
          ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
          runtimeAccountId: account.accountId,
        };
        account.assertCurrent();
        throwIfAborted(signal);
        if (!native) return await (confirmInFlow ? executor.executeConfirmed : executor.execute)(actionId, input, capturedContext);
        return await executeManagedNativeActionWithApprovalObservation({ actionId: native.actionId,
          requestId: actionRequestId!, serverId, accountId: account.accountId,
          execute: () => executor.executeNativeManagedAction(native.actionId, input, capturedContext, confirmInFlow, native.retainedMachine) });
      }, actionId);
      return await execute(actionContext.signal);
    } catch (error) {
      const failure = accountScopeFailure(error);
      if (failure) return failure;
      throw error;
    }
  };
  return {
    previewSessionTargets: async (target, context, readInputs) => {
      const serverId = context?.serverId;
      if (!serverId || await apiTokenTransport()) return { coverage: 'unavailable', addresses: [], error: 'session_target_unavailable' };
      try {
        return await withDefaultActionExecuteContext(opts, { ...context, serverId }, (executor, account) =>
          executor.previewSessionTargets(target, { ...context, serverId, runtimeAccountId: account.accountId }), undefined, readInputs);
      } catch (error) {
        const failure = accountScopeFailure(error);
        return { coverage: 'unavailable', addresses: [], error: failure?.errorCode ?? 'session_target_unavailable' };
      }
    },
    execute: executeAction,
    executeConfirmed: (actionId, input, context) => executeAction(actionId, input, context, true),
    prepare: async (actionId, input, context, options) => {
      const { openRoute, archiveOperation, reviewedManagedMachine, voiceSpeechSource, ...actionContext } = context ?? {};
      const custodyFailure = opts?.filesystemActionDelivery?.actionId === actionId ? null : resolveUiFilesystemTransferCustodyFailure(actionId, input);
      if (custodyFailure) return { kind: 'settled', result: custodyFailure };
      const api = await apiTokenTransport();
      if (api) {
        const failure = apiTokenComposerSubmissionFailure(actionId);
        let result: Promise<ActionExecuteResult> | undefined;
        return failure ? { kind: 'settled', result: failure }
          : { kind: 'ready', invocation: { run: () => result ??= executeApiTokenAction(api, actionId, input, actionContext) } };
      }
      const serverId = resolveDefaultActionInvocationServerId(actionId, input, context);
      if (!serverId) return await ordinary().prepare(actionId, input, actionContext, options);
      const account = await captureLazyActionAccountContext(serverId, context?.signal);
      const archiveInvocation = createSessionArchiveInvocation(actionId, input, archiveOperation, account.serverId, context?.defaultSessionId);
      try {
        assertExpectedActionAccount(account, context);
        const settings = await readActionAdmissionSettings(account);
        account.assertCurrent();
        throwIfAborted(context?.signal);
        const listContributedActionDefinitions = actionContext.contributedActionInvocation?.listContributedActionDefinitions ?? opts?.listContributedActionDefinitions;
        const executor = buildDefaultActionExecutor({ ...opts, archiveInvocation,
          ...(voiceSpeechSource ? { voiceSpeechSource } : {}),
          ...(listContributedActionDefinitions ? { listContributedActionDefinitions } : {}),
          ...(openRoute ? { openRoute } : {}) }, { ...account, settings });
        const native = await resolveNativeManagedAction(actionId, input, account, actionContext, opts, reviewedManagedMachine);
        if (native && 'ok' in native) {
          finishSessionArchiveInvocation(archiveInvocation);
          account.dispose();
          return { kind: 'settled', result: native };
        }
        const capturedContext = {
          ...actionContext,
          serverId,
          ...(native ? { actionRequestId: actionContext.actionRequestId ?? randomUUID() } : {}),
          ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
          runtimeAccountId: account.accountId,
        };
        const preferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, {
          managedMachineCreationEnabled: settings.managedMachineCreationEnabled,
        });
        let prepared: import('@happier-dev/protocol/actions/executor/types').ActionPrepareResult;
        if (native) {
          if (preferenceFailure) prepared = { kind: 'settled', result: preferenceFailure };
          else if (options?.reviewOnly) {
            const review = await executor.prepare(actionId, input, capturedContext, options);
            prepared = review.kind === 'ready' ? { ...review, invocation: { run: async () =>
              await executor.executeNativeManagedAction(native.actionId, review.operation?.normalizedInput ?? input, capturedContext, false, native.retainedMachine) } } : review;
          } else prepared = { kind: 'ready', invocation: {
            run: async () => await executor.executeNativeManagedAction(native.actionId, input, capturedContext, false, native.retainedMachine),
          } };
        } else prepared = await executor.prepare(actionId, input, capturedContext, options);
        account.assertCurrent();
        account.dispose();
        if (prepared.kind === 'settled') {
          finishSessionArchiveInvocation(archiveInvocation);
          return prepared;
        }
        let result: ReturnType<typeof prepared.invocation.run> | undefined;
        return {
          kind: 'ready',
          ...(prepared.operation ? { operation: prepared.operation } : {}),
          invocation: {
            run: () => {
              result ??= account.runPrepared(async () => {
                try { return await prepared.invocation.run(); }
                finally { finishSessionArchiveInvocation(archiveInvocation); }
              }, getActionSpec(actionId).sideEffectClass);
              return result;
            },
          },
        };
      } catch (error) {
        finishSessionArchiveInvocation(archiveInvocation);
        account.dispose();
        const failure = accountScopeFailure(error);
        if (failure) return { kind: 'settled', result: failure };
        logPluginSurfaceDiagnostic({ pluginId: null, contributionId: null, surfaceId: null }, {
          kind: 'action_prepare_failed', actionId,
          ...(context?.actionRequestId ? { requestId: context.actionRequestId } : {}),
          failureDiagnostic: readActionOutputDiagnostic(withActionFailureCauseDiagnostic({}, error, 'action.prepare')),
        });
        throw error;
      }
    },
    replayApprovedApprovalRequest: async (args) => {
      const api = await apiTokenTransport();
      if (api) return { ok: false, effectAttempted: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      return await ordinary().replayApprovedApprovalRequest(args);
    },
  };
}
import { createVoiceAgentSettingsCatalogReader } from './voiceAgentSettingsCatalog';
import { createLegacyVoiceChatSelectionPreparer } from '@/sync/ops/settings/legacyVoiceChatImport';
import { createWidgetAreaActionDepsV1, prepareWidgetAreaSharingV1 } from './widgetAreaActionDeps';
