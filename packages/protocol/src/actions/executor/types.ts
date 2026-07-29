import type { ActionsSettingsV1 } from '../actionSettings.js';
import type { ActionId, RuntimeActionIdV1 } from '../actionIds.js';
import type { ActionSurfaces } from '../actionSpecs.js';
import type { ActionUiPlacement } from '../actionUiPlacements.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../../memory/memoryWindow.js';
import type { ApprovalRequestOriginV1, ApprovalRequestV1 } from '../../approvals/approvalRequestV1.js';
import type { PromptRegistryConfiguredSourceV1 } from '../../prompts/library/promptRegistriesV1.js';
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

export type ActionExecuteResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

export type RuntimeActionExecutionFamily =
  | 'browser'
  | 'localServices'
  | 'peerMediation'
  | 'devices.simulator';

export type RuntimeActionDisabledReason = 'runtime_family_unimplemented';

export type ActionExecutorContext = Readonly<{
  /**
   * Used when ActionSpec input permits an optional sessionId and the caller
   * wants to default to a current/active session.
   */
  defaultSessionId?: string | null;

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

export type ActionExecutorDeps = Readonly<{
  // Execution runs (session-scoped RPC)
  executionRunStart: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunList: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunGet: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunSend: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunEnsure?: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunEnsureOrStart?: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunStreamStart?: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunStreamRead?: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunStreamCancel?: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunStop: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunAction: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunWait: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
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
  }>) => Promise<unknown>;
  runtimeActionExecute?: RuntimeActionExecute;

  // Session navigation/spawn (client-side)
  sessionOpen: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionFork: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionContinueWithReplay?: (args: SessionContinueWithReplayRpcParams) => Promise<unknown>;
  sessionRollback: (args: Readonly<{ sessionId: string; serverId?: string | null; target?: SessionRollbackTarget }>) => Promise<unknown>;
  checkpointCodeRollback?: (args: Readonly<{
    request: CheckpointCodeRollbackRequest;
    serverId?: string | null;
  }>) => Promise<CheckpointCodeRollbackResult | unknown>;
  sessionCheckpoint?: (args: Readonly<{
    request: SessionCheckpointRequestV1;
    serverId?: string | null;
  }>) => Promise<SessionCheckpointResultV1 | unknown>;
  sessionRestore?: (args: Readonly<{
    request: SessionRestoreRequestV1;
    serverId?: string | null;
  }>) => Promise<SessionRestoreResultV1 | unknown>;
  sessionHandoffStart?: (args: Readonly<{
    sessionId: string;
    targetMachineId: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionHandoffPrepareTarget?: (args: SessionHandoffPrepareTargetRequest) => Promise<unknown>;
  sessionHandoffPrepareTargetResume?: (args: SessionHandoffPrepareTargetResumeRequest) => Promise<unknown>;
  sessionHandoffPrepareTargetResultGet?: (args: SessionHandoffPrepareTargetResultGetRequest) => Promise<unknown>;
  sessionHandoffCommit?: (args: SessionHandoffCommitRequest) => Promise<unknown>;
  sessionHandoffAbort?: (args: SessionHandoffAbortRequest) => Promise<unknown>;
  sessionHandoffStatusGet?: (args: SessionHandoffStatusGetRequest) => Promise<unknown>;
  sessionSpawnNew: (args: Readonly<{
    tag?: string;
    agentId?: string;
    modelId?: string;
    providerConnectionId?: string | null;
    modelUpdatedAt?: number;
    backendTargetKey?: string;
    backendTarget?: unknown;
    title?: string;
    path?: string;
    directory?: string;
    host?: string;
    machineId?: string;
    serverId?: string;
    initialMessage?: string;
    initialPrompt?: string;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    sessionConfigOptionOverrides?: unknown;
    configOptions?: Record<string, string | number | boolean | null>;
    profileId?: string;
    environmentVariables?: Record<string, string>;
    connectedServices?: unknown;
    connectedServicesUpdatedAt?: number;
    mcpSelection?: unknown;
    transcriptStorage?: 'persisted' | 'direct';
    terminal?: unknown;
    windowsRemoteSessionLaunchMode?: 'hidden' | 'windows_terminal' | 'console';
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    windowsTerminalWindowName?: string;
    runtimeDescriptorV1?: unknown;
    callerSurface?: keyof ActionSurfaces | null;
    callerPermissionMode?: string | null;
    sessionAgentSpawnPolicyV1?: unknown;
    actionRequestId?: string | null;
    resumeActionRequest?: boolean;
  }>) => Promise<unknown>;
  sessionSpawnPicker: (args: Readonly<{
    tag?: string;
    agentId?: string;
    modelId?: string;
    providerConnectionId?: string | null;
    backendTargetKey?: string;
    initialMessage?: string;
  }>) => Promise<unknown>;

  // Local inventory + discovery (voice)
  pathsListRecent: (args: Readonly<{ machineId?: string; limit?: number }>) => Promise<unknown>;
  machinesList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  serversList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  reviewEnginesList: (args: Readonly<{ sessionId: string; includeDisabled?: boolean }>) => Promise<unknown>;
  agentsBackendsList: (args: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>) => Promise<unknown>;
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
    permissionModeOverride?: string;
    modelOverride?: string | null;
    providerConnectionId?: ProviderConnectionId | null;
    wait?: boolean;
    timeoutSeconds?: number;
    serverId?: string | null;
    callerSurface?: keyof ActionSurfaces | null;
    callerPermissionMode?: string | null;
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
  }>) => Promise<unknown>;
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
  }>) => Promise<unknown>;
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
  }>) => Promise<unknown>;
  sessionModeSet: (args: Readonly<{ sessionId: string; modeId: string }>) => Promise<unknown>;
  sessionModesList: (args: Readonly<{ sessionId: string }>) => Promise<unknown>;

  // Voice panel targeting + session query tools
  sessionTargetPrimarySet: (args: Readonly<{ sessionId: string | null }>) => Promise<unknown>;
  sessionTargetTrackedSet: (args: Readonly<{ sessionIds: readonly string[] }>) => Promise<unknown>;
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

  // Provider-neutral session subagent projections (optional until A.12-subagents host owner is wired).
  subagentsList?: (args: Readonly<{ parentSessionId?: string; groupId?: string | null; limit?: number }>) => Promise<unknown>;
  subagentsGet?: (args: Readonly<{ id: string; parentSessionId?: string }>) => Promise<unknown>;
  subagentsWatch?: (args: Readonly<{ parentSessionId?: string; id?: string }>) => Promise<unknown>; // Returns the initial snapshot from the bounded host watcher path.
  subagentsUpsert?: (args: SubagentRefInputV1) => Promise<unknown>;
  subagentsUpdateStatus?: (args: Readonly<{
    id: string;
    parentSessionId?: string;
    status: SubagentStatusV1;
    lifecycleDetail?: SubagentLifecycleDetailV1;
    completedAt?: number;
  }>) => Promise<unknown>;
  subagentsComplete?: (args: Readonly<{
    id: string;
    parentSessionId?: string;
    status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
    lifecycleDetail?: SubagentLifecycleDetailV1;
    completedAt?: number;
  }>) => Promise<unknown>;

  promptDocUpdate?: (args: Readonly<{
    artifactId: string;
    title: string;
    markdown: string;
    folderId?: string | null;
    tags?: readonly string[];
  }>) => Promise<unknown>;
  promptBundleUpdate?: (args: Readonly<{
    artifactId: string;
    title: string;
    skillMarkdown: string;
    folderId?: string | null;
    tags?: readonly string[];
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
  }>) => Promise<unknown>;

  pluginsDevLoopAction?: (args: Readonly<{
    actionId: Extract<ActionId, 'plugins.scaffold' | 'plugins.install' | 'plugins.uninstall' | 'plugins.reload' | 'plugins.list'>;
    input: unknown;
    context: ActionExecutorContext;
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
  isActionApprovalRequired?: (actionId: ActionId, ctx: ActionExecutorContext) => boolean;

  // Server routing resolver (optional)
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>;
