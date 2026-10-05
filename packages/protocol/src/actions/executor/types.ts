import type { SessionFollowActionIdV1 } from '../../sessions/follow/actions.js';
import type { SessionWorkerPublishInputV1 } from '../../sessions/relations/workerUpdateV1.js';
import type { AgentStartContextV1, AgentStartSessionCallerV1 } from '../../account/settings/admitAgentStartV1.js';
import type { HomeHubLayoutActionId } from '../specs/homeHub.js';
import type { HomeHubArtifactPortV1 } from '../../home/homeHubArtifactV1.js';
import type { WidgetActionSurfacePortV1, WidgetActionInputResolverV1, WidgetCatalogEntryV1, WidgetInstanceActionIdV1 } from '../../widgets/actionsV1.js';
import type { WidgetInstanceRefV1, WidgetSurfaceRefV1 } from '../../widgets/widgetInstanceV1.js';
import type { WidgetDefinitionActionDepsV1 } from '../../widgets/definitionActionsV1.js';
import type { MachinesAgentsSignInStartInput, MachinesAgentsSignInStatusInput, MachinesAgentsSignInStartOutput, AgentSignInStatusResponse, MachinesAgentsSignInCancelInput, MachinesAgentsSignInCancelOutput } from '../../daemon/agentSignIn.js';
import type { z } from 'zod';
import type { MachineAddSshActionId } from '../specs/machineConnection.js';
import type { DaemonTerminalEnsureResponse, DaemonTerminalListResponseV1 } from '../../daemon/terminal.js';
import type { HomeConnectInputSchema, HomeConnectOutputSchema, MachineAddCommandInputSchema, MachineAddCommandOutputSchema, MachinePairingCreateInputSchema, MachinePairingCreateOutputSchema, MachineTerminalOpenInputSchema, MachineTerminalListInputSchema } from '../specs/machineConnection.js';
import type {
  DaemonAgentInstallStartRequest, DaemonAgentInstallStartResponse,
  DaemonAgentInstallReadRequest, DaemonAgentInstallReadResponse,
  DaemonAgentInstallCancelRequest, DaemonAgentInstallCancelResponse,
} from '../../daemon/agentInstallJobs.js';
import type { RoleActionIdV1 } from '../../prompts/roles/roleActionIdsV1.js';
import type { WorkBoardArtifactPortV1 } from '../../boards/workBoardArtifactV1.js';
import type { TodoSessionLinkOutputV1 } from '../../todos/todoSessionLinkV1.js';
import type { ArtifactAccessActionIdV1 } from '../../artifacts/artifactAccessV1.js';
import type { ArtifactActionIdV1 } from '../../artifacts/artifactActionsV1.js';
import type { SessionRoleConfigurationV1, SessionRolesV1 } from '../../prompts/roles/sessionRolesSnapshot.js';
import type { ExecutionRunSendRequest, ExecutionRunCancelTurnRequest } from '../../execution/runs/index.js';
import type { ActionsSettingsV1 } from '../actionSettings.js';
import type { ScopeActionId } from '../scopeActionFamily.js';
import type {
  NotificationsNotifyMeInputV1,
  NotificationsNotifyMeResultV1,
} from '../../account/notifications/notifyMeV1.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actionExecutionResult.js';
import type { ApiTokenGrantV1, CallerInputConstraintsV1 } from '../../auth/apiTokenGrant.js';
import type { SessionPermissionRespondActionDecisionV1, SessionPermissionRespondRpcParamsV1 } from '../../sessions/permissions/respondRpcParamsV1.js';
import type { AgentsBackendsListOutput } from '../agentBackendInventory.js';
import type { MachinesAgentsListInput, MachinesAgentsListOutput } from '../../capabilities/machineAgentInventory.js';
import type { DaemonWorkspaceFileSearchResponse } from '../../machines/workspaceFiles.js';
import type {
  ActionId,
  PluginDevLoopActionIdV1,
  RuntimeActionIdV1,
  SessionAccessActionId,
} from '../actionIds.js';
import type {
  ActionRequiredAuthority,
  ActionSurfaces,
  PublicActionInputById,
  ExecutionRunPermissionRespondActionInput,
  PUBLIC_ACTION_INPUT_SCHEMAS,
  SessionTranscriptGetResult,
} from '../actionSpecs.js';
import type { HomeDomainActionIdV1 } from '../homeDomainActionFamily.js';
import type { WorkspaceActionId } from '../workspaceActionFamily.js';
import type { SessionCanvasActionId } from '../sessionCanvasActionFamily.js';
import type { SessionTerminalActionId } from '../sessionTerminalActionFamily.js';
import type { ConnectedServiceConfigurationActionIdV1 } from '../../connect/configurationActionsV1.js';
import type { SettingsDeclarationActionIdV1 } from '../settingsDeclarationActionFamily.js';
import type { VoiceConversationActionId } from '../voiceConversationActionFamily.js';
import type { AppShellActionId } from '../appShellActionFamily.js';
import type { NotificationConfigurationActionId } from '../notificationConfigurationActionFamily.js';
import type { AppUpdateActionId } from '../appUpdateActionFamily.js';
import type { ActionUiPlacement } from '../actionUiPlacements.js';
import type { ActionDefinitionSummaryV1 } from '../actionDefinitionV1.js';
import type { ExternalActionTargetV1, ExternalActionExecutionAuthorizationV1 } from '../externalActionApi.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../../memory/memoryWindow.js';
import type {
  ApprovalExecutionOriginV1,
  ApprovalRequest,
  ApprovalRequestOriginV1,
} from '../../approvals/approvalRequestV1.js';
import type { PluginSourceCustodyV1 } from '../../plugins/runtime/sourceCustody.js';
import type {
  PromptRegistryConfiguredSourceV1,
  PromptRegistryInstallRequestV1,
  PromptRegistryScanSourceRequestV1,
} from '../../prompts/library/promptRegistriesV1.js';
import type {
  PromptAssetDeleteRequest,
  PromptAssetDiscoverRequest,
} from '../../prompts/library/promptAssetsV1.js';
import type { ProviderConnectionId } from '../../providers/ids.js';
import type { SessionBoardActionIdV1 } from '../../sessions/board/actionIds.js';
import type { SessionBoardActionPortResultV1 } from '../../sessions/board/actions.js';
import type { SessionReadStateActionIdV1 } from '../../sessions/readState/actionIds.js';
import type { CurrentSessionPresentationActionInputV1 } from '../../sessions/presentation/currentSessionPresentationV1.js';
import type { SessionDiscussionActionIdV1 } from '../../sessions/discussions/actionIds.js';
import type { SessionRollbackTarget } from '../../sessions/rollback.js';
import type { SessionListQueryV1 } from '../../sessions/listing/query.js';
import type { SessionReportsToSetActionInputV1, SessionReportsToSetResultV1 } from '../../sessions/relations/sessionReportsToV1.js';
import type { SessionListViewV1 } from '../../sessions/awareness/action.js';
import type { WaitActionInputV1, WaitOwnerResultV1 } from '../specs/wait.js';
import type { WaitOwnerOptionsV1 } from './waitAction.js';
import type { ReviewCommentActionIdV1 } from '../../reviews/comments/actions.js';
import type { ReviewCommentPrincipalHeaderV1 } from '../../reviews/comments/actions.js';
import type {
  SubagentLifecycleDetailV1,
  SubagentRefInputV1,
  SubagentStatusV1,
} from '../../sessions/subagents/subagentRefV1.js';
import type {
  SessionHandoffAbortRequest,
  SessionHandoffCommitRequest,
  SessionHandoffPrepareTargetRequest,
  SessionHandoffPrepareTargetResumeRequest,
  SessionHandoffPrepareTargetResultGetRequest,
  SessionHandoffStatusGetRequest,
} from '../../sessions/control/handoff/handoffSchemas.js';
import type { HandoffWorkspaceActionV1 } from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import type {
  WorkspaceSyncConflictResolveActionInputV1,
  WorkspaceSyncConflictsListActionInputV1,
  WorkspaceSyncConflictInspectActionInputV1,
  WorkspaceSyncConflictInspectActionOutputV1,
  WorkspaceSyncConflictPageV1,
  WorkspaceSyncRelationshipsListActionInputV1,
  WorkspaceSyncRelationshipsListActionOutputV1,
  WorkspaceSyncRelationshipCreateActionInputV1,
  WorkspaceSyncRelationshipCreateResultV1,
  WorkspaceSyncConflictResolutionResultV1,
} from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import type { HandoffTargetReplacementApprovalV1 } from '../../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import type { SessionContinueWithReplayRpcParams } from '../../sessions/continueWithReplay.js';
import type { SessionForkRpcParams } from '../../sessions/fork.js';
import type {
  PluginSessionInputAttachmentV1,
  PluginSessionInputSourceV1,
  SessionInputCausalPermissionAuthorityV1,
} from '../../sessions/messages/sessionInputAdmission.js';
import type { PendingRequestedActionV1 } from '../../sessions/pending/pendingRequestedActionV1.js';
import type { ParticipantRecipientRoutingIdentityV1 } from '../../messages/structured/participantMessageV1.js';
import type {
  CheckpointCodeRollbackRequest,
  CheckpointCodeRollbackResult,
} from '../../sessions/control/rollback/checkpointCodeRollback.js';
import type {
  SessionCheckpointRequestV1,
  SessionCheckpointResultV1,
  SessionRestoreRequestV1,
  SessionRestoreResultV1,
} from '../../sessions/control/checkpoints/v1.js';
import type {
  PluginPermissionGrantDismissRequestActionInputV1,
  PluginPermissionGrantGrantActionInputV1,
  PluginPermissionGrantListActionInputV1,
  PluginPermissionGrantRequestActionInputV1,
  PluginPermissionGrantRevokeActionInputV1,
} from '../../plugins/permissions/grants.js';
import type {
  PluginWebhookActionIdV1,
  PluginWebhookDeliveryMovePendingInputV1,
  PluginWebhookEndpointCheckCorrespondenceInputV1,
  PluginWebhookEndpointCredentialConfigureInputV1,
  PluginWebhookEndpointCredentialFinishRotationInputV1,
  PluginWebhookEndpointCredentialRotateInputV1,
  PluginWebhookEndpointEnsureInputV1,
  PluginWebhookEndpointReadInputV1,
  PluginWebhookEndpointRetargetInputV1,
  PluginWebhookEndpointRevokeInputV1,
} from '../../plugins/webhooks/endpointV1.js';
import type {
  AutomationConversationActionIdV1,
  AutomationConversationAdmitInputV1,
  AutomationConversationTargetVerifyInputV1,
  AutomationConversationTargetsListInputV1,
  AutomationEventActionIdV1,
  AutomationEventAdmitInputV1,
  AutomationEventSourceStatusReportV1,
  AutomationEventSourcesListInputV1,
} from '../../automations/automationEventV1.js';
import type {
  PluginSessionHookInstallActionInputV1,
  PluginSessionHookInstallationMutationActionInputV1,
  PluginSessionHookStatusActionInputV1,
} from '../../sessions/external/hookManagementV1.js';
import type {
  SessionPermissionRemoteGrantRevokeInputV1,
  SessionPermissionRemoteGrantsListInputV1,
  SessionPermissionRemotePendingListInputV1,
  SessionPermissionRemoteRespondInputV1,
  SessionUserActionRemoteAnswerInputV1,
} from '../../sessions/permissions/v1.js';
import type {
  SessionSpawnNewInputV2,
} from '../../sessions/creation/sessionSpawnNewInputV2.js';
import type { SessionCreateOriginFieldsV1 } from '../../sessions/creation/sessionCreateOriginV1.js';
import type {
  SessionCreationDirectoryApprovalV1,
} from '../../sessions/creation/sessionCreationTargetPreparationV1.js';
import type {
  SessionSpawnNewResultV1,
} from '../../sessions/creation/sessionSpawnNewResultV1.js';
import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';
import type {
  SessionCreationTagV1,
} from '../../sessions/creation/sessionCreationIdentityV1.js';
import type {
  PluginAccountDataEraseActionInputV1,
  PluginAccountDataEraseActionOutputV1,
} from '../../plugins/data/accountEraseV1.js';
import type {
  AccountSessionsSignOutEverywhereActionInputV1,
  AccountSessionsSignOutEverywhereActionOutputV1,
} from '../../auth/accountSessions.js';
import type {
  AccountApiTokensCreateActionInputV1,
  AccountApiTokensUpdateActionInputV1,
  AccountApiTokensUpdateActionOutputV1,
  AccountApiTokensCreateActionOutputV1,
  AccountApiTokensListActionInputV1,
  AccountApiTokensListActionOutputV1,
  AccountApiTokensRevokeActionInputV1,
  AccountApiTokensRevokeActionOutputV1,
  AccountApiTokensRevokeAllActionInputV1,
  AccountApiTokensRevokeAllActionOutputV1,
} from '../../auth/accountApiTokens.js';
import type {
  AccountEmailChangeRequestV1,
  AccountEmailChangeRequestResponseV1,
  AccountPasswordChangeRequestV1,
  AccountPasswordEnrollRequestV1,
  AccountPasswordMutationResponseV1,
  AccountPasswordRemoveRequestV1,
  AccountSecurityGetResponseV1,
  AccountTerminalPresentUserPolicySetRequestV1,
  AccountTerminalPresentUserPolicySetResponseV1,
} from '../../auth/accountSecurity.js';
import type { AccountHistoricalEncryptionKeyForgetResultV1, AccountEncryptionAutomationTemplatesRecoverResultV1 } from '../../auth/accountSecurity.js';
import type { PluginMachineMaterializationRefV1 } from '../../plugins/availability/materializationRefV1.js';
import type { PluginSettingsAdministrationActionIdV1 } from '../../plugins/settingsAdministration.js';
import type { AutomationRunCause } from '../../automations/automationRunCause.js';
import type { MachinePoolActionIdV1, MachinePoolActionInputV1 } from '../../machines/pools/actionsV1.js';
import type { EphemeralRunnerActionIdV1 } from '../../ephemeralRunner/actionIdsV1.js';
import type {
  WorkflowActionInputSchemasV1,
  WorkflowActionOutputSchemasV1,
} from '../../workflows/actionsV1.js';
import type { WorkflowAcceptedAuthorizationV1, WorkflowRunStartedByV1 } from '../../workflows/workflowDefinitionV1.js';
import type { WorkflowActionFailureV1 } from '../../workflows/workflowProgressV1.js';
import type { WorkflowActionIdV1 } from '../actionIds.js';

export type {
  ActionExecuteFailure,
  ActionExecuteResult,
} from '../actionExecutionResult.js';

export type ActionPreparedInvocation = Readonly<{
  run: () => Promise<ActionExecuteResult>;
}>;

/**
 * Exact host-local routing identity for a Session Action dependency.
 *
 * This is not Action input or a Home-local wire identity: the host resolves a
 * natural reference against its authoritative selected corpus, then carries
 * the resulting tuple to the mutation/navigation owner without re-inferring a
 * Home from focus.
 */
export type ActionSessionAddress = Readonly<{
  serverId: string;
  sessionId: string;
}>;

export type ActionSessionReferenceResolution =
  | Readonly<{ kind: 'unique'; address: ActionSessionAddress }>
  | Readonly<{ kind: 'ambiguous'; candidates: readonly ActionSessionAddress[] }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'incomplete' }>;

export type ActionPrepareResult =
  | Readonly<{ kind: 'ready'; invocation: ActionPreparedInvocation }>
  | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>;

export type RuntimeActionExecutionFamily =
  | 'computer'
  | 'browser'
  | 'localServices'
  | 'peerMediation'
  | 'devices.simulator';

export type RuntimeActionDisabledReason = 'runtime_family_unimplemented';

export type ScmActionId = Extract<ActionId, `scm.${string}`>;

export type ScmActionExecute = (args: Readonly<{
  actionId: ScmActionId;
  input: unknown;
  context: ActionExecutorContext;
  /**
   * Re-enter the exact current Action boundary for SCM's source reads and run
   * admission. This carries the original host-stamped context; it is not a
   * second dispatcher, Session adapter, or execution-run service.
   */
  executeCanonicalAction: (
    actionId: Extract<ActionId, 'execution.run.start' | 'execution.run.get' | 'session.message.send' | 'action.invoke'>,
    input: unknown,
    options?: Readonly<{ requiredContributedActionDangerLevel?: 'safe' }>,
  ) => Promise<ActionExecuteResult>;
}>) => Promise<unknown>;

/**
 * Host-stamped provenance for a plugin caller of a canonical Action.
 *
 * `contributionLocalId` is optional exclusively for pre-provenance in-process
 * callers. It is never accepted from Action input and must not be invented by
 * downstream consumers when absent.
 */
export type ActionPluginCaller = Readonly<{
  kind: 'plugin';
  pluginId: string;
  contributionLocalId?: string;
  /** Exact host-stamped process-local plugin occurrence. */
  occurrenceId?: string;
  /** Durable source custody for owners that freeze replay provenance. */
  sourceCustody?: PluginSourceCustodyV1;
  /**
   * Exact host-stamped materialization for a live plugin Action edge. Durable
   * approval replay carries only the persisted plugin/contribution identity;
   * it never persists or substitutes a materialization reference.
   */
  materialization?: PluginMachineMaterializationRefV1;
  /** Descriptive host-stamped initiating provenance; never plugin authorization or Action input. */
  initiatingCaller?: ActionCaller;
  /** Bounded admitting starter frozen for durable approval replay; never authorization. */
  startedBy?: WorkflowRunStartedByV1;
}>;

/**
 * Closed host-stamped provenance for one Automation Run. It is never Action
 * input: only the Automation/Session transport owner can attach it to an
 * existing Action execution context.
 */
export type ActionAutomationRunCaller = Readonly<{
  kind: 'automationRun';
  runId: string;
  automationId: string;
  /** Exact immutable provenance frozen by canonical Run admission. */
  cause: AutomationRunCause;
}>;

/**
 * Closed host-stamped provenance for an admitted Workflow Run. The binding is
 * private Run content and can only be attached by the daemon after opening the
 * exact accepted envelope; neither Workflow nor nested Action input carries it.
 */
export type ActionWorkflowRunCaller = Readonly<{
  kind: 'workflowRun';
  runId: string;
  authorization: WorkflowAcceptedAuthorizationV1;
}>;

export type ActionCaller =
  | Readonly<{ kind: 'host' }>
  /** Host-stamped authenticated Session agent; never supplied as Action input. */
  | AgentStartSessionCallerV1
  | ActionPluginCaller
  | ActionAutomationRunCaller
  | ActionWorkflowRunCaller;

/**
 * Narrow host adapter seam for the existing committed-runtime contributed
 * Action invoker. Selection/currentness/cancellation remain with that owner;
 * the canonical ActionExecutor only validates and admits `action.invoke`.
 */
export type InvokeContributedAction = (request: Readonly<{
  action: import('../../plugins/contributionIdentity.js').PluginContributionIdentityV1;
  input: unknown;
  context: ActionExecutorContext;
  approvalExecutionOrigin?: ApprovalExecutionOriginV1;
  /** Host-only source-read constraint, enforced against the leased manifest. */
  requiredDangerLevel?: 'safe';
  signal?: AbortSignal;

}>) => Promise<ActionExecuteResult>;

/**
 * One canonical host-authenticated webhook endpoint operation. The Action
 * executor validates the exact input schema for `actionId` before this crosses
 * into the webhook endpoint owner.
 */
export type PluginWebhookActionArgs = Readonly<{
  actionId: PluginWebhookActionIdV1;
  input:
    | PluginWebhookEndpointEnsureInputV1
    | PluginWebhookEndpointReadInputV1
    | PluginWebhookEndpointRevokeInputV1
    | PluginWebhookEndpointRetargetInputV1
    | PluginWebhookEndpointCheckCorrespondenceInputV1
    | PluginWebhookDeliveryMovePendingInputV1
    | PluginWebhookEndpointCredentialConfigureInputV1
    | PluginWebhookEndpointCredentialRotateInputV1
    | PluginWebhookEndpointCredentialFinishRotationInputV1;
  caller: NonNullable<ActionExecutorContext['actionCaller']>;
  signal?: AbortSignal;
}>;

export type AutomationEventActionArgs = Readonly<{
  actionId: AutomationEventActionIdV1;
  input:
    | AutomationEventSourcesListInputV1
    | AutomationEventAdmitInputV1
    | AutomationEventSourceStatusReportV1;
  caller: ActionPluginCaller;
  signal?: AbortSignal;
}>;

/**
 * Canonical Automation conversation boundary. The host stamps the plugin
 * caller; the Action declaration selects the permitted plugin caller and the
 * Automation owner verifies current materialization for target reads and
 * occurrence admission.
 */
export type AutomationConversationActionArgs = Readonly<{
  actionId: AutomationConversationActionIdV1;
  input:
    | AutomationConversationTargetsListInputV1
    | AutomationConversationTargetVerifyInputV1
    | AutomationConversationAdmitInputV1;
  caller: ActionPluginCaller;
  signal?: AbortSignal;
}>;

export type SessionPermissionRemoteActionId =
  | 'session.permission.remote.pending.list'
  | 'session.permission.remote.respond'
  | 'session.user_action.remote.answer'
  | 'session.permission.remote.grants.list'
  | 'session.permission.remote.grants.revoke';

export type SessionPermissionRemoteActionArgs =
  | Readonly<{
      actionId: 'session.permission.remote.pending.list';
      input: SessionPermissionRemotePendingListInputV1;
      caller: ActionCaller;
      serverId?: string | null;
      signal?: AbortSignal;
    }>
  | Readonly<{
      actionId: 'session.permission.remote.respond';
      input: SessionPermissionRemoteRespondInputV1;
      caller: ActionCaller;
      serverId?: string | null;
      signal?: AbortSignal;
    }>
  | Readonly<{
      actionId: 'session.user_action.remote.answer';
      input: SessionUserActionRemoteAnswerInputV1;
      caller: ActionCaller;
      serverId?: string | null;
      signal?: AbortSignal;
    }>
  | Readonly<{
      actionId: 'session.permission.remote.grants.list';
      input: SessionPermissionRemoteGrantsListInputV1;
      caller: ActionCaller;
      serverId?: string | null;
      signal?: AbortSignal;
    }>
  | Readonly<{
      actionId: 'session.permission.remote.grants.revoke';
      input: SessionPermissionRemoteGrantRevokeInputV1;
      caller: ActionCaller;
      serverId?: string | null;
      signal?: AbortSignal;
    }>;

export type ActionExecutorContext = Readonly<{
  /** Host-validated readable page context; supplies no execution or storage authority. Never decoded from Action input. */
  widgetAreaContext?: Readonly<{ surface: WidgetSurfaceRefV1; values: Readonly<Record<string, readonly import('../../json/strictJsonValue.js').JsonValue[]>> }>;
  /** Effective host-stamped role policy; never accepted from Action input. */
  workspaceWrites?: 'allow' | 'deny';
  /** Host-only nested source-read constraint; never accepted from Action input. */
  requiredContributedActionDangerLevel?: 'safe';
  /** Host-only current occurrence from contributed Action transport admission. */
  expectedContributedActionOccurrenceId?: string;
  /**
   * Host-only Session corpus admission. For autonomous callers,
   * `current_session` also bounds Actions that declare a current-Session
   * contextual `sessionId`; it is never Action input or an Account-wide grant.
   */
  sessionListAccess?: 'current_session' | 'led_subtree' | 'unavailable';

  /**
   * Stable cryptographic Home identity observed by the host for this exact
   * connection. `serverId` remains the device-local profile/routing key; this
   * identity is the portable binding used by V2 approval artifacts.
   */
  serverIdentityId?: string;

  /** Caller cancellation for execution and interception. */
  signal?: AbortSignal;

  /** Host-only passive observation sink, never serialized as Action input. */
  onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
  /** Host-only issuance witness for callers retaining uncertain mutation custody. */
  onTransportIssued?: () => void;

  /** Host-stamped caller identity. Never accepted from plugin action input. */
  actionCaller?: ActionCaller;

  /**
   * Host-stamped admission authority. Public ingress must set this explicitly;
   * it is never Action input and never inferred from a client-provided surface.
   */
  authority?: ActionRequiredAuthority;

  /**
   * Exact dangerous Action whose direct-surface present-user confirmation has
   * already completed in the invoking host. This is host context, never
   * Action input, and only suppresses the default duplicate confirmation for
   * the same Action id. Persisted explicit approval requirements still win.
   */
  presentUserConfirmation?: Readonly<{ actionId: ActionId }>;

  /**
   * Verified public-API credential provenance, stamped only after bearer
   * authentication. It is never accepted from Action input or persisted as an
   * Action-owned identity.
   */
  externalActionCredential?: Readonly<{
    accountId: string;
    principalId: string;
    credentialId: string;
    grant: ApiTokenGrantV1;
  }>;
  /** Home-issued authorization, usable only with the exact Machine's request signature. */
  externalActionExecutionAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Process-local Machine signer; capture signs only the canonical stored approval input. */
  signExternalActionApprovalInput?: (input: Readonly<{
    actionId: ActionId; input: unknown; target: ExternalActionTargetV1; authorization: ExternalActionExecutionAuthorizationV1;
  }>) => string;

  /** Host-stamped runtime Account principal for durable approval origin capture. */
  runtimeAccountId?: string;
  /** Exact current runtime occurrence, when the admitted Action is Run-bound. */
  runtimeRunId?: string;
  runtimeRunOccurrenceId?: string;

  /**
   * Resolved public-API routing target. This stays transport metadata rather
   * than becoming Action input or a second placement decision maker.
   */
  externalActionTarget?: ExternalActionTargetV1;

  /**
   * Disables interception for the one action execution nested directly inside
   * a hook handler. This advisory depth-one bypass is host-owned.
   */
  bypassActionInterception?: boolean;

  /**
   * Used when ActionSpec input permits an optional sessionId and the caller
   * wants to default to a current/active session.
   */
  defaultSessionId?: string | null;

  /** Exact machine associated with the current session for declared contextual Action inputs. */
  defaultSessionMachineId?: string | null;

  /**
   * Exact machine admitted by a mounted host for a detached execution run.
   * This is host context rather than Action input, so an Action caller cannot
   * retarget an admitted invocation. The execution-run V2 preflight owns the
   * final exact machine selection used for dispatch.
   */
  executionRunTargetMachineId?: string | null;

  /** Host-resolved caller, baseline and roles; never accepted from Action input. */
  agentStartContext?: AgentStartContextV1;
  /** Live lead Session configuration stamped by its host, never Action input. */
  sessionRoleConfiguration?: SessionRoleConfigurationV1;
  /** Admission output retained only within this executor invocation/replay. */
  agentStartWorkDepth?: number;
  /** Canonical selected child role ceiling, not an Action request field. */
  agentStartWorkspaceWrites?: 'allow' | 'deny';

  /**
   * Opaque host-private permission-store binding for an in-process detached
   * Run launch. It is never Action input, serialized, or transported over RPC;
   * the owning host validates the concrete store interface before use.
   */
  executionRunPermissionRequestStore?: unknown;

  /**
   * Opaque host-private exact Workflow observation sink for an in-process
   * detached Run invocation. It is never Action input or RPC wire content.
   */
  executionRunWorkflowObservationSink?: unknown;
  /** Host-private admitted Workflow identity, not caller Action input. */
  executionRunWorkflowRunId?: string;

  /**
   * Optional explicit server routing hint. When omitted, deps may resolve serverId
   * from local caches given a sessionId.
   */
  serverId?: string | null;

  /**
   * Invocation surface (UI / voice / MCP / CLI). Used for fail-closed per-surface gating.
   */
  surface?: keyof ActionSurfaces | null;

  /**
   * Host-stamped authority for the currently active admitted Session turn.
   * This is Action execution context only: public Action/RPC input must never
   * carry it. `null` represents an agent invocation with no current causal
   * turn and is non-authorizing.
   */
  causalPermissionAuthority?: unknown;

  /**
   * Host-stamped source Session/turn for an Agent-originated Session input.
   * This is execution context only and is never accepted from Action input.
   */
  sessionInputSource?: unknown;

  /**
   * UI placement hint (session header, command palette, etc). Used for fail-closed
   * placement gating when desired.
   */
  placement?: ActionUiPlacement | null;

  /**
   * Internal escape hatch used when executing an action *because it has already been approved*.
   *
   * When true, the executor will still enforce surface/placement enablement, but it will not
   * route the underlying action through the approvals queue again. This prevents nested
   * approvals (and recursion) when `approval.request.decide` executes an approved action
   * on the same surface that originally required approvals.
   */
  bypassApprovals?: boolean;

  /** Host-derived review author identity for canonical review-comment dispatch. */
  reviewCommentPrincipal?: ReviewCommentPrincipalHeaderV1 | null;

  /**
   * Optional provenance for approvals created from an in-transcript tool call.
   *
   * The executor validates and session-scopes this before persisting it so
   * unrelated surfaces cannot attach misleading transcript links.
   */
  approvalOrigin?: ApprovalRequestOriginV1 | null;

  /**
   * Exact target-path evidence recovered only from an approved
   * `session.spawn_new` artifact. Public Action input never carries it.
   */
  sessionCreationDirectoryApproval?: SessionCreationDirectoryApprovalV1 | null;

  /** Exact host-only non-empty handoff target proof recovered from approval. */
  handoffTargetReplacementApproval?: HandoffTargetReplacementApprovalV1 | null;

  /** Durable approval artifact identity; distinct from the original Action request identity. */
  handoffTargetReplacementApprovalReceiptId?: string | null;

  /**
   * Current caller permission mode/intent. Used only for agent-surface
   * non-escalation; missing values fail closed to the default ordinal.
   */
  callerPermissionMode?: string | null;

  /**
   * Account-scoped policy for agent-surface child-session creation. Kept opaque
   * here so protocol does not own account-settings lookup.
   */
  sessionAgentSpawnPolicyV1?: unknown;

  /**
   * Live action settings for this invocation. Passing the concrete settings lets
   * execute-time availability report the same disabled reason as spec discovery.
   */
  actionsSettings?: ActionsSettingsV1 | null;

  /** Stable identity for one externally retryable action invocation. */
  actionRequestId?: string | null;

  /** Resolve the existing action attempt without repeating its outward write. */
  resumeActionRequest?: boolean;
}>;

export type RuntimeActionInputById = Readonly<{
  [K in RuntimeActionIdV1]: unknown;
}>;

export type RuntimeActionResultById = Readonly<{
  [K in RuntimeActionIdV1]: unknown;
}>;

// NOTE: `RuntimeActionInputById`/`RuntimeActionResultById` map every id to `unknown`,
// so they add no static narrowing (id→input/result typing is tracked as follow-up debt).
// We therefore type `input` as plain `unknown` and keep `RuntimeActionExecuteArgs`
// NON-distributed. A distributed mapped union broke assignability at every family
// executor call site (a generic `TActionId` produced an indexed-access type that no
// longer matched the union). Keeping `TActionId` on `actionId` preserves the id union
// for call sites that narrow it at runtime.
export type RuntimeActionExecuteArgsFor<TActionId extends RuntimeActionIdV1 = RuntimeActionIdV1> =
  Readonly<{
    actionId: TActionId;
    input: unknown;
    context: ActionExecutorContext;
  }>;

export type RuntimeActionExecuteArgs = RuntimeActionExecuteArgsFor<RuntimeActionIdV1>;

export type RuntimeActionExecute = (args: RuntimeActionExecuteArgs) => Promise<unknown>;

/**
 * Plugin-provenance External Session Action family. The low-level ephemeral
 * viewer-lease ids (`sessions.external.follow`/`unfollow`) are excluded from
 * the plugin projection by the canonical owner
 * (`PLUGIN_SURFACE_EXCLUSION_REASONS`) and therefore stay off this union;
 * `HostExternalSessionActionId` below retains their host route.
 */
export type PluginExternalSessionActionId =
  | 'sessions.external.materialize.start'
  | 'sessions.external.status.get'
  | 'sessions.external.operation.status.get'
  | 'sessions.external.operation.cancel'
  | 'sessions.external.operation.resume'
  | 'sessions.external.operation.retry'
  | 'sessions.external.operation.discard'
  | 'sessions.external.backgroundFollow.set';

/**
 * User-facing External Session operations owned by the daemon's fenced host
 * adapter. This intentionally extends, but does not replace, the narrower
 * plugin-provenance Action family: API callers never manufacture a plugin
 * identity merely to reach discovery, linking, transcript, or takeover Start.
 * The ephemeral viewer-lease ids are listed here explicitly so the released
 * host RPC/API route survives their plugin-projection exclusion.
 */
export type HostExternalSessionActionId =
  | PluginExternalSessionActionId
  | 'sessions.external.follow'
  | 'sessions.external.unfollow'
  | 'sessions.external.candidates.list'
  | 'sessions.external.candidate.delete'
  | 'sessions.external.link.ensure'
  | 'sessions.external.transcript.page'
  | 'sessions.external.transcript.readAfter'
  | 'sessions.external.takeover.start';

export type RuntimeActionDispatchArgs<TActionId extends RuntimeActionIdV1 = RuntimeActionIdV1> =
  RuntimeActionExecuteArgsFor<TActionId> & Readonly<{
    runtimeActionExecute: RuntimeActionExecute;
  }>;

export type ApprovalQueueListItemV1 = Readonly<{
  artifactId: string;
  status: ApprovalRequest['status'];
  actionId: ActionId;
  summary: string;
  sessionId?: string;
  serverId?: string;
  updatedAtMs: number;
}>;

export type ApprovalQueueQueryPlanV1 = Readonly<{
  kind: 'approval_artifact_header_scan' | 'bounded_approval_artifact_header_scan' | 'approval_artifact_id_lookup';
  backingStore?: 'ArtifactStore';
  boundedBy?: string;
  serverLimit?: number;
  hydratedTranscripts: false;
}>;

export type ApprovalQueueListResultV1 = Readonly<{
  items: readonly ApprovalQueueListItemV1[];
  queryPlan: ApprovalQueueQueryPlanV1;
}>;

type ExecutionRunActionOptions = Readonly<{
  serverId?: string | null;
  /** Immutable caller facts already admitted by the outer Action executor. */
  authority?: ActionRequiredAuthority;
  actionCaller?: ActionCaller;
  runtimeAccountId?: string;
  actionRequestId?: string;
  externalActionCredential?: ActionExecutorContext['externalActionCredential'];
  externalActionExecutionAuthorization?: ActionExecutorContext['externalActionExecutionAuthorization'];
  signExternalActionApprovalInput?: ActionExecutorContext['signExternalActionApprovalInput'];
  externalActionTarget?: ActionExecutorContext['externalActionTarget'];
  defaultSessionMachineId?: string;
  /**
   * Host-only admitted-turn authority carried to the incumbent execution-run
   * manager after the Action executor validates host context. It never enters
   * Action input or a public RPC payload.
   */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  /**
   * Permission mode after the Action owner clamps the current mutable Session
   * mode to the admitted-turn ceiling. Existing-run nested Actions and child
   * Runs must use this value instead of the historical Run mode.
   */
  effectiveCallerPermissionMode?: string;
  /**
   * The contextual Session that selected the exact daemon when the requested
   * execution-run scope is detached. This is transport context, never Action
   * input, so callers cannot retarget a run by mutating the request.
   */
  originSessionId?: string | null;
  /**
   * Host-stamped candidate for detached scope before V2 capability preflight
   * returns the exact machine id. Never accepted from Action input.
   */
  targetMachineId?: string | null;
  /** Exact machine selected by the detached capability preflight. */
  exactMachineId?: string | null;
  /** Host-private in-process binding; never part of an RPC payload. */
  permissionRequestStore?: unknown;
  /** Host-private in-process Workflow observation sink; never RPC payload. */
  workflowObservationSink?: unknown;
  /** Real admitted Workflow identity, host-only even without an observation sink. */
  workflowRunId?: string;
  /** Absolute host-admitted delegation depth, never public Run input. */
  workDepth?: number;
  agentStartContext?: AgentStartContextV1;
  workspaceWrites?: 'allow' | 'deny';
  sessionAgentSpawnPolicyV1?: unknown;
  signal?: AbortSignal;
}>;

type ExecutionRunWaitActionRequest = Omit<
  z.output<(typeof PUBLIC_ACTION_INPUT_SCHEMAS)['execution.run.wait']>,
  'sessionId'
>;

type Assert<T extends true> = T;
type IsExact<Left, Right> = (
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? ((<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
        ? true
        : false)
    : false
);

// Context ingress remains unknown until Action execution validates it. This
// host-only option is that validated projection, not a second authority shape.
type _ExecutionRunActionOptionsAuthorityIsCanonical = Assert<IsExact<
  ExecutionRunActionOptions['causalPermissionAuthority'],
  SessionInputCausalPermissionAuthorityV1 | undefined
>>;

export type ExecutionRunProtocolV2Requirement = Readonly<{
  detachedScope: boolean;
  startAndWait: boolean;
  exactInputResults: boolean;
  runScopedAgentBindings: boolean;
  secretReferenceOverlay: boolean;
}>;

type WorkflowActionExecuteArgsV1 = {
  [TActionId in WorkflowActionIdV1]: Readonly<{
    actionId: TActionId;
    input: ReturnType<(typeof WorkflowActionInputSchemasV1)[TActionId]['parse']>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>
}[WorkflowActionIdV1];

export type WorkflowActionExecuteArgs<TWorkflowActionId extends WorkflowActionIdV1 = WorkflowActionIdV1> =
  Extract<WorkflowActionExecuteArgsV1, { actionId: TWorkflowActionId }>;

/** One host port for the complete canonical Workflow Action family. */
export type WorkflowActionExecute = (args: WorkflowActionExecuteArgs) => Promise<
  | { [TActionId in WorkflowActionIdV1]: ReturnType<(typeof WorkflowActionOutputSchemasV1)[TActionId]['parse']> }[WorkflowActionIdV1]
  | WorkflowActionFailureV1
>;

export type ActionExecutorDeps = Readonly<{
  /** A client relays admitted typed-field discovery to the daemon's same options owner. */
  readAdmittedInputTypeOptions?: (request: Readonly<{ input: Readonly<Record<string, unknown>>;
    context: ActionExecutorContext }>) => Promise<unknown>;
  /** Admitted current plugin descriptor and incumbent Resource transport, bound by the host. */
  resolveInputType?: (identity: import('../../plugins/contributionIdentity.js').PluginContributionIdentityV1,
    context: ActionExecutorContext) => Promise<import('../../inputs/inputTypeRuntime.js').ResolvedInputTypeV1 | null>;
  readInputTypeResource?: (request: Readonly<{
    type: import('../../inputs/inputTypeRuntime.js').ResolvedInputTypeV1;
    resource: import('../../plugins/contributionIdentity.js').PluginContributionIdentityV1;
    context: ActionExecutorContext;
    sessionId?: string;
  }>) => Promise<unknown>;
  /** Mode-aware Account Artifact authority for Home layout and configured instances. */
  homeHubArtifacts?: HomeHubArtifactPortV1;
  /** Captured authenticated Home/Account authority; never taken from widget input. */
  widgetAccountScope?: () => Readonly<{ serverId: string; accountId: string }> | null;
  widgetSurfaceActions?: Partial<Readonly<Record<WidgetSurfaceRefV1['owner']['kind'], WidgetActionSurfacePortV1>>>;
  widgetInputs?: WidgetActionInputResolverV1;
  widgetCatalog?: Readonly<{ list(surface: WidgetSurfaceRefV1, context: ActionExecutorContext, signal?: AbortSignal, boundSession?: Readonly<{ serverId: string; sessionId: string }>): Promise<readonly WidgetCatalogEntryV1[] | ActionExecuteFailure> }>;
  widgetRefresh?: (args: Readonly<{ ref: WidgetInstanceRefV1; context: ActionExecutorContext; signal?: AbortSignal }>) => Promise<ActionExecuteResult>;
  widgetDefinitionArtifacts?: WidgetDefinitionActionDepsV1['widgetDefinitionArtifacts'];
  readSessionWidgetDefinitionSource?: WidgetDefinitionActionDepsV1['readSessionWidgetDefinitionSource'];
  describeWidgetDefinitionPlacements?: WidgetDefinitionActionDepsV1['describeWidgetDefinitionPlacements'];
  /** Current client inventory and captured Account settings; the Home layout owner decides mutations. */
  homeHubLayoutAction?: (args: Readonly<{
    actionId: HomeHubLayoutActionId;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  /**
   * Reads client-local contributed Actions at the discovery boundary. The
   * caller owns currentness; ActionExecutor only composes these definitions
   * with the static host catalog. Listings carry no schemas.
   */
  listContributedActionDefinitions?: () => readonly ActionDefinitionSummaryV1[];

  /**
   * Reads one listed contributed Action's declared schemas on demand for
   * `action.spec.get`; `null` when the Action is no longer current.
   */
  readContributedActionSchemas?: (id: string, signal?: AbortSignal) => Promise<Readonly<{
    inputSchema: Readonly<Record<string, unknown>>;
    outputSchema?: Readonly<Record<string, unknown>>;
  }> | null>;

  /** Existing committed-runtime invoker consumed by the `action.invoke` host Action. */
  invokeContributedAction?: InvokeContributedAction;

  interceptActionExecution?: (request: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    caller: NonNullable<ActionExecutorContext['actionCaller']>;
    signal?: AbortSignal;
  }>) => Promise<Readonly<
    | { status: 'continue'; input: unknown }
    | { status: 'rejected'; code?: string; message?: string }
    | { status: 'failed'; code: string }
  >>;

  observeActionExecution?: (observation: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    caller: NonNullable<ActionExecutorContext['actionCaller']>;
    result: ActionExecuteResult;
  }>) => Promise<void> | void;

  // Execution runs share one scope owner: an exact Session id or detached (`null`).
  /**
   * Exact-target capability proof for V2-only execution-run fields. Client
   * transports provide this before dispatch. V2-only requests fail closed
   * when it is unavailable; ordinary Session-scoped immediate calls do not
   * require it.
   */
  executionRunCheckProtocolV2?: (
    sessionId: string | null,
    requirement: ExecutionRunProtocolV2Requirement,
    opts?: ExecutionRunActionOptions,
  ) => Promise<
    | Readonly<{ ok: true; exactMachineId?: string }>
    | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>
  >;
  executionRunStart: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunList: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunGet: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  detachedExecutionRunSend: (sessionId: null, request: ExecutionRunSendRequest, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunEnsure?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunEnsureOrStart?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStreamStart?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStreamRead?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStreamCancel?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStop: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunCancelTurn?: (sessionId: string | null, request: ExecutionRunCancelTurnRequest, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunAction: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunPermissionRespond?: (
    request: ExecutionRunPermissionRespondActionInput,
    context: ActionExecutorContext,
  ) => Promise<unknown>;
  executionRunWait: (
    sessionId: string | null,
    request: ExecutionRunWaitActionRequest,
    opts?: ExecutionRunActionOptions,
  ) => Promise<unknown>;
  reviewCommentAction?: (args: Readonly<{
    actionId: ReviewCommentActionIdV1;
    input: unknown;
    serverId?: string | null;
    reviewCommentPrincipal?: ReviewCommentPrincipalHeaderV1 | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  pluginSessionHookManagementAction?: (args: Readonly<
    | {
      actionId: 'plugins.sessionHooks.status.get';
      input: PluginSessionHookStatusActionInputV1;
      serverId?: string | null;
      signal?: AbortSignal;
    }
    | {
      actionId: 'plugins.sessionHooks.install';
      input: PluginSessionHookInstallActionInputV1;
      serverId?: string | null;
      signal?: AbortSignal;
    }
    | {
      actionId:
        | 'plugins.sessionHooks.disable'
        | 'plugins.sessionHooks.enable'
        | 'plugins.sessionHooks.uninstall';
      input: PluginSessionHookInstallationMutationActionInputV1;
      serverId?: string | null;
      signal?: AbortSignal;
    }
  >) => Promise<unknown>;
  externalSessionAction?: (args: Readonly<{
    actionId: PluginExternalSessionActionId;
    input: unknown;
    pluginId: string;
    signal?: AbortSignal;
  }>) => Promise<ActionExecuteResult>;
  /**
   * Host-owned adapter for user-facing External Session controls. This is
   * deliberately separate from the plugin-provenance adapter above: public
   * ingress never supplies a plugin identity to select a contributor.
   */
  hostExternalSessionAction?: (args: Readonly<{
    actionId: HostExternalSessionActionId;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<ActionExecuteResult>;
  runtimeActionExecute?: RuntimeActionExecute;
  /** Client placement continuation, called only after canonical policy/approval admission. */
  clientActionExecute?: (args: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<ActionExecuteResult>;
  uiCommandPaletteAction?: (args: Readonly<{
    actionId: 'ui.command_palette.list' | 'ui.command_palette.invoke';
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<ActionExecuteResult>;
  /** The answering client's existing current-context owner; absent on headless hosts. */
  uiCurrentContextAction?: (args: Readonly<{
    actionId: 'ui.current_context.read' | 'ui.current_context.command.invoke';
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<ActionExecuteResult>;
  uiFindAction?: (args: Readonly<{
    actionId: 'ui.find';
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<ActionExecuteResult>;
  uiPromptPickerOpen?: (args: Readonly<{
    actionId: 'ui.prompts.picker.open';
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<ActionExecuteResult>;
  /** The mounted client's pending-navigation owner; absent on headless hosts. */
  nextPendingSession?: (context: ActionExecutorContext) => Promise<Readonly<{ status: 'opened' | 'none' | 'unavailable' }>>;
  launchProfilePublish?: (input: Readonly<{ profileId: string }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<Readonly<{ artifactId: string }>>;
  roleActionExecute?: (args: Readonly<{
    actionId: RoleActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;
  scmActionExecute?: ScmActionExecute;

  // Session navigation/spawn (client-side)
  /** The current mounted client workspace; absent on headless hosts. */
  workspaceAction?: (args: Readonly<{ actionId: WorkspaceActionId; input: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  sessionCanvasAction?: (args: Readonly<{ actionId: SessionCanvasActionId; input: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  workflowConversationBind?: (args: Readonly<{ input: unknown; context: ActionExecutorContext; signal?: AbortSignal }>) => Promise<unknown>;
  sessionOrganizationMove?: (args: Readonly<{ input: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  composerIngress?: (args: Readonly<{ actionId: 'composer.transaction.apply' | 'composer.attachments.pick' | 'repository.upload.pick'; input: unknown; context: ActionExecutorContext; signal?: AbortSignal }>) => Promise<unknown>;
  listReorder?: (args: Readonly<{ actionId: 'session.pending.reorder' | 'todos.reorder'; input: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  todoSessionLink?: (args: Readonly<{ input: unknown; context: ActionExecutorContext; signal?: AbortSignal }>) => Promise<TodoSessionLinkOutputV1>;
  sessionTerminalAction?: (args: Readonly<{ actionId: SessionTerminalActionId; input: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  /** Canonical host resolver for non-qualified Session ids/titles. */
  resolveSessionReference?: (args: Readonly<{
    context: ActionExecutorContext;
    sessionId?: string;
    sessionTitle?: string;
    signal?: AbortSignal;
  }>) => Promise<ActionSessionReferenceResolution>;
  sessionOpen: (args: ActionSessionAddress & Readonly<{
    tabId?: string;
    destination?: PublicActionInputById['session.open']['destination'];
    actionRequestId?: string | null;
    approvedNewDirectoryCreation?: boolean;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionFork: (args: Readonly<
    Omit<SessionForkRpcParams, 'v' | 'parentSessionId'> & {
      sessionId: string;
      serverId?: string | null;
      signal?: AbortSignal;
    }
  >) => Promise<unknown>;
  sessionContinueWithReplay?: (args: SessionContinueWithReplayRpcParams & Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
  sessionRollback: (args: Readonly<{ sessionId: string; serverId?: string | null; target?: SessionRollbackTarget; signal?: AbortSignal }>) => Promise<unknown>;
  checkpointCodeRollback?: (args: Readonly<{
    request: CheckpointCodeRollbackRequest;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<CheckpointCodeRollbackResult | unknown>;
  sessionCheckpoint?: (args: Readonly<{
    request: SessionCheckpointRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<SessionCheckpointResultV1 | unknown>;
  sessionRestore?: (args: Readonly<{
    request: SessionRestoreRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<SessionRestoreResultV1 | unknown>;
  sessionHandoffStart?: (args: Readonly<{
    sessionId: string;
    targetMachineId: string;
    targetPath?: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceAction?: HandoffWorkspaceActionV1;
    serverId?: string | null;
    actionRequestId?: string | null;
    handoffTargetReplacementApproval?: HandoffTargetReplacementApprovalV1 | null;
    handoffTargetReplacementApprovalReceiptId?: string | null;
    handoffTargetReplacementApprovalActionInput?: unknown;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  /**
   * Target-daemon inspection before an operation can replace a destination's
   * contents or activate exact mirroring on it. One owner serves both
   * destination-choosing Action families: `session.handoff` supplies its
   * admitted Session, while direct Project linking has no Session and supplies
   * its destination intent instead.
   */
  sessionHandoffTargetReplacementApprovalPreflight?: (args: Readonly<{
    sessionId?: string;
    targetMachineId: string;
    targetPath?: string;
    workspaceAction?: HandoffWorkspaceActionV1;
    /** Explicit for callers that do not express their mode as a handoff workspace action. */
    activatesExactMirror?: boolean;
    destinationIntent?: 'use_existing' | 'materialize_from_source_workspace';
    serverId?: string | null;
    operationId: string;
    signal?: AbortSignal;
  }>) => Promise<
    | Readonly<{ type: 'not_required' }>
    | Readonly<{ type: 'approval_required'; approval: HandoffTargetReplacementApprovalV1 }>
    | Readonly<{ type: 'error'; result: ActionExecuteResult }>
  >;
  sessionHandoffPrepareTarget?: (args: SessionHandoffPrepareTargetRequest) => Promise<unknown>;
  sessionHandoffPrepareTargetResume?: (args: SessionHandoffPrepareTargetResumeRequest) => Promise<unknown>;
  sessionHandoffPrepareTargetResultGet?: (args: SessionHandoffPrepareTargetResultGetRequest) => Promise<unknown>;
  sessionHandoffCommit?: (args: SessionHandoffCommitRequest) => Promise<unknown>;
  sessionHandoffAbort?: (args: SessionHandoffAbortRequest) => Promise<unknown>;
  sessionHandoffStatusGet?: (args: SessionHandoffStatusGetRequest) => Promise<unknown>;
  workspaceSyncConflictResolve?: (args: Readonly<{
    actionReceiptId: string;
    input: WorkspaceSyncConflictResolveActionInputV1;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceSyncConflictResolutionResultV1>;
  /**
   * Direct Project linking. The executor supplies the admitted operation
   * identity and any approved destination proof; the source controller daemon
   * owns relationship identity, endpoint materialization and bootstrap.
   */
  workspaceSyncRelationshipCreate?: (args: Readonly<{
    input: WorkspaceSyncRelationshipCreateActionInputV1;
    operationId: string;
    serverId?: string | null;
    targetReplacementApproval?: HandoffTargetReplacementApprovalV1 | null;
    targetReplacementApprovalReceiptId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceSyncRelationshipCreateResultV1 | unknown>;
  workspaceSyncRelationshipsList?: (args: Readonly<{
    input: WorkspaceSyncRelationshipsListActionInputV1;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceSyncRelationshipsListActionOutputV1>;
  workspaceSyncConflictsList?: (args: Readonly<{
    input: WorkspaceSyncConflictsListActionInputV1;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceSyncConflictPageV1>;
  workspaceSyncConflictInspect?: (args: Readonly<{
    input: WorkspaceSyncConflictInspectActionInputV1;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceSyncConflictInspectActionOutputV1>;
  sessionSpawnNew: (args: SessionSpawnNewInputV2 & SessionCreateOriginFieldsV1 & Readonly<{
    /** Host-only invocation binding for post-commit private material preparation; never sent in the spawn payload. */
    context?: ActionExecutorContext;
    /** Complete host-resolved spawn snapshot; memory remains subject to target owner proof. */
    initialSessionRolesV1?: SessionRolesV1;
    creationKey: SessionSpawnNewInputV2['creationKey'];
    creationAuthorization?: Readonly<{ token: string }>;
    callerInputConstraints?: CallerInputConstraintsV1;
    sessionCreationTag: SessionCreationTagV1;
    /**
     * Private compatibility sidecar from a provenance-bounded predecessor
     * approval-artifact replay. It is not part of SessionSpawnNewInputV2 or
     * plugin/SDK/live Action input.
     */
    legacyMetadataLabel?: string;
    /** Host-stamped caller identity; never supplied by Action input. */
    actionCaller: ActionCaller;
    callerSurface?: keyof ActionSurfaces | null;
    sessionAgentSpawnPolicyV1?: unknown;
    workDepth?: number;
    actionRequestId?: string | null;
    resumeActionRequest?: boolean;
    /** Host-only exact directory-creation authorization from approval replay. */
    sessionCreationDirectoryApproval?: SessionCreationDirectoryApprovalV1 | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  /**
   * Host-owned admission for an Agent-originated child Session request. It
   * runs before approval creation and compares explicit V2 choices with the
   * live parent Session; approval replay never becomes a policy bypass.
   */
  resolveAgentStartContext?: (context: ActionExecutorContext) => Promise<AgentStartContextV1 | null>;
  /** Live Session role owner; checked again after deferred approval/prepared invocation. */
  getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
  /**
   * Probes the exact target before `session.spawn_new` can materialize a raw
   * directory. A returned approval is retained by the existing Action
   * approval artifact and must be replayed back through this same owner.
   */
  sessionSpawnNewDirectoryApprovalPreflight?: (args: Readonly<{
    input: SessionSpawnNewInputV2;
    signal?: AbortSignal;
  }>) => Promise<
    | Readonly<{ type: 'not_required' }>
    | Readonly<{
        type: 'approval_required';
        approval: SessionCreationDirectoryApprovalV1;
      }>
    | Readonly<{
        type: 'error';
        result: Extract<SessionSpawnNewResultV1, Readonly<{ type: 'error' }>>;
      }>
  >;
  /**
   * Host transport for replay that must run on an exact daemon. The canonical
   * executor calls this only after the present-user decision is durably
   * recorded; the receiving host may consume that approved Artifact but cannot
   * create or alter the decision.
   */
  approvalRequestApprovedReplay?: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequest;
    signal?: AbortSignal;
  }>) => Promise<ActionExecuteResult | null>;
  /**
   * Host-owned replay for a contributed Action's durable API approval. It
   * claims only artifacts whose strict target subject it can re-read; null
   * leaves ordinary ApprovalRequest handling on the existing path.
   */
  targetActionApprovalReplay?: (args: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    callerGrant?: ApiTokenGrantV1;
    signal?: AbortSignal;
  }>) => Promise<ActionExecuteResult | null>;
  // Local inventory + discovery (voice)
  pathsListRecent: (args: Readonly<{ machineId?: string; limit?: number }>) => Promise<unknown>;
  /**
   * The Account's persisted project registry, each row carrying the resolved
   * hosting provider and worktrees its SCM working snapshot already holds.
   *
   * It is a projection of two incumbent owners — `workspaceRefsV1` in Account
   * Settings and the `projectKey`-keyed working snapshot — and builds no index
   * of its own. A host that holds neither installs no dependency at all and
   * the Action reports `unsupported_action`, so a caller can tell "this client
   * cannot list projects" from "you have no matching project" — the two need
   * different words in front of a reader.
   */
  projectsList?: (args: Readonly<{ machineId?: string; limit?: number }>) => Promise<unknown>;
  promptInvocationsList?: (args: Readonly<{ limit?: number; signal?: AbortSignal }>) => Promise<unknown>;
  promptInvocationResolve?: (args: Readonly<{ invocationId: string; argsText?: string; sessionId?: string | null; signal?: AbortSignal }>) => Promise<unknown>;
  machinesList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  homeConnect?: (input: z.infer<typeof HomeConnectInputSchema>, context: ActionExecutorContext) => Promise<z.infer<typeof HomeConnectOutputSchema> | ActionExecuteFailure>;
  machineAddCommand?: (input: z.infer<typeof MachineAddCommandInputSchema>, context: ActionExecutorContext) => Promise<z.infer<typeof MachineAddCommandOutputSchema> | ActionExecuteFailure>;
  machineAddSshTaskAction?: (actionId: MachineAddSshActionId, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
  machinePairingCreate?: (input: z.infer<typeof MachinePairingCreateInputSchema>, context: ActionExecutorContext) => Promise<z.infer<typeof MachinePairingCreateOutputSchema> | ActionExecuteFailure>;
  machineTerminalOpen?: (input: z.infer<typeof MachineTerminalOpenInputSchema> & { signal?: AbortSignal }) => Promise<DaemonTerminalEnsureResponse | ActionExecuteFailure>;
  machineTerminalList?: (input: z.infer<typeof MachineTerminalListInputSchema> & { signal?: AbortSignal }) => Promise<DaemonTerminalListResponseV1 | null | ActionExecuteFailure>;
  serversList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  reviewEnginesList: (args: Readonly<{ sessionId: string | null; includeDisabled?: boolean; scope?: 'paths' }>) => Promise<unknown>;
  /** Caller-owned Account delivery; the host checks visibility of any deep link. */
  notificationsNotifyMe?: (
    input: NotificationsNotifyMeInputV1,
    context: ActionExecutorContext,
  ) => Promise<NotificationsNotifyMeResultV1 | ActionExecuteFailure>;
  /** Configured channel ids and labels from the executing Account host. */
  notificationChannelsList?: (context: ActionExecutorContext) => Promise<unknown>;
  /**
   * Resolves the V2 authored Session Agent identity through the current host
   * catalog before a Session-spawn dynamic option source reaches inventory.
   * This is deliberately host-owned: Protocol validates the public target,
   * while the host owns its current contribution catalog and backend key.
   */
  resolveSessionSpawnAgentInventorySelection?: (args: Readonly<{
    agentTarget: AgentExecutionTargetV1;
    machineId?: string;
    serverId?: string;
  }>) => Promise<Readonly<{
    agentId: string;
    backendTargetKey: string;
  }> | null> | Readonly<{
    agentId: string;
    backendTargetKey: string;
  }> | null;
  agentsBackendsList: (args: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>) => Promise<AgentsBackendsListOutput>;
  machineAgentSignInStart?: (args: MachinesAgentsSignInStartInput & { serverId?: string; signal?: AbortSignal }) => Promise<MachinesAgentsSignInStartOutput>;
  machineAgentSignInStatus?: (args: MachinesAgentsSignInStatusInput & { serverId?: string; signal?: AbortSignal }) => Promise<AgentSignInStatusResponse>;
  machineAgentSignInCancel?: (args: MachinesAgentsSignInCancelInput & { serverId?: string; signal?: AbortSignal }) => Promise<MachinesAgentsSignInCancelOutput>;
  machineAgentSignInRestart?: (args: MachinesAgentsSignInCancelInput & { serverId?: string; signal?: AbortSignal }) => Promise<MachinesAgentsSignInStartOutput>;
  machinesAgentsList?: (args: MachinesAgentsListInput, context: ActionExecutorContext) => Promise<MachinesAgentsListOutput | ActionExecuteFailure>;
  workspaceFilesSearch?: (args: PublicActionInputById['workspace.files.search'], context: ActionExecutorContext) => Promise<DaemonWorkspaceFileSearchResponse | ActionExecuteFailure>;
  machineAgentInstallStart?: (args: DaemonAgentInstallStartRequest & { machineId: string; serverId?: string; signal?: AbortSignal }) => Promise<DaemonAgentInstallStartResponse>;
  machineAgentInstallRead?: (args: DaemonAgentInstallReadRequest & { machineId: string; serverId?: string; signal?: AbortSignal }) => Promise<DaemonAgentInstallReadResponse>;
  machineAgentInstallCancel?: (args: DaemonAgentInstallCancelRequest & { machineId: string; serverId?: string; signal?: AbortSignal }) => Promise<DaemonAgentInstallCancelResponse>;
  agentsModelsList: (args: Readonly<{
    agentId?: string;
    machineId?: string;
    serverId?: string;
    limit?: number;
    backendTargetKey?: string;
    /** Only the admitted Session-spawn model field requests the Provider read projection. */
    includeProviderProjection?: true;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  agentsConfigOptionsList?: (args: Readonly<{ agentId?: string; machineId?: string; serverId?: string; limit?: number; backendTargetKey?: string; modelId?: string }>) => Promise<unknown>;
  agentsSessionModesList?: (args: Readonly<{ agentId?: string; machineId?: string; serverId?: string; limit?: number; backendTargetKey?: string }>) => Promise<unknown>;
  spawnProfilesList?: (args: Readonly<{ agentId?: string; backendTargetKey?: string; limit?: number }>) => Promise<unknown>;
  spawnConnectedServicesList?: (args: Readonly<{ agentId?: string; backendTargetKey?: string; machineId?: string; serverId?: string; includeUnavailable?: boolean }>) => Promise<unknown>;
  spawnMcpServersPreview?: (args: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    machineId?: string;
    directory?: string;
    selection?: unknown;
    limit?: number;
  }>) => Promise<unknown>;

  // Session messaging (socket message event, server-scoped)
  sessionSendMessage: (args: Readonly<{
    context: ActionExecutorContext;
    callerInputConstraints?: CallerInputConstraintsV1;
    sessionId: string;
    message: string;
    recipient?: ParticipantRecipientRoutingIdentityV1;
    /** Host-authored display text for an exact semantic Session operation. */
    displayText?: string;
    /** Host-authored structured metadata; never accepted from plugin input. */
    messageMeta?: Readonly<Record<string, unknown>>;
    requestedAction: PendingRequestedActionV1;
    actionCaller?: ActionCaller;
    idempotencyKey?: string;
    /** Caller-retained durable input identity; plugin inputs derive their own. */
    localId?: string;
    source?: PluginSessionInputSourceV1;
    /**
     * Declared Composer attachment drafts authored by the plugin caller. The
     * host qualifies their plugin id from `actionCaller` and stamps identity
     * before they reach the Session-input writer.
     */
    attachments?: readonly PluginSessionInputAttachmentV1[];
    permissionModeOverride?: string;
    modelOverride?: string | null;
    providerConnectionId?: ProviderConnectionId | null;
    wait?: boolean;
    timeoutSeconds?: number;
    serverId?: string | null;
    callerSurface?: keyof ActionSurfaces | null;
    /** Validated host-only source turn and immutable causal authority. */
    sessionInputSource?: Readonly<{
      sourceSessionId: string;
      sourceTurnId: string;
      via: 'action' | 'mcp';
      causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
    }>;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionApprovalReviewerSet?: (args: Readonly<{ context: ActionExecutorContext; sessionId: string; enabled: boolean; serverId?: string | null }>) => Promise<unknown>;
  /**
   * `session.attention.set` host port (ORC R-10). It writes the existing attention-standing route
   * for the exact Home and returns that route's `{ standing }` payload; it adds no store of its own.
   */
  sessionAttentionSet?: (args: Readonly<{
    context: ActionExecutorContext;
    sessionId: string;
    request: Readonly<{ standing?: boolean | null; remindAt?: number | null }>;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionTitleSet?: (args: Readonly<{ context: ActionExecutorContext; sessionId: string; title: string; serverId?: string | null }>) => Promise<unknown>;
  sessionStop?: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionTerminalComposerClear?: (args: Readonly<{
    sessionId: string;
    expectedStateAtMs?: number;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionPendingInputInterruptAndRun?: (args: Readonly<{
    sessionId: string;
    localId: string;
    expectedStateAtMs?: number;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionPermissionModeSet?: (args: Readonly<{
    sessionId: string;
    context?: ActionExecutorContext;
    callerInputConstraints?: CallerInputConstraintsV1;
    permissionMode: string;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionModelSet?: (args: Readonly<{
    sessionId: string;
    context?: ActionExecutorContext;
    callerInputConstraints?: CallerInputConstraintsV1;
    modelId?: string;
    providerConnectionId?: string | null;
    teamCredentialModel?: import('../../teams/credentials/resourceV1.js').TeamCredentialProviderModelSelectionV1;
    teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionArchiveSet?: (args: Readonly<{ sessionId: string; archived: boolean; serverId?: string | null }>) => Promise<unknown>;
  /**
   * Durable Session-to-Session Follow authoring. The destination is always
   * explicit: Follow is a relation between two Sessions, so neither endpoint is
   * inherited from the ambient current Session.
   */
  sessionFollowAction?: (args: Readonly<{
    context: ActionExecutorContext;
    actionId: SessionFollowActionIdV1;
    input: Readonly<Record<string, unknown>>;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  /**
   * The one explicit-human Session read-state port (Lane 09B §5.3, E1).
   * Each executor host implements it once over its own incumbent authenticated
   * transport to the existing `POST /v2/sessions/:sessionId/read-state` domain
   * route: the UI over its exact-Home repository and the CLI over its
   * authenticated Account HTTP adapter. The host performs no second
   * persistence write, evaluation, response interpretation, or server
   * execution; it binds the exact Home SessionAddress and returns the route
   * payload for this executor's canonical Action projection.
   *
   * It is absent until that host's read-state producer exists, and the
   * executor then returns the canonical unsupported result rather than running
   * without a proven authority and policy path.
   */
  sessionReadStateAction?: (args: Readonly<{
    context: ActionExecutorContext;
    actionId: SessionReadStateActionIdV1;
    input: Readonly<Record<string, unknown>>;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionStatusGet?: (args: Readonly<{ sessionId: string; live?: boolean; serverId?: string | null }>) => Promise<unknown>;
  sessionHistoryGet?: (args: Readonly<{
    sessionId: string;
    limit?: number;
    format?: 'compact' | 'raw';
    includeMeta?: boolean;
    includeStructuredPayload?: boolean;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionTranscriptGet?: (args: Readonly<{
    context: ActionExecutorContext;
    sessionId: string;
    projection?: 'externalShareableV1';
    callerPluginId?: string;
    limit?: number;
    cursor?: string | null;
    direction?: 'before' | 'after';
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    roles?: readonly ('user' | 'assistant')[];
    includeTools?: boolean;
    includeReasoning?: boolean;
    includeEvents?: boolean;
    includeMeta?: boolean;
    includeStructuredPayload?: boolean;
    includeRaw?: boolean;
    maxCharsPerMessage?: number | null;
    maxRawPayloadChars?: number | null;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<SessionTranscriptGetResult>;
  sessionEventsGet?: (args: Readonly<{
    sessionId: string;
    limit?: number;
    cursor?: string | null;
    direction?: 'before' | 'after';
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
    kinds?: readonly string[];
    format?: 'compact' | 'raw';
    includeMeta?: boolean;
    includeStructuredPayload?: boolean;
    includeRaw?: boolean;
    maxTextChars?: number;
    maxPayloadChars?: number;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionWaitIdle?: (args: Readonly<{ sessionId: string; timeoutSeconds?: number; serverId?: string | null; signal?: AbortSignal }>) => Promise<unknown>;
  sessionAwarenessWait?: (args: Readonly<{
    context: ActionExecutorContext;
    input: WaitActionInputV1;
    options: WaitOwnerOptionsV1;
    readAwareness: () => Promise<unknown>;
  }>) => Promise<WaitOwnerResultV1>;
  sessionWorkStateGet?: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionGoalGet?: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionGoalSet?: (args: Readonly<{
    sessionId: string;
    objective?: string;
    status?: string;
    tokenBudget?: number | null;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionGoalClear?: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionUsageLimitWaitResumeEnable?: (args: Readonly<{
    sessionId: string;
    issueFingerprint?: string;
    remember?: boolean;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUsageLimitWaitResumeCancel?: (args: Readonly<{
    sessionId: string;
    issueFingerprint?: string | null;
    armedAtMs?: number;
    runtimeAuthRecoveryAttemptId?: string;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUsageLimitCheckNow?: (args: Readonly<{
    sessionId: string;
    agentId?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUsageLimitSwitchAccountNow?: (args: Readonly<{
    sessionId: string;
    agentId?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUsageLimitConsumeResetCredit?: (args: Readonly<{
    sessionId: string;
    agentId?: string;
    issueFingerprint?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionVendorPluginCatalogList?: (args: Readonly<{ sessionId: string; cwd?: string; serverId?: string | null }>) => Promise<unknown>;
  sessionSkillCatalogList?: (args: Readonly<{ sessionId: string; cwd?: string; serverId?: string | null }>) => Promise<unknown>;

  // Permission response (session RPC, server-scoped)
  sessionPermissionRespond?: (args: Readonly<{
    sessionId: string;
    context?: ActionExecutorContext;
    decision: SessionPermissionRespondActionDecisionV1;
    mode?: SessionPermissionRespondRpcParamsV1['mode'];
    reason?: string;
    answers?: SessionPermissionRespondRpcParamsV1['answers'];
    requestId?: string | null;
    turnId?: string | null;
    allowedTools?: readonly string[];
    updatedPermissions?: unknown;
    execPolicyAmendment?: SessionPermissionRespondRpcParamsV1['execPolicyAmendment'];
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionPermissionRemoteAction?: (args: SessionPermissionRemoteActionArgs) => Promise<unknown>;
  sessionUserActionAnswer?: (args: Readonly<{
    sessionId: string;
    context?: ActionExecutorContext;
    requestId?: string | null;
    answers: readonly Readonly<{ question: string; values: readonly string[] }>[];
    decision?: 'approve' | 'reject' | 'request_changes';
    reason?: string;
    updatedPermissions?: unknown;
    allowedTools?: readonly string[];
    execPolicyAmendment?: unknown;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionModeSet: (args: Readonly<{ sessionId: string; modeId: string }>) => Promise<unknown>;
  sessionModesList: (args: Readonly<{ sessionId: string }>) => Promise<unknown>;

  // Voice panel targeting + session query tools
  sessionTargetPrimarySet?: (args: ActionSessionAddress | Readonly<{ sessionId: null; serverId?: null }>) => Promise<unknown>;
  sessionTargetTrackedSet?: (args: (
    | Readonly<{ sessionAddresses: readonly ActionSessionAddress[] }>
    | Readonly<{ sessionIds: readonly string[] }>
  ) & Readonly<{
    context: ActionExecutorContext;
    serverId?: string | null;
    signal?: AbortSignal;
  }>
  ) => Promise<
    import('../../sessions/follow/voiceTrackedTargetsCompatibilityV1.js').VoiceTrackedTargetsActionResultV1
  >;
  sessionList: (args: Readonly<{
    context: ActionExecutorContext;
    query?: SessionListQueryV1;
    view?: SessionListViewV1;
    limit?: number;
    cursor?: string | null;
    includeLastMessagePreview?: boolean;
    activeOnly?: boolean;
    archivedOnly?: boolean;
    includeSystem?: boolean;
    resumableOnly?: boolean;
    includeRows?: boolean;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionReportsToSet?: (args: SessionReportsToSetActionInputV1 & Readonly<{
    context: ActionExecutorContext;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<SessionReportsToSetResultV1 | ActionExecuteFailure>;
  sessionWorkerPublish?: (args: SessionWorkerPublishInputV1 & Readonly<{ context: ActionExecutorContext }>) => Promise<unknown>;
  sessionActivityGet: (args: Readonly<{ context: ActionExecutorContext; sessionId: string; view?: SessionListViewV1; windowSeconds?: number; serverId?: string; signal?: AbortSignal }>) => Promise<unknown>;
  sessionRecentMessagesGet: (args: Readonly<{
    sessionId: string;
    serverId?: string | null;
    limit?: number;
    cursor?: string | null;
    includeUser?: boolean;
    includeAssistant?: boolean;
    maxCharsPerMessage?: number | null;
  }>) => Promise<unknown>;

  // Global voice controls
  resetGlobalVoiceAgent: () => Promise<void> | void;
  teleportVoiceAgentToSessionRoot?: (args: Readonly<{ sessionId: string }>) => Promise<unknown>;

  // Daemon-local memory (machine-scoped RPC)
  daemonMemorySearch: (args: Readonly<{
    machineId: string;
    query: MemorySearchQueryV1;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<MemorySearchResultV1>;
  daemonMemoryGetWindow: (args: Readonly<{
    machineId: string;
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<MemoryWindowV1>;
  daemonMemoryEnsureUpToDate: (args: Readonly<{ machineId: string; sessionId?: string; serverId?: string | null }>) => Promise<unknown>;

  // Approval queue (optional)
  approvalsList?: (args: Readonly<{
    status?: ApprovalRequest['status'] | null;
    limit?: number | null;
    serverId?: string | null;
  }>) => Promise<ApprovalQueueListResultV1>;
  approvalsCreate?: (args: Readonly<{ request: ApprovalRequest; serverId?: string | null }>) => Promise<{ artifactId: string }>;
  approvalsGet?: (args: Readonly<{ artifactId: string; serverId?: string | null }>) => Promise<ApprovalRequest | null>;
  approvalsUpdate?: (args: Readonly<{ artifactId: string; request: ApprovalRequest; serverId?: string | null }>) => Promise<{ ok: true } | { ok: false; errorCode: string; error: string }>;
  /** Revalidates the origin against current credential/runtime/target owners before effects. */
  isApprovalExecutionOriginCurrent?: (args: Readonly<{
    origin: ApprovalExecutionOriginV1;
    request: ApprovalRequest;
    signal?: AbortSignal;
  }>) => Promise<boolean>;
  approvalsResolveBlockingDecision?: (args: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    request: ApprovalRequest;
    serverId?: string | null;
  }>) => Promise<{ resolved: boolean }>;
  approvalsWaitForDecision?: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequest;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<
    | { decision: 'approve'; request: ApprovalRequest }
    | { decision: 'reject'; request: ApprovalRequest; reason?: string }
    | { decision: 'canceled'; request: ApprovalRequest; reason?: string }
  >;

  /**
   * Host Session permission transport for an exact Session-local Agent operation.
   * Null retains Account-private Artifact custody. The decision resumes the same
   * admitted invocation; it is never an Artifact or an independent execution owner.
   */
  sessionActionConfirmation?: (args: Readonly<{
    actionId: ActionId;
    input: unknown;
    /** Only the Action domain's explicit Session-disclosure projection may be published. */
    preview: unknown;
    context: ActionExecutorContext;
    sessionId: string;
  }>) => Promise<Readonly<{
    decision: 'approve' | 'reject' | 'canceled';
    /** Revalidate the captured runtime/operation binding immediately before effects. */
    isCurrent: () => boolean | Promise<boolean>;
  }> | null>;

  /**
   * Narrow client-side transcript implementation hook. It runs only after
   * canonical Action parsing, caller policy, interception, and approval
   * routing; `null` leaves the established Protocol dispatch in control.
   */
  sessionTranscriptAction?: (args: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<ActionExecuteResult | null>;

  // Provider-neutral session subagent projections (optional until A.12-subagents host owner is wired).
  subagentsList?: (args: Readonly<{ parentSessionId?: string; groupId?: string | null; limit?: number }>) => Promise<unknown>;
  subagentsGet?: (args: Readonly<{ id: string; parentSessionId?: string }>) => Promise<unknown>;
  subagentsWatch?: (args: Readonly<{ parentSessionId?: string; id?: string }>) => Promise<unknown>; // Returns the initial snapshot from the bounded host watcher path.
  subagentsUpsert?: (args: Readonly<{
    input: SubagentRefInputV1;
    caller: ActionCaller;
  }>) => Promise<unknown>;
  subagentsUpdateStatus?: (args: Readonly<{
    input: Readonly<{
      id: string;
      parentSessionId?: string;
      status: SubagentStatusV1;
      lifecycleDetail?: SubagentLifecycleDetailV1;
      completedAt?: number;
    }>;
    caller: ActionCaller;
  }>) => Promise<unknown>;
  subagentsComplete?: (args: Readonly<{
    input: Readonly<{
      id: string;
      parentSessionId?: string;
      status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
      lifecycleDetail?: SubagentLifecycleDetailV1;
      completedAt?: number;
    }>;
    caller: ActionCaller;
  }>) => Promise<unknown>;

  /**
   * Compare-and-set the Account's custom ACP catalog (`acpCatalogSettingsV1`) through the host's
   * Account settings writer. `mutate` receives the latest stored value and returns the next one;
   * the host applies it once, with its own encryption mode and version handling.
   */
  updateAccountAcpCatalogSettings?: (args: Readonly<{
    mutate: (current: unknown) => unknown;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
  workBoardArtifacts?: Pick<WorkBoardArtifactPortV1, 'read' | 'apply'> & Partial<Pick<WorkBoardArtifactPortV1, 'readBoard'>>;
  promptDocGet?: (args: Readonly<{ artifactId: string; signal?: AbortSignal }>) => Promise<unknown>;
  promptDocCreate?: (args: Readonly<{ title: string; markdown: string; folderId?: string | null;
    tags?: readonly string[]; favorite?: boolean; signal?: AbortSignal }>) => Promise<unknown>;
  promptDocFavoriteSet?: (args: Readonly<{ artifactId: string; favorite: boolean; signal?: AbortSignal }>) => Promise<unknown>;
  promptsLibraryList?: (args: Readonly<{ query?: string; includeBundles?: false; signal?: AbortSignal }>) => Promise<unknown>;
  promptDocUpdate?: (args: Readonly<{
    artifactId: string;
    title: string;
    markdown: string;
    folderId?: string | null;
    tags?: readonly string[];
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  promptBundleUpdate?: (args: Readonly<{
    artifactId: string;
    title: string;
    skillMarkdown: string;
    folderId?: string | null;
    tags?: readonly string[];
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  promptAssetExport?: (args: Readonly<{
    artifactId: string;
    machineId: string;
    assetTypeId: string;
    scope: 'user' | 'project';
    serverId?: string | null;
    directory?: string;
    targetPath?: string;
    targetName?: string;
    installMode?: 'copy' | 'symlink';
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  promptRegistryInstall?: (args: Readonly<{
    machineId: string;
    sourceId: string;
    itemId: string;
    configuredSources: readonly PromptRegistryConfiguredSourceV1[];
    serverId?: string | null;
    installTarget?: Readonly<{
      assetTypeId: string;
      scope: 'user' | 'project';
      directory?: string;
      targetName: string;
      installMode?: 'copy' | 'symlink';
    }>;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  daemonPromptAssetsDiscover?: (args: Readonly<{
    request: PromptAssetDiscoverRequest;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  daemonPromptAssetsDelete?: (args: Readonly<{
    request: PromptAssetDeleteRequest;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  daemonPromptRegistryScanSource?: (args: Readonly<{
    request: PromptRegistryScanSourceRequestV1;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  daemonPromptRegistryInstall?: (args: Readonly<{
    request: PromptRegistryInstallRequestV1;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  pluginsDevLoopAction?: (args: Readonly<{
    actionId: PluginDevLoopActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;

  /** One host-owned Settings administration dispatch into existing Settings/Secrets owners. */
  pluginSettingsAdministrationAction?: (args: Readonly<{
    actionId: PluginSettingsAdministrationActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;

  /**
   * The UI-present host path for erasing only the current Account’s data for
   * one plugin. Account authority is host-stamped by the transport beneath
   * this owner; callers may select only the canonical plugin id.
   */
  accountPluginDataEraseAction?: (args: Readonly<{
    input: PluginAccountDataEraseActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<PluginAccountDataEraseActionOutputV1>;

  /**
   * The UI-present host path for invalidating the current Account's signed
   * sessions. The transport owns Account derivation and token-epoch mutation.
   */
  accountSessionsSignOutEverywhereAction?: (args: Readonly<{
    input: AccountSessionsSignOutEverywhereActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountSessionsSignOutEverywhereActionOutputV1>;

  /**
   * Current-Account API-token lifecycle owners. Transport derives the Account
   * from verified provenance; callers can select only token-local input.
   */
  accountApiTokensCreateAction?: (args: Readonly<{
    input: AccountApiTokensCreateActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountApiTokensCreateActionOutputV1 | ActionExecuteFailure>;
  accountApiTokensUpdateAction?: (args: Readonly<{
    input: AccountApiTokensUpdateActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountApiTokensUpdateActionOutputV1 | ActionExecuteFailure>;
  accountApiTokensListAction?: (args: Readonly<{
    input: AccountApiTokensListActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountApiTokensListActionOutputV1 | ActionExecuteFailure>;
  accountApiTokensRevokeAction?: (args: Readonly<{
    input: AccountApiTokensRevokeActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountApiTokensRevokeActionOutputV1 | ActionExecuteFailure>;
  accountApiTokensRevokeAllAction?: (args: Readonly<{
    input: AccountApiTokensRevokeAllActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountApiTokensRevokeAllActionOutputV1 | ActionExecuteFailure>;

  /**
   * Current-Account security owners. Transport derives the Account from verified
   * provenance and reaches the explicit Lane 02 domain routes; callers select
   * only credential-local input. Human-secret operations stay off agent/MCP/
   * generic API/public plugin surfaces via the registry `surfaces` fact.
   */
  /** Invoking client's scoped credential custodian; headless hosts leave this absent. */
  accountHistoricalEncryptionKeyForgetAction?: (args: Readonly<{
    input: Record<string, never>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountHistoricalEncryptionKeyForgetResultV1 | ActionExecuteFailure>;
  accountEncryptionAutomationTemplatesRecoverAction?: (args: Readonly<{
    input: Record<string, never>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountEncryptionAutomationTemplatesRecoverResultV1 | ActionExecuteFailure>;
  accountSecurityGetAction?: (args: Readonly<{
    input: Record<string, never>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountSecurityGetResponseV1 | ActionExecuteFailure>;
  accountSecurityTerminalPresentUserSetAction?: (args: Readonly<{
    input: AccountTerminalPresentUserPolicySetRequestV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountTerminalPresentUserPolicySetResponseV1 | ActionExecuteFailure>;
  accountPasswordEnrollAction?: (args: Readonly<{
    input: AccountPasswordEnrollRequestV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountPasswordMutationResponseV1 | ActionExecuteFailure>;
  accountPasswordChangeAction?: (args: Readonly<{
    input: AccountPasswordChangeRequestV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountPasswordMutationResponseV1 | ActionExecuteFailure>;
  accountPasswordRemoveAction?: (args: Readonly<{
    input: AccountPasswordRemoveRequestV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountPasswordMutationResponseV1 | ActionExecuteFailure>;
  accountEmailChangeRequestAction?: (args: Readonly<{
    input: AccountEmailChangeRequestV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<AccountEmailChangeRequestResponseV1 | ActionExecuteFailure>;

  pluginPermissionGrantAction?: (args: Readonly<
    & {
      caller: NonNullable<ActionExecutorContext['actionCaller']>;
      signal?: AbortSignal;
    }
    & (
      | { actionId: 'plugins.permissions.grants.list'; input: PluginPermissionGrantListActionInputV1 }
      | { actionId: 'plugins.permissions.grants.request'; input: PluginPermissionGrantRequestActionInputV1 }
      | { actionId: 'plugins.permissions.grants.grant'; input: PluginPermissionGrantGrantActionInputV1 }
      | { actionId: 'plugins.permissions.grants.revoke'; input: PluginPermissionGrantRevokeActionInputV1 }
      | { actionId: 'plugins.permissions.grants.dismissRequest'; input: PluginPermissionGrantDismissRequestActionInputV1 }
    )
  >) => Promise<unknown>;

  /**
   * Canonical endpoint owner for the closed webhook Action family. HTTP and
   * Account authentication stay below this Action boundary; callers arrive
   * here with host-stamped provenance only.
   */
  pluginWebhookAction?: (args: PluginWebhookActionArgs) => Promise<unknown>;

  /**
   * The one Home family port: Home governance and Team intents both travel to
   * one exact Home over the host's existing server-Account request authority.
   * The Home's transaction — never this port — decides authority, feature
   * availability and conflict, so a host implements reachability only.
   */
  homeDomainAction?: (args: Readonly<{
    actionId: HomeDomainActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /** Mounted client view owner. Headless hosts leave this port absent. */
  scopeAction?: (args: Readonly<{
    actionId: ScopeActionId;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;

  connectedServiceAction?: (args: Readonly<{
    actionId: ConnectedServiceConfigurationActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /** The answering client's declared-preference owner; Account writes retain captured Account scope. */
  settingsDeclarationAction?: (args: Readonly<{
    actionId: SettingsDeclarationActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;

  /** The answering client's canonical Voice owner; daemon and headless hosts have no microphone. */
  voiceConversationAction?: (args: Readonly<{
    actionId: VoiceConversationActionId;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;

  /** Compound webhook edits through the captured Account's canonical settings writer. */
  notificationConfigurationAction?: (args: Readonly<{
    actionId: NotificationConfigurationActionId; input: unknown; context: ActionExecutorContext;
  }>) => Promise<unknown>;
  /** The answering app's mounted update owner; no separate installation engine. */
  appUpdateAction?: (args: Readonly<{
    actionId: AppUpdateActionId; input: unknown; context: ActionExecutorContext;
  }>) => Promise<unknown>;

  /** Client-owned Inbox acknowledgement and draft deletion; headless hosts leave it absent. */
  appShellAction?: (args: Readonly<{
    actionId: AppShellActionId;
    input: unknown;
    context: ActionExecutorContext;
  }>) => Promise<unknown>;

  /**
   * The one Session-access family port.
   *
   * Grants, Team context, responsibility and public links are all decided by the
   * Home that owns the Session, so a host implements reachability to one exact
   * Account scope and nothing else. Authority, availability and staleness stay
   * below this port with the host's transport, and the canonical result schema
   * is validated once at the executor's terminal output boundary.
   */
  sessionAccessAction?: (args: Readonly<{
    actionId: SessionAccessActionId;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /** Canonical owner for caller-scoped Event definition, admission, and source-status Actions. */
  automationEventAction?: (args: AutomationEventActionArgs) => Promise<unknown>;

  /** Canonical owner for plugin-originated Automation conversation admission. */
  automationConversationAction?: (args: AutomationConversationActionArgs) => Promise<unknown>;

  /**
   * The one Session Board family port. Each executor host implements it once
   * over the shared pure Board semantics with its own incumbent record
   * transport and Session encryption context: the UI over its exact-Home
   * repository, the CLI/daemon over the System Records host-V1 routes. It is
   * absent until that host's Board producer exists, and the executor then
   * returns the canonical unsupported result rather than running without a
   * proven authority and policy path.
   */
  sessionBoardAction?: (args: Readonly<{
    actionId: SessionBoardActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<SessionBoardActionPortResultV1>;

  /**
   * One host-stamped current-Session presentation seam. The host resolves the
   * exact live Session from context and delegates to the incumbent presentation
   * service, which remains the sole binding/currentness/dedupe/ack owner.
   */
  currentSessionPresentationApply?: (args: Readonly<{
    input: CurrentSessionPresentationActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /**
   * The one Session human-discussion family port. Each executor host implements
   * it once over its own incumbent authenticated transport and Session
   * encryption context: the UI over its exact-Home repository, the CLI/daemon
   * over its authenticated Account HTTP adapter. The host seals and opens
   * discussion content through the existing Session cipher, so the Action layer
   * carries only strict semantic plaintext.
   *
   * It is absent until that host's discussion producer exists, and the executor
   * then returns the canonical unsupported result rather than running without a
   * proven authority and policy path.
   */
  sessionDiscussionAction?: (args: Readonly<{
    actionId: SessionDiscussionActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /**
   * One Account-server-owned transport for all personal Machine Pool intents.
   * The executor parses the caller input through `MachinePoolActionInputSchemasV1`
   * before dispatching, so the port receives a parsed pool input and never an
   * `unknown` its host has to re-narrow at the transport call.
   */
  machinePoolAction?: (args: Readonly<{
    actionId: MachinePoolActionIdV1;
    input: MachinePoolActionInputV1;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /**
   * One exact-Home transport for the three Temporary computer activation
   * intents. The creator surface already owns the captured Home scope and the
   * activation client, so the executor keeps admission, the feature decision,
   * approval and result validation and delegates only the request.
   */
  ephemeralRunnerAction?: (args: Readonly<{
    actionId: EphemeralRunnerActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /** Canonical Workflow service adapter; storage/execution remain host-owned. */
  workflowAction?: WorkflowActionExecute;
  /** Document kind validation and key preparation at the authenticated key-holding host. */
  artifactAccessAction?: (args: Readonly<{
    actionId: ArtifactAccessActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  /** Ordinary Account content; authenticated storage and workspace copying remain host-owned. */
  artifactAction?: (args: Readonly<{
    actionId: ArtifactActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<unknown>;

  buildApprovalPreview?: (args: Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    defaultPreview: Readonly<{
      actionId: ActionId;
      actionArgs: unknown;
    }>;
  }>) => Promise<unknown> | unknown;

  // Optional policy hook for fail-closed action disablement.
  isActionEnabled?: (actionId: ActionId, ctx: ActionExecutorContext) => boolean;

  /**
   * Optional approvals routing policy hook.
   *
   * When true, the executor will create an approval request instead of executing the action.
   */
  isActionApprovalRequired?: (actionId: ActionId, ctx: ActionExecutorContext, input?: unknown) => boolean;

  // Server routing resolver (optional)
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>;
