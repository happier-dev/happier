import type { ActionsSettingsV1 } from '../actionSettings.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actionExecutionResult.js';
import type { AgentsBackendsListOutput } from '../agentBackendInventory.js';
import type { ActionId, PluginDevLoopActionIdV1, RuntimeActionIdV1 } from '../actionIds.js';
import type {
  ActionRequiredAuthority,
  ActionSurfaces,
  SessionTranscriptGetResult,
} from '../actionSpecs.js';
import type { ActionUiPlacement } from '../actionUiPlacements.js';
import type { ActionDefinitionV1 } from '../actionDefinitionV1.js';
import type { ExternalActionTargetV1 } from '../externalActionApi.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../../memory/memoryWindow.js';
import type { ApprovalRequestOriginV1, ApprovalRequestV1 } from '../../approvals/approvalRequestV1.js';
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
import type { BackendTargetRefV1 } from '../../backends/targets/backendTargetRef.js';
import type { SessionRollbackTarget } from '../../sessions/rollback.js';
import type { ReviewStartInput } from '../../reviews/reviewStart.js';
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
  SessionHandoffWorkspaceTransfer,
} from '../../sessions/control/handoff/handoffSchemas.js';
import type { SessionContinueWithReplayRpcParams } from '../../sessions/continueWithReplay.js';
import type { SessionForkRpcParams } from '../../sessions/fork.js';
import type {
  PluginSessionInputAttachmentV1,
  PluginSessionInputSourceV1,
  SessionInputCausalPermissionAuthorityV1,
} from '../../sessions/messages/sessionInputAdmission.js';
import type { PendingRequestedActionV1 } from '../../sessions/pending/pendingRequestedActionV1.js';
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
  AccountApiTokensCreateActionOutputV1,
  AccountApiTokensListActionInputV1,
  AccountApiTokensListActionOutputV1,
  AccountApiTokensRevokeActionInputV1,
  AccountApiTokensRevokeActionOutputV1,
  AccountApiTokensRevokeAllActionInputV1,
  AccountApiTokensRevokeAllActionOutputV1,
} from '../../auth/accountApiTokens.js';
import type { PluginMachineMaterializationRefV1 } from '../../plugins/availability/materializationRefV1.js';
import type { PluginSettingsAdministrationActionIdV1 } from '../../plugins/settingsAdministration.js';

export type {
  ActionExecuteFailure,
  ActionExecuteResult,
} from '../actionExecutionResult.js';

export type ActionPreparedInvocation = Readonly<{
  run: () => Promise<ActionExecuteResult>;
}>;

export type ActionPrepareResult =
  | Readonly<{ kind: 'ready'; invocation: ActionPreparedInvocation }>
  | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>;

export type RuntimeActionExecutionFamily =
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
   * Re-enter the exact current Action boundary for SCM's bounded execution
   * consumption. This carries the original host-stamped context; it is not a
   * second dispatcher, Session adapter, or execution-run service.
   */
  executeCanonicalAction: (
    actionId: Extract<ActionId, 'execution.run.start' | 'execution.run.get'>,
    input: unknown,
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
  /**
   * Exact host-stamped admitted plugin generation. It is optional only for
   * legacy in-process callers and is never accepted from Action input.
   */
  immutableGenerationId?: string;
  /**
   * Exact host-stamped materialization for a live plugin Action edge. Durable
   * approval replay carries only the persisted plugin/contribution identity;
   * it never persists or substitutes a materialization reference.
   */
  materialization?: PluginMachineMaterializationRefV1;
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
  origin: 'schedule' | 'manual' | 'event' | 'conversation';
}>;

export type ActionCaller =
  | Readonly<{ kind: 'host' }>
  | ActionPluginCaller
  | ActionAutomationRunCaller;

/**
 * Narrow host adapter seam for the existing committed-runtime contributed
 * Action invoker. Selection/currentness/cancellation remain with that owner;
 * the canonical ActionExecutor only validates and admits `action.invoke`.
 */
export type InvokeContributedAction = (request: Readonly<{
  action: import('../../plugins/contributionIdentity.js').PluginContributionIdentityV1;
  input: unknown;
  context: ActionExecutorContext;
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
  /** Caller cancellation for execution and interception. */
  signal?: AbortSignal;

  /** Host-stamped caller identity. Never accepted from plugin action input. */
  actionCaller?: ActionCaller;

  /**
   * Host-stamped admission authority. Public ingress must set this explicitly;
   * it is never Action input and never inferred from a client-provided surface.
   */
  authority?: ActionRequiredAuthority;

  /**
   * Verified public-API credential provenance, stamped only after bearer
   * authentication. It is never accepted from Action input or persisted as an
   * Action-owned identity.
   */
  externalActionCredential?: Readonly<{
    accountId: string;
    principalId: string;
    credentialId: string;
  }>;

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

export type PluginExternalSessionActionId =
  | 'sessions.external.materialize.start'
  | 'sessions.external.status.get'
  | 'sessions.external.operation.status.get'
  | 'sessions.external.operation.cancel'
  | 'sessions.external.operation.resume'
  | 'sessions.external.operation.retry'
  | 'sessions.external.operation.discard'
  | 'sessions.external.follow'
  | 'sessions.external.unfollow'
  | 'sessions.external.backgroundFollow.set';

/**
 * User-facing External Session operations owned by the daemon's fenced host
 * adapter. This intentionally extends, but does not replace, the narrower
 * plugin-provenance Action family: API callers never manufacture a plugin
 * identity merely to reach discovery, linking, transcript, or takeover Start.
 */
export type HostExternalSessionActionId =
  | PluginExternalSessionActionId
  | 'sessions.external.candidates.list'
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
  status: ApprovalRequestV1['status'];
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
  /**
   * Host-only admitted-turn authority carried to the incumbent execution-run
   * manager after the Action executor validates host context. It never enters
   * Action input or a public RPC payload.
   */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
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
  signal?: AbortSignal;
}>;

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
}>;

export type ActionExecutorDeps = Readonly<{
  /**
   * Reads client-local contributed Actions at the discovery boundary. The
   * caller owns currentness; ActionExecutor only composes these definitions
   * with the static host catalog.
   */
  listContributedActionDefinitions?: () => readonly ActionDefinitionV1[];

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
    | Readonly<{ ok: false; errorCode: string; error: string }>
  >;
  executionRunStart: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunList: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunGet: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunSend: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunEnsure?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunEnsureOrStart?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStreamStart?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStreamRead?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStreamCancel?: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunStop: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunAction: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  executionRunWait: (sessionId: string | null, request: any, opts?: ExecutionRunActionOptions) => Promise<unknown>;
  reviewStartInline?: (args: Readonly<{
    sessionId: string;
    engineId: string;
    backendTarget: BackendTargetRefV1;
    instructions: string;
    input: ReviewStartInput;
    serverId?: string | null;
  }>) => Promise<unknown>;
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
  scmActionExecute?: ScmActionExecute;

  // Session navigation/spawn (client-side)
  sessionOpen: (args: Readonly<{
    sessionId: string;
    serverId?: string | null;
    actionRequestId?: string | null;
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
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionHandoffPrepareTarget?: (args: SessionHandoffPrepareTargetRequest) => Promise<unknown>;
  sessionHandoffPrepareTargetResume?: (args: SessionHandoffPrepareTargetResumeRequest) => Promise<unknown>;
  sessionHandoffPrepareTargetResultGet?: (args: SessionHandoffPrepareTargetResultGetRequest) => Promise<unknown>;
  sessionHandoffCommit?: (args: SessionHandoffCommitRequest) => Promise<unknown>;
  sessionHandoffAbort?: (args: SessionHandoffAbortRequest) => Promise<unknown>;
  sessionHandoffStatusGet?: (args: SessionHandoffStatusGetRequest) => Promise<unknown>;
  sessionSpawnNew: (args: SessionSpawnNewInputV2 & Readonly<{
    creationKey: SessionSpawnNewInputV2['creationKey'];
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
    callerPermissionMode?: string | null;
    sessionAgentSpawnPolicyV1?: unknown;
    actionRequestId?: string | null;
    resumeActionRequest?: boolean;
    /** Host-only exact directory-creation authorization from approval replay. */
    sessionCreationDirectoryApproval?: SessionCreationDirectoryApprovalV1 | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
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
   * Portable host transport for a deferred Session-spawn directory approval.
   * It forwards the approval decision to the exact target daemon before this
   * executor mutates the artifact, so the daemon that stamped the persisted
   * proof also rehydrates and consumes it. Public Action input never carries
   * the directory proof.
   */
  sessionSpawnNewDirectoryApprovalReplay?: (args: Readonly<{
    artifactId: string;
    executionTarget: SessionCreationDirectoryApprovalV1['executionTarget'];
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  /**
   * Host-owned replay for a contributed Action's durable API approval. It
   * claims only artifacts whose strict target subject it can re-read; null
   * leaves ordinary ApprovalRequestV1 handling on the existing path.
   */
  targetActionApprovalReplay?: (args: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    signal?: AbortSignal;
  }>) => Promise<ActionExecuteResult | null>;
  /**
   * Host-only persistence compatibility seam. It is called exclusively while
   * executing an existing approved `session.spawn_new` artifact whose args do
   * not satisfy the current strict V2 schema; live Action ingress never uses
   * it. Return null to fail that artifact with invalid_parameters.
   */
  normalizeSessionSpawnNewLegacyApprovalReplay?: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    serverId: string | null;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    input: SessionSpawnNewInputV2;
    legacyMetadataLabel?: string;
  }> | null>;
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
  promptInvocationsList?: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  promptInvocationResolve?: (args: Readonly<{ invocationId: string; argsText?: string }>) => Promise<unknown>;
  machinesList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  serversList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  reviewEnginesList: (args: Readonly<{ sessionId: string; includeDisabled?: boolean }>) => Promise<unknown>;
  /**
   * Resolves the V2 authored Session Agent identity through the current host
   * catalog before a Session-spawn dynamic option source reaches inventory.
   * This is deliberately host-owned: Protocol validates the public target,
   * while the host owns its current contribution catalog and backend key.
   */
  resolveSessionSpawnAgentInventorySelection?: (args: Readonly<{
    agentTarget: AgentExecutionTargetV1;
  }>) => Readonly<{
    agentId: string;
    backendTargetKey: string;
  }> | null;
  agentsBackendsList: (args: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>) => Promise<AgentsBackendsListOutput>;
  agentsModelsList: (args: Readonly<{ agentId?: string; machineId?: string; limit?: number; backendTargetKey?: string }>) => Promise<unknown>;
  agentsConfigOptionsList?: (args: Readonly<{ agentId?: string; machineId?: string; limit?: number; backendTargetKey?: string; modelId?: string }>) => Promise<unknown>;
  agentsSessionModesList?: (args: Readonly<{ agentId?: string; machineId?: string; limit?: number; backendTargetKey?: string }>) => Promise<unknown>;
  spawnProfilesList?: (args: Readonly<{ agentId?: string; backendTargetKey?: string; limit?: number }>) => Promise<unknown>;
  spawnConnectedServicesList?: (args: Readonly<{ agentId?: string; backendTargetKey?: string; includeUnavailable?: boolean }>) => Promise<unknown>;
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
    sessionId: string;
    message: string;
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
    callerPermissionMode?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionTitleSet?: (args: Readonly<{ sessionId: string; title: string; serverId?: string | null }>) => Promise<unknown>;
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
    permissionMode: string;
    serverId?: string | null;
    callerSurface?: keyof ActionSurfaces | null;
    callerPermissionMode?: string | null;
  }>) => Promise<unknown>;
  sessionModelSet?: (args: Readonly<{
    sessionId: string;
    modelId: string;
    providerConnectionId?: string | null;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionArchiveSet?: (args: Readonly<{ sessionId: string; archived: boolean; serverId?: string | null }>) => Promise<unknown>;
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
  sessionWaitIdle?: (args: Readonly<{ sessionId: string; timeoutSeconds?: number; serverId?: string | null }>) => Promise<unknown>;
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
    decision: 'allow' | 'deny';
    requestId?: string | null;
    allowedTools?: readonly string[];
    updatedPermissions?: unknown;
    execPolicyAmendment?: unknown;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
  sessionPermissionRemoteAction?: (args: SessionPermissionRemoteActionArgs) => Promise<unknown>;
  sessionUserActionAnswer?: (args: Readonly<{
    sessionId: string;
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
  sessionTargetPrimarySet?: (args: Readonly<{ sessionId: string | null }>) => Promise<unknown>;
  sessionTargetTrackedSet?: (args: Readonly<{ sessionIds: readonly string[] }>) => Promise<unknown>;
  sessionList: (args: Readonly<{
    limit?: number;
    cursor?: string | null;
    includeLastMessagePreview?: boolean;
    activeOnly?: boolean;
    archivedOnly?: boolean;
    includeSystem?: boolean;
    resumableOnly?: boolean;
    includeRows?: boolean;
  }>) => Promise<unknown>;
  sessionActivityGet: (args: Readonly<{ sessionId: string; windowSeconds?: number }>) => Promise<unknown>;
  sessionRecentMessagesGet: (args: Readonly<{
    sessionId: string;
    defaultSessionId?: string | null;
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
  daemonMemorySearch: (args: Readonly<{ machineId: string; query: MemorySearchQueryV1; serverId?: string | null }>) => Promise<MemorySearchResultV1>;
  daemonMemoryGetWindow: (args: Readonly<{
    machineId: string;
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    serverId?: string | null;
  }>) => Promise<MemoryWindowV1>;
  daemonMemoryEnsureUpToDate: (args: Readonly<{ machineId: string; sessionId?: string; serverId?: string | null }>) => Promise<unknown>;

  // Approval queue (optional)
  approvalsList?: (args: Readonly<{
    status?: ApprovalRequestV1['status'] | null;
    limit?: number | null;
    serverId?: string | null;
  }>) => Promise<ApprovalQueueListResultV1>;
  approvalsCreate?: (args: Readonly<{ request: ApprovalRequestV1; serverId?: string | null }>) => Promise<{ artifactId: string }>;
  approvalsGet?: (args: Readonly<{ artifactId: string; serverId?: string | null }>) => Promise<ApprovalRequestV1 | null>;
  approvalsUpdate?: (args: Readonly<{ artifactId: string; request: ApprovalRequestV1; serverId?: string | null }>) => Promise<{ ok: true } | { ok: false; errorCode: string; error: string }>;
  approvalsResolveBlockingDecision?: (args: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    request: ApprovalRequestV1;
    serverId?: string | null;
  }>) => Promise<{ resolved: boolean }>;
  approvalsWaitForDecision?: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<
    | { decision: 'approve'; request: ApprovalRequestV1 }
    | { decision: 'reject'; request: ApprovalRequestV1; reason?: string }
    | { decision: 'canceled'; request: ApprovalRequestV1; reason?: string }
  >;

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

  /** Canonical owner for caller-scoped Event definition, admission, and source-status Actions. */
  automationEventAction?: (args: AutomationEventActionArgs) => Promise<unknown>;

  /** Canonical owner for plugin-originated Automation conversation admission. */
  automationConversationAction?: (args: AutomationConversationActionArgs) => Promise<unknown>;

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
  isActionApprovalRequired?: (actionId: ActionId, ctx: ActionExecutorContext) => boolean;

  // Server routing resolver (optional)
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>;
