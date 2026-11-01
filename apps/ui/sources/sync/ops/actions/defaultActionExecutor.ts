import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { writeSessionApprovalReviewerOverrideV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { recordReviewCommentReads } from '@/sync/domains/reviews/comments/reviewRunComments';
import type { ReviewCommentListResponseV1, ReviewCommentGetResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { SessionArchiveActionInputV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { isSessionArchiveOperationCurrent, resolveSessionArchiveAddress, type SessionArchiveOperation } from '@/sync/domains/session/listing/sessionArchiveState';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import type { ApprovalStaleReason } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionMessageReplyMutationResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { inspectSessionContinuationOnMachine } from '@/sync/ops/sessionContinuationInspection';
import { projectAutomationEligibleEventsCatalogV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { readRpcFailureCode } from './rpcFailureCode';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { StoredContentPublicSharesListResponseV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
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
import { buildSessionPermissionRespondRpcParamsV1, buildSessionUserActionAnswerMap } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { buildMachineAgentsDetectRequest, projectMachineAgentsDetectResponse, projectAcpCatalogForMachineInventory, MachineAgentInventoryUnavailableError } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, listApprovalArtifactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema, readApprovalRequesterDecisionV1, requiresExactDaemonApprovalReplay, isMountedPluginBlockingApprovalEligibleForLiveClient, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { readOriginalAccountActionMachine } from '@/sync/api/externalActionAccountTransport';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { sessionGoalGet, sessionGoalSet, sessionGoalClear } from '@/sync/ops/sessionGoals';
import {
  sessionUsageLimitWaitResumeEnable, sessionUsageLimitWaitResumeCancel, sessionUsageLimitCheckNow,
  sessionUsageLimitSwitchAccountNow, sessionUsageLimitConsumeResetCredit,
  type SessionUsageLimitRecoveryOperationResult,
} from '@/sync/ops/sessionUsageLimitRecovery';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ActionSessionAddress } from '@happier-dev/protocol/actions/executor/types';
import { SessionTargetPreviewV1Schema, type SessionTargetPreviewV1, type SessionTargetSelectorV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { presentActionApproval, readActionApprovalSubject, readActionApprovalRoleId } from '@/components/approvals/actionApprovalPresentation';
import { buildRoleCatalog } from '@/sync/domains/roles/roleCatalog';
import { readApprovalReferenceForConfirmation } from '@/components/approvals/approvalReferenceReading';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD, type CurrentSessionPresentationActionResultV1 } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createUiProviderActionExecuteV1 } from './providerActionDeps';
import { isSessionStateFieldActionId } from '@happier-dev/protocol/actions';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { ActionOperationActionIdV1Schema, ActionOperationActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/actionOperations';
import { PROJECT_SOURCE_ACTION_SPECS_V1 } from '@happier-dev/protocol/actions/specs/projectSources';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, isProjectActionIdV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { SessionSpawnNewActionInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewActionResultV1Schema, readSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createUiSessionCapabilityActionDeps } from './sessionCapabilityActionDeps';
import { setSessionCapabilityV1 } from '@happier-dev/protocol/actions/executor/sessionCapabilities';
import { setSessionConnectedServiceAuthBinding } from '@/sync/ops/connectedServices/sessionAuthSwitch';
import { MachineWorkSummaryGetInputV1Schema } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { MachineVitalsActionIdSchema, MACHINE_VITALS_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineVitals';
import { MachineResourcesActionIdSchema, MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineResources';
import { MachineStorageActionIdSchema, MACHINE_STORAGE_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/storage';
import { MachineGuardActionIdSchema, MACHINE_GUARD_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineGuard';
import { resolveMachineGuardOperationTimeoutMs } from '@happier-dev/protocol/machines/guard/actionIdsV1';
import { MachineProcessesActionIdSchema, MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineProcesses';
import { machineResourcesPolicyGet } from '@/sync/ops/machineResourcesPolicy';
import { listMachineVitalsSummariesV1, readMachineVitalsResourcesProjectionV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { filterVisibleMachines, resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { ProjectContextUpdateInputV1Schema } from '@happier-dev/protocol/projects/projectContextV1';
import { decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { createTerminalUtf8ProjectionDecoder, TERMINAL_OUTPUT_GAP_MARKER } from '@/sync/domains/terminal/stream/runtime';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { createPromptDocInLibrary, updatePromptBundleInLibrary, setPromptDocFavorite, listPromptLibrary, readPromptDocInLibrary, updatePromptDocInLibrary, readSkillInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { SkillReadResultV1Schema, type SkillReadInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { resolvePromptDocCreateActionInputV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { MEMORY_DOCUMENT_ACTION_IDS_V1, MemoryActionInputSchemasV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readSkillRulesForItemV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { readSkillUsageCatalogV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { readPromptLibraryCatalogProjectionInContext, mutatePromptLibraryRoleOverrideInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { getActionSpec, type PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { isPluginDevLoopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
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
import { isActionApprovalRequiredByAccountSettings, resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import { PluginWebhookActionHttpPathsV1, type PluginWebhookPresentUserActionIdV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { projectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';
import { SessionModelTransitionRequestV1Schema, SessionModelTransitionResultV1Schema, type SessionModelTransitionRequestV1, type SessionModelTransitionResultV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, ActionExecuteResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PendingResetStartWaitingReasonV1Schema } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import type { ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import type { MemoryWindowV1, MemoryWindowRequestV1 } from '@happier-dev/protocol/memory/memoryWindow';
import { clearDaemonMemoryIndex } from '@/sync/domains/memory/clearDaemonMemoryIndex';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { AutonomousExchangeStatusV1Schema } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { readSessionExchangeStatus } from '@/sync/api/session/sessionExchangeApi';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { readCompleteActionSpecV1, supportsSessionMessageInputJsonSchema } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowActionInputV1, SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { machineContributionRegistryProjectionDescribe, machinePluginUiTargetedContributionsRead } from '@/sync/ops/machineContributionRegistryProjection';
import { machineWorkspaceFileSearch } from '@/sync/ops/machineWorkspaceFileSearch';
import { machineLanguageIntelligenceQuery, machineLanguageIntelligenceRestart } from '@/sync/ops/machineLanguageIntelligence';
import { DaemonWorkspaceFileReplacePreviewResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { classifyWorkspaceFileRpcError } from '@/sync/ops/machineWorkspaceFileRpcError';
import { randomUUID } from '@/platform/randomUUID';
import { executeCurrentUiContextAction, executeCurrentUiContextContributedAction, listCurrentUiContextContributedActionDefinitions } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import { buildMachineAgentInventoryDescriptors } from '@/agents/machineAgents/machineAgentCatalog';
import {
  readAgentInstallJobRpc,
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
  createModelIntentV2MetadataCasCandidate,
  isInactiveModelIntentSessionActiveError,
  runModelIntentAtAuthoritativeDisposition,
} from '@happier-dev/agents/session/state/metadataWriters';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { isModelRefGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { createUiLanguageIntelligenceApplyAction, createUiWorkspaceFileReplaceAction } from './workspaceFileReplaceAction';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { isActionAccountScopeChangedError } from '@/sync/domains/scope/actionAccountScopeError';

import { captureLazyActionAccountContext, captureApprovalSettlementAccount, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { resolveRequesterSessionSpawnDisposition } from './requesterSessionSpawnPreparation';
import { createUiArtifactAction } from './artifactActionDeps';
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
import { invokeWorkflowAuthoringAction } from './workflowAuthoringAction';
import { openSessionAuthoringDraft } from './sessionAuthoringOpenAction';
import { invokeSessionListOrganizationAction } from '@/components/sessions/shell/drag/sessionListOrganizationAction';
import { createSessionOrganizationMutationScopeForAccount, writeSessionOrganizationPin } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { scmReviewComparisonOfSource, scmReviewViewUnavailableReason } from '@/sync/domains/scm/diffSummary/selection';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { isVoiceHistoryActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { computeSessionConfigOptionControls } from '@/sync/domains/sessionControl/configOptionsControl';
import { computeSessionModelConfigOptionControls } from '@/sync/domains/models/modelOptions';
import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createSettingsDeclarationAction, isBuiltInLocalSettingMutation, resolveSettingsDeclarationOperationApprovalPolicy } from './settingsDeclarationAction';
import { createAtmosphereSettingServices } from './atmosphereSettingServices';
import { createSettingsOwnerActionExecutor } from './settingsOwnerActionExecutor';
import { getAutomationSettings, updateAutomationSettings } from '@/sync/api/automations/apiAutomations';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { createAppShellAction } from './appShellAction';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';
import { createBugReportSubmitAction } from './bugReportSubmitAction';
import { executeAppUpdateAction } from '@/updates/appUpdateActionRuntime';
import { createUpdatesAction, readCurrentMachineUpdateItem } from '@/updates/updatesActionRuntime';
import { startMachineAgentItemUpdate } from '@/updates/machineUpdateRuns';
import { cancelMachineAgentInstallJob, startAgentInstallJob } from '@/agents/machineAgents/installJobs/installJobStore';
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
import { executePromptPickerOpenAction } from '@/components/sessions/agentInput/commandMenu/promptPickerActionRuntime';
import { invokeNextPendingRequest } from '@/activity/source/pendingNavigationRuntime';
import { executeApiTokenAction, type ApiTokenActionTransport } from './apiTokenActionTransport';
import { createMachinePoolActionClient, MachinePoolActionError } from '@/sync/api/machines/machinePoolActions';
import { createMachinePresetActionClient, MachinePresetActionError } from '@/sync/api/machines/managedMachinePresets';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { executeManagedMachineNativeAction } from '@/sync/api/machines/managedMachineOrigination';
import { subscribeActionOperationByRequestId } from '@/sync/domains/actionOperations/subscribeActionOperationByRequestId';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createUiManagedMachineReferenceReader } from './managedMachineReferenceDeps';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createRunnerActivationClient, RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { RunnerActivationCreateRequestV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
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
import { nowServerMs } from '@/sync/runtime/time';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readAgentScopedPluginSettingsSnapshot } from '@/agents/registry/agentScopedPluginSettings';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { getSessionRunnerRuntimeStatus, restartSessionRunnerOnCurrentRuntime } from '@/sync/ops/sessionRunnerRestart';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import {
  preflightWorkspaceDestinationReplacement,
  startSessionHandoff as startSessionHandoffOp,
} from '@/sync/ops/sessionHandoffs';
import { createWorkspaceSyncRelationshipOnController } from '@/sync/ops/workspaceSyncRelationshipCreateRpc';
import { listWorkspaceSyncRelationshipsOnController } from '@/sync/ops/workspaceSyncRelationshipsListRpc';
import {
  disableWorkspaceSyncRelationship,
  enableWorkspaceSyncRelationship,
  flushWorkspaceSyncRelationship,
  terminatePersistedWorkspaceSyncRelationship,
} from '@/sync/ops/workspaceSync';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
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
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { sync } from '@/sync/sync';
import { executeListReorderAction } from './listReorderAction';
import { executeTodoSessionLinkAction } from './todoSessionLinkAction';
import { executeInternalTaskHostAction } from './internalTaskAction';
import { createHomeDomainActionExecutorForScope } from '@/sync/api/home/homeDomainActions';
import { createUiPersonalSavedSecretActionExecute } from '@/sync/ops/settings/personalSavedSecretActionHost';
import { createSessionOrganizationResourceAction, isSessionOrganizationResourceAction } from '@/sync/ops/sessionOrganization/sessionOrganizationAction';
import { resolveSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { writeApprovalRequestArtifact } from './approvalArtifactWriter';
import { publishAcpSessionModeOverrideToMetadata } from '@/sync/state/acpSessionModeOverridePublish';
import { createUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { admitSessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { installPromptRegistryItemInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
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
import { createPluginExecutionOriginActionDeps } from './pluginExecutionOriginActionDeps';
import { createUiPluginSettingsAdministrationAction } from './pluginSettingsAdministrationAction';
import { invokeScopeAction } from './scopeActionFamily';
import { invokeDiagnosticAction } from '@/components/settings/diagnosis/diagnosticsActionRuntime';
import { signOutEverywhere } from '@/sync/api/account/signOutEverywhere';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
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

function projectSessionModelTransitionFailure(transition: Extract<SessionModelTransitionResultV1, { ok: false }>) {
  return {
    ok: false as const,
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

function projectSessionInteractionRpcResult(result: unknown): unknown {
  return result === undefined || result === null ? { ok: true } : result;
}

function projectSessionInteractionRpcFailure(error: unknown) {
  const errorCode = readRpcFailureCode(error);
  if (!errorCode) throw error;
  return { ok: false, errorCode, errorMessage: error instanceof Error ? error.message : errorCode };
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

/**
 * Re-exported from the Protocol owner of `ApprovalExecutionOriginV1`: the list
 * of origin facts this client cannot verify belongs beside the schema that
 * introduces them, not in a hand-maintained consumer-side enumeration.
 */
export { requiresExactDaemonApprovalReplay };

export function resolveApprovalReplayRoute(approval: Readonly<{
  v: number;
  executionOriginV1?: Readonly<{ serverId: string; serverIdentityId?: string }>;
}> | null): ApprovalReplayRoute | null {
  if (!approval?.executionOriginV1) return null;
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
type UiProtocolActionExecutor = Pick<ReturnType<typeof createActionExecutor>, 'prepare' | 'execute' | 'replayApprovedApprovalRequest'> & Readonly<{
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
  /** One captured Voice editor intent; never serialized into Action input or approval. */
  voiceSettingsEdit?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['voiceSettingsEdit'];
  /** Mounted History delivery; the consumer retains Account binding and delete-wins ownership. */
  voiceHistory?: import('@/voice/history/voiceHistoryActions').VoiceHistoryActionPorts;
  /** Mounted model-pack progress presentation; Action policy owns admission. */
  voiceModelPackPresentation?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['voiceModelPackPresentation'];
  /** Captured profile candidate; Settings admission remains in the shared executor. */
  publicProfileAtmosphereDraft?: import('@/components/settings/catalog/settingDeclarations').SettingsMutationServices['publicProfileAtmosphereDraft'];
  /** Fresh invocation's exact Session admission objects; never serialized or shared by cached executors. */
  archiveInvocation?: SessionArchiveInvocation;
  /** Private presentation leaf for this invocation; never enters Action custody. */
  openRoute?: (route: string) => void | Promise<void>;
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
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
  openSession?: (sessionId: string, options?: OpenSessionOptions) => void | Promise<void>;
  runtimeActions?: CreateDefaultRuntimeActionExecutorInput;
  /** Native/process task transport for local client Actions; admission stays with this executor. */
  homeRuntimeRunner?: SystemTaskRunner;
  /** Mounted presentation only; the existing blocking executor retains input and decision custody. */
  onBlockingApprovalPending?: (input: Readonly<{ artifactId: string; signal?: AbortSignal }>) => void;
  /** Exact mounted invocation whose intent must remain live through shared approval. */
  hostActionApprovalLifetime?: Readonly<{ actionId: ActionId; signal: AbortSignal; surface: 'ui' }>;
  listContributedActionDefinitions?: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>;
  readContributedActionSchemas?: NonNullable<ActionExecutorDeps['readContributedActionSchemas']>;
  /** Optional surface-local policy composed with the canonical Action settings policy. */
  isActionEnabled?: NonNullable<ActionExecutorDeps['isActionEnabled']>;
  /** Mounted device-setting lifetime guard, evaluated at the admitted persistence boundary. */
  beforeLocalSettingCommit?: () => void;
  /** Optional delivery leaf used by a surface that needs specialized ingress semantics. */
  sessionSendMessage?: NonNullable<ActionExecutorDeps['sessionSendMessage']>;
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
  /** Trusted per-invocation precondition, evaluated on the metadata CAS candidate. */
  sessionStateMetadataPreprocess?: UiSessionStateMetadataPreprocess;
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
  /** Original mounted Account administration intent retained by the incumbent approval waiter. */
  pluginAccountAdministrationIsCurrent?: () => boolean;
  /** Trusted raw projection already owned by the mounted administration surface. */
  pluginAccountAdministrationProjection?: () => import('@happier-dev/protocol').PluginProjectionV2 | null;
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
  machineProcessesAction?: NonNullable<ActionExecutorDeps['machineProcessesAction']>;
  machineResourcesPolicyAction?: NonNullable<ActionExecutorDeps['machineResourcesPolicyAction']>;
  usageSourceDismiss?: Parameters<typeof createUiUsageSourceActionPort>[1];
  /** A mounted recap preview may provide the same client rasterization boundary. */
  usageRecapRender?: Parameters<typeof createUiUsageActionPorts>[1];
  projectWorkerAction?: NonNullable<ActionExecutorDeps['projectWorkerAction']>;
  /** Local keyholding-host delivery; never enters Action input, approval or result. */
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  /** Optional Session human-discussion family port bound by a mounted surface. */
  discussionAction?: NonNullable<ActionExecutorDeps['discussionAction']>;
  /** Exact mounted canvas for local pane interactions; external callers use the focused publication. */
  /**
   * The Home family port, bound by the caller to the exact Home and Account.
   * Without it, the shared executor rejects Home and Teams actions as unsupported.
   */
  homeDomainAction?: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  teamMembershipHistoryAction?: NonNullable<ActionExecutorDeps['teamMembershipHistoryAction']>;
  /** Subordinate target-bound transport for a confirmed workspace conflict Action. */
  workspaceSyncConflictResolve?: NonNullable<ActionExecutorDeps['workspaceSyncConflictResolve']>;
  workflowAction?: NonNullable<ActionExecutorDeps['workflowAction']>;
  /** A mounted WorkBoard binds current UI membership and its existing Account save queue. */
  workBoardArtifacts?: NonNullable<ActionExecutorDeps['workBoardArtifacts']>;
  /** Host-page defaults remain outside Action input and personal persisted copies. */
  resolveWidgetAreaPresets?: Parameters<typeof createWidgetAreaActionDepsV1>[1];
  widgetAreaIsCurrent?: () => boolean;
  }>, accountContext?: LazyActionAccountContext & { settings: Awaited<ReturnType<LazyActionAccountContext['readSettings']>> }, followReadInputs?: SessionFollowReadInputs): UiProtocolActionExecutor & Readonly<{
    executeNativeManagedAction(actionId: ManagedMachineActionIdV1, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
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
    const target = args.context.externalActionTarget;
    if (!accountContext || target?.kind !== 'machine' || !target.machineId.trim()) return { ok: false, errorCode: 'runtime_action_disabled', error: 'browser_automation_unavailable' };
    const result = await executeOriginalAccountMachineAction({ account: accountContext, actionId: args.actionId,
      requestId: randomUUID(), machineId: target.machineId, machineTarget: target, input: args.input,
      actionCaller: args.context.actionCaller,
      authority: args.context.authority, signal: args.context.signal });
    return result.ok ? result.result : result;
  });
  const isMachineOwnedPluginAction = (actionId: string, input: unknown) => {
    const pluginActionId = actionId === 'approval.request.create' && input !== null && typeof input === 'object'
      && 'actionId' in input && typeof input.actionId === 'string' ? input.actionId : actionId;
    return isPluginDevLoopActionIdV1(pluginActionId) && getActionSpec(pluginActionId).executionPlacement === 'machine';
  };
  const executeMachineOwnedPluginAction = async (args: Readonly<{
    actionId: string; input: unknown; context: ActionExecutorContext;
  }>) => {
    // Mounted surfaces supply this target through the admitted controller, not
    // Action input, presence ranking, or the UI's default Machine selection.
    const pluginInput = args.actionId === 'approval.request.create' && args.input !== null && typeof args.input === 'object'
      && 'actionArgs' in args.input ? args.input.actionArgs : args.input;
    const machineOwnedPluginAction = isMachineOwnedPluginAction(args.actionId, args.input);
    const requestedMachineId = pluginInput !== null && typeof pluginInput === 'object'
      && 'machineId' in pluginInput && typeof pluginInput.machineId === 'string'
      ? pluginInput.machineId : undefined;
    const mountedMachineId = args.context.executionRunTargetMachineId
      ?? (args.context.surface !== 'plugin' ? args.context.defaultSessionMachineId : undefined);
    if (requestedMachineId && mountedMachineId && requestedMachineId !== mountedMachineId) {
      return { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' };
    }
    const machineId = requestedMachineId ?? mountedMachineId;
    if (!accountContext || !machineId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    // Delegate admission with the original host origin. The receiving daemon
    // owns the retained candidate, Action policy and sole approval Artifact.
    // Mounted plugins have their own sealed pluginInvocation provenance. Do
    // not reinterpret that surface as a host Agent/CLI requester invocation.
    const invocation = machineOwnedPluginAction && args.context.surface !== 'ui' && args.context.surface !== 'plugin'
      ? ExternalActionRequesterInvocationV1Schema.safeParse({
          caller: args.context.actionCaller ?? { kind: 'host' }, surface: args.context.surface, authority: args.context.authority,
          callerPermissionMode: args.context.callerPermissionMode, callerInputConstraints: args.context.callerInputConstraints,
          workspaceWrites: args.context.workspaceWrites, defaultSessionId: args.context.defaultSessionId,
        }) : null;
    if (invocation && !invocation.success) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    const execution = await executeOriginalAccountMachineAction({ account: accountContext,
      actionId: args.actionId, input: args.input, machineId,
      requestId: args.context.actionRequestId ?? randomUUID(),
      actionCaller: args.context.actionCaller,
      ...(invocation?.success ? { invocation: invocation.data } : {}),
      authority: args.context.authority, signal: args.context.signal });
    return execution.ok ? execution.result : execution;
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
  const capturedFamilyPorts = accountContext ? createCapturedScopeFamilyPorts(accountContext, opts?.discussionAttachmentSources) : null;
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

  const connectedServiceAction = accountContext ? createUiConnectedServiceAction(accountContext) : undefined;
  const updateApprovalArtifact = async ({ artifactId, request, context }: Readonly<{
    artifactId: string; request: ApprovalRequest | TargetActionApprovalRequestV1; context?: ActionExecutorContext;
  }>) => {
    // Only the known Home-open ACK and a decided terminal outcome may outlive their
    // invoking presentation/intent; target decisions keep their captured Account lifetime.
    const settlement = accountContext && request.v === 2
      ? await captureApprovalSettlementAccount(accountContext, request) : null;
    const artifactAccount = settlement ?? accountContext;
    try {
      const written = await writeApprovalRequestArtifact({
        artifactId, request,
        read: async id => await (artifactAccount ? artifactAccount.fetchArtifact(id, { fresh: true }) : sync.fetchArtifactWithBody(id, { fresh: true })),
        write: async (basis, header, body) => {
          context?.assertDecisionAuthorityCurrent?.();
          if (artifactAccount) {
            await artifactAccount.updateArtifact(artifactId, header, body, basis, context?.assertDecisionAuthorityCurrent);
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
  const usageActions = accountContext ? createUiUsageActionPorts(accountContext, opts?.usageRecapRender) : undefined;
  const scmActionExecute = opts?.scmActionExecute ?? createUiScmAction(accountContext, { onDispatched: opts?.onScmDispatched });
  const publicProfileHome = opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction;
  let deps: ActionExecutorDeps = {
    buildApprovalPreview: async ({ actionId, input, context, defaultPreview }) => {
      if (actionId !== 'session.spawn_new' || !accountContext || !machineAccessAction) return defaultPreview;
      const parsed = SessionSpawnNewActionInputV2Schema.safeParse(input);
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
        accountContext.assertCurrent(); throwIfAborted(context.signal);
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({
          scope: accountContext.accountLifetime.scope, activeRequest: accountContext.request,
        }, authority => readSessionSnapshotForAuthority({ authority, sessionId: ref.sessionId, isCurrent: accountContext.accountLifetime.isCurrent }));
        accountContext.assertCurrent(); throwIfAborted(context.signal);
        if (!session || !admitProjectWorkspaceCensusForSubject({
          subject: { kind: 'session', ownerAccountId: session.ownerAccountId, access: session.access, accessLevel: session.accessLevel },
          rowServerId: ref.serverId, censusServerId: accountContext.serverId,
          viewerAccountId: accountContext.accountLifetime.scope.accountId,
        }).admitted) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
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
      return await invokeScopeAction(actionId, input, context);
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
    notificationConfigurationAction: createNotificationConfigurationAction(accountContext ?? null),
    bugReportSubmit: createBugReportSubmitAction(accountContext ?? null),
    appUpdateAction: executeAppUpdateAction,
    updatesAction: createUpdatesAction(accountContext),
    clipboardWrite: async ({ text, signal }) => {
      throwIfAborted(signal);
      accountContext?.assertCurrent();
      const copied = await setClipboardStringSafe(text);
      throwIfAborted(signal);
      accountContext?.assertCurrent();
      return copied ? { status: 'copied' } : { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' };
    },
    hostExternalSessionAction: executeExternalSessionBrowseAction,
    settingsDeclarationAction: createSettingsDeclarationAction({
      serverId: accountContext?.serverId,
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
        ...(accountContext && opts?.voiceSettingsEdit ? { voiceSettingsEdit: opts.voiceSettingsEdit } : {}),
        ...(accountContext && opts?.voiceModelPackPresentation ? { voiceModelPackPresentation: opts.voiceModelPackPresentation } : {}),
        ...(accountContext ? createAtmosphereSettingServices(accountContext) : {}),
        ...(accountContext && opts?.publicProfileAtmosphereDraft ? { publicProfileAtmosphereDraft: opts.publicProfileAtmosphereDraft } : {}),
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
              return { status: 'unavailable', reason: error instanceof HappyError ? error.code ?? 'encryption_conversion_unavailable' : 'encryption_conversion_unavailable',
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
    pluginsDevLoopAction: executeMachineOwnedPluginAction,
    ...(opts?.pluginSessionHookManagementAction ? { pluginSessionHookManagementAction: opts.pluginSessionHookManagementAction } : {}),
    ...(accountContext ? { npmRegistryProfileAction: createUiNpmRegistryProfileAction(accountContext, opts?.npmRegistryProfileDelivery) } : {}),
    ...(accountContext ? createPluginAccountAdministrationActionDeps(accountContext, opts?.pluginAccountAdministrationIsCurrent,
      opts?.pluginAccountAdministrationProjection) : {}),
    ...(accountContext ? createPluginExecutionOriginActionDeps(accountContext) : {}),
    ...(accountContext ? { pluginSettingsAdministrationAction: createUiPluginSettingsAdministrationAction(accountContext) } : {}),
    automationConversationAction: async (args) => args.context
      ? await executeMachineOwnedPluginAction({ actionId: args.actionId, input: args.input, context: args.context })
      : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' },
    ...(accountContext ? { artifactAction: createUiArtifactAction(accountContext, { onPublicLinkIssued: opts?.onPublicLinkIssued }) } : {}),
    ...(accountContext ? {
      profileActionExecute: createUiProfileActionExecuteV1(accountContext, { onRpcDispatched: opts?.onProviderRpcDispatched }),
      mcpServerAction: createUiMcpServerActionExecuteV1(accountContext, connectedServiceAction, {
        ...(promptLibraryStore?.organization ? { registryActionExecute: createUiRegistryActionExecuteV1(accountContext, promptLibraryStore.organization) } : {}),
        ...((opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction) ? {
          personalSavedSecretActionExecute: createUiPersonalSavedSecretActionExecute(accountContext, (opts?.homeDomainAction ?? capturedFamilyPorts!.homeDomainAction)!),
        } : {}),
      }),
      providerActionExecute: createUiProviderActionExecuteV1(accountContext, { onRpcDispatched: opts?.onProviderRpcDispatched }),
    } : {}),
    ...(accountContext ? { remoteHostActionExecute: createUiRemoteHostActionExecuteV1(accountContext, opts?.openRoute) } : {}),
    ...(accountContext ? { artifactAccessAction: createArtifactAccessActionsV1({
      read: (artifactId, options) => accountContext.readArtifactPublicLinkResource(artifactId, options?.signal),
      transport: accountContext.artifactAccessGrants,
    }) } : {}),
    ...(opts?.workflowAction
      ? { workflowAction: opts.workflowAction }
      : accountContext
        ? { workflowAction: createUiWorkflowAction({ account: accountContext }) }
        : {}),
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
          const { session } = await runWithServerRequestAuthorityForServerAccountScope({
            scope: accountContext.accountLifetime.scope, activeRequest: accountContext.request,
          }, authority => readSessionSnapshotForAuthority({ authority, sessionId: exact.sessionId,
            isCurrent: () => !signal?.aborted && accountContext.accountLifetime.isCurrent() }));
          throwIfAborted(signal); accountContext.assertCurrent();
          return session.id === exact.sessionId ? { kind: 'unique', address: exact } : { kind: 'incomplete' };
        } catch (error) {
          throwIfAborted(signal);
          return error instanceof SessionSnapshotReadError && error.httpStatus === 404 ? { kind: 'none' } : { kind: 'incomplete' };
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
      if (isMountedPluginBlockingApprovalEligibleForLiveClient(request) && origin.caller.kind === 'plugin' && origin.machineId) {
        // Reuse the exact daemon's current source producer. A retained app
        // invocation keeps its operands locally; its plugin never becomes host.
        const current = await machinePluginUiTargetedContributionsRead(origin.machineId, {
          serverId: accountContext.serverId, pluginId: origin.caller.pluginId,
          accountLifetime: accountContext.accountLifetime, ...(signal ? { signal } : {}),
        });
        accountContext.assertCurrent();
        if (signal?.aborted || !current.supported) return stale('currentness_read_failed');
        return pluginSourceCustodyV1Equal(origin.caller.sourceCustody, current.targetedContributions.target.sourceCustody)
          || stale('plugin_source_changed');
      }
      // Exact-daemon families verify their signed input at that daemon. For an
      // app-owned Account proposal, verify against the fresh Home installation
      // identity before the Artifact claim and again immediately before effect.
      const authorization = origin.externalActionExecutionAuthorization;
      if (!authorization || requiresExactDaemonApprovalReplay(request)) return true;
      if (request.v !== 2 || !origin.machineId || !origin.target || !origin.externalActionInputSignature
        || origin.actionId !== request.actionId
        // Public creation authenticates proposal authoring. Its installed producer
        // signs the reviewed target/input below; the carrier never authorizes the effect.
        || (authorization.binding.actionId !== request.actionId && authorization.binding.actionId !== 'approval.request.create')
        || origin.caller.kind !== 'session' || request.createdBy.sessionId !== origin.caller.sessionId) return stale('credential_changed');
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
    isActionApprovalRequired: (actionId, ctx, input, defaultUiConfirmation?: boolean) => {
      const operationSettings = actionId === 'settings.invoke' ? accountContext?.readLiveSettings() : null;
      const anchor = input && typeof input === 'object' && 'anchor' in input && typeof input.anchor === 'string' ? input.anchor : '';
      const operationPolicy = operationSettings ? resolveSettingsDeclarationOperationApprovalPolicy(anchor, operationSettings) : undefined;
      const operationSafety = actionId === 'settings.invoke' ? operationPolicy?.requiresApproval === false ? 'safe' : 'danger' : undefined;
      return isActionApprovalRequiredByAccountSettings(actionId, readAccountSettingsSnapshot(), {
        surface: ctx.surface ?? null,
        authority: ctx.authority,
        actionCaller: ctx.actionCaller,
        presentUserConfirmation: ctx.presentUserConfirmation,
      }, { defaultSafety: operationSafety, defaultUiConfirmation: defaultUiConfirmation ?? operationPolicy?.uiConfirmationRequired, input });
    },
    ...createUiExecutionRunActionDeps(accountContext?.accountLifetime.scope, accountContext),
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
      const featureId = getActionRequiredServerFeatureId(args.actionId, args.context);
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
        }, isCurrent);
      }
      const opensMicrophone = actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.recover'
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
        const { executeVoiceBriefOperation } = await import('@/components/voice/brief/voiceBriefActionRuntime');
        accountContext.assertCurrent();
        throwIfAborted(context.signal);
        const operation = actionId === 'ui.voice_global.brief.request' ? 'request' : actionId === 'ui.voice_global.brief.retry' ? 'retry'
          : actionId === 'ui.voice_global.brief.close' ? 'close' : 'stop';
        const result = executeVoiceBriefOperation(operation, input as Readonly<{ expectedAttemptId?: string }>);
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
    uiCurrentContextAction: (request) => executeCurrentUiContextAction(request, { execute: executor.execute, context: request.context }),
    accountHomeContinuationAction: (request) => executeCurrentUiContextAction(request),
    sessionAuthoringOpen: args => openSessionAuthoringDraft(args, accountContext ?? undefined),
    invokeContributedAction: (request) => executeCurrentUiContextContributedAction(request, {
      execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
    }, accountContext?.accountLifetime),
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
    workflowAuthoringAction: invokeWorkflowAuthoringAction,
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
    listReorder: executeListReorderAction,
    todoSessionLink: executeTodoSessionLinkAction,
    internalTaskAction: executeInternalTaskHostAction,
    sessionTerminalAction: invokeSessionTerminalAction,
    actionOperationAction: async ({ actionId, input, signal }) => {
      try {
        return await executeActionOperationActionV1({
          actionId, input, ...(signal ? { signal } : {}),
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
    sessionOpen: async ({ sessionId, serverId, intent, resumeRequest, approvedNewDirectoryCreation, actionRequestId, tabId, destination, signal }, context) => {
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
        const target = resolveSessionActionDefaultBackend({ session });
        // Resolve from the fresh exact-Home snapshot, not a same-id row in the focused Home.
        const machineTarget = resolveMachineControlTargetForSessionFromState({
          ...state, sessions: { [sessionId]: session }, sessionListRowsByServerId: {},
        }, { ...accountContext.accountLifetime.scope, sessionId });
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
          executionAuthority: context?.authority ?? 'account_automation',
          executionAuthorization: { provenance: 'user_request', requestId: actionRequestId ?? randomUUID() },
          ...(approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true } : {}),
          ...(target?.defaultAgentId ? buildResumeSessionExtrasFromUiState({
            agentId: target.defaultAgentId, settings, pluginSettings, session,
          }) : {}),
        });
        accountContext.assertCurrent();
        if (resumed.type === 'error') return { ok: false, errorCode: resumed.rpcErrorCode ?? resumed.errorCode, error: resumed.errorMessage };
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

    sessionRuntimeRefresh: async ({ sessionId, machineId, serverId, signal }) => withAccountLifetime(signal, async signal => {
      accountContext?.assertCurrent();
      throwIfAborted(signal);
      const runtimeState = await getSessionRunnerRuntimeStatus({ sessionId, machineId, serverId, signal });
      accountContext?.assertCurrent();
      throwIfAborted(signal);
      if (!runtimeState || runtimeState.machineId !== machineId) {
        return { ok: false, status: 'unsupported_daemon', sessionId, reasonCode: 'unsupported_daemon_version' } as const;
      }
      const result = await restartSessionRunnerOnCurrentRuntime({ runtimeState, serverId, signal });
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

    workspaceSyncRelationshipsList: async ({ input, signal }) => await listWorkspaceSyncRelationshipsOnController({
      input, account: accountContext, ...(signal ? { signal } : {}),
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
      accountContext?.assertCurrent();
      return { v: 1 as const, relationshipId: input.relationshipId, terminated: true as const };
    },

    workspaceSyncRelationshipDisable: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext.assertCurrent();
      await disableWorkspaceSyncRelationship({ serverId: scope.serverId, ...input, ...(signal ? { signal } : {}) });
      accountContext.assertCurrent();
      return { v: 1 as const, relationshipId: input.relationshipId, enabled: false as const };
    },

    workspaceSyncRelationshipEnable: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext.assertCurrent();
      await enableWorkspaceSyncRelationship({ serverId: scope.serverId, ...input, ...(signal ? { signal } : {}) });
      accountContext.assertCurrent();
      return { v: 1 as const, relationshipId: input.relationshipId, enabled: true as const };
    },

    workspaceSyncRelationshipFlush: async ({ input, serverId, signal }) => {
      const scope = accountContext?.accountLifetime.scope;
      if (!scope || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      accountContext.assertCurrent();
      const status = await flushWorkspaceSyncRelationship({ serverId: scope.serverId, ...input, ...(signal ? { signal } : {}) });
      accountContext.assertCurrent();
      return { v: 1 as const, relationshipId: input.relationshipId, status };
    },

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

    sessionSpawnNewDirectoryApprovalPreflight: createUiSessionSpawnNewDirectoryApprovalPreflight(accountContext ?? null),
    sessionSpawnNew: async ({
      context,
      admittedInput,
      creationKey,
      actionCaller: _actionCaller,
      actionRequestId,
      signal,
    }) => {
      if (!admittedInput) return { type: 'error' as const, code: 'invalid_input' as const, retryable: false as const };
      // The daemon re-admits public selections. Host launch expansion (including
      // the original Discussion recipe sidecar) is never a transport payload.
      const input = { ...admittedInput, creationKey };
      const { placementOrigin, ...exactInput } = input;
      const serverId = resolveServerProfileScopeIdForIdentifier(input.executionTarget.serverId);
      const machine = storage.getState().machineListByServerId[serverId]
        ?.find((candidate) => candidate.id === input.executionTarget.machineId);
      if (input.authoringOrigin && !supportsMachineOperationProtocolCapabilityV1(
        machine?.operationProtocolCapabilities, 'sessionSpawnAuthoringOrigin',
      )) return { type: 'error' as const, code: 'update_required' as const, retryable: false as const,
        details: { kind: 'update_required' as const, operation: 'session.spawn_new' as const,
          component: 'daemon' as const, reason: 'session_spawn_authoring_origin_update_required' as const } };
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
      if (accountContext) {
        accountContext.assertCurrent();
        if (accountContext.serverId !== serverId) return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
        if (!machineAccessAction) return { type: 'error' as const, code: 'target_unavailable' as const, retryable: true as const };
        const access = await machineAccessAction({ actionId: 'machines.access.grants.list',
          input: { serverId, machineId: input.executionTarget.machineId }, context: context ?? {}, ...(signal ? { signal } : {}) });
        accountContext.assertCurrent();
        const disposition = resolveRequesterSessionSpawnDisposition({ accountId: accountContext.accountId,
          machineId: input.executionTarget.machineId, access });
        if (disposition.kind === 'refused') return disposition.result;
        if (disposition.kind === 'requester') {
          const execution = await executeOriginalAccountMachineAction({ account: accountContext,
            actionId: 'session.spawn_new', requestId: actionRequestId ?? context?.actionRequestId ?? randomUUID(),
            machineId: input.executionTarget.machineId,
            // Requester HTTP and direct Machine RPC consume the same spawn owner's budget.
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            input: projectSessionSpawnNewActionInputV2(placementOrigin && supportsOrigin ? { ...exactInput, placementOrigin } : exactInput),
            actionCaller: _actionCaller, authority: context?.authority, ...(signal ? { signal } : {}) });
          accountContext.assertResultCurrent(getActionSpec('session.spawn_new').sideEffectClass);
          if (!execution.ok && execution.errorCode === 'outcome_uncertain') {
            return { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'unknown' as const };
          }
          if (!execution.ok) throw Object.assign(new Error(execution.error), { code: execution.errorCode });
          return readSessionSpawnNewActionResultV1(SessionSpawnNewActionResultV1Schema.parse(execution.result));
        }
      }
      accountContext?.assertCurrent();
      return await dispatchSessionSpawnNewWithManagerPreparation({
        payload: placementOrigin && supportsOrigin ? { ...exactInput, placementOrigin } : exactInput,
        signal,
      });
    },

    presentUserActionConfirmation: accountContext ? async ({ actionId, input, context }) => {
      accountContext.assertCurrent();
      throwIfAborted(context.signal);
      if (opts?.presentUserActionConfirmation) {
        const confirmed = await opts.presentUserActionConfirmation({ actionId, input, context });
        if (context.signal?.aborted) return false;
        accountContext.assertCurrent();
        return confirmed;
      }
      const { Modal } = await import('@/modal');
      const presentationInput = { actionId, actionArgs: input };
      const reference = readActionApprovalSubject(presentationInput);
      const reading = await readApprovalReferenceForConfirmation(reference, accountContext, context.signal);
      const roleId = readActionApprovalRoleId(presentationInput);
      const roleResult = roleId && accountRoleAction ? await accountRoleAction({ actionId: 'roles.get', input: { roleId }, context }) : null;
      const roleEntry = roleResult ? RoleActionOutputSchemasV1['roles.get'].safeParse(roleResult) : null;
      const role = roleEntry?.success ? buildRoleCatalog({ items: [roleEntry.data], overrides: {} })[0] : null;
      throwIfAborted(context.signal);
      accountContext.assertCurrent();
      // A Machine-targeted Action names its paths the way that Machine's home reads them (`~/work/app`).
      const targetMachineId = input && typeof input === 'object' && typeof (input as { machineId?: unknown }).machineId === 'string'
        ? (input as { machineId: string }).machineId : null;
      const homeDir = targetMachineId
        ? resolveServerScopedMachine(storage.getState(), accountContext.serverId, targetMachineId)?.metadata?.homeDir?.trim() || null : null;
      const formatPath = homeDir ? (path: string) => formatPathRelativeToHome(path, homeDir) : null;
      const presentation = presentActionApproval({ ...presentationInput, subject: reading.named ? reading.text : null, role, formatPath });
      const confirmed = actionId === 'account.delete'
        ? await Modal.prompt(t('settingsAccount.deleteAccountConfirmTitle'), t('settingsAccount.deleteAccountConfirmBody'), {
          placeholder: 'DELETE', confirmText: t('settingsAccount.deleteAccount'),
        }) === 'DELETE'
        : await Modal.confirm(presentation.title ?? t('approvals.untitled'), presentation.summary ?? '',
          { ...(presentation.confirmLabel ? { confirmText: presentation.confirmLabel } : {}),
            ...(presentation.destructive ? { destructive: true } : {}),
            ...(context.signal ? { signal: context.signal } : {}), });
      // Let the Action owner project invocation cancellation before checking
      // Account currentness, which also throws for an aborted invocation.
      if (context.signal?.aborted) return false;
      accountContext.assertCurrent();
      return confirmed;
    } : undefined,

    approvalRequestApprovedReplay: async ({ artifactId, request, decision, context, requestId, signal }) => {
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
        const result = await actionSessionRpc<unknown, { artifactId: string; sessionId: string; decision: 'approve' | 'reject' | 'cancel'; decisionSource?: 'voice' }>({
          serverId: accountContext.serverId, sessionId: subject.personaSessionRef.sessionId,
          method: RPC_METHODS.APPROVAL_REQUEST_DECIDE,
          // Private authenticated transport metadata, not caller-authored Action input.
          payload: { artifactId, sessionId: subject.personaSessionRef.sessionId, decision,
            ...(context.surface === 'voice' ? { decisionSource: 'voice' as const } : {}) }, timeoutMs: null,
          ...(context?.assertDecisionAuthorityCurrent ? { onIssued: context.assertDecisionAuthorityCurrent } : {}),
          ...(signal ? { signal } : {}),
        });
        accountContext.assertResultCurrent(getActionSpec('approval.request.decide').sideEffectClass);
        const settled = getActionSpec('approval.request.decide').outputSchema?.safeParse(result);
        if (settled?.success) return { ok: true, result: settled.data };
        const failure = ActionExecuteFailureSchema.safeParse(result);
        return failure.success ? failure.data : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
      }
      if (request.v !== 2) return null;
      // Currentness above has revalidated the daemon-produced source identity.
      // Only this existing live continuation may spend its retained app operands;
      // durable/signed/remote replay keeps the exact-daemon route below.
      if (isMountedPluginBlockingApprovalEligibleForLiveClient(request)
        && approvalCoordinator.getLiveWaiterCount(artifactId) > 0
        && accountContext && (context.surface === 'ui' || context.surface === 'voice') && context.authority === 'present_user'
        && !context.externalActionCredential && !context.externalActionExecutionAuthorization
        && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host')) return null;
      if (!requiresExactDaemonApprovalReplay(request)) {
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
      const machineId = request.v === 2 ? request.executionOriginV1.machineId?.trim() ?? '' : '';
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
        return await replayApprovedApprovalRequestAtExactDaemon({
          artifactId,
          executionTarget: { ...replayRoute, machineId },
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (accountContext && request.v === 2 && !context.externalActionCredential
        && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization
        && (!context.actionCaller || context.actionCaller.kind === 'host')) {
        if (!requestId || (context.surface !== 'ui' && context.surface !== 'voice') || context.authority !== 'present_user'
          || !isApprovalExecutionOriginCurrentForAccountContext({ origin: request.executionOriginV1,
            accountServerId: accountContext.serverId, accountId: accountContext.accountId })) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        const execution = await executeOriginalAccountMachineAction({ account: accountContext,
          actionId: 'approval.request.decide', requestId, machineId,
        input: { artifactId, decision: decision ?? 'approve',
            serverIdentityId: replayRoute.serverIdentityId, originServerId: replayRoute.originServerId },
          ...(signal ? { signal } : {}) });
        accountContext.assertResultCurrent(getActionSpec('approval.request.decide').sideEffectClass);
        if (execution) return execution;
      }
      if (decision === 'approve') {
        const replay = ActionExecuteResultSchema.safeParse(await replayApprovalRequestAtExactDaemon({
          artifactId, decision, executionTarget: { ...replayRoute, machineId },
          ...(signal === undefined ? {} : { signal }),
        }));
        return replay.success ? replay.data
          : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
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
      return updateProjectOrganizationV1({
        accountScope: () => {
          try { accountContext.assertCurrent(); return { serverId: accountContext.serverId, accountId: accountContext.accountId }; }
          catch { return null; }
        }, mutateOrganization: createUiProjectAccountRowsClient(accountContext).mutateOrganization,
      }, input, context);
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
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response);
        if (approval.success && approval.data.actionId === 'projects.open') return approval.data;
        return OpenProjectResultV1Schema.parse(response);
      } catch (error) {
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
    ...createMachineConnectionActionDeps({ ...(accountContext ? { account: accountContext } : {}), runner: opts?.homeRuntimeRunner }),
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
    ...(opts?.machineProcessesAction ?? capturedFamilyPorts?.machineProcessesAction
      ? { machineProcessesAction: opts?.machineProcessesAction ?? capturedFamilyPorts!.machineProcessesAction }
      : {}),
    ...(opts?.machineResourcesPolicyAction ?? capturedFamilyPorts?.machineResourcesPolicyAction
      ? { machineResourcesPolicyAction: opts?.machineResourcesPolicyAction ?? capturedFamilyPorts!.machineResourcesPolicyAction }
      : {}),
    ...(capturedFamilyPorts ? { skillMachineActionExecute: capturedFamilyPorts.skillMachineActionExecute } : {}),
    ...(machineAccessAction
      ? { machineAccessAction }
      : {}),
    ...(opts?.discussionAction ?? capturedFamilyPorts?.discussionAction
      ? { discussionAction: opts?.discussionAction ?? capturedFamilyPorts!.discussionAction }
      : {}),
    ...(opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction
      ? { homeDomainAction: (args: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0]) => {
        // Section intents need the opened Account organization owner even when a mounted
        // surface supplies the ordinary Home HTTP transport for the other families.
        const owner = isSessionOrganizationResourceAction(args.actionId)
          ? capturedFamilyPorts?.homeDomainAction : undefined;
        return (owner ?? opts?.homeDomainAction ?? capturedFamilyPorts!.homeDomainAction)(args);
      } }
      : {}),
    ...(accountContext && (opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction)
      ? { personalSavedSecretActionExecute: createUiPersonalSavedSecretActionExecute(accountContext,
        (opts?.homeDomainAction ?? capturedFamilyPorts?.homeDomainAction)!) } : {}),
    ...(opts?.teamMembershipHistoryAction ?? capturedFamilyPorts?.teamMembershipHistoryAction
      ? { teamMembershipHistoryAction: opts?.teamMembershipHistoryAction ?? capturedFamilyPorts!.teamMembershipHistoryAction } : {}),
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
    ...(accountContext ? { accountLifecycleAction: createUiAccountLifecycleAction(accountContext,
      async path => {
        if (opts?.openRoute) await opts.openRoute(path);
        else { const { router } = await import('expo-router'); router.replace(path as never); }
      }) } : {}),
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
        serverId: args.serverId, signal: context.signal, accountLifetime: accountContext?.accountLifetime, reuseFreshReady: false,
        sections: ['automationEligibleEvents'],
      });
      if (catalog?.kind !== 'ready' || catalog.inputs.automationEligibleEvents === undefined) {
        return { ok: false, errorCode: 'workflow_event_catalog_unavailable', error: 'workflow_event_catalog_unavailable' };
      }
      return { machineId: args.machineId, events: projectAutomationEligibleEventsCatalogV1(catalog.inputs.automationEligibleEvents) };
    },
    machinesAgentsList: async (args, context) => {
      const catalog = args.draftDefinitions ? { definitions: args.draftDefinitions }
        : projectAcpCatalogForMachineInventory(await readAccountAcpCatalog({ signal: context.signal }));
      const definitions = catalog.definitions?.filter(definition => (!args.agentId || args.agentId === 'custom-acp')
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
        .filter(({ agentId, definitionId }) => (!args.agentId || args.agentId === agentId)
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
    machineAgentInstallStart: async ({ machineId, signal, ...request }) => {
      if (!accountContext) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      accountContext.assertCurrent();
      throwIfAborted(signal);
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
    machineAgentInstallRead: async ({ machineId, serverId, signal, ...request }) =>
      await readAgentInstallJobRpc({ machineId, serverId, signal }, request),
    machineAgentInstallCancel: async ({ machineId, signal, jobId }) => {
      if (!accountContext) throw new Error('not_authenticated');
      accountContext.assertCurrent();
      throwIfAborted(signal);
      return await cancelMachineAgentInstallJob({ ...accountContext.accountLifetime.scope, machineId }, jobId);
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

    sessionContinuationInspect: async ({ input, serverId }) => {
      const machineId = resolveSessionMachineId(input.sessionId, serverId);
      if (!machineId) return { status: 'indeterminate' };
      return await inspectSessionContinuationOnMachine({ ...input, machineId, serverId: serverId ?? null });
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
    sessionSendMessage: opts?.sessionSendMessage ?? (async (args) => {
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
        const account = accountContext;
        if (!account) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
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
          const machines = await withActionAccountRequestSignal(account, signal, ownedSignal => fetchMachineRows({ credentials: account.credentials,
            readTransport: account.readTransport, signal: ownedSignal,
            request: (path, init) => account.request(path, { ...init, signal: ownedSignal }) }));
          account.assertCurrent();
          throwIfAborted(signal);
          const machine = machines.find(row => row.id === target.machineId && row.revokedAt === null && row.replacedByMachineId === null);
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
          const advertised = await readCompleteActionSpecV1({ actionId: 'session.message.send', signal,
            read: async schemaInput => execute({ actionId: 'action.spec.get', input: schemaInput, context,
              ...(signal ? { signal } : {}) }) });
          account.assertCurrent();
          throwIfAborted(signal);
          advertisedInputSchema = advertised.inputSchema;
          if (!supportsSessionMessageInputJsonSchema(advertised.inputSchema, input)) {
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
          const handles = await uploadSessionMessageAttachmentDrafts({
            target: { serverId: account.serverId, accountId: account.accountId, sessionId },
            executionTarget: { serverId: account.serverId, machineId: target.machineId },
            drafts: composerSubmission.legacyAttachments.drafts, config: composerSubmission.legacyAttachments.config,
            onUploadedDraftCheckpoint: composerSubmission.legacyAttachments.onUploadedDraftCheckpoint,
            messageLocalId: localId, ...(signal ? { signal } : {}),
            isCurrent: () => account.accountLifetime.isCurrent() && composerSubmission.isCurrent(),
          });
          if (!handles) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
          input = { ...input, message: composerSubmission.legacyAttachments.originalMessage,
            structuredInput: { v: 1, ...input.structuredInput, sessionAttachments: [...handles] } };
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
    }),

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
          serverId, signal: context.signal,
        });
        throwIfAborted(context.signal);
      }
      const result = await writeUiSessionStateField({
        sessionId: sid, fieldId,
        value: fieldId === 'display.title' ? { title: String(value), updatedAt } : value,
        metadataReason: `ui-${actionId}`,
        ...(opts?.sessionStateMetadataPreprocess ? { metadataPreprocess: opts.sessionStateMetadataPreprocess } : {}),
        updateSessionMetadataWithRetry: async (targetSessionId, updater) => {
          throwIfAborted(context.signal);
          let committedRevision: number | undefined;
          await sync.patchSessionMetadataWithRetry(targetSessionId, (metadata) => {
            throwIfAborted(context.signal);
            return updater(metadata);
          }, { serverId: serverId ?? null,
            ...(fieldId === 'display.title' ? { mutationIntent: 'rename_session' as const } : {}),
            ...(accountContext ? { accountLifetime: accountContext.accountLifetime } : {}),
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
        : fieldId === 'display.bot' ? { bot: value } : fieldId === 'intent.memoryEnabled' ? { enabled: value }
        : fieldId === 'intent.voicePreference' ? { preference: value }
        : fieldId === 'intent.context' ? { updated: true } : { showToolCalls: value }), version: result.version };
    },

    sessionPermissionRespond: async ({ sessionId, requestId, turnId, decision, serverId, mode, reason, answers, allowedTools, updatedPermissions, execPolicyAmendment, signal, context }) => {
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
      try {
        await withAccountLifetime(signal, ownedSignal => sessionRespondToPermission(sessionId, request, {
          serverId: serverId ?? undefined, signal: ownedSignal,
          ...(context?.assertDecisionAuthorityCurrent ? { onIssued: context.assertDecisionAuthorityCurrent } : {}),
        }));
      } catch (error) {
        return projectSessionInteractionRpcFailure(error);
      }
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
          ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
        }, { serverId: serverId ?? undefined, signal: ownedSignal,
          ...(context?.assertDecisionAuthorityCurrent ? { onIssued: context.assertDecisionAuthorityCurrent } : {}),
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
    sessionConfigOptionSet: async ({ sessionId, configId, valueId }) => {
      const session = storage.getState().sessions[sessionId] ?? null;
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      const agentId = resolveAgentIdForPermissionUi({
        metadata,
        flavor: metadata?.flavor ?? undefined,
        toolName: '',
      });
      const target = session ? resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session })) : null;
      const selection = session && target ? getModelOverrideForSpawn(session, buildBackendTargetKeyV2(target))?.modelSelection.ref : null;
      const modelControls = agentId === null || selection?.providerConnectionId ? null : computeSessionModelConfigOptionControls({
        agentId,
        metadata: session?.composerOptionsInput === undefined ? metadata : session.composerOptionsInput,
        modelId: selection?.modelId ?? 'default',
      });
      const sessionControl = agentId === null ? undefined : computeSessionConfigOptionControls({ agentId, metadata })
        ?.find((candidate) => candidate.option.id === configId);
      const control = modelControls?.find((candidate) => candidate.option.id === configId) ?? sessionControl;
      const choiceIds = control?.option.options?.map((choice) => choice.value)
        ?? control?.option.groups?.flatMap((group) => group.options.map((choice) => choice.value))
        ?? [];
      if (!control || control.disabled || sessionControl?.disabled || !choiceIds.includes(valueId)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      await sync.publishSessionAcpConfigOptionOverrideToMetadata({
        sessionId,
        configId,
        value: valueId,
        updatedAt: Date.now(),
        ...(accountContext ? { serverId: accountContext.serverId, accountLifetime: accountContext.accountLifetime } : {}),
      });
      return { ok: true, sessionId, configId, valueId };
    },
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
      const normalizedModelId = String(modelId ?? '').trim();
      if (!normalizedSessionId || (!normalizedModelId && args.teamCredentialModel === undefined)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }

      const session = storage.getState().sessions[normalizedSessionId] ?? null;
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      if (args.teamCredentialModel !== undefined) {
        accountContext?.assertCurrent();
        if (args.callerInputConstraints && !isModelRefGrantedV1(args.callerInputConstraints, 'automatic')) {
          return { ok: false, errorCode: 'model_not_granted', error: 'model_not_granted' };
        }
        const requested = args.teamCredentialModel;
        const target = resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session }));
        if (!target || buildBackendTargetKeyV2(target) !== requested.agentTargetKey) {
          return { ok: false, errorCode: 'model_selection_agent_target_unknown', error: 'model_selection_agent_target_unknown' };
        }
        const observedActive = session.active === true;
        const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 0, ref: {
          source: 'team_resource', resourceId: requested.resourceId, teamId: requested.teamId,
          expectedResourceRevision: requested.expectedResourceRevision, deliveryMode: requested.deliveryMode,
          agentTargetKey: requested.agentTargetKey, modelId: requested.modelId,
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
                expectedResourceRevision: requested.expectedResourceRevision, deliveryMode: requested.deliveryMode, teamId: requested.teamId }],
              ...(args.teamVisibilityGrantConsent ? { teamVisibilityGrantConsent: args.teamVisibilityGrantConsent } : {}),
            },
          });
          const state = candidate.readState();
          if (!state.accepted || state.updatedAt === null) return uncommitted();
          if (observedActive) {
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
      const response = await accountContext.request(`/v2/sessions/${encodeURIComponent(sessionId)}/messages/by-local-id/${encodeURIComponent(requestLocalId)}/reply`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewDecision), ...(signal ? { signal } : {}) });
      accountContext.assertCurrent();
      const parsed = SessionMessageReplyMutationResultV1Schema.safeParse(await response.json());
      accountContext.assertCurrent();
      if (!response.ok) {
        const error = parsed.success && !parsed.data.ok ? parsed.data.error : 'unavailable';
        return { ok: false, errorCode: error, error };
      }
      return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
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
        if (parsed && parsed.family !== 'execution_run_host_action') return parsed.request;
      }

      // Consent must acquire its own current body, rather than wait on or
      // borrow an ordinary read acquired before this decision was made.
      const full = await (accountContext ? accountContext.fetchArtifact(artifactId, { fresh: true }) : sync.fetchArtifactWithBody(artifactId, { fresh: true }));
      if (full) {
        if (!accountContext) storage.getState().updateArtifact(full);
        const body = full.body;
        if (typeof body !== 'string' || !full.header) return null;
        const parsed = approvalArtifactBodyMatchesHeaderV1(full.header, body);
        return parsed && parsed.family !== 'execution_run_host_action' ? parsed.request : null;
      }

      return null;
    },

    approvalsUpdate: updateApprovalArtifact,

    targetActionApprovalReplay: createTargetActionApprovalDecision({
      read: async (artifactId, initialRead) => {
        const parsed = TargetActionApprovalRequestV1Schema.safeParse(initialRead
          ? initialRead.request : await deps.approvalsGet?.({ artifactId, serverId: null }));
        // This client records consent for an Account invocation, never replays
        // Machine-bound effects or asserts another process's waiter is stale.
        return parsed.success && parsed.data.approvalInputCustody === 'live_only'
          && !parsed.data.executionOriginV1 && !parsed.data.replayPlacement ? parsed.data : null;
      },
      update: updateApprovalArtifact,
    }),

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
      if (!signal?.aborted) opts?.onBlockingApprovalPending?.({ artifactId, ...(signal ? { signal } : {}) });
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
        if ((await registry.readRegistrySource(sourceId)).token) {
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
        return { ok: result.ok };
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
    const surface = context?.surface ?? 'ui';
    const installedAuth = getCurrentAuth();
    const credential = accountContext?.credentialAuthorityKind ?? installedAuth?.credentialAuthorityKind ?? 'none';
    const localUiInteraction = !accountContext && credential === 'none'
      && installedAuth?.credentialAuthorityKind === 'none' && installedAuth.isAuthenticated === false
      && surface === 'ui' && context?.actionCaller?.kind === 'host'
      && !context.externalActionCredential && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization
      && !context.signal?.aborted && storage.getState().settingsScope === null && isSettingsOwnerCurrent()
      && isBuiltInLocalSettingMutation(actionId, input);
    const voiceCanApproveRequests = surface === 'voice' && credential === 'account'
      && (!context?.actionCaller || context.actionCaller.kind === 'host')
      && !context?.externalActionCredential && !context?.externalActionExecutionAuthorization
      && !context?.rpcSessionAuthorization
      && readAccountSettingsSnapshot().voice.canApproveRequests === true;
    const credentialAuthority = resolveInvocationAuthority({ credential, surface, localUiInteraction,
      actionId, voiceCanApproveRequests });
    // Ordinary callers can narrow the installed credential's authority, never
    // promote it. Authenticated daemon continuations retain their admitted stamp.
    const authority = opts?.admittedClientActionId
      ? context?.authority ?? 'account_automation'
      : credentialAuthority === 'present_user' ? context?.authority ?? credentialAuthority : credentialAuthority;
    const actionCaller = context?.actionCaller ?? (credential === 'account' && (surface === 'ui' || surface === 'voice' || surface === 'rpc') && !context?.externalActionCredential
      && !context?.rpcSessionAuthorization ? { kind: 'host' as const } : undefined);
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
      // This closure belongs to the captured Account, not the invoking model.
      // Re-read after suspension; never retract an already-issued effect receipt.
      assertDecisionAuthorityCurrent: voiceCanApproveRequests && authority === 'present_user'
        ? () => {
          if (readAccountSettingsSnapshot().voice.canApproveRequests !== true) {
            throw new HappyError('present_user_required', false, { code: 'present_user_required' });
          }
        } : undefined,
      ...(actionCaller ? { actionCaller } : {}),
      ...(accountContext ? { managedMachineCreationEnabled: accountContext.settings.managedMachineCreationEnabled } : {}),
      ...(opts?.admittedClientActionId ? { bypassApprovals: actionId === opts.admittedClientActionId } : {}),
      ...((surface === 'ui' || surface === 'voice' || surface === 'plugin') && (credential === 'account' || credential === 'terminal')
        ? { actionRequestId: context?.actionRequestId ?? (creationKey || randomUUID()) }
        : {}),
    };
  };

  const executeMachinePluginAtDaemon = async (actionId: ActionId, input: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult> => {
    if (context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) {
      return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    const spec = getActionSpec(actionId);
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await executeMachineOwnedPluginAction({ actionId, input: parsed.data, context });
    const failure = ActionExecuteFailureSchema.safeParse(result);
    if (failure.success) return failure.data;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
    if (approval.success && approval.data.actionId === actionId) return { ok: true, result: approval.data };
    const output = spec.outputSchema?.safeParse(result);
    return output?.success ? { ok: true, result: output.data }
      : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  };

  return {
    previewSessionTargets: async (target, context) => {
      const input = { target, actionId: 'session.message.send' };
      const result = await executor.execute('session.targets.resolve', input, resolveContext(context, input, 'session.targets.resolve'));
      return result.ok ? SessionTargetPreviewV1Schema.parse(result.result)
        : { coverage: 'unavailable', addresses: [], error: result.errorCode };
    },
    // A genuine present-user native invocation has one installed Action policy
    // and approval owner. Do not create a second local Ask before its relay.
    executeNativeManagedAction: async (actionId: ManagedMachineActionIdV1, input: unknown, context?: ActionExecutorContext) => {
      if (!accountContext) return { ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const resolvedContext = resolveContext(context, input, actionId);
      const preferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, resolvedContext);
      if (preferenceFailure) return preferenceFailure;
      if (deps.isActionEnabled && !deps.isActionEnabled(actionId, resolvedContext)) {
        return { ok: false as const, errorCode: 'action_disabled', error: 'action_disabled' };
      }
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
    prepare: async (actionId, input, context) => {
      const resolved = resolveContext(context, input, actionId);
      // The daemon owns both implicit and explicitly requested plugin review.
      // Preparation must not create an app-local approval before that owner runs.
      return resolved.surface !== 'plugin' && isMachineOwnedPluginAction(actionId, input)
        ? { kind: 'ready', invocation: { run: () => executeMachinePluginAtDaemon(actionId, input, resolved) } }
        : await executor.prepare(actionId, input, resolved);
    },
    execute: async (actionId, input, context) => {
      const resolved = resolveContext(context, input, actionId);
      return resolved.surface !== 'plugin' && isMachineOwnedPluginAction(actionId, input)
        ? await executeMachinePluginAtDaemon(actionId, input, resolved)
        : await executor.execute(actionId, input, resolved);
    },
    replayApprovedApprovalRequest: async (args) => await executor.replayApprovedApprovalRequest(args),
  };
}


type DefaultActionExecutorOptions = Parameters<typeof buildDefaultActionExecutor>[0];
/** UI-only projection qualifier; the captured Account owner enforces it before admission. */
export type UiActionExecutorContext = ActionExecutorContext & Readonly<{
  expectedAccountId?: string;
  /** Exact object admitted by the enclosing UI stop/archive lifecycle. */
  archiveOperation?: SessionArchiveOperation;
  /** Destination-owner navigation leaf, consumed only in this invocation. */
  openRoute?: (route: string) => void | Promise<void>;
}>;
type DefaultActionExecutor = Omit<UiProtocolActionExecutor, 'execute' | 'prepare' | 'previewSessionTargets'> & Readonly<{
  previewSessionTargets: (target: SessionTargetSelectorV1, context?: UiActionExecutorContext, readInputs?: SessionFollowReadInputs) => Promise<UiSessionTargetPreview>;
  execute: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['execute']>;
  prepare: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => ReturnType<ReturnType<typeof createActionExecutor>['prepare']>;
}>;
type DefaultActionExecuteContext = Pick<UiActionExecutorContext, 'expectedAccountId' | 'externalActionCredential' | 'openRoute' | 'archiveOperation' | 'defaultSessionId'> & Readonly<{
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
  discussionAttachmentSources?: readonly import('@/sync/domains/attachments/prepareAttachmentPayloads').PreparedAttachmentSource[]): Readonly<{
  sessionAccessAction: NonNullable<ActionExecutorDeps['sessionAccessAction']>;
  machineAccessAction: NonNullable<ActionExecutorDeps['machineAccessAction']>;
  machineWorkSummaryGet: NonNullable<ActionExecutorDeps['machineWorkSummaryGet']>;
  machineVitalsAction: NonNullable<ActionExecutorDeps['machineVitalsAction']>;
  machineStorageAction: NonNullable<ActionExecutorDeps['machineStorageAction']>;
  machineGuardAction: NonNullable<ActionExecutorDeps['machineGuardAction']>;
  machineProcessesAction: NonNullable<ActionExecutorDeps['machineProcessesAction']>;
  machineResourcesPolicyAction: NonNullable<ActionExecutorDeps['machineResourcesPolicyAction']>;
  skillMachineActionExecute: NonNullable<ActionExecutorDeps['skillMachineActionExecute']>;
  discussionAction: NonNullable<ActionExecutorDeps['discussionAction']>;
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  teamMembershipHistoryAction: NonNullable<ActionExecutorDeps['teamMembershipHistoryAction']>;
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
    teamMembershipHistoryAction: async (args) => {
      account.assertCurrent();
      const { executeMembershipHistoryActionForScope } = await import('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi');
      return await executeMembershipHistoryActionForScope({ scope, isCurrent, actionId: args.actionId, input: args.input,
        availability: await readCollaborationAvailability(), ...(args.signal ? { signal: args.signal } : {}) });
    },
    machineProcessesAction: ({ actionId, input, context, signal }) => machineActionRpc(actionId, input, signal, context.actionRequestId ?? undefined),
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
      const result = await work(buildDefaultActionExecutor({ ...opts, archiveInvocation, ...(context.openRoute ? { openRoute: context.openRoute } : {}) }, { ...account, settings }, followReadInputs), account, settings);
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
    if (isProjectActionIdV1(actionId) && actionId !== 'projects.trust.list' && actionId !== 'projects.trust.revoke') {
      const qualified = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (qualified.success) return 'workspace' in qualified.data ? qualified.data.workspace.serverId : qualified.data.serverId;
    }
    if (isSessionStateFieldActionId(actionId)) {
      const qualified = getActionSpec(actionId).inputSchema.safeParse(input);
      const target = qualified.success ? qualified.data : null;
      if (target && typeof target === 'object' && 'serverId' in target && typeof target.serverId === 'string') return target.serverId;
    }
    if (actionId === 'session.spawn_new') {
      const qualified = SessionSpawnNewActionInputV2Schema.safeParse(input);
      if (qualified.success) return qualified.data.executionTarget.serverId;
    }
    if (actionId === 'machines.work.summary.get') {
      const qualified = MachineWorkSummaryGetInputV1Schema.safeParse(input);
      if (qualified.success) return qualified.data.serverId;
    }
    const vitalsAction = MachineVitalsActionIdSchema.safeParse(actionId);
    if (vitalsAction.success) {
      const qualified = MACHINE_VITALS_ACTION_INPUT_SCHEMAS[vitalsAction.data].safeParse(input);
      if (qualified.success && qualified.data.serverId) return qualified.data.serverId;
    }
    const resourcesAction = MachineResourcesActionIdSchema.safeParse(actionId);
    if (resourcesAction.success) {
      const qualified = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS[resourcesAction.data].safeParse(input);
      if (qualified.success && qualified.data.serverId) return qualified.data.serverId;
    }
    const storageAction = MachineStorageActionIdSchema.safeParse(actionId);
    if (storageAction.success) {
      const qualified = MACHINE_STORAGE_ACTION_INPUT_SCHEMAS[storageAction.data].safeParse(input);
      if (qualified.success && qualified.data.serverId) return qualified.data.serverId;
    }
    const guardAction = MachineGuardActionIdSchema.safeParse(actionId);
    if (guardAction.success) {
      const qualified = MACHINE_GUARD_ACTION_INPUT_SCHEMAS[guardAction.data].safeParse(input);
      if (qualified.success && qualified.data.serverId) return qualified.data.serverId;
    }
    const processesAction = MachineProcessesActionIdSchema.safeParse(actionId);
    if (processesAction.success) {
      const qualified = MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[processesAction.data].safeParse(input);
      if (qualified.success && qualified.data.serverId) return qualified.data.serverId;
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

function resolveNativeManagedAction(actionId: ActionId, opts?: DefaultActionExecutorOptions): ManagedMachineActionIdV1 | null {
  // An admitted replay retains its existing strict approval custody. Ordinary
  // relay ingress cannot consume a local Artifact's bypass proof.
  if (opts?.admittedClientActionId) return null;
  const parsed = ManagedMachineActionIdV1Schema.safeParse(actionId);
  return parsed.success && parsed.data !== 'machines.managed.list'
    && parsed.data !== 'machines.managed.get' && parsed.data !== 'machines.managed.cancel'
    && parsed.data !== 'machines.managed.setup.skip'
    && parsed.data !== 'machines.managed.references.get' ? parsed.data : null;
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
    : error instanceof ActionAdmissionHomeUnreachableError
      ? { ok: false as const, errorCode: 'server_unreachable', error: 'server_unreachable' }
      : null;
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
    execute: async (actionId, input, context) => {
      const { openRoute, archiveOperation, ...actionContext } = context ?? {};
      const custodyFailure = opts?.filesystemActionDelivery?.actionId === actionId ? null : resolveUiFilesystemTransferCustodyFailure(actionId, input);
      if (custodyFailure) return custodyFailure;
      const api = await apiTokenTransport();
      if (api) {
        const failure = apiTokenComposerSubmissionFailure(actionId);
        return failure ?? await executeApiTokenAction(api, actionId, input, actionContext);
      }
      const serverId = resolveDefaultActionInvocationServerId(actionId, input, context);
      if (!serverId) return await ordinary().execute(actionId, input, actionContext);
      try {
        const native = resolveNativeManagedAction(actionId, opts);
        const execute = (signal?: AbortSignal) => withDefaultActionExecuteContext(opts, { ...actionContext, signal, openRoute, archiveOperation, archiveInput: input, serverId }, async (executor, account) => {
          const actionRequestId = native ? actionContext.actionRequestId ?? randomUUID() : actionContext.actionRequestId;
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
          if (!native) return await executor.execute(actionId, input, capturedContext);
          return await executeManagedNativeActionWithApprovalObservation({ actionId: native,
            requestId: actionRequestId!, serverId, accountId: account.accountId,
            execute: () => executor.executeNativeManagedAction(native, input, capturedContext) });
        }, actionId);
        return await execute(actionContext.signal);
      } catch (error) {
        const failure = accountScopeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    prepare: async (actionId, input, context) => {
      const { openRoute, archiveOperation, ...actionContext } = context ?? {};
      const custodyFailure = opts?.filesystemActionDelivery?.actionId === actionId ? null : resolveUiFilesystemTransferCustodyFailure(actionId, input);
      if (custodyFailure) return { kind: 'settled', result: custodyFailure };
      const api = await apiTokenTransport();
      if (api) {
        const failure = apiTokenComposerSubmissionFailure(actionId);
        return failure ? { kind: 'settled', result: failure }
          : { kind: 'ready', invocation: { run: async () => await executeApiTokenAction(api, actionId, input, actionContext) } };
      }
      const serverId = resolveDefaultActionInvocationServerId(actionId, input, context);
      if (!serverId) return await ordinary().prepare(actionId, input, actionContext);
      const account = await captureLazyActionAccountContext(serverId, context?.signal);
      const archiveInvocation = createSessionArchiveInvocation(actionId, input, archiveOperation, account.serverId, context?.defaultSessionId);
      try {
        assertExpectedActionAccount(account, context);
        const settings = await readActionAdmissionSettings(account);
        account.assertCurrent();
        throwIfAborted(context?.signal);
        const executor = buildDefaultActionExecutor({ ...opts, archiveInvocation, ...(openRoute ? { openRoute } : {}) }, { ...account, settings });
        const capturedContext = {
          ...actionContext,
          serverId,
          ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
          runtimeAccountId: account.accountId,
        };
        const native = resolveNativeManagedAction(actionId, opts);
        const preferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, {
          managedMachineCreationEnabled: settings.managedMachineCreationEnabled,
        });
        const prepared = native
          ? preferenceFailure ? { kind: 'settled' as const, result: preferenceFailure }
            : { kind: 'ready' as const, invocation: { run: async () => await executor.executeNativeManagedAction(native, input, capturedContext) } }
          : await executor.prepare(actionId, input, capturedContext);
        account.assertCurrent();
        account.dispose();
        if (prepared.kind === 'settled') {
          finishSessionArchiveInvocation(archiveInvocation);
          return prepared;
        }
        let result: ReturnType<typeof prepared.invocation.run> | undefined;
        return {
          kind: 'ready',
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
