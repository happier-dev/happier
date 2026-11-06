import { BotTemplateActionInputSchemasV1, BotTemplateActionOutputSchemasV1, type BotTemplateActionIdV1 } from '../bots/templates/botTemplateActionsV1.js';
import { BOT_TEMPLATE_ACTION_SPECS_V1 } from './specs/botTemplates.js';
import { MACHINE_REACHABILITY_ACTION_SPECS_V1 } from './specs/machineReachability.js';
import { SESSION_MESSAGE_PIN_ACTION_SPECS } from './sessionMessagePinActionSpecs.js';
import { MEDIA_ANNOTATION_ACTION_SPECS } from './mediaAnnotationAction.js';
import { DESKTOP_WINDOWS_ACTION_SPECS } from './desktopWindowsAction.js';
import { DESKTOP_SHELL_ACTION_SPECS } from './specs/desktopShell.js';
import type { ExternalActionRequestEnvelope, ExternalActionTargetV1 } from './externalActionApi.js';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { completeActionInputHints } from './schemaInputHints.js';
import { withClientActionInput, retainClientActionInput } from './clientActionInput.js';
import type { ClientRoutedActionId } from './clientRoutedActionIds.generated.js';
import { resolveMachineRpcGovernance } from '../machines/peer/mediation/rpc/governanceV1.js';
import { CODE_INTELLIGENCE_ACTION_SPECS } from './codeIntelligenceActionFamily.js';
import { PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS } from './specs/pluginExecutionOrigin.js';
import { NPM_REGISTRY_PROFILE_ACTION_SPECS_V1 } from './specs/npmRegistryProfiles.js';
import { PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_SPECS } from './specs/pluginAccountAdministration.js';
import { PluginAccountAdministrationActionInputSchemas, PluginAccountAdministrationActionOutputSchemas,
  type PluginAccountAdministrationActionId } from './pluginAccountAdministrationActionFamily.js';
import { NpmRegistryProfileActionInputSchemasV1, NpmRegistryProfileActionOutputSchemasV1,
  type NpmRegistryProfileActionIdV1 } from './npmRegistryProfileActionFamily.js';
import { PluginExecutionOriginActionInputSchemas, PluginExecutionOriginActionOutputSchemas,
  type PluginExecutionOriginActionId } from './pluginExecutionOriginActionFamily.js';
export { ActionPromptingSchema, type ActionPrompting } from './metadata.js';
export type { DesktopWindowTarget, DesktopWindowsOpenInput, DesktopWindowsOpenResult } from './desktopWindowsAction.js';
export { DesktopWindowTargetSchema, DesktopWindowsOpenInputSchema, DesktopWindowsOpenResultSchema } from './desktopWindowsAction.js';
export type { DesktopDisplaysList } from './specs/desktopShell.js';
export { DesktopDisplaysListResultSchema } from './specs/desktopShell.js';
export { SessionOpenDestinationSchema, type SessionOpenDestination } from './sessionOpenDestination.js';
import { SessionPendingWithdrawInputV1Schema, SessionPendingWithdrawResultV1Schema } from '../sessions/control/pendingWithdrawV1.js';
import { SessionPendingMarkHandledInputV1Schema, SessionPendingDeliveryRecoveryInputV1Schema,
  SessionPendingDeliveryRecoveryResultV1Schema, SessionPendingSendAsNewResultV1Schema } from '../sessions/control/pendingDeliveryRecoveryV1.js';
import { MEMORY_DOCUMENT_ACTION_SPECS_V1 } from './specs/memoryDocuments.js';
import { DOC_COLLABORATION_ACTION_SPECS_V1 } from './specs/docCollaboration.js';
import { WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1 } from './specs/workflowEvents.js';
import { MEMORY_DOCUMENT_ACTION_IDS_V1 } from '../prompts/library/memoryActionsV1.js';
import { PROFILE_ACTION_SPECS_V1 } from './specs/profiles.js';
import { MCP_SERVER_ACTION_SPECS_V1 } from './specs/mcpServers.js';
import { REGISTRY_ACTION_SPECS_V1 } from './specs/registries.js';
import { DEPLOYMENT_ACTION_SPECS_V1 } from './specs/deployments.js';
export { readRegistryAgentCliLocatorV1 } from './specs/registries.js';
import { PERSONAL_SAVED_SECRET_ACTION_SPECS_V1 } from './specs/personalSavedSecrets.js';
import { CAPABILITY_RULES_ACTION_SPECS_V1 } from './specs/capabilityRules.js';
import { SESSION_CAPABILITIES_ACTION_SPECS_V1 } from './specs/sessionCapabilities.js';
import { SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1 } from './specs/session/accessDiscovery.js';
import { FRIENDS_ACTION_SPECS } from './specs/friends.js';
import { SKILL_ACTION_SPECS_V1 } from './specs/skills.js';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1, type McpServerActionIdV1 } from '../mcp/servers/serverActionsV1.js';
import { PROVIDER_ACTION_SPECS_V1 } from './specs/providers.js';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1, type ProviderActionIdV1 } from '../providers/providerActionsV1.js';
import { REMOTE_HOST_ACTION_SPECS_V1 } from './specs/remoteHosts.js';
import { HOME_RUNTIME_ACTION_SPECS_V1 } from './specs/homeRuntime.js';
import { ACCOUNT_LIFECYCLE_ACTION_SPECS } from './specs/accountLifecycle.js';
import { HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1, HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1, type HomeRuntimeActionIdV1 } from '../home/runtime/actionsV1.js';
import { REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1, REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1, type RemoteHostActionIdV1 } from '../remoteHosts/remoteHostActionsV1.js';
import { ARTIFACT_FOLDER_ACTION_SPECS_V1 } from './specs/artifactFolders.js';
import { ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1, ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1 } from '../prompts/library/promptFolderActionSchemasV1.js';
import type { ArtifactFolderActionIdV1 } from '../prompts/library/artifactFolderActionIdsV1.js';
import { PROFILE_ACTION_INPUT_SCHEMAS_V1, PROFILE_ACTION_OUTPUT_SCHEMAS_V1, type ProfileActionIdV1 } from '../profiles/profileActionsV1.js';
import { MANAGED_MACHINE_ACTION_SPECS } from './specs/managedMachines.js';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, type ManagedMachineActionIdV1 } from '../machines/managed/actionsV1.js';
import { VOICE_CONVERSATION_ACTION_SPECS, VoiceConversationActionInputSchemas, VoiceConversationActionOutputSchemas, type VoiceConversationActionId } from './voiceConversationActionFamily.js';
import { z } from 'zod/mini';
import { AccountHistoricalEncryptionKeyForgetInputV1Schema, AccountHistoricalEncryptionKeyForgetResultV1Schema,
  AccountEncryptionAutomationTemplatesRecoverInputV1Schema, AccountEncryptionAutomationTemplatesRecoverResultV1Schema } from '../auth/accountSecurity.js';
import { WORK_BOARD_ACTION_IDS_V1, type WorkBoardActionIdV1 } from '../boards/actionIdsV1.js';
import { WorkBoardActionInputSchemasV1, WorkBoardActionOutputSchemasV1 } from '../boards/actionsV1.js';
import { DECISION_ACTION_IDS, TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS, canRequestPresentUserApprovalForActionInputV1 } from './decisionAuthority.js';
export type WorkspaceFilesReplaceActionOutput = z.infer<typeof WorkspaceFilesReplaceActionOutputSchema>;
import { SCM_GIT_ACTION_SPECS } from './scmGitActionSpecs.js';
import { WORKSPACE_ACTION_SPECS, WORKSPACE_ACTION_INPUT_SCHEMAS, WORKSPACE_ACTION_OUTPUT_SCHEMAS, type WorkspaceActionId } from './workspaceActionFamily.js';
import { PROJECT_DEFINITION_ACTION_SPECS, PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS, PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS, type ProjectDefinitionActionId } from './projectDefinitionActionFamily.js';
import { PROJECT_ACTION_SPECS_V1, PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1, type ProjectActionIdV1 } from './projectActionFamily.js';
import { SESSION_TERMINAL_ACTION_SPECS, SESSION_TERMINAL_ACTION_INPUT_SCHEMAS, SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS, type SessionTerminalActionId } from './sessionTerminalActionFamily.js';
import { SESSION_AGENT_TRANSITION_ACTION_SPECS, SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS,
  SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS, type SessionAgentTransitionActionId } from './sessionAgentTransitionActionFamily.js';
import { COMMAND_PALETTE_ACTION_SPECS } from './commandPaletteActionSpecs.js';
import { FIND_ACTION_SPECS } from './findActionSpecs.js';
import { PROMPT_PICKER_ACTION_SPECS } from './promptPickerActionSpecs.js';
import { PROMPT_INVOCATION_CREATE_ACTION_SPECS } from './promptInvocationCreateActionSpecs.js';
import { SESSION_PENDING_NEXT_ACTION_SPECS } from './specs/session/pendingNext.js';
import { SESSION_PENDING_EDIT_ACTION_SPECS, SessionPendingEditInputV1Schema, SessionPendingEditResultV1Schema } from './specs/session/pendingEdit.js';
export { SessionPendingEditInputV1Schema, SessionPendingEditResultV1Schema } from './specs/session/pendingEdit.js';
export type { SessionPendingEditInputV1, SessionPendingEditResultV1 } from './specs/session/pendingEdit.js';
export type { SessionPendingNextOutput } from './specs/session/pendingNext.js';
import { PROJECT_WORKER_ACTION_SPECS, ProjectWorkerActionInputSchemasV1, ProjectWorkerActionOutputSchemasV1,
  type ProjectWorkerActionIdV1 } from './specs/projectWorkers.js';
import { ACTION_OPERATION_ACTION_SPECS, ActionOperationActionInputSchemasV1, ActionOperationActionOutputSchemasV1,
  type ActionOperationActionIdV1 } from './specs/actionOperations.js';
import { SESSION_ORGANIZATION_MOVE_ACTION_SPECS } from './sessionOrganizationMoveAction.js';
import { LIST_REORDER_ACTION_SPECS } from './listReorderAction.js';
import { TODO_SESSION_LINK_ACTION_SPECS } from './todoSessionLinkAction.js';
import { INTERNAL_TASK_ACTION_SPECS } from './internalTaskActions.js';
import { WORKFLOW_AUTHORING_ACTION_SPECS } from './workflowAuthoringAction.js';
import { WORKFLOW_DIAGNOSTIC_ACTION_SPECS } from './workflowDiagnosticActionSpecs.js';
import { COMPOSER_INGRESS_ACTION_SPECS } from './composerIngressAction.js';
import { SETTINGS_DECLARATION_ACTION_IDS_V1, SettingsDeclarationActionInputSchemasV1, SettingsDeclarationActionOutputSchemasV1, type SettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { ActionPolicyInputSchemas, ActionPolicyOutputSchemas, type ActionPolicyActionId } from './actionPolicyActionFamily.js';
import { APP_SHELL_ACTION_IDS, APP_SHELL_ACTION_SPECS } from './appShellActionFamily.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS, NOTIFICATION_CONFIGURATION_ACTION_SPECS, NotificationConfigurationActionInputSchemas, NotificationConfigurationActionOutputSchemas, type NotificationConfigurationActionId } from './notificationConfigurationActionFamily.js';
import { APP_UPDATE_ACTION_IDS, APP_UPDATE_ACTION_SPECS, AppUpdateActionInputSchemas, AppUpdateActionOutputSchemas, type AppUpdateActionId } from './appUpdateActionFamily.js';
import { UPDATES_ACTION_IDS, UPDATES_ACTION_SPECS, UpdatesActionInputSchemas, UpdatesActionOutputSchemas, type UpdatesActionId } from './updatesActionFamily.js';
import { CLIPBOARD_ACTION_SPECS } from './clipboardActionFamily.js';
import { SCREEN_CAPTURE_DELIVERY_ACTION_SPECS, SCREEN_CAPTURE_NATIVE_ACTION_SPECS } from './specs/screenCapture.js';
export { ScreenCaptureOpenInputSchema, ScreenCaptureOpenResultSchema, ScreenCaptureDeliveryInputSchema, ScreenCaptureDiscardInputSchema, ScreenCaptureCopyInputSchema } from './specs/screenCapture.js';
export { ScreenCaptureStartInputSchema, ScreenCapturePermissionRequestInputSchema, ScreenCaptureWindowTextInputSchema,
  ScreenCaptureRecordingInputSchema, ScreenCaptureRecordingEditInputSchema,
  ScreenCaptureRecordingReadInputSchema } from './specs/screenCapture.js';
import { EXTERNAL_LINK_ACTION_SPECS } from './externalLinkActionFamily.js';
import { FILE_SAVE_ACTION_SPECS } from './fileSaveActionFamily.js';
export { FileSaveInputSchema, FileSaveResultSchema } from './fileSaveActionFamily.js';
export type { FileSaveInput } from './fileSaveActionFamily.js';
import { WORKFLOW_EFFECT_ACTION_SPECS_V1, WorkflowEffectActionInputSchemasV1, WorkflowEffectActionOutputSchemasV1, type WorkflowEffectActionIdV1 } from '../workflows/stepActionsV1.js';
import { ROLE_ACTION_IDS_V1, type RoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { RoleActionTargetInputSchemasV1, RoleActionOutputSchemasV1 } from '../prompts/roles/roleActionsV1.js';
import { ARTIFACT_ACCESS_ACTION_IDS_V1, ArtifactAccessActionInputSchemasV1, ArtifactAccessActionOutputSchemasV1, type ArtifactAccessActionIdV1 } from '../artifacts/artifactAccessV1.js';
import { ARTIFACT_ACTION_IDS_V1, ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1, type ArtifactActionIdV1 } from '../artifacts/artifactActionsV1.js';
import {
  MachinePoolActionInputSchemasV1,
  MachinePoolActionOutputSchemasV1,
  type MachinePoolActionIdV1
} from '../machines/pools/actionsV1.js';
import { MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
  type MachinePresetActionIdV1
} from '../machines/managed/machinePresetActionsV1.js';
import {
  EphemeralRunnerActionInputSchemasV1,
  EphemeralRunnerActionOutputSchemasV1,
  type EphemeralRunnerActionIdV1
} from '../ephemeralRunner/actionsV1.js';
import {
  WorkflowActionInputSchemasV1,
  WorkflowActionOutputSchemasV1,
  type WorkflowActionIdV1,
} from '../workflows/actionsV1.js';

import {
  assertPublicActionSdkMethodNames
} from './actionSdkMethodNames.js';

export { resolveActionSdkMethodName } from './actionSdkMethodNames.js';

import {
  type ActionCliCommandBinding
} from './actionCliProjection.js';
import {
  type ActionExecutionPlacement,
  type ActionRequiredAuthority,
  type ActionSurfaces
} from './metadata.js';

import {
  ACTION_IDS,
  ACTION_ID_FAMILIES_V1,
  ActionIdSchema,
  PLUGIN_DEV_LOOP_ACTION_IDS_V1,
  SESSION_MESSAGE_SEND_ACTION_ID_V1,
  RUNTIME_ACTION_IDS_V1,
  type ActionId,
  type PluginDevLoopActionIdV1,
  type RuntimeActionIdV1
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
import { type ActionUiPlacement } from './actionUiPlacements.js';
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
import {
  PLUGIN_WEBHOOK_ACTION_IDS_V1,
  PluginWebhookActionHttpPathsV1,
  PluginWebhookActionInputSchemasV1,
  PluginWebhookActionOutputSchemasV1,
  type PluginWebhookActionIdV1,
  type PluginWebhookPresentUserActionIdV1
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
  AccountTerminalPresentUserPolicySetResponseV1Schema
} from '../auth/accountSecurity.js';
import {
  PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
  PluginSettingsAdministrationActionInputSchemasV1,
  PluginSettingsAdministrationActionOutputV1Schema,
  type PluginSettingsAdministrationActionIdV1
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
import { SessionPendingActionSetInputV1Schema, SessionPendingActionSetResultV1Schema, PendingResetStartSetInputV1Schema, PendingResetStartCancelInputV1Schema, PendingResetStartSetResultV1Schema, PendingResetStartCancelResultV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import {
  RUNTIME_ACTION_INPUT_SCHEMAS,
  RUNTIME_ACTION_OUTPUT_SCHEMAS,
  RUNTIME_ACTION_SPECS,
} from './specs/index.js';
import { HOME_GOVERNANCE_ACTION_SPECS } from './specs/home.js';
import { ACCOUNT_PROFILE_ACTION_SPECS_V1 } from './specs/accountProfile.js';
import { HOME_IDENTITY_ACTION_SPECS } from './specs/homeIdentity.js';
import { SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS } from './specs/sessionOrganization.js';
import { SCOPE_ACTION_SPECS } from './specs/scope.js';
import { DIAGNOSTICS_ACTION_SPECS } from './specs/diagnostics.js';
import { HOME_HUB_LAYOUT_ACTION_SPECS } from './specs/homeHub.js';
import { PROJECT_SOURCE_ACTION_SPECS_V1 } from './specs/projectSources.js';
import { WIDGET_INSTANCE_ACTION_SPECS_V1, WIDGET_DEFINITION_ACTION_SPECS_V1, WIDGET_SNAPSHOT_ACTION_SPECS_V1, WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1 } from './specs/widgets.js';
import type { WidgetInstanceActionIdV1, WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import type { WidgetDefinitionActionIdV1, WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1 } from '../widgets/definitionActionsV1.js';
import type { WidgetLayoutFragmentActionIdV1, WidgetLayoutFragmentActionInputSchemasV1, WidgetLayoutFragmentActionOutputSchemasV1 } from '../widgets/fragmentActionsV1.js';
import { MACHINE_CONNECTION_ACTION_SPECS } from './specs/machineConnection.js';
import { LOCAL_DAEMON_SERVICE_ACTION_SPECS } from './specs/localDaemonService.js';
import { MACHINE_TERMINAL_ACTION_SPECS, MACHINE_TERMINAL_ACTION_IDS, MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS,
  MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS, type MachineTerminalActionId } from './specs/machineTerminal.js';
import { MACHINE_ACCESS_ACTION_SPECS } from './specs/machine/access.js';
import { MACHINE_VITALS_ACTION_SPECS } from './specs/machineVitals.js';
import { MACHINE_PROCESSES_ACTION_SPECS } from './specs/machineProcesses.js';
import { MACHINE_STORAGE_ACTION_SPECS } from './specs/storage.js';
import { MACHINE_RESOURCES_ACTION_SPECS } from './specs/machineResources.js';
import { MACHINE_SERVICE_ACTION_SPECS } from './specs/machine/services.js';
import { MACHINE_SERVICE_ADOPTION_ACTION_SPECS } from './specs/machine/serviceAdoption.js';
import { MACHINE_REBOOT_ACTION_SPECS } from './specs/machine/reboot.js';
import { MACHINE_AGENT_ISOLATION_ACTION_SPECS } from './specs/machine/agentIsolation.js';
import { MACHINE_ADMIN_ACCESS_ACTION_SPECS } from './specs/machine/adminAccess.js';
import { MACHINE_GUARD_ACTION_SPECS } from './specs/machineGuard.js';
import { TEAM_ACTION_SPECS } from './specs/teams.js';
import { SHARED_SAVED_SECRET_ACTION_SPECS } from './specs/sharedSavedSecrets.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS } from './specs/connectedServices.js';
import { USAGE_SOURCE_ACTION_SPECS } from './specs/usageSources.js';
import { USAGE_SOURCE_ACTION_INPUT_SCHEMAS, USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS, type UsageSourceActionId } from '../usage/usageSources.js';
import { USAGE_ACTION_SPECS } from './specs/usage.js';
import { USAGE_COACH_ACTION_SPECS } from './specs/usageCoach.js';
import {
  TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1,
  type TeamCredentialActionIdV1,
} from '../teams/credentials/actionsV1.js';
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
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  type ManagedIdentityProviderActionIdV1,
} from '../identity/providers.js';
import {
  MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1,
  type ManagedGitHubAppActionIdV1
} from '../identity/githubApps.js';
import { isSourceQualifiedLocalServicePreviewActionInput } from './specs/localServices.js';
import {
  type ActionContextualDefaults
} from './contextualDefaults.js';
import { SUBAGENT_ACTION_SPECS } from './specs/session/subagents.js';
import { SESSION_READ_ACTION_SPECS, SESSION_DISCOVERY_ACTION_SPECS } from './specs/session/reads.js';
export { SessionEventsGetInputSchema, type SessionEventsGetInput, type SessionEventsGetItem, type SessionEventsGetOutput, SessionWaitIdleResultSchema, SessionListActionInputV1Schema } from './specs/session/reads.js';
import { SESSION_INTERACTION_ACTION_SPECS } from './specs/session/interaction.js';
import { SESSION_STATE_ACTION_SPECS } from './specs/session/state.js';
export { SessionTargetsResolveInputV1Schema, SessionModelSetInputSchema } from './specs/session/state.js';
import { DISCUSSION_ACTION_SPECS_V1 } from './specs/discussions.js';
import { ARTIFACT_ACCESS_ACTION_SPECS, ARTIFACT_ACTION_SPECS } from './specs/artifacts.js';
import { WORKFLOW_ACTION_SPECS_V1 } from './specs/workflows.js';
import { SESSION_LIFECYCLE_ACTION_SPECS } from './specs/session/lifecycle.js';
export { SESSION_LIFECYCLE_ACTION_SPECS };
export { projectSessionSpawnNewApiRequest } from './specs/session/lifecycle.js';
import { EXECUTION_RUN_ACTION_SPECS } from './specs/executionRuns.js';
import { ACTION_VOICE_ARGS_EXAMPLES } from './specs/voiceExamples.js';
import { resolveBuiltInActionContextualDefaults } from './specs/context.js';
import { resolveActionPluginCallerPolicy } from './specs/callerPolicy.js';
import { createReviewCommentActionSpec } from './specs/reviewComments.js';
import { createAutomationEventActionSpec, createAutomationConversationActionSpec } from './specs/automation.js';
import { AUTOMATION_OCCURRENCE_ACTION_SPECS } from './specs/occurrences.js';
import { AutomationOccurrenceInputSchemas, AutomationOccurrenceOutputSchemas, type AutomationOccurrenceActionId } from '../automations/occurrenceActions.js';
import { PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1 } from './specs/pluginSessionHooks.js';
import { PluginDevLoopActionInputSchemas, PluginDevLoopActionOutputSchemas, createPluginDevLoopActionSpec } from './specs/pluginDevelopment.js';
export * from './specs/pluginPublication.js';
export { PluginScaffoldUiModeSchema, type PluginScaffoldUiMode, DEFAULT_PLUGIN_SCAFFOLD_UI_MODE, PluginScaffoldTemplateSchema, type PluginScaffoldTemplate } from './specs/pluginDevelopment.js';
import { SessionSendMessagePluginInputV1Schema, SESSION_MESSAGE_ACTION_SPECS } from './specs/session/messages.js';
export { SessionSendMessageInputSchema, type SessionMessageSendAuthoredInput } from './specs/session/messages.js';
import { APPROVAL_REQUEST_ACTION_SPECS } from './specs/approvals.js';
import { PERSISTED_TRANSCRIPT_ACTION_SPECS } from './specs/session/persistedTranscript.js';
export { TranscriptOpenedAgentStateV1Schema, type TranscriptOpenedAgentStateV1, TranscriptOpenedSharedMetadataV1Schema, type TranscriptOpenedSharedMetadataV1, TranscriptFollowChangeV1Schema, type TranscriptFollowChangeV1, TranscriptOpenedFollowOutputV1Schema, type TranscriptOpenedFollowOutputV1 } from './specs/session/persistedTranscript.js';
import { EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1 } from './specs/session/external.js';
import { createPluginWebhookActionSpec } from './specs/pluginWebhooks.js';
import { createPluginSettingsAdministrationActionSpec } from './specs/pluginSettings.js';
import { PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS, createPluginPermissionGrantActionSpec } from './specs/pluginPermissions.js';
import { defineActionSpecs } from './specs/definition.js';
import type { ActionSurfaceBindingContext, ActionSurfaceBindingTransform, ActionSpec, ParsedActionSpec, ActionSpecWithoutApproval, PreNormalizedActionSpec, NormalizedActionSpec } from './specs/definition.js';
export { type ApprovalPresentationContext, type ActionSurfaceBindingCaller, type ActionSurfaceBindingContext, type ActionSurfaceBindingTransform, ActionSpecSurfaceBindingsSchema, type ActionSpecSurfaceBindings, ActionPluginCallerPolicySchema, type ActionPluginCallerPolicy, ActionServerTransportSchema, type ActionServerTransport, ActionSpecSchema, type ActionSpec, isPluginActionCallerPolicySatisfied, type ActionSpecWithoutApproval, type PreNormalizedActionSurfaces, type ActionSpecDefinition, type PreNormalizedActionSpec, type ActionSpecProjectionMetadata, defineActionSpecs } from './specs/definition.js';
export { SESSION_TRANSCRIPT_GET_MAX_LIMIT, SessionTranscriptGetExternalShareableInputV1Schema, type SessionTranscriptGetExternalShareableInputV1, SessionTranscriptGetInputSchema, type SessionTranscriptGetInput, type SessionTranscriptGetItem, SessionTranscriptGetExternalShareableResultV1Schema, SessionTranscriptGetResultSchema, type SessionTranscriptGetResult, type SessionTranscriptGetExternalShareableResultV1, type SessionTranscriptGetOutput } from './specs/session/transcript.js';
import { ACCOUNT_SECURITY_ACTION_SPECS } from './specs/account/security.js';
import { WORKSPACE_SYNC_ACTION_SPECS } from './specs/workspaceSync.js';
import { SESSION_ACCESS_ACTION_SPECS } from './specs/session/access.js';
import { MEMORY_ACTION_SPECS } from './specs/memory.js';
import { FILESYSTEM_ACTION_SPECS } from './specs/filesystem.js';
import { EXTERNAL_SESSION_ACTION_SPECS } from './specs/session/external.js';
import { AGENT_CATALOG_ACTION_SPECS, AGENT_INVENTORY_ACTION_SPECS, ACP_BACKEND_ACTION_SPECS } from './specs/agentCatalog.js';
import { PROMPT_DOCUMENT_ACTION_SPECS, PROMPT_INVOCATION_ACTION_SPECS, PROMPT_LIBRARY_ACTION_SPECS } from './specs/prompts.js';
import { REVIEW_ACTION_SPECS } from './specs/reviews.js';
import { PROJECT_CONTEXT_ACTION_SPECS } from './specs/projects.js';
import { SESSION_FOLLOW_ACTION_SPECS, SESSION_FOLLOW_RELATION_ACTION_SPECS } from './specs/session/follow.js';
import { WORK_BOARD_ACTION_SPECS_V1, SESSION_BOARD_ACTION_SPECS } from './specs/session/boards.js';
import { SESSION_LIFETIME_CONTROL_ACTION_SPECS, SESSION_RECOVERY_ACTION_SPECS, SESSION_PENDING_ACTION_SPECS } from './specs/session/control.js';
import { ACTION_CATALOG_ACTION_SPECS, ACTION_OPTIONS_ACTION_SPECS } from './specs/catalog.js';
import { WorkspaceFilesReplaceActionOutputSchema, WORKSPACE_FILE_ACTION_SPECS } from './specs/workspaceFiles.js';
import { UI_CONTEXT_ACTION_SPECS } from './specs/uiContext.js';
import { ROLE_ACTION_SPECS } from './specs/roles.js';
import { ACTION_POLICY_SPECS, SETTINGS_ADMINISTRATION_ACTION_SPECS } from './specs/settings.js';
import { MACHINE_PRESET_ACTION_SPECS, EPHEMERAL_RUNNER_ACTION_SPECS, MACHINE_POOL_ACTION_SPECS } from './specs/managedMachines.js';
import { BUG_REPORT_ACTION_SPECS } from './specs/bugReport.js';
import { MANAGED_GITHUB_APP_ACTION_SPECS } from './specs/identity/githubApps.js';
import { PROFILE_PUBLICATION_ACTION_SPECS } from './specs/profiles.js';
import { CAPTURE_VIEW_ACTION_SPECS } from './specs/plugin/capture.js';
import { WAIT_ACTION_SPECS } from './specs/wait.js';
import { NOTIFICATION_DELIVERY_ACTION_SPECS } from './specs/notifications.js';
import { SESSION_AUTHORING_ACTION_SPECS } from './specs/session/authoring.js';
import { SESSION_SPAWN_ACTION_SPECS } from './specs/session/lifecycle.js';
import { MACHINE_DISCOVERY_ACTION_SPECS } from './specs/machine/discovery.js';
import { SERVER_DISCOVERY_ACTION_SPECS } from './specs/servers.js';
import { REVIEW_ENGINE_DISCOVERY_ACTION_SPECS } from './specs/reviews.js';
import { SESSION_PRESENTATION_ACTION_SPECS } from './specs/session/presentation.js';
import { MODEL_FAVORITE_ACTION_SPECS } from './specs/modelFavorites.js';
import { SESSION_MODEL_UNARM_ACTION_SPECS } from './specs/session/state.js';


















export { WorkspaceFilesReplacePreviewActionInputSchema, WorkspaceFilesReplaceActionInputSchema, type WorkspaceFilesReplacePreviewActionInput, type WorkspaceFilesReplaceActionInput, WorkspaceFilesReplaceActionOutputSchema, WorkspaceFilesSearchActionInputSchema } from './specs/workspaceFiles.js';







export { PromptRegistryInstallInputSchema } from './specs/prompts.js';

export { AgentInventoryProbeInputSchema, type AgentInventoryProbeInput } from './specs/agentCatalog.js';



export { SearchConversationsInputV1Schema, type SearchConversationsInputV1, ConversationSearchSourceFailureV1Schema, type ConversationSearchSourceFailureV1, SearchConversationsResultV1Schema } from './specs/memory.js';




export { DetachedExecutionRunSendInputSchema, ExecutionRunPermissionRespondInputSchema, type ExecutionRunPermissionRespondActionInput } from './specs/executionRuns.js';


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

type AssertNever<T extends never> = T;

// Reference family declarations so this aggregate preserves literal ids and
// schemas without serializing every Zod schema into the inline tuple type.
const ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES: readonly (
  | (typeof SESSION_MESSAGE_PIN_ACTION_SPECS)[number]
  | (typeof DESKTOP_WINDOWS_ACTION_SPECS)[number]
  | (typeof DESKTOP_SHELL_ACTION_SPECS)[number]
  | (typeof MEDIA_ANNOTATION_ACTION_SPECS)[number]
  | (typeof PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS)[number]
  | (typeof USAGE_ACTION_SPECS)[number]
  | (typeof USAGE_COACH_ACTION_SPECS)[number]
  | (typeof HOME_GOVERNANCE_ACTION_SPECS)[number]
  | (typeof ACCOUNT_PROFILE_ACTION_SPECS_V1)[number]
  | (typeof FRIENDS_ACTION_SPECS)[number]
  | (typeof ACCOUNT_LIFECYCLE_ACTION_SPECS)[number]
  | (typeof HOME_IDENTITY_ACTION_SPECS)[number]
  | (typeof SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS)[number]
  | (typeof MACHINE_CONNECTION_ACTION_SPECS)[number]
  | (typeof LOCAL_DAEMON_SERVICE_ACTION_SPECS)[number]
  | (typeof MACHINE_TERMINAL_ACTION_SPECS)[number]
  | (typeof MACHINE_ACCESS_ACTION_SPECS)[number]
  | (typeof MACHINE_VITALS_ACTION_SPECS)[number]
  | (typeof MACHINE_PROCESSES_ACTION_SPECS)[number]
  | (typeof MACHINE_STORAGE_ACTION_SPECS)[number]
  | (typeof MACHINE_RESOURCES_ACTION_SPECS)[number]
  | (typeof MACHINE_SERVICE_ACTION_SPECS)[number]
  | (typeof MACHINE_SERVICE_ADOPTION_ACTION_SPECS)[number]
  | (typeof MACHINE_REBOOT_ACTION_SPECS)[number]
  | (typeof MACHINE_AGENT_ISOLATION_ACTION_SPECS)[number]
  | (typeof MACHINE_ADMIN_ACCESS_ACTION_SPECS)[number]
  | (typeof MACHINE_GUARD_ACTION_SPECS)[number]
  | (typeof TEAM_ACTION_SPECS)[number]
  | (typeof SHARED_SAVED_SECRET_ACTION_SPECS)[number]
  | (typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS)[number]
  | (typeof USAGE_SOURCE_ACTION_SPECS)[number]
  | (typeof PROFILE_ACTION_SPECS_V1)[number]
  | (typeof MCP_SERVER_ACTION_SPECS_V1)[number]
  | (typeof REGISTRY_ACTION_SPECS_V1)[number]
  | (typeof DEPLOYMENT_ACTION_SPECS_V1)[number]
  | (typeof PERSONAL_SAVED_SECRET_ACTION_SPECS_V1)[number]
  | (typeof CAPABILITY_RULES_ACTION_SPECS_V1)[number]
  | (typeof SESSION_CAPABILITIES_ACTION_SPECS_V1)[number]
  | (typeof SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1)[number]
  | (typeof SKILL_ACTION_SPECS_V1)[number]
  | (typeof PROVIDER_ACTION_SPECS_V1)[number]
  | (typeof REMOTE_HOST_ACTION_SPECS_V1)[number]
  | (typeof HOME_RUNTIME_ACTION_SPECS_V1)[number]
  | (typeof ARTIFACT_FOLDER_ACTION_SPECS_V1)[number]
  | (typeof MANAGED_IDENTITY_PROVIDER_ACTION_SPECS)[number]
  | (typeof MANAGED_GITHUB_APP_ACTION_SPECS)[number]
  | (typeof PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1)[number]
  | (typeof EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1)[number]
  | (typeof WORKFLOW_ACTION_SPECS_V1)[number]
  | (typeof WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1)[number]
)[] = Object.freeze([
  ...SESSION_MESSAGE_PIN_ACTION_SPECS,
  ...MEDIA_ANNOTATION_ACTION_SPECS,
  ...PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS,
  ...USAGE_ACTION_SPECS,
  ...USAGE_COACH_ACTION_SPECS,
  ...HOME_GOVERNANCE_ACTION_SPECS,
  ...ACCOUNT_PROFILE_ACTION_SPECS_V1,
  ...FRIENDS_ACTION_SPECS,
  ...ACCOUNT_LIFECYCLE_ACTION_SPECS,
  ...HOME_IDENTITY_ACTION_SPECS,
  ...SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS,
  ...MACHINE_CONNECTION_ACTION_SPECS,
  ...LOCAL_DAEMON_SERVICE_ACTION_SPECS,
  ...MACHINE_TERMINAL_ACTION_SPECS,
  ...MACHINE_ACCESS_ACTION_SPECS,
  ...MACHINE_VITALS_ACTION_SPECS,
  ...MACHINE_PROCESSES_ACTION_SPECS,
  ...MACHINE_STORAGE_ACTION_SPECS,
  ...MACHINE_RESOURCES_ACTION_SPECS,
  ...MACHINE_SERVICE_ACTION_SPECS,
  ...MACHINE_SERVICE_ADOPTION_ACTION_SPECS,
  ...MACHINE_REBOOT_ACTION_SPECS,
  ...MACHINE_AGENT_ISOLATION_ACTION_SPECS,
  ...MACHINE_ADMIN_ACCESS_ACTION_SPECS,
  ...MACHINE_REACHABILITY_ACTION_SPECS_V1,
  ...MACHINE_GUARD_ACTION_SPECS,
  ...TEAM_ACTION_SPECS,
  ...SHARED_SAVED_SECRET_ACTION_SPECS,
  ...CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS,
  ...USAGE_SOURCE_ACTION_SPECS,
  ...PROFILE_ACTION_SPECS_V1,
  ...MCP_SERVER_ACTION_SPECS_V1,
  ...REGISTRY_ACTION_SPECS_V1,
  ...DEPLOYMENT_ACTION_SPECS_V1,
  ...PERSONAL_SAVED_SECRET_ACTION_SPECS_V1,
  ...CAPABILITY_RULES_ACTION_SPECS_V1,
  ...SESSION_CAPABILITIES_ACTION_SPECS_V1,
  ...SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1,
  ...SKILL_ACTION_SPECS_V1,
  ...PROVIDER_ACTION_SPECS_V1,
  ...REMOTE_HOST_ACTION_SPECS_V1,
  ...HOME_RUNTIME_ACTION_SPECS_V1,
  ...(BOT_TEMPLATE_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...ARTIFACT_FOLDER_ACTION_SPECS_V1,
  ...MANAGED_IDENTITY_PROVIDER_ACTION_SPECS,
  ...MANAGED_GITHUB_APP_ACTION_SPECS,
  ...PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1,
  ...EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1,
  ...WORKFLOW_ACTION_SPECS_V1,
  ...WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1,
]);

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_OPENING = Object.freeze(defineActionSpecs([
  ...(MEMORY_DOCUMENT_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(DOC_COLLABORATION_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(PROJECT_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(WORKFLOW_EFFECT_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(WORKSPACE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROJECT_DEFINITION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(WORKFLOW_AUTHORING_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(WORKFLOW_DIAGNOSTIC_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(COMPOSER_INGRESS_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_ORGANIZATION_MOVE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(LIST_REORDER_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(TODO_SESSION_LINK_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(INTERNAL_TASK_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_TERMINAL_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_AGENT_TRANSITION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(APP_SHELL_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(NOTIFICATION_CONFIGURATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(APP_UPDATE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(UPDATES_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(CLIPBOARD_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SCREEN_CAPTURE_DELIVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SCREEN_CAPTURE_NATIVE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(DESKTOP_WINDOWS_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(DESKTOP_SHELL_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(EXTERNAL_LINK_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(FILE_SAVE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(CODE_INTELLIGENCE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(VOICE_CONVERSATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SCOPE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(DIAGNOSTICS_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_MIDDLE = Object.freeze(defineActionSpecs([
  ...(WORK_BOARD_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(WIDGET_INSTANCE_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(WIDGET_DEFINITION_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(WIDGET_SNAPSHOT_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(HOME_HUB_LAYOUT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROJECT_SOURCE_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(ARTIFACT_ACCESS_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ARTIFACT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROFILE_PUBLICATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD = Object.freeze(defineActionSpecs([
  ...(ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_OPENING satisfies readonly PreNormalizedActionSpec[]),
  ...(ACTION_POLICY_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SETTINGS_ADMINISTRATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_MIDDLE satisfies readonly PreNormalizedActionSpec[]),
  ...(ROLE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PLUGIN_DEV_LOOP_ACTION_IDS_V1.map(createPluginDevLoopActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  ...(NPM_REGISTRY_PROFILE_ACTION_SPECS_V1 satisfies readonly PreNormalizedActionSpec[]),
  ...(PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(CAPTURE_VIEW_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1.map(createPluginSettingsAdministrationActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  ...(PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1.map(createPluginPermissionGrantActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  ...(PLUGIN_WEBHOOK_ACTION_IDS_V1.map(createPluginWebhookActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  ...(AUTOMATION_EVENT_ACTION_IDS_V1.map(createAutomationEventActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  ...AUTOMATION_OCCURRENCE_ACTION_SPECS,
  ...(AUTOMATION_CONVERSATION_ACTION_IDS_V1.map(createAutomationConversationActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  ...(REVIEW_COMMENT_ACTION_IDS_V1.map(createReviewCommentActionSpec) satisfies readonly PreNormalizedActionSpec[]),
  // Runtime rows' exact carriers are projected from their family schema maps
  // below. Avoid serializing that complete union again inside this tuple.
  ...((RUNTIME_ACTION_SPECS as readonly PreNormalizedActionSpec[]) satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_OPENING = Object.freeze(defineActionSpecs([
  ...(MACHINE_PRESET_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(MANAGED_MACHINE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROJECT_WORKER_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ACTION_OPERATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(MACHINE_POOL_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(EPHEMERAL_RUNNER_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ACCOUNT_SECURITY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ACTION_CATALOG_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(WAIT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(NOTIFICATION_DELIVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ACTION_OPTIONS_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(REVIEW_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SUBAGENT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_MIDDLE = Object.freeze(defineActionSpecs([
  ...(EXECUTION_RUN_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_LIFECYCLE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_REMAINDER = Object.freeze(defineActionSpecs([
  ...(WORKSPACE_SYNC_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_AUTHORING_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_SPAWN_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROJECT_CONTEXT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROMPT_INVOCATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(MACHINE_DISCOVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SERVER_DISCOVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(REVIEW_ENGINE_DISCOVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(AGENT_INVENTORY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(WORKSPACE_FILE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(AGENT_CATALOG_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_MESSAGE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_LIFETIME_CONTROL_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

// Keep exact schema carriers in the source tuples and project them below;
// the runtime aggregate must not serialize their complete schema union again.
const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX: readonly PreNormalizedActionSpec[] = Object.freeze([
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_OPENING,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_MIDDLE,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_REMAINDER,
]);

const ACTION_SPECS_WITHOUT_APPROVAL_PENDING: readonly PreNormalizedActionSpec[] = Object.freeze(defineActionSpecs([
  ...(SESSION_PENDING_EDIT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_PENDING_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING = Object.freeze(defineActionSpecs([
  ...(SESSION_PRESENTATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_BOARD_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),

  // The Home-owned Discussion family. People reach these through the UI
  // and CLI executors; an Agent reaches the reads and the deliberate post through
  // the same rows under its own admitted execution principal. Discussion content
  // is sealed and opened by the executor through the existing Discussion key, so
  // these inputs carry strict semantic plaintext and never the storage envelope.
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION = Object.freeze(defineActionSpecs([
  ...(SESSION_STATE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_ACCESS_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_FOLLOW_RELATION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX = Object.freeze(defineActionSpecs([
  ...(SESSION_FOLLOW_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_RECOVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_READ_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_INTERACTION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_DISCOVERY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

// Keep exact Session row/schema carriers in a separately named tuple so the
// declaration serializer does not have to inline the entire trailing catalog.
const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_OPENING = Object.freeze(defineActionSpecs([
  ...(UI_CONTEXT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(MEMORY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(ACP_BACKEND_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROMPT_DOCUMENT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(MODEL_FAVORITE_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_MODEL_UNARM_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(PROMPT_LIBRARY_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(FILESYSTEM_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  ...(BUG_REPORT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

// Name the trailing schema carriers separately so declaration emission preserves
// exact Action ids and schemas without serializing the whole suffix in one node.
const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_APPROVAL = Object.freeze(defineActionSpecs([
  ...(APPROVAL_REQUEST_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_TRANSCRIPT = Object.freeze(defineActionSpecs([
  ...(PERSISTED_TRANSCRIPT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_EXTERNAL = Object.freeze(defineActionSpecs([
  ...(EXTERNAL_SESSION_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
  // Keep this generated family out of the large suffix tuple's serialized
  // inference. Its exact schemas remain in the canonical family projection.
  ...(SCM_GIT_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec) satisfies readonly PreNormalizedActionSpec[]),
  ...(COMMAND_PALETTE_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec) satisfies readonly PreNormalizedActionSpec[]),
  ...(FIND_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec) satisfies readonly PreNormalizedActionSpec[]),
  ...(PROMPT_PICKER_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec) satisfies readonly PreNormalizedActionSpec[]),
  ...(PROMPT_INVOCATION_CREATE_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec) satisfies readonly PreNormalizedActionSpec[]),
  ...(SESSION_PENDING_NEXT_ACTION_SPECS satisfies readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX: readonly (
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_APPROVAL)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_TRANSCRIPT)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_EXTERNAL)[number]
)[] = Object.freeze([
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_APPROVAL,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_TRANSCRIPT,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_EXTERNAL,
]);

const ACTION_SPECS_WITHOUT_APPROVAL: readonly (
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PENDING)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING)[number]
  | (typeof DISCUSSION_ACTION_SPECS_V1)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_OPENING)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX)[number]
)[] = Object.freeze([
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD,
  ...ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PENDING,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING,
  ...DISCUSSION_ACTION_SPECS_V1,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_OPENING,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX,
]);

// Coordination ruling, 2026-10-14: this plugin-originated request is not a
// user UI capability. Grant/dismiss remain human-owned approval proposals;
// list/revoke are user administration and are exposed to Agent and MCP.
export const AGENT_ACTION_EXCLUSION_REASONS = Object.freeze({
  'secrets.shared.reveal': 'Only the present person in the app may display a Saved Secret; no agent hold.',
  'plugins.permissions.grants.request': 'Permission requests originate from host-stamped plugin provenance, not a user UI operation.',
  'session.view.toolCalls.set': 'Plan 60 §6 reserves transcript visibility for human UI, user Voice and genuine CLI callers.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

/**
 * API exclusions for plugin protocol operations whose canonical input relies
 * on host-stamped provenance. Agent/MCP user administration is independently
 * declared by each Action's surfaces; this API list does not exclude it.
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
  ...ACTION_ID_FAMILIES_V1.bug_report_submission,
  'browser.workspace.open',
  ...ACTION_ID_FAMILIES_V1.local_daemon_services,
  ...ACTION_ID_FAMILIES_V1.account_home_continuation,
  ...ACTION_ID_FAMILIES_V1.session_authoring,
  ...ACTION_ID_FAMILIES_V1.composer_ingress,
  ...ACTION_ID_FAMILIES_V1.workflow_authoring,
  ...ACTION_ID_FAMILIES_V1.list_reorder,
  ...ACTION_ID_FAMILIES_V1.session_organization_move,
  'account.encryption.historicalKey.forget',
  'account.encryption.automationTemplates.recover',
  ...NOTIFICATION_CONFIGURATION_ACTION_IDS,
  ...APP_UPDATE_ACTION_IDS,
  ...UPDATES_ACTION_IDS,
  ...ACTION_ID_FAMILIES_V1.session_terminals,
  ...ACTION_ID_FAMILIES_V1.workspace_layout,
  ...APP_SHELL_ACTION_IDS,
  'connectedServices.identityPrivacy.set',
  'connectedServices.billing.open',
  'home.reachNudge.dismiss',
  ...SETTINGS_DECLARATION_ACTION_IDS_V1,
  'homes.connect',
  'machines.add.command',
  'machines.add.local.start',
  'machines.pairing.create',
  'machines.add.ssh.start',
  'machines.add.ssh.status',
  'machines.add.ssh.respond',
  'machines.managed.bootstrap.respond',
  'machines.add.ssh.cancel',
  'servers.list',
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
  'plugins.uninstall',
  'plugins.dev.submit',
  'plugins.dev.unregister',
  'plugins.dev.install',
  'plugins.sessionHooks.install',
  'plugins.sessionHooks.disable',
  'plugins.sessionHooks.enable',
  'plugins.sessionHooks.uninstall',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.dismissRequest',
  ...(Object.keys(PluginWebhookActionHttpPathsV1) as PluginWebhookPresentUserActionIdV1[])
    .filter(actionId => actionId !== 'plugin.webhook.delivery.replay' && actionId !== 'plugin.webhook.delivery.discard'),
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
  'browser.workspace.open',
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
  const declaredPlacementIds = new Set<ActionId>();
  // Row declarations own placement; the legacy census fills only undeclared rows.
  for (const spec of ACTION_SPECS_WITHOUT_APPROVAL) {
    if ('executionPlacement' in spec && spec.executionPlacement) {
      placements.set(spec.id, spec.executionPlacement);
      declaredPlacementIds.add(spec.id);
    }
  }
  const register = (placement: ActionExecutionPlacement, actionIds: readonly ActionId[]) => {
    for (const actionId of actionIds) {
      if (declaredPlacementIds.has(actionId)) continue;
      if (placements.has(actionId)) {
        throw new Error(`Action ${actionId} has more than one execution placement`);
      }
      placements.set(actionId, placement);
    }
  };

  // Account/server data can run before an exact machine is known.
  register('account', [
    ...MEMORY_DOCUMENT_ACTION_IDS_V1,
    ...PROJECT_SOURCE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...MANAGED_MACHINE_ACTION_SPECS.filter((spec) => spec.executionPlacement === 'account').map((spec) => spec.id),
    'home.hub.layout.get',
    'home.hub.layout.update',
    ...ACTION_ID_FAMILIES_V1.todo_session_link,
    ...ACTION_ID_FAMILIES_V1.observation,
    ...ACTION_ID_FAMILIES_V1.connected_services_configuration.filter((id) => id !== 'connectedServices.identityPrivacy.set' && id !== 'connectedServices.quota.reset' && id !== 'connectedServices.billing.open'),
    ...WORK_BOARD_ACTION_IDS_V1,
    ...ARTIFACT_ACCESS_ACTION_IDS_V1,
    ...ARTIFACT_ACTION_IDS_V1.filter((id) => id !== 'artifact.publish_from_file' && id !== 'artifact.export'),
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
    'prompts.stack.update',
    'prompts.invocations.list',
    'prompts.invocation.resolve',
    'prompt_doc.update',
    'prompt_bundle.update',
    // The custom ACP catalog is an Account setting: no machine has to be reachable to edit it.
    ...ACTION_ID_FAMILIES_V1.agent_acp_catalog,
    ...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('roles.')),
    'launch_profiles.publish',
    ...PROFILE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...MCP_SERVER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...CAPABILITY_RULES_ACTION_SPECS_V1.map(spec => spec.id),
    ...SKILL_ACTION_SPECS_V1.map(spec => spec.id),
    ...PROVIDER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...REMOTE_HOST_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...ACTION_ID_FAMILIES_V1.approvals,
    ...ACTION_ID_FAMILIES_V1.plugin_permission_grants,
    ...ACTION_ID_FAMILIES_V1.plugin_webhooks,
    ...ACTION_ID_FAMILIES_V1.account_plugin_data,
    ...ACTION_ID_FAMILIES_V1.account_sessions,
    ...ACTION_ID_FAMILIES_V1.discussion,
    ...ACTION_ID_FAMILIES_V1.account_security.filter((id) => id !== 'account.encryption.historicalKey.forget'
      && id !== 'account.encryption.automationTemplates.recover'),
    ...ACTION_ID_FAMILIES_V1.account_api_tokens,
    ...ACTION_ID_FAMILIES_V1.session_organization_resources,
    ...ACTION_ID_FAMILIES_V1.identity_github_apps,
    ...ACTION_ID_FAMILIES_V1.machine_pools,
    ...ACTION_ID_FAMILIES_V1.machine_presets,
    ...ACTION_ID_FAMILIES_V1.ephemeral_runner,
    ...ACTION_ID_FAMILIES_V1.automation_events,
    ...ACTION_ID_FAMILIES_V1.automation_occurrences,
    ...ACTION_ID_FAMILIES_V1.automation_conversation,
    // The Home decides governance, Team and Home-identity operations in its own
    // transaction, so these are Account-placed regardless of which machine
    // invoked them. Identity providers travel the same Home family port.
    ...ACTION_ID_FAMILIES_V1.home_governance,
    ...ACTION_ID_FAMILIES_V1.home_identity,
    ...ACTION_ID_FAMILIES_V1.teams,
    ...ACTION_ID_FAMILIES_V1.identity_providers,
    ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
    ...ACTION_ID_FAMILIES_V1.widgets.filter((id) => id !== 'widgets.item.refresh'),
    ...ACTION_ID_FAMILIES_V1.workflows.filter((actionId) => actionId !== 'workflow.run.start'),
  ]);

  // These actions require an answering app's runtime. Discovery remains
  // placement-neutral; admitted daemon hosts deliver through reverse RPC,
  // while absent client custody returns the canonical typed unavailable result.
  register('client', CLIENT_EXECUTION_PLACEMENT_ACTION_IDS);
  register('client', PROJECT_SOURCE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'client').map(spec => spec.id));
  register('client', ACTION_ID_FAMILIES_V1.capture_viewing);
  register('client', ACTION_ID_FAMILIES_V1.scope);
  register('client', ACTION_ID_FAMILIES_V1.command_palette);
  register('client', ACTION_ID_FAMILIES_V1.find);
  register('client', ACTION_ID_FAMILIES_V1.prompt_picker);
  register('client', ACTION_ID_FAMILIES_V1.widgets.filter((id) => id === 'widgets.item.refresh'));
  register('client', PROFILE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'client').map(spec => spec.id));
  register('client', REMOTE_HOST_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'client').map(spec => spec.id));
  register('client', ACTION_ID_FAMILIES_V1.home_runtime.filter(id => id !== 'home.runtime.restart'));
  register('machine', ['home.runtime.restart']);
  register('machine', PROFILE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'machine').map(spec => spec.id));
  register('machine', MCP_SERVER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'machine').map(spec => spec.id));
  register('machine', PROVIDER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'machine').map(spec => spec.id));
  // Workflow effect actions declare their placement on their own spec (`stepActionsV1`).
  for (const spec of WORKFLOW_EFFECT_ACTION_SPECS_V1) register(spec.executionPlacement, [spec.id]);

  // A canonical Session resolves its current machine/daemon owner. Execution
  // runs are intentionally absent: detached runs have no Session owner.
  register('session', [
    ...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('session.')),
    ...ACTION_ID_FAMILIES_V1.session_lifecycle.filter((actionId) => actionId !== 'session.spawn_new'),
    'review.engines.list',
    ...ACTION_ID_FAMILIES_V1.messaging,
    ...ACTION_ID_FAMILIES_V1.session_control.filter((actionId) => actionId !== 'session.history.get'),
    ...ACTION_ID_FAMILIES_V1.intent_start,
    ...ACTION_ID_FAMILIES_V1.subagent_registry,
    'session.activity.get',
    ...ACTION_ID_FAMILIES_V1.session_transcripts.filter(
      (actionId) => !PERSISTED_TRANSCRIPT_READ_ACTION_ID_SET.has(actionId),
    ),
    ...ACTION_ID_FAMILIES_V1.session_permissions,
    // The Board lives on the Session's own Home; its records resolve through that owner.
    ...ACTION_ID_FAMILIES_V1.session_board,
    'browser.recording.attachToComposer',
    'sessions.external.follow',
    'sessions.external.unfollow',
    'sessions.external.backgroundFollow.set',
    'sessions.external.status.get',
    'sessions.external.transcript.readAfter',
  ]);

  // The remaining operations are daemon/machine-owned. This includes detached
  // execution runs, local indexes/filesystem/plugin/scm owners, and external
  // session operations whose request selects a concrete daemon runtime.
  register('machine', [
    ...MANAGED_MACHINE_ACTION_SPECS.filter((spec) => spec.executionPlacement === 'machine').map((spec) => spec.id),
    'artifact.publish_from_file',
    'artifact.export',
    'connectedServices.quota.reset',
    ...MACHINE_TERMINAL_ACTION_IDS,
    ...ACTION_ID_FAMILIES_V1.machine_agent_install,
    'action.options.resolve',
    'action.invoke',
    'session.spawn_new',
    ...PERSISTED_TRANSCRIPT_READ_ACTION_IDS,
    'paths.list_recent',
    'projects.open',
    'agents.backends.list',
    'machines.agents.list',
    ...ACTION_ID_FAMILIES_V1.workflow_event_catalog,
    'workspace.files.search',
    ...ACTION_ID_FAMILIES_V1.code_intelligence,
    'workspace.files.replace.preview',
    'workspace.files.replace',
    ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
    'agents.models.list',
    'agents.config_options.list',
    'agents.session_modes.list',
    'sessions.spawn.profiles.list',
    'sessions.spawn.connected_services.list',
    'sessions.spawn.mcp_servers.preview',
    ...ACTION_ID_FAMILIES_V1.execution_run_control,
    'workflow.run.start',
    ...ACTION_ID_FAMILIES_V1.memory.filter(id => !MEMORY_DOCUMENT_ACTION_IDS_V1.some(documentId => documentId === id)),
    'prompt_registry.install',
    ...ACTION_ID_FAMILIES_V1.daemon_admin,
    ...ACTION_ID_FAMILIES_V1.filesystem,
    ...ACTION_ID_FAMILIES_V1.plugin_dev_loop,
    ...ACTION_ID_FAMILIES_V1.plugin_settings_administration,
    'sessions.external.candidates.list',
    'sessions.external.candidate.delete',
    'sessions.external.link.ensure',
    'sessions.external.transcript.page',
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

/** Disclosure from the admitted declaration/input; never execution or approval authority. */
export function resolveActionPermissionChangingV1(
  spec: Readonly<{ permissionChanging?: true; permissionChangingForInput?: (input: unknown) => boolean }>,
  admittedInput?: unknown,
): boolean {
  return spec.permissionChanging === true || spec.permissionChangingForInput?.(admittedInput) === true;
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
  const canExposeCli = executionPlacement !== 'client' || spec.cli !== undefined;
  const clientRouted = executionPlacement === 'client' || spec.executionPlacements?.includes('client');
  const routeSurface = <T extends { inputSchema?: z.ZodMiniType; bindInput?: ActionSurfaceBindingTransform }>(binding: T): T => {
    const bind = binding.bindInput;
    return { ...binding,
      ...(binding.inputSchema ? { inputSchema: withClientActionInput(binding.inputSchema) } : {}),
      ...(bind ? { bindInput: async (input: unknown, context: ActionSurfaceBindingContext) =>
        retainClientActionInput(input, await bind(input, context)) } : {}),
    };
  };
  // Automation proposes human-owned effects through the ordinary approval owner.
  const presentUserRequestable = !isInternal
    && !Object.hasOwn(AGENT_ACTION_EXCLUSION_REASONS, spec.id)
    && canRequestPresentUserApprovalForActionInputV1({
      id: spec.id, requiredAuthority, approvalInputCustody: spec.approvalInputCustody,
    });
  return {
    ...spec,
    requiredAuthority,
    executionPlacement,
    ...(clientRouted ? {
      inputSchema: withClientActionInput(spec.inputSchema),
      clientActionDomainInputSchema: spec.inputSchema,
      ...(spec.surfaceBindings ? { surfaceBindings: { ...spec.surfaceBindings,
        ...(spec.surfaceBindings.api ? { api: routeSurface(spec.surfaceBindings.api) } : {}),
        ...(spec.surfaceBindings.plugin ? { plugin: routeSurface(spec.surfaceBindings.plugin) } : {}),
        ...(spec.surfaceBindings.rpc ? { rpc: { ...spec.surfaceBindings.rpc,
          inputSchema: withClientActionInput(spec.surfaceBindings.rpc.inputSchema),
          decodeInput: async (input, context) => retainClientActionInput(input,
            await spec.surfaceBindings!.rpc!.decodeInput(input, context)),
        } } : {}),
      } } : {}),
    } : {}),
    cli: canExposeCli && spec.cli ? { ...spec.cli,
      ...(clientRouted && spec.cli.inputSchema
        ? { inputSchema: withClientActionInput(spec.cli.inputSchema) } : {}),
      ...(clientRouted && spec.cli.bindInput ? { bindInput: (input, context) =>
        retainClientActionInput(input, spec.cli!.bindInput!(input, context)) } : {}),
    } : undefined,
    surfaces: {
      ...spec.surfaces,
      // Explicit client commands use the mounted answering-owner transport;
      // undeclared client-owned Actions remain unavailable as CLI commands.
      cli: canExposeCli && spec.surfaces.cli,
      mcp: spec.surfaces.mcp || presentUserRequestable
        || spec.id === 'account.apiTokens.list' || spec.id === 'account.security.get',
      agent: spec.surfaces.agent || presentUserRequestable
        || spec.id === 'account.apiTokens.list' || spec.id === 'account.security.get',
      api: spec.surfaces.api !== false && !isInternal
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
  TInputSchema extends z.ZodMiniType,
  TOutputSchema extends z.ZodMiniType,
  TSurfaceBindings = never,
  TRequiredAuthority extends ActionRequiredAuthority = TActionId extends PresentUserRequiredActionId
    ? 'present_user'
    : 'account_automation',
> = Readonly<{
  id: TActionId;
  approval: ParsedActionSpec['approval'];
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
  | LiteralActionSpecTupleDefinition<typeof CODE_INTELLIGENCE_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof CLIPBOARD_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof DESKTOP_WINDOWS_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof DESKTOP_SHELL_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof SCREEN_CAPTURE_DELIVERY_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof SCREEN_CAPTURE_NATIVE_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof EXTERNAL_LINK_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof FILE_SAVE_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof SESSION_ORGANIZATION_MOVE_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof LIST_REORDER_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof TODO_SESSION_LINK_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof INTERNAL_TASK_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof APP_SHELL_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof HOME_HUB_LAYOUT_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof PROJECT_SOURCE_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof DEPLOYMENT_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof MACHINE_REACHABILITY_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof WIDGET_SNAPSHOT_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_OPENING>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_MIDDLE>
  | LiteralActionSpecTupleDefinition<typeof CAPTURE_VIEW_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD>
  | LiteralActionSpecDefinition<(typeof ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES)[number]>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_OPENING>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_MIDDLE>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_REMAINDER>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING>
  | LiteralActionSpecTupleDefinition<typeof DISCUSSION_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX_OPENING>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX>;

type SessionPendingCustodyActionSpecDefinition =
  | CanonicalActionSchemaDefinition<
      'session.pending.edit',
      typeof SessionPendingEditInputV1Schema,
      typeof SessionPendingEditResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.action.set',
      typeof SessionPendingActionSetInputV1Schema,
      typeof SessionPendingActionSetResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.markHandled',
      typeof SessionPendingMarkHandledInputV1Schema,
      typeof SessionPendingDeliveryRecoveryResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.dismiss',
      typeof SessionPendingDeliveryRecoveryInputV1Schema,
      typeof SessionPendingDeliveryRecoveryResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.sendAsNew',
      typeof SessionPendingDeliveryRecoveryInputV1Schema,
      typeof SessionPendingSendAsNewResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.withdraw',
      typeof SessionPendingWithdrawInputV1Schema,
      typeof SessionPendingWithdrawResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.resetStart.set',
      typeof PendingResetStartSetInputV1Schema,
      typeof PendingResetStartSetResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.resetStart.cancel',
      typeof PendingResetStartCancelInputV1Schema,
      typeof PendingResetStartCancelResultV1Schema
    >;

type NonRuntimeActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  // These families have exact per-ID schema definitions below. Their generic
  // row factories must not reintroduce widened schema unions into the catalog.
  ? TActionId extends RuntimeActionIdV1 | SessionTerminalActionId | SessionAgentTransitionActionId | MachineTerminalActionId | WorkspaceActionId | ProjectDefinitionActionId
    | WidgetInstanceActionIdV1 | WidgetDefinitionActionIdV1 | WidgetLayoutFragmentActionIdV1
    | ArtifactFolderActionIdV1 | ProfileActionIdV1 | ProviderActionIdV1 | RemoteHostActionIdV1 | HomeRuntimeActionIdV1 | ProjectActionIdV1 | WorkflowEffectActionIdV1 | UsageSourceActionId
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
    (typeof PluginDevLoopActionOutputSchemas)[TActionId]
  > & (TActionId extends 'plugins.install'
    ? Readonly<{ surfaces: Readonly<{ api: false }> }> : unknown);
}[PluginDevLoopActionIdV1];

type PluginSettingsAdministrationActionSpecDefinition = {
  [TActionId in PluginSettingsAdministrationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginSettingsAdministrationActionInputSchemasV1)[TActionId],
    typeof PluginSettingsAdministrationActionOutputV1Schema
  > & (TActionId extends `plugins.settings.secret.${'bind' | 'unbind' | 'delete'}`
    ? Readonly<{ surfaces: Readonly<{ api: false }> }> : unknown);
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

type AutomationOccurrenceActionSpecDefinition = {
  [Id in AutomationOccurrenceActionId]: CanonicalActionSchemaDefinition<Id,
    (typeof AutomationOccurrenceInputSchemas)[Id], (typeof AutomationOccurrenceOutputSchemas)[Id]>;
}[AutomationOccurrenceActionId];

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

type MachinePresetActionSpecDefinition = {
  [Id in MachinePresetActionIdV1]: CanonicalActionSchemaDefinition<Id,
    (typeof MachinePresetActionInputSchemasV1)[Id], (typeof MachinePresetActionOutputSchemasV1)[Id]>;
}[MachinePresetActionIdV1];

type ManagedMachineActionSpecDefinition = {
  [TActionId in ManagedMachineActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ManagedMachineActionInputSchemasV1)[TActionId],
    (typeof ManagedMachineActionOutputSchemasV1)[TActionId]
  >;
}[ManagedMachineActionIdV1];

type ProjectWorkerActionSpecDefinition = {
  [TActionId in ProjectWorkerActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ProjectWorkerActionInputSchemasV1)[TActionId],
    (typeof ProjectWorkerActionOutputSchemasV1)[TActionId]
  >;
}[ProjectWorkerActionIdV1];

type ActionOperationActionSpecDefinition = {
  [TActionId in ActionOperationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ActionOperationActionInputSchemasV1)[TActionId],
    (typeof ActionOperationActionOutputSchemasV1)[TActionId]
  >;
}[ActionOperationActionIdV1];

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
    (typeof RoleActionTargetInputSchemasV1)[TActionId],
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

type BotTemplateActionSpecDefinition = {
  [Id in BotTemplateActionIdV1]: CanonicalActionSchemaDefinition<Id,
    (typeof BotTemplateActionInputSchemasV1)[Id], (typeof BotTemplateActionOutputSchemasV1)[Id], never, 'account_automation'>;
}[BotTemplateActionIdV1];

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

type ActionPolicyActionSpecDefinition = {
  [Id in ActionPolicyActionId]: CanonicalActionSchemaDefinition<Id,
    (typeof ActionPolicyInputSchemas)[Id], (typeof ActionPolicyOutputSchemas)[Id], never,
    Id extends 'actions.policy.get' ? 'account_automation' : 'present_user'>;
}[ActionPolicyActionId];

type WorkspaceActionSpecDefinition = {
  [TActionId in WorkspaceActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WORKSPACE_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof WORKSPACE_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[WorkspaceActionId];

type ProjectDefinitionActionSpecDefinition = {
  [Id in ProjectDefinitionActionId]: CanonicalActionSchemaDefinition<Id,
    (typeof PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS)[Id], (typeof PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS)[Id]>;
}[ProjectDefinitionActionId];

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

type WidgetLayoutFragmentActionSpecDefinition = {
  [Id in WidgetLayoutFragmentActionIdV1]: CanonicalActionSchemaDefinition<Id,
    (typeof WidgetLayoutFragmentActionInputSchemasV1)[Id], (typeof WidgetLayoutFragmentActionOutputSchemasV1)[Id],
    never, (typeof WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1)[number]['requiredAuthority']>;
}[WidgetLayoutFragmentActionIdV1];

type SessionTerminalActionSpecDefinition = {
  [TActionId in SessionTerminalActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SESSION_TERMINAL_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[SessionTerminalActionId];

type MachineTerminalActionSpecDefinition = {
  [TActionId in MachineTerminalActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[MachineTerminalActionId];

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
    (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId],
    never,
    TActionId extends 'teams.credentials.test' ? 'present_user' : 'account_automation'
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
 * projecting their wire schemas here rather than letting that implementation
 * detail degrade their inputs and results to `unknown`.
 */
type AccountSecurityActionSpecDefinition =
  | CanonicalActionSchemaDefinition<
      'account.plugins.data.erase',
      typeof PluginAccountDataEraseActionInputV1Schema,
      typeof PluginAccountDataEraseActionOutputV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.sessions.signOutEverywhere',
      typeof AccountSessionsSignOutEverywhereActionInputV1Schema,
      typeof AccountSessionsSignOutEverywhereActionOutputV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.encryption.automationTemplates.recover',
      typeof AccountEncryptionAutomationTemplatesRecoverInputV1Schema,
      typeof AccountEncryptionAutomationTemplatesRecoverResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.encryption.historicalKey.forget',
      typeof AccountHistoricalEncryptionKeyForgetInputV1Schema,
      typeof AccountHistoricalEncryptionKeyForgetResultV1Schema
    >
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
  | (typeof DOC_COLLABORATION_ACTION_SPECS_V1)[number]
  | (typeof CAPABILITY_RULES_ACTION_SPECS_V1)[number]
  | (typeof SESSION_CAPABILITIES_ACTION_SPECS_V1)[number]
  | (typeof SKILL_ACTION_SPECS_V1)[number]
  | (typeof ACCOUNT_LIFECYCLE_ACTION_SPECS)[number]
  | (typeof MEMORY_DOCUMENT_ACTION_SPECS_V1)[number]
  | { [Id in PluginExecutionOriginActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof PluginExecutionOriginActionInputSchemas)[Id], (typeof PluginExecutionOriginActionOutputSchemas)[Id], never, 'account_automation'>
    }[PluginExecutionOriginActionId]
  | { [Id in NpmRegistryProfileActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof NpmRegistryProfileActionInputSchemasV1)[Id], (typeof NpmRegistryProfileActionOutputSchemasV1)[Id], never, 'account_automation'>
    }[NpmRegistryProfileActionIdV1]
  | { [Id in PluginAccountAdministrationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof PluginAccountAdministrationActionInputSchemas)[Id], (typeof PluginAccountAdministrationActionOutputSchemas)[Id], never, 'account_automation'>
    }[PluginAccountAdministrationActionId]
  | { [Id in HomeRuntimeActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[HomeRuntimeActionIdV1]
  | (typeof USAGE_ACTION_SPECS)[number]
  | (typeof USAGE_COACH_ACTION_SPECS)[number]
  | { [Id in UsageSourceActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof USAGE_SOURCE_ACTION_INPUT_SCHEMAS)[Id],
      (typeof USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS)[Id]> }[UsageSourceActionId]
  | { [Id in McpServerActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[McpServerActionIdV1]
  | { [Id in RemoteHostActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[RemoteHostActionIdV1]
  | { [Id in ArtifactFolderActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[ArtifactFolderActionIdV1]
  | { [Id in ProfileActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof PROFILE_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof PROFILE_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[ProfileActionIdV1]
  | { [Id in ProviderActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof PROVIDER_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[ProviderActionIdV1]
  | { [Id in ProjectActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof PROJECT_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof PROJECT_ACTION_OUTPUT_SCHEMAS_V1)[Id]>
    }[ProjectActionIdV1]
  | { [Id in WorkflowEffectActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof WorkflowEffectActionInputSchemasV1)[Id], (typeof WorkflowEffectActionOutputSchemasV1)[Id]>
    }[WorkflowEffectActionIdV1]
  | { [Id in VoiceConversationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof VoiceConversationActionInputSchemas)[Id], (typeof VoiceConversationActionOutputSchemas)[Id]>
    }[VoiceConversationActionId]
  | (typeof COMPOSER_INGRESS_ACTION_SPECS)[number]
  | (typeof MEDIA_ANNOTATION_ACTION_SPECS)[number]
  | (typeof WORKFLOW_AUTHORING_ACTION_SPECS)[number]
  | (typeof WORKFLOW_DIAGNOSTIC_ACTION_SPECS)[number]
  | { [Id in NotificationConfigurationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof NotificationConfigurationActionInputSchemas)[Id], (typeof NotificationConfigurationActionOutputSchemas)[Id]>
    }[NotificationConfigurationActionId]
  | { [Id in AppUpdateActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof AppUpdateActionInputSchemas)[Id], (typeof AppUpdateActionOutputSchemas)[Id]>
    }[AppUpdateActionId]
  | { [Id in UpdatesActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof UpdatesActionInputSchemas)[Id], (typeof UpdatesActionOutputSchemas)[Id]>
    }[UpdatesActionId]
  | SessionTerminalActionSpecDefinition
  | { [Id in SessionAgentTransitionActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS)[Id], (typeof SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS)[Id]>
    }[SessionAgentTransitionActionId]
  | MachineTerminalActionSpecDefinition
  | WorkspaceActionSpecDefinition
  | ProjectDefinitionActionSpecDefinition
  | WidgetInstanceActionSpecDefinition
  | WidgetDefinitionActionSpecDefinition
  | WidgetLayoutFragmentActionSpecDefinition
  | (typeof SCOPE_ACTION_SPECS)[number]
  | (typeof DIAGNOSTICS_ACTION_SPECS)[number]
  | (typeof COMMAND_PALETTE_ACTION_SPECS)[number]
  | (typeof FIND_ACTION_SPECS)[number]
  | (typeof PROMPT_PICKER_ACTION_SPECS)[number]
  | (typeof SESSION_MESSAGE_PIN_ACTION_SPECS)[number]
  | (typeof PROMPT_INVOCATION_CREATE_ACTION_SPECS)[number]
  | (typeof SESSION_PENDING_NEXT_ACTION_SPECS)[number]
  | SessionPendingCustodyActionSpecDefinition
  | SettingsDeclarationActionSpecDefinition
  | ActionPolicyActionSpecDefinition
  | WorkBoardActionSpecDefinition
  | ArtifactAccessActionSpecDefinition
  | BotTemplateActionSpecDefinition
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
  | AutomationOccurrenceActionSpecDefinition
  | PluginAutomationConversationActionSpecDefinition
  | MachinePoolActionSpecDefinition
  | MachinePresetActionSpecDefinition
  | ManagedMachineActionSpecDefinition
  | ProjectWorkerActionSpecDefinition
  | ActionOperationActionSpecDefinition
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

type ResultRequiredActionId = {
  // Schema-only family projections widen approval; check every potentially required result.
  [Id in keyof CanonicalActionSpecBucketsById]: 'required' extends CanonicalActionSpecBucketsById[Id]['approval']['result'] ? Id : never;
}[keyof CanonicalActionSpecBucketsById];
type ResultRequiredActionsWithoutSchema = {
  [TActionId in ResultRequiredActionId]: CanonicalActionSpecBucketsById[TActionId] extends Readonly<{
    outputSchema: z.ZodMiniType;
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

type DeclaredApiExcludedActionId = {
  [Id in keyof CanonicalActionSpecBucketsById]: CanonicalActionSpecBucketsById[Id] extends Readonly<{
    surfaces: Readonly<{ api: false }>;
  }> ? Id : never;
}[keyof CanonicalActionSpecBucketsById];

export type PublicActionId = Exclude<Extract<SignedRootActionId,
  AccountAutomationActionId | typeof DECISION_ACTION_IDS[number] | typeof TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS[number]>,
  PluginProvenanceOnlyActionId | DeclaredApiExcludedActionId>;

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
  confirmVerb?: ParsedActionSpec['confirmVerb'];
  irreversible?: ParsedActionSpec['irreversible'];
  permissionChanging?: ParsedActionSpec['permissionChanging'];
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
  sessionTarget?: ParsedActionSpec['sessionTarget'];
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
  [TActionId in keyof TSchemas]: z.ZodMiniType<z.output<TSchemas[TActionId]>, z.input<TSchemas[TActionId]>>;
}>;

/** Canonical type projection consumed by the public DTO generator as well as schema maps. */
export type WithClientRoutingInput<Id extends ActionId, Input> = Id extends ClientRoutedActionId
  ? Input & { clientId?: string }
  : Input;
type WithClientRoutingSchema<Id extends ActionId, Schema extends z.ZodMiniType> =
  z.ZodMiniType<WithClientRoutingInput<Id, z.output<Schema>>, WithClientRoutingInput<Id, z.input<Schema>>>;
type PluginActionInputSchemaById = Readonly<{
  [Id in PluginInvocableActionId]: WithClientRoutingSchema<Id, PluginActionDomainInputSchemaById[Id]>;
}>;

export type PluginActionInputById = Readonly<{
  [TActionId in PluginInvocableActionId]: z.input<PluginActionInputSchemaById[TActionId]>;
}>;

export type PluginActionResultById = Readonly<{
  [TActionId in PluginInvocableActionId]: z.output<PluginActionOutputSchemaById[TActionId]>;
}>;

type PluginActionDomainInputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ inputSchema: infer TInputSchema extends z.ZodMiniType }> }>;
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
    surfaceBindings: Readonly<{ plugin: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodMiniType }> }>;
  }>
    ? TOutputSchema
    : PluginActionSpecForId<TActionId> extends Readonly<{
      outputSchema: infer TOutputSchema extends z.ZodMiniType;
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
    outputSchema: z.ZodMiniType;
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
  [Id in PublicActionId]: WithClientRoutingSchema<Id, PublicActionDomainInputSchemaById[Id]>;
}>;

type PublicActionDomainInputSchemaById = Readonly<{
  [TActionId in PublicActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProfileActionIdV1
      ? (typeof PROFILE_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends McpServerActionIdV1
      ? (typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProviderActionIdV1
      ? (typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends RemoteHostActionIdV1
      ? (typeof REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends HomeRuntimeActionIdV1
      ? (typeof HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ArtifactFolderActionIdV1
      ? (typeof ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : PublicActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ api: Readonly<{ inputSchema: infer TInputSchema extends z.ZodMiniType }> }>;
  }>
    ? TInputSchema
    : PublicActionSpecForId<TActionId>['inputSchema'];
}>;

type PublicActionOutputSchemaById = Readonly<{
  [TActionId in PublicActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProfileActionIdV1
      ? (typeof PROFILE_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends McpServerActionIdV1
      ? (typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProviderActionIdV1
      ? (typeof PROVIDER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends RemoteHostActionIdV1
      ? (typeof REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends HomeRuntimeActionIdV1
      ? (typeof HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ArtifactFolderActionIdV1
      ? (typeof ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : PublicActionSpecForId<TActionId> extends Readonly<{
      surfaceBindings: Readonly<{ api: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodMiniType }> }>;
    }>
      ? TOutputSchema
      : PublicActionSpecForId<TActionId>['outputSchema'];
}>;

function isSignedRootActionSpec(
  spec: ActionSpecWithoutApproval,
): spec is ActionSpecWithoutApproval & Readonly<{ outputSchema: z.ZodMiniType }> {
  return !isInternalActionId(spec.id)
    && !isHumanSecretApiExcludedActionId(spec.id)
    && spec.outputSchema !== undefined;
}

const SIGNED_ROOT_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(isSignedRootActionSpec);

/**
 * Signed Account roots retain present-user Actions and plugin-provenance-only
 * shapes. The latter require a mounted claim at ingress and daemon-derived
 * plugin policy; they remain excluded from the PAT catalog.
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
    outputSchema: z.ZodMiniType;
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
): Readonly<Record<SignedRootActionId, z.ZodMiniType>>;
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

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze(
  ACTION_SPECS_WITH_PUBLIC_EXPOSURE.map((spec): ActionSpec => {
    const pluginCallerPolicy = resolveActionPluginCallerPolicy(spec);
    const contextualDefaults = resolveBuiltInActionContextualDefaults(spec.id);
    const argsExample = spec.examples?.voice?.argsExample ?? ACTION_VOICE_ARGS_EXAMPLES[spec.id];
    return completeActionInputHints({
      ...spec,
      ...(argsExample ? { examples: { ...spec.examples, voice: { ...spec.examples?.voice, argsExample } } } : {}),
      requiredAuthority: resolveActionRequiredAuthority(spec),
      executionPlacement: resolveActionExecutionPlacement(spec),
      ...(pluginCallerPolicy ? { pluginCallerPolicy } : {}),
      ...(contextualDefaults ? { contextualDefaults } : {}),
      placements: [...spec.placements],
    });
  }),
);

assertPublicActionSdkMethodNames(ACTION_SPECS, PUBLIC_ACTION_ID_SET);

const ACTION_SPECS_BY_ID = new Map(ACTION_SPECS.map((spec) => [spec.id, spec] as const));

export function listActionSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS;
}

export function getActionSpec<TActionId extends ActionId>(id: TActionId): Readonly<{
  inputSchema: WithClientRoutingSchema<TActionId, CanonicalActionSpecById[TActionId]['inputSchema']>;
}> & ActionSpec;
export function getActionSpec(id: ActionId): ActionSpec {
  const spec = ACTION_SPECS_BY_ID.get(id);
  if (!spec) {
    // This is a programmer error: all call sites should be type-safe and list-backed.
    throw new Error(`Unknown action spec: ${id}`);
  }
  return spec;
}

/** Public non-content demand comes only from the Action's declaration; accepted input keeps its own activation owner. */
export function projectExternalActionMachineRuntimeDemandV1(actionId: string, input: unknown,
  target: ExternalActionTargetV1 | undefined): 'required' | undefined {
  const parsed = ActionIdSchema.safeParse(actionId);
  if (!parsed.success) return undefined;
  const demand = getActionSpec(parsed.data).machineRuntimeDemandForInput?.(input, {
    ...(target ? { externalActionTarget: target } : {}),
    ...(target?.kind === 'session' ? { defaultSessionId: target.sessionId } : {}),
  });
  return demand && demand.activation !== 'accepted-input' ? 'required' : undefined;
}

/** Home checks the declaration before consuming the sealed operand's authenticated projection. */
export function readExternalActionMachineRuntimeDemandV1(actionId: string,
  envelope: ExternalActionRequestEnvelope): 'required' | undefined {
  if (envelope.v !== 2) return projectExternalActionMachineRuntimeDemandV1(actionId, envelope.input, envelope.target);
  const parsed = ActionIdSchema.safeParse(actionId);
  // Send activates only after its input is committed by the existing Pending owner.
  if (!parsed.success || parsed.data === SESSION_MESSAGE_SEND_ACTION_ID_V1
    || !getActionSpec(parsed.data).machineRuntimeDemandForInput) return undefined;
  return envelope.machineRuntimeDemand;
}

/** Invocation and inspection prepare targets under their own admitted Action root. */
export function isSessionTargetPreparationAction(id: ActionId): boolean {
  return id === 'session.targets.resolve' || id === 'action.invoke' || Boolean(getActionSpec(id).sessionTarget);
}

export function getActionContextualDefaults(
  action: ActionId | string | ActionSpec,
  input?: unknown,
): ActionContextualDefaults | null {
  const spec = typeof action === 'string'
    ? (() => {
      const parsed = ActionIdSchema.safeParse(action);
      return parsed.success ? getActionSpec(parsed.data) : null;
    })()
    : action;
  if (!spec) return null;
  if (isSourceQualifiedLocalServicePreviewActionInput(spec.id, input)) return null;
  // An exact registered preview already owns its scope. Defaulting the caller's
  // Session here would reinterpret a user-owned registration as Session-owned;
  // explicit Session qualifiers still reach the preview owner's binding check.
  if (spec.id === 'localServices.preview.openOrCreate' && input && typeof input === 'object' && !Array.isArray(input)
    && (('launchTargetId' in input && typeof input.launchTargetId === 'string')
      || ('managedServiceId' in input && typeof input.managedServiceId === 'string'))) return null;
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

/** Effect projection only: it grants no authority and never admits a replay. */
export function isReadOnlyMachineRpcMethod(method: string): boolean {
  const governance = resolveMachineRpcGovernance(method);
  if (governance.rpcClassification === 'action_spec_bound') {
    const actionId = ActionIdSchema.safeParse(governance.actionSpecId);
    return actionId.success && isVoiceSdkSafeActionSpec(getActionSpec(actionId.data));
  }
  return governance.readOnly === true;
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
export { requiresExplicitScmMachineTarget, isScmDiffSummaryRunAction } from './scmGitActionSpecs.js';

export type AdmittedActionInputById = Readonly<{
  [Id in keyof CanonicalActionSpecById]: z.output<CanonicalActionSpecById[Id]['inputSchema']>;
}>;
