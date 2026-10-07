import { resolveInputOptions, normalizeResolvedOptions, tryNormalizeExecutionBackendOptionValue, readReviewNarratorOptions, buildAgentInventorySelectionArgs } from '../inputs/inputOptions.js';
import { InputOptionsConsumerV1Schema, inputOptionsConsumerActionId } from '../inputs/inputOptionsConsumer.js';
import { readRecord, readNonEmptyString, isRecord, hasOwn } from '../inputs/inputRecords.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import type { PublicActionInputById } from './actionSpecs.js';
import { WaitActionInputV1Schema } from './specs/wait.js';
import { executeWaitActionV1 } from './executor/waitAction.js';
import { isWorkspaceActionId } from './workspaceActionFamily.js';
import { isSessionCanvasActionId } from './sessionCanvasActionFamily.js';
import { isSessionTerminalActionId } from './sessionTerminalActionFamily.js';
import { parseWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionRefV1.js';
import { ComputerSelectedTargetResponseV1Schema, ComputerTargetSelectRequestV1Schema, ComputerTargetsListResponseV1Schema, computerTargetKeyV1, type ComputerApprovalDisplayV1 } from '../computer/v1.js';
import { isSessionFollowActionIdV1 } from '../sessions/follow/actions.js';
import { evaluateApiTokenGrantV1, isApiTokenGrantTargetMemberV1, isPermissionModeGrantedV1 } from '../auth/apiTokenGrant.js';
import { resolveCredentialActionAdmissionV1, canRequestPresentUserApprovalForActionInputV1, requiresPresentUserDecisionForActionInputV1, requiresPresentUserExecutionAuthorityForActionInputV1 } from './decisionAuthority.js';
import { SESSION_PERMISSION_MODES } from '../sessions/metadata/sessionPermissionModes.js';
import { SessionPermissionRespondActionDecisionV1Schema, SessionPermissionRespondRpcParamsV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import { SessionWorkerPublishInputV1Schema, SessionWorkerPublishOutputV1Schema } from '../sessions/relations/workerUpdateV1.js';
import { MachinesAgentsListInputSchema } from '../capabilities/machineAgentInventory.js';
import { WorkspaceFilesSearchActionInputSchema } from './actionSpecs.js';
import { HomeConnectInputSchema, MachineAddCommandInputSchema, MachinePairingCreateInputSchema, MachineTerminalOpenInputSchema, MachineTerminalListInputSchema, MACHINE_ADD_SSH_ACTION_IDS, MACHINE_ADD_SSH_INPUT_SCHEMAS, type MachineAddSshActionId } from './specs/machineConnection.js';
import { NotificationsNotifyMeInputV1Schema } from '../account/notifications/notifyMeV1.js';
import { MachinesAgentsSignInStartInputSchema, MachinesAgentsSignInStatusInputSchema, MachinesAgentsSignInCancelInputSchema } from '../daemon/agentSignIn.js';
import { isRoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { isWorkBoardActionIdV1 } from '../boards/actionIdsV1.js';
import { WorkBoardActionInputSchemasV1 } from '../boards/actionsV1.js';
import { HOME_HUB_LAYOUT_ACTION_IDS, HomeHubLayoutUpdateInputSchema } from './specs/homeHub.js';
import { WidgetInstanceActionIdV1Schema, WidgetSurfaceReadV1Schema, readWidgetActionSurfaceV1, readWidgetActionDestinationV1, readWidgetCatalogBoundSessionV1 } from '../widgets/actionsV1.js';
import { executeWidgetInstanceActionV1, admitWidgetInstanceConfigurationV1, readWidgetActionSurfacePortV1 } from '../widgets/executeWidgetInstanceActionV1.js';
import { clientActionUnavailable } from './clientDispatchV1.js';
import { WidgetDefinitionActionIdV1Schema } from '../widgets/definitionActionIdsV1.js';
import { readWidgetDefinitionActionAccountV1, readWidgetDefinitionActionSessionV1 } from '../widgets/definitionActionsV1.js';
import { admitWidgetActionSurfaceV1 } from '../widgets/widgetActionScopeV1.js';
import { executeWidgetDefinitionActionV1 } from '../widgets/executeWidgetDefinitionActionV1.js';
import { executeWidgetSnapshotPostV1 } from '../widgets/executeWidgetSnapshotPostV1.js';
import { prepareWidgetDefinitionPublicationV1 } from '../widgets/widgetDefinitionPublicationV1.js';
import type { HomeHubLayoutActionId } from './specs/homeHub.js';
import { executeWorkBoardActionV1 } from '../boards/executeWorkBoardActionV1.js';
import { snapshotSessionRolesAtSpawnV1 } from '../prompts/roles/sessionRolesSnapshot.js';
import { LaunchProfilePublishInputV1Schema } from '../launchProfiles/publishLaunchProfile.js';
import {
  DaemonAgentInstallStartRequestSchema,
  DaemonAgentInstallReadRequestSchema,
  DaemonAgentInstallCancelRequestSchema,
} from '../daemon/agentInstallJobs.js';
import {
  AgentsAcpBackendsDeleteInputV1Schema,
  AgentsAcpBackendsUpsertInputV1Schema,
  applyAcpBackendDeleteV1,
  applyAcpBackendUpsertV1,
} from '../acp/catalog/catalogMutationsV1.js';
import { SESSION_TOOL_ANSWER_DELIVERY_KIND } from '../sessions/messages/sessionMessageMeta.js';
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
import { resolveActionApprovalFlow } from './actionApprovalMetadata.js';
import { inputTypeOptionsSourceId, parseInputTypeOptionsSourceId } from '../inputs/inputTypes.js';
import { resolveActionApprovalRouting, SURFACE_AUTHORITY_AGENT_FLOOR } from './actionApprovalPolicy.js';
import { resolveWorkflowRunStartedByForActionCallerV1 } from '../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { readActionCallerLedSubtreeSessionIds } from './executor/sessionLedSubtree.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { resolveRequestedSessionModeId } from './sessionModeIds.js';
import {
  findSpawnConfigOptionAliasConflicts,
  mergeSpawnConfigOptionAliases,
} from './sessionSpawnConfigOptions.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from './executionRunActionPermissionMode.js';
import { parseAgentPermissionIntentV1Alias } from '../runtime/permissionIntentV1.js';
import type { AcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import type { ConnectedServiceBindingsV2 } from '../connect/connectedServiceBindings.js';
import {
  assertNonEscalatingPermissionMode,
  resolveEffectivePermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  type PermissionEscalationDecision,
} from './permissionPrivilege.js';
import {
  isActionEnabledByActionsSettings,
  type ActionsSettingsV1,
} from './actionSettings.js';
import type { ActionDefinitionSummaryV1 } from './actionDefinitionV1.js';
import {
  ActionSurfaceSchema,
  DetachedExecutionRunSendInputSchema,
  ExecutionRunPermissionRespondInputSchema,
  SessionListActionInputV1Schema,
  SessionModelSetInputSchema,
  getActionSpec,
  resolveActionExecutionPlacementForInput,
  listActionSpecs,
  isActionSpecSurfacedOn,
  isPluginActionCallerPolicySatisfied,
  type ActionRequiredAuthority,
  type ActionSpec,
  type ActionSurfaces,
  type PublicActionResultById,
} from './actionSpecs.js';
import {
  SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
  SESSION_LIST_AWARENESS_VIEW_V1,
  SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
  SessionListViewV1Schema,
  parseSessionAwarenessListResultV1,
  parseSessionListQueryActionResultV1,
} from '../sessions/awareness/action.js';
import { SessionListUnavailableQueryV1Schema, SessionListQueryV1Schema } from '../sessions/listing/query.js';
import { SessionReportsToSetActionInputV1Schema, SessionReportsToSetResultV1Schema } from '../sessions/relations/sessionReportsToV1.js';
import { SessionAwarenessProjectionV1Schema } from '../sessions/awareness/projectionV1.js';
import {
  resolveActionSurfaceAvailability,
  type ActionSurfaceAvailability,
} from './actionSurfaceAvailability.js';
import {
  ACTION_ID_FAMILIES_V1,
  isPluginDevLoopActionIdV1,
  isRuntimeActionIdV1,
  isSessionAccessActionId,
  ActionIdSchema,
  type ActionId,
  WorkflowActionIdV1Schema,
} from './actionIds.js';
import { WorkflowActionInputSchemasV1 } from '../workflows/actionsV1.js';
import { ArtifactAccessActionIdV1Schema, ArtifactAccessActionInputSchemasV1, ArtifactAccessActionOutputSchemasV1 } from '../artifacts/artifactAccessV1.js';
import { ArtifactActionIdV1Schema, ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1 } from '../artifacts/artifactActionsV1.js';
import { WorkflowActionFailureV1Schema } from '../workflows/workflowProgressV1.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../memory/memoryWindow.js';
import { resolveSubagentLaunchStructuredSend } from '../messages/structured/subagentLaunchV1.js';
import { ParticipantRecipientRoutingIdentityV1Schema } from '../messages/structured/participantMessageV1.js';
import {
  ApprovalExecutionOriginV1Schema,
  ApprovalRequestOriginV1Schema,
  StoredApprovalRequestSchema,
  type ApprovalExecutionOriginCallerV1,
  type ApprovalExecutionOriginV1,
  type ApprovalRequest,
  type ApprovalRequestOriginV1,
  type ApprovalRequestV1,
  type ApprovalRequestV2,
} from '../approvals/approvalRequestV1.js';
import {
  projectApprovalExecutionFailureV2,
  readApprovalExecutionFailure,
} from '../approvals/approvalExecutionFailure.js';
import { settleApprovalRequestActionArgs } from '../approvals/approvalRequestTransition.js';
import type { PromptRegistryConfiguredSourceV1 } from '../prompts/library/promptRegistriesV1.js';
import { ProviderConnectionIdSchema } from '../providers/ids.js';
import {
  BackendTargetKeySchema,
  buildBackendTargetKey,
  type BackendTargetRefV1,
} from '../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import {
  TeamCredentialProviderModelSelectionV1Schema,
  type TeamCredentialProviderModelSelectionV1,
} from '../teams/credentials/resourceV1.js';
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
import { SessionDiscussionActionIdV1Schema } from '../sessions/discussions/actionIds.js';
import { SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1 } from '../sessions/discussions/actions.js';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  parseSessionBoardActionPortResultV1,
} from '../sessions/board/actions.js';
import { CurrentSessionPresentationActionInputV1Schema } from '../sessions/presentation/currentSessionPresentationV1.js';
import {
  MachinePoolActionIdV1Schema,
  MachinePoolActionInputSchemasV1,
} from '../machines/pools/actionsV1.js';
import { EphemeralRunnerActionIdV1Schema } from '../ephemeralRunner/actionIdsV1.js';
import { EphemeralRunnerActionInputSchemasV1 } from '../ephemeralRunner/actionsV1.js';
import { isHomeDomainActionIdV1 } from './homeDomainActionFamily.js';
import { ScopeActionIdSchema } from './scopeActionFamily.js';
import { ConnectedServiceConfigurationActionIdV1Schema } from '../connect/configurationActionsV1.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { isVoiceConversationActionId } from './voiceConversationActionFamily.js';
import { isAppShellActionId } from './appShellActionFamily.js';
import { isNotificationConfigurationActionId } from './notificationConfigurationActionFamily.js';
import { isAppUpdateActionId } from './appUpdateActionFamily.js';
import { SessionOrganizationContentUnavailableError } from '../sessions/organization/content.js';
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
import {
  PluginSettingsAdministrationActionIdV1Schema,
  PluginSettingsAdministrationActionInputSchemasV1,
} from '../plugins/settingsAdministration.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import {
  formatQualifiedPluginActionId,
  parseQualifiedPluginActionId,
  type QualifiedPluginActionId,
} from '../plugins/actions/invocation.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  PluginSessionInputSourceV1Schema,
  PluginSessionUserTextAuthoredFieldSchemasV1,
  SessionInputCausalPermissionAuthorityV1Schema,
  SessionInputSourceSessionV1Schema,
  derivePluginSessionInputLocalIdV1,
  type SessionInputCausalPermissionAuthorityV1,
} from '../sessions/messages/sessionInputAdmission.js';
import { SessionDiscussionSelectionSourceV1Schema } from '../sessions/discussions/content.js';
import { PendingRequestedActionV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
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
import {
  type SessionHandoffAbortRequest,
  type SessionHandoffCommitRequest,
  type SessionHandoffPrepareTargetResultGetRequest,
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResumeRequest,
  type SessionHandoffStatusGetRequest,
} from '../sessions/control/handoff/handoffSchemas.js';
import {
  WorkspaceSyncConflictResolveActionInputV1Schema,
  WorkspaceSyncConflictsListActionInputV1Schema,
  WorkspaceSyncConflictInspectActionInputV1Schema,
  WorkspaceSyncRelationshipsListActionInputV1Schema,
  WorkspaceSyncRelationshipCreateActionInputV1Schema,
  type HandoffWorkspaceActionV1,
} from '../sessions/control/handoff/workspaceSyncSchemas.js';
import {
  HandoffTargetReplacementApprovalV1Schema,
  sameHandoffTargetReplacementApproval,
  type HandoffTargetReplacementApprovalV1,
} from '../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import type { SessionContinueWithReplayRpcParams } from '../sessions/continueWithReplay.js';
import { SessionForkRpcParamsSchema } from '../sessions/fork.js';
import { SpawnSessionErrorCodeSchema } from '../sessions/spawnSession.js';
import { SessionControlErrorCodeSchema } from '../sessions/control/contract.js';
import { readRpcErrorCode, RPC_ERROR_CODES } from '../rpc/errors.js';
import {
  deriveSessionCreationTagV1,
  SessionCreationKeyV1Schema,
  type SessionCreationKeyV1,
} from '../sessions/creation/sessionCreationIdentityV1.js';
import {
  SessionSpawnNewInputV2Schema,
  type SessionSpawnNewInputV2,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import {
  SessionAgentSpawnPolicyV1StrictSchema,
} from '../account/settings/accountSettings.js';
import {
  admitActionAgentStartV1, isAgentStartActionV1, isActionCallerOwnSessionV1, requiresActionAgentStartDepthV1, resolveActionAgentStartRequestsV1,
  resolveActionAgentStartContextV1, resolveRunStartModelAndConfig, stampAgentStartSelectionV1,
} from './executor/agentStartAdmission.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import {
  SessionCreationDirectoryApprovalV1Schema,
  type SessionCreationDirectoryApprovalV1,
} from '../sessions/creation/sessionCreationTargetPreparationV1.js';
import { ExecutionRunActionResponseSchema, ExecutionRunEnsureOrStartResponseSchema, ExecutionRunEnsureResponseSchema, ExecutionRunSendRequestSchema } from '../execution/runs/index.js';
import { ExecutionRunCancelTurnRequestSchema, ExecutionRunCancelTurnResponseSchema } from '../execution/runs/cancelTurn.js';
import { ExecutionRunSendResponseSchema, readExecutionRunStartRunCreation, ExecutionRunStartResponseSchema, ExecutionRunStopResponseSchema, ExecutionRunWaitResultSchema, ExecutionRunGetResponseSchema, withExecutionRunStartFailureDetails } from '../execution/runs/responseSchemas.js';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '../execution/runs/streaming.js';
import { ExecutionRunWaitConditionSchema } from '../execution/runs/waitForTerminal.js';
import { type ExecutionRunLaunchOrigin } from '../execution/runs/startRequest.js';
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
import {
  resolveActionBackendTargetSelection,
  resolveExecutionBackendTargetSelectionForValue,
} from './resolveActionBackendTargetSelection.js';
import { projectActionExecuteFailure } from './actionExecutionResult.js';
import { dispatchRuntimeAction } from './executor/dispatch.js';
import { type RuntimeActionExecute } from './executor/types.js';
import {
  TeamInvitationAcceptApprovalPrepareResultV1Schema,
  TeamInvitationAcceptInputV1Schema,
} from '../teams/invitation.js';

import type {
  ActionCaller,
  ActionExecuteResult,
  ActionExecutorContext,
  ActionExecutorDeps,
  ActionSessionAddress,
  ActionSessionReferenceResolution,
  ActionPreparedInvocation,
  ActionPrepareResult,
  HostExternalSessionActionId,
  PluginExternalSessionActionId,
  ScmActionId,
  SessionPermissionRemoteActionId,
} from './executor/types.js';
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

const SCM_ACTION_ID_SET: ReadonlySet<ActionId> = new Set([
  ...ACTION_ID_FAMILIES_V1.scm_git,
  ...ACTION_ID_FAMILIES_V1.scm_pull_request,
  ...ACTION_ID_FAMILIES_V1.scm_repository,
  ...ACTION_ID_FAMILIES_V1.scm_diff_summary,
]);
const SESSION_TRANSCRIPT_ACTION_ID_SET: ReadonlySet<ActionId> = new Set(
  ACTION_ID_FAMILIES_V1.session_transcripts,
);

// Plugin-provenance External Session registration. The low-level ephemeral
// viewer-lease Actions (`sessions.external.follow`/`unfollow`) are excluded
// from the plugin projection by the canonical owner
// (`PLUGIN_SURFACE_EXCLUSION_REASONS`), so they must not be registered here;
// authors use `SessionsService.external.followTranscript`, and the retained
// host route lives in HOST_EXTERNAL_SESSION_ACTION_ID_SET below.
const PLUGIN_EXTERNAL_SESSION_ACTION_ID_SET: ReadonlySet<ActionId> = new Set([
  'sessions.external.materialize.start',
  'sessions.external.status.get',
  'sessions.external.operation.status.get',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'sessions.external.backgroundFollow.set',
]);

const HOST_EXTERNAL_SESSION_ACTION_ID_SET: ReadonlySet<ActionId> = new Set([
  ...PLUGIN_EXTERNAL_SESSION_ACTION_ID_SET,
  // Released RPC/API clients reach the ephemeral lease seams through the host
  // external-session owner; that domain/RPC implementation stays here.
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.candidates.list',
  'sessions.external.candidate.delete',
  'sessions.external.link.ensure',
  'sessions.external.transcript.page',
  'sessions.external.transcript.readAfter',
  'sessions.external.takeover.start',
]);

const SESSION_PERMISSION_REMOTE_ACTION_ID_SET: ReadonlySet<ActionId> = new Set([
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.user_action.remote.answer',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
]);

function isPluginExternalSessionActionId(
  actionId: ActionId,
): actionId is PluginExternalSessionActionId {
  return PLUGIN_EXTERNAL_SESSION_ACTION_ID_SET.has(actionId);
}

function isHostExternalSessionActionId(
  actionId: ActionId,
): actionId is HostExternalSessionActionId {
  return HOST_EXTERNAL_SESSION_ACTION_ID_SET.has(actionId);
}

function isSessionPermissionRemoteActionId(
  actionId: ActionId,
): actionId is SessionPermissionRemoteActionId {
  return SESSION_PERMISSION_REMOTE_ACTION_ID_SET.has(actionId);
}

function isScmActionId(actionId: ActionId): actionId is ScmActionId {
  return SCM_ACTION_ID_SET.has(actionId);
}

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function resolveExecutionRunLaunchOrigin(ctx: ActionExecutorContext): ExecutionRunLaunchOrigin {
  const discussionSource = SessionDiscussionSelectionSourceV1Schema.safeParse(ctx.sessionInputSource);
  if (discussionSource.success) return discussionSource.data;
  const source = SessionInputSourceSessionV1Schema.safeParse(ctx.sessionInputSource);
  if (source.success) {
    return { kind: 'session', sessionId: source.data.sourceSessionId };
  }
  if (ctx.surface === 'agent') {
    const sessionId = normalizeId(ctx.defaultSessionId);
    return sessionId ? { kind: 'session', sessionId } : { kind: 'external' };
  }
  if (ctx.surface === 'cli' || ctx.surface === 'mcp') {
    return { kind: 'external', source: ctx.surface };
  }
  return ctx.surface ? { kind: 'external', source: 'action' } : { kind: 'external' };
}




function reviewScopeForInput(input: unknown): 'paths' | undefined {
  const record = readRecord(input);
  return hasOwn(record, 'selectedPaths') || hasOwn(record, 'selectedFiles') ? 'paths' : undefined;
}

function readNullableString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}


function readTranscriptDirection(raw: unknown): 'before' | 'after' | undefined {
  return raw === 'before' || raw === 'after' ? raw : undefined;
}

function readTranscriptScope(raw: unknown): 'main' | 'sidechain' | 'all' | undefined {
  return raw === 'main' || raw === 'sidechain' || raw === 'all' ? raw : undefined;
}

function readEventFormat(raw: unknown): 'compact' | 'raw' | undefined {
  return raw === 'compact' || raw === 'raw' ? raw : undefined;
}

function readUserActionDecision(raw: unknown): 'approve' | 'reject' | 'request_changes' | undefined {
  return raw === 'approve' || raw === 'reject' || raw === 'request_changes' ? raw : undefined;
}

function readPermissionResponseDecision(raw: unknown) {
  const parsed = SessionPermissionRespondActionDecisionV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function readApprovalRequestStatus(raw: unknown): ApprovalRequest['status'] | null {
  return raw === 'open'
    || raw === 'approved'
    || raw === 'rejected'
    || raw === 'executed'
    || raw === 'failed'
    || raw === 'canceled'
    ? raw
    : null;
}


function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function readFiniteNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function readStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.every(([, value]) => typeof value === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function resolveSessionSpawnNewCreationKey(
  data: Readonly<Record<string, unknown>>,
  ctx: ActionExecutorContext,
): SessionCreationKeyV1 | null {
  const explicitCreationKey = SessionCreationKeyV1Schema.safeParse(data.creationKey);
  const actionRequestId = readNonEmptyString(ctx.actionRequestId);
  const creationKey = explicitCreationKey.success
    ? explicitCreationKey.data
    : actionRequestId
      ? SessionCreationKeyV1Schema.parse(`action-request:${actionRequestId}`)
      : null;
  return creationKey;
}

/**
 * A deferred Session spawn must retain the same durable creation identity that
 * a live API invocation derives from its host-stamped request id. The approval
 * artifact is the only replay input; the later present-user decision has its
 * own context and must not need (or inherit) the original external request.
 */
function materializeSessionSpawnApprovalInput(
  input: unknown,
  ctx: ActionExecutorContext,
): unknown {
  const canonical = SessionSpawnNewInputV2Schema.safeParse(input);
  if (!canonical.success) return input;
  const creationKey = resolveSessionSpawnNewCreationKey(canonical.data, ctx);
  return creationKey
    ? { ...canonical.data, creationKey }
    : canonical.data;
}

function buildSessionSpawnNewArgs(
  data: Readonly<Record<string, unknown>>,
  ctx: ActionExecutorContext,
  legacyMetadataLabel?: string,
): Parameters<ActionExecutorDeps['sessionSpawnNew']>[0] | null {
  const creationKey = resolveSessionSpawnNewCreationKey(data, ctx);
  if (!creationKey) return null;

  if (
    ctx.actionCaller?.kind === 'automationRun'
    && creationKey !== `automation-run:${ctx.actionCaller.runId}`
  ) {
    return null;
  }

  const callerCreationNamespace = ctx.actionCaller?.kind === 'automationRun'
    ? `automation:${ctx.actionCaller.automationId}`
    : ctx.surface === 'plugin'
    && ctx.actionCaller?.kind === 'plugin'
    ? `plugin:${ctx.actionCaller.pluginId}`
    : ctx.authority === 'account_automation'
    && ctx.externalActionCredential
    && normalizeId(ctx.externalActionCredential.accountId)
    && normalizeId(ctx.externalActionCredential.principalId)
    ? `api-principal:${normalizeId(ctx.externalActionCredential.accountId)}:${normalizeId(ctx.externalActionCredential.principalId)}`
    : ctx.authority === 'account_automation'
    && ctx.surface === 'agent'
    && normalizeId(ctx.serverId)
    && normalizeId(ctx.runtimeAccountId)
    && normalizeId(ctx.defaultSessionId)
    // The existing creation identity accepts an opaque caller namespace. Bind
    // ordinary Agent retries to their admitted parent, not a human message author.
    ? JSON.stringify(['session', normalizeId(ctx.serverId), normalizeId(ctx.runtimeAccountId), normalizeId(ctx.defaultSessionId)])
    : ctx.authority === 'account_automation'
    && ctx.surface === 'voice'
    && (!ctx.actionCaller || ctx.actionCaller.kind === 'host')
    && normalizeId(ctx.serverId)
    && normalizeId(ctx.runtimeAccountId)
    // Voice creates its own hidden conversation before any parent Session exists.
    // The admitted Home and Account scope retries without granting user authority.
    ? JSON.stringify(['voice', normalizeId(ctx.serverId), normalizeId(ctx.runtimeAccountId)])
    : ctx.authority === 'present_user'
    ? 'user'
    : null;
  if (!callerCreationNamespace) return null;
  const args: Record<string, unknown> = {
    ...data,
    ...(isAgentCaller(ctx) && data.reportsTo === undefined && ctx.defaultSessionId
      ? { reportsTo: { sessionId: normalizeId(ctx.defaultSessionId) } } : {}),
    creationKey,
    sessionCreationTag: deriveSessionCreationTagV1({
      callerCreationNamespace,
      creationKey,
    }),
    actionCaller: ctx.actionCaller ?? { kind: 'host' },
    context: ctx,
  };
  const leadSessionId = normalizeId(ctx.defaultSessionId);
  if (leadSessionId && ctx.agentStartContext) {
    args.initialSessionRolesV1 = {
      ...snapshotSessionRolesAtSpawnV1({
        leadSessionId,
        roles: ctx.agentStartContext.roles,
        notes: ctx.sessionRoleConfiguration?.notes,
        memoryDocRef: ctx.sessionRoleConfiguration?.memoryDocRef,
        // This is only a host-private candidate. The canonical target creator
        // must prove ownership of the lead before persisting a memory reference.
        sameAccount: true,
      }),
      ...(typeof data.roleId === 'string' ? { roleId: data.roleId } : {}),
    };
  }
  assignIfDefined(args, 'legacyMetadataLabel', legacyMetadataLabel);
  assignIfDefined(args, 'actionRequestId', ctx.actionRequestId ?? undefined);
  assignIfDefined(args, 'resumeActionRequest', ctx.resumeActionRequest === true ? true : undefined);
  assignIfDefined(args, 'signal', ctx.signal);
  const callerGrant = ctx.externalActionCredential?.grant;
  if (callerGrant) {
    args.callerInputConstraints = { models: callerGrant.models, permissionModes: callerGrant.permissionModes };
  }
  if (ctx.externalActionExecutionAuthorization) {
    args.creationAuthorization = { token: ctx.externalActionExecutionAuthorization.token };
  }
  assignIfDefined(args, 'workDepth', ctx.agentStartWorkDepth);
  if (ctx.agentStartWorkDepth !== undefined) {
    args.originKind = ctx.actionCaller?.kind === 'workflowRun' ? 'run_step' : ctx.runtimeRunId ? 'execution_run' : 'session';
    if (ctx.actionCaller?.kind === 'workflowRun') args.originRunId = ctx.actionCaller.runId;
    if (ctx.defaultSessionId) args.originSessionId = ctx.defaultSessionId;
  }
  const directoryApproval = SessionCreationDirectoryApprovalV1Schema.safeParse(
    ctx.sessionCreationDirectoryApproval,
  );
  if (directoryApproval.success) {
    assignIfDefined(args, 'sessionCreationDirectoryApproval', directoryApproval.data);
  }
  if (ctx.surface) {
    assignIfDefined(args, 'callerSurface', ctx.surface);
  }
  if (ctx.surface === 'agent') {
    assignIfDefined(args, 'sessionAgentSpawnPolicyV1', ctx.sessionAgentSpawnPolicyV1);
  }
  return args as Parameters<ActionExecutorDeps['sessionSpawnNew']>[0];
}

const ActionSurfaceKeySchema = ActionSurfaceSchema.keyof();

function parseActionSurfaceKey(value: unknown): keyof ActionSurfaces | null {
  const parsed = ActionSurfaceKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isAgentCaller(ctx: ActionExecutorContext): boolean {
  return ctx.surface === 'agent' || ctx.actionCaller?.kind === 'session';
}

function normalizeActionCallerContext(ctx: ActionExecutorContext): ActionExecutorContext | null {
  if (ctx.actionCaller?.kind !== 'session') return ctx;
  // Session identity is host-authenticated provenance. Surface and focus cannot
  // turn that agent into the Account host or select another Session.
  const sessionId = normalizeId(ctx.actionCaller.sessionId);
  return sessionId ? { ...ctx, surface: 'agent', defaultSessionId: sessionId,
    actionCaller: { ...ctx.actionCaller, sessionId } } : null;
}

type ActionExecuteFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

function createPermissionPolicyResult(
  ctx: ActionExecutorContext,
  decision: Exclude<PermissionEscalationDecision, { ok: true }>,
): ActionExecuteFailure {
  const errorCode = decision.reason;
  return {
    ok: false,
    errorCode,
    error: errorCode,
    details: {
      reason: errorCode,
      surface: ctx.surface ?? null,
      requestedMode: decision.requestedMode,
      requestedOrdinal: decision.requestedOrdinal,
      callerMode: decision.callerMode,
      callerOrdinal: decision.callerOrdinal,
    },
  };
}

type AgentPermissionResolution =
  | Readonly<{
      ok: true;
      permissionDecision: PermissionEscalationDecision | null;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>
  | Readonly<{
      ok: false;
      error: ActionExecuteFailure;
    }>;

function causalPermissionAuthorityFailure(): ActionExecuteFailure {
  return {
    ok: false,
    errorCode: 'causal_permission_authority_invalid',
    error: 'causal_permission_authority_invalid',
  };
}

function resolveAgentSessionInputSource(
  ctx: ActionExecutorContext,
  authority: SessionInputCausalPermissionAuthorityV1 | undefined,
): Readonly<{
  sourceSessionId: string;
  sourceTurnId: string;
  via: 'action' | 'mcp';
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
}> | null {
  if (!isAgentCaller(ctx) || !authority) return null;
  const parsed = SessionInputSourceSessionV1Schema.safeParse(ctx.sessionInputSource);
  if (!parsed.success) return null;
  const contextualSessionId = normalizeId(ctx.defaultSessionId);
  if (!contextualSessionId || parsed.data.sourceSessionId !== contextualSessionId) return null;
  return Object.freeze({
    ...parsed.data,
    causalPermissionAuthority: authority,
  });
}

type AgentEffectivePermissionResolution =
  | Readonly<{
      ok: true;
      effectiveCallerMode: string | null;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>
  | Readonly<{
      ok: false;
      error: ActionExecuteFailure;
    }>;

/**
 * Resolves the one host-stamped permission mode that an Agent Action may use.
 * When an active-turn authority is present, the immutable admitted ceiling is
 * intersected with the mutable current Session mode before any Action-specific
 * permission decision. A present but invalid authority never falls back to the
 * mutable mode.
 */
function resolveAgentEffectivePermission(
  ctx: ActionExecutorContext,
  supportedModes?: readonly string[],
): AgentEffectivePermissionResolution {
  if (ctx.actionCaller?.kind === 'workflowRun') {
    const authorization = ctx.actionCaller.authorization;
    const admitted = authorization.admittedPermissionCeiling;
    const admittedDecision = supportedModes
      ? assertNonEscalatingPermissionMode({
          requestedMode: admitted,
          callerMode: admitted,
          supportedModes,
        })
      : null;
    if (admittedDecision && !admittedDecision.ok) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
    const causalPermissionAuthority = SessionInputCausalPermissionAuthorityV1Schema.safeParse({
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: admitted,
      ...(authorization.sourceAuthority
        ? {
            sourceAuthority: {
              kind: 'mediatedExternal',
              ...authorization.sourceAuthority,
              admittedPermissionCeiling: admitted,
            },
          }
        : {}),
    });
    if (!causalPermissionAuthority.success) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
    return {
      ok: true,
      effectiveCallerMode: admittedDecision?.normalizedMode ?? admitted,
      causalPermissionAuthority: causalPermissionAuthority.data,
    };
  }
  if (!isAgentCaller(ctx)) {
    return { ok: true, effectiveCallerMode: null };
  }
  if (!Object.prototype.hasOwnProperty.call(ctx, 'causalPermissionAuthority')) {
    return { ok: true, effectiveCallerMode: ctx.callerPermissionMode ?? 'default' };
  }

  const parsedAuthority = SessionInputCausalPermissionAuthorityV1Schema.safeParse(
    ctx.causalPermissionAuthority,
  );
  if (!parsedAuthority.success) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  const effective = resolveEffectivePermissionMode({
    currentMode: ctx.callerPermissionMode ?? 'default',
    admittedPermissionCeiling: parsedAuthority.data.admittedPermissionCeiling,
    supportedModes,
  });
  if (!effective.ok) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  return {
    ok: true,
    effectiveCallerMode: effective.effectiveMode,
    causalPermissionAuthority: parsedAuthority.data,
  };
}

function resolveWorkflowActionContext(
  ctx: ActionExecutorContext,
): Readonly<
  | { ok: true; context: ActionExecutorContext }
  | { ok: false; error: ActionExecuteFailure }
> {
  const effective = resolveAgentEffectivePermission(ctx);
  if (!effective.ok) return effective;
  if (isAgentCaller(ctx) || ctx.actionCaller?.kind === 'workflowRun') {
    if (effective.effectiveCallerMode === null) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
    return {
      ok: true,
      context: Object.freeze({
        ...ctx,
        callerPermissionMode: effective.effectiveCallerMode,
        ...(effective.causalPermissionAuthority
          ? { causalPermissionAuthority: effective.causalPermissionAuthority }
          : {}),
      }),
    };
  }
  // Non-Agent invocation authorities are authenticated and normalized by the
  // host before Action execution. Workflow input cannot carry this field.
  return {
    ok: true,
    context: Object.freeze({ ...ctx, callerPermissionMode: 'yolo' }),
  };
}

function assertAgentPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes?: readonly string[],
): AgentPermissionResolution {
  const effective = resolveAgentEffectivePermission(ctx, supportedModes);
  if (!effective.ok) return effective;
  if (effective.effectiveCallerMode === null) {
    return { ok: true, permissionDecision: null };
  }
  const hasRequestedMode = typeof requestedMode === 'string' && requestedMode.trim().length > 0;
  return {
    ok: true,
    permissionDecision: hasRequestedMode
      ? assertNonEscalatingPermissionMode({
          requestedMode,
          callerMode: effective.effectiveCallerMode,
          supportedModes,
        })
      : resolveNearestPermissionModeAtOrBelow({
          requestedMode: undefined,
          callerMode: effective.effectiveCallerMode,
          supportedModes,
        }),
    ...(effective.causalPermissionAuthority
      ? { causalPermissionAuthority: effective.causalPermissionAuthority }
      : {}),
  };
}

type SessionMessageSendAdmission =
  | Readonly<{
      ok: true;
      permissionModeOverride?: string;
      sessionInputSource?: NonNullable<ReturnType<typeof resolveAgentSessionInputSource>>;
    }>
  | Readonly<{
      ok: false;
      error: ActionExecuteFailure;
    }>;

/**
 * Resolves the host-owned Agent permission and source witness before either a
 * Session message is approved or dispatched. Approval may defer target/runtime
 * currentness, but it must not persist an invocation that already lacks valid
 * causal authority.
 */
function resolveSessionMessageSendAdmission(
  ctx: ActionExecutorContext,
  permissionOverrideRaw: unknown,
): SessionMessageSendAdmission {
  const permissionResolution = assertAgentPermission(ctx, permissionOverrideRaw);
  if (!permissionResolution.ok) return permissionResolution;
  const permissionDecision = permissionResolution.permissionDecision;
  if (permissionDecision?.ok === false) {
    return { ok: false, error: createPermissionPolicyResult(ctx, permissionDecision) };
  }
  const hasPermissionModeOverride = typeof permissionOverrideRaw === 'string'
    && permissionOverrideRaw.trim().length > 0;
  const permissionModeOverride = hasPermissionModeOverride
    ? permissionDecision?.ok === true
      ? permissionDecision.normalizedMode
      : permissionOverrideRaw
    : undefined;
  const sessionInputSource = resolveAgentSessionInputSource(
    ctx,
    permissionResolution.causalPermissionAuthority,
  );
  if (isAgentCaller(ctx) && ctx.actionCaller?.kind !== 'plugin' && !sessionInputSource) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  return {
    ok: true,
    ...(permissionModeOverride ? { permissionModeOverride } : {}),
    ...(sessionInputSource ? { sessionInputSource } : {}),
  };
}

/**
 * A Session-agent MCP call explicitly carries host-stamped active-turn
 * authority. That turn's immutable admission ceiling constrains the current
 * mutable Session mode before an execution run is started. Other Action
 * callers retain their existing paths; Action input cannot synthesize this
 * context field.
 */
function resolveAgentExecutionRunPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes: readonly string[],
): AgentPermissionResolution {
  return assertAgentPermission(ctx, requestedMode, supportedModes);
}

function bindAgentExistingExecutionRunAuthority(
  ctx: ActionExecutorContext,
  opts: ExecutionRunCallOptions | undefined,
): Readonly<
  | { ok: true; opts: ExecutionRunCallOptions | undefined }
  | { ok: false; error: ActionExecuteFailure }
> {
  if (!isAgentCaller(ctx) && ctx.actionCaller?.kind !== 'workflowRun') return { ok: true, opts };
  if (
    ctx.actionCaller?.kind !== 'workflowRun'
    && !Object.prototype.hasOwnProperty.call(ctx, 'causalPermissionAuthority')
  ) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  const effective = resolveAgentEffectivePermission(ctx);
  if (!effective.ok) return effective;
  if (!effective.causalPermissionAuthority) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  return {
    ok: true,
    opts: {
      ...(opts ?? {}),
      causalPermissionAuthority: effective.causalPermissionAuthority,
      ...(effective.effectiveCallerMode === null
        ? {}
        : { effectiveCallerPermissionMode: effective.effectiveCallerMode }),
    },
  };
}

function resolveSessionIdFromInput(input: unknown, ctx: ActionExecutorContext): string | null {
  const sessionId = normalizeId(readRecord(input).sessionId);
  if (sessionId) return sessionId;
  const definitionSession = readWidgetDefinitionActionSessionV1(input);
  if (definitionSession) return definitionSession.sessionId;
  const widgetSurface = readWidgetActionSurfaceV1(input);
  if (widgetSurface?.owner.kind === 'sessionBoard' || widgetSurface?.owner.kind === 'companion') return widgetSurface.owner.sessionId;
  const widgetDestination = readWidgetActionDestinationV1(input);
  if (widgetDestination?.owner.kind === 'sessionBoard' || widgetDestination?.owner.kind === 'companion') return widgetDestination.owner.sessionId;
  const fallback = normalizeId(ctx.defaultSessionId);
  return fallback || null;
}

/**
 * The execution-run scope is deliberately not the general Session defaulting
 * rule: presence of `sessionId: null` is an explicit detached request, while
 * an omitted property may inherit the contextual Session. Do not collapse this
 * with `??` or truthiness; those would make explicit detached starts attach to
 * the current Session.
 */
function resolveExecutionRunScope(input: unknown, ctx: ActionExecutorContext): string | null {
  const record = readRecord(input);
  if (hasOwn(record, 'sessionId') && record.sessionId !== undefined) {
    return record.sessionId === null ? null : normalizeId(record.sessionId) || null;
  }
  const fallback = normalizeId(ctx.defaultSessionId);
  return fallback || null;
}

function withoutExecutionRunScope(input: unknown): Record<string, unknown> {
  const request = { ...readRecord(input) };
  delete request.sessionId;
  return request;
}

function mapApprovalCreatedBySurface(surface: ActionExecutorContext['surface']): ApprovalRequestV1['createdBy']['surface'] {
  if (surface === 'voice') return 'voice';
  if (surface === 'agent') return 'agent';
  if (surface === 'mcp') return 'mcp';
  if (surface === 'cli') return 'cli';
  // UI surfaces (and unknown surfaces) map to `system`.
  return 'system';
}

function buildApprovalSummary(spec: ActionSpec, sessionId: string | null): string {
  const base = String(spec.title ?? '').trim() || String(spec.id);
  return sessionId ? `${base} — ${sessionId}` : base;
}

function sameSessionCreationDirectoryApproval(
  left: SessionCreationDirectoryApprovalV1 | null | undefined,
  right: SessionCreationDirectoryApprovalV1 | null | undefined,
): boolean {
  return left?.v === right?.v
    && left?.executionTarget.serverId === right?.executionTarget.serverId
    && left?.executionTarget.machineId === right?.executionTarget.machineId
    && left?.directory === right?.directory;
}

function buildApprovalMetadata(spec: ActionSpec): NonNullable<ApprovalRequestV1['approval']> {
  return {
    flow: resolveActionApprovalFlow(spec.approval),
    result: spec.approval.result,
  };
}

async function resolveComputerActionSelection(
  deps: ActionExecutorDeps,
  input: unknown,
  context: ActionExecutorContext,
) {
  if (!deps.runtimeActionExecute) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
  const rawSelection = await deps.runtimeActionExecute({ actionId: 'computer.target.get',
    input: { machineId: readRecord(input).machineId }, context });
  const failure = readActionFailureEnvelope(rawSelection);
  if (failure) return failure;
  const selection = ComputerSelectedTargetResponseV1Schema.safeParse(rawSelection);
  return selection.success
    ? { ok: true as const, selection: selection.data }
    : { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}

async function prepareApprovalRequest(params: Readonly<{
  deps: ActionExecutorDeps;
  actionId: ActionId;
  input: unknown;
  actionArgs: unknown;
  context: ActionExecutorContext;
  computerApprovalDisplay?: ComputerApprovalDisplayV1;
}>): Promise<Readonly<{ actionArgs: unknown; preview: unknown }> | null> {
  const spec = getActionSpec(params.actionId);
  let computerApprovalDisplay = params.computerApprovalDisplay;
  if (!computerApprovalDisplay && (params.actionId === 'computer.target.select'
    || params.actionId === 'computer.capture' || params.actionId === 'computer.query' || params.actionId === 'computer.input')) {
    const selection = await resolveComputerActionSelection(params.deps, params.input, params.context);
    if (!selection.ok) return null;
    computerApprovalDisplay = selection.selection.approvalDisplay;
  }
  if (computerApprovalDisplay && params.actionId === 'computer.target.select') {
    computerApprovalDisplay = { machineDisplayName: computerApprovalDisplay.machineDisplayName, requiresTargetSelection: true };
  }
  const observedInput = spec.projectObservationInput
    ? spec.projectObservationInput(params.input)
    : params.input;
  const defaultPreview = {
    actionId: params.actionId,
    actionArgs: observedInput,
  } as const;
  const customized = await params.deps.buildApprovalPreview?.({
    actionId: params.actionId,
    input: params.input,
    context: params.context,
    defaultPreview,
  }) ?? defaultPreview;
  const preview = {
    ...readRecord(customized),
    actionId: params.actionId,
    actionArgs: observedInput,
    ...(computerApprovalDisplay ? { computerApprovalDisplay } : {}),
  };

  // Declared live-only input custody: the durable record carries only this
  // Action's own safe observation projection. `resolveActionApprovalRouting`
  // keeps the admitted invocation as the blocking waiter, so the raw input
  // never leaves it, and a replay without that invocation fails closed.
  if (spec.approvalInputCustody === 'live_only') {
    return { actionArgs: observedInput, preview };
  }

  if (params.actionId !== 'teams.invitations.accept' || !params.deps.homeDomainAction) {
    return { actionArgs: params.actionArgs, preview };
  }
  const admission = TeamInvitationAcceptInputV1Schema.safeParse(params.input);
  if (!admission.success || !('token' in admission.data)) {
    return { actionArgs: params.actionArgs, preview };
  }

  // A token-bearing acceptance must not cross the durable Approval boundary.
  // The authenticated Home atomically exchanges it for the existing Account-bound
  // post-auth continuation and returns the bounded invitation preview. This happens
  // before execution-origin signing so external callers bind the exact continuation
  // that will later be replayed. Failure is fail-closed: no Approval Artifact exists.
  let rawPrepared: unknown;
  try {
    rawPrepared = await params.deps.homeDomainAction({
      actionId: 'teams.invitations.accept.prepareApproval',
      input: { v: 1, token: admission.data.token },
      context: {
        ...(params.context.serverId ? { serverId: params.context.serverId } : {}),
        ...(params.context.surface ? { surface: params.context.surface } : {}),
        ...(params.context.signal ? { signal: params.context.signal } : {}),
      },
      ...(params.context.signal ? { signal: params.context.signal } : {}),
    });
  } catch {
    return null;
  }
  const resolved = TeamInvitationAcceptApprovalPrepareResultV1Schema.safeParse(rawPrepared);
  if (!resolved.success || resolved.data.outcome !== 'ok') return null;
  const invitation = resolved.data.preview;
  return {
    actionArgs: { v: 1, continuation: resolved.data.continuation },
    // Do not retain caller/adapter customization for the bearer-bearing form: a
    // custom summary-like field could otherwise become a parallel secret-bearing
    // presentation channel. Only Home-owned bounded facts cross this boundary.
    preview: {
      actionId: params.actionId,
      actionArgs: {
        homeServerId: invitation.home.serverId,
        continuation: { teamId: invitation.team.teamId },
        teamName: invitation.team.name,
        role: invitation.role,
        historyAccess: invitation.historyAccess,
        state: invitation.state,
        expiresAt: invitation.expiresAt,
        recipientEmailMask: invitation.recipientEmailMask,
      },
    },
  };
}

function resolveApprovalOriginForRequest(
  origin: unknown,
  sessionId: string | null,
): ApprovalRequestOriginV1 | null {
  const parsed = ApprovalRequestOriginV1Schema.safeParse(origin);
  if (!parsed.success) return null;
  if (sessionId && parsed.data.sessionId !== sessionId) return null;
  return parsed.data;
}

function resolvePolicyApprovalRequestingSessionId(
  rawOrigin: unknown,
  ctx: ActionExecutorContext,
  targetSessionId: string | null,
): string | null {
  const origin = resolveApprovalOriginForRequest(rawOrigin, null);
  const originSessionId = normalizeId(origin?.sessionId);
  if (originSessionId) return originSessionId;

  const defaultSessionId = normalizeId(ctx.defaultSessionId);
  if (defaultSessionId) return defaultSessionId;

  return targetSessionId;
}

/**
 * The one projection from the live `ActionCaller` union onto the durable
 * approval-origin caller. It is exhaustive by construction: a new live caller
 * arm is a compile error here, and an unmapped arm fails closed with `null`
 * rather than being persisted as `host`. A durable approval must never lose the
 * principal that replay currentness has to recheck.
 */
function projectApprovalExecutionOriginCaller(
  rawCaller: ActionCaller,
): ApprovalExecutionOriginCallerV1 | null {
  switch (rawCaller.kind) {
    case 'host':
      return { kind: 'host' };
    case 'session': {
      const caller = AgentStartSessionCallerV1Schema.safeParse(rawCaller);
      return caller.success ? caller.data : null;
    }
    case 'plugin': {
      const sourceCustody = PluginSourceCustodyV1Schema.safeParse(rawCaller.sourceCustody);
      const pluginId = normalizeId(rawCaller.pluginId);
      const contributionLocalId = normalizeId(rawCaller.contributionLocalId);
      if (!pluginId || !contributionLocalId || !sourceCustody.success) return null;
      return { kind: 'plugin', pluginId, contributionLocalId, sourceCustody: sourceCustody.data,
        startedBy: resolveWorkflowRunStartedByForActionCallerV1(rawCaller) };
    }
    case 'automationRun':
      return {
        kind: 'automationRun',
        runId: rawCaller.runId,
        automationId: rawCaller.automationId,
        cause: rawCaller.cause,
      };
    case 'workflowRun':
      return {
        kind: 'workflowRun',
        runId: rawCaller.runId,
        authorization: rawCaller.authorization,
      };
    default:
      return refuseUnmappedApprovalCaller(rawCaller);
  }
}

/**
 * Compile-time exhaustiveness for the projection above: adding a live caller arm
 * without mapping it is a type error here, and an untyped arm reaching this at
 * runtime yields no durable approval at all.
 */
function refuseUnmappedApprovalCaller(_caller: never): null {
  return null;
}

function buildApprovalExecutionOriginV1(params: Readonly<{
  actionId: ActionId;
  input: unknown;
  context: ActionExecutorContext;
  targetSessionId: string | null;
}>): ApprovalExecutionOriginV1 | null {
  const authority = params.context.authority ?? 'account_automation';
  const requestedSurface = parseActionSurfaceKey(params.context.surface);
  const inputRecord = readRecord(params.input);
  const inputExecutionTarget = readRecord(inputRecord.executionTarget);
  const serverId = normalizeId(params.context.serverId) || normalizeId(inputExecutionTarget.serverId);
  if (!requestedSurface || !serverId) return null;

  const caller = projectApprovalExecutionOriginCaller(
    params.context.actionCaller ?? { kind: 'host' as const },
  );
  if (!caller) return null;

  const recipient = readRecord(inputRecord.recipient);
  const runId = normalizeId(params.context.runtimeRunId)
    || (recipient.kind === 'execution_run' ? normalizeId(recipient.runId) : '')
    || normalizeId(inputRecord.runId);
  const externalCredential = params.context.externalActionCredential;
  const externalAuthorization = params.context.externalActionExecutionAuthorization;
  if (externalCredential && !externalAuthorization) return null;
  // A contributed Action still executes through the plugin surface, but a
  // Home-authorized external invocation must remain an API origin when it is
  // persisted for approval replay. The plugin caller below retains the exact
  // contribution provenance without turning that provenance into authority.
  const surface = externalAuthorization ? 'api' as const : requestedSurface;
  let externalActionInputSignature: string | undefined;
  if (externalAuthorization) {
    if (!params.context.signExternalActionApprovalInput) return null;
    try {
      externalActionInputSignature = params.context.signExternalActionApprovalInput({
        actionId: params.actionId, input: params.input, authorization: externalAuthorization,
        target: params.context.externalActionTarget ?? externalAuthorization.binding.target,
      });
    } catch { return null; }
  }
  const externalTarget = params.context.externalActionTarget;
  const targetSessionId = params.targetSessionId
    || (externalTarget?.kind === 'session' ? normalizeId(externalTarget.sessionId) : '');
  const observedServerIdentityId = normalizeId(params.context.serverIdentityId);
  if (
    externalAuthorization
    && observedServerIdentityId
    && observedServerIdentityId !== externalAuthorization.binding.serverIdentityId
  ) return null;
  const rawCallerPermissionMode = params.context.callerPermissionMode;
  const callerPermissionMode = typeof rawCallerPermissionMode === 'string'
    ? parseAgentPermissionIntentV1Alias(rawCallerPermissionMode)
    : rawCallerPermissionMode;
  if (typeof rawCallerPermissionMode === 'string' && callerPermissionMode === null) return null;
  const spawnPolicy = isAgentCaller(params.context)
    ? SessionAgentSpawnPolicyV1StrictSchema.safeParse(params.context.sessionAgentSpawnPolicyV1 ?? {})
    : null;
  if (spawnPolicy && !spawnPolicy.success) return null;
  const machineId = normalizeId(params.context.executionRunTargetMachineId)
    || externalAuthorization?.binding.machineId
    || (getActionSpec(params.actionId).executionPlacement === 'machine' ? normalizeId(inputRecord.machineId) : '')
    || normalizeId(params.context.defaultSessionMachineId)
    || normalizeId(inputExecutionTarget.machineId)
    || (externalTarget?.kind === 'machine' ? normalizeId(externalTarget.machineId) : '');
  const candidate = {
    v: 1,
    authority,
    surface,
    caller,
    serverId,
    ...((externalAuthorization?.binding.serverIdentityId ?? observedServerIdentityId)
      ? { serverIdentityId: externalAuthorization?.binding.serverIdentityId ?? observedServerIdentityId }
      : {}),
    ...(normalizeId(params.context.runtimeAccountId)
      ? { accountId: normalizeId(params.context.runtimeAccountId) }
      : externalCredential
        ? { accountId: externalCredential.accountId }
        : {}),
    ...(externalCredential
      ? {
          principalId: externalCredential.principalId,
          credentialId: externalCredential.credentialId,
        }
      : {}),
    ...(externalAuthorization ? { externalActionExecutionAuthorization: externalAuthorization } : {}),
    ...(externalActionInputSignature ? { externalActionInputSignature } : {}),
    ...(targetSessionId ? { sessionId: targetSessionId } : {}),
    ...(params.context.sessionListAccess !== undefined
      ? { sessionListAccess: params.context.sessionListAccess }
      : {}),
    ...(machineId ? { machineId } : {}),
    ...(runId ? { runId } : {}),
    ...(normalizeId(params.context.runtimeRunOccurrenceId)
      ? { runOccurrenceId: normalizeId(params.context.runtimeRunOccurrenceId) }
      : {}),
    ...(callerPermissionMode !== undefined ? { callerPermissionMode } : {}),
    ...(spawnPolicy?.success ? { sessionAgentSpawnPolicyV1: spawnPolicy.data } : {}),
    ...(params.context.causalPermissionAuthority !== undefined
      ? { causalPermissionAuthority: params.context.causalPermissionAuthority }
      : {}),
    ...(params.context.sessionInputSource !== undefined
      ? { sessionInputSource: params.context.sessionInputSource }
      : {}),
    ...(externalTarget ? { target: externalTarget } : {}),
    actionId: params.actionId,
    requestId: normalizeId(params.context.actionRequestId) || normalizeId(inputRecord.creationKey),
  };
  const parsed = ApprovalExecutionOriginV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function resolveExplicitApprovalRequestingSessionId(
  rawOrigin: unknown,
  ctx: ActionExecutorContext,
  targetSessionId: string | null,
): string | null {
  const defaultSessionId = normalizeId(ctx.defaultSessionId);
  if (defaultSessionId) return defaultSessionId;

  const origin = resolveApprovalOriginForRequest(rawOrigin, null);
  const originSessionId = normalizeId(origin?.sessionId);
  if (originSessionId) return originSessionId;

  return targetSessionId;
}

function isApprovalActionId(actionId: ActionId): boolean {
  return actionId === 'approval.request.list'
    || actionId === 'approval.request.get'
    || actionId === 'approval.request.create'
    || actionId === 'approval.request.decide';
}

function isBlockingApprovalRequest(request: ApprovalRequest): boolean {
  return request.approval?.flow === 'blocking';
}

async function resolveActionSessionAddress(
  deps: ActionExecutorDeps,
  input: Readonly<{ sessionId?: unknown; sessionTitle?: unknown }>,
  context: ActionExecutorContext,
): Promise<ActionSessionReferenceResolution> {
  const sessionId = normalizeId(input.sessionId);
  const sessionTitle = normalizeId(input.sessionTitle);
  const serverId = normalizeId(context.serverId);
  if (sessionId && serverId) {
    return { kind: 'unique', address: { serverId, sessionId } };
  }
  if (!sessionId && !sessionTitle) return { kind: 'none' };
  if (!deps.resolveSessionReference) return { kind: 'incomplete' };
  return await deps.resolveSessionReference({
    context,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  });
}

function projectSessionReferenceFailure(
  resolution: Exclude<ActionSessionReferenceResolution, Readonly<{ kind: 'unique'; address: ActionSessionAddress }>>,
): ActionExecuteResult {
  if (resolution.kind === 'ambiguous') {
    return { ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' };
  }
  if (resolution.kind === 'incomplete') {
    return { ok: false, errorCode: 'session_lookup_incomplete', error: 'session_lookup_incomplete' };
  }
  return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
}

function resolveServerIdForSession(deps: ActionExecutorDeps, ctx: ActionExecutorContext, sessionId: string): string | null {
  const explicit = normalizeId(ctx.serverId);
  if (explicit) return explicit;
  return deps.resolveServerIdForSessionId ? deps.resolveServerIdForSessionId(sessionId) : null;
}

function resolveServerIdForExecutionRunScope(
  deps: ActionExecutorDeps,
  ctx: ActionExecutorContext,
  sessionId: string | null,
): string | null {
  if (sessionId) return resolveServerIdForSession(deps, ctx, sessionId);
  return normalizeId(ctx.serverId) || null;
}

type ExecutionRunCallOptions = NonNullable<
  Parameters<ActionExecutorDeps['executionRunStart']>[2]
>;

function buildExecutionRunCallOptions(
  authority: ActionExecutorContext['authority'],
  serverId: string | null,
  signal?: AbortSignal,
  originSessionId?: string | null,
  targetMachineId?: string | null,
  permissionRequestStore?: unknown,
  workflowObservationSink?: unknown,
  actionContext?: Pick<ActionExecutorContext, 'actionCaller' | 'actionRequestId'>,
): ExecutionRunCallOptions | undefined {
  const origin = normalizeId(originSessionId);
  const target = normalizeId(targetMachineId);
  const actionRequestId = normalizeId(actionContext?.actionRequestId);
  const actionCaller = actionContext?.actionCaller;
  if (!serverId && !signal && !origin && !target
    && permissionRequestStore === undefined && workflowObservationSink === undefined
    && !actionRequestId && !actionCaller && !authority) return undefined;
  return {
    ...(serverId ? { serverId } : {}),
    ...(origin ? { originSessionId: origin } : {}),
    ...(target ? { targetMachineId: target } : {}),
    ...(signal ? { signal } : {}),
    ...(permissionRequestStore === undefined ? {} : { permissionRequestStore }),
    ...(workflowObservationSink === undefined ? {} : { workflowObservationSink }),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(actionCaller ? { actionCaller } : {}),
    ...(authority ? { authority } : {}),
    ...(actionCaller?.kind === 'workflowRun' ? { workflowRunId: actionCaller.runId } : {}),
  };
}

async function checkDetachedExecutionRunProtocolV2(
  deps: ActionExecutorDeps,
  sessionId: string | null,
  opts: ExecutionRunCallOptions | undefined,
  requirement: Readonly<{
    startAndWait: boolean;
    exactInputResults?: boolean;
    runScopedAgentBindings?: boolean;
    secretReferenceOverlay?: boolean;
  }>,
): Promise<
  | Readonly<{ ok: true; opts: ExecutionRunCallOptions | undefined }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>
> {
  // V2 is needed for any start-and-wait request, plus every detached control.
  // Ordinary Session-scoped immediate operations retain the V1 path.
  if (
    sessionId !== null
    && !requirement.startAndWait
    && requirement.exactInputResults !== true
    && requirement.runScopedAgentBindings !== true
    && requirement.secretReferenceOverlay !== true
  ) return { ok: true, opts };
  if (!deps.executionRunCheckProtocolV2) {
    return {
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      ...(requirement.secretReferenceOverlay === true ? {
        details: {
          updateRequired: {
            kind: 'update_required',
            operation: 'execution.run.start',
            component: 'daemon',
            reason: 'execution_run_secret_reference_overlay_update_required',
          },
        },
      } : {}),
    };
  }
  const capability = await deps.executionRunCheckProtocolV2(sessionId, {
    detachedScope: sessionId === null,
    startAndWait: requirement.startAndWait,
    exactInputResults: requirement.exactInputResults === true,
    runScopedAgentBindings: requirement.runScopedAgentBindings === true,
    secretReferenceOverlay: requirement.secretReferenceOverlay === true,
  }, opts);
  if (!capability.ok) {
    return requirement.secretReferenceOverlay === true
      && capability.errorCode === 'execution_run_protocol_unsupported'
      ? {
          ...capability,
          details: {
            updateRequired: {
              kind: 'update_required',
              operation: 'execution.run.start',
              component: 'daemon',
              reason: 'execution_run_secret_reference_overlay_update_required',
            },
          },
        }
      : capability;
  }
  return {
    ok: true,
    opts: capability.exactMachineId
      ? { ...(opts ?? {}), exactMachineId: capability.exactMachineId }
      : opts,
  };
}

function normalizeExecutionBackendOptionValue(value: string): string {
  const normalized = tryNormalizeExecutionBackendOptionValue(value);
  if (!normalized) {
    throw new Error('invalid_backend_target_option');
  }
  return normalized;
}

function normalizeExecutionBackendTargetValue(value: string): BackendTargetRefV1 {
  const backendTarget = resolveExecutionBackendTargetSelectionForValue(value)?.backendTarget;
  if (!backendTarget) {
    throw new Error('invalid_backend_target_option');
  }
  return backendTarget;
}

function doesTeamCredentialSelectionTargetBackend(
  selection: TeamCredentialProviderModelSelectionV1,
  backendTargetValue: string,
): boolean {
  const canonicalTarget = resolveExecutionBackendTargetSelectionForValue(backendTargetValue)?.canonicalBackendTarget;
  return canonicalTarget !== null
    && canonicalTarget !== undefined
    && buildBackendTargetKeyV2(canonicalTarget) === selection.agentTargetKey;
}

function resolveFanoutTeamCredentialModel(
  data: Readonly<Record<string, unknown>>,
  backendTargetValues: readonly string[],
): { ok: true; selection: TeamCredentialProviderModelSelectionV1 | null } | { ok: false } {
  if (data.teamCredentialModel === undefined) return { ok: true, selection: null };
  const parsed = TeamCredentialProviderModelSelectionV1Schema.safeParse(data.teamCredentialModel);
  if (
    !parsed.success
    || backendTargetValues.length !== 1
    || data.modelSelection !== undefined
    || (typeof data.modelId === 'string' && data.modelId.trim() !== parsed.data.modelId)
    || !doesTeamCredentialSelectionTargetBackend(parsed.data, backendTargetValues[0]!)
  ) {
    return { ok: false };
  }
  return { ok: true, selection: parsed.data };
}

function buildAvailableExecutionBackendOptionKeys(value: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const option of normalizeResolvedOptions(value)) {
    if (option.disabled === true) continue;
    const selection = resolveExecutionBackendTargetSelectionForValue(option.value);
    if (!selection?.backendTargetKey) continue;
    const raw = normalizeId(option.value);
    if (raw) keys.add(raw);
    keys.add(selection.backendTargetKey);
    if (selection.backendTarget) {
      keys.add(buildBackendTargetKey(selection.backendTarget));
    }
  }
  return keys;
}

function readReviewRunActionPayload(value: unknown): unknown {
  const transport = readRecord(value);
  const native = transport.ok === true && transport.data !== undefined ? transport.data : value;
  const host = readRecord(native);
  return host.ok === true && host.result !== undefined ? host.result : native;
}

type FanoutResultItem = Readonly<{
  key: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  error?: string;
  details?: ReturnType<typeof withExecutionRunStartFailureDetails>;
}>;

function normalizeSuccessfulFanoutStartResult(result: unknown): unknown {
  const record = readRecord(result);
  if (
    record.ok === true
    && isRecord(record.data)
  ) {
    return record.data;
  }
  return result;
}

function readFanoutStartError(result: unknown): Readonly<{
  errorCode?: string;
  error: string;
  details: ReturnType<typeof withExecutionRunStartFailureDetails>;
}> {
  const record = readRecord(result);
  const errorCode =
    typeof record.errorCode === 'string'
      ? String(record.errorCode)
      : typeof record.code === 'string'
          ? String(record.code)
          : undefined;
  const error =
    typeof record.error === 'string'
      ? String(record.error)
      : typeof record.message === 'string'
          ? String(record.message)
          : 'execution_run_failed';
  const details = readFailureEnvelopeDetails(record);
  return {
    error,
    ...(errorCode ? { errorCode } : {}),
    details: withExecutionRunStartFailureDetails(
      details,
      hasExecutionRunStartIdentityEvidence(result)
        ? 'outcomeUnknown'
        : readExecutionRunStartRunCreation(details),
    ),
  };
}

async function fanoutStarts(params: Readonly<{
  keys: readonly string[];
  startOne: (key: string) => Promise<unknown>;
}>): Promise<readonly FanoutResultItem[]> {
  const results = await Promise.all(
    params.keys.map(async (key): Promise<FanoutResultItem> => {
      try {
        const rawResult = await params.startOne(key);
        const normalizedResult = normalizeSuccessfulFanoutStartResult(rawResult);
        const claimsFailure = readRecord(rawResult).ok === false || readRecord(normalizedResult).ok === false;
        const result = claimsFailure
          ? readCompleteExecutionRunStartIdentity(rawResult) ?? normalizedResult
          : normalizedResult;
        const resultRecord = readRecord(result);
        if (resultRecord.ok === false) {
          return {
            key,
            ok: false,
            ...readFanoutStartError(result),
          };
        }
        if (
          isRecord(result)
          && (
            typeof result.runId !== 'string'
            || typeof result.callId !== 'string'
            || typeof result.sidechainId !== 'string'
          )
        ) {
          return {
            key,
            ok: false,
            ...readFanoutStartError(result),
            details: withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown'),
          };
        }
        return { key, ok: true, result };
      } catch (error) {
        const failure = normalizeActionExecutorThrownError(error);
        const details = readFailureEnvelopeDetails(readRecord(error));
        return {
          key,
          ok: false,
          errorCode: failure.errorCode,
          error: failure.error,
          details: withExecutionRunStartFailureDetails(
            details,
            hasExecutionRunStartIdentityEvidence(error)
              ? 'outcomeUnknown'
              : readExecutionRunStartRunCreation(details),
          ),
        };
      }
    }),
  );
  return results;
}

function projectActionExecutionObservation(actionId: ActionId, result: ActionExecuteResult): ActionExecuteResult {
  const project = getActionSpec(actionId).projectObservationOutput;
  return result.ok && project ? { ...result, result: project(result.result) } : result;
}

/** The input-side sibling: this Action's own observation-safe view of its input. */
function projectActionObservationInput(actionId: ActionId, input: unknown): unknown {
  const project = getActionSpec(actionId).projectObservationInput;
  return project ? project(input) : input;
}

function projectApprovalExecutionForDecisionObservation(
  request: ApprovalRequest,
): ApprovalRequest['execution'] {
  const execution = request.execution;
  if (!execution?.ok) return execution;

  // Approval decisions and result custody are deliberately different powers.
  // The exact originating continuation reads the encrypted Artifact body; a
  // caller observing `approval.request.decide` receives the target Action's
  // existing observation projection instead. Released V1 history can name a
  // retired Action, so preserve it when no current projection owner exists.
  const actionId = ActionIdSchema.safeParse(request.actionId);
  if (!actionId.success) return execution;
  const project = getActionSpec(actionId.data).projectObservationOutput;
  return project ? { ...execution, result: project(execution.result) } : execution;
}

function buildApprovalDecisionResult(request: ApprovalRequest, liveResult?: ActionExecuteResult): ActionExecuteResult {
  const observedExecution = projectApprovalExecutionForDecisionObservation(request);
  return {
    ok: true,
    result: {
      ok: true,
      status: request.status,
      ...(observedExecution ? { execution: observedExecution } : {}),
      ...(liveResult?.ok ? { liveExecution: liveResult } : {}),
    },
  };
}

function buildActionExecuteResultFromRecordedApprovalExecution(request: ApprovalRequest): ActionExecuteResult | null {
  if (!request.execution) return null;
  if (request.execution.ok) {
    return { ok: true, result: request.execution.result };
  }
  return readApprovalExecutionFailure(request);
}

function projectApprovalRequestPluginCaller(
  actionCaller: ActionExecutorContext['actionCaller'],
): Readonly<{ pluginId: string; contributionLocalId: string }> | null {
  if (actionCaller?.kind !== 'plugin') return null;
  const pluginId = PluginIdSchema.safeParse(actionCaller.pluginId);
  const contributionLocalId = PluginContributionLocalIdSchema.safeParse(actionCaller.contributionLocalId);
  if (!pluginId.success || !contributionLocalId.success) return null;
  return { pluginId: pluginId.data, contributionLocalId: contributionLocalId.data };
}

const RPC_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(RPC_ERROR_CODES));

function normalizeActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string; details?: unknown }> {
  if (error instanceof SessionOrganizationContentUnavailableError) {
    return { errorCode: error.code, error: error.message };
  }
  const errorRecord = readRecord(error);
  const rawDetails = errorRecord.details;
  const details = rawDetails && typeof rawDetails === 'object'
    && Object.hasOwn(rawDetails, 'spawnResponse')
    && typeof (rawDetails as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (rawDetails as { spawnNonce: string }).spawnNonce.trim().length > 0
    ? { spawnNonce: (rawDetails as { spawnNonce: string }).spawnNonce.trim(), accepted: true as const }
    : undefined;
  const rawCodes = [errorRecord.code, errorRecord.errorCode]
    .map((value) => (typeof value === 'string' ? String(value).trim() : ''))
    .filter((value) => value.length > 0);
  const sessionListUnavailable = SessionListUnavailableQueryV1Schema.safeParse(rawDetails);
  if (sessionListUnavailable.success && rawCodes.includes(sessionListUnavailable.data.code)) {
    return {
      errorCode: sessionListUnavailable.data.code,
      error: sessionListUnavailable.data.code,
      details: sessionListUnavailable.data,
    };
  }
  const protocolCode = rawCodes.find((value) => (
    SessionControlErrorCodeSchema.safeParse(value).success
    || SpawnSessionErrorCodeSchema.safeParse(value).success
    || value === 'workspace_sync_update_required'
    // Transport owners have already decided whether a mutation may have committed.
    || value === 'outcome_unknown'
    || value === 'cancelled'
  )) ?? '';
  const rpcErrorCode = readRpcErrorCode(error);
  const typedRpcErrorCode = rpcErrorCode && RPC_ERROR_CODE_SET.has(rpcErrorCode)
    ? rpcErrorCode
    : '';
  const normalizedCode = protocolCode || typedRpcErrorCode;
  const rawCode = rawCodes[0] ?? '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof errorRecord.message === 'string'
          ? String(errorRecord.message)
          : typeof errorRecord.errorMessage === 'string'
            ? String(errorRecord.errorMessage)
            : typeof errorRecord.error === 'string'
              ? String(errorRecord.error)
              : '';

  if (normalizedCode) {
    return {
      errorCode: normalizedCode,
      error: message || normalizedCode,
      ...(details !== undefined ? { details } : {}),
    };
  }

  // Common network failures from axios/node.
  if (rawCode && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(rawCode)) {
    return {
      errorCode: 'server_unreachable',
      error: message || 'server_unreachable',
      ...(details !== undefined ? { details } : {}),
    };
  }

  return {
    errorCode: 'action_failed',
    error: message || 'action_failed',
    ...(details !== undefined ? { details } : {}),
  };
}

function readFailureEnvelopeDetails(record: Readonly<Record<string, unknown>>): unknown | undefined {
  if (Object.prototype.hasOwnProperty.call(record, 'details')) {
    return record.details;
  }

  const details: Record<string, unknown> = {};
  for (const key of ['field', 'surface'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value !== undefined) {
      details[key] = value;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function readActionFailureEnvelope(
  result: unknown,
  options: Readonly<{ treatReturnedErrorEnvelopeAsFailure?: boolean }> = {},
): Extract<ActionExecuteResult, Readonly<{ ok: false }>> | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const record = result as Readonly<Record<string, unknown>>;
  if (typeof record.errorCode !== 'string') {
    return null;
  }
  const errorCode = record.errorCode.trim();
  if (!errorCode) {
    return null;
  }
  if (record.ok !== false) {
    if (
      record.type !== 'error'
      || (
        options.treatReturnedErrorEnvelopeAsFailure !== true
        && !SpawnSessionErrorCodeSchema.safeParse(errorCode).success
      )
    ) {
      return null;
    }
  }
  const rawError = typeof record.error === 'string' ? record.error.trim() : '';
  const rawFallbackMessage = typeof record.errorMessage === 'string' && record.errorMessage.trim().length > 0
    ? record.errorMessage.trim()
    : typeof record.message === 'string' && record.message.trim().length > 0
      ? record.message.trim()
      : '';
  const error = rawError && rawError !== errorCode
    ? rawError
    : rawFallbackMessage || rawError || errorCode;
  const details = readFailureEnvelopeDetails(record);
  return {
    ok: false,
    errorCode,
    error,
    ...(details !== undefined ? { details } : {}),
  };
}

function completeActionResult(
  result: unknown,
  options: Readonly<{ treatReturnedErrorEnvelopeAsFailure?: boolean }> = {},
): ActionExecuteResult {
  const failure = readActionFailureEnvelope(result, options);
  return failure ?? { ok: true, result };
}

/** Keep coordinator/RPC success envelopes internal to their host adapter. */
function completeSessionHandoffActionResult(result: unknown): ActionExecuteResult {
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;

  const record = readRecord(result);
  if (record.ok === true && Object.prototype.hasOwnProperty.call(record, 'result')) {
    return completeActionResult(record.result);
  }
  if (record.ok === true) {
    const { ok: _ok, ...terminalResult } = record;
    return completeActionResult(terminalResult);
  }
  return completeActionResult(result);
}

/**
 * Execution-run services keep their RPC compatibility envelope internal. The
 * public Action boundary projects its payload or failure into the canonical
 * Action result shape; raw Action-shaped values still pass through unchanged.
 */
function completeExecutionRunServiceActionResult(actionId: ActionId, result: unknown): ActionExecuteResult {
  const record = readRecord(result);
  if (record.ok === true && hasOwn(record, 'data')) {
    const data = record.data;
    switch (actionId) {
      case 'execution.run.send':
        return completeActionResult(ExecutionRunSendResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.ensure':
        return completeActionResult(ExecutionRunEnsureResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.ensure_or_start':
        return completeActionResult(ExecutionRunEnsureOrStartResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.stream.start':
        return completeActionResult(ExecutionRunTurnStreamStartResponseSchema.parse(data));
      case 'execution.run.stream.read':
        return completeActionResult(ExecutionRunTurnStreamReadResponseSchema.parse(data));
      case 'execution.run.stream.cancel':
        return completeActionResult(ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.stop':
        return completeActionResult(ExecutionRunStopResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.cancel_turn':
        return completeActionResult(ExecutionRunCancelTurnResponseSchema.parse({ ok: true, ...readRecord(data) }));
      case 'execution.run.action':
        return completeActionResult(ExecutionRunActionResponseSchema.parse({ ok: true, ...readRecord(data) }));
      default:
        return completeActionResult(data);
    }
  }

  if (record.ok === false && typeof record.code === 'string' && record.code.trim().length > 0) {
    const errorCode = record.code.trim();
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const details = readFailureEnvelopeDetails(record);
    return {
      ok: false,
      errorCode,
      error: message || errorCode,
      ...(details !== undefined ? { details } : {}),
    };
  }

  return completeActionResult(result);
}

function readCompleteExecutionRunStartIdentity(result: unknown) {
  const record = readRecord(result);
  const wrapperClaimsFailure = record.ok === false;
  const candidates = hasOwn(record, 'data')
    ? [record.data, result]
    : [result];
  for (const candidate of candidates) {
    const candidateRecord = readRecord(candidate);
    const identity = ExecutionRunStartResponseSchema.safeParse({
      runId: candidateRecord.runId,
      callId: candidateRecord.callId,
      sidechainId: candidateRecord.sidechainId,
    });
    if (!identity.success) continue;
    if (wrapperClaimsFailure || candidateRecord.ok === false) return identity.data;
    const response = ExecutionRunStartResponseSchema.safeParse(candidate);
    return response.success ? response.data : identity.data;
  }
  return null;
}

function hasExecutionRunStartIdentityEvidence(result: unknown): boolean {
  const record = readRecord(result);
  const candidates = hasOwn(record, 'data')
    ? [record.data, result]
    : [result];
  return candidates.some((candidate) => {
    const candidateRecord = readRecord(candidate);
    return hasOwn(candidateRecord, 'runId')
      || hasOwn(candidateRecord, 'callId')
      || hasOwn(candidateRecord, 'sidechainId');
  });
}

function classifyExecutionRunStartFailure(
  result: ActionExecuteFailure,
  runCreation: 'noRunCreated' | 'outcomeUnknown',
): ActionExecuteFailure {
  return {
    ...result,
    details: withExecutionRunStartFailureDetails(result.details, runCreation),
  };
}

function classifyExecutionRunStartPreDispatchFailure(
  actionId: ActionId,
  result: ActionExecuteFailure,
): ActionExecuteFailure {
  return actionId === 'execution.run.start'
    ? classifyExecutionRunStartFailure(result, 'noRunCreated')
    : result;
}

function parseExecutionRunWaitResult(result: unknown) {
  const record = readRecord(result);
  // Transport failures may carry service-private diagnostics. Keep the public
  // wait disposition closed while successful observations retain the exact
  // canonical `execution.run.get` projection returned by the shared waiter.
  if (record.ok === false && typeof record.code === 'string') {
    return ExecutionRunWaitResultSchema.safeParse({ ok: false, code: record.code });
  }
  return ExecutionRunWaitResultSchema.safeParse(result);
}

function isExecutionRunWaitCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError')
    || readRecord(error).name === 'AbortError';
}

function completeSpawnActionResult(result: unknown): ActionExecuteResult {
  return completeActionResult(result, { treatReturnedErrorEnvelopeAsFailure: true });
}

export function createActionExecutor(deps: ActionExecutorDeps): Readonly<{
  prepare: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionPrepareResult>;
  execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
  replayApprovedApprovalRequest: (args: Readonly<{
    artifactId: string;
    signal?: AbortSignal;
    callerAuthority?: ActionRequiredAuthority;
  }>) => Promise<ActionExecuteResult>;
}> {
  const policyAllowsAction = deps.isActionEnabled ?? ((_id: ActionId, _ctx: ActionExecutorContext) => true);
  const isActionEnabledByPolicy = (spec: ActionSpec, ctx: ActionExecutorContext) => policyAllowsAction(spec.id, ctx);
  const isActionEnabledBySurface = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionSpecSurfacedOn(spec, ctx.surface);
  const isActionEnabled = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionEnabledBySurface(spec, ctx) && isActionEnabledByPolicy(spec, ctx);
  const listContributedActionDefinitions = (): readonly ActionDefinitionSummaryV1[] => {
    try {
      return deps.listContributedActionDefinitions?.() ?? [];
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
    const definition = listContributedActionDefinitions().find((candidate) => candidate.id === id) ?? null;
    return definition && isContributedActionDefinitionSurfacedOn(definition, ctx)
      ? definition
      : null;
  };

  function resolveAvailabilityForContext(spec: ActionSpec, ctx: ActionExecutorContext): ActionSurfaceAvailability | null {
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

  function requiredAuthorityFailure(
    spec: ActionSpec,
    ctx: ActionExecutorContext,
    input: unknown,
  ): Extract<ActionExecuteResult, Readonly<{ ok: false }>> | null {
    // Request admission is not replay authority. Only the decision owner may
    // stamp the human authority after claiming a present-user approval below.
    if (ctx.bypassApprovals && canRequestPresentUserApprovalForActionInputV1(spec, input)
      && resolveHostStampedAuthority(ctx) !== 'present_user') {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    const admission = resolveCredentialActionAdmissionV1({
      spec, authority: resolveHostStampedAuthority(ctx), grant: ctx.externalActionCredential?.grant ?? null,
      surface: ctx.surface, hasExternalCredential: ctx.externalActionCredential !== undefined,
      actionInput: input,
    });
    return admission.ok ? null : { ok: false, errorCode: admission.errorCode, error: admission.errorCode };
  }

  function credentialScopeFailure(
    actionId: string,
    ctx: ActionExecutorContext,
    input?: unknown,
    discovery = false,
  ): ActionExecuteFailure | null {
    const grant = ctx.externalActionCredential?.grant;
    if (!grant) return null;
    const action = readRecord(readRecord(input).action);
    const contributedQualifiedId = actionId === 'action.invoke'
      && typeof action.pluginId === 'string' && typeof action.localId === 'string'
      ? formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.localId })
      : parseQualifiedPluginActionId(actionId) !== null ? actionId : undefined;
    const widgetSurface = (actionId === 'widgets.snapshot.post' || WidgetInstanceActionIdV1Schema.safeParse(actionId).success) ? readWidgetActionSurfaceV1(input) : null;
    const widgetSessionId = widgetSurface?.owner.kind === 'sessionBoard' || widgetSurface?.owner.kind === 'companion' ? widgetSurface.owner.sessionId : null;
    const definitionAction = WidgetDefinitionActionIdV1Schema.safeParse(actionId).success;
    const definitionSession = definitionAction ? readWidgetDefinitionActionSessionV1(input) : null;
    const sessionId = definitionSession?.sessionId ?? widgetSessionId ?? (input === undefined ? null : normalizeId(readRecord(input).sessionId));
    const target = sessionId ? { kind: 'session' as const, sessionId } : widgetSurface || definitionAction ? null : ctx.externalActionTarget
      ?? (ctx.defaultSessionId ? { kind: 'session' as const, sessionId: ctx.defaultSessionId } : null);
    const result = evaluateApiTokenGrantV1({
      grant: discovery ? { ...grant, targets: null, create: null }
        : actionId === 'approval.request.decide' ? { ...grant, targets: null } : grant,
      actionId: contributedQualifiedId && actionId !== 'action.invoke' ? 'action.invoke' : actionId,
      ...(contributedQualifiedId ? { contributedQualifiedId } : {}),
      ...(actionId === 'session.spawn_new' && input !== undefined ? { spawnInput: input } : {}),
      target, targetMachineId: sessionId && sessionId !== ctx.defaultSessionId ? undefined : ctx.defaultSessionMachineId
        ?? (ctx.externalActionTarget?.kind === 'machine' ? ctx.externalActionTarget.machineId : undefined),
    });
    const boundSession = actionId === 'widgets.catalog.list' ? readWidgetCatalogBoundSessionV1(input) : null;
    const boundResult = result.ok && boundSession ? evaluateApiTokenGrantV1({ grant, actionId,
      target: { kind: 'session', sessionId: boundSession.sessionId },
      targetMachineId: boundSession.sessionId === ctx.defaultSessionId ? ctx.defaultSessionMachineId : undefined,
    }) : result;
    const destination = actionId === 'widgets.instance.move' ? readWidgetActionDestinationV1(input) : null;
    const destinationSession = destination?.owner.kind === 'sessionBoard' || destination?.owner.kind === 'companion' ? destination.owner.sessionId : null;
    const finalResult = boundResult.ok && destination ? evaluateApiTokenGrantV1({ grant, actionId,
      target: destinationSession ? { kind: 'session', sessionId: destinationSession } : null,
      targetMachineId: destinationSession && destinationSession === ctx.defaultSessionId ? ctx.defaultSessionMachineId : undefined,
    }) : boundResult;
    return finalResult.ok ? null : {
      ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', details: { reason: finalResult.reason },
    };
  }

  function workspaceWriteFailure(
    spec: ActionSpec,
    input: unknown,
    ctx: ActionExecutorContext,
  ): ActionExecuteFailure | null {
    let currentWorkspaceWrites: 'allow' | 'deny' | undefined;
    try { currentWorkspaceWrites = deps.getCurrentWorkspaceWrites?.(); }
    catch { return { ok: false, errorCode: 'role_policy_unavailable', error: 'role_policy_unavailable' }; }
    const workspaceWrites = ctx.workspaceWrites === 'deny' || currentWorkspaceWrites === 'deny'
      ? 'deny' : currentWorkspaceWrites ?? ctx.workspaceWrites;
    if (workspaceWrites === 'deny' && spec.workspaceWrite) {
      return { ok: false, errorCode: 'workspace_write_denied', error: 'workspace_write_denied' };
    }
    if (isAgentCaller(ctx) && workspaceWrites !== 'allow'
      && isRoleActionIdV1(spec.id) && readRecord(input).workspaceWrites === 'allow') {
      return { ok: false, errorCode: 'workspace_write_escalation_denied', error: 'workspace_write_escalation_denied' };
    }
    return null;
  }

  function pluginActionCallerPolicyFailure(
    spec: ActionSpec,
    input: unknown,
    ctx: ActionExecutorContext,
  ): Extract<ActionExecuteResult, Readonly<{ ok: false }>> | null {
    if (ctx.surface !== 'plugin' || spec.safety === 'safe') return null;
    return isPluginActionCallerPolicySatisfied(spec.pluginCallerPolicy, input, ctx.actionCaller)
      ? null
      : {
          ok: false,
          errorCode: 'plugin_action_caller_forbidden',
          error: 'plugin_action_caller_forbidden',
        };
  }

  function callerInputSchema(spec: ActionSpec, ctx: ActionExecutorContext) {
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
  ): Promise<Readonly<
    | { ok: true; input: unknown }
    | { ok: false; errorCode: string; error: string }
  >> {
    const schema = callerInputSchema(spec, ctx);
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
  }>): Promise<boolean> {
    if (args.request.v !== 2 || !deps.isApprovalExecutionOriginCurrent) return false;
    const origin = ApprovalExecutionOriginV1Schema.safeParse(args.request.executionOriginV1);
    if (
      !origin.success
      || (origin.data.surface === 'api' && (
        origin.data.externalActionExecutionAuthorization === undefined
        || origin.data.externalActionInputSignature === undefined
      ))
      || origin.data.actionId !== args.request.actionId
      || (args.expectedOriginServerId !== undefined
        && args.expectedOriginServerId !== origin.data.serverId)
      || (args.expectedServerIdentityId !== undefined
        && args.expectedServerIdentityId !== origin.data.serverIdentityId)
    ) {
      return false;
    }
    const ownerCurrent = await deps.isApprovalExecutionOriginCurrent({
      origin: origin.data,
      request: args.request,
      ...(args.signal ? { signal: args.signal } : {}),
    }).catch(() => false);
    if (!ownerCurrent) return false;
    if (!origin.data.runId || !origin.data.runOccurrenceId) return true;
    try {
      const currentRun = await deps.executionRunGet(
        origin.data.sessionId ?? null,
        { runId: origin.data.runId, includeStructured: false },
        { ...(args.signal ? { signal: args.signal } : {}) },
      );
      const run = readRecord(readRecord(currentRun).run);
      const inputTurns = readRecord(run.inputTurns);
      return normalizeId(run.runId) === origin.data.runId
        && normalizeId(inputTurns.occurrenceId) === origin.data.runOccurrenceId;
    } catch {
      return false;
    }
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
    /**
     * Raw input retained by the admitted invocation for an Action whose spec
     * declares `approvalInputCustody: 'live_only'`. Only that Action reads it,
     * because its durable record deliberately holds the redacted projection.
     */
    liveOnlyActionArgs?: unknown;
  }>): Promise<
    | Readonly<{ ok: true; request: ApprovalRequest; exec: ActionExecuteResult }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
  > {
    if (!deps.approvalsUpdate) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
    }
    if (isInternalActionId(args.request.actionId)) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }

    const executionOutcomeUnknown = (): Readonly<{ ok: false; errorCode: string; error: string }> => ({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
      error: 'approval_execution_outcome_unknown',
    });

    const persistPreExecutionFailure = async (
      request: ApprovalRequest,
      failure: ActionExecuteFailure,
    ): Promise<
      | Readonly<{ ok: true; request: ApprovalRequest; exec: ActionExecuteResult }>
      | Readonly<{ ok: false; errorCode: string; error: string }>
    > => {
      const executedAtMs = Date.now();
      // A definitive pre-execution failure is a settlement too: no replay is
      // left, so it keeps the same declared input projection as every other
      // terminal transition.
      const nextFailed: ApprovalRequest = {
        ...request,
        status: 'failed',
        updatedAtMs: Math.max(executedAtMs, request.updatedAtMs),
        actionArgs: settleApprovalRequestActionArgs(request),
        execution: request.v === 2
          ? projectApprovalExecutionFailureV2({ request, failure, executedAtMs })
          : {
              executedAtMs,
              ok: false,
              errorCode: failure.errorCode,
              error: failure.error,
            },
      };
      const updated = await deps.approvalsUpdate!({
        artifactId: args.artifactId,
        request: nextFailed,
        serverId: args.artifactServerId,
      });
      const updateFailure = readActionFailureEnvelope(updated);
      return updateFailure ?? { ok: true, request: nextFailed, exec: failure };
    };

    const latestRequest = deps.approvalsGet
      ? await deps.approvalsGet({ artifactId: args.artifactId, serverId: args.artifactServerId })
      : null;
    if (latestRequest) {
      const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(latestRequest);
      if (recordedExecutionResult) {
        return { ok: true, request: latestRequest, exec: recordedExecutionResult };
      }
      if (latestRequest.v === 2 && latestRequest.status === 'executing') {
        return executionOutcomeUnknown();
      }
    }
    if (args.preExecutionFailure) {
      return await persistPreExecutionFailure(args.request, args.preExecutionFailure);
    }
    // An Action with live-only input custody can only run while the admitted
    // invocation still holds its raw input: the durable record deliberately
    // carries the redacted projection. Any other replay path is stale and must
    // never reconstruct the operation from durable approval state.
    const custodyReplayActionId = ActionIdSchema.safeParse(args.request.actionId);
    if (
      custodyReplayActionId.success
      && getActionSpec(custodyReplayActionId.data).approvalInputCustody === 'live_only'
      && args.liveOnlyActionArgs === undefined
    ) {
      return await persistPreExecutionFailure(args.request, {
        ok: false,
        errorCode: 'approval_stale',
        error: 'approval_stale',
      });
    }
    // `approvalsUpdate` has already claimed the open→approved transition at
    // the Artifact owner. A stale/non-transactional read may still project the
    // prior open row, so replay uses that successfully claimed approved value;
    // terminal rows discovered above remain authoritative and idempotent.
    let request = args.request;
    if (request.v === 2) {
      const originIsCurrentBeforeClaim = await isApprovalExecutionOriginCurrentForRequest({
        request,
        expectedOriginServerId: args.expectedOriginServerId ?? args.artifactServerId,
        ...(args.expectedServerIdentityId !== undefined
          ? { expectedServerIdentityId: args.expectedServerIdentityId }
          : {}),
        ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
      });
      if (!originIsCurrentBeforeClaim) {
        return await persistPreExecutionFailure(request, {
          ok: false,
          errorCode: 'approval_stale',
          error: 'approval_stale',
        });
      }
      const executingRequest: ApprovalRequest = {
        ...request,
        status: 'executing',
        updatedAtMs: Math.max(Date.now(), request.updatedAtMs),
      };
      const claimed = await deps.approvalsUpdate({
        artifactId: args.artifactId,
        request: executingRequest,
        serverId: args.artifactServerId,
      });
      const claimFailure = readActionFailureEnvelope(claimed);
      if (claimFailure) {
        const persisted = deps.approvalsGet
          ? await deps.approvalsGet({ artifactId: args.artifactId, serverId: args.artifactServerId })
          : null;
        if (persisted) {
          const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(persisted);
          if (recordedExecutionResult) {
            return { ok: true, request: persisted, exec: recordedExecutionResult };
          }
          if (persisted.v === 2 && persisted.status === 'executing') {
            return executionOutcomeUnknown();
          }
        }
        return claimFailure;
      }
      request = executingRequest;
    }
    const replayActionId = ActionIdSchema.safeParse(request.actionId);
    const actionId = replayActionId.success ? replayActionId.data : null;

    const origin = request.v === 2
      ? ApprovalExecutionOriginV1Schema.safeParse(request.executionOriginV1)
      : null;
    const originIsCurrent = await isApprovalExecutionOriginCurrentForRequest({
      request,
      expectedOriginServerId: args.expectedOriginServerId ?? args.artifactServerId,
      ...(args.expectedServerIdentityId !== undefined
        ? { expectedServerIdentityId: args.expectedServerIdentityId }
        : {}),
      ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
    });
    const requestSurface = origin?.success ? origin.data.surface : null;
    const replayCaller = origin?.success ? origin.data.caller : { kind: 'host' as const };
    const persistedDirectoryApproval = request.actionId === 'session.spawn_new'
      ? SessionCreationDirectoryApprovalV1Schema.safeParse(
        request.sessionCreationDirectoryApproval,
      )
      : null;
    const persistedHandoffTargetApproval = request.actionId === 'session.handoff'
      ? HandoffTargetReplacementApprovalV1Schema.safeParse(
        request.handoffTargetReplacementApproval,
      )
      : null;
    const executionContext: ActionExecutorContext = {
      ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
      ...(origin?.success ? {
        authority: origin.data.authority,
        surface: origin.data.surface,
        serverId: origin.data.serverId,
        ...(origin.data.serverIdentityId ? { serverIdentityId: origin.data.serverIdentityId } : {}),
        actionCaller: origin.data.caller,
        actionRequestId: origin.data.requestId,
        ...(origin.data.accountId ? { runtimeAccountId: origin.data.accountId } : {}),
        ...(origin.data.externalActionExecutionAuthorization
          ? { externalActionExecutionAuthorization: origin.data.externalActionExecutionAuthorization }
          : {}),
        ...(origin.data.principalId && origin.data.credentialId && origin.data.accountId
          && origin.data.externalActionExecutionAuthorization
          ? { externalActionCredential: {
              accountId: origin.data.accountId,
              principalId: origin.data.principalId,
              credentialId: origin.data.credentialId,
              grant: origin.data.externalActionExecutionAuthorization.binding.grant,
            } }
          : {}),
        ...(origin.data.target ? { externalActionTarget: origin.data.target } : {}),
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
      } : {}),
      actionCaller: replayCaller,
      ...(actionId !== null && requiresPresentUserExecutionAuthorityForActionInputV1(getActionSpec(actionId), request.actionArgs)
        && resolveHostStampedAuthority(args.ctx) === 'present_user'
        ? { authority: 'present_user' as const } : {}),
      placement: null,
      bypassApprovals: true,
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
    const replayInput: unknown = actionId !== null
      && getActionSpec(actionId).approvalInputCustody === 'live_only'
      ? args.liveOnlyActionArgs
      : request.actionArgs;
    const exec = !originIsCurrent || !actionId
        ? { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' }
        : requestSurface
          ? await executeCoreTerminal(
                actionId,
                replayInput,
                executionContext,
                true,
              )
          : { ok: false as const, errorCode: 'approval_execution_surface_invalid', error: 'approval_execution_surface_invalid' };
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
          context: executionContext,
          caller: replayCaller,
          result: projectActionExecutionObservation(actionId, exec),
        });
      } catch {
        // Deferred approval execution is authoritative; after-hook observation is diagnostic only.
      }
    }
    const executedAtMs = Date.now();
    // Blocking approval keeps result custody on the admitted live invocation.
    // Its Artifact is durable history only, so use the Action's existing safe
    // observer projection there while returning `exec` unchanged below. A
    // caller that detached before execution intentionally cannot recover a
    // one-shot secret from durable approval state.
    const persistedExec = actionId !== null
      && (
        isBlockingApprovalRequest(request)
        || getActionSpec(actionId).approvalResultCustody === 'live_only'
      )
      ? projectActionExecutionObservation(actionId, exec)
      : exec;
    // Settled approval input custody, the input-side sibling of `persistedExec`
    // above. Deferred replay is the only reader of the raw arguments and it has
    // already run, so the terminal record keeps this Action's own observation
    // projection instead of retaining write-only secrets forever.
    const nextExecuted: ApprovalRequest = {
      ...request,
      status: exec.ok ? 'executed' : 'failed',
      updatedAtMs: executedAtMs,
      actionArgs: settleApprovalRequestActionArgs(request),
      execution: persistedExec.ok
        ? { executedAtMs, ok: true, result: persistedExec.result }
        : request.v === 2
          ? projectApprovalExecutionFailureV2({
              request,
              failure: persistedExec,
              executedAtMs,
            })
          : { executedAtMs, ok: false, errorCode: persistedExec.errorCode, error: persistedExec.error },
    };

    // The side effect ran after the durable execution claim. If its terminal
    // projection cannot be committed, the Artifact intentionally remains
    // executing and no caller may infer failure or replay blindly. A thrown
    // transport error is the same post-effect uncertainty as a returned
    // failure envelope: it must never be reclassified by the callers' generic
    // catch as an unreached `server_unreachable` request.
    let updated: unknown;
    try {
      updated = await deps.approvalsUpdate({ artifactId: args.artifactId, request: nextExecuted, serverId: args.artifactServerId });
    } catch {
      return executionOutcomeUnknown();
    }
    const updateFailure = readActionFailureEnvelope(updated);
    if (updateFailure) return executionOutcomeUnknown();
    return { ok: true, request: nextExecuted, exec };
  }

  /**
   * Exact-daemon replay capability. Unlike `approval.request.decide`, this
   * entrypoint owns no decision authority: it can only consume an Artifact
   * whose canonical owner has already committed an approve decision.
   */
  const replayApprovedApprovalRequest = async (args: Readonly<{
    artifactId: string;
    signal?: AbortSignal;
    callerAuthority?: ActionRequiredAuthority;
  }>): Promise<ActionExecuteResult> => {
    try {
      const artifactId = normalizeId(args.artifactId);
      if (!artifactId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      if (!deps.approvalsGet || !deps.approvalsUpdate) {
        return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
      }

      // Artifact ids are Account-scoped. Read without a device-local profile
      // filter, then derive and verify every replay identity from the strict
      // immutable request itself.
      const existingRaw = await deps.approvalsGet({ artifactId, serverId: null });
      if (!existingRaw) {
        return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
      }
      const parsed = StoredApprovalRequestSchema.safeParse(existingRaw);
      if (!parsed.success) {
        return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
      }
      const request = parsed.data;
      const parsedRequestActionId = ActionIdSchema.safeParse(request.actionId);
      if ((parsedRequestActionId.success && isApprovalActionId(parsedRequestActionId.data))
        || isInternalActionId(request.actionId)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      if (
        (request.status === 'executed' || request.status === 'failed')
        && request.decision?.kind === 'approve'
      ) {
        return buildApprovalDecisionResult(request);
      }
      if (request.v === 2 && request.status === 'executing') {
        return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
      }
      if (
        request.status !== 'approved'
        || request.decision?.kind !== 'approve'
        || request.execution !== undefined
      ) {
        return { ok: false, errorCode: 'approval_not_approved', error: 'approval_not_approved' };
      }

      const requiresHumanDecision = parsedRequestActionId.success
        && requiresPresentUserDecisionForActionInputV1(getActionSpec(parsedRequestActionId.data), request.actionArgs);
      // An approved Artifact is caller-writable Account data, not proof of a
      // human decision. Human-mandated Actions, including input-sensitive
      // directory consent, require authenticated transport authority to replay.
      if (requiresHumanDecision && args.callerAuthority !== 'present_user') {
        return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
      }

      const artifactServerId = request.v === 2
        ? normalizeId(request.executionOriginV1.serverId) || null
        : normalizeId(request.serverId) || null;
      if (request.v === 1) {
        const failed = await executeApprovedActionForRequest({
          artifactId,
          request,
          artifactServerId,
          ctx: args.signal ? { signal: args.signal } : {},
          preExecutionFailure: {
            ok: false,
            errorCode: 'approval_stale',
            error: 'approval_stale',
          },
        });
        return failed.ok ? buildApprovalDecisionResult(failed.request) : failed;
      }
      if (isBlockingApprovalRequest(request) && await resolveBlockingDecisionIfClaimed({
        artifactId,
        request,
        decision: 'approve',
        decisionAuthority: args.callerAuthority ?? 'account_automation',
        serverId: artifactServerId,
      })) return buildApprovalDecisionResult(request);
      const executed = await executeApprovedActionForRequest({
        artifactId,
        request,
        artifactServerId,
        ctx: {
          ...(args.signal ? { signal: args.signal } : {}),
          ...(requiresHumanDecision && args.callerAuthority === 'present_user'
            ? { authority: 'present_user' as const } : {}),
        },
        observeExecution: true,
      });
      return executed.ok ? buildApprovalDecisionResult(executed.request) : executed;
    } catch (error) {
      const normalized = normalizeActionExecutorThrownError(error);
      return {
        ok: false,
        errorCode: normalized.errorCode,
        error: normalized.error,
        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
      };
    }
  };

  async function resolveBlockingDecisionIfClaimed(args: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    decisionAuthority: ActionRequiredAuthority;
    request: ApprovalRequest;
    serverId: string | null;
  }>): Promise<boolean> {
    const resolved = await deps.approvalsResolveBlockingDecision?.({
      artifactId: args.artifactId,
      decision: args.decision,
      decisionAuthority: args.decisionAuthority,
      request: args.request,
      serverId: args.serverId,
    });
    return resolved?.resolved === true;
  }

  type PreparedCoreAdmission = Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    legacyMetadataLabel?: string;
  }>;

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
  ): ActionPrepareResult => ({
    kind: 'ready',
    invocation: createOneShotInvocation(runOnce
      ? async () => settleActionOutput(admission.actionId, await runOnce())
      : () => executeCoreTerminal(
          admission.actionId,
          admission.input,
          admission.context,
          true,
          admission.legacyMetadataLabel,
          admission,
        )),
  });

  /**
   * The one terminal Action boundary: public failures lose bridge-private
   * metadata and successful built-in Actions project through their declared
   * output schema. Approval admission is deliberately not an action output.
   */
  function settleActionOutput(actionId: ActionId, result: ActionExecuteResult): ActionExecuteResult {
    if (!result.ok) return projectActionExecuteFailure(result);
    if (isDeferredApprovalResult(result)) return result;
    const outputSchema = getActionSpec(actionId).outputSchema;
    if (!outputSchema) return result;
    try {
      const output = outputSchema.safeParse(result.result);
      return output.success
        ? { ok: true, result: output.data }
        : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    } catch {
      return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
  }

  function settlePrepareResult(
    actionId: ActionId,
    result: ActionExecuteResult | ActionPrepareResult,
  ): ActionPrepareResult {
    return 'kind' in result ? result : { kind: 'settled', result: settleActionOutput(actionId, result) };
  }

  const executeCore = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
    inputAlreadyBound = false,
    legacyMetadataLabel?: string,
    options?: Readonly<{
      prepareOnly?: boolean;
      prepared?: PreparedCoreAdmission;
    }>,
  ): Promise<ActionExecuteResult | ActionPrepareResult> => {
    const existingAdmission = options?.prepared;
    const normalizedContext = normalizeActionCallerContext(existingAdmission?.context ?? context ?? {});
    if (!normalizedContext) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    let ctx: ActionExecutorContext = normalizedContext;

    const listAccessFailure = resolveActionSessionListAccessFailure(actionId, ctx);
    if (listAccessFailure) return listAccessFailure;

    const spec = getActionSpec(actionId);
    {
      const authorityFailure = requiredAuthorityFailure(spec, ctx, input);
      if (authorityFailure) {
        return actionId === 'execution.run.start'
          ? classifyExecutionRunStartFailure(authorityFailure, 'noRunCreated')
          : authorityFailure;
      }
    }
    const actionGrantFailure = credentialScopeFailure(actionId, ctx, actionId === 'action.invoke' ? input : undefined, true);
    if (actionGrantFailure) return actionGrantFailure;
    const availability = existingAdmission ? null : resolveAvailabilityForContext(spec, ctx);
    const isApprovalAction = isApprovalActionId(actionId);
    if (!existingAdmission && (availability ? !availability.available : !isActionEnabled(spec, ctx))) {
      const unavailable = actionDisabled(availability);
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(unavailable, 'noRunCreated')
        : unavailable;
    }
    const bound = existingAdmission
      ? { ok: true as const, input: existingAdmission.input }
      : inputAlreadyBound
      ? { ok: true as const, input }
      : await bindCallerInput(spec, input, ctx);
    if (!bound.ok) {
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(bound, 'noRunCreated')
        : bound;
    }
    const parsed = existingAdmission
      ? { success: true as const, data: existingAdmission.input }
      : spec.inputSchema.safeParse(bound.input ?? {});
    if (!parsed.success) {
      const invalid = { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } as const;
      return actionId === 'execution.run.start'
        ? classifyExecutionRunStartFailure(invalid, 'noRunCreated')
        : invalid;
    }
    let admittedInput = parsed.data;
    const credentialFailure = credentialScopeFailure(actionId, ctx, admittedInput);
    if (credentialFailure) return credentialFailure;
    const workspaceFailure = workspaceWriteFailure(spec, admittedInput, ctx);
    if (workspaceFailure) return workspaceFailure;
    if (WidgetDefinitionActionIdV1Schema.safeParse(actionId).success) {
      const account = readWidgetDefinitionActionAccountV1(admittedInput);
      if (!account) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
      const accountFailure = admitWidgetActionSurfaceV1(deps, { ...account, owner: { kind: 'home' } }, ctx);
      if (accountFailure) return accountFailure;
      const sourceSession = readWidgetDefinitionActionSessionV1(admittedInput);
      if (sourceSession) {
        if (sourceSession.serverId !== account.serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        const sourceScopeFailure = await resolveActionCurrentSessionScopeFailure(actionId,
          { sessionId: sourceSession.sessionId }, ctx, { sessionId: 'current_session' }, deps);
        if (sourceScopeFailure) return sourceScopeFailure;
      }
    }
    const widgetTarget = (actionId === 'widgets.snapshot.post' || WidgetInstanceActionIdV1Schema.safeParse(actionId).success) ? readWidgetActionSurfaceV1(admittedInput) : null;
    if (actionId === 'widgets.snapshot.post' && widgetTarget) {
      const snapshotScopeFailure = admitWidgetActionSurfaceV1(deps, widgetTarget, ctx);
      if (snapshotScopeFailure) return snapshotScopeFailure;
    }
    const widgetDestination = actionId === 'widgets.instance.move' ? readWidgetActionDestinationV1(admittedInput) : null;
    if (widgetTarget && widgetDestination && widgetTarget.serverId !== widgetDestination.serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
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
    if (actionId === 'widgets.instance.add') {
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
    const currentSessionScopeFailure = await resolveActionCurrentSessionScopeFailure(
      actionId,
      admittedInput,
      ctx,
      spec.contextualDefaults,
      deps,
    );
    if (currentSessionScopeFailure) {
      return classifyExecutionRunStartPreDispatchFailure(actionId, currentSessionScopeFailure);
    }
    // Materialized Workflow writes need the same authenticated facts before
    // approval custody as native starts. Replay resolves current baseline and
    // policy while retaining the original host-admitted caller depth.
    if (isAgentCaller(ctx) && requiresActionAgentStartDepthV1(actionId) && !isAgentStartActionV1(actionId)) {
      const resolved = await resolveActionAgentStartContextV1(deps, ctx);
      const permission = resolveAgentEffectivePermission(ctx);
      if (!permission.ok) return permission.error;
      const ceiling = typeof permission.effectiveCallerMode === 'string'
        ? parseAgentPermissionIntentV1Alias(permission.effectiveCallerMode) : null;
      if (!resolved || !ceiling) {
        return actionId.startsWith('workflow.definition.')
          ? { ok: false, errorCode: 'definition_exceeds_authority', error: 'definition_exceeds_authority',
              details: { code: 'definition_exceeds_authority', cause: { code: 'target_unavailable' } } }
          : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      ctx = { ...ctx, agentStartContext: { ...resolved, callerPermissionCeiling: ceiling } };
    }
    const agentStartAction = isAgentStartActionV1(actionId);
    const roleTargetAction = isRoleActionIdV1(actionId) && actionId.startsWith('session.');
    const userRoleStart = ctx.authority === 'present_user' && agentStartAction
      && typeof readRecord(admittedInput).roleId === 'string'
      && Boolean(ctx.agentStartContext);
    if ((isAgentCaller(ctx) && (agentStartAction || roleTargetAction)) || userRoleStart) {
      const roleTarget = roleTargetAction ? readRecord(admittedInput).sessionId : undefined;
      const resolved = await resolveActionAgentStartContextV1(deps, ctx, typeof roleTarget === 'string' ? roleTarget : undefined);
      const caller = userRoleStart ? { ok: true as const, effectiveCallerMode: 'yolo' } : resolveAgentEffectivePermission(ctx);
      if (!caller.ok) return classifyExecutionRunStartPreDispatchFailure(actionId, caller.error);
      const ceiling = typeof caller.effectiveCallerMode === 'string'
        ? parseAgentPermissionIntentV1Alias(caller.effectiveCallerMode) : null;
      if (!ceiling) return classifyExecutionRunStartPreDispatchFailure(actionId, causalPermissionAuthorityFailure());
      // This fact comes from the authenticated Action caller, never authored input.
      const startContext = resolved ? { ...resolved, callerPermissionCeiling: ceiling,
        initiator: userRoleStart ? 'user' as const : undefined } : null;
      const request = readRecord(admittedInput);
      if (roleTargetAction) {
        const admission = admitActionAgentStartV1(ctx, { kind: 'session_target', targetSessionId: String(request.sessionId) }, startContext);
        if (!admission.ok) return admission.error;
      } else {
        const starts = resolveActionAgentStartRequestsV1({ actionId, input: request, context: ctx,
          baseline: startContext?.baseline ?? { machineId: '', directory: '' } });
        if (!starts.ok) return classifyExecutionRunStartPreDispatchFailure(actionId, {
          ok: false, errorCode: starts.errorCode, error: starts.errorCode,
        });
        for (const start of starts.requests) {
          const admission = admitActionAgentStartV1(ctx, start, startContext);
          if (!admission.ok) return classifyExecutionRunStartPreDispatchFailure(actionId, admission.error);
          if (start.kind === 'execution_run' || start.kind === 'spawn_new') {
            admittedInput = stampAgentStartSelectionV1(request, admission.stamped,
              actionId === 'session.spawn_new' ? 'spawn_new' : 'execution_run', startContext!);
            if (actionId !== 'execution.run.start' && actionId !== 'session.spawn_new' && admission.stamped.roleId && admission.stamped.engine) {
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
    const data = readRecord(admittedInput);
    const sessionMessageSendAdmission: SessionMessageSendAdmission = actionId === 'session.message.send'
      ? resolveSessionMessageSendAdmission(ctx, data.permissionModeOverride)
      : { ok: true };
    if (!sessionMessageSendAdmission.ok) return sessionMessageSendAdmission.error;
    let requiredDirectoryApproval: SessionCreationDirectoryApprovalV1 | null = null;
    let requiredHandoffTargetApproval: HandoffTargetReplacementApprovalV1 | null = null;
    if (!existingAdmission && actionId === 'session.spawn_new' && deps.sessionSpawnNewDirectoryApprovalPreflight) {
      const spawnInput = SessionSpawnNewInputV2Schema.safeParse(admittedInput);
      if (!spawnInput.success) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      let directoryPreflight: Awaited<ReturnType<NonNullable<
        ActionExecutorDeps['sessionSpawnNewDirectoryApprovalPreflight']
      >>>;
      try {
        directoryPreflight = await deps.sessionSpawnNewDirectoryApprovalPreflight({
          input: spawnInput.data,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch {
        return completeSpawnActionResult({
          type: 'error',
          code: ctx.signal?.aborted ? 'cancelled' : 'machine_offline',
          retryable: !ctx.signal?.aborted,
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
            return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
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
        : normalizeId(ctx.serverId) || null;
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
    const contextualSafety = !existingAdmission && actionId === 'session.reports_to.set'
      ? isAgentCaller(ctx)
        && (normalizeId(ctx.defaultSessionId) === String(readRecord(admittedInput).sessionId)
          || (await readActionCallerLedSubtreeSessionIds(deps, ctx))?.has(String(readRecord(admittedInput).sessionId)))
        ? 'safe' as const : 'danger' as const
      : !existingAdmission && spec.safety === 'danger' && widgetDestination
        ? [widgetTarget, widgetDestination].some(target => target?.owner.kind !== 'home' && target?.owner.kind !== 'companion')
          ? 'danger' as const
          : [widgetTarget, widgetDestination].some(target => target?.owner.kind === 'home')
            ? getActionSpec('home.hub.layout.update').safety : getActionSpec('session.presentation.apply').safety
      : !existingAdmission && spec.safety === 'danger' && widgetTarget?.owner.kind === 'home'
        ? getActionSpec('home.hub.layout.update').safety
        : !existingAdmission && spec.safety === 'danger' && widgetTarget?.owner.kind === 'companion'
          ? getActionSpec('session.presentation.apply').safety
          : undefined;
    if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const baseApprovalRouting = existingAdmission
      ? { required: false, flow: 'deferred' as const, result: 'none' as const }
      : resolveActionApprovalRouting({
          actionId,
          spec,
          input: admittedInput,
          context: ctx,
          ...(computerSelection ? { computerConsentGranted: computerSelection.consentGranted, settings: ctx.actionsSettings } : {}),
          ...(contextualSafety === undefined ? {} : { defaultSafety: contextualSafety, settings: ctx.actionsSettings }),
          // Pass the raw policy-hook result through (boolean | undefined). When the hook is unwired,
          // `undefined` propagates so `resolveActionApprovalRouting` applies its centralized fail-safe
          // default instead of coercing an unwired dependency to "no approval" here. (F7)
          requiredByPolicy: ctx.bypassApprovals ? false : contextualSafety === undefined
            ? deps.isActionApprovalRequired?.(actionId, ctx, admittedInput) : undefined,
        });
    const approvalRouting = (!existingAdmission && actionId === 'workspace.sync.conflict.resolve' && !ctx.bypassApprovals)
      ? { required: true, flow: 'deferred' as const, result: 'required' as const }
      : requiredDirectoryApproval || requiredHandoffTargetApproval
      ? {
          required: true,
          flow: 'deferred' as const,
          result: 'required' as const,
        }
      : baseApprovalRouting;
    // Selection is not approval. Only after the incumbent approval policy has
    // admitted this effect (including a waiver/bypass) can its computer owner retain consent.
    if (computerSelection?.selectedTarget && !approvalRouting.required) ctx = { ...ctx, bypassApprovals: true };
    if (!approvalRouting.required && (actionId === 'computer.targets.list'
      || SURFACE_AUTHORITY_AGENT_FLOOR.some(id => id === actionId))) {
      // Carry policy admission (approval replay, waiver or bypass), never substitute human authority.
      ctx = { ...ctx, bypassApprovals: true };
    }
    let dispatchedPluginSessionInputLocalId: string | null = null;

    try {
      if (approvalRouting.required && !isApprovalAction) {
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
              input: admittedInput,
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
        const approvalOrigin = resolveApprovalOriginForRequest(ctx.approvalOrigin, requestingSessionId);
        const createdBy = {
          surface: mapApprovalCreatedBySurface(ctx.surface ?? null),
          ...(approvalPluginCaller ?? {}),
          ...(requestingSessionId ? { sessionId: requestingSessionId } : {}),
        } as const;
        const initialApprovalActionArgs = actionId === 'session.spawn_new'
          ? materializeSessionSpawnApprovalInput(admittedInput, ctx)
          : admittedInput;
        const preparedApproval = await prepareApprovalRequest({
          deps,
          actionId,
          input: admittedInput,
          actionArgs: initialApprovalActionArgs,
          context: ctx,
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
        const approvalActionArgs = preparedApproval.actionArgs;
        const executionOriginV1 = buildApprovalExecutionOriginV1({
          actionId,
          input: approvalActionArgs,
          context: ctx,
          targetSessionId,
        });
        if (!executionOriginV1) {
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode: 'approval_origin_unavailable',
            error: 'approval_origin_unavailable',
          });
        }
        if (ctx.signal?.aborted) {
          return classifyExecutionRunStartPreDispatchFailure(actionId, {
            ok: false,
            errorCode: 'cancelled',
            error: 'cancelled',
          });
        }
        const request: ApprovalRequestV2 = {
          v: 2,
          status: 'open',
          createdAtMs: now,
          updatedAtMs: now,
          createdBy,
          ...(requestedSurface ? { requestedSurface } : {}),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          executionOriginV1,
          approval: {
            flow: approvalRouting.flow,
            result: approvalRouting.result,
          },
          actionId,
          actionArgs: approvalActionArgs,
          summary: buildApprovalSummary(spec, targetSessionId),
          preview: preparedApproval.preview,
          ...(requiredDirectoryApproval
            ? { sessionCreationDirectoryApproval: requiredDirectoryApproval }
            : {}),
          ...(requiredHandoffTargetApproval
            ? { handoffTargetReplacementApproval: requiredHandoffTargetApproval }
            : {}),
        };

        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        const artifactId = normalizeId(res.artifactId);
        if (approvalRouting.flow === 'blocking') {
          if (!deps.approvalsWaitForDecision || !deps.approvalsUpdate) {
            return { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' };
          }

          const effectiveServerId = normalizeId(ctx.serverId) || null;
          const decision = await deps.approvalsWaitForDecision({
            artifactId,
            request,
            serverId: effectiveServerId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });

          if (decision.decision === 'reject' || decision.decision === 'canceled') {
            const nowRejected = Date.now();
            // Settled approval input custody, the blocking sibling of the
            // deferred settlement writes: a refused request has no replay left,
            // so the durable record keeps only the observation projection.
            const nextRequest: ApprovalRequest = {
              ...decision.request,
              status: decision.decision === 'reject' ? 'rejected' : 'canceled',
              updatedAtMs: nowRejected,
              actionArgs: settleApprovalRequestActionArgs(decision.request),
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
                updatedAtMs: Date.now(),
                decision: { kind: 'approve' as const, decidedAtMs: Date.now() },
              };
          if (decision.request.status === 'open') {
            const approved = await deps.approvalsUpdate({ artifactId, request: approvedRequest, serverId: effectiveServerId });
            const approvalFailure = readActionFailureEnvelope(approved);
            if (approvalFailure) return approvalFailure;
          }

          // Live-only input custody keeps the raw input here, on the admitted
          // invocation, rather than in the Artifact the approver can read.
          const liveOnlyCustody = spec.approvalInputCustody === 'live_only'
            ? { liveOnlyActionArgs: admittedInput }
            : {};
          // Only the exact live decision continuation carries authenticated
          // authority. Artifact notifications and durable reads carry none.
          const continuationContext = decision.decisionAuthority === 'present_user'
            ? { ...ctx, authority: 'present_user' as const }
            : ctx;

          if (options?.prepareOnly) {
            const approvedAdmission: PreparedCoreAdmission = {
              actionId,
              input: spec.approvalInputCustody === 'live_only'
                ? admittedInput
                : approvedRequest.actionArgs,
              context: {},
            };
            return ready(approvedAdmission, async () => {
              const executed = await executeApprovedActionForRequest({
                artifactId,
                request: approvedRequest,
                artifactServerId: effectiveServerId,
                ctx: continuationContext,
                ...liveOnlyCustody,
              });
              return executed.ok ? executed.exec : executed;
            });
          }

          const executed = await executeApprovedActionForRequest({
            artifactId,
            request: approvedRequest,
            artifactServerId: effectiveServerId,
            ctx: continuationContext,
            ...liveOnlyCustody,
          });
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

      if (options?.prepareOnly) {
        return ready({
          actionId,
          input: admittedInput,
          context: ctx,
          ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
        });
      }

      const executionPlacement = resolveActionExecutionPlacementForInput(spec, admittedInput);
      if (executionPlacement === 'client' && deps.clientActionExecute) {
        return await deps.clientActionExecute({ actionId, input: admittedInput, context: ctx });
      }
      if (executionPlacement === 'client' && actionId !== 'widgets.instance.refresh'
        && WidgetInstanceActionIdV1Schema.safeParse(actionId).success
        && !deps.widgetSurfaceActions?.companion) return clientActionUnavailable(actionId);

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
            (ctx.surface === 'ui' || ctx.surface === 'agent' || ctx.surface === 'mcp')
            && ctx.actionCaller?.kind !== 'plugin'
            && (actionId === 'sessions.external.candidates.list'
              || actionId === 'sessions.external.candidate.delete'
              || actionId === 'sessions.external.link.ensure'
              || actionId === 'sessions.external.materialize.start'
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

      const reviewCommentActionId = ReviewCommentActionIdV1Schema.safeParse(actionId);
      if (reviewCommentActionId.success) {
        if (!deps.reviewCommentAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        let reviewCommentPrincipal = ctx.reviewCommentPrincipal ?? null;
        let reviewCommentInput = parsed.data;
        if (ctx.actionCaller?.kind === 'workflowRun') {
          if (reviewCommentPrincipal && (
            reviewCommentPrincipal.actor.kind !== 'workflow'
            || reviewCommentPrincipal.actor.runId !== ctx.actionCaller.runId
          )) {
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
          }
          reviewCommentPrincipal ??= { actor: { kind: 'workflow', runId: ctx.actionCaller.runId } };
        } else if (ctx.surface === 'agent' || ctx.surface === 'mcp') {
          const actor = reviewCommentPrincipal?.actor;
          if (actor?.kind !== 'agent' || (ctx.defaultSessionId && ctx.defaultSessionId !== actor.sessionId)) {
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
          }
          if (reviewCommentActionId.data === 'reviews.comments.list') {
            reviewCommentInput = {
              ...data,
              sessionId: data.sessionId ?? actor.sessionId,
            };
          }
        }
        if (ctx.surface === 'plugin') {
          if (ctx.actionCaller?.kind !== 'plugin') {
            return {
              ok: false,
              errorCode: 'plugin_action_caller_required',
              error: 'plugin_action_caller_required',
            };
          }
          if (reviewCommentPrincipal) {
            return {
              ok: false,
              errorCode: 'review_comment_permission_denied',
              error: 'review_comment_permission_denied',
            };
          }
          reviewCommentPrincipal = {
            actor: { kind: 'plugin', pluginId: ctx.actionCaller.pluginId },
          };
        }
        const serverId = normalizeId(ctx.serverId) || null;
        const requestContext = {
          ...(serverId ? { serverId } : {}),
          ...(reviewCommentPrincipal ? { reviewCommentPrincipal } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        if (reviewCommentActionId.data === 'reviews.comments.list') {
          const { allPages, ...request } = ReviewCommentListActionRequestV1Schema.parse(reviewCommentInput);
          reviewCommentInput = request;
          if (allPages) {
            const items: ReviewCommentListResponseV1['items'] = [];
            let cursor = request.cursor;
            do {
              ctx.signal?.throwIfAborted();
              const result = await deps.reviewCommentAction({
                actionId: 'reviews.comments.list',
                input: { ...request, ...(cursor ? { cursor } : {}) },
                ...requestContext,
              });
              const failure = readActionFailureEnvelope(result);
              if (failure) return failure;
              const page = ReviewCommentListResponseV1Schema.parse(result);
              items.push(...page.items);
              cursor = page.cursor ?? undefined;
            } while (cursor !== undefined);
            return { ok: true, result: { items, cursor: null } };
          }
        }
        const result = await deps.reviewCommentAction({
          actionId: reviewCommentActionId.data,
          input: reviewCommentInput,
          ...requestContext,
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      const permissionGrantActionId = PluginPermissionGrantActionIdV1Schema.safeParse(actionId);
      if (permissionGrantActionId.success) {
        if (!deps.pluginPermissionGrantAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const caller = ctx.actionCaller ?? { kind: 'host' as const };
        const common = {
          caller,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        const result = permissionGrantActionId.data === 'plugins.permissions.grants.list'
          ? await deps.pluginPermissionGrantAction({
              actionId: permissionGrantActionId.data,
              input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId.data].parse(parsed.data),
              ...common,
            })
          : permissionGrantActionId.data === 'plugins.permissions.grants.request'
            ? await deps.pluginPermissionGrantAction({
                actionId: permissionGrantActionId.data,
                input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId.data].parse(parsed.data),
                ...common,
              })
            : permissionGrantActionId.data === 'plugins.permissions.grants.grant'
              ? await deps.pluginPermissionGrantAction({
                  actionId: permissionGrantActionId.data,
                  input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId.data].parse(parsed.data),
                  ...common,
                })
              : permissionGrantActionId.data === 'plugins.permissions.grants.revoke'
                ? await deps.pluginPermissionGrantAction({
                    actionId: permissionGrantActionId.data,
                    input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId.data].parse(parsed.data),
                    ...common,
                  })
                : await deps.pluginPermissionGrantAction({
                    actionId: permissionGrantActionId.data,
                    input: PluginPermissionGrantActionInputSchemasV1[permissionGrantActionId.data].parse(parsed.data),
                    ...common,
                  });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      const automationEventActionId = AutomationEventActionIdV1Schema.safeParse(actionId);
      if (automationEventActionId.success) {
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
          actionId: automationEventActionId.data,
          input: AutomationEventActionInputSchemasV1[automationEventActionId.data].parse(parsed.data),
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
          if (intent.kind.startsWith('widget_') && 'ref' in intent && 'surface' in intent.ref) {
            const refusal = admitWidgetActionSurfaceV1(deps, intent.ref.surface, ctx);
            if (refusal) return refusal;
            if (intent.kind === 'widget_add' || intent.kind === 'widget_inputs') {
              let instance = intent.kind === 'widget_add' ? intent.instance : undefined;
              if (intent.kind === 'widget_inputs') {
                const port = readWidgetActionSurfacePortV1(deps, intent.ref.surface);
                const read = port ? await port.read(intent.ref.surface, ctx, ctx.signal) : null;
                const failed = readActionFailureEnvelope(read);
                if (failed) return failed;
                const state = WidgetSurfaceReadV1Schema.safeParse(read);
                if (!state.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
                const existing = state.data.instances.find(entry => entry.instance.id === intent.ref.instanceId)?.instance;
                if (!existing) return { ok: false, errorCode: 'widget_instance_not_found', error: 'widget_instance_not_found' };
                instance = { ...existing, bindings: intent.bindings };
              }
              const admission = await admitWidgetInstanceConfigurationV1(deps, intent.ref, instance!, ctx);
              if (admission) return admission;
            }
          }
        }
        return await executeWorkBoardActionV1(deps.workBoardArtifacts, actionId, parsed.data, ctx.signal, ctx);
      }

      const widgetActionId = WidgetInstanceActionIdV1Schema.safeParse(actionId);
      if (widgetActionId.success) return await executeWidgetInstanceActionV1(deps, widgetActionId.data, admittedInput, ctx);
      const widgetDefinitionActionId = WidgetDefinitionActionIdV1Schema.safeParse(actionId);
      if (widgetDefinitionActionId.success) return await executeWidgetDefinitionActionV1(deps, widgetDefinitionActionId.data, parsed.data, ctx);
      if (actionId === 'widgets.snapshot.post') return await executeWidgetSnapshotPostV1(deps, parsed.data, ctx);

      if (actionId === 'launch_profiles.publish') {
        if (!deps.launchProfilePublish) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const input = LaunchProfilePublishInputV1Schema.parse(parsed.data);
        return { ok: true, result: await deps.launchProfilePublish(input, { context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }) };
      }

      if (isRoleActionIdV1(actionId)) {
        if (actionId.startsWith('session.') && isAgentCaller(ctx)) {
          const target = readRecord(parsed.data).sessionId;
          const roleContext = await resolveActionAgentStartContextV1(deps, ctx, typeof target === 'string' ? target : undefined);
          const caller = roleContext?.caller;
          const ownSessionId = caller?.kind === 'session' ? caller.sessionId : undefined;
          if (typeof target !== 'string' || !ownSessionId
            || (target !== ownSessionId && !roleContext?.ledSubtreeSessionIds.includes(target))) {
            return { ok: false, errorCode: 'session_target_not_led', error: 'session_target_not_led' };
          }
          ctx = { ...ctx, agentStartContext: roleContext ?? undefined };
        }
        if (!deps.roleActionExecute) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.roleActionExecute({ actionId, input: parsed.data, context: ctx });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      const artifactAccessActionId = ArtifactAccessActionIdV1Schema.safeParse(actionId);
      if (artifactAccessActionId.success) {
        if (!deps.artifactAccessAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.artifactAccessAction({ actionId: artifactAccessActionId.data,
          input: ArtifactAccessActionInputSchemasV1[artifactAccessActionId.data].parse(parsed.data), context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: ArtifactAccessActionOutputSchemasV1[artifactAccessActionId.data].parse(result) };
      }

      const artifactActionId = ArtifactActionIdV1Schema.safeParse(actionId);
      if (artifactActionId.success) {
        if (!deps.artifactAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.artifactAction({ actionId: artifactActionId.data,
          input: ArtifactActionInputSchemasV1[artifactActionId.data].parse(parsed.data), context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: ArtifactActionOutputSchemasV1[artifactActionId.data].parse(result) };
      }

      const workflowActionId = WorkflowActionIdV1Schema.safeParse(actionId);
      if (workflowActionId.success) {
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
        const workflowId = workflowActionId.data;
        const result = await (async () => {
          switch (workflowId) {
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
            case 'workflow.trigger.list':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.add':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.update':
              return workflowAction({ actionId: workflowId, input: WorkflowActionInputSchemasV1[workflowId].parse(parsed.data), ...common });
            case 'workflow.trigger.remove':
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

      const automationConversationActionId = AutomationConversationActionIdV1Schema.safeParse(actionId);
      if (automationConversationActionId.success) {
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
          actionId: automationConversationActionId.data,
          input: AutomationConversationActionInputSchemasV1[automationConversationActionId.data].parse(parsed.data),
          caller: ctx.actionCaller,
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
      const scopeActionId = ScopeActionIdSchema.safeParse(actionId);
      if (scopeActionId.success) {
        if (!deps.scopeAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.scopeAction({ actionId: scopeActionId.data, input: parsed.data, context: ctx }));
      }
      const sessionBoardActionId = SessionBoardActionIdV1Schema.safeParse(actionId);
      if (actionId === 'session.pending.next') {
        return completeActionResult(deps.nextPendingSession
          ? await deps.nextPendingSession(ctx)
          : { status: 'unavailable' });
      }
      if (actionId === 'ui.command_palette.list' || actionId === 'ui.command_palette.invoke') {
        if (!deps.uiCommandPaletteAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        return await deps.uiCommandPaletteAction({ actionId, input: parsed.data, context: ctx });
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
      if (sessionBoardActionId.success) {
        if (!deps.sessionBoardAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const boardInput = SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[sessionBoardActionId.data].parse(parsed.data);
        const result = await deps.sessionBoardAction({
          actionId: sessionBoardActionId.data,
          input: boardInput,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const boundSessionId = boardInput.sessionId ?? ctx.defaultSessionId ?? undefined;
        const validated = parseSessionBoardActionPortResultV1(sessionBoardActionId.data, boardInput, result, {
          ...(boundSessionId ? { expectedSessionId: boundSessionId } : {}),
          ...(ctx.serverId ? { expectedServerId: ctx.serverId } : {}),
        });
        if (!validated.success) {
          return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        }
        return validated.kind === 'failure'
          ? validated.data as Extract<ActionExecuteResult, Readonly<{ ok: false }>>
          : { ok: true, result: validated.data };
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

      // One family branch for all nine discussion intents. Context, availability,
      // settings, approval, interception and observation already ran above; the
      // host seals/opens content through the Session cipher and the canonical
      // result is validated once at the terminal output boundary.
      const sessionDiscussionActionId = SessionDiscussionActionIdV1Schema.safeParse(actionId);
      if (sessionDiscussionActionId.success) {
        if (!deps.sessionDiscussionAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.sessionDiscussionAction({
          actionId: sessionDiscussionActionId.data,
          input: SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1[sessionDiscussionActionId.data].parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      const machinePoolActionId = MachinePoolActionIdV1Schema.safeParse(actionId);
      const connectedServiceActionId = ConnectedServiceConfigurationActionIdV1Schema.safeParse(actionId);
      if (connectedServiceActionId.success) {
        if (!deps.connectedServiceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.connectedServiceAction({ actionId: connectedServiceActionId.data, input: parsed.data, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (machinePoolActionId.success) {
        if (!deps.machinePoolAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.machinePoolAction({
          actionId: machinePoolActionId.data,
          input: MachinePoolActionInputSchemasV1[machinePoolActionId.data].parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      // One family branch for the three Temporary computer activation intents.
      // The declared serverTransport rows name the exact registered creator
      // routes; the bound adapter owns the captured Home scope and substitutes
      // the activation id.
      const ephemeralRunnerActionId = EphemeralRunnerActionIdV1Schema.safeParse(actionId);
      if (ephemeralRunnerActionId.success) {
        if (!deps.ephemeralRunnerAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.ephemeralRunnerAction({
          actionId: ephemeralRunnerActionId.data,
          input: EphemeralRunnerActionInputSchemasV1[ephemeralRunnerActionId.data].parse(parsed.data),
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
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (isVoiceConversationActionId(actionId)) {
        if (!deps.voiceConversationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.voiceConversationAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      if (isSettingsDeclarationActionIdV1(actionId)) {
        if (!deps.settingsDeclarationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.settingsDeclarationAction({ actionId, input: parsed.data, context: ctx });
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
      if (isAppUpdateActionId(actionId)) {
        if (!deps.appUpdateAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.appUpdateAction({ actionId, input: parsed.data, context: ctx });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }

      const webhookActionId = PluginWebhookActionIdV1Schema.safeParse(actionId);
      if (webhookActionId.success) {
        if (!deps.pluginWebhookAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.pluginWebhookAction({
          actionId: webhookActionId.data,
          input: PluginWebhookActionInputSchemasV1[webhookActionId.data].parse(parsed.data),
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

      const pluginSettingsAdministrationActionId =
        PluginSettingsAdministrationActionIdV1Schema.safeParse(actionId);
      if (pluginSettingsAdministrationActionId.success) {
        if (!deps.pluginSettingsAdministrationAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const settingsActionId = pluginSettingsAdministrationActionId.data;
        const result = await deps.pluginSettingsAdministrationAction({
          actionId: settingsActionId,
          input: PluginSettingsAdministrationActionInputSchemasV1[settingsActionId].parse(parsed.data),
          context: ctx,
        });
        return completeActionResult(result);
      }

      if ((MACHINE_ADD_SSH_ACTION_IDS as readonly string[]).includes(actionId)) {
        if (!deps.machineAddSshTaskAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const id = actionId as MachineAddSshActionId;
        return completeActionResult(await deps.machineAddSshTaskAction(id, MACHINE_ADD_SSH_INPUT_SCHEMAS[id].parse(parsed.data), ctx));
      }
      if (actionId === 'homes.connect') {
        if (!deps.homeConnect) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.homeConnect(HomeConnectInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'machines.add.command') {
        if (!deps.machineAddCommand) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machineAddCommand(MachineAddCommandInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'machines.pairing.create') {
        if (!deps.machinePairingCreate) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machinePairingCreate(MachinePairingCreateInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'machines.terminal.open') {
        if (!deps.machineTerminalOpen) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const request = MachineTerminalOpenInputSchema.parse(parsed.data);
        const serverId = request.serverId ?? ctx.serverId;
        return completeActionResult(await deps.machineTerminalOpen({ ...request,
          ...(serverId ? { serverId } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }
      if (actionId === 'machines.terminal.list') {
        if (!deps.machineTerminalList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const request = MachineTerminalListInputSchema.parse(parsed.data);
        const serverId = request.serverId ?? ctx.serverId;
        return completeActionResult(await deps.machineTerminalList({ ...request,
          ...(serverId ? { serverId } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }

      if (actionId === 'account.plugins.data.erase') {
        if (!deps.accountPluginDataEraseAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountPluginDataEraseAction({
          input: PluginAccountDataEraseActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.sessions.signOutEverywhere') {
        if (!deps.accountSessionsSignOutEverywhereAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountSessionsSignOutEverywhereAction({
          input: AccountSessionsSignOutEverywhereActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.apiTokens.create') {
        if (!deps.accountApiTokensCreateAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountApiTokensCreateAction({
          input: AccountApiTokensCreateActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.apiTokens.list') {
        if (!deps.accountApiTokensListAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountApiTokensListAction({
          input: AccountApiTokensListActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.encryption.automationTemplates.recover') {
        if (!deps.accountEncryptionAutomationTemplatesRecoverAction) {
          return { ok: false, errorCode: 'target_unavailable', error: 'Historical template recovery belongs to the invoking client; no client key custodian is available.' };
        }
        return completeActionResult(await deps.accountEncryptionAutomationTemplatesRecoverAction({
          input: {}, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }

      if (actionId === 'account.encryption.historicalKey.forget') {
        if (!deps.accountHistoricalEncryptionKeyForgetAction) {
          return { ok: false, errorCode: 'target_unavailable', error: 'Historical credentials belong to the invoking client; no client credential custodian is available.' };
        }
        return completeActionResult(await deps.accountHistoricalEncryptionKeyForgetAction({
          input: {}, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }

      if (actionId === 'account.apiTokens.update') {
        if (!deps.accountApiTokensUpdateAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        return completeActionResult(await deps.accountApiTokensUpdateAction({
          input: AccountApiTokensUpdateActionInputV1Schema.parse(parsed.data), context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }

      if (actionId === 'account.apiTokens.revoke') {
        if (!deps.accountApiTokensRevokeAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountApiTokensRevokeAction({
          input: AccountApiTokensRevokeActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.apiTokens.revokeAll') {
        if (!deps.accountApiTokensRevokeAllAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountApiTokensRevokeAllAction({
          input: AccountApiTokensRevokeAllActionInputV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      // Lane 02 Account Security family. Each row declares its explicit domain
      // transport; the host below owns reachability to one exact Home/Account
      // while the Home transaction retains authentication, authorization,
      // validation, rate limits, encryption, and transaction ownership.
      if (actionId === 'account.security.get') {
        if (!deps.accountSecurityGetAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountSecurityGetAction({
          input: AccountSecurityGetRequestV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.security.terminalPresentUser.set') {
        if (!deps.accountSecurityTerminalPresentUserSetAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        return completeActionResult(await deps.accountSecurityTerminalPresentUserSetAction({
          input: AccountTerminalPresentUserPolicySetRequestV1Schema.parse(parsed.data), context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }

      if (actionId === 'account.password.enroll') {
        if (!deps.accountPasswordEnrollAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountPasswordEnrollAction({
          input: AccountPasswordEnrollRequestV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.password.change') {
        if (!deps.accountPasswordChangeAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountPasswordChangeAction({
          input: AccountPasswordChangeRequestV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.password.remove') {
        if (!deps.accountPasswordRemoveAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountPasswordRemoveAction({
          input: AccountPasswordRemoveRequestV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

      if (actionId === 'account.email.change.request') {
        if (!deps.accountEmailChangeRequestAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.accountEmailChangeRequestAction({
          input: AccountEmailChangeRequestV1Schema.parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return completeActionResult(result);
      }

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
          executeCanonicalAction: async (nestedActionId, nestedInput, options) => await execute(
            nestedActionId,
            nestedInput,
            options?.requiredContributedActionDangerLevel
              ? { ...ctx, requiredContributedActionDangerLevel: options.requiredContributedActionDangerLevel }
              : ctx,
          ),
        });
        return completeActionResult(result);
      }

      if (actionId === 'review.walkthrough' || actionId === 'review.explain_findings') {
        const input = actionId === 'review.walkthrough'
          ? ReviewWalkthroughInputSchema.parse(parsed.data)
          : ReviewExplainFindingsInputSchema.parse(parsed.data);
        const sessionId = resolveSessionIdFromInput(input, ctx);
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const { sessionId: _sessionId, runId, reviewRunIds, ...request } = input;
        const nestedInput = actionId === 'review.walkthrough'
          ? ReviewWalkthroughRequestSchema.parse({ ...request, reviewRunIds: reviewRunIds ?? [runId] })
          : ReviewExplainFindingsRequestSchema.parse({ ...request, reviewRunIds: reviewRunIds ?? [runId] });
        // Reuse the existing Run Action admission/authority transport in every surface.
        const response = await execute('execution.run.action', { sessionId, runId, actionId, input: nestedInput }, ctx);
        if (!response.ok) return response;
        const payload = readReviewRunActionPayload(response.result);
        const host = readRecord(payload);
        if (host.ok === false) return { ok: false,
          errorCode: typeof host.errorCode === 'string' ? host.errorCode : 'review_action_failed',
          error: typeof host.error === 'string' ? host.error : 'review_action_failed' };
        if (actionId === 'review.walkthrough') return { ok: true, result: payload };
        const refinement = ReviewExplainFindingsRefinementSchema.safeParse(payload);
        if (!refinement.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        // Targeting was verified by the host; revision admission remains with U3.
        return execute(refinement.data.refinement.actionId, refinement.data.refinement.input, { ...ctx, defaultSessionId: sessionId });
      }

      if (actionId === 'review.start') {
        const detached = readRecord(data.target).kind === 'detached'
          || (ctx.actionCaller?.kind === 'workflowRun' && data.sessionId === undefined);
        const sessionId = detached ? null : resolveSessionIdFromInput(parsed.data, ctx);
        if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const machineTarget = detached && ctx.externalActionTarget?.kind === 'machine' ? ctx.externalActionTarget : undefined;
        const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
        const opts = buildExecutionRunCallOptions(
          ctx.authority,
          serverId, ctx.signal, detached ? ctx.defaultSessionId : undefined,
          detached ? machineTarget?.machineId ?? ctx.executionRunTargetMachineId : undefined,
          detached ? ctx.executionRunPermissionRequestStore : undefined,
          detached ? ctx.executionRunWorkflowObservationSink : undefined,
          ctx,
        );

        const reviewInput = data as ReviewStartInput;
        const engineIds = reviewInput.engineIds;
        const teamCredentialModel = resolveFanoutTeamCredentialModel(
          reviewInput as Readonly<Record<string, unknown>>,
          engineIds,
        );
        if (!teamCredentialModel.ok) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (
          reviewInput.teamCredentialSessionBindingConsent
          && reviewInput.teamCredentialSessionBindingConsent.sessionId !== sessionId
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (reviewInput.profileId && engineIds.length !== 1) {
          return {
            ok: false,
            errorCode: 'execution_run_profile_requires_single_engine',
            error: 'execution_run_profile_requires_single_engine',
          };
        }
        const instructions = reviewInput.instructions.trim();
        const executionRunPermission = resolveAgentExecutionRunPermission(
          ctx,
          reviewInput.permissionMode,
          EXECUTION_RUN_ACTION_PERMISSION_MODES,
        );
        if (!executionRunPermission.ok) {
          return executionRunPermission.error;
        }
        const permissionDecision = executionRunPermission.permissionDecision;
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : reviewInput.permissionMode;
        const executionRunOpts = executionRunPermission.causalPermissionAuthority
          ? {
              ...(opts ?? {}),
              causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
            }
          : opts;
        let executionRunDispatchOpts = executionRunOpts;
        const runScopedAgentBindings = reviewInput.roleId !== undefined || reviewInput.launchProfileId !== undefined
          || teamCredentialModel.selection !== null;
        if (detached || reviewInput.secretReferenceOverlay || runScopedAgentBindings) {
          const capability = await checkDetachedExecutionRunProtocolV2(
            deps,
            sessionId,
            executionRunOpts,
            {
              startAndWait: false,
              runScopedAgentBindings,
              secretReferenceOverlay: reviewInput.secretReferenceOverlay !== undefined,
            },
          );
          if (!capability.ok) return classifyExecutionRunStartFailure(capability, 'noRunCreated');
          executionRunDispatchOpts = capability.opts;
        }
        const {
          teamCredentialSessionBindingConsent: _teamCredentialSessionBindingConsent,
          secretReferenceOverlay: _secretReferenceOverlay,
          outputs: _outputs,
          narrator: _narrator,
          ...reviewIntentInput
        } = reviewInput;
        const intentInputBase = { ...reviewIntentInput, permissionMode };
        const reviewEngineInventory = await deps.reviewEnginesList({
          sessionId,
          includeDisabled: false,
          ...(reviewScopeForInput(reviewInput) ? { scope: 'paths' as const } : {}),
        });
        const availableReviewEngineKeys = buildAvailableExecutionBackendOptionKeys(reviewEngineInventory);
        const narrationRequested = reviewInput.outputs?.includes('walkthrough') === true;
        const narratorOptions = readReviewNarratorOptions(reviewEngineInventory);
        const narrationPolicy = resolveReviewNarratorPolicy({
          selectedEngineIds: engineIds.map((engineId) => tryNormalizeExecutionBackendOptionValue(engineId) ?? engineId),
          engines: narratorOptions,
        });
        const narrator = reviewInput.narrator ?? (narrationPolicy.defaultNarratorEngineId
          ? { engineId: engineIds.find((engineId) => tryNormalizeExecutionBackendOptionValue(engineId) === narrationPolicy.defaultNarratorEngineId)! }
          : undefined);
        if (narrationRequested && (!reviewInput.comparisonId || !sessionId)) {
          return { ok: false, errorCode: 'review_narration_comparison_required', error: 'review_narration_comparison_required' };
        }
        if (narrationRequested && (!narrator || !narratorOptions.some((option) =>
          option.value === tryNormalizeExecutionBackendOptionValue(narrator.engineId)
          && option.disabled !== true && option.capabilities.structuredNarration))) {
          return { ok: false, errorCode: 'review_narrator_unavailable', error: 'review_narrator_unavailable' };
        }
        const originalModelId = teamCredentialModel.selection?.modelId ?? (typeof data.modelId === 'string' ? data.modelId : undefined);
        const continueSingleReview = narrationRequested && engineIds.length === 1 && !narrationPolicy.requiresSeparateNarrator
          && narrator !== undefined && normalizeExecutionBackendOptionValue(narrator.engineId) === normalizeExecutionBackendOptionValue(engineIds[0]!)
          && (narrator.modelId === undefined || narrator.modelId === originalModelId);

        const reviewGroupId = `review_${bytesToHex(randomBytes(16))}`;
        const results = await fanoutStarts({
          keys: engineIds,
          startOne: async (engineId) => {
            const normalizedBackendTargetKey = normalizeExecutionBackendOptionValue(engineId);
            const rawEngineId = normalizeId(engineId);
            if (
              !availableReviewEngineKeys.has(normalizedBackendTargetKey)
              && (!rawEngineId || !availableReviewEngineKeys.has(rawEngineId))
            ) {
              return {
                ok: false,
                errorCode: 'review_engine_unavailable',
                error: 'review_engine_unavailable',
                details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
              };
            }
            return deps.executionRunStart(
              sessionId,
              {
                intent: data.intent ?? 'review',
                ...(typeof data.roleId === 'string' ? { roleId: data.roleId } : {}),
                ...(typeof data.launchProfileId === 'string' ? { launchProfileId: data.launchProfileId } : {}),
                display: { groupId: reviewGroupId },
                ...(machineTarget?.project ? { cwd: machineTarget.project.directory } : {}),
                ...(reviewInput.notifyParentOnCompletion !== undefined
                  ? { notifyParentOnCompletion: reviewInput.notifyParentOnCompletion }
                  : {}),
                backendTarget: data.roleId && data.backendTarget ? data.backendTarget : normalizeExecutionBackendTargetValue(engineId),
                instructions,
                ...(typeof data.modelId === 'string' ? { modelId: data.modelId } : {}),
                ...(data.modelSelection ? { modelSelection: data.modelSelection } : {}),
                ...(data.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: data.sessionConfigOptionOverrides } : {}),
                permissionMode,
                retentionPolicy: 'resumable',
                runClass: continueSingleReview ? 'long_lived' : 'bounded',
                // Reviews should stream sidechain progress (and tool traffic) into the parent session.
                ioMode: 'streaming',
                ...(teamCredentialModel.selection
                  ? {
                      modelId: teamCredentialModel.selection.modelId,
                      teamCredentialModel: teamCredentialModel.selection,
                      ...(reviewInput.teamCredentialSessionBindingConsent
                        ? { teamCredentialSessionBindingConsent: reviewInput.teamCredentialSessionBindingConsent }
                        : {}),
                    }
                  : {}),
                launchOrigin: resolveExecutionRunLaunchOrigin(ctx),
                ...(reviewInput.profileId && reviewInput.profileSourceCustody
                  ? {
                      profileId: reviewInput.profileId,
                      profileSourceCustody: reviewInput.profileSourceCustody,
                    }
                  : {}),
                ...(reviewInput.secretReferenceOverlay
                  ? { secretReferenceOverlay: reviewInput.secretReferenceOverlay }
                  : {}),
                ...(!data.intent || data.intent === 'review' ? { intentInput: {
                  ...intentInputBase, engineId,
                  ...(continueSingleReview ? { outputs: ['walkthrough'], narrator } : {}),
                } } : {}),
              },
              {
                ...executionRunDispatchOpts,
                ...(ctx.agentStartWorkDepth !== undefined ? { workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 } : {}),
              },
            );
          },
        });

        if (!narrationRequested) return { ok: true, result: { intent: 'review', sessionId, results } };
        const reviewRunIds = results.flatMap((item) => item.ok && typeof readRecord(item.result).runId === 'string'
          ? [String(readRecord(item.result).runId)] : []);
        if (reviewRunIds.length === 0) {
          return { ok: true, result: { intent: 'review', sessionId, results,
            narration: { state: 'failed', errorCode: 'review_launch_failed', error: 'review_launch_failed' } } };
        }
        if (continueSingleReview) {
          return { ok: true, result: { intent: 'review', sessionId, results, narration: {
            runId: reviewRunIds[0], comparisonId: reviewInput.comparisonId, reviewRunIds,
            mode: 'continued_review', state: 'collecting',
          } } };
        }
        const launchFailures = results.flatMap((item) => item.ok ? [] : [{
          engineId: item.key, errorCode: item.errorCode ?? 'execution_run_failed', error: item.error ?? 'execution_run_failed',
        }]);
        let narration: unknown;
        try {
          const response = await deps.executionRunAction(sessionId, {
            runId: reviewRunIds[0], actionId: 'review.walkthrough', input: ReviewWalkthroughRequestSchema.parse({
              reviewRunIds, comparisonId: reviewInput.comparisonId, narrator,
              ...(launchFailures.length > 0 ? { launchFailures } : {}),
            }),
          }, executionRunDispatchOpts);
          const payload = readReviewRunActionPayload(response);
          const actionRecord = readRecord(payload);
          narration = actionRecord.ok === false ? { state: 'failed', ...actionRecord } : payload;
        } catch (error) {
          narration = { state: 'failed', ...readFanoutStartError(error) };
        }
        return { ok: true, result: { intent: 'review', sessionId, results, narration } };
      }

      if (actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start' || actionId === 'voice_agent.start') {
        const detached = actionId === 'subagents.plan.start' && readRecord(data.target).kind === 'detached';
        const sessionId = detached ? null : resolveSessionIdFromInput(parsed.data, ctx);
        if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const machineTarget = detached && ctx.externalActionTarget?.kind === 'machine'
          ? ctx.externalActionTarget : undefined;
        const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
        const opts = buildExecutionRunCallOptions(
          ctx.authority,
          serverId, ctx.signal,
          detached ? ctx.defaultSessionId : undefined,
          detached ? machineTarget?.machineId ?? ctx.executionRunTargetMachineId : undefined,
          detached ? ctx.executionRunPermissionRequestStore : undefined,
          detached ? ctx.executionRunWorkflowObservationSink : undefined,
          ctx,
        );

        const backendTargetKeys: readonly string[] = Array.isArray(data.backendTargetKeys)
          ? data.backendTargetKeys
          : [];
        const teamCredentialModel = resolveFanoutTeamCredentialModel(data, backendTargetKeys);
        if (!teamCredentialModel.ok) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (
          data.teamCredentialSessionBindingConsent
          && (data.teamCredentialSessionBindingConsent as Readonly<{ sessionId: string }>).sessionId !== sessionId
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (data.profileId && backendTargetKeys.length !== 1) {
          return {
            ok: false,
            errorCode: 'execution_run_profile_requires_single_engine',
            error: 'execution_run_profile_requires_single_engine',
          };
        }
        const instructions = String(data.instructions ?? '').trim();
        const intent: 'plan' | 'delegate' | 'voice_agent' =
          actionId === 'subagents.plan.start' ? 'plan' : actionId === 'subagents.delegate.start' ? 'delegate' : 'voice_agent';
        if (intent === 'voice_agent' && teamCredentialModel.selection) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const permissionModeDefault = intent === 'delegate' ? 'workspace_write' : 'read_only';
        const requestedPermissionMode = data.permissionMode;
        const executionRunPermission = resolveAgentExecutionRunPermission(
          ctx,
          requestedPermissionMode,
          EXECUTION_RUN_ACTION_PERMISSION_MODES,
        );
        if (!executionRunPermission.ok) {
          return executionRunPermission.error;
        }
        const permissionDecision = executionRunPermission.permissionDecision;
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : requestedPermissionMode ?? permissionModeDefault;
        const executionRunOpts = executionRunPermission.causalPermissionAuthority
          ? {
              ...(opts ?? {}),
              causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
            }
          : opts;

          let executionRunDispatchOpts = executionRunOpts;
          const runScopedAgentBindings = data.roleId !== undefined || data.launchProfileId !== undefined
            || teamCredentialModel.selection !== null;
          if (detached || data.secretReferenceOverlay || runScopedAgentBindings) {
            const capability = await checkDetachedExecutionRunProtocolV2(
              deps,
              sessionId,
              executionRunOpts,
              {
                startAndWait: false,
                runScopedAgentBindings,
                secretReferenceOverlay: data.secretReferenceOverlay !== undefined,
              },
            );
            if (!capability.ok) return classifyExecutionRunStartFailure(capability, 'noRunCreated');
            executionRunDispatchOpts = capability.opts;
          }
          const runOptions = resolveRunStartModelAndConfig(data);
          if (!runOptions.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const blanketConnectedServices = data.connectedServices === undefined
            ? null
            : normalizeConnectedServiceSelectionInput(data.connectedServices);
          if (blanketConnectedServices && !blanketConnectedServices.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const connectedServicesByBackendTargetKey = data.connectedServicesByBackendTargetKey;
          const {
            teamCredentialSessionBindingConsent: _teamCredentialSessionBindingConsent,
            secretReferenceOverlay: _secretReferenceOverlay,
            ...runIntentInput
          } = data;
          const readConnectedServicesForTargetKey = (backendTargetKey: string): unknown =>
            connectedServicesByBackendTargetKey
            && typeof connectedServicesByBackendTargetKey === 'object'
            && !Array.isArray(connectedServicesByBackendTargetKey)
              ? (connectedServicesByBackendTargetKey as Record<string, unknown>)[backendTargetKey]
              : undefined;
          // Normalize the agent-friendly connected-services selection (simple string / array / full
          // object) at the ONE boundary, once per target, BEFORE any run starts. Malformed input
          // fails the whole action with invalid_parameters — no run is started on a bad selection.
          const connectedServicesByTargetKey = new Map<
            string,
            Readonly<{ bindings: ConnectedServiceBindingsV2 | null | undefined; defaultServiceIds: readonly string[] }>
          >();
          for (const backendTargetKey of backendTargetKeys) {
            const raw = readConnectedServicesForTargetKey(backendTargetKey);
            if (raw === undefined) continue;
            // Preserve bare per-service defaults (RO-F5): the run-start owner resolves them and merges
            // UNDER explicit pins, so a mixed bare+explicit selection resolves instead of failing closed.
            const normalized = normalizeConnectedServiceSelectionInput(raw);
            if (!normalized.ok) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
            connectedServicesByTargetKey.set(backendTargetKey, {
              bindings: normalized.bindings,
              defaultServiceIds: normalized.defaultServiceIds,
            });
          }
          const results = await fanoutStarts({
            keys: backendTargetKeys,
            startOne: async (backendTargetKey) => {
              const targetSelection = connectedServicesByTargetKey.get(backendTargetKey)
                ?? (blanketConnectedServices?.ok
                  ? {
                      bindings: blanketConnectedServices.bindings,
                      defaultServiceIds: blanketConnectedServices.defaultServiceIds,
                    }
                  : undefined);
              const connectedServices = targetSelection?.bindings;
              const connectedServicesDefaultServiceIds = targetSelection?.defaultServiceIds ?? [];
              return deps.executionRunStart(
                sessionId,
                {
                  intent: data.intent ?? intent,
                  ...(typeof data.roleId === 'string' ? { roleId: data.roleId } : {}),
                  ...(typeof data.launchProfileId === 'string' ? { launchProfileId: data.launchProfileId } : {}),
                  ...(machineTarget?.project ? { cwd: machineTarget.project.directory } : {}),
                  backendTarget: data.roleId && data.backendTarget ? data.backendTarget : normalizeExecutionBackendTargetValue(backendTargetKey),
                  instructions,
                  ...(data.modelSelection ? { modelSelection: data.modelSelection } : {}),
                  permissionMode,
                  retentionPolicy: data.retentionPolicy ?? 'ephemeral',
                  runClass: data.runClass ?? 'bounded',
                  ioMode: data.ioMode ?? 'request_response',
                  ...(data.notifyParentOnCompletion !== undefined
                    ? { notifyParentOnCompletion: data.notifyParentOnCompletion }
                    : {}),
                  launchOrigin: resolveExecutionRunLaunchOrigin(ctx),
                  ...(typeof data.profileId === 'string' && data.profileSourceCustody
                    ? {
                        profileId: data.profileId,
                        profileSourceCustody: data.profileSourceCustody,
                      }
                    : {}),
                  ...(teamCredentialModel.selection
                    ? {
                        modelId: teamCredentialModel.selection.modelId,
                        teamCredentialModel: teamCredentialModel.selection,
                        ...(data.teamCredentialSessionBindingConsent
                          ? { teamCredentialSessionBindingConsent: data.teamCredentialSessionBindingConsent }
                          : {}),
                      }
                    : runOptions.options.modelId
                      ? { modelId: runOptions.options.modelId }
                      : {}),
                  ...(runOptions.options.sessionConfigOptionOverrides
                    ? { sessionConfigOptionOverrides: runOptions.options.sessionConfigOptionOverrides }
                    : {}),
                  ...(connectedServices !== undefined ? { connectedServices } : {}),
                  ...(connectedServicesDefaultServiceIds.length > 0
                    ? { connectedServicesDefaultServiceIds }
                    : {}),
                  ...(data.secretReferenceOverlay
                    ? { secretReferenceOverlay: data.secretReferenceOverlay }
                    : {}),
                  ...(!data.intent || data.intent === intent ? { intentInput: {
                    ...runIntentInput,
                    backendTargetKey,
                  } } : {}),
                },
                { ...executionRunDispatchOpts, ...(ctx.agentStartWorkDepth !== undefined ? { workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 } : {}) },
              );
            },
          });

          return { ok: true, result: { intent, sessionId, results } };
        }

        if (actionId === 'action.spec.search') {
          return {
            ok: true,
            result: {
              actionSpecs: searchSerializedActionSpecsForSurface({
                surface: ctx.surface ?? null,
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
          try {
            const requestedSpec = getActionSpec(requestedId as ActionId);
            const credentialFailure = credentialScopeFailure(requestedId, ctx, undefined, true);
            if (credentialFailure) return credentialFailure;
            const requestedAvailability = resolveAvailabilityForContext(requestedSpec, ctx);
            if (requestedAvailability ? !requestedAvailability.available : !isActionEnabled(requestedSpec, ctx)) {
              return actionDisabled(requestedAvailability);
            }
            return {
              ok: true,
              result: {
                actionSpec: projectActionDefinitionForExternalDiscovery(
                  actionSpecToActionDefinitionV1(requestedSpec, {
                    surface: ctx.surface ?? null,
                  }),
                ),
              },
            };
          } catch {
            const contributedDefinition = getContributedActionDefinition(requestedId, ctx);
            if (!contributedDefinition) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
            return {
              ok: true,
              result: {
                actionSpec: projectActionDefinitionForExternalDiscovery({
                  ...contributedDefinition,
                  kindVersion: 1,
                  inputSchema: { ...schemas.inputSchema },
                  ...(schemas.outputSchema === undefined ? {} : { outputSchema: { ...schemas.outputSchema } }),
                }),
              },
            };
          }
        }

        if (actionId === 'action.options.resolve') {
          let actionIdRaw = normalizeId(data.actionId);
          const fieldPath = normalizeId(data.fieldPath);
          const directOptionsSourceId = normalizeId(data.optionsSourceId);
          let optionsSourceId = directOptionsSourceId;
          let admittedInputTypeSource = false;

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
            if (field.connectedAccountOptions && consumer.kind === 'widget') {
              const options = await deps.widgetConnectedAccountOptions?.({ consumer, fieldPath, context: ctx });
              if (!options) return { ok: false, errorCode: 'widget_connected_account_options_unavailable', error: 'widget_connected_account_options_unavailable' };
              if ('ok' in options) return options;
              return { ok: true, result: { actionId: consumingActionId, fieldPath, optionsSourceId: null,
                options: filterResolvedActionOptions([...options], data) } };
            }
            const staticOptions = serializeActionFieldOptions(field);
            if (staticOptions.length > 0) return { ok: true, result: { actionId: consumingActionId, fieldPath,
              optionsSourceId: null, options: filterResolvedActionOptions(staticOptions, data) } };
            optionsSourceId = field.inputType ? inputTypeOptionsSourceId(field.inputType) : normalizeId(field.optionsSourceId);
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
                return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
              const staticOptions = serializeActionFieldOptions(field);
              if (staticOptions.length > 0) {
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
              if (!field.inputType) return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
              optionsSourceId = inputTypeOptionsSourceId(field.inputType);
              admittedInputTypeSource = true;
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
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }

            const staticOptions = serializeActionFieldOptions(field);

            if (staticOptions.length > 0) {
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

            optionsSourceId = field.inputType ? inputTypeOptionsSourceId(field.inputType)
              : normalizeId(readRecord(field).optionsSourceId) || directOptionsSourceId;
            admittedInputTypeSource = field.inputType !== undefined;
            }
          }

          if (parseInputTypeOptionsSourceId(optionsSourceId) && !admittedInputTypeSource) {
            return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
          }

          if (admittedInputTypeSource && deps.readAdmittedInputTypeOptions) {
            const result = await deps.readAdmittedInputTypeOptions({ input: data, context: ctx });
            const failure = readActionFailureEnvelope(result);
            if (failure) return failure;
            const parsed = getActionSpec('action.options.resolve').outputSchema!.safeParse(result);
            return parsed.success ? { ok: true, result: parsed.data }
              : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }

          if (!optionsSourceId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }

          const draftInput = readRecord(data.draftInput);
          const dependencyInput: Record<string, unknown> = {
            ...draftInput,
            ...data,
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
          const action = PluginContributionIdentityV1Schema.safeParse(data.action);
          if (!action.success) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const approvalExecutionOrigin = buildApprovalExecutionOriginV1({
            actionId: 'action.invoke',
            input: data,
            context: ctx,
            targetSessionId: normalizeId(ctx.defaultSessionId) || null,
          });
          return await deps.invokeContributedAction({
            action: action.data,
            input: data.input,
            context: ctx,
            ...(approvalExecutionOrigin ? { approvalExecutionOrigin } : {}),
            ...(ctx.requiredContributedActionDangerLevel ? { requiredDangerLevel: ctx.requiredContributedActionDangerLevel } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        }

        if (actionId === 'sessions.subagents.list') {
          if (!deps.subagentsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.list' };
          }
          const parentSessionId = normalizeId(data.parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsList({
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'groupId')
              ? { groupId: normalizeId(data.groupId) || null }
              : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.get') {
          if (!deps.subagentsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.get' };
          }
          const parentSessionId = normalizeId(data.parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsGet({
            id: String(data.id),
            ...(parentSessionId ? { parentSessionId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.watch') {
          if (!deps.subagentsWatch) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.watch' };
          }
          const parentSessionId = normalizeId(data.parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsWatch({
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(normalizeId(data.id) ? { id: normalizeId(data.id) } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.upsert') {
          if (!deps.subagentsUpsert) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.upsert' };
          }
          const res = await deps.subagentsUpsert({
            input: parsed.data as SubagentRefInputV1,
            caller: ctx.actionCaller ?? { kind: 'host' as const },
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.updateStatus') {
          if (!deps.subagentsUpdateStatus) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.updateStatus' };
          }
          const res = await deps.subagentsUpdateStatus({
            input: parsed.data as {
              id: string;
              parentSessionId: string;
              status: SubagentStatusV1;
              lifecycleDetail?: SubagentLifecycleDetailV1;
              completedAt?: number;
            },
            caller: ctx.actionCaller ?? { kind: 'host' as const },
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.complete') {
          if (!deps.subagentsComplete) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.complete' };
          }
          const res = await deps.subagentsComplete({
            input: parsed.data as {
              id: string;
              parentSessionId: string;
              status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
              lifecycleDetail?: SubagentLifecycleDetailV1;
              completedAt?: number;
            },
            caller: ctx.actionCaller ?? { kind: 'host' as const },
          });
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.start') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            sessionId === null ? ctx.executionRunPermissionRequestStore : undefined,
            sessionId === null ? ctx.executionRunWorkflowObservationSink : undefined,
            ctx,
          );
          const exactInputResults = data.localInputId !== undefined || data.resultContract !== undefined;
          const runScopedAgentBindings = data.roleId !== undefined || data.launchProfileId !== undefined
            || data.teamCredentialModel !== undefined || (
            data.intent === 'agent' && (
              data.cwd !== undefined
              || data.mcpSelection !== undefined
              || data.modelId !== undefined
              || data.modelSelection !== undefined
              || data.sessionConfigOptionOverrides !== undefined
              || data.connectedServices !== undefined
            )
          );
          const secretReferenceOverlay = data.secretReferenceOverlay !== undefined;
          const needsProtocolV2 = sessionId === null
            || data.waitForCompletion === true
            || data.waitTimeoutSeconds !== undefined
            || exactInputResults
            || runScopedAgentBindings
            || secretReferenceOverlay;
          let dispatchOpts = opts;
          if (needsProtocolV2) {
            const capability = await checkDetachedExecutionRunProtocolV2(
              deps,
              sessionId,
              opts,
              {
                startAndWait: data.waitForCompletion === true || data.waitTimeoutSeconds !== undefined,
                exactInputResults,
                runScopedAgentBindings,
                secretReferenceOverlay,
              },
            );
            if (!capability.ok) {
              return classifyExecutionRunStartFailure(capability, 'noRunCreated');
            }
            dispatchOpts = capability.opts;
          }

          const runOptions = resolveRunStartModelAndConfig(data);
          if (!runOptions.ok) {
            return classifyExecutionRunStartFailure(
              { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
              'noRunCreated',
            );
          }
          const request: Record<string, unknown> = { ...data };
          delete request.sessionId;
          delete request.waitForCompletion;
          delete request.waitTimeoutSeconds;
          // The `configOptions` shorthand is merged into the canonical `sessionConfigOptionOverrides`
          // above; never forward it as a second vocabulary on the run request.
          delete request.configOptions;
          request.launchOrigin = resolveExecutionRunLaunchOrigin(ctx);
          if (runOptions.options.modelId) {
            request.modelId = runOptions.options.modelId;
          } else {
            delete request.modelId;
          }
          if (runOptions.options.sessionConfigOptionOverrides) {
            request.sessionConfigOptionOverrides = runOptions.options.sessionConfigOptionOverrides;
          } else {
            delete request.sessionConfigOptionOverrides;
          }
          // Normalize the agent-friendly connected-services selection at the ONE boundary; malformed
          // input fails closed with invalid_parameters (the run is never started on a bad selection).
          if (request.connectedServices !== undefined) {
            const normalized = normalizeConnectedServiceSelectionInput(request.connectedServices);
            if (!normalized.ok) {
              return classifyExecutionRunStartFailure(
                { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
                'noRunCreated',
              );
            }
            request.connectedServices = normalized.bindings;
            // Preserve bare per-service defaults (RO-F5) alongside explicit pins; the run-start owner
            // resolves each named service's stored default and merges it UNDER explicit selections.
            if (normalized.defaultServiceIds.length > 0) {
              request.connectedServicesDefaultServiceIds = normalized.defaultServiceIds;
            } else {
              delete request.connectedServicesDefaultServiceIds;
            }
          }
          const executionRunPermission = resolveAgentExecutionRunPermission(
            ctx,
            request.permissionMode,
            EXECUTION_RUN_ACTION_PERMISSION_MODES,
          );
          if (!executionRunPermission.ok) {
            return classifyExecutionRunStartFailure(executionRunPermission.error, 'noRunCreated');
          }
          const permissionDecision = executionRunPermission.permissionDecision;
          if (permissionDecision?.ok === false) {
            return classifyExecutionRunStartFailure(
              createPermissionPolicyResult(ctx, permissionDecision),
              'noRunCreated',
            );
          }
          if (permissionDecision?.ok === true) {
            request.permissionMode = permissionDecision.requestedMode;
          }
          if (executionRunPermission.causalPermissionAuthority) {
            dispatchOpts = {
              ...(dispatchOpts ?? {}),
              causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
            };
          }
          let rawStartResult: unknown;
          if (ctx.agentStartWorkDepth !== undefined) dispatchOpts = { ...dispatchOpts, workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 };
          try {
            rawStartResult = await deps.executionRunStart(sessionId, request, dispatchOpts);
          } catch (error) {
            const failure = normalizeActionExecutorThrownError(error);
            const details = readFailureEnvelopeDetails(readRecord(error));
            return classifyExecutionRunStartFailure(
              { ok: false, errorCode: failure.errorCode, error: failure.error, ...(details !== undefined ? { details } : {}) },
              readExecutionRunStartRunCreation(details),
            );
          }
          const returnedIdentity = readCompleteExecutionRunStartIdentity(rawStartResult);
          const startResult: ActionExecuteResult = returnedIdentity
            ? { ok: true, result: returnedIdentity }
            : completeExecutionRunServiceActionResult(actionId, rawStartResult);
          if (!startResult.ok) {
            return classifyExecutionRunStartFailure(
              startResult,
              hasExecutionRunStartIdentityEvidence(rawStartResult)
                ? 'outcomeUnknown'
                : readExecutionRunStartRunCreation(startResult.details),
            );
          }
          const res = startResult.result;
          const serviceFailure = readRecord(res);
          if (serviceFailure.ok === false) {
            const failure = readFanoutStartError(res);
            const details = readFailureEnvelopeDetails(serviceFailure);
            return {
              ok: false,
              errorCode: failure.errorCode ?? 'execution_run_failed',
              error: failure.error,
              details: withExecutionRunStartFailureDetails(
                details,
                hasExecutionRunStartIdentityEvidence(rawStartResult)
                  ? 'outcomeUnknown'
                  : readExecutionRunStartRunCreation(details),
              ),
            };
          }
          const parsedStartResponse = ExecutionRunStartResponseSchema.safeParse(res);
          if (!parsedStartResponse.success) {
            return classifyExecutionRunStartFailure(
              {
                ok: false,
                errorCode: 'execution_run_failed',
                error: 'execution_run_invalid_response',
              },
              'outcomeUnknown',
            );
          }
          const admittedStartResult: ActionExecuteResult = {
            ok: true,
            result: parsedStartResponse.data,
          };
          if (data.waitForCompletion !== true) return admittedStartResult;

          const runId = parsedStartResponse.data.runId;
          // The waiter is a client concern: compose the existing scoped waiter
          // after a successful start without turning caller cancellation into a
          // run stop. A typed timeout remains nested under the accepted run.
          try {
            const rawWait = await deps.executionRunWait(sessionId, {
              runId,
              ...(typeof data.waitTimeoutSeconds === 'number'
                ? { timeoutSeconds: data.waitTimeoutSeconds }
                : {}),
            }, dispatchOpts);
            const wait = parseExecutionRunWaitResult(rawWait);
            if (!wait.success) {
              return {
                ok: true,
                result: ExecutionRunStartResponseSchema.parse({
                  ...parsedStartResponse.data,
                  wait: { ok: false, code: 'execution_run_failed' },
                }),
              };
            }
            return {
              ok: true,
              result: ExecutionRunStartResponseSchema.parse({ ...parsedStartResponse.data, wait: wait.data }),
            };
          } catch (error) {
            return {
              ok: true,
              result: ExecutionRunStartResponseSchema.parse({
                ...parsedStartResponse.data,
                wait: isExecutionRunWaitCancellation(error, ctx.signal)
                  ? { ok: false, code: 'cancelled' }
                  : { ok: false, code: 'execution_run_failed' },
              }),
            };
          }
        }

        if (actionId === 'execution.run.list') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunList(sessionId, withoutExecutionRunScope(parsed.data), capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.get') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunGet(sessionId, {
            runId: data.runId,
            includeStructured: data.includeStructured === true,
            ...(data.waitForInputId ? { waitForInputId: data.waitForInputId } : {}),
            ...(data.waitForOutput ? { waitForOutput: data.waitForOutput } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.send') {
          const detachedInput = DetachedExecutionRunSendInputSchema.parse(parsed.data);
          const sessionId = detachedInput.sessionId;
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            sessionId === null ? ctx.executionRunPermissionRequestStore : undefined,
            sessionId === null ? ctx.executionRunWorkflowObservationSink : undefined,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, authority.opts, {
            startAndWait: false,
            exactInputResults: detachedInput.localInputId !== undefined || detachedInput.resultContract !== undefined,
            secretReferenceOverlay: false,
          });
          if (!capability.ok) return capability;
          const res = await deps.detachedExecutionRunSend(sessionId, {
            runId: detachedInput.runId,
            message: detachedInput.message,
            delivery: detachedInput.delivery === 'prompt' || detachedInput.delivery === 'interrupt'
              ? detachedInput.delivery
              : 'steer_if_supported',
            ...(detachedInput.resume === true ? { resume: true } : {}),
            ...(detachedInput.localInputId ? { localInputId: detachedInput.localInputId } : {}),
            ...(detachedInput.resultContract ? { resultContract: detachedInput.resultContract } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.ensure') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunEnsure) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.ensure' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, authority.opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunEnsure(sessionId, {
            runId: data.runId,
            ...(data.resume === true ? { resume: true } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.ensure_or_start') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunEnsureOrStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.ensure_or_start' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const existingAuthority = data.runId
            ? bindAgentExistingExecutionRunAuthority(ctx, opts)
            : { ok: true as const, opts };
          if (!existingAuthority.ok) return existingAuthority.error;
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, existingAuthority.opts, { startAndWait: false });
          if (!capability.ok) return capability;
          let start = data.start ? withoutExecutionRunScope(data.start) : undefined;
          let dispatchOpts = capability.opts;
          if (start) {
            const executionRunPermission = resolveAgentExecutionRunPermission(
              ctx,
              start.permissionMode,
              EXECUTION_RUN_ACTION_PERMISSION_MODES,
            );
            if (!executionRunPermission.ok) {
              return executionRunPermission.error;
            }
            const permissionDecision = executionRunPermission.permissionDecision;
            if (permissionDecision?.ok === false) {
              return createPermissionPolicyResult(ctx, permissionDecision);
            }
            if (permissionDecision?.ok === true) {
              start = { ...start, permissionMode: permissionDecision.requestedMode };
            }
            if (executionRunPermission.causalPermissionAuthority) {
              dispatchOpts = {
                ...(dispatchOpts ?? {}),
                causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
              };
            }
          }
          const res = await deps.executionRunEnsureOrStart(sessionId, {
            ...(data.runId ? { runId: data.runId } : {}),
            ...(start ? { start } : {}),
            ...(data.resume === true ? { resume: true } : {}),
          }, dispatchOpts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stream.start') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunStreamStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.start' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const nestedActionOptions: ExecutionRunCallOptions = {
            ...(authority.opts ?? {}),
            ...(ctx.authority ? { authority: ctx.authority } : {}),
            ...(ctx.actionCaller ? { actionCaller: ctx.actionCaller } : {}),
            ...(normalizeId(ctx.runtimeAccountId) ? { runtimeAccountId: normalizeId(ctx.runtimeAccountId) } : {}),
            ...(normalizeId(ctx.actionRequestId) ? { actionRequestId: normalizeId(ctx.actionRequestId) } : {}),
            ...(ctx.externalActionCredential ? { externalActionCredential: ctx.externalActionCredential } : {}),
            ...(ctx.externalActionExecutionAuthorization ? { externalActionExecutionAuthorization: ctx.externalActionExecutionAuthorization } : {}),
            ...(ctx.signExternalActionApprovalInput ? { signExternalActionApprovalInput: ctx.signExternalActionApprovalInput } : {}),
            ...(ctx.externalActionTarget ? { externalActionTarget: ctx.externalActionTarget } : {}),
            ...(normalizeId(ctx.defaultSessionMachineId)
              ? { defaultSessionMachineId: normalizeId(ctx.defaultSessionMachineId) }
              : {}),
          };
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, nestedActionOptions, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStreamStart(sessionId, {
            runId: data.runId,
            message: data.message,
            ...(data.displayMessage ? { displayMessage: data.displayMessage } : {}),
            ...(data.resume === true ? { resume: true } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stream.read') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunStreamRead) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.read' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStreamRead(sessionId, {
            runId: data.runId,
            streamId: data.streamId,
            ...(typeof data.cursor === 'number' ? { cursor: data.cursor } : {}),
            ...(typeof data.maxEvents === 'number' ? { maxEvents: data.maxEvents } : {}),
            ...(data.waitForEvents === true ? { waitForEvents: true } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stream.cancel') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunStreamCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.cancel' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStreamCancel(sessionId, {
            runId: data.runId,
            streamId: data.streamId,
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.cancel_turn') {
          if (!deps.executionRunCancelTurn) return { ok: false, errorCode: 'unsupported_action', error: 'Cancel turn is unavailable' };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId, ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const request = ExecutionRunCancelTurnRequestSchema.parse({
            runId: data.runId, occurrenceId: data.occurrenceId, turnId: data.turnId,
          });
          const res = await deps.executionRunCancelTurn(sessionId, request, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stop') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStop(sessionId, { runId: data.runId }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.permission.respond') {
          if (!deps.executionRunPermissionRespond) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.permission.respond' };
          }
          const request = ExecutionRunPermissionRespondInputSchema.parse(parsed.data);
          return completeActionResult(await deps.executionRunPermissionRespond(request, ctx));
        }

        if (actionId === 'execution.run.action') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const nestedActionOptions: ExecutionRunCallOptions = {
            ...(authority.opts ?? {}),
            ...(ctx.authority ? { authority: ctx.authority } : {}),
            ...(ctx.actionCaller ? { actionCaller: ctx.actionCaller } : {}),
            ...(normalizeId(ctx.runtimeAccountId) ? { runtimeAccountId: normalizeId(ctx.runtimeAccountId) } : {}),
            ...(normalizeId(ctx.actionRequestId) ? { actionRequestId: normalizeId(ctx.actionRequestId) } : {}),
            ...(ctx.externalActionCredential ? { externalActionCredential: ctx.externalActionCredential } : {}),
            ...(ctx.externalActionExecutionAuthorization ? { externalActionExecutionAuthorization: ctx.externalActionExecutionAuthorization } : {}),
            ...(ctx.signExternalActionApprovalInput ? { signExternalActionApprovalInput: ctx.signExternalActionApprovalInput } : {}),
            ...(ctx.externalActionTarget ? { externalActionTarget: ctx.externalActionTarget } : {}),
            ...(normalizeId(ctx.defaultSessionMachineId)
              ? { defaultSessionMachineId: normalizeId(ctx.defaultSessionMachineId) }
              : {}),
          };
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, nestedActionOptions, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunAction(sessionId, { runId: data.runId, actionId: data.actionId, input: data.input }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'wait') {
          const request = WaitActionInputV1Schema.parse(parsed.data);
          // The target cannot choose credentials: agree with the host's captured Home.
          if (!ctx.serverId || request.target.serverId !== ctx.serverId) {
            return { ok: true, result: { target: request.target, condition: request.condition, disposition: 'permission_denied' } };
          }
          const unwrap = (result: ActionExecuteResult) => result.ok ? result.result : result;
          const result = await executeWaitActionV1(request, {
            execution: async (target, options) => unwrap(await execute('execution.run.wait', {
              runId: target.runId,
              ...(options.condition.kind === 'terminal' ? {} : { condition: options.condition.kind }),
              ...(target.sessionId ? { sessionId: target.sessionId } : { target: { kind: 'detached' } }),
              ...(options.timeoutMs === null ? {} : { timeoutSeconds: options.timeoutMs / 1000 }),
            }, { ...ctx, executionRunTargetMachineId: target.machineId,
              ...(options.onSnapshot ? { onWaitSnapshot: options.onSnapshot } : {}),
              ...(options.signal ? { signal: options.signal } : {}) })),
            workflow: async (target, options) => unwrap(await execute('workflow.run.wait', {
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
                const denied = credentialScopeFailure('action.invoke', ctx, invocation);
                if (denied) return denied;
                const approvalExecutionOrigin = buildApprovalExecutionOriginV1({
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
                  ? unwrap(await execute('session.activity.get', {
                      sessionId: input.target.sessionId, view: 'awareness',
                    }, { ...ctx, ...(options.signal ? { signal: options.signal } : {}) })) : null,
              }),
            } : {}),
          }, { ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.onWaitSnapshot ? { onSnapshot: ctx.onWaitSnapshot } : {}) });
          return { ok: true, result };
        }

        if (actionId === 'execution.run.wait') {
          if (typeof data.runId !== 'string') {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          try {
            const res = await deps.executionRunWait(sessionId, {
              runId: data.runId,
              ...(typeof data.timeoutSeconds === 'number' ? { timeoutSeconds: data.timeoutSeconds } : {}),
              ...(data.condition ? { condition: ExecutionRunWaitConditionSchema.parse(data.condition) } : {}),
              ...(data.after ? { after: ExecutionRunGetResponseSchema.parse(data.after) } : {}),
            }, { ...capability.opts, ...(ctx.onWaitSnapshot ? { onSnapshot: ctx.onWaitSnapshot } : {}) });
            const wait = parseExecutionRunWaitResult(res);
            if (wait.success) return { ok: true, result: wait.data };
            if (readRecord(res).ok === true) {
              return {
                ok: false,
                errorCode: 'action_failed',
                error: 'execution_run_wait_result_invalid',
              };
            }
            return completeActionResult(res);
          } catch (error) {
            if (!isExecutionRunWaitCancellation(error, ctx.signal)) throw error;
            return { ok: true, result: ExecutionRunWaitResultSchema.parse({ ok: false, code: 'cancelled' }) };
          }
        }

        if (isWorkspaceActionId(actionId)) {
          if (!deps.workspaceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.workspaceAction({ actionId, input: parsed.data, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (isSessionCanvasActionId(actionId)) {
          if (!deps.sessionCanvasAction) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.sessionCanvasAction({ actionId, input: parsed.data, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'workflow.authoring.conversation.bind') {
          if (!deps.workflowConversationBind) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.workflowConversationBind({ input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.organization.move') {
          if (!deps.sessionOrganizationMove) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.sessionOrganizationMove({ input: parsed.data,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'composer.transaction.apply' || actionId === 'composer.attachments.pick' || actionId === 'repository.upload.pick') {
          if (!deps.composerIngress) return { ok: true, result: { status: actionId === 'composer.transaction.apply' ? 'composerUnavailable' : 'unavailable' } };
          return completeActionResult(await deps.composerIngress({ actionId, input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.pending.reorder' || actionId === 'todos.reorder') {
          if (!deps.listReorder) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.listReorder({ actionId, input: parsed.data,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'todos.session.link') {
          if (!deps.todoSessionLink) return { ok: true, result: { status: 'unavailable' } };
          return completeActionResult(await deps.todoSessionLink({ input: parsed.data, context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (isSessionTerminalActionId(actionId)) {
          if (!deps.sessionTerminalAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.sessionTerminalAction({ actionId, input: parsed.data, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.open') {
          // A headless Session-open owner can resume Sessions, but cannot target a client tab.
          if ((typeof data.tabId === 'string' || data.destination !== undefined) && !deps.workspaceAction) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' };
          }
          const resolution = await resolveActionSessionAddress(deps, data, ctx);
          if (resolution.kind !== 'unique') return projectSessionReferenceFailure(resolution);
          const { serverId, sessionId } = resolution.address;
          const destination = (parsed.data as PublicActionInputById['session.open']).destination;
          if (destination && 'sessionId' in destination.comparison && destination.comparison.sessionId
            && destination.comparison.sessionId !== sessionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'comparison_session_mismatch' };
          }
          const res = await deps.sessionOpen({
            sessionId,
            serverId,
            ...(destination ? { destination } : {}),
            ...(typeof data.tabId === 'string' ? { tabId: data.tabId } : {}),
            ...(typeof data.approvedNewDirectoryCreation === 'boolean'
              ? { approvedNewDirectoryCreation: data.approvedNewDirectoryCreation } : {}),
            ...(ctx.actionRequestId ? { actionRequestId: ctx.actionRequestId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.fork') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const forkRequest = SessionForkRpcParamsSchema.safeParse({
            v: 1,
            parentSessionId: sessionId,
            forkPoint: data.forkPoint ?? { type: 'latest' },
            ...(hasOwn(data, 'strategy') ? { strategy: data.strategy } : {}),
            ...(hasOwn(data, 'replaySummaryRunner') ? { replaySummaryRunner: data.replaySummaryRunner } : {}),
            ...(hasOwn(data, 'replayMaxSeedChars') ? { replayMaxSeedChars: data.replayMaxSeedChars } : {}),
            ...(hasOwn(data, 'requestId')
              ? { requestId: data.requestId }
              : ctx.actionRequestId
                ? { requestId: ctx.actionRequestId }
                : {}),
          });
          if (!forkRequest.success) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const { parentSessionId } = forkRequest.data;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionFork({
            sessionId: parentSessionId,
            forkPoint: forkRequest.data.forkPoint,
            ...(forkRequest.data.strategy ? { strategy: forkRequest.data.strategy } : {}),
            ...(forkRequest.data.replaySummaryRunner
              ? { replaySummaryRunner: forkRequest.data.replaySummaryRunner }
              : {}),
            ...(forkRequest.data.replayMaxSeedChars !== undefined
              ? { replayMaxSeedChars: forkRequest.data.replayMaxSeedChars }
              : {}),
            ...(forkRequest.data.requestId ? { requestId: forkRequest.data.requestId } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.continue_with_replay') {
          if (!deps.sessionContinueWithReplay) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.continue_with_replay' };
          }
          const res = await deps.sessionContinueWithReplay({
            ...(parsed.data as SessionContinueWithReplayRpcParams),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.rollback') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const rawTarget = data?.target;
          const target = rawTarget && typeof rawTarget === 'object' ? (rawTarget as SessionRollbackTarget) : undefined;
          const res = await deps.sessionRollback({
            sessionId,
            ...(serverId ? { serverId } : {}),
            ...(target ? { target } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.checkpoint_code_rollback') {
          if (!deps.checkpointCodeRollback) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint_code_rollback' };
          }
          const request = parsed.data as CheckpointCodeRollbackActionRequest;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.checkpointCodeRollback({
            request,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.checkpoint') {
          if (!deps.sessionCheckpoint) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint' };
          }
          const request = parsed.data as SessionCheckpointRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionCheckpoint({
            request,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.restore') {
          if (!deps.sessionRestore) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.restore' };
          }
          const request = parsed.data as SessionRestoreRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionRestore({
            request,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const targetMachineId = normalizeId(data.targetMachineId);
          if (!targetMachineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionHandoffStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const targetSessionStorageMode =
            data.targetSessionStorageMode === 'direct' || data.targetSessionStorageMode === 'persisted'
              ? data.targetSessionStorageMode
              : undefined;
          const targetPath = normalizeId(data.targetPath);
          const workspaceAction = data.workspaceAction as HandoffWorkspaceActionV1 | undefined;
          const res = await deps.sessionHandoffStart({
            sessionId,
            targetMachineId,
            ...(targetPath ? { targetPath } : {}),
            ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
            ...(workspaceAction ? { workspaceAction } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.actionRequestId ? { actionRequestId: ctx.actionRequestId } : {}),
            ...(ctx.handoffTargetReplacementApproval
              ? { handoffTargetReplacementApproval: ctx.handoffTargetReplacementApproval }
              : {}),
            ...(ctx.handoffTargetReplacementApprovalReceiptId
              ? {
                  handoffTargetReplacementApprovalReceiptId: ctx.handoffTargetReplacementApprovalReceiptId,
                  handoffTargetReplacementApprovalActionInput: parsed.data,
                }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeSessionHandoffActionResult(res);
        }

        if (actionId === 'session.handoff.prepare_target') {
          if (!deps.sessionHandoffPrepareTarget) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target' };
          }
          const res = await deps.sessionHandoffPrepareTarget(parsed.data as SessionHandoffPrepareTargetRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.prepare_target.resume') {
          if (!deps.sessionHandoffPrepareTargetResume) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target.resume' };
          }
          const res = await deps.sessionHandoffPrepareTargetResume(parsed.data as SessionHandoffPrepareTargetResumeRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.prepare_target_result.get') {
          if (!deps.sessionHandoffPrepareTargetResultGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target_result.get' };
          }
          const res = await deps.sessionHandoffPrepareTargetResultGet(parsed.data as SessionHandoffPrepareTargetResultGetRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.commit') {
          if (!deps.sessionHandoffCommit) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.commit' };
          }
          const res = await deps.sessionHandoffCommit(parsed.data as SessionHandoffCommitRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.abort') {
          if (!deps.sessionHandoffAbort) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.abort' };
          }
          const res = await deps.sessionHandoffAbort(parsed.data as SessionHandoffAbortRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.status.get') {
          if (!deps.sessionHandoffStatusGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.status.get' };
          }
          const res = await deps.sessionHandoffStatusGet(parsed.data as SessionHandoffStatusGetRequest);
          return completeActionResult(res);
        }

        if (actionId === 'workspace.sync.conflict.resolve') {
          if (!deps.workspaceSyncConflictResolve) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.conflict.resolve' };
          }
          if (!ctx.actionRequestId) {
            return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
          }
          const res = await deps.workspaceSyncConflictResolve({
            actionReceiptId: ctx.actionRequestId,
            input: WorkspaceSyncConflictResolveActionInputV1Schema.parse(parsed.data),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'workspace.sync.relationship.create') {
          if (!deps.workspaceSyncRelationshipCreate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationship.create' };
          }
          // Relationship identity is derived from the admitted Action request,
          // never from a caller-supplied value: the target daemon re-derives
          // the same rule to authorize a destructive destination.
          const operationId = normalizeId(ctx.handoffTargetReplacementApproval?.operationId)
            || normalizeId(ctx.actionRequestId);
          if (!operationId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.workspaceSyncRelationshipCreate({
            input: WorkspaceSyncRelationshipCreateActionInputV1Schema.parse(parsed.data),
            operationId,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(ctx.handoffTargetReplacementApproval && ctx.handoffTargetReplacementApprovalReceiptId
              ? {
                  targetReplacementApproval: ctx.handoffTargetReplacementApproval,
                  targetReplacementApprovalReceiptId: ctx.handoffTargetReplacementApprovalReceiptId,
                }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'workspace.sync.relationships.list') {
          if (!deps.workspaceSyncRelationshipsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationships.list' };
          }
          const res = await deps.workspaceSyncRelationshipsList({
            input: WorkspaceSyncRelationshipsListActionInputV1Schema.parse(parsed.data),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'workspace.sync.conflicts.list') {
          if (!deps.workspaceSyncConflictsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.conflicts.list' };
          }
          const res = await deps.workspaceSyncConflictsList({
            input: WorkspaceSyncConflictsListActionInputV1Schema.parse(parsed.data),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'workspace.sync.conflict.inspect') {
          if (!deps.workspaceSyncConflictInspect) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.conflict.inspect' };
          }
          const res = await deps.workspaceSyncConflictInspect({
            input: WorkspaceSyncConflictInspectActionInputV1Schema.parse(parsed.data),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.spawn_new') {
          const spawnInput = data;
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
          );
          if (!spawnArgs) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.sessionSpawnNew(spawnArgs);
          return completeSpawnActionResult(res);
        }

        if (actionId === 'paths.list_recent') {
          const res = await deps.pathsListRecent({
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'projects.list') {
          const projectsList = deps.projectsList;
          if (!projectsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.list' };
          }
          const res = await projectsList({
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
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
          const res = await deps.machinesList({
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
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
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const res = await deps.reviewEnginesList({
            sessionId,
            ...(typeof data.includeDisabled === 'boolean' ? { includeDisabled: data.includeDisabled } : {}),
            ...(data.scope === 'paths' ? { scope: 'paths' as const } : {}),
          });
          return completeActionResult(res);
        }

        if (
          (actionId === 'agents.models.list'
            || actionId === 'agents.config_options.list'
            || actionId === 'agents.session_modes.list'
            || actionId === 'sessions.spawn.connected_services.list')
          && hasOwn(data, 'serverId')
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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

        if (actionId === 'workspace.files.search') {
          if (!deps.workspaceFilesSearch) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await deps.workspaceFilesSearch(WorkspaceFilesSearchActionInputSchema.parse(parsed.data), ctx));
        }

        if (actionId === 'agents.backends.list') {
          const res = await deps.agentsBackendsList({
            ...(typeof data.includeDisabled === 'boolean' ? { includeDisabled: data.includeDisabled } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'machines.agents.signIn.start') {
          if (!deps.machineAgentSignInStart) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = MachinesAgentsSignInStartInputSchema.parse(parsed.data);
          return completeActionResult(await deps.machineAgentSignInStart({ ...request,
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.signIn.status') {
          if (!deps.machineAgentSignInStatus) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await deps.machineAgentSignInStatus({
            ...MachinesAgentsSignInStatusInputSchema.parse(parsed.data),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }
        if (actionId === 'machines.agents.signIn.cancel' || actionId === 'machines.agents.signIn.restart') {
          const operation = actionId === 'machines.agents.signIn.cancel' ? deps.machineAgentSignInCancel : deps.machineAgentSignInRestart;
          if (!operation) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await operation({ ...MachinesAgentsSignInCancelInputSchema.parse(parsed.data),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.install') {
          if (!deps.machineAgentInstallStart) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = DaemonAgentInstallStartRequestSchema.parse({
            agentId: data.agentId, intent: data.intent,
            consent: data.consent ?? { vendorRecipe: false },
            ...(data.force === undefined ? {} : { force: data.force }),
          });
          return completeActionResult(await deps.machineAgentInstallStart({
            ...request, machineId: String(data.machineId),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.install.status') {
          if (!deps.machineAgentInstallRead) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = DaemonAgentInstallReadRequestSchema.parse({ jobId: data.jobId, cursor: data.cursor ?? 0 });
          return completeActionResult(await deps.machineAgentInstallRead({
            ...request, machineId: String(data.machineId),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.install.cancel') {
          if (!deps.machineAgentInstallCancel) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = DaemonAgentInstallCancelRequestSchema.parse({ jobId: data.jobId });
          return completeActionResult(await deps.machineAgentInstallCancel({
            ...request, machineId: String(data.machineId),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'agents.models.list') {
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: readOptionalString(data.agentId),
            backendTargetKey: readOptionalString(data.backendTargetKey),
          });
          if (!resolvedSelection.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const resolvedAgentId = resolvedSelection.selection.agentId;
          const backendTargetKey = resolvedSelection.selection.backendTargetKey;
          if (!resolvedAgentId && !backendTargetKey) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.agentsModelsList({
            ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(backendTargetKey ? { backendTargetKey } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'agents.config_options.list') {
          if (!deps.agentsConfigOptionsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.config_options.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsConfigOptionsList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...((data.modelId) ? { modelId: String(data.modelId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'agents.session_modes.list') {
          if (!deps.agentsSessionModesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.session_modes.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsSessionModesList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.profiles.list') {
          if (!deps.spawnProfilesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.profiles.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({
            deps,
            actionId: null,
            input: data,
            agentScope: 'optional',
          });
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.spawnProfilesList({
            ...selectionArgs,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.connected_services.list') {
          if (!deps.spawnConnectedServicesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.connected_services.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.spawnConnectedServicesList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...(typeof data.includeUnavailable === 'boolean' ? { includeUnavailable: data.includeUnavailable } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.mcp_servers.preview') {
          if (!deps.spawnMcpServersPreview) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const directory = typeof data.directory === 'string' && data.directory.trim().length > 0
            ? data.directory.trim()
            : typeof data.path === 'string' && data.path.trim().length > 0
              ? data.path.trim()
              : undefined;
          const res = await deps.spawnMcpServersPreview({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(directory ? { directory } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'selection') ? { selection: data.selection } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.message.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const actionCaller = ctx.actionCaller ?? { kind: 'host' as const };
          if (data.kind === 'sessionSubagentLaunch' && actionCaller.kind !== 'plugin') {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          // Mediated external source authority is a plugin-mediator fact: it
          // names the mediator, its external revision, and the ceiling that
          // input may request. Only a plugin caller can be held to it, and the
          // Agent/MCP cross-Session path derives its own source authority from
          // the host-stamped active turn instead. A generic caller supplying
          // the field is refused rather than silently stripped, so a permission
          // ceiling is never quietly dropped from an accepted send.
          const parsedSource = data.source === undefined
            ? undefined
            : PluginSessionInputSourceV1Schema.safeParse(data.source);
          if (parsedSource && (actionCaller.kind !== 'plugin' || !parsedSource.success)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          // Only a plugin caller owns a declared Composer attachment the host
          // can qualify. A generic caller supplying the field is refused rather
          // than silently stripped, so a mis-routed send never delivers its
          // text with the entry context quietly dropped.
          const parsedAttachments = Object.prototype.hasOwnProperty.call(data, 'attachments')
            ? PluginSessionInputAttachmentsV1Schema.safeParse(data.attachments)
            : null;
          if (parsedAttachments && (actionCaller.kind !== 'plugin' || !parsedAttachments.success)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const parsedToolAnswerDelivery = data.toolAnswerDelivery === undefined
            ? null
            : PluginSessionUserTextAuthoredFieldSchemasV1.toolAnswerDelivery.safeParse(data.toolAnswerDelivery);
          if (parsedToolAnswerDelivery && (actionCaller.kind !== 'plugin' || !parsedToolAnswerDelivery.success)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          if (
            actionCaller.kind === 'plugin'
            && (
              typeof actionCaller.contributionLocalId !== 'string'
              || actionCaller.contributionLocalId.length === 0
              || typeof data.idempotencyKey !== 'string'
            )
          ) {
            return {
              ok: false,
              errorCode: 'plugin_action_caller_required',
              error: 'plugin_action_caller_required',
            };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const modelOverrideRaw = Object.prototype.hasOwnProperty.call(data, 'modelOverride')
            ? data.modelOverride
            : undefined;
          const providerConnectionIdRaw = Object.prototype.hasOwnProperty.call(data, 'providerConnectionId')
            ? data.providerConnectionId
            : undefined;
          const { permissionModeOverride, sessionInputSource } = sessionMessageSendAdmission;
          const structuredSubagentLaunch = data.kind === 'sessionSubagentLaunch'
            ? resolveSubagentLaunchStructuredSend(data.launch)
            : null;
          const requestedAction = PendingRequestedActionV1Schema.parse(
            structuredSubagentLaunch
              ? { v: 1, kind: 'send_now' }
              : data.requestedAction ?? { v: 1, kind: 'steer_if_active' },
          );
          const sendMessageArgs = {
            context: ctx,
            ...(ctx.externalActionCredential?.grant ? { callerInputConstraints: {
              models: ctx.externalActionCredential.grant.models,
              permissionModes: ctx.externalActionCredential.grant.permissionModes,
            } } : {}),
            sessionId,
            message: structuredSubagentLaunch?.text ?? String(data.message ?? ''),
            ...(data.recipient === undefined ? {} : {
              recipient: ParticipantRecipientRoutingIdentityV1Schema.parse(data.recipient),
            }),
            ...(structuredSubagentLaunch
              ? {
                  displayText: structuredSubagentLaunch.displayText,
                  messageMeta: structuredSubagentLaunch.messageMeta,
                }
              : {}),
            ...(actionCaller.kind === 'plugin' && parsedToolAnswerDelivery?.success && parsedToolAnswerDelivery.data
              ? { messageMeta: {
                  happier: {
                    kind: SESSION_TOOL_ANSWER_DELIVERY_KIND,
                    payload: { toolCallId: parsedToolAnswerDelivery.data.toolCallId },
                  },
                } }
              : {}),
            requestedAction,
            actionCaller,
            ...(typeof data.idempotencyKey === 'string' ? { idempotencyKey: data.idempotencyKey } : {}),
            // A plugin input's identity is host-derived from its idempotency
            // key, so only a non-plugin caller may retain its own localId.
            ...(actionCaller.kind !== 'plugin' && typeof data.localId === 'string' && data.localId.trim().length > 0
              ? { localId: data.localId }
              : {}),
            ...(parsedSource?.success ? { source: parsedSource.data } : {}),
            ...(parsedAttachments?.success ? { attachments: parsedAttachments.data } : {}),
            ...(permissionModeOverride ? { permissionModeOverride } : {}),
            ...(modelOverrideRaw === null
              ? { modelOverride: null }
              : typeof modelOverrideRaw === 'string' && modelOverrideRaw.trim().length > 0
                ? { modelOverride: modelOverrideRaw.trim() }
                : {}),
            ...(providerConnectionIdRaw === null
              ? { providerConnectionId: null }
              : typeof providerConnectionIdRaw === 'string' && providerConnectionIdRaw.trim().length > 0
                ? { providerConnectionId: ProviderConnectionIdSchema.parse(providerConnectionIdRaw) }
                : {}),
            ...(typeof data.wait === 'boolean' ? { wait: data.wait } : {}),
            ...(typeof data.timeoutSeconds === 'number' ? { timeoutSeconds: data.timeoutSeconds } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.surface ? { callerSurface: ctx.surface } : {}),
            ...(sessionInputSource ? { sessionInputSource } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          };
          if (actionCaller.kind === 'plugin') {
            dispatchedPluginSessionInputLocalId = derivePluginSessionInputLocalIdV1({
              caller: actionCaller,
              sessionId,
              idempotencyKey: String(data.idempotencyKey),
            });
          }
          const res = await deps.sessionSendMessage(sendMessageArgs);
          return completeActionResult(res);
        }

        if (actionId === 'session.title.set') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionTitleSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.title.set' };
          }
          const title = String(data.title ?? '').trim();
          if (!title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTitleSet({ context: ctx, sessionId, title, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.stop') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionStop) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.stop' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionStop({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.terminalComposer.clear') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTerminalComposerClear) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.terminalComposer.clear' };
          }
          const expectedStateAtMs = typeof data.expectedStateAtMs === 'number'
            ? data.expectedStateAtMs
            : undefined;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTerminalComposerClear({
            sessionId,
            ...(expectedStateAtMs !== undefined ? { expectedStateAtMs } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.pendingInput.interruptAndRun') {
          const sessionId = normalizeId(data.sessionId);
          const localId = normalizeId(data.localId);
          if (!sessionId || !localId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionPendingInputInterruptAndRun) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.pendingInput.interruptAndRun' };
          }
          const expectedStateAtMs = typeof data.expectedStateAtMs === 'number'
            ? data.expectedStateAtMs
            : undefined;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPendingInputInterruptAndRun({
            sessionId,
            localId,
            ...(expectedStateAtMs !== undefined ? { expectedStateAtMs } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.permission_mode.set') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionPermissionModeSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission_mode.set' };
          }
          const permissionMode = normalizeId(data.permissionMode);
          if (!permissionMode) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const permissionResolution = assertAgentPermission(ctx, permissionMode);
          if (!permissionResolution.ok) {
            return permissionResolution.error;
          }
          const permissionDecision = permissionResolution.permissionDecision;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const effectiveMode = permissionDecision?.ok === true ? permissionDecision.normalizedMode : permissionMode;
          const grantedMode = SESSION_PERMISSION_MODES.find((mode) => mode === effectiveMode);
          const callerConstraints = ctx.externalActionCredential?.grant;
          if (callerConstraints && (!grantedMode || !isPermissionModeGrantedV1(callerConstraints, grantedMode))) {
            return { ok: false, errorCode: 'permission_mode_not_granted', error: 'permission_mode_not_granted' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionModeSet({
            sessionId,
            context: ctx,
            permissionMode: effectiveMode,
            ...(callerConstraints ? { callerInputConstraints: {
              models: callerConstraints.models, permissionModes: callerConstraints.permissionModes,
            } } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.attention.set') {
          const parsedInput = SessionAttentionSetInputV1Schema.safeParse(data);
          const request = parsedInput.success ? resolveSessionAttentionStandingRequest(parsedInput.data) : null;
          const sessionId = parsedInput.success ? normalizeId(parsedInput.data.sessionId) : null;
          if (!request || !sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionAttentionSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.attention.set' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const result = await deps.sessionAttentionSet({ context: ctx, sessionId, request,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          const output = SessionAttentionSetResultV1Schema.safeParse(result);
          if (!output.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          return completeActionResult(output.data);
        }

        if (actionId === 'session.approval_reviewer.set') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId || typeof data.enabled !== 'boolean') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionApprovalReviewerSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.approval_reviewer.set' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          return completeActionResult(await deps.sessionApprovalReviewerSet({ context: ctx, sessionId, enabled: data.enabled, ...(serverId ? { serverId } : {}) }));
        }

        if (actionId === 'session.model.set') {
          const input = SessionModelSetInputSchema.parse(data);
          const sessionId = normalizeId(input.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionModelSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.model.set' };
          }
          const teamCredentialModel = input.teamCredentialModel;
          const modelId = teamCredentialModel === undefined ? normalizeId(input.modelId) : null;
          if (teamCredentialModel === undefined && !modelId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const providerConnectionId = input.providerConnectionId === null
            ? null
            : normalizeId(input.providerConnectionId);
          if (input.providerConnectionId !== undefined && input.providerConnectionId !== null && !providerConnectionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionModelSet({
            sessionId,
            context: ctx,
            ...(ctx.externalActionCredential?.grant ? { callerInputConstraints: {
              models: ctx.externalActionCredential.grant.models,
              permissionModes: ctx.externalActionCredential.grant.permissionModes,
            } } : {}),
            ...(modelId ? { modelId } : {}),
            ...(teamCredentialModel !== undefined ? { teamCredentialModel } : {}),
            ...(input.teamVisibilityGrantConsent !== undefined ? { teamVisibilityGrantConsent: input.teamVisibilityGrantConsent } : {}),
            ...(input.providerConnectionId !== undefined ? { providerConnectionId } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.archive' || actionId === 'session.unarchive') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionArchiveSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.archive' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionArchiveSet({
            sessionId,
            archived: actionId === 'session.archive',
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (isSessionFollowActionIdV1(actionId)) {
          if (!deps.sessionFollowAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (typeof data.sourceSessionId === 'string' && data.sourceSessionId === data.destinationSessionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'session_follow_same_session' };
          }
          const sessionId = normalizeId(data.destinationSessionId) ?? normalizeId(data.sessionId);
          const serverId = sessionId ? resolveServerIdForSession(deps, ctx, sessionId) : normalizeId(ctx.serverId);
          const result = await deps.sessionFollowAction({ context: ctx, actionId, input: data,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          return completeActionResult(parseSessionFollowActionResponse(actionId, data, result));
        }

        if (isSessionReadStateActionIdV1(actionId)) {
          if (!deps.sessionReadStateAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const parsed = SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(data);
          const sessionId = normalizeId(parsed.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const result = await deps.sessionReadStateAction({ context: ctx, actionId, input: parsed,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          try {
            return completeActionResult(parseSessionReadStateActionResponse(actionId, parsed, result));
          } catch {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
        }

        if (actionId === 'session.status.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionStatusGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.status.get' };
          }
          const live = data.live === true;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionStatusGet({ sessionId, live, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.work_state.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionWorkStateGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.work_state.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionWorkStateGet({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.goal.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionGoalGet({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.goal.set') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.set' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const tokenBudget = data.tokenBudget;
          const res = await deps.sessionGoalSet({
            sessionId,
            ...(typeof data.objective === 'string' ? { objective: data.objective } : {}),
            ...(typeof data.status === 'string' ? { status: data.status } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'tokenBudget') && (typeof tokenBudget === 'number' || tokenBudget === null)
              ? { tokenBudget }
              : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.goal.clear') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalClear) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.clear' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionGoalClear({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.waitResume.enable') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeEnable) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.enable' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const issueFingerprint = typeof data.issueFingerprint === 'string'
            ? data.issueFingerprint
            : undefined;
          const remember = data.remember === true
            || data.rememberPreference === true;
          const resumePromptMode = data.resumePromptMode === 'off'
            ? 'off'
            : data.resumePromptMode === 'standard'
              ? 'standard'
              : data.resumePromptMode === 'custom'
                ? 'custom'
                : undefined;
          const res = await deps.sessionUsageLimitWaitResumeEnable({
            sessionId,
            ...(issueFingerprint ? { issueFingerprint } : {}),
            ...(remember ? { remember } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.waitResume.cancel') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.cancel' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const issueFingerprint = data.issueFingerprint;
          const armedAtMs = typeof data.armedAtMs === 'number' && Number.isFinite(data.armedAtMs)
            ? Math.trunc(data.armedAtMs)
            : undefined;
          const runtimeAuthRecoveryAttemptId = typeof data.runtimeAuthRecoveryAttemptId === 'string'
            ? data.runtimeAuthRecoveryAttemptId.trim()
            : '';
          const res = await deps.sessionUsageLimitWaitResumeCancel({
            sessionId,
            ...(Object.prototype.hasOwnProperty.call(data, 'issueFingerprint')
              && (typeof issueFingerprint === 'string' || issueFingerprint === null)
              ? { issueFingerprint }
              : {}),
            ...(armedAtMs !== undefined ? { armedAtMs } : {}),
            ...(runtimeAuthRecoveryAttemptId.length > 0 ? { runtimeAuthRecoveryAttemptId } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.checkNow') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const operation =
            data.operation === 'switch_account_now'
              ? 'switch_account_now'
              : 'check_now';
          const resumePromptMode = data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
            ? data.resumePromptMode
            : undefined;
          if (operation === 'switch_account_now') {
            if (!deps.sessionUsageLimitSwitchAccountNow) {
              return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
            }
            const res = await deps.sessionUsageLimitSwitchAccountNow({
              sessionId,
              ...(typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? { agentId: data.agentId.trim() } : {}),
              ...(resumePromptMode ? { resumePromptMode } : {}),
              ...(serverId ? { serverId } : {}),
            });
            return completeActionResult(res);
          }

          if (!deps.sessionUsageLimitCheckNow) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
          }
          const res = await deps.sessionUsageLimitCheckNow({
            sessionId,
            ...(typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? { agentId: data.agentId.trim() } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.consumeResetCredit') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitConsumeResetCredit) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.consumeResetCredit' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const resumePromptMode = data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
            ? data.resumePromptMode
            : undefined;
          const res = await deps.sessionUsageLimitConsumeResetCredit({
            sessionId,
            ...(typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? { agentId: data.agentId.trim() } : {}),
            ...(typeof data.issueFingerprint === 'string' && data.issueFingerprint.trim().length > 0 ? { issueFingerprint: data.issueFingerprint.trim() } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.vendor_plugin_catalog.list') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionVendorPluginCatalogList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.vendor_plugin_catalog.list' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionVendorPluginCatalogList({
            sessionId,
            ...(typeof data.cwd === 'string' ? { cwd: data.cwd } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.skill_catalog.list') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionSkillCatalogList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.skill_catalog.list' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionSkillCatalogList({
            sessionId,
            ...(typeof data.cwd === 'string' ? { cwd: data.cwd } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.history.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionEventsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.events.get' };
          }
          const limit = typeof data.limit === 'number' ? data.limit : undefined;
          const format = data.format === 'raw' ? 'raw' : 'compact';
          const includeMeta = data.includeMeta === true;
          const includeStructuredPayload = data.includeStructuredPayload === true;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionEventsGet({
            sessionId,
            ...(typeof limit === 'number' ? { limit } : {}),
            format,
            includeMeta,
            includeStructuredPayload,
            ...(format === 'raw' ? { includeRaw: includeStructuredPayload } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.transcript.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTranscriptGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.transcript.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTranscriptGet({
            context: ctx,
            sessionId,
            ...(data.projection === 'externalShareableV1' ? { projection: data.projection } : {}),
            ...(data.projection === 'externalShareableV1' && ctx.actionCaller?.kind === 'plugin'
              ? { callerPluginId: ctx.actionCaller.pluginId }
              : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: readNullableString(data.cursor) } : {}),
            ...(readTranscriptDirection(data.direction) ? { direction: readTranscriptDirection(data.direction) } : {}),
            ...(readTranscriptScope(data.scope) ? { scope: readTranscriptScope(data.scope) } : {}),
            ...(hasOwn(data, 'sidechainId') ? { sidechainId: readNullableString(data.sidechainId) } : {}),
            ...(Array.isArray(data.roles) ? { roles: data.roles } : {}),
            ...(typeof data.includeTools === 'boolean' ? { includeTools: data.includeTools } : {}),
            ...(typeof data.includeReasoning === 'boolean' ? { includeReasoning: data.includeReasoning } : {}),
            ...(typeof data.includeEvents === 'boolean' ? { includeEvents: data.includeEvents } : {}),
            ...(typeof data.includeMeta === 'boolean' ? { includeMeta: data.includeMeta } : {}),
            ...(typeof data.includeStructuredPayload === 'boolean' ? { includeStructuredPayload: data.includeStructuredPayload } : {}),
            ...(typeof data.includeRaw === 'boolean' ? { includeRaw: data.includeRaw } : {}),
            ...(hasOwn(data, 'maxCharsPerMessage') ? { maxCharsPerMessage: typeof data.maxCharsPerMessage === 'number' ? data.maxCharsPerMessage : null } : {}),
            ...(hasOwn(data, 'maxRawPayloadChars') ? { maxRawPayloadChars: typeof data.maxRawPayloadChars === 'number' ? data.maxRawPayloadChars : null } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.events.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionEventsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.events.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionEventsGet({
            sessionId,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: readNullableString(data.cursor) } : {}),
            ...(readTranscriptDirection(data.direction) ? { direction: readTranscriptDirection(data.direction) } : {}),
            ...(readTranscriptScope(data.scope) ? { scope: readTranscriptScope(data.scope) } : {}),
            ...(hasOwn(data, 'sidechainId') ? { sidechainId: readNullableString(data.sidechainId) } : {}),
            ...(Array.isArray(data.roles) ? { roles: data.roles } : {}),
            ...(Array.isArray(data.kinds) ? { kinds: data.kinds } : {}),
            ...(readEventFormat(data.format) ? { format: readEventFormat(data.format) } : {}),
            ...(typeof data.includeMeta === 'boolean' ? { includeMeta: data.includeMeta } : {}),
            ...(typeof data.includeStructuredPayload === 'boolean' ? { includeStructuredPayload: data.includeStructuredPayload } : {}),
            ...(typeof data.includeRaw === 'boolean' ? { includeRaw: data.includeRaw } : {}),
            ...(typeof data.maxTextChars === 'number' ? { maxTextChars: data.maxTextChars } : {}),
            ...(typeof data.maxPayloadChars === 'number' ? { maxPayloadChars: data.maxPayloadChars } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.wait.idle') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionWaitIdle) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.wait.idle' };
          }
          const timeoutSeconds = typeof data.timeoutSeconds === 'number' ? data.timeoutSeconds : 300;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionWaitIdle({ sessionId, timeoutSeconds, ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.permission.respond') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionPermissionRespond) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const decision = readPermissionResponseDecision(data.decision);
          if (!decision) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionPermissionRespond({
            sessionId,
            context: ctx,
            decision,
            requestId: hasOwn(data, 'requestId') ? readNullableString(data.requestId) : null,
            turnId: hasOwn(data, 'turnId') ? readNullableString(data.turnId) : null,
            ...(data.mode === undefined ? {} : { mode: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.mode.parse(data.mode) }),
            ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
            ...(data.answers === undefined ? {} : { answers: StructuredQuestionAnswersV1Schema.parse(data.answers) }),
            ...(Array.isArray(data.allowedTools) ? { allowedTools: data.allowedTools } : {}),
            ...(hasOwn(data, 'updatedPermissions') ? { updatedPermissions: data.updatedPermissions } : {}),
            ...(hasOwn(data, 'execPolicyAmendment') ? { execPolicyAmendment: SessionPermissionRespondRpcParamsV1Schema.options[0].shape.execPolicyAmendment.parse(data.execPolicyAmendment) } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.user_action.answer') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionUserActionAnswer) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.user_action.answer' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionUserActionAnswer({
            sessionId,
            context: ctx,
            requestId: hasOwn(data, 'requestId') ? readNullableString(data.requestId) : null,
            answers: Array.isArray(data.answers) ? data.answers.map((entry) => {
              const answer = readRecord(entry);
              return {
                question: String(answer.question ?? ''),
                values: Array.isArray(answer.values)
                  ? answer.values.map((value) => String(value))
                  : typeof answer.answer === 'string'
                    ? [answer.answer]
                    : [],
              };
            }) : [],
            ...(readUserActionDecision(data.decision) ? { decision: readUserActionDecision(data.decision) } : {}),
            ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
            ...(hasOwn(data, 'updatedPermissions') ? { updatedPermissions: data.updatedPermissions } : {}),
            ...(Array.isArray(data.allowedTools) ? { allowedTools: data.allowedTools } : {}),
            ...(hasOwn(data, 'execPolicyAmendment') ? { execPolicyAmendment: data.execPolicyAmendment } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.mode.set') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const modeIdRaw = normalizeId(data.modeId);
          const availableModes = normalizeResolvedOptions(await deps.sessionModesList({ sessionId }));
          const modeId = resolveRequestedSessionModeId(modeIdRaw, availableModes);
          if (modeId && availableModes.length > 0) {
            if (!availableModes.some((option) => normalizeId(option.value) === modeId)) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
          }
          const res = await deps.sessionModeSet({ sessionId, modeId });
          return completeActionResult(res);
        }

        if (actionId === 'session.target.primary.set') {
          if (!deps.sessionTargetPrimarySet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.primary.set' };
          }
          if (data.sessionId === null) {
            const res = await deps.sessionTargetPrimarySet({ sessionId: null });
            return completeActionResult(res);
          }
          const res = await deps.sessionTargetPrimarySet({
            serverId: String(data.serverId),
            sessionId: String(data.sessionId),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.target.tracked.set') {
          if (!deps.sessionTargetTrackedSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.target.tracked.set' };
          }
          const res = await deps.sessionTargetTrackedSet(Array.isArray(data.sessionAddresses)
            ? {
                context: ctx,
                sessionAddresses: data.sessionAddresses.map((address) => {
                  const record = readRecord(address);
                  return { serverId: String(record.serverId), sessionId: String(record.sessionId) };
                }),
              }
            : {
                context: ctx,
                sessionIds: Array.isArray(data.sessionIds) ? data.sessionIds.map(String) : [],
              });
          return completeActionResult(res);
        }

        if (actionId === 'session.worker.publish') {
          const request = SessionWorkerPublishInputV1Schema.safeParse(admittedInput);
          if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionWorkerPublish) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.worker.publish' };
          const response = await deps.sessionWorkerPublish({ context: ctx, ...request.data });
          const failure = readActionFailureEnvelope(response);
          if (failure) return failure;
          const output = SessionWorkerPublishOutputV1Schema.safeParse(response);
          if (!output.success) return { ok: false, errorCode: 'worker_report_invalid_response', error: 'worker_report_invalid_response' };
          return completeActionResult(output.data);
        }
        if (actionId === 'session.reports_to.set') {
          const request = SessionReportsToSetActionInputV1Schema.safeParse(admittedInput);
          if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionReportsToSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.reports_to.set' };
          const serverId = resolveServerIdForSession(deps, ctx, request.data.sessionId);
          const rawResponse = await deps.sessionReportsToSet({
            ...request.data, context: ctx,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const hostFailure = readActionFailureEnvelope(rawResponse);
          if (hostFailure) return hostFailure;
          const response = SessionReportsToSetResultV1Schema.safeParse(rawResponse);
          if (!response.success) return { ok: false, errorCode: 'session_reports_to_invalid_response', error: 'session_reports_to_invalid_response' };
          const result = response.data;
          if (!result.ok) return {
            ok: false, errorCode: result.error, error: result.error,
            ...(result.error === 'reports_to_forbidden' ? { details: { reason: result.reason } } : {}),
          };
          if (result.sessionId !== request.data.sessionId || result.leadSessionId !== request.data.leadSessionId) {
            return { ok: false, errorCode: 'session_reports_to_invalid_response', error: 'session_reports_to_invalid_response' };
          }
          return completeActionResult(result);
        }

        if (actionId === 'session.list') {
          // Parse through the canonical Action input owner: `query` reaches the listing
          // dependency as a typed `SessionListQueryV1`, never as an untyped record cast.
          const listInput = SessionListActionInputV1Schema.safeParse(admittedInput);
          if (!listInput.success) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const listRequest = listInput.data;
          const requestedRoot = listRequest.underSessionId ?? listRequest.query?.underSessionId;
          if (ctx.sessionListAccess === 'current_session' && requestedRoot !== undefined) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
          }
          const callerSubtree = ctx.sessionListAccess === 'led_subtree'
            || (isAgentCaller(ctx) && ctx.sessionListAccess !== 'current_session');
          const root = requestedRoot ?? (callerSubtree ? ctx.defaultSessionId?.trim() : undefined);
          if (callerSubtree && requestedRoot && requestedRoot !== ctx.defaultSessionId?.trim()
            && !(await readActionCallerLedSubtreeSessionIds(deps, ctx))?.has(requestedRoot)) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
          }
          if (root && (listRequest.activeOnly || listRequest.resumableOnly)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const query = root
            ? SessionListQueryV1Schema.parse(listRequest.query
              ? { ...listRequest.query, underSessionId: root }
              : {
                  v: 1, storage: listRequest.archivedOnly ? 'archived' : 'active',
                  includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [],
                  underSessionId: root,
                  ...(listRequest.limit !== undefined ? { limit: listRequest.limit } : {}),
                  ...(listRequest.cursor ? { cursor: listRequest.cursor } : {}),
                })
            : listRequest.query;
          const res = await deps.sessionList({
            context: ctx,
            ...(query !== undefined ? { query } : {}),
            ...(listRequest.view !== undefined ? { view: listRequest.view } : {}),
            ...(query === undefined && listRequest.limit !== undefined ? { limit: listRequest.limit } : {}),
            ...(query === undefined && hasOwn(data, 'cursor') ? { cursor: listRequest.cursor ?? null } : {}),
            ...(listRequest.includeLastMessagePreview !== undefined ? { includeLastMessagePreview: listRequest.includeLastMessagePreview } : {}),
            ...(query === undefined && listRequest.activeOnly !== undefined ? { activeOnly: listRequest.activeOnly } : {}),
            ...(query === undefined && listRequest.archivedOnly !== undefined ? { archivedOnly: listRequest.archivedOnly } : {}),
            ...(listRequest.includeSystem !== undefined ? { includeSystem: listRequest.includeSystem } : {}),
            ...(query === undefined && listRequest.resumableOnly !== undefined ? { resumableOnly: listRequest.resumableOnly } : {}),
            ...(listRequest.includeRows !== undefined ? { includeRows: listRequest.includeRows } : {}),
            ...(ctx.serverId !== undefined ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(res);
          if (failure) return failure;
          if (
            query !== undefined
            && !parseSessionListQueryActionResultV1(res)
          ) {
            return {
              ok: false,
              errorCode: SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
              error: SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
            };
          }
          if (listRequest.view === SESSION_LIST_AWARENESS_VIEW_V1) {
            // A host that ignored `view` answers with an ordinary summary list. Refusing it here
            // is what stops an awareness caller from projecting a summary locally and reporting
            // success against an older host (AWI-09).
            if (!parseSessionAwarenessListResultV1(res)) {
              return {
                ok: false,
                errorCode: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
                error: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
              };
            }
          }
          return completeActionResult(res);
        }

        if (actionId === 'session.activity.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          // The admitted input already satisfied the Action's strict schema, so read the selector
          // through the same canonical owner rather than comparing local literals.
          const view = SessionListViewV1Schema.safeParse(data.view);
          const res = await deps.sessionActivityGet({
            context: ctx,
            sessionId,
            ...(view.success ? { view: view.data } : {}),
            ...(typeof data.windowSeconds === 'number' ? { windowSeconds: data.windowSeconds } : {}),
            ...(typeof ctx.serverId === 'string' ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (view.success && view.data === SESSION_LIST_AWARENESS_VIEW_V1 && !readActionFailureEnvelope(res)) {
            // A host that ignored `view` answers with its activity digest. Refusing it keeps an
            // awareness caller from reading released booleans as the canonical projection (AWI-09).
            if (!SessionAwarenessProjectionV1Schema.safeParse(res).success) {
              return {
                ok: false,
                errorCode: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
                error: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
              };
            }
          }
          return completeActionResult(res);
        }

        if (actionId === 'session.messages.recent.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTranscriptGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.transcript.get' };
          }
          const includeUser = data.includeUser !== false;
          const includeAssistant = data.includeAssistant !== false;
          const roles: ('user' | 'assistant')[] = [];
          if (includeUser) roles.push('user');
          if (includeAssistant) roles.push('assistant');
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTranscriptGet({
            context: ctx,
            sessionId,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: readNullableString(data.cursor) } : {}),
            roles,
            ...(hasOwn(data, 'maxCharsPerMessage') ? { maxCharsPerMessage: typeof data.maxCharsPerMessage === 'number' ? data.maxCharsPerMessage : null } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
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
          const sessionId = normalizeId(data.sessionId);
          if (!machineId || !sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.daemonMemoryGetWindow({
            machineId,
            sessionId,
            seqFrom: Number(data.seqFrom ?? 0),
            seqTo: Number(data.seqTo ?? 0),
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

        if (actionId === 'daemon.promptAssets.discover') {
          if (!deps.daemonPromptAssetsDiscover) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:daemon.promptAssets.discover' };
          }
          return completeActionResult(await deps.daemonPromptAssetsDiscover({
            request: parsed.data as Parameters<NonNullable<ActionExecutorDeps['daemonPromptAssetsDiscover']>>[0]['request'],
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'daemon.promptAssets.delete') {
          if (!deps.daemonPromptAssetsDelete) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:daemon.promptAssets.delete' };
          }
          return completeActionResult(await deps.daemonPromptAssetsDelete({
            request: parsed.data as Parameters<NonNullable<ActionExecutorDeps['daemonPromptAssetsDelete']>>[0]['request'],
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'daemon.promptRegistry.scanSource') {
          if (!deps.daemonPromptRegistryScanSource) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:daemon.promptRegistry.scanSource' };
          }
          return completeActionResult(await deps.daemonPromptRegistryScanSource({
            request: parsed.data as Parameters<NonNullable<ActionExecutorDeps['daemonPromptRegistryScanSource']>>[0]['request'],
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'daemon.promptRegistry.install') {
          if (!deps.daemonPromptRegistryInstall) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:daemon.promptRegistry.install' };
          }
          return completeActionResult(await deps.daemonPromptRegistryInstall({
            request: parsed.data as Parameters<NonNullable<ActionExecutorDeps['daemonPromptRegistryInstall']>>[0]['request'],
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'agents.acp.backends.upsert' || actionId === 'agents.acp.backends.delete') {
          if (!deps.updateAccountAcpCatalogSettings) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          // The catalog owner decides; the host only persists what it returns, so this and the
          // Settings editor store identical results.
          const settlement: { refusal?: Readonly<{ code: string; message: string }>; result?: unknown } = {};
          if (actionId === 'agents.acp.backends.upsert') {
            const parsed = AgentsAcpBackendsUpsertInputV1Schema.safeParse(data);
            if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            const nowMs = Date.now();
            const persisted = await deps.updateAccountAcpCatalogSettings({
              mutate: (current) => {
                const outcome = applyAcpBackendUpsertV1({ settings: current, backend: parsed.data.backend, nowMs });
                if (!outcome.ok) {
                  settlement.refusal = { code: outcome.code, message: outcome.message };
                  return current;
                }
                settlement.result = { backend: outcome.backend };
                return outcome.settings;
              },
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            if (settlement.refusal) return { ok: false, errorCode: settlement.refusal.code, error: settlement.refusal.message };
            if (!persisted.ok) return { ok: false, errorCode: persisted.errorCode, error: persisted.error };
            return { ok: true, result: settlement.result };
          }
          const parsed = AgentsAcpBackendsDeleteInputV1Schema.safeParse(data);
          if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const persisted = await deps.updateAccountAcpCatalogSettings({
            mutate: (current) => {
              const outcome = applyAcpBackendDeleteV1({ settings: current, backendId: parsed.data.backendId });
              if (!outcome.ok) {
                settlement.refusal = { code: outcome.code, message: outcome.code };
                return current;
              }
              settlement.result = { backendId: parsed.data.backendId, deleted: true };
              return outcome.settings;
            },
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (settlement.refusal) return { ok: false, errorCode: settlement.refusal.code, error: settlement.refusal.message };
          if (!persisted.ok) return { ok: false, errorCode: persisted.errorCode, error: persisted.error };
          return { ok: true, result: settlement.result };
        }

        if (actionId === 'prompt_doc.get') {
          if (!deps.promptDocGet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.get' };
          return completeActionResult(await deps.promptDocGet({
            artifactId: String(data.artifactId), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }));
        }

        if (actionId === 'prompt_doc.create') {
          if (!deps.promptDocCreate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.create' };
          return completeActionResult(await deps.promptDocCreate({ title: String(data.title), markdown: String(data.markdown),
            ...(typeof data.folderId === 'string' || data.folderId === null ? { folderId: data.folderId } : {}),
            ...(Array.isArray(data.tags) ? { tags: data.tags.filter((entry): entry is string => typeof entry === 'string') } : {}),
            ...(typeof data.favorite === 'boolean' ? { favorite: data.favorite } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'prompt_doc.favorite.set') {
          if (!deps.promptDocFavoriteSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.favorite.set' };
          return completeActionResult(await deps.promptDocFavoriteSet({ artifactId: String(data.artifactId), favorite: data.favorite === true,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'prompts.library.list') {
          if (!deps.promptsLibraryList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompts.library.list' };
          return completeActionResult(await deps.promptsLibraryList({ ...(typeof data.query === 'string' ? { query: data.query } : {}),
            ...(data.includeBundles === false ? { includeBundles: false } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'prompt_doc.update') {
          if (!deps.promptDocUpdate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.update' };
          }
          const artifactId = normalizeId(data.artifactId);
          const title = String(data.title ?? '').trim();
          if (!artifactId || !title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.promptDocUpdate({
            artifactId,
            title,
            markdown: String(data.markdown ?? ''),
            ...(Object.prototype.hasOwnProperty.call(data, 'folderId')
              ? { folderId: (data.folderId ?? null) as string | null }
              : {}),
            ...(Array.isArray(data.tags)
              ? { tags: (data.tags as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'prompt_bundle.update') {
          if (!deps.promptBundleUpdate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_bundle.update' };
          }
          const artifactId = normalizeId(data.artifactId);
          const title = String(data.title ?? '').trim();
          if (!artifactId || !title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.promptBundleUpdate({
            artifactId,
            title,
            skillMarkdown: String(data.skillMarkdown ?? ''),
            ...(Object.prototype.hasOwnProperty.call(data, 'folderId')
              ? { folderId: (data.folderId ?? null) as string | null }
              : {}),
            ...(Array.isArray(data.tags)
              ? { tags: (data.tags as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'prompt_asset.export') {
          if (!deps.promptAssetExport) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_asset.export' };
          }
          const artifactId = normalizeId(data.artifactId);
          const machineId = normalizeId(data.machineId);
          const assetTypeId = normalizeId(data.assetTypeId);
          const scope = data.scope === 'project' ? 'project' : data.scope === 'user' ? 'user' : null;
          if (!artifactId || !machineId || !assetTypeId || !scope) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.promptAssetExport({
            artifactId,
            machineId,
            assetTypeId,
            scope,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(typeof data.directory === 'string' && String(data.directory).trim().length > 0
              ? { directory: String(data.directory).trim() }
              : {}),
            ...(typeof data.targetPath === 'string' && String(data.targetPath).trim().length > 0
              ? { targetPath: String(data.targetPath).trim() }
              : {}),
            ...(typeof data.targetName === 'string' && String(data.targetName).trim().length > 0
              ? { targetName: String(data.targetName).trim() }
              : {}),
            ...(data.installMode === 'copy' || data.installMode === 'symlink'
              ? { installMode: data.installMode }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(res);
          if (failure) return failure;
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
          const installTargetRaw = data.installTarget;
          const installTargetRecord = readRecord(installTargetRaw);
          const installTargetScope = installTargetRecord.scope === 'project' || installTargetRecord.scope === 'user'
            ? installTargetRecord.scope
            : null;
          const installMode = installTargetRecord.installMode === 'copy' || installTargetRecord.installMode === 'symlink'
            ? installTargetRecord.installMode
            : undefined;
          const installTarget =
            typeof installTargetRecord.assetTypeId === 'string'
            && typeof installTargetRecord.targetName === 'string'
            && installTargetScope
              ? {
                  assetTypeId: installTargetRecord.assetTypeId,
                  scope: installTargetScope,
                  ...(typeof installTargetRecord.directory === 'string' && installTargetRecord.directory.trim().length > 0
                    ? { directory: installTargetRecord.directory.trim() }
                    : {}),
                  targetName: installTargetRecord.targetName,
                  ...(installMode ? { installMode } : {}),
                } satisfies NonNullable<Parameters<NonNullable<ActionExecutorDeps['promptRegistryInstall']>>[0]['installTarget']>
              : undefined;
          const res = await deps.promptRegistryInstall({
            machineId,
            sourceId,
            itemId,
            configuredSources: Array.isArray(data.configuredSources) ? data.configuredSources : [],
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(installTarget ? { installTarget } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(res);
          if (failure) return failure;
          return completeActionResult(res);
        }

      if (actionId === 'approval.request.list') {
        if (!deps.approvalsList) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const limitRaw = data.limit;
        const listed = await deps.approvalsList({
          status: readApprovalRequestStatus(data.status),
          limit: typeof limitRaw === 'number' ? limitRaw : null,
          serverId: normalizeId(ctx.serverId) || null,
        });
        return { ok: true, result: listed };
      }

      if (actionId === 'approval.request.get') {
        if (!deps.approvalsGet) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const artifactId = normalizeId(data.artifactId);
        if (!artifactId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };

        const request = await deps.approvalsGet({ artifactId, serverId: normalizeId(ctx.serverId) || null });
        if (!request) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
        return {
          ok: true,
          result: {
            artifactId,
            request,
            queryPlan: {
              kind: 'approval_artifact_id_lookup',
              backingStore: 'ArtifactStore',
              boundedBy: 'approval artifact id',
              hydratedTranscripts: false,
            },
          },
        };
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
        const approvalPluginCaller = projectApprovalRequestPluginCaller(ctx.actionCaller);
        if (ctx.actionCaller?.kind === 'plugin' && !approvalPluginCaller) {
          return { ok: false, errorCode: 'plugin_action_caller_required', error: 'plugin_action_caller_required' };
        }

        const rawCreatedBy = data.createdBy as ApprovalRequestV1['createdBy'];
        const forcedSurface = mapApprovalCreatedBySurface(ctx.surface ?? null);
        const actionArgsSessionId = normalizeId(readRecord(parsedTargetArgs.data).sessionId);
        const ctxDefaultSessionId = normalizeId(ctx.defaultSessionId);
        const targetSessionId = actionArgsSessionId || ctxDefaultSessionId || null;
        const rawApprovalOrigin = Object.prototype.hasOwnProperty.call(data, 'origin')
          ? data.origin
          : ctx.approvalOrigin;
        const requestSessionId = resolveExplicitApprovalRequestingSessionId(rawApprovalOrigin, ctx, targetSessionId);
        const approvalOrigin = resolveApprovalOriginForRequest(rawApprovalOrigin, requestSessionId);
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
        const summary = buildApprovalSummary(targetSpec, targetSessionId);

        const initialApprovalActionArgs = targetActionId === 'session.spawn_new'
          ? materializeSessionSpawnApprovalInput(parsedTargetArgs.data, ctx)
          : parsedTargetArgs.data;
        const preparedApproval = await prepareApprovalRequest({
          deps,
          actionId: targetActionId,
          input: parsedTargetArgs.data,
          actionArgs: initialApprovalActionArgs,
          context: ctx,
        });
        if (!preparedApproval) {
          const errorCode = ctx.signal?.aborted ? 'cancelled' : 'approval_context_unavailable';
          return { ok: false, errorCode, error: errorCode };
        }
        const approvalActionArgs = preparedApproval.actionArgs;
        const executionOriginV1 = buildApprovalExecutionOriginV1({
          actionId: targetActionId,
          input: approvalActionArgs,
          context: ctx,
          targetSessionId,
        });
        if (!executionOriginV1) {
          return { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' };
        }
        if (ctx.signal?.aborted) {
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        }
        const request: ApprovalRequestV2 = {
          v: 2,
          status: 'open',
          createdAtMs: now,
          updatedAtMs: now,
          createdBy,
          ...(requestedSurface ? { requestedSurface } : {}),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          executionOriginV1,
          approval: buildApprovalMetadata(targetSpec),
          actionId: targetActionId,
          actionArgs: approvalActionArgs,
          summary,
          preview: preparedApproval.preview,
        };
        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        return completeActionResult(res);
      }

      if (actionId === 'approval.request.decide') {
        const artifactId = normalizeId(data.artifactId);
        const decision = data.decision === 'approve' || data.decision === 'reject'
          ? data.decision
          : null;
        if (!artifactId || !decision) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }

        if (deps.targetActionApprovalReplay) {
          const replay = await deps.targetActionApprovalReplay({
            artifactId,
            decision,
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
        const existingRaw = await deps.approvalsGet({ artifactId, serverId: null });
        if (!existingRaw) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };

        const existingParsed = StoredApprovalRequestSchema.safeParse(existingRaw);
        if (!existingParsed.success) return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
        const existing = existingParsed.data;
        const editsComputerSelection = data.computerTarget !== undefined || data.computerAccess !== undefined;
        if (editsComputerSelection && (decision !== 'approve'
          || existing.actionId !== 'computer.target.select' || existing.status !== 'open')) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (editsComputerSelection && resolveHostStampedAuthority(ctx) !== 'present_user') {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        const requestedActionId = ActionIdSchema.safeParse(existing.actionId);
        if (requestedActionId.success
          && requiresPresentUserDecisionForActionInputV1(getActionSpec(requestedActionId.data), existing.actionArgs, decision)
          && resolveHostStampedAuthority(ctx) !== 'present_user') {
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
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
          || isInternalActionId(existing.actionId)
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const isRecoverableApproved = decision === 'approve'
          && existing.status === 'approved'
          && existing.decision?.kind === 'approve'
          && !existing.execution;

        if (decision === 'approve' && existing.v === 2 && existing.status === 'executing') {
          return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
        }

        if (decision === 'reject' && existing.status === 'rejected' && existing.decision?.kind === 'reject') {
          return buildApprovalDecisionResult(existing);
        }

        if (decision === 'approve'
          && (existing.status === 'approved' || existing.status === 'executed' || existing.status === 'failed')
          && existing.decision?.kind === 'approve'
          && !isRecoverableApproved) {
          return buildApprovalDecisionResult(existing);
        }

        if (existing.status !== 'open' && !isRecoverableApproved) {
          return { ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' };
        }

        const now = Date.now();

        if (decision === 'reject') {
          // Rejection is the other settlement, and a refused request has no
          // replay left either: it keeps the same observation projection the
          // executed/failed transition writes.
          const nextRejected: ApprovalRequest = {
            ...existing,
            status: 'rejected',
            updatedAtMs: now,
            actionArgs: settleApprovalRequestActionArgs(existing),
            decision: { kind: 'reject', decidedAtMs: now },
          };
          const updated = await deps.approvalsUpdate({ artifactId, request: nextRejected, serverId: effectiveServerId });
          const updateFailure = readActionFailureEnvelope(updated);
          if (updateFailure) return updateFailure;
          if (isBlockingApprovalRequest(nextRejected)) {
            await resolveBlockingDecisionIfClaimed({
              artifactId,
              decision: 'reject',
              decisionAuthority: resolveHostStampedAuthority(ctx),
              request: nextRejected,
              serverId: effectiveServerId,
            });
          }
          return buildApprovalDecisionResult(nextRejected);
        }

        let approvedRequest = existing;
        if (existing.status === 'open') {
          let approvedActionArgs = existing.actionArgs;
          if (editsComputerSelection) {
            const choice = ComputerTargetSelectRequestV1Schema.safeParse({
              ...readRecord(existing.actionArgs),
              ...(data.computerTarget !== undefined ? { target: data.computerTarget } : {}),
              ...(data.computerAccess !== undefined ? { access: data.computerAccess } : {}),
            });
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
            actionArgs: approvedActionArgs,
            status: 'approved',
            updatedAtMs: now,
            decision: { kind: 'approve', decidedAtMs: now,
              ...(editsComputerSelection ? { authority: 'present_user' as const } : {}) },
          };

          const approved = await deps.approvalsUpdate({
            artifactId,
            request: approvedRequest,
            serverId: effectiveServerId,
          });
          const approvalFailure = readActionFailureEnvelope(approved);
          if (approvalFailure) return approvalFailure;
        }

        let preExecutionFailure: ActionExecuteFailure | undefined;
        if (approveAdmission?.status === 'unavailable') {
          preExecutionFailure = approveAdmission.reason === 'legacy_request'
            ? { ok: false, errorCode: 'approval_stale', error: 'approval_stale' }
            : {
                ok: false,
                errorCode: 'approval_context_unavailable',
                error: 'approval_context_unavailable',
                details: approveAdmission.details,
              };
        } else if (approvedRequest.v === 2) {
          const originIsCurrent = await isApprovalExecutionOriginCurrentForRequest({
            request: approvedRequest,
            ...(normalizeId(data.originServerId)
              ? { expectedOriginServerId: normalizeId(data.originServerId) }
              : {}),
            ...(normalizeId(ctx.serverIdentityId) || normalizeId(data.serverIdentityId)
              ? { expectedServerIdentityId: normalizeId(ctx.serverIdentityId) || normalizeId(data.serverIdentityId) }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (!originIsCurrent) {
            preExecutionFailure = { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
          }
        }

        if (preExecutionFailure) {
          const failed = await executeApprovedActionForRequest({
            artifactId,
            request: approvedRequest,
            artifactServerId: effectiveServerId,
            ctx,
            preExecutionFailure,
          });
          return failed.ok ? buildApprovalDecisionResult(failed.request) : failed;
        }

        if (isBlockingApprovalRequest(approvedRequest)) {
          const claimed = await resolveBlockingDecisionIfClaimed({
            artifactId,
            decision: 'approve',
            decisionAuthority: resolveHostStampedAuthority(ctx),
            request: approvedRequest,
            serverId: effectiveServerId,
          });
          if (claimed) return buildApprovalDecisionResult(approvedRequest);
        }

        if (deps.approvalRequestApprovedReplay) {
          const replay = await deps.approvalRequestApprovedReplay({
            artifactId,
            request: approvedRequest,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (replay !== null) return replay;
        }

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
      }

      return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    } catch (error) {
      if (dispatchedPluginSessionInputLocalId !== null) {
        return {
          ok: true,
          result: {
            status: 'outcomeUnknown',
            localId: dispatchedPluginSessionInputLocalId,
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
        ? classifyExecutionRunStartFailure(failure, 'outcomeUnknown')
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
  ): Promise<ActionExecuteResult> {
    const result = await executeCore(
      actionId,
      input,
      context,
      inputAlreadyBound,
      legacyMetadataLabel,
      prepared ? { prepared } : undefined,
    );
    if ('kind' in result) {
      throw new Error('Prepared Action invocation unexpectedly prepared twice');
    }
    return settleActionOutput(actionId, result);
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

  const prepare = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
  ): Promise<ActionPrepareResult> => {
    const ctx = normalizeActionCallerContext(context ?? {});
    if (!ctx) return settlePrepareResult(actionId, {
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
    });
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
    const credentialFailure = credentialScopeFailure(actionId, ctx, actionId === 'session.spawn_new' ? undefined : input);
    if (credentialFailure) return settlePrepareResult(actionId, credentialFailure);
    if (ctx.surface === 'plugin' && ctx.actionCaller?.kind !== 'plugin') {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, {
        ok: false,
        errorCode: 'plugin_action_caller_required',
        error: 'plugin_action_caller_required',
      }));
    }
    if (ctx.bypassActionInterception || !deps.interceptActionExecution) {
      return settlePrepareResult(actionId, await executeCore(
        actionId,
        input,
        ctx,
        false,
        undefined,
        { prepareOnly: true },
      ));
    }

    const parsedInitialInput = callerInputSchema(spec, ctx).safeParse(input ?? {});
    if (!parsedInitialInput.success) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
      ));
    }
    const initialCurrentSessionScopeFailure = await resolveActionCurrentSessionScopeFailure(
      actionId,
      parsedInitialInput.data,
      ctx,
      spec.contextualDefaults,
      deps,
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

    const parsedTransformedInput = callerInputSchema(spec, ctx).safeParse(intercepted.input);
    if (!parsedTransformedInput.success) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
      ));
    }

    const bound = await bindCallerInput(spec, parsedTransformedInput.data, ctx);
    if (!bound.ok) return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(actionId, bound));
    const parsedSemanticInput = spec.inputSchema.safeParse(bound.input);
    if (!parsedSemanticInput.success) {
      return settlePrepareResult(actionId, classifyExecutionRunStartPreDispatchFailure(
        actionId,
        { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
      ));
    }

    const prepared = settlePrepareResult(actionId, await executeCore(
      actionId,
      parsedSemanticInput.data,
      ctx,
      true,
      undefined,
      { prepareOnly: true },
    ));
    const observeResult = async (result: ActionExecuteResult): Promise<void> => {
      try {
        const observedInput = spec.projectObservationInput
          ? spec.projectObservationInput(parsedSemanticInput.data)
          : parsedSemanticInput.data;
        await deps.observeActionExecution?.({
          actionId,
          input: observedInput,
          context: ctx,
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
      invocation: createOneShotInvocation(async () => {
        const result = await prepared.invocation.run();
        await observeResult(result);
        return result;
      }),
    };
  };

  const execute = async (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
  ): Promise<ActionExecuteResult> => {
    const prepared = await prepare(actionId, input, context);
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

  return {
    prepare,
    execute,
    replayApprovedApprovalRequest,
  };
}
