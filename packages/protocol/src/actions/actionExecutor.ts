import { dispatchProjectsDispatch1, dispatchProjectsDispatch2, dispatchProjectsDispatch3 } from './executor/projects/dispatch.js';
import { withScmRefineInputAuthorizationV1, readHostRootInputCredentialActionV1 } from './executor/scmRefineInputPurpose.js';
import { dispatchMachineControls1, dispatchMachineControls2, dispatchMachineControls3 } from './executor/machine/controls.js';
import { dispatchMachineManaged } from './executor/machine/managed.js';
import { dispatchAgentsSubagents1, dispatchAgentsSubagents2 } from './executor/agents/subagents.js';
import { dispatchReviewDispatch1, dispatchReviewDispatch2, reviewScopeForInput } from './executor/review/dispatch.js';
import { dispatchRunsDispatch1, dispatchRunsDispatch2 } from './executor/runs/dispatch.js';
import { dispatchAgentsAcp, projectAcpUpsertRefusal } from './executor/agents/acp.js';
import { dispatchAgentsCatalog } from './executor/agents/catalog.js';
import { dispatchSessionAwareness } from './executor/session/awareness.js';
import { dispatchSessionWork } from './executor/session/work.js';
import { dispatchSessionHandoff } from './executor/session/handoff.js';
import { dispatchSessionLifecycle1, dispatchSessionLifecycle2 } from './executor/session/lifecycle.js';
import { dispatchSessionMessages } from './executor/session/messages.js';
import { dispatchSessionPendingEdit } from './executor/session/pendingEdit.js';
import { dispatchSessionControls1, dispatchSessionControls2 } from './executor/session/controls.js';
import { dispatchSessionTranscript } from './executor/session/transcript.js';
import { dispatchAccountSecurity } from './executor/account/security.js';
import { dispatchWorkspaceSync } from './executor/workspace/sync.js';
import { dispatchCode } from './executor/code.js';
import type { CoreOptions, PreparedCoreAdmission, PrivatePrepareResult, ActionHomeEquivalence, DispatchFacts } from './executor/coreInvocation.js';
import { DeploymentTemplateInstantiationReviewV1Schema, areDeploymentTemplateReviewFactsEqualV1 } from '../deployments/deploymentTemplateInstantiationV1.js';
import { SESSION_TRANSCRIPT_ACTION_ID_SET, delegatesApprovalClassificationToResolvedAction, isPluginExternalSessionActionId, isHostExternalSessionActionId, isSessionPermissionRemoteActionId, isScmActionId, isActionFamilyId } from './executor/actionFamilies.js';
import { resolveSessionIdFromInput, resolveExecutionRunScope, withoutExecutionRunScope, projectSessionReferenceFailure, resolveServerIdForSession, resolveServerIdForExecutionRunScope } from './executor/sessionScope.js';
import { projectActionExecutionObservation, projectActionObservationInput, readUnavailableApprovalReplayOrigin, buildApprovalDecisionResult, buildActionExecuteResultFromRecordedApprovalExecution, projectApprovalRequestPluginCaller, classifyApprovalExecutionOriginCurrentness } from './executor/approvalResults.js';
export { buildActionExecuteResultFromRecordedApprovalExecution, classifyApprovalExecutionOriginCurrentness } from './executor/approvalResults.js';
import { mapApprovalCreatedBySurface, buildApprovalSummary, buildApprovalPreviewSummary, resolveComputerActionSelection, readDeploymentPreparation, prepareApprovalRequest } from './executor/approvalPreparation.js';
export { buildApprovalPreviewSummary } from './executor/approvalPreparation.js';
import { resolveApprovalOriginForRequest, projectActionApprovalOrigin, projectActionObservationContext, resolvePolicyApprovalRequestingSessionId, projectApprovalExecutionOriginCaller, buildApprovalExecutionOriginV1, resolveExplicitApprovalRequestingSessionId, isApprovalActionId, isApprovalRequestActionReplayAdmitted, isBlockingApprovalRequest } from './executor/approvalOrigins.js';
import { resolveMachineServiceLogsApprovalLifetime } from './executor/approvalOrigins.js';
export { projectApprovalExecutionOriginCaller, buildApprovalExecutionOriginV1 } from './executor/approvalOrigins.js';
import { materializeSessionSpawnApprovalInput, buildSessionSpawnNewArgs, sameSessionCreationDirectoryApproval } from './executor/sessionSpawn.js';
import { parseActionSurfaceKey, isAgentCaller, normalizeActionCallerContext, sessionAttestedContextCallerFailure, createPermissionPolicyResult, causalPermissionAuthorityFailure, resolveAgentEffectivePermission, resolveWorkflowActionContext, assertAgentPermission, resolveSessionMessageSendAdmission, resolveAgentExecutionRunPermission, bindAgentExistingExecutionRunAuthority } from './executor/callerContext.js';
import type { SessionMessageSendAdmission } from './executor/callerContext.js';
import { resolveExecutionRunLaunchOrigin, buildExecutionRunCallOptions, checkDetachedExecutionRunProtocolV2, normalizeExecutionBackendOptionValue, normalizeExecutionBackendTargetValue, resolveFanoutTeamCredentialModel, resolveFanoutConnectedServicesSelections, buildAvailableExecutionBackendOptionKeys, readReviewRunActionPayload, readFanoutStartError, fanoutStarts, readCompleteExecutionRunStartIdentity, hasExecutionRunStartIdentityEvidence, classifyExecutionRunStartFailure, classifyExecutionRunStartPreDispatchFailure, parseExecutionRunWaitResult, isExecutionRunWaitCancellation } from './executor/executionRuns.js';
import type { ExecutionRunCallOptions } from './executor/executionRuns.js';
import { normalizeId, readNullableString, readOptionalString } from './executor/inputReading.js';
import { normalizeActionExecutorThrownError, completeActionResult, completeSessionHandoffActionResult, completeExecutionRunServiceActionResult, completeSpawnActionResult } from './executor/resultProjection.js';
import { MachineServiceLogsReadInputV1Schema, MachineServiceActionIdSchema,
  MACHINE_SERVICE_ACTION_INPUT_SCHEMAS, MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS } from './specs/machine/services.js';
import { ManagedServiceNativeLogResultV1Schema } from '../local/services/nativeLogsV1.js';
import { readActionApprovalScopeAdmissionV1 } from './executor/approvalScope.js';
import { resolveActionApprovalPreferenceScopeV1 } from './actionApprovalPolicy.js';
import { isDeploymentActionIdV1, DeploymentActionInputSchemasV1 } from '../deployments/deploymentActionsV1.js';
import { withoutClientActionInput } from './clientActionInput.js';
import { isPresentUserHostInvocation } from './invocationAuthority.js';
import { ReviewFindingsApplyInputV1Schema } from '../reviews/reviewApplyV1.js';
import type { ReviewCommentV1 } from '../reviews/comments/v1.js';
import { buildAcceptedReviewFindingsForVerifyV1,
  REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '../reviews/reviewFindingsApplyInputV1.js';
import { ReviewCommentGetResponseV1Schema } from '../reviews/comments/actions.js';
import { isActionOutcomeUnknownErrorCodeV1 } from './actionExecutionResult.js';
import { createApprovalReplay } from './executor/approvalReplay.js';
import { createBlockingApprovalDecisionResolver } from './executor/blockingApprovalDecision.js';
import { approvalReadFailure as approvalContextUnavailable } from './executor/approvalRead.js';
import { readApprovalReplayResult } from './executor/approvalResults.js';
import { requiresLiveCliApprovalOrigin } from '../approvals/liveCliOrigin.js';
import { ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema } from '../projects/projectOrganizationV1.js';
import { deriveWorkflowDiscussionReplyLocalIdV1, deriveWorkflowReplacementId } from '../workflows/workflowInvocationIdentityV1.js';
import { captureWorkflowDefinitionV1 } from './executor/workflowDefinitionCapture.js';
import { LocalServiceStartApprovalReviewV1Schema } from '../local/services/launcher/v1.js';
import { actionInputIssueFailure, actionInputValidationFailure } from './executor/actionInputValidation.js';
import { CODE_INTELLIGENCE_QUERY_KIND_BY_ACTION_ID, CodeIntelligenceActionInputSchema, CodeIntelligenceFileActionInputSchema, CodeIntelligenceRestartActionInputSchema, CodeIntelligenceRenamePreviewInputSchema, CodeIntelligenceFileRenamePreviewInputSchema, CodeIntelligenceEditApplyInputSchema, CodeIntelligenceCodeActionApplyInputSchema, CodeIntelligenceDiagnosticsInputSchema, CodeIntelligenceWorkspaceSymbolsInputSchema, CodeIntelligenceCallHierarchyInputSchema, CodeIntelligenceFormatInputSchema, CodeIntelligenceOrganizeImportsInputSchema } from './codeIntelligenceActionFamily.js';
import { DaemonLspQueryResponseSchema, DaemonLspRestartResponseSchema, DaemonLspApplyResponseSchema, type DaemonLspApplyRequest, type DaemonLspQueryRequest } from '../machines/languageIntelligence.js';
import { queryCodeIntelligenceFallback } from '../machines/codeIntelligenceFallback.js';
import { ActionInvokeInputSchema } from './actionInvokeInput.js';
import { PetChooseInputV1Schema } from '../pets/selection.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, RawIngressStructuredInputV1Schema } from '../runtime/input/structuredInputV1.js';
import { SessionSpawnNewActionResultV1Schema, readSessionSpawnNewActionResultV1 } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { isSessionStopConfirmed, SessionStopResultSchema, SessionArchiveResultSchema, SessionArchiveActionInputV1Schema, SessionArchiveActionResultV1Schema, type SessionArchiveReportOutcomeV1 } from '../sessions/control/contract.js';
import { readSessionManagerSessionIdV1 } from '../sessions/follow/sessionManagerV1.js';
import { SESSION_LIST_PAGE_MAX_LIMIT } from '../sessions/listing/query.js';
import { bindActionSessionTargetOperands, previewActionSessionTargets, readActionSessionTargetField, readActionSessionTargetOperands, replaceActionSessionTargetField, resolveActionSessionAddress, resolveActionSessionTargets } from './executor/sessionTargets.js';
import { SessionMessageExplicitReplyV1Schema, SessionMessageReplyMutationResultV1Schema,
  classifySessionMessageReplyPublicationFailureV1, deriveSessionMessageReplyReturnLocalIdV1,
  type SessionMessageReplyAccountMutationV1 } from '../sessions/messages/sessionMessageReplyV1.js';
import { AutonomousExchangeControlRequestV1Schema } from '../sessions/messages/autonomousExchangeV1.js';
import { AutonomousExchangeObservedRevisionV1Schema } from '../sessions/messages/autonomousExchangeV1.js';
import { ActionResolvedSessionTargetsV1Schema, normalizeSessionTargetV1, type ActionSessionTargetDeclarationV1 } from './sessionTargetV1.js';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1.js';
import { deriveManagedDeleteApprovalSubjectKeyV1 } from '../approvals/approvalArtifactHeaderV1.js';
import { executeApprovalObservationAction } from './executor/approvalObservation.js';
import { isApprovalArtifactKindV1 } from '../approvals/approvalArtifactKindV1.js';
import { ScmDiffSummaryModelSelectorSchema } from '../scm/diffSummary.js';
import * as z from 'zod/mini';
import { actionStartTargetUnavailableV1 } from './executor/actionStartDiagnostics.js';
import { resolveInputOptions, resolveTypedInputFieldOptions, normalizeResolvedOptions, tryNormalizeExecutionBackendOptionValue, readReviewNarratorOptions, buildAgentInventorySelectionArgs } from '../inputs/inputOptions.js';
import { ProjectPagesListInputV1Schema } from './projectActionFamily.js';
import { PluginExecutionOriginActionIdSchema, PluginExecutionOriginActionInputSchemas } from './pluginExecutionOriginActionFamily.js';
import { NpmRegistryProfileActionIdV1Schema, NpmRegistryProfileActionInputSchemasV1 } from './npmRegistryProfileActionFamily.js';
import { PluginAccountAdministrationActionIdSchema, PluginAccountAdministrationActionInputSchemas } from './pluginAccountAdministrationActionFamily.js';
import { readWidgetActionAccountScopeAdmissionV1 } from '../widgets/widgetActionScopeV1.js';
import { WidgetInstanceV1Schema } from '../widgets/widgetInstanceV1.js';
import { LOCAL_DAEMON_SERVICE_ACTION_IDS, LOCAL_DAEMON_SERVICE_INPUT_SCHEMAS, type LocalDaemonServiceActionId } from './specs/localDaemonService.js';
import { AutomationEventTestInputV1Schema, testAutomationEventV1 } from '../automations/automationEventTestV1.js';
import { getWorkflowStarterExamplesV1, materializeWorkflowStarterExample } from '../workflows/builtins/examples.js';
import { WorkflowStartersResolveInputV1Schema } from '../workflows/builtins/starterActionsV1.js';
import { resolveReviewEngineInventoryTarget } from './executor/reviewEngineInventoryTarget.js';
import { MemoryWindowRequestV1Schema } from '../memory/memoryWindow.js';
import { isWorkflowAuthoringActionId } from './workflowAuthoringActionIds.js';
import { PromptDocRevisionV1Schema, PromptDocCreateActionInputV1Schema } from '../prompts/library/promptDocV2.js';
import { PromptBundleUpdateActionInputV1Schema } from '../prompts/library/promptBundleSchemas.js';
import { SKILL_ACTION_INPUT_SCHEMAS_V1, SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 } from '../prompts/library/skills/skillActionSchemasV1.js';
import { SkillReadInputV1Schema } from '../prompts/library/skills/skillReadV1.js';
import { ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1, ArtifactFolderMutationResultV1Schema } from '../prompts/library/promptFolderActionSchemasV1.js';
import { updatePromptLibraryStackV1 } from '../prompts/library/promptLibraryCatalogV1.js';
import { createPromptInvocationInLibrary, updatePromptInvocationInLibrary, deletePromptInvocationInLibrary } from '../prompts/library/promptInvocationActionOperations.js';
import { isPromptInvocationActionId, PromptInvocationCreateInputSchema, PromptInvocationUpdateInputSchema, PromptInvocationDeleteInputSchema } from './promptInvocationCreateActionSpecs.js';
import { PromptLibraryStackUpdateInputV1Schema } from '../prompts/library/promptStacksV1.js';
import { mutateSkillRulesV1 } from '../prompts/library/skillRulesActionsV1.js';
import { SkillsRulesSetInputV1Schema } from './specs/capabilityRules.js';
import { SessionCapabilitiesGetInputV1Schema, SessionCapabilitiesGetOutputV1Schema, SessionCapabilitiesSetInputV1Schema,
  SessionCapabilitiesSetOutputV1Schema, SpawnCapabilitiesPreviewInputV1Schema, SpawnCapabilitiesPreviewOutputV1Schema } from './specs/sessionCapabilities.js';
import { setSessionCapabilityV1 } from './executor/sessionCapabilities.js';
import { REGISTRY_ACTION_IDS_V1, type RegistryActionIdV1 } from '../registries/registryActionsV1.js';
import { PERSONAL_SAVED_SECRET_ACTION_IDS_V1, type PersonalSavedSecretActionIdV1 } from '../account/settings/personalSavedSecretActionsV1.js';
import { ProjectContextUpdateInputV1Schema } from '../projects/projectContextV1.js';
import { SessionPendingWithdrawInputV1Schema } from '../sessions/control/pendingWithdrawV1.js';
import { SessionPendingMarkHandledInputV1Schema, SessionPendingDeliveryRecoveryInputV1Schema } from '../sessions/control/pendingDeliveryRecoveryV1.js';
import { SetSessionPinRequestSchema, SetSessionPinResponseSchema } from '../sessions/organization/mutations.js';
import { isMemoryWriteActionV1, MEMORY_DOCUMENT_ACTION_IDS_V1, MemoryDocReadInputV1Schema, MemoryListInputV1Schema } from '../prompts/library/memoryActionsV1.js';
import { readMemoryDocInLibrary, listMemoryDocsInLibrary, projectLegacySkillRegistryInstallActionResultV1 } from '../prompts/library/promptLibraryActionOperations.js';
import { isArtifactFolderActionIdV1 } from '../prompts/library/artifactFolderActionIdsV1.js';
import { executeArtifactFolderActionV1 } from '../prompts/library/promptFolderActionsV1.js';
import { redactBugReportSensitiveText } from '../bugs/reports/redaction.js';
import { assertMemoryHomeV1, readMemoryWriteAdmissionV1, bindMemoryWriteApprovalInputV1, executeMemoryWriteV1, type MemoryWriteAdmissionV1 } from './executor/memoryDocumentActions.js';

import { InputOptionsConsumerV1Schema, inputOptionsConsumerActionId } from '../inputs/inputOptionsConsumer.js';
import { readRecord, readNonEmptyString, isRecord, hasOwn } from '../inputs/inputRecords.js';
import { areServerProfileIdentifiersEquivalent } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { ModelFavoriteMutationV1Schema } from '../providers/modelFavoritesV1.js';
import {
  ProjectSourcesListInputV1Schema, ProjectSourcesReadInputV1Schema, ProjectSourcesCreateInputV1Schema,
  ProjectSourcesUpdateInputV1Schema, ProjectSourcesDeleteInputV1Schema,
} from '../projects/sources/projectSourceV1.js';
import { isSessionStateFieldActionId, resolveSessionStateFieldActionWrite } from './sessionStateFieldActions.js';
import { SessionCoordinatorEnableInputV1Schema } from '../sessions/follow/sessionCoordinatorActionsV1.js';
import { executeSessionCoordinatorEnableV1 } from './executor/sessionCoordinator.js';
import { isProjectDefinitionActionId } from './projectDefinitionActionFamily.js';
import { isAccountSettingActionSurfaceAllowedV1 } from './accountSettingDeclarations.js';
import { AccountHomeContinuationInputV1Schema } from './accountHomeContinuationV1.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { resolveProjectActionMachineV1 } from './executor/projectActionPlacement.js';
import type { PublicActionInputById } from './actionSpecs.js';
import type { ApprovalStaleReason } from '../approvals/approvalExecutionFailure.js';
import type { SessionResumeRequestV1 } from '../sessions/control/sessionResumeRequestV1.js';
import type { SessionGoalSetRequestV1 } from '../sessions/work/state/sessionWorkStateRpc.js';
import { WaitActionInputV1Schema } from './specs/wait.js';
import { ActionOperationActionIdV1Schema, ActionOperationActionInputSchemasV1 } from './specs/actionOperations.js';
import { readActionFailureEnvelope, readFailureEnvelopeDetails } from './executor/actionFailureEnvelope.js';
import { AccountNoticeArtifactBodyV1Schema, readAccountNoticeArtifactV1, readOwnedNoticeArtifactV1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1 } from '../activity/usageNoticeArtifactV1.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '../json/strictJsonValue.js';
import { resolveActionOriginationPreferenceFailureV1 } from './executor/actionOriginationPreferences.js';
import { UsageSourceActionIdSchema, USAGE_SOURCE_ACTION_INPUT_SCHEMAS } from '../usage/usageSources.js';
import type { UsageSourceActionRequest } from './executor/usageSourceActions.js';
import { ManagedDeleteOutputV1Schema, ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '../machines/managed/actionsV1.js';
import { MachineReferenceCensusV1Schema, type MachineReferenceCensusV1 } from '../machines/machineReferenceCensusV1.js';
import { ManagedRefusalCodeV1Schema } from '../machines/managed/providerFactsV1.js';
import { ManagedControllerRequestFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema } from './operations/v1.js';
import { PrivateSecretContinuationV1Schema, type PrivateSecretContinuationV1 } from '../approvals/privateSecretContinuationV1.js';
import { SecretFillSettlementV1Schema } from '../computer/v1.js';
import { executeWaitActionV1 } from './executor/waitAction.js';
import { executeUsageAction } from './executor/usageActions.js';
import { isPublicProfilePreparationActionIdV1 } from '../account/publicProfileActionIds.js';
import { preparePublicProfileAction, executePublicProfileAction, PublicProfileAccountScopeError } from './executor/publicProfileActions.js';
import { executeUsageCoachAction } from './executor/usageCoachActions.js';
import { isWorkspaceActionId } from './workspaceActionFamily.js';
import { isFilesystemActionId } from './filesystemActionFamily.js';
import { isProjectActionIdV1 } from './projectActionIdsV1.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '../projects/openProjectV1.js';
import { isSessionTerminalActionId } from './sessionTerminalActionFamily.js';
import { SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS } from './sessionAgentTransitionActionFamily.js';
import { SessionAgentTransitionRequestV1Schema } from '../sessions/agentTransition.js';
import { parseWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionRefV1.js';
import { ComputerSelectedTargetResponseV1Schema, ComputerTargetSelectRequestV1Schema, ComputerTargetsListResponseV1Schema, computerTargetKeyV1 } from '../computer/v1.js';
import { isSessionFollowActionIdV1, SessionFollowActionInputSchemasV1 } from '../sessions/follow/actions.js';
import { evaluateApiTokenGrantV1, isApiTokenGrantActionAllowedV1, isApiTokenGrantTargetMemberV1, isPermissionModeGrantedV1 } from '../auth/apiTokenGrant.js';
import { resolveCredentialActionAdmissionV1, resolveWorkspaceWriteActionAdmissionV1, canRequestPresentUserApprovalForActionInputV1, requiresPresentUserDecisionForActionInputV1, requiresPresentUserExecutionAuthorityForActionInputV1, computeActionInputApprovalDigestV1, isPublicLinkCreationActionV1 } from './decisionAuthority.js';
import { SessionActionRpcOriginV1Schema } from '../rpc/socket.js';
import { SessionNeedsYouRaiseInputV1Schema } from '../sessions/permissions/questionV1.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { SESSION_PERMISSION_MODES } from '../sessions/metadata/sessionPermissionModes.js';
import { SessionPermissionRespondActionDecisionV1Schema, SessionPermissionRespondRpcParamsV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import { SessionUpdatePostInputV1Schema, SessionUpdatePostOutputV1Schema } from '../sessions/relations/workerUpdateV1.js';
import { MachinesAgentsListInputSchema, MachinesAgentsListOutputSchema, MachineAcpInventoryDefinitionSchema } from '../capabilities/machineAgentInventory.js';
import { resolveAcpPlatformFitV1 } from '../acp/catalog/registry/acpPlatformFitV1.js';
import { installAcpRegistryAgentV1 } from '../acp/catalog/registry/installAcpRegistryAgentV1.js';
import { AgentsAcpBackendsInstallFromRegistryInputV1Schema } from '../acp/catalog/registry/registryInstallActionV1.js';
import { WorkflowEventsListInputV1Schema } from './specs/workflowEvents.js';
import { WorkspaceFilesSearchActionInputSchema } from './actionSpecs.js';
import { WorkspaceFilesReplacePreviewActionInputSchema, WorkspaceFilesReplaceActionInputSchema } from './actionSpecs.js';
import { HomeConnectInputSchema, HomeReconnectInputSchema, MachineAddCommandInputSchema, MachinePairingCreateInputSchema, MACHINE_ADD_SSH_ACTION_IDS, MACHINE_ADD_SSH_INPUT_SCHEMAS, MACHINE_PAGE_ACTION_IDS, MACHINE_PAGE_ACTION_INPUT_SCHEMAS, type MachineAddSshActionId, type MachinePageActionId } from './specs/machineConnection.js';
import { isMachineTerminalActionId, MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS } from './specs/machineTerminal.js';
import { MachineAddLocalStartInputSchema } from './specs/machineConnection.js';
import { MachineManagedInstallationRespondInputSchema } from './specs/machineConnection.js';
import { MachineAccessActionIdSchema, machineAccessGrantSetRequiresUiConfirmation } from './specs/machine/access.js';
import { MachineAccessGrantSetInputV1Schema } from '../machines/machineAccessV1.js';
import { MachineWorkSummaryGetInputV1Schema } from '../machines/machineWorkSummaryV1.js';
import { MachineVitalsActionIdSchema, MACHINE_VITALS_ACTION_INPUT_SCHEMAS } from './specs/machineVitals.js';
import { MachineStorageActionIdSchema, MACHINE_STORAGE_ACTION_INPUT_SCHEMAS } from './specs/storage.js';
import { MachineProcessesActionIdSchema, MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS } from './specs/machineProcesses.js';
import { MachineResourcesActionIdSchema, MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from './specs/machineResources.js';
import { MachineAgentIsolationActionIdSchema, MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS } from './specs/machine/agentIsolation.js';
import { MachineAdminAccessActionIdSchema, MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS } from './specs/machine/adminAccess.js';
import { MachineGuardActionIdSchema, MACHINE_GUARD_ACTION_INPUT_SCHEMAS } from './specs/machineGuard.js';
import { NotificationsNotifyMeInputV1Schema } from '../account/notifications/notifyMeV1.js';
import { WorkflowWebhookInputV1Schema, WorkflowMachineCommandInputV1Schema } from '../workflows/stepActionsV1.js';
import { MachinesAgentsSignInStartInputSchema, MachinesAgentsSignInStatusInputSchema, MachinesAgentsSignInCancelInputSchema } from '../daemon/agentSignIn.js';
import { isRoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { MachinePresetActionIdV1Schema, MachinePresetActionInputSchemasV1 } from '../machines/managed/machinePresetActionsV1.js';
import { projectAccountRoleActionRefusalV1, projectSessionRoleRpcFailureV1 } from '../prompts/roles/accountRoleActions.js';
import { isWorkBoardActionIdV1 } from '../boards/actionIdsV1.js';
import { WorkBoardActionInputSchemasV1 } from '../boards/actionsV1.js';
import { HOME_HUB_LAYOUT_ACTION_IDS, HomeHubLayoutUpdateInputSchema } from './specs/homeHub.js';
import { WidgetInstanceActionIdV1Schema, WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema, readWidgetActionSurfaceV1, readWidgetActionDestinationV1, readWidgetCatalogBoundSessionV1 } from '../widgets/actionsV1.js';
import { executeWidgetInstanceActionV1, admitWidgetInstanceConfigurationV1, admitWidgetInstanceSizeV1, isWidgetAdmissionUndecidableHereV1, readWidgetActionSurfacePortV1 } from '../widgets/executeWidgetInstanceActionV1.js';
import { getWidgetSizeFootprintV1, WIDGET_SIZE_ORDER_V1 } from '../widgets/widgetPresentationV1.js';
import { clientActionUnavailable } from './clientDispatchV1.js';
import { projectKnownAccountAuthorityRetirementReceipt } from './accountAuthorityRetirement.js';
import { SessionAuthoringOpenV1Schema } from '../plugins/ui/hostApiRequests.js';
import { WidgetDefinitionActionIdV1Schema } from '../widgets/definitionActionIdsV1.js';
import { readWidgetDefinitionActionAccountV1, readWidgetDefinitionActionSessionV1 } from '../widgets/definitionActionsV1.js';
import { admitWidgetActionSurfaceV1, readWidgetActionSurfaceAdmissionV1 } from '../widgets/widgetActionScopeV1.js';
import { setWidgetInputBindingsV1 } from '../widgets/widgetInstanceV1.js';
import { executeWidgetDefinitionActionV1 } from '../widgets/executeWidgetDefinitionActionV1.js';
import { WidgetLayoutFragmentActionIdV1Schema } from '../widgets/fragmentActionIdsV1.js';
import { readWidgetLayoutFragmentActionAccountV1 } from '../widgets/fragmentActionsV1.js';
import { executeWidgetLayoutFragmentActionV1 } from '../widgets/executeWidgetLayoutFragmentActionV1.js';
import { executeWidgetSnapshotPostV1 } from '../widgets/executeWidgetSnapshotPostV1.js';
import { prepareWidgetDefinitionPublicationV1 } from '../widgets/widgetDefinitionPublicationV1.js';
import type { HomeHubLayoutActionId } from './specs/homeHub.js';
import { executeWorkBoardActionV1 } from '../boards/executeWorkBoardActionV1.js';
import { LaunchProfilePublishInputV1Schema } from '../launchProfiles/publishLaunchProfile.js';
import { isProfileActionIdV1, parseProfileActionRequestV1 } from '../profiles/profileActionsV1.js';
import { isMcpServerActionIdV1 } from '../mcp/servers/serverActionIdsV1.js';
import { isProviderActionIdV1, parseProviderActionRequestV1 } from '../providers/providerActionsV1.js';
import { isRemoteHostActionIdV1, REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1, type RemoteHostActionRequestV1 } from '../remoteHosts/remoteHostActionsV1.js';
import { isHomeRuntimeActionIdV1, HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1, type HomeRuntimeActionRequestV1, type HomeRuntimeRestartInputV1 } from '../home/runtime/actionsV1.js';
import { isAccountLifecycleActionId, ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS, ACCOUNT_LIFECYCLE_ACTION_OUTPUT_SCHEMAS } from './accountLifecycleActionFamily.js';
import { executeHomeRuntimeRestart } from './executor/homeRuntimeRestart.js';
import {
  DaemonAgentInstallStartRequestSchema,
  DaemonAgentInstallReadRequestSchema,
  DaemonAgentInstallCancelRequestSchema,
} from '../daemon/agentInstallJobs.js';
import {
  AgentsAcpBackendsDeleteInputV1Schema,
  AgentsAcpBackendsDeleteOutputV1Schema,
  AgentsAcpBackendsGetInputV1Schema,
  AgentsAcpBackendsGetOutputV1Schema,
  AgentsAcpBackendsUpsertInputV1Schema,
  AgentsAcpBackendsUpsertOutputV1Schema,
  applyAcpBackendDeleteV1,
  applyAcpBackendUpsertV1,
} from '../acp/catalog/catalogMutationsV1.js';
import { SCM_WALKTHROUGH_QUESTION_META_KEY_V1, SESSION_TOOL_ANSWER_DELIVERY_KIND } from '../sessions/messages/sessionMessageMeta.js';
import { isSessionReadStateActionIdV1, SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1 } from '../sessions/readState/actions.js';
import {
  resolveSessionAttentionStandingRequest,
  SessionAttentionSetInputV1Schema,
  SessionAttentionSetResultV1Schema,
} from '../sessions/organization/attentionAction.js';
import {
  resolveActionCurrentSessionScopeFailure,
  resolveActionSessionListAccessFailure,
} from './executor/sessionListAccess.js';
import { resolveActionWorkflowSessionScopeV1 } from './executor/workflowSessionScope.js';
import { parseSessionFollowActionResponse } from '../sessions/follow/actionTransport.js';
import { parseSessionReadStateActionResponse } from '../sessions/readState/actionTransport.js';
import {
  actionSpecToActionDefinitionV1,
  findActionInputFieldHint,
  filterResolvedActionOptions,
  getActionSpecForCatalogSurface,
  projectActionDefinitionForExternalDiscovery,
  projectActionDefinitionSummaryForExternalDiscovery,
  searchSerializedActionSpecsForSurface,
  serializeActionFieldOptions,
} from './actionCatalog.js';
import { projectActionSpecSchemaSections } from './actionSpecSections.js';
import { parseInputTypeOptionsSourceId } from '../inputs/inputTypes.js';
import { readInputFieldOptionsSourceId } from '../inputs/inputTypeRuntime.js';
import { isSharedRequesterActionV1, resolveActionApprovalRouting, SURFACE_AUTHORITY_AGENT_FLOOR } from './actionApprovalPolicy.js';
import { readActionCallerLedSubtreeSessionIds } from './executor/sessionLedSubtree.js';
import { readPluginInstallApprovalPendingReview, resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { resolveRequestedSessionModeId } from './sessionModeIds.js';
import {
  findSpawnConfigOptionAliasConflicts,
  mergeSpawnConfigOptionAliases,
} from './sessionSpawnConfigOptions.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from './executionRunActionPermissionMode.js';
import { parseAgentPermissionIntentV1Alias } from '../runtime/permissionIntentV1.js';
import type { AcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import {
  isActionEnabledByActionsSettings,
  type ActionsSettingsV1,
} from './actionSettings.js';
import type { ActionDefinitionSummaryV1 } from './actionDefinitionV1.js';
import { AgentInventoryProbeInputSchema, DetachedExecutionRunSendInputSchema, ExecutionRunPermissionRespondInputSchema, SessionListActionInputV1Schema, SessionModelSetInputSchema, SessionSendMessageInputSchema, SessionTargetsResolveInputV1Schema, getActionSpec, resolveActionExecutionPlacementForInput, listActionSpecs, isActionSpecSurfacedOn, isPluginActionCallerPolicySatisfied, type ActionRequiredAuthority, type ActionSpec, type PublicActionResultById } from './actionSpecs.js';
import {
  SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
  SESSION_LIST_AWARENESS_VIEW_V1,
  SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
  SessionListViewV1Schema,
  parseSessionAwarenessListResultV1,
  parseSessionListQueryActionResultV1,
} from '../sessions/awareness/action.js';
import { SessionListQueryV1Schema } from '../sessions/listing/query.js';
import { SessionManagerSetActionInputV1Schema, SessionManagerSetResultV1Schema } from '../sessions/follow/sessionManagerV1.js';
import { SessionAwarenessProjectionV1Schema } from '../sessions/awareness/projectionV1.js';
import {
  resolveActionSurfaceAvailability,
  type ActionSurfaceAvailability,
} from './actionSurfaceAvailability.js';
import { isPluginDevLoopActionIdV1, isRuntimeActionIdV1, isSessionAccessActionId, ActionIdSchema, type ActionId, WorkflowActionIdV1Schema } from './actionIds.js';
import { WorkflowActionInputSchemasV1 } from '../workflows/actionsV1.js';
import { executeWorkflowDiscussionRoundProjectV1 } from './executor/workflowDiscussionRound.js';
import { ArtifactAccessActionIdV1Schema, ArtifactAccessActionInputSchemasV1, ArtifactAccessActionOutputSchemasV1 } from '../artifacts/artifactAccessV1.js';
import { ArtifactActionIdV1Schema, ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1 } from '../artifacts/artifactActionsV1.js';
import { executeDocReadV1, executeDocDiscussionWriteV1, executeDocEditDecisionV1 } from './executor/docCollaborationActions.js';
import { getArtifactKindPolicyV1 } from '../artifacts/artifactSharingV1.js';
import { WorkflowActionFailureV1Schema } from '../workflows/workflowProgressV1.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../memory/memoryWindow.js';
import { MemorySettingsV1Schema } from '../memory/memorySettings.js';
import { SearchConversationsInputV1Schema } from './actionSpecs.js';
import { resolveSubagentLaunchStructuredSend } from '../messages/structured/subagentLaunchV1.js';
import { resolveSubagentCommandStructuredSend } from '../messages/structured/subagentCommandV1.js';
import { ParticipantRecipientRoutingIdentityV1Schema } from '../messages/structured/participantMessageV1.js';
import { ApprovalExecutionOriginV1Schema, StoredApprovalRequestSchema, requiresExactDaemonApprovalReplay, resolveApprovalRequestAppExecutionPlacement, isSessionDiscussionApprovalPublicationV1, readApprovalRequesterDecisionV1, admitApprovalRequesterDecisionV1, resolveApprovalRequesterConfirmationV1, APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1, type ApprovalRequest, type ApprovalRequestV1, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { projectApprovalExecutionFailureV2 } from '../approvals/approvalExecutionFailure.js';
import { resolveApprovalRequestExecutionInput, settleApprovalRequestReplayInputs } from '../approvals/approvalRequestTransition.js';
import { ProviderConnectionIdSchema } from '../providers/ids.js';
import { BackendTargetKeySchema } from '../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import type { SessionRollbackTarget } from '../sessions/rollback.js';
import type { ReviewStartInput } from '../reviews/reviewStart.js';
import { ReviewWalkthroughInputSchema, ReviewWalkthroughRequestSchema, ReviewExplainFindingsInputSchema, ReviewExplainFindingsRequestSchema, ReviewExplainFindingsRefinementSchema } from '../reviews/reviewNarration.js';
import { resolveReviewNarratorPolicy } from '../reviews/reviewEngines.js';
import {
  ReviewCommentActionIdV1Schema,
  ReviewCommentListActionRequestV1Schema,
  ReviewCommentListResponseV1Schema,
  type ReviewCommentListResponseV1,
  type ReviewCommentActionIdV1,
} from '../reviews/comments/actions.js';
import {
  PluginPermissionGrantActionIdV1Schema,
  PluginPermissionGrantActionInputSchemasV1,
} from '../plugins/permissions/actions.js';
import {
  PluginWebhookActionIdV1Schema,
  PluginWebhookActionInputSchemasV1,
} from '../plugins/webhooks/endpointV1.js';
import {
  AutomationConversationActionIdV1Schema,
  AutomationConversationActionInputSchemasV1,
  AutomationEventActionIdV1Schema,
  AutomationEventActionInputSchemasV1,
} from '../automations/automationActionSpecsV1.js';
import { SessionBoardActionIdV1Schema } from '../sessions/board/actionIds.js';
import { DiscussionActionIdV1Schema } from '../discussions/actionIds.js';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionInviteInputV1Schema,
  DiscussionParticipantRemoveInputV1Schema, DiscussionDetailsResultV1Schema } from '../discussions/actions.js';
import { DiscussionInitialParticipantsV1Schema, DiscussionInviteResponseV1Schema, DiscussionRemoveParticipantResponseV1Schema, DiscussionParticipantsListResponseV1Schema,
  type DiscussionOwnedSessionV1, type DiscussionAnswerPolicyV1 } from '../discussions/participants.js';
import { projectDiscussionModelParticipantLaunchV1, type DiscussionModelParticipantLaunchV1 } from '../discussions/modelParticipantLaunch.js';
import { executeDiscussionSecondOpinionV1 } from './executor/discussionSecondOpinion.js';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  SessionBoardItemUpsertInputV1Schema,
  materializeSessionBoardWidgetCreationFootprintV1,
  sessionBoardActionUsesLayoutV1,
  parseSessionBoardActionPortResultV1,
} from '../sessions/board/actions.js';
import { CurrentSessionPresentationActionInputV1Schema } from '../sessions/presentation/currentSessionPresentationV1.js';
import { readSessionVisualAdmissionV1, type SessionVisualAdmissionV1 } from './executor/sessionVisualAdmission.js';
import {
  MachinePoolActionIdV1Schema,
  MachinePoolActionInputSchemasV1,
} from '../machines/pools/actionsV1.js';
import { ProjectWorkerActionIdV1Schema, ProjectWorkerActionInputSchemasV1, ProjectWorkerCopyInspectResultV1Schema } from './specs/projectWorkers.js';
import { MachinePoolResolveInputV1Schema, MachinePoolViewV1Schema } from '../machines/pools/v1.js';
import { resolveMachinePoolWorkerCandidateV1 } from '../machines/pools/machinePoolWorkerPlacement.js';
import { EphemeralRunnerActionIdV1Schema } from '../ephemeralRunner/actionIdsV1.js';
import { EphemeralRunnerActionInputSchemasV1 } from '../ephemeralRunner/actionsV1.js';
import { isHomeDomainActionIdV1 } from './homeDomainActionFamily.js';
import { executeTeamCredentialUsageExport } from './executor/teamCredentialUsageExport.js';
import { isTeamMembershipHistoryActionIdV1, TeamMembershipHistoryInputV1Schema } from '../teams/membershipHistoryPreparationV1.js';
import { ScopeActionIdSchema } from './scopeActionFamily.js';
import { DiagnosticsActionIdSchema } from './diagnosticsActionFamily.js';
import { ConnectedServiceConfigurationActionIdV1Schema } from '../connect/configurationActionsV1.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { isActionPolicyActionId } from './actionPolicyActionFamily.js';
import { isVoiceConversationActionId } from './voiceConversationActionFamily.js';
import { isAppShellActionId, readNoticeInboxAccountIdV1 } from './appShellActionFamily.js';
import { isNotificationConfigurationActionId } from './notificationConfigurationActionFamily.js';
import { BugReportSubmitInputSchema } from './specs/bugReport.js';
import { isAppUpdateActionId } from './appUpdateActionFamily.js';
import { isUpdatesActionId } from './updatesActionFamily.js';
import { ClipboardWriteInputSchema } from './clipboardActionFamily.js';
import { AutomationOccurrenceActionIdSchema, AutomationOccurrenceInputSchemas } from '../automations/occurrenceActions.js';
import { ExternalUrlOpenInputSchema } from './externalLinkActionFamily.js';
import { isInternalActionId } from './pluginActionSurface.js';
import {
  PluginSessionHookInstallActionInputV1Schema,
  PluginSessionHookInstallationMutationActionInputV1Schema,
  PluginSessionHookStatusActionInputV1Schema,
} from '../sessions/external/hookManagementV1.js';
import {
  PluginAccountDataEraseActionInputV1Schema,
} from '../plugins/data/accountEraseV1.js';
import {
  AccountSessionsSignOutEverywhereActionInputV1Schema,
} from '../auth/accountSessions.js';
import {
  AccountApiTokensCreateActionInputV1Schema,
  AccountApiTokensListActionInputV1Schema,
  AccountApiTokensRevokeActionInputV1Schema,
  AccountApiTokensUpdateActionInputV1Schema,
  AccountApiTokensRevokeAllActionInputV1Schema,
} from '../auth/accountApiTokens.js';
import {
  AccountEmailChangeRequestV1Schema,
  AccountPasswordChangeRequestV1Schema,
  AccountPasswordEnrollRequestV1Schema,
  AccountPasswordRemoveRequestV1Schema,
  AccountSecurityGetRequestV1Schema,
  AccountTerminalPresentUserPolicySetRequestV1Schema,
} from '../auth/accountSecurity.js';
import { PluginSettingsAdministrationActionIdV1Schema, PluginSettingsAdministrationActionInputSchemasV1 } from '../plugins/settingsAdministration.js';
import {
  formatQualifiedPluginActionId,
  parseQualifiedPluginActionId,
  type QualifiedPluginActionId,
} from '../plugins/actions/invocation.js';
import { PluginSessionInputAttachmentsV1Schema, PluginSessionInputSourceV1Schema, PluginSessionUserTextAuthoredFieldSchemasV1, SessionInputSourceSessionV1Schema, derivePluginSessionInputLocalIdV1, deriveWorkflowSessionInputLocalIdV2 } from '../sessions/messages/sessionInputAdmission.js';
import { PendingRequestedActionV1Schema, SessionPendingActionSetInputV1Schema, PendingResetStartSetInputV1Schema, PendingResetStartCancelInputV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import { PendingLocalIdSchema } from '../sessions/pending/pendingLocalId.js';
import {
  SessionPermissionRemoteGrantRevokeInputV1Schema,
  SessionPermissionRemoteGrantsListInputV1Schema,
  SessionPermissionRemotePendingListInputV1Schema,
  SessionPermissionRemoteRespondInputV1Schema,
  SessionUserActionRemoteAnswerInputV1Schema,
} from '../sessions/permissions/v1.js';
import type {
  SubagentRefInputV1,
  SubagentStatusV1,
  SubagentLifecycleDetailV1,
} from '../sessions/subagents/subagentRefV1.js';
import type {
  SessionHandoffAbortRequest,
  SessionHandoffCommitRequest,
  SessionHandoffPrepareTargetResultGetRequest,
  SessionHandoffPrepareTargetRequest,
  SessionHandoffPrepareTargetResumeRequest,
  SessionHandoffStatusGetRequest,
} from '../sessions/control/handoff/handoffSchemas.js';
import {
  WorkspaceSyncConflictResolveActionInputV1Schema,
  WorkspaceSyncConflictsListActionInputV1Schema,
  WorkspaceSyncConflictInspectActionInputV1Schema,
  WorkspaceSyncRelationshipsListActionInputV1Schema,
  WorkspaceSyncRelationshipCreateActionInputV1Schema,
  WorkspaceSyncRelationshipDisableActionInputV1Schema,
  WorkspaceSyncRelationshipEnableActionInputV1Schema,
  WorkspaceSyncRelationshipFlushActionInputV1Schema,
  WorkspaceSyncRelationshipTerminateActionInputV1Schema,
  type HandoffWorkspaceActionV1,
} from '../sessions/control/handoff/workspaceSyncSchemas.js';
import {
  HandoffTargetReplacementApprovalV1Schema,
  sameHandoffTargetReplacementApproval,
  type HandoffTargetReplacementApprovalV1,
} from '../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import type { SessionContinueWithReplayRpcParams } from '../sessions/continueWithReplay.js';
import { SessionForkRpcParamsSchema } from '../sessions/fork.js';
import { readRpcErrorCode, RPC_ERROR_CODES } from '../rpc/errors.js';
import {
  SessionSpawnNewInputV2Schema,
  SessionSpawnNewActionInputV2Schema,
  SessionSpawnNewActionAgentAuthoringInputV2Schema,
  admitSessionSpawnNewActionInputV2,
  projectSessionSpawnNewActionInputV2,
  type SessionSpawnNewInputV2,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import {
  admitActionAgentStartV1, isAgentStartActionV1, isAgentStartActionInvocationV1, isActionCallerOwnSessionV1, requiresActionAgentStartDepthV1, resolveActionAgentStartRequestsV1, resolveProfileSkillSeedsAtAdmissionV1,
  resolveActionAgentStartContextV1, resolveRunStartModelAndConfig, stampAgentStartSelectionV1, projectAgentStartSelectionV1,
} from './executor/agentStartAdmission.js';
import {
  SessionCreationDirectoryApprovalV1Schema,
  type SessionCreationDirectoryApprovalV1,
} from '../sessions/creation/sessionCreationTargetPreparationV1.js';
import { ExecutionRunSendRequestSchema } from '../execution/runs/index.js';
import { ExecutionRunCancelTurnRequestSchema } from '../execution/runs/cancelTurn.js';
import { readExecutionRunStartRunCreation, ExecutionRunStartResponseSchema, ExecutionRunWaitResultSchema, ExecutionRunGetResponseSchema, withExecutionRunStartFailureDetails } from '../execution/runs/responseSchemas.js';
import { ExecutionRunWaitConditionSchema } from '../execution/runs/waitForTerminal.js';
import type {
  CheckpointCodeRollbackRequest,
  CheckpointCodeRollbackActionRequest,
  CheckpointCodeRollbackResult,
} from '../sessions/control/rollback/checkpointCodeRollback.js';
import type {
  SessionCheckpointRequestV1,
  SessionCheckpointResultV1,
  SessionRestoreRequestV1,
  SessionRestoreResultV1,
} from '../sessions/control/checkpoints/v1.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';
import { ActionApprovalRequestCreatedResultSchema, ActionOperationCredentialUseV1Schema, projectActionExecuteFailure, type ActionOperationCredentialUseV1 } from './actionExecutionResult.js';
import { dispatchRuntimeAction } from './executor/dispatch.js';
import type { RuntimeActionExecute } from './executor/types.js';
import type { SessionConnectedServiceAuthSwitchRpcParams } from '../connect/sessionConnectedServiceAuthSwitch.js';

import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, ActionSessionAddress, ActionPreparedInvocation, ActionPrepareResult } from './executor/types.js';
export type {
  ActionAutomationRunCaller,
  ActionCaller,
  ActionExecuteResult,
  ActionExecutorContext,
  ActionExecutorDeps,
  ActionSessionAddress,
  ActionSessionReferenceResolution,
  ActionPreparedInvocation,
  ActionPrepareResult,
  ActionPluginCaller,
  ApprovalQueueListItemV1,
  ApprovalQueueListResultV1,
  ApprovalQueueQueryPlanV1,
  ScmActionExecute,
  ScmActionId,
  WorkflowActionExecute,
  WorkflowActionExecuteArgs,
} from './executor/types.js';

type ActionExecuteFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

function redactMemoryActionInput(actionId: string, input: unknown): unknown {
  const request = readRecord(input);
  return isMemoryWriteActionV1(actionId) && typeof request.text === 'string'
    ? { ...request, text: redactBugReportSensitiveText(request.text),
      ...(actionId === 'memory.decision.save' && typeof request.reason === 'string'
        ? { reason: redactBugReportSensitiveText(request.reason) } : {}) } : input;
}

/** Removing a reference placement preserves its definition; groups have no single instance. */
function widgetRemovalDeletesStoredContent(instance: ReturnType<typeof WidgetInstanceV1Schema.parse> | undefined): boolean {
  return !instance || instance.definition.kind === 'inline';
}

export function createActionExecutor(deps: ActionExecutorDeps): Readonly<{
  prepare: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionPrepareResult>;
  execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
  continueConfidentialApprovalRequest: (input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
  replayApprovedApprovalRequest: (args: Readonly<{
    artifactId: string;
    signal?: AbortSignal;
    callerAuthority?: ActionRequiredAuthority;
    /** Current credential-bound host facts, never read from the approval or RPC operands. */
    currentAccount?: Readonly<{ accountId: string; serverId: string; serverIdentityId: string }>;
  }>) => Promise<ActionExecuteResult>;
}> {
  const startExecutionRunWithSelection = (
    sessionId: Parameters<ActionExecutorDeps['executionRunStart']>[0],
    input: Parameters<ActionExecutorDeps['executionRunStart']>[1],
    opts: Parameters<ActionExecutorDeps['executionRunStart']>[2],
    context: ActionExecutorContext,
  ) => {
    const resolved = context.agentStartContext;
    const machineId = opts?.targetMachineId ?? context.executionRunTargetMachineId;
    const current = resolved && machineId && machineId !== resolved.baseline.machineId
      ? { ...resolved, baseline: { machineId: resolved.baseline.machineId, directory: resolved.baseline.directory } } : resolved;
    return deps.executionRunStart(sessionId, current
      ? stampAgentStartSelectionV1(input, { workDepth: context.agentStartWorkDepth ?? 0 }, 'execution_run', current) : input, opts);
  };
  const retireOpenManagedDeleteApprovals = async (input: Readonly<{ homeId: string; managedId: string }>,
    ctx: ActionExecutorContext): Promise<void> => {
    if (!deps.approvalsList || !deps.approvalsGet || !deps.approvalsUpdate) return;
    const warn = async (warning: Readonly<{ artifactId?: string; code: string }>) => {
      try {
        await deps.recordApprovalRetirementWarning?.(warning);
      } catch {
        // Diagnostics cannot change the already-confirmed Delete outcome.
      }
    };
    const failureCode = (error: unknown, fallback: string) => normalizeId(readRecord(error).code) || fallback;
    let cursor: string | null = null;
    do {
      let page: Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalsList']>>>;
      try {
        page = await deps.approvalsList({ status: 'open', actionId: 'machines.managed.delete',
          subjectKey: deriveManagedDeleteApprovalSubjectKeyV1(input), cursor,
          limit: 100, serverId: normalizeId(ctx.serverId) || null });
      } catch (error) {
        await warn({ code: failureCode(error, 'list_failed') });
        return;
      }
      for (const item of page.items) {
        let stored: Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalsGet']>>>;
        try {
          stored = await deps.approvalsGet({ artifactId: item.artifactId,
            serverId: normalizeId(ctx.serverId) || null });
        } catch (error) {
          await warn({ artifactId: item.artifactId, code: failureCode(error, 'read_failed') });
          continue;
        }
        const parsed = StoredApprovalRequestSchema.safeParse(stored);
        if (!parsed.success || parsed.data.status !== 'open' || parsed.data.actionId !== 'machines.managed.delete') continue;
        const actionArgs = readRecord(parsed.data.actionArgs);
        if (actionArgs.homeId !== input.homeId || actionArgs.managedId !== input.managedId) continue;
        const now = Date.now();
        const canceled: ApprovalRequest = { ...settleApprovalRequestReplayInputs(parsed.data), status: 'canceled',
          updatedAtMs: Math.max(now, parsed.data.updatedAtMs) };
        try {
          const updated = await deps.approvalsUpdate({ artifactId: item.artifactId, request: canceled,
            serverId: normalizeId(ctx.serverId) || null });
          if (!updated.ok) {
            await warn({ artifactId: item.artifactId, code: updated.errorCode });
          }
        } catch (error) {
          await warn({ artifactId: item.artifactId, code: failureCode(error, 'update_failed') });
        }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
  };
  const prepareApprovalExecutionOrigin = async (params: Parameters<typeof buildApprovalExecutionOriginV1>[0]) => {
    if (params.context.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const prepared = await deps.prepareApprovalExecutionOriginContext?.({
      ...(params.context.signal ? { signal: params.context.signal } : {}),
    });
    if (params.context.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    return buildApprovalExecutionOriginV1({
      ...params,
      context: prepared ? { ...params.context, serverIdentityId: prepared.serverIdentityId } : params.context,
    });
  };
  const isSameHome = (targetServerId: unknown, currentServerId: string | null | undefined, ctx: ActionExecutorContext): boolean =>
    typeof targetServerId === 'string' && areServerProfileIdentifiersEquivalent(targetServerId, currentServerId, identifier =>
      identifier === ctx.serverId && ctx.serverIdentityId ? ctx.serverIdentityId
        : identifier === ctx.serverIdentityId ? ctx.serverIdentityId : deps.resolveServerProfileScopeId?.(identifier));
  const actionPolicyContext = (actionId: ActionId, ctx: ActionExecutorContext): ActionExecutorContext => {
    const reservation = actionId === 'discussion.invite' && ctx.actionCaller?.kind === 'workflowRun'
      ? ctx.actionCaller.discussionModelReservation : undefined;
    return reservation?.policySurface ? { ...ctx, surface: reservation.policySurface } : ctx;
  };
  const policyAllowsAction = (id: ActionId, ctx: ActionExecutorContext) =>
    deps.isActionEnabled ? deps.isActionEnabled(id, actionPolicyContext(id, ctx)) : true;
  const isActionEnabledByPolicy = (spec: ActionSpec, ctx: ActionExecutorContext) => policyAllowsAction(spec.id, ctx);
  const isActionEnabledBySurface = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionSpecSurfacedOn(spec, ctx.surface);
  const isActionEnabled = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionEnabledBySurface(spec, ctx) && isActionEnabledByPolicy(spec, ctx);
  const isHostInternalActionEnabled = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionEnabledByPolicy(spec, ctx)
    && (!ctx.actionsSettings || isActionEnabledByActionsSettings(spec.id, ctx.actionsSettings,
      { surface: actionPolicyContext(spec.id, ctx).surface, placement: ctx.placement }));
  const listContributedActionDefinitions = (
    selection?: Parameters<NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>>[0],
  ): readonly ActionDefinitionSummaryV1[] => {
    try {
      return deps.listContributedActionDefinitions?.(selection) ?? [];
    } catch {
      return [];
    }
  };
  const getContributedActionSettingsId = (
    definition: ActionDefinitionSummaryV1,
  ): QualifiedPluginActionId | null => {
    const identity = parseQualifiedPluginActionId(definition.id);
    return identity ? formatQualifiedPluginActionId(identity) : null;
  };
  const isContributedActionDefinitionSurfacedOn = (
    definition: ActionDefinitionSummaryV1,
    ctx: ActionExecutorContext,
  ): boolean => {
    const surface = parseActionSurfaceKey(ctx.surface);
    return !surface || definition.surfaces[surface] === true;
  };
  const isContributedActionDefinitionEnabled = (
    definition: ActionDefinitionSummaryV1,
    ctx: ActionExecutorContext,
  ): boolean => {
    const actionId = getContributedActionSettingsId(definition);
    return actionId !== null && !credentialScopeFailure(actionId, ctx, undefined, true) && (
      !ctx.actionsSettings
      || isActionEnabledByActionsSettings(actionId, ctx.actionsSettings, {
        surface: parseActionSurfaceKey(ctx.surface),
      })
    );
  };
  const getContributedActionDefinition = (
    id: string,
    ctx: ActionExecutorContext,
  ): ActionDefinitionSummaryV1 | null => {
    const identity = parseQualifiedPluginActionId(id);
    if (!identity) return null;
    const definition = listContributedActionDefinitions({ id: formatQualifiedPluginActionId(identity) })
      .find((candidate) => candidate.id === id) ?? null;
    return definition && isContributedActionDefinitionSurfacedOn(definition, ctx)
      ? definition
      : null;
  };

  // Discovery owns the current declaration. The dispatch wrapper merely
  // projects its operand path into the same input used by host Actions.
  const readActionSessionTargetDeclaration = (id: string, input: unknown, ctx: ActionExecutorContext):
    (ActionSessionTargetDeclarationV1 & Readonly<{ scopeSideEffectClass?: ActionSpec['sideEffectClass'] }>) | undefined => {
    if (id === 'action.invoke') {
      const action = readRecord(readRecord(input).action);
      if (typeof action.pluginId !== 'string' || typeof action.localId !== 'string') return undefined;
      let qualifiedId: QualifiedPluginActionId;
      try { qualifiedId = formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.localId }); }
      catch { return undefined; }
      const definition = getContributedActionDefinition(qualifiedId, ctx);
      const declaration = definition?.sessionTarget;
      // The contributed dispatcher uses the same safe classification for its
      // read-only admission. A wrapper cannot supply the handler's effect facts.
      return definition && declaration ? { ...declaration, field: `input.${declaration.field}`,
        scopeSideEffectClass: definition.sideEffectClass ?? (definition.safety === 'safe' ? 'read' : 'external') } : undefined;
    }
    const hostId = ActionIdSchema.safeParse(id);
    return hostId.success ? getActionSpec(hostId.data).sessionTarget
      : getContributedActionDefinition(id, ctx)?.sessionTarget;
  };

  function resolveAvailabilityForContext(spec: ActionSpec, ctx: ActionExecutorContext): ActionSurfaceAvailability | null {
    ctx = actionPolicyContext(spec.id, ctx);
    const surface = parseActionSurfaceKey(ctx.surface);
    if (!surface) return null;
    return resolveActionSurfaceAvailability({
      actionId: spec.id as ActionId,
      surface,
      settings: ctx.actionsSettings ?? null,
      isActionEnabled: (id) => policyAllowsAction(id, ctx),
    });
  }

  function actionDisabled(
    details: ActionSurfaceAvailability | null,
  ): Extract<ActionExecuteResult, Readonly<{ ok: false }>> {
    return {
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      ...(details ? { details } : {}),
    };
  }

  function resolveHostStampedAuthority(ctx: ActionExecutorContext): ActionRequiredAuthority {
    return ctx.authority ?? 'account_automation';
  }

  async function readDiscussionPublicationPolicy(actionId: string, input: unknown, ctx: ActionExecutorContext,
    originalSessionId?: string): Promise<Readonly<{ ok: true; answerPolicy: DiscussionAnswerPolicyV1; informationalReturn: boolean }> | ActionExecuteFailure | null> {
    if (actionId !== 'discussion.post' && actionId !== 'discussion.reply') return null;
    const returned = ctx.discussionReplyReturn;
    if (returned && 'kind' in returned) {
      const publication = readRecord(input);
      const target = readRecord(publication.replyTarget);
      const exact = actionId === 'discussion.reply' && ctx.actionCaller?.kind === 'workflowRun'
        && ctx.actionCaller.runId === returned.producer.runId
        && Boolean(ctx.runtimeAccountId && ctx.defaultSessionMachineId) && ctx.serverIdentityId === returned.serverId
        && publication.discussionId === returned.origin.discussion.discussionId
        && target.kind === 'message' && target.messageId === returned.origin.messageId
        && publication.localId === deriveWorkflowDiscussionReplyLocalIdV1(returned.producer)
        && ctx.actionRequestId === publication.localId;
      return exact ? { ok: true, answerPolicy: 'when_addressed', informationalReturn: true }
        : { ok: false, errorCode: 'discussion_post_denied', error: 'discussion_post_denied' };
    }
    const publisherSessionId = originalSessionId || (ctx.actionCaller?.kind === 'session' ? normalizeId(ctx.actionCaller.sessionId)
      : (ctx.actionCaller?.kind === 'host' || ctx.actionCaller?.kind === 'workflowRun') && ctx.discussionReplyReturn ? normalizeId(ctx.defaultSessionId) : '');
    if (!publisherSessionId) return null;
    if (!deps.discussionAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    let rawRoster: unknown;
    try {
      rawRoster = await deps.discussionAction({ actionId: 'discussion.participants.list',
        input: { discussionId: readRecord(input).discussionId }, context: ctx,
        ...(ctx.signal ? { signal: ctx.signal } : {}) });
    } catch (error) {
      const failure = normalizeActionExecutorThrownError(error);
      return { ok: false, ...failure };
    }
    const failure = readActionFailureEnvelope(rawRoster);
    if (failure) return failure;
    const roster = DiscussionParticipantsListResponseV1Schema.safeParse(rawRoster);
    if (!roster.success || roster.data.discussionId !== readRecord(input).discussionId) {
      return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    const participant = roster.data.participants.find(entry => entry.participant.kind === 'session'
      ? entry.participant.sessionId === publisherSessionId : 'sessionId' in entry && entry.sessionId === publisherSessionId);
    const marker = returned;
    const parsedSource = SessionInputSourceSessionV1Schema.safeParse(ctx.sessionInputSource);
    const source = parsedSource.success ? parsedSource.data : undefined;
    const addressing = source?.discussionAddressing;
    const publication = readRecord(input);
    const target = readRecord(publication.replyTarget);
    // Eligibility to reach the incumbent trusted publisher only. Its durable
    // execution proof and the Home's original/G checks remain the authority.
    const informationalReturn = Boolean(actionId === 'discussion.reply'
      && (ctx.actionCaller?.kind === 'host' || ctx.actionCaller?.kind === 'workflowRun' && ctx.actionCaller.runId === marker?.workflow?.runId) && marker?.workflow
      && ctx.serverIdentityId === marker.serverId && marker.acceptedTurnId
      && source?.sourceSessionId === publisherSessionId && source.sourceInputId === marker.requestLocalId
      && source.sourceTurnId === marker.acceptedTurnId && addressing?.participantSessionId === publisherSessionId
      && addressing.discussionId === publication.discussionId && target.kind === 'message' && target.messageId === addressing.messageId
      && marker.requestLocalId === deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation',
        runId: marker.workflow.runId, invocationRecordId: marker.workflow.invocationRecordId })
      && publication.localId === deriveSessionMessageReplyReturnLocalIdV1({ sessionId: publisherSessionId,
        localId: marker.requestLocalId, acceptedTurnId: marker.acceptedTurnId }));
    if (participant) return { ok: true, answerPolicy: participant.answerPolicy, informationalReturn };
    if (informationalReturn) return { ok: true, answerPolicy: 'when_addressed', informationalReturn };
    return { ok: false, errorCode: 'discussion_participant_required', error: 'discussion_participant_required' };
  }

  async function requireDiscussionDraftReviewAuthority(request: ApprovalRequest, ctx: ActionExecutorContext): Promise<ActionExecuteFailure | null> {
    if (resolveHostStampedAuthority(ctx) === 'present_user' || request.v !== 2) return null;
    const origin = request.executionOriginV1;
    if (!isSessionDiscussionApprovalPublicationV1(request)) return null;
    const policy = await readDiscussionPublicationPolicy(request.actionId, request.actionArgs,
      { ...ctx, serverId: origin.serverId, runtimeAccountId: origin.accountId },
      origin.caller.kind === 'session' ? origin.caller.sessionId : origin.sessionId);
    if (policy && !policy.ok) return policy;
    return policy?.answerPolicy === 'drafts_for_approval'
      ? { ok: false, errorCode: 'present_user_required', error: 'present_user_required' } : null;
  }

  /** Structural transport admission only; the asking Session alone decides manager eligibility. */
  function hasSessionQuestionAnswerOrigin(actionId: string, ctx: ActionExecutorContext): boolean {
    if (actionId !== 'session.user_action.answer' || ctx.signal?.aborted
      || ctx.externalActionCredential || ctx.externalActionExecutionAuthorization) return false;
    if (ctx.actionCaller?.kind === 'plugin') {
      return SessionActionRpcOriginV1Schema.safeParse(ctx.readSessionActionRpcOrigin?.()).success;
    }
    if (ctx.actionCaller?.kind !== 'session') return false;
    const source = ctx.sessionInputSource;
    if (!source || typeof source !== 'object' || !('sourceSessionId' in source)
      || source.sourceSessionId !== ctx.actionCaller.sessionId) return false;
    const permissionMode = ctx.callerPermissionMode ? parseAgentPermissionIntentV1Alias(ctx.callerPermissionMode) : null;
    if (ctx.callerPermissionMode && !permissionMode) return false;
    return SessionActionRpcOriginV1Schema.safeParse({
      v: 1, caller: ctx.actionCaller,
      sourceTurnId: 'sourceTurnId' in source ? source.sourceTurnId : undefined,
      ...('sourceInputId' in source ? { sourceInputId: source.sourceInputId } : {}),
      callerPermissionMode: permissionMode,
      requestId: ctx.actionRequestId,
    }).success;
  }

  function requiredAuthorityFailure(
    spec: ActionSpec,
    ctx: ActionExecutorContext,
    input: unknown,
  ): Extract<ActionExecuteResult, Readonly<{ ok: false }>> | null {
    if (spec.id === 'secrets.shared.reveal' && (ctx.surface !== 'ui' || !isPresentUserHostInvocation(ctx))) {
      return { ok: false, errorCode: 'reveal_person_only', error: 'reveal_person_only' };
    }
    // Request admission is not replay authority. Only the decision owner may
    // stamp the human authority after claiming a present-user approval below.
    if (ctx.bypassApprovals && canRequestPresentUserApprovalForActionInputV1(spec, input)
      && resolveHostStampedAuthority(ctx) !== 'present_user' && !hasSessionQuestionAnswerOrigin(spec.id, ctx)) {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    const admission = resolveCredentialActionAdmissionV1({
      spec, authority: resolveHostStampedAuthority(ctx), grant: ctx.externalActionCredential?.grant ?? null,
      surface: ctx.surface, hasExternalCredential: ctx.externalActionCredential !== undefined,
      actionInput: input,
      ...(ctx.nativeRealtimeInput ? { nativeRealtimeInput: true } : {}),
      hasSessionQuestionAnswerOrigin: hasSessionQuestionAnswerOrigin(spec.id, ctx),
    });
    return admission.ok ? null : { ok: false, errorCode: admission.errorCode, error: admission.errorCode };
  }

  function credentialScopeFailure(
    actionId: string,
    ctx: ActionExecutorContext,
    input?: unknown,
    discovery = false,
    sourceMachineIds?: ReadonlyMap<string, string>,
    hostInternal = false,
  ): ActionExecuteFailure | null {
    const grant = ctx.externalActionCredential?.grant;
    if (!grant) return null;
    if (actionId === 'deployments.deploy') {
      // Discovery checks the Action ceiling only. Execution consumes the decoded
      // operand and the Home's exact Environment/receiving-host admission.
      if (discovery) return isApiTokenGrantActionAllowedV1(grant, actionId) ? null
        : { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
      const binding = ctx.externalActionExecutionAuthorization?.binding;
      if (!binding || binding.actionId !== actionId || binding.environmentId !== readRecord(input).environmentId
        || binding.environmentId === undefined || binding.target.kind !== 'machine'
        || binding.target.machineId !== binding.machineId || ctx.externalActionTarget?.kind !== 'machine'
        || ctx.externalActionTarget.machineId !== binding.machineId) {
        return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
          details: { reason: 'environment_not_granted' } };
      }
    }
    const rootInputAction = readHostRootInputCredentialActionV1(actionId, input, ctx, hostInternal);
    const action = readRecord(readRecord(input).action);
    const contributedQualifiedId = actionId === 'action.invoke'
      && typeof action.pluginId === 'string' && typeof action.localId === 'string'
      ? formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.localId })
      : parseQualifiedPluginActionId(actionId) !== null ? actionId : undefined;
    const widgetSurface = (actionId === 'widgets.snapshot.post' || isActionFamilyId(actionId, WidgetInstanceActionIdV1Schema)) ? readWidgetActionSurfaceV1(input) : null;
    const widgetSessionId = widgetSurface?.owner.kind === 'sessionBoard' || widgetSurface?.owner.kind === 'companion' ? widgetSurface.owner.sessionId : null;
    const definitionAction = isActionFamilyId(actionId, WidgetDefinitionActionIdV1Schema)
      || isActionFamilyId(actionId, WidgetLayoutFragmentActionIdV1Schema);
    const definitionSession = definitionAction ? readWidgetDefinitionActionSessionV1(input) : null;
    const declaration = readActionSessionTargetDeclaration(actionId, input, ctx);
    const sessionId = definitionSession?.sessionId ?? widgetSessionId ?? (input === undefined ? null
      : normalizeId(readRecord(input).sessionId) || (declaration && !declaration.field.includes('*')
        ? normalizeId(readActionSessionTargetField(readRecord(input), declaration.field)) : null));
    // A contributed handler owns what an omitted declared Session operand means
    // (often the whole Account). The routed target is not that operand, so a
    // Session-restricted grant must name a granted Session instead.
    const omittedContributedTarget = contributedQualifiedId !== undefined && input !== undefined
      && declaration !== undefined && !declaration.field.includes('*');
    const target = sessionId ? { kind: 'session' as const, sessionId }
      : widgetSurface || definitionAction || omittedContributedTarget ? null : ctx.externalActionTarget
      ?? (ctx.defaultSessionId ? { kind: 'session' as const, sessionId: ctx.defaultSessionId } : null);
    const result = evaluateApiTokenGrantV1({
      grant: discovery ? { ...grant, targets: null, create: null, automationIds: null }
        : actionId === 'approval.request.decide' ? { ...grant, targets: null } : grant,
      actionId: rootInputAction ?? (contributedQualifiedId && actionId !== 'action.invoke' ? 'action.invoke' : actionId),
      ...(contributedQualifiedId ? { contributedQualifiedId } : {}),
      ...(actionId === 'session.spawn_new' && input !== undefined ? { spawnInput: input } : {}),
      ...(actionId === 'session.spawn_new' && ctx.surface === 'api'
        ? { contributedActionAdmission: 'pre_open' as const, sessionSpawnInputKind: 'public_api' as const }
        : {}),
      ...(actionId === 'workflow.trigger.run_now' ? { automationId: readRecord(input).automationId } : {}),
      ...(actionId === 'deployments.deploy' ? { environmentId: readRecord(input).environmentId } : {}),
      target, targetMachineId: (rootInputAction ? ctx.externalActionExecutionAuthorization?.binding.machineId : undefined)
        ?? (sessionId ? sourceMachineIds?.get(sessionId) : undefined) ?? (sessionId && sessionId !== ctx.defaultSessionId ? undefined : ctx.defaultSessionMachineId
        ?? (ctx.externalActionTarget?.kind === 'machine' ? ctx.externalActionTarget.machineId : undefined)),
    });
    const boundSession = actionId === 'widgets.catalog.list' ? readWidgetCatalogBoundSessionV1(input) : null;
    const boundResult = result.ok && boundSession ? evaluateApiTokenGrantV1({ grant, actionId,
      target: { kind: 'session', sessionId: boundSession.sessionId },
      targetMachineId: boundSession.sessionId === ctx.defaultSessionId ? ctx.defaultSessionMachineId : undefined,
    }) : result;
    const destination = actionId === 'widgets.item.move' ? readWidgetActionDestinationV1(input) : null;
    const destinationSession = destination?.owner.kind === 'sessionBoard' || destination?.owner.kind === 'companion' ? destination.owner.sessionId : null;
    const finalResult = boundResult.ok && destination ? evaluateApiTokenGrantV1({ grant, actionId,
      target: destinationSession ? { kind: 'session', sessionId: destinationSession } : null,
      targetMachineId: destinationSession && destinationSession === ctx.defaultSessionId ? ctx.defaultSessionMachineId : undefined,
    }) : boundResult;
    const copySource = actionId === 'session.board.item.upsert'
      ? readRecord(readRecord(input).copySource ?? readRecord(readRecord(input).reviewedVisual).copySource) : null;
    const copySessionId = copySource ? normalizeId(copySource.sessionId) : null;
    // A copy reads another Session before destination admission. Frozen approval
    // replay retains that source target even though it no longer re-reads content.
    const copyResult = finalResult.ok && copySessionId && !discovery ? evaluateApiTokenGrantV1({ grant, actionId,
      target: { kind: 'session', sessionId: copySessionId },
      targetMachineId: sourceMachineIds?.get(copySessionId)
        ?? (copySessionId === ctx.defaultSessionId ? ctx.defaultSessionMachineId : undefined),
    }) : finalResult;
    const managedContinuation = actionId === 'machines.managed.acquire' ? readRecord(readRecord(input).agentStart) : null;
    // A known fresh continuation cannot inherit the controller's target grant:
    // the new Machine has no identity yet. The incumbent grant owner therefore
    // must admit spawn without a substituted target before compute is purchased.
    const continuationResult = copyResult.ok && managedContinuation && Object.keys(managedContinuation).length > 0
      ? evaluateApiTokenGrantV1({ grant, actionId: 'session.spawn_new' }) : copyResult;
    return continuationResult.ok ? null : {
      ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', details: { reason: continuationResult.reason,
        ...(finalResult.ok && copySessionId && !copyResult.ok ? { sourceSessionId: copySessionId } : {}),
      },
    };
  }

  async function admitCredentialScope(
    actionId: ActionId,
    ctx: ActionExecutorContext,
    input?: unknown,
    hostInternal = false,
  ): Promise<ActionExecuteFailure | null> {
    let failure = credentialScopeFailure(actionId, ctx, input, false, undefined, hostInternal);
    if (!ctx.externalActionCredential?.grant?.targets?.machines.length || !deps.resolveApiTokenGrantSessionMachineId) return failure;
    const sourceMachineIds = new Map<string, string>();
    // Execution placement is not source attribution. Ask the authenticated host
    // boundary, then re-enter the same grant owner; absent proof stays closed.
    while (failure && readRecord(failure.details).reason === 'target_not_granted') {
      const declaration = readActionSessionTargetDeclaration(actionId, input, ctx);
      const sessionId = normalizeId(readRecord(failure.details).sourceSessionId) || normalizeId(readRecord(input).sessionId)
        || (declaration && !declaration.field.includes('*') ? normalizeId(readActionSessionTargetField(readRecord(input), declaration.field)) : null);
      if (!sessionId || sourceMachineIds.has(sessionId)) return failure;
      try {
        const machineId = await deps.resolveApiTokenGrantSessionMachineId({ actionId, sessionId, context: ctx });
        if (!machineId || ctx.signal?.aborted) return failure;
        sourceMachineIds.set(sessionId, machineId);
        failure = credentialScopeFailure(actionId, ctx, input, false, sourceMachineIds, hostInternal);
      } catch { return failure; }
    }
    return failure;
  }

  async function admitDiscussionInvitationTargets(actionId: ActionId, input: unknown, ctx: ActionExecutorContext,
    snapshot: ActionExecutorContext['sessionTargetsV1']): Promise<ActionExecuteFailure | null> {
    if (actionId !== 'discussion.create' && actionId !== 'discussion.invite') return null;
    if (snapshot) {
      if (snapshot.targets.some(target => !ctx.serverId || !isSameHome(target.serverId, ctx.serverId, ctx))) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      for (const target of snapshot.targets) {
        const failure = await admitCredentialScope(actionId, { ...ctx, serverId: target.serverId }, { sessionId: target.sessionId });
        if (failure) return failure;
      }
    }
    if (actionId === 'discussion.create' && readRecord(input).participants !== undefined
      && !DiscussionInitialParticipantsV1Schema.safeParse(readRecord(input).participants).success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    return null;
  }

  function workspaceWriteFailure(
    spec: ActionSpec,
    input: unknown,
    ctx: ActionExecutorContext,
  ): ActionExecuteFailure | null {
    let currentWorkspaceWrites: 'allow' | 'deny' | undefined;
    try { currentWorkspaceWrites = deps.getCurrentWorkspaceWrites?.(); }
    catch { return { ok: false, errorCode: 'role_policy_unavailable', error: 'role_policy_unavailable' }; }
    const admission = resolveWorkspaceWriteActionAdmissionV1({
      spec, actionInput: input, workspaceWrites: ctx.workspaceWrites, currentWorkspaceWrites,
      agentCaller: isAgentCaller(ctx),
    });
    return admission.ok ? null : { ok: false, errorCode: admission.errorCode, error: admission.errorCode };
  }

  function pluginActionCallerPolicyFailure(
    spec: ActionSpec,
    input: unknown,
    ctx: ActionExecutorContext,
  ): Extract<ActionExecuteResult, Readonly<{ ok: false }>> | null {
    // Incumbent safe Actions without a caller policy retain their released
    // behavior. An explicit policy is authoritative regardless of safety.
    if (ctx.surface !== 'plugin' || (spec.safety === 'safe' && !spec.pluginCallerPolicy)) return null;
    return isPluginActionCallerPolicySatisfied(spec.pluginCallerPolicy, input, ctx.actionCaller)
      ? null
      : {
          ok: false,
          errorCode: 'plugin_action_caller_forbidden',
          error: 'plugin_action_caller_forbidden',
        };
  }

  function callerInputSchema(spec: ActionSpec, ctx: ActionExecutorContext) {
    if (ctx.surface === 'cli') {
      // Friendly argv has already been bound; admit only the declared whole Action input.
      return spec.cli?.wholeInputSchema ?? spec.inputSchema;
    }
    if (ctx.surface === 'mcp') {
      return spec.surfaceBindings?.mcp?.inputSchema ?? spec.inputSchema;
    }
    if (ctx.surface === 'api') {
      return spec.surfaceBindings?.api?.inputSchema ?? spec.inputSchema;
    }
    return ctx.surface === 'plugin' && ctx.actionCaller?.kind === 'plugin'
      ? spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema
      : spec.inputSchema;
  }

  async function bindCallerInput(
    spec: ActionSpec,
    input: unknown,
    ctx: ActionExecutorContext,
    hostInternal = false,
  ): Promise<Readonly<
    | { ok: true; input: unknown }
    | ActionExecuteFailure
  >> {
    // Private children have no surface binding. Core admission parses their
    // semantic input after resolving targets, just as it does for bound input.
    if (hostInternal) return { ok: true, input };
    const schema = callerInputSchema(spec, ctx);
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      const timingIssue = spec.id === 'session.permission_mode.set'
        ? parsed.error.issues.find((issue) => issue.path[0] === 'applyTiming')
        : undefined;
      return { ...actionInputValidationFailure(parsed.error), error: timingIssue?.message ?? 'invalid_parameters' };
    }
    const caller = ctx.actionCaller ?? { kind: 'host' as const };
    const apiBinding = ctx.surface === 'api'
      ? spec.surfaceBindings?.api
      : undefined;
    const pluginBinding = ctx.surface === 'plugin' && caller.kind === 'plugin'
      ? spec.surfaceBindings?.plugin
      : undefined;
    const binding = apiBinding ?? pluginBinding;
    if (!binding?.bindInput) return { ok: true, input: parsed.data };
    if (apiBinding && caller.kind !== 'host') {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      };
    }
    if (pluginBinding && caller.kind !== 'plugin') {
      return {
        ok: false,
        errorCode: 'plugin_action_caller_required',
        error: 'plugin_action_caller_required',
      };
    }
    try {
      return {
        ok: true,
        input: await binding.bindInput(parsed.data, {
          actionId: spec.id,
          surface: apiBinding ? 'api' : 'plugin',
          caller,
          ...(ctx.defaultSessionId !== undefined ? { defaultSessionId: ctx.defaultSessionId } : {}),
          ...(ctx.serverId !== undefined ? { serverId: ctx.serverId } : {}),
          ...(ctx.externalActionTarget !== undefined
            ? { externalActionTarget: ctx.externalActionTarget }
            : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }),
      };
    } catch {
      return {
        ok: false,
        errorCode: apiBinding ? 'invalid_parameters' : 'plugin_action_input_binding_failed',
        error: apiBinding ? 'invalid_parameters' : 'plugin_action_input_binding_failed',
      };
    }
  }

  async function isApprovalExecutionOriginCurrentForRequest(args: Readonly<{
    request: ApprovalRequest;
    expectedOriginServerId?: string | null;
    expectedServerIdentityId?: string | null;
    signal?: AbortSignal;
    reportStale?: (reason: ApprovalStaleReason) => void;
  }>): Promise<boolean> {
    const stale = (reason: ApprovalStaleReason) => { args.reportStale?.(reason); return false; };
    if (args.request.v !== 2) return stale('origin_version');
    if (!deps.isApprovalExecutionOriginCurrent) return stale('currentness_owner_unavailable');
    const origin = ApprovalExecutionOriginV1Schema.safeParse(args.request.executionOriginV1);
    if (
      !origin.success
      || (origin.data.surface === 'api' && (
        origin.data.externalActionExecutionAuthorization === undefined
        || origin.data.externalActionInputSignature === undefined
      ))
    ) {
      return stale('origin_invalid');
    }
    if (origin.data.actionId !== args.request.actionId) return stale('origin_action_changed');
    if (args.expectedOriginServerId !== undefined && args.expectedOriginServerId !== origin.data.serverId
      || args.expectedServerIdentityId !== undefined && args.expectedServerIdentityId !== origin.data.serverIdentityId) return stale('home_changed');
    const currentness = await classifyApprovalExecutionOriginCurrentness({
      check: async reportStale => await deps.isApprovalExecutionOriginCurrent!({
        origin: origin.data,
        request: args.request,
        ...(args.signal ? { signal: args.signal } : {}),
        reportStale,
      }),
    });
    if (currentness.status === 'requester_home_unavailable' || currentness.status === 'read_failed') {
      throw currentness.error;
    }
    if (currentness.status === 'stale') return stale(currentness.reason);
    if (!origin.data.runId || !origin.data.runOccurrenceId) return true;
    const runCurrentness = await classifyApprovalExecutionOriginCurrentness({
      check: async reportStale => {
        const currentRun = await deps.executionRunGet(
          origin.data.sessionId ?? null,
          { runId: origin.data.runId, includeStructured: false },
          { ...(args.signal ? { signal: args.signal } : {}) },
        );
        // The CLI Session adapter returns its service envelope; Machine and app
        // adapters return the payload. Use the public Run Action's one normalizer.
        const observed = completeExecutionRunServiceActionResult('execution.run.get', currentRun);
        if (!observed.ok) {
          if (observed.errorCode === 'execution_run_not_found') {
            reportStale('currentness_read_failed');
            return false;
          }
          throw Object.assign(new Error(observed.error), observed);
        }
        const run = readRecord(readRecord(observed.result).run);
        const inputTurns = readRecord(run.inputTurns);
        const matches = normalizeId(run.runId) === origin.data.runId
          && normalizeId(inputTurns.occurrenceId) === origin.data.runOccurrenceId;
        if (!matches) reportStale('run_occurrence_changed');
        return matches;
      },
    });
    if (runCurrentness.status === 'requester_home_unavailable' || runCurrentness.status === 'read_failed') {
      throw runCurrentness.error;
    }
    return runCurrentness.status === 'current' || stale(runCurrentness.reason);
  }

  async function readMatchingApprovalRequestReceipt(args: Readonly<{
    artifactId: string;
    serverId: string | null;
    request: ApprovalRequest;
  }>): Promise<ApprovalRequest | null> {
    try {
      const persisted = StoredApprovalRequestSchema.safeParse(await deps.approvalsGet?.({
        artifactId: args.artifactId, serverId: args.serverId,
      }));
      if (persisted.success && sameStrictJsonValue(persisted.data, JSON.parse(JSON.stringify(args.request)))) {
        return persisted.data;
      }
    } catch { /* An unreadable or different receipt cannot establish a committed write. */ }
    return null;
  }

  /** Approved replies use the same original-input settlement as ordinary return recovery. */
  async function settleFailedDiscussionApprovalPublication(artifactId: string, request: ApprovalRequest,
    context: ActionExecutorContext): Promise<ActionExecuteFailure | null> {
    if (request.v !== 2 || request.actionId !== 'discussion.reply' || request.status !== 'failed'
      || request.decision?.kind !== 'approve' || request.execution?.ok !== false) return null;
    const origin = request.executionOriginV1;
    const returned = origin.discussionReplyReturn;
    // Non-Session Workflow results retain their invocation-owned settlement.
    if (!returned || 'kind' in returned) return null;
    const failure = classifySessionMessageReplyPublicationFailureV1(request.execution.errorCode, 'action_admission');
    if (!failure) return null;
    if (resolveHostStampedAuthority(context) !== 'present_user') {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    const sessionId = origin.sessionId ?? (origin.caller.kind === 'session' ? origin.caller.sessionId : undefined);
    const reply = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.reply'].safeParse(request.actionArgs);
    if (!sessionId || !reply.success || reply.data.replyTarget.kind !== 'message') {
      return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
    }
    if (!deps.sessionMessageReply) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.message.reply' };
    const response = await deps.sessionMessageReply({ context, sessionId, requestLocalId: returned.requestLocalId,
      serverId: origin.serverIdentityId ?? origin.serverId, ...(context.signal ? { signal: context.signal } : {}),
      reviewDecision: { kind: 'discussion_publication', discussionId: reply.data.discussionId,
        messageId: reply.data.replyTarget.messageId, ...(returned.acceptedTurnId ? { acceptedTurnId: returned.acceptedTurnId } : {}),
        approvalArtifactId: artifactId, publication: { kind: 'failed', failure } } });
    const transportFailure = readActionFailureEnvelope(response);
    if (transportFailure) return transportFailure;
    const settled = SessionMessageReplyMutationResultV1Schema.safeParse(response);
    if (!settled.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    if (!settled.data.ok) {
      const errorCode = settled.data.error === 'unavailable' ? 'approval_context_unavailable' : 'approval_stale';
      return { ok: false, errorCode, error: errorCode };
    }
    return null;
  }

  async function executeApprovedActionForRequest(args: Readonly<{
    artifactId: string;
    request: ApprovalRequest;
    artifactServerId: string | null;
    expectedOriginServerId?: string | null;
    expectedServerIdentityId?: string | null;
    ctx: ActionExecutorContext;
    observeExecution?: boolean;
    preExecutionFailure?: ActionExecuteFailure;
    replayOutcomeUnknown?: ActionExecuteFailure;
    /**
     * Operands retained only by the admitted invocation. Input custody reads
     * them instead of the redacted Artifact; explicit blocking result custody
     * requires the same live continuation before minting a show-once result.
     */
    liveOnlyActionArgs?: unknown;
    tokenExecution?: import('./blockingApprovalCoordinator.js').BlockingApprovalTokenExecution;
    /** Restrictive field currentness retained only by the original blocking UI invocation. */
    retainedPluginSettingsIntent?: () => boolean;
    /** Page values stay with the original blocking invocation, never durable approval replay. */
    retainedWidgetAreaContext?: ActionExecutorContext['widgetAreaContext'];
    retainedPublicProfileAction?: ActionExecutorContext['publicProfilePreparedAction'];
    retainedPublicProfilePreview?: ActionExecutorContext['publicProfilePreviewResult'];
    privateSecretContinuation?: PrivateSecretContinuationV1;
  }>): Promise<
    | Readonly<{ ok: true; request: ApprovalRequest; exec: ActionExecuteResult }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
  > {
    // Only the factory-bound live plugin invocation can retain this source
    // proof. Durable replay has no such lifetime and keeps the ordinary
    // daemon-origin checks. Never reconstruct an occurrence from the Artifact.
    const lifetime = deps.hostActionApprovalLifetime;
    const retainedPluginContext = lifetime && 'actionId' in lifetime && lifetime.surface === 'plugin'
      && args.request.v === 2 && args.request.approval?.flow === 'blocking'
      && lifetime.actionId === args.request.actionId && args.ctx.signal === lifetime.signal
      && args.ctx.surface === 'plugin' && args.ctx.actionCaller?.kind === 'plugin'
      && args.ctx.actionRequestId === args.request.executionOriginV1.requestId
      && args.ctx.serverId === args.request.executionOriginV1.serverId
      && args.ctx.runtimeAccountId === args.request.executionOriginV1.accountId
      && sameStrictJsonValue(projectApprovalExecutionOriginCaller(args.ctx.actionCaller), args.request.executionOriginV1.caller)
      && !args.ctx.externalActionExecutionAuthorization && !args.ctx.externalActionCredential
      ? { context: args.ctx, lifetime } : null;
    const isOriginCurrent = async (request: ApprovalRequest, reportStale: (reason: ApprovalStaleReason) => void) => {
      if (!retainedPluginContext) return await isApprovalExecutionOriginCurrentForRequest({ request, reportStale,
        expectedOriginServerId: args.expectedOriginServerId ?? args.artifactServerId,
        ...(args.expectedServerIdentityId !== undefined ? { expectedServerIdentityId: args.expectedServerIdentityId } : {}),
        ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
      });
      const { lifetime } = retainedPluginContext;
      const current = !lifetime.signal.aborted && await lifetime.isCurrent() && !lifetime.signal.aborted;
      if (!current) reportStale('origin_not_current');
      return current;
    };
    if (!deps.approvalsUpdate) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
    }

    const executionOutcomeUnknown = (): Readonly<{ ok: false; errorCode: string; error: string }> => ({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
      error: 'approval_execution_outcome_unknown',
    });
    const finishExecution = async (request: ApprovalRequest, exec: ActionExecuteResult) => {
      const settlementFailure = await settleFailedDiscussionApprovalPublication(args.artifactId, request, args.ctx);
      return settlementFailure ?? { ok: true as const, request, exec };
    };
    const persistExecutionFailure = async (
      request: ApprovalRequest,
      failure: ActionExecuteFailure,
      effectAttempted = false,
    ): Promise<
      | Readonly<{ ok: true; request: ApprovalRequest; exec: ActionExecuteResult }>
      | Readonly<{ ok: false; errorCode: string; error: string }>
    > => {
      const executedAtMs = Date.now();
      // Both definitive refusal and an unknown dispatched outcome end replay
      // custody and keep the Action's declared settled-input projection.
      const settledRequest = settleApprovalRequestReplayInputs(request);
      const execution = request.v === 2
          ? projectApprovalExecutionFailureV2({ request, failure, executedAtMs, effectAttempted })
          : {
              executedAtMs,
              ok: false,
              errorCode: failure.errorCode,
              error: failure.error,
            };
      const nextFailed: ApprovalRequest = settledRequest.v === 2
        ? { ...settledRequest, status: effectAttempted ? 'outcome_unknown' : 'failed',
            updatedAtMs: Math.max(executedAtMs, request.updatedAtMs), execution }
        : { ...settledRequest, status: 'failed', updatedAtMs: Math.max(executedAtMs, request.updatedAtMs), execution };
      const persistenceFailure = async (fallback: ActionExecuteFailure) => {
        const persisted = await readMatchingApprovalRequestReceipt({
          artifactId: args.artifactId, serverId: args.artifactServerId, request: nextFailed,
        });
        if (persisted) return finishExecution(persisted, failure);
        // A pre-effect check may fail after the execution claim. Losing that
        // settlement acknowledgement cannot advertise an unclaimed retry.
        return effectAttempted || request.v === 2 && request.status === 'executing' || fallback.errorCode === 'invalid_transition'
          ? executionOutcomeUnknown() : fallback;
      };
      let updated: unknown;
      try {
        updated = await deps.approvalsUpdate!({
          artifactId: args.artifactId,
          request: nextFailed,
          serverId: args.artifactServerId,
          expectedStatus: request.status,
        });
      } catch {
        return await persistenceFailure(approvalContextUnavailable());
      }
      const updateFailure = readActionFailureEnvelope(updated);
      return updateFailure ? await persistenceFailure(updateFailure) : finishExecution(nextFailed, failure);
    };

    let latestRaw: unknown;
    try {
      latestRaw = deps.approvalsGet
        ? await deps.approvalsGet({ artifactId: args.artifactId, serverId: args.artifactServerId })
        : null;
    } catch {
      // An unreadable receipt cannot rule out another executor's claim.
      // The normal CAS writer either records that uncertainty or reports its
      // own persistence failure; it never publishes a false no-effect fact.
      return await persistExecutionFailure(args.request, executionOutcomeUnknown(), true);
    }
    const latestParsed = StoredApprovalRequestSchema.safeParse(latestRaw);
    const latestRequest = latestParsed.success ? latestParsed.data : null;
    if (latestRequest) {
      const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(latestRequest);
      if (recordedExecutionResult) {
        return finishExecution(latestRequest, recordedExecutionResult);
      }
      if (latestRequest.v === 2 && latestRequest.status === 'executing') {
        if (args.replayOutcomeUnknown) return await persistExecutionFailure(latestRequest, args.replayOutcomeUnknown, true);
        return executionOutcomeUnknown();
      }
    }
    if (args.preExecutionFailure) {
      return await persistExecutionFailure(args.request, args.preExecutionFailure);
    }
    if (args.replayOutcomeUnknown) {
      return await persistExecutionFailure(args.request, args.replayOutcomeUnknown, true);
    }
    if (!isApprovalRequestActionReplayAdmitted(args.request, args.ctx)) {
      return await persistExecutionFailure(args.request, {
        ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      });
    }
    const unavailableOrigin = readUnavailableApprovalReplayOrigin(args.request);
    if (unavailableOrigin && !retainedPluginContext) {
      return await persistExecutionFailure(args.request, unavailableOrigin);
    }
    if ((args.request.actionId === 'computer.secret.fill' || args.request.actionId === 'browser.automation.secret.fill')
      && !args.privateSecretContinuation) {
      return await persistExecutionFailure(args.request, {
        ok: false, errorCode: 'confidential_choice_required', error: 'confidential_choice_required',
      });
    }
    // Private inputs and explicitly retained show-once results require the
    // original live invocation. Durable approval state cannot restore either
    // the private input or the lost result recipient.
    const custodyReplayActionId = ActionIdSchema.safeParse(args.request.actionId);
    const serviceStartReview = args.request.actionId === 'localServices.launcher.start'
      && readRecord(args.request.actionArgs).declaration !== undefined
      ? LocalServiceStartApprovalReviewV1Schema.safeParse(readRecord(args.request.preview).serviceStartReview) : null;
    if (serviceStartReview && (!serviceStartReview.success
      || !sameStrictJsonValue(serviceStartReview.data.request, args.request.actionArgs))) {
      return await persistExecutionFailure(args.request, {
        ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable',
      });
    }
    const custodySpec = custodyReplayActionId.success ? getActionSpec(custodyReplayActionId.data) : null;
    if (
      (custodySpec?.approvalInputCustody === 'live_only'
        || custodySpec?.approvalResultCustody === 'live_only' && isBlockingApprovalRequest(args.request))
      && (args.liveOnlyActionArgs === undefined
        || custodySpec?.approvalInputCustody === 'live_only' && args.ctx.signal?.aborted)
    ) {
      return await persistExecutionFailure(args.request, {
        ok: false,
        errorCode: 'approval_stale',
        error: 'approval_stale',
        details: { reason: 'live_invocation_unavailable' },
      });
    }
    // `approvalsUpdate` has already claimed the open→approved transition at
    // the Artifact owner. A stale/non-transactional read may still project the
    // prior open row, so replay uses that successfully claimed approved value;
    // terminal rows discovered above remain authoritative and idempotent.
    let request = args.request;
    if (request.v === 2) {
      const admission = await admitApprovalRequesterDecisionV1({ request, context: args.ctx });
      if (!admission.ok) return await persistExecutionFailure(request, admission);
      let staleReason: ApprovalStaleReason = 'origin_not_current';
      let originIsCurrentBeforeClaim: boolean;
      try {
        originIsCurrentBeforeClaim = await isOriginCurrent(request, reason => { staleReason = reason; });
      } catch (error) {
        const failure = normalizeActionExecutorThrownError(error);
        return await persistExecutionFailure(request, { ok: false, ...failure, error: redactBugReportSensitiveText(failure.error) });
      }
      if (!originIsCurrentBeforeClaim) {
        return await persistExecutionFailure(request, {
          ok: false,
          errorCode: 'approval_stale',
          error: 'approval_stale',
          details: { reason: staleReason },
        });
      }
      const executingRequest: ApprovalRequest = {
        ...request,
        status: 'executing',
        updatedAtMs: Math.max(Date.now(), request.updatedAtMs),
      };
      let claimed: unknown;
      let claimThrew = false;
      try {
        claimed = await deps.approvalsUpdate({
          artifactId: args.artifactId,
          request: executingRequest,
          serverId: args.artifactServerId,
        });
      } catch (error) {
        claimThrew = true;
        claimed = { ok: false, ...normalizeActionExecutorThrownError(error) };
      }
      const claimFailure = readActionFailureEnvelope(claimed);
      if (claimFailure) {
        const writeNotCommitted = claimed !== null && typeof claimed === 'object'
          && 'writeCommitted' in claimed && claimed.writeCommitted === false;
        let persistedRaw: unknown;
        try {
          persistedRaw = deps.approvalsGet
            ? await deps.approvalsGet({ artifactId: args.artifactId, serverId: args.artifactServerId })
            : null;
        } catch {
          // An unreadable claim receipt cannot prove that execution custody
          // stayed unclaimed, including after a lost write acknowledgement.
          return executionOutcomeUnknown();
        }
        const persistedParsed = StoredApprovalRequestSchema.safeParse(persistedRaw);
        const persisted = persistedParsed.success ? persistedParsed.data : null;
        if (persisted) {
          const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(persisted);
          if (recordedExecutionResult) {
            return { ok: true, request: persisted, exec: recordedExecutionResult };
          }
          if (persisted.v === 2 && persisted.status === 'executing') {
            if (!writeNotCommitted && sameStrictJsonValue(persisted, JSON.parse(JSON.stringify(executingRequest)))) {
              return await persistExecutionFailure(persisted, { ...executionOutcomeUnknown(),
                details: { reasonCode: claimFailure.errorCode } }, true);
            }
            return executionOutcomeUnknown();
          }
          if (persisted.status === 'approved' && persisted.decision?.kind === 'approve' && !persisted.execution
            && sameStrictJsonValue(persisted, JSON.parse(JSON.stringify(request)))) {
            // A returned HTTP failure and a thrown/lost acknowledgement have
            // the same pre-effect recovery only when the exact approved input
            // is still unclaimed. A different receipt cannot invite replay.
            return await persistExecutionFailure(persisted, claimThrew ? approvalContextUnavailable() : claimFailure);
          }
        }
        return claimThrew ? executionOutcomeUnknown() : claimFailure;
      }
      request = executingRequest;
    }
    const replayActionId = ActionIdSchema.safeParse(request.actionId);
    const actionId = replayActionId.success ? replayActionId.data : null;

    const origin = request.v === 2
      ? ApprovalExecutionOriginV1Schema.safeParse(request.executionOriginV1)
      : null;
    let staleReason: ApprovalStaleReason = 'origin_not_current';
    let originIsCurrent: boolean;
    try {
      originIsCurrent = await isOriginCurrent(request, reason => { staleReason = reason; });
    } catch (error) {
      // The claim is durable, but no Action has been entered yet. An unavailable
      // Home recheck must settle that claim rather than escape to the outer
      // request catch and strand it as executing without an effect receipt.
      const failure = normalizeActionExecutorThrownError(error);
      return await persistExecutionFailure(request, {
        ok: false, ...failure, error: redactBugReportSensitiveText(failure.error),
      });
    }
    // Origin verification above uses the original signed arguments, never the
    // person's choice. Only then admit the choice through the Action's owner.
    const admittedReplay = resolveApprovalRequestExecutionInput(request);
    if (!admittedReplay.ok) return await persistExecutionFailure(request, admittedReplay);
    const replayInput: unknown = actionId !== null
      && getActionSpec(actionId).approvalInputCustody === 'live_only'
      ? args.liveOnlyActionArgs
      : admittedReplay.input;
    const requestSurface = origin?.success ? origin.data.surface : null;
    const replayCaller = origin?.success ? origin.data.caller : { kind: 'host' as const };
    // Only this factory's retained host invocation can resume its in-process
    // operation. Durable replay and the deciding caller carry no such ports.
    const retainedLogsLifetime = resolveMachineServiceLogsApprovalLifetime(actionId, replayInput, args.ctx);
    const retainedHostLifetime = deps.hostActionApprovalLifetime ?? retainedLogsLifetime;
    const retainsHostInvocation = Boolean(retainedHostLifetime
      && 'actionId' in retainedHostLifetime && retainedHostLifetime.actionId === actionId
      && args.ctx.signal === retainedHostLifetime.signal && !retainedHostLifetime.signal.aborted
      && requestSurface === (retainedHostLifetime.surface ?? 'cli') && request.approval?.flow === 'blocking');
    const retainsHostOperation = Boolean(retainedHostLifetime
      && 'operationId' in retainedHostLifetime
      && args.ctx.signal === retainedHostLifetime.signal
      && args.ctx.operationAcceptance?.operationId === retainedHostLifetime.operationId
      && args.ctx.actionCaller?.kind === 'host'
      && origin?.success
      && origin.data.caller.kind === 'host'
      && origin.data.authority === 'account_automation'
      && origin.data.requestId === args.ctx.actionRequestId
      && request.v === 2
      && request.approval?.flow === 'blocking');
    // UI/CLI normally return durable deferred proposals. A blocking proposal
    // instead retains a private invocation, field or operation. Losing that
    // lifetime must not turn its Artifact into a detached effect executor.
    const requiresRetainedHostInvocation = (requestSurface === 'ui' || requestSurface === 'cli')
      && request.approval?.flow === 'blocking'
      && custodySpec?.approvalInputCustody !== 'live_only'
      && custodySpec?.approvalResultCustody !== 'live_only';
    const retainsUiFieldIntent = actionId !== null
      && getActionSpec(actionId).approvalPolicy?.retainUiFieldIntent === true
      && requestSurface === 'ui' && args.retainedPluginSettingsIntent?.() === true;
    if (requiresRetainedHostInvocation && !retainsHostInvocation && !retainsHostOperation && !retainsUiFieldIntent) {
      return await persistExecutionFailure(request, { ok: false, errorCode: 'approval_stale', error: 'approval_stale',
        details: { reason: 'live_invocation_unavailable' } });
    }
    const persistedDirectoryApproval = request.actionId === 'session.spawn_new'
      ? SessionCreationDirectoryApprovalV1Schema.safeParse(
        request.sessionCreationDirectoryApproval,
      )
      : null;
    const persistedHandoffTargetApproval = (request.actionId === 'session.handoff'
      || request.actionId === 'workspace.sync.relationship.create')
      ? HandoffTargetReplacementApprovalV1Schema.safeParse(
        request.handoffTargetReplacementApproval,
      )
      : null;
    // Local profile ids belong to a device, not the Home. Account replay can use
    // the deciding device's profile after verifying the unchanged Home origin;
    // exact-daemon requests retain their original routing custody.
    const replayServerId = origin?.success && originIsCurrent
      && !requiresExactDaemonApprovalReplay(request)
      && origin.data.serverIdentityId
      && args.ctx.serverIdentityId === origin.data.serverIdentityId
      && normalizeId(args.ctx.serverId)
      ? args.ctx.serverId
      : origin?.success ? origin.data.serverId : undefined;
    // App-owned Account/client replay is a new human invocation of the validated
    // proposal, not an upgrade of its Session/PAT/terminal carrier. Custody is
    // decided by the approval owner; original provenance stays on the Artifact.
    const replayPlacement = actionId !== null
      ? resolveActionExecutionPlacementForInput(getActionSpec(actionId), replayInput) : null;
    const sessionDiscussionPublication = isSessionDiscussionApprovalPublicationV1(request);
    const appOwnedReplay = actionId !== null && origin?.success && originIsCurrent
      && !requiresExactDaemonApprovalReplay(request)
      && (replayPlacement === 'account' || replayPlacement === 'client')
      // A decision may come from a surface that cannot invoke the Action
      // itself. In that case retain the validated originating context.
      && isActionSpecSurfacedOn(getActionSpec(actionId), args.ctx.surface === 'cli' ? 'cli' : 'ui')
      && isPresentUserHostInvocation(args.ctx);
    // A Machine target authored with the creator's device-local profile follows
    // this already-verified Account replay Home. Never rewrite the stored/signed
    // proposal, a different target, or exact-daemon/external replay custody.
    const executionInput = appOwnedReplay && actionId?.startsWith('machines.')
      && origin?.success && replayServerId
      && readRecord(replayInput).serverId === origin.data.serverId
      ? { ...readRecord(replayInput), serverId: replayServerId }
      : replayInput;
    const reviewedSessionTargets = origin?.success ? origin.data.sessionTargetsV1 : undefined;
    // Reuse the verified Home-profile mapping above without changing the
    // reviewed Session ids or moving targets belonging to a different Home.
    const replaySessionTargets = reviewedSessionTargets && appOwnedReplay && origin?.success
      && replayServerId && replayServerId !== origin.data.serverId
      ? { ...reviewedSessionTargets, targets: reviewedSessionTargets.targets.map(target => (
          target.serverId === origin.data.serverId ? { ...target, serverId: replayServerId } : target
        )), ...(reviewedSessionTargets.operands ? { operands: reviewedSessionTargets.operands.map(operand => ({ ...operand,
          target: operand.target.serverId === origin.data.serverId ? { ...operand.target, serverId: replayServerId } : operand.target,
        })) } : {}) }
      : reviewedSessionTargets;
    let executionContext: ActionExecutorContext = {
      ...(retainsHostInvocation && retainedLogsLifetime && origin?.success && originIsCurrent
        && origin.data.externalActionExecutionAuthorization?.token === args.ctx.externalActionExecutionAuthorization?.token
        && sameStrictJsonValue(origin.data.externalActionExecutionAuthorization?.binding, args.ctx.externalActionExecutionAuthorization?.binding)
        ? { machineServiceLogsResource: args.ctx.machineServiceLogsResource } : {}),
      ...(serviceStartReview?.success ? { nativeServiceStartApproval: serviceStartReview.data } : {}),
      ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
      ...(retainsHostOperation ? {
        operationAcceptance: args.ctx.operationAcceptance,
        ...(args.ctx.operationProgress ? { operationProgress: args.ctx.operationProgress } : {}),
        ...(args.ctx.operationOwnerUpdate ? { operationOwnerUpdate: args.ctx.operationOwnerUpdate } : {}),
        ...(args.ctx.operationCancellation ? { operationCancellation: args.ctx.operationCancellation } : {}),
      } : {}),
      ...(appOwnedReplay && origin?.success ? {
        authority: 'present_user' as const, surface: args.ctx.surface === 'cli' ? 'cli' as const : 'ui' as const,
        serverId: replayServerId,
        ...(origin.data.serverIdentityId ? { serverIdentityId: origin.data.serverIdentityId } : {}),
        ...(args.ctx.runtimeAccountId ? { runtimeAccountId: args.ctx.runtimeAccountId } : {}),
        actionRequestId: origin.data.requestId,
        ...(origin.data.caller.kind === 'session'
          ? { defaultSessionId: origin.data.caller.sessionId }
          : origin.data.sessionId ? { defaultSessionId: origin.data.sessionId } : {}),
      } : origin?.success ? {
        authority: origin.data.authority,
        surface: origin.data.surface,
        serverId: replayServerId,
        ...(origin.data.serverIdentityId ? { serverIdentityId: origin.data.serverIdentityId } : {}),
        actionRequestId: origin.data.requestId,
        ...(origin.data.accountId ? { runtimeAccountId: origin.data.accountId } : {}),
        ...(origin.data.externalActionExecutionAuthorization
          ? { externalActionExecutionAuthorization: origin.data.externalActionExecutionAuthorization }
          : {}),
        ...(requiresExactDaemonApprovalReplay(request) && origin.data.originalActionEnvelope
          ? { originalActionEnvelope: origin.data.originalActionEnvelope } : {}),
        ...(origin.data.principalId && origin.data.credentialId && origin.data.accountId
          && origin.data.externalActionExecutionAuthorization
          && 'grant' in origin.data.externalActionExecutionAuthorization.binding
          ? { externalActionCredential: {
              accountId: origin.data.accountId,
              principalId: origin.data.principalId,
              credentialId: origin.data.credentialId,
              grant: origin.data.externalActionExecutionAuthorization.binding.grant,
            } }
          : {}),
        ...(origin.data.target
          ? { externalActionTarget: origin.data.target }
          : requiresExactDaemonApprovalReplay(request) && origin.data.machineId
            ? { externalActionTarget: { kind: 'machine' as const, machineId: origin.data.machineId } }
            : {}),
        ...(origin.data.caller.kind === 'session'
          ? { defaultSessionId: origin.data.caller.sessionId }
          : origin.data.sessionId ? { defaultSessionId: origin.data.sessionId } : {}),
        ...(origin.data.sessionListAccess !== undefined ? { sessionListAccess: origin.data.sessionListAccess } : {}),
        ...(origin.data.machineId ? {
          defaultSessionMachineId: origin.data.machineId,
          executionRunTargetMachineId: origin.data.machineId,
        } : {}),
        ...(origin.data.runId ? { runtimeRunId: origin.data.runId } : {}),
        ...(origin.data.runOccurrenceId ? { runtimeRunOccurrenceId: origin.data.runOccurrenceId } : {}),
        ...(origin.data.callerPermissionMode !== undefined ? { callerPermissionMode: origin.data.callerPermissionMode } : {}),
        ...(origin.data.sessionAgentSpawnPolicyV1 !== undefined ? { sessionAgentSpawnPolicyV1: origin.data.sessionAgentSpawnPolicyV1 } : {}),
        ...(origin.data.causalPermissionAuthority !== undefined ? { causalPermissionAuthority: origin.data.causalPermissionAuthority } : {}),
        ...(origin.data.sessionInputSource !== undefined ? { sessionInputSource: origin.data.sessionInputSource } : {}),
        ...(origin.data.discussionReplyReturn ? { discussionReplyReturn: origin.data.discussionReplyReturn } : {}),
        ...(origin.data.actionRequestAttributionV1 ? { actionRequestAttributionV1: origin.data.actionRequestAttributionV1 } : {}),
        ...(origin.data.externalActionExecutionAuthorization
          && 'authentication' in origin.data.externalActionExecutionAuthorization.binding
          && origin.data.externalActionExecutionAuthorization.binding.sessionActionOrigin?.workspaceWrites
          ? { workspaceWrites: origin.data.externalActionExecutionAuthorization.binding.sessionActionOrigin.workspaceWrites }
          : {}),
      } : {}),
      ...(replaySessionTargets ? { sessionTargetsV1: replaySessionTargets } : {}),
      actionCaller: retainedPluginContext?.context.actionCaller ?? (appOwnedReplay ? { kind: 'host' } : replayCaller),
      ...(args.retainedPluginSettingsIntent
        ? { isPluginSettingsIntentCurrent: args.retainedPluginSettingsIntent } : {}),
      ...(args.retainedWidgetAreaContext ? { widgetAreaContext: args.retainedWidgetAreaContext } : {}),
      ...(args.retainedPublicProfileAction ? { publicProfilePreparedAction: args.retainedPublicProfileAction } : {}),
      ...(args.retainedPublicProfilePreview ? { publicProfilePreviewResult: args.retainedPublicProfilePreview } : {}),
      ...(actionId !== null && (actionId === 'plugins.install'
        || requiresPresentUserExecutionAuthorityForActionInputV1(getActionSpec(actionId), replayInput))
        && !(request.v === 2 && request.requesterConfirmation)
        && resolveHostStampedAuthority(args.ctx) === 'present_user'
        ? { authority: 'present_user' as const,
            ...(request.v === 2 && request.status === 'executing' && request.decision?.kind === 'approve'
              && origin?.success && originIsCurrent ? { presentUserApproval: {
                artifactId: args.artifactId, actionId, requestId: origin.data.requestId,
                inputDigest: computeActionInputApprovalDigestV1(actionId, executionInput),
                requestSurface: origin.data.surface,
              } } : {}),
          } : {}),
      placement: null,
      // Every exact parent preparation consumes the same witnessed approval
      // fact. This annotation grants no execution authority; the validated
      // current origin and deciding person's custody remain the proof owner.
      ...(actionId !== null && request.v === 2
        && !request.requesterConfirmation
        && request.status === 'executing' && request.decision?.kind === 'approve'
        && request.decision.authority === 'present_user' && origin?.success && originIsCurrent
        && resolveHostStampedAuthority(args.ctx) === 'present_user'
        && origin.data.accountId ? { presentUserApproval: {
          artifactId: args.artifactId, actionId, requestId: origin.data.requestId,
          inputDigest: computeActionInputApprovalDigestV1(actionId, executionInput),
          requestSurface: origin.data.surface,
          decidingAccountId: origin.data.accountId,
          decidedAtMs: request.decision.decidedAtMs,
        } } : {}),
      ...(request.v === 2 && request.requesterConfirmation && origin?.success
        && request.status === 'executing' && args.ctx.requesterApprovalDecision ? { presentUserApproval: {
          artifactId: args.artifactId, actionId: request.actionId, requestId: origin.data.requestId,
          inputDigest: request.requesterConfirmation.inputDigest,
          requestSurface: origin.data.surface,
          decidingAccountId: args.ctx.requesterApprovalDecision.actor.accountId,
          ...(request.decision ? { decidedAtMs: request.decision.decidedAtMs } : {}),
        } } : {}),
      bypassApprovals: true,
      ...(origin?.success && originIsCurrent && request.v === 2
        && request.status === 'executing' && request.decision?.kind === 'approve'
        ? { approvedActionReplay: { artifactId: args.artifactId, origin: {
            surface: origin.data.surface, caller: origin.data.caller,
            ...(origin.data.accountId ? { accountId: origin.data.accountId } : {}),
            ...(origin.data.sessionId ? { sessionId: origin.data.sessionId } : {}),
          }, ...(request.actionId === 'deployments.templates.instantiate'
            && readRecord(request.preview).deploymentReview !== undefined ? {
              deploymentReview: projectNativeJsonValueForTransport(readRecord(request.preview).deploymentReview),
            } : {}) } } : {}),
      ...(request.actionId === 'workspace.sync.conflict.resolve'
        ? { actionRequestId: args.artifactId }
        : {}),
      ...(persistedDirectoryApproval?.success
        ? { sessionCreationDirectoryApproval: persistedDirectoryApproval.data }
        : {}),
      ...(persistedHandoffTargetApproval?.success
        ? {
            handoffTargetReplacementApproval: persistedHandoffTargetApproval.data,
            handoffTargetReplacementApprovalReceiptId: args.artifactId,
          }
        : {}),
    };
    if (sessionDiscussionPublication && (actionId === 'discussion.post' || actionId === 'discussion.reply')
      && executionContext.presentUserApproval && origin?.success && originIsCurrent
      && isPresentUserHostInvocation(args.ctx)
      && args.ctx.runtimeAccountId === origin.data.accountId
      && origin.data.serverIdentityId && args.ctx.serverIdentityId === origin.data.serverIdentityId) {
      // The current reviewer owns the Account-qualified resource/key reads.
      // The retired Agent's signed HTTP carrier cannot perform fresh reads;
      // its immutable provenance stays on the Artifact and Session context.
      // Publication still requires the host to reopen that exact approved body.
      const { externalActionExecutionAuthorization: _originalHttpCarrier, ...reviewedContext } = executionContext;
      executionContext = reviewedContext;
    }
    // The verified origin binds its creator-local profile to this Home even
    // when that profile does not exist on the deciding device. Keep this
    // comparison evidence private to this replay; never rewrite stored refs,
    // retry identities, or the captured transport's routing context.
    const sameReplayHome: ActionHomeEquivalence | undefined = appOwnedReplay && origin?.success
      && origin.data.serverIdentityId && origin.data.serverIdentityId === args.ctx.serverIdentityId
      ? (left, right) => isSameHome(
          left === origin.data.serverId ? origin.data.serverIdentityId : left,
          right === origin.data.serverId ? origin.data.serverIdentityId : right,
          executionContext,
        ) : undefined;
    const executeConfidential = async (): Promise<ActionExecuteResult> => {
      const continuation = args.privateSecretContinuation;
      if (!continuation || !deps.confidentialSecretFill) {
        return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      }
      try {
        const settlement = await deps.confidentialSecretFill({
          actionId: continuation.actionId, request: continuation.request, choice: continuation.choice,
          submit: continuation.submit, accountEncryptionMode: continuation.accountEncryptionMode,
          context: { ...executionContext, authority: 'present_user',
            runtimeAccountId: args.ctx.runtimeAccountId },
          async isCurrent() {
            if (args.ctx.signal?.aborted) return false;
            if (!isActionEnabled(getActionSpec(continuation.actionId), { ...args.ctx, surface: executionContext.surface })) return false;
            const current = deps.approvalsGet
              ? await deps.approvalsGet({ artifactId: args.artifactId, serverId: args.artifactServerId }) : null;
            const parsed = StoredApprovalRequestSchema.safeParse(current);
            return parsed.success && parsed.data.v === 2 && parsed.data.status === 'executing'
              && parsed.data.decision?.kind === 'approve'
              && parsed.data.decision.authority === 'present_user'
              && parsed.data.actionId === continuation.actionId
              && JSON.stringify(parsed.data.actionArgs) === JSON.stringify(continuation.request)
              && parsed.data.executionOriginV1.requestId === continuation.requestId
              && await isApprovalExecutionOriginCurrentForRequest({ request: parsed.data,
                expectedOriginServerId: args.expectedOriginServerId ?? args.artifactServerId,
                ...(args.ctx.signal ? { signal: args.ctx.signal } : {}) })
              && await isDecidingHumanAdmissionCurrent(args.ctx);
          },
        });
        const parsed = SecretFillSettlementV1Schema.safeParse(settlement);
        return { ok: true, result: parsed.success ? parsed.data : { status: 'unknown', code: 'delivery_unknown' } };
      } catch {
        // An issued confidential effect is never replayed and no adapter prose crosses custody.
        return { ok: true, result: { status: 'unknown', code: 'delivery_unknown' } };
      }
    };
    let effectAttempted = false;
    const exec = await (async (): Promise<ActionExecuteResult> => {
      if (request.v === 2) {
        const admission = await admitApprovalRequesterDecisionV1({ request, context: args.ctx });
        if (!admission.ok) return admission;
      }
      if (!originIsCurrent) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale', details: { reason: staleReason } };
      }
      if (!actionId || actionId === 'session.board.item.upsert' && !readRecord(replayInput).reviewedVisual) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      if (args.privateSecretContinuation) { effectAttempted = true; return await executeConfidential(); }
      if (!requestSurface) return { ok: false, errorCode: 'approval_execution_surface_invalid', error: 'approval_execution_surface_invalid' };
      if (actionId === 'account.apiTokens.create' && args.tokenExecution) {
        // Retained human credentials select the native effect, while current
        // authority, surface and Action policy still belong to core admission.
        effectAttempted = true;
        return await executeCoreTerminal(actionId, executionInput, executionContext, true, undefined, undefined, true, args.tokenExecution,
          false, sameReplayHome);
      }
      if (actionId === 'account.apiTokens.create' && origin?.success
        && origin.data.externalActionExecutionAuthorization?.binding.sessionActionOrigin) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      const authorization = executionContext.externalActionExecutionAuthorization;
      // Strict Artifact decoding intentionally loses private ports. Only exact
      // daemon custody reacquires them from the unchanged, verified signed root;
      // app-owned Account replay continues with the approving app's authority.
      let prepared: Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']>>> | undefined;
      try {
        prepared = authorization && requiresExactDaemonApprovalReplay(request)
          && deps.prepareApprovalExecutionAuthorization
          ? await deps.prepareApprovalExecutionAuthorization({ authorization,
              ...(args.ctx.signal ? { signal: args.ctx.signal } : {}) })
          : undefined;
      } catch (error) {
        const failure = normalizeActionExecutorThrownError(error);
        return { ok: false, ...failure, error: redactBugReportSensitiveText(failure.error) };
      }
      try {
        if (prepared === null || prepared && (!authorization
          || prepared.authorization.token !== authorization.token
          || !sameStrictJsonValue(prepared.authorization.binding, authorization.binding))) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale', details: { reason: 'requester_account_unavailable' } };
        }
        if (prepared) executionContext = { ...executionContext, externalActionExecutionAuthorization: prepared.authorization };
        if (request.v === 2) {
          const admission = await admitApprovalRequesterDecisionV1({ request, context: args.ctx });
          if (!admission.ok) return admission;
        }
        effectAttempted = true;
        return await executeCoreTerminal(actionId, executionInput, executionContext, true, undefined, undefined, true, undefined,
          false, sameReplayHome);
      } finally {
        await prepared?.dispose?.();
      }
    })().catch((error): ActionExecuteFailure => {
      const failure = normalizeActionExecutorThrownError(error);
      return effectAttempted
        ? { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown',
            details: { reasonCode: failure.errorCode } }
        : { ok: false, ...failure, error: redactBugReportSensitiveText(failure.error) };
    });
    if (
      originIsCurrent
      && actionId !== null
      && args.observeExecution
      && deps.observeActionExecution
    ) {
      try {
        await deps.observeActionExecution({
          actionId,
          input: projectActionObservationInput(actionId, replayInput),
          context: projectActionObservationContext(actionId, executionContext),
          caller: executionContext.actionCaller ?? replayCaller,
          result: projectActionExecutionObservation(actionId, exec),
        });
      } catch {
        // Deferred approval execution is authoritative; after-hook observation is diagnostic only.
      }
    }
    const executedAtMs = Date.now();
    // Private Artifact custody carries ordinary typed results back to a caller
    // waiting on another host. Blocking flow alone does not make that result
    // live-only. Only declared live-only results use the safe projection here;
    // public reads and decisions independently apply the observation projection.
    const persistedExec = actionId !== null
      && getActionSpec(actionId).approvalResultCustody === 'live_only'
      ? projectActionExecutionObservation(actionId, exec)
      : exec;
    // Settled approval input custody, the input-side sibling of `persistedExec`
    // above. Deferred replay is the only reader of the raw arguments and it has
    // already run, so the terminal record keeps this Action's own observation
    // projection instead of retaining write-only secrets forever.
    const settledRequest = settleApprovalRequestReplayInputs(request);
    const executionReceipt = {
      updatedAtMs: Math.max(executedAtMs, request.updatedAtMs),
      execution: persistedExec.ok
        ? { executedAtMs, effectAttempted, ok: true, result: persistedExec.result }
        : request.v === 2
          ? projectApprovalExecutionFailureV2({
              request,
              failure: persistedExec,
              executedAtMs,
              effectAttempted,
            })
          : { executedAtMs, ok: false, errorCode: persistedExec.errorCode, error: persistedExec.error },
    };
    const nextExecuted: ApprovalRequest = settledRequest.v === 2
      ? { ...settledRequest, ...executionReceipt,
          status: exec.ok ? 'executed' : effectAttempted && isActionOutcomeUnknownErrorCodeV1(exec.errorCode) ? 'outcome_unknown' : 'failed' }
      : { ...settledRequest, ...executionReceipt, status: exec.ok ? 'executed' : 'failed' };
    if (nextExecuted.v === 2 && effectAttempted && persistedExec.operationCredentialUses?.length) {
      nextExecuted.execution = { ...nextExecuted.execution!, operationCredentialUses: [...persistedExec.operationCredentialUses] };
    }

    // The side effect ran after the durable execution claim. If its terminal
    // projection cannot be committed, the Artifact intentionally remains
    // executing and no caller may infer failure or replay blindly. A thrown
    // transport error is the same post-effect uncertainty as a returned
    // failure envelope: it must never be reclassified by the callers' generic
    // catch as an unreached `server_unreachable` request.
    // Only a declared, validated successful self-retirement keeps its known
    // status-only live receipt when its own authority can no longer write
    // history. The durable execution claim remains non-replayable; unrelated
    // scope loss and ordinary terminal write failures remain outcome-unknown.
    const retirementReceipt = actionId === null ? null
      : projectKnownAccountAuthorityRetirementReceipt(getActionSpec(actionId), exec);
    const terminalPersistenceFailure = async () => {
      if (retirementReceipt) return { ok: true as const, request: nextExecuted, exec: retirementReceipt };
      // A missing acknowledgement does not prove the terminal write failed.
      // Read the exact receipt once; never replay the effect or infer its
      // outcome from the resource's later state. The private live result stays
      // with this invocation, even when durable history contains its projection.
      const persisted = await readMatchingApprovalRequestReceipt({
        artifactId: args.artifactId, serverId: args.artifactServerId, request: nextExecuted,
      });
      if (persisted) return finishExecution(persisted, exec);
      return executionOutcomeUnknown();
    };
    let updated: unknown;
    try {
      updated = await deps.approvalsUpdate({ artifactId: args.artifactId, request: nextExecuted, serverId: args.artifactServerId });
    } catch {
      return terminalPersistenceFailure();
    }
    const updateFailure = readActionFailureEnvelope(updated);
    if (updateFailure) return terminalPersistenceFailure();
    return finishExecution(nextExecuted, exec);
  }

  /**
   * Exact-daemon replay capability. Unlike `approval.request.decide`, this
   * entrypoint owns no decision authority: it can only consume an Artifact
   * whose canonical owner has already committed an approve decision.
   */
  const resolveBlockingDecisionIfClaimed = createBlockingApprovalDecisionResolver(deps);
  const replayApprovedApprovalRequest = createApprovalReplay({
    approvalsGet: deps.approvalsGet, approvalsUpdate: deps.approvalsUpdate,
    requireDiscussionDraftReviewAuthority, settleFailedDiscussionApprovalPublication,
    resolveBlockingDecisionIfClaimed, executeApprovedActionForRequest,
  });

  const createOneShotInvocation = (runOnce: () => Promise<ActionExecuteResult>): ActionPreparedInvocation => {
    let resultPromise: Promise<ActionExecuteResult> | null = null;
    return Object.freeze({
      run: () => {
        resultPromise ??= Promise.resolve().then(runOnce);
        return resultPromise;
      },
    });
  };

  const ready = (
    admission: PreparedCoreAdmission,
    runOnce?: () => Promise<ActionExecuteResult>,
  ): PrivatePrepareResult => ({
    kind: 'ready',
    admission,
    invocation: createOneShotInvocation(async () => {
      try {
        admission.context.assertDecisionAuthorityCurrent?.();
      } catch (error) {
        return settleActionOutput(admission.actionId, { ok: false, ...normalizeActionExecutorThrownError(error) });
      }
      return runOnce
        ? settleActionOutput(admission.actionId, await runOnce())
        : await executeCoreTerminal(
          admission.actionId,
          admission.input,
          admission.context,
          true,
          admission.legacyMetadataLabel,
          admission,
        );
    }),
  });

  /**
   * The one terminal Action boundary: public failures lose bridge-private
   * metadata and successful built-in Actions project through their declared
   * output schema. Approval admission is deliberately not an action output.
   */
  function settleActionOutput(actionId: ActionId, result: ActionExecuteResult): ActionExecuteResult {
    const withCredentialUses = (settled: ActionExecuteResult): ActionExecuteResult => result.operationCredentialUses?.length
      ? { ...settled, operationCredentialUses: result.operationCredentialUses } : settled;
    if (!result.ok) return withCredentialUses(projectActionExecuteFailure(result));
    if (isDeferredApprovalResult(result)) return result;
    const outputSchema = getActionSpec(actionId).outputSchema;
    if (!outputSchema) return result;
    try {
      const output = outputSchema.safeParse(result.result);
      return withCredentialUses(output.success
        ? { ok: true, result: output.data }
        : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    } catch {
      return withCredentialUses({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    }
  }

  function settlePrepareResult(
    actionId: ActionId,
    result: ActionExecuteResult | PrivatePrepareResult,
  ): PrivatePrepareResult {
    return 'kind' in result ? result : { kind: 'settled', result: settleActionOutput(actionId,
      result.ok ? result : classifyExecutionRunStartPreDispatchFailure(actionId, result)) };
  }

  const executeCore = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
    inputAlreadyBound = false,
    legacyMetadataLabel?: string,
    options?: CoreOptions,
  ): Promise<ActionExecuteResult | PrivatePrepareResult> => {
    // Child positions belong to this parent invocation, including its local
    // and routed branches. Count per Action so a completed grant/read on retry
    // cannot shift another Action's slots. Nested parents extend the same path.
    const childPositions = new Map<ActionId, number>();
    const executeHostChild = (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => {
      const position = childPositions.get(childId) ?? 0;
      childPositions.set(childId, position + 1);
      const parentRequestId = normalizeId(childContext.actionRequestId);
      return executeInvocation(childId, childInput, parentRequestId ? { ...childContext,
        actionRequestId: deriveWorkflowReplacementId(['action.child', parentRequestId, actionId, childId, position]),
      } : childContext, true);
    };
    const stopThenArchiveSession = async (sessionId: string, childContext: ActionExecutorContext): Promise<ActionExecuteResult> => {
      const stopped = await executeHostChild('session.stop', { sessionId }, childContext);
      if (!stopped.ok || isDeferredApprovalResult(stopped)) return stopped;
      const stop = SessionStopResultSchema.safeParse(stopped.result);
      if (!stop.success || stop.data.sessionId !== sessionId || !isSessionStopConfirmed(stop.data)) {
        const native = readRecord(stopped.result);
        const code = readNonEmptyString(native.code) ?? 'session_stop_unconfirmed';
        return { ok: false, errorCode: code, error: readNonEmptyString(native.message) ?? code };
      }
      return await executeHostChild('session.archive', { sessionId, alsoArchiveReports: false }, childContext);
    };
    const existingAdmission = options?.prepared;
    const normalizedContext = normalizeActionCallerContext(existingAdmission?.context ?? context ?? {});
    if (!normalizedContext) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    let ctx: ActionExecutorContext = normalizedContext;

    const attestationFailure = sessionAttestedContextCallerFailure(actionId, input, ctx);
    if (attestationFailure) return attestationFailure;

    const originationPreferenceFailure = resolveActionOriginationPreferenceFailureV1(actionId, ctx);
    if (originationPreferenceFailure) return originationPreferenceFailure;

    const listAccessFailure = resolveActionSessionListAccessFailure(actionId, ctx);
    if (listAccessFailure) return listAccessFailure;

    const spec = getActionSpec(actionId);
    if (!isAccountSettingActionSurfaceAllowedV1(actionId, input, ctx.surface)) {
      return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    }
    {
      const authorityFailure = requiredAuthorityFailure(spec, ctx, input);
      if (authorityFailure) {
        return actionId === 'execution.run.start'
          ? classifyExecutionRunStartFailure(authorityFailure, 'noRunCreated')
          : authorityFailure;
      }
    }
    const hostInternal = options?.hostInternal === true;
    const actionGrantFailure = credentialScopeFailure(actionId, ctx, actionId === 'action.invoke' || hostInternal ? input : undefined,
      true, undefined, hostInternal);
    if (actionGrantFailure) return actionGrantFailure;
    const liveEnvironmentScope = spec.approvalScope === 'environment';
    const availability = existingAdmission && !liveEnvironmentScope || hostInternal ? null : resolveAvailabilityForContext(spec, ctx);
    const isApprovalAction = isApprovalActionId(actionId);
    // A host-selected child is a semantic effect of its admitted parent, not
    // another external ingress. Keep the original context for requester and
    // approval provenance, but do not apply its external exposure to the child.
    const enabled = existingAdmission && !liveEnvironmentScope ? true : hostInternal
      ? isHostInternalActionEnabled(spec, ctx)
      : availability ? availability.available : isActionEnabled(spec, ctx);
    if (!existingAdmission && !enabled) {
      const unavailable = actionDisabled(availability);
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(unavailable, 'noRunCreated')
        : unavailable;
    }
    const bound = existingAdmission
      ? { ok: true as const, input: existingAdmission.input }
      : inputAlreadyBound
      ? { ok: true as const, input }
      : await bindCallerInput(spec, input, ctx, hostInternal);
    if (!bound.ok) {
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(bound, 'noRunCreated')
        : bound;
    }
    // Resolve declared operands before exact domain schemas parse them. The
    // snapshot is also the sole selection used by preparation and replay.
    let admittedInput: unknown = bound.input ?? {};
    const sessionTarget = readActionSessionTargetDeclaration(actionId, admittedInput, ctx);
    if (sessionTarget && !options?.sessionTargetLeaf) {
      if (ctx.sessionTargetsV1) {
        const snapshot = ActionResolvedSessionTargetsV1Schema.safeParse(ctx.sessionTargetsV1);
        if (!snapshot.success || snapshot.data.actionId !== actionId || snapshot.data.field !== sessionTarget.field) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        if (!sessionTarget.field.includes('*') && (snapshot.data.operands
          || sessionTarget.cardinality === 'one' && snapshot.data.targets.length !== 1)) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
      } else {
        if (options?.approvalReplay && (sessionTarget.field.includes('*')
          ? readActionSessionTargetOperands(readRecord(admittedInput), sessionTarget.field).length > 0
          : readActionSessionTargetField(readRecord(admittedInput), sessionTarget.field) !== undefined)) {
          if (sessionTarget.field.includes('*')) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
          try {
            if (typeof normalizeSessionTargetV1(readActionSessionTargetField(readRecord(admittedInput), sessionTarget.field)) !== 'string') {
              return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
            }
          } catch {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
        }
        const targets = await resolveActionSessionTargets(deps, { actionId, declaration: sessionTarget,
          input: readRecord(admittedInput), context: ctx });
        if (targets && 'ok' in targets) return targets;
        if (targets) ctx = { ...ctx, sessionTargetsV1: targets };
      }
      const snapshot = ctx.sessionTargetsV1;
      if (ctx.expectedSessionAddress && (!snapshot || snapshot.targets.length !== 1
        || snapshot.targets[0].sessionId !== ctx.expectedSessionAddress.sessionId
        || !isSameHome(snapshot.targets[0].serverId, ctx.expectedSessionAddress.serverId, ctx))) {
        return { ok: false, errorCode: 'session_address_mismatch', error: 'session_address_mismatch' };
      }
      if (sessionTarget.field.includes('*') && snapshot) {
        const bound = bindActionSessionTargetOperands(readRecord(admittedInput), snapshot, options?.approvalReplay === true);
        if (!bound) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        admittedInput = bound;
      } else if (snapshot && sessionTarget.cardinality === 'one') {
        if (options?.approvalReplay && readActionSessionTargetField(readRecord(admittedInput), snapshot.field) !== snapshot.targets[0].sessionId) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        admittedInput = replaceActionSessionTargetField(readRecord(admittedInput), snapshot.field, snapshot.targets[0].sessionId);
      }
    }
    const parsed = existingAdmission
      ? { success: true as const, data: existingAdmission.input }
      : spec.inputSchema.safeParse(admittedInput);
    if (!parsed.success) {
      const invalid = actionInputValidationFailure(parsed.error);
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(invalid, 'noRunCreated')
        : invalid;
    }
    if (spec.clientActionDomainInputSchema && typeof readRecord(parsed.data).clientId === 'string'
      && resolveActionExecutionPlacementForInput(spec, parsed.data) !== 'client') {
      return { ok: false, errorCode: 'client_routing_not_applicable', error: 'This input selects an owner other than a UI client' };
    }
    if (ctx.interactivePresentation === 'unavailable'
        && (actionId === 'approval.request.create' || resolveActionExecutionPlacementForInput(spec, parsed.data) === 'client')) {
      return { ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required' };
    }
    if (isScmActionId(actionId) && sessionTarget?.field === 'sessionId') {
      const explicitSessionId = readNonEmptyString(readRecord(parsed.data).sessionId);
      if (explicitSessionId) {
        const serverId = ctx.sessionTargetsV1?.targets[0]?.serverId ?? ctx.serverId;
        const sameSession = ctx.defaultSessionId === explicitSessionId && ctx.serverId === serverId;
        // The resolved operational operand selects the Session placement. An
        // inherited Machine/Run target must not divert that exact Session's SCM.
        ctx = { ...ctx, serverId, defaultSessionId: explicitSessionId,
          defaultSessionMachineId: sameSession ? ctx.defaultSessionMachineId : undefined,
          externalActionTarget: undefined, executionRunTargetMachineId: undefined };
      }
    }
    const discussionParticipantLaunch = existingAdmission?.discussionParticipantLaunch
      ?? (actionId === 'session.spawn_new' && readRecord(parsed.data).discussionParticipant !== undefined
        ? projectDiscussionModelParticipantLaunchV1(admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse(parsed.data))) : undefined);
    admittedInput = redactMemoryActionInput(actionId, parsed.data);
    if (isPublicProfilePreparationActionIdV1(actionId)) {
      if (ctx.publicProfilePreparedAction && ctx.publicProfilePreparedAction.actionId !== actionId) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      if (!ctx.publicProfilePreparedAction && !ctx.publicProfilePreviewResult) {
        if (options?.approvalReplay) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        let prepared: Awaited<ReturnType<typeof preparePublicProfileAction>>;
        try {
          prepared = await preparePublicProfileAction(actionId, admittedInput, deps.publicProfileActions, ctx);
          if (prepared.kind === 'prepared' && ctx.reviewPublicProfilePreparedAction) {
            const reviewed = await ctx.reviewPublicProfilePreparedAction(prepared.effect);
            if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            try { await deps.publicProfileActions?.assertCurrent(ctx); }
            catch { throw new PublicProfileAccountScopeError(); }
            if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            if (!reviewed) return { ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' };
            if (ctx.surface === 'ui' && ctx.authority === 'present_user' && ctx.actionCaller?.kind === 'host') {
              ctx = { ...ctx, presentUserConfirmation: { actionId } };
            }
          }
        }
        catch (error) {
          if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          return { ok: false, ...normalizeActionExecutorThrownError(error) };
        }
        if (prepared.kind === 'settled') {
          if (!prepared.result.ok) return prepared.result;
          ctx = { ...ctx, publicProfilePreviewResult: prepared.result };
        } else ctx = { ...ctx, publicProfilePreparedAction: prepared.effect };
      }
    }
    const invitationFailure = await admitDiscussionInvitationTargets(actionId, admittedInput, ctx, ctx.sessionTargetsV1);
    if (invitationFailure) return invitationFailure;
    if (!existingAdmission && ctx.sessionTargetsV1 && !options?.sessionTargetLeaf) {
      ctx.onSessionTargetsResolved?.({ actionId, input: admittedInput, targets: ctx.sessionTargetsV1 });
    }
    if (actionId === 'session.exchange.control') {
      const exchangeInput = readRecord(admittedInput);
      if (exchangeInput.observedRevision === undefined) {
        if (existingAdmission || options?.approvalReplay || !deps.sessionExchangePrepare) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        const sessionId = resolveSessionIdFromInput(admittedInput, ctx);
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const serverId = resolveServerIdForSession(deps, ctx, sessionId);
        const observedRevision = await deps.sessionExchangePrepare({ context: ctx, sessionId,
          originInputLocalId: String(exchangeInput.originInputLocalId),
          ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (!AutonomousExchangeObservedRevisionV1Schema.safeParse(observedRevision).success) {
          return { ok: false, errorCode: 'exchange_unavailable', error: 'exchange_unavailable' };
        }
        admittedInput = spec.inputSchema.parse({ ...exchangeInput, observedRevision });
      }
    }
    if (actionId === 'account.apiTokens.create' && readRecord(admittedInput).encryption !== undefined
      && resolveHostStampedAuthority(ctx) !== 'present_user') {
      // Wrapping material belongs to the trusted device that will disclose the
      // compound credential. An automated request cannot prepare that custody.
      return { ok: false, errorCode: 'api_token_encryption_not_ready', error: 'api_token_encryption_not_ready' };
    }
    if (actionId === 'plugins.settings.set') {
      const admitInput = deps.pluginSettingsAdministrationAction?.admitInput;
      if (!admitInput) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const admissionFailure = await admitInput({ actionId, input: admittedInput, context: ctx });
      if (admissionFailure) return admissionFailure;
      if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    }
    if (actionId === 'connectedServices.accounts.revoke'
      && readRecord(admittedInput).emergencyRevoke !== true
      && readRecord(admittedInput).expectedCredentialRevision === undefined) {
      if (existingAdmission || ctx.bypassApprovals === true) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      const prepareInput = deps.connectedServiceAction?.prepareInput;
      if (!prepareInput) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const prepared = await prepareInput({ actionId, input: admittedInput, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const preparationFailure = readActionFailureEnvelope(prepared);
      if (preparationFailure) return preparationFailure;
      const preparedInput = spec.inputSchema.safeParse(prepared);
      if (!preparedInput.success || typeof readRecord(preparedInput.data).expectedCredentialRevision !== 'string') {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      admittedInput = preparedInput.data;
    }
    let memoryAdmission = existingAdmission?.memoryAdmission;
    let memoryDuplicateReview: MemoryWriteAdmissionV1['duplicateReview'];
    if (isMemoryWriteActionV1(actionId)) {
      if (ctx.approvalOrigin?.kind === 'transcript_tool_call') ctx = { ...ctx, approvalOrigin: { ...ctx.approvalOrigin, toolInput: admittedInput } };
      if (!deps.memoryLibrary) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
      try {
        const current = await readMemoryWriteAdmissionV1(deps.memoryLibrary, actionId, admittedInput, ctx);
        if (memoryAdmission?.safety === 'safe' && current.safety === 'danger') {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        memoryAdmission ??= current;
        memoryDuplicateReview = current.duplicateReview;
        admittedInput = bindMemoryWriteApprovalInputV1(actionId, admittedInput, memoryAdmission);
      } catch (error) {
        const code = ctx.signal?.aborted ? 'cancelled' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'memory_exposure_unavailable';
        return { ok: false, errorCode: code, error: code,
          ...(!ctx.signal?.aborted && error && typeof error === 'object' && 'details' in error ? { details: error.details } : {}) };
      }
    }
    if (isActionFamilyId(actionId, ActionOperationActionIdV1Schema) && ctx.serverId
      && !isSameHome(readRecord(admittedInput).serverId, ctx.serverId, ctx)) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    // The Action grant was checked before target reads. Selector intent is not
    // a credential target; each concrete leaf re-enters full target admission.
    const credentialFailure = sessionTarget && ctx.sessionTargetsV1 && !options?.sessionTargetLeaf
      ? null : await admitCredentialScope(actionId, ctx, admittedInput, hostInternal);
    if (credentialFailure) return credentialFailure;
    const workspaceFailure = workspaceWriteFailure(spec, admittedInput, ctx);
    if (workspaceFailure) return workspaceFailure;
    const retainedDeploymentReview = existingAdmission?.deploymentReview ?? ctx.approvedActionReplay?.deploymentReview;
    let deploymentReview: JsonValue | undefined = retainedDeploymentReview;
    if ((!existingAdmission || actionId === 'deployments.templates.instantiate') && (actionId === 'machines.setup.apply' && deps.prepareMachineSetupApply
      || actionId === 'deployments.publish'
      || actionId === 'deployments.templates.instantiate' && deps.prepareDeploymentTemplateInstantiation && readRecord(admittedInput).mode === 'apply'
      || (actionId === 'deployments.deploy' || actionId === 'deployments.rollback' || actionId === 'deployments.promote') && deps.prepareDeploymentAction)) {
      if (actionId === 'deployments.publish' && (!ctx.serverId || !isSameHome(readRecord(admittedInput).serverId, ctx.serverId, ctx)))
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      const prepared = await readDeploymentPreparation(deps, actionId, admittedInput, ctx);
      if (prepared) {
        if ('errorCode' in prepared) return prepared;
        if (actionId === 'deployments.templates.instantiate' && (retainedDeploymentReview === undefined
          ? options?.approvalReplay === true
          : !areDeploymentTemplateReviewFactsEqualV1(retainedDeploymentReview, prepared.preview)))
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        admittedInput = prepared.input;
        deploymentReview = prepared.preview;
      }
    }
    if (memoryDuplicateReview) return { ok: true, result: memoryDuplicateReview };
    if (isActionFamilyId(actionId, WidgetDefinitionActionIdV1Schema) || isActionFamilyId(actionId, WidgetLayoutFragmentActionIdV1Schema)) {
      const account = readWidgetDefinitionActionAccountV1(admittedInput) ?? readWidgetLayoutFragmentActionAccountV1(admittedInput);
      if (!account) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
      const accountFailure = await admitWidgetActionSurfaceV1(deps, { ...account, owner: { kind: 'home' } }, ctx);
      if (accountFailure) return accountFailure;
      const sourceSession = readWidgetDefinitionActionSessionV1(admittedInput);
      if (sourceSession) {
        const sourceHomeFailure = await admitWidgetActionSurfaceV1(deps,
          { serverId: sourceSession.serverId, accountId: account.accountId, owner: { kind: 'home' } }, ctx);
        if (sourceHomeFailure) return sourceHomeFailure;
        const sourceScopeFailure = await resolveActionCurrentSessionScopeFailure(actionId,
          { sessionId: sourceSession.sessionId }, ctx, { sessionId: 'current_session' }, deps);
        if (sourceScopeFailure) return sourceScopeFailure;
      }
    }
    const nativeBoardIntent = actionId === 'boards.apply' ? WorkBoardActionInputSchemasV1['boards.apply'].parse(admittedInput).intent : null;
    const storedNativeBoardWidgetTarget = nativeBoardIntent?.kind.startsWith('widget_') && 'ref' in nativeBoardIntent
      && 'surface' in nativeBoardIntent.ref ? nativeBoardIntent.ref.surface : null;
    // Native edits address stored Board keys; admission still belongs to the caller's captured Home.
    // New adds and generic widget Actions must provide their current routing target themselves.
    const nativeBoardWidgetTarget = storedNativeBoardWidgetTarget && nativeBoardIntent?.kind !== 'widget_add'
      ? { ...storedNativeBoardWidgetTarget, serverId: ctx.serverIdentityId ?? ctx.serverId ?? storedNativeBoardWidgetTarget.serverId }
      : storedNativeBoardWidgetTarget;
    const widgetTarget = (actionId === 'widgets.snapshot.post' || isActionFamilyId(actionId, WidgetInstanceActionIdV1Schema))
      ? readWidgetActionSurfaceV1(admittedInput) : nativeBoardWidgetTarget;
    if (actionId === 'widgets.snapshot.post' && widgetTarget) {
      const snapshotScopeFailure = await admitWidgetActionSurfaceV1(deps, widgetTarget, ctx);
      if (snapshotScopeFailure) return snapshotScopeFailure;
    }
    const widgetDestination = actionId === 'widgets.item.move' ? readWidgetActionDestinationV1(admittedInput) : null;
    if (widgetTarget && widgetDestination && widgetTarget.serverId !== widgetDestination.serverId) {
      const sourceScope = readWidgetActionAccountScopeAdmissionV1(deps, widgetTarget, ctx);
      if (!sourceScope.ok) return sourceScope;
      const destinationScope = readWidgetActionAccountScopeAdmissionV1(deps, widgetDestination, ctx);
      if (!destinationScope.ok) return destinationScope;
    }
    if (widgetTarget && widgetDestination && widgetTarget.accountId !== widgetDestination.accountId) return { ok: false, errorCode: 'account_target_mismatch', error: 'account_target_mismatch' };
    if (widgetTarget?.owner.kind === 'sessionBoard' || widgetTarget?.owner.kind === 'companion') {
      const widgetScopeFailure = await resolveActionCurrentSessionScopeFailure(actionId,
        { sessionId: widgetTarget.owner.sessionId }, ctx, { sessionId: 'current_session' }, deps);
      if (widgetScopeFailure) return widgetScopeFailure;
    }
    if (widgetDestination?.owner.kind === 'sessionBoard' || widgetDestination?.owner.kind === 'companion') {
      const destinationScopeFailure = await resolveActionCurrentSessionScopeFailure(actionId,
        { sessionId: widgetDestination.owner.sessionId }, ctx, { sessionId: 'current_session' }, deps);
      if (destinationScopeFailure) return destinationScopeFailure;
    }
    if (actionId === 'widgets.item.add') {
      const publication = await prepareWidgetDefinitionPublicationV1(deps, admittedInput, ctx);
      if (!publication.ok) return publication;
      admittedInput = publication.input;
    }
    const boundWidgetSession = actionId === 'widgets.catalog.list' ? readWidgetCatalogBoundSessionV1(admittedInput) : null;
    if (boundWidgetSession) {
      const boundScopeFailure = await resolveActionCurrentSessionScopeFailure(actionId,
        { sessionId: boundWidgetSession.sessionId }, ctx, { sessionId: 'current_session' }, deps);
      if (boundScopeFailure) return boundScopeFailure;
    }
    // Selector scope is checked on each concrete leaf, before that leaf's
    // approval/effect admission. The intent itself is not a Session identity.
    // A selector Goal mutation uses session_target admission below at both
    // preparation and effect. Exact writes retain the contextual scope guard.
    const selectorGoalMutation = (ctx.sessionTargetsV1 !== undefined || options?.sessionTargetLeaf === true)
      && (actionId === 'session.goal.set' || actionId === 'session.goal.clear');
    if (!(ctx.sessionTargetsV1 && !ctx.sessionTargetsV1.operands && !options?.sessionTargetLeaf)
      && !selectorGoalMutation && !hasSessionQuestionAnswerOrigin(actionId, ctx)) {
      // A declared operand has the same Session scope regardless of its path
      // within a native input or a dispatch wrapper's input. Selection never
      // upgrades the wrapper's effect authority.
      const delegatedTarget = delegatesApprovalClassificationToResolvedAction(actionId) ? sessionTarget : undefined;
      const scopeInputs = delegatedTarget
        ? readActionSessionTargetOperands(readRecord(admittedInput), delegatedTarget.field).map(operand => ({ sessionId: operand.value }))
        : [admittedInput];
      for (const scopeInput of scopeInputs) {
        const currentSessionScopeFailure = await resolveActionCurrentSessionScopeFailure(actionId, scopeInput, ctx,
          delegatedTarget ? { sessionId: 'current_session' } : spec.contextualDefaults, deps,
          resolved => { ctx = { ...ctx, agentStartContext: resolved }; }, delegatedTarget?.scopeSideEffectClass);
        if (currentSessionScopeFailure) return classifyExecutionRunStartPreDispatchFailure(actionId, currentSessionScopeFailure);
      }
    }
    // Materialized Workflow writes need the same authenticated facts before
    // approval custody as native starts. Replay resolves current baseline and
    // policy while retaining the original host-admitted caller depth.
    if (isAgentCaller(ctx) && requiresActionAgentStartDepthV1(actionId) && !isAgentStartActionV1(actionId)) {
      const permission = resolveAgentEffectivePermission(ctx);
      if (!permission.ok) return permission.error;
      const ceiling = typeof permission.effectiveCallerMode === 'string'
        ? parseAgentPermissionIntentV1Alias(permission.effectiveCallerMode) : null;
      // Materialization consumes the permission owner's effective fact. Keep
      // the original context intact for its signed origination/approval proof.
      const resolved = ceiling ? await resolveActionAgentStartContextV1(deps,
        { ...ctx, callerPermissionMode: permission.effectiveCallerMode }) : null;
      if (!resolved || !ceiling) {
        return actionId.startsWith('workflow.definition.')
          ? { ok: false, errorCode: 'definition_exceeds_authority', error: 'definition_exceeds_authority',
              details: { code: 'definition_exceeds_authority', cause: { code: 'target_unavailable',
                reason: !ceiling ? 'caller_permission_unavailable' : 'agent_start_context_unavailable' } } }
          : actionStartTargetUnavailableV1(ctx, 'agent_start_context', !ceiling
            ? 'caller_permission_unavailable' : 'agent_start_context_unavailable');
      }
      ctx = { ...ctx, agentStartContext: { ...resolved, callerPermissionCeiling: ceiling } };
    }
    const agentStartAction = isAgentStartActionInvocationV1(actionId, readRecord(admittedInput));
    const managedAgentStart = actionId === 'machines.managed.acquire' && readRecord(admittedInput).agentStart !== undefined;
    const roleTargetAction = isRoleActionIdV1(actionId) && actionId.startsWith('session.');
    const userRoleStart = ctx.authority === 'present_user' && agentStartAction
      && typeof (managedAgentStart ? readRecord(readRecord(admittedInput).agentStart) : readRecord(admittedInput)).roleId === 'string'
      && Boolean(ctx.agentStartContext);
    // Account automation resolves the same selected Role, while retaining its
    // authenticated ceiling and ordinary policy/depth admission. It is never
    // promoted to the present-user exemption.
    const automationRoleStart = ctx.authority === 'account_automation' && !isAgentCaller(ctx)
      && (!ctx.actionCaller || ctx.actionCaller.kind === 'host') && agentStartAction
      && typeof (managedAgentStart ? readRecord(readRecord(admittedInput).agentStart) : readRecord(admittedInput)).roleId === 'string'
      && Boolean(ctx.agentStartContext);
    if ((isAgentCaller(ctx) && (agentStartAction || roleTargetAction || selectorGoalMutation)) || userRoleStart || automationRoleStart) {
      const targetSessionId = roleTargetAction || selectorGoalMutation || actionId === 'session.goal.set'
        ? readRecord(admittedInput).sessionId : undefined;
      const caller = userRoleStart ? { ok: true as const, effectiveCallerMode: 'yolo' }
        : automationRoleStart ? { ok: true as const, effectiveCallerMode: ctx.agentStartContext!.callerPermissionCeiling }
          : resolveAgentEffectivePermission(ctx);
      if (!caller.ok) return classifyExecutionRunStartPreDispatchFailure(actionId, caller.error);
      const ceiling = typeof caller.effectiveCallerMode === 'string'
        ? parseAgentPermissionIntentV1Alias(caller.effectiveCallerMode) : null;
      if (!ceiling) return classifyExecutionRunStartPreDispatchFailure(actionId, causalPermissionAuthorityFailure());
      const resolved = await resolveActionAgentStartContextV1(deps,
        { ...ctx, callerPermissionMode: caller.effectiveCallerMode }, typeof targetSessionId === 'string' ? targetSessionId : undefined);
      // This fact comes from the authenticated Action caller, never authored input.
      const startContext = resolved ? { ...resolved, callerPermissionCeiling: ceiling,
        initiator: userRoleStart ? 'user' as const : undefined } : null;
      const request = readRecord(admittedInput);
      if (roleTargetAction) {
        const admission = admitActionAgentStartV1(ctx, { kind: 'session_target', targetSessionId: String(request.sessionId) }, startContext);
        if (!admission.ok) return admission.error;
        ctx = { ...ctx, agentStartContext: startContext ?? undefined };
      } else {
        const starts = resolveActionAgentStartRequestsV1({ actionId, input: request, context: ctx,
          baseline: startContext?.baseline ?? { machineId: '', directory: '' } });
        if (!starts.ok) return classifyExecutionRunStartPreDispatchFailure(actionId, {
          ok: false, errorCode: starts.errorCode, error: starts.errorCode,
          ...(starts.details === undefined ? {} : { details: starts.details }),
        });
        for (const start of starts.requests) {
          const admission = admitActionAgentStartV1(ctx, start, startContext);
          if (!admission.ok) return classifyExecutionRunStartPreDispatchFailure(actionId, admission.error);
          if (start.kind === 'execution_run' || start.kind === 'spawn_new') {
            const startInput = managedAgentStart ? readRecord(request.agentStart) : request;
            // Fan-out inherits only after each concrete child target and route
            // are known. Role projection still precedes downstream admission.
            const stampedInput = start.kind === 'spawn_new'
              ? stampAgentStartSelectionV1(startInput, admission.stamped, start.kind, startContext!)
              : admission.stamped.roleId && admission.stamped.engine
                ? projectAgentStartSelectionV1(startInput, { ...admission.stamped, engine: admission.stamped.engine }, start.kind,
                    startContext!.caller.kind === 'session' ? startContext!.baseline
                      : { machineId: startContext!.baseline.machineId, directory: startContext!.baseline.directory })
                : startInput;
            admittedInput = managedAgentStart ? { ...request, agentStart: stampedInput } : stampedInput;
            if (!managedAgentStart && actionId !== 'execution.run.start' && actionId !== 'session.spawn_new' && admission.stamped.roleId && admission.stamped.engine) {
              admittedInput = { ...readRecord(admittedInput),
                [actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys']: [admission.stamped.engine.agentTargetKey] };
            }
          }
          ctx = { ...ctx, agentStartContext: startContext ?? undefined, agentStartWorkDepth: admission.stamped.workDepth,
            agentStartWorkspaceWrites: admission.stamped.workspaceWrites };
        }
      }
    }
    const callerPolicyFailure = existingAdmission
      ? null
      : pluginActionCallerPolicyFailure(spec, admittedInput, ctx);
    if (callerPolicyFailure) {
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(callerPolicyFailure, 'noRunCreated')
        : callerPolicyFailure;
    }
    let visualAdmission: SessionVisualAdmissionV1 | undefined;
    if (actionId === 'session.board.item.upsert') {
      try {
        const admission = await readSessionVisualAdmissionV1(deps, admittedInput, ctx, Boolean(existingAdmission) || options?.approvalReplay === true);
        if ('ok' in admission) return admission;
        visualAdmission = admission;
        admittedInput = admission.input;
      } catch {
        const errorCode = ctx.signal?.aborted ? 'cancelled' : 'action_failed';
        return { ok: false, errorCode, error: errorCode };
      }
    }
    let computerSelection: ReturnType<typeof ComputerSelectedTargetResponseV1Schema.parse> | undefined;
    if (actionId === 'computer.target.select' || actionId === 'computer.capture' || actionId === 'computer.query' || actionId === 'computer.input') {
      const selection = await resolveComputerActionSelection(deps, admittedInput, ctx);
      if (!selection.ok) return selection;
      computerSelection = selection.selection;
      if (actionId !== 'computer.target.select') {
        const requested = readRecord(admittedInput).target;
        if (requested && computerSelection.selectedTarget && JSON.stringify(requested) !== JSON.stringify(computerSelection.selectedTarget)) {
          return { ok: false, errorCode: 'computer_target_selection_changed', error: 'computer_target_selection_changed' };
        }
        if (ctx.bypassApprovals && !computerSelection.selectedTarget) {
          return { ok: true, result: { status: 'target_selection_required', approvalDisplay: computerSelection.approvalDisplay } };
        }
        const requestedSourceId = readRecord(admittedInput).sourceId;
        if (requestedSourceId && requestedSourceId !== computerSelection.sourceId) {
          return { ok: false, errorCode: 'computer_target_selection_changed', error: 'computer_target_selection_changed' };
        }
        if (computerSelection.selectedTarget) admittedInput = { ...readRecord(admittedInput), target: computerSelection.selectedTarget, sourceId: computerSelection.sourceId };
        else {
          const { target: _target, sourceId: _sourceId, ...unselected } = readRecord(admittedInput);
          admittedInput = unselected;
        }
      }
    }
    let data = readRecord(admittedInput);
    const folderCreateInput = (actionId === 'prompt_doc.create' || actionId === 'prompt_doc.update'
      || actionId === 'prompt_bundle.update') && data.createFolder !== undefined
      ? ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1['artifact.folders.create'].parse(data.createFolder) : null;
    if (folderCreateInput) {
      const childSpec = getActionSpec('artifact.folders.create');
      const childAuthorityFailure = requiredAuthorityFailure(childSpec, ctx, folderCreateInput);
      if (childAuthorityFailure) return childAuthorityFailure;
      const childGrantFailure = credentialScopeFailure(childSpec.id, ctx, folderCreateInput, true);
      if (childGrantFailure) return childGrantFailure;
      if (!isHostInternalActionEnabled(childSpec, ctx)) {
        return actionDisabled(null);
      }
      if (!deps.artifactFolders) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:artifact.folders.create' };
      if (ctx.serverId && !(deps.artifactFolders.matchesServerId?.(ctx.serverId) ?? ctx.serverId === deps.artifactFolders.serverId)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
    }
    const sessionMessageSendAdmission: SessionMessageSendAdmission = actionId === 'session.message.send' || actionId === 'session.agent.transition'
      ? resolveSessionMessageSendAdmission(ctx, actionId === 'session.agent.transition'
        ? readRecord(readRecord(data.input).meta).permissionMode : data.permissionModeOverride)
      : { ok: true };
    if (!sessionMessageSendAdmission.ok) return sessionMessageSendAdmission.error;
    if (actionId === 'session.message.send' && data.returnToSessionId !== undefined
      && (isAgentCaller(ctx) || ctx.actionCaller?.kind === 'plugin')) {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    let requiredDirectoryApproval: SessionCreationDirectoryApprovalV1 | null = null;
    let requiredHandoffTargetApproval: HandoffTargetReplacementApprovalV1 | null = null;
    if (!existingAdmission && actionId === 'session.spawn_new' && deps.sessionSpawnNewDirectoryApprovalPreflight) {
      const spawnInput = SessionSpawnNewActionInputV2Schema.safeParse(admittedInput);
      if (!spawnInput.success) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      let directoryPreflight: Awaited<ReturnType<NonNullable<
        ActionExecutorDeps['sessionSpawnNewDirectoryApprovalPreflight']
      >>>;
      try {
        directoryPreflight = await deps.sessionSpawnNewDirectoryApprovalPreflight({
          input: admitSessionSpawnNewActionInputV2(spawnInput.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (error) {
        const rpcCode = readRpcErrorCode(error);
        if (!ctx.signal?.aborted && (rpcCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || rpcCode === RPC_ERROR_CODES.METHOD_NOT_FOUND)) {
          return completeSpawnActionResult({ type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'target_preparation_rpc_unavailable' } });
        }
        const forbidden = rpcCode === RPC_ERROR_CODES.FORBIDDEN;
        return completeSpawnActionResult({
          type: 'error',
          code: ctx.signal?.aborted ? 'cancelled' : forbidden ? 'permission_denied' : 'spawn_failed',
          retryable: !ctx.signal?.aborted && !forbidden,
        });
      }
      if (directoryPreflight.type === 'error') {
        return completeSpawnActionResult(directoryPreflight.result);
      }
      if (directoryPreflight.type === 'approval_required') {
        const replayedApproval = SessionCreationDirectoryApprovalV1Schema.safeParse(
          ctx.sessionCreationDirectoryApproval,
        );
        if (!replayedApproval.success || !sameSessionCreationDirectoryApproval(
          replayedApproval.data,
          directoryPreflight.approval,
        )) {
          // An approved artifact may only replay its exact target proof. A
          // refreshed target cannot turn that replay into another approval:
          // doing so would settle the original artifact as executed without
          // either its approved proof or the Action effect.
          if (ctx.bypassApprovals) {
            return { ok: false, errorCode: 'approval_stale', error: 'approval_stale',
              details: { reason: replayedApproval.success ? 'directory_changed' : 'directory_approval_missing' } };
          }
          requiredDirectoryApproval = directoryPreflight.approval;
        }
      }
    }
    const handoffWorkspaceAction = actionId === 'session.handoff'
      ? data.workspaceAction as HandoffWorkspaceActionV1 | undefined
      : undefined;
    const handoffMayReplaceTarget = handoffWorkspaceAction?.kind === 'copy_once'
      || handoffWorkspaceAction?.kind === 'create_relationship';
    // Both destination-choosing Action families reach the same target-daemon
    // inspection. Linking has no Session, so it carries its destination intent
    // and mode explicitly instead of a handoff workspace action.
    const choosesWorkspaceDestination = (actionId === 'session.handoff' && handoffMayReplaceTarget)
      || actionId === 'workspace.sync.relationship.create';
    if (!existingAdmission && choosesWorkspaceDestination
      && !deps.sessionHandoffTargetReplacementApprovalPreflight) {
      return { ok: false, errorCode: 'workspace_sync_unavailable', error: 'workspace_sync_unavailable' };
    }
    if (!existingAdmission && choosesWorkspaceDestination && deps.sessionHandoffTargetReplacementApprovalPreflight) {
      const sessionId = actionId === 'session.handoff'
        ? resolveSessionIdFromInput(admittedInput, ctx)
        : null;
      const targetMachineId = normalizeId(data.targetMachineId);
      const targetServerId = sessionId
        ? resolveServerIdForSession(deps, ctx, sessionId)
        : normalizeId(ctx.serverIdentityId) || normalizeId(ctx.serverId) || null;
      const operationId = normalizeId(ctx.handoffTargetReplacementApproval?.operationId)
        || normalizeId(ctx.actionRequestId);
      if ((actionId === 'session.handoff' && !sessionId) || !targetMachineId || !operationId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const destinationIntent = actionId === 'workspace.sync.relationship.create'
        && (data.destinationIntent === 'use_existing' || data.destinationIntent === 'materialize_from_source_workspace')
        ? data.destinationIntent
        : undefined;
      let targetPreflight: Awaited<ReturnType<NonNullable<
        ActionExecutorDeps['sessionHandoffTargetReplacementApprovalPreflight']
      >>>;
      try {
        targetPreflight = await deps.sessionHandoffTargetReplacementApprovalPreflight({
          ...(sessionId ? { sessionId } : {}),
          targetMachineId,
          ...(normalizeId(data.targetPath) ? { targetPath: normalizeId(data.targetPath)! } : {}),
          ...(data.workspaceAction ? { workspaceAction: data.workspaceAction as HandoffWorkspaceActionV1 } : {}),
          ...(destinationIntent ? { destinationIntent } : {}),
          ...(actionId === 'workspace.sync.relationship.create'
            ? { activatesExactMirror: data.mode === 'mirror_exactly' }
            : {}),
          ...(targetServerId ? { serverId: targetServerId } : {}),
          operationId,
          effectActionId: actionId === 'session.handoff' ? actionId : 'workspace.sync.relationship.create',
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch {
        return { ok: false, errorCode: ctx.signal?.aborted ? 'cancelled' : 'machine_offline', error: ctx.signal?.aborted ? 'cancelled' : 'machine_offline' };
      }
      if (targetPreflight.type === 'error') return targetPreflight.result;
      if (targetPreflight.type === 'approval_required') {
        const replayedApproval = HandoffTargetReplacementApprovalV1Schema.safeParse(
          ctx.handoffTargetReplacementApproval,
        );
        if (!replayedApproval.success || !sameHandoffTargetReplacementApproval(
          replayedApproval.data,
          targetPreflight.approval,
        )) {
          if (ctx.bypassApprovals) {
            return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
          }
          requiredHandoffTargetApproval = targetPreflight.approval;
        }
      }
    }
    // Home is Account-private; Artifact-backed surfaces supply their admitted
    // audience through the same read that proves edit authority.
    let widgetSourceIsShared: boolean | undefined = widgetTarget?.owner.kind === 'home' ? false : undefined;
    let widgetSourceRead: ReturnType<typeof WidgetSurfaceReadV1Schema.parse> | undefined;
    let widgetDestinationIsShared: boolean | undefined;
    if (!existingAdmission && spec.safety === 'danger' && widgetTarget) {
      for (const [target, destination] of [[widgetTarget, false], [widgetDestination, true]] as const) {
        const readPlacement = actionId === 'widgets.item.remove' && !destination;
        if (!target || !readPlacement && target.owner.kind !== 'project' && target.owner.kind !== 'workBoard'
          && target.owner.kind !== 'pluginArea' && target.owner.kind !== 'corePage') continue;
        const admitted = await readWidgetActionSurfaceAdmissionV1(deps, target, ctx, readPlacement ? { readPlacement: true } : undefined);
        if (!admitted.ok) return admitted;
        if (!admitted.read?.canEdit) return { ok: false, errorCode: 'widget_edit_denied', error: 'widget_edit_denied' };
        if (destination) widgetDestinationIsShared = admitted.read.isShared;
        else { widgetSourceIsShared = admitted.read.isShared; widgetSourceRead = admitted.read; }
      }
    }
    const widgetMoveWidensAudience = actionId === 'widgets.item.move' && widgetDestination !== null
      && widgetSourceIsShared === false && widgetDestinationIsShared === true;
    const removedWidget = actionId === 'widgets.item.remove' && widgetSourceRead
      ? widgetSourceRead.instances.find(entry => entry.instance.id === readRecord(readRecord(admittedInput).ref).instanceId)?.instance : undefined;
    // Reference placements can be added again, including on shared layouts.
    // A group, an inline definition's sole copy, or a Session source is deletion.
    const widgetRemovalDeletesContent = actionId === 'widgets.item.remove'
      && (widgetTarget?.owner.kind === 'sessionBoard'
        || widgetRemovalDeletesStoredContent(removedWidget));
    const homeLayoutInput = actionId === 'home.hub.layout.update' ? HomeHubLayoutUpdateInputSchema.safeParse(admittedInput) : null;
    const homeRemoval = homeLayoutInput?.success && (homeLayoutInput.data.intent.kind === 'remove'
      || homeLayoutInput.data.intent.kind === 'widget_remove' && !homeLayoutInput.data.intent.expectedInstance)
      ? homeLayoutInput.data.intent : null;
    let homeRemovalDeletesContent = false;
    if (!existingAdmission && homeRemoval) {
      homeRemovalDeletesContent = true;
      if (deps.homeHubArtifacts) {
        const description = await deps.homeHubArtifacts.describe(await deps.homeHubArtifacts.read(ctx.signal), ctx.signal);
        const instance = description.sections.flatMap(section => section.kind === 'group' ? section.children : [section])
          .find(section => section.kind === 'widget' && section.id === homeRemoval.instanceId);
        homeRemovalDeletesContent = widgetRemovalDeletesStoredContent(instance?.kind === 'widget' ? instance.instance : undefined);
      }
    }
    // Ordinary reversible edits stay declaration-owned. Proven publication from
    // a private surface strengthens only the shared policy's UI default.
    let contextualSafety = actionId === 'widgets.item.network.set' ? 'danger' as const
      : actionId === 'widgets.definition.create' && readRecord(readRecord(readRecord(admittedInput).definition).body).kind === 'html' ? 'danger' as const
      : !existingAdmission && memoryAdmission ? memoryAdmission.safety
      : !existingAdmission && actionId === 'session.manager.set'
      ? isAgentCaller(ctx)
        && (normalizeId(ctx.defaultSessionId) === String(readRecord(admittedInput).sessionId)
          || (await readActionCallerLedSubtreeSessionIds(deps, ctx))?.has(String(readRecord(admittedInput).sessionId)))
        ? 'safe' as const : 'danger' as const
      : requiredDirectoryApproval ? 'danger' as const
      : undefined;
    if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const logsApprovalLifetime = resolveMachineServiceLogsApprovalLifetime(actionId, admittedInput, ctx);
    // A signed host continuation cannot become a detached approval: replay
    // would lose its generation constraint and private observation custody.
    const protectedLogsEnvelope = ctx.originalActionEnvelope?.v === 1
      && (ctx.originalActionEnvelope.machineServiceLogsGeneration !== undefined || ctx.originalActionEnvelope.resourceContinuation !== undefined);
    if (actionId === 'machines.services.logs.read' && (ctx.machineServiceLogsResource || protectedLogsEnvelope)
      && ctx.externalActionExecutionAuthorization && !logsApprovalLifetime) return approvalContextUnavailable();
    const hostApprovalLifetime = deps.hostActionApprovalLifetime ?? logsApprovalLifetime;
    const retainHostOperationApproval = Boolean(hostApprovalLifetime
      && ctx.signal === hostApprovalLifetime.signal
      && ('actionId' in hostApprovalLifetime
        // A private factory retains only this exact current invocation;
        // neither caller authority nor policy is substituted to obtain custody.
        ? ctx.surface === (hostApprovalLifetime.surface ?? 'cli') && hostApprovalLifetime.actionId === actionId
          && (!ctx.externalActionCredential && !ctx.externalActionExecutionAuthorization || logsApprovalLifetime !== undefined)
        : ctx.operationAcceptance?.operationId === hostApprovalLifetime.operationId
          && ctx.actionCaller?.kind === 'host' && ctx.authority === 'account_automation'));
    // Dispatch wrappers do not describe the eventual effect. Their resolved
    // Action is the single approval-classification and confirmation owner.
    const sharedRequesterRequest = !delegatesApprovalClassificationToResolvedAction(actionId)
      && isSharedRequesterActionV1(ctx);
    const sharedRequesterEffect = spec.sideEffectClass === 'external' && sharedRequesterRequest;
    // Speaking policy is the participant owner's deliberate publication choice,
    // independent of the Settings confirmation policy and its normal bypasses.
    let discussionDraftReviewRequired = false;
    const discussionPolicy = await readDiscussionPublicationPolicy(actionId, admittedInput, ctx);
    if (discussionPolicy) {
      if (!discussionPolicy.ok) return discussionPolicy;
      if (discussionPolicy.answerPolicy === 'reads_only') {
        return { ok: false, errorCode: 'discussion_answer_policy_denied', error: 'discussion_answer_policy_denied' };
      }
      const review = ctx.presentUserApproval;
      const reviewed = Boolean(ctx.approvedActionReplay && review?.artifactId === ctx.approvedActionReplay.artifactId
        && review.actionId === actionId && review.requestId === ctx.actionRequestId && review.decidingAccountId
        && review.inputDigest === computeActionInputApprovalDigestV1(actionId, admittedInput));
      discussionDraftReviewRequired = discussionPolicy.answerPolicy === 'drafts_for_approval' && !reviewed;
      // The exact Workflow original already authorized this informational
      // answer. Keep explicit Settings Require and private draft review at
      // their existing owners instead of applying the generic new-post default.
      if (discussionPolicy.informationalReturn) contextualSafety = 'safe';
      if (discussionDraftReviewRequired && options?.approvalReplay) {
        return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
      }
    }
    let contextualUiConfirmation = widgetMoveWidensAudience || widgetRemovalDeletesContent || homeRemovalDeletesContent ? true : undefined;
    if (!existingAdmission && actionId === 'machines.access.grant.set'
      && ctx.surface === 'ui' && resolveHostStampedAuthority(ctx) === 'present_user' && deps.machineAccessAction) {
      const change = MachineAccessGrantSetInputV1Schema.parse(admittedInput);
      if (ctx.serverId && !isSameHome(change.serverId, ctx.serverId, ctx)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      if (change.level === 'view') {
        // Read the committed grant through the same scoped transport as the effect;
        // the sheet cannot supply its own approval classification or stale draft.
        const current = await deps.machineAccessAction({ actionId: 'machines.access.grants.list',
          input: { serverId: change.serverId, machineId: change.machineId }, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const failure = readActionFailureEnvelope(current);
        if (failure) return failure;
        contextualUiConfirmation = machineAccessGrantSetRequiresUiConfirmation(admittedInput, current);
      }
    }
    if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const scopeAdmission = await readActionApprovalScopeAdmissionV1({ actionId, spec, input: admittedInput,
      context: ctx, deps, phase: options?.approvalReplay ? 'replay' : existingAdmission ? 'dispatch' : 'prepare',
      isSameHome: (left, right) => isSameHome(left, right, ctx) });
    if ('ok' in scopeAdmission) return scopeAdmission;
    const { approvalScope, previewTemplateEnvironmentId, mandatoryApprovalRequired } = scopeAdmission;
    if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if (existingAdmission && !sameStrictJsonValue(existingAdmission.approvalScope ?? null, approvalScope ?? null)) {
      return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
    }
    if (existingAdmission && existingAdmission.previewTemplateEnvironmentId !== previewTemplateEnvironmentId) {
      return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
    }
    const preferenceScope = resolveActionApprovalPreferenceScopeV1(approvalScope, previewTemplateEnvironmentId);
    const resolveBaseApprovalRouting = (executionContext: ActionExecutorContext,
      approvedOperation?: Awaited<ReturnType<NonNullable<ActionExecutorDeps['readWorkflowApprovedOperation']>>>) => {
      const context = actionPolicyContext(actionId, executionContext);
      return resolveActionApprovalRouting({
        actionId,
        spec,
        input: admittedInput,
        context,
        settings: context.actionsSettings,
        ...(approvalScope ? { approvalScope } : {}),
        ...(previewTemplateEnvironmentId ? { previewTemplateEnvironmentId } : {}),
        ...(mandatoryApprovalRequired ? { mandatoryApprovalRequired } : {}),
        ...(approvedOperation ? { approvedOperation } : {}),
        ...(sharedRequesterEffect ? { defaultConfirmation: true } : {}),
        ...(retainHostOperationApproval ? { retainHostOperationApproval: true } : {}),
        ...(computerSelection ? { computerConsentGranted: computerSelection.consentGranted } : {}),
        ...(contextualSafety === undefined ? {} : { defaultSafety: contextualSafety }),
        ...(contextualUiConfirmation === undefined ? {} : { defaultUiConfirmation: contextualUiConfirmation }),
        // Pass the raw policy-hook result through (boolean | undefined). When the hook is unwired,
        // `undefined` propagates so `resolveActionApprovalRouting` applies its centralized fail-safe
        // default instead of coercing an unwired dependency to "no approval" here. (F7)
        requiredByPolicy: context.bypassApprovals ? false : visualAdmission?.networkCreationApprovalRequired === true
          ? true : contextualUiConfirmation !== undefined
          ? deps.isActionApprovalRequired?.(actionId, context, admittedInput, contextualUiConfirmation, approvedOperation, preferenceScope) : contextualSafety === undefined
          ? deps.isActionApprovalRequired?.(actionId, context, admittedInput, undefined, approvedOperation, preferenceScope) : undefined,
      });
    };
    const workflowRunId = ctx.externalActionExecutionAuthorization?.binding.workflowActionOrigin?.runId
      ?? (ctx.actionCaller?.kind === 'workflowRun' && ctx.executionRunWorkflowRunId === ctx.actionCaller.runId
        ? ctx.actionCaller.runId : undefined);
    // Preparation is not perpetual consent. Workflow dispatch re-reads the
    // exact stored operation and current policy after the coordinator commits
    // admitting; ordinary one-shot prepared Actions retain their existing path.
    let baseApprovalRouting = existingAdmission && !workflowRunId && !liveEnvironmentScope || hasSessionQuestionAnswerOrigin(actionId, ctx)
      ? { required: false, flow: 'deferred' as const, result: 'none' as const }
      : resolveBaseApprovalRouting(ctx);
    if (baseApprovalRouting.required && workflowRunId && deps.readWorkflowApprovedOperation) {
      let approvedOperation: Awaited<ReturnType<NonNullable<ActionExecutorDeps['readWorkflowApprovedOperation']>>> = null;
      try {
        approvedOperation = await deps.readWorkflowApprovedOperation({ runId: workflowRunId, context: ctx,
          phase: existingAdmission ? 'dispatch' : 'prepare' });
      } catch {
        // Missing, revoked, unreadable or mode-inconsistent evidence follows
        // the ordinary approval hold, never a transported bypass.
      }
      if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      if (approvedOperation) baseApprovalRouting = resolveBaseApprovalRouting(ctx, approvedOperation);
    }
    const folderApprovalRouting = folderCreateInput && !existingAdmission ? resolveActionApprovalRouting({
      actionId: 'artifact.folders.create', spec: getActionSpec('artifact.folders.create'), input: folderCreateInput,
      context: ctx, settings: ctx.actionsSettings,
      ...(retainHostOperationApproval ? { retainHostOperationApproval: true } : {}),
      requiredByPolicy: ctx.bypassApprovals ? false : deps.isActionApprovalRequired?.('artifact.folders.create', ctx, folderCreateInput),
    }) : null;
    const combinedApprovalRouting = baseApprovalRouting.required ? baseApprovalRouting : folderApprovalRouting?.required
      ? folderApprovalRouting : baseApprovalRouting;
    async function createReviewedPromptFolder(): Promise<ActionExecuteResult | null> {
      if (!folderCreateInput) return null;
      // This private child is covered by the exact parent operand that reached
      // combined admission. Its own executor still rechecks authority and policy.
      const child = await executeHostChild('artifact.folders.create', folderCreateInput, { ...ctx, bypassApprovals: true });
      if (!child.ok) return child;
      const mutation = ArtifactFolderMutationResultV1Schema.parse(child.result);
      if (mutation.status === 'updated') return null;
      const errorCode = mutation.status === 'conflict' ? 'version_mismatch' : 'artifact_organization_unavailable';
      return { ok: false, errorCode, error: errorCode };
    }
    const confidentialChoiceRequired = actionId === 'computer.secret.fill' || actionId === 'browser.automation.secret.fill';
    if (confidentialChoiceRequired && ctx.bypassApprovals) {
      return { ok: false, errorCode: 'confidential_choice_required', error: 'confidential_choice_required' };
    }
    const approvalRouting = confidentialChoiceRequired || discussionDraftReviewRequired
      ? { required: true, flow: 'deferred' as const, result: 'required' as const }
      : (!existingAdmission && actionId === 'workspace.sync.conflict.resolve' && !ctx.bypassApprovals)
      ? { required: true, flow: 'deferred' as const, result: 'required' as const }
      : requiredHandoffTargetApproval
      ? {
          required: true,
          flow: 'deferred' as const,
          result: 'required' as const,
        }
      : requiredDirectoryApproval && combinedApprovalRouting.required
      ? { ...combinedApprovalRouting, result: 'required' as const }
      : combinedApprovalRouting;
    if (approvalRouting.required && !isApprovalAction && ctx.interactivePresentation === 'unavailable') {
      return { ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required' };
    }
    if (requiredDirectoryApproval && !approvalRouting.required) {
      // Target inspection proves which folder may be created; the shared
      // Action policy decides whether that reversible effect needs approval.
      // Carry the exact proof after admission without changing caller authority.
      ctx = { ...ctx, sessionCreationDirectoryApproval: requiredDirectoryApproval };
    }
    // Selection is not approval. Only after the incumbent approval policy has
    // admitted this effect (including a waiver/bypass) can its computer owner retain consent.
    if (computerSelection?.selectedTarget && !approvalRouting.required) ctx = { ...ctx, bypassApprovals: true };
    if (!approvalRouting.required && (actionId === 'computer.targets.list'
      || SURFACE_AUTHORITY_AGENT_FLOOR.some(id => id === actionId))) {
      // Carry policy admission (approval replay, waiver or bypass), never substitute human authority.
      ctx = { ...ctx, bypassApprovals: true };
    }
    const dispatchFacts: DispatchFacts = { dispatchedPluginSessionInputLocalId: null, executionRunStartDispatched: false };

    try {
      if (approvalRouting.required && !isApprovalAction) {
        // A person is asked to approve only an add whose inputs this host's input owner already admits.
        if (actionId === 'widgets.item.add' && !existingAdmission && widgetTarget && deps.widgetInputs) {
          const added = WidgetInstanceActionInputSchemasV1['widgets.item.add'].safeParse(admittedInput);
          const refusal = added.success ? await admitWidgetInstanceConfigurationV1(deps,
            { surface: widgetTarget, instanceId: added.data.instance.id }, added.data.instance, ctx) : null;
          if (refusal && !isWidgetAdmissionUndecidableHereV1(refusal)) return refusal;
        }
        if (options?.confirmUiDefault && approvalRouting === baseApprovalRouting && !folderApprovalRouting?.required
          && ctx.surface === 'ui' && isPresentUserHostInvocation(ctx) && !ctx.bypassApprovals
          && ctx.presentUserConfirmation?.actionId !== actionId && deps.presentUserActionConfirmation) {
          const confirmedContext = { ...ctx, presentUserConfirmation: { actionId } };
          // Only the policy owner can distinguish a confirmable default from an
          // explicit Ask-first requirement after target/context admission.
          if (!resolveBaseApprovalRouting(confirmedContext).required) {
            const confirm = deps.presentUserActionConfirmation;
            return ready({ actionId, input: admittedInput, context: ctx,
              ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
            }, async () => {
              if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
              const policyReview = (actionId === 'machines.reboot' || actionId === 'providers.connections.endpoint.set'
                || actionId === 'providers.connections.secrets.bind' || actionId === 'providers.connections.create_contribution')
                ? await prepareApprovalRequest({ deps, actionId, input: admittedInput, actionArgs: admittedInput, context: ctx }) : null;
              if (policyReview && 'ok' in policyReview) return policyReview;
              const confirmationInput = policyReview?.actionArgs ?? admittedInput;
              const confirmed = await confirm({ actionId, input: confirmationInput, context: ctx,
                ...(policyReview ? { preview: policyReview.preview } : {}) });
              if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
              if (!confirmed) return { ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' };
              // The host reads current Account policy after this new UI await;
              // a newly explicit Ask-first requirement invalidates the default confirmation.
              if (deps.isActionApprovalRequired?.(actionId, confirmedContext, confirmationInput) === true) {
                return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
              }
              // Re-enter current authority and domain admission with the existing
              // exact-Action confirmation fact, never an approval bypass.
              return await executeCoreTerminal(actionId, discussionParticipantLaunch ? parsed.data : confirmationInput,
                confirmedContext, true, legacyMetadataLabel);
            });
          }
        }
        const confirmationSessionId = resolveSessionIdFromInput(admittedInput, ctx);
        const confirmationPreview = confirmationSessionId
          ? spec.projectSessionConfirmation?.(admittedInput, { sessionId: confirmationSessionId })
          : null;
        if (
          approvalRouting.flow === 'blocking'
          && ctx.surface === 'agent'
          && ctx.authority === 'account_automation'
          && spec.executionPlacement === 'session'
          && confirmationPreview != null
          && confirmationSessionId
          && confirmationSessionId === normalizeId(ctx.defaultSessionId)
          && deps.sessionActionConfirmation
        ) {
          const confirmation = await deps.sessionActionConfirmation({
            actionId,
            input: admittedInput,
            preview: confirmationPreview,
            context: ctx,
            sessionId: confirmationSessionId,
          });
          if (confirmation) {
            if (confirmation.decision !== 'approve') {
              const errorCode = confirmation.decision === 'reject' ? 'approval_rejected' : 'approval_canceled';
              return { ok: false, errorCode, error: errorCode };
            }
            const admission: PreparedCoreAdmission = {
              actionId,
              input: discussionParticipantLaunch ? parsed.data : admittedInput,
              context: { ...ctx, bypassApprovals: true },
              ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
            };
            const continueConfirmedAction = async (): Promise<ActionExecuteResult> => {
              if (ctx.signal?.aborted || !await confirmation.isCurrent()) {
                return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
              }
              // Re-enter current authority/enablement and domain admission with
              // the original bound subject, rather than using a prepared bypass.
              return await executeCoreTerminal(
                actionId, admission.input, admission.context, true, legacyMetadataLabel,
              );
            };
            return options?.prepareOnly
              ? ready(admission, continueConfirmedAction)
              : await continueConfirmedAction();
          }
        }
        if (!deps.approvalsCreate) {
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode: 'approvals_not_supported',
            error: 'approvals_not_supported',
          });
        }
        // Supported unsigned proposals capture the delivery owner's target
        // before durable approval takes custody. Unsupported approval stops
        // before attempting Account-private SOURCE placement reads.
        if (!ctx.externalActionExecutionAuthorization
          && (actionId === 'projects.prepare' || actionId === 'projects.script.run' || actionId === 'projects.compute.exec')) {
          const target = await resolveProjectActionMachineV1({ actionId, input: admittedInput, context: ctx,
            executeCanonicalAction: (id, input) => executeInvocation(id, input, ctx),
            createRequestKey: () => bytesToHex(randomBytes(16)),
            ...(ctx.serverIdentityId ? { homeId: ctx.serverIdentityId } : {}) });
          if (!target.ok) return target;
          ctx = { ...ctx, executionRunTargetMachineId: target.machineId };
        }
        const approvalPluginCaller = projectApprovalRequestPluginCaller(ctx.actionCaller);
        if (ctx.actionCaller?.kind === 'plugin' && !approvalPluginCaller) {
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode: 'plugin_action_caller_required',
            error: 'plugin_action_caller_required',
          });
        }

        const now = Date.now();
        const targetSessionId = resolveSessionIdFromInput(admittedInput, ctx);
        const requestedSurface = parseActionSurfaceKey(ctx.surface);
        const requestingSessionId = resolvePolicyApprovalRequestingSessionId(ctx.approvalOrigin, ctx, targetSessionId);
        const approvalOrigin = projectActionApprovalOrigin(actionId,
          resolveApprovalOriginForRequest(ctx.approvalOrigin, requestingSessionId));
        const createdBy = {
          surface: mapApprovalCreatedBySurface(ctx.surface ?? null),
          ...(approvalPluginCaller ?? {}),
          ...(requestingSessionId ? { sessionId: requestingSessionId } : {}),
        } as const;
        const initialApprovalActionArgs = actionId === 'session.spawn_new'
          ? materializeSessionSpawnApprovalInput(discussionParticipantLaunch ? parsed.data : admittedInput, ctx)
          : admittedInput;
        const preparedApproval = await prepareApprovalRequest({
          deps,
          actionId,
          input: admittedInput,
          actionArgs: initialApprovalActionArgs,
          context: ctx,
          ...(deploymentReview === undefined ? {} : { deploymentReview }),
          executeCanonicalAction: (id, input) => executeInvocation(id, input, ctx),
          ...(widgetSourceRead ? { widgetSurfaceRead: widgetSourceRead } : {}),
          ...(computerSelection ? { computerApprovalDisplay: computerSelection.approvalDisplay } : {}),
        });
        if (!preparedApproval) {
          const errorCode = ctx.signal?.aborted ? 'cancelled' : 'approval_context_unavailable';
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode,
            error: errorCode,
          });
        }
        if ('ok' in preparedApproval) return preparedApproval;
        const approvalActionArgs = preparedApproval.actionArgs;
        const requesterAdmission = resolveApprovalRequesterConfirmationV1({ context: ctx, actionId,
          input: approvalActionArgs, required: sharedRequesterRequest });
        if (!requesterAdmission.ok) return requesterAdmission;
        const { requesterConfirmation } = requesterAdmission;
        const executionOriginV1 = await prepareApprovalExecutionOrigin({
          actionId,
          input: approvalActionArgs,
          admittedInput,
          context: ctx,
          targetSessionId,
          ...(requesterConfirmation ? { requesterConfirmation } : {}),
        });
        if (!executionOriginV1) {
          const errorCode = requesterConfirmation ? 'approval_requester_unavailable' : 'approval_origin_unavailable';
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode,
            error: requesterConfirmation ? APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 : errorCode,
          });
        }
        if (ctx.signal?.aborted) {
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode: 'cancelled',
            error: 'cancelled',
          });
        }
        const proposedRequest: ApprovalRequestV2 = {
          v: 2,
          status: 'open',
          createdAtMs: now,
          updatedAtMs: now,
          createdBy,
          ...(requestedSurface ? { requestedSurface } : {}),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          executionOriginV1,
          requestInputDigest: computeActionInputApprovalDigestV1(actionId, admittedInput),
          ...(requesterConfirmation ? { requesterConfirmation } : {}),
          ...(discussionDraftReviewRequired ? { discussionDraftReview: true as const } : {}),
          approval: {
            flow: approvalRouting.flow,
            result: approvalRouting.result,
          },
          actionId,
          actionArgs: approvalActionArgs,
          summary: buildApprovalSummary(spec, admittedInput, preparedApproval.preview),
          preview: preparedApproval.preview,
          ...(requiredDirectoryApproval
            ? { sessionCreationDirectoryApproval: requiredDirectoryApproval }
            : {}),
          ...(requiredHandoffTargetApproval
            ? { handoffTargetReplacementApproval: requiredHandoffTargetApproval }
            : {}),
        };

        const res = await deps.approvalsCreate({ request: proposedRequest, serverId: normalizeId(ctx.serverId) || null });
        const request = res.request ?? proposedRequest;
        if (request.v !== 2) return { ok: false, errorCode: 'approval_request_conflict', error: 'approval_request_conflict' };
        const artifactId = normalizeId(res.artifactId);
        // Retained native reads keep exact-daemon/deferred replay, but their
        // original host still owns its interest until that recorded result.
        if (approvalRouting.flow === 'blocking' || retainHostOperationApproval) {
          if (!deps.approvalsWaitForDecision || !deps.approvalsUpdate) {
            return { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' };
          }

          const effectiveServerId = normalizeId(ctx.serverId) || null;
          ctx.operationOwnerUpdate?.update({ progress: { phase: 'waiting_for_approval', label: 'Waiting for approval',
            approval: { kind: 'approval_request_created', artifactId, actionId } } });
          let decision: Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>>;
          try {
            decision = await deps.approvalsWaitForDecision({
              artifactId,
              request,
              serverId: effectiveServerId,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          } catch (error) {
            // An ordinary transport observer may leave the durable request for
            // another authenticated surface. A Session-turn Action cannot: once
            // its admitted source lifetime ends, no originating tool invocation
            // remains to receive or execute the decision, so settle that request.
            if (ctx.signal?.aborted && !retainHostOperationApproval) {
              if (ctx.sessionInputSource === undefined) {
                return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
              }
              decision = { decision: 'canceled', request };
            } else {
              // Only an explicitly retained host intent owns withdrawal when it
              // ends. The incumbent transition/CAS below refuses cancellation if
              // a decision or effect claim already won the race.
              if (!retainHostOperationApproval || !hostApprovalLifetime || !('actionId' in hostApprovalLifetime)
                  || !ctx.signal?.aborted) throw error;
              decision = { decision: 'canceled', request };
            }
          } finally {
            // Consent, rejection, cancellation and failed observation all leave
            // this hold. The retained domain owner supplies its next progress.
            ctx.operationOwnerUpdate?.update({ progress: {} });
          }

          if (decision.decision === 'reject' || decision.decision === 'canceled') {
            const nowRejected = Date.now();
            // Settled approval input custody, the blocking sibling of the
            // deferred settlement writes: a refused request has no replay left,
            // so the durable record keeps only the observation projection.
            const nextRequest: ApprovalRequest = {
              ...settleApprovalRequestReplayInputs(decision.request),
              status: decision.decision === 'reject' ? 'rejected' : 'canceled',
              updatedAtMs: Math.max(nowRejected, decision.request.updatedAtMs),
              ...(decision.decision === 'reject'
                ? { decision: { kind: 'reject' as const, decidedAtMs: nowRejected } }
                : {}),
            };
            if (decision.request.status === 'open') {
              const updated = await deps.approvalsUpdate({ artifactId, request: nextRequest, serverId: effectiveServerId });
              const updateFailure = readActionFailureEnvelope(updated);
              if (updateFailure) return updateFailure;
            }
            const errorCode = decision.decision === 'reject' ? 'approval_rejected' : 'approval_canceled';
            return { ok: false, errorCode, error: errorCode };
          }

          const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(decision.request);
          if (recordedExecutionResult) return recordedExecutionResult;

          const approvedRequest = decision.request.status === 'approved'
            ? decision.request
            : {
                ...decision.request,
                status: 'approved' as const,
                updatedAtMs: Math.max(Date.now(), decision.request.updatedAtMs),
                decision: { kind: 'approve' as const, decidedAtMs: Date.now() },
              };
          if (decision.request.status === 'open') {
            const approved = await deps.approvalsUpdate({ artifactId, request: approvedRequest, serverId: effectiveServerId });
            const approvalFailure = readActionFailureEnvelope(approved);
            if (approvalFailure) return approvalFailure;
          }

          // Retain the exact invocation for private input or an explicitly
          // blocking show-once result; detached replay has no result recipient.
          const liveOnlyCustody = spec.approvalInputCustody === 'live_only'
            || spec.approvalResultCustody === 'live_only'
            ? { liveOnlyActionArgs: admittedInput }
            : {};
          const tokenExecution = decision.tokenExecution;
          const retainedFieldIntent = spec.approvalPolicy?.retainUiFieldIntent === true && ctx.surface === 'ui'
            && (!ctx.actionCaller || ctx.actionCaller.kind === 'host') && ctx.isPluginSettingsIntentCurrent
            ? { retainedPluginSettingsIntent: ctx.isPluginSettingsIntentCurrent } : {};
          // Only the exact live decision continuation carries authenticated
          // authority. Artifact notifications and durable reads carry none.
          const continuationContext = decision.decisionAuthority === 'present_user'
            ? { ...ctx, authority: 'present_user' as const,
              ...(decision.requesterApprovalDecision ? { requesterApprovalDecision: decision.requesterApprovalDecision } : {}) }
            : ctx;

          if (options?.prepareOnly) {
            const approvedInput = resolveApprovalRequestExecutionInput(approvedRequest);
            if (!approvedInput.ok) { await tokenExecution?.dispose(); return approvedInput; }
            const approvedAdmission: PreparedCoreAdmission = {
              actionId,
              input: spec.approvalInputCustody === 'live_only'
                ? admittedInput
                : approvedInput.input,
              context: {},
            };
            return ready(approvedAdmission, async () => {
              const executed = await executeApprovedActionForRequest({
                artifactId,
                request: approvedRequest,
                artifactServerId: effectiveServerId,
                ctx: continuationContext,
                ...liveOnlyCustody,
                ...(ctx.widgetAreaContext ? { retainedWidgetAreaContext: ctx.widgetAreaContext } : {}),
                ...(ctx.publicProfilePreparedAction ? { retainedPublicProfileAction: ctx.publicProfilePreparedAction } : {}),
                ...(ctx.publicProfilePreviewResult ? { retainedPublicProfilePreview: ctx.publicProfilePreviewResult } : {}),
                ...(tokenExecution ? { tokenExecution } : {}),
                ...retainedFieldIntent,
              }).finally(() => tokenExecution?.dispose());
              return executed.ok ? executed.exec : executed;
            });
          }

          const executed = await executeApprovedActionForRequest({
            artifactId,
            request: approvedRequest,
            artifactServerId: effectiveServerId,
            ctx: continuationContext,
            ...liveOnlyCustody,
            ...(ctx.widgetAreaContext ? { retainedWidgetAreaContext: ctx.widgetAreaContext } : {}),
            ...(ctx.publicProfilePreparedAction ? { retainedPublicProfileAction: ctx.publicProfilePreparedAction } : {}),
            ...(ctx.publicProfilePreviewResult ? { retainedPublicProfilePreview: ctx.publicProfilePreviewResult } : {}),
            ...(tokenExecution ? { tokenExecution } : {}),
            ...retainedFieldIntent,
          }).finally(() => tokenExecution?.dispose());
          return executed.ok ? executed.exec : executed;
        }
        return {
          ok: true,
          result: {
            kind: 'approval_request_created',
            artifactId,
            actionId,
          },
        };
      }

      // Request admission may permit automation to propose a human-only Action.
      // A policy waiver suppresses that proposal, never grants execution authority.
      if (canRequestPresentUserApprovalForActionInputV1(spec, admittedInput)
        && resolveHostStampedAuthority(ctx) !== 'present_user' && !hasSessionQuestionAnswerOrigin(actionId, ctx)) {
        return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
      }

      if (sessionTarget && ctx.sessionTargetsV1 && !ctx.sessionTargetsV1.operands && !options?.sessionTargetLeaf) {
        const snapshot = ctx.sessionTargetsV1;
        const runTargets = async (): Promise<ActionExecuteResult> => {
          const results: Array<{ target: ActionSessionAddress; result: ActionExecuteResult }> = [];
          for (const target of snapshot.targets) {
            // Every leaf passes current credential, scope, enabled-state and
            // domain admission. Only the already-reviewed selection is reused.
            const result: ActionExecuteResult = ctx.signal?.aborted
              ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
              : await executeCoreTerminal(actionId, replaceActionSessionTargetField(readRecord(admittedInput), snapshot.field, target.sessionId),
                  { ...ctx, serverId: target.serverId,
                    // A reviewed/resolved host leaf remains this exact Session
                    // through fresh transport reads, including durable replay.
                    ...(actionId === 'action.invoke' ? {} : { expectedSessionAddress: target }),
                    sessionTargetsV1: actionId === 'action.invoke' && sessionTarget.cardinality === 'one' ? snapshot : undefined,
                    bypassApprovals: true }, true,
                  legacyMetadataLabel, undefined, options?.approvalReplay === true, undefined, true, undefined, hostInternal);
            results.push({ target, result });
          }
          return snapshot.selector
            ? { ok: true, result: { kind: 'fanout', results } }
            : results[0].result;
        };
        return options?.prepareOnly
          ? ready({ actionId, input: admittedInput, context: ctx }, runTargets)
          : await runTargets();
      }

      if (options?.prepareOnly) {
        return ready({
          actionId,
          input: admittedInput,
          context: ctx,
          ...(hostInternal ? { hostInternal: true } : {}),
          ...(approvalScope ? { approvalScope } : {}),
          ...(previewTemplateEnvironmentId ? { previewTemplateEnvironmentId } : {}),
          ...(discussionParticipantLaunch ? { discussionParticipantLaunch } : {}),
          ...(memoryAdmission ? { memoryAdmission } : {}),
          ...(deploymentReview === undefined ? {} : { deploymentReview }),
          ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
        });
      }

      const runActionOperation = ctx.runActionOperation ?? deps.runActionOperation;
      if (spec.operation && runActionOperation && !existingAdmission?.operationObserved
        && ctx.operationAcceptance?.actionId !== actionId) {
        return await runActionOperation({ actionId, input: admittedInput, context: ctx,
          execute: operationContext => executeCoreTerminal(actionId, admittedInput, operationContext, true, legacyMetadataLabel, {
            actionId, input: admittedInput, context: operationContext, operationObserved: true,
            ...(hostInternal ? { hostInternal: true } : {}),
            ...(approvalScope ? { approvalScope } : {}),
            ...(previewTemplateEnvironmentId ? { previewTemplateEnvironmentId } : {}),
            ...(discussionParticipantLaunch ? { discussionParticipantLaunch } : {}),
            ...(memoryAdmission ? { memoryAdmission } : {}),
            ...(deploymentReview === undefined ? {} : { deploymentReview }),
            ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
          }, options?.approvalReplay === true, undefined, options?.sessionTargetLeaf === true),
        });
      }

      const executionPlacement = resolveActionExecutionPlacementForInput(spec, admittedInput);
      if (actionId === 'inbox.get') {
        const accountId = readNoticeInboxAccountIdV1(ctx);
        if (!accountId) return { ok: false, errorCode: 'forbidden', error: 'forbidden' };
        ctx = { ...ctx, expectedAccountId: accountId };
      }
      if (executionPlacement === 'client' && deps.clientActionExecute) {
        const delivered = await deps.clientActionExecute({ actionId, input: admittedInput, context: ctx });
        // An exact receiver's result cannot retarget to a headless owner.
        if (typeof data.clientId === 'string') return delivered;
        if (actionId === 'inbox.get' && delivered.ok && readRecord(delivered.result).status === 'unavailable' && deps.appShellAction) {
          return completeActionResult(await deps.appShellAction({ actionId, input: admittedInput, context: ctx }));
        }
        // The recap explicitly serves headless callers with compose data. Only a declared
        // no-client result falls back; denied or uncertain issued requests stay terminal.
        if ((actionId === 'usage.recap.export' || actionId === 'usage.recap.deliver'
          || actionId === 'usage.recap.private.export' || actionId === 'usage.recap.private.deliver') && !delivered.ok && delivered.errorCode === 'unavailable'
          && delivered.error === 'noClient' && deps.usageActions) {
          return await executeUsageAction(actionId, admittedInput, { query: deps.usageActions.query,
            readPublicProfile: deps.usageActions.readPublicProfile }, ctx);
        }
        if (!delivered.ok && delivered.errorCode === 'unavailable' && delivered.error === 'noClient') {
          if (actionId === 'usage.coach.apply' || actionId === 'usage.coach.undo'
            || actionId === 'usage.coach.dismiss' || actionId === 'usage.coach.snooze') {
            return await executeUsageCoachAction(actionId, admittedInput, (childId, childInput) => executeHostChild(childId, childInput,
              childId === 'usage.query' && actionId !== 'usage.coach.undo' ? { ...ctx, usageQueryReadiness: 'coach_evidence' } : ctx));
          }
          if ((actionId === 'settings.get' || actionId === 'settings.set') && deps.settingsDeclarationAction
            && !('reversal' in readRecord(admittedInput))) {
            return completeActionResult(await deps.settingsDeclarationAction({ actionId, input: admittedInput, context: ctx,
              executeOwnerAction: request => executeInvocation(request.actionId, request.input, { ...request.context, bypassApprovals: false }),
            }));
          }
        }
        return delivered;
      }
      if (executionPlacement === 'client' && spec.clientActionDomainInputSchema && Object.hasOwn(data, 'clientId')) {
        const domain = spec.clientActionDomainInputSchema.safeParse(withoutClientActionInput(admittedInput));
        if (!domain.success) return actionInputValidationFailure(domain.error);
        admittedInput = domain.data;
        parsed.data = domain.data;
        data = readRecord(domain.data);
      }
      if (executionPlacement === 'client' && actionId !== 'widgets.item.refresh' && actionId !== 'widgets.area.layout.select'
        && isActionFamilyId(actionId, WidgetInstanceActionIdV1Schema)
        && !deps.widgetSurfaceActions?.companion) return clientActionUnavailable(actionId);

      if (actionId === 'session.authoring.open') {
        if (!deps.sessionAuthoringOpen) return clientActionUnavailable(actionId);
        return completeActionResult(await deps.sessionAuthoringOpen({
          input: SessionAuthoringOpenV1Schema.parse(admittedInput), context: ctx,
        }));
      }

      if (SESSION_TRANSCRIPT_ACTION_ID_SET.has(actionId) && deps.sessionTranscriptAction) {
        const result = await deps.sessionTranscriptAction({
          actionId,
          input: parsed.data,
          context: ctx,
        });
        if (result !== null) {
          return result;
        }
      }

      // Switch by actionId; keep substrate generic.
      if (actionId === 'usage.query' || actionId === 'usage.export' || actionId === 'usage.calendar.export' || actionId === 'usage.recap.compose' || actionId === 'usage.recap.export' || actionId === 'usage.recap.deliver'
        || actionId === 'usage.recap.private.compose' || actionId === 'usage.recap.private.export' || actionId === 'usage.recap.private.deliver'
        || actionId === 'usage.prices.get' || actionId === 'usage.prices.refresh') {
        return executeUsageAction(actionId, admittedInput, deps.usageActions, ctx);
      }
      if (actionId === 'usage.coach.apply' || actionId === 'usage.coach.undo'
        || actionId === 'usage.coach.dismiss' || actionId === 'usage.coach.snooze') {
        return executeUsageCoachAction(actionId, admittedInput, (childId, childInput) => executeHostChild(childId, childInput,
          childId === 'usage.query' && actionId !== 'usage.coach.undo' ? { ...ctx, usageQueryReadiness: 'coach_evidence' } : ctx));
      }
      if (MEMORY_DOCUMENT_ACTION_IDS_V1.some(id => id === actionId)) {
        if (!deps.memoryLibrary) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        assertMemoryHomeV1(deps.memoryLibrary, ctx.serverId);
        if (isMemoryWriteActionV1(actionId)) {
          if (!memoryAdmission) return { ok: false, errorCode: 'memory_exposure_unavailable', error: 'memory_exposure_unavailable' };
          const proof = ctx.presentUserApproval;
          const accountId = ctx.expectedAccountId ?? ctx.runtimeAccountId;
          const approvedBy = proof?.actionId === actionId && proof.decidingAccountId && proof.decidedAtMs !== undefined
            && proof.inputDigest === computeActionInputApprovalDigestV1(actionId, admittedInput)
            ? { accountId: proof.decidingAccountId, atMs: proof.decidedAtMs }
            : ctx.bypassApprovals !== true && resolveHostStampedAuthority(ctx) === 'present_user' && accountId
              ? { accountId, atMs: (deps.memoryLibrary.nowMs ?? Date.now)() } : null;
          return { ok: true, result: await executeMemoryWriteV1({ port: deps.memoryLibrary, actionId, input: admittedInput, context: ctx,
            admission: memoryAdmission, approvedBy, sessionStateFieldSet: deps.sessionStateFieldSet }) };
        }
        if (actionId === 'memory.read') {
          const request = MemoryDocReadInputV1Schema.parse(admittedInput);
          assertMemoryHomeV1(deps.memoryLibrary, request.ref.serverId);
          return completeActionResult(await readMemoryDocInLibrary({ store: deps.memoryLibrary.store, artifactId: request.ref.artifactId,
            ...(request.topic === undefined ? {} : { topic: request.topic }), nowMs: deps.memoryLibrary.nowMs, signal: ctx.signal }));
        }
        const request = MemoryListInputV1Schema.parse(admittedInput);
        assertMemoryHomeV1(deps.memoryLibrary, request.serverId);
        return completeActionResult(await listMemoryDocsInLibrary({ store: deps.memoryLibrary.store, request, signal: ctx.signal }));
      }
      if (isSessionPermissionRemoteActionId(actionId)) {
        if (!deps.sessionPermissionRemoteAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const requiresPluginCaller = actionId === 'session.permission.remote.pending.list'
          || actionId === 'session.permission.remote.respond'
          || actionId === 'session.user_action.remote.answer';
        const pluginCaller = ctx.actionCaller?.kind === 'plugin' ? ctx.actionCaller : null;
        // These mediator requests intentionally omit their source identity.
        // Only a host-stamped plugin caller can select that owner; this is
        // provenance, not a transport/surface policy.
        if (
          requiresPluginCaller
          && (
            !pluginCaller
            || !pluginCaller.contributionLocalId?.trim()
          )
        ) {
          return {
            ok: false,
            errorCode: 'plugin_action_caller_required',
            error: 'plugin_action_caller_required',
          };
        }
        const sessionId = normalizeId(data.sessionId);
        if (!sessionId) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const caller = ctx.actionCaller ?? { kind: 'host' as const };
        const serverId = resolveServerIdForSession(deps, ctx, sessionId);
        const common = {
          caller,
          context: ctx,
          ...(serverId ? { serverId } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        const result = actionId === 'session.permission.remote.pending.list'
          ? await deps.sessionPermissionRemoteAction({
              actionId,
              input: SessionPermissionRemotePendingListInputV1Schema.parse(parsed.data),
              ...common,
            })
          : actionId === 'session.permission.remote.respond'
            ? await deps.sessionPermissionRemoteAction({
                actionId,
                input: SessionPermissionRemoteRespondInputV1Schema.parse(parsed.data),
                ...common,
              })
            : actionId === 'session.user_action.remote.answer'
              ? await deps.sessionPermissionRemoteAction({
                  actionId,
                  input: SessionUserActionRemoteAnswerInputV1Schema.parse(parsed.data),
                  ...common,
                })
            : actionId === 'session.permission.remote.grants.list'
              ? await deps.sessionPermissionRemoteAction({
                  actionId,
                  input: SessionPermissionRemoteGrantsListInputV1Schema.parse(parsed.data),
                  ...common,
                })
              : await deps.sessionPermissionRemoteAction({
                  actionId,
                  input: SessionPermissionRemoteGrantRevokeInputV1Schema.parse(parsed.data),
                  ...common,
                });
        return completeActionResult(result);
      }

      if (
        isHostExternalSessionActionId(actionId)
        && (
          (ctx.surface === 'api' && ctx.actionCaller?.kind === 'host')
          || (
            (ctx.surface === 'ui' || ctx.surface === 'agent' || ctx.surface === 'mcp' || ctx.surface === 'cli')
            && ctx.actionCaller?.kind !== 'plugin'
            && (actionId === 'sessions.external.candidates.list'
              || actionId === 'sessions.external.candidate.delete'
              || actionId === 'sessions.external.link.ensure'
              || actionId === 'sessions.external.transcript.page'
              || actionId === 'sessions.external.materialize.start'
              || actionId === 'sessions.external.backgroundFollow.set'
              || actionId === 'sessions.external.operation.status.get'
              || actionId === 'sessions.external.operation.cancel'
              || actionId === 'sessions.external.operation.resume'
              || actionId === 'sessions.external.operation.retry'
              || actionId === 'sessions.external.operation.discard')
          )
        )
      ) {
        if (!deps.hostExternalSessionAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        return await deps.hostExternalSessionAction({
          actionId,
          input: parsed.data,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }

      if (isPluginExternalSessionActionId(actionId)) {
        const pluginCaller = ctx.actionCaller?.kind === 'plugin' ? ctx.actionCaller : null;
        if (!deps.externalSessionAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        // This incumbent adapter selects its external-session contributor from
        // host-stamped plugin provenance. The API path above uses the existing
        // host owner rather than manufacturing plugin identity from transport
        // data.
        if (!pluginCaller) {
          return {
            ok: false,
            errorCode: 'plugin_action_caller_required',
            error: 'plugin_action_caller_required',
          };
        }
        return await deps.externalSessionAction({
          actionId,
          input: parsed.data,
          pluginId: pluginCaller.pluginId,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }

      if (
        actionId === 'plugins.sessionHooks.status.get'
        || actionId === 'plugins.sessionHooks.install'
        || actionId === 'plugins.sessionHooks.disable'
        || actionId === 'plugins.sessionHooks.enable'
        || actionId === 'plugins.sessionHooks.uninstall'
      ) {
        if (!deps.pluginSessionHookManagementAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const common = {
          ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        const result = actionId === 'plugins.sessionHooks.status.get'
          ? await deps.pluginSessionHookManagementAction({
              actionId,
              input: PluginSessionHookStatusActionInputV1Schema.parse(parsed.data),
              ...common,
            })
          : actionId === 'plugins.sessionHooks.install'
            ? await deps.pluginSessionHookManagementAction({
                actionId,
                input: PluginSessionHookInstallActionInputV1Schema.parse(parsed.data),
                ...common,
              })
            : await deps.pluginSessionHookManagementAction({
                actionId,
                input: PluginSessionHookInstallationMutationActionInputV1Schema.parse(parsed.data),
                ...common,
              });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (actionId === 'notifications.notify_me') {
        if (!deps.notificationsNotifyMe) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const input = NotificationsNotifyMeInputV1Schema.parse(parsed.data);
        const caller = ctx.actionCaller;
        const result = await deps.notificationsNotifyMe(
          input.open === undefined && caller?.kind === 'workflowRun'
            ? { ...input, open: { kind: 'workflow_run', runId: caller.runId } }
            : input,
          ctx,
        );
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (actionId === 'workflow.discussion.round.project') return await executeWorkflowDiscussionRoundProjectV1(parsed.data, ctx, deps);
      if (actionId === 'webhooks.call' || actionId === 'machines.command.run') {
        const result = actionId === 'webhooks.call'
          ? await deps.webhookCall?.(WorkflowWebhookInputV1Schema.parse(parsed.data), ctx)
          : await deps.machineCommandRun?.(WorkflowMachineCommandInputV1Schema.parse(parsed.data), ctx);
        if (result === undefined) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const dispatchReviewDispatch1Result = await dispatchReviewDispatch1({ actionId, deps, ctx, parsed, data, executeHostChild });
      if (dispatchReviewDispatch1Result !== null) return dispatchReviewDispatch1Result;

      const permissionGrantActionId = isActionFamilyId(actionId, PluginPermissionGrantActionIdV1Schema) ? actionId : null;
      if (permissionGrantActionId !== null) {
        if (!deps.pluginPermissionGrantAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const caller = ctx.actionCaller ?? { kind: 'host' as const };
        const common = {
          caller,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        const result = permissionGrantActionId === 'plugins.permissions.grants.list'
          ? await deps.pluginPermissionGrantAction({
              actionId: permissionGrantActionId,
              input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId].parse(parsed.data),
              ...common,
            })
          : permissionGrantActionId === 'plugins.permissions.grants.request'
            ? await deps.pluginPermissionGrantAction({
                actionId: permissionGrantActionId,
                input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId].parse(parsed.data),
                ...common,
              })
            : permissionGrantActionId === 'plugins.permissions.grants.grant'
              ? await deps.pluginPermissionGrantAction({
                  actionId: permissionGrantActionId,
                  input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId].parse(parsed.data),
                  ...common,
                })
              : permissionGrantActionId === 'plugins.permissions.grants.revoke'
                ? await deps.pluginPermissionGrantAction({
                    actionId: permissionGrantActionId,
                    input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId].parse(parsed.data),
                    ...common,
                  })
                : await deps.pluginPermissionGrantAction({
                    actionId: permissionGrantActionId,
                    input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId].parse(parsed.data),
                    ...common,
                  });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      const automationEventActionId = isActionFamilyId(actionId, AutomationEventActionIdV1Schema) ? actionId : null;
      if (automationEventActionId !== null) {
        if (!deps.automationEventAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        if (ctx.actionCaller?.kind !== 'plugin') {
          return {
            ok: false,
            errorCode: 'plugin_action_caller_required',
            error: 'plugin_action_caller_required',
          };
        }
        const result = await deps.automationEventAction({
          actionId: automationEventActionId,
          input: AutomationEventActionInputSchemasV1[automationEventActionId].parse(parsed.data),
          caller: ctx.actionCaller,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (isWorkBoardActionIdV1(actionId)) {
        if (!deps.workBoardArtifacts) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        if (actionId === 'boards.apply') {
          const { intent } = WorkBoardActionInputSchemasV1['boards.apply'].parse(parsed.data);
          if (intent.kind.startsWith('widget_') && 'ref' in intent && 'surface' in intent.ref && nativeBoardWidgetTarget) {
            const routedRef = { ...intent.ref, surface: nativeBoardWidgetTarget };
            const refusal = await admitWidgetActionSurfaceV1(deps, routedRef.surface, ctx);
            if (refusal) return refusal;
            if (intent.kind === 'widget_add' || intent.kind === 'widget_inputs' || intent.kind === 'widget_size') {
              let instance = intent.kind === 'widget_add' ? intent.instance : undefined;
              if (intent.kind === 'widget_inputs' || intent.kind === 'widget_size') {
                const port = readWidgetActionSurfacePortV1(deps, routedRef.surface);
                const read = port ? await port.read(routedRef.surface, ctx, ctx.signal) : null;
                const failed = readActionFailureEnvelope(read);
                if (failed) return failed;
                const state = WidgetSurfaceReadV1Schema.safeParse(read);
                if (!state.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
                const existing = state.data.instances.find(entry => entry.instance.id === intent.ref.instanceId)?.instance;
                if (!existing) return { ok: false, errorCode: 'widget_instance_not_found', error: 'widget_instance_not_found' };
                instance = intent.kind === 'widget_inputs' ? { ...existing,
                  bindings: setWidgetInputBindingsV1(existing.bindings, intent.bindings, intent.paths) } : existing;
              }
              if (intent.kind === 'widget_add' || intent.kind === 'widget_inputs') {
                const admission = await admitWidgetInstanceConfigurationV1(deps, routedRef, instance!, ctx);
                if (admission) return admission;
              }
              if (intent.kind === 'widget_add' || intent.kind === 'widget_size') {
                const admission = await admitWidgetInstanceSizeV1(deps, routedRef, instance!, intent.size, ctx);
                if ('ok' in admission) return admission;
                return await executeWorkBoardActionV1(deps.workBoardArtifacts, actionId,
                  { intent: { ...intent, ...(admission.size ? { size: admission.size } : {}) } }, ctx.signal, ctx);
              }
            }
          }
        }
        return await executeWorkBoardActionV1(deps.workBoardArtifacts, actionId, parsed.data, ctx.signal, ctx);
      }

      const widgetActionId = isActionFamilyId(actionId, WidgetInstanceActionIdV1Schema) ? actionId : null;
      if (widgetActionId !== null) return await executeWidgetInstanceActionV1(deps, widgetActionId, admittedInput, ctx);
      const widgetDefinitionActionId = isActionFamilyId(actionId, WidgetDefinitionActionIdV1Schema) ? actionId : null;
      if (widgetDefinitionActionId !== null) return await executeWidgetDefinitionActionV1(deps, widgetDefinitionActionId, parsed.data, ctx);
      const widgetFragmentActionId = isActionFamilyId(actionId, WidgetLayoutFragmentActionIdV1Schema) ? actionId : null;
      if (widgetFragmentActionId !== null) return await executeWidgetLayoutFragmentActionV1(deps, widgetFragmentActionId, admittedInput, ctx);
      if (actionId === 'widgets.snapshot.post') return await executeWidgetSnapshotPostV1(deps, parsed.data, ctx);

      if (isProfileActionIdV1(actionId)) {
        if (!deps.profileActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return await deps.profileActionExecute(parseProfileActionRequestV1(actionId, parsed.data), ctx);
      }

      if (actionId === 'skills.rules.set') {
        if (!deps.skillRules) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        if (ctx.serverId && !(deps.skillRules.matchesServerId?.(ctx.serverId) ?? ctx.serverId === deps.skillRules.serverId)) {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        return { ok: true, result: await mutateSkillRulesV1(deps.skillRules, SkillsRulesSetInputV1Schema.parse(parsed.data), ctx.signal) };
      }
      if (isMcpServerActionIdV1(actionId) || actionId === 'mcp.rules.set') {
        if (!deps.mcpServerAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return await deps.mcpServerAction({ actionId, input: parsed.data, context: ctx });
      }
      if (isProviderActionIdV1(actionId)) {
        if (!deps.providerActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return await deps.providerActionExecute(parseProviderActionRequestV1(actionId, parsed.data), ctx);
      }

      if (isRemoteHostActionIdV1(actionId)) {
        if (!deps.remoteHostActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        // The spec admitted this exact action's schema; recover its erased id/input correlation without reparsing.
        const request = { actionId, input: parsed.data } as RemoteHostActionRequestV1;
        const outcome = await deps.remoteHostActionExecute(request, ctx);
        return outcome.ok ? { ok: true, result: REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(outcome.result) } : outcome;
      }

      if (isAccountLifecycleActionId(actionId)) {
        if (!deps.accountLifecycleAction) return clientActionUnavailable(actionId);
        const outcome = await deps.accountLifecycleAction({ actionId,
          input: ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS[actionId].parse(parsed.data), context: ctx });
        return outcome.ok ? { ok: true, result: ACCOUNT_LIFECYCLE_ACTION_OUTPUT_SCHEMAS[actionId].parse(outcome.result) } : outcome;
      }

      if (isHomeRuntimeActionIdV1(actionId)) {
        if (actionId === 'home.runtime.restart') {
          if (!deps.homeRuntimeTaskRpc) return { ok: true, result: { status: 'unavailable', reason: 'runtime_task_transport_unavailable' } };
          return await executeHomeRuntimeRestart(parsed.data as HomeRuntimeRestartInputV1, ctx, deps.homeRuntimeTaskRpc);
        }
        if (!deps.homeRuntimeActionExecute) return clientActionUnavailable(actionId);
        // The spec admitted this exact action's schema; recover its erased id/input correlation without reparsing.
        const request = { actionId, input: parsed.data } as HomeRuntimeActionRequestV1;
        const outcome = await deps.homeRuntimeActionExecute(request, ctx);
        return outcome.ok ? { ok: true, result: HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(outcome.result) } : outcome;
      }

      if (actionId === 'launch_profiles.publish') {
        if (!deps.launchProfilePublish) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const input = LaunchProfilePublishInputV1Schema.parse(parsed.data);
        return { ok: true, result: await deps.launchProfilePublish(input, { context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }) };
      }

      if (isRoleActionIdV1(actionId)) {
        if (!deps.roleActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        let result: unknown;
        try {
          result = await deps.roleActionExecute({ actionId, input: parsed.data, context: ctx });
        } catch (error) {
          const failure = projectAccountRoleActionRefusalV1(error)
            ?? projectSessionRoleRpcFailureV1(actionId, readRpcErrorCode(error));
          if (failure) return failure;
          throw error;
        }
        const failure = readActionFailureEnvelope(result);
        return (failure && projectSessionRoleRpcFailureV1(actionId, failure.errorCode)) ?? failure ?? { ok: true, result };
      }

      if (actionId === 'session.targets.resolve') {
        const input = SessionTargetsResolveInputV1Schema.parse(parsed.data);
        const declaration = readActionSessionTargetDeclaration(input.actionId, undefined, ctx);
        if (!declaration) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const result = await previewActionSessionTargets(deps, { actionId,
          declaration: { field: 'target', cardinality: declaration.cardinality },
          input: { target: input.target }, context: ctx });
        return { ok: true, result };
      }

      const artifactAccessActionId = isActionFamilyId(actionId, ArtifactAccessActionIdV1Schema) ? actionId : null;
      if (artifactAccessActionId !== null) {
        if (!deps.artifactAccessAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.artifactAccessAction({ actionId: artifactAccessActionId,
          input: ArtifactAccessActionInputSchemasV1[artifactAccessActionId].parse(parsed.data), context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: ArtifactAccessActionOutputSchemasV1[artifactAccessActionId].parse(result) };
      }

      if (actionId === 'doc.read') return await executeDocReadV1(parsed.data, ctx, deps,
        options?.sameHome ?? ((left, right) => isSameHome(left, right, ctx)));
      if (actionId === 'doc.comment.reply' || actionId === 'doc.edit.propose') {
        return await executeDocDiscussionWriteV1(actionId, parsed.data, ctx, deps.discussionAction,
          options?.sameHome ?? ((left, right) => isSameHome(left, right, ctx)));
      }
      if (actionId === 'doc.edit.accept' || actionId === 'doc.edit.decline') {
        return await executeDocEditDecisionV1(actionId, parsed.data, ctx, deps,
          options?.sameHome ?? ((left, right) => isSameHome(left, right, ctx)));
      }

      const artifactActionId = isActionFamilyId(actionId, ArtifactActionIdV1Schema) ? actionId : null;
      if (artifactActionId !== null) {
        if (!deps.artifactAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const artifactInput = ArtifactActionInputSchemasV1[artifactActionId].parse(parsed.data);
        const internalKindRefusal = { ok: false as const, errorCode: 'artifact_kind_internal', error: 'artifact_kind_internal' };
        // The incumbent Inbox may read and dismiss its captured Account's private
        // notices. This does not admit ordinary private-document authoring or egress.
        const noticeAccountId = readNoticeInboxAccountIdV1(ctx);
        const noticeReadAccountId = artifactActionId === 'artifact.get' ? readNoticeInboxAccountIdV1(ctx, 'read') : noticeAccountId;
        const isNoticeInboxCaller = noticeAccountId !== null;
        const requestedApprovalKinds = new Set<string>();
        if (artifactActionId === 'artifact.list') {
          if ('kind' in artifactInput && typeof artifactInput.kind === 'string' && isApprovalArtifactKindV1(artifactInput.kind)) {
            requestedApprovalKinds.add(artifactInput.kind);
          }
          if ('kinds' in artifactInput) for (const kind of artifactInput.kinds ?? []) {
            if (isApprovalArtifactKindV1(kind)) requestedApprovalKinds.add(kind);
          }
          // Private Inbox metadata keeps the existing own-Account caller
          // admission. Scoped API/plugin callers use their approval owner.
          if (requestedApprovalKinds.size > 0 && !noticeAccountId) return internalKindRefusal;
        }
        const readOwnedNotice = (artifact: Readonly<{ ownerAccountId: string; access: string;
          publicAudience?: string; header: unknown; body: unknown }>) => {
          return readOwnedNoticeArtifactV1(artifact, noticeReadAccountId);
        };
        const isNoticeUpdateInput = artifactActionId === 'artifact.update'
          && isNoticeInboxCaller && 'header' in artifactInput
          && (artifactInput.header.kind === USAGE_NOTICE_ARTIFACT_KIND_V1
            || artifactInput.header.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1) && 'body' in artifactInput;
        // Generic documents consume the same kind exclusion as the browser. Specialized
        // owners keep their native transport; retagging cannot bypass their write policy.
        if ('header' in artifactInput && !getArtifactKindPolicyV1(artifactInput.header.kind).browserListed && !isNoticeUpdateInput
          || artifactActionId === 'artifact.publish_from_file' && 'kind' in artifactInput
            && !getArtifactKindPolicyV1(artifactInput.kind).browserListed) return internalKindRefusal;
        if ((artifactActionId === 'artifact.update' || artifactActionId === 'artifact.delete' || artifactActionId === 'artifact.export'
          || artifactActionId === 'artifact.revisions.list' || artifactActionId === 'artifact.revisions.restore')
          && 'artifactId' in artifactInput) {
          // The keyholding host opens the actual current document and admits its access.
          // The existing expected-revision writer still decides stale/current mutations.
          const opened = await deps.artifactAction({ actionId: 'artifact.get', input: { artifactId: artifactInput.artifactId }, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const refusal = readActionFailureEnvelope(opened);
          if (refusal) return refusal;
          const admitted = ArtifactActionOutputSchemasV1['artifact.get'].safeParse(opened);
          if (!admitted.success || admitted.data.artifact && admitted.data.artifact.artifactId !== artifactInput.artifactId)
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          if (!admitted.data.artifact) return { ok: false, errorCode: 'not_found', error: 'not_found' };
          if (!getArtifactKindPolicyV1(admitted.data.artifact.header.kind).browserListed || isNoticeUpdateInput) {
            const current = admitted.data.artifact;
            const notice = readOwnedNotice(current);
            if (!isNoticeUpdateInput || !notice || notice.status !== 'open'
              || !('body' in artifactInput)
              || !('header' in artifactInput)) return internalKindRefusal;
            const updated = readAccountNoticeArtifactV1({ header: artifactInput.header, body: artifactInput.body });
            const recoveredHealth = notice.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1
              && notice.healthPhase === 'recovered' && !notice.resolved;
            const settleRecovery = recoveredHealth && updated?.resolved === true
              && typeof current.body === 'string' && typeof artifactInput.body === 'string'
              && sameStrictJsonValue(JSON.parse(artifactInput.body), {
                ...AccountNoticeArtifactBodyV1Schema.parse(JSON.parse(current.body)), resolved: true });
            if (recoveredHealth && !settleRecovery || !settleRecovery && artifactInput.body !== current.body) return internalKindRefusal;
            const resolved = settleRecovery ? { resolved: true } : {};
            const dismiss = sameStrictJsonValue(artifactInput.header, { ...current.header, ...resolved, status: 'dismissed' });
            const markRead = notice.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 && !notice.resolved
              && (notice.type === 'update' || notice.type === 'mention') && notice.readAt === undefined
              && updated?.readAt !== undefined
              && sameStrictJsonValue(artifactInput.header, { ...current.header, ...resolved, readAt: updated.readAt });
            if (!dismiss && !markRead) return internalKindRefusal;
          }
          ctx.signal?.throwIfAborted();
        }
        const result = await deps.artifactAction({ actionId: artifactActionId,
          input: artifactInput, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const refusal = readActionFailureEnvelope(result);
        if (refusal) return refusal;
        if (artifactActionId === 'artifact.get') {
          const opened = ArtifactActionOutputSchemasV1['artifact.get'].parse(result);
          if (opened.artifact && !getArtifactKindPolicyV1(opened.artifact.header.kind).browserListed
            && !readOwnedNotice(opened.artifact)) return internalKindRefusal;
          return { ok: true, result: opened };
        }
        if (artifactActionId === 'artifact.list') {
          const page = ArtifactActionOutputSchemasV1['artifact.list'].parse(result);
          // Explicit approval discovery exposes headers through the same admitted
          // store. Broad document lists still use browser membership; bodies and
          // mutations remain with the specialized approval owner.
          return { ok: true, result: { ...page, items: page.items.filter(item => getArtifactKindPolicyV1(item.header.kind).browserListed
            || typeof item.header.kind === 'string' && requestedApprovalKinds.has(item.header.kind)
              && item.access === 'owner' && item.ownerAccountId === noticeAccountId) } };
        }
        return { ok: true, result: ArtifactActionOutputSchemasV1[artifactActionId].parse(result) };
      }

      const workflowActionId = isActionFamilyId(actionId, WorkflowActionIdV1Schema) ? actionId : null;
      if (workflowActionId !== null) {
        const workflowAction = deps.workflowAction;
        if (!workflowAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const workflowContext = resolveWorkflowActionContext(ctx);
        if (!workflowContext.ok) return workflowContext.error;
        ctx = workflowContext.context;
        const ownSessionTriggerRead = (actionId === 'session.trigger.list' || actionId === 'session.trigger.remove')
          && isActionCallerOwnSessionV1(ctx, readRecord(parsed.data).sessionId);
        if (isAgentCaller(ctx) && (actionId === 'session.trigger.list' || actionId === 'session.trigger.remove') && !ownSessionTriggerRead && ctx.actionCaller?.kind !== 'workflowRun'
          && ctx.actionCaller?.kind !== 'automationRun') {
          const authority = await resolveActionAgentStartContextV1(deps, ctx);
          const ceiling = typeof ctx.callerPermissionMode === 'string' ? parseAgentPermissionIntentV1Alias(ctx.callerPermissionMode) : null;
          if (!authority || !ceiling) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
          ctx = { ...ctx, agentStartContext: { ...authority, callerPermissionCeiling: ceiling } };
        }
        const common = {
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        // Keep the schema lookup correlated with the discriminant at the host
        // port. A dynamic union lookup loses that relationship in TypeScript
        // and would weaken the typed Workflow executor contract.
        const workflowId = workflowActionId;
        const result = await (async () => {
          switch (workflowId) {
            case 'workflow.definition.capture':
              return captureWorkflowDefinitionV1(parsed.data, ctx, deps);
            case 'workflow.validate':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.start':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.list':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.summaries':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.get':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.read_state.set':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.wait':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.pause':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.resume':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.cancel':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.invocations.list':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.invocations.get':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.invocations.retry':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.invocations.publish_draft':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.invocations.complete_review':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.run.delete':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.list':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.get':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.create':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.update':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.edit':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.delete':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.import':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.definition.export':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.list':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.add':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.update':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.remove':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.run_now':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'session.trigger.list':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'session.trigger.add':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'session.trigger.update':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'session.trigger.remove':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            default:
              workflowId satisfies never;
              throw new Error('unreachable_workflow_action');
          }
        })();
        const failure = readActionFailureEnvelope(result);
        if (!failure) return { ok: true, result };
        const workflowFailure = WorkflowActionFailureV1Schema.safeParse(failure);
        return workflowFailure.success
          ? workflowFailure.data
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }

      const occurrenceId = isActionFamilyId(actionId, AutomationOccurrenceActionIdSchema) ? actionId : null;
      if (occurrenceId !== null) {
        if (!deps.automationOccurrenceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.automationOccurrenceAction({ actionId: occurrenceId,
          input: AutomationOccurrenceInputSchemas[occurrenceId].parse(parsed.data), context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      const automationConversationActionId = isActionFamilyId(actionId, AutomationConversationActionIdV1Schema) ? actionId : null;
      if (automationConversationActionId !== null) {
        if (!deps.automationConversationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        if (
          ctx.actionCaller?.kind !== 'plugin'
          || typeof ctx.actionCaller.contributionLocalId !== 'string'
          || ctx.actionCaller.contributionLocalId.trim().length === 0
          || !ctx.actionCaller.materialization
          || ctx.actionCaller.materialization.pluginId !== ctx.actionCaller.pluginId
        ) {
          return {
            ok: false,
            errorCode: 'plugin_action_caller_required',
            error: 'plugin_action_caller_required',
          };
        }
        const result = await deps.automationConversationAction({
          actionId: automationConversationActionId,
          input: AutomationConversationActionInputSchemasV1[automationConversationActionId].parse(parsed.data),
          caller: ctx.actionCaller,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      // Home customization shares the global policy and terminal output boundary.
      // Account Artifact and semantic owners supply their typed refusal codes.
      if ((HOME_HUB_LAYOUT_ACTION_IDS as readonly string[]).includes(actionId)) {
        if (actionId !== 'home.reachNudge.dismiss') {
          if (!deps.homeHubArtifacts) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          try {
            if (actionId === 'home.hub.layout.update') {
              const { intent } = HomeHubLayoutUpdateInputSchema.parse(parsed.data);
              if (intent.kind === 'widget_add' || intent.kind === 'widget_size' || intent.kind === 'widget_inputs') {
                const scope = deps.widgetAccountScope?.();
                if (!scope) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
                const surface = { serverId: scope.serverId, accountId: scope.accountId, owner: { kind: 'home' as const } };
                const read = intent.kind !== 'widget_add'
                  ? WidgetSurfaceReadV1Schema.parse(await readWidgetActionSurfacePortV1(deps, surface)!.read(surface, ctx, ctx.signal)) : undefined;
                const original = intent.kind === 'widget_add' ? intent.instance
                  : read?.instances.find(value => value.instance.id === intent.instanceId)?.instance;
                const instance = intent.kind === 'widget_inputs' && original ? { ...original,
                  bindings: setWidgetInputBindingsV1(original.bindings, intent.bindings, intent.paths) } : original;
                if (!instance) return { ok: false, errorCode: 'widget_instance_not_found', error: 'widget_instance_not_found' };
                const ref = { surface, instanceId: instance.id };
                if (intent.kind === 'widget_add' || intent.kind === 'widget_inputs') {
                  const refusal = await admitWidgetInstanceConfigurationV1(deps, ref, instance, ctx);
                  if (refusal) return refusal;
                }
                if (intent.kind === 'widget_inputs') return { ok: true, result: await deps.homeHubArtifacts.apply(intent, ctx.signal) };
                const admission = await admitWidgetInstanceSizeV1(deps, ref, instance, intent.size, ctx);
                if ('ok' in admission) return admission;
                return { ok: true, result: await deps.homeHubArtifacts.apply({ ...intent,
                  ...(admission.size ? { size: admission.size } : {}) }, ctx.signal) };
              }
            }
            const result = actionId === 'home.hub.layout.get'
              ? await deps.homeHubArtifacts.describe(await deps.homeHubArtifacts.read(ctx.signal), ctx.signal)
              : await deps.homeHubArtifacts.apply(HomeHubLayoutUpdateInputSchema.parse(parsed.data).intent, ctx.signal);
            return { ok: true, result };
          } catch (error) {
            if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
              return { ok: false, errorCode: error.code, error: error.message };
            }
            throw error;
          }
        }
        if (!deps.homeHubLayoutAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.homeHubLayoutAction({ actionId: actionId as HomeHubLayoutActionId, input: parsed.data, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }
      const scopeActionId = isActionFamilyId(actionId, ScopeActionIdSchema) ? actionId : null;
      const diagnosticsActionId = isActionFamilyId(actionId, DiagnosticsActionIdSchema) ? actionId : null;
      if (diagnosticsActionId !== null) {
        return completeActionResult(deps.diagnosticsAction
          ? await deps.diagnosticsAction({ actionId: diagnosticsActionId, input: parsed.data, context: ctx })
          : { status: 'unavailable' });
      }
      if (scopeActionId !== null) {
        if (!deps.scopeAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.scopeAction({ actionId: scopeActionId, input: parsed.data, context: ctx }));
      }
      const sessionBoardActionId = isActionFamilyId(actionId, SessionBoardActionIdV1Schema) ? actionId : null;
      const pendingEditResult = await dispatchSessionPendingEdit({ actionId, parsed, ctx, deps });
      if (pendingEditResult) return pendingEditResult;
      if (actionId === 'session.pending.next') {
        return completeActionResult(deps.nextPendingSession
          ? await deps.nextPendingSession(ctx)
          : { status: 'unavailable', reason: 'no_navigation_host' });
      }
      if (actionId === 'session.pending.action.set') {
        if (!deps.sessionPendingActionSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return completeActionResult(await deps.sessionPendingActionSet({
          ...SessionPendingActionSetInputV1Schema.parse(parsed.data), context: ctx,
        }));
      }
      if (actionId === 'session.pending.withdraw') {
        if (!deps.sessionPendingWithdraw) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return completeActionResult(await deps.sessionPendingWithdraw({
          ...SessionPendingWithdrawInputV1Schema.parse(parsed.data), context: ctx,
        }));
      }
      if (actionId === 'session.pending.markHandled') {
        if (!deps.sessionPendingMarkHandled) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return completeActionResult(await deps.sessionPendingMarkHandled({
          ...SessionPendingMarkHandledInputV1Schema.parse(parsed.data), context: ctx,
        }));
      }
      if (actionId === 'session.pending.dismiss' || actionId === 'session.pending.sendAsNew') {
        const recover = actionId === 'session.pending.dismiss' ? deps.sessionPendingDismiss : deps.sessionPendingSendAsNew;
        if (!recover) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return completeActionResult(await recover({
          ...SessionPendingDeliveryRecoveryInputV1Schema.parse(parsed.data), context: ctx,
        }));
      }
      if (actionId === 'session.pending.resetStart.set') {
        if (!deps.sessionPendingResetStartSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return completeActionResult(await deps.sessionPendingResetStartSet({
          ...PendingResetStartSetInputV1Schema.parse(parsed.data), context: ctx,
        }));
      }
      if (actionId === 'session.pending.resetStart.cancel') {
        if (!deps.sessionPendingResetStartCancel) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return completeActionResult(await deps.sessionPendingResetStartCancel({
          ...PendingResetStartCancelInputV1Schema.parse(parsed.data), context: ctx,
        }));
      }
      if (actionId === 'ui.command_palette.list' || actionId === 'ui.command_palette.invoke') {
        if (!deps.uiCommandPaletteAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        return await deps.uiCommandPaletteAction({ actionId, input: parsed.data, context: ctx });
      }
      if (actionId === 'ui.pet.choose') {
        return deps.uiPetChooseAction
          ? await deps.uiPetChooseAction({ input: PetChooseInputV1Schema.parse(parsed.data), context: ctx })
          : clientActionUnavailable(actionId);
      }
      if (actionId === 'account.home_continuation.invoke') {
        return deps.accountHomeContinuationAction
          ? await deps.accountHomeContinuationAction({ actionId, input: AccountHomeContinuationInputV1Schema.parse(parsed.data), context: ctx })
          : { ok: false, errorCode: 'unsupported_action', error: 'current_account_continuation_not_mounted' };
      }
      if (actionId === 'ui.current_context.read' || actionId === 'ui.current_context.command.invoke') {
        return deps.uiCurrentContextAction
          ? await deps.uiCurrentContextAction({ actionId, input: parsed.data, context: ctx })
          : { ok: false, errorCode: 'unsupported_action', error: 'current_ui_context_not_mounted' };
      }
      if (actionId === 'ui.find') {
        return deps.uiFindAction
          ? await deps.uiFindAction({ actionId, input: parsed.data, context: ctx })
          : completeActionResult({ status: 'unavailable', reason: 'noClient' });
      }
      if (actionId === 'ui.prompts.picker.open') {
        return deps.uiPromptPickerOpen
          ? await deps.uiPromptPickerOpen({ actionId, input: parsed.data, context: ctx })
          : completeActionResult({ status: 'unavailable', reason: 'noClient' });
      }
      if (sessionBoardActionId !== null) {
        if (!deps.sessionBoardAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        let boardInput = SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[sessionBoardActionId].parse(admittedInput);
        if (sessionBoardActionId === 'session.board.item.upsert') {
          const upsert = SessionBoardItemUpsertInputV1Schema.parse(visualAdmission
            ? { ...boardInput, item: visualAdmission.effectiveItem } : boardInput);
          if (!('item' in upsert)) return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' };
          boardInput = upsert;
          // Creation supplies the whole configured widget rectangle. Existing
          // native item edits retain their independent width/height contract.
          if (upsert.expectedItemRevision === null && upsert.item.source.kind === 'widget') {
            const scope = deps.widgetAccountScope?.();
            const sessionId = upsert.sessionId ?? ctx.defaultSessionId;
            if (!scope || !sessionId) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
            const surface = { serverId: scope.serverId, accountId: scope.accountId, owner: { kind: 'sessionBoard' as const, sessionId } };
            const scopeRefusal = await admitWidgetActionSurfaceV1(deps, surface, ctx);
            if (scopeRefusal) return scopeRefusal;
            const instance = upsert.item.source.instance;
            const ref = { surface, instanceId: instance.id };
            const configurationRefusal = await admitWidgetInstanceConfigurationV1(deps, ref, instance, ctx);
            if (configurationRefusal) return configurationRefusal;
            if (sessionBoardActionUsesLayoutV1(sessionBoardActionId, upsert)) {
              const placement = upsert.placement;
              if (!placement) return { ok: false, errorCode: 'widget_placement_required', error: 'widget_placement_required' };
              const height = upsert.item.height.mode === 'fixed' ? upsert.item.height.size : upsert.item.height.fallback;
              const requested = placement.width === undefined ? undefined : WIDGET_SIZE_ORDER_V1.find(size => {
                const footprint = getWidgetSizeFootprintV1('sessionBoard', size);
                return footprint !== undefined && footprint.width === placement.width && footprint.height === height;
              });
              if (placement.width !== undefined && !requested) return { ok: false, errorCode: 'widget_size_unsupported', error: 'widget_size_unsupported' };
              const admission = await admitWidgetInstanceSizeV1(deps, ref, instance, requested, ctx);
              if ('ok' in admission) return admission;
              const rectangle = admission.size && materializeSessionBoardWidgetCreationFootprintV1(upsert, admission.size);
              if (!rectangle) return { ok: false, errorCode: 'widget_size_unsupported', error: 'widget_size_unsupported' };
              boardInput = rectangle;
            }
          }
        }
        const result = await deps.sessionBoardAction({
          actionId: sessionBoardActionId,
          input: boardInput,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const boundSessionId = boardInput.sessionId ?? ctx.defaultSessionId ?? undefined;
        const validated = parseSessionBoardActionPortResultV1(sessionBoardActionId, boardInput, result, {
          ...(boundSessionId ? { expectedSessionId: boundSessionId } : {}),
          ...(ctx.serverId ? { expectedServerId: ctx.serverId } : {}),
        });
        if (!validated.success) {
          return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        }
        return validated.kind === 'failure'
          ? validated.data as Extract<ActionExecuteResult, Readonly<{ ok: false }>>
          : { ok: true, result: { ...validated.data,
              // Transport recovery stays bound to the issued local profile. A
              // successful public acknowledgement uses the already-proved Home
              // identity so another device can resolve it without our profile.
              serverId: ctx.serverIdentityId ?? validated.data.serverId,
              ...(visualAdmission?.effectiveNetwork && (visualAdmission.effectiveItem.source.kind === 'hostedHtml'
                || visualAdmission.effectiveItem.source.kind === 'widget') ? { effectiveNetwork: visualAdmission.effectiveNetwork,
                ...(visualAdmission.networkOffNotice ? { notices: [{ code: 'agent_html_network_off' as const }] } : {}) } : {}) } };
      }

      // Presentation is deliberately a single host-stamped current-Session
      // operation. The incumbent Session UI service owns binding, currentness,
      // dedupe and acknowledgement; the Action layer only validates the strict
      // semantic intent and preserves the admitted runtime principal.
      if (actionId === 'session.presentation.apply') {
        if (!deps.currentSessionPresentationApply) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.currentSessionPresentationApply({
          input: CurrentSessionPresentationActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      // Passing settles the current runtime's original through C2; it is not a
      // Home resource mutation and must not enter the HTTP Discussion adapter.
      if (actionId === 'discussion.pass') {
        const source = SessionInputSourceSessionV1Schema.safeParse(ctx.sessionInputSource);
        if (!source.success || !source.data.discussionAddressing || !source.data.sourceInputId
          || source.data.discussionAddressing.discussionId !== data.discussionId
          || (ctx.defaultSessionId && ctx.defaultSessionId !== source.data.sourceSessionId)
          || (ctx.actionCaller?.kind === 'session' && ctx.actionCaller.sessionId !== source.data.sourceSessionId)) {
          return { ok: false, errorCode: 'session_reply_source_unavailable', error: 'session_reply_source_unavailable' };
        }
        if (!deps.sessionMessageReply) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const sessionId = source.data.sourceSessionId;
        const serverId = resolveServerIdForSession(deps, ctx, sessionId);
        return completeActionResult(await deps.sessionMessageReply({ context: ctx, sessionId,
          requestLocalId: source.data.sourceInputId, reply: { kind: 'pass' },
          ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }

      // One family branch for Discussion intents. Context, availability,
      // settings, approval, interception and observation already ran above; the
      // host seals/opens content through the Discussion key and the canonical
      // result is validated once at the terminal output boundary.
      const discussionActionId = isActionFamilyId(actionId, DiscussionActionIdV1Schema) ? actionId : null;
      if (discussionActionId !== null) {
        if (discussionActionId === 'discussion.second_opinion.start') {
          return executeDiscussionSecondOpinionV1(parsed.data, deps, ctx, executeHostChild,
            serverId => !!ctx.serverId && isSameHome(serverId, ctx.serverId, ctx));
        }
        if (!deps.discussionAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        if (discussionActionId === 'discussion.create') {
          const create = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.create'].parse(parsed.data);
          if (create.anchor?.kind === 'doc'
            && (!ctx.serverId || !isSameHome(create.anchor.doc.ref.serverId, ctx.serverId, ctx))) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
        }
        if (discussionActionId === 'discussion.invite') {
          const invite = DiscussionInviteInputV1Schema.parse(parsed.data);
          const reservation = ctx.actionCaller?.kind === 'workflowRun' ? ctx.actionCaller.discussionModelReservation : undefined;
          if (reservation && (invite.participant.kind !== 'model' || invite.discussionId !== reservation.discussionId
            || invite.participant.participantSlotId !== reservation.participantSlotId)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          if (invite.participant.kind === 'model'
            && (!ctx.serverId || !isSameHome(invite.participant.launch.executionTarget.serverId, ctx.serverId, ctx))) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
        }
        const result = await deps.discussionAction({
          actionId: discussionActionId,
          input: DISCUSSION_ACTION_INPUT_SCHEMAS_V1[discussionActionId].parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        if (failure) return failure;
        if (discussionActionId === 'discussion.invite' && ctx.actionCaller?.kind === 'workflowRun'
          && ctx.actionCaller.discussionModelReservation) {
          // Same invitation policy/approval/replay, narrower effect custody.
          return { ok: true, result };
        }
        if (discussionActionId === 'discussion.invite') {
          const invite = DiscussionInviteInputV1Schema.parse(parsed.data);
          if (invite.participant.kind === 'model') {
            const reservation = DiscussionInviteResponseV1Schema.safeParse(result);
            if (!reservation.success) {
              return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            }
            const modelParticipant = reservation.data.modelParticipant;
            if (reservation.data.discussionId !== invite.discussionId || !modelParticipant
              || modelParticipant.participant.participantSlotId !== invite.participant.participantSlotId) {
              return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            }
            const started = await executeHostChild('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
              ...modelParticipant.launch,
              // The requested target was proved to be this captured Home before
              // reservation. A saved device-local connection alias is not a new
              // Machine/model selection and cannot route another client's retry.
              executionTarget: { ...modelParticipant.launch.executionTarget, serverId: ctx.serverId },
              creationKey: modelParticipant.participant.participantSlotId,
              discussionParticipant: { discussionId: invite.discussionId,
                participantSlotId: modelParticipant.participant.participantSlotId },
              initialTriggers: [],
            })), ctx);
            if (!started.ok || isDeferredApprovalResult(started)) return started;
            const sessionStart = SessionSpawnNewActionResultV1Schema.safeParse(started.result);
            if (!sessionStart.success || (sessionStart.data.type === 'success' && modelParticipant.sessionId !== null
              && modelParticipant.sessionId !== sessionStart.data.sessionId)) {
              return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            }
            return { ok: true, result: { ...reservation.data,
              modelParticipant: { ...modelParticipant,
                sessionId: sessionStart.data.type === 'success' ? sessionStart.data.sessionId : modelParticipant.sessionId },
              sessionStart: readSessionSpawnNewActionResultV1(sessionStart.data) } };
          }
        }
        let ownedSessions: readonly DiscussionOwnedSessionV1[] = [];
        if (discussionActionId === 'discussion.participant.remove') {
          const removal = DiscussionParticipantRemoveInputV1Schema.parse(parsed.data);
          const response = DiscussionRemoveParticipantResponseV1Schema.safeParse(result);
          if (!response.success || response.data.discussionId !== removal.discussionId) {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
          const owned = response.data.ownedSession;
          if (owned && (owned.discussionId !== removal.discussionId
            || (removal.participant.kind === 'model' ? owned.participantSlotId !== removal.participant.participantSlotId
              : removal.participant.kind !== 'session' || owned.sessionId !== removal.participant.sessionId))) {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
          if (owned) ownedSessions = [owned];
        } else if (discussionActionId === 'discussion.archive') {
          const response = DiscussionDetailsResultV1Schema.safeParse(result);
          const discussionId = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.archive'].parse(parsed.data).discussionId;
          if (!response.success || response.data.discussion.id !== discussionId
            || response.data.ownedSessions?.some(owned => owned.discussionId !== discussionId)) {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
          ownedSessions = response.data.ownedSessions ?? [];
        }
        for (const owned of ownedSessions) {
          // Resource membership does not confer Session control. These children
          // retain ordinary authority, approval and lifecycle admission.
          if (!ctx.serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          const exactTarget = [{ serverId: ctx.serverId, sessionId: owned.sessionId }];
          const stopped = await executeHostChild('session.stop', { sessionId: owned.sessionId }, { ...ctx,
            sessionTargetsV1: { actionId: 'session.stop', field: 'sessionId', targets: exactTarget, selector: false } });
          if (!stopped.ok || isDeferredApprovalResult(stopped)) return stopped;
          const stop = SessionStopResultSchema.safeParse(stopped.result);
          if (!stop.success || !isSessionStopConfirmed(stop.data)) {
            return { ok: false, errorCode: 'session_stop_unconfirmed', error: 'session_stop_unconfirmed' };
          }
          const archived = await executeHostChild('session.archive', { sessionId: owned.sessionId }, { ...ctx,
            sessionTargetsV1: { actionId: 'session.archive', field: 'sessionId', targets: exactTarget, selector: false } });
          if (!archived.ok || isDeferredApprovalResult(archived)) return archived;
        }
        return { ok: true, result };
      }
      const dispatchMachineManagedResult = await dispatchMachineManaged({ actionId, deps, admittedInput, ctx, isDeferredApprovalResult, retireOpenManagedDeleteApprovals });
      if (dispatchMachineManagedResult !== null) return dispatchMachineManagedResult;

      const machinePoolActionId = isActionFamilyId(actionId, MachinePoolActionIdV1Schema) ? actionId : null;
      const operationActionId = isActionFamilyId(actionId, ActionOperationActionIdV1Schema) ? actionId : null;
      if (operationActionId !== null) {
        if (!deps.actionOperationAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.actionOperationAction({
          actionId: operationActionId,
          input: ActionOperationActionInputSchemasV1[operationActionId].parse(parsed.data),
          context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const projectWorkerActionId = isActionFamilyId(actionId, ProjectWorkerActionIdV1Schema) ? actionId : null;
      if (projectWorkerActionId !== null) {
        if (!deps.projectWorkerAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.projectWorkerAction({
          actionId: projectWorkerActionId,
          input: ProjectWorkerActionInputSchemasV1[projectWorkerActionId].parse(parsed.data),
          context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        // Not-owned is a strict review fact, not a transport/Action failure envelope.
        if (projectWorkerActionId === 'projects.worker.copy.inspect') {
          const review = ProjectWorkerCopyInspectResultV1Schema.safeParse(result);
          if (review.success) return { ok: true, result: review.data };
        }
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const dispatchMachineControls1Result = await dispatchMachineControls1({ actionId, deps, parsed, ctx, isSameHome, approvalScope, executeHostChild });
      if (dispatchMachineControls1Result !== null) return dispatchMachineControls1Result;
      const usageSourceActionId = isActionFamilyId(actionId, UsageSourceActionIdSchema) ? actionId : null;
      if (usageSourceActionId !== null) {
        const id = usageSourceActionId;
        const input = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[id].parse(parsed.data);
        if (ctx.serverId && input.serverId !== ctx.serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.usageSourceAction) return id === 'usage.sources.dismiss'
          ? { ok: true, result: { status: 'unavailable' } }
          : { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const request = { actionId: id, input } as UsageSourceActionRequest;
        const result = await deps.usageSourceAction(request, ctx);
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const connectedServiceActionId = isActionFamilyId(actionId, ConnectedServiceConfigurationActionIdV1Schema) ? actionId : null;
      if (connectedServiceActionId !== null) {
        if (!deps.connectedServiceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.connectedServiceAction({ actionId: connectedServiceActionId, input: admittedInput, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const dispatchMachineControls2Result = await dispatchMachineControls2({ machinePoolActionId, deps, actionId, parsed, ctx, isSameHome, executeHostChild });
      if (dispatchMachineControls2Result !== null) return dispatchMachineControls2Result;

      // One family branch for the three Temporary computer activation intents.
      // The declared serverTransport rows name the exact registered creator
      // routes; the bound adapter owns the captured Home scope and substitutes
      // the activation id.
      const ephemeralRunnerActionId = isActionFamilyId(actionId, EphemeralRunnerActionIdV1Schema) ? actionId : null;
      if (ephemeralRunnerActionId !== null) {
        if (!deps.ephemeralRunnerAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.ephemeralRunnerAction({
          actionId: ephemeralRunnerActionId,
          input: EphemeralRunnerActionInputSchemasV1[ephemeralRunnerActionId].parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      // One branch for the whole Session-access family. Grants, Team context,
      // responsibility and public links are one Home decision, so a per-intent
      // port would give the same concept several hosts to keep in step.
      if (isSessionAccessActionId(actionId)) {
        if (!deps.sessionAccessAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        // `parsed.data` already satisfied this row's strict domain input.
        const result = await deps.sessionAccessAction({
          actionId,
          input: parsed.data,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      // One branch for Home governance and Teams. Both are decided by the same
      // Home transaction, so a second port here would give the same concept two
      // hosts to keep in step.
      if (actionId === 'teams.credentials.usage.export') {
        return await executeTeamCredentialUsageExport(admittedInput, deps.homeDomainAction, ctx);
      }
      if (isPublicProfilePreparationActionIdV1(actionId)) {
        if (actionId === 'account.public_profile.preview') {
          return ctx.publicProfilePreviewResult ?? { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
        const effect = ctx.publicProfilePreparedAction;
        if (!effect || !deps.publicProfileActions) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        return await executePublicProfileAction(effect, deps.publicProfileActions, ctx, () => executeHostChild(
          'account.public_profile.refresh', {}, { ...ctx, bypassApprovals: false, publicProfilePreparedAction: undefined,
            publicProfilePreviewResult: undefined, reviewPublicProfilePreparedAction: undefined,
            presentUserConfirmation: undefined, approvedActionReplay: undefined }));
      }
      if (actionId === 'secrets.shared.reveal') {
        if (!deps.savedSecretRevealAction) return clientActionUnavailable(actionId);
        // The registered row already admitted this exact closed input.
        const result = await deps.savedSecretRevealAction({ input: parsed.data as import('../account/settings/savedSecretResourceActionsV1.js').SharedSavedSecretRevealInputV1, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (isHomeDomainActionIdV1(actionId)) {
        if (!deps.homeDomainAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        // `parsed.data` already satisfied this row's strict domain input; the
        // family adds no second validation of the same declaration.
        const result = await deps.homeDomainAction({
          actionId,
          input: parsed.data,
          context: ctx,
          ...(actionId === 'session.sections.archive' ? { archiveSession: async (sessionId: string) => {
            const childContext = { ...ctx, bypassApprovals: false, approvedActionReplay: undefined,
              presentUserConfirmation: undefined, sessionTargetsV1: undefined };
            const archived = await executeHostChild('session.archive', { sessionId, alsoArchiveReports: false }, childContext);
            // Membership carries no live status. Let ordinary archive admission
            // decide, then use the same confirmed Stop child as report archive.
            return !archived.ok && archived.errorCode === 'session_active'
              ? await stopThenArchiveSession(sessionId, childContext) : archived;
          } } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (isTeamMembershipHistoryActionIdV1(actionId)) {
        if (!deps.teamMembershipHistoryAction) return clientActionUnavailable(actionId);
        const result = await deps.teamMembershipHistoryAction({ actionId,
          input: TeamMembershipHistoryInputV1Schema.parse(admittedInput), context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (isVoiceConversationActionId(actionId)) {
        if (!deps.voiceConversationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.voiceConversationAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (isSettingsDeclarationActionIdV1(actionId) || isActionPolicyActionId(actionId)) {
        if (!deps.settingsDeclarationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.settingsDeclarationAction({ actionId, input: parsed.data, context: ctx,
          executeOwnerAction: request => executeInvocation(request.actionId, request.input, { ...request.context, bypassApprovals: false }),
        });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (isAppShellActionId(actionId)) {
        if (!deps.appShellAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.appShellAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (isNotificationConfigurationActionId(actionId)) {
        if (!deps.notificationConfigurationAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.notificationConfigurationAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (actionId === 'bugreport.submit') {
        if (!deps.bugReportSubmit) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:bugreport.submit' };
        const result = await deps.bugReportSubmit(BugReportSubmitInputSchema.parse(parsed.data), ctx);
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (isAppUpdateActionId(actionId)) {
        if (!deps.appUpdateAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.appUpdateAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (isUpdatesActionId(actionId)) {
        if (!deps.updatesAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.updatesAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (actionId === 'links.openExternal') {
        if (!deps.externalUrlOpen) return clientActionUnavailable(actionId);
        ctx.signal?.throwIfAborted();
        const input = ExternalUrlOpenInputSchema.parse(parsed.data);
        const result = await deps.externalUrlOpen({ url: input.url, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (actionId === 'clipboard.write') {
        if (!deps.clipboardWrite) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        ctx.signal?.throwIfAborted();
        const input = ClipboardWriteInputSchema.parse(parsed.data);
        const result = await deps.clipboardWrite({ text: input.text, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      const webhookActionId = isActionFamilyId(actionId, PluginWebhookActionIdV1Schema) ? actionId : null;
      if (webhookActionId !== null) {
        if (!deps.pluginWebhookAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.pluginWebhookAction({
          actionId: webhookActionId,
          input: PluginWebhookActionInputSchemasV1[webhookActionId].parse(parsed.data),
          caller: ctx.actionCaller ?? { kind: 'host' },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (isPluginDevLoopActionIdV1(actionId)) {
        if (!deps.pluginsDevLoopAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.pluginsDevLoopAction({
          actionId,
          input: parsed.data,
          context: ctx,
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      const npmRegistryProfileActionId = isActionFamilyId(actionId, NpmRegistryProfileActionIdV1Schema) ? actionId : null;
      if (npmRegistryProfileActionId !== null) {
        if (!deps.npmRegistryProfileAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.npmRegistryProfileAction({ actionId: npmRegistryProfileActionId,
          input: NpmRegistryProfileActionInputSchemasV1[npmRegistryProfileActionId].parse(parsed.data), context: ctx }));
      }

      const pluginAccountAdministrationActionId = isActionFamilyId(actionId, PluginAccountAdministrationActionIdSchema) ? actionId : null;
      if (pluginAccountAdministrationActionId !== null) {
        if (!deps.pluginAccountAdministrationAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.pluginAccountAdministrationAction({ actionId: pluginAccountAdministrationActionId,
          input: PluginAccountAdministrationActionInputSchemas[pluginAccountAdministrationActionId].parse(parsed.data), context: ctx }));
      }

      const pluginSettingsAdministrationActionId =
        isActionFamilyId(actionId, PluginSettingsAdministrationActionIdV1Schema) ? actionId : null;
      const executionOriginActionId = isActionFamilyId(actionId, PluginExecutionOriginActionIdSchema) ? actionId : null;
      if (executionOriginActionId !== null) {
        if (!deps.pluginExecutionOriginAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.pluginExecutionOriginAction({ actionId: executionOriginActionId,
          input: PluginExecutionOriginActionInputSchemas[executionOriginActionId].parse(parsed.data), context: ctx }));
      }
      if (pluginSettingsAdministrationActionId !== null) {
        if (!deps.pluginSettingsAdministrationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const settingsActionId = pluginSettingsAdministrationActionId;
        const result = await deps.pluginSettingsAdministrationAction({
          actionId: settingsActionId,
          input: PluginSettingsAdministrationActionInputSchemasV1[settingsActionId].parse(parsed.data),
          context: ctx,
        });
        return completeActionResult(result);
      }
      const dispatchMachineControls3Result = await dispatchMachineControls3({ actionId, deps, parsed, ctx, isSameHome });
      if (dispatchMachineControls3Result !== null) return dispatchMachineControls3Result;
      const dispatchAccountSecurityResult = await dispatchAccountSecurity({ actionId, deps, parsed, ctx, options });
      if (dispatchAccountSecurityResult !== null) return dispatchAccountSecurityResult;

      if (actionId === 'capture.view') {
        // The mounted viewer consumes this live-only approval result; source
        // currentness and transport admission remain with the capture owner.
        return completeActionResult({ admitted: true, sourceId: data.sourceId, sourceOccurrenceId: data.sourceOccurrenceId });
      }

      if (isRuntimeActionIdV1(actionId)) {
        const result = await dispatchRuntimeAction({
          actionId,
          input: parsed.data,
          context: ctx,
          runtimeActionExecute: deps.runtimeActionExecute,
          executeCanonicalAction: (nestedActionId, nestedInput) => executeHostChild(nestedActionId, nestedInput, ctx),
        });
        return completeActionResult(result);
      }

      if (isScmActionId(actionId)) {
        if (!deps.scmActionExecute) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.scmActionExecute({
          actionId,
          input: parsed.data,
          context: ctx,
          executeCanonicalAction: async (nestedActionId, nestedInput, options) => {
            // Only detached Run control is Machine-bound. A retained, separately
            // admitted Session namespace keeps the incumbent Session RPC route.
            const nestedContext = nestedActionId.startsWith('execution.run.')
              && !readNonEmptyString(readRecord(nestedInput).sessionId)
              && ctx.externalActionTarget?.kind === 'machine'
              ? { ...ctx, executionRunTargetMachineId: ctx.externalActionTarget.machineId } : ctx;
            return await executeHostChild(nestedActionId, nestedInput, {
              ...withScmRefineInputAuthorizationV1(nestedContext, options?.scmRefineInputAuthorization),
              ...(options?.requiredContributedActionDangerLevel
                ? { requiredContributedActionDangerLevel: options.requiredContributedActionDangerLevel } : {}),
              ...(nestedActionId === 'session.message.send' && options?.sessionMessageDisplayText !== undefined
                ? { sessionMessageDisplayText: options.sessionMessageDisplayText } : {}),
              ...(nestedActionId === 'session.message.send' && options?.sessionMessageScmWalkthroughQuestion !== undefined
                ? { sessionMessageScmWalkthroughQuestion: options.sessionMessageScmWalkthroughQuestion } : {}),
            });
          },
        });
        return completeActionResult(result);
      }

      if (isFilesystemActionId(actionId)) {
        if (!deps.filesystemActionExecute) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        return completeActionResult(await deps.filesystemActionExecute({ actionId, input: parsed.data, context: ctx }));
      }
      const dispatchReviewDispatch2Result = await dispatchReviewDispatch2({ actionId, parsed, ctx, executeHostChild, data, deps, startExecutionRunWithSelection });
      if (dispatchReviewDispatch2Result !== null) return dispatchReviewDispatch2Result;
      const dispatchAgentsSubagents1Result = await dispatchAgentsSubagents1({ actionId, data, parsed, ctx, deps, startExecutionRunWithSelection });
      if (dispatchAgentsSubagents1Result !== null) return dispatchAgentsSubagents1Result;

        if (actionId === 'action.spec.search') {
          return {
            ok: true,
            result: {
              actionSpecs: searchSerializedActionSpecsForSurface({
                surface: ctx.surface ?? null,
                includeOutputSchema: ctx.surface !== 'agent' && ctx.surface !== 'mcp' && ctx.surface !== 'cli',
                query: typeof data.query === 'string' ? data.query : '',
                limit: typeof data.limit === 'number' ? data.limit : undefined,
                isActionEnabled: (id) => !credentialScopeFailure(id, ctx, undefined, true) && isActionEnabled(getActionSpec(id), ctx),
                additionalDefinitions: listContributedActionDefinitions().filter((definition) => (
                  isContributedActionDefinitionEnabled(definition, ctx)
                )),
              }).map(projectActionDefinitionSummaryForExternalDiscovery),
            },
          };
        }

        if (actionId === 'action.spec.get') {
          const requestedId = String(data.id);
          const schemaPath = typeof data.schemaPath === 'string' ? data.schemaPath : undefined;
          const includeOutputSchema = schemaPath?.startsWith('/outputSchema') === true || (typeof data.includeOutputSchema === 'boolean'
            ? data.includeOutputSchema
            : ctx.surface !== 'agent' && ctx.surface !== 'mcp' && ctx.surface !== 'cli');
          const projectDiscovery = (definition: Parameters<typeof projectActionSpecSchemaSections>[0]): ActionExecuteResult => {
            const scope = deps.widgetAccountScope?.();
            const sessionId = ctx.defaultSessionId;
            const invocationContext = sessionId ? { sessionId,
              ...(scope ? { widgetSurface: { serverId: scope.serverId, accountId: scope.accountId,
                owner: { kind: 'sessionBoard' as const, sessionId } } } : {}) } : undefined;
            try {
              return { ok: true, result: {
                ...(schemaPath !== undefined || ctx.surface === 'agent' || ctx.surface === 'mcp' || ctx.surface === 'cli'
                  ? projectActionSpecSchemaSections(definition, schemaPath) : { actionSpec: definition }),
                ...(invocationContext ? { invocationContext } : {}),
              } };
            } catch (error) {
              if (error instanceof Error && error.message === 'invalid_schema_path') {
                return actionInputIssueFailure({ code: 'invalid_schema_path', path: ['schemaPath'] });
              }
              throw error;
            }
          };
          let requestedSpec: ActionSpec | null = null;
          try { requestedSpec = getActionSpec(requestedId as ActionId); } catch { /* May be contributed. */ }
          if (requestedSpec) {
            const credentialFailure = credentialScopeFailure(requestedId, ctx, undefined, true);
            if (credentialFailure) return credentialFailure;
            const requestedAvailability = resolveAvailabilityForContext(requestedSpec, ctx);
            if (requestedAvailability ? !requestedAvailability.available : !isActionEnabled(requestedSpec, ctx)) {
              return actionDisabled(requestedAvailability);
            }
            return projectDiscovery(projectActionDefinitionForExternalDiscovery(
              actionSpecToActionDefinitionV1(requestedSpec, {
                surface: ctx.surface ?? null,
                includeOutputSchema,
              }),
            ));
          } else {
            const contributedDefinition = getContributedActionDefinition(requestedId, ctx);
            if (!contributedDefinition) {
              return actionInputIssueFailure({ code: 'unknown_action', path: ['id'] });
            }
            const credentialFailure = credentialScopeFailure(requestedId, ctx, undefined, true);
            if (credentialFailure) return credentialFailure;
            if (!isContributedActionDefinitionEnabled(contributedDefinition, ctx)) {
              return actionDisabled(null);
            }
            // Contributed listings carry no schemas; read this one on demand.
            const schemas = await deps.readContributedActionSchemas?.(requestedId, ctx.signal) ?? null;
            if (!schemas) {
              return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
            }
            const { outputSchema: _summaryOutputSchema, ...contributedMetadata } = contributedDefinition;
            return projectDiscovery(projectActionDefinitionForExternalDiscovery({
              ...contributedMetadata,
              kindVersion: 1,
              inputSchema: { ...schemas.inputSchema },
              ...(includeOutputSchema && schemas.outputSchema !== undefined ? { outputSchema: { ...schemas.outputSchema } } : {}),
            }));
          }
        }

        if (actionId === 'action.options.resolve') {
          let actionIdRaw = normalizeId(data.actionId);
          let optionsConsumer: ReturnType<typeof InputOptionsConsumerV1Schema.parse> | undefined;
          const fieldPath = normalizeId(data.fieldPath);
          const directOptionsSourceId = normalizeId(data.optionsSourceId);
          let optionsSourceId = directOptionsSourceId;
          let admittedInputTypeSource = false;
          // The picked values an admission needs answered; every path below narrows to them.
          const optionValues = Array.isArray(data.values) ? data.values as readonly JsonValue[] : undefined;
          const resolveTypedFieldOptions = async (field: Parameters<typeof resolveTypedInputFieldOptions>[0]['field'], ownerId: string): Promise<ActionExecuteResult | null> => {
            if (!field.inputType || 'hostType' in field.inputType) return null;
            if (!deps.resolveInputType && deps.readAdmittedInputTypeOptions) {
              const result = await deps.readAdmittedInputTypeOptions({ input: data, context: ctx });
              const failure = readActionFailureEnvelope(result);
              if (failure) return failure;
              const parsed = getActionSpec('action.options.resolve').outputSchema!.safeParse(result);
              return parsed.success ? { ok: true, result: parsed.data }
                : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            }
            const resolved = await resolveTypedInputFieldOptions({ field, deps, ctx,
              actionId: ownerId as ActionId, input: { ...readRecord(data.draftInput), ...data },
              consumer: optionsConsumer, ...(optionValues ? { values: optionValues } : {}),
              readFailure: readActionFailureEnvelope, resolveSessionId: resolveSessionIdFromInput, reviewScope: reviewScopeForInput });
            return resolved.ok ? { ok: true, result: { actionId: ownerId, fieldPath,
              optionsSourceId: resolved.optionsSourceId === null ? null : readInputFieldOptionsSourceId(field) ?? null,
              options: filterResolvedActionOptions(resolved.result, data) } } : resolved;
          };

          const discoveryGrant = ctx.externalActionCredential?.grant;
          if (discoveryGrant && discoveryGrant.actions !== null && directOptionsSourceId && !parseInputTypeOptionsSourceId(directOptionsSourceId)) {
            const visibleOwner = listActionSpecs().some((candidate) => (
              (!actionIdRaw || candidate.id === actionIdRaw)
              && isActionEnabled(candidate, ctx)
              && !credentialScopeFailure(candidate.id, ctx, undefined, true)
              && candidate.inputHints?.fields.some((field) => field.optionsSourceId === directOptionsSourceId)
            ));
            if (!visibleOwner) {
              return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', details: { reason: 'action_not_granted' } };
            }
          }

          if (data.consumer !== undefined) {
            const consumer = InputOptionsConsumerV1Schema.parse(data.consumer);
            const consumingActionId = inputOptionsConsumerActionId(consumer);
            if ((actionIdRaw && actionIdRaw !== consumingActionId) || !fieldPath) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
            actionIdRaw = consumingActionId;
            const grantFailure = credentialScopeFailure(consumingActionId, ctx, undefined, true);
            if (grantFailure) return grantFailure;
            if (!isActionEnabled(getActionSpec(consumingActionId), ctx)) return actionDisabled(null);
            const { resolveInputOptionsConsumerField } = await import('../inputs/inputOptionsConsumerResolver.js');
            const field = await resolveInputOptionsConsumerField({ consumer, fieldPath, deps, context: ctx });
            if (!field) return { ok: false, errorCode: 'input_type_consumer_unavailable', error: 'input_type_consumer_unavailable' };
            if ('ok' in field) return field;
            optionsConsumer = consumer;
            if (field.connectedAccountOptions && consumer.kind === 'widget') {
              const options = await deps.widgetConnectedAccountOptions?.({ consumer, fieldPath, context: ctx });
              if (!options) return { ok: false, errorCode: 'widget_connected_account_options_unavailable', error: 'widget_connected_account_options_unavailable' };
              if ('ok' in options) return options;
              return { ok: true, result: { actionId: consumingActionId, fieldPath, optionsSourceId: null,
                options: filterResolvedActionOptions([...options], data) } };
            }
            const typedOptions = await resolveTypedFieldOptions(field, consumingActionId);
            if (typedOptions) return typedOptions;
            const staticOptions = serializeActionFieldOptions(field);
            if (field.options !== undefined) return { ok: true, result: { actionId: consumingActionId, fieldPath,
              optionsSourceId: null, options: filterResolvedActionOptions(staticOptions, data) } };
            optionsSourceId = readInputFieldOptionsSourceId(field) ?? '';
            admittedInputTypeSource = field.inputType !== undefined;
          } else if (actionIdRaw && fieldPath) {
            const credentialFailure = credentialScopeFailure(actionIdRaw, ctx, undefined, true);
            if (credentialFailure) return credentialFailure;
            let contributedDefinition: ActionDefinitionSummaryV1 | null = null;
            try {
              getActionSpec(actionIdRaw as ActionId);
            } catch {
              contributedDefinition = getContributedActionDefinition(actionIdRaw, ctx);
              if (!contributedDefinition) {
                return actionInputIssueFailure({ code: 'unknown_action', path: ['actionId'] });
              }
            }
            if (contributedDefinition) {
              if (!isContributedActionDefinitionEnabled(contributedDefinition, ctx)) {
                return actionDisabled(null);
              }
              const field = findActionInputFieldHint(contributedDefinition, fieldPath);
              if (!field) {
                // Contributed JSON Schema does not define the Action options
                // protocol. Only explicit inputHints options are representable.
                return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
              }
              const typedOptions = await resolveTypedFieldOptions(field, contributedDefinition.id);
              if (typedOptions) return typedOptions;
              const staticOptions = serializeActionFieldOptions(field);
              if (field.options !== undefined) {
                return {
                  ok: true,
                  result: {
                    actionId: contributedDefinition.id,
                    fieldPath,
                    optionsSourceId: null,
                    options: filterResolvedActionOptions(staticOptions, data),
                  },
                };
              }
              optionsSourceId = readInputFieldOptionsSourceId(field) ?? '';
              if (!optionsSourceId) return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
              admittedInputTypeSource = field.inputType !== undefined;
            } else {
            const requestedSpec = getActionSpecForCatalogSurface({
              id: actionIdRaw as ActionId,
              surface: ctx.surface ?? null,
              isActionEnabled: (id) => isActionEnabled(getActionSpec(id), ctx),
            });
            if (!requestedSpec) {
              const disabledSpec = getActionSpec(actionIdRaw as ActionId);
              return actionDisabled(resolveAvailabilityForContext(disabledSpec, ctx));
            }
            const field = findActionInputFieldHint(requestedSpec, fieldPath);
            if (!field) {
              return actionInputIssueFailure({ code: 'unknown_field', path: ['fieldPath'] });
            }

            const typedOptions = await resolveTypedFieldOptions(field, requestedSpec.id);
            if (typedOptions) return typedOptions;

            const staticOptions = serializeActionFieldOptions(field);

            if (field.options !== undefined) {
              return {
                ok: true,
                result: {
                  actionId: requestedSpec.id,
                  fieldPath,
                  optionsSourceId: null,
                  options: filterResolvedActionOptions(staticOptions, data),
                },
              };
            }

            optionsSourceId = readInputFieldOptionsSourceId(field) ?? directOptionsSourceId;
            admittedInputTypeSource = field.inputType !== undefined;
            }
          }

          if (parseInputTypeOptionsSourceId(optionsSourceId) && !admittedInputTypeSource) {
            return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
          }

          if (!optionsSourceId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }

          const draftInput = readRecord(data.draftInput);
          const dependencyInput: Record<string, unknown> = {
            ...draftInput,
            ...data,
            // Only the reviewed outer hint path selects a field-bound source.
            fieldPath,
          };
          const backendTargetKeys = Array.isArray(dependencyInput.backendTargetKeys)
            ? dependencyInput.backendTargetKeys.filter((value): value is string => typeof value === 'string')
            : [];
          if (!normalizeId(dependencyInput.backendTargetKey) && backendTargetKeys.length === 1) {
            dependencyInput.backendTargetKey = backendTargetKeys[0];
          }
          const requiresErgonomicRunTarget = (
            actionIdRaw === 'subagents.plan.start'
            || actionIdRaw === 'subagents.delegate.start'
            || actionIdRaw === 'voice_agent.start'
          ) && (
            optionsSourceId === 'agents.models.available'
            || optionsSourceId === 'agents.config_options.available'
            || optionsSourceId === 'sessions.spawn.connected_services.available'
          );
          if (requiresErgonomicRunTarget && !normalizeId(dependencyInput.backendTargetKey)) {
            return {
              ok: false,
              errorCode: 'missing_option_dependency',
              error: 'Select one backend target in draftInput before resolving dependent options.',
              details: {
                requiredDraftPath: 'backendTargetKeys',
                example: { draftInput: { backendTargetKeys: ['agent:pi'] } },
              },
            };
          }

          const dynamic = await resolveInputOptions({
            readFailure: readActionFailureEnvelope,
            resolveSessionId: resolveSessionIdFromInput,
            reviewScope: reviewScopeForInput,
            deps,
            ctx,
            actionId: actionIdRaw ? actionIdRaw as ActionId : null,
            optionsSourceId,
            input: dependencyInput,
            consumer: optionsConsumer,
            ...(optionValues ? { values: optionValues } : {}),
            includeSpawnModelCatalog: actionIdRaw === 'session.spawn_new' && fieldPath === 'modelSelection',
          });
          if (!dynamic.ok) return dynamic;

          return {
            ok: true,
            result: {
              actionId: actionIdRaw || null,
              fieldPath: fieldPath || null,
              optionsSourceId: dynamic.optionsSourceId === null ? null : optionsSourceId,
              options: filterResolvedActionOptions(
                dynamic.result,
                data,
              ),
              ...(dynamic.modelCatalog ? { modelCatalog: dynamic.modelCatalog } : {}),
              ...(dynamic.machineRecipeDetails === undefined ? {} : { machineRecipeDetails: dynamic.machineRecipeDetails }),
            },
          };
        }

        if (actionId === 'action.invoke') {
          if (!deps.invokeContributedAction) {
            return {
              ok: false,
              errorCode: 'contributed_action_unavailable',
              error: 'contributed_action_unavailable',
            };
          }
          const invocation = ActionInvokeInputSchema.safeParse(data);
          if (!invocation.success) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const approvalExecutionOrigin = await prepareApprovalExecutionOrigin({
            actionId: 'action.invoke',
            input: data,
            context: ctx,
            targetSessionId: normalizeId(ctx.defaultSessionId) || null,
          });
          return await deps.invokeContributedAction({
            action: invocation.data.action,
            input: invocation.data.input,
            ...(invocation.data.clientId === undefined ? {} : { clientId: invocation.data.clientId }),
            ...(invocation.data.messageActionReference ? { messageActionReference: invocation.data.messageActionReference } : {}),
            context: ctx,
            ...(approvalExecutionOrigin ? { approvalExecutionOrigin } : {}),
            ...(ctx.requiredContributedActionDangerLevel ? { requiredDangerLevel: ctx.requiredContributedActionDangerLevel } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        }
        const dispatchAgentsSubagents2Result = await dispatchAgentsSubagents2({ actionId, deps, data, ctx, parsed });
        if (dispatchAgentsSubagents2Result !== null) return dispatchAgentsSubagents2Result;
        const dispatchRunsDispatch1Result = await dispatchRunsDispatch1({ actionId, parsed, ctx, deps, data, dispatchFacts, startExecutionRunWithSelection });
        if (dispatchRunsDispatch1Result !== null) return dispatchRunsDispatch1Result;

        if (actionId === 'wait') {
          const request = WaitActionInputV1Schema.parse(parsed.data);
          // The target cannot choose credentials: agree with the host's captured Home.
          if (!ctx.serverId || request.target.serverId !== ctx.serverId) {
            return { ok: true, result: { target: request.target, condition: request.condition, disposition: 'permission_denied' } };
          }
          const unwrap = (result: ActionExecuteResult) => result.ok ? result.result : result;
          const result = await executeWaitActionV1(request, {
            operation: async (target, options) => {
              const observed = await executeHostChild('action.operations.get', {
                serverId: target.serverId, machineId: target.machineId, operationId: target.operationId, waitForTerminal: true,
              }, { ...ctx, ...(options.signal ? { signal: options.signal } : {}) });
              if (!observed.ok) return observed;
              const response = observed.result;
              if (response && typeof response === 'object' && 'kind' in response && response.kind === 'found' && 'operation' in response) {
                return { disposition: 'matched', snapshot: response.operation };
              }
              return { disposition: 'target_unavailable' };
            },
            execution: async (target, options) => unwrap(await executeHostChild('execution.run.wait', {
              runId: target.runId,
              ...(options.condition.kind === 'terminal' ? {} : { condition: options.condition.kind }),
              ...(target.sessionId ? { sessionId: target.sessionId } : { target: { kind: 'detached' } }),
              ...(options.timeoutMs === null ? {} : { timeoutSeconds: options.timeoutMs / 1000 }),
            }, { ...ctx, executionRunTargetMachineId: target.machineId,
              ...(options.onSnapshot ? { onWaitSnapshot: options.onSnapshot } : {}),
              ...(options.signal ? { signal: options.signal } : {}) })),
            workflow: async (target, options) => unwrap(await executeHostChild('workflow.run.wait', {
              runId: target.runId,
              conditions: options.condition.kind === 'terminal' ? ['terminal']
                : options.condition.kind === 'needs_attention' ? ['attention'] : ['terminal', 'attention'],
              ...(options.timeoutMs === null ? {} : { timeoutSeconds: options.timeoutMs / 1000 }),
            }, { ...ctx, ...(options.onSnapshot ? { onWaitSnapshot: options.onSnapshot } : {}),
              ...(options.signal ? { signal: options.signal } : {}) })),
            ...(deps.invokeContributedAction ? {
              plugin: async (input, options) => {
                if (input.target.kind !== 'plugin_source' || input.condition.kind !== 'plugin') return { disposition: 'unsupported_condition' };
                const invocation = {
                  action: { pluginId: input.target.pluginId, localId: input.condition.actionLocalId },
                  input: { sourceId: input.target.sourceId, condition: input.condition.condition,
                    ...(options.timeoutMs === null ? {} : { timeoutMs: Math.max(0, options.deadlineMs! - Date.now()) }) },
                };
                const denied = await admitCredentialScope('action.invoke', ctx, invocation);
                if (denied) return denied;
                const approvalExecutionOrigin = await prepareApprovalExecutionOrigin({
                  actionId: 'action.invoke', input: invocation, context: ctx,
                  targetSessionId: normalizeId(ctx.defaultSessionId) || null,
                });
                return unwrap(await deps.invokeContributedAction!({
                  ...invocation,
                  context: ctx,
                  ...(approvalExecutionOrigin ? { approvalExecutionOrigin } : {}),
                  ...(options.signal ? { signal: options.signal } : {}),
                }));
              },
            } : {}),
            ...(deps.sessionAwarenessWait ? {
              session: async (input, options) => deps.sessionAwarenessWait!({
                context: ctx, input, options,
                readAwareness: async () => input.target.kind === 'session'
                  ? unwrap(await executeHostChild('session.activity.get', {
                      sessionId: input.target.sessionId, view: 'awareness',
                    }, { ...ctx, ...(options.signal ? { signal: options.signal } : {}) })) : null,
              }),
            } : {}),
          }, { ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.onWaitSnapshot ? { onSnapshot: ctx.onWaitSnapshot } : {}) });
          return { ok: true, result };
        }
        const dispatchRunsDispatch2Result = await dispatchRunsDispatch2({ actionId, data, parsed, ctx, deps });
        if (dispatchRunsDispatch2Result !== null) return dispatchRunsDispatch2Result;
        const dispatchProjectsDispatch1Result = await dispatchProjectsDispatch1({ actionId, deps, parsed, ctx, executeHostChild });
        if (dispatchProjectsDispatch1Result !== null) return dispatchProjectsDispatch1Result;

        if (actionId === 'workflow.trigger.test') {
          return completeActionResult(testAutomationEventV1(AutomationEventTestInputV1Schema.parse(parsed.data)));
        }
        if (actionId === 'workflow.starters.list') {
          return completeActionResult({ examples: getWorkflowStarterExamplesV1() });
        }
        if (actionId === 'workflow.starters.resolve') {
          const input = WorkflowStartersResolveInputV1Schema.parse(parsed.data);
          const example = getWorkflowStarterExamplesV1().find((entry) => entry.key === input.key);
          if (!example) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          return completeActionResult(materializeWorkflowStarterExample(example, input));
        }

        if (actionId === 'workflow.events.list') {
          if (!deps.workflowEventsList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const input = WorkflowEventsListInputV1Schema.parse(parsed.data);
          if (input.serverId && ctx.serverId && input.serverId !== ctx.serverId) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          return completeActionResult(await deps.workflowEventsList({ ...input,
            ...(!input.serverId && ctx.serverId ? { serverId: ctx.serverId } : {}),
          }, ctx));
        }

        if (isWorkflowAuthoringActionId(actionId)) {
          if (!deps.workflowAuthoringAction) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.workflowAuthoringAction({ actionId, input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.organization.move') {
          if (!deps.sessionOrganizationMove) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.sessionOrganizationMove({ input: parsed.data,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.organization.pin.set') {
          if (!deps.sessionOrganizationPinSet) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const input = parsed.data as PublicActionInputById['session.organization.pin.set'];
          if (input.serverId && ctx.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          const serverId = input.serverId ?? resolveServerIdForSession(deps, ctx, input.sessionId);
          const request = SetSessionPinRequestSchema.parse({ pinned: input.pinned,
            ...(input.surface ? { surface: input.surface } : {}),
            ...(input.sortKey !== undefined ? { sortKey: input.sortKey } : {}),
          });
          const result = await deps.sessionOrganizationPinSet({ context: ctx, sessionId: input.sessionId, request, serverId,
            ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          const output = SetSessionPinResponseSchema.safeParse(result);
          if (!output.success || (output.data.pin === null ? request.pinned
            : output.data.pin.sessionId !== input.sessionId
              || output.data.pin[(request.surface ?? 'list') === 'rail' ? 'railPinned' : 'listPinned'] !== request.pinned)) {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
          return completeActionResult(output.data);
        }

        if (actionId === 'composer.transaction.apply' || actionId === 'composer.attachments.pick' || actionId === 'repository.upload.pick') {
          if (!deps.composerIngress) return { ok: true, result: { status: actionId === 'composer.transaction.apply' ? 'composerUnavailable' : 'unavailable' } };
          return completeActionResult(await deps.composerIngress({ actionId, input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'tasks.internal.list' || actionId === 'tasks.internal.create' || actionId === 'tasks.internal.edit' || actionId === 'tasks.internal.transition') {
          if (!deps.internalTaskAction) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.internalTaskAction({ actionId, input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.pending.reorder' || actionId === 'tasks.internal.reorder') {
          if (!deps.listReorder) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.listReorder({ actionId, input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'tasks.internal.session.link') {
          if (!deps.todoSessionLink) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.todoSessionLink({ input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }
        const dispatchSessionLifecycle1Result = await dispatchSessionLifecycle1({ actionId, deps, parsed, ctx, data, isDeferredApprovalResult, stopThenArchiveSession, executeHostChild });
        if (dispatchSessionLifecycle1Result !== null) return dispatchSessionLifecycle1Result;
        const dispatchSessionHandoffResult = await dispatchSessionHandoff({ actionId, parsed, ctx, data, deps });
        if (dispatchSessionHandoffResult !== null) return dispatchSessionHandoffResult;
        const dispatchWorkspaceSyncResult = await dispatchWorkspaceSync({ actionId, deps, ctx, parsed });
        if (dispatchWorkspaceSyncResult !== null) return dispatchWorkspaceSyncResult;

        if (actionId === 'session.spawn_new') {
          const admittedSpawnInput = admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse(parsed.data));
          const profileAdmission = await resolveProfileSkillSeedsAtAdmissionV1(admittedSpawnInput, deps, ctx);
          if (!profileAdmission.ok) return profileAdmission;
          const spawnInput = profileAdmission.input;
          const permissionResolution = assertAgentPermission(ctx, spawnInput.permissionMode);
          if (!permissionResolution.ok) {
            return permissionResolution.error;
          }
          const permissionDecision = permissionResolution.permissionDecision;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const effectiveSpawnInput = permissionDecision?.ok === true
            ? { ...spawnInput, permissionMode: permissionDecision.normalizedMode }
            : spawnInput;
          const spawnArgs = buildSessionSpawnNewArgs(
            effectiveSpawnInput,
            ctx,
            legacyMetadataLabel,
            discussionParticipantLaunch,
          );
          if (!spawnArgs) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.sessionSpawnNew({ ...spawnArgs,
            admittedInput: admittedSpawnInput,
          });
          return completeSpawnActionResult(res);
        }
        const dispatchProjectsDispatch2Result = await dispatchProjectsDispatch2({ actionId, deps, data, ctx });
        if (dispatchProjectsDispatch2Result !== null) return dispatchProjectsDispatch2Result;

        // Domain refusals retain their acknowledged/current Source revision;
        // the outer Action result distinguishes transport/admission failures.
        if (actionId === 'deployments.templates.instantiate') {
          if (!ctx.serverId || !ctx.runtimeAccountId) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
          if (!deps.deploymentTemplateInstantiate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:deployments.templates.instantiate' };
          const input = DeploymentActionInputSchemasV1[actionId].parse(data);
          if (!isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
          const review = deploymentReview === undefined ? undefined : DeploymentTemplateInstantiationReviewV1Schema.parse(deploymentReview);
          const result = await deps.deploymentTemplateInstantiate(input, ctx, review);
          if ('ok' in result) return result;
          if (result.kind === 'partial') {
            return { ok: false, errorCode: result.errorCode, error: result.errorCode, details: result };
          }
          return { ok: true, result };
        }
        if (actionId === 'deployments.publish' || actionId === 'deployments.prepare') {
          if (!ctx.serverId || !ctx.runtimeAccountId) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
          if (actionId === 'deployments.publish') {
            if (!deps.deploymentPublish) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:deployments.publish' };
            const result = await deps.deploymentPublish(DeploymentActionInputSchemasV1[actionId].parse(data), ctx);
            return 'errorCode' in result ? result : { ok: true, result };
          }
          if (!deps.deploymentPrepare) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:deployments.prepare' };
          const input = DeploymentActionInputSchemasV1[actionId].parse(data);
          if (!isSameHome(input.workspace.serverId, ctx.serverId, ctx))
            return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
          const result = await deps.deploymentPrepare(input, ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (isDeploymentActionIdV1(actionId)) {
          if (!deps.deploymentAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.deploymentAction(actionId, DeploymentActionInputSchemasV1[actionId].parse(data), ctx);
          if ('errorCode' in result) return result;
          if ('kind' in result) return { ok: true, result };
          if (!result.ok) return { ok: false, errorCode: result.error, error: result.error, details: result };
          return { ok: true, result };
        }
        const dispatchProjectsDispatch3Result = await dispatchProjectsDispatch3({ actionId, deps, data, ctx });
        if (dispatchProjectsDispatch3Result !== null) return dispatchProjectsDispatch3Result;

        if (isPromptInvocationActionId(actionId)) {
          // The existing stack port is the same admitted catalog/read/write owner, not another store.
          const port = deps.promptStacks;
          if (!port) return completeActionResult({ status: 'unavailable', reason: 'noClient' });
          if (ctx.serverId && !(port.matchesServerId?.(ctx.serverId) ?? ctx.serverId === port.serverId)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          if (actionId === 'prompts.invocation.delete') return completeActionResult(await deletePromptInvocationInLibrary({ port,
            request: PromptInvocationDeleteInputSchema.parse(parsed.data), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
          const actionTokens = listActionSpecs().filter(spec => spec.surfaces.ui === true).flatMap(spec => spec.slash?.tokens ?? []);
          if (actionId === 'prompts.invocation.update') return completeActionResult(await updatePromptInvocationInLibrary({ port,
            request: PromptInvocationUpdateInputSchema.parse(parsed.data), actionTokens, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
          return completeActionResult(await createPromptInvocationInLibrary({ port,
            request: PromptInvocationCreateInputSchema.parse(parsed.data), invocationId: bytesToHex(randomBytes(16)),
            actionTokens,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'prompts.invocations.list') {
          const promptInvocationsList = deps.promptInvocationsList;
          if (!promptInvocationsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompts.invocations.list' };
          }
          const res = await promptInvocationsList({
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'prompts.invocation.resolve') {
          const promptInvocationResolve = deps.promptInvocationResolve;
          if (!promptInvocationResolve) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompts.invocation.resolve' };
          }
          const invocationId = typeof data.invocationId === 'string' ? data.invocationId.trim() : '';
          if (!invocationId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await promptInvocationResolve({
            invocationId,
            sessionId: ctx.defaultSessionId ?? null,
            ...(typeof data.argsText === 'string' ? { argsText: data.argsText } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'machines.list') {
          const requestedServerId = normalizeId(data.serverId);
          const currentServerId = normalizeId(ctx.serverId);
          if (requestedServerId && currentServerId && !isSameHome(requestedServerId, currentServerId, ctx)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          const res = await deps.machinesList({
            ...(requestedServerId || currentServerId ? { serverId: requestedServerId || currentServerId } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(typeof data.refresh === 'boolean' ? { refresh: data.refresh } : {}),
            ...(data.refresh === true && ctx.surface === 'ui' ? { purpose: 'input' as const } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'servers.list') {
          const res = await deps.serversList({
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'review.engines.list') {
          const target = resolveReviewEngineInventoryTarget(parsed.data, ctx, resolveSessionIdFromInput);
          if (!target.ok) return target;
          const res = await deps.reviewEnginesList({
            ...target.target,
            ...(typeof data.includeDisabled === 'boolean' ? { includeDisabled: data.includeDisabled } : {}),
            ...(data.scope === 'paths' ? { scope: 'paths' as const } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'machines.agents.list') {
          if (!deps.machinesAgentsList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const args = MachinesAgentsListInputSchema.parse(parsed.data);
          const res = await deps.machinesAgentsList({
            ...args,
            ...(!args.serverId && ctx.serverId ? { serverId: ctx.serverId } : {}),
          }, ctx);
          return completeActionResult(res);
        }
        const dispatchCodeResult = await dispatchCode({ actionId, parsed, deps, ctx, data });
        if (dispatchCodeResult !== null) return dispatchCodeResult;

        if (actionId === 'workspace.files.search') {
          if (!deps.workspaceFilesSearch) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await deps.workspaceFilesSearch(WorkspaceFilesSearchActionInputSchema.parse(parsed.data), ctx));
        }

        if (actionId === 'workspace.files.replace.preview') {
          if (!deps.workspaceFilesReplacePreview) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await deps.workspaceFilesReplacePreview(WorkspaceFilesReplacePreviewActionInputSchema.parse(parsed.data), ctx));
        }
        if (actionId === 'workspace.files.replace') {
          if (!deps.workspaceFilesReplace) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await deps.workspaceFilesReplace(WorkspaceFilesReplaceActionInputSchema.parse(parsed.data), ctx));
        }
        const dispatchAgentsCatalogResult = await dispatchAgentsCatalog({ actionId, deps, data, parsed, ctx });
        if (dispatchAgentsCatalogResult !== null) return dispatchAgentsCatalogResult;
        const dispatchSessionMessagesResult = await dispatchSessionMessages({ actionId, deps, parsed, ctx, sessionMessageSendAdmission, data, dispatchFacts });
        if (dispatchSessionMessagesResult !== null) return dispatchSessionMessagesResult;

        if (actionId === 'session.coordinator.enable') {
          const request = SessionCoordinatorEnableInputV1Schema.parse(parsed.data);
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          if (request.ruleSuggestions.some(suggestion => suggestion.ruleDefinition.filter.homeServerIds.length !== 1
            || !serverId || !isSameHome(suggestion.ruleDefinition.filter.homeServerIds[0]!, serverId, ctx))) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          return completeActionResult(await executeSessionCoordinatorEnableV1(request,
            (childId, childInput) => executeHostChild(childId, childInput, ctx), ctx.signal));
        }
        const dispatchSessionControls1Result = await dispatchSessionControls1({ actionId, parsed, ctx, deps, data, isSameHome });
        if (dispatchSessionControls1Result !== null) return dispatchSessionControls1Result;
        const dispatchSessionLifecycle2Result = await dispatchSessionLifecycle2({ actionId, deps, parsed, ctx, data, isDeferredApprovalResult, stopThenArchiveSession, executeHostChild });
        if (dispatchSessionLifecycle2Result !== null) return dispatchSessionLifecycle2Result;
        const dispatchSessionWorkResult = await dispatchSessionWork({ actionId, data, deps, ctx, parsed });
        if (dispatchSessionWorkResult !== null) return dispatchSessionWorkResult;
        const dispatchSessionTranscriptResult = await dispatchSessionTranscript({ actionId, data, deps, ctx });
        if (dispatchSessionTranscriptResult !== null) return dispatchSessionTranscriptResult;
        const dispatchSessionControls2Result = await dispatchSessionControls2({ actionId, parsed, ctx, deps, data, isSameHome });
        if (dispatchSessionControls2Result !== null) return dispatchSessionControls2Result;
        const dispatchSessionAwarenessResult = await dispatchSessionAwareness({ actionId, admittedInput, deps, ctx, data });
        if (dispatchSessionAwarenessResult !== null) return dispatchSessionAwarenessResult;

        if (actionId === 'search.conversations') {
          if (!deps.searchConversations) return clientActionUnavailable(actionId);
          return completeActionResult(await deps.searchConversations({
            input: SearchConversationsInputV1Schema.parse(data), context: ctx,
          }));
        }

        if (actionId === 'search.settings.get' || actionId === 'search.settings.set'
          || actionId === 'memory.status' || actionId === 'memory.clear_index') {
          const machineId = normalizeId(data.machineId);
          const args = { machineId, context: ctx, serverId: normalizeId(ctx.serverId) || null, ...(ctx.signal ? { signal: ctx.signal } : {}) };
          if (actionId === 'search.settings.get' && deps.daemonMemorySettingsGet) {
            return completeActionResult(await deps.daemonMemorySettingsGet(args));
          }
          if (actionId === 'search.settings.set' && deps.daemonMemorySettingsSet) {
            return completeActionResult(await deps.daemonMemorySettingsSet({ ...args, settings: MemorySettingsV1Schema.parse(data.settings) }));
          }
          if (actionId === 'memory.status' && deps.daemonMemoryStatus) {
            return completeActionResult(await deps.daemonMemoryStatus(args));
          }
          if (actionId === 'memory.clear_index' && deps.daemonMemoryClearIndex) {
            return completeActionResult(await deps.daemonMemoryClearIndex(args));
          }
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }

        if (actionId === 'memory.search') {
          const machineId = normalizeId(data.machineId);
          if (!machineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const query = data.query as MemorySearchQueryV1;
          const res = await deps.daemonMemorySearch({
            machineId,
            query,
            serverId: normalizeId(ctx.serverId) || null,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'memory.get_window') {
          const machineId = normalizeId(data.machineId);
          if (!machineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const { machineId: _machineId, ...request } = data;
          const window = MemoryWindowRequestV1Schema.parse(request);
          const res = await deps.daemonMemoryGetWindow({
            ...window,
            machineId,
            serverId: normalizeId(ctx.serverId) || null,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'memory.ensure_up_to_date') {
          const machineId = normalizeId(data.machineId);
          if (!machineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const sessionId = normalizeId(data.sessionId);
          const res = await deps.daemonMemoryEnsureUpToDate({
            machineId,
            ...(sessionId ? { sessionId } : {}),
            serverId: normalizeId(ctx.serverId) || null,
          });
          return completeActionResult(res);
        }

        if (actionId === 'ui.voice_global.reset') {
          await deps.resetGlobalVoiceAgent();
          return { ok: true, result: { ok: true } };
        }

        if (actionId === 'ui.voice_agent.teleport') {
          if (!deps.teleportVoiceAgentToSessionRoot) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:ui.voice_agent.teleport' };
          }
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const result = await deps.teleportVoiceAgentToSessionRoot({ sessionId });
          const resultRecord = readRecord(result);
          if (resultRecord.ok === false) {
            const errorCode = typeof resultRecord.code === 'string'
              ? resultRecord.code
              : typeof resultRecord.errorCode === 'string'
                ? resultRecord.errorCode
                : 'voice_teleport_failed';
            return { ok: false, errorCode, error: errorCode };
          }
          return { ok: true, result: { ok: true, sessionId } };
        }

        if ((REGISTRY_ACTION_IDS_V1 as readonly string[]).includes(actionId)) {
          if (!deps.registryActionExecute) return {ok:false,errorCode:'unsupported_action',error:`unsupported_action:${actionId}`};
          return completeActionResult(await deps.registryActionExecute({actionId:actionId as RegistryActionIdV1,input:parsed.data,context:ctx}));
        }
        if ((PERSONAL_SAVED_SECRET_ACTION_IDS_V1 as readonly string[]).includes(actionId)) {
          if (!deps.personalSavedSecretActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.personalSavedSecretActionExecute({ actionId: actionId as PersonalSavedSecretActionIdV1, input: parsed.data, context: ctx }));
        }
        const dispatchAgentsAcpResult = await dispatchAgentsAcp({ actionId, deps, data, ctx });
        if (dispatchAgentsAcpResult !== null) return dispatchAgentsAcpResult;

        if (actionId === 'agents.acp.backends.upsert' || actionId === 'agents.acp.backends.delete') {
          if (!deps.updateAccountAcpCatalogSettings) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          // The catalog owner decides; the host only persists what it returns, so this and the
          // Settings editor store identical results.
          const settlement: { refusal?: ActionExecuteFailure;
            result?: Pick<ReturnType<typeof AgentsAcpBackendsUpsertOutputV1Schema.parse>, 'backend'>
              | Pick<ReturnType<typeof AgentsAcpBackendsDeleteOutputV1Schema.parse>, 'backendId' | 'deleted'> } = {};
          const projectPersistenceFailure = (failure: Extract<Awaited<ReturnType<NonNullable<ActionExecutorDeps['updateAccountAcpCatalogSettings']>>>, { ok: false }>): ActionExecuteFailure => ({
            ...failure,
            errorCode: failure.errorCode === 'conflict' ? 'acp_catalog_conflict' : failure.errorCode,
          });
          if (actionId === 'agents.acp.backends.upsert') {
            const parsed = AgentsAcpBackendsUpsertInputV1Schema.safeParse(data);
            if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            const nowMs = Date.now();
            const persisted = await deps.updateAccountAcpCatalogSettings({
              mutate: (current) => {
                const outcome = applyAcpBackendUpsertV1({ settings: current, backend: parsed.data.backend, nowMs });
                if (!outcome.ok) {
                  settlement.refusal = projectAcpUpsertRefusal(outcome);
                  return current;
                }
                settlement.result = { backend: outcome.backend };
                return outcome.settings;
              },
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              ...(parsed.data.expectedRevision !== undefined ? { expectedRevision: parsed.data.expectedRevision } : {}),
              ...(parsed.data.sourceSettingsVersion !== undefined ? { sourceSettingsVersion: parsed.data.sourceSettingsVersion } : {}),
            });
            if (settlement.refusal) return settlement.refusal;
            if (!persisted.ok) return projectPersistenceFailure(persisted);
            return { ok: true, result: AgentsAcpBackendsUpsertOutputV1Schema.parse({
              ...settlement.result,
              revision: persisted.revision,
              ...(persisted.cleanup ? { cleanup: persisted.cleanup } : {}),
            }) };
          }
          const parsed = AgentsAcpBackendsDeleteInputV1Schema.safeParse(data);
          if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const persisted = await deps.updateAccountAcpCatalogSettings({
            mutate: (current) => {
              const outcome = applyAcpBackendDeleteV1({ settings: current, backendId: parsed.data.backendId });
              if (!outcome.ok) {
                settlement.refusal = { ok: false, errorCode: outcome.code, error: outcome.code };
                return current;
              }
              settlement.result = { backendId: parsed.data.backendId, deleted: true };
              return outcome.settings;
            },
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(parsed.data.expectedRevision !== undefined ? { expectedRevision: parsed.data.expectedRevision } : {}),
            ...(parsed.data.sourceSettingsVersion !== undefined ? { sourceSettingsVersion: parsed.data.sourceSettingsVersion } : {}),
          });
          if (settlement.refusal) return settlement.refusal;
          if (!persisted.ok) return projectPersistenceFailure(persisted);
          return { ok: true, result: AgentsAcpBackendsDeleteOutputV1Schema.parse({
            ...settlement.result, ...(persisted.cleanup ? { cleanup: persisted.cleanup } : {}),
          }) };
        }

        if (isArtifactFolderActionIdV1(actionId)) {
          if (!deps.artifactFolders) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (ctx.serverId && !(deps.artifactFolders.matchesServerId?.(ctx.serverId) ?? ctx.serverId === deps.artifactFolders.serverId)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          return completeActionResult(await executeArtifactFolderActionV1({ port: deps.artifactFolders, actionId, input: parsed.data, signal: ctx.signal }));
        }

        if (actionId === 'prompts.stack.update') {
          if (!deps.promptStacks) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompts.stack.update' };
          if (ctx.serverId && !(deps.promptStacks.matchesServerId?.(ctx.serverId) ?? ctx.serverId === deps.promptStacks.serverId)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
          }
          return completeActionResult(await updatePromptLibraryStackV1(deps.promptStacks, PromptLibraryStackUpdateInputV1Schema.parse(parsed.data), ctx.signal));
        }

        if (actionId === 'prompt_doc.get') {
          if (!deps.promptDocGet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.get' };
          return completeActionResult(await deps.promptDocGet({
            artifactId: String(data.artifactId), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'prompt_doc.create') {
          if (!deps.promptDocCreate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.create' };
          const childFailure = await createReviewedPromptFolder();
          if (childFailure) return childFailure;
          return completeActionResult(await deps.promptDocCreate({ ...PromptDocCreateActionInputV1Schema.parse(data),
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'models.favorite.set') {
          if (!deps.modelFavoriteSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:models.favorite.set' };
          const outcome = await deps.modelFavoriteSet(ModelFavoriteMutationV1Schema.parse(data), ctx);
          if (outcome.status === 'applied' || outcome.status === 'satisfied' || outcome.status === 'unchanged') {
            return completeActionResult({ status: 'updated' });
          }
          const errorCode = outcome.status === 'outcomeUnknown' ? 'account_settings_mutation_outcome_unknown' : `account_settings_mutation_${outcome.status}`;
          return { ok: false, errorCode, error: errorCode };
        }
        if (actionId === 'session.model.unarm') {
          if (!deps.sessionModelUnarm) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.model.unarm' };
          const sessionId = String(data.sessionId);
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionModelUnarm({ sessionId, context: ctx, ...(serverId ? { serverId } : {}) }));
        }
        if (actionId === 'prompt_doc.favorite.set') {
          if (!deps.promptDocFavoriteSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.favorite.set' };
          return completeActionResult(await deps.promptDocFavoriteSet({ artifactId: String(data.artifactId), favorite: data.favorite === true,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'prompts.library.list') {
          if (!deps.promptsLibraryList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompts.library.list' };
          return completeActionResult(await deps.promptsLibraryList({ ...(typeof data.query === 'string' ? { query: data.query } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'skills.read') {
          if (!deps.skillsRead) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:skills.read' };
          return completeActionResult(await deps.skillsRead({ ...SkillReadInputV1Schema.parse(data),
            ...(ctx.signal ? { signal: ctx.signal } : {}) }, ctx));
        }

        if (actionId === 'prompt_doc.update') {
          if (!deps.promptDocUpdate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.update' };
          }
          const artifactId = normalizeId(data.artifactId);
          const title = String(data.title ?? '').trim();
          if (!artifactId || !title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const childFailure = await createReviewedPromptFolder();
          if (childFailure) return childFailure;
          const res = await deps.promptDocUpdate({
            artifactId,
            title,
            markdown: String(data.markdown ?? ''),
            ...(data.expectedRevision === undefined ? {} : { expectedRevision: PromptDocRevisionV1Schema.parse(data.expectedRevision) }),
            ...(Object.prototype.hasOwnProperty.call(data, 'folderId')
              ? { folderId: (data.folderId ?? null) as string | null }
              : {}),
            ...(Array.isArray(data.tags)
              ? { tags: (data.tags as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx);
          return completeActionResult(res);
        }

        if (Object.hasOwn(SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1, actionId)) {
          if (!deps.skillMachineActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.skillMachineActionExecute({
            actionId: actionId as keyof typeof SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1, input: data, context: ctx,
          }));
        }

        if (Object.hasOwn(SKILL_ACTION_INPUT_SCHEMAS_V1, actionId)) {
          if (!deps.skillActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.skillActionExecute({ actionId: actionId as keyof typeof SKILL_ACTION_INPUT_SCHEMAS_V1, input: data, context: ctx });
          const returned = readRecord(result);
          if (returned.ok === false && typeof returned.code === 'string') return { ok: false, errorCode: returned.code, error: returned.code,
            ...(returned.current ? { details: { current: returned.current } } : {}) };
          return completeActionResult(result);
        }

        if (actionId === 'prompt_bundle.update') {
          if (!deps.promptBundleUpdate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_bundle.update' };
          }
          const childFailure = await createReviewedPromptFolder();
          if (childFailure) return childFailure;
          const res = await deps.promptBundleUpdate({ ...PromptBundleUpdateActionInputV1Schema.parse(data),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'prompt_registry.install') {
          if (!deps.promptRegistryInstall) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_registry.install' };
          }
          const machineId = normalizeId(data.machineId);
          const sourceId = normalizeId(data.sourceId);
          const itemId = normalizeId(data.itemId);
          if (!machineId || !sourceId || !itemId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = projectLegacySkillRegistryInstallActionResultV1(await deps.promptRegistryInstall({
            machineId,
            sourceId,
            itemId,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx));
          const failure = readActionFailureEnvelope(res);
          if (failure) return failure;
          return completeActionResult(res);
        }

      if (actionId === 'approval.request.list' || actionId === 'approval.request.get') {
        return executeApprovalObservationAction({ actionId, input: data, context: ctx, deps });
      }

      if (actionId === 'approval.request.create') {
        if (!deps.approvalsCreate) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const now = Date.now();
        const targetActionId = data.actionId as ActionId;
        if (isApprovalActionId(targetActionId) || isInternalActionId(targetActionId)) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }

        // Approvals eligibility is policy-driven (settings/surface), not safety-driven.
        // Safety metadata remains useful for UI copy and defaults, but it is not a hard gate here.
        const targetSpec = getActionSpec(targetActionId);
        // An Action whose input may only live on its admitted invocation has no
        // durable queue form: the record could only hold the redacted
        // projection, which can never be executed. Refuse it at the request
        // boundary rather than persisting an approval nobody can settle.
        if (targetSpec.approvalInputCustody === 'live_only') {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const parsedTargetArgs = targetSpec.inputSchema.safeParse(data.actionArgs ?? {});
        if (!parsedTargetArgs.success) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        let targetArgs = redactMemoryActionInput(targetActionId, parsedTargetArgs.data);
        if (targetSpec.sessionTarget) {
          const targets = await resolveActionSessionTargets(deps, { actionId: targetActionId,
            declaration: targetSpec.sessionTarget, input: readRecord(targetArgs), context: ctx });
          if (targets && 'ok' in targets) return targets;
          if (targets) {
            ctx = { ...ctx, sessionTargetsV1: targets };
            if (targets.operands) {
              const bound = bindActionSessionTargetOperands(readRecord(targetArgs), targets);
              if (!bound) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
              targetArgs = bound;
            } else if (targetActionId === 'discussion.invite') {
              targetArgs = replaceActionSessionTargetField(readRecord(targetArgs), targets.field, targets.targets[0].sessionId);
            }
            const invitationFailure = await admitDiscussionInvitationTargets(targetActionId, targetArgs, ctx, targets);
            if (invitationFailure) return invitationFailure;
            ctx.onSessionTargetsResolved?.({ actionId: targetActionId, input: targetArgs, targets });
          }
        }
        if (isMemoryWriteActionV1(targetActionId)) {
          if (!deps.memoryLibrary) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${targetActionId}` };
          const admission = await readMemoryWriteAdmissionV1(deps.memoryLibrary, targetActionId, targetArgs, ctx);
          targetArgs = bindMemoryWriteApprovalInputV1(targetActionId, targetArgs, admission);
          if (admission.duplicateReview) return { ok: true, result: admission.duplicateReview };
        }
        const approvalPluginCaller = projectApprovalRequestPluginCaller(ctx.actionCaller);
        if (ctx.actionCaller?.kind === 'plugin' && !approvalPluginCaller) {
          return { ok: false, errorCode: 'plugin_action_caller_required', error: 'plugin_action_caller_required' };
        }

        const rawCreatedBy = data.createdBy as ApprovalRequestV1['createdBy'];
        const forcedSurface = mapApprovalCreatedBySurface(ctx.surface ?? null);
        const actionArgsSessionId = normalizeId(readRecord(targetArgs).sessionId);
        const ctxDefaultSessionId = normalizeId(ctx.defaultSessionId);
        const targetSessionId = actionArgsSessionId || ctxDefaultSessionId || null;
        const rawApprovalOrigin = Object.prototype.hasOwnProperty.call(data, 'origin')
          ? data.origin
          : ctx.approvalOrigin;
        const requestSessionId = resolveExplicitApprovalRequestingSessionId(rawApprovalOrigin, ctx, targetSessionId);
        const rawResolvedOrigin = resolveApprovalOriginForRequest(rawApprovalOrigin, requestSessionId);
        const approvalOrigin = isMemoryWriteActionV1(targetActionId) && rawResolvedOrigin?.kind === 'transcript_tool_call'
          ? { ...rawResolvedOrigin, toolInput: targetArgs } : rawResolvedOrigin;
        const rawAgentId = normalizeId(rawCreatedBy.agentId) || null;
        const requestedSurface = ctx.actionCaller?.kind === 'plugin'
          ? 'plugin'
          : parseActionSurfaceKey(ctx.surface);
        const createdBy: ApprovalRequestV1['createdBy'] = {
          surface: forcedSurface,
          ...(approvalPluginCaller ?? {}),
          ...(rawAgentId ? { agentId: rawAgentId } : {}),
          ...(requestSessionId ? { sessionId: requestSessionId } : {}),
        };

        // `approval.request.create` remains a public way to request approval for
        // any non-internal, non-approval Action, but its caller does not own the shared
        // approval presentation. A caller-authored summary or preview would be
        // a second, untrusted description of the effect and could also carry
        // secrets omitted by the target Action's observation projection.
        if (!String(data.summary ?? '').trim()) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const initialApprovalActionArgs = targetActionId === 'session.spawn_new'
          ? materializeSessionSpawnApprovalInput(targetArgs, ctx)
          : targetArgs;
        const preparedApproval = await prepareApprovalRequest({
          deps,
          actionId: targetActionId,
          input: targetArgs,
          actionArgs: initialApprovalActionArgs,
          context: ctx,
          executeCanonicalAction: (id, input) => executeInvocation(id, input, ctx),
        });
        if (!preparedApproval) {
          const errorCode = ctx.signal?.aborted ? 'cancelled' : 'approval_context_unavailable';
          return { ok: false, errorCode, error: errorCode };
        }
        if ('ok' in preparedApproval) return preparedApproval;
        const summary = buildApprovalSummary(targetSpec, targetArgs, preparedApproval.preview);
        const approvalActionArgs = preparedApproval.actionArgs;
        const sharedRequesterRequest = !delegatesApprovalClassificationToResolvedAction(targetActionId)
          && isSharedRequesterActionV1(ctx);
        const requesterAdmission = resolveApprovalRequesterConfirmationV1({ context: ctx, actionId: targetActionId,
          input: approvalActionArgs, required: sharedRequesterRequest });
        if (!requesterAdmission.ok) return requesterAdmission;
        const { requesterConfirmation } = requesterAdmission;
        const executionOriginV1 = await prepareApprovalExecutionOrigin({
          actionId: targetActionId,
          input: approvalActionArgs,
          context: ctx,
          targetSessionId,
          ...(requesterConfirmation ? { requesterConfirmation } : {}),
        });
        if (!executionOriginV1) {
          const errorCode = requesterConfirmation ? 'approval_requester_unavailable' : 'approval_origin_unavailable';
          return { ok: false, errorCode, error: requesterConfirmation ? APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 : errorCode };
        }
        if (ctx.signal?.aborted) {
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        }
        // Explicit creation returns an Artifact, never a retained invocation.
        // Use the same surface/custody owner as ordinary Action admission;
        // private live-only result custody still keeps its declared flow.
        const approvalRouting = resolveActionApprovalRouting({
          actionId: targetActionId,
          spec: targetSpec,
          input: approvalActionArgs,
          context: { surface: ctx.surface, authority: resolveHostStampedAuthority(ctx), actionCaller: ctx.actionCaller },
          requiredByPolicy: true,
        });
        const request: ApprovalRequestV2 = {
          v: 2,
          status: 'open',
          createdAtMs: now,
          updatedAtMs: now,
          createdBy,
          ...(requestedSurface ? { requestedSurface } : {}),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          executionOriginV1,
          requestInputDigest: computeActionInputApprovalDigestV1(targetActionId, targetArgs),
          ...(requesterConfirmation ? { requesterConfirmation } : {}),
          approval: { flow: approvalRouting.flow, result: approvalRouting.result },
          actionId: targetActionId,
          actionArgs: approvalActionArgs,
          summary,
          preview: preparedApproval.preview,
        };
        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        return completeActionResult({ artifactId: res.artifactId });
      }

      if (actionId === 'approval.request.decide') {
        const delegatedHostDecision = resolveHostStampedAuthority(ctx) !== 'present_user'
          && (ctx.surface === 'agent' || ctx.surface === 'mcp') && !ctx.externalActionCredential;
        // Decisions cannot request another approval. Only an explicit persisted
        // waiver delegates ordinary decisions; bypass/replay hints never do.
        if (delegatedHostDecision && (!ctx.actionsSettings
          || isApprovalRequiredByActionsSettings(actionId, ctx.actionsSettings, ctx))) {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        const artifactId = normalizeId(data.artifactId);
        const decision = data.decision === 'approve' || data.decision === 'reject' || data.decision === 'cancel'
          ? data.decision
          : null;
        if (!artifactId || !decision) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }

        // A requester recipient has View, not lifecycle-write custody. A
        // Discussion Post must also reach its publication owner before CAS:
        // closing the reviewing client cannot strand browser-recorded consent.
        let requesterPreviewRead: unknown;
        let requesterPreviewWasRead = false;
        if (!ctx.requesterApprovalDecision && resolveHostStampedAuthority(ctx) === 'present_user'
          && (deps.approvalRequestApprovedReplay || deps.executionRunHostActionApprovalReplay) && deps.approvalsGet) {
          try {
            requesterPreviewRead = await deps.approvalsGet({ artifactId, serverId: null });
            requesterPreviewWasRead = true;
          } catch (error) { return approvalContextUnavailable(error); }
          const builtInPreview = StoredApprovalRequestSchema.safeParse(requesterPreviewRead);
          const targetPreview = TargetActionApprovalRequestV1Schema.safeParse(requesterPreviewRead);
          const preview = builtInPreview.success && builtInPreview.data.v === 2 ? builtInPreview.data
            : targetPreview.success ? targetPreview.data : null;
          const requesterDecision = preview ? readApprovalRequesterDecisionV1(preview, decision) : null;
          const discussionPost = decision === 'approve' && builtInPreview.success && builtInPreview.data.v === 2
            && (builtInPreview.data.status === 'open' || builtInPreview.data.status === 'approved')
            && isSessionDiscussionApprovalPublicationV1(builtInPreview.data);
          if (preview && (requesterDecision || discussionPost) && deps.approvalRequestApprovedReplay) {
            if (data.narrowedInput !== undefined) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            const forwarded = await deps.approvalRequestApprovedReplay({ artifactId, request: preview,
              decision, context: ctx, ...(ctx.actionRequestId ? { requestId: ctx.actionRequestId } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}) });
            if (forwarded !== null) return forwarded;
            // The incumbent daemon keeps ordinary publication decisions in this
            // CAS owner. Only requester-specific decisions require forwarding.
            if (requesterDecision) return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
          }
        }

        if (!delegatedHostDecision && data.narrowedInput === undefined && deps.executionRunHostActionApprovalReplay) {
          const decisionResult = await deps.executionRunHostActionApprovalReplay({ artifactId, decision, context: ctx,
            ...(requesterPreviewWasRead ? { initialRead: { request: requesterPreviewRead } } : {}),
            ...(ctx.externalActionCredential?.grant ? { callerGrant: ctx.externalActionCredential.grant } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}) });
          if (decisionResult !== null) return decisionResult;
        }
        if (!delegatedHostDecision && data.narrowedInput === undefined && deps.targetActionApprovalReplay) {
          const replay = await deps.targetActionApprovalReplay({
            artifactId,
            decision,
            ...(requesterPreviewWasRead ? { initialRead: { request: requesterPreviewRead } } : {}),
            context: ctx,
            ...(ctx.externalActionCredential?.grant ? { callerGrant: ctx.externalActionCredential.grant } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (replay !== null) return replay;
        }

        if (!deps.approvalsGet || !deps.approvalsUpdate) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        // Approval Artifacts are Account-scoped. The deciding device's local
        // profile is not the immutable creator profile recorded by the body.
        let existingRaw: unknown;
        try {
          existingRaw = requesterPreviewWasRead ? requesterPreviewRead : await deps.approvalsGet({ artifactId, serverId: null });
        } catch (error) {
          return approvalContextUnavailable(error);
        }
        if (!existingRaw) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };

        const existingParsed = StoredApprovalRequestSchema.safeParse(existingRaw);
        if (!existingParsed.success) return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
        const existing = existingParsed.data;
        const admission = await admitApprovalRequesterDecisionV1({ request: existing, context: ctx });
        if (!admission.ok) return admission;
        if (existing.v === 2) {
          if (existing.requesterConfirmation && data.narrowedInput !== undefined) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          if (existing.requesterConfirmation && existing.status === 'open') {
            const current = await admitApprovalRequesterDecisionV1({ request: existing, context: ctx });
            if (!current.ok) return current;
          }
        }
        if (decision === 'approve' && (existing.actionId === 'computer.secret.fill' || existing.actionId === 'browser.automation.secret.fill')) {
          return { ok: false, errorCode: 'confidential_choice_required', error: 'confidential_choice_required' };
        }
        const narrowsInput = data.narrowedInput !== undefined;
        const requestedActionId = ActionIdSchema.safeParse(existing.actionId);
        const requestedSpec = requestedActionId.success ? getActionSpec(requestedActionId.data) : null;
        const draftReviewFailure = await requireDiscussionDraftReviewAuthority(existing, ctx);
        if (draftReviewFailure) return draftReviewFailure;
        if (delegatedHostDecision) {
          const origin = existing.v === 2 ? existing.executionOriginV1 : null;
          const requestingSessionId = origin?.caller.kind === 'session' ? origin.caller.sessionId : origin?.sessionId;
          const decidingSessionId = ctx.actionCaller?.kind === 'session' ? ctx.actionCaller.sessionId : ctx.defaultSessionId;
          // Immutable execution provenance, rather than editable presentation
          // provenance, identifies the requester. Missing identity fails closed.
          if (!origin || !requestingSessionId || !decidingSessionId || requestingSessionId === decidingSessionId
            || origin.requestId === ctx.actionRequestId
            || (requestedSpec && requiresPresentUserExecutionAuthorityForActionInputV1(requestedSpec, existing.actionArgs))) {
            return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
          }
        }
        if (narrowsInput && (decision !== 'approve' || !requestedSpec?.approvalNarrowing || existing.status !== 'open')) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (narrowsInput && resolveHostStampedAuthority(ctx) !== 'present_user') {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        let narrowedActionArgs = existing.actionArgs;
        if (narrowsInput && requestedSpec?.approvalNarrowing) {
          const narrowed = requestedSpec.approvalNarrowing.narrow(existing.actionArgs, data.narrowedInput);
          const admitted = narrowed === null ? null : requestedSpec.inputSchema.safeParse(narrowed);
          if (!admitted?.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          narrowedActionArgs = admitted.data;
        }
        if (requestedActionId.success
          && decision !== 'cancel'
          && requiresPresentUserDecisionForActionInputV1(getActionSpec(requestedActionId.data), existing.actionArgs, decision)
          && resolveHostStampedAuthority(ctx) !== 'present_user') {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        if (decision === 'approve' && requestedActionId.success && isPublicLinkCreationActionV1(existing.actionId)) {
          // The Account host delegates Voice decisions only while the person's
          // preference is on. Readback/asking is instruction-level; no extra tap.
          if (ctx.surface === 'voice' && isPresentUserHostInvocation(ctx)) {
            ctx = { ...ctx, presentUserConfirmation: { actionId: requestedActionId.data } };
          }
          // Other credential authority alone does not establish disclosure.
          if (ctx.presentUserConfirmation?.actionId !== existing.actionId) {
            return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
          }
        }
        const callerGrant = ctx.externalActionCredential?.grant;
        const origin = existing.v === 2 ? existing.executionOriginV1 : null;
        const originTarget = origin?.target
          ?? (origin?.sessionId ? { kind: 'session' as const, sessionId: origin.sessionId } : null)
          ?? (origin?.machineId ? { kind: 'machine' as const, machineId: origin.machineId } : null);
        if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, originTarget, origin?.machineId)) {
          return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', details: { reason: 'target_not_granted' } };
        }
        const approveAdmission = decision === 'approve'
          ? resolveApprovalRequestApproveAdmission(existing)
          : null;
        // V1 rejection/history still uses the released Account-scoped artifact
        // flow. Approval already returned above because replay cannot safely
        // reconstruct an immutable execution origin from that legacy shape.
        const effectiveServerId = (existing.v === 2
          ? normalizeId(existing.executionOriginV1.serverId)
          : normalizeId(ctx.serverId) || normalizeId(existing.serverId))
          || null;
        if (
          existing.actionId === 'session.spawn_picker'
          || isApprovalActionId(existing.actionId)
          || !isApprovalRequestActionReplayAdmitted(existing, ctx)
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (decision === 'approve' && existing.status === 'open'
          && approveAdmission?.status === 'unavailable' && approveAdmission.reason !== 'legacy_request') {
          return {
            ok: false,
            errorCode: 'approval_context_unavailable',
            error: 'approval_context_unavailable',
            details: approveAdmission.details,
          };
        }
        if (delegatedHostDecision && data.narrowedInput === undefined && deps.targetActionApprovalReplay) {
          const replay = await deps.targetActionApprovalReplay({ artifactId, decision,
            context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (replay !== null) return replay;
        }
        const isRecoverableApproved = decision === 'approve'
          && existing.status === 'approved'
          && existing.decision?.kind === 'approve'
          && !existing.execution;
        const isCancelableApproved = decision === 'cancel' && existing.v === 2
          && existing.status === 'approved' && existing.decision?.kind === 'approve' && !existing.execution;

        let settleDiscussionReview: (() => Promise<ActionExecuteFailure | null>) | undefined;
        if (decision !== 'approve' && existing.v === 2 && existing.actionId === 'discussion.reply'
          && existing.executionOriginV1.discussionReplyReturn
          && !('kind' in existing.executionOriginV1.discussionReplyReturn)) {
          if (resolveHostStampedAuthority(ctx) !== 'present_user') {
            return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
          }
          const executionOrigin = existing.executionOriginV1;
          const returned = executionOrigin.discussionReplyReturn;
          const sessionId = executionOrigin.sessionId
            ?? (executionOrigin.caller.kind === 'session' ? executionOrigin.caller.sessionId : undefined);
          const publication = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.reply'].safeParse(existing.actionArgs);
          if (!returned || 'kind' in returned || !sessionId || existing.actionId !== 'discussion.reply' || !publication.success
            || publication.data.replyTarget.kind !== 'message') {
            return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
          }
          // Capture the existing original-input port before CAS. The decision
          // remains recoverable if its response or the later settlement is lost.
          const settleOriginal = deps.sessionMessageReply;
          if (!settleOriginal) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.message.reply' };
          const correlation = { discussionId: publication.data.discussionId, messageId: publication.data.replyTarget.messageId,
            ...(returned.acceptedTurnId ? { acceptedTurnId: returned.acceptedTurnId } : {}) };
          const reviewDecision = (existing.discussionDraftReview === true
            ? { kind: 'discussion_review', ...correlation, decision }
            : { kind: 'discussion_publication', ...correlation, approvalArtifactId: artifactId, publication: { kind: 'failed',
                failure: { code: decision === 'reject' ? 'approval_rejected' : 'approval_canceled',
                  phase: 'action_admission', retryable: false } } }) satisfies Extract<SessionMessageReplyAccountMutationV1,
                    { kind: 'discussion_review' | 'discussion_publication' }>;
          settleDiscussionReview = async () => {
            const response = await settleOriginal({ context: ctx, sessionId, requestLocalId: returned.requestLocalId,
              serverId: executionOrigin.serverIdentityId ?? executionOrigin.serverId, reviewDecision, ...(ctx.signal ? { signal: ctx.signal } : {}) });
            const failure = readActionFailureEnvelope(response);
            if (failure) return failure;
            const settled = SessionMessageReplyMutationResultV1Schema.safeParse(response);
            if (!settled.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            if (!settled.data.ok) {
              const errorCode = settled.data.error === 'unavailable' ? 'approval_context_unavailable' : 'approval_stale';
              return { ok: false, errorCode, error: errorCode };
            }
            const progress = settled.data.progress;
            const expectedPublication = reviewDecision.kind === 'discussion_review' ? progress.outcome?.kind === 'declined'
              : progress.outcome !== undefined && progress.outcome.kind !== 'declined'
                && progress.returnPublication?.kind === 'failed'
                && progress.returnPublication.failure.code === reviewDecision.publication.failure.code
                && progress.returnPublication.failure.phase === reviewDecision.publication.failure.phase
                && !progress.returnPublication.failure.retryable;
            if (progress.disposition !== 'released' || !expectedPublication
              || progress.discussion?.discussionId !== reviewDecision.discussionId
              || progress.discussion.messageId !== reviewDecision.messageId || progress.discussion.participantSessionId !== sessionId
              || progress.acceptedTurnId !== returned.acceptedTurnId) {
              return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            }
            return null;
          };
        }

        if (decision === 'approve' && existing.v === 2 && existing.status === 'executing') {
          return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
        }

        if (decision === 'reject' && existing.status === 'rejected' && existing.decision?.kind === 'reject') {
          const settlementFailure = await settleDiscussionReview?.();
          if (settlementFailure) return settlementFailure;
          return buildApprovalDecisionResult(existing);
        }
        if (decision === 'cancel' && (existing.status === 'canceled'
          || existing.status === 'failed' && existing.execution?.errorCode === 'approval_canceled'
            && existing.v === 2 && existing.execution.effectAttempted === false)) {
          const settlementFailure = await settleDiscussionReview?.();
          return settlementFailure ?? buildApprovalDecisionResult(existing);
        }

        if (decision === 'approve'
          && (existing.status === 'approved' || existing.status === 'executed' || existing.status === 'failed' || existing.status === 'outcome_unknown')
          && existing.decision?.kind === 'approve'
          && !isRecoverableApproved) {
          const settlementFailure = await settleFailedDiscussionApprovalPublication(artifactId, existing, ctx);
          return settlementFailure ?? buildApprovalDecisionResult(existing);
        }

        if (existing.status !== 'open' && !isRecoverableApproved && !isCancelableApproved) {
          return { ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' };
        }

        // An open client proposal with missing source custody cannot acquire
        // consent merely because this deciding app can perform its effect.
        if (decision === 'approve' && existing.status === 'open'
          && resolveApprovalRequestAppExecutionPlacement(existing) === 'client') {
          const unavailableOrigin = readUnavailableApprovalReplayOrigin(existing);
          if (unavailableOrigin) return unavailableOrigin;
        }

        const now = Date.now();

        if (decision === 'cancel') {
          if (isCancelableApproved && existing.v === 2) {
            // Consent remains history. Cancellation settles only unclaimed
            // custody; the transition owner and Artifact CAS refuse a raced claim.
            const nextFailed: ApprovalRequest = { ...settleApprovalRequestReplayInputs(existing), status: 'failed',
              updatedAtMs: Math.max(now, existing.updatedAtMs),
              execution: projectApprovalExecutionFailureV2({ request: existing, executedAtMs: now,
                effectAttempted: false, failure: { ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' } }) };
            const updated = await deps.approvalsUpdate({ artifactId, request: nextFailed, serverId: effectiveServerId, context: ctx });
            const updateFailure = readActionFailureEnvelope(updated);
            if (updateFailure) return updateFailure;
            const settlementFailure = await settleDiscussionReview?.();
            return settlementFailure ?? buildApprovalDecisionResult(nextFailed);
          }
          const nextCanceled: ApprovalRequest = { ...settleApprovalRequestReplayInputs(existing), status: 'canceled',
            updatedAtMs: Math.max(now, existing.updatedAtMs) };
          const updated = await deps.approvalsUpdate({ artifactId, request: nextCanceled, serverId: effectiveServerId, context: ctx });
          const updateFailure = readActionFailureEnvelope(updated);
          if (updateFailure) return updateFailure;
          const settlementFailure = await settleDiscussionReview?.();
          if (settlementFailure) return settlementFailure;
          // Blocking waiters observe the persisted canceled Artifact through their
          // existing cancellation branch; no approval/rejection authority is minted.
          return buildApprovalDecisionResult(nextCanceled);
        }

        if (decision === 'reject') {
          // Rejection is the other settlement, and a refused request has no
          // replay left either: it keeps the same observation projection the
          // executed/failed transition writes.
          const nextRejected: ApprovalRequest = {
            ...settleApprovalRequestReplayInputs(existing),
            status: 'rejected',
            updatedAtMs: Math.max(now, existing.updatedAtMs),
            decision: { kind: 'reject', decidedAtMs: now,
              ...(existing.v === 2 && resolveHostStampedAuthority(ctx) === 'present_user' ? {
                authority: 'present_user' as const,
                ...(ctx.surface === 'voice' && isPresentUserHostInvocation(ctx) ? { decidedVia: 'voice' as const } : {}),
                ...(ctx.expectedAccountId ?? ctx.runtimeAccountId
                  ? { decidingAccountId: ctx.expectedAccountId ?? ctx.runtimeAccountId } : {}),
              } : {}),
              ...(existing.v === 2 && existing.requesterConfirmation && ctx.requesterApprovalDecision
                ? { authority: 'present_user' as const, decidingAccountId: ctx.requesterApprovalDecision.actor.accountId,
                  ...(ctx.requesterApprovalDecision.decisionSource === 'voice' ? { decidedVia: 'voice' as const } : {}) } : {}) },
          };
          const updated = await deps.approvalsUpdate({ artifactId, request: nextRejected, serverId: effectiveServerId, context: ctx });
          const updateFailure = readActionFailureEnvelope(updated);
          if (updateFailure) return updateFailure;
          const settlementFailure = await settleDiscussionReview?.();
          if (settlementFailure) return settlementFailure;
          if (isBlockingApprovalRequest(nextRejected)) {
            await resolveBlockingDecisionIfClaimed({
              artifactId,
              decision: 'reject',
              decisionAuthority: resolveHostStampedAuthority(ctx),
              ...(ctx.requesterApprovalDecision ? { requesterApprovalDecision: ctx.requesterApprovalDecision } : {}),
              request: nextRejected,
              serverId: effectiveServerId,
            });
          }
          return buildApprovalDecisionResult(nextRejected);
        }

        let approvedRequest = existing;
        if (existing.status === 'open') {
          let approvedActionArgs = narrowedActionArgs;
          if (narrowsInput && existing.actionId === 'computer.target.select') {
            const choice = ComputerTargetSelectRequestV1Schema.safeParse(narrowedActionArgs);
            if (!choice.success || !choice.data.target) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
            if (!deps.runtimeActionExecute) {
              return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:computer' };
            }
            // The deciding person's list validates identity without executing a
            // selection or transferring human authority to the agent replay.
            const listed = await deps.runtimeActionExecute({
              actionId: 'computer.targets.list',
              input: { machineId: choice.data.machineId, displayId: choice.data.target.displayId },
              context: { ...ctx, authority: 'present_user',
                defaultSessionId: existing.v === 2 ? existing.executionOriginV1.sessionId : ctx.defaultSessionId },
            });
            const listFailure = readActionFailureEnvelope(listed);
            if (listFailure) return listFailure;
            const targets = ComputerTargetsListResponseV1Schema.safeParse(listed);
            if (!targets.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            const targetKey = computerTargetKeyV1(choice.data.target);
            if (!targets.data.targets.some(entry => computerTargetKeyV1(entry.target) === targetKey)) {
              return { ok: false, errorCode: 'computer_target_not_available', error: 'computer_target_not_available' };
            }
            approvedActionArgs = choice.data;
          }
          approvedRequest = {
            ...existing,
            status: 'approved',
            updatedAtMs: Math.max(now, existing.updatedAtMs),
            decision: { kind: 'approve', decidedAtMs: now,
              ...(existing.v === 2 && resolveHostStampedAuthority(ctx) === 'present_user' ? {
                authority: 'present_user' as const,
                ...(ctx.surface === 'voice' && isPresentUserHostInvocation(ctx) ? { decidedVia: 'voice' as const } : {}),
                ...(existing.v === 2 && !existing.requesterConfirmation
                  && (ctx.expectedAccountId ?? ctx.runtimeAccountId ?? existing.executionOriginV1.accountId)
                  ? { decidingAccountId: ctx.expectedAccountId ?? ctx.runtimeAccountId ?? existing.executionOriginV1.accountId } : {}),
              } : {}),
              ...(existing.v === 2 && existing.requesterConfirmation && ctx.requesterApprovalDecision
                ? { authority: 'present_user' as const, decidingAccountId: ctx.requesterApprovalDecision.actor.accountId,
                  ...(ctx.requesterApprovalDecision.decisionSource === 'voice' ? { decidedVia: 'voice' as const } : {}) } : {}),
              ...(narrowsInput ? { narrowedInput: projectNativeJsonValueForTransport(approvedActionArgs) } : {}),
              ...(narrowsInput || (requestedSpec && requiresPresentUserDecisionForActionInputV1(requestedSpec, approvedActionArgs))
                ? { authority: 'present_user' as const } : {}) },
          };

          let approved: unknown;
          try {
            approved = await deps.approvalsUpdate({
              artifactId,
              request: approvedRequest,
              serverId: effectiveServerId,
              context: ctx,
            });
          } catch (error) {
            approved = { ok: false, ...normalizeActionExecutorThrownError(error) };
          }
          const approvalFailure = readActionFailureEnvelope(approved);
          if (approvalFailure) {
            // A lost acknowledgement can leave consent committed while its
            // original live requester still waits. Reconcile the exact decision
            // once before handing it to the existing execution-claim owner.
            // A failed/unreadable/different write never authorizes an effect.
            const persisted = await readMatchingApprovalRequestReceipt({
              artifactId, serverId: effectiveServerId, request: approvedRequest,
            });
            if (!persisted) return approvalFailure.errorCode === 'action_failed'
              ? approvalContextUnavailable()
              : approvalFailure;
            approvedRequest = persisted;
          }
        }

        let approvalEffectMayHaveStarted = false;
        const settleApprovedFailure = async (failure: ActionExecuteFailure, outcomeUnknown = false): Promise<ActionExecuteResult> => {
          const settledFailure = outcomeUnknown && !isActionOutcomeUnknownErrorCodeV1(failure.errorCode)
            ? { ok: false as const, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown',
                details: { reasonCode: failure.errorCode } }
            : failure;
          const settled = await executeApprovedActionForRequest({ artifactId, request: approvedRequest,
            artifactServerId: effectiveServerId, ctx,
            ...(outcomeUnknown ? { replayOutcomeUnknown: settledFailure } : { preExecutionFailure: settledFailure }) });
          return settled.ok ? buildApprovalDecisionResult(settled.request) : settled;
        };
        try {
        let preExecutionFailure: ActionExecuteFailure | undefined = readUnavailableApprovalReplayOrigin(approvedRequest) ?? undefined;
        if (approveAdmission?.status === 'unavailable') {
          preExecutionFailure = approveAdmission.reason === 'legacy_request'
            ? { ok: false, errorCode: 'approval_stale', error: 'approval_stale', details: { reason: 'origin_version' } }
            : {
                ok: false,
                errorCode: 'approval_context_unavailable',
                error: 'approval_context_unavailable',
                details: approveAdmission.details,
              };
        } else if (!preExecutionFailure && approvedRequest.v === 2) {
          let staleReason: ApprovalStaleReason = 'origin_not_current';
          const originIsCurrent = await isApprovalExecutionOriginCurrentForRequest({
            request: approvedRequest,
            reportStale: reason => { staleReason = reason; },
            ...(normalizeId(data.originServerId)
              ? { expectedOriginServerId: normalizeId(data.originServerId) }
              : {}),
            ...(normalizeId(ctx.serverIdentityId) || normalizeId(data.serverIdentityId)
              ? { expectedServerIdentityId: normalizeId(ctx.serverIdentityId) || normalizeId(data.serverIdentityId) }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (!originIsCurrent) {
            preExecutionFailure = { ok: false, errorCode: 'approval_stale', error: 'approval_stale', details: { reason: staleReason } };
          }
        }

        if (preExecutionFailure) {
          return await settleApprovedFailure(preExecutionFailure);
        }

        // Authenticated live delivery has reached the process holding private
        // input. A durable approved label never takes this branch on its own.
        const liveCliOrigin = requiresLiveCliApprovalOrigin(approvedRequest);
        if (liveCliOrigin && resolveHostStampedAuthority(ctx) === 'present_user') {
          const claimed = await resolveBlockingDecisionIfClaimed({ artifactId, decision: 'approve',
            decisionAuthority: 'present_user', request: approvedRequest, serverId: effectiveServerId });
          if (claimed) {
            approvalEffectMayHaveStarted = true;
            return buildApprovalDecisionResult(approvedRequest);
          }
        }

        // The host's replay adapter owns admission to an exact origin. A
        // process-local waiter cannot bypass that admission merely by being
        // alive in the deciding app. App-owned effects return null here and
        // continue through the same incumbent blocking coordinator below.
        if (deps.approvalRequestApprovedReplay && approvedRequest.v === 2 && !approvedRequest.requesterConfirmation) {
          const replayRequestId = normalizeId(ctx.actionRequestId)
            || (approvedRequest.v === 2 ? approvedRequest.executionOriginV1.requestId : '');
          let replayDispatched = false;
          let replay: ActionExecuteResult | null;
          try {
            replay = await deps.approvalRequestApprovedReplay({
              artifactId,
              request: approvedRequest,
              context: ctx,
              ...(liveCliOrigin ? { decision: 'approve' as const } : {}),
              onReplayDispatched: (dispatched = true) => { replayDispatched = dispatched; approvalEffectMayHaveStarted = dispatched; },
              ...(replayRequestId ? { requestId: replayRequestId } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          } catch (error) {
            replay = { ok: false, ...normalizeActionExecutorThrownError(error) };
          }
          if (replay !== null) {
            replay = readApprovalReplayResult(replay);
            const replayFailure = replay.ok ? null : replay;
            if (replayFailure) {
              // cli-v0.2.17 / cli-v0.2.17-preview.1 failures omit the producer
              // fact. Missing proof after dispatch remains unknown.
              const outcomeUnknown = isActionOutcomeUnknownErrorCodeV1(replayFailure.errorCode)
                || replayDispatched && replayFailure.effectAttempted !== false;
              // Preserve a definitive refusal; an unconfirmed dispatched call
              // instead requires a receipt before claiming any effect outcome.
              return await settleApprovedFailure(replayFailure, outcomeUnknown);
            }
            return replay;
          }
        }

        if (liveCliOrigin) {
          return await settleApprovedFailure({ ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' });
        }

        if (isBlockingApprovalRequest(approvedRequest)) {
          approvalEffectMayHaveStarted = true;
          const claimed = await resolveBlockingDecisionIfClaimed({
            artifactId,
            decision: 'approve',
            decisionAuthority: resolveHostStampedAuthority(ctx),
            ...(ctx.requesterApprovalDecision ? { requesterApprovalDecision: ctx.requesterApprovalDecision } : {}),
            request: approvedRequest,
            serverId: effectiveServerId,
          });
          if (claimed) return buildApprovalDecisionResult(approvedRequest);
          approvalEffectMayHaveStarted = false;
        }

        approvalEffectMayHaveStarted = true;
        const executed = await executeApprovedActionForRequest({
          artifactId,
          request: approvedRequest,
          artifactServerId: effectiveServerId,
          ...(normalizeId(data.originServerId)
            ? { expectedOriginServerId: normalizeId(data.originServerId) }
            : {}),
          ...(normalizeId(ctx.serverIdentityId) || normalizeId(data.serverIdentityId)
            ? { expectedServerIdentityId: normalizeId(ctx.serverIdentityId) || normalizeId(data.serverIdentityId) }
            : {}),
          ctx,
          observeExecution: true,
        });
        // A deferred mint has no original live waiter: deliver its bearer once
        // to the deciding human. A detached blocking invocation has lost its
        // secret custody and cannot recover it through another decision call.
        const liveResult = executed.ok && resolveHostStampedAuthority(ctx) === 'present_user'
          && approvedRequest.approval?.flow === 'deferred'
          && requestedActionId.success && getActionSpec(requestedActionId.data).approvalResultCustody === 'live_only'
          ? executed.exec : undefined;
        return executed.ok ? buildApprovalDecisionResult(executed.request, liveResult) : executed;
        } catch (error) {
          const failure = normalizeActionExecutorThrownError(error);
          return await settleApprovedFailure({ ok: false, ...failure, error: redactBugReportSensitiveText(failure.error) },
            approvalEffectMayHaveStarted);
        }
      }

      return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    } catch (error) {
      if (dispatchFacts.dispatchedPluginSessionInputLocalId !== null) {
        return {
          ok: true,
          result: {
            status: 'outcomeUnknown',
            localId: dispatchFacts.dispatchedPluginSessionInputLocalId,
            code: 'session_input_action_execution_failed',
          },
        };
      }
      const normalized = normalizeActionExecutorThrownError(error);
      const failure: ActionExecuteFailure = {
        ok: false,
        errorCode: normalized.errorCode,
        error: normalized.error,
        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
      };
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(failure, dispatchFacts.executionRunStartDispatched ? 'outcomeUnknown' : 'noRunCreated', error)
        : failure;
    }
  };

  async function executeCoreTerminal(
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
    inputAlreadyBound = false,
    legacyMetadataLabel?: string,
    prepared?: PreparedCoreAdmission,
    approvalReplay = false,
    approvedApiTokenExecution?: import('./blockingApprovalCoordinator.js').BlockingApprovalTokenExecution,
    sessionTargetLeaf = false,
    sameHome?: ActionHomeEquivalence,
    hostInternal = false,
  ): Promise<ActionExecuteResult> {
    const operationCredentialUses: ActionOperationCredentialUseV1[] = [];
    let observing = true;
    const recordOperationCredentialUse = (use: ActionOperationCredentialUseV1) => {
      if (!observing) return;
      const parsed = ActionOperationCredentialUseV1Schema.safeParse(use);
      if (!parsed.success) return;
      if (operationCredentialUses.some(existing => sameStrictJsonValue(existing, parsed.data))) return;
      operationCredentialUses.push(parsed.data);
      context?.recordOperationCredentialUse?.(parsed.data);
    };
    try {
      const result = await executeCore(
        actionId,
        input,
        { ...context, recordOperationCredentialUse },
        inputAlreadyBound,
        legacyMetadataLabel,
        { ...(prepared ? { prepared } : {}), ...(approvalReplay ? { approvalReplay: true } : {}),
          ...(hostInternal || prepared?.hostInternal ? { hostInternal: true } : {}),
          ...(sessionTargetLeaf ? { sessionTargetLeaf: true } : {}),
          ...(approvedApiTokenExecution ? { approvedApiTokenExecution } : {}),
          ...(sameHome ? { sameHome } : {}) },
      );
      if ('kind' in result) {
        throw new Error('Prepared Action invocation unexpectedly prepared twice');
      }
      // Only this invocation's host observer may stamp the annotation. An
      // arbitrary dependency/plugin result cannot assert a credential identity.
      const { operationCredentialUses: _untrustedAnnotation, ...unannotated } = result;
      const settled = settleActionOutput(actionId, unannotated);
      return operationCredentialUses.length ? { ...settled, operationCredentialUses } : settled;
    } finally {
      observing = false;
    }
  }

  function isDeferredApprovalResult(result: ActionExecuteResult): boolean {
    return result.ok
      && isRecord(result.result)
      && result.result.kind === 'approval_request_created';
  }

  function isReleasedAttachedExecutionRunSend(
    input: unknown,
    context: ActionExecutorContext,
  ): boolean {
    const record = readRecord(input);
    if (typeof record.sessionId === 'string') return true;
    if (Object.prototype.hasOwnProperty.call(record, 'sessionId')) return false;
    const defaultSessionId = typeof context.defaultSessionId === 'string'
      ? context.defaultSessionId.trim()
      : '';
    return defaultSessionId.length > 0
      && ExecutionRunSendRequestSchema.safeParse(input).success;
  }

  const prepareInvocationCore = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
    hostInternal = false,
    confirmUiDefault = false,
  ): Promise<PrivatePrepareResult> => {
    const normalizedContext = normalizeActionCallerContext(context ?? {});
    if (!normalizedContext) return settlePrepareResult(actionId, {
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
    });
    let ctx: ActionExecutorContext = normalizedContext;
    const attestationFailure = sessionAttestedContextCallerFailure(actionId, input, ctx);
    if (attestationFailure) return settlePrepareResult(actionId, attestationFailure);
    const spec = getActionSpec(actionId);
    const workspaceFailure = workspaceWriteFailure(spec, input, ctx);
    if (workspaceFailure) return settlePrepareResult(actionId, workspaceFailure);
    // Released attached send cannot be approximated by the Session queue's delivery modes.
    if (actionId === 'execution.run.send' && isReleasedAttachedExecutionRunSend(input, ctx)) {
      return settlePrepareResult(actionId, {
        ok: false,
        errorCode: 'session_input_target_update_required',
        error: 'session_input_target_update_required',
      });
    }
    const authorityFailure = requiredAuthorityFailure(spec, ctx, input);
    if (authorityFailure) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, authorityFailure));
    }
    let selectorIntent = false;
    const sessionTarget = readActionSessionTargetDeclaration(actionId, input, ctx);
    if (sessionTarget) {
      try { selectorIntent = sessionTarget.field.includes('*')
        ? readActionSessionTargetOperands(readRecord(input), sessionTarget.field).length > 0
        : typeof normalizeSessionTargetV1(readActionSessionTargetField(readRecord(input), sessionTarget.field)) !== 'string'; }
      catch { /* Canonical semantic parsing below returns invalid_parameters. */ }
    }
    const credentialFailure = selectorIntent
      ? credentialScopeFailure(actionId, ctx, hostInternal ? input : undefined, true, undefined, hostInternal)
      : await admitCredentialScope(actionId, ctx, actionId === 'session.spawn_new' ? undefined : input, hostInternal);
    if (credentialFailure) return settlePrepareResult(actionId, credentialFailure);
    if (ctx.surface === 'plugin' && ctx.actionCaller?.kind !== 'plugin') {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, {
        ok: false,
        errorCode: 'plugin_action_caller_required',
        error: 'plugin_action_caller_required',
      }));
    }
    if (actionId === 'session.spawn_new' && isAgentCaller(ctx)) {
      const authoring = SessionSpawnNewActionAgentAuthoringInputV2Schema.safeParse(input ?? {});
      if (!authoring.success) return settlePrepareResult(actionId,
        actionInputValidationFailure(authoring.error));
      const authored = authoring.data;
      if (typeof authored.profileId === 'string' && authored.roleId === undefined) {
        const availability = hostInternal ? null : resolveAvailabilityForContext(spec, ctx);
        const enabled = hostInternal ? isHostInternalActionEnabled(spec, ctx)
          : availability ? availability.available : isActionEnabled(spec, ctx);
        if (!enabled) return settlePrepareResult(actionId, actionDisabled(availability));
        const permission = resolveAgentEffectivePermission(ctx);
        if (!permission.ok) return settlePrepareResult(actionId, permission.error);
        const profileAdmission = await resolveProfileSkillSeedsAtAdmissionV1(authored, deps, ctx);
        if (!profileAdmission.ok) return settlePrepareResult(actionId, profileAdmission);
        // A Role can replace the authored Profile. Keep native dispatch as the
        // final seed projector after interception and deferred approval, so
        // this early availability check cannot retain superseded seeds.
      }
      if (authored.executionTarget === undefined || authored.agentTarget === undefined) {
        // Both intercepted and direct invocations resolve inherited choices at
        // the authenticated start owner before strict creation-input parsing.
        const startContext = await resolveActionAgentStartContextV1(deps, ctx);
        if (!startContext) return settlePrepareResult(actionId,
          actionStartTargetUnavailableV1(ctx, 'agent_start_context', 'agent_start_context_unavailable'));
        ctx = { ...ctx, agentStartContext: startContext };
        const inheritedTarget = startContext.caller.kind === 'session'
          ? startContext.baseline.configuration?.agentTarget : undefined;
        // Host baselines may carry routing refs; creation takes the canonical
        // contribution target projected by the existing target-key owner.
        const agentTarget = authored.agentTarget === undefined && inheritedTarget
          ? parseBackendTargetKeyV2(buildBackendTargetKeyV2(inheritedTarget)) : undefined;
        input = { ...authored,
          ...(authored.executionTarget === undefined && ctx.serverId && startContext.baseline.machineId
            ? { executionTarget: { serverId: ctx.serverId, machineId: startContext.baseline.machineId } } : {}),
          ...(authored.agentTarget === undefined && agentTarget ? { agentTarget } : {}),
        };
      }
    }
    if (ctx.bypassActionInterception || (!deps.interceptActionExecution && !deps.observeActionExecution)) {
      return settlePrepareResult(actionId, await executeCore(
        actionId,
        input,
        ctx,
        false,
        undefined,
        { prepareOnly: true, hostInternal, confirmUiDefault },
      ));
    }

    const inputSchema = hostInternal ? spec.inputSchema : callerInputSchema(spec, ctx);
    const parsedInitialInput = inputSchema.safeParse(input ?? {});
    if (!parsedInitialInput.success) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        actionInputValidationFailure(parsedInitialInput.error),
      ));
    }
    const initialCurrentSessionScopeFailure = selectorIntent || hasSessionQuestionAnswerOrigin(actionId, ctx)
      ? null : await resolveActionCurrentSessionScopeFailure(
      actionId,
      parsedInitialInput.data,
      ctx,
      spec.contextualDefaults,
      deps,
      resolved => { ctx = { ...ctx, agentStartContext: resolved }; },
    );
    if (initialCurrentSessionScopeFailure) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        initialCurrentSessionScopeFailure,
      ));
    }
    const initialPluginCallerPolicyFailure = pluginActionCallerPolicyFailure(
      spec,
      parsedInitialInput.data,
      ctx,
    );
    if (initialPluginCallerPolicyFailure) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, initialPluginCallerPolicyFailure));
    }

    const caller = ctx.actionCaller ?? { kind: 'host' as const };
    if (actionId === 'plugins.settings.set') {
      const admitInput = deps.pluginSettingsAdministrationAction?.admitInput;
      if (!admitInput) return settlePrepareResult(actionId, { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
      const admissionFailure = await admitInput({ actionId, input: parsedInitialInput.data, context: ctx });
      if (admissionFailure) return settlePrepareResult(actionId, admissionFailure);
      if (ctx.signal?.aborted) return settlePrepareResult(actionId, { ok: false, errorCode: 'cancelled', error: 'cancelled' });
    }
    let transformedInput: unknown = parsedInitialInput.data;
    if (deps.interceptActionExecution) {
      let intercepted;
      try {
        intercepted = await deps.interceptActionExecution({
          actionId,
          input: parsedInitialInput.data,
          context: ctx,
          caller,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch {
        return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, {
          ok: false,
          errorCode: 'action_interception_failed',
          error: 'action_interception_failed',
          details: { code: 'plugin_hook_handler_failed' },
        }));
      }

      if (intercepted.status === 'rejected') {
        return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, {
          ok: false,
          errorCode: 'action_interception_rejected',
          error: 'action_interception_rejected',
          ...(intercepted.code || intercepted.message
            ? {
                details: {
                  ...(intercepted.code ? { code: intercepted.code } : {}),
                  ...(intercepted.message ? { message: intercepted.message } : {}),
                },
              }
            : {}),
        }));
      }
      if (intercepted.status === 'failed') {
        return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, {
          ok: false,
          errorCode: 'action_interception_failed',
          error: 'action_interception_failed',
          details: { code: intercepted.code },
        }));
      }
      transformedInput = intercepted.input;
    }

    const parsedTransformedInput = inputSchema.safeParse(transformedInput);
    if (!parsedTransformedInput.success) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        actionInputValidationFailure(parsedTransformedInput.error),
      ));
    }

    const bound = await bindCallerInput(spec, parsedTransformedInput.data, ctx, hostInternal);
    if (!bound.ok) return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, bound));
    const parsedSemanticInput = spec.inputSchema.safeParse(bound.input);
    if (!parsedSemanticInput.success) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        actionInputValidationFailure(parsedSemanticInput.error),
      ));
    }

    const prepared = settlePrepareResult(actionId, await executeCore(
      actionId,
      parsedSemanticInput.data,
      ctx,
      true,
      undefined,
      { prepareOnly: true, hostInternal, confirmUiDefault },
    ));
    const observeResult = async (result: ActionExecuteResult): Promise<void> => {
      try {
        const observedInput = spec.projectObservationInput
          ? spec.projectObservationInput(parsedSemanticInput.data)
          : parsedSemanticInput.data;
        await deps.observeActionExecution?.({
          actionId,
          input: observedInput,
          context: projectActionObservationContext(actionId, ctx),
          caller,
          result: projectActionExecutionObservation(actionId, result),
        });
      } catch {
        // The action effect/result is authoritative; after-hook observation is diagnostic only.
      }
    };
    if (prepared.kind === 'settled') {
      if (!isDeferredApprovalResult(prepared.result)) {
        await observeResult(prepared.result);
      }
      return prepared;
    }

    return {
      kind: 'ready',
      admission: prepared.admission,
      invocation: createOneShotInvocation(async () => {
        const result = await prepared.invocation.run();
        await observeResult(result);
        return result;
      }),
    };
  };

  const prepareInvocation = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
    hostInternal = false,
    confirmUiDefault = false,
  ): Promise<PrivatePrepareResult> => {
    try {
      return await prepareInvocationCore(actionId, input, context, hostInternal, confirmUiDefault);
    } catch (error) {
      // Preparation never enters the Run transport; only the ready invocation can do so.
      if (actionId !== 'execution.run.start') throw error;
      return settlePrepareResult(actionId, classifyExecutionRunStartFailure(
        { ok: false, ...normalizeActionExecutorThrownError(error) }, 'noRunCreated', error));
    }
  };

  const executeInvocation = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
    hostInternal = false,
  ): Promise<ActionExecuteResult> => {
    const prepared = await prepareInvocation(actionId, input, context, hostInternal, true);
    if (hostInternal && prepared.kind === 'ready' && deps.routeHostChildAction) {
      const spec = getActionSpec(actionId);
      const admitted = prepared.admission;
      if (resolveActionExecutionPlacementForInput(spec, admitted.input) === 'machine') {
        const routed = await deps.routeHostChildAction({ actionId, input: admitted.input, context: admitted.context });
        if (routed) return settleActionOutput(actionId, routed);
      }
    }
    const result = prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
    // Admission may cancel before this read-only Action's observation arm runs.
    if (actionId === 'wait' && !result.ok && result.errorCode === 'cancelled') {
      const request = WaitActionInputV1Schema.safeParse(input);
      if (request.success) return settleActionOutput(actionId, { ok: true, result: {
        target: request.data.target, condition: request.data.condition, disposition: 'cancelled',
      } });
    }
    return result;
  };

  const prepare = async (actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionPrepareResult> => {
    const prepared = await prepareInvocation(actionId, input, context);
    return prepared.kind === 'ready' ? { kind: 'ready', invocation: prepared.invocation } : prepared;
  };
  const execute = (actionId: ActionId, input: unknown, context?: ActionExecutorContext) =>
    executeInvocation(actionId, input, context);

  async function isDecidingHumanAdmissionCurrent(ctx: ActionExecutorContext): Promise<boolean> {
    if (ctx.signal?.aborted) return false;
    try {
      const admitted = !ctx.verifyMachineAdmissionCurrent || await ctx.verifyMachineAdmissionCurrent();
      return admitted && !ctx.signal?.aborted;
    } catch {
      return false;
    }
  }

  async function continueConfidentialApprovalRequest(input: unknown, ctx: ActionExecutorContext = {}): Promise<ActionExecuteResult> {
    if (resolveHostStampedAuthority(ctx) !== 'present_user') {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    const parsed = PrivateSecretContinuationV1Schema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if (!deps.approvalsGet || !deps.approvalsUpdate) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    }
    let continuation: PrivateSecretContinuationV1 | null = parsed.data;
    try {
      const raw = await deps.approvalsGet({ artifactId: continuation.artifactId, serverId: null });
      const stored = StoredApprovalRequestSchema.safeParse(raw);
      if (!stored.success || stored.data.v !== 2) {
        return { ok: false, errorCode: raw ? 'approval_invalid' : 'approval_not_found', error: raw ? 'approval_invalid' : 'approval_not_found' };
      }
      let request: ApprovalRequest = stored.data;
      const origin = stored.data.executionOriginV1;
      if (request.actionId !== continuation.actionId || origin.requestId !== continuation.requestId
        || origin.serverId !== continuation.request.serverId || origin.sessionId !== continuation.request.sessionId
        || origin.machineId !== continuation.request.machineId
        || (ctx.serverId && ctx.serverId !== origin.serverId
          && (!origin.serverIdentityId || ctx.serverIdentityId !== origin.serverIdentityId))
        || (ctx.serverIdentityId && origin.serverIdentityId && ctx.serverIdentityId !== origin.serverIdentityId)
        || JSON.stringify(request.actionArgs) !== JSON.stringify(continuation.request)
        || (continuation.submit && !continuation.request.submit)) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      const recorded = buildActionExecuteResultFromRecordedApprovalExecution(request);
      if (recorded) return recorded;
      if (request.status === 'executing') {
        return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
      }
      if (request.status !== 'open') return { ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' };
      const callerGrant = ctx.externalActionCredential?.grant;
      const target = origin.target ?? { kind: 'session' as const, sessionId: continuation.request.sessionId };
      if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, target, origin.machineId)) {
        return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
      }
      if (!isActionEnabled(getActionSpec(continuation.actionId), { ...ctx, surface: origin.surface })) {
        return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
      }
      if (!await isApprovalExecutionOriginCurrentForRequest({ request, expectedOriginServerId: origin.serverId,
        ...(ctx.signal ? { signal: ctx.signal } : {}) }) || !await isDecidingHumanAdmissionCurrent(ctx)) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      const now = Date.now();
      request = { ...request, status: 'approved', updatedAtMs: Math.max(now, request.updatedAtMs),
        decision: { kind: 'approve', decidedAtMs: now, authority: 'present_user' } };
      const claimed = await deps.approvalsUpdate({ artifactId: continuation.artifactId, request, serverId: origin.serverId });
      const failure = readActionFailureEnvelope(claimed);
      if (failure) return failure;
      const execution = await executeApprovedActionForRequest({ artifactId: continuation.artifactId, request,
        artifactServerId: origin.serverId, expectedOriginServerId: origin.serverId, ctx,
        privateSecretContinuation: continuation, observeExecution: true });
      return execution.ok ? execution.exec : execution;
    } finally {
      // JavaScript cannot promise forensic string erasure; no owned durable reference remains.
      continuation = null;
    }
  }

  return {
    prepare,
    execute,
    continueConfidentialApprovalRequest,
    replayApprovedApprovalRequest,
  };
}
