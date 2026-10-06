import { lazyZodSchema } from '../lazyZodSchema.js';
import { PassthroughEmptyObjectSchema } from './specs/common.js';
import { InputOptionsConsumerV1Schema } from '../inputs/inputOptionsConsumer.js';
import { VOICE_CONVERSATION_ACTION_IDS, VOICE_CONVERSATION_ACTION_SPECS, VoiceConversationActionInputSchemas, VoiceConversationActionOutputSchemas, type VoiceConversationActionId } from './voiceConversationActionFamily.js';
import {
  SessionAccessGrantsListRequestV1Schema, SessionAccessGrantsListResponseV1Schema,
  SetSessionAccessGrantResponseV1Schema,
  RemoveSessionAccessGrantRequestV1Schema, RemoveSessionAccessGrantResponseV1Schema,
  SetSessionAccessContextRequestV1Schema, SetSessionAccessContextResponseV1Schema,
} from '../sessions/access/sessionAccessOperationsV1.js';
import {
  AgentsAcpBackendsDeleteInputV1Schema,
  AgentsAcpBackendsDeleteOutputV1Schema,
  AgentsAcpBackendsUpsertInputV1Schema,
  AgentsAcpBackendsUpsertOutputV1Schema,
} from '../acp/catalog/catalogMutationsV1.js';
import {
  SessionAccessGrantSetActionInputV1Schema,
  SessionPublicLinkCreateActionInputV1Schema, SessionPublicLinkCreateActionResultV1Schema,
  SessionPublicLinkGetActionResultV1Schema, SessionPublicLinkRemoveActionResultV1Schema,
} from '../sessions/access/sessionAccessActionsV1.js';
import {
  SetSessionResponsibilityRequestSchema, SetSessionResponsibilityResponseSchema,
  SessionResponsibilityCandidatesRequestSchema, SessionResponsibilityCandidatesResponseSchema,
} from '../sessions/access/sessionResponsibilityV1.js';
import { z } from 'zod';
import { AccountHistoricalEncryptionKeyForgetInputV1Schema, AccountHistoricalEncryptionKeyForgetResultV1Schema,
  AccountEncryptionAutomationTemplatesRecoverInputV1Schema, AccountEncryptionAutomationTemplatesRecoverResultV1Schema } from '../auth/accountSecurity.js';
import { ScmComparisonSourceSchema } from '../scm/comparison.js';
import { redactPublicShareCapabilityUrl } from '../crypto/publicShareCapabilityUrl.js';
import { ExecutionRunWaitConditionSchema } from '../execution/runs/waitForTerminal.js';
import { WaitActionInputV1Schema, WaitActionResultV1Schema, WAIT_CLI_PROJECTION } from './specs/wait.js';
import { ComputerAccessV1Schema, ComputerTargetV1Schema } from '../computer/v1.js';
import { WORK_BOARD_ACTION_IDS_V1, type WorkBoardActionIdV1 } from '../boards/actionIdsV1.js';
import { WorkBoardActionInputSchemasV1, WorkBoardActionOutputSchemasV1 } from '../boards/actionsV1.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';
import { DECISION_ACTION_IDS, TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS, isAgentRequestablePresentUserActionId } from './decisionAuthority.js';
import { SessionPermissionRespondActionDecisionV1Schema, SessionPermissionRespondRpcParamsV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { SessionMessageV1Schema } from '../sessions/messages/sessionMessagesPageV1.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { SessionSharedMetadataV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import {
  NotificationsNotifyMeInputV1Schema,
  NotificationsNotifyMeResultV1Schema,
} from '../account/notifications/notifyMeV1.js';
import {
  MachinesAgentsSignInStartInputSchema, MachinesAgentsSignInStartOutputSchema,
  MachinesAgentsSignInStatusInputSchema, AgentSignInStatusResponseSchema,
  MachinesAgentsSignInCancelInputSchema, MachinesAgentsSignInCancelOutputSchema,
} from '../daemon/agentSignIn.js';
import { MachinesAgentsListInputSchema, MachinesAgentsListOutputSchema } from '../capabilities/machineAgentInventory.js';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '../machines/workspaceFiles.js';

export const WorkspaceFilesSearchActionInputSchema = lazyZodSchema(() => DaemonWorkspaceFileSearchRequestSchema.extend({
  machineId: z.string().trim().min(1),
}).strict());
import {
  DaemonAgentInstallStartRequestSchema,
  DaemonAgentInstallStartResponseSchema,
  DaemonAgentInstallReadRequestSchema,
  DaemonAgentInstallReadResponseSchema,
  DaemonAgentInstallCancelRequestSchema,
  DaemonAgentInstallCancelResponseSchema,
} from '../daemon/agentInstallJobs.js';
import type { ActionCompletionDeclaration } from './actionCompletion.js';
import { planStartCompletion, reviewStartCompletion, reviewWalkthroughCompletion } from './specs/executionRunCompletion.js';
import { SCM_GIT_ACTION_SPECS } from './scmGitActionSpecs.js';
import { WORKSPACE_ACTION_SPECS, WORKSPACE_ACTION_INPUT_SCHEMAS, WORKSPACE_ACTION_OUTPUT_SCHEMAS, type WorkspaceActionId } from './workspaceActionFamily.js';
import { SESSION_CANVAS_ACTION_SPECS, SESSION_CANVAS_ACTION_INPUT_SCHEMAS, SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS, type SessionCanvasActionId } from './sessionCanvasActionFamily.js';
import { SESSION_TERMINAL_ACTION_SPECS, SESSION_TERMINAL_ACTION_INPUT_SCHEMAS, SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS, type SessionTerminalActionId } from './sessionTerminalActionFamily.js';
import { COMMAND_PALETTE_ACTION_SPECS } from './commandPaletteActionSpecs.js';
import { FIND_ACTION_SPECS } from './findActionSpecs.js';
import { PROMPT_PICKER_ACTION_SPECS } from './promptPickerActionSpecs.js';
import { SESSION_PENDING_NEXT_ACTION_SPECS } from './specs/sessionPendingNext.js';
import { SESSION_ORGANIZATION_MOVE_ACTION_SPECS } from './sessionOrganizationMoveAction.js';
import { LIST_REORDER_ACTION_SPECS } from './listReorderAction.js';
import { TODO_SESSION_LINK_ACTION_SPECS } from './todoSessionLinkAction.js';
import { WORKFLOW_AUTHORING_ACTION_SPECS } from './workflowAuthoringAction.js';
import { COMPOSER_INGRESS_ACTION_SPECS } from './composerIngressAction.js';
import { SETTINGS_DECLARATION_ACTION_IDS_V1, SettingsDeclarationActionInputSchemasV1, SettingsDeclarationActionOutputSchemasV1, type SettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { readAccountSettingDeclarationV1 } from './accountSettingDeclarations.js';
import { APP_SHELL_ACTION_IDS, APP_SHELL_ACTION_SPECS } from './appShellActionFamily.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS, NOTIFICATION_CONFIGURATION_ACTION_SPECS, NotificationConfigurationActionInputSchemas, NotificationConfigurationActionOutputSchemas, type NotificationConfigurationActionId } from './notificationConfigurationActionFamily.js';
import { APP_UPDATE_ACTION_IDS, APP_UPDATE_ACTION_SPECS, AppUpdateActionInputSchemas, AppUpdateActionOutputSchemas, type AppUpdateActionId } from './appUpdateActionFamily.js';
import { ROLE_ACTION_IDS_V1, type RoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { LaunchProfilePublishInputV1Schema, LaunchProfilePublishOutputV1Schema } from '../launchProfiles/publishLaunchProfile.js';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1, isAccountRoleMutationV1 } from '../prompts/roles/roleActionsV1.js';
import { ARTIFACT_ACCESS_ACTION_IDS_V1, ArtifactAccessActionInputSchemasV1, ArtifactAccessActionOutputSchemasV1, type ArtifactAccessActionIdV1 } from '../artifacts/artifactAccessV1.js';
import { ARTIFACT_ACTION_IDS_V1, ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1, type ArtifactActionIdV1 } from '../artifacts/artifactActionsV1.js';
import { SessionListQueryV1Schema } from '../sessions/listing/query.js';
import { SessionReportsToSetActionInputV1Schema, SessionReportsToSetResultV1Schema } from '../sessions/relations/sessionReportsToV1.js';
import {
  SetSessionFolderAssignmentRequestSchema, SetSessionFolderAssignmentResponseSchema,
  SetSessionTagAssignmentsRequestSchema, SetSessionTagAssignmentsResponseSchema,
} from '../sessions/organization/mutations.js';
import { SessionWorkerPublishInputV1Schema, SessionWorkerPublishOutputV1Schema } from '../sessions/relations/workerUpdateV1.js';
import {
  SESSION_LIST_AWARENESS_VIEW_V1,
  SESSION_LIST_SUMMARY_VIEW_V1,
  SessionActivityActionResultV1Schema,
  SessionListActionResultV1Schema,
  SessionListViewV1Schema,
  type SessionListViewV1,
} from '../sessions/awareness/action.js';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1,
  SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
} from '../sessions/board/actions.js';
import {
  SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1,
  SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1,
} from '../sessions/discussions/actions.js';
import {
  CurrentSessionPresentationActionInputV1Schema,
  CurrentSessionPresentationActionResultV1Schema,
} from '../sessions/presentation/currentSessionPresentationV1.js';
import {
  MACHINE_POOL_ACTION_IDS_V1,
  MachinePoolActionInputSchemasV1,
  MachinePoolActionOutputSchemasV1,
  machinePoolActionEndpointPathV1,
  type MachinePoolActionIdV1,
} from '../machines/pools/actionsV1.js';
import {
  EPHEMERAL_RUNNER_ACTION_IDS_V1,
  EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1,
  EphemeralRunnerActionInputSchemasV1,
  EphemeralRunnerActionOutputSchemasV1,
  type EphemeralRunnerActionIdV1,
} from '../ephemeralRunner/actionsV1.js';
import {
  WorkflowActionInputSchemasV1,
  WorkflowActionOutputSchemasV1,
  type WorkflowActionIdV1,
} from '../workflows/actionsV1.js';
import {
  ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1,
  ACCOUNT_PASSWORD_CHANGE_PATH_V1,
  ACCOUNT_PASSWORD_ENROLL_PATH_V1,
  ACCOUNT_PASSWORD_REMOVE_PATH_V1,
  ACCOUNT_SECURITY_PATH_V1,
} from '../auth/accountSecurity.js';

import {
  assertPublicActionSdkMethodNames,
  resolveActionSdkMethodName,
} from './actionSdkMethodNames.js';

export { resolveActionSdkMethodName } from './actionSdkMethodNames.js';

import { ActionOperationDeclarationV1Schema } from './operations/v1.js';
import {
  ActionCliProjectionSchema,
  readActionSchemaTopLevelFieldNames,
  type ActionCliCommandBinding,
} from './actionCliProjection.js';
import { AgentsBackendsListOutputSchema } from './agentBackendInventory.js';
import {
  ActionExecutionPlacementSchema,
  ActionInputHintsSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  type ActionExecutionPlacement,
  type ActionInputHints,
  type ActionRequiredAuthority,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';

import type { ActionCaller } from './executor/types.js';
import type { ExternalActionTargetV1 } from './externalActionApi.js';
import { ActionSafetySchema } from './safety.js';
import {
  ConversationTurnOriginV1Schema,
  type ConversationTurnOriginV1,
} from '../messages/structured/conversationTurnOriginV1.js';
import { SubagentLaunchV1Schema } from '../messages/structured/subagentLaunchV1.js';
import {
  ACTION_IDS,
  ACTION_ID_FAMILIES_V1,
  ActionIdSchema,
  PLUGIN_DEV_LOOP_ACTION_IDS_V1,
  RUNTIME_ACTION_IDS_V1,
  WORKFLOW_ACTION_IDS_V1,
  isRuntimeActionIdV1,
  type ActionId,
  type PluginDevLoopActionIdV1,
  type RuntimeActionIdV1,
} from './actionIds.js';
import {
  HUMAN_SECRET_API_EXCLUSION_ACTION_IDS,
  HUMAN_SECRET_API_EXCLUSION_REASONS,
  INTERNAL_ACTION_IDS,
  INTERNAL_ACTION_REASONS,
  PLUGIN_INVOCABLE_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_REASONS,
  PluginInvocableActionIdSchema,
  isHumanSecretApiExcludedActionId,
  isInternalActionId,
  isPluginSurfaceExcludedActionId,
  type HumanSecretApiExcludedActionId,
  type InternalActionId,
  type PluginInvocableActionId,
  type PluginSurfaceExcludedActionId,
} from './pluginActionSurface.js';

export {
  HUMAN_SECRET_API_EXCLUSION_ACTION_IDS,
  HUMAN_SECRET_API_EXCLUSION_REASONS,
  INTERNAL_ACTION_IDS,
  INTERNAL_ACTION_REASONS,
  PLUGIN_INVOCABLE_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_REASONS,
  PluginInvocableActionIdSchema,
  isHumanSecretApiExcludedActionId,
  isInternalActionId,
  isPluginSurfaceExcludedActionId,
  type HumanSecretApiExcludedActionId,
  type InternalActionId,
  type PluginInvocableActionId,
  type PluginSurfaceExcludedActionId,
};
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ReviewWalkthroughInputSchema, ReviewExplainFindingsInputSchema, ReviewWalkthroughObservationSchema } from '../reviews/reviewNarration.js';
import {
  REVIEW_COMMENT_ACTION_IDS_V1,
  ReviewCommentActionInputSchemasV1,
  ReviewCommentActionOutputSchemasV1,
  type ReviewCommentActionIdV1,
} from '../reviews/comments/actions.js';
import {
  PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1,
  PluginPermissionGrantActionInputSchemasV1,
  PluginPermissionGrantActionOutputSchemasV1,
  type PluginPermissionGrantActionIdV1,
} from '../plugins/permissions/actions.js';
import { PluginPermissionSubjectV1Schema } from '../plugins/permissions/grants.js';
import {
  PLUGIN_WEBHOOK_ACTION_IDS_V1,
  PluginWebhookActionHttpPathsV1,
  PluginWebhookPluginSurfaceActionHttpPathsV1,
  PluginWebhookActionInputSchemasV1,
  PluginWebhookActionOutputSchemasV1,
  isPluginWebhookPluginSurfaceActionIdV1,
  type PluginWebhookActionIdV1,
  type PluginWebhookPresentUserActionIdV1,
} from '../plugins/webhooks/endpointV1.js';
import {
  PluginAccountDataEraseActionInputV1Schema,
  PluginAccountDataEraseActionOutputV1Schema,
} from '../plugins/data/accountEraseV1.js';
import {
  AccountSessionsSignOutEverywhereActionInputV1Schema,
  AccountSessionsSignOutEverywhereActionOutputV1Schema,
} from '../auth/accountSessions.js';
import {
  AccountEmailChangeRequestResponseV1Schema,
  AccountEmailChangeRequestV1Schema,
  AccountPasswordChangeRequestV1Schema,
  AccountPasswordEnrollRequestV1Schema,
  AccountPasswordMutationResponseV1Schema,
  AccountPasswordRemoveRequestV1Schema,
  AccountSecurityGetRequestV1Schema,
  AccountSecurityGetResponseV1Schema,
  AccountTerminalPresentUserPolicySetRequestV1Schema,
  AccountTerminalPresentUserPolicySetResponseV1Schema,
  ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1,
} from '../auth/accountSecurity.js';
import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
  AccountApiTokensUpdateActionInputV1Schema,
  AccountApiTokensUpdateActionOutputV1Schema,
  AccountApiTokensCreateActionInputV1Schema,
  AccountApiTokensCreateActionOutputV1Schema,
  projectAccountApiTokenCreationObservation,
  AccountApiTokensListActionInputV1Schema,
  AccountApiTokensListActionOutputV1Schema,
  AccountApiTokensRevokeActionInputV1Schema,
  AccountApiTokensRevokeActionOutputV1Schema,
  AccountApiTokensRevokeAllActionInputV1Schema,
  AccountApiTokensRevokeAllActionOutputV1Schema,
} from '../auth/accountApiTokens.js';
import {
  PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
  PluginSettingsAdministrationActionInputSchemasV1,
  PluginSettingsAdministrationActionOutputV1Schema,
  type PluginSettingsAdministrationActionIdV1,
} from '../plugins/settingsAdministration.js';
import {
  AUTOMATION_CONVERSATION_ACTION_IDS_V1,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  type AutomationConversationActionIdV1,
  AUTOMATION_EVENT_ACTION_IDS_V1,
  AutomationEventActionInputSchemasV1,
  AutomationEventActionOutputSchemasV1,
  type AutomationEventActionIdV1,
} from '../automations/automationActionSpecsV1.js';
import {
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { CurrentUiContextSnapshotV1Schema } from '../plugins/ui/currentUiContext.js';
import {
  ActionInputFieldHintSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  ActionInputWidgetSchema,
  readActionInputOptionValue,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
} from './actionInputHints.js';
import {
  MemorySearchQueryV1Schema,
  MemorySearchResultV1Schema,
} from '../memory/memorySearch.js';
import { MemoryWindowV1Schema } from '../memory/memoryWindow.js';
import {
  ApprovalRequestCreatedBySchema,
  ApprovalRequestOriginV1Schema,
  ApprovalRequestStatusSchema,
  ApprovalRequestV2StatusSchema,
} from '../approvals/approvalRequestV1.js';
import {
  PromptRegistryConfiguredSourceV1Schema,
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryScanSourceRequestV1Schema,
} from '../prompts/library/promptRegistriesV1.js';
import {
  PromptAssetDeleteRequestSchema,
  PromptAssetDiscoverRequestSchema,
  PromptAssetInstallModeV1Schema,
  PromptAssetScopeV1Schema,
} from '../prompts/library/promptAssetsV1.js';
import {
  DaemonFilesystemListDirectoryRequestSchema,
} from '../machines/fileBrowser.js';
import { BackendTargetKeySchema } from '../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema, BackendTargetRefV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../connect/connectedServiceBindings.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import { ExecutionRunListRequestSchema } from '../execution/runs/listRequest.js';
import { ExecutionRunCancelTurnRequestSchema, ExecutionRunCancelTurnResponseSchema } from '../execution/runs/cancelTurn.js';
import {
  ExecutionRunGetResponseSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunWaitResultSchema,
} from '../execution/runs/responseSchemas.js';
import {
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../execution/runs/streaming.js';
import { ExecutionRunTurnStreamReadRequestSchema } from '../execution/runs/runPrimitives.js';
import {
  ActionDiscoveryDefinitionSummaryV1Schema,
  ActionDiscoveryDefinitionV1Schema,
} from './actionDefinitionV1.js';
import {
  ExecutionRunStartRequestBaseSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTeamCredentialSessionBindingConsentV1Schema,
  refineExecutionRunStartRequest,
} from '../execution/runs/startRequest.js';
import { ExecutionRunResultContractV1Schema } from '../execution/runs/resultContractV1.js';
import { SessionMcpSelectionV1Schema } from '../mcp/servers/sessionSelectionV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../sessions/metadata/metadataOverridesV1.js';
import { RuntimeDescriptorV1Schema } from '../sessions/metadata/runtimeDescriptorV1.js';
import { SecretReferenceOverlayV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import {
  SessionSpawnNewInputV2Schema,
  SessionSpawnNewInputV2BaseSchema,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import { refineSessionDirectoryIntentCheckoutV1 } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { SessionSpawnNewResultV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { SessionCreationKeyV1Schema } from '../sessions/creation/sessionCreationIdentityV1.js';
import {
  PluginSessionInputIdempotencyKeyV1Schema,
  PluginSessionUserTextAuthoredFieldSchemasV1,
  requireSessionInputContent,
  SessionMessageSendResultV1Schema,
} from '../sessions/messages/sessionInputAdmission.js';
import { ExternalShareableTranscriptPageV1Schema } from '../sessions/messages/sessionExternalShareableTranscriptV1.js';
import { PendingLocalIdSchema } from '../sessions/pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import {
  SessionPermissionRemoteGrantRevokeInputV1Schema,
  SessionPermissionRemoteGrantRevokeOutputV1Schema,
  SessionPermissionRemoteGrantsListInputV1Schema,
  SessionPermissionRemoteGrantsListOutputV1Schema,
  SessionPermissionRemotePendingListInputV1Schema,
  SessionPermissionRemotePendingListOutputV1Schema,
  SessionPermissionRemoteRespondInputV1Schema,
  SessionPermissionRemoteRespondOutputV1Schema,
  SessionUserActionRemoteAnswerInputV1Schema,
  SessionUserActionRemoteAnswerOutputV1Schema,
} from '../sessions/permissions/v1.js';
import { ProviderConnectionIdSchema } from '../providers/ids.js';
import {
  SpawnConfigOptionValueSchema,
  findSpawnConfigOptionAliasConflicts,
} from './sessionSpawnConfigOptions.js';
import {
  EXECUTION_RUN_ACTION_PERMISSION_INPUTS,
  EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
  ExecutionRunActionPermissionModeSchema,
} from './executionRunActionPermissionMode.js';
import {
  SESSION_PERMISSION_INTENT_INPUTS,
  SessionPermissionModeInputSchema,
} from '../sessions/metadata/sessionPermissionModes.js';
import { SessionFollowActionInputSchemasV1, SessionFollowActionOutputSchemasV1 } from '../sessions/follow/actions.js';
import {
  VoiceTrackedSessionAddressV1Schema,
  VoiceTrackedTargetsActionResultV1Schema,
} from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { SESSION_FOLLOW_HTTP_PATHS_V1 } from '../sessions/follow/api.js';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '../sessions/follow/sessionFollowSourcesApi.js';
import { SESSION_DISCUSSION_HTTP_PATHS_V1 } from '../sessions/discussions/api.js';
import { SessionWorkStateStatusV1Schema } from '../sessions/work/state/sessionWorkStateV1.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import {
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
} from '../sessions/work/state/sessionWorkStateRpc.js';
import {
  ExternalSessionAttachRequestSchema,
  ExternalSessionAttachResponseSchema,
  ExternalSessionBackgroundFollowActionInputV1Schema,
  ExternalSessionBackgroundFollowActionResultV1Schema,
  ExternalSessionDetachRequestSchema,
  ExternalSessionDetachResponseSchema,
  ExternalSessionFollowPolicySetRequestSchema,
  ExternalSessionFollowPolicySetResponseSchema,
  ExternalSessionLinkEnsureRequestSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionCandidateDeleteRequestSchema,
  ExternalSessionCandidateDeleteResponseSchema,
  ExternalSessionsCandidatesListRequestSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionStatusGetRequestSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionStatusActionInputV1Schema,
  ExternalSessionStatusActionResultV1Schema,
  ExternalSessionTranscriptPageRequestSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterRequestSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
  ExternalSessionViewerFollowActionInputV1Schema,
  ExternalSessionViewerFollowActionResultV1Schema,
  ExternalSessionViewerUnfollowActionInputV1Schema,
  ExternalSessionViewerUnfollowActionResultV1Schema,
} from '../sessions/external/daemonRpcV1.js';
import {
  ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
  ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
} from '../sessions/external/secureRefreshV1.js';
import {
  SourceControlCloneProtocolSchema,
  type SourceControlCloneProtocol,
} from '../scm/repositoryClone.js';
import {
  SkillCatalogItemV1Schema,
  SkillCatalogV1Schema,
} from '../runtime/catalog/skills.js';
import {
  VendorPluginCatalogItemV1Schema,
  VendorPluginCatalogV1Schema,
} from '../runtime/catalog/vendorPlugins.js';
import {
  ExternalSessionTakeoverInputV1Schema,
  ExternalSessionTakeoverResultV1Schema,
} from '../sessions/external/takeoverV1.js';
import {
  ExternalSessionMaterializeStartInputV1Schema,
  ExternalSessionMaterializeActionInputV1Schema,
  ExternalSessionMaterializeActionResultV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationDiscardInputV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  ExternalSessionOperationRetryInputV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  ExternalSessionOperationTransportReferenceV1Schema,
  ExternalSessionTakeoverStartInputV1Schema,
  projectExternalSessionMaterializeActionResultV1,
  projectExternalSessionOperationActionResultV1,
} from '../sessions/external/operationActionSchemasV1.js';
import {
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS,
  PluginSessionHookInstallActionInputV1Schema,
  PluginSessionHookInstallInputV1Schema,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookInstallationMutationActionInputV1Schema,
  PluginSessionHookInstallationMutationInputV1Schema,
  PluginSessionHookStatusActionInputV1Schema,
  PluginSessionHookStatusInputV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookToggleResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
} from '../sessions/external/hookManagementV1.js';
import {
  SubagentLifecycleDetailV1Schema,
  SubagentRefInputV1Schema,
  SubagentRefV1Schema,
  SubagentStatusV1Schema,
} from '../sessions/subagents/subagentRefV1.js';
import { SessionRollbackTargetSchema } from '../sessions/rollback.js';
import {
  CheckpointCodeRollbackRequestSchema,
  CheckpointCodeRollbackActionRequestSchema,
  CheckpointCodeRollbackResultSchema,
} from '../sessions/control/rollback/checkpointCodeRollback.js';
import {
  SessionCheckpointRequestV1Schema,
  SessionCheckpointResultV1Schema,
  SessionRestoreRequestV1Schema,
  SessionRestoreResultV1Schema,
} from '../sessions/control/checkpoints/v1.js';
import {
  SessionTerminalComposerClearRequestV1Schema,
  SessionTerminalComposerClearResultV1Schema,
} from '../sessions/control/terminalComposerClearV1.js';
import {
  SessionPendingInputInterruptAndRunRequestV1Schema,
  SessionPendingInputInterruptAndRunResultV1Schema,
} from '../sessions/control/pendingInputInterruptAndRunV1.js';
import {
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetResultGetRequestSchema,
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResumeRequestSchema,
  SessionHandoffPrepareTargetResumeResponseSchema,
  SessionHandoffStatusGetRequestSchema,
  SessionHandoffActionResultV1Schema,
} from '../sessions/control/handoff/handoffSchemas.js';
import { HandoffTargetReplacementApprovalV1Schema } from '../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import {
  WorkspaceSyncConflictResolveActionInputV1Schema,
  WorkspaceSyncConflictsListActionInputV1Schema,
  WorkspaceSyncConflictInspectActionInputV1Schema,
  WorkspaceSyncRelationshipsListActionInputV1Schema,
  WorkspaceSyncRelationshipCreateActionInputV1Schema,
  WorkspaceSyncRelationshipCreateResultV1Schema,
  HandoffWorkspaceActionV1Schema,
  WorkspaceSyncConflictResolutionResultV1Schema,
} from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { SessionContinueWithReplayRpcParamsSchema } from '../sessions/continueWithReplay.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../rpc/methods.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';
import {
  RUNTIME_ACTION_INPUT_SCHEMAS,
  RUNTIME_ACTION_OUTPUT_SCHEMAS,
  RUNTIME_ACTION_SPECS,
} from './specs/index.js';
import { HOME_GOVERNANCE_ACTION_SPECS } from './specs/home.js';
import { SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS } from './specs/sessionOrganization.js';
import { SCOPE_ACTION_SPECS } from './specs/scope.js';
import { HOME_HUB_LAYOUT_ACTION_SPECS } from './specs/homeHub.js';
import { WIDGET_INSTANCE_ACTION_SPECS_V1, WIDGET_DEFINITION_ACTION_SPECS_V1, WIDGET_SNAPSHOT_ACTION_SPECS_V1 } from './specs/widgets.js';
import type { WidgetInstanceActionIdV1, WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import type { WidgetDefinitionActionIdV1, WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1 } from '../widgets/definitionActionsV1.js';
import { MACHINE_CONNECTION_ACTION_SPECS } from './specs/machineConnection.js';
import { TEAM_ACTION_SPECS } from './specs/teams.js';
import { SHARED_SAVED_SECRET_ACTION_SPECS } from './specs/sharedSavedSecrets.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS } from './specs/connectedServices.js';
import {
  TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1,
  type TeamCredentialActionIdV1,
} from '../teams/credentials/actionsV1.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../teams/credentials/resourceV1.js';
import {
  SHARED_SAVED_SECRET_ACTION_IDS_V1,
  SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1,
  SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
  type SharedSavedSecretActionIdV1,
} from '../account/settings/savedSecretResourceActionsV1.js';
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_SPECS,
  type ManagedIdentityProviderRequiredAuthority,
} from './specs/identityProviders.js';
import { redactObservationInputPaths } from './specs/observationRedaction.js';
import {
  SESSION_ARCHIVE_CLI_PROJECTION,
  SESSION_MODEL_SET_CLI_PROJECTION,
  SESSION_PERMISSION_MODE_SET_CLI_PROJECTION,
  SESSION_STATUS_GET_CLI_PROJECTION,
  SESSION_STOP_CLI_PROJECTION,
  SESSION_TITLE_SET_CLI_PROJECTION,
  SESSION_UNARCHIVE_CLI_PROJECTION,
  SESSION_WAIT_IDLE_CLI_PROJECTION,
} from './specs/sessionCommandCli.js';
import { SESSION_SEND_CLI_PROJECTION } from './specs/sessionSendCli.js';
import { SESSION_LIST_CLI_PROJECTION } from './specs/sessionListCli.js';
import {
  EXECUTION_RUN_GET_CLI_PROJECTION,
  EXECUTION_RUN_LIST_CLI_PROJECTION,
  EXECUTION_RUN_START_CLI_PROJECTION,
  EXECUTION_RUN_STOP_CLI_PROJECTION,
  EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION,
  EXECUTION_RUN_STREAM_READ_CLI_PROJECTION,
  EXECUTION_RUN_STREAM_START_CLI_PROJECTION,
  EXECUTION_RUN_WAIT_CLI_PROJECTION,
} from './specs/executionRunCli.js';
import {
  SESSION_BOARD_GET_CLI_PROJECTION,
  SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION,
  SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION,
  SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION,
} from './specs/sessionBoardCli.js';
import {
  SESSION_DISCUSSION_ARCHIVE_CLI_PROJECTION,
  SESSION_DISCUSSION_CREATE_CLI_PROJECTION,
  SESSION_DISCUSSION_GET_CLI_PROJECTION,
  SESSION_DISCUSSION_LIST_CLI_PROJECTION,
  SESSION_DISCUSSION_POST_CLI_PROJECTION,
  SESSION_DISCUSSION_READ_CLI_PROJECTION,
  SESSION_DISCUSSION_READ_STATE_SET_CLI_PROJECTION,
  SESSION_DISCUSSION_RENAME_CLI_PROJECTION,
  SESSION_DISCUSSION_RESTORE_CLI_PROJECTION,
} from './specs/sessionDiscussionCli.js';
import { SESSION_READ_STATE_SET_CLI_PROJECTION } from './specs/sessionReadStateCli.js';
import {
  SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1,
  SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1,
} from '../sessions/readState/actions.js';
import { SESSION_READ_STATE_HTTP_PATHS_V1 } from '../sessions/readState/api.js';
import {
  SESSION_ATTENTION_STANDING_HTTP_PATH_V1,
  SessionAttentionSetInputV1Schema,
  SessionAttentionSetResultV1Schema,
} from '../sessions/organization/attentionAction.js';
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  type ManagedIdentityProviderActionIdV1,
} from '../identity/providers.js';
import { TEAM_ACTION_IDS_V1, type TeamActionIdV1 } from '../teams/actionsV1.js';
import {
  MANAGED_GITHUB_APP_ACTION_IDS_V1,
  MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1,
  MANAGED_GITHUB_APP_ACTION_PATHS_V1,
  type ManagedGitHubAppActionIdV1,
} from '../identity/githubApps.js';
import { ActionApprovalSchema, resolveActionApprovalFlow, type ActionApproval } from './actionApprovalMetadata.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ActionInvokeInputSchema } from './actionInvokeInput.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import {
  ActionContextualDefaultsSchema,
  type ActionContextualDefaults,
} from './contextualDefaults.js';

export {
  ActionContextualDefaultsSchema,
  type ActionContextualDefaults,
} from './contextualDefaults.js';

export {
  RuntimeActionHostEffectClassSchema,
  resolveRuntimeActionHostEffectClass,
  type RuntimeActionHostEffectClass,
} from './safety.js';

export {
  ActionApprovalFlowSchema,
  ActionApprovalResultSchema,
  ActionApprovalSchema,
  resolveActionApprovalFlow,
  type ActionApproval,
  type ActionApprovalFlow,
  type ActionApprovalResult,
} from './actionApprovalMetadata.js';

const ZodSchemaLike = z.custom<z.ZodTypeAny>((value) => {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return typeof v.safeParse === 'function' && typeof v.parse === 'function';
}, { message: 'Expected a Zod schema' });

export type ActionSurfaceBindingCaller = ActionCaller;

export type ActionSurfaceBindingContext = Readonly<{
  actionId: ActionId;
  surface: 'api' | 'rpc' | 'plugin';
  caller: ActionSurfaceBindingCaller;
  defaultSessionId?: string | null;
  serverId?: string | null;
  externalActionTarget?: ExternalActionTargetV1;
  signal?: AbortSignal;
  input?: unknown;
}>;

export type ActionSurfaceBindingTransform = (
  value: unknown,
  context: ActionSurfaceBindingContext,
) => unknown | Promise<unknown>;

const ActionSurfaceBindingTransformSchema = lazyZodSchema(() => z.custom<ActionSurfaceBindingTransform>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action surface binding transform' },
));

export const ActionSpecSurfaceBindingsSchema = lazyZodSchema(() => z.object({
  api: z.object({
    inputSchema: ZodSchemaLike,
    bindInput: ActionSurfaceBindingTransformSchema.optional(),
    outputSchema: ZodSchemaLike.optional(),
    inputHints: ActionInputHintsSchema.optional(),
  }).strict().optional(),
  rpc: z.object({
    inputSchema: ZodSchemaLike,
    decodeInput: ActionSurfaceBindingTransformSchema,
    outputSchema: ZodSchemaLike,
    encodeOutput: ActionSurfaceBindingTransformSchema,
  }).strict().optional(),
  plugin: z.object({
    inputSchema: ZodSchemaLike.optional(),
    bindInput: ActionSurfaceBindingTransformSchema.optional(),
    outputSchema: ZodSchemaLike.optional(),
    projectOutput: ActionSurfaceBindingTransformSchema.optional(),
  }).strict().optional(),
}).strict());
export type ActionSpecSurfaceBindings = z.infer<typeof ActionSpecSurfaceBindingsSchema>;

const ActionPluginCallerAdministrativeSelectorSchema = lazyZodSchema(() => z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());

/**
 * A host Action's explicit authority contract when it is callable by a
 * plugin. `caller` requires a current host-stamped plugin caller at the
 * canonical executor: the host proves the call really came from the claimed
 * plugin materialization. Further identity projection occurs only where an
 * incumbent domain owner has caller-dependent authorization — for example the
 * Account-scoped Automation owner, which fences its own reads by Account and
 * current materialization rather than by which plugin is asking — and it never
 * grants authority over another plugin. `self_or_inspector_admin` is reserved
 * for the one plugin-targeted host Action and makes its exceptional Inspector
 * administration visible at the Action declaration owner.
 */
export const ActionPluginCallerPolicySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('caller'),
  }).strict(),
  z.object({
    kind: z.literal('self_or_inspector_admin'),
    targetPluginIdField: z.literal('pluginId'),
    administrativeCallers: z.array(ActionPluginCallerAdministrativeSelectorSchema).min(1),
  }).strict(),
]));
export type ActionPluginCallerPolicy = z.infer<typeof ActionPluginCallerPolicySchema>;

export { ActionSafetySchema, type ActionSafety } from './safety.js';
export {
  ActionExecutionPlacementSchema,
  ActionInputHintsSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  type ActionExecutionPlacement,
  type ActionInputHints,
  type ActionRequiredAuthority,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';
export {
  ActionInputFieldHintSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  ActionInputWidgetSchema,
  readActionInputOptionValue,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
} from './actionInputHints.js';

export const ActionPromptingSchema = lazyZodSchema(() => z
  .object({
    voiceHotPath: z.boolean().optional(),
  })
  .passthrough());
export type ActionPrompting = z.infer<typeof ActionPromptingSchema>;

/** Local declaration only; domain routes retain wire validation and authorization. */
export const ActionServerTransportSchema = lazyZodSchema(() => z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').refine((path) => !path.startsWith('//'), {
    message: 'Action transport must be a relative Home path',
  }),
}).strict());
export type ActionServerTransport = z.infer<typeof ActionServerTransportSchema>;

export const ActionSpecSchema = lazyZodSchema(() => z.object({
  id: ActionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  safety: ActionSafetySchema,
  approval: ActionApprovalSchema,
  // UI placements where the action can appear when the relevant surface is enabled.
  placements: z.array(ActionUiPlacementSchema).default([]),
  // Optional stable slash command token for UI slash-command placement.
  slash: z.object({
    tokens: z.array(z.string().min(1)),
  }).passthrough().optional(),
  bindings: z.object({
    // Tool name the voice client is allowed to expose (surface.voice).
    voiceClientToolName: z.string().min(1).optional(),
    // Optional direct MCP tool name; generic action_execute invokes by Action id.
    mcpToolName: z.string().min(1).optional(),
    // Optional generated SDK method-name override. Most public Actions derive
    // their path from the canonical Action id; overrides only resolve a real
    // namespace collision.
    sdkMethod: z.string().min(1).optional(),
    // RPC method exposed when surface.rpc is true.
    rpcMethod: z.string().min(1).optional(),
    // Wire aliases accepted alongside the canonical method until their owning compatibility packet removes them.
    rpcMethodAliases: z.array(z.string().min(1)).optional(),
  }).passthrough().optional(),
  surfaceBindings: ActionSpecSurfaceBindingsSchema.optional(),
  outputSchema: ZodSchemaLike.optional(),
  /** Host-private launch/terminal projection. Only its schema and awaits marker are frozen. */
  completion: z.object({
    awaits: z.literal('execution_runs'),
    terminalOutputSchema: ZodSchemaLike,
    launched: z.custom<ActionCompletionDeclaration['launched']>((value) => typeof value === 'function'),
    terminal: z.custom<ActionCompletionDeclaration['terminal']>((value) => typeof value === 'function'),
  }).strict().optional(),
  /** Host-private input projection for observers; secrets must never enter Action history. */
  projectObservationInput: z.custom<(value: unknown) => unknown>(
    (value) => typeof value === 'function',
  ).optional(),
  /** Host-private output projection for observers; never changes the intentional caller result. */
  projectObservationOutput: z.custom<(value: unknown) => unknown>(
    (value) => typeof value === 'function',
  ).optional(),
  /**
   * Host-private custody rule for one-shot results that must never become
   * durable Approval Artifact result state. A present-user UI invocation keeps
   * the existing blocking waiter alive and receives the result directly; if
   * that live invocation is lost, the result is intentionally unrecoverable.
   */
  approvalResultCustody: z.literal('live_only').optional(),
  /**
   * The input-side sibling of `approvalResultCustody`. Host-private custody rule
   * for secret-bearing input — credentials, verification bearers, reauthentication
   * proofs — that must never become durable Approval Artifact state. The admitted
   * invocation stays the blocking waiter and keeps the raw input; the Artifact
   * carries only this Action's own `projectObservationInput` projection, so a
   * replay that no longer has the live invocation fails closed instead of
   * recovering the secret from durable approval state.
   */
  approvalInputCustody: z.literal('live_only').optional(),
  /** Domain-owned disclosure of this exact operation to its Session participants. */
  projectSessionConfirmation: z.custom<(
    input: unknown,
    context: Readonly<{ sessionId: string }>,
  ) => unknown | null>((value) => typeof value === 'function').optional(),
  execution: z
    .object({
      handler: z.string().min(1).optional(),
      transport: z.enum(['host', 'plugin', 'rpc', 'api']).optional(),
    })
    .passthrough()
    .optional(),
  sideEffectClass: z.enum(['none', 'read', 'write', 'external', 'danger']).optional(),
  /** This Action mutates workspace files or repository state. Coordination writes do not. */
  workspaceWrite: z.literal(true).optional(),
  examples: z
    .object({
      voice: z
        .object({
          argsExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
      mcp: z
        .object({
          argsExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
      sdk: z
        .object({
          codeExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  prompting: ActionPromptingSchema.optional(),
  toolExposure: ActionToolExposureSchema.optional(),
  contextualDefaults: ActionContextualDefaultsSchema.optional(),
  operation: ActionOperationDeclarationV1Schema.optional(),
  /** Host-owned admission floor; public callers never supply this in Action input. */
  requiredAuthority: ActionRequiredAuthoritySchema.optional(),
  /** Host-owned routing placement; public callers never supply this in Action input. */
  executionPlacement: ActionExecutionPlacementSchema.optional(),
  /** Host-only selector for an admitted input whose owner varies; never serialized as caller authority. */
  executionPlacementForInput: z.custom<(input: unknown) => ActionExecutionPlacement>((value) => typeof value === 'function').optional(),
  /** Explicit host-stamped caller authority for a Plugin Action. */
  pluginCallerPolicy: ActionPluginCallerPolicySchema.optional(),
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: ActionInputHintsSchema.optional(),
  /**
   * Friendly CLI command projection for this packaged binary. Intentionally
   * omitted by `serializeActionSpec`/`actionSpecToActionDefinitionV1`: it is not
   * a cross-version wire contract and its binder cannot be serialized.
   */
  cli: ActionCliProjectionSchema.optional(),
  /** Not serialized; the bound domain adapter supplies encryption and Home identity. */
  serverTransport: ActionServerTransportSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if ((value.placements?.length ?? 0) > 0 && !value.surfaces.ui) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'placements require surface.ui',
      path: ['surfaces', 'ui'],
    });
  }
  if (value.approvalResultCustody === 'live_only') {
    if (value.approval.result !== 'required') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'live-only approval custody requires a required result',
        path: ['approvalResultCustody'],
      });
    }
    if (!value.projectObservationOutput) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'live-only approval custody requires a safe observation projection',
        path: ['projectObservationOutput'],
      });
    }
  }
  if (value.approvalInputCustody === 'live_only') {
    if (resolveActionApprovalFlow(value.approval) !== 'blocking') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'live-only approval input custody requires a blocking approval flow',
        path: ['approvalInputCustody'],
      });
    }
    if (!value.projectObservationInput) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'live-only approval input custody requires a safe observation projection',
        path: ['projectObservationInput'],
      });
    }
  }
  if (value.surfaces.rpc && !value.bindings?.rpcMethod) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.rpc requires bindings.rpcMethod',
      path: ['bindings', 'rpcMethod'],
    });
  }
  if (value.surfaces.mcp && !value.outputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.mcp requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && !value.outputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.plugin requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && value.inputSchema instanceof z.ZodUnknown) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.plugin requires a representable input schema',
      path: ['inputSchema'],
    });
  }
  if (value.surfaces.plugin && value.outputSchema instanceof z.ZodUnknown) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.plugin requires a representable output schema',
      path: ['outputSchema'],
    });
  }
  const nonSafePluginAction = value.surfaces.plugin && value.safety !== 'safe';
  if (nonSafePluginAction && !value.pluginCallerPolicy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'non-safe surface.plugin requires pluginCallerPolicy',
      path: ['pluginCallerPolicy'],
    });
  }
  if (!value.surfaces.plugin && value.pluginCallerPolicy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pluginCallerPolicy requires a surface.plugin Action',
      path: ['pluginCallerPolicy'],
    });
  }
  if (value.surfaceBindings?.rpc && !value.surfaces.rpc) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surfaceBindings.rpc requires surface.rpc',
      path: ['surfaceBindings', 'rpc'],
    });
  }
  if (value.surfaceBindings?.plugin && !value.surfaces.plugin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surfaceBindings.plugin requires surface.plugin',
      path: ['surfaceBindings', 'plugin'],
    });
  }
  if (value.cli && !value.surfaces.cli) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cli requires surface.cli',
      path: ['surfaces', 'cli'],
    });
  }
  if (value.cli) {
    // Positionals name the effective CLI caller shape, which is the declared
    // caller schema when one exists and the canonical Action input otherwise.
    const callerShape = value.cli.inputSchema ?? value.inputSchema;
    const declaredFields = readActionSchemaTopLevelFieldNames(callerShape);
    if (declaredFields) {
      for (const [index, command] of value.cli.commands.entries()) {
        for (const [positionalIndex, positional] of (command.positionals ?? []).entries()) {
          if (!declaredFields.has(positional)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `cli positional "${positional}" is not a field of the effective CLI caller schema`,
              path: ['cli', 'commands', index, 'positionals', positionalIndex],
            });
          }
        }
        if (command.variadicPositional && !declaredFields.has(command.variadicPositional)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `cli variadic positional "${command.variadicPositional}" is not a field of the effective CLI caller schema`,
            path: ['cli', 'commands', index, 'variadicPositional'],
          });
        }
      }
      for (const [index, entry] of (value.cli.flagAliases ?? []).entries()) {
        if (!declaredFields.has(entry.path)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `cli flag alias target "${entry.path}" is not a field of the effective CLI caller schema`,
            path: ['cli', 'flagAliases', index, 'path'],
          });
        }
      }
    }
  }
  if (value.surfaceBindings?.plugin?.bindInput && !value.surfaceBindings.plugin.inputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surfaceBindings.plugin.bindInput requires a caller input schema',
      path: ['surfaceBindings', 'plugin', 'inputSchema'],
    });
  }
}));

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
  requiredAuthority: ActionRequiredAuthority;
  executionPlacement: ActionExecutionPlacement;
}>;

/**
 * Evaluates the declaration-owned policy against host-stamped caller
 * provenance. Action input never manufactures, widens, or narrows caller
 * authority: it is read only to name the plugin the call *targets*, and the
 * target is then compared against the stamped caller.
 */
export function isPluginActionCallerPolicySatisfied(
  policy: ActionPluginCallerPolicy | undefined,
  input: unknown,
  caller: ActionCaller | undefined,
): boolean {
  if (!policy || caller?.kind !== 'plugin') return false;
  if (policy.kind === 'caller') return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;

  const targetPluginId = (input as Readonly<Record<string, unknown>>)[policy.targetPluginIdField];
  if (typeof targetPluginId !== 'string') return false;
  if (targetPluginId === caller.pluginId) return true;

  return policy.administrativeCallers.some((administrator) => (
    administrator.pluginId === caller.pluginId
    && administrator.contributionLocalId === caller.contributionLocalId
  ));
}

type ParsedActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionSpecWithoutApproval = Readonly<{
  id: ParsedActionSpec['id'];
  title: ParsedActionSpec['title'];
  description?: ParsedActionSpec['description'];
  safety: ParsedActionSpec['safety'];
  placements: readonly ActionUiPlacement[];
  slash?: ParsedActionSpec['slash'];
  bindings?: ParsedActionSpec['bindings'];
  surfaceBindings?: ParsedActionSpec['surfaceBindings'];
  outputSchema?: ParsedActionSpec['outputSchema'];
  completion?: ParsedActionSpec['completion'];
  projectObservationInput?: ParsedActionSpec['projectObservationInput'];
  projectObservationOutput?: ParsedActionSpec['projectObservationOutput'];
  approvalResultCustody?: ParsedActionSpec['approvalResultCustody'];
  approvalInputCustody?: ParsedActionSpec['approvalInputCustody'];
  projectSessionConfirmation?: ParsedActionSpec['projectSessionConfirmation'];
  execution?: ParsedActionSpec['execution'];
  sideEffectClass?: ParsedActionSpec['sideEffectClass'];
  workspaceWrite?: ParsedActionSpec['workspaceWrite'];
  examples?: ParsedActionSpec['examples'];
  prompting?: ParsedActionSpec['prompting'];
  toolExposure?: ParsedActionSpec['toolExposure'];
  contextualDefaults?: ParsedActionSpec['contextualDefaults'];
  operation?: ParsedActionSpec['operation'];
  requiredAuthority?: ParsedActionSpec['requiredAuthority'];
  executionPlacement?: ParsedActionSpec['executionPlacement'];
  executionPlacementForInput?: ParsedActionSpec['executionPlacementForInput'];
  pluginCallerPolicy?: ParsedActionSpec['pluginCallerPolicy'];
  surfaces: ParsedActionSpec['surfaces'];
  inputSchema: ParsedActionSpec['inputSchema'];
  inputHints?: ParsedActionSpec['inputHints'];
  cli?: ParsedActionSpec['cli'];
  serverTransport?: ParsedActionSpec['serverTransport'];
}>;

/**
 * Author-owned Action rows intentionally omit the derived API and Plugin
 * exposure bits. Those values are assigned once by normalizeActionPublicExposure
 * from the canonical internal/provenance/human-secret classifications below.
 */
export type PreNormalizedActionSurfaces = Omit<ActionSurfaces, 'api' | 'plugin'> & Readonly<{
  api?: never;
  plugin?: never;
}>;
export type ActionSpecDefinition = Omit<ActionSpecWithoutApproval, 'surfaces'> & Readonly<{
  surfaces: PreNormalizedActionSurfaces;
}>;
export type PreNormalizedActionSpec = ActionSpecDefinition;
type NormalizedActionSpec = ActionSpecWithoutApproval;

/**
 * Keeps each registry row's literal id and concrete Zod schema types intact.
 * Runtime validation still goes through ActionSpecSchema; this helper exists so
 * generated author projections do not widen back to ActionId/ZodTypeAny.
 */
export function defineActionSpecs<const TSpecs extends readonly PreNormalizedActionSpec[]>(
  specs: TSpecs,
): TSpecs {
  return specs;
}

const DAEMON_ADMIN_RPC_SURFACES = Object.freeze({
  ui: false,
  voice: false,
  agent: false,
  mcp: false,
  cli: false,
  rpc: true,
} satisfies PreNormalizedActionSurfaces);

const DAEMON_ADMIN_INPUT_HINTS = Object.freeze({
  fields: [],
} satisfies ActionInputHints);

const EmptyObjectSchema = lazyZodSchema(() => z.object({}).strict());
const DaemonFilesystemReadFileInputSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
}).passthrough());
const DaemonFilesystemWriteFileInputSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedHash: z.string().nullable().optional(),
}).passthrough());
const DaemonFilesystemListDirectoryInputSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  includeGitIgnore: z.boolean().optional(),
}).passthrough());
const DaemonFilesystemGetDirectoryTreeInputSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  maxDepth: z.number().int().min(0),
}).passthrough());
const BugReportGetLogTailInputSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1).optional(),
  maxBytes: z.number().int().min(1024).max(1_000_000).optional(),
}).passthrough());
const BugReportUploadArtifactInputSchema = lazyZodSchema(() => z.object({
  uploadUrl: z.string().optional(),
}).passthrough());
const OptionalSessionIdInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
}).passthrough());

const SessionIdRequiredInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
}).passthrough());

const SessionTitleSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().trim().min(1),
}).passthrough());

const SessionPermissionModeSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  permissionMode: SessionPermissionModeInputSchema,
}).passthrough());

export const SessionModelSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  modelId: z.string().trim().min(1).optional(),
  providerConnectionId: ProviderConnectionIdSchema.nullable().optional(),
  teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema.optional(),
  teamVisibilityGrantConsent: z.object({ teamId: z.string().min(1) }).strict().optional(),
}).passthrough().superRefine((value, context) => {
  const hasTeamSelection = value.teamCredentialModel !== undefined;
  const hasLegacySelection = value.modelId !== undefined || value.providerConnectionId !== undefined;
  if (hasTeamSelection === hasLegacySelection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['teamCredentialModel'],
      message: 'Select exactly one model source',
    });
  }
  if (!hasTeamSelection && value.modelId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['modelId'], message: 'modelId is required' });
  }
  if (value.teamVisibilityGrantConsent && value.teamVisibilityGrantConsent.teamId !== value.teamCredentialModel?.teamId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['teamVisibilityGrantConsent'], message: 'Consent must match the selected Team' });
  }
}));

const SessionStatusGetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  live: z.boolean().optional(),
}).passthrough());

const SessionHistoryGetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(250).optional(),
  format: z.enum(['compact', 'raw']).optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
}).passthrough());

const SessionTranscriptRoleSchema = lazyZodSchema(() => z.enum(['user', 'assistant']));
const SessionStoredTranscriptRoleSchema = lazyZodSchema(() => z.enum(['user', 'agent', 'event', 'unknown']));

const SessionTranscriptGetExternalShareableProjectionSchema = lazyZodSchema(() => z.literal('externalShareableV1'));

/**
 * The largest page `session.transcript.get` will return for one request.
 *
 * Named here because the bound has consumers outside the schema: the reader
 * clamps to it, and a caller that wants the fewest possible round trips asks
 * for exactly it. Each of those was carrying its own copy of the number, so
 * lowering the bound left them confidently over-asking.
 */
export const SESSION_TRANSCRIPT_GET_MAX_LIMIT = 100;

const SessionTranscriptGetInputShape = {
  sessionId: z.string().min(1),
  projection: SessionTranscriptGetExternalShareableProjectionSchema.optional(),
  limit: z.number().int().min(1).max(SESSION_TRANSCRIPT_GET_MAX_LIMIT).optional(),
  cursor: z.string().min(1).nullable().optional(),
  direction: z.enum(['before', 'after']).optional(),
  scope: z.enum(['main', 'sidechain', 'all']).optional(),
  sidechainId: z.string().min(1).nullable().optional(),
  roles: z.array(SessionTranscriptRoleSchema).optional(),
  includeTools: z.boolean().optional(),
  includeReasoning: z.boolean().optional(),
  includeEvents: z.boolean().optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  maxCharsPerMessage: z.number().int().min(0).max(50_000).nullable().optional(),
  maxRawPayloadChars: z.number().int().min(1).max(32768).nullable().optional(),
};

/** Closed semantic transcript input exposed to PAT/API/SDK callers. */
const SessionTranscriptGetPublicInputSchema = lazyZodSchema(() => z.object(SessionTranscriptGetInputShape)
  .omit({ projection: true })
  .strict());

/** Exact public input for the closed external-shareable transcript projection. */
export const SessionTranscriptGetExternalShareableInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: SessionTranscriptGetInputShape.sessionId,
  projection: SessionTranscriptGetExternalShareableProjectionSchema,
  limit: SessionTranscriptGetInputShape.limit,
  cursor: SessionTranscriptGetInputShape.cursor,
}).strict());
export type SessionTranscriptGetExternalShareableInputV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableInputV1Schema
>;

export const SessionTranscriptGetInputSchema = lazyZodSchema(() => z.object(SessionTranscriptGetInputShape).passthrough().superRefine((value, context) => {
  if (value.projection !== 'externalShareableV1') return;
  const allowedKeys = new Set(['sessionId', 'projection', 'cursor', 'limit']);
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    context.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} is not accepted by the externalShareableV1 projection`,
    });
  }
}));
export type SessionTranscriptGetInput = z.infer<typeof SessionTranscriptGetInputSchema>;
const SessionTranscriptSemanticRoleSchema = lazyZodSchema(() => z.enum([
  'user',
  'assistant',
  'tool',
  'event',
  'reasoning',
  'unknown',
]));
const SessionTranscriptStoredMessageRoleSchema = lazyZodSchema(() => z.enum(['user', 'agent', 'event', 'unknown']));
const SessionTranscriptGetItemSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  seq: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  storedMessageRole: SessionTranscriptStoredMessageRoleSchema.optional(),
  semanticRole: SessionTranscriptSemanticRoleSchema,
  role: SessionTranscriptSemanticRoleSchema,
  kind: z.string(),
  origin: ConversationTurnOriginV1Schema.optional(),
  provider: z.string().optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
  toolName: z.string().optional(),
  callId: z.string().optional(),
  raw: z.unknown().optional(),
  truncated: z.boolean().optional(),
  rawTruncated: z.boolean().optional(),
}).strict());
export type SessionTranscriptGetItem = z.infer<typeof SessionTranscriptGetItemSchema>;

const SessionTranscriptGetSemanticSuccessSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  items: z.array(SessionTranscriptGetItemSchema).readonly(),
  nextCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
  diagnostics: z.object({
    rawRowsScanned: z.number().int().nonnegative(),
    pagesFetched: z.number().int().nonnegative(),
    scanLimitReached: z.boolean(),
    payloadTruncations: z.number().int().nonnegative(),
  }).strict(),
}).strict());

export const SessionTranscriptGetExternalShareableResultV1Schema = lazyZodSchema(() => ExternalShareableTranscriptPageV1Schema.extend({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  projection: z.literal('externalShareableV1'),
}).strict());

const SessionTranscriptGetErrorSchema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
  candidates: z.array(z.string().min(1)).readonly().optional(),
}).strict());

/** Canonical strict result envelope for every session.transcript.get Action path. */
export const SessionTranscriptGetResultSchema = lazyZodSchema(() => z.union([
  SessionTranscriptGetSemanticSuccessSchema,
  SessionTranscriptGetExternalShareableResultV1Schema,
  SessionTranscriptGetErrorSchema,
]));
export type SessionTranscriptGetResult = z.infer<typeof SessionTranscriptGetResultSchema>;
export type SessionTranscriptGetExternalShareableResultV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableResultV1Schema
>;
export type SessionTranscriptGetOutput = SessionTranscriptGetResult;

export const SessionEventsGetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).nullable().optional(),
  direction: z.enum(['before', 'after']).optional(),
  scope: z.enum(['main', 'sidechain', 'all']).optional(),
  sidechainId: z.string().min(1).nullable().optional(),
  roles: z.array(SessionStoredTranscriptRoleSchema).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  format: z.enum(['compact', 'raw']).optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  maxTextChars: z.number().int().min(0).max(4000).optional(),
  maxPayloadChars: z.number().int().min(1).max(32768).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.sidechainId && value.scope !== 'sidechain') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scope must be sidechain when sidechainId is provided',
      path: ['scope'],
    });
  }
}));
export type SessionEventsGetInput = z.infer<typeof SessionEventsGetInputSchema>;
export type SessionEventsGetItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  storedMessageRole?: 'user' | 'agent' | 'event' | 'unknown';
  semanticRole: 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
  kind: string;
  origin?: ConversationTurnOriginV1;
  provider?: string;
  text?: string;
  summary?: string;
  toolName?: string;
  callId?: string;
  raw?: unknown;
  truncated?: boolean;
  rawTruncated?: boolean;
}>;
export type SessionEventsGetOutput =
  | Readonly<{
      ok: true;
      sessionId: string;
      items: readonly SessionEventsGetItem[];
      nextCursor: string | null;
      hasMore: boolean;
      diagnostics?: Readonly<{
        rawRowsScanned: number;
        pagesFetched: number;
        scanLimitReached: boolean;
        payloadTruncations: number;
      }>;
    }>
  | Readonly<{
      ok: false;
      errorCode: string;
      errorMessage: string;
      candidates?: readonly string[];
    }>;

const SessionWaitIdleInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough());

const SessionWaitIdlePublicInputSchema = lazyZodSchema(() => SessionWaitIdleInputSchema.strict());

/** Exact result returned by the canonical Session idle waiter. */
export const SessionWaitIdleResultSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    idle: z.literal(true),
    observedAt: z.number().finite().nonnegative(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'session_not_found',
      'session_id_ambiguous',
      'session_lookup_timeout',
      'unsupported',
      'encryption_material_unavailable',
      'timeout',
    ]),
    candidates: z.array(z.string().min(1)).readonly().optional(),
  }).strict(),
]));

const SessionGoalSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  objective: z.string().trim().min(1).max(4000).optional(),
  status: SessionWorkStateStatusV1Schema.optional(),
  tokenBudget: z.number().finite().positive().nullable().optional(),
}).passthrough().refine((value) => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
), { message: 'At least one goal mutation field is required' }));

const SessionFollowPreferencesCliInputSchema = lazyZodSchema(() => z.object({
  assigned: z.enum(['on', 'off']),
  direct: z.enum(['on', 'off']),
  team: z.enum(['on', 'off']),
  group: z.enum(['on', 'off']),
}).strict());

const SessionCatalogListInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1).optional(),
}).passthrough());

const SessionVendorPluginCatalogListOutputSchema = lazyZodSchema(() => z.object({
  supported: z.boolean().optional(),
  unsupported: z.literal(true).optional(),
  vendorPlugins: z.array(VendorPluginCatalogItemV1Schema).readonly(),
  catalog: VendorPluginCatalogV1Schema.optional(),
  diagnostic: z.string().min(1).optional(),
}).passthrough());

const SessionSkillCatalogListOutputSchema = lazyZodSchema(() => z.object({
  supported: z.boolean().optional(),
  unsupported: z.literal(true).optional(),
  skills: z.array(SkillCatalogItemV1Schema).readonly(),
  catalog: SkillCatalogV1Schema.optional(),
  diagnostic: z.string().min(1).optional(),
}).passthrough());

const BackendTargetKeyInputSchema = lazyZodSchema(() => z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]));

const IntentStartCommonSchema = lazyZodSchema(() => z.object({
  roleId: z.string().trim().min(1).optional(),
  launchProfileId: z.string().trim().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  backendTargetKeys: z.array(BackendTargetKeyInputSchema).min(1),
  instructions: z.string().trim().min(1),
  permissionMode: ExecutionRunActionPermissionModeSchema.optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
  notifyParentOnCompletion: z.boolean().optional(),
  /**
   * Optional model selection applied to EVERY started run, reusing the canonical session-spawn
   * `modelId` vocabulary. Omitted ⇒ each backend's default model.
   */
  modelId: z.string().min(1).optional(),
  /** Exact recipient-safe Team resource/model selection for the one selected Agent target. */
  teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema.optional(),
  teamCredentialSessionBindingConsent: ExecutionRunTeamCredentialSessionBindingConsentV1Schema.optional(),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: SecretReferenceOverlayV1Schema.optional(),
  /**
   * Optional canonical agent config-option overrides (e.g. reasoning effort) applied to every
   * started run — the SAME `AcpConfigOptionOverridesV1` shape session spawn uses.
   */
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; a value conflicting with `sessionConfigOptionOverrides`
   * fails with `invalid_parameters`.
   */
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
  /** Blanket connected-services selection; an exact per-target entry overrides it. */
  connectedServices: StrictJsonValueSchema.optional(),
  /**
   * Optional per-backend-target connected-services selection, keyed by the SAME backend target
   * key strings passed in `backendTargetKeys`. Each value may be an agent-friendly simple string
   * (`"<service>:group:<id>"`, `"<service>:<profileId>"`, `"<service>:native"`), an array of those,
   * or the full current connected-service bindings object — normalized at the action boundary. Targets
   * without an entry apply the session-spawn account-settings defaulting; connected selections fail
   * closed at run start.
   */
  connectedServicesByBackendTargetKey: z
    .record(z.string(), StrictJsonValueSchema)
    .optional(),
}).passthrough());

const PlanStartInputSchema = lazyZodSchema(() => IntentStartCommonSchema.extend({
  target: z.object({ kind: z.literal('detached') }).strict().optional(),
  permissionMode: ExecutionRunActionPermissionModeSchema.default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough().refine((input) => !input.target || input.sessionId === undefined, {
  path: ['sessionId'], message: 'A detached plan cannot target a Session',
}));

const DelegateStartInputSchema = lazyZodSchema(() => IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough());

const VoiceAgentStartInputSchema = lazyZodSchema(() => IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('long_lived'),
  ioMode: z.enum(['request_response', 'streaming']).default('streaming'),
}).passthrough());

/**
 * Scope is intentionally tri-state: an omitted field resolves to the caller's
 * current Session when one exists; explicit `null` means detached; and a string
 * identifies one exact Session. Keep the property optional so the action owner
 * can distinguish omission from explicit `null` by property presence.
 */
const ExecutionRunScopeSessionIdSchema = lazyZodSchema(() => z.string().min(1).refine(
  (sessionId) => sessionId.trim().length > 0,
  { message: 'sessionId must not be whitespace only' },
).nullable().optional());

const ExecutionRunIdInputSchema = lazyZodSchema(() => z.object({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.string().min(1),
}).passthrough());

/**
 * Normalize the agent-friendly `connectedServices` simple-form (string / array) into the canonical
 * current bindings object BEFORE the strict run-request schema validates it. A malformed
 * value is left untouched so the strict schema rejects it (→ `invalid_parameters`). Non-simple
 * (already-object) values pass through unchanged. This keeps the run REQUEST schema strict while the
 * action input accepts the ergonomic forms an agent can produce from the spec alone.
 */
function preprocessRunStartConnectedServicesInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const selection = record.connectedServices;
  if (typeof selection !== 'string' && !Array.isArray(selection)) return raw;
  const normalized = normalizeConnectedServiceSelectionInput(selection);
  if (!normalized.ok) return raw;
  return { ...record, connectedServices: normalized.bindings };
}

const ExecutionRunStartActionRequestSchema = lazyZodSchema(() => ExecutionRunStartRequestBaseSchema.extend({
  // Action callers use the canonical permission-intent vocabulary. The
  // execution-run RPC retains its historical wire tokens, so this shared
  // Action-boundary schema projects `safe-yolo` → `workspace_write` once,
  // before it reaches the run owner.
  permissionMode: ExecutionRunActionPermissionModeSchema,
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.boolean().optional(),
  waitTimeoutSeconds: z.number().int().min(1).optional(),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; conflicting values fail with `invalid_parameters`.
   */
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
}).superRefine(refineExecutionRunStartRequest).superRefine((value, ctx) => {
  if (
    value.teamCredentialSessionBindingConsent
    && (
      value.sessionId === null
      || value.teamCredentialSessionBindingConsent.sessionId !== value.sessionId
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Session binding consent requires and must match an attached Session',
      path: ['teamCredentialSessionBindingConsent', 'sessionId'],
    });
  }
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
}));

const ExecutionRunStartPluginInputSchema = lazyZodSchema(() => ExecutionRunStartRequestBaseSchema.extend({
  // Trusted plugins share the public Action contract; do not let them carry
  // a second, unnormalized permission-mode vocabulary into execution runs.
  permissionMode: ExecutionRunActionPermissionModeSchema,
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.boolean().optional(),
  waitTimeoutSeconds: z.number().int().min(1).optional(),
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
  connectedServices: z.union([
    ConnectedServiceBindingsV2IngressSchema,
    z.string(),
    z.array(z.string()),
  ]).optional(),
}).superRefine(refineExecutionRunStartRequest).superRefine((value, ctx) => {
  if (
    value.teamCredentialSessionBindingConsent
    && (
      value.sessionId === null
      || value.teamCredentialSessionBindingConsent.sessionId !== value.sessionId
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Session binding consent requires and must match an attached Session',
      path: ['teamCredentialSessionBindingConsent', 'sessionId'],
    });
  }
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
}));

const ExecutionRunStartInputSchema = lazyZodSchema(() => z.preprocess<
  unknown,
  typeof ExecutionRunStartActionRequestSchema,
  z.input<typeof ExecutionRunStartPluginInputSchema>
>(
  preprocessRunStartConnectedServicesInput,
  ExecutionRunStartActionRequestSchema,
));

const ExecutionRunGetInputSchema = lazyZodSchema(() => ExecutionRunIdInputSchema.extend({
  includeStructured: z.boolean().optional(),
  waitForInputId: z.string().trim().min(1).optional(),
  waitForOutput: ReviewWalkthroughObservationSchema.optional(),
}).passthrough());

export const DetachedExecutionRunSendInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.null(),
  runId: z.string().min(1),
  message: z.string().min(1),
  localInputId: z.string().trim().min(1).optional(),
  resultContract: ExecutionRunResultContractV1Schema.optional(),
  resume: z.boolean().optional(),
  delivery: z.enum(['prompt', 'steer_if_supported', 'interrupt']).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.resultContract && !value.localInputId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['localInputId'],
      message: 'resultContract requires exact localInputId correspondence',
    });
  }
}));

const ExecutionRunEnsureInputSchema = lazyZodSchema(() => ExecutionRunIdInputSchema.extend({
  resume: z.boolean().optional(),
}).passthrough());

const ExecutionRunEnsureOrStartInputSchema = lazyZodSchema(() => z.object({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.string().min(1).nullable().optional(),
  start: ExecutionRunStartRequestSchema.optional(),
  resume: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId && !value.start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start is required when runId is missing' });
  }
}));

const ExecutionRunStreamStartInputSchema = lazyZodSchema(() => ExecutionRunIdInputSchema.extend({
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  resume: z.boolean().optional(),
}).passthrough());

const ExecutionRunStreamReadInputSchema = lazyZodSchema(() => ExecutionRunTurnStreamReadRequestSchema.extend({
  sessionId: ExecutionRunScopeSessionIdSchema,
}));

const ExecutionRunStreamCancelInputSchema = lazyZodSchema(() => ExecutionRunIdInputSchema.extend({
  streamId: z.string().min(1),
}).passthrough());

const ExecutionRunActionInputSchema = lazyZodSchema(() => ExecutionRunIdInputSchema.extend({
  actionId: z.string().min(1),
  input: StrictJsonValueSchema.optional(),
}).passthrough());

export const ExecutionRunPermissionRespondInputSchema = lazyZodSchema(() => z.union([
  z.object({ runId: z.string().trim().min(1), requestId: z.string().trim().min(1), approved: z.boolean() }).strict(),
  z.object({ runId: z.string().trim().min(1), requestId: z.string().trim().min(1), answers: StructuredQuestionAnswersV1Schema }).strict(),
]));

export type ExecutionRunPermissionRespondActionInput = z.input<typeof ExecutionRunPermissionRespondInputSchema>;

const ExecutionRunWaitInputSchema = lazyZodSchema(() => ExecutionRunIdInputSchema.extend({
  timeoutSeconds: z.number().int().min(1).optional(),
  condition: ExecutionRunWaitConditionSchema.optional(),
  after: ExecutionRunGetResponseSchema.optional(),
}).passthrough());

const ExecutionRunWaitPublicInputSchema = lazyZodSchema(() => ExecutionRunWaitInputSchema.strict());

const SessionOpenInputSchema = lazyZodSchema(() => z.object({
  tabId: z.string().trim().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  sessionTitle: z.string().trim().min(1).optional(),
  serverId: z.string().trim().min(1).optional(),
  approvedNewDirectoryCreation: z.boolean().optional(),
  destination: z.object({
    kind: z.literal('scmReview'),
    comparison: ScmComparisonSourceSchema,
    view: z.enum(['walkthrough', 'files']),
    explain: z.boolean().optional(),
    comparisonId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (!(typeof value.sessionId === 'string' && value.sessionId.trim().length > 0) && !(typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
}));

const SessionForkInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
}).passthrough());

const SessionRollbackInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  target: SessionRollbackTargetSchema.optional(),
}).passthrough());

/**
 * Outcome-oriented public handoff input. Workspace endpoint identity and the
 * settings version that proves it are daemon-owned: the coordinator resolves or
 * materializes both `WorkspaceRef` values from the Account settings owner, so a
 * caller can neither name nor pin them here.
 */
const SessionHandoffInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  sourceMachineId: z.string().min(1).optional(),
  targetMachineId: z.string().min(1).optional(),
  targetPath: z.string().min(1).optional(),
  sessionStorageMode: z.enum(['direct', 'persisted']).optional(),
  targetSessionStorageMode: z.enum(['direct', 'persisted']).optional(),
  preferredTransportStrategies: z.array(z.enum(['direct_peer', 'server_routed_stream'])).max(2).optional(),
  workspaceAction: HandoffWorkspaceActionV1Schema.optional(),
  accountServerId: z.string().min(1).optional(),
  actionRequestId: z.string().min(1).max(2_000).optional(),
  handoffTargetReplacementApproval: HandoffTargetReplacementApprovalV1Schema.optional(),
  handoffTargetReplacementApprovalReceiptId: z.string().min(1).max(2_000).optional(),
  handoffTargetReplacementApprovalActionInput: z.unknown().optional(),
}).strict());

const SessionHandoffPublicInputSchema = lazyZodSchema(() => SessionHandoffInputSchema.omit({
  sourceMachineId: true,
  sessionStorageMode: true,
  preferredTransportStrategies: true,
  accountServerId: true,
  actionRequestId: true,
  handoffTargetReplacementApproval: true,
  handoffTargetReplacementApprovalReceiptId: true,
  handoffTargetReplacementApprovalActionInput: true,
}).strict());

const SessionSpawnNewInputSchema = SessionSpawnNewInputV2Schema;
const SessionSpawnNewApiInputSchema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.omit({
  executionTarget: true,
}).strict().superRefine(refineSessionDirectoryIntentCheckoutV1));
const SessionSpawnNewInputHints = {
  title: 'Create a new session',
  fields: [
    { path: 'creationKey', title: 'Creation key', widget: 'text' },
    { path: 'executionTarget.serverId', title: 'Server id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.servers.available' },
    { path: 'executionTarget.machineId', title: 'Machine id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.machines.available' },
    { path: 'directory', title: 'Directory intent', widget: 'json', required: true, optionsSourceId: 'sessions.spawn.paths.recent' },
    { path: 'organizationPlacement', title: 'Organization placement', widget: 'json' },
    { path: 'agentTarget', title: 'Agent target', widget: 'json', required: true, optionsSourceId: 'agents.backends.enabled' },
    { path: 'modelSelection', title: 'Model selection', widget: 'json', optionsSourceId: 'agents.models.available' },
    { path: 'title', title: 'Title', widget: 'text' },
    { path: 'permissionMode', title: 'Permission mode', widget: 'text' },
    { path: 'agentModeId', title: 'Agent mode', widget: 'text', optionsSourceId: 'agents.session_modes.available' },
    { path: 'configuration', title: 'Configuration', widget: 'json', optionsSourceId: 'agents.config_options.available' },
    { path: 'profileId', title: 'Profile id', widget: 'text', optionsSourceId: 'sessions.spawn.profiles.available' },
    { path: 'connectedServices', title: 'Connected services', widget: 'json', optionsSourceId: 'sessions.spawn.connected_services.available' },
    { path: 'mcpSelection', title: 'MCP selection', widget: 'json', optionsSourceId: 'sessions.spawn.mcp_servers.preview' },
    { path: 'transcriptStorage', title: 'Transcript storage', widget: 'text' },
    { path: 'terminal', title: 'Terminal', widget: 'json' },
    { path: 'checkoutCreationDraft', title: 'Checkout creation', widget: 'json' },
    { path: 'initialInput.text', title: 'Initial message', widget: 'textarea' },
    { path: 'initialInput.attachments', title: 'Initial attachments', widget: 'json' },
    { path: 'agentSessionStartupInstructionsV1', title: 'Startup instructions', widget: 'json' },
  ],
} satisfies ActionInputHints;
const SessionSpawnNewApiInputHints = {
  ...SessionSpawnNewInputHints,
  fields: SessionSpawnNewInputHints.fields.filter((field) => (
    field.path !== 'executionTarget.serverId' && field.path !== 'executionTarget.machineId'
  )),
} satisfies ActionInputHints;

/**
 * The sole canonical-to-public projection for a Session creation request that
 * was already admitted on a local Action surface. Execution placement remains
 * transport metadata: the public input cannot carry it, while the selected
 * machine reaches the API envelope as its exact target.
 */
export function projectSessionSpawnNewApiRequest(
  value: unknown,
): Readonly<{
  input: z.input<typeof SessionSpawnNewApiInputSchema>;
  target: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
}> {
  const canonicalInput = SessionSpawnNewInputV2Schema.parse(value);
  const { executionTarget, ...apiInput } = canonicalInput;
  return {
    input: SessionSpawnNewApiInputSchema.parse(apiInput),
    target: {
      kind: 'machine',
      machineId: executionTarget.machineId,
    },
  };
}

// Action invocations may derive a key from their durable request identity, but
// RPC retries have no such identity. The transport therefore requires the
// caller's one logical creation key rather than synthesizing one per attempt.
const SessionSpawnNewRpcInputSchema = lazyZodSchema(() => SessionSpawnNewInputV2Schema.safeExtend({
  creationKey: SessionCreationKeyV1Schema,
}));

function bindApiSessionSpawnNewInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const input = SessionSpawnNewApiInputSchema.parse(value);
  const serverId = context.serverId;
  const target = context.externalActionTarget;
  if (
    context.caller.kind !== 'host'
    || typeof serverId !== 'string'
    || serverId.trim().length === 0
    || target?.kind !== 'machine'
  ) {
    throw new Error('API session spawn requires a host-stamped machine target and server id');
  }

  return {
    ...input,
    executionTarget: {
      serverId,
      machineId: target.machineId,
    },
  };
}

function validateAgentIdAndBackendTargetKeySelection(
  value: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    backendTarget?: z.infer<typeof BackendTargetRefV2Schema>;
    runtimeDescriptorV1?: z.infer<typeof RuntimeDescriptorV1Schema>;
  }>,
  ctx: z.RefinementCtx,
): void {
  const resolved = resolveActionBackendTargetSelection(value);
  if (!resolved.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: resolved.message,
      path: [resolved.path],
    });
  }
}

function validateStringAliasPair(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  params: Readonly<{ primary: string; alias: string }>,
): void {
  const primaryValue = value[params.primary];
  const aliasValue = value[params.alias];
  if (typeof primaryValue !== 'string' || typeof aliasValue !== 'string') return;
  if (primaryValue.trim() === aliasValue.trim()) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${params.primary} and ${params.alias} must match when both are provided`,
    path: [params.alias],
  });
}

const PathsListRecentInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).passthrough());

/**
 * The persisted project registry read.
 *
 * It narrows by machine and count only. It deliberately does NOT filter by
 * hosting provider or repository name: matching a repository to a checkout is
 * one decision with one owner, and a filter here would make this a second place
 * that rule lives — silently disagreeing with the caller's own matcher the day
 * either one changes. The registry is a bounded local read, so the caller
 * receives it and decides.
 */
const ProjectsListInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough());

/**
 * The Prompt Library invocation inventory read.
 *
 * It returns the invocation entries themselves — stable `id`, user-facing
 * `token`, title, behavior — and never a prompt body: an inventory that
 * expanded every referenced document would fetch every artifact in the Library
 * to answer "which prompts exist".
 */
const PromptInvocationsListInputSchema = lazyZodSchema(() => z.object({
  limit: z.number().int().min(1).max(500).optional(),
}).passthrough());

/**
 * Resolve ONE Prompt Library invocation to the text it produces.
 *
 * `invocationId` is the entry's stable id, never the renameable slash token:
 * renaming a command must not break a stored reference to it. Rendering the
 * body is the Library's own job, so this is a projection of the incumbent
 * expansion owner rather than a second template renderer.
 */
const PromptInvocationResolveInputSchema = lazyZodSchema(() => z.object({
  invocationId: z.string().min(1),
  argsText: z.string().optional(),
}).passthrough());

const MachinesListInputSchema = lazyZodSchema(() => z.object({
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough());

/**
 * The friendly `happier machines list` bound has always been the whole page. It
 * is a caller default, not an Action default: another surface may page.
 */
const MACHINES_LIST_CLI_DEFAULT_LIMIT = 200;
const MachinesListCliInputSchema = lazyZodSchema(() => z.object({
  limit: z.number().int().min(1).max(MACHINES_LIST_CLI_DEFAULT_LIMIT).optional(),
}).strict());

const ServersListInputSchema = lazyZodSchema(() => z.object({
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough());

const ReviewEnginesListInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  includeDisabled: z.boolean().optional(),
  scope: z.literal('paths').optional(),
}).passthrough());

/**
 * `machineId` scopes the answer to the installed/external Agents one machine's
 * daemon projection admits. The executor forwards it to the host inventory
 * owner, so it is part of this canonical contract rather than passthrough
 * residue: an input the schema does not name is a contract the schema lies
 * about.
 */
const AgentsBackendsListInputSchema = lazyZodSchema(() => z.object({
  includeDisabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  machineId: z.string().min(1).optional(),
}).passthrough());

const AgentsModelsListInputSchema = lazyZodSchema(() => z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  machineId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
}));

const AgentSpawnOptionsListInputBaseSchema = lazyZodSchema(() => z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}));

const AgentSpawnOptionsListInputSchema = lazyZodSchema(() => AgentSpawnOptionsListInputBaseSchema.extend({
  serverId: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
}));

/**
 * `sessions.spawn.profiles.list` is the one spawn-option source whose agent
 * scope is a FILTER, not a requirement.
 *
 * Models, config options and session modes cannot be enumerated without knowing
 * whose they are, so the shared schema demands an agent. A Launch Profile is the
 * other way round: `LaunchProfileListItemV1.supportedAgentIds` rides every row,
 * so an unscoped list loses no information, and a caller that selects a profile
 * FIRST — a Triage action does exactly that, and the profile then supplies the
 * agent — has no agent to scope by. Requiring one made that read fail input
 * validation, which the caller could only observe as "the catalog did not
 * answer": the selector stayed empty and every profile-configured press refused
 * forever.
 *
 * A contradictory pair is still refused, because half an agent scope is not a
 * weaker filter.
 */
const SpawnProfilesListInputSchema = lazyZodSchema(() => AgentSpawnOptionsListInputBaseSchema
  .passthrough()
  .superRefine((value, ctx) => {
    validateAgentIdAndBackendTargetKeySelection(value, ctx);
  }));

const AgentsConfigOptionsListInputSchema = lazyZodSchema(() => AgentSpawnOptionsListInputBaseSchema.extend({
  modelId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
}));

const SpawnConnectedServicesListInputSchema = lazyZodSchema(() => AgentSpawnOptionsListInputBaseSchema.extend({
  includeUnavailable: z.boolean().optional(),
  serverId: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
}));

const SpawnMcpServersPreviewInputSchema = lazyZodSchema(() => z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  machineId: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  selection: SessionMcpSelectionV1Schema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
}));

const ActionSpecSearchInputSchema = lazyZodSchema(() => z.object({
  query: z.string().trim().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough());

const ActionSpecSearchCliInputSchema = lazyZodSchema(() => z.object({
  query: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(100).optional(),
}).strict());

const ActionSpecGetInputSchema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
}).passthrough());

const ActionSpecSearchResultSchema = lazyZodSchema(() => z.object({
  actionSpecs: z.array(ActionDiscoveryDefinitionSummaryV1Schema),
}).strict());

const ActionSpecGetResultSchema = lazyZodSchema(() => z.object({
  actionSpec: ActionDiscoveryDefinitionV1Schema,
}).strict());

const ActionOptionsResolveInputSchema = lazyZodSchema(() => z.object({
  actionId: z.string().min(1).optional(),
  fieldPath: z.string().min(1).optional(),
  consumer: InputOptionsConsumerV1Schema.optional(),
  optionsSourceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().optional(),
  draftInput: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((value, ctx) => {
  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  const fieldPath = typeof value.fieldPath === 'string' ? value.fieldPath.trim() : '';
  const optionsSourceId = typeof value.optionsSourceId === 'string' ? value.optionsSourceId.trim() : '';
  if (!optionsSourceId && !(actionId && fieldPath) && !(value.consumer && fieldPath)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'actionId + fieldPath or optionsSourceId is required',
      path: ['actionId'],
    });
  }
}));

const ActionOptionsResolveResultSchema = lazyZodSchema(() => z.object({
  actionId: z.string().min(1).nullable(),
  fieldPath: z.string().min(1).nullable(),
  optionsSourceId: z.string().min(1).nullable(),
  options: z.array(ActionInputOptionSchema).max(256).readonly(),
  modelCatalog: z.object({
    nativeModels: z.array(z.object({
      value: z.string().min(1),
      label: ActionInputOptionSchema.shape.label,
      description: ActionInputOptionSchema.shape.description,
    }).strict()).readonly(),
    providerProjection: DaemonProviderModelProjectionResponseV1Schema.options[0].nullable(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.modelCatalog !== undefined
    && (value.actionId !== 'session.spawn_new' || value.fieldPath !== 'modelSelection')) {
    ctx.addIssue({ code: 'custom', path: ['modelCatalog'], message: 'Model catalog belongs to Session spawn model selection' });
  }
}));

/** Current-UI semantic payloads stay behind the ephemeral opaque command handle. */
const CurrentUiContextCommandInvokeInputSchema = lazyZodSchema(() => z.object({
  commandId: z.string().trim().min(1),
}).strict());

const SessionSendUserTextInputFieldsSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  recipient: PluginSessionUserTextAuthoredFieldSchemasV1.recipient,
  // The executor re-admits a plugin-bound input through this canonical shape
  // before dispatch. Keep the content rule here too: attachment-only is valid,
  // while the executor still rejects authored attachments from non-plugin
  // callers before the writer.
  message: z.string(),
  requestedAction: PendingRequestedActionV1Schema.optional(),
  /**
   * The caller-retained stable identity for this durable input. Resubmitting
   * the same localId rejoins the existing pending input instead of queueing a
   * second message, so an ambiguous send can be retried safely. Plugin callers
   * cannot supply it: their identity is host-derived from `idempotencyKey`.
   */
  localId: PendingLocalIdSchema.optional(),
  idempotencyKey: PluginSessionUserTextAuthoredFieldSchemasV1.idempotencyKey.optional(),
  source: PluginSessionUserTextAuthoredFieldSchemasV1.source,
  attachments: PluginSessionUserTextAuthoredFieldSchemasV1.attachments,
  toolAnswerDelivery: PluginSessionUserTextAuthoredFieldSchemasV1.toolAnswerDelivery,
  permissionModeOverride: z.string().trim().min(1).optional(),
  modelOverride: z.union([z.string().trim().min(1), z.null()]).optional(),
  providerConnectionId: ProviderConnectionIdSchema.nullable().optional(),
  wait: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).strict());

function validateSessionSendProviderSelection(
  value: z.infer<typeof SessionSendUserTextInputFieldsSchema>,
  ctx: z.RefinementCtx,
): void {
  if (value.providerConnectionId === undefined) return;
  // A Provider connection is only ever applied together with the model
  // selection it sources. Without a `modelOverride` the send path composes no
  // selection at all, so the connection — including the explicit native `null`
  // — would be accepted and then silently discarded.
  if (value.modelOverride === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelOverride'],
      message: 'modelOverride must be provided when providerConnectionId is set',
    });
    return;
  }
  if (value.providerConnectionId !== null && typeof value.modelOverride !== 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelOverride'],
      message: 'modelOverride must be a concrete model id when providerConnectionId is set',
    });
  }
}

const SessionSendUserTextInputSchema = lazyZodSchema(() => SessionSendUserTextInputFieldsSchema
  .superRefine(requireSessionInputContent).superRefine(validateSessionSendProviderSelection));

// Public callers author text and routing intent, never plugin source or attachment authority.
const SessionSendMessagePublicInputSchema = lazyZodSchema(() => SessionSendUserTextInputFieldsSchema
  .omit({ idempotencyKey: true, source: true, attachments: true, toolAnswerDelivery: true })
  .superRefine(requireSessionInputContent)
  .superRefine(validateSessionSendProviderSelection));

/** Plugin Session messages carry only host-attributed admission intent. */
const SessionSendUserTextPluginInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  // Blank only when an attachment carries the input, decided by the one
  // `requireSessionInputContent` owner this binding shares with
  // `PluginSessionInputRequestV1Schema`. A `.min(1)` here would let the Action
  // surface refuse an attachment-only input the seam beneath it admits.
  message: z.string(),
  ...PluginSessionUserTextAuthoredFieldSchemasV1,
}).strict().superRefine(requireSessionInputContent));

const SessionSendSubagentLaunchPluginInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  kind: z.literal('sessionSubagentLaunch'),
  launch: SubagentLaunchV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}).strict());

const SessionSendMessagePluginInputV1Schema = lazyZodSchema(() => z.union([
  SessionSendUserTextPluginInputV1Schema,
  SessionSendSubagentLaunchPluginInputV1Schema,
]));

const SessionSendMessageInputSchema = lazyZodSchema(() => z.union([
  SessionSendUserTextInputSchema,
  SessionSendSubagentLaunchPluginInputV1Schema,
]));

const SessionPermissionRespondInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  decision: SessionPermissionRespondActionDecisionV1Schema,
  requestId: z.string().min(1).optional(),
  // Optional only at the released action compatibility boundary. Current UI
  // producers stamp it and current host requests require an exact match.
  turnId: z.string().trim().min(1).optional(),
  reason: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.reason,
  mode: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.mode,
  allowedTools: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.allowedTools,
  execPolicyAmendment: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.execPolicyAmendment,
  updatedPermissions: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.updatedPermissions,
  answers: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.answers,
}).passthrough());

const SessionUserActionAnswerItemSchema = lazyZodSchema(() => z.object({
  question: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'question must not be blank',
  }),
  values: z.array(z.string()).min(1).optional(),
  // Compatibility for clients through the released 0.2.2 preview. Remove `answer`
  // after that preview leaves the supported mixed-version window.
  answer: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.answer !== undefined && value.values !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer and values cannot both be provided' });
  }
  if (value.answer === undefined && value.values === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer or values is required' });
  }
}));

function validateSessionUserActionAnswer(
  value: Readonly<{
    decision?: 'approve' | 'reject' | 'request_changes';
    reason?: string;
    answers?: readonly Readonly<{
      question: string;
      values?: readonly string[];
      answer?: string;
    }>[];
  }>,
  ctx: z.RefinementCtx,
): void {
  const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
  const structuredAnswers = Object.create(null) as Record<string, readonly string[]>;
  for (const [index, entry] of (value.answers ?? []).entries()) {
    if (Object.prototype.hasOwnProperty.call(structuredAnswers, entry.question)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate question',
        path: ['answers', index, 'question'],
      });
      continue;
    }
    structuredAnswers[entry.question] = entry.values ?? [entry.answer!];
  }
  if (hasAnswers && !StructuredQuestionAnswersV1Schema.safeParse(structuredAnswers).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid structured answers',
      path: ['answers'],
    });
  }
  if (!hasAnswers && value.decision === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'decision or answers is required',
      path: ['decision'],
    });
  }
  if (value.decision === 'request_changes'
    && !(typeof value.reason === 'string' && value.reason.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reason is required when decision=request_changes',
      path: ['reason'],
    });
  }
}

const SessionUserActionAnswerInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
  reason: z.string().trim().min(1).optional(),
  answers: z.array(SessionUserActionAnswerItemSchema).min(1).optional(),
  updatedPermissions: StrictJsonValueSchema.optional(),
}).passthrough().superRefine(validateSessionUserActionAnswer));

const SessionUserActionAnswerPluginInputSchema = lazyZodSchema(() => z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
  reason: z.string().trim().min(1).optional(),
  answers: z.array(SessionUserActionAnswerItemSchema).min(1).optional(),
}).strict().superRefine(validateSessionUserActionAnswer));

const SessionInteractionResponseSuccessSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
}).strict());

const SessionModeSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  modeId: z.string().min(1),
}).passthrough());

const SessionPrimaryTargetInputSchema = lazyZodSchema(() => z.union([
  VoiceTrackedSessionAddressV1Schema,
  z.object({ sessionId: z.null() }).strict(),
]));

// Uncapped like the canonical Account Voice replace API it forwards to: a
// complete exact-Home replacement must reach the Follow owner and settle.
const SessionTrackedTargetsInputSchema = lazyZodSchema(() => z.union([
  z.object({
    sessionAddresses: z.array(VoiceTrackedSessionAddressV1Schema),
  }).strict(),
  // Released 0.2 clients sent Home-local ids. Keep this as an input-only
  // compatibility arm; the executing client must qualify them before mutation.
  z.object({
    sessionIds: z.array(z.string().trim().min(1)),
  }).strict(),
]));

/**
 * The one typed `session.list` caller contract. Exported so the Action executor parses the
 * admitted input through this owner instead of casting an untyped record into the listing
 * dependency's `SessionListQueryV1` parameter.
 */
export const SessionListActionInputV1Schema = lazyZodSchema(() => z.object({
  query: z.lazy(() => SessionListQueryV1Schema).optional(),
  underSessionId: z.string().trim().min(1).optional(),
  view: SessionListViewV1Schema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeLastMessagePreview: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  archivedOnly: z.boolean().optional(),
  includeSystem: z.boolean().optional(),
  resumableOnly: z.boolean().optional(),
  includeRows: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.query !== undefined) {
    for (const field of ['underSessionId', 'limit', 'cursor', 'activeOnly', 'archivedOnly', 'resumableOnly'] as const) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} cannot be combined with query` });
      }
    }
  }
  if (value.view === 'awareness' && Object.prototype.hasOwnProperty.call(value, 'includeLastMessagePreview')) {
    ctx.addIssue({ code: 'custom', path: ['includeLastMessagePreview'], message: 'Awareness does not include message previews' });
  }
}));

/**
 * The compatibility activity read shares `session.list`'s representation selector so Voice, agent,
 * MCP, UI and trusted plugin callers can ask this stable Action ID for canonical awareness instead
 * of reconstructing it. Omission keeps the released digest.
 */
const SessionActivityInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  view: SessionListViewV1Schema.optional(),
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.view === SESSION_LIST_AWARENESS_VIEW_V1 && value.windowSeconds !== undefined) {
    // `windowSeconds` only narrows the released retained-window message counts, and awareness has
    // no counts. Accepting both would silently ignore the window the caller asked for.
    ctx.addIssue({
      code: 'custom',
      path: ['windowSeconds'],
      message: 'Awareness does not include retained-window message counts',
    });
  }
}));

const SessionRecentMessagesInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeUser: z.boolean().optional(),
  includeAssistant: z.boolean().optional(),
  maxCharsPerMessage: z.number().int().min(0).max(50_000).nullable().optional(),
}).passthrough());

const SessionLogTailInputSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  offset: z.number().int().min(0).optional(),
}).passthrough());

const TranscriptPageInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  cursor: z.string().min(1).nullable().optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough());

const TranscriptReadAfterInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  cursor: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough());

const TranscriptFollowInputSchema = lazyZodSchema(() => TranscriptReadAfterInputSchema.extend({
  waitForChanges: z.boolean().optional(),
  leaseId: z.string().min(1).optional(),
  idleTtlMs: z.number().int().min(1).max(3_600_000).optional(),
  projection: z.literal('openedMessagesV1').optional(),
  agentStateVersion: z.number().int().min(-1).optional(),
  sharedMetadataVersion: z.number().int().min(-1).optional(),
}).strict());

const TranscriptUnfollowInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  leaseId: z.string().min(1),
}).strict());

const TranscriptImportInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  importId: z.string().trim().min(1).optional(),
  items: z.array(StrictJsonValueSchema).min(1).max(500),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough());

const TranscriptSearchInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().trim().min(1),
  cursor: z.string().min(1).optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  maxReads: z.number().int().min(1).max(50).optional(),
}).passthrough());

const TranscriptPageOutputSchema = lazyZodSchema(() => z.object({
  ok: z.boolean().optional(),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean().optional(),
  tailCursor: z.string().nullable().optional(),
  truncated: z.boolean(),
}).passthrough());

const TranscriptReadAfterOutputSchema = lazyZodSchema(() => z.object({
  ok: z.boolean().optional(),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
}).passthrough());

/** Closed authoritative version envelope; the opened Agent-native JSON is opaque preserved content. */
export const TranscriptOpenedAgentStateV1Schema = lazyZodSchema(() => z.object({
  version: z.number().int().min(0),
  value: z.record(z.string(), StrictJsonValueSchema).nullable(),
}).strict());
export type TranscriptOpenedAgentStateV1 = z.infer<typeof TranscriptOpenedAgentStateV1Schema>;

/** Only the canonical recipient-safe metadata envelope may cross this opened read. */
export const TranscriptOpenedSharedMetadataV1Schema = lazyZodSchema(() => z.object({
  version: z.number().int().min(0),
  value: SessionSharedMetadataV1Schema,
}).strict());
export type TranscriptOpenedSharedMetadataV1 = z.infer<typeof TranscriptOpenedSharedMetadataV1Schema>;

// Reuse the canonical row projection. Only its stored-content arm changes for this daemon-opened read.
const TranscriptOpenedMessageV1Schema = lazyZodSchema(() => z.union([
  SessionMessageV1Schema.extend({
    content: StrictSessionStoredMessageContentEnvelopeSchema.options[1].extend({
      v: z.record(z.string(), StrictJsonValueSchema),
    }),
    openFailure: z.never().optional(),
  }),
  SessionMessageV1Schema.extend({
    content: z.object({ t: z.literal('plain'), v: z.null() }).strict(),
    openFailure: z.enum(['mode_mismatch', 'corrupt_or_unopenable']),
  }),
]));

/** Closed follow/cursor envelope; its canonical rows drop unknown presentation fields. */
export const TranscriptFollowChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('append') }).strict(),
  z.object({ kind: z.literal('revision'), messageId: z.string().min(1), seq: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal('session') }).strict(),
  z.object({ kind: z.literal('reset') }).strict(),
]));
export type TranscriptFollowChangeV1 = z.infer<typeof TranscriptFollowChangeV1Schema>;

export const TranscriptOpenedFollowOutputV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  leaseId: z.string().min(1),
  projection: z.literal('openedMessagesV1'),
  items: z.array(TranscriptOpenedMessageV1Schema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  agentState: TranscriptOpenedAgentStateV1Schema.nullable(),
  sharedMetadata: TranscriptOpenedSharedMetadataV1Schema.nullable(),
  changes: z.array(TranscriptFollowChangeV1Schema).optional(),
}).strict());
export type TranscriptOpenedFollowOutputV1 = z.infer<typeof TranscriptOpenedFollowOutputV1Schema>;

const TranscriptFollowOutputSchema = lazyZodSchema(() => z.union([TranscriptReadAfterOutputSchema.extend({
  changes: z.array(TranscriptFollowChangeV1Schema).optional(),
  leaseId: z.string().min(1).optional(),
  projection: z.never().optional(),
}).passthrough(), TranscriptOpenedFollowOutputV1Schema]));

const TranscriptUnfollowOutputSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  released: z.boolean(),
}).strict());

const TranscriptImportOutputSchema = lazyZodSchema(() => z.object({
  ok: z.boolean(),
  imported: z.number().int().min(0).optional(),
  cursor: z.string().nullable().optional(),
}).passthrough());

const SessionLogTailOutputSchema = lazyZodSchema(() => z.object({
  success: z.boolean().optional(),
  ok: z.boolean().optional(),
  path: z.string().optional(),
  tail: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough());

const SubagentListInputSchema = lazyZodSchema(() => z.object({
  parentSessionId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough());

const SubagentGetInputSchema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1).optional(),
}).passthrough());

const SubagentWatchInputSchema = lazyZodSchema(() => z.object({
  parentSessionId: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
}).passthrough());

const SubagentStatusUpdateInputSchema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  status: SubagentStatusV1Schema,
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).passthrough());

const SubagentCompleteInputSchema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  status: z.enum(['completed', 'failed', 'aborted']).optional(),
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).passthrough());

const SubagentWatchSnapshotOutputSchema = lazyZodSchema(() => z.object({
  kind: z.literal('snapshot'),
  subagents: z.array(SubagentRefV1Schema),
}).passthrough());

const MemorySearchInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1),
  query: MemorySearchQueryV1Schema,
}).passthrough());

const MemoryGetWindowInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
}));

const MemoryEnsureUpToDateInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).passthrough());

const MemoryEnsureUpToDateOutputSchema = lazyZodSchema(() => z.object({
  ok: z.boolean(),
}).passthrough());

const ApprovalRequestCreateInputSchema = lazyZodSchema(() => z.object({
  actionId: ActionIdSchema,
  actionArgs: StrictJsonValueSchema,
  summary: z.string().min(1),
  createdBy: ApprovalRequestCreatedBySchema,
  origin: ApprovalRequestOriginV1Schema.optional(),
  preview: StrictJsonValueSchema.optional(),
}).passthrough());

/**
 * A trusted plugin may ask the present user to approve an Action it could have
 * invoked itself; it may not borrow the approval queue to reach a host-internal
 * Action the Plugin census excludes. The census set is built from these same
 * rows, so this arm resolves lazily instead of duplicating the exclusion list.
 */
const PluginSurfaceApprovalRequestCreateInputSchema = lazyZodSchema(() => ApprovalRequestCreateInputSchema.extend({
  actionId: z.lazy(() => PluginInvocableActionIdSchema),
}));

const ApprovalRequestListInputSchema = lazyZodSchema(() => z.object({
  status: ApprovalRequestV2StatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough());

const ApprovalRequestGetInputSchema = lazyZodSchema(() => z.object({
  artifactId: z.string().min(1),
}).passthrough());

const ApprovalRequestDecideInputSchema = lazyZodSchema(() => z.object({
  artifactId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  /** Human picker choice for an open computer.target.select request; never caller authority. */
  computerTarget: ComputerTargetV1Schema.optional(),
  computerAccess: ComputerAccessV1Schema.optional(),
  /** Immutable creator-local id from the persisted V2 origin; never a route selector. */
  originServerId: z.string().min(1).optional(),
  /** Stable Home identity selected by the current device before exact-daemon routing. */
  serverIdentityId: z.string().min(1).optional(),
}).passthrough());

const PromptDocUpdateInputSchema = lazyZodSchema(() => z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  markdown: z.string(),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).passthrough());

const PromptBundleUpdateInputSchema = lazyZodSchema(() => z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  skillMarkdown: z.string(),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).passthrough());

const PromptAssetExportInputSchema = lazyZodSchema(() => z.object({
  artifactId: z.string().min(1),
  machineId: z.string().min(1),
  assetTypeId: z.string().min(1),
  scope: PromptAssetScopeV1Schema,
  directory: z.string().min(1).optional(),
  targetPath: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
  installMode: PromptAssetInstallModeV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasDocTarget = typeof value.targetPath === 'string' && value.targetPath.trim().length > 0;
  const hasBundleTarget = typeof value.targetName === 'string' && value.targetName.trim().length > 0;
  if (!hasDocTarget && !hasBundleTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetPath or targetName is required',
      path: ['targetPath'],
    });
  }
}));

const PromptRegistryInstallInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1),
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
  installTarget: z.object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).optional(),
    targetName: z.string().min(1),
    installMode: PromptAssetInstallModeV1Schema.optional(),
  }).optional(),
}).passthrough());

const ExternalSessionTakeoverActionInputSchema = ExternalSessionTakeoverInputV1Schema;

const APPROVAL_RESULT_REQUIRED: ActionApproval = Object.freeze({ result: 'required' });
const APPROVAL_RESULT_REQUIRED_DEFERRED: ActionApproval = Object.freeze({ result: 'required', flow: 'deferred' });
const APPROVAL_RESULT_NONE: ActionApproval = Object.freeze({ result: 'none' });
const APPROVAL_RESULT_NONE_DEFERRED: ActionApproval = Object.freeze({ result: 'none', flow: 'deferred' });
const APPROVAL_RESULT_OPTIONAL_DEFERRED: ActionApproval = Object.freeze({ result: 'optional', flow: 'deferred' });

// TeamSection owns deferred approval presentation for these exact ordinary
// mutation results and refreshes the exact Team after replay. Keep this list
// explicit: danger is the confirmation default, not proof that a result can be
// replaced by an approval artifact. Identity test/Portal Actions, invitation
// bearer delivery, and credential test/key creation return non-refreshable
// results or one-time material, so they deliberately stay blocking/result-required
// even though they are dangerous.
const TEAM_DEFERRED_APPROVAL_REPLAY_SAFE_ACTION_IDS = [
  'teams.credentials.create',
  'teams.credentials.update',
  'teams.credentials.audience.set',
  'teams.credentials.delete',
  'teams.credentials.limits.upsert',
  'teams.credentials.limits.delete',
  'teams.credentials.externalKeys.revoke',
  'teams.credentials.externalKeys.revokeAll',
  'teams.policy.set',
  'teams.archive',
  'teams.restore',
  'teams.members.add',
  'teams.members.role.set',
  'teams.members.suspend',
  'teams.members.reactivate',
  'teams.members.remove',
  'teams.members.management.set',
  'teams.groups.archive',
  'teams.groups.restore',
  'teams.groups.members.add',
  'teams.groups.members.remove',
  'teams.invitations.revoke',
  'teams.invitations.accept',
  'teams.identity.connections.enable',
  'teams.identity.connections.disable',
  'teams.identity.connections.remove',
  'teams.externalGroupBindings.set',
  'teams.externalGroupBindings.remove',
  'teams.directory.sources.create',
  'teams.directory.sources.sync',
  'teams.directory.sources.pause',
  'teams.directory.sources.resume',
  'teams.directory.sources.remove',
] as const satisfies readonly TeamActionIdV1[];
const TEAM_DEFERRED_APPROVAL_REPLAY_SAFE_ACTION_ID_SET = new Set<ActionId>(
  TEAM_DEFERRED_APPROVAL_REPLAY_SAFE_ACTION_IDS,
);

const WORKFLOW_READ_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.validate', 'workflow.run.list', 'workflow.run.summaries', 'workflow.run.get', 'workflow.run.wait',
  'workflow.run.invocations.list', 'workflow.run.invocations.get',
  'workflow.definition.list', 'workflow.definition.get',
  'workflow.trigger.list',
  'session.trigger.list',
]);
const WORKFLOW_MUTATION_ACTION_IDS = WORKFLOW_ACTION_IDS_V1.filter(
  (actionId) => !WORKFLOW_READ_ACTION_IDS.has(actionId),
);

const RESULT_NONE_DEFERRED_APPROVAL_ACTION_IDS = [
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
] as const satisfies readonly ActionId[];

const RESULT_REQUIRED_DEFERRED_APPROVAL_ACTION_IDS = [
  ...TEAM_DEFERRED_APPROVAL_REPLAY_SAFE_ACTION_IDS,
  // The Team settings shell refreshes the exact Team after replay and therefore
  // has a real result consumer. Deferred metadata lets its UI receive and show
  // the approval artifact instead of waiting without an approval presenter.
  'teams.update',
  'workspace.sync.conflict.resolve',
  ...SHARED_SAVED_SECRET_ACTION_SPECS
    .filter((spec) => spec.id !== 'secrets.shared.list')
    .map((spec) => spec.id),
] as const satisfies readonly ActionId[];

const RESULT_REQUIRED_APPROVAL_ACTION_IDS = [
  ...VOICE_CONVERSATION_ACTION_IDS,
  ...ACTION_ID_FAMILIES_V1.composer_ingress,
  ...ACTION_ID_FAMILIES_V1.workflow_authoring,
  ...ACTION_ID_FAMILIES_V1.list_reorder,
  ...ACTION_ID_FAMILIES_V1.todo_session_link,
  ...ACTION_ID_FAMILIES_V1.session_organization_move,
  ...NOTIFICATION_CONFIGURATION_ACTION_IDS,
  ...APP_UPDATE_ACTION_IDS,
  'capture.view',
  ...ACTION_ID_FAMILIES_V1.session_terminals,
  ...ACTION_ID_FAMILIES_V1.workspace_layout,
  ...APP_SHELL_ACTION_IDS,
  ...ACTION_ID_FAMILIES_V1.connected_services_configuration,
  ...ACTION_ID_FAMILIES_V1.home_hub_layout,
  ...ACTION_ID_FAMILIES_V1.scope,
  ...SETTINGS_DECLARATION_ACTION_IDS_V1,
  ...WORK_BOARD_ACTION_IDS_V1,
  ...ACTION_ID_FAMILIES_V1.widgets,
  // Native observations and input outcomes must return to the invoking Session after consent.
  ...ACTION_ID_FAMILIES_V1.computer,
  ...ARTIFACT_ACCESS_ACTION_IDS_V1,
  ...ARTIFACT_ACTION_IDS_V1,
  // Sharing's continuation needs the published Artifact id, including after approval replay.
  ...ACTION_ID_FAMILIES_V1.launch_profiles,
  ...ACTION_ID_FAMILIES_V1.notifications,
  ...ACTION_ID_FAMILIES_V1.machine_agent_install,
  ...ACTION_ID_FAMILIES_V1.machine_connection,
  ...ACTION_ID_FAMILIES_V1.scm_git,
  ...ROLE_ACTION_IDS_V1,
  ...MANAGED_GITHUB_APP_ACTION_IDS_V1,
  // An agent saving or removing a custom ACP agent waits for the decision and reads the stored
  // definition (or the catalog owner's typed refusal) back.
  ...ACTION_ID_FAMILIES_V1.agent_acp_catalog,
  ...WORKFLOW_READ_ACTION_IDS,
  'machines.pools.list',
  'machines.pools.get',
  'machines.pools.resolve',
  'sessions.runner.activation.get',
  'session.follow.get',
  'session.follow.preferences.get',
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'action.invoke',
  'ui.current_context.read',
  'ui.current_context.command.invoke',
  'ui.command_palette.list',
  'ui.command_palette.invoke',
  'ui.find',
  'ui.prompts.picker.open',
  'session.pending.next',
  'account.plugins.data.erase',
  'account.sessions.signOutEverywhere',
  ...ACTION_ID_FAMILIES_V1.account_security,
  'account.apiTokens.create',
  'account.apiTokens.update',
  'account.apiTokens.list',
  'account.apiTokens.revoke',
  'account.apiTokens.revokeAll',
  'sessions.subagents.list',
  'sessions.subagents.get',
  'sessions.subagents.watch',
  'execution.run.list',
  'execution.run.get',
  'execution.run.stream.read',
  'execution.run.wait',
  'wait',
  'session.handoff.prepare_target_result.get',
  'session.handoff.status.get',
  'workspace.sync.relationships.list',
  'workspace.sync.conflicts.list',
  'workspace.sync.conflict.inspect',
  'paths.list_recent',
  'projects.list',
  'prompt_doc.get',
  'prompts.library.list',
  'prompts.invocations.list',
  'prompts.invocation.resolve',
  'machines.list',
  'servers.list',
  'review.engines.list',
  'agents.backends.list',
  'machines.agents.list',
  'workspace.files.search',
  'agents.models.list',
  'agents.config_options.list',
  'agents.session_modes.list',
  'sessions.spawn.profiles.list',
  'sessions.spawn.connected_services.list',
  'sessions.spawn.mcp_servers.preview',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  // The current-viewer command has no durable Board effect, but its caller
  // must consume the typed applied/unavailable acknowledgement before it can
  // report settlement. Human-confirmation policy remains independently
  // resolved by the shared Action settings owner.
  'session.presentation.apply',
  'session.worker.publish',
  // Catalog reads answer synchronously with the resource rows the caller renders.
  // Mutations are classified from the source-owned danger rows above so their
  // revision-bearing results survive the shared deferred approval lifecycle.
  'secrets.shared.list',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  // A Board read answers its caller directly; it never becomes an approval artifact.
  'session.board.get',
  // Discussion reads likewise answer their caller directly.
  'session.discussion.list',
  'session.discussion.get',
  'session.discussion.read',
  'session.list',
  'session.activity.get',
  'session.messages.recent.get',
  'memory.search',
  'memory.get_window',
  'memory.ensure_up_to_date',
  'daemon.promptAssets.discover',
  'daemon.promptRegistry.scanSource',
  'daemon.filesystem.readFile',
  'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree',
  'daemon.filesystem.listRoots',
  'daemon.filesystem.browseDirectory',
  'bugreport.collectDiagnostics',
  'bugreport.getLogTail',
  'approval.request.list',
  'approval.request.get',
  'plugins.list',
  'plugins.change.status',
  'plugins.settings.list',
  'plugins.settings.get',
  'plugins.settings.secret.status',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugins.sessionHooks.status.get',
  'plugins.permissions.grants.list',
  'session.log.tail',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.search',
  'sessions.external.candidates.list',
  'sessions.external.status.get',
  'sessions.external.operation.status.get',
  'sessions.external.transcript.page',
  'sessions.external.transcript.readAfter',
  'scm.pullRequest.list',
  'scm.pullRequest.get',
  'scm.pullRequest.openCompose',
  'scm.hostingRepository.describePublishTargets',
  'scm.diffSummary.capture',
  'scm.diffSummary.generate',
  'scm.diffSummary.result.read',
  'scm.diffSummary.result.list',
  'scm.diffSummary.result.clear',
  'scm.diffSummary.result.edit',
  'scm.diffSummary.result.undo',
  'scm.diffSummary.result.delete',
  'scm.diffSummary.refine',
  'scm.diffSummary.addOutputs',
  'scm.diffSummary.discuss',
  'scm.diffSummary.commitPlan.accept',
  'scm.diffSummary.commitPlan.stop',
  'scm.diffSummary.commitPlan.includeHookChanges',
  'scm.diffSummary.commitPlan.cancel',
  'scm.diffSummary.commitPlan.recover',
  'scm.commit.resolveOutcome',
  'scm.diffSummary.reviewed.mark',
  'scm.diffSummary.reviewed.unmark',
  'browser.sandbox.install',
  'browser.view.open',
  'browser.view.close',
  'browser.view.focus',
  'browser.target.set',
  'browser.navigate',
  'browser.reload',
  'browser.goBack',
  'browser.goForward',
  'browser.stop',
  'browser.diagnostics.snapshot',
  'browser.control.takeControl',
  'browser.control.handBack',
  'browser.diagnostics.clear',
  'browser.diagnostics.pause',
  'browser.diagnostics.resume',
  'browser.diagnostics.eval',
  'browser.diagnostics.getProperties',
  'browser.diagnostics.releaseObjectGroup',
  'browser.diagnostics.elementPicker.start',
  'browser.diagnostics.elementPicker.cancel',
  'browser.context.capturePage',
  'browser.context.captureScreenshot',
  'browser.context.captureSelectedElement',
  'browser.context.captureNetworkSummary',
  'browser.context.captureConsoleSummary',
  'browser.context.annotation.start',
  'browser.context.annotation.cancel',
  'browser.context.annotation.captureRegion',
  'browser.context.annotation.captureElement',
  'browser.context.annotation.attachComment',
  'browser.context.annotation.attachStroke',
  'browser.context.annotation.attachStyleIntent',
  'browser.context.attachToComposer',
  'browser.context.attachToAgentTurn',
  'browser.context.clear',
  'browser.automation.status',
  'browser.automation.snapshot',
  'browser.automation.semanticSnapshot',
  'browser.automation.queryElements',
  'browser.automation.waitFor',
  'browser.automation.timeline.get',
  'browser.automation.cancelActive',
  'browser.automation.navigate',
  'browser.automation.reload',
  'browser.automation.goBack',
  'browser.automation.goForward',
  'browser.automation.click',
  'browser.automation.tap',
  'browser.automation.type',
  'browser.automation.press',
  'browser.automation.scroll',
  'browser.automation.hover',
  'browser.automation.focus',
  'browser.automation.select',
  'browser.automation.setValue',
  'browser.automation.upload',
  'browser.automation.drag',
  'browser.recording.start',
  'browser.recording.stop',
  'browser.recording.cancel',
  'browser.recording.status',
  'browser.recording.listForView',
  'browser.recording.discard',
  'browser.recording.cleanupExpired',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.start',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'localServices.actions.copyUrl',
  'localServices.actions.openPreview',
  'localServices.actions.forget',
  'localServices.actions.stopManaged',
  'localServices.actions.restartManaged',
  'localServices.actions.terminateDetected',
  'peerMediation.observability.snapshot',
  'peerMediation.observability.subscribe',
  'peerMediation.observability.unsubscribe',
  'devices.simulator.list',
  'devices.simulator.stream.keyframe',
  'devices.simulator.stream.snapshot',
  'devices.simulator.stream.quality.set',
  'devices.simulator.stream.fps.set',
  'devices.simulator.stream.scale.set',
  'devices.simulator.lease.acquire',
  'devices.simulator.lease.renew',
  'devices.simulator.lease.release',
  'devices.simulator.input.tap',
  'devices.simulator.input.swipe',
  'devices.simulator.input.text',
  'devices.simulator.input.key',
  'devices.simulator.input.button',
  'devices.simulator.input.orientation',
  'devices.simulator.input.pinch',
  'devices.simulator.input.rotate',
  'devices.simulator.sideband.request',
  // Home-domain operations not explicitly classified as replay-safe deferred
  // retain their required result for the initiating caller.
  ...HOME_GOVERNANCE_ACTION_SPECS.map((spec) => spec.id),
  // Session folder/tag resource rows are Home-domain rows too (`homeDomainActionRow`).
  ...ACTION_ID_FAMILIES_V1.session_organization_resources,
  'home.hub.layout.get',
  ...TEAM_ACTION_IDS_V1.filter((id) => !TEAM_DEFERRED_APPROVAL_REPLAY_SAFE_ACTION_ID_SET.has(id) && id !== 'teams.update'),
  'secrets.shared.list',
  ...MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
] as const satisfies readonly ActionId[];

const RESULT_NONE_APPROVAL_ACTION_IDS = [
  'wait',
  'machines.agents.signIn.start',
  'machines.agents.signIn.status',
  'machines.agents.signIn.cancel',
  'machines.agents.signIn.restart',
  'session.read_state.set',
  'session.follow.sources.list',
  'session.access.grants.list',
  'session.responsibility.candidates.list',
  'session.public_link.get',
  'session.stop',
  'session.delete',
  'session.folder.set',
  'session.tags.set',
  'session.title.set',
  'session.permission_mode.set',
  'session.approval_reviewer.set',
  'session.attention.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.goal.set',
  'session.goal.clear',
  'transcript.unfollow',
  'ui.voice_global.reset',
  'ui.pet.choose',
  'prompt_doc.update',
  'prompt_doc.create',
  'prompt_doc.favorite.set',
  'prompt_bundle.update',
  'prompt_asset.export',
  'prompt_registry.install',
  'approval.request.create',
  'approval.request.decide',
  'plugins.permissions.grants.request',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.revoke',
  'plugins.permissions.grants.dismissRequest',
  'plugins.settings.set',
  'plugins.settings.reset',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  // The plugin-surface target convergence is the same endpoint mutation class
  // as `retarget`: it never routes through approval, so it carries no
  // approval-result artifact semantics either.
  'plugin.webhook.endpoint.convergeTarget',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
  'automation.event.sources.list',
  'automation.event.admit',
  'automation.event.source.status.report',
  'automation.conversation.targets.list',
  'automation.conversation.target.verify',
  'automation.conversation.admit',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.user_action.remote.answer',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  ...REVIEW_COMMENT_ACTION_IDS_V1,
] as const satisfies readonly ActionId[];

const RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_IDS = [
  'home.hub.layout.update',
  ...WORKFLOW_MUTATION_ACTION_IDS,
  'session.access.grant.set',
  'session.access.grant.remove',
  'session.access.context.set',
  'session.responsibility.set',
  'session.reports_to.set',
  'session.public_link.create',
  'session.public_link.remove',

  'machines.pools.create',
  'machines.pools.update',
  'machines.pools.delete',
  'sessions.runner.activation.create',
  'sessions.runner.activation.cancel',
  'session.follow.set',
  'session.follow.remove',
  'session.follow.preferences.set',
  // Creating or removing durable cross-Session context flow is dangerous, so
  // both mutations use the shared deferred approval routing rather than a
  // Follow-local confirmation engine.
  'session.follow.sources.set',
  'session.follow.sources.remove',
  'review.start',
  'review.walkthrough',
  'review.explain_findings',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'sessions.subagents.upsert',
  'sessions.subagents.updateStatus',
  'sessions.subagents.complete',
  'execution.run.start',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.cancel_turn',
  'execution.run.action',
  'execution.run.permission.respond',
  'session.open',
  'session.fork',
  'session.continue_with_replay',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'session.handoff.prepare_target.resume',
  'session.handoff.commit',
  'session.handoff.abort',
  // Linking is ordinarily unapproved: attaching an existing folder destroys
  // nothing. Its destination preflight raises a deferred approval only for a
  // replacement or a continuing exact-mirror deletion.
  'workspace.sync.relationship.create',
  'session.spawn_new',
  'session.message.send',
  // Board mutations carry the ordinary optional/deferred approval artifact; the
  // shared settings resolver decides whether a given surface actually prompts.
  'session.board.item.upsert',
  'session.board.item.remove',
  'session.board.layout.update',
  // Discussion mutations carry the same ordinary optional/deferred artifact.
  // Only the post is dangerous by default, and the shared settings resolver —
  // not discussion code — decides whether a surface actually prompts.
  'session.discussion.create',
  'session.discussion.post',
  'session.discussion.rename',
  'session.discussion.archive',
  'session.discussion.restore',
  'session.discussion.read_state.set',
  'session.permission.respond',
  'session.user_action.answer',
  'session.mode.set',
  'session.target.primary.set',
  'session.target.tracked.set',
  'ui.voice_agent.teleport',
  'daemon.promptAssets.delete',
  'daemon.promptRegistry.install',
  'daemon.filesystem.writeFile',
  'bugreport.uploadArtifact',
  'transcript.import',
  'sessions.external.candidate.delete',
  'sessions.external.link.ensure',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.takeover',
  'sessions.external.materialize.start',
  'sessions.external.takeover.start',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'scm.pullRequest.openOrReuse',
  'scm.pullRequest.checkout',
  'scm.pullRequest.prepareWorktree',
  'scm.reviewWorkspace.materializePrepared',
  'scm.pullRequest.runStacked',
  'scm.repository.clone',
  'scm.repository.init',
  'scm.repository.removeIndexLock',
  'scm.hostingRepository.publish',
  'plugins.scaffold',
  'plugins.install',
  'plugins.uninstall',
  'plugins.dev.submit',
  'plugins.dev.install',
  'plugins.dev.typecheck',
  'plugins.dev.build',
  'plugins.dev.test',
  'plugins.doctor',
  'plugins.pack',
  'plugins.reload',
  'plugins.sessionHooks.install',
  'plugins.sessionHooks.disable',
  'plugins.sessionHooks.enable',
  'plugins.sessionHooks.uninstall',
] as const satisfies readonly ActionId[];

const RESULT_REQUIRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_REQUIRED_APPROVAL_ACTION_IDS);
const RESULT_REQUIRED_DEFERRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(
  RESULT_REQUIRED_DEFERRED_APPROVAL_ACTION_IDS,
);
const RESULT_NONE_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_NONE_APPROVAL_ACTION_IDS);
const RESULT_NONE_DEFERRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_NONE_DEFERRED_APPROVAL_ACTION_IDS);
const RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_IDS);

type ApprovalMetadataActionId =
  | (typeof RESULT_REQUIRED_APPROVAL_ACTION_IDS)[number]
  | (typeof RESULT_REQUIRED_DEFERRED_APPROVAL_ACTION_IDS)[number]
  | (typeof RESULT_NONE_APPROVAL_ACTION_IDS)[number]
  | (typeof RESULT_NONE_DEFERRED_APPROVAL_ACTION_IDS)[number]
  | (typeof RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_IDS)[number];
type AssertNever<T extends never> = T;
type AllActionsMustHaveApprovalMetadata = AssertNever<Exclude<ActionId, ApprovalMetadataActionId>>;
// A missing entry must remain a compiler error, independent of catalog size.
// @ts-expect-error Deliberately omit one real Action from the metadata census.
type MissingApprovalMetadataMustFail = AssertNever<Exclude<ActionId, Exclude<ApprovalMetadataActionId, 'session.message.send'>>>;

const MANAGED_GITHUB_APP_ACTION_SPECS = MANAGED_GITHUB_APP_ACTION_IDS_V1.map(
  (id): PreNormalizedActionSpec => {
    const metadata: Readonly<Record<ManagedGitHubAppActionIdV1, Readonly<{
      title: string;
      description: string;
      safety: 'safe' | 'danger';
      sideEffectClass: 'read' | 'danger';
      cliPath: readonly string[];
    }>>> = {
      'identity.githubApps.list': {
        title: 'List managed GitHub Apps',
        description: 'List the managed GitHub App registrations visible to one Home or Team owner.',
        safety: 'safe',
        sideEffectClass: 'read',
        cliPath: ['identity', 'github-apps', 'list'],
      },
      'identity.githubApps.create': {
        title: 'Create managed GitHub App',
        description: 'Create a managed GitHub App registration for one Home or Team owner.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'create'],
      },
      'identity.githubApps.manifestSetup.start': {
        title: 'Start GitHub App manifest setup',
        description: 'Create a one-time GitHub.com App manifest handoff for one Home or Team owner.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'manifest-setup', 'start'],
      },
      'identity.githubApps.update': {
        title: 'Update managed GitHub App',
        description: 'Update a managed GitHub App registration and rotate its write-only secrets.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'update'],
      },
      'identity.githubApps.verifyInstallation': {
        title: 'Verify managed GitHub App installation',
        description: 'Verify and bind an exact GitHub App installation and organization.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'verify-installation'],
      },
      'identity.githubApps.remove': {
        title: 'Remove managed GitHub App installation',
        description: 'Remove an unused managed GitHub App installation at its current revision.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'remove'],
      },
    };
    const row = metadata[id];
    // `list` returns the already-redacted registration/installation projection
    // and is the one managed-App operation an automation caller may carry. Every
    // other row either accepts write-only App key material or answers with a
    // one-time browser handoff, so it stays on an authenticated human caller —
    // withholding the Agent tool surface alone would still leave the same spec
    // reachable to an API-token or trusted-plugin caller through the public ABI.
    const isSafeRead = id === 'identity.githubApps.list';
    return {
      id,
      title: row.title,
      description: row.description,
      safety: row.safety,
      requiredAuthority: isSafeRead ? 'account_automation' : 'present_user',
      executionPlacement: 'account',
      placements: [],
      surfaces: {
        ui: true,
        voice: false,
        agent: isSafeRead,
        mcp: false,
        cli: true,
        rpc: false,
      },
      sideEffectClass: row.sideEffectClass,
      inputSchema: MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1[id],
      outputSchema: MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[id],
      inputHints: { fields: [] },
      // Registration and installation state belong to one exact Home. The
      // selector is required so credential lookup cannot borrow the device's
      // ambient active Home for a managed-identity secret owner.
      cli: {
        commands: [{ path: [...row.cliPath], visibility: 'canonical' }],
        acceptsServerId: true,
        requiresServerId: true,
      },
      // App private keys, client secrets and webhook secrets are write-only.
      // Observation reaches every installed plugin's after-hook, so the secret
      // arm is dropped here rather than at each observer.
      ...(id === 'identity.githubApps.create'
        ? { projectObservationInput: redactObservationInputPaths('secrets') }
        : {}),
      ...(id === 'identity.githubApps.update'
        ? { projectObservationInput: redactObservationInputPaths('patch.secrets') }
        : {}),
      // The manifest-setup link carries a one-time launch handle and the
      // installation verification answers with a live OAuth authorize URL plus
      // its attempt id. Both are scoped one-time browser credentials, so the
      // observation the executor hands to every installed plugin's after-hook
      // and to the durable approval record keeps only the fact that a handoff
      // was produced — the same projection the sibling provider-test and Admin
      // Portal handoffs use.
      ...(id === 'identity.githubApps.manifestSetup.start' || id === 'identity.githubApps.verifyInstallation'
        ? { projectObservationOutput: () => ({ redacted: true }) }
        : {}),
      serverTransport: { method: 'POST', path: MANAGED_GITHUB_APP_ACTION_PATHS_V1[id] },
    };
  },
);

const CHECKPOINT_SCOPE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'conversation', label: 'Conversation' },
  { value: 'workspace', label: 'Workspace' },
];

const SESSION_VIEW_INPUT_OPTION_LABELS: Readonly<Record<SessionListViewV1, string>> = {
  [SESSION_LIST_SUMMARY_VIEW_V1]: 'Summary',
  [SESSION_LIST_AWARENESS_VIEW_V1]: 'Awareness',
};

/**
 * Every Session read that offers the representation selector offers the same values, derived from
 * the awareness contract that owns them. A spec listing its own literals would drift the moment
 * that enum changes.
 */
const SESSION_VIEW_INPUT_OPTIONS: ActionInputOption[] = SessionListViewV1Schema.options.map((view) => ({
  value: view,
  label: SESSION_VIEW_INPUT_OPTION_LABELS[view],
}));

const CHECKPOINT_SOURCE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'happier_scm', label: 'Happier SCM' },
  { value: 'composed', label: 'Composed' },
];

const REVIEW_COMMENT_ACTION_TITLES: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'Create review comment',
  'reviews.comments.list': 'List review comments',
  'reviews.comments.get': 'Get review comment',
  'reviews.comments.transition': 'Transition review comment',
  'reviews.comments.edit': 'Edit review comment',
  'reviews.comments.reply': 'Reply to review comment',
  'reviews.comments.redact': 'Redact review comment',
  'reviews.comments.setDisposition': 'Set review comment disposition',
  'reviews.comments.attachEvidence': 'Attach review comment evidence',
  'reviews.comments.bulkTransition': 'Bulk transition review comments',
  'reviews.comments.claimPublicationDispatch': 'Claim review comment publication dispatch',
});

const REVIEW_COMMENT_ACTION_SDK_METHODS: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'reviews.comments.create',
  'reviews.comments.list': 'reviews.comments.list',
  'reviews.comments.get': 'reviews.comments.get',
  'reviews.comments.transition': 'reviews.comments.transition',
  'reviews.comments.edit': 'reviews.comments.edit',
  'reviews.comments.reply': 'reviews.comments.reply',
  'reviews.comments.redact': 'reviews.comments.redact',
  'reviews.comments.setDisposition': 'reviews.comments.setDisposition',
  'reviews.comments.attachEvidence': 'reviews.comments.attachEvidence',
  'reviews.comments.bulkTransition': 'reviews.comments.bulkTransition',
  'reviews.comments.claimPublicationDispatch': 'reviews.comments.claimPublicationDispatch',
});

const REVIEW_COMMENT_ACTION_RPC_METHODS: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': RPC_METHODS.REVIEW_COMMENTS_CREATE,
  'reviews.comments.list': RPC_METHODS.REVIEW_COMMENTS_LIST,
  'reviews.comments.get': RPC_METHODS.REVIEW_COMMENTS_GET,
  'reviews.comments.transition': RPC_METHODS.REVIEW_COMMENTS_TRANSITION,
  'reviews.comments.edit': RPC_METHODS.REVIEW_COMMENTS_EDIT,
  'reviews.comments.reply': RPC_METHODS.REVIEW_COMMENTS_REPLY,
  'reviews.comments.redact': RPC_METHODS.REVIEW_COMMENTS_REDACT,
  'reviews.comments.setDisposition': RPC_METHODS.REVIEW_COMMENTS_SET_DISPOSITION,
  'reviews.comments.attachEvidence': RPC_METHODS.REVIEW_COMMENTS_ATTACH_EVIDENCE,
  'reviews.comments.bulkTransition': RPC_METHODS.REVIEW_COMMENTS_BULK_TRANSITION,
  'reviews.comments.claimPublicationDispatch': RPC_METHODS.REVIEW_COMMENTS_CLAIM_PUBLICATION_DISPATCH,
});

const PluginSessionHookAgentPluginInputSchema = lazyZodSchema(() => z.object({
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
const PluginSessionHookStatusPluginInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('passive_inventory'),
    agent: PluginSessionHookAgentPluginInputSchema.optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number()
      .int()
      .min(1)
      .max(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)
      .default(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
  }).strict(),
  z.object({
    intent: z.literal('install_preview'),
    agent: PluginSessionHookAgentPluginInputSchema,
  }).strict(),
  z.object({
    intent: z.literal('installation_recheck'),
    agent: PluginSessionHookAgentPluginInputSchema,
    installationId: z.string().trim().min(1).max(512),
  }).strict(),
]));
const PluginSessionHookInstallPluginInputV1Schema = lazyZodSchema(() => z.object({
  agent: PluginSessionHookAgentPluginInputSchema,
  expectedPreviewId: z.string().regex(/^hook-install-preview:v1:[0-9a-f]{64}$/u),
}).strict());
const PluginSessionHookMutationPluginInputV1Schema = lazyZodSchema(() => z.object({
  agent: PluginSessionHookAgentPluginInputSchema,
  installationId: z.string().trim().min(1).max(512),
}).strict());

function bindPluginSessionHookAgent(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const input = z.object({
    agent: PluginSessionHookAgentPluginInputSchema.optional(),
  }).passthrough().parse(value);
  return {
    ...input,
    ...(input.agent
      ? { agent: { pluginId: caller.pluginId, localId: input.agent.localId } }
      : {}),
  };
}

function projectPluginSessionHookStatus(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const response = PluginSessionHookStatusResponseV1Schema.parse(value);
  return response.ok
    ? {
        ...response,
        rows: response.rows.filter((row) => row.agent.pluginId === caller.pluginId),
      }
    : response;
}

const PluginSessionHookRpcSurfaceBinding = {
  inputSchema: PluginSessionHookStatusInputV1Schema,
  decodeInput: (value: unknown) => value,
  outputSchema: PluginSessionHookStatusResponseV1Schema,
  encodeOutput: (value: unknown) => value,
} as const;

const PLUGIN_PERMISSION_GRANT_ACTION_TITLES: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': 'List plugin permission grants',
  'plugins.permissions.grants.request': 'Request plugin permission grant',
  'plugins.permissions.grants.grant': 'Grant plugin permission',
  'plugins.permissions.grants.revoke': 'Revoke plugin permission',
  'plugins.permissions.grants.dismissRequest': 'Dismiss plugin permission request',
});

const PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_LIST,
  'plugins.permissions.grants.request': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REQUEST,
  'plugins.permissions.grants.grant': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_GRANT,
  'plugins.permissions.grants.revoke': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REVOKE,
  'plugins.permissions.grants.dismissRequest': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_DISMISS_REQUEST,
});

const PluginPermissionSubjectPluginInputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginPermissionSubjectV1Schema.options[0],
  PluginPermissionSubjectV1Schema.options[1].omit({ contribution: true }).extend({
    contribution: z.object({ localId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
  }).strict(),
]));
const PluginPermissionGrantListPluginInputSchema =
  lazyZodSchema(() => PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.list']
    .omit({ pluginId: true, grantId: true, subject: true })
    .extend({ subject: PluginPermissionSubjectPluginInputSchema.optional() })
    .strict());
const PluginPermissionGrantRequestPluginInputSchema =
  lazyZodSchema(() => PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.request'].omit({
    pluginId: true,
    requester: true,
    subject: true,
  }).extend({ subject: PluginPermissionSubjectPluginInputSchema }).strict());
const PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS = Object.freeze({
  'plugins.permissions.grants.list': PluginPermissionGrantListPluginInputSchema,
  'plugins.permissions.grants.request': PluginPermissionGrantRequestPluginInputSchema,
  'plugins.permissions.grants.revoke': PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.revoke'],
});

function requirePluginBindingCaller(context: ActionSurfaceBindingContext): Readonly<{
  kind: 'plugin';
  pluginId: string;
}> {
  if (context.caller.kind !== 'plugin') {
    throw new Error('plugin_surface_caller_required');
  }
  return context.caller;
}

function bindPluginCurrentSessionInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  requirePluginBindingCaller(context);
  const sessionId = typeof context.defaultSessionId === 'string'
    ? context.defaultSessionId.trim()
    : '';
  if (!sessionId) throw new Error('plugin_current_session_required');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_session_interaction_input_invalid');
  }
  return { ...value, sessionId };
}

function projectPluginSessionInteractionResponse(value: unknown): unknown {
  if (value === undefined || value === null) return { ok: true };
  const parsed = SessionInteractionResponseSuccessSchema.safeParse(value);
  if (!parsed.success) throw new Error('plugin_session_interaction_result_invalid');
  return parsed.data;
}

function bindPluginPermissionSubject(
  subject: z.infer<typeof PluginPermissionSubjectPluginInputSchema> | undefined,
  pluginId: string,
): unknown {
  if (!subject || subject.kind === 'general') return subject;
  return {
    ...subject,
    contribution: {
      pluginId,
      localId: subject.contribution.localId,
    },
  };
}

/**
 * The single vocabulary for the plugin scaffold's UI mode. Every surface that
 * accepts `--ui` (CLI parser, `plugins.scaffold` action input, scaffold engine,
 * and the Settings Create form) resolves the mode through this schema; no
 * consumer may enumerate a second mode list.
 *
 * `declarative` is first because it is the default a scaffold receives when the
 * author expresses no preference: a declarative surface is projected from the
 * manifest, so it needs no bundler, no UI dependency tree and no build step,
 * and a fresh plugin therefore renders its first surface on every platform
 * immediately. The executable arms are opt-in.
 */
export const PluginScaffoldUiModeSchema = lazyZodSchema(() => z.enum(['declarative', 'hostedWeb', 'reactNative']));
export type PluginScaffoldUiMode = z.infer<typeof PluginScaffoldUiModeSchema>;

/**
 * The mode a scaffold receives when the author expresses no preference. The
 * scaffold engine applies it and the Settings Create form preselects it, so the
 * command line and the app cannot start a plugin from different shapes.
 */
export const DEFAULT_PLUGIN_SCAFFOLD_UI_MODE: PluginScaffoldUiMode = 'declarative';

/** Optional first-party starting shape; omission retains the generic scaffold. */
export const PluginScaffoldTemplateSchema = lazyZodSchema(() => z.enum(['session-agent']));
export type PluginScaffoldTemplate = z.infer<typeof PluginScaffoldTemplateSchema>;

const PluginScaffoldActionInputSchema = lazyZodSchema(() => z.object({
  targetDir: z.string().trim().min(1),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  ui: PluginScaffoldUiModeSchema.optional(),
  template: PluginScaffoldTemplateSchema.optional(),
}).strict());

const PluginInstallActionInputSchema = lazyZodSchema(() => z.object({
  path: z.string().trim().min(1),
  dev: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict());

const PluginUninstallActionInputSchema = lazyZodSchema(() => z.object({
  pluginId: z.string().trim().min(1),
}).strict());

const PluginReloadActionInputSchema = lazyZodSchema(() => z.object({
  pluginId: z.string().trim().min(1),
}).strict());

const PluginDevActionInputSchema = lazyZodSchema(() => z.object({
  projectRoot: z.string().trim().min(1),
  sdkRegistryOrigin: z.string().trim().min(1).optional(),
}).strict());

const PluginAuthorActionInputSchema = lazyZodSchema(() => z.object({
  projectRoot: z.string().trim().min(1),
  sdkRegistryOrigin: z.string().trim().min(1).optional(),
}).strict());

const PluginDoctorActionInputSchema = lazyZodSchema(() => z.object({
  locator: z.string().trim().min(1),
}).strict());

const PluginPackActionInputSchema = lazyZodSchema(() => z.object({
  locator: z.string().trim().min(1),
  outPath: z.string().trim().min(1).optional(),
  sdkRegistryOrigin: z.string().trim().min(1).optional(),
}).strict());

const PluginListActionInputSchema = EmptyObjectSchema;

const PluginChangeStatusActionInputSchema = lazyZodSchema(() => z.object({
  pendingChangeId: z.string().trim().min(1),
}).strict());

const PluginDevLoopActionInputSchemas = {
  'plugins.scaffold': PluginScaffoldActionInputSchema,
  'plugins.install': PluginInstallActionInputSchema,
  'plugins.uninstall': PluginUninstallActionInputSchema,
  'plugins.dev.submit': PluginDevActionInputSchema,
  'plugins.dev.install': PluginAuthorActionInputSchema,
  'plugins.dev.typecheck': PluginAuthorActionInputSchema,
  'plugins.dev.build': PluginAuthorActionInputSchema,
  'plugins.dev.test': PluginAuthorActionInputSchema,
  'plugins.doctor': PluginDoctorActionInputSchema,
  'plugins.pack': PluginPackActionInputSchema,
  'plugins.reload': PluginReloadActionInputSchema,
  'plugins.list': PluginListActionInputSchema,
  'plugins.change.status': PluginChangeStatusActionInputSchema,
} as const satisfies Readonly<Record<PluginDevLoopActionIdV1, z.ZodTypeAny>>;

const PluginDevLoopActionResultKindSchema = lazyZodSchema(() => z.enum([
  'plugins_scaffold',
  'plugins_install',
  'plugins_uninstall',
  'plugins_dev_submit',
  'plugins_dev_install',
  'plugins_dev_typecheck',
  'plugins_dev_build',
  'plugins_dev_test',
  'plugins_doctor',
  'plugins_pack',
  'plugins_reload',
  'plugins_list',
  'plugins_change_status',
]));

const PluginDevLoopPendingReviewSchema = lazyZodSchema(() => z.object({
  kind: z.literal('reviewRequired'),
  reviewKind: z.enum(['projectTrust', 'installation']),
  pendingChangeId: z.string().trim().min(1),
  // The daemon/CLI change owner retains the review payload contract. Action
  // consumers receive it only as an opaque, nested projection.
  review: z.object({}).passthrough(),
}).passthrough());

const PluginDevLoopReviewRequiredActionOutputSchema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  kind: z.enum(['plugins_install', 'plugins_dev_submit', 'plugins_reload']),
  outcome: z.literal('reviewRequired'),
  // A pending daemon candidate is one nested value. An Action may report it,
  // but never decides it or supplies authenticated user interaction evidence.
  pendingReview: PluginDevLoopPendingReviewSchema,
  pendingChangeId: z.never().optional(),
  review: z.never().optional(),
}).passthrough());

const PluginDevLoopChangeStatusActionOutputSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  kind: z.literal('plugins_change_status'),
  // Status is daemon-lifetime state owned by the CLI change client. Keep its
  // state/result payload opaque here instead of introducing a second owner.
  status: z.object({}).passthrough(),
}).passthrough());

const PluginDevLoopOrdinaryActionOutputSchema = lazyZodSchema(() => z.object({
  ok: z.boolean(),
  kind: PluginDevLoopActionResultKindSchema.exclude(['plugins_change_status']),
  // Only install currently emits an ordinary outcome. Keeping this bounded
  // prevents a review-required result from bypassing its typed envelope.
  outcome: z.enum(['applied', 'failed']).optional(),
  pendingReview: z.never().optional(),
  pendingChangeId: z.never().optional(),
  review: z.never().optional(),
}).passthrough());

const PluginDevLoopActionOutputSchema = lazyZodSchema(() => z.union([
  PluginDevLoopReviewRequiredActionOutputSchema,
  PluginDevLoopChangeStatusActionOutputSchema,
  PluginDevLoopOrdinaryActionOutputSchema,
]));

const PLUGIN_DEV_LOOP_ACTION_TITLES: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Scaffold plugin',
  'plugins.install': 'Install plugin',
  'plugins.uninstall': 'Uninstall plugin',
  'plugins.dev.submit': 'Submit plugin development snapshot',
  'plugins.dev.install': 'Prepare plugin author dependencies',
  'plugins.dev.typecheck': 'Typecheck plugin author source',
  'plugins.dev.build': 'Build plugin author source',
  'plugins.dev.test': 'Test plugin author source',
  'plugins.doctor': 'Diagnose plugin author source',
  'plugins.pack': 'Pack plugin',
  'plugins.reload': 'Reload plugin',
  'plugins.list': 'List plugins',
  'plugins.change.status': 'Get plugin change status',
});

const PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Create a local plugin scaffold from the first-party template.',
  'plugins.install': 'Install a local plugin source and optionally enable the dev reload loop.',
  'plugins.uninstall': 'Remove a local installed plugin through the daemon-owned plugin lifecycle.',
  'plugins.dev.submit': 'Inspect a local plugin source and submit its current snapshot to the daemon-owned development cycle without starting a watcher.',
  'plugins.dev.install': 'Prepare external plugin-author dependencies through the managed runtime.',
  'plugins.dev.typecheck': 'Run the managed TypeScript check for an external plugin-author source.',
  'plugins.dev.build': 'Build an external plugin-author source through the managed runtime.',
  'plugins.dev.test': 'Run the external plugin-author test command through the managed runtime.',
  'plugins.doctor': 'Evaluate and diagnose an external plugin-author source.',
  'plugins.pack': 'Validate and package a local plugin into an installable archive.',
  'plugins.reload': 'Reload one local development plugin through the daemon-owned plugin lifecycle.',
  'plugins.list': 'List installed plugins with source and load diagnostics.',
  'plugins.change.status': 'Read one daemon-issued pending plugin change without creating or deciding it.',
});

function createPluginDevLoopActionSpec(actionId: PluginDevLoopActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.list' || actionId === 'plugins.change.status';
  const isInspectorUiAction = actionId === 'plugins.list'
    || actionId === 'plugins.reload'
    || actionId === 'plugins.change.status';
  const inputSchema = PluginDevLoopActionInputSchemas[actionId];

  return {
    id: actionId,
    title: PLUGIN_DEV_LOOP_ACTION_TITLES[actionId],
    description: PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS[actionId],
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
    },
    surfaces: {
      ui: isInspectorUiAction,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    sideEffectClass: actionId === 'plugins.uninstall' ? 'danger' : isRead ? 'read' : 'write',
    outputSchema: PluginDevLoopActionOutputSchema,
    inputSchema,
    inputHints: { fields: [] },
  };
}

const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List plugin settings',
  'plugins.settings.get': 'Get plugin setting',
  'plugins.settings.set': 'Set plugin setting',
  'plugins.settings.reset': 'Reset plugin setting',
  'plugins.settings.secret.status': 'Get plugin secret status',
  'plugins.settings.secret.bind': 'Bind existing saved secret',
  'plugins.settings.secret.unbind': 'Unbind plugin secret',
  'plugins.settings.secret.delete': 'Delete plugin secret',
});

const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List declared plugin Settings for one exact Account or daemon scope.',
  'plugins.settings.get': 'Read one declared non-secret plugin Setting from one exact scope.',
  'plugins.settings.set': 'Compare-and-set one declared non-secret plugin Setting.',
  'plugins.settings.reset': 'Reset one declared non-secret plugin Setting to its owner default.',
  'plugins.settings.secret.status': 'Read safe configured status for one declared plugin secret.',
  'plugins.settings.secret.bind': 'Bind one plugin secret to an existing SavedSecret identity without exposing its value.',
  'plugins.settings.secret.unbind': 'Remove the binding for one plugin secret without exposing its value.',
  'plugins.settings.secret.delete': 'Delete one plugin secret through its declared custody owner without exposing its value.',
});

function createPluginSettingsAdministrationActionSpec(
  actionId: PluginSettingsAdministrationActionIdV1,
): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.settings.list'
    || actionId === 'plugins.settings.get'
    || actionId === 'plugins.settings.secret.status';

  return {
    id: actionId,
    title: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES[actionId],
    description: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS[actionId],
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginSettingsAdministrationActionOutputV1Schema,
    inputSchema: PluginSettingsAdministrationActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

function createPluginPermissionGrantActionSpec(actionId: PluginPermissionGrantActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.permissions.grants.list';
  const pluginBinding = actionId === 'plugins.permissions.grants.list'
    ? {
        inputSchema: PluginPermissionGrantListPluginInputSchema,
        bindInput(value: unknown, context: ActionSurfaceBindingContext) {
          const caller = requirePluginBindingCaller(context);
          const input = value as z.infer<typeof PluginPermissionGrantListPluginInputSchema>;
          return {
            ...input,
            pluginId: caller.pluginId,
            ...(input.subject
              ? { subject: bindPluginPermissionSubject(input.subject, caller.pluginId) }
              : {}),
          };
        },
      }
    : actionId === 'plugins.permissions.grants.request'
      ? {
          inputSchema: PluginPermissionGrantRequestPluginInputSchema,
          bindInput(value: unknown, context: ActionSurfaceBindingContext) {
            const caller = requirePluginBindingCaller(context);
            const input = value as z.infer<typeof PluginPermissionGrantRequestPluginInputSchema>;
            return {
              ...input,
              pluginId: caller.pluginId,
              subject: bindPluginPermissionSubject(input.subject, caller.pluginId),
              requester: {
                kind: 'plugin' as const,
                pluginId: caller.pluginId,
                ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
              },
            };
          },
        }
      : actionId === 'plugins.permissions.grants.revoke'
        ? {
            inputSchema: PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS[actionId],
          }
        : undefined;
  return {
    id: actionId,
    title: PLUGIN_PERMISSION_GRANT_ACTION_TITLES[actionId],
    description: 'Manage durable user-approved optional plugin permission grants.',
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      rpcMethod: PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS[actionId],
      sdkMethod: actionId,
    },
    ...(pluginBinding ? { surfaceBindings: { plugin: pluginBinding } } : {}),
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginPermissionGrantActionOutputSchemasV1[actionId],
    inputSchema: PluginPermissionGrantActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const PLUGIN_WEBHOOK_ACTION_TITLES: Readonly<Record<PluginWebhookActionIdV1, string>> = Object.freeze({
  'plugin.webhook.endpoint.ensure': 'Ensure webhook endpoint',
  'plugin.webhook.endpoint.read': 'Read webhook endpoint',
  'plugin.webhook.endpoint.revoke': 'Revoke webhook endpoint',
  'plugin.webhook.endpoint.retarget': 'Retarget webhook endpoint',
  'plugin.webhook.endpoint.checkCorrespondence': 'Check webhook endpoint correspondence',
  'plugin.webhook.endpoint.convergeTarget': 'Converge webhook endpoint target',
  'plugin.webhook.delivery.movePending': 'Move pending webhook deliveries',
  'plugin.webhook.endpoint.credential.configure': 'Configure webhook credential',
  'plugin.webhook.endpoint.credential.rotate': 'Rotate webhook credential',
  'plugin.webhook.endpoint.credential.finishRotation': 'Finish webhook credential rotation',
});

function createPluginWebhookActionSpec(actionId: PluginWebhookActionIdV1): PreNormalizedActionSpec {
  // A plugin-surface endpoint operation is never offered on a present-user
  // surface: the caller identity it authorizes against is host-stamped plugin
  // provenance, which a `ui`/`cli` invocation cannot supply.
  const isPluginSurface = isPluginWebhookPluginSurfaceActionIdV1(actionId);
  const readOnly = actionId === 'plugin.webhook.endpoint.read'
    || actionId === 'plugin.webhook.endpoint.checkCorrespondence';
  return {
    id: actionId,
    title: PLUGIN_WEBHOOK_ACTION_TITLES[actionId],
    description: 'Manage one Account-owned webhook endpoint through the canonical Webhook ingress owner.',
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: !isPluginSurface,
      voice: false,
      agent: false,
      mcp: false,
      cli: !isPluginSurface,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: PluginWebhookActionOutputSchemasV1[actionId],
    inputSchema: PluginWebhookActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
    serverTransport: {
      method: 'POST',
      path: isPluginWebhookPluginSurfaceActionIdV1(actionId)
        ? PluginWebhookPluginSurfaceActionHttpPathsV1[actionId]
        : PluginWebhookActionHttpPathsV1[actionId],
    },
  };
}

const AUTOMATION_EVENT_ACTION_TITLES: Readonly<Record<AutomationEventActionIdV1, string>> = Object.freeze({
  'automation.event.sources.list': 'List Automation Event sources',
  'automation.event.admit': 'Admit Automation Event occurrence',
  'automation.event.source.status.report': 'Report Automation Event source status',
});

function createAutomationEventActionSpec(actionId: AutomationEventActionIdV1): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.event.sources.list';
  return {
    id: actionId,
    title: AUTOMATION_EVENT_ACTION_TITLES[actionId],
    description: 'Read or update Event Automation state through the canonical Automation owner.',
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationEventActionOutputSchemasV1[actionId],
    inputSchema: AutomationEventActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const AUTOMATION_CONVERSATION_ACTION_TITLES: Readonly<
  Record<AutomationConversationActionIdV1, string>
> = Object.freeze({
  'automation.conversation.targets.list': 'List Automation conversation targets',
  'automation.conversation.target.verify': 'Verify Automation conversation target',
  'automation.conversation.admit': 'Admit Automation conversation occurrence',
});

function createAutomationConversationActionSpec(
  actionId: AutomationConversationActionIdV1,
): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.conversation.targets.list'
    || actionId === 'automation.conversation.target.verify';
  const description = actionId === 'automation.conversation.targets.list'
    ? 'List current selectable Automation conversation targets through the canonical Automation owner.'
    : readOnly
      ? 'Verify an Automation conversation target through the canonical Automation owner.'
      : 'Admit a conversation occurrence through the canonical Automation owner.';
  return {
    id: actionId,
    title: AUTOMATION_CONVERSATION_ACTION_TITLES[actionId],
    description,
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationConversationActionOutputSchemasV1[actionId],
    inputSchema: AutomationConversationActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

function createReviewCommentActionSpec(actionId: ReviewCommentActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'reviews.comments.list' || actionId === 'reviews.comments.get';
  const isVerdictAction = actionId === 'reviews.comments.list'
    || actionId === 'reviews.comments.transition'
    || actionId === 'reviews.comments.setDisposition';
  return {
    id: actionId,
    title: REVIEW_COMMENT_ACTION_TITLES[actionId],
    description: 'Operate on durable review comments through the shared review-comment substrate.',
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      rpcMethod: REVIEW_COMMENT_ACTION_RPC_METHODS[actionId],
      sdkMethod: REVIEW_COMMENT_ACTION_SDK_METHODS[actionId],
      ...(isVerdictAction ? { mcpToolName: actionId.replaceAll('.', '_') } : {}),
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: isVerdictAction,
      mcp: isVerdictAction,
      cli: false,
      rpc: true,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: ReviewCommentActionOutputSchemasV1[actionId],
    inputSchema: ReviewCommentActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1 = [
  {
    id: 'plugins.sessionHooks.status.get',
    title: 'Get Agent session-hook status inventory',
    description:
      'Read a bounded, paginated inventory of portable External Session hook installation status rows.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET },
    surfaceBindings: {
      rpc: PluginSessionHookRpcSurfaceBinding,
      plugin: {
        inputSchema: PluginSessionHookStatusPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
        projectOutput: projectPluginSessionHookStatus,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: PluginSessionHookStatusResponseV1Schema,
    inputSchema: PluginSessionHookStatusActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.install',
    title: 'Install Agent session hooks',
    description: 'Explicitly install External Session hooks for one qualified Agent integration.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookInstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookInstallPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookInstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.disable',
    title: 'Disable Agent session hooks',
    description: 'Explicitly disable ingestion for one exact Agent hook installation without deleting its owned config.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.enable',
    title: 'Enable Agent session hooks',
    description: 'Explicitly enable ingestion for one exact Agent hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.uninstall',
    title: 'Uninstall Agent session hooks',
    description: 'Explicitly remove only the owned entries for one exact External Session hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookUninstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginSessionHookUninstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

const EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS: ActionInputHints['fields'] = [
  { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
  { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
  { path: 'revision', title: 'Revision', widget: 'text', required: true },
];

function identityActionSurfaceValue(value: unknown): unknown {
  return value;
}

function projectExternalSessionOperationResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const semantic = ExternalSessionOperationActionResultV1Schema.safeParse(value);
  const materialize = ExternalSessionMaterializeActionInputV1Schema.safeParse(
    context.input,
  );
  const reference = ExternalSessionOperationStatusInputV1Schema.safeParse(
    context.input,
  );
  const sessionId = materialize.success
    ? materialize.data.request.sessionId
    : reference.success
      ? reference.data.sessionId
      : null;
  if (!sessionId) throw new Error('external_session_operation_input_required');
  if (semantic.success) {
    if (
      semantic.data.ok
      && semantic.data.operation.sessionId !== sessionId
    ) {
      throw new Error('external_session_operation_session_mismatch');
    }
    return semantic.data;
  }
  return projectExternalSessionOperationActionResultV1(value, sessionId);
}

function projectExternalSessionMaterializeResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const materialize = ExternalSessionMaterializeActionInputV1Schema.parse(
    context.input,
  );
  return projectExternalSessionMaterializeActionResultV1(
    value,
    materialize.request.sessionId,
  );
}

function projectExternalSessionStatusResult(value: unknown): unknown {
  const response = ExternalSessionStatusGetResponseSchema.parse(value);
  return response.ok
    ? ExternalSessionStatusActionResultV1Schema.parse({
        ok: true,
        machineOnline: response.machineOnline,
        runnerActive: response.runnerActive,
        activity: response.activity,
        canTakeOverDirect: response.canTakeOverDirect,
        canTakeOverPersist: response.canTakeOverPersist,
        canForceStop: response.canForceStop,
        ...(response.lastKnownActivityAtMs === undefined
          ? {}
          : { lastKnownActivityAtMs: response.lastKnownActivityAtMs }),
      })
    : ExternalSessionStatusActionResultV1Schema.parse({
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

function projectExternalSessionBackgroundFollowResult(value: unknown): unknown {
  const response = ExternalSessionFollowPolicySetResponseSchema.parse(value);
  return ExternalSessionBackgroundFollowActionResultV1Schema.parse(response.ok
    ? {
        ok: true,
        enabled: response.enabled,
        leaseActive: response.leaseActive,
        updatedAtMs: response.updatedAtMs,
      }
    : {
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

const EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1 = [
  {
    id: 'sessions.external.materialize.start',
    title: 'Materialize external session',
    description: 'Start or converge on the canonical external-session materialization operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START, mcpToolName: 'sessions_external_materialize_start' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionMaterializeStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionMaterializeActionInputV1Schema,
        projectOutput: projectExternalSessionMaterializeResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionMaterializeActionResultV1Schema,
    inputSchema: ExternalSessionMaterializeActionInputV1Schema,
    inputHints: {
      title: 'Materialize external session',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.takeover.start',
    title: 'Start external session takeover',
    description: 'Start or converge on the canonical external-session takeover operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionTakeoverStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResponseV1Schema,
    inputSchema: ExternalSessionTakeoverStartInputV1Schema,
    inputHints: {
      title: 'Start external session takeover',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.operation.status.get',
    title: 'Get external session operation status',
    description: 'Passively read the current canonical external-session operation projection.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, mcpToolName: 'sessions_external_operation_status_get' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationStatusInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationStatusInputV1Schema,
    inputHints: {
      title: 'Get external session operation status',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.cancel',
    title: 'Cancel external session operation',
    description: 'Record an explicit cancellation intent for the current operation revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL, mcpToolName: 'sessions_external_operation_cancel' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationCancelInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationCancelInputV1Schema,
    inputHints: {
      title: 'Cancel external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.resume',
    title: 'Resume external session operation',
    description: 'Explicitly resume a passively hydrated operation from its durable checkpoint.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, mcpToolName: 'sessions_external_operation_resume' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationResumeInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationResumeInputV1Schema,
    inputHints: {
      title: 'Resume external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.retry',
    title: 'Retry external session operation',
    description: 'Explicitly retry the canonical recovery phase at the current revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY, mcpToolName: 'sessions_external_operation_retry' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationRetryInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationRetryInputV1Schema,
    inputHints: {
      title: 'Retry external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.discard',
    title: 'Discard external session operation',
    description: 'Destructively discard an eligible initial partial operation and its private staging.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD, mcpToolName: 'sessions_external_operation_discard' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationDiscardInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationDiscardInputV1Schema,
    inputHints: {
      title: 'Discard external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

function resolveApprovalMetadataForActionId(actionId: ActionId): ActionApproval {
  if (RESULT_REQUIRED_DEFERRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_REQUIRED_DEFERRED;
  if (RESULT_REQUIRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_REQUIRED;
  if (RESULT_NONE_DEFERRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_NONE_DEFERRED;
  if (RESULT_NONE_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_NONE;
  if (RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_OPTIONAL_DEFERRED;
  throw new Error(`Missing action approval metadata for ${actionId}`);
}

const EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION =
  'A nonempty sessionId selects that exact authorized Session. Omitting sessionId inherits the current Action Session, or selects detached scope when none exists. sessionId:null selects detached scope even inside a current Session.';

const EXECUTION_RUN_SESSION_SCOPE_HINT = {
  path: 'sessionId',
  title: 'Session id',
  description: 'Use a nonempty value for an exact authorized Session. Omit it to inherit the current Action Session, or to select detached scope when no current Session exists. Set null to select detached scope even inside a current Session.',
  widget: 'text',
} satisfies ActionInputFieldHint;

const EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION =
  'Timeout only ends this observation; it does not stop, retry, or start the run. Cancellation only ends this wait.';

const WORKFLOW_DIRECT_MCP_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.run.start', 'workflow.run.get', 'workflow.run.wait', 'workflow.run.cancel',
]);

const WORKFLOW_DANGER_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.run.delete', 'workflow.definition.delete',
  'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove',
  'session.trigger.remove',
]);

const WORKFLOW_ACTION_TITLES: Readonly<Record<WorkflowActionIdV1, string>> = {
  'workflow.validate': 'Validate workflow',
  'workflow.run.start': 'Start workflow Run',
  'workflow.run.list': 'List workflow Runs',
  'workflow.run.summaries': 'Summarize workflow Runs',
  'workflow.run.get': 'Get workflow Run',
  'workflow.run.wait': 'Wait for workflow Run',
  'workflow.run.pause': 'Pause workflow Run',
  'workflow.run.resume': 'Resume workflow Run',
  'workflow.run.cancel': 'Cancel workflow Run',
  'workflow.run.invocations.list': 'List workflow invocations',
  'workflow.run.invocations.get': 'Get workflow invocation',
  'workflow.run.invocations.retry': 'Retry workflow invocation',
  'workflow.run.invocations.publish_draft': 'Publish workflow draft result',
  'workflow.run.invocations.complete_review': 'Complete workflow review',
  'workflow.run.delete': 'Delete workflow Run history',
  'workflow.definition.list': 'List workflow definitions',
  'workflow.definition.get': 'Get workflow definition',
  'workflow.definition.create': 'Create workflow definition',
  'workflow.definition.update': 'Update workflow definition',
  'workflow.definition.edit': 'Edit workflow definition',
  'workflow.definition.delete': 'Delete workflow definition',
  'workflow.trigger.list': 'List workflow triggers',
  'workflow.trigger.add': 'Add workflow trigger',
  'workflow.trigger.update': 'Update workflow trigger',
  'workflow.trigger.remove': 'Remove workflow trigger',
  'session.trigger.list': 'List session triggers',
  'session.trigger.add': 'Add session trigger',
  'session.trigger.update': 'Update session trigger',
  'session.trigger.remove': 'Remove session trigger',
};

const WORKFLOW_TRIGGER_VOICE_ARGS_EXAMPLES: Readonly<Partial<Record<WorkflowActionIdV1, string>>> = {
  'workflow.trigger.list': '{"workflow":"builtin:review-and-converge"}',
  'workflow.trigger.add': '{"workflow":"builtin:review-and-converge","project":{"machineId":"machine_123","directory":"/workspace/project"},"trigger":{"kind":"schedule","enabled":true,"schedule":{"kind":"cron","scheduleExpr":"0 9 * * *","everyMs":null,"timezone":"UTC"}}}',
  'workflow.trigger.update': '{"automationId":"automation_123","triggerId":"trigger_123","expectedRevision":1,"patch":{"enabled":false}}',
  'workflow.trigger.remove': '{"automationId":"automation_123","triggerId":"trigger_123"}',
  'session.trigger.list': '{"sessionId":"session_123"}',
  'session.trigger.add': '{"sessionId":"session_123","target":{"kind":"workflow","ref":"builtin:keep-going"},"trigger":{"kind":"sessionLifecycle","enabled":true,"sourceSessionId":"session_123","events":["parentTurnCompleted"],"policy":{"kind":"everyMatch"}}}',
  'session.trigger.update': '{"sessionId":"session_123","triggerId":"trigger_123","expectedRevision":1,"patch":{"enabled":false}}',
  'session.trigger.remove': '{"sessionId":"session_123","triggerId":"trigger_123"}',
};

const WorkflowInvocationRetryCliInputV1Schema = lazyZodSchema(() => WorkflowActionInputSchemasV1[
  'workflow.run.invocations.retry'
].omit({ input: true }).extend({
  retryInput: WorkflowActionInputSchemasV1['workflow.run.invocations.retry'].shape.input,
}).strict());

function bindWorkflowInvocationRetryCliInputV1(value: unknown): unknown {
  const { retryInput, ...rest } = WorkflowInvocationRetryCliInputV1Schema.parse(value);
  return { ...rest, input: retryInput };
}

const WORKFLOW_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = WORKFLOW_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
  const directMcp = WORKFLOW_DIRECT_MCP_ACTION_IDS.has(actionId);
  const voiceArgsExample = WORKFLOW_TRIGGER_VOICE_ARGS_EXAMPLES[actionId];
  const sideEffectClass = WORKFLOW_DANGER_ACTION_IDS.has(actionId)
    ? 'danger' as const
    : WORKFLOW_READ_ACTION_IDS.has(actionId)
      ? 'read' as const
      : 'write' as const;
  const commandPath = actionId.split('.');
  return {
    id: actionId,
    title: WORKFLOW_ACTION_TITLES[actionId],
    description: actionId === 'workflow.definition.edit'
      ? 'Prefer this typed operation batch for partial workflow changes; workflow.definition.update replaces the whole definition.'
      : actionId === 'workflow.run.invocations.publish_draft'
        ? "Publish a private draft value validated against the invocation's exact frozen result contract. Prose does not publish a result. Publication does not complete or advance the invocation. If publication fails, request a present-user follow-up; an agent must not complete the review."
        : actionId === 'workflow.run.invocations.complete_review'
          ? 'Present-user only: use the stored or supplied validated result, or request generation on the held invocation, using its exact content revision. Automated callers cannot resolve review.'
          : `${WORKFLOW_ACTION_TITLES[actionId]} through the canonical workflow Action owner.`,
    safety: WORKFLOW_DANGER_ACTION_IDS.has(actionId) ? 'danger' : 'safe',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
      // Trusted clients reach the same daemon-owned Workflow Action port. The
      // method is the Action id, so there is no second transport vocabulary.
      rpcMethod: actionId,
    },
    surfaces: {
      ui: true,
      voice: actionId.startsWith('workflow.trigger.') || actionId.startsWith('session.trigger.'),
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    // Only the four interactive operations project as direct MCP tools; the
    // other Workflow operations stay executable through the generic external
    // MCP `action_execute` transport and discoverable through Action search
    // without gaining a dedicated tool row.
    ...(directMcp ? {} : { toolExposure: { mcp: 'discoverable_only' as const } }),
    sideEffectClass,
    ...(actionId === 'workflow.run.invocations.complete_review' ? { requiredAuthority: 'present_user' as const } : {}),
    inputSchema: WorkflowActionInputSchemasV1[actionId],
    outputSchema: WorkflowActionOutputSchemasV1[actionId],
    ...(voiceArgsExample ? { examples: { voice: { argsExample: voiceArgsExample } } } : {}),
    inputHints: { title: WORKFLOW_ACTION_TITLES[actionId], fields: actionId === 'workflow.trigger.add'
      ? [{ path: 'workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' }]
      : actionId === 'session.trigger.add'
        ? [{ path: 'target.ref', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' }]
      : actionId === 'workflow.run.start'
        ? [{ path: 'source.workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' }]
      : [] },
    cli: {
      acceptsServerId: true,
      commands: [{ path: commandPath, visibility: 'canonical' }],
      ...(actionId === 'workflow.run.invocations.retry' ? {
        inputSchema: WorkflowInvocationRetryCliInputV1Schema,
        inputHints: {
          title: 'Retry workflow invocation',
          fields: [{
            path: 'retryInput',
            title: 'Retry input',
            description: 'Use {"kind":"original"} or provide a replacement authored input.',
            widget: 'json',
            required: true,
          }],
        },
        bindInput: bindWorkflowInvocationRetryCliInputV1,
      } : {}),
    },
  };
});
const WORK_BOARD_ACTION_TITLES: Readonly<Record<WorkBoardActionIdV1, string>> = {
  'boards.list': 'List Boards',
  'boards.apply': 'Edit Board',
};

const WORK_BOARD_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = WORK_BOARD_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  id,
  title: WORK_BOARD_ACTION_TITLES[id],
  description: id === 'boards.list'
    ? 'Read this Home Account’s Boards.'
    : 'Replay a Board intent through Account settings. Supports create, delete, update, add_items, remove_item and set_positions; agent moves do not prune positions.',
  // An aggregate intent can delete a Board, so mutation approval uses the shared danger policy.
  safety: id === 'boards.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'boards.list' ? 'read' : 'danger',
  executionPlacement: 'account', requiredAuthority: 'account_automation',
  placements: [],
  bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: WorkBoardActionInputSchemasV1[id],
  outputSchema: WorkBoardActionOutputSchemasV1[id],
  inputHints: { title: WORK_BOARD_ACTION_TITLES[id], fields: id === 'boards.list' ? [] : [
    { path: 'boardId', title: 'Board id', widget: 'text', description: 'Optional; must match the intent target when supplied.' },
    { path: 'intent', title: 'Board intent', widget: 'json', required: true,
      description: 'Use kind create, delete, update, add_items, remove_item or set_positions. References include kind and qualifiedId {serverId, id}.' },
  ] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}));

const ARTIFACT_ACCESS_ACTION_SPECS: readonly (PreNormalizedActionSpec & Readonly<{
  requiredAuthority: 'account_automation';
}>)[] = ARTIFACT_ACCESS_ACTION_IDS_V1.map((id) => ({
  id, title: id === 'artifact.access.grants.list' ? 'List document sharing' : id === 'artifact.access.grants.set' ? 'Share document' : 'Remove document sharing',
  description: 'Manage sharing through the document kind owner and authenticated Artifact grants.',
  safety: id === 'artifact.access.grants.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'artifact.access.grants.list' ? 'read' : 'write',
  // Anything a person can do here an agent can do too (owner rule; INT review F-18): the same
  // authority and approval policy as Session access grants, so widening access still asks.
  requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
  surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: false },
  inputSchema: ArtifactAccessActionInputSchemasV1[id], outputSchema: ArtifactAccessActionOutputSchemasV1[id],
  inputHints: { title: 'Document sharing', fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}));

function projectPublicLinkCreationObservation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  return { ...result,
    ...(typeof result.url === 'string' ? { url: redactPublicShareCapabilityUrl(result.url) } : {}),
    ...(typeof result.previewUrl === 'string' ? { previewUrl: redactPublicShareCapabilityUrl(result.previewUrl) } : {}),
  };
}

const ARTIFACT_ACTION_SPECS: readonly (PreNormalizedActionSpec & Readonly<{
  requiredAuthority: 'account_automation';
}>)[] = ARTIFACT_ACTION_IDS_V1.map((id) => {
  const read = id === 'artifact.get' || id === 'artifact.list' || id === 'artifact.revisions.list' || id === 'artifact.storage.usage' || id === 'artifact.public_link.audit';
  return {
    id, title: id, description: 'Read, publish and manage ordinary Account Artifacts through their mode-aware store.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read || id === 'artifact.public_link.list' ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: id === 'artifact.publish_from_file' ? 'machine' : 'account',
    placements: [], bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: false },
    inputSchema: ArtifactActionInputSchemasV1[id], outputSchema: ArtifactActionOutputSchemasV1[id],
    ...(['artifact.public_link.create', 'artifact.create', 'artifact.update', 'artifact.publish_from_file', 'artifact.get', 'artifact.revisions.restore'].includes(id)
      ? { projectObservationOutput: projectPublicLinkCreationObservation } : {}),
    inputHints: { title: 'Artifact', fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.').map((segment) => segment.replaceAll('_', '-')), visibility: 'canonical' }] },
  };
});

// Reference family declarations so this aggregate preserves literal ids and
// schemas without serializing every Zod schema into the inline tuple type.
const ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES: readonly (
  | (typeof HOME_GOVERNANCE_ACTION_SPECS)[number]
  | (typeof SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS)[number]
  | (typeof MACHINE_CONNECTION_ACTION_SPECS)[number]
  | (typeof TEAM_ACTION_SPECS)[number]
  | (typeof SHARED_SAVED_SECRET_ACTION_SPECS)[number]
  | (typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS)[number]
  | (typeof MANAGED_IDENTITY_PROVIDER_ACTION_SPECS)[number]
  | (typeof MANAGED_GITHUB_APP_ACTION_SPECS)[number]
  | (typeof PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1)[number]
  | (typeof EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1)[number]
  | (typeof WORKFLOW_ACTION_SPECS_V1)[number]
)[] = Object.freeze([
  ...HOME_GOVERNANCE_ACTION_SPECS,
  ...SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS,
  ...MACHINE_CONNECTION_ACTION_SPECS,
  ...TEAM_ACTION_SPECS,
  ...SHARED_SAVED_SECRET_ACTION_SPECS,
  ...CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS,
  ...MANAGED_IDENTITY_PROVIDER_ACTION_SPECS,
  ...MANAGED_GITHUB_APP_ACTION_SPECS,
  ...PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1,
  ...EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1,
  ...WORKFLOW_ACTION_SPECS_V1,
]);

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD = Object.freeze(defineActionSpecs([
  ...WORKSPACE_ACTION_SPECS,
  ...SESSION_CANVAS_ACTION_SPECS,
  ...WORKFLOW_AUTHORING_ACTION_SPECS,
  ...COMPOSER_INGRESS_ACTION_SPECS,
  ...SESSION_ORGANIZATION_MOVE_ACTION_SPECS,
  ...LIST_REORDER_ACTION_SPECS,
  ...TODO_SESSION_LINK_ACTION_SPECS,
  ...SESSION_TERMINAL_ACTION_SPECS,
  ...APP_SHELL_ACTION_SPECS,
  ...NOTIFICATION_CONFIGURATION_ACTION_SPECS,
  ...APP_UPDATE_ACTION_SPECS,
  ...VOICE_CONVERSATION_ACTION_SPECS,
  ...SCOPE_ACTION_SPECS,
  ...SETTINGS_DECLARATION_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
    id, title: id === 'settings.list' ? 'List declared settings' : id === 'settings.get' ? 'Read a declared setting' : id === 'settings.invoke' ? 'Invoke a declared settings operation' : 'Change a declared setting',
    description: 'Discover declared settings, read or change bound preferences, or request a declared operation through its canonical owner. Operations retain their human interaction and credential trust requirements. Local preferences belong to the answering client.',
    safety: id === 'settings.set' ? 'danger' : 'safe',
    sideEffectClass: id === 'settings.set' || id === 'settings.invoke' ? 'write' : 'read',
    requiredAuthority: 'account_automation', executionPlacement: id === 'settings.invoke' ? 'client' : 'account', placements: [],
    executionPlacementForInput: (input: unknown) => id === 'settings.list' ? 'account'
      : id !== 'settings.invoke' && typeof input === 'object' && input !== null && 'anchor' in input
        && readAccountSettingDeclarationV1(input.anchor) ? 'account' : 'client',
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: false },
    inputSchema: SettingsDeclarationActionInputSchemasV1[id], outputSchema: SettingsDeclarationActionOutputSchemasV1[id],
    inputHints: { fields: id === 'settings.list'
      ? [{ path: 'pageId', title: 'Settings page', widget: 'text' }]
      : [
        { path: 'anchor', title: 'Setting anchor', widget: 'text', required: true },
        ...(id === 'settings.set' ? [{ path: 'value', title: 'Setting value', widget: 'json' as const, required: true }] : []),
      ] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  })),
  ...WORK_BOARD_ACTION_SPECS_V1,
  ...WIDGET_INSTANCE_ACTION_SPECS_V1,
  ...WIDGET_DEFINITION_ACTION_SPECS_V1,
  ...WIDGET_SNAPSHOT_ACTION_SPECS_V1,
  ...HOME_HUB_LAYOUT_ACTION_SPECS,
  ...ARTIFACT_ACCESS_ACTION_SPECS,
  ...ARTIFACT_ACTION_SPECS,
  {
    id: 'launch_profiles.publish', title: 'Publish launch profile', safety: 'safe',
    placements: [], bindings: { rpcMethod: 'launch_profiles.publish' },
    requiredAuthority: 'account_automation', sideEffectClass: 'write',
    surfaces: { ui: true, cli: true, agent: true, mcp: false, voice: false, rpc: true },
    inputSchema: LaunchProfilePublishInputV1Schema, outputSchema: LaunchProfilePublishOutputV1Schema,
    inputHints: { title: 'Publish launch profile', fields: [
      { path: 'profileId', title: 'Launch profile id', widget: 'text', required: true },
    ] },
    cli: { acceptsServerId: true, commands: [{ path: ['launch_profiles', 'publish'], visibility: 'canonical' }] },
  },
  ...ROLE_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const accountMutation = isAccountRoleMutationV1(id);
    const read = id === 'roles.list' || id === 'roles.get';
    const reports = id === 'session.roles.apply_to_reports';
    const fields: ActionInputFieldHint[] = [];
    if (id.startsWith('session.')) {
      fields.push({ path: 'sessionId', title: 'Session id', widget: 'text', required: true });
    }
    if (id !== 'roles.list' && id !== 'session.notes.set' && !reports) {
      fields.push({ path: 'roleId', title: 'Role id', widget: 'text', required: id !== 'roles.create' });
    }
    if (id === 'session.roles.add' || id === 'roles.create' || id === 'roles.update') {
      fields.push({ path: 'role', title: 'Role', widget: 'json', required: true });
    }
    if (id === 'roles.update' || id === 'roles.delete') {
      fields.push({ path: 'expectedRevision', title: 'Expected role revision', widget: 'json', required: true });
    }
    if (id === 'session.roles.override.set' || id === 'roles.override.set') {
      fields.push(
        { path: 'engine', title: 'Engine', widget: 'json' },
        { path: 'runsAs', title: 'Runs as', widget: 'json' },
        { path: 'profileId', title: 'Launch profile id', widget: 'text' },
        { path: 'workspaceWrites', title: 'Workspace writes', widget: 'select', options: [
          { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' },
        ] },
        { path: 'secondOpinion', title: 'Second opinion', widget: 'select', options: [
          { value: 'off', label: 'Off' }, { value: 'encouraged', label: 'Encouraged' },
        ] },
      );
      if (id === 'roles.override.set') {
        fields.push({ path: 'instructionsOverride', title: 'Instructions override', widget: 'textarea' });
      }
    }
    if (id === 'session.notes.set') {
      fields.push({ path: 'notes', title: 'Orchestration notes', widget: 'textarea', required: true });
    }
    const voiceArgsExamples: Partial<Record<RoleActionIdV1, string>> = {
      'session.role.set': '{"sessionId":"{{sessionId}}","roleId":"orchestrator"}',
      'session.roles.override.set': '{"sessionId":"{{sessionId}}","roleId":"orchestrator","workspaceWrites":"deny"}',
      'session.roles.override.clear': '{"sessionId":"{{sessionId}}","roleId":"orchestrator"}',
      'session.roles.add': '{"sessionId":"{{sessionId}}","roleId":"scout_notes","role":{"name":"Scout notes","instructions":"Read the workspace and report findings.","runsAs":{"kind":"session"},"workspaceWrites":"deny","secondOpinion":"off","enabled":true}}',
      'session.roles.remove': '{"sessionId":"{{sessionId}}","roleId":"scout_notes"}',
      'session.notes.set': '{"sessionId":"{{sessionId}}","notes":"Verify changes before reporting."}',
      'roles.list': '{}',
      'roles.get': '{"roleId":"orchestrator"}',
    };
    const voiceArgsExample = voiceArgsExamples[id];
    return {
      id, title: id.split('.').join(' '), safety: accountMutation ? 'danger' : 'safe',
      placements: [],
      bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
      surfaces: { ui: true, cli: true, agent: true, mcp: !accountMutation && !reports,
        voice: !accountMutation && !reports, rpc: true },
      sideEffectClass: read ? 'read' : 'write',
      ...(voiceArgsExample ? { examples: { voice: { argsExample: voiceArgsExample } } } : {}),
      inputSchema: RoleActionInputSchemasV1[id],
      outputSchema: RoleActionOutputSchemasV1[id],
      inputHints: { title: id.split('.').join(' '), fields },
      cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    };
  }),
  ...PLUGIN_DEV_LOOP_ACTION_IDS_V1.map(createPluginDevLoopActionSpec),
  {
    id: 'capture.view',
    title: 'View host capture',
    description: 'Allow one mounted plugin viewer to view the exact current host capture source. Approval is required by default and may be waived for that plugin in Actions settings.',
    safety: 'safe',
    approvalResultCustody: 'live_only',
    projectObservationOutput: () => ({ admitted: true }),
    placements: [],
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: false, rpc: false },
    sideEffectClass: 'read',
    inputSchema: lazyZodSchema(() => z.object({ sourceId: z.string().min(1), sourceOccurrenceId: z.string().min(1) }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ admitted: z.literal(true), sourceId: z.string().min(1), sourceOccurrenceId: z.string().min(1) }).strict()),
    inputHints: { fields: [] },
  },
  ...PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1.map(createPluginSettingsAdministrationActionSpec),
  ...PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1.map(createPluginPermissionGrantActionSpec),
  ...PLUGIN_WEBHOOK_ACTION_IDS_V1.map(createPluginWebhookActionSpec),
  ...AUTOMATION_EVENT_ACTION_IDS_V1.map(createAutomationEventActionSpec),
  ...AUTOMATION_CONVERSATION_ACTION_IDS_V1.map(createAutomationConversationActionSpec),
  ...REVIEW_COMMENT_ACTION_IDS_V1.map(createReviewCommentActionSpec),
  // Runtime rows' exact carriers are projected from their family schema maps
  // below. Avoid serializing that complete union again inside this tuple.
  ...(RUNTIME_ACTION_SPECS as readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX = Object.freeze(defineActionSpecs([
  ...MACHINE_POOL_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const verb = actionId.slice('machines.pools.'.length);
    const isDelete = actionId === 'machines.pools.delete';
    const isRead = actionId === 'machines.pools.list'
      || actionId === 'machines.pools.get'
      || actionId === 'machines.pools.resolve';
    const titles: Record<MachinePoolActionIdV1, string> = {
      'machines.pools.list': 'List Machine Pools',
      'machines.pools.get': 'Get Machine Pool',
      'machines.pools.create': 'Create Machine Pool',
      'machines.pools.update': 'Update Machine Pool',
      'machines.pools.delete': 'Delete Machine Pool',
      'machines.pools.resolve': 'Resolve Machine Pool target',
    };
    return {
      id: actionId,
      title: titles[actionId],
      description: `${titles[actionId]} on the authenticated Home.`,
      safety: isDelete ? 'danger' : 'safe',
      sideEffectClass: isDelete ? 'danger' : isRead ? 'read' : 'write',
      placements: [],
      bindings: { mcpToolName: `machines_pools_${verb}` },
      surfaces: {
        ui: true,
        voice: false,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
      },
      cli: {
        acceptsServerId: true,
        commands: [{
          path: ['machines', 'pools', verb],
          visibility: 'canonical',
        }],
      },
      inputHints: { title: titles[actionId], fields: [] },
      inputSchema: MachinePoolActionInputSchemasV1[actionId],
      outputSchema: MachinePoolActionOutputSchemasV1[actionId],
      serverTransport: {
        method: 'POST',
        path: machinePoolActionEndpointPathV1(actionId),
      },
    };
  }),
  ...EPHEMERAL_RUNNER_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const titles: Record<EphemeralRunnerActionIdV1, string> = {
      'sessions.runner.activation.create': 'Create Temporary computer request',
      'sessions.runner.activation.get': 'Get Temporary computer request',
      'sessions.runner.activation.cancel': 'Cancel Temporary computer request',
    };
    const isRead = actionId === 'sessions.runner.activation.get';
    return {
      id: actionId,
      title: titles[actionId],
      description: `${titles[actionId]} on the exact authenticated Home.`,
      safety: actionId === 'sessions.runner.activation.cancel' ? 'danger' : 'safe',
      sideEffectClass: isRead ? 'read' : actionId === 'sessions.runner.activation.cancel' ? 'danger' : 'write',
      placements: [],
      bindings: {},
      surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false },
      inputHints: { title: titles[actionId], fields: [] },
      inputSchema: EphemeralRunnerActionInputSchemasV1[actionId],
      outputSchema: EphemeralRunnerActionOutputSchemasV1[actionId],
      serverTransport: EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1[actionId],
    };
  }),
  {
    id: 'account.plugins.data.erase',
    title: 'Erase Account plugin data',
    description: 'Erase the current Account’s retained data for one plugin without uninstalling local plugin code.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginAccountDataEraseActionOutputV1Schema,
    inputSchema: PluginAccountDataEraseActionInputV1Schema,
    inputHints: {
      title: 'Erase Account plugin data',
      description: 'This permanently removes the current Account’s retained data for the selected plugin.',
      fields: [
        { path: 'pluginId', title: 'Plugin id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'account.sessions.signOutEverywhere',
    title: 'Sign out everywhere',
    description: 'Invalidate all signed sessions for the current Account. API tokens remain active.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountSessionsSignOutEverywhereActionOutputV1Schema,
    inputSchema: AccountSessionsSignOutEverywhereActionInputV1Schema,
    inputHints: {
      title: 'Sign out everywhere',
      description: 'This invalidates signed sessions for the current Account. API tokens remain active.',
      fields: [],
    },
  },
  {
    id: 'account.encryption.automationTemplates.recover',
    placements: [],
    bindings: { mcpToolName: 'account_encryption_automation_templates_recover' },
    title: 'Recover older automation templates',
    description: 'Recover encrypted predecessor templates on a plain Account using genuine historical material held by the invoking client. Each template uses version CAS; retained encrypted Session templates and historical keys remain unchanged.',
    safety: 'danger',
    sideEffectClass: 'write',
    requiredAuthority: 'present_user',
    surfaces: { ui: true, voice: false, mcp: true, cli: false, agent: true, rpc: false },
    inputSchema: AccountEncryptionAutomationTemplatesRecoverInputV1Schema,
    outputSchema: AccountEncryptionAutomationTemplatesRecoverResultV1Schema,
    inputHints: { title: 'Recover older automation templates', fields: [] },
  },
  {
    id: 'account.encryption.historicalKey.forget',
    placements: [],
    bindings: { mcpToolName: 'account_encryption_historical_key_forget' },
    title: 'Forget the old encryption key',
    description: 'Irreversibly discard historical encryption material on the invoking device after disclosing encrypted dependencies and obtaining human confirmation. Server content is not deleted.',
    safety: 'danger',
    sideEffectClass: 'danger',
    requiredAuthority: 'present_user',
    surfaces: { ui: true, voice: false, mcp: true, cli: false, agent: true, rpc: false },
    inputSchema: AccountHistoricalEncryptionKeyForgetInputV1Schema,
    outputSchema: AccountHistoricalEncryptionKeyForgetResultV1Schema,
    inputHints: { title: 'Forget the old encryption key', fields: [] },
  },
  ...([
    {
      id: 'account.security.get',
      bindings: { mcpToolName: 'account_security_get' },
      title: 'View Account security',
      description: 'Read the current Account authentication summary without exposing credential material.',
      safety: 'safe',
      sideEffectClass: 'read',
      inputSchema: AccountSecurityGetRequestV1Schema,
      outputSchema: AccountSecurityGetResponseV1Schema,
      serverTransport: { method: 'GET', path: ACCOUNT_SECURITY_PATH_V1 },
    },
    {
      id: 'account.security.terminalPresentUser.set',
      bindings: { mcpToolName: 'account_security_terminal_present_user_set' },
      title: 'Set terminal present-user policy',
      description: 'Set whether trusted terminal credentials may prove present-user authority for this Account.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountTerminalPresentUserPolicySetRequestV1Schema,
      outputSchema: AccountTerminalPresentUserPolicySetResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1 },
    },
    {
      id: 'account.password.enroll',
      title: 'Add a password',
      description: 'Enroll email and password authentication for the current Account.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordEnrollRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_ENROLL_PATH_V1 },
    },
    {
      id: 'account.password.change',
      title: 'Change password',
      description: 'Replace the current Account password credential.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordChangeRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_CHANGE_PATH_V1 },
    },
    {
      id: 'account.password.remove',
      title: 'Remove password',
      description: 'Remove email and password authentication after verifying another viable sign-in route.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordRemoveRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_REMOVE_PATH_V1 },
    },
    {
      id: 'account.email.change.request',
      title: 'Change sign-in email',
      description: 'Send verification for a replacement sign-in email address.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountEmailChangeRequestV1Schema,
      outputSchema: AccountEmailChangeRequestResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1 },
    },
  ] as const).map((spec): PreNormalizedActionSpec => ({
    ...spec,
    // Enrollment, change and removal carry credential material, one-time
    // verification bearers and reauthentication proofs. That input may never
    // become durable Approval Artifact custody: a required confirmation keeps
    // the admitted present-user invocation as the waiter, and the Artifact
    // carries only the observation projection below.
    ...(spec.id === 'account.password.enroll'
      || spec.id === 'account.password.change'
      || spec.id === 'account.password.remove'
      ? { approvalInputCustody: 'live_only' as const }
      : {}),
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      // Trusted interactive CLI hosts are application-owned surfaces that prove
      // present_user, collect secrets locally, and use the canonical direct
      // confirmation host. This is not the public plugin SDK: agent/MCP/API/
      // plugin surfaces remain closed for human-secret operations.
      cli: true,
      rpc: false,
    },
    inputHints: { title: spec.title, fields: [] },
    projectObservationInput: (input: unknown) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
      const record = input as Readonly<Record<string, unknown>>;
      return {
        ...(record.v === 1 ? { v: 1 } : {}),
        ...(record.kind === 'plain' || record.kind === 'e2ee' ? { kind: record.kind } : {}),
        ...(typeof record.expectedCredentialRevision === 'number'
          ? { expectedCredentialRevision: record.expectedCredentialRevision }
          : {}),
      };
    },
  })),
  {
    id: 'account.apiTokens.create',
    bindings: { mcpToolName: 'account_api_tokens_create' },
    title: 'Create API token',
    description: 'Create a named API token for the current Account, optionally with trusted-device-prepared encryption access. The token secret is shown once.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensCreateActionOutputV1Schema,
    projectObservationOutput: projectAccountApiTokenCreationObservation,
    // The bearer is shown once and stored only as a digest (L02 PLAN "no ...
    // compound credential reaches ... approval history"); like the Team external
    // key, it stays on the admitted invocation and never in a durable Artifact.
    approvalResultCustody: 'live_only',
    inputSchema: AccountApiTokensCreateActionInputV1Schema,
    inputHints: {
      title: 'Create API token',
      description: 'The full token is displayed once after creation.',
      fields: [
        { path: 'label', title: 'Label', widget: 'text', required: true },
        { path: 'expiresAt', title: 'Expiry', widget: 'text' },
      ],
    },
  },
  {
    id: 'account.apiTokens.list',
    bindings: { mcpToolName: 'account_api_tokens_list' },
    title: 'List API tokens',
    description: 'List non-secret API-token summaries for the current Account.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'read',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensListActionOutputV1Schema,
    inputSchema: AccountApiTokensListActionInputV1Schema,
    inputHints: {
      title: 'List API tokens',
      description: 'Returns labels, prefixes, timestamps, and whether encryption access is present; no token secret is returned.',
      fields: [],
    },
  },
  {
    id: 'account.apiTokens.update',
    bindings: { mcpToolName: 'account_api_tokens_update' },
    title: 'Update API token access',
    description: 'Update the label, grant, or embed configuration of one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensUpdateActionOutputV1Schema,
    inputSchema: AccountApiTokensUpdateActionInputV1Schema,
    inputHints: { title: 'Update API token access', fields: [
      { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
    ] },
  },
  {
    id: 'account.apiTokens.revoke',
    bindings: { mcpToolName: 'account_api_tokens_revoke' },
    title: 'Revoke API token',
    description: 'Revoke one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensRevokeActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeActionInputV1Schema,
    inputHints: {
      title: 'Revoke API token',
      description: 'The token stops working on the server’s next verification.',
      fields: [
        { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'account.apiTokens.revokeAll',
    bindings: { mcpToolName: 'account_api_tokens_revoke_all' },
    title: 'Revoke all API tokens',
    description: 'Revoke every API token for the current Account. Signed sessions are unaffected.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensRevokeAllActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeAllActionInputV1Schema,
    inputHints: {
      title: 'Revoke all API tokens',
      description: 'This permanently revokes every API token for the current Account.',
      fields: [],
    },
  },
  {
    id: 'action.spec.search',
    title: 'Search action specs',
    sideEffectClass: 'read',
    description: 'Search available Happier action specs by name, description, bindings, and field hints.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'searchActionSpecs', mcpToolName: 'action_spec_search' },
    examples: {
      voice: { argsExample: '{"query":"plan mode","limit":5}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Search action specs',
      description: 'Use this before guessing action ids or tool names.',
      fields: [
        { path: 'query', title: 'Query', description: 'Natural-language search text.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{
        path: ['actions', 'search'],
        variadicPositional: 'query',
        visibility: 'canonical',
      }],
      inputSchema: ActionSpecSearchCliInputSchema,
      inputHints: {
        title: 'Search action specs',
        description: 'Use this before guessing action ids or tool names.',
        fields: [
          { path: 'query', title: 'Query words', description: 'Natural-language search text.', widget: 'text' },
          { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
        ],
      },
      bindInput: (value) => {
        const parsed = ActionSpecSearchCliInputSchema.parse(value);
        return {
          query: parsed.query.join(' '),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        };
      },
    },
    outputSchema: ActionSpecSearchResultSchema,
    inputSchema: ActionSpecSearchInputSchema,
  },
  {
    id: 'action.spec.get',
    title: 'Get action spec',
    sideEffectClass: 'read',
    description: 'Get one Happier action spec with input hints and examples.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getActionSpec', mcpToolName: 'action_spec_get' },
    examples: {
      voice: { argsExample: '{"id":"subagents.plan.start"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get action spec',
      fields: [
        { path: 'id', title: 'Action id', description: 'The exact Happier action id.', widget: 'text', required: true },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{
        path: ['actions', 'get'],
        positionals: ['id'],
        visibility: 'canonical',
      }],
    },
    outputSchema: ActionSpecGetResultSchema,
    inputSchema: ActionSpecGetInputSchema,
  },
  {
    id: 'wait',
    title: 'Wait for work',
    description: 'Observe an existing Home-qualified handle without polling or stopping its work. Prefer notifyParentOnCompletion or Follow for parent delivery. Reuse the same handle after an observation timeout.',
    sideEffectClass: 'read',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    bindings: { mcpToolName: 'wait' },
    surfaces: { ui: false, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: WAIT_CLI_PROJECTION,
    inputSchema: WaitActionInputV1Schema,
    outputSchema: WaitActionResultV1Schema,
  },
  {
    id: 'notifications.notify_me',
    title: 'Notify me',
    description: "Send a notification to your Account's configured channels, following your delivery policy.",
    sideEffectClass: 'write',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    bindings: {
      voiceClientToolName: 'notifyMe',
      mcpToolName: 'notifications_notify_me',
      rpcMethod: 'notifications.notify_me',
    },
    examples: {
      voice: { argsExample: '{"title":"Tests finished","message":"The test run on the API branch passed."}' },
    },
    surfaces: { ui: false, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Notify me',
      fields: [
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'open', title: 'Open', description: 'Optional Session or Workflow run link.', widget: 'json' },
        { path: 'channels', title: 'Send to', widget: 'multiselect', optionsSourceId: 'notifications.channels.available' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{ path: ['notify'], positionals: ['message'], visibility: 'canonical' }],
      flagAliases: [{ path: 'message', aliases: ['-p'] }, { path: 'title', aliases: ['-t'] }],
    },
    inputSchema: NotificationsNotifyMeInputV1Schema,
    outputSchema: NotificationsNotifyMeResultV1Schema,
  },
  {
    id: 'action.options.resolve',
    title: 'Resolve action options',
    sideEffectClass: 'read',
    description: 'Resolve valid options for an action field, including dynamic options sources.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'resolveActionOptions', mcpToolName: 'action_options_resolve', rpcMethod: 'action.options.resolve' },
    examples: {
      voice: { argsExample: '{"actionId":"subagents.plan.start","fieldPath":"backendTargetKeys","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Resolve action options',
      description: 'Use this when an action field has static options or an optionsSourceId.',
      fields: [
        { path: 'actionId', title: 'Action id', description: 'Optional when optionsSourceId is provided directly.', widget: 'text' },
        { path: 'fieldPath', title: 'Field path', description: 'Dot-path for the action input field.', widget: 'text' },
        { path: 'optionsSourceId', title: 'Options source id', description: 'Direct options source lookup when known.', widget: 'text' },
        { path: 'sessionId', title: 'Session id', description: 'Omit to use the current invoking Session. Set only for an intentional authorized cross-Session target.', widget: 'text' },
        { path: 'draftInput', title: 'Partial action input', description: 'Partial input for dependent options, for example {"backendTargetKeys":["agent:pi"]} when resolving a model, configuration, or connected service.', widget: 'json' },
        { path: 'query', title: 'Query filter', description: 'Optional search text to filter the returned options.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of options to return.', widget: 'text' },
      ],
    },
    outputSchema: ActionOptionsResolveResultSchema,
    inputSchema: ActionOptionsResolveInputSchema,
  },
  {
    id: 'action.invoke',
    title: 'Invoke contributed action',
    description: 'Invoke one currently available contributed Action through the canonical host dispatcher. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'invokeAction', rpcMethod: 'action.invoke' },
    examples: {
      voice: { argsExample: '{"action":{"pluginId":"acme.plugin","localId":"open-details"},"input":{"source":"voice"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Invoke contributed action',
      description: 'Use the exact qualified Action identity returned by action discovery and only its declared input.',
      fields: [
        { path: 'action.pluginId', title: 'Plugin id', widget: 'text', required: true },
        { path: 'action.localId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Declared Action input', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ActionInvokeInputSchema,
  },
  {
    id: 'review.start',
    title: 'Start review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/review', '/h.review'] },
    bindings: { voiceClientToolName: 'startReview', mcpToolName: 'review_start' },
    inputHints: {
      title: 'Start a code review',
      description: 'Start one or more parallel review runs against the current worktree.',
      fields: [
        {
          path: 'engineIds',
          title: 'Review engines',
          description: 'Select one or more engines. Each engine runs as its own execution run.',
          widget: 'multiselect',
          required: true,
          requireExplicitSelection: true,
          optionsSourceId: 'review.engines.available',
        },
        {
          path: 'outputs', title: 'Also write a walkthrough', widget: 'multiselect',
          options: [{ value: 'walkthrough', label: 'Walkthrough' }],
        },
        {
          path: 'comparisonId', title: 'Captured comparison', widget: 'text',
          description: 'Saved exact comparison identity required when requesting a walkthrough.',
        },
        {
          path: 'narrator.engineId', title: 'Narrator', widget: 'select',
          description: 'Optional explicit capable engine; defaults to the first selected capable reviewer.',
          optionsSourceId: 'review.engines.available',
        },
        { path: 'narrator.modelId', title: 'Narrator model', widget: 'text' },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the reviewers to focus on.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Requires one review engine.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'changeType',
          title: 'Change type',
          description: 'Which changes to review.',
          widget: 'select',
          required: true,
          options: [
            { value: 'committed', label: 'Committed' },
            { value: 'uncommitted', label: 'Uncommitted' },
            { value: 'all', label: 'All' },
          ],
        },
        {
          path: 'base.kind',
          title: 'Base selection',
          description: 'How to define the review base for engines that need it.',
          widget: 'select',
          required: true,
          options: [
            { value: 'none', label: 'None' },
            { value: 'branch', label: 'Base branch' },
            { value: 'commit', label: 'Base commit' },
          ],
        },
        {
          path: 'base.baseBranch',
          title: 'Base branch',
          description: 'Branch name to diff against (when base.kind=branch).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
        },
        {
          path: 'base.baseCommit',
          title: 'Base commit',
          description: 'Commit SHA to diff against (when base.kind=commit).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"engineIds":["codex"],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewStartInputSchema,
    completion: reviewStartCompletion,
  },
  {
    id: 'review.walkthrough',
    title: 'Walk through review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'voice_panel'],
    bindings: { voiceClientToolName: 'reviewWalkthrough', mcpToolName: 'review_walkthrough' },
    cli: { commands: [{ path: ['review', 'walkthrough'], visibility: 'canonical' }] },
    examples: { voice: { argsExample: '{"runId":"review-1","comparisonId":"comparison-1"}' } },
    inputHints: { fields: [
      { path: 'runId', title: 'Reviewer Run', widget: 'text', required: true },
      { path: 'reviewRunIds', title: 'Reviewer Runs', widget: 'text_list', listSeparator: 'comma' },
      { path: 'comparisonId', title: 'Captured comparison', widget: 'text', required: true },
      { path: 'narrator.engineId', title: 'Narrator', widget: 'select', optionsSourceId: 'review.engines.available' },
      { path: 'narrator.modelId', title: 'Narrator model', widget: 'text' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewWalkthroughInputSchema,
    outputSchema: StrictJsonValueSchema,
    completion: reviewWalkthroughCompletion,
  },
  {
    id: 'review.explain_findings',
    title: 'Explain review findings',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'voice_panel'],
    bindings: { voiceClientToolName: 'reviewExplainFindings', mcpToolName: 'review_explain_findings' },
    cli: { commands: [{ path: ['review', 'explain-findings'], visibility: 'canonical' }] },
    examples: { voice: { argsExample: '{"runId":"review-1","cwd":"/repo","resultId":"result-1","expectedRevision":1,"findingIds":[{"runId":"review-1","findingId":"finding-1"}]}' } },
    inputHints: { fields: [
      { path: 'runId', title: 'Reviewer Run', widget: 'text', required: true },
      { path: 'reviewRunIds', title: 'Reviewer Runs', widget: 'text_list', listSeparator: 'comma' },
      { path: 'cwd', title: 'Repository', widget: 'text', required: true },
      { path: 'resultId', title: 'Saved result', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current result revision', widget: 'integer', required: true },
      { path: 'findingIds', title: 'Finding Run identities', widget: 'json', required: true },
      { path: 'instructions', title: 'Instructions', widget: 'textarea' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewExplainFindingsInputSchema,
    outputSchema: StrictJsonValueSchema,
  },
  {
    id: 'subagents.plan.start',
    title: 'Start plan run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.plan'] },
    bindings: { voiceClientToolName: 'startPlan', mcpToolName: 'subagents_plan_start' },
    inputHints: {
      title: 'Start a planning run',
      description: 'Start one or more Happier-managed planning runs using selected Agent backend targets; targets are Agent choices, not parallelism capacity.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Agent backend targets',
          description: 'Select Agent backend targets for Happier-managed runs; use repeated launches or Agent-native subagents for homogeneous parallelism capacity, not parallelism capacity in this field.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the planner(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional model applied to every started run (same vocabulary as session spawn). Omit for the backend default.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Mutually exclusive with modelSelection.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides applied to every started run, e.g. {"reasoning_effort":"high"}. Merged canonically; a conflict with sessionConfigOptionOverrides fails.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional blanket connected-services selection for every target. Use "native" to suppress all connected-service inheritance. An exact connectedServicesByBackendTargetKey entry overrides it.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional connected-services selection per backend target key. Accepts "native" (suppress all connected-service inheritance), a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted targets use session-spawn defaulting (literal). Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"backendTargetKeys":["agent:codex"],"instructions":"Plan the changes."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      },
	    outputSchema: StrictJsonValueSchema,
	    inputSchema: PlanStartInputSchema,
	    completion: planStartCompletion,
	  },
  {
    id: 'subagents.delegate.start',
    title: 'Start delegate run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.delegate'] },
    bindings: { voiceClientToolName: 'startDelegate', mcpToolName: 'subagents_delegate_start' },
    inputHints: {
      title: 'Start a delegation run',
      description: 'Start one or more Happier-managed delegation runs using selected Agent backend targets; targets are Agent choices, not parallelism capacity.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Agent backend targets',
          description: 'Select Agent backend targets for Happier-managed runs; use repeated launches or Agent-native subagents for homogeneous parallelism capacity, not parallelism capacity in this field.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the delegate(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'permissionMode',
          title: 'Permission mode',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          options: EXECUTION_RUN_ACTION_PERMISSION_INPUTS.map((value) => ({ value, label: value })),
        },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional model applied to every started run (same vocabulary as session spawn). Omit for the backend default.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Requires one Agent backend target.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides applied to every started run, e.g. {"reasoning_effort":"high"}. Merged canonically; a conflict with sessionConfigOptionOverrides fails.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional blanket connected-services selection for every target. Use "native" to suppress all connected-service inheritance. An exact connectedServicesByBackendTargetKey entry overrides it.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional connected-services selection per backend target key. Accepts "native" (suppress all connected-service inheritance), a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted targets use session-spawn defaulting (literal). Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"backendTargetKeys":["agent:codex"],"instructions":"Delegate the task."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      },
	    outputSchema: StrictJsonValueSchema,
	    inputSchema: DelegateStartInputSchema,
	  },
  {
    id: 'voice_agent.start',
    title: 'Start voice agent run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['voice_panel'],
    slash: { tokens: ['/h.voice'] },
    bindings: { voiceClientToolName: 'startVoiceAgentRun', mcpToolName: 'voice_agent_start' },
    inputHints: {
      title: 'Start a voice agent run',
      description: 'Start a voice agent execution run (typically used by the voice control plane).',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Agent backend targets',
          description: 'Select Agent backend targets for the Happier-managed voice agent run; this is not parallelism capacity.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'Initial instructions for the voice agent run.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional blanket connected-services selection for every target. An exact connectedServicesByBackendTargetKey entry overrides it.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional per-target override using the exact selected backend target key.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"backendTargetKeys":["agent:codex"],"instructions":"Start the voice assistant for this workspace."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: VoiceAgentStartInputSchema,
  },
  {
    id: 'sessions.subagents.list',
    title: 'List session subagents',
    description: 'Return bounded provider-neutral subagent projections for a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_LIST },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: lazyZodSchema(() => z.array(SubagentRefV1Schema)),
    inputSchema: SubagentListInputSchema,
    inputHints: {
      title: 'List session subagents',
      description: 'Reads a bounded provider-neutral subagent projection snapshot.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'groupId', title: 'Group id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.get',
    title: 'Get session subagent',
    description: 'Return one provider-neutral subagent projection by id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_GET },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: lazyZodSchema(() => SubagentRefV1Schema.nullable()),
    inputSchema: SubagentGetInputSchema,
    inputHints: {
      title: 'Get session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.watch',
    title: 'Watch session subagents',
    description: 'Register the bounded host subagent watcher path and return its initial typed projection snapshot.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_WATCH },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentWatchSnapshotOutputSchema,
    inputSchema: SubagentWatchInputSchema,
    inputHints: {
      title: 'Watch session subagents',
      description: 'Uses the bounded host subagent watcher path and returns the initial snapshot for the RPC caller.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'id', title: 'Subagent id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.upsert',
    title: 'Upsert session subagent',
    description: 'Create or replace a provider-neutral subagent projection with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentRefInputV1Schema,
    inputHints: {
      title: 'Upsert session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'origin', title: 'Origin', widget: 'text', required: true },
        { path: 'kind', title: 'Kind', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.updateStatus',
    title: 'Update session subagent status',
    description: 'Update subagent lifecycle status with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentStatusUpdateInputSchema,
    inputHints: {
      title: 'Update session subagent status',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text', required: true },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.complete',
    title: 'Complete session subagent',
    description: 'Mark a subagent terminal with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentCompleteInputSchema,
    inputHints: {
      title: 'Complete session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Terminal status', widget: 'text' },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'execution.run.start',
    title: 'Start execution run',
    description: `Start a new execution run. Set waitForCompletion=true to wait for a terminal run result. waitTimeoutSeconds only bounds this observation; it never stops, retries, or starts the run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      voiceClientToolName: 'startExecutionRun',
      mcpToolName: 'execution_run_start',
    },
    sideEffectClass: 'write',
    examples: {
      mcp: {
        argsExample: '{"intent":"voice_agent","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response","waitForCompletion":true,"waitTimeoutSeconds":60}',
      },
      voice: {
        argsExample: '{"intent":"voice_agent","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response"}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    cli: EXECUTION_RUN_START_CLI_PROJECTION,
    surfaceBindings: {
      plugin: {
        inputSchema: ExecutionRunStartPluginInputSchema,
      },
    },
    inputHints: {
      title: 'Start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'intent', title: 'Intent', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target (json)', widget: 'textarea', required: true },
        { path: 'instructions', title: 'Instructions', widget: 'textarea' },
        {
          path: 'permissionMode',
          title: 'Permission intent',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          required: true,
          options: EXECUTION_RUN_ACTION_PERMISSION_INPUTS.map((value) => ({ value, label: value })),
        },
        { path: 'retentionPolicy', title: 'Retention policy', widget: 'text', required: true },
        { path: 'runClass', title: 'Run class', widget: 'text', required: true },
        { path: 'ioMode', title: 'IO mode', widget: 'text', required: true },
        {
          path: 'waitForCompletion',
          title: 'Wait for completion',
          description: 'Return the terminal run disposition under wait instead of returning immediately after start.',
          widget: 'boolean',
        },
        {
          path: 'waitTimeoutSeconds',
          title: 'Wait timeout seconds',
          description: 'Optional observation deadline; requires waitForCompletion=true and never stops the run.',
          widget: 'text',
        },
        { path: 'initialContextMode', title: 'Initial context mode', widget: 'text' },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional model for the run backend (same vocabulary as session spawn). Omit for the backend default.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides, e.g. {"reasoning_effort":"high"}. Merged into sessionConfigOptionOverrides at the boundary; a conflict fails with invalid_parameters.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional connected-services selection for the run backend. Accepts "native" (suppress all connected-service inheritance), a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted = session-spawn defaulting (literal). Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
      ],
    },
    outputSchema: ExecutionRunStartResponseSchema,
    inputSchema: ExecutionRunStartInputSchema,
  },
  {
    id: 'execution.run.list',
    title: 'List execution runs',
    description: `List execution runs in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    sideEffectClass: 'read',
    inputHints: {
      title: 'List execution runs',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'backendTarget', title: 'Backend target', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'running', label: 'Running' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'timeout', label: 'Timeout' },
          ],
        },
        { path: 'limit', title: 'Max runs', widget: 'text' },
      ],
    },
    examples: {
      voice: { argsExample: '{"status":"running","limit":10}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    cli: EXECUTION_RUN_LIST_CLI_PROJECTION,
	    outputSchema: ExecutionRunListResponseSchema,
    inputSchema: lazyZodSchema(() => ExecutionRunListRequestSchema.extend({
      sessionId: ExecutionRunScopeSessionIdSchema,
    })),
	  },
  {
    id: 'execution.run.get',
    title: 'Get execution run',
    description: `Get one execution run from the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'run_card', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_GET, voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    sideEffectClass: 'read',
    examples: {
      voice: { argsExample: '{"sessionId":null,"runId":"run_123","includeStructured":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    cli: EXECUTION_RUN_GET_CLI_PROJECTION,
    inputHints: {
      title: 'Get a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'includeStructured', title: 'Include structured output', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunGetResponseSchema,
    inputSchema: ExecutionRunGetInputSchema,
  },
  {
    id: 'execution.run.send',
    title: 'Send to detached execution run',
    description: 'Send a message to a detached execution run on the selected Machine. Requires sessionId: null. Session-owned runs use session.message.send with a recipient.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_SEND, mcpToolName: 'execution_run_send' },
    sideEffectClass: 'write',
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Send to detached run',
      fields: [
        { path: 'sessionId', title: 'Detached scope (null)', widget: 'text', required: true },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunSendResponseSchema,
    inputSchema: DetachedExecutionRunSendInputSchema,
  },
  {
    id: 'execution.run.ensure',
    title: 'Ensure execution run',
    description: `Ensure an existing execution run is active or resumable. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Ensure a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureInputSchema,
  },
  {
    id: 'execution.run.ensure_or_start',
    title: 'Ensure or start execution run',
    description: `Ensure an existing execution run, or start a new one when no run id is supplied. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      rpcMethodAliases: [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1],
    },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Ensure or start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text' },
        { path: 'start', title: 'Start request (json)', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureOrStartInputSchema,
  },
  {
    id: 'execution.run.stream.start',
    title: 'Start execution run stream',
    description: `Start a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_START_CLI_PROJECTION,
    inputHints: {
      title: 'Start a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'displayMessage', title: 'Display message', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamStartResponseSchema)),
    inputSchema: ExecutionRunStreamStartInputSchema,
  },
  {
    id: 'execution.run.stream.read',
    title: 'Read execution run stream',
    description: `Read bounded deltas from an execution-run stream cursor. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_READ_CLI_PROJECTION,
    inputHints: {
      title: 'Read a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxEvents', title: 'Max events', widget: 'text' },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamReadResponseSchema)),
    inputSchema: ExecutionRunStreamReadInputSchema,
  },
  {
    id: 'execution.run.stream.cancel',
    title: 'Cancel execution run stream',
    description: `Cancel a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION,
    inputHints: {
      title: 'Cancel a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamCancelResponseSchema)),
    inputSchema: ExecutionRunStreamCancelInputSchema,
  },
  {
    id: 'execution.run.stop',
    title: 'Stop execution run',
    description: `Stop one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card', 'run_list'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, voiceClientToolName: 'stopExecutionRun', mcpToolName: 'execution_run_stop' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    cli: EXECUTION_RUN_STOP_CLI_PROJECTION,
	    inputHints: {
	      title: 'Stop a run',
	      fields: [
          EXECUTION_RUN_SESSION_SCOPE_HINT,
          { path: 'runId', title: 'Run id', widget: 'text', required: true },
        ],
	    },
	    outputSchema: ExecutionRunStopResponseSchema,
	    inputSchema: ExecutionRunIdInputSchema,
	  },
  {
    id: 'execution.run.cancel_turn',
    title: 'Cancel this response',
    description: `Cancel the addressed active response without stopping its execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, mcpToolName: 'execution_run_cancel_turn' },
    sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Cancel this response',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'occurrenceId', title: 'Occurrence id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
      ],
    },
    outputSchema: ExecutionRunCancelTurnResponseSchema,
    inputSchema: lazyZodSchema(() => ExecutionRunCancelTurnRequestSchema.extend({ sessionId: ExecutionRunScopeSessionIdSchema })),
  },
  {
    id: 'execution.run.action',
    title: 'Apply execution run action',
    description: `Apply an action to one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, voiceClientToolName: 'actionExecutionRun', mcpToolName: 'execution_run_action' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","actionId":"voice_agent.commit","input":{"maxChars":1200}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Run action',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Input (JSON)', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunActionInputSchema,
  },
  {
    id: 'execution.run.permission.respond',
    title: 'Answer detached run request',
    description: 'Approve or deny a permission request, or answer a structured question, on an exact detached execution run. Only a present user may answer; autonomous callers can discover this operation but cannot execute it.',
    safety: 'safe',
    requiredAuthority: 'present_user',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND },
    sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { title: 'Answer a detached run request', fields: [
      { path: 'runId', title: 'Run id', widget: 'text', required: true },
      { path: 'requestId', title: 'Request id', widget: 'text', required: true },
      { path: 'approved', title: 'Approve permission', widget: 'boolean' },
      { path: 'answers', title: 'Question answers (JSON)', widget: 'textarea' },
    ] },
    inputSchema: ExecutionRunPermissionRespondInputSchema,
    outputSchema: lazyZodSchema(() => z.object({ ok: z.literal(true) }).strict()),
  },
  {
    id: 'execution.run.wait',
    title: 'Wait for execution run',
    description: `Observe an execution run until terminal by default, or select permission attention, either condition, or a changed snapshot. Pass timeoutSeconds to bound the observation; omit it for no Happier-side deadline. ${EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION} ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
      mcpToolName: 'execution_run_wait',
    },
    sideEffectClass: 'read',
    examples: {
      mcp: { argsExample: '{"sessionId":null,"runId":"run_123"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_WAIT_CLI_PROJECTION,
    inputHints: {
      title: 'Wait for a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: ExecutionRunWaitResultSchema,
    inputSchema: ExecutionRunWaitInputSchema,
    surfaceBindings: {
      api: {
        inputSchema: ExecutionRunWaitPublicInputSchema,
        outputSchema: ExecutionRunWaitResultSchema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.open',
    title: 'Open session',
    description: 'Open or resume a session. Explicit fresh-folder consent lets the daemon recover a missing managed folder.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'openSession', mcpToolName: 'session_open' },
    examples: {
      voice: { argsExample: '{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Open a session',
      fields: [
        { path: 'tabId', title: 'Workspace tab id (optional)', widget: 'text' },
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
        { path: 'approvedNewDirectoryCreation', title: 'Continue in a fresh folder if the private folder is missing', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionOpenInputSchema,
    cli: { commands: [{ path: ['session', 'open'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.fork',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
      presentation: { onStart: 'current' },
    },
    title: 'Fork session',
    sideEffectClass: 'write',
    description: 'Create a new session from the latest state of the selected session.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info', 'command_palette', 'slash_command', 'voice_panel', 'agent_input_chips'],
    slash: { tokens: ['fork'] },
    bindings: {
      voiceClientToolName: 'forkSession',
      rpcMethod: 'session.fork',
      rpcMethodAliases: [RPC_METHODS.SESSION_FORK_PROVIDER_SAFE],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Fork a session',
      description: 'Forks from the latest message in the session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionForkInputSchema,
  },
  {
    id: 'session.continue_with_replay',
    title: 'Continue session with replay',
    description: 'Create a continuation session from a replay seed while preserving the existing RPC wire contract.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.continueWithReplay' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Continue with replay',
      fields: [
        { path: 'directory', title: 'Directory', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target', widget: 'text', required: true },
        { path: 'replay', title: 'Replay seed', widget: 'textarea', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionContinueWithReplayRpcParamsSchema,
  },
  {
    id: 'session.rollback',
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'session.rollback' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Rollback a session conversation',
      description: 'Rewinds conversation state for the selected session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRollbackInputSchema,
  },
  {
    id: 'session.checkpoint_code_rollback',
    title: 'Rollback code to checkpoint',
    description: 'Apply a checkpoint-backed code rollback for the selected session turn.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Rollback session code to a checkpoint',
      description: 'Creates a mandatory backup checkpoint before applying a same-worktree reverse patch.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text', required: true },
      ],
    },
    outputSchema: CheckpointCodeRollbackResultSchema,
    inputSchema: CheckpointCodeRollbackActionRequestSchema,
  },
  {
    id: 'session.checkpoint',
    title: 'Create checkpoint',
    description: 'Create a source-qualified checkpoint for the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Create a session checkpoint',
      description: 'Creates a checkpoint through a selected provider or Happier SCM source.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionCheckpointResultV1Schema,
    inputSchema: SessionCheckpointRequestV1Schema,
  },
  {
    id: 'session.restore',
    title: 'Restore checkpoint',
    description: 'Restore a selected session checkpoint source.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_RESTORE },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Restore a session checkpoint',
      description: 'Restores from an explicit provider or Happier SCM checkpoint source.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
        { path: 'candidate.source', title: 'Source', widget: 'select', options: CHECKPOINT_SOURCE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionRestoreResultV1Schema,
    inputSchema: SessionRestoreRequestV1Schema,
  },
  {
    id: 'session.handoff',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Hand off session',
    description: 'Move the current session to another machine while keeping the same session id.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info'],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_START],
      sdkMethod: 'session.handoff.start',
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Hand off a session',
      description: 'Moves the current session to another machine.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text' },
      ],
    },
    outputSchema: SessionHandoffActionResultV1Schema,
    inputSchema: SessionHandoffInputSchema,
    surfaceBindings: {
      api: { inputSchema: SessionHandoffPublicInputSchema },
      plugin: { inputSchema: SessionHandoffPublicInputSchema },
    },
  },
  {
    id: 'session.handoff.prepare_target',
    title: 'Prepare session handoff target',
    description: 'Prepare a target machine to receive an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET],
      sdkMethod: 'session.handoff.prepareTarget.start',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Prepare handoff target',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'sourceMachineId', title: 'Source machine id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffPrepareTargetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target_result.get',
    title: 'Get session handoff target preparation result',
    description: 'Read the prepared-target result for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Get handoff prepare-target result',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: SessionHandoffPrepareTargetResultGetResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResultGetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target.resume',
    title: 'Resume interrupted session handoff target preparation',
    description: 'Explicitly continue one interrupted prepare-target job at its current durable revision.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3 },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Resume interrupted handoff preparation',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'jobId', title: 'Job id', widget: 'text', required: true },
        { path: 'expectedRevision', title: 'Expected revision', widget: 'text', required: true },
        { path: 'attemptId', title: 'Attempt id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionHandoffPrepareTargetResumeResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResumeRequestSchema,
  },
  {
    id: 'session.handoff.commit',
    title: 'Commit session handoff',
    description: 'Finalize a prepared session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Commit handoff',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffCommitRequestSchema,
  },
  {
    id: 'session.handoff.abort',
    title: 'Abort session handoff',
    description: 'Cancel an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Abort handoff',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'reason', title: 'Reason', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffAbortRequestSchema,
  },
  {
    id: 'session.handoff.status.get',
    title: 'Get session handoff status',
    description: 'Read scalar status for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Get handoff status',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffStatusGetRequestSchema,
  },
  {
    id: 'workspace.sync.conflict.resolve',
    workspaceWrite: true,
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Resolve workspace conflict',
    description: 'Apply the exact reviewed workspace entry to the explicitly approved current destinations.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_conflict_resolve' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Resolve workspace conflict',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
        { path: 'hubWorkspaceRefId', title: 'Hub workspace ref id', widget: 'text', required: true },
        { path: 'path', title: 'Conflict path', widget: 'text', required: true },
        { path: 'source', title: 'Reviewed source', widget: 'json', required: true },
        { path: 'targets', title: 'Approved destinations', widget: 'json', required: true },
        { path: 'relationshipIds', title: 'Relationship ids', widget: 'json', required: true },
        { path: 'strategy', title: 'Resolution strategy', widget: 'select', options: [{ value: 'use_source', label: 'Use reviewed source' }, { value: 'keep_both', label: 'Use source and keep alternatives' }], required: true },
      ],
    },
    outputSchema: WorkspaceSyncConflictResolutionResultV1Schema,
    inputSchema: WorkspaceSyncConflictResolveActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationship.create',
    workspaceWrite: true,
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Add machine to workspace',
    description: 'Link a selected Workspace to a folder on another machine. Attaching an existing folder preserves its contents; creating from this Workspace replaces them.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Add a machine to this workspace',
      description: 'Links the selected Workspace to a folder on another machine.',
      fields: [
        { path: 'sourceWorkspaceRefId', title: 'Source workspace ref id', widget: 'text', required: true },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text', required: true },
        { path: 'targetPath', title: 'Target folder', widget: 'text', required: true },
        { path: 'mode', title: 'Sync mode', widget: 'select', options: [
          { value: 'keep_synced', label: 'Replica' },
          { value: 'mirror_exactly', label: 'Exact replica' },
          { value: 'keep_both_in_sync', label: 'Editable copy' },
        ], required: true },
        { path: 'destinationIntent', title: 'Destination', widget: 'select', options: [
          { value: 'use_existing', label: 'Use existing folder' },
          { value: 'materialize_from_source_workspace', label: 'Create from this Workspace' },
        ], required: true },
        { path: 'contentPolicy', title: 'Content policy', widget: 'json', required: true },
      ],
    },
    outputSchema: WorkspaceSyncRelationshipCreateResultV1Schema,
    inputSchema: WorkspaceSyncRelationshipCreateActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationships.list',
    title: 'List linked workspace relationships',
    description: 'List linked workspace relationships and their current sync status on the exact controller. Missing status stays unknown, never zero.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_relationships_list' },
    examples: {
      mcp: { argsExample: '{"controllerMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List linked workspace relationships',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text' },
        { path: 'workspaceRefId', title: 'Workspace ref id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: WorkspaceSyncRelationshipsListActionInputV1Schema,
  },
  {
    id: 'workspace.sync.conflicts.list',
    title: 'List workspace sync conflicts',
    description: 'Read one bounded conflict page for a linked workspace relationship. Pages keep their cursor; coverage can be partial.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_conflicts_list' },
    examples: {
      mcp: { argsExample: '{"controllerMachineId":"{{machineId}}","relationshipId":"{{relationshipId}}","limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List workspace sync conflicts',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
        { path: 'relationshipId', title: 'Relationship id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: WorkspaceSyncConflictsListActionInputV1Schema,
  },
  {
    id: 'workspace.sync.conflict.inspect',
    title: 'Inspect workspace sync conflict',
    description: 'Inspect the current endpoint versions of a linked workspace path. Reads current bytes, not history; coverage can be partial.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_conflict_inspect' },
    examples: {
      mcp: { argsExample: '{"controllerMachineId":"{{machineId}}","workspaceRefId":"{{workspaceRefId}}","path":"src/index.ts"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Inspect workspace sync conflict',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text' },
        { path: 'workspaceRefId', title: 'Workspace ref id', widget: 'text', required: true },
        { path: 'path', title: 'Conflict path', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: WorkspaceSyncConflictInspectActionInputV1Schema,
  },
  {
    id: 'session.spawn_new',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Create session',
    description: 'Create a new session on the requested machine using the selected Agent. Pass directory {kind:"path",path} for a folder or {kind:"managed"} for no folder: Happier creates a private folder for this session.',
    sideEffectClass: 'write',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: {
      rpcMethod: RPC_METHODS.SESSION_SPAWN_NEW,
      voiceClientToolName: 'spawnSession',
      mcpToolName: 'session_spawn_new',
    },
    surfaceBindings: {
      api: {
        inputSchema: SessionSpawnNewApiInputSchema,
        bindInput: bindApiSessionSpawnNewInput,
        inputHints: SessionSpawnNewApiInputHints,
      },
      rpc: {
        inputSchema: SessionSpawnNewRpcInputSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: SessionSpawnNewResultV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    examples: {
      voice: { argsExample: '{"executionTarget":{"serverId":"active","machineId":"machine-1"},"directory":{"kind":"path","path":"/workspace/project"},"agentTarget":{"kind":"agent","identity":{"pluginId":"happier.agent.claude","localId":"claude"}},"initialInput":{"text":"Help me inspect this workspace."}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: SessionSpawnNewInputHints,
    outputSchema: SessionSpawnNewResultV1Schema,
    inputSchema: SessionSpawnNewInputSchema,
  },
  {
    id: 'paths.list_recent',
    title: 'List recent paths',
    sideEffectClass: 'read',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths', mcpToolName: 'paths_list_recent' },
    examples: {
      voice: { argsExample: '{"limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List recent paths',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PathsListRecentInputSchema,
  },
  {
    id: 'projects.list',
    title: 'List projects',
    sideEffectClass: 'read',
    description:
      'List the account\'s persisted projects with each one\'s resolved hosting provider and worktrees.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'List projects',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ProjectsListInputSchema,
  },
  {
    id: 'prompts.invocations.list',
    title: 'List prompt invocations',
    sideEffectClass: 'read',
    description:
      "List the account's Prompt Library invocations by stable id, without expanding any prompt body.",
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'prompts_invocations_list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List prompt invocations',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptInvocationsListInputSchema,
  },
  {
    id: 'prompts.invocation.resolve',
    title: 'Resolve a prompt invocation',
    sideEffectClass: 'read',
    description:
      'Resolve one Prompt Library invocation, by its stable id, to the prompt text it produces.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'prompts_invocation_resolve' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Resolve a prompt invocation',
      fields: [
        { path: 'invocationId', title: 'Invocation id', widget: 'text', required: true },
        { path: 'argsText', title: 'Arguments', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptInvocationResolveInputSchema,
  },
  {
    id: 'machines.list',
    title: 'List machines',
    sideEffectClass: 'read',
    description: 'List machines available on the active server scope.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listMachines' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List machines',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: MachinesListInputSchema,
    cli: {
      commands: [{ path: ['machines', 'list'], visibility: 'canonical' }],
      inputSchema: MachinesListCliInputSchema,
      bindInput: (value) => ({
        limit: (value as Readonly<{ limit?: number }>).limit ?? MACHINES_LIST_CLI_DEFAULT_LIMIT,
      }),
    },
  },
  {
    id: 'servers.list',
    title: 'List servers',
    sideEffectClass: 'read',
    description: 'List servers configured in the client.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listServers' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List servers',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ServersListInputSchema,
  },
  {
    id: 'review.engines.list',
    title: 'List review engines',
    sideEffectClass: 'read',
    description: 'List review engines currently available for the active session.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listReviewEngines' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","includeDisabled":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List review engines',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'scope', title: 'Scope', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewEnginesListInputSchema,
  },
  {
    id: 'agents.backends.list',
    title: 'List agent backends',
    sideEffectClass: 'read',
    description: 'List available Agent backends for spawning sessions.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends', mcpToolName: 'agents_backends_list' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10,"machineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent backends',
      fields: [
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'limit', title: 'Max results', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
      ],
    },
    outputSchema: AgentsBackendsListOutputSchema,
    inputSchema: AgentsBackendsListInputSchema,
  },
  {
    id: 'machines.agents.list',
    title: 'List agents on a machine',
    sideEffectClass: 'read',
    description: 'Read daemon-owned Agent installation, sign-in, platform and update facts for a machine.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'List agents on a machine',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'serverId', title: 'Home id (optional)', widget: 'text' },
        { path: 'agentId', title: 'Agent id (optional)', widget: 'text' },
        { path: 'refresh', title: 'Refresh inventory', widget: 'boolean' },
      ],
    },
    inputSchema: MachinesAgentsListInputSchema,
    outputSchema: MachinesAgentsListOutputSchema,
  },
  {
    id: 'workspace.files.search',
    title: 'Search text in workspace files',
    description: 'Search the addressed machine workspace and return one bounded page of grouped text matches with explicit coverage. Refine the query when hasMore is true.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_files_search' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { title: 'Search text in workspace files', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'query', title: 'Search text', widget: 'text' },
      { path: 'matchCase', title: 'Match case', widget: 'boolean' },
      { path: 'regex', title: 'Regular expression', widget: 'boolean' },
      { path: 'includeHidden', title: 'Include hidden files', widget: 'boolean' },
    ] },
    inputSchema: WorkspaceFilesSearchActionInputSchema,
    outputSchema: DaemonWorkspaceFileSearchResponseSchema,
  },
  {
    id: 'machines.agents.signIn.start',
    title: 'Sign in to an agent',
    description: 'Connect an accepted account, or open the agent native login on the selected machine.',
    sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_start' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInStartInputSchema,
    outputSchema: MachinesAgentsSignInStartOutputSchema,
    inputHints: { title: 'Sign in to an agent', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'agentId', title: 'Agent id', widget: 'text' },
      { path: 'method', title: 'Method (connected or native)', widget: 'text' },
      { path: 'serviceId', title: 'Connected service id', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.signIn.status',
    title: 'Check agent sign-in', sideEffectClass: 'read', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_status' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInStatusInputSchema, outputSchema: AgentSignInStatusResponseSchema,
    inputHints: { title: 'Check agent sign-in', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'agentId', title: 'Agent id', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.signIn.cancel',
    title: 'Cancel agent sign-in', sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_cancel' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInCancelInputSchema, outputSchema: MachinesAgentsSignInCancelOutputSchema,
  },
  {
    id: 'machines.agents.signIn.restart',
    title: 'Restart agent sign-in', sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_restart' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInCancelInputSchema, outputSchema: MachinesAgentsSignInStartOutputSchema,
  },
  {
    id: 'machines.agents.install',
    title: 'Install or update an agent',
    sideEffectClass: 'danger',
    description: 'Start a daemon-owned agent install or update job.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install', sdkMethod: 'machines.agents.install.start' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => DaemonAgentInstallStartRequestSchema.extend({
      machineId: z.string().min(1),
      consent: DaemonAgentInstallStartRequestSchema.shape.consent.optional(),
    })),
    outputSchema: DaemonAgentInstallStartResponseSchema,
    inputHints: {
      title: 'Install or update an agent',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'intent', title: 'Intent', widget: 'text' },
        { path: 'consent.vendorRecipe', title: 'Allow the vendor install recipe', widget: 'boolean' },
        { path: 'force', title: 'Reinstall an installed agent', widget: 'boolean' },
      ],
    },
  },
  {
    id: 'machines.agents.install.status',
    title: 'Read an agent install job',
    description: 'Read the daemon-owned current steps, byte progress, and outcome alongside events after the cursor. Omitting the cursor reads events from the start.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install_status' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => DaemonAgentInstallReadRequestSchema.extend({
      machineId: z.string().min(1), cursor: DaemonAgentInstallReadRequestSchema.shape.cursor.optional(),
    })),
    outputSchema: DaemonAgentInstallReadResponseSchema,
    inputHints: { title: 'Read an agent install job', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'jobId', title: 'Job id', widget: 'text' },
      { path: 'cursor', title: 'Event cursor', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.install.cancel',
    title: 'Cancel an agent install job',
    sideEffectClass: 'danger',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install_cancel' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => DaemonAgentInstallCancelRequestSchema.extend({ machineId: z.string().min(1) })),
    outputSchema: DaemonAgentInstallCancelResponseSchema,
    inputHints: { title: 'Cancel an agent install job', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'jobId', title: 'Job id', widget: 'text' },
    ] },
  },
  {
    id: 'agents.models.list',
    title: 'List agent models',
    sideEffectClass: 'read',
    description: 'List available models for an agent backend.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentModels', mcpToolName: 'agents_models_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"backend:plugin-review-bot","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'serverId', title: 'Server id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentsModelsListInputSchema,
  },
  {
    id: 'agents.config_options.list',
    title: 'List agent config options',
    sideEffectClass: 'read',
    description: 'List configurable option definitions for an agent backend without exposing current values.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentConfigOptions', mcpToolName: 'agents_config_options_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"agent:happier.agent.claude/claude","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent config options',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'serverId', title: 'Server id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentsConfigOptionsListInputSchema,
  },
  {
    id: 'agents.session_modes.list',
    title: 'List agent session modes',
    sideEffectClass: 'read',
    description: 'List session modes available for an agent backend.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentSessionModes', mcpToolName: 'agents_session_modes_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent session modes',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'serverId', title: 'Server id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentSpawnOptionsListInputSchema,
  },
  {
    id: 'sessions.spawn.profiles.list',
    title: 'List spawn profiles',
    sideEffectClass: 'read',
    description: 'List Agent launch profile references available for new sessions without exposing secret bindings.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnProfiles', mcpToolName: 'sessions_spawn_profiles_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn profiles',
      fields: [
        { path: 'agentId', title: 'Runtime agent id (optional filter)', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key (optional filter)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnProfilesListInputSchema,
  },
  {
    id: 'sessions.spawn.connected_services.list',
    title: 'List spawn connected services',
    sideEffectClass: 'read',
    description: 'List connected-service references available for new sessions without exposing credentials.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnConnectedServices', mcpToolName: 'sessions_spawn_connected_services_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","includeUnavailable":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn connected services',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'serverId', title: 'Server id (optional)', widget: 'text' },
        { path: 'includeUnavailable', title: 'Include unavailable', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnConnectedServicesListInputSchema,
  },
  {
    id: 'sessions.spawn.mcp_servers.preview',
    title: 'Preview spawn MCP servers',
    sideEffectClass: 'read',
    description: 'Preview MCP servers that would be available to a new session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'previewSpawnMcpServers', mcpToolName: 'sessions_spawn_mcp_servers_preview' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","machineId":"{{machineId}}","directory":"{{path}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Preview spawn MCP servers',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'directory', title: 'Directory', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'selection', title: 'Selection', widget: 'json' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnMcpServersPreviewInputSchema,
  },
  {
    id: 'session.message.send',
    title: 'Send a message to a session',
    sideEffectClass: 'external',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'sendSessionMessage', mcpToolName: 'session_message_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Send a message',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'recipient', title: 'Recipient', description: 'Optional participant routing identity; omit to send to the main Session.', widget: 'json' },
        { path: 'permissionModeOverride', title: 'Permission mode override (optional)', widget: 'text' },
        { path: 'modelOverride', title: 'Model override (optional)', widget: 'text' },
        { path: 'providerConnectionId', title: 'Provider connection id (optional)', widget: 'text' },
        { path: 'wait', title: 'Wait for message completion (optional)', widget: 'boolean' },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: SessionMessageSendResultV1Schema,
    inputSchema: SessionSendMessageInputSchema,
    cli: { ...SESSION_SEND_CLI_PROJECTION, wholeInputSchema: SessionSendMessagePublicInputSchema },
    surfaceBindings: {
      api: {
        inputSchema: SessionSendMessagePublicInputSchema,
        outputSchema: SessionMessageSendResultV1Schema,
      },
      plugin: {
        inputSchema: SessionSendMessagePluginInputV1Schema,
        outputSchema: SessionMessageSendResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.stop',
    title: 'Stop session',
    description: 'Request that the local daemon stops the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_stop', rpcMethod: 'stop-session' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Stop a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
    cli: SESSION_STOP_CLI_PROJECTION,
  },
  {
    id: 'session.terminalComposer.clear',
    title: 'Clear terminal composer',
    description: 'Clear the pending terminal composer draft for a session runtime.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      mcpToolName: 'session_terminal_composer_clear',
      rpcMethod: SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
    },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Clear terminal composer',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionTerminalComposerClearResultV1Schema,
    inputSchema: SessionTerminalComposerClearRequestV1Schema,
  },
  {
    id: 'session.pendingInput.interruptAndRun',
    title: 'Interrupt and run now',
    description: 'Interrupt the live provider turn so its exact native queued prompt can run now.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Interrupt and run now',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionPendingInputInterruptAndRunResultV1Schema,
    inputSchema: SessionPendingInputInterruptAndRunRequestV1Schema,
  },
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX = Object.freeze(defineActionSpecs([
  {
    id: 'session.worker.publish', title: 'Publish a worker report',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'session',
    placements: [], bindings: { mcpToolName: 'session_worker_publish' },
    surfaces: { ui: false, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputHints: { fields: [{ path: 'summary', title: 'Report', widget: 'text', required: true }] },
    inputSchema: SessionWorkerPublishInputV1Schema, outputSchema: SessionWorkerPublishOutputV1Schema,
  },
  // The four shared human/Agent Board intents. People reach them through the UI
  // executor and Agents through the generic Action/tool projection; neither gets a
  // Board-specific dispatcher, parser, or approval rule.
  {
    id: 'session.presentation.apply',
    title: 'Present in the current Session',
    description: 'Apply one reversible Board, Companion, or Chat presentation intent to the exact focused viewer bound to this Agent Session. This never mutates durable Board content.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'account_automation',
    executionPlacement: 'session',
    placements: [],
    bindings: { mcpToolName: 'session_presentation_apply' },
    examples: {
      mcp: { argsExample: '{"intent":{"kind":"board.open","mode":"beside_chat"}}' },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Present in this Session',
      description: 'Changes only the currently bound viewer presentation. Use the Board Actions for durable item or layout mutations.',
      fields: [
        { path: 'intent', title: 'Presentation intent', widget: 'json', required: true },
      ],
    },
    inputSchema: CurrentSessionPresentationActionInputV1Schema,
    outputSchema: CurrentSessionPresentationActionResultV1Schema,
  },
  {
    id: 'session.board.get',
    title: 'Read Session Board',
    description: 'Read the shared Session Board: views, item identities, exact revisions, and the caller’s current Board capabilities. Exact itemIds return full item content.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'session_board_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","itemIds":["release-checklist"],"limit":100}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Read Board',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'itemIds', title: 'Exact item ids', widget: 'text_list', listSeparator: 'comma' },
        { path: 'cursor', title: 'Page cursor', widget: 'text' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.get'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.get'],
    cli: SESSION_BOARD_GET_CLI_PROJECTION,
  },
  {
    id: 'session.board.item.upsert',
    title: 'Create or update a Board item',
    description: 'Create or update one Session Board item at a stable id. Creation requires an atomic first placement; expectedItemRevision is the exact optimistic-concurrency operand.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'session_board_item_upsert' },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","itemId":"release-checklist","expectedItemRevision":null,"item":{"v":1,"title":"Release checklist","frame":"card","height":{"mode":"auto","fallback":"regular"},"source":{"kind":"declarative","document":{"version":1,"root":{"kind":"markdown","text":"# Release checklist"}}}},"placement":{"tabId":"overview","tabTitle":"Overview","width":"wide"}}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Save a Board item',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
        { path: 'item', title: 'Item', widget: 'json', required: true },
        { path: 'placement', title: 'Placement', widget: 'json' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.item.upsert'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.item.upsert'],
    cli: SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION,
  },
  {
    id: 'session.board.item.remove',
    title: 'Remove a Board item',
    description: 'Remove one Session Board item and every placement of it. All Session readers lose the item; installed plugins are unaffected.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_board_item_remove' },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","itemId":"release-checklist","expectedItemRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ","expectedLayoutRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ"}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Remove a Board item',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
        { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.item.remove'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.item.remove'],
    cli: SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION,
  },
  {
    id: 'session.board.layout.update',
    title: 'Organize the Session Board',
    description: 'Apply exactly one semantic Board organization change: create, rename, move or remove a view, or place, move, unpin, resize or set a shared frame style on an item placement. Frame styles are card or plain; null clears the override. Moves use stable sibling anchors, never indices.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'session_board_layout_update' },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","expectedLayoutRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ","operation":{"op":"item.move","itemId":"release-checklist","fromTabId":"overview","toTabId":"metrics","anchor":{"side":"before","itemId":"burndown"}}}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Organize the Board',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text', required: true },
        { path: 'operation', title: 'Layout operation', widget: 'json', required: true },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.layout.update'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.layout.update'],
    cli: SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION,
  },

  // The Session-owned human discussion family. People reach these through the UI
  // and CLI executors; an Agent reaches the reads and the deliberate post through
  // the same rows under its own admitted execution principal. Discussion content
  // is sealed and opened by the executor through the existing Session cipher, so
  // these inputs carry strict semantic plaintext and never the storage envelope.
  {
    id: 'session.discussion.list',
    title: 'List Session discussions',
    description: 'List the human discussions attached to a Session, newest activity first. Titles are opened locally; unread and mention counts are the caller’s own private facts.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'session_discussion_list' },
    serverTransport: { method: 'GET', path: SESSION_DISCUSSION_HTTP_PATHS_V1.collection },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","state":"active","limit":30}' },
    },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'List discussions',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'state', title: 'State', widget: 'text' },
        { path: 'cursor', title: 'Page cursor', widget: 'text' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.list'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.list'],
    cli: SESSION_DISCUSSION_LIST_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.get',
    title: 'Read one Session discussion',
    description: 'Read one human discussion’s opened title, activity, capabilities and the caller’s private unread facts. It returns no message bodies.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'session_discussion_get' },
    serverTransport: { method: 'GET', path: SESSION_DISCUSSION_HTTP_PATHS_V1.discussion },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","discussionId":"{{discussionId}}"}' },
    },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Read a discussion',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.get'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.get'],
    cli: SESSION_DISCUSSION_GET_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.read',
    title: 'Read discussion messages',
    description: 'Read one bounded page of a discussion’s authored human messages, opened locally. Reading never advances the caller’s private read cursor.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'session_discussion_read' },
    serverTransport: { method: 'GET', path: SESSION_DISCUSSION_HTTP_PATHS_V1.messages },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","discussionId":"{{discussionId}}","limit":30}' },
    },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Read discussion messages',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'beforeSeq', title: 'Before sequence', widget: 'integer' },
        { path: 'afterSeq', title: 'After sequence', widget: 'integer' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.read'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.read'],
    cli: SESSION_DISCUSSION_READ_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.create',
    title: 'Start a Session discussion',
    description: 'Start one human discussion with its title and first message in a single atomic write. Agent and MCP management surfaces remain disabled.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    serverTransport: { method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.collection },
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: {
      title: 'Start a discussion',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'firstMessage', title: 'First message', widget: 'json', required: true },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.create'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.create'],
    cli: SESSION_DISCUSSION_CREATE_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.post',
    title: 'Post a discussion message',
    description: 'Post one authored message to a human discussion. Every Session collaborator sees it. An Agent posts under its own authenticated execution Account with visible “via agent” attribution; it never posts as the person who asked.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_discussion_post' },
    serverTransport: { method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.messages },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","discussionId":"{{discussionId}}","content":{"v":1,"parts":[{"t":"text","text":"Migration is green on all three providers."}]}}' },
    },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Post to a discussion',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'content', title: 'Message', widget: 'json', required: true },
        { path: 'mentionedAccountIds', title: 'Mentioned Account ids', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.post'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.post'],
    cli: SESSION_DISCUSSION_POST_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.rename',
    title: 'Rename a discussion',
    description: 'Change one human discussion’s title. It does not reorder the discussion or touch its messages.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    serverTransport: { method: 'PATCH', path: SESSION_DISCUSSION_HTTP_PATHS_V1.discussion },
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: {
      title: 'Rename a discussion',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.rename'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.rename'],
    cli: SESSION_DISCUSSION_RENAME_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.archive',
    title: 'Archive a discussion',
    description: 'Archive one human discussion. It stays readable and restorable; new posts and title changes stop.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    serverTransport: { method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.archive },
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: {
      title: 'Archive a discussion',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.archive'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.archive'],
    cli: SESSION_DISCUSSION_ARCHIVE_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.restore',
    title: 'Restore a discussion',
    description: 'Restore one archived human discussion so it accepts posts again.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    serverTransport: { method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.restore },
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: {
      title: 'Restore a discussion',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.restore'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.restore'],
    cli: SESSION_DISCUSSION_RESTORE_CLI_PROJECTION,
  },
  {
    id: 'session.discussion.read_state.set',
    title: 'Mark a discussion read',
    description: 'Advance the caller’s own private read position in a discussion. Agent and MCP callers cannot acknowledge a person’s read position.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    serverTransport: { method: 'PUT', path: SESSION_DISCUSSION_HTTP_PATHS_V1.read },
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: {
      title: 'Mark a discussion read',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'lastReadSeq', title: 'Last read sequence', widget: 'integer', required: true },
      ],
    },
    outputSchema: SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['session.discussion.read_state.set'],
    inputSchema: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1['session.discussion.read_state.set'],
    cli: SESSION_DISCUSSION_READ_STATE_SET_CLI_PROJECTION,
  },
  {
    id: 'session.title.set',
    title: 'Set session title',
    description: 'Set the title (summary text) shown for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_title_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","title":"Fix flaky tests"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set title',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTitleSetInputSchema,
    cli: SESSION_TITLE_SET_CLI_PROJECTION,
  },
  {
    id: 'session.permission_mode.set',
    title: 'Set session permission mode',
    description: `Update the permission intent (${SESSION_PERMISSION_INTENT_INPUTS.join('/')}) for the specified session. Compatible aliases are accepted.`,
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_permission_mode_set', rpcMethod: 'session.permission_mode.set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","permissionMode":"read_only"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Set permission mode',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPermissionModeSetInputSchema,
    cli: SESSION_PERMISSION_MODE_SET_CLI_PROJECTION,
  },
  {
    id: 'session.model.set',
    title: 'Set session model',
    description: 'Set the model override for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_model_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","modelId":"default"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set session model',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'modelId', title: 'Model id', widget: 'text', required: true },
        { path: 'providerConnectionId', title: 'Provider connection id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModelSetInputSchema,
    cli: SESSION_MODEL_SET_CLI_PROJECTION,
  },
  {
    id: 'session.archive',
    title: 'Archive session',
    description: 'Archive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_archive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Archive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
    cli: SESSION_ARCHIVE_CLI_PROJECTION,
  },
  {
    id: 'session.delete',
    title: 'Delete session',
    description: 'Permanently delete a session. Its daemon removes managed folders through the durable deletion lifecycle.',
    safety: 'danger', sideEffectClass: 'danger', placements: [],
    bindings: { mcpToolName: 'session_delete' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'DELETE', path: '/v1/sessions/:sessionId' },
    inputSchema: lazyZodSchema(() => z.object({ sessionId: z.string().trim().min(1) }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ success: z.literal(true) }).strict()),
    inputHints: { title: 'Delete a session', fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }] },
    cli: { commands: [{ path: ['session', 'delete'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.folder.set',
    title: 'Assign session folder',
    description: 'Assign a session to an existing organization folder, or clear its assignment with null.',
    safety: 'safe', sideEffectClass: 'external', placements: [],
    bindings: { mcpToolName: 'session_folder_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'PUT', path: '/v2/session-organization/folder-assignments/:sessionId' },
    inputSchema: lazyZodSchema(() => SetSessionFolderAssignmentRequestSchema.extend({ sessionId: z.string().trim().min(1) })),
    outputSchema: SetSessionFolderAssignmentResponseSchema,
    inputHints: { title: 'Assign session folder', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'folderId', title: 'Folder id, or null to clear', widget: 'text', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'folder', 'set'], positionals: ['sessionId', 'folderId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.tags.set',
    title: 'Assign session tags',
    description: 'Replace a session’s tag assignments with existing organization tag ids; an empty list clears them.',
    safety: 'safe', sideEffectClass: 'external', placements: [],
    bindings: { mcpToolName: 'session_tags_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'PUT', path: '/v2/session-organization/tag-assignments/:sessionId' },
    inputSchema: lazyZodSchema(() => SetSessionTagAssignmentsRequestSchema.extend({ sessionId: z.string().trim().min(1) })),
    outputSchema: SetSessionTagAssignmentsResponseSchema,
    inputHints: { title: 'Assign session tags', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'tagIds', title: 'Tag ids', widget: 'textarea', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'tags', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.unarchive',
    title: 'Unarchive session',
    description: 'Unarchive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_unarchive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Unarchive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
    cli: SESSION_UNARCHIVE_CLI_PROJECTION,
  },
  {
    id: 'session.status.get',
    title: 'Get session status',
    description: 'Get summary status for a session, optionally refreshing live agent state.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_status_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","live":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session status',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'live', title: 'Live', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionStatusGetInputSchema,
    cli: SESSION_STATUS_GET_CLI_PROJECTION,
  },
  {
    id: 'session.work_state.get',
    title: 'Get session work state',
    description: 'Get the normalized current goal, task, and todo snapshot for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_work_state_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session work state',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.get',
    title: 'Get session goal',
    description: 'Get the editable session goal when the provider supports native goals.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_goal_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session goal',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.set',
    title: 'Set session goal',
    description: 'Set or update the native session goal.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_goal_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","objective":"Ship goal controls"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Set session goal',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'objective', title: 'Objective', widget: 'textarea' },
        { path: 'status', title: 'Status', widget: 'text' },
        { path: 'tokenBudget', title: 'Token budget', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionGoalSetInputSchema,
  },
  {
    id: 'session.goal.clear',
    title: 'Clear session goal',
    description: 'Clear the native session goal.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_goal_clear' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Clear session goal',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.access.grants.list',
    title: 'List Session access',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grants', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grants_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionAccessGrantsListResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/list' },
  },
  {
    id: 'session.access.grant.set',
    title: 'Set Session access',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grant', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grant_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [] },
    inputSchema: SessionAccessGrantSetActionInputV1Schema,
    outputSchema: SetSessionAccessGrantResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/set' },
  },
  {
    id: 'session.access.grant.remove',
    title: 'Remove Session access',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grant', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grant_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [] },
    inputSchema: RemoveSessionAccessGrantRequestV1Schema,
    outputSchema: RemoveSessionAccessGrantResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/remove' },
  },
  {
    id: 'session.access.context.set',
    title: 'Set Session Team context',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'context', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_context_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [] },
    inputSchema: SetSessionAccessContextRequestV1Schema,
    outputSchema: SetSessionAccessContextResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-context/set' },
  },
  {
    id: 'session.reports_to.set',
    title: 'Set Session lead',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'reports-to', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_reports_to_set' },
    examples: { voice: { argsExample: '{"sessionId":"{{sessionId}}","leadSessionId":"lead_session","expectedLeadSessionId":null}' } },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session', widget: 'text' },
      { path: 'leadSessionId', title: 'Lead Session (null to detach)', widget: 'text' },
      { path: 'expectedLeadSessionId', title: 'Expected current lead', widget: 'text' },
    ] },
    inputSchema: SessionReportsToSetActionInputV1Schema,
    outputSchema: SessionReportsToSetResultV1Schema,
    serverTransport: { method: 'POST', path: '/v1/sessions/:sessionId/reports-to' },
  },
  {
    id: 'session.responsibility.set',
    title: 'Assign Session responsibility',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'responsibility', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_responsibility_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [] },
    inputSchema: SetSessionResponsibilityRequestSchema,
    outputSchema: SetSessionResponsibilityResponseSchema,
    serverTransport: { method: 'POST', path: '/v2/sessions/responsibility/set' },
  },
  {
    id: 'session.responsibility.candidates.list',
    title: 'Find Session responsibility candidates',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'responsibility', 'candidates', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_responsibility_candidates_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionResponsibilityCandidatesRequestSchema,
    outputSchema: SessionResponsibilityCandidatesResponseSchema,
    serverTransport: { method: 'POST', path: '/v2/sessions/responsibility/candidates' },
  },
  {
    id: 'session.public_link.get',
    title: 'Get Session public link settings',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionPublicLinkGetActionResultV1Schema,
    serverTransport: { method: 'GET', path: '/v1/sessions/:sessionId/public-share' },
  },
  {
    id: 'session.public_link.create',
    projectObservationOutput: projectPublicLinkCreationObservation,
    title: 'Create Session public link',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'create'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_create' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [] },
    inputSchema: SessionPublicLinkCreateActionInputV1Schema,
    outputSchema: SessionPublicLinkCreateActionResultV1Schema,
    serverTransport: { method: 'POST', path: '/v1/public-shares' },
  },
  {
    id: 'session.public_link.remove',
    title: 'Remove Session public link',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionPublicLinkRemoveActionResultV1Schema,
    serverTransport: { method: 'DELETE', path: '/v1/sessions/:sessionId/public-share' },
  },
  {
    id: 'session.follow.get',
    title: 'Get Session Follow',
    description: 'Get Session Follow for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'follow', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.get'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.get'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  },
  {
    id: 'session.follow.set',
    title: 'Set Session Follow',
    description: 'Set Session Follow for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'follow', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  },
  {
    id: 'session.follow.remove',
    title: 'Remove Session Follow',
    description: 'Remove Session Follow for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'follow', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.remove'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.remove'],
    serverTransport: { method: 'DELETE', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  },
  {
    id: 'session.follow.preferences.get',
    title: 'Get Follow defaults',
    description: 'Get Follow defaults for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'follow', 'preferences', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_preferences_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.preferences.get'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.preferences.get'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences },
  },
  {
    id: 'session.follow.preferences.set',
    title: 'Set Follow defaults',
    description: 'Set Follow defaults for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: {
      commands: [{ path: ['session', 'follow', 'preferences', 'set'], visibility: 'canonical' }],
      inputSchema: SessionFollowPreferencesCliInputSchema,
      bindInput: (value) => {
        const input = SessionFollowPreferencesCliInputSchema.parse(value);
        return { assigned: input.assigned === 'on', direct: input.direct === 'on', team: input.team === 'on', group: input.group === 'on' };
      },
    },
    placements: [],
    bindings: { mcpToolName: 'session_follow_preferences_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.preferences.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.preferences.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences },
  },
  {
    id: 'session.follow.sources.list',
    title: 'List followed sessions',
    description: 'List the sessions whose updates are included with this session\'s next turn.',
    safety: 'safe',
    cli: { commands: [{ path: ['session', 'follow', 'sources', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_sources_list' },
    examples: {
      mcp: { argsExample: '{"destinationSessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List followed sessions',
      fields: [{ path: 'destinationSessionId', title: 'Destination session id', widget: 'text', required: true }],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.sources.list'],
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.sources.list'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list },
  },
  {
    id: 'session.follow.sources.set',
    title: 'Send updates from another session',
    description: 'Include another authorized session\'s updates as context on this session\'s next turn.',
    safety: 'danger',
    cli: { commands: [{ path: ['session', 'follow', 'sources', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_sources_set' },
    examples: {
      mcp: { argsExample: '{"destinationSessionId":"{{sessionId}}","sourceSessionId":"{{sourceSessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Send updates from another session',
      fields: [
        { path: 'destinationSessionId', title: 'Destination session id', widget: 'text', required: true },
        { path: 'sourceSessionId', title: 'Source session id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.sources.set'],
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.sources.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.source },
  },
  {
    id: 'session.follow.sources.remove',
    title: 'Stop updates from another session',
    description: 'Stop including another session\'s updates. Following again later starts from the current state.',
    safety: 'danger',
    cli: { commands: [{ path: ['session', 'follow', 'sources', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_follow_sources_remove' },
    examples: {
      mcp: { argsExample: '{"destinationSessionId":"{{sessionId}}","sourceSessionId":"{{sourceSessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Stop updates from another session',
      fields: [
        { path: 'destinationSessionId', title: 'Destination session id', widget: 'text', required: true },
        { path: 'sourceSessionId', title: 'Source session id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['session.follow.sources.remove'],
    inputSchema: SessionFollowActionInputSchemasV1['session.follow.sources.remove'],
    serverTransport: { method: 'DELETE', path: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.source },
  },
  {
    id: 'session.read_state.set',
    title: 'Mark a session read',
    description: 'Set the caller\u2019s own private read position in a session. Does not resolve approvals, mentions or human attention.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_read_state_set' },
    sideEffectClass: 'write',
    inputHints: {
      title: 'Mark a session read',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'state', title: 'Read state', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1['session.read_state.set'],
    inputSchema: SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1['session.read_state.set'],
    cli: SESSION_READ_STATE_SET_CLI_PROJECTION,
    serverTransport: { method: 'POST', path: SESSION_READ_STATE_HTTP_PATHS_V1.set },
  },
  {
    id: 'session.usageLimit.waitResume.enable',
    title: 'Enable usage-limit wait resume',
    description: 'Arm a durable intent to continue a session when a provider usage limit is lifted.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_enable' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","remember":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Enable usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'remember', title: 'Remember', widget: 'boolean' },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeEnableRequestV1Schema,
  },
  {
    id: 'session.usageLimit.waitResume.cancel',
    title: 'Cancel usage-limit wait resume',
    description: 'Cancel the active usage-limit wait/resume intent for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_cancel' },
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","issueFingerprint":"usage-limit:provider:turn:1:no-reset","armedAtMs":1000,"runtimeAuthRecoveryAttemptId":"runtime-auth-attempt-1"}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Cancel usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'armedAtMs', title: 'Armed at (ms)', widget: 'number' },
        { path: 'runtimeAuthRecoveryAttemptId', title: 'Runtime auth recovery attempt id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeCancelRequestV1Schema,
  },
  {
    id: 'session.usageLimit.checkNow',
    title: 'Check usage-limit recovery now',
    description: 'Ask the session runtime to perform a safe provider-owned usage-limit recovery check.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_check_now' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Check usage-limit recovery now',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'operation',
          title: 'Operation',
          widget: 'select',
          options: [
            { value: 'check_now', label: 'Check now' },
            { value: 'switch_account_now', label: 'Switch account now' },
          ],
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitCheckNowRequestV1Schema,
  },
  {
    id: 'session.usageLimit.consumeResetCredit',
    title: 'Apply usage-limit reset credit',
    description: 'Ask the session runtime to spend a connected-service reset credit for usage-limit recovery.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_consume_reset_credit' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Apply reset credit',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitConsumeResetCreditRequestV1Schema,
  },
  {
    id: 'session.vendor_plugin_catalog.list',
    title: 'List session vendor plugins',
    description: 'List provider-owned vendor plugins available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_vendor_plugin_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List vendor plugins',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionVendorPluginCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.skill_catalog.list',
    title: 'List session skills',
    description: 'List provider-visible skills available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_skill_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List skills',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionSkillCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.history.get',
    title: 'Get session history',
    description: 'DEPRECATED: use session_events_get. Returns diagnostic session events with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_history_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"format":"compact"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get session history',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        {
          path: 'format',
          title: 'Format',
          widget: 'select',
          options: [
            { value: 'compact', label: 'Compact' },
            { value: 'raw', label: 'Raw' },
          ],
        },
        { path: 'includeMeta', title: 'Include meta', widget: 'boolean' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHistoryGetInputSchema,
  },
  {
    id: 'session.transcript.get',
    title: 'Get session transcript',
    sideEffectClass: 'read',
    description: 'Read the semantic transcript for a session as clean user/assistant messages with optional tool/reasoning/event flags.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionTranscript', mcpToolName: 'session_transcript_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'direction',
          title: 'Direction',
          description: 'Page away from the cursor: before reads older items (the default), after reads newer ones.',
          widget: 'select',
          options: [
            { value: 'before', label: 'Before cursor (older)' },
            { value: 'after', label: 'After cursor (newer)' },
          ],
        },
        {
          path: 'maxCharsPerMessage',
          title: 'Message truncation chars',
          description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
          widget: 'text',
        },
      ],
    },
    outputSchema: SessionTranscriptGetResultSchema,
    inputSchema: SessionTranscriptGetInputSchema,
    surfaceBindings: {
      api: {
        inputSchema: SessionTranscriptGetPublicInputSchema,
        outputSchema: SessionTranscriptGetResultSchema,
      },
      plugin: {
        inputSchema: SessionTranscriptGetExternalShareableInputV1Schema,
        outputSchema: SessionTranscriptGetExternalShareableResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.events.get',
    title: 'Get session events',
    description: 'Inspect raw session events (tool calls, tool results, token counts, lifecycle, permission, stream, session events) for diagnostics. Use session_transcript_get for normal transcript reading.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_events_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}' },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get session events',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionEventsGetInputSchema,
  },
  {
    id: 'session.wait.idle',
    title: 'Wait for session idle',
    description: 'Wait until the session becomes idle or the timeout elapses.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'session_wait_idle' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","timeoutSeconds":300}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Wait for idle',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds', widget: 'text' },
      ],
    },
    outputSchema: SessionWaitIdleResultSchema,
    inputSchema: SessionWaitIdleInputSchema,
    cli: SESSION_WAIT_IDLE_CLI_PROJECTION,
    surfaceBindings: {
      api: {
        inputSchema: SessionWaitIdlePublicInputSchema,
        outputSchema: SessionWaitIdleResultSchema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.permission.respond',
    title: 'Respond to permission request',
    sideEffectClass: 'write',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.respond' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Respond to permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        { path: 'turnId', title: 'Turn id', widget: 'text' },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionPermissionRespondInputSchema,
  },
  {
    id: 'session.approval_reviewer.set',
    title: 'Set session approval reviewer',
    description: 'Enable or disable request-only background approval review for this session.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'present_user',
    placements: [],
    surfaces: { ui: true, cli: true, agent: false, mcp: false, voice: false, rpc: false },
    inputHints: { title: 'Set session approval reviewer', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.object({ sessionId: z.string().trim().min(1), enabled: z.boolean() }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ updated: z.literal(true) }).strict()),
  },
  {
    id: 'session.attention.set',
    title: 'Settle or snooze a session',
    description: 'Write the caller\u2019s own Inbox attention standing for a session: settle it (standing false), keep it standing, or snooze it until a time (remindAt). Settle pairs with session.read_state.set. Agent calls use the normal Action approval policy.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, cli: true, voice: true, agent: true, mcp: false, rpc: false },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","standing":false}' },
    },
    inputHints: {
      title: 'Settle or snooze a session',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'standing', title: 'Keep in Needs you', widget: 'boolean' },
        { path: 'remindAt', title: 'Snooze until (epoch ms)', widget: 'integer' },
      ],
    },
    inputSchema: SessionAttentionSetInputV1Schema,
    outputSchema: SessionAttentionSetResultV1Schema,
    serverTransport: { method: 'PUT', path: SESSION_ATTENTION_STANDING_HTTP_PATH_V1 },
  },
  {
    id: 'session.permission.remote.pending.list',
    title: 'List remotely mediated permission requests',
    sideEffectClass: 'read',
    description: 'List the caller mediator’s current permission requests for one exact source authority.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'List remotely mediated permission requests',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemotePendingListOutputV1Schema,
    inputSchema: SessionPermissionRemotePendingListInputV1Schema,
  },
  {
    id: 'session.permission.remote.respond',
    title: 'Respond to a remotely mediated permission request',
    sideEffectClass: 'write',
    description: 'Submit an attributed external-human decision for one current permission request.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Respond to a remotely mediated permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'idempotencyKey', title: 'Idempotency key', widget: 'text', required: true },
        { path: 'actor.namespace', title: 'External principal namespace', widget: 'text', required: true },
        { path: 'actor.principalId', title: 'External principal id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'request', label: 'This request' },
            { value: 'session', label: 'This session' },
          ],
        },
      ],
    },
    outputSchema: SessionPermissionRemoteRespondOutputV1Schema,
    inputSchema: SessionPermissionRemoteRespondInputV1Schema,
  },
  {
    id: 'session.user_action.remote.answer',
    title: 'Answer a remotely mediated user-action request',
    sideEffectClass: 'write',
    description: 'Submit bounded indexed answers for one current source-bound AskUserQuestion request.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Answer a remotely mediated user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'answers', title: 'Indexed answers', widget: 'json', required: true },
      ],
    },
    outputSchema: SessionUserActionRemoteAnswerOutputV1Schema,
    inputSchema: SessionUserActionRemoteAnswerInputV1Schema,
  },
  {
    id: 'session.permission.remote.grants.list',
    title: 'List remotely mediated permission grants',
    sideEffectClass: 'read',
    description: 'List source-scoped remote permission grants visible to the authenticated caller.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'List remotely mediated permission grants',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Maximum grants', widget: 'text' },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantsListOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantsListInputV1Schema,
  },
  {
    id: 'session.permission.remote.grants.revoke',
    title: 'Revoke a remotely mediated permission grant',
    sideEffectClass: 'write',
    description: 'Revoke one source-scoped remote permission grant.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.revoke' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Revoke a remotely mediated permission grant',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'grantId', title: 'Grant id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantRevokeOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantRevokeInputV1Schema,
  },
  {
    id: 'session.user_action.answer',
    title: 'Respond to user-action request',
    sideEffectClass: 'write',
    description: 'Approve, reject, request changes, or provide structured answers for an active user-action request.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest', mcpToolName: 'session_user_action_answer', rpcMethod: 'session.user_action.answer' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","values":["Yes"]}]}',
      },
    },
    surfaceBindings: {
      plugin: {
        inputSchema: SessionUserActionAnswerPluginInputSchema,
        bindInput: bindPluginCurrentSessionInput,
        projectOutput: projectPluginSessionInteractionResponse,
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Respond to user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          description: 'Use approve or reject for general user actions, or request_changes when you need the coding assistant to revise something first.',
          widget: 'select',
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'request_changes', label: 'Request changes' },
          ],
        },
        {
          path: 'reason',
          title: 'Reason',
          description: 'Required when requesting changes. Optional extra context for a rejection.',
          widget: 'textarea',
        },
        {
          path: 'answers',
          title: 'Answers',
          description: 'Structured answers for question-style user-action requests such as AskUserQuestion.',
          widget: 'json',
        },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionUserActionAnswerInputSchema,
  },
  {
    id: 'session.mode.set',
    title: 'Set session mode',
    sideEffectClass: 'write',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setSessionMode', mcpToolName: 'session_mode_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","modeId":"plan"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set session mode',
      fields: [
        { path: 'sessionId', title: 'Session id', description: 'Optional when the active target session is already correct.', widget: 'text' },
        {
          path: 'modeId',
          title: 'Mode id',
          description: 'Use default to clear the override and return to the provider default mode.',
          widget: 'select',
          required: true,
          optionsSourceId: 'session.modes.available',
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModeSetInputSchema,
  },
  {
    id: 'session.target.primary.set',
    title: 'Set primary action session',
    sideEffectClass: 'write',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setPrimaryActionSession', mcpToolName: 'session_target_primary_set' },
    examples: {
      voice: { argsExample: '{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'Set primary action session',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text' },
        { path: 'sessionId', title: 'Session id (or null)', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPrimaryTargetInputSchema,
  },
  {
    id: 'session.target.tracked.set',
    title: 'Set Include in Voice sessions',
    sideEffectClass: 'write',
    description: 'Set which sessions are included in Voice through Account Follow.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions', mcpToolName: 'session_target_tracked_set' },
    examples: {
      voice: { argsExample: '{"sessionAddresses":[{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}]}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set Include in Voice sessions',
      fields: [{ path: 'sessionIds', title: 'Session ids', widget: 'text_list', required: true, listSeparator: 'comma' }],
    },
    outputSchema: VoiceTrackedTargetsActionResultV1Schema,
    inputSchema: SessionTrackedTargetsInputSchema,
  },
  {
    id: 'session.list',
    title: 'List sessions',
    sideEffectClass: 'read',
    description: 'List recent sessions the user can target.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions', mcpToolName: 'session_list' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List sessions',
      fields: [
        {
          // The representation selector belongs to the canonical form hints so every generated
          // UI/CLI/SDK/MCP projection offers the same choice instead of adding a local control.
          path: 'view',
          title: 'View',
          description: 'Summary rows, or the marked operational awareness projection.',
          widget: 'select',
          options: SESSION_VIEW_INPUT_OPTIONS,
        },
        { path: 'underSessionId', title: 'Session led subtree', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'boolean' },
      ],
    },
    outputSchema: SessionListActionResultV1Schema,
    inputSchema: SessionListActionInputV1Schema,
    cli: SESSION_LIST_CLI_PROJECTION,
  },
  {
    id: 'session.activity.get',
    title: 'Get session activity',
    sideEffectClass: 'read',
    description: 'Get a short activity digest for a session without transcript content.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionActivity', mcpToolName: 'session_activity_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get session activity',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          // Same canonical selector as `session.list`: every generated UI/CLI/SDK/MCP projection
          // offers awareness here instead of a caller composing it from a local digest.
          path: 'view',
          title: 'View',
          description: 'The released activity digest, or the canonical awareness projection.',
          widget: 'select',
          options: SESSION_VIEW_INPUT_OPTIONS,
        },
        { path: 'windowSeconds', title: 'Window seconds', widget: 'text' },
      ],
    },
    outputSchema: SessionActivityActionResultV1Schema,
    inputSchema: SessionActivityInputSchema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionActivityInputSchema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return {
        sessionId,
        ...(parsed.data.windowSeconds !== undefined ? { windowSeconds: parsed.data.windowSeconds } : {}),
      };
    },
  },
  {
    id: 'session.messages.recent.get',
    title: 'Get recent messages',
    description: 'DEPRECATED: use session_transcript_get. Returns semantic transcript items with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'getSessionRecentMessages', mcpToolName: 'session_messages_recent_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
      },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get recent messages',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeUser', title: 'Include user', widget: 'boolean' },
        { path: 'includeAssistant', title: 'Include assistant', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRecentMessagesInputSchema,
  },
  {
    id: 'ui.voice_global.reset',
    title: 'Reset voice agent',
    sideEffectClass: 'write',
    safety: 'danger',
    executionPlacement: 'client',
    requiredAuthority: 'account_automation',
    placements: ['voice_panel', 'command_palette', 'slash_command'],
    slash: { tokens: ['/h.voice.reset'] },
    bindings: { voiceClientToolName: 'resetGlobalVoiceAgent', mcpToolName: 'ui_voice_global_reset' },
    inputHints: {
      title: 'Reset voice agent',
      description: 'Reset the global voice agent state (clears the current voice conversation).',
      fields: [],
    },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.pet.choose',
    title: 'Choose pet',
    description: 'Open pet settings so the user can choose or manage their companion.',
    safety: 'safe',
    placements: ['slash_command'],
    slash: { tokens: ['/pet', '/h.pet'] },
    inputHints: {
      title: 'Choose pet',
      description: 'Open pet settings.',
      fields: [],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.voice_agent.teleport',
    title: 'Teleport voice agent to session root',
    sideEffectClass: 'write',
    description: 'Move the daemon-backed voice agent into the current or specified session root.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'teleportVoiceAgentToSessionRoot' },
    inputHints: {
      title: 'Teleport voice agent',
      description: 'Teleport the active voice agent into a session root. Defaults to the current action session when omitted.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: OptionalSessionIdInputSchema,
  },
  {
    id: 'ui.current_context.read',
    title: 'Read current UI context',
    description: 'Read the current local UI navigation context and its bounded opaque command descriptors.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'readCurrentUiContext', mcpToolName: 'read_current_ui_context' },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Read current UI context',
      description: 'Returns only the current local navigation snapshot and opaque command descriptors.',
      fields: [],
    },
    outputSchema: CurrentUiContextSnapshotV1Schema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.current_context.command.invoke',
    title: 'Invoke current UI command',
    description: 'Invoke one currently available opaque command from the local current UI context. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'invokeCurrentUiCommand', mcpToolName: 'invoke_current_ui_command' },
    examples: {
      voice: { argsExample: '{"commandId":"current-ui:1:0"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Invoke current UI command',
      description: 'Use only an opaque command id returned by readCurrentUiContext; semantic command data is never accepted here.',
      fields: [
        { path: 'commandId', title: 'Opaque command id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: CurrentUiContextCommandInvokeInputSchema,
  },
  {
    id: 'memory.search',
    title: 'Search memory',
    sideEffectClass: 'read',
    description: 'Search the local daemon memory index (opt-in).',
    safety: 'safe',
    placements: ['voice_panel', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'memorySearch', mcpToolName: 'memory_search' },
    inputHints: {
      title: 'Search memory',
      description: 'Search across sessions using the daemon-local memory index.',
      fields: [
        {
          path: 'machineId',
          title: 'Machine id',
          description: 'Machine running the daemon memory index.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.query',
          title: 'Query',
          description: 'What to search for.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.mode',
          title: 'Mode',
          description: 'Which index to search.',
          widget: 'select',
          required: true,
          options: [
            { value: 'hints', label: 'Hints' },
            { value: 'deep', label: 'Deep' },
            { value: 'auto', label: 'Auto' },
          ],
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: MemorySearchResultV1Schema,
    inputSchema: MemorySearchInputSchema,
  },
  {
    id: 'memory.get_window',
    title: 'Get memory window',
    sideEffectClass: 'read',
    description: 'Fetch and decrypt a transcript window (used to verify/quote a memory hit).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryGetWindow', mcpToolName: 'memory_get_window' },
    inputHints: {
      title: 'Get memory window',
      description: 'Fetch and decrypt a message range from a specific session.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'seqFrom', title: 'Seq from', widget: 'text', required: true },
        { path: 'seqTo', title: 'Seq to', widget: 'text', required: true },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
    },
    outputSchema: MemoryWindowV1Schema,
    inputSchema: MemoryGetWindowInputSchema,
  },
  {
    id: 'memory.ensure_up_to_date',
    title: 'Ensure memory up to date',
    sideEffectClass: 'write',
    description: 'Trigger the daemon to sync memory hints for a session (or all active sessions).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryEnsureUpToDate', mcpToolName: 'memory_ensure_up_to_date' },
    inputHints: {
      title: 'Ensure memory up to date',
      description: 'Forces the daemon memory worker to process new transcript content.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id (optional)', widget: 'text' },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
    },
    outputSchema: MemoryEnsureUpToDateOutputSchema,
    inputSchema: MemoryEnsureUpToDateInputSchema,
  },
  {
    id: 'agents.acp.backends.upsert',
    title: 'Save custom ACP agent',
    description: 'Add or replace one custom ACP agent (a command that speaks the Agent Client Protocol) in the Account agent catalog. Names must be unique; an existing id is replaced.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_upsert' },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    outputSchema: AgentsAcpBackendsUpsertOutputV1Schema,
    inputSchema: AgentsAcpBackendsUpsertInputV1Schema,
    inputHints: {
      title: 'Save custom ACP agent',
      fields: [
        { path: 'backend.id', title: 'Id', widget: 'text', required: true },
        { path: 'backend.name', title: 'Name', widget: 'text', required: true },
        { path: 'backend.title', title: 'Title', widget: 'text', required: true },
        { path: 'backend.command', title: 'Command', widget: 'text', required: true },
        { path: 'backend.args', title: 'Arguments', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'agents.acp.backends.delete',
    title: 'Delete custom ACP agent',
    description: 'Remove one custom ACP agent from the Account agent catalog.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_delete' },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    outputSchema: AgentsAcpBackendsDeleteOutputV1Schema,
    inputSchema: AgentsAcpBackendsDeleteInputV1Schema,
    inputHints: {
      title: 'Delete custom ACP agent',
      fields: [
        { path: 'backendId', title: 'Id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'prompt_doc.get',
    title: 'Read prompt document',
    description: 'Read the current Account-private prompt document, including workstream memory, by its Artifact reference.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.object({ artifactId: z.string().min(1) }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ ok: z.literal(true), artifactId: z.string().min(1), title: z.string().min(1), markdown: z.string() }).strict()),
    inputHints: { title: 'Read prompt document', fields: [
      { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
    ] },
  },
  {
    id: 'prompt_doc.create',
    title: 'Create prompt document',
    description: 'Create an Account-private prompt document in the Happier prompt library.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_create' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.object({ title: z.string().min(1), markdown: z.string(), folderId: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(), favorite: z.boolean().optional() }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ ok: z.literal(true), artifactId: z.string().min(1) }).strict()),
    inputHints: { title: 'Create prompt document', fields: [
      { path: 'title', title: 'Title', widget: 'text', required: true },
      { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true },
      { path: 'folderId', title: 'Folder id', widget: 'text' },
      { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      { path: 'favorite', title: 'Favourite', widget: 'boolean' },
    ] },
  },
  {
    id: 'prompt_doc.favorite.set',
    title: 'Set prompt favourite',
    description: 'Set a prompt document favourite without changing its content.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_favorite_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.object({ artifactId: z.string().min(1), favorite: z.boolean() }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ ok: z.literal(true), artifactId: z.string().min(1) }).strict()),
    inputHints: { title: 'Set prompt favourite', fields: [
      { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
      { path: 'favorite', title: 'Favourite', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'prompts.library.list',
    title: 'List prompt library',
    description: 'List prompt document headers without fetching their bodies.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'prompts_library_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.object({ query: z.string().optional(), includeBundles: z.literal(false).optional() }).strict()),
    outputSchema: lazyZodSchema(() => z.object({ coverage: z.enum(['complete', 'partial', 'unavailable']), items: z.array(z.object({
      artifactId: z.string().min(1), title: z.string(), folderId: z.string().nullable(), tags: z.array(z.string()),
      favorite: z.boolean(), updatedAtMs: z.number(),
    }).strict()) }).strict()),
    inputHints: { title: 'List prompt library', fields: [{ path: 'query', title: 'Search', widget: 'text' }] },
  },
  {
    id: 'prompt_doc.update',
    title: 'Update prompt document',
    description: 'Update a prompt document stored in the Happier prompt library.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_update' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptDocUpdateInputSchema,
    inputHints: {
      title: 'Update prompt document',
      fields: [
        { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_bundle.update',
    title: 'Update prompt bundle',
    description: 'Update a skill bundle stored in the Happier prompt library.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptBundleUpdateInputSchema,
    inputHints: {
      title: 'Update prompt bundle',
      fields: [
        { path: 'artifactId', title: 'Bundle artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'skillMarkdown', title: 'SKILL.md markdown', widget: 'textarea', required: true },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_asset.export',
    title: 'Export prompt asset',
    description: 'Export a prompt doc or skill bundle from the Happier library to a provider-native asset.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptAssetExportInputSchema,
    inputHints: {
      title: 'Export prompt asset',
      fields: [
        { path: 'artifactId', title: 'Artifact id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'assetTypeId', title: 'Asset type id', widget: 'text', required: true },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
          ],
        },
        { path: 'directory', title: 'Project directory', widget: 'text' },
        { path: 'targetPath', title: 'Document path', widget: 'text' },
        { path: 'targetName', title: 'Skill name', widget: 'text' },
        {
          path: 'installMode',
          title: 'Install mode',
          widget: 'select',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'symlink', label: 'Symlink' },
          ],
        },
      ],
    },
  },
  {
    id: 'prompt_registry.install',
    title: 'Install prompt registry skill',
    description: 'Import a skill bundle from a registry and optionally export it to an external skills location.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryInstallInputSchema,
    inputHints: {
      title: 'Install prompt registry skill',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'configuredSources', title: 'Configured sources (json)', widget: 'textarea' },
        { path: 'installTarget.assetTypeId', title: 'Target asset type', widget: 'text' },
        {
          path: 'installTarget.scope',
          title: 'Target scope',
          widget: 'select',
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
          ],
        },
        { path: 'installTarget.directory', title: 'Project directory', widget: 'text' },
        { path: 'installTarget.targetName', title: 'Target skill name', widget: 'text' },
        {
          path: 'installTarget.installMode',
          title: 'Install mode',
          widget: 'select',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'symlink', label: 'Symlink' },
          ],
        },
      ],
    },
  },
  {
    id: 'daemon.promptAssets.discover',
    title: 'Discover prompt assets',
    description: 'Discover provider-native prompt assets through the daemon prompt asset adapter registry.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptAssets.discover' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptAssetDiscoverRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptAssets.delete',
    title: 'Delete prompt asset',
    description: 'Delete a provider-native prompt asset through the daemon prompt asset adapter registry.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptAssets.delete' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptAssetDeleteRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptRegistry.scanSource',
    title: 'Scan prompt registry source',
    description: 'Scan a configured prompt registry source through the daemon prompt registry adapter registry.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptRegistry.scanSource' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryScanSourceRequestV1Schema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptRegistry.install',
    title: 'Install prompt registry asset',
    description: 'Install a prompt registry item through bundle-capable prompt asset adapters.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptRegistry.install' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryInstallRequestV1Schema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.readFile',
    title: 'Read file',
    description: 'Read a bounded file through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'readFile' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemReadFileInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.writeFile',
    workspaceWrite: true,
    title: 'Write file',
    description: 'Write a bounded file through daemon filesystem path authorization.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'writeFile' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemWriteFileInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.listDirectory',
    title: 'List directory',
    description: 'List a directory through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemListDirectoryInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.getDirectoryTree',
    title: 'Get directory tree',
    description: 'Read a bounded directory tree through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'getDirectoryTree' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemGetDirectoryTreeInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.listRoots',
    title: 'List filesystem roots',
    description: 'List bounded machine file-browser roots resolved from daemon filesystem access policy.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listRoots' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.browseDirectory',
    title: 'Browse filesystem directory',
    description: 'List a machine file-browser directory constrained to a configured browse root.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemListDirectoryRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.collectDiagnostics',
    title: 'Collect bug report diagnostics',
    description: 'Collect bounded, redacted daemon diagnostics for a bug report.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.collectDiagnostics' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PassthroughEmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.getLogTail',
    title: 'Read bug report log tail',
    description: 'Read a bounded daemon log tail from diagnostics-approved candidate paths.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.getLogTail' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportGetLogTailInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.uploadArtifact',
    title: 'Upload bug report artifact',
    description: 'Return daemon-side bug report artifact upload availability without exposing secret material.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.uploadArtifact' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'none',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportUploadArtifactInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'approval.request.list',
    title: 'List approval requests',
    description: 'List approval queue entries from targeted approval artifact headers.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'approval.request.list' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestListInputSchema,
    inputHints: {
      title: 'List approval requests',
      description: 'Reads bounded approval queue metadata from artifact headers without transcript hydration.',
      fields: [
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'executed', label: 'Executed' },
            { value: 'failed', label: 'Failed' },
            { value: 'canceled', label: 'Canceled' },
          ],
        },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'approval.request.get',
    title: 'Get approval request',
    description: 'Fetch one approval request by approval artifact id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'approval.request.get' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestGetInputSchema,
    inputHints: {
      title: 'Get approval request',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'approval.request.create',
    title: 'Create approval request',
    description: 'Create an approval request for another action to run.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'approval_request_create', rpcMethod: 'approval.request.create' },
    surfaceBindings: {
      plugin: { inputSchema: PluginSurfaceApprovalRequestCreateInputSchema },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestCreateInputSchema,
    inputHints: {
      title: 'Request approval',
      description: 'Create an approval request in the global inbox.',
      fields: [
        { path: 'summary', title: 'Summary', widget: 'textarea', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'actionArgs', title: 'Action args (json)', widget: 'textarea', required: true },
      ],
    },
  },
  {
    id: 'approval.request.decide',
    projectObservationOutput: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { liveExecution: _liveExecution, ...observed } = value as Record<string, unknown>;
      return observed;
    },
    title: 'Decide approval request',
    description: 'Approve or reject an approval request.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'approval_request_decide', rpcMethod: 'approval.request.decide' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestDecideInputSchema,
    inputHints: {
      title: 'Approve or reject',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
          ],
        },
      ],
    },
  },
  {
    id: 'session.log.tail',
    title: 'Tail session log',
    description: 'Read a bounded byte tail from an allowed session log file.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSION_LOG_TAIL },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: SessionLogTailOutputSchema,
    inputSchema: SessionLogTailInputSchema,
    inputHints: {
      title: 'Tail session log',
      fields: [
        { path: 'path', title: 'Log path', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'offset', title: 'File offset', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.page',
    title: 'Page session transcript',
    description: 'Read a bounded older transcript page using cursor-backed storage.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_PAGE },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptPageOutputSchema,
    inputSchema: TranscriptPageInputSchema,
    inputHints: {
      title: 'Page session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.readAfter',
    title: 'Read session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_READ_AFTER },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptReadAfterInputSchema,
    inputHints: {
      title: 'Read session transcript after cursor',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.follow',
    title: 'Follow session transcript',
    description: 'Create or refresh a retained bounded transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_FOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptFollowOutputSchema,
    inputSchema: TranscriptFollowInputSchema,
    inputHints: {
      title: 'Follow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'idleTtlMs', title: 'Idle TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.unfollow',
    title: 'Unfollow session transcript',
    description: 'Release a retained transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_UNFOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptUnfollowOutputSchema,
    inputSchema: TranscriptUnfollowInputSchema,
    inputHints: {
      title: 'Unfollow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'transcript.import',
    title: 'Import session transcript rows',
    description: 'Import a bounded batch of transcript rows through the session transcript writer owner.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_IMPORT },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptImportOutputSchema,
    inputSchema: TranscriptImportInputSchema,
    inputHints: {
      title: 'Import session transcript rows',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'importId', title: 'Import id', widget: 'text' },
        { path: 'items', title: 'Transcript rows', widget: 'textarea', required: true },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.search',
    title: 'Search session transcript',
    description: 'Search transcript rows through bounded forward cursor reads.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_SEARCH },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptSearchInputSchema,
    inputHints: {
      title: 'Search session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'query', title: 'Query', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'maxReads', title: 'Maximum reads', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.candidates.list',
    title: 'List external session candidates',
    description: 'List attachable external session candidates through the external-session machine RPC.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY],
      sdkMethod: 'sessions.external.listCandidates',
      mcpToolName: 'sessions_external_candidates_list',
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionsCandidatesListResponseSchema,
    inputSchema: ExternalSessionsCandidatesListRequestSchema,
    inputHints: {
      title: 'List external session candidates',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'searchTerm', title: 'Search term', widget: 'text' },
        { path: 'searchTarget', title: 'Search target (metadata or content)', widget: 'text' },
        { path: 'searchMode', title: 'Metadata search mode (fast or full)', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.candidate.delete',
    title: 'Delete external session candidate',
    description: "Delete one Agent-owned session a resume-only external-session listing surfaced. The Agent's own record is removed; no Happier Session is deleted.",
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_CANDIDATE_DELETE,
      mcpToolName: 'sessions_external_candidate_delete',
      // cli-v0.2.1 / ui-web-v0.2.0 name this same operation
      // `daemon.directSessions.candidate.delete` and carry `providerId`. It is
      // the identical Agent-side deletion addressed by the identical opaque
      // identifier, so the released spelling dispatches this canonical Action
      // instead of gaining a second decision-maker; the request reader admits
      // the released identity and the registrar maps the released failure
      // literal back. Remove when no supported client or rollback target sends
      // it.
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE_LEGACY],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionCandidateDeleteResponseSchema,
    inputSchema: ExternalSessionCandidateDeleteRequestSchema,
    inputHints: {
      title: 'Delete external session candidate',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.link.ensure',
    title: 'Ensure external session link',
    description: 'Create or reuse the Happier link for an external provider session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
      mcpToolName: 'sessions_external_link_ensure',
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionLinkEnsureResponseSchema,
    inputSchema: ExternalSessionLinkEnsureRequestSchema,
    inputHints: {
      title: 'Ensure external session link',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'titleHint', title: 'Title hint', widget: 'text' },
        { path: 'directoryHint', title: 'Directory hint', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.follow',
    title: 'Follow external session lease',
    description: 'Attach an ephemeral follow lease to an external session link.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionAttachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionAttachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerFollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerFollowActionInputV1Schema,
    inputHints: {
      title: 'Follow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'ttlMs', title: 'Lease TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.unfollow',
    title: 'Unfollow external session lease',
    description: 'Detach an external-session follow lease.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionDetachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionDetachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerUnfollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerUnfollowActionInputV1Schema,
    inputHints: {
      title: 'Unfollow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.backgroundFollow.set',
    title: 'Set external session follow policy',
    description: 'Enable or disable background following for an external session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionFollowPolicySetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionFollowPolicySetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
        projectOutput: projectExternalSessionBackgroundFollowResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionBackgroundFollowActionResultV1Schema,
    inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
    inputHints: {
      title: 'Set external session follow policy',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.status.get',
    title: 'Get external session status',
    description: 'Read bounded status and takeover readiness for a linked external session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY],
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionStatusGetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionStatusGetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionStatusActionInputV1Schema,
        projectOutput: projectExternalSessionStatusResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionStatusActionResultV1Schema,
    inputSchema: ExternalSessionStatusActionInputV1Schema,
    inputHints: {
      title: 'Get external session status',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.page',
    title: 'Page external session transcript',
    description: 'Read a bounded transcript page for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY],
      sdkMethod: 'sessions.external.pageTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionTranscriptPageResponseSchema,
    inputSchema: ExternalSessionTranscriptPageRequestSchema,
    inputHints: {
      title: 'Page external session transcript',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'direction', title: 'Direction', widget: 'select', required: true, options: [
          { value: 'older', label: 'Older' },
          { value: 'newer', label: 'Newer' },
        ] },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.readAfter',
    title: 'Read external session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY],
      sdkMethod: 'sessions.external.readAfterTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: lazyZodSchema(() => z.union([
      ExternalSessionTranscriptReadAfterResponseSchema,
      ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
    ])),
    inputSchema: lazyZodSchema(() => z.union([
      ExternalSessionTranscriptReadAfterRequestSchema,
      ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
    ])),
    inputHints: {
      title: 'Read external session transcript after cursor',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.takeover',
    title: 'Take over external session',
    description: 'Move a linked external session into a Happier-managed terminal runtime.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
      rpcMethodAliases: [
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      ],
      sdkMethod: 'sessions.external.takeover.execute',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionTakeoverResultV1Schema,
    inputSchema: ExternalSessionTakeoverActionInputSchema,
    inputHints: {
      title: 'Take over external session',
      fields: [
        { path: 'linkedSessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'targetRuntimeMode', title: 'Target runtime mode', widget: 'select', required: true, options: [
          { value: 'terminal', label: 'Terminal' },
        ] },
        { path: 'storageMode', title: 'Storage mode', widget: 'select', required: true, options: [
          { value: 'external-linked', label: 'External linked' },
          { value: 'persisted', label: 'Persisted' },
        ] },
      ],
    },
  },
  // Keep this generated family out of the large suffix tuple's serialized
  // inference. Its exact schemas remain in the canonical family projection.
  ...SCM_GIT_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...COMMAND_PALETTE_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...FIND_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...PROMPT_PICKER_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...SESSION_PENDING_NEXT_ACTION_SPECS,
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL: readonly (
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX)[number]
)[] = Object.freeze([
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD,
  ...ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX,
]);

/**
 * These are plugin protocol operations, not user-selected API operations: the
 * canonical input intentionally omits the plugin identity and the existing
 * owner derives it from host-stamped plugin provenance. A PAT must never
 * manufacture that omitted identity, so these remain plugin-only until an
 * owner-local user contract exists.
 */
export const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS = Object.freeze({
  'capture.view': 'Viewing requires an exact mounted plugin caller and a live viewer occurrence.',
  'automation.event.sources.list': 'Automation source identity is selected from the host-stamped plugin caller.',
  'automation.event.admit': 'Automation event admission persists the host-stamped plugin source identity.',
  'automation.event.source.status.report': 'Automation source status is attributed to the host-stamped plugin caller.',
  'automation.conversation.targets.list': 'Automation conversation targets are selected from the host-stamped plugin caller.',
  'automation.conversation.target.verify': 'Automation conversation target verification requires host-stamped plugin provenance.',
  'automation.conversation.admit': 'Automation conversation admission persists host-stamped plugin provenance.',
  'session.permission.remote.pending.list': 'The remote-permission mediator identity comes only from the host-stamped plugin caller.',
  'session.permission.remote.respond': 'The remote-permission mediator identity comes only from the host-stamped plugin caller.',
  'session.user_action.remote.answer': 'The remote user-action mediator identity comes only from the host-stamped plugin caller.',
  'plugins.permissions.grants.revoke': 'Plugin self-revocation resolves the grant owner from the host-stamped plugin caller.',
  'plugin.webhook.endpoint.checkCorrespondence': 'Endpoint correspondence verification requires the host-stamped plugin caller; a present user administers endpoints through plugin.webhook.endpoint.read.',
  'plugin.webhook.endpoint.convergeTarget': 'Endpoint target convergence authorizes the host-stamped plugin caller against its own source correspondence; a present user administers endpoints through plugin.webhook.endpoint.retarget.',
  'sessions.external.materialize.start': 'External-session materialization persists plugin-authored intent from the host-stamped caller.',
  'scm.reviewWorkspace.materializePrepared': 'Prepared review-workspace materialization is invoked only by the host-stamped source plugin.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type PluginProvenanceOnlyActionId = keyof typeof PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS;

/**
 * Present-user operations whose canonical input contains human-entered secret
 * material. They remain available to first-party interactive UI/CLI hosts, but
 * are intentionally absent from the generic API and trusted-plugin catalogs.
 */
const CLIENT_EXECUTION_PLACEMENT_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.composer_ingress,
  ...ACTION_ID_FAMILIES_V1.workflow_authoring,
  ...ACTION_ID_FAMILIES_V1.list_reorder,
  ...ACTION_ID_FAMILIES_V1.session_organization_move,
  'account.encryption.historicalKey.forget',
  'account.encryption.automationTemplates.recover',
  ...NOTIFICATION_CONFIGURATION_ACTION_IDS,
  ...APP_UPDATE_ACTION_IDS,
  ...ACTION_ID_FAMILIES_V1.session_terminals,
  ...ACTION_ID_FAMILIES_V1.workspace_layout,
  ...APP_SHELL_ACTION_IDS,
  'connectedServices.identityPrivacy.set',
  'home.reachNudge.dismiss',
  ...SETTINGS_DECLARATION_ACTION_IDS_V1,
  'homes.connect',
  'machines.add.command',
  'machines.pairing.create',
  'machines.add.ssh.start',
  'machines.add.ssh.status',
  'machines.add.ssh.respond',
  'machines.add.ssh.cancel',
  'servers.list',
  'projects.list',
  'session.target.primary.set',
  'session.target.tracked.set',
  'devices.simulator.input.orientation',
  ...ACTION_ID_FAMILIES_V1.voice_controls,
  ...ACTION_ID_FAMILIES_V1.current_ui_context,
  ...ACTION_ID_FAMILIES_V1.companion_controls,
] as const satisfies readonly ActionId[];

export type SignedRootActionId = Exclude<
  ActionId,
  InternalActionId
    | PluginProvenanceOnlyActionId
    | HumanSecretApiExcludedActionId
>;

export const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS = Object.freeze(
  Object.keys(PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS) as PluginProvenanceOnlyActionId[],
);

const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_ID_SET = new Set<ActionId>(
  PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS,
);

export function isPluginProvenanceOnlyActionId(actionId: string): actionId is PluginProvenanceOnlyActionId {
  return PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_ID_SET.has(actionId as ActionId);
}

const PRESENT_USER_REQUIRED_ACTION_ID_VALUES = [
  ...ARTIFACT_ACCESS_ACTION_IDS_V1,
  'approval.request.decide',
  'session.user_action.answer',
  'account.plugins.data.erase',
  'account.sessions.signOutEverywhere',
  'sessions.runner.activation.create',
  'sessions.runner.activation.cancel',
  ...ACTION_ID_FAMILIES_V1.account_security.filter(
    (actionId) => actionId !== 'account.security.get',
  ),
  'account.apiTokens.create',
  'account.apiTokens.update',
  'account.apiTokens.revoke',
  'account.apiTokens.revokeAll',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
  'plugins.install',
  'plugins.uninstall',
  'plugins.dev.submit',
  'plugins.dev.install',
  'plugins.sessionHooks.install',
  'plugins.sessionHooks.disable',
  'plugins.sessionHooks.enable',
  'plugins.sessionHooks.uninstall',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.dismissRequest',
  'browser.automation.cancelActive',
  ...(Object.keys(PluginWebhookActionHttpPathsV1) as PluginWebhookPresentUserActionIdV1[]),
  'computer.target.close',
] as const satisfies readonly ActionId[];

type PresentUserRequiredActionId = typeof PRESENT_USER_REQUIRED_ACTION_ID_VALUES[number];

const PRESENT_USER_REQUIRED_ACTION_IDS = new Set<ActionId>(PRESENT_USER_REQUIRED_ACTION_ID_VALUES);

/**
 * External ingress routes from this registry fact. These groups are by the
 * current execution owner, not by Action-id prefix: each exceptional
 * bootstrap/client/session case is named below so a new Action cannot silently
 * inherit a machine route merely because it was added to a neighboring family.
 */
const RUNTIME_ACTION_IDS_WITHOUT_MACHINE_PLACEMENT = new Set<RuntimeActionIdV1>([
  // Intentionally host-internal/fail-closed, so client placement is retained
  // only to keep the registry total while no external owner exists.
  'devices.simulator.input.orientation',
  // Composer attachment is a Session-media operation, not a machine command.
  'browser.recording.attachToComposer',
]);

// These readers resolve a Session id only to load persisted transcript data.
// They can run through any selected available daemon and must not require the
// Session's original publisher to still be present.
const PERSISTED_TRANSCRIPT_READ_ACTION_IDS: readonly ActionId[] = [
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.messages.recent.get',
  'transcript.page',
  'transcript.readAfter',
  'transcript.search',
];
const PERSISTED_TRANSCRIPT_READ_ACTION_ID_SET = new Set<ActionId>(PERSISTED_TRANSCRIPT_READ_ACTION_IDS);

const ACTION_EXECUTION_PLACEMENT_BY_ID: ReadonlyMap<ActionId, ActionExecutionPlacement> = (() => {
  const placements = new Map<ActionId, ActionExecutionPlacement>();
  const register = (placement: ActionExecutionPlacement, actionIds: readonly ActionId[]) => {
    for (const actionId of actionIds) {
      if (placements.has(actionId)) {
        throw new Error(`Action ${actionId} has more than one execution placement`);
      }
      placements.set(actionId, placement);
    }
  };

  // Account/server data can run before an exact machine is known.
  register('account', [
    'home.hub.layout.get',
    'home.hub.layout.update',
    ...ACTION_ID_FAMILIES_V1.todo_session_link,
    ...ACTION_ID_FAMILIES_V1.observation,
    ...ACTION_ID_FAMILIES_V1.connected_services_configuration.filter((id) => id !== 'connectedServices.identityPrivacy.set' && id !== 'connectedServices.quota.reset'),
    ...WORK_BOARD_ACTION_IDS_V1,
    ...ARTIFACT_ACCESS_ACTION_IDS_V1,
    ...ARTIFACT_ACTION_IDS_V1.filter((id) => id !== 'artifact.publish_from_file'),
    ...ACTION_ID_FAMILIES_V1.notifications,
    ...ACTION_ID_FAMILIES_V1.session_attention,
    'action.spec.search',
    'action.spec.get',
    'machines.list',
    'session.list',
    // Follow authoring is a Home relation: a valid authorized edge is persisted
    // and waits, so no exact destination runtime has to be reachable.
    ...ACTION_ID_FAMILIES_V1.session_follow,
    // Viewer read state is the same Account-scoped Home relation: the actor's
    // own private frontier, persisted per Account and published only to that
    // Account's devices, so no exact machine has to be reachable.
    ...ACTION_ID_FAMILIES_V1.session_read_state,
    ...ACTION_ID_FAMILIES_V1.session_access,
    'prompt_doc.get',
    'prompt_doc.create',
    'prompt_doc.favorite.set',
    'prompts.library.list',
    'prompts.invocations.list',
    'prompts.invocation.resolve',
    'prompt_doc.update',
    'prompt_bundle.update',
    // The custom ACP catalog is an Account setting: no machine has to be reachable to edit it.
    ...ACTION_ID_FAMILIES_V1.agent_acp_catalog,
    ...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('roles.')),
    ...ACTION_ID_FAMILIES_V1.launch_profiles,
    ...ACTION_ID_FAMILIES_V1.approvals,
    ...ACTION_ID_FAMILIES_V1.plugin_permission_grants,
    ...ACTION_ID_FAMILIES_V1.plugin_webhooks,
    ...ACTION_ID_FAMILIES_V1.account_plugin_data,
    ...ACTION_ID_FAMILIES_V1.account_sessions,
    ...ACTION_ID_FAMILIES_V1.account_security.filter((id) => id !== 'account.encryption.historicalKey.forget'
      && id !== 'account.encryption.automationTemplates.recover'),
    ...ACTION_ID_FAMILIES_V1.account_api_tokens,
    ...ACTION_ID_FAMILIES_V1.session_organization_resources,
    ...ACTION_ID_FAMILIES_V1.identity_github_apps,
    ...ACTION_ID_FAMILIES_V1.machine_pools,
    ...ACTION_ID_FAMILIES_V1.ephemeral_runner,
    ...ACTION_ID_FAMILIES_V1.automation_events,
    ...ACTION_ID_FAMILIES_V1.automation_conversation,
    // The Home decides governance, Team and Home-identity operations in its own
    // transaction, so these are Account-placed regardless of which machine
    // invoked them. Identity providers travel the same Home family port.
    ...ACTION_ID_FAMILIES_V1.home_governance,
    ...ACTION_ID_FAMILIES_V1.teams,
    ...ACTION_ID_FAMILIES_V1.identity_providers,
    ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
    ...ACTION_ID_FAMILIES_V1.widgets.filter((id) => id !== 'widgets.instance.refresh'),
    ...ACTION_ID_FAMILIES_V1.workflows.filter((actionId) => actionId !== 'workflow.run.start'),
  ]);

  // These actions require an answering app's runtime. Discovery remains
  // placement-neutral; admitted daemon hosts deliver through reverse RPC,
  // while absent client custody returns the canonical typed unavailable result.
  register('client', CLIENT_EXECUTION_PLACEMENT_ACTION_IDS);
  register('client', ACTION_ID_FAMILIES_V1.capture_viewing);
  register('client', ACTION_ID_FAMILIES_V1.scope);
  register('client', ACTION_ID_FAMILIES_V1.command_palette);
  register('client', ACTION_ID_FAMILIES_V1.find);
  register('client', ACTION_ID_FAMILIES_V1.prompt_picker);
  register('client', ACTION_ID_FAMILIES_V1.widgets.filter((id) => id === 'widgets.instance.refresh'));

  // A canonical Session resolves its current machine/daemon owner. Execution
  // runs are intentionally absent: detached runs have no Session owner.
  register('session', [
    ...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('session.')),
    ...ACTION_ID_FAMILIES_V1.session_lifecycle.filter((actionId) => actionId !== 'session.spawn_new'),
    'review.engines.list',
    ...ACTION_ID_FAMILIES_V1.messaging,
    ...ACTION_ID_FAMILIES_V1.session_control.filter((actionId) => actionId !== 'session.history.get'),
    ...ACTION_ID_FAMILIES_V1.intent_start,
    ...ACTION_ID_FAMILIES_V1.review_comments,
    ...ACTION_ID_FAMILIES_V1.subagent_registry,
    'session.activity.get',
    ...ACTION_ID_FAMILIES_V1.session_transcripts.filter(
      (actionId) => !PERSISTED_TRANSCRIPT_READ_ACTION_ID_SET.has(actionId),
    ),
    ...ACTION_ID_FAMILIES_V1.session_permissions,
    // The Board lives on the Session's own Home; its records resolve through that owner.
    ...ACTION_ID_FAMILIES_V1.session_board,
    // Human discussions are Session-owned rows on that same Home.
    ...ACTION_ID_FAMILIES_V1.session_discussion,
    'browser.recording.attachToComposer',
    'sessions.external.follow',
    'sessions.external.unfollow',
    'sessions.external.backgroundFollow.set',
    'sessions.external.status.get',
    'sessions.external.transcript.page',
    'sessions.external.transcript.readAfter',
  ]);

  // The remaining operations are daemon/machine-owned. This includes detached
  // execution runs, local indexes/filesystem/plugin/scm owners, and external
  // session operations whose request selects a concrete daemon runtime.
  register('machine', [
    'artifact.publish_from_file',
    'connectedServices.quota.reset',
    'machines.terminal.open',
    'machines.terminal.list',
    ...ACTION_ID_FAMILIES_V1.machine_agent_install,
    'action.options.resolve',
    'action.invoke',
    'session.spawn_new',
    ...PERSISTED_TRANSCRIPT_READ_ACTION_IDS,
    'paths.list_recent',
    'agents.backends.list',
    'machines.agents.list',
    'workspace.files.search',
    ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
    'agents.models.list',
    'agents.config_options.list',
    'agents.session_modes.list',
    'sessions.spawn.profiles.list',
    'sessions.spawn.connected_services.list',
    'sessions.spawn.mcp_servers.preview',
    ...ACTION_ID_FAMILIES_V1.execution_run_control,
    'workflow.run.start',
    ...ACTION_ID_FAMILIES_V1.memory,
    'prompt_asset.export',
    'prompt_registry.install',
    ...ACTION_ID_FAMILIES_V1.daemon_admin,
    ...ACTION_ID_FAMILIES_V1.plugin_dev_loop,
    ...ACTION_ID_FAMILIES_V1.plugin_settings_administration,
    'sessions.external.candidates.list',
    'sessions.external.candidate.delete',
    'sessions.external.link.ensure',
    'sessions.external.takeover',
    'sessions.external.materialize.start',
    'sessions.external.takeover.start',
    'sessions.external.operation.status.get',
    'sessions.external.operation.cancel',
    'sessions.external.operation.resume',
    'sessions.external.operation.retry',
    'sessions.external.operation.discard',
    ...ACTION_ID_FAMILIES_V1.scm_pull_request,
    ...ACTION_ID_FAMILIES_V1.scm_git,
    ...ACTION_ID_FAMILIES_V1.scm_repository,
    ...ACTION_ID_FAMILIES_V1.scm_diff_summary,
    ...RUNTIME_ACTION_IDS_V1.filter(
      (actionId) => !RUNTIME_ACTION_IDS_WITHOUT_MACHINE_PLACEMENT.has(actionId),
    ),
  ]);

  const missing = ACTION_IDS.filter((actionId) => !placements.has(actionId));
  if (missing.length > 0) {
    throw new Error(`Action execution placement missing for: ${missing.join(', ')}`);
  }
  return placements;
})();

function resolveActionRequiredAuthority(
  spec: Pick<PreNormalizedActionSpec, 'id' | 'requiredAuthority'>,
): ActionRequiredAuthority {
  return spec.requiredAuthority
    ?? (PRESENT_USER_REQUIRED_ACTION_IDS.has(spec.id) ? 'present_user' : 'account_automation');
}

function resolveActionExecutionPlacement(
  spec: Pick<PreNormalizedActionSpec, 'id' | 'executionPlacement'>,
): ActionExecutionPlacement {
  if (spec.executionPlacement) return spec.executionPlacement;
  const placement = ACTION_EXECUTION_PLACEMENT_BY_ID.get(spec.id);
  if (!placement) {
    throw new Error(`Action execution placement missing for: ${spec.id}`);
  }
  return placement;
}

/** Invoke only with schema-admitted input; the spec remains the sole placement owner. */
export function resolveActionExecutionPlacementForInput(
  spec: Pick<ActionSpec, 'executionPlacement' | 'executionPlacementForInput'>,
  input: unknown,
): ActionExecutionPlacement {
  return spec.executionPlacementForInput?.(input) ?? spec.executionPlacement;
}

function normalizeActionPublicExposure(spec: PreNormalizedActionSpec): NormalizedActionSpec {
  const isInternal = isInternalActionId(spec.id);
  const isPluginProvenanceOnly = isPluginProvenanceOnlyActionId(spec.id);
  const isHumanSecretApiExcluded = isHumanSecretApiExcludedActionId(spec.id);
  const isPluginSurfaceExcluded = isPluginSurfaceExcludedActionId(spec.id);
  const executionPlacement = resolveActionExecutionPlacement(spec);
  const requiredAuthority = resolveActionRequiredAuthority(spec);
  return {
    ...spec,
    requiredAuthority,
    executionPlacement,
    cli: executionPlacement === 'client' ? undefined : spec.cli,
    surfaces: {
      ...spec.surfaces,
      // Standalone CLI has no bound answering app. Daemon-hosted Agent/MCP
      // invocations can use the admitted client's existing reverse-RPC channel.
      cli: executionPlacement !== 'client' && spec.surfaces.cli,
      mcp: spec.surfaces.mcp || isAgentRequestablePresentUserActionId(spec.id)
        || spec.id === 'account.apiTokens.list' || spec.id === 'account.security.get',
      agent: spec.surfaces.agent || isAgentRequestablePresentUserActionId(spec.id)
        || spec.id === 'account.apiTokens.list' || spec.id === 'account.security.get',
      api: !isInternal
        && !isPluginProvenanceOnly
        && !isHumanSecretApiExcluded
        && (requiredAuthority === 'account_automation'
          || (DECISION_ACTION_IDS as readonly string[]).includes(spec.id)
          || (TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(spec.id)),
      plugin: !isPluginSurfaceExcluded,
    },
  };
}

const ACTION_SPECS_WITH_PUBLIC_EXPOSURE = Object.freeze(
  ACTION_SPECS_WITHOUT_APPROVAL.map(normalizeActionPublicExposure),
);

/**
 * The generated-family builders above return a broad registry row at runtime.
 * Keep their concrete Zod carriers in this one type-only projection so the
 * public API and Plugin maps remain derived from the same Action ids instead
 * of retaining a second, surface-specific allowlist. Array map cannot retain
 * the correlation between a runtime/generated family id and its indexed schema
 * after the value registry is assembled; changing every builder to a
 * tuple-aware generic would duplicate that machinery across eight existing
 * family owners. This projection therefore reads only their existing schema
 * maps and is checked by the explicit pluginActionDtoCorrespondence gate for
 * exact registry-id and per-row runtime-schema equality. It never decides an Action's runtime behavior, exposure,
 * authority, placement, or policy.
 */
type CanonicalActionSchemaDefinition<
  TActionId extends ActionId,
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
  TSurfaceBindings = never,
  TRequiredAuthority extends ActionRequiredAuthority = TActionId extends PresentUserRequiredActionId
    ? 'present_user'
    : 'account_automation',
> = Readonly<{
  id: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  surfaceBindings?: TSurfaceBindings;
  requiredAuthority: TRequiredAuthority;
}>;

type LiteralActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  ? ActionId extends TActionId
    ? never
    : TSpec
  : never;

// Filter each tuple row before forming its union: widened factory rows would
// otherwise absorb the concrete rows and erase their exact schema carriers.
type LiteralActionSpecTupleDefinition<TSpecs extends readonly PreNormalizedActionSpec[]> = {
  [K in keyof TSpecs]: LiteralActionSpecDefinition<TSpecs[K]>;
}[number];

type DirectActionSpecDefinition =
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD>
  | LiteralActionSpecDefinition<(typeof ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES)[number]>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX>;

type NonRuntimeActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  // These families have exact per-ID schema definitions below. Their generic
  // row factories must not reintroduce widened schema unions into the catalog.
  ? TActionId extends RuntimeActionIdV1 | SessionTerminalActionId | WorkspaceActionId
    | SessionCanvasActionId | WidgetInstanceActionIdV1 | WidgetDefinitionActionIdV1
    ? never
    : TSpec
  : never;

type NonRuntimeDirectActionSpecDefinition = NonRuntimeActionSpecDefinition<
  DirectActionSpecDefinition
>;

type RuntimeActionSpecDefinition = {
  [TActionId in RuntimeActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof RUNTIME_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof RUNTIME_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[RuntimeActionIdV1];

type PluginDevLoopActionSpecDefinition = {
  [TActionId in PluginDevLoopActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginDevLoopActionInputSchemas)[TActionId],
    typeof PluginDevLoopActionOutputSchema
  >;
}[PluginDevLoopActionIdV1];

type PluginSettingsAdministrationActionSpecDefinition = {
  [TActionId in PluginSettingsAdministrationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginSettingsAdministrationActionInputSchemasV1)[TActionId],
    typeof PluginSettingsAdministrationActionOutputV1Schema
  >;
}[PluginSettingsAdministrationActionIdV1];

type PluginPermissionGrantPluginBoundActionId = keyof typeof PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS;
type PluginPermissionGrantPluginBoundActionSpecDefinition = {
  [TActionId in PluginPermissionGrantPluginBoundActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginPermissionGrantActionInputSchemasV1)[TActionId],
    (typeof PluginPermissionGrantActionOutputSchemasV1)[TActionId],
    Readonly<{
      plugin: Readonly<{
        inputSchema: (typeof PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS)[TActionId];
      }>;
    }>
  >;
}[PluginPermissionGrantPluginBoundActionId];
type PluginPermissionGrantUnboundActionId = Exclude<
  PluginPermissionGrantActionIdV1,
  PluginPermissionGrantPluginBoundActionId
>;
type PluginPermissionGrantUnboundActionSpecDefinition = {
  [TActionId in PluginPermissionGrantUnboundActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginPermissionGrantActionInputSchemasV1)[TActionId],
    (typeof PluginPermissionGrantActionOutputSchemasV1)[TActionId]
  >;
}[PluginPermissionGrantUnboundActionId];
type PluginPermissionGrantActionSpecDefinition =
  | PluginPermissionGrantPluginBoundActionSpecDefinition
  | PluginPermissionGrantUnboundActionSpecDefinition;

type PluginReviewCommentActionSpecDefinition = {
  [TActionId in ReviewCommentActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ReviewCommentActionInputSchemasV1)[TActionId],
    (typeof ReviewCommentActionOutputSchemasV1)[TActionId]
  >;
}[ReviewCommentActionIdV1];

type PluginWebhookActionSpecDefinition = {
  [TActionId in PluginWebhookActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginWebhookActionInputSchemasV1)[TActionId],
    (typeof PluginWebhookActionOutputSchemasV1)[TActionId]
  >;
}[PluginWebhookActionIdV1];

type PluginAutomationEventActionSpecDefinition = {
  [TActionId in AutomationEventActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof AutomationEventActionInputSchemasV1)[TActionId],
    (typeof AutomationEventActionOutputSchemasV1)[TActionId]
  >;
}[AutomationEventActionIdV1];

type PluginAutomationConversationActionSpecDefinition = {
  [TActionId in AutomationConversationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof AutomationConversationActionInputSchemasV1)[TActionId],
    (typeof AutomationConversationActionOutputSchemasV1)[TActionId]
  >;
}[AutomationConversationActionIdV1];

type MachinePoolActionSpecDefinition = {
  [TActionId in MachinePoolActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MachinePoolActionInputSchemasV1)[TActionId],
    (typeof MachinePoolActionOutputSchemasV1)[TActionId]
  >;
}[MachinePoolActionIdV1];

type EphemeralRunnerActionSpecDefinition = {
  [TActionId in EphemeralRunnerActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof EphemeralRunnerActionInputSchemasV1)[TActionId],
    (typeof EphemeralRunnerActionOutputSchemasV1)[TActionId]
  >;
}[EphemeralRunnerActionIdV1];

type WorkBoardActionSpecDefinition = {
  [TActionId in WorkBoardActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WorkBoardActionInputSchemasV1)[TActionId],
    (typeof WorkBoardActionOutputSchemasV1)[TActionId]
  >;
}[WorkBoardActionIdV1];

type RoleActionSpecDefinition = {
  [TActionId in RoleActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof RoleActionInputSchemasV1)[TActionId],
    (typeof RoleActionOutputSchemasV1)[TActionId]
  >;
}[RoleActionIdV1];

type ArtifactAccessActionSpecDefinition = {
  [TActionId in ArtifactAccessActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ArtifactAccessActionInputSchemasV1)[TActionId],
    (typeof ArtifactAccessActionOutputSchemasV1)[TActionId],
    never,
    (typeof ARTIFACT_ACCESS_ACTION_SPECS)[number]['requiredAuthority']
  >;
}[ArtifactAccessActionIdV1];

type ArtifactActionSpecDefinition = {
  [TActionId in ArtifactActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ArtifactActionInputSchemasV1)[TActionId],
    (typeof ArtifactActionOutputSchemasV1)[TActionId],
    never,
    (typeof ARTIFACT_ACTION_SPECS)[number]['requiredAuthority']
  >;
}[ArtifactActionIdV1];

type SettingsDeclarationActionSpecDefinition = {
  [TActionId in SettingsDeclarationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SettingsDeclarationActionInputSchemasV1)[TActionId],
    (typeof SettingsDeclarationActionOutputSchemasV1)[TActionId]
  >;
}[SettingsDeclarationActionIdV1];

type WorkspaceActionSpecDefinition = {
  [TActionId in WorkspaceActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WORKSPACE_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof WORKSPACE_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[WorkspaceActionId];

type WidgetInstanceActionSpecDefinition = {
  [TActionId in WidgetInstanceActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WidgetInstanceActionInputSchemasV1)[TActionId],
    (typeof WidgetInstanceActionOutputSchemasV1)[TActionId],
    never,
    (typeof WIDGET_INSTANCE_ACTION_SPECS_V1)[number]['requiredAuthority']
  >;
}[WidgetInstanceActionIdV1];

type WidgetDefinitionActionSpecDefinition = {
  [TActionId in WidgetDefinitionActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WidgetDefinitionActionInputSchemasV1)[TActionId],
    (typeof WidgetDefinitionActionOutputSchemasV1)[TActionId],
    never,
    (typeof WIDGET_DEFINITION_ACTION_SPECS_V1)[number]['requiredAuthority']
  >;
}[WidgetDefinitionActionIdV1];

type SessionTerminalActionSpecDefinition = {
  [TActionId in SessionTerminalActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SESSION_TERMINAL_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[SessionTerminalActionId];

type ScmGitActionSpecDefinition = (typeof SCM_GIT_ACTION_SPECS)[number];

type WorkflowActionSpecDefinition = {
  [TActionId in WorkflowActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WorkflowActionInputSchemasV1)[TActionId],
    (typeof WorkflowActionOutputSchemasV1)[TActionId],
    never,
    TActionId extends 'workflow.run.invocations.complete_review' ? 'present_user' : 'account_automation'
  >;
}[WorkflowActionIdV1];

type TeamCredentialActionSpecDefinition = {
  [TActionId in TeamCredentialActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
  >;
}[TeamCredentialActionIdV1];

type SharedSavedSecretActionSpecDefinition = {
  [TActionId in SharedSavedSecretActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
  >;
}[SharedSavedSecretActionIdV1];

type ManagedGitHubAppActionSpecDefinition = {
  [TActionId in ManagedGitHubAppActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1)[TActionId],
    never,
    TActionId extends 'identity.githubApps.list' ? 'account_automation' : 'present_user'
  >;
}[ManagedGitHubAppActionIdV1];

type ManagedIdentityProviderActionSpecDefinition = {
  [TActionId in ManagedIdentityProviderActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId],
    never,
    ManagedIdentityProviderRequiredAuthority<TActionId>
  >;
}[ManagedIdentityProviderActionIdV1];

/**
 * Account Security rows are authored together above, but their shared map
 * deliberately widens to `PreNormalizedActionSpec` while it attaches the
 * common surface metadata. Keep the public/plugin author maps exact by
 * projecting the five wire schemas here rather than letting that implementation
 * detail degrade their inputs and results to `unknown`.
 */
type AccountSecurityActionSpecDefinition =
  | CanonicalActionSchemaDefinition<
      'account.security.terminalPresentUser.set',
      typeof AccountTerminalPresentUserPolicySetRequestV1Schema,
      typeof AccountTerminalPresentUserPolicySetResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.security.get',
      typeof AccountSecurityGetRequestV1Schema,
      typeof AccountSecurityGetResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.password.enroll',
      typeof AccountPasswordEnrollRequestV1Schema,
      typeof AccountPasswordMutationResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.password.change',
      typeof AccountPasswordChangeRequestV1Schema,
      typeof AccountPasswordMutationResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.password.remove',
      typeof AccountPasswordRemoveRequestV1Schema,
      typeof AccountPasswordMutationResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.email.change.request',
      typeof AccountEmailChangeRequestV1Schema,
      typeof AccountEmailChangeRequestResponseV1Schema
    >;

export type CanonicalActionSpecDefinition =
  | { [Id in VoiceConversationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof VoiceConversationActionInputSchemas)[Id], (typeof VoiceConversationActionOutputSchemas)[Id]>
    }[VoiceConversationActionId]
  | (typeof COMPOSER_INGRESS_ACTION_SPECS)[number]
  | (typeof WORKFLOW_AUTHORING_ACTION_SPECS)[number]
  | { [Id in SessionCanvasActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof SESSION_CANVAS_ACTION_INPUT_SCHEMAS)[Id], (typeof SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS)[Id]>
    }[SessionCanvasActionId]
  | { [Id in NotificationConfigurationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof NotificationConfigurationActionInputSchemas)[Id], (typeof NotificationConfigurationActionOutputSchemas)[Id]>
    }[NotificationConfigurationActionId]
  | { [Id in AppUpdateActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof AppUpdateActionInputSchemas)[Id], (typeof AppUpdateActionOutputSchemas)[Id]>
    }[AppUpdateActionId]
  | SessionTerminalActionSpecDefinition
  | WorkspaceActionSpecDefinition
  | WidgetInstanceActionSpecDefinition
  | WidgetDefinitionActionSpecDefinition
  | (typeof SCOPE_ACTION_SPECS)[number]
  | (typeof COMMAND_PALETTE_ACTION_SPECS)[number]
  | (typeof FIND_ACTION_SPECS)[number]
  | (typeof PROMPT_PICKER_ACTION_SPECS)[number]
  | (typeof SESSION_PENDING_NEXT_ACTION_SPECS)[number]
  | SettingsDeclarationActionSpecDefinition
  | WorkBoardActionSpecDefinition
  | ArtifactAccessActionSpecDefinition
  | ArtifactActionSpecDefinition
  | RoleActionSpecDefinition
  | ScmGitActionSpecDefinition
  | NonRuntimeDirectActionSpecDefinition
  | RuntimeActionSpecDefinition
  | PluginDevLoopActionSpecDefinition
  | PluginSettingsAdministrationActionSpecDefinition
  | PluginPermissionGrantActionSpecDefinition
  | PluginReviewCommentActionSpecDefinition
  | PluginWebhookActionSpecDefinition
  | PluginAutomationEventActionSpecDefinition
  | PluginAutomationConversationActionSpecDefinition
  | MachinePoolActionSpecDefinition
  | EphemeralRunnerActionSpecDefinition
  | WorkflowActionSpecDefinition
  | TeamCredentialActionSpecDefinition
  | SharedSavedSecretActionSpecDefinition
  | ManagedGitHubAppActionSpecDefinition
  | ManagedIdentityProviderActionSpecDefinition
  | AccountSecurityActionSpecDefinition;

// Index the family union once instead of distributing Extract over the whole
// catalog again for every input, result and surface projection.
type CanonicalActionSpecBucketsById = {
  [TSpec in CanonicalActionSpecDefinition as TSpec['id']]: TSpec;
};
type CanonicalActionSpecById = {
  [TActionId in keyof CanonicalActionSpecBucketsById]: Extract<
    CanonicalActionSpecBucketsById[TActionId],
    Readonly<{ id: TActionId }>
  >;
};

type ResultRequiredActionId =
  | (typeof RESULT_REQUIRED_APPROVAL_ACTION_IDS)[number]
  | (typeof RESULT_REQUIRED_DEFERRED_APPROVAL_ACTION_IDS)[number];
type ResultRequiredActionsWithoutSchema = {
  [TActionId in ResultRequiredActionId]: CanonicalActionSpecBucketsById[TActionId] extends Readonly<{
    outputSchema: z.ZodTypeAny;
  }> ? never : TActionId;
}[ResultRequiredActionId];
type ResultRequiredActionsMustHaveSchema = AssertNever<ResultRequiredActionsWithoutSchema>;

type ResolveCanonicalActionRequiredAuthority<TSpec> = TSpec extends Readonly<{
  requiredAuthority: infer TRequiredAuthority extends ActionRequiredAuthority;
}>
  ? TRequiredAuthority
  : TSpec extends Readonly<{ id: infer TActionId extends ActionId }>
    ? TActionId extends PresentUserRequiredActionId
      ? 'present_user'
      : 'account_automation'
    : never;

type AccountAutomationActionId = CanonicalActionSpecDefinition extends infer TSpec
  ? TSpec extends Readonly<{ id: infer TActionId extends ActionId }>
    ? ResolveCanonicalActionRequiredAuthority<TSpec> extends 'account_automation'
      ? TActionId
      : never
    : never
  : never;

export type PublicActionId = Extract<SignedRootActionId,
  AccountAutomationActionId | typeof DECISION_ACTION_IDS[number] | typeof TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS[number]>;

export type PluginInvocableActionSpecDefinition = Extract<
  CanonicalActionSpecBucketsById[PluginInvocableActionId],
  Readonly<{ id: PluginInvocableActionId }>
>;

/**
 * Public Action descriptor shape narrowed to the exact trusted-Plugin Action
 * census. Build this from the explicit descriptor contract rather than the
 * passthrough Zod inference: the latter carries a string index signature, and
 * applying `Omit` to it erases the useful property types to `unknown`.
 * Host surface transforms, execution routing, and caller-authority policy are
 * deliberately absent: authors consume the normalized descriptor and invoke
 * Actions through the service rather than participating in host dispatch.
 */
export type PluginInvocableActionSpec = Readonly<{
  id: PluginInvocableActionId;
  title: ParsedActionSpec['title'];
  description?: ParsedActionSpec['description'];
  safety: ParsedActionSpec['safety'];
  approval: ParsedActionSpec['approval'];
  placements: ActionUiPlacement[];
  slash?: ParsedActionSpec['slash'];
  bindings?: ParsedActionSpec['bindings'];
  outputSchema?: ParsedActionSpec['outputSchema'];
  sideEffectClass?: ParsedActionSpec['sideEffectClass'];
  examples?: ParsedActionSpec['examples'];
  prompting?: ParsedActionSpec['prompting'];
  toolExposure?: ParsedActionSpec['toolExposure'];
  contextualDefaults?: ParsedActionSpec['contextualDefaults'];
  operation?: ParsedActionSpec['operation'];
  requiredAuthority: ActionRequiredAuthority;
  executionPlacement: ActionExecutionPlacement;
  surfaces: ParsedActionSpec['surfaces'];
  inputSchema: ParsedActionSpec['inputSchema'];
  inputHints?: ParsedActionSpec['inputHints'];
}>;

type PluginActionSpecForId<TActionId extends PluginInvocableActionId> = CanonicalActionSpecById[TActionId];

// Preserve each row's exact input/output while dynamic catalog lookups consume
// the parser interface, not a union of hundreds of Zod implementation classes.
type ActionSchemaCarriersById<TSchemas> = Readonly<{
  [TActionId in keyof TSchemas]: z.ZodType<z.output<TSchemas[TActionId]>, z.input<TSchemas[TActionId]>>;
}>;

export type PluginActionInputById = Readonly<{
  [TActionId in PluginInvocableActionId]: z.input<PluginActionInputSchemaById[TActionId]>;
}>;

export type PluginActionResultById = Readonly<{
  [TActionId in PluginInvocableActionId]: z.output<PluginActionOutputSchemaById[TActionId]>;
}>;

type PluginActionInputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ inputSchema: infer TInputSchema extends z.ZodTypeAny }> }>;
  }>
    ? TInputSchema
    : PluginActionSpecForId<TActionId>['inputSchema'];
}>;

type PluginActionOutputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodTypeAny }> }>;
  }>
    ? TOutputSchema
    : PluginActionSpecForId<TActionId> extends Readonly<{
      outputSchema: infer TOutputSchema extends z.ZodTypeAny;
    }>
      ? TOutputSchema
      : never;
}>;

// Catalog/type correspondence is checked by pluginActionDtoCorrespondence.ts,
// outside prerequisite compilation. Keep the runtime schema carriers exact here.
type AssertTrue<T extends true> = T;
type IsTypeEqual<TLeft, TRight> = (
  <T>() => T extends TLeft ? 1 : 2
) extends (
  <T>() => T extends TRight ? 1 : 2
) ? true : false;
// This single-row binding references private admission schemas and does not
// instantiate the catalog-wide maps. The full correspondence gate checks all rows.
type PluginSessionMessageInputMustRemainAdmissionOnly = AssertTrue<IsTypeEqual<
  PluginActionInputById['session.message.send'],
  z.input<typeof SessionSendMessagePluginInputV1Schema>
>>;

const PLUGIN_INVOCABLE_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(
  (spec): spec is ActionSpecWithoutApproval & Readonly<{
    surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ plugin: true }>;
    outputSchema: z.ZodTypeAny;
  }> => (
    spec.surfaces.plugin === true && spec.outputSchema !== undefined
  ),
);

function projectPluginActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): ActionSchemaCarriersById<PluginActionInputSchemaById>;
function projectPluginActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(
    specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const pluginBinding = surfaceBindings && 'plugin' in surfaceBindings
      ? surfaceBindings.plugin
      : undefined;
    return [spec.id, pluginBinding?.inputSchema ?? spec.inputSchema];
    }),
  ));
}

function projectPluginActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): ActionSchemaCarriersById<PluginActionOutputSchemaById>;
function projectPluginActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(
    specs.map((spec) => {
      const surfaceBindings = 'surfaceBindings' in spec
        ? spec.surfaceBindings
        : undefined;
      const pluginBinding = surfaceBindings && 'plugin' in surfaceBindings
        ? surfaceBindings.plugin
        : undefined;
      const pluginOutputSchema = pluginBinding && 'outputSchema' in pluginBinding
        ? pluginBinding.outputSchema
        : undefined;
      return [spec.id, pluginOutputSchema ?? spec.outputSchema];
    }),
  ));
}

export const PLUGIN_ACTION_INPUT_SCHEMAS: ActionSchemaCarriersById<PluginActionInputSchemaById> = projectPluginActionInputSchemas(
  PLUGIN_INVOCABLE_ACTION_SPECS,
);

export const PLUGIN_ACTION_OUTPUT_SCHEMAS: ActionSchemaCarriersById<PluginActionOutputSchemaById> = projectPluginActionOutputSchemas(
  PLUGIN_INVOCABLE_ACTION_SPECS,
);

/**
 * The authenticated public API is the API-surface projection of the same
 * canonical rows. It excludes host-internal and plugin-provenance-only Actions,
 * rather than maintaining a second allowlist; execution placement is resolved
 * when an admitted Action runs.
 */
export type PublicActionSpecDefinition = Extract<
  CanonicalActionSpecBucketsById[PublicActionId],
  Readonly<{ id: PublicActionId }>
>;

type PublicActionSpecForId<TActionId extends PublicActionId> = CanonicalActionSpecById[TActionId];

export type PublicActionInputById = Readonly<{
  [TActionId in PublicActionId]: z.input<PublicActionInputSchemaById[TActionId]>;
}>;

export type PublicActionResultById = Readonly<{
  [TActionId in PublicActionId]: z.output<PublicActionOutputSchemaById[TActionId]>;
}>;

type PublicActionInputSchemaById = Readonly<{
  [TActionId in PublicActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : PublicActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ api: Readonly<{ inputSchema: infer TInputSchema extends z.ZodTypeAny }> }>;
  }>
    ? TInputSchema
    : PublicActionSpecForId<TActionId>['inputSchema'];
}>;

type PublicActionOutputSchemaById = Readonly<{
  [TActionId in PublicActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : PublicActionSpecForId<TActionId> extends Readonly<{
      surfaceBindings: Readonly<{ api: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodTypeAny }> }>;
    }>
      ? TOutputSchema
      : PublicActionSpecForId<TActionId>['outputSchema'];
}>;

function isSignedRootActionSpec(
  spec: ActionSpecWithoutApproval,
): spec is ActionSpecWithoutApproval & Readonly<{ outputSchema: z.ZodTypeAny }> {
  return !isInternalActionId(spec.id)
    && !isPluginProvenanceOnlyActionId(spec.id)
    && !isHumanSecretApiExcludedActionId(spec.id)
    && spec.outputSchema !== undefined;
}

const SIGNED_ROOT_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(isSignedRootActionSpec);

/**
 * Interactive signed-root admission uses the same API-safe Action shapes as
 * PAT ingress, but retains Actions whose declared authority is present_user.
 */
export const SIGNED_ROOT_ACTION_IDS = Object.freeze(
  SIGNED_ROOT_ACTION_SPECS.map((spec) => spec.id),
) as readonly SignedRootActionId[];

const SIGNED_ROOT_ACTION_ID_SET = new Set<string>(SIGNED_ROOT_ACTION_IDS);

export const SignedRootActionIdSchema = lazyZodSchema(() => z.custom<SignedRootActionId>(
  (actionId) => typeof actionId === 'string' && SIGNED_ROOT_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available to the signed interactive root' },
));

const PUBLIC_ACTION_SPECS = SIGNED_ROOT_ACTION_SPECS.filter(
  (spec): spec is ActionSpecWithoutApproval & Readonly<{
    surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ api: true }>;
    outputSchema: z.ZodTypeAny;
  }> => (
    spec.surfaces.api === true
  ),
);

/** Runtime companion generated from the same canonical rows as the API type maps. */
export const PUBLIC_ACTION_IDS = Object.freeze(
  PUBLIC_ACTION_SPECS.map((spec) => spec.id),
) as readonly PublicActionId[];

const PUBLIC_ACTION_ID_SET = new Set<string>(PUBLIC_ACTION_IDS);

/** Runtime parser for the ActionSpec rows explicitly surfaced to authenticated API callers. */
export const PublicActionIdSchema = lazyZodSchema(() => z.custom<PublicActionId>(
  (actionId) => typeof actionId === 'string' && PUBLIC_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available on the public API surface' },
));

function projectPublicActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): ActionSchemaCarriersById<PublicActionInputSchemaById>;
function projectPublicActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const apiBinding = surfaceBindings && 'api' in surfaceBindings
      ? surfaceBindings.api
      : undefined;
    return [spec.id, apiBinding?.inputSchema ?? spec.inputSchema];
  })));
}

function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
  projection: 'public',
): ActionSchemaCarriersById<PublicActionOutputSchemaById>;
function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
  projection: 'signed-root',
): Readonly<Record<SignedRootActionId, z.ZodTypeAny>>;
function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
  _projection: 'public' | 'signed-root',
): object {
  return Object.freeze(Object.fromEntries(specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const apiBinding = surfaceBindings && 'api' in surfaceBindings
      ? surfaceBindings.api
      : undefined;
    const apiOutputSchema = apiBinding && 'outputSchema' in apiBinding
      ? apiBinding.outputSchema
      : undefined;
    return [spec.id, apiOutputSchema ?? spec.outputSchema];
  })));
}

/** Runtime result projection for signed interactive root execution. */
export const SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS = projectPublicActionOutputSchemas(
  SIGNED_ROOT_ACTION_SPECS,
  'signed-root',
);

export const PUBLIC_ACTION_INPUT_SCHEMAS: ActionSchemaCarriersById<PublicActionInputSchemaById> = projectPublicActionInputSchemas(
  PUBLIC_ACTION_SPECS,
);

export const PUBLIC_ACTION_OUTPUT_SCHEMAS: ActionSchemaCarriersById<PublicActionOutputSchemaById> = projectPublicActionOutputSchemas(
  PUBLIC_ACTION_SPECS,
  'public',
);

const HOST_DOMAIN_PLUGIN_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'caller',
};
const PLUGIN_RELOAD_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'self_or_inspector_admin',
  targetPluginIdField: 'pluginId',
  administrativeCallers: [{
    pluginId: 'happier.inspector',
    contributionLocalId: 'inspector-app',
  }],
};
/**
 * The one declaration census for host Actions with a caller policy on the
 * plugin surface.
 * `caller` means the canonical executor requires a current host-stamped
 * plugin caller. A `caller` row names no plugin identity: a built-in plugin
 * and an out-of-tree plugin reach exactly the same host capability. Further
 * identity projection occurs only when the incumbent domain owner has
 * caller-dependent authorization — Account scope, publisher proof, and current
 * materialization are that owner's fences, and they do not depend on which
 * plugin is asking. Reload is the one plugin-*targeted* Action: it administers
 * a peer plugin's development generation, so its self scope and the exact
 * Inspector administrative surface live here rather than in any consumer.
 */
const ACTION_PLUGIN_CALLER_POLICY_BY_ID: Readonly<
  Partial<Record<ActionId, ActionPluginCallerPolicy>>
> = Object.freeze({
  'capture.view': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.reload': PLUGIN_RELOAD_CALLER_POLICY,
  'plugins.permissions.grants.request': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.permissions.grants.revoke': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.source.status.report': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.targets.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.target.verify': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.transition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.edit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.reply': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.redact': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.setDisposition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.attachEvidence': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.bulkTransition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.claimPublicationDispatch': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'browser.navigate': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.disable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.enable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.uninstall': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.materialize.start': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.cancel': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.resume': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.retry': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.discard': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  // Destructive Board removal needs a current host-stamped plugin caller; the
  // Session's own access owner still authorizes the record mutation beneath it.
  'session.board.item.remove': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint_code_rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.restore': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.terminalComposer.clear': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pendingInput.interruptAndRun': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.usageLimit.consumeResetCredit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.upsert': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.delete': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.favorite.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.library.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocations.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocation.resolve': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_bundle.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_asset.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_registry.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'daemon.promptAssets.delete': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'daemon.promptRegistry.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'transcript.import': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.backgroundFollow.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.openOrReuse': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.checkout': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.prepareWorktree': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.reviewWorkspace.materializePrepared': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.runStacked': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.clone': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.init': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.removeIndexLock': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.hostingRepository.publish': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
});

function resolveActionPluginCallerPolicy(
  spec: ActionSpecWithoutApproval,
): ActionPluginCallerPolicy | undefined {
  const policy = ACTION_PLUGIN_CALLER_POLICY_BY_ID[spec.id];
  const requiresPolicy = spec.surfaces.plugin && spec.safety !== 'safe';
  if (!spec.surfaces.plugin && policy) {
    throw new Error(`Action ${spec.id} declares pluginCallerPolicy without a plugin surface`);
  }
  // Backed runtime Actions use the same host-stamped Plugin provenance as
  // every other non-safe host Action. Their machine/session routing remains
  // with the runtime owner; callers never supply a plugin identity in input.
  if (requiresPolicy && isRuntimeActionIdV1(spec.id)) {
    return HOST_DOMAIN_PLUGIN_CALLER_POLICY;
  }
  return requiresPolicy ? policy ?? HOST_DOMAIN_PLUGIN_CALLER_POLICY : policy;
}

const CURRENT_SESSION_CONTEXT_ACTION_IDS = new Set<ActionId>([
  'reviews.comments.create',
  'reviews.comments.list',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.start',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'peerMediation.observability.snapshot',
  'sessions.external.operation.status.get',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'action.options.resolve',
  'review.start',
  'review.walkthrough',
  'review.explain_findings',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'execution.run.start',
  'execution.run.list',
  'execution.run.get',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.read',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.cancel_turn',
  'execution.run.action',
  'execution.run.wait',
  'session.open',
  'session.fork',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'review.engines.list',
  'session.message.send',
  'session.stop',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.title.set',
  'session.permission_mode.set',
  'session.approval_reviewer.set',
  'session.attention.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.goal.set',
  'session.goal.clear',
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.board.get',
  'session.board.item.upsert',
  'session.board.item.remove',
  'session.board.layout.update',
  'session.discussion.list',
  'session.discussion.get',
  'session.discussion.read',
  'session.discussion.create',
  'session.discussion.post',
  'session.discussion.rename',
  'session.discussion.archive',
  'session.discussion.restore',
  'session.discussion.read_state.set',
  'session.permission.respond',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.user_action.remote.answer',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  'session.user_action.answer',
  'session.mode.set',
  'session.target.primary.set',
  'session.activity.get',
  'session.messages.recent.get',
  'ui.voice_agent.teleport',
  'memory.ensure_up_to_date',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.unfollow',
  'transcript.import',
  'transcript.search',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.status.get',
]);

function resolveBuiltInActionContextualDefaults(actionId: ActionId): ActionContextualDefaults | undefined {
  if (actionId === 'memory.search' || actionId === 'memory.get_window') {
    return { machineId: 'current_session_machine' };
  }
  return CURRENT_SESSION_CONTEXT_ACTION_IDS.has(actionId)
    ? { sessionId: 'current_session' }
    : undefined;
}

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze(
  ACTION_SPECS_WITH_PUBLIC_EXPOSURE.map((spec): ActionSpec => {
    const pluginCallerPolicy = resolveActionPluginCallerPolicy(spec);
    const contextualDefaults = resolveBuiltInActionContextualDefaults(spec.id);
    return {
      ...spec,
      requiredAuthority: resolveActionRequiredAuthority(spec),
      executionPlacement: resolveActionExecutionPlacement(spec),
      ...(pluginCallerPolicy ? { pluginCallerPolicy } : {}),
      ...(contextualDefaults ? { contextualDefaults } : {}),
      placements: [...spec.placements],
      approval: resolveApprovalMetadataForActionId(spec.id),
    };
  }),
);

assertPublicActionSdkMethodNames(ACTION_SPECS, PUBLIC_ACTION_ID_SET);

export function listActionSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS;
}

export function getActionSpec(id: ActionId): ActionSpec {
  const spec = ACTION_SPECS.find((s) => s.id === id);
  if (!spec) {
    // This is a programmer error: all call sites should be type-safe and list-backed.
    throw new Error(`Unknown action spec: ${id}`);
  }
  return spec;
}

export function getActionContextualDefaults(
  action: ActionId | string | ActionSpec,
): ActionContextualDefaults | null {
  const spec = typeof action === 'string'
    ? (() => {
      const parsed = ActionIdSchema.safeParse(action);
      return parsed.success ? getActionSpec(parsed.data) : null;
    })()
    : action;
  if (!spec) return null;
  return spec.contextualDefaults ?? null;
}

/**
 * Is `spec` reachable from `surface`? This is the enablement gate for the whole Action catalog:
 * it backs `createActionExecutor`'s `isActionEnabledBySurface` and both MCP tool bridges.
 *
 * It fails CLOSED on a nullish or unknown surface (INV-1). An unattributed caller is not a
 * wildcard — surface attribution is owned by the host that constructs the executor
 * (`createCliActionExecutor` stamps `'cli'`, `createDefaultActionExecutor` stamps `'ui'`, the
 * MCP servers stamp `'agent'`/`'mcp'`, the RPC adapter stamps `'rpc'`, external ingress stamps
 * `'api'`), so a missing surface means the host forgot, not that every surface is permitted.
 * This resolves the same direction as the consent layer, which already treats an unresolvable
 * surface as `ambiguous` and applies the agent approval floor
 * (`actionApprovalPolicy.ts#resolveApprovalSurface`).
 *
 * Callers that mean "no surface filter requested" must short-circuit before calling this
 * (see `actionCatalog.ts`, which guards every use with `params.surface && …`). That is a
 * different question from "may an unknown caller reach this Action".
 */
export function isActionSpecSurfacedOn(spec: ActionSpec, surface: keyof ActionSurfaces | null | undefined): boolean {
  if (!surface) return false;
  return spec.surfaces[surface] === true;
}

export function listActionSpecsForSurface(surface: keyof ActionSurfaces): readonly ActionSpec[] {
  return ACTION_SPECS.filter((spec) => isActionSpecSurfacedOn(spec, surface));
}

export type ActionCliCommandDeclaration = Readonly<{
  spec: ActionSpec;
  binding: ActionCliCommandBinding;
}>;

/**
 * Every friendly CLI path the catalog declares, flattened for the one CLI
 * compiler. Ordering follows the catalog so a compiled command list is stable.
 */
export function listActionCliCommandDeclarations(): readonly ActionCliCommandDeclaration[] {
  return Object.freeze(ACTION_SPECS.flatMap((spec) => (
    (spec.cli?.commands ?? []).map((binding) => Object.freeze({ spec, binding }))
  )));
}

/**
 * A command path has exactly one admitted Action owner. Two Actions claiming the
 * same spelling is a declaration defect, not a dispatch-time tiebreak, so it
 * fails at catalog load rather than silently letting the first one win.
 */
function assertActionCliCommandPathsAreUnique(
  declarations: readonly ActionCliCommandDeclaration[],
): void {
  const ownerByPath = new Map<string, ActionId>();
  for (const { spec, binding } of declarations) {
    const path = binding.path.join(' ');
    const existing = ownerByPath.get(path);
    if (existing) {
      throw new Error(
        `Action CLI command path "${path}" is declared by both ${existing} and ${spec.id}`,
      );
    }
    ownerByPath.set(path, spec.id);
  }
}

assertActionCliCommandPathsAreUnique(listActionCliCommandDeclarations());

export function listVoiceToolActionSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export { describeActionForVoiceTool } from './actionVoiceToolSummary.js';

/**
 * Canonical tool projection for provider SDK callbacks that cannot retain a
 * stable host call/result identity across reconnects. Such callbacks may
 * expose only none/read actions and must never advertise mutations.
 */
export function isVoiceSdkSafeActionSpec(spec: Pick<ActionSpec, 'sideEffectClass'>): boolean {
  return spec.sideEffectClass === 'none' || spec.sideEffectClass === 'read';
}

export function listVoiceSdkSafeToolActionSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoiceSdkSafeActionSpec);
}

export function isVoicePromptHotPathSpec(spec: Pick<ActionSpec, 'prompting'>): boolean {
  return spec.prompting?.voiceHotPath === true;
}

export function listVoicePromptHotPathSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoicePromptHotPathSpec);
}

export function listVoiceActionBlockSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export function listVoiceClientToolNames(): readonly string[] {
  const names = listVoiceToolActionSpecs()
    .map((spec) => String(spec.bindings?.voiceClientToolName ?? '').trim())
    .filter((name) => name.length > 0);
  names.sort();
  return names;
}

export function resolveVoiceClientToolNameAlias(value: string): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;

  for (const spec of listVoiceToolActionSpecs()) {
    const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
    if (!toolName) continue;
    if (toolName === normalized || spec.id === normalized) return toolName;
  }

  return null;
}
