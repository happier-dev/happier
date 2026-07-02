import {
  findActionInputFieldHint,
  filterResolvedActionOptions,
  getActionSpecForCatalogSurface,
  getSerializedActionSpecForSurface,
  searchSerializedActionSpecsForSurface,
  serializeActionFieldOptions,
} from './actionCatalog.js';
import { resolveActionApprovalFlow } from './actionApprovalMetadata.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { resolveRequestedSessionModeId } from './sessionModeIds.js';
import { ActionSurfaceSchema, getActionSpec, isActionSpecSurfacedOn, type ActionSpec, type ActionSurfaces } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../memory/memoryWindow.js';
import {
  ApprovalRequestOriginV1Schema,
  ApprovalRequestV1Schema,
  type ApprovalRequestOriginV1,
  type ApprovalRequestV1,
} from '../approvals/approvalRequestV1.js';
import type { PromptRegistryConfiguredSourceV1 } from '../promptLibrary/promptRegistriesV1.js';
import {
  BackendTargetKeySchema,
  buildBackendTargetKey,
  parseBackendTargetKey,
  type BackendTargetRefV1,
} from '../backendTargets/backendTargetRef.js';
import { BackendTargetKeyV2Schema } from '../backendTargets/backendTargetRefV2.js';
import type { SessionRollbackTarget } from '../sessionRollback.js';
import type { ReviewStartInput } from '../reviews/reviewStart.js';
import {
  ReviewCommentActionIdV1Schema,
  type ReviewCommentActionIdV1,
} from '../reviews/comments/actions.js';
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
  type SessionHandoffStatusGetRequest,
  SessionHandoffWorkspaceTransferSchema,
  type SessionHandoffWorkspaceTransfer,
} from '../sessionControl/handoff/handoffSchemas.js';
import type { SessionContinueWithReplayRpcParams } from '../sessionContinueWithReplay.js';
import { SessionControlErrorCodeSchema } from '../sessionControl/contract.js';
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

export type ActionExecuteResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

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

  /**
   * Optional provenance for approvals created from an in-transcript tool call.
   *
   * The executor validates and session-scopes this before persisting it so
   * unrelated surfaces cannot attach misleading transcript links.
   */
  approvalOrigin?: ApprovalRequestOriginV1 | null;
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
  }>) => Promise<unknown>;

  // Session navigation/spawn (client-side)
  sessionOpen: (args: Readonly<{ sessionId: string }>) => Promise<unknown>;
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
  sessionHandoffPrepareTargetResultGet?: (args: SessionHandoffPrepareTargetResultGetRequest) => Promise<unknown>;
  sessionHandoffCommit?: (args: SessionHandoffCommitRequest) => Promise<unknown>;
  sessionHandoffAbort?: (args: SessionHandoffAbortRequest) => Promise<unknown>;
  sessionHandoffStatusGet?: (args: SessionHandoffStatusGetRequest) => Promise<unknown>;
  sessionSpawnNew: (args: Readonly<{
    tag?: string;
    agentId?: string;
    modelId?: string;
    backendTargetKey?: string;
    title?: string;
    path?: string;
    host?: string;
    initialMessage?: string;
  }>) => Promise<unknown>;
  sessionSpawnPicker: (args: Readonly<{ tag?: string; agentId?: string; modelId?: string; backendTargetKey?: string; initialMessage?: string }>) => Promise<unknown>;

  // Local inventory + discovery (voice)
  pathsListRecent: (args: Readonly<{ machineId?: string; limit?: number }>) => Promise<unknown>;
  machinesList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  serversList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  reviewEnginesList: (args: Readonly<{ sessionId: string; includeDisabled?: boolean }>) => Promise<unknown>;
  agentsBackendsList: (args: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>) => Promise<unknown>;
  agentsModelsList: (args: Readonly<{ agentId?: string; machineId?: string; limit?: number; backendTargetKey?: string }>) => Promise<unknown>;

  // Session messaging (socket message event, server-scoped)
  sessionSendMessage: (args: Readonly<{
    sessionId: string;
    message: string;
    permissionModeOverride?: string;
    modelOverride?: string | null;
    wait?: boolean;
    timeoutSeconds?: number;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionTitleSet?: (args: Readonly<{ sessionId: string; title: string; serverId?: string | null }>) => Promise<unknown>;
  sessionStop?: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionPermissionModeSet?: (args: Readonly<{ sessionId: string; permissionMode: string; serverId?: string | null }>) => Promise<unknown>;
  sessionModelSet?: (args: Readonly<{ sessionId: string; modelId: string; serverId?: string | null }>) => Promise<unknown>;
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
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUsageLimitCheckNow?: (args: Readonly<{
    sessionId: string;
    provider?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUsageLimitSwitchAccountNow?: (args: Readonly<{
    sessionId: string;
    provider?: string;
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
    answers: readonly Readonly<{ question: string; answer: string }>[];
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

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

const ActionSurfaceKeySchema = ActionSurfaceSchema.keyof();

function parseActionSurfaceKey(value: unknown): keyof ActionSurfaces | null {
  const parsed = ActionSurfaceKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function resolveSessionIdFromInput(input: any, ctx: ActionExecutorContext): string | null {
  const sessionId = normalizeId(input?.sessionId);
  if (sessionId) return sessionId;
  const fallback = normalizeId(ctx.defaultSessionId);
  return fallback || null;
}

function mapApprovalCreatedBySurface(surface: ActionExecutorContext['surface']): ApprovalRequestV1['createdBy']['surface'] {
  if (surface === 'voice') return 'voice';
  if (surface === 'session_agent') return 'session_agent';
  if (surface === 'mcp') return 'mcp';
  if (surface === 'cli') return 'cli';
  // UI surfaces (and unknown surfaces) map to `system`.
  return 'system';
}

function buildApprovalSummary(spec: ActionSpec, sessionId: string | null): string {
  const base = String(spec.title ?? '').trim() || String(spec.id);
  return sessionId ? `${base} — ${sessionId}` : base;
}

function buildApprovalMetadata(spec: ActionSpec): NonNullable<ApprovalRequestV1['approval']> {
  return {
    flow: resolveActionApprovalFlow(spec.approval),
    result: spec.approval.result,
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

function isBlockingApprovalRequest(request: ApprovalRequestV1): boolean {
  return request.approval?.flow === 'blocking';
}

function extractListedSessions(value: unknown): readonly Readonly<{ id: string; title: string }>[] {
  const sessions = Array.isArray((value as any)?.sessions)
    ? ((value as any).sessions as readonly Record<string, unknown>[])
    : Array.isArray((value as any)?.items)
      ? ((value as any).items as readonly Record<string, unknown>[])
      : [];

  return sessions
    .map((session) => {
      const id = normalizeId(session?.id);
      const title = normalizeId(session?.title ?? session?.label);
      if (!id || !title) return null;
      return { id, title };
    })
    .filter(Boolean) as readonly Readonly<{ id: string; title: string }>[];
}

type SessionTitleResolution =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'resolved'; sessionId: string }>
  | Readonly<{ kind: 'ambiguous' }>;

async function resolveSessionIdByTitle(
  deps: ActionExecutorDeps,
  rawSessionTitle: unknown,
): Promise<SessionTitleResolution> {
  const sessionTitle = normalizeId(rawSessionTitle);
  if (!sessionTitle) return { kind: 'not_found' };

  let cursor: string | null = null;
  let matchedSessionId: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const response = await deps.sessionList({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const session of extractListedSessions(response)) {
      if (session.title !== sessionTitle) continue;
      if (matchedSessionId && matchedSessionId !== session.id) {
        return { kind: 'ambiguous' };
      }
      matchedSessionId = session.id;
    }
    const nextCursor = normalizeId((response as any)?.nextCursor);
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return matchedSessionId ? { kind: 'resolved', sessionId: matchedSessionId } : { kind: 'not_found' };
}

function resolveServerIdForSession(deps: ActionExecutorDeps, ctx: ActionExecutorContext, sessionId: string): string | null {
  const explicit = normalizeId(ctx.serverId);
  if (explicit) return explicit;
  return deps.resolveServerIdForSessionId ? deps.resolveServerIdForSessionId(sessionId) : null;
}

function normalizeResolvedOptions(value: unknown): readonly Readonly<{ value: string; label: string; description?: string; disabled?: boolean }>[] {
  const items = Array.isArray((value as any)?.items)
    ? ((value as any).items as readonly Record<string, unknown>[])
    : Array.isArray(value)
      ? (value as readonly Record<string, unknown>[])
      : [];

  return items
    .map((item) => {
      const valueCandidate =
        typeof item?.targetKey === 'string'
          ? item.targetKey
          : typeof item?.value === 'string'
            ? item.value
            : typeof item?.id === 'string'
              ? item.id
              : typeof item?.agentId === 'string'
                ? item.agentId
                : typeof item?.engineId === 'string'
                  ? item.engineId
                  : null;
      if (!valueCandidate) return null;
      const labelCandidate =
        typeof item?.label === 'string'
          ? item.label
          : typeof item?.title === 'string'
            ? item.title
            : valueCandidate;
      const descriptionCandidate = typeof item?.description === 'string' ? item.description : undefined;
      const disabledCandidate =
        item?.disabled === true || item?.enabled === false ? true : undefined;
      return {
        value: valueCandidate,
        label: labelCandidate,
        ...(descriptionCandidate ? { description: descriptionCandidate } : {}),
        ...(disabledCandidate ? { disabled: true as const } : {}),
      };
    })
    .filter(Boolean) as readonly Readonly<{ value: string; label: string; description?: string; disabled?: boolean }>[];
}

function tryNormalizeExecutionBackendOptionValue(value: string): string | null {
  const normalizedValue = normalizeId(value);
  if (!normalizedValue) return null;
  const candidateKey =
    BackendTargetKeySchema.safeParse(normalizedValue).success || BackendTargetKeyV2Schema.safeParse(normalizedValue).success
      ? normalizedValue
      : buildBackendTargetKey({ kind: 'builtInAgent', agentId: normalizedValue });
  const resolved = resolveActionBackendTargetSelection({ backendTargetKey: candidateKey });
  return resolved.ok ? resolved.selection.backendTargetKey : null;
}

function normalizeExecutionBackendOptionValue(value: string): string {
  const normalized = tryNormalizeExecutionBackendOptionValue(value);
  if (!normalized) {
    throw new Error('invalid_backend_target_option');
  }
  return normalized;
}

function buildAvailableExecutionBackendOptionKeys(value: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const option of normalizeResolvedOptions(value)) {
    if (option.disabled === true) continue;
    const normalized = tryNormalizeExecutionBackendOptionValue(option.value);
    if (!normalized) continue;
    const raw = normalizeId(option.value);
    if (raw) keys.add(raw);
    keys.add(normalized);
  }
  return keys;
}

async function resolveDynamicActionOptions(params: Readonly<{
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  optionsSourceId: string;
  input: Record<string, unknown>;
}>): Promise<ActionExecuteResult> {
  const { deps, ctx, optionsSourceId, input } = params;

  if (optionsSourceId === 'execution.backends.enabled') {
    const result = await deps.agentsBackendsList({
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : { includeDisabled: false }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return {
      ok: true,
      result: normalizeResolvedOptions(result)
        .map((option) => {
          const normalizedValue = tryNormalizeExecutionBackendOptionValue(option.value);
          if (!normalizedValue) {
            return null;
          }
          return {
            ...option,
            value: normalizedValue,
          };
        })
        .filter((option): option is NonNullable<typeof option> => Boolean(option)),
    };
  }

  if (optionsSourceId === 'review.engines.available') {
    const sessionId = resolveSessionIdFromInput(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.reviewEnginesList({
      sessionId,
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'session.modes.available') {
    const sessionId = resolveSessionIdFromInput(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.sessionModesList({ sessionId });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  return { ok: false, errorCode: 'options_source_not_supported', error: 'options_source_not_supported' };
}

type FanoutResultItem = Readonly<{
  key: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  error?: string;
}>;

function normalizeSuccessfulFanoutStartResult(result: unknown): unknown {
  if (
    result
    && typeof result === 'object'
    && (result as any).ok === true
    && (result as any).data
    && typeof (result as any).data === 'object'
  ) {
    return (result as any).data;
  }
  return result;
}

function readFanoutStartError(result: unknown): { errorCode?: string; error: string } {
  const errorCode =
    result
    && typeof result === 'object'
    && typeof (result as any).errorCode === 'string'
      ? String((result as any).errorCode)
      : result
        && typeof result === 'object'
        && typeof (result as any).code === 'string'
          ? String((result as any).code)
          : undefined;
  const error =
    result
    && typeof result === 'object'
    && typeof (result as any).error === 'string'
      ? String((result as any).error)
      : result
        && typeof result === 'object'
        && typeof (result as any).message === 'string'
          ? String((result as any).message)
          : 'execution_run_failed';
  return {
    error,
    ...(errorCode ? { errorCode } : {}),
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
        const result = normalizeSuccessfulFanoutStartResult(rawResult);
        if (result && typeof result === 'object' && (result as any).ok === false) {
          return {
            key,
            ok: false,
            ...readFanoutStartError(result),
          };
        }
        if (
          result
          && typeof result === 'object'
          && (
            typeof (result as any).runId !== 'string'
            || typeof (result as any).callId !== 'string'
            || typeof (result as any).sidechainId !== 'string'
          )
        ) {
          return {
            key,
            ok: false,
            ...readFanoutStartError(result),
          };
        }
        return { key, ok: true, result };
      } catch (error) {
        return { key, ok: false, error: error instanceof Error ? error.message : 'execution_run_failed' };
      }
    }),
  );
  return results;
}

function buildApprovalDecisionResult(request: ApprovalRequestV1): ActionExecuteResult {
  return {
    ok: true,
    result: {
      ok: true,
      status: request.status,
      ...(request.execution ? { execution: request.execution } : {}),
    },
  };
}

function buildActionExecuteResultFromRecordedApprovalExecution(request: ApprovalRequestV1): ActionExecuteResult | null {
  if (!request.execution) return null;
  if (request.execution.ok) {
    return { ok: true, result: request.execution.result };
  }
  const errorCode = typeof request.execution.errorCode === 'string' && request.execution.errorCode.trim().length > 0
    ? request.execution.errorCode
    : 'approval_execution_failed';
  const error = typeof request.execution.error === 'string' && request.execution.error.trim().length > 0
    ? request.execution.error
    : errorCode;
  return { ok: false, errorCode, error };
}

function resolveApprovalRequestExecutionSurface(createdBySurface: ApprovalRequestV1['createdBy']['surface']): keyof ActionSurfaces | null {
  if (createdBySurface === 'session_agent') return 'session_agent';
  if (createdBySurface === 'mcp') return 'mcp';
  if (createdBySurface === 'voice') return 'voice';
  if (createdBySurface === 'cli') return 'cli';
  return null;
}

function normalizeActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string }> {
  const anyErr = error as any;
  const rawCode = typeof anyErr?.code === 'string' ? String(anyErr.code).trim() : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof anyErr?.message === 'string'
          ? String(anyErr.message)
        : '';

  if (rawCode && SessionControlErrorCodeSchema.safeParse(rawCode).success) {
    return { errorCode: rawCode, error: message || rawCode };
  }

  // Common network failures from axios/node.
  if (rawCode && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(rawCode)) {
    return { errorCode: 'server_unreachable', error: message || 'server_unreachable' };
  }

  return { errorCode: 'action_failed', error: message || 'action_failed' };
}

function readActionFailureEnvelope(result: unknown): Extract<ActionExecuteResult, Readonly<{ ok: false }>> | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const record = result as Readonly<Record<string, unknown>>;
  if (record.ok !== false || typeof record.errorCode !== 'string') {
    return null;
  }
  const errorCode = record.errorCode.trim();
  if (!errorCode) {
    return null;
  }
  const error = typeof record.error === 'string' && record.error.trim().length > 0
    ? record.error
    : errorCode;
  return { ok: false, errorCode, error };
}

function completeSubagentActionResult(result: unknown): ActionExecuteResult {
  const failure = readActionFailureEnvelope(result);
  return failure ?? { ok: true, result };
}

export function createActionExecutor(deps: ActionExecutorDeps): Readonly<{
  execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}> {
  const policyAllowsAction = deps.isActionEnabled ?? ((_id: ActionId, _ctx: ActionExecutorContext) => true);
  const isActionEnabledByPolicy = (spec: ActionSpec, ctx: ActionExecutorContext) => policyAllowsAction(spec.id, ctx);
  const isActionEnabledBySurface = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionSpecSurfacedOn(spec, ctx.surface);
  const isActionEnabled = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionEnabledBySurface(spec, ctx) && isActionEnabledByPolicy(spec, ctx);

  async function executeApprovedActionForRequest(args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    effectiveServerId: string | null;
    ctx: ActionExecutorContext;
  }>): Promise<
    | Readonly<{ ok: true; request: ApprovalRequestV1; exec: ActionExecuteResult }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
  > {
    if (!deps.approvalsUpdate) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
    }

    const latestRequest = deps.approvalsGet
      ? await deps.approvalsGet({ artifactId: args.artifactId, serverId: args.effectiveServerId })
      : null;
    if (latestRequest) {
      const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(latestRequest);
      if (recordedExecutionResult) {
        return { ok: true, request: latestRequest, exec: recordedExecutionResult };
      }
    }

    const requestSurface = parseActionSurfaceKey((args.request as any).requestedSurface)
      ?? resolveApprovalRequestExecutionSurface(args.request.createdBy.surface);
    const requestDefaultSessionId = typeof args.request.createdBy.sessionId === 'string' ? args.request.createdBy.sessionId.trim() : '';
    const exec = requestSurface
      ? await execute(args.request.actionId, args.request.actionArgs, {
          ...args.ctx,
          ...(args.effectiveServerId ? { serverId: args.effectiveServerId } : {}),
          ...(requestDefaultSessionId ? { defaultSessionId: requestDefaultSessionId } : {}),
          surface: requestSurface,
          placement: null,
          bypassApprovals: true,
        })
      : { ok: false as const, errorCode: 'approval_execution_surface_invalid', error: 'approval_execution_surface_invalid' };
    const executedAtMs = Date.now();
    const nextExecuted: ApprovalRequestV1 = {
      ...args.request,
      status: exec.ok ? 'executed' : 'failed',
      updatedAtMs: executedAtMs,
      execution: exec.ok
        ? { executedAtMs, ok: true, result: (exec as any).result }
        : { executedAtMs, ok: false, errorCode: (exec as any).errorCode, error: (exec as any).error },
    };

    const updated = await deps.approvalsUpdate({ artifactId: args.artifactId, request: nextExecuted, serverId: args.effectiveServerId });
    if ((updated as any)?.ok === false) return { ok: false, errorCode: (updated as any).errorCode, error: (updated as any).error };
    return { ok: true, request: nextExecuted, exec };
  }

  async function resolveBlockingDecisionIfClaimed(args: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    request: ApprovalRequestV1;
    serverId: string | null;
  }>): Promise<boolean> {
    const resolved = await deps.approvalsResolveBlockingDecision?.({
      artifactId: args.artifactId,
      decision: args.decision,
      request: args.request,
      serverId: args.serverId,
    });
    return resolved?.resolved === true;
  }

  const execute = async (actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult> => {
    const ctx: ActionExecutorContext = context ?? {};

    const spec = getActionSpec(actionId);
    const approvalRouting = resolveActionApprovalRouting({
      actionId,
      spec,
      context: ctx,
      requiredByPolicy: ctx.bypassApprovals ? false : deps.isActionApprovalRequired?.(actionId, ctx) === true,
    });
    const isApprovalAction = isApprovalActionId(actionId);
    if (!isActionEnabled(spec, ctx)) {
      return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
    }
    const parsed = (spec.inputSchema as any).safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }

    try {
      if (approvalRouting.required && !isApprovalAction) {
        if (!deps.approvalsCreate) {
          return { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' };
        }

        const now = Date.now();
        const targetSessionId = resolveSessionIdFromInput(parsed.data, ctx);
        const requestedSurface = parseActionSurfaceKey(ctx.surface);
        const requestingSessionId = resolvePolicyApprovalRequestingSessionId(ctx.approvalOrigin, ctx, targetSessionId);
        const approvalOrigin = resolveApprovalOriginForRequest(ctx.approvalOrigin, requestingSessionId);
        const createdBy = {
          surface: mapApprovalCreatedBySurface(ctx.surface ?? null),
          ...(requestingSessionId ? { sessionId: requestingSessionId } : {}),
        } as const;

        const request: ApprovalRequestV1 = {
          v: 1,
          status: 'open',
          createdAtMs: now,
          updatedAtMs: now,
          createdBy,
          ...(requestedSurface ? { requestedSurface } : {}),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          approval: {
            flow: approvalRouting.flow,
            result: approvalRouting.result,
          },
          actionId,
          actionArgs: parsed.data,
          summary: buildApprovalSummary(spec, targetSessionId),
          preview: { actionId, actionArgs: parsed.data },
          ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
        };

        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        const artifactId = normalizeId((res as any)?.artifactId);
        if (approvalRouting.flow === 'blocking') {
          if (!deps.approvalsWaitForDecision || !deps.approvalsUpdate) {
            return { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' };
          }

          const effectiveServerId = normalizeId(ctx.serverId) || null;
          const decision = await deps.approvalsWaitForDecision({
            artifactId,
            request,
            serverId: effectiveServerId,
          });

          if (decision.decision === 'reject' || decision.decision === 'canceled') {
            const nowRejected = Date.now();
            const nextRequest: ApprovalRequestV1 = {
              ...decision.request,
              status: decision.decision === 'reject' ? 'rejected' : 'canceled',
              updatedAtMs: nowRejected,
              ...(decision.decision === 'reject'
                ? { decision: { kind: 'reject' as const, decidedAtMs: nowRejected } }
                : {}),
            };
            if (decision.request.status === 'open') {
              const updated = await deps.approvalsUpdate({ artifactId, request: nextRequest, serverId: effectiveServerId });
              if ((updated as any)?.ok === false) return { ok: false, errorCode: (updated as any).errorCode, error: (updated as any).error };
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
            if ((approved as any)?.ok === false) {
              return { ok: false, errorCode: (approved as any).errorCode, error: (approved as any).error };
            }
          }

          const executed = await executeApprovedActionForRequest({
            artifactId,
            request: approvedRequest,
            effectiveServerId,
            ctx,
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

      // Switch by actionId; keep substrate generic.
      const reviewCommentActionId = ReviewCommentActionIdV1Schema.safeParse(actionId);
      if (reviewCommentActionId.success) {
        if (!deps.reviewCommentAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const serverId = normalizeId(ctx.serverId) || null;
        const result = await deps.reviewCommentAction({
          actionId: reviewCommentActionId.data,
          input: parsed.data,
          ...(serverId ? { serverId } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (actionId === 'review.start') {
        const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const serverId = resolveServerIdForSession(deps, ctx, sessionId);
        const opts = serverId ? { serverId } : undefined;

        const reviewInput = parsed.data as ReviewStartInput;
        const engineIds = reviewInput.engineIds;
        const instructions = reviewInput.instructions.trim();
        const permissionMode = reviewInput.permissionMode;
        const intentInputBase = { ...reviewInput };
        const runLocation = reviewInput.runLocation;

        if (runLocation === 'current_session') {
          if (engineIds.length !== 1) {
            return {
              ok: false,
              errorCode: 'inline_review_requires_single_engine',
              error: 'inline_review_requires_single_engine',
            };
          }
          if (!deps.reviewStartInline) {
            return {
              ok: false,
              errorCode: 'inline_review_not_supported',
              error: 'inline_review_not_supported',
            };
          }

          const engineId = engineIds[0]!;
          const result = await deps.reviewStartInline({
            sessionId,
            engineId,
            backendTarget: parseBackendTargetKey(normalizeExecutionBackendOptionValue(engineId)),
            instructions,
            input: intentInputBase,
            ...(serverId ? { serverId } : {}),
          });
          if (result && typeof result === 'object' && (result as Record<string, unknown>).ok === false) {
            const record = result as Record<string, unknown>;
            const errorCode = typeof record.errorCode === 'string' ? record.errorCode : 'action_failed';
            const error = typeof record.error === 'string' ? record.error : errorCode;
            return { ok: false, errorCode, error };
          }
          return { ok: true, result };
        }

        const availableReviewEngineKeys = buildAvailableExecutionBackendOptionKeys(await deps.reviewEnginesList({
          sessionId,
          includeDisabled: false,
        }));

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
              };
            }
            return deps.executionRunStart(
              sessionId,
              {
                intent: 'review',
                backendTarget: parseBackendTargetKey(normalizedBackendTargetKey),
                instructions,
                permissionMode,
                retentionPolicy: 'resumable',
                runClass: 'bounded',
                // Reviews should stream sidechain progress (and tool traffic) into the parent session.
                ioMode: 'streaming',
                intentInput: { ...intentInputBase, engineId },
              },
              opts,
            );
          },
        });

        return { ok: true, result: { intent: 'review', sessionId, results } };
      }

      if (actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start' || actionId === 'voice_agent.start') {
        const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const serverId = resolveServerIdForSession(deps, ctx, sessionId);
        const opts = serverId ? { serverId } : undefined;

        const backendTargetKeys: readonly string[] = Array.isArray((parsed.data as any).backendTargetKeys)
          ? (parsed.data as any).backendTargetKeys
          : [];
        const instructions = String((parsed.data as any).instructions ?? '').trim();
        const intent: 'plan' | 'delegate' | 'voice_agent' =
          actionId === 'subagents.plan.start' ? 'plan' : actionId === 'subagents.delegate.start' ? 'delegate' : 'voice_agent';
        const permissionModeDefault = intent === 'delegate' ? 'workspace_write' : 'read_only';

          const results = await fanoutStarts({
            keys: backendTargetKeys,
            startOne: async (backendTargetKey) =>
              deps.executionRunStart(
                sessionId,
                {
                  intent,
                  backendTarget: parseBackendTargetKey(backendTargetKey),
                  instructions,
                  permissionMode: (parsed.data as any).permissionMode ?? permissionModeDefault,
                  retentionPolicy: (parsed.data as any).retentionPolicy ?? 'ephemeral',
                  runClass: (parsed.data as any).runClass ?? 'bounded',
                  ioMode: (parsed.data as any).ioMode ?? 'request_response',
                  intentInput: { ...(parsed.data as any), backendTargetKey },
                },
                opts,
              ),
          });

          return { ok: true, result: { intent, sessionId, results } };
        }

        if (actionId === 'action.spec.search') {
          return {
            ok: true,
            result: {
              actionSpecs: searchSerializedActionSpecsForSurface({
                surface: ctx.surface ?? null,
                query: typeof (parsed.data as any).query === 'string' ? (parsed.data as any).query : '',
                limit: typeof (parsed.data as any).limit === 'number' ? (parsed.data as any).limit : undefined,
                isActionEnabled: (id) => isActionEnabled(getActionSpec(id), ctx),
              }),
            },
          };
        }

        if (actionId === 'action.spec.get') {
          try {
            const requested = getSerializedActionSpecForSurface({
              id: String((parsed.data as any).id) as ActionId,
              surface: ctx.surface ?? null,
              isActionEnabled: (id) => isActionEnabled(getActionSpec(id), ctx),
            });
            if (!requested) {
              return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
            }
            return { ok: true, result: { actionSpec: requested } };
          } catch {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
        }

        if (actionId === 'action.options.resolve') {
          const actionIdRaw = normalizeId((parsed.data as any).actionId);
          const fieldPath = normalizeId((parsed.data as any).fieldPath);
          const directOptionsSourceId = normalizeId((parsed.data as any).optionsSourceId);
          let optionsSourceId = directOptionsSourceId;

          if (actionIdRaw && fieldPath) {
            try {
              getActionSpec(actionIdRaw as ActionId);
            } catch {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
            const requestedSpec = getActionSpecForCatalogSurface({
              id: actionIdRaw as ActionId,
              surface: ctx.surface ?? null,
              isActionEnabled: (id) => isActionEnabled(getActionSpec(id), ctx),
            });
            if (!requestedSpec) {
              return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
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
                  options: filterResolvedActionOptions(staticOptions, parsed.data as Record<string, unknown>),
                },
              };
            }

            optionsSourceId = normalizeId((field as any).optionsSourceId) || directOptionsSourceId;
          }

          if (!optionsSourceId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }

          const dynamic = await resolveDynamicActionOptions({
            deps,
            ctx,
            optionsSourceId,
            input: parsed.data as Record<string, unknown>,
          });
          if (!dynamic.ok) return dynamic;

          return {
            ok: true,
            result: {
              actionId: actionIdRaw || null,
              fieldPath: fieldPath || null,
              optionsSourceId,
              options: filterResolvedActionOptions(
                dynamic.result as readonly Readonly<{ value: string; label: string; description?: string; disabled?: boolean }>[] ,
                parsed.data as Record<string, unknown>,
              ),
            },
          };
        }

        if (actionId === 'sessions.subagents.list') {
          if (!deps.subagentsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.list' };
          }
          const parentSessionId = normalizeId((parsed.data as any).parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsList({
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'groupId')
              ? { groupId: normalizeId((parsed.data as any).groupId) || null }
              : {}),
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
          });
          return completeSubagentActionResult(res);
        }

        if (actionId === 'sessions.subagents.get') {
          if (!deps.subagentsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.get' };
          }
          const parentSessionId = normalizeId((parsed.data as any).parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsGet({
            id: String((parsed.data as any).id),
            ...(parentSessionId ? { parentSessionId } : {}),
          });
          return completeSubagentActionResult(res);
        }

        if (actionId === 'sessions.subagents.watch') {
          if (!deps.subagentsWatch) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.watch' };
          }
          const parentSessionId = normalizeId((parsed.data as any).parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsWatch({
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(normalizeId((parsed.data as any).id) ? { id: normalizeId((parsed.data as any).id) } : {}),
          });
          return completeSubagentActionResult(res);
        }

        if (actionId === 'sessions.subagents.upsert') {
          if (!deps.subagentsUpsert) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.upsert' };
          }
          const res = await deps.subagentsUpsert(parsed.data as SubagentRefInputV1);
          return completeSubagentActionResult(res);
        }

        if (actionId === 'sessions.subagents.updateStatus') {
          if (!deps.subagentsUpdateStatus) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.updateStatus' };
          }
          const res = await deps.subagentsUpdateStatus(parsed.data as {
            id: string;
            parentSessionId: string;
            status: SubagentStatusV1;
            lifecycleDetail?: SubagentLifecycleDetailV1;
            completedAt?: number;
          });
          return completeSubagentActionResult(res);
        }

        if (actionId === 'sessions.subagents.complete') {
          if (!deps.subagentsComplete) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.complete' };
          }
          const res = await deps.subagentsComplete(parsed.data as {
            id: string;
            parentSessionId: string;
            status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
            lifecycleDetail?: SubagentLifecycleDetailV1;
            completedAt?: number;
          });
          return completeSubagentActionResult(res);
        }

        if (actionId === 'execution.run.start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;

          const { sessionId: _ignored, ...request } = parsed.data as any;
          const res = await deps.executionRunStart(sessionId, request, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.list') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunList(sessionId, parsed.data, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.get') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunGet(sessionId, { runId: (parsed.data as any).runId, includeStructured: (parsed.data as any).includeStructured === true }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunSend(sessionId, {
            runId: (parsed.data as any).runId,
            message: (parsed.data as any).message,
            delivery: typeof (parsed.data as any).delivery === 'string'
              ? (parsed.data as any).delivery
              : 'steer_if_supported',
            ...((parsed.data as any).resume === true ? { resume: true } : {}),
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.ensure') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.executionRunEnsure) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.ensure' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunEnsure(sessionId, {
            runId: (parsed.data as any).runId,
            ...((parsed.data as any).resume === true ? { resume: true } : {}),
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.ensure_or_start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.executionRunEnsureOrStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.ensure_or_start' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunEnsureOrStart(sessionId, {
            ...((parsed.data as any).runId ? { runId: (parsed.data as any).runId } : {}),
            ...((parsed.data as any).start ? { start: (parsed.data as any).start } : {}),
            ...((parsed.data as any).resume === true ? { resume: true } : {}),
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.stream.start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.executionRunStreamStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.start' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunStreamStart(sessionId, {
            runId: (parsed.data as any).runId,
            message: (parsed.data as any).message,
            ...((parsed.data as any).displayMessage ? { displayMessage: (parsed.data as any).displayMessage } : {}),
            ...((parsed.data as any).resume === true ? { resume: true } : {}),
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.stream.read') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.executionRunStreamRead) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.read' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunStreamRead(sessionId, {
            runId: (parsed.data as any).runId,
            streamId: (parsed.data as any).streamId,
            ...(typeof (parsed.data as any).cursor === 'number' ? { cursor: (parsed.data as any).cursor } : {}),
            ...(typeof (parsed.data as any).maxEvents === 'number' ? { maxEvents: (parsed.data as any).maxEvents } : {}),
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.stream.cancel') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.executionRunStreamCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.cancel' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunStreamCancel(sessionId, {
            runId: (parsed.data as any).runId,
            streamId: (parsed.data as any).streamId,
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.stop') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunStop(sessionId, { runId: (parsed.data as any).runId }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.action') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunAction(sessionId, { runId: (parsed.data as any).runId, actionId: (parsed.data as any).actionId, input: (parsed.data as any).input }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.wait') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunWait(sessionId, {
            runId: (parsed.data as any).runId,
            ...(typeof (parsed.data as any).timeoutSeconds === 'number' ? { timeoutSeconds: (parsed.data as any).timeoutSeconds } : {}),
            ...(typeof (parsed.data as any).pollIntervalMs === 'number' ? { pollIntervalMs: (parsed.data as any).pollIntervalMs } : {}),
          }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'session.open') {
          const explicitSessionId = normalizeId((parsed.data as any).sessionId);
          const titleResolution = explicitSessionId ? null : await resolveSessionIdByTitle(deps, (parsed.data as any).sessionTitle);
          if (titleResolution?.kind === 'ambiguous') {
            return { ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' };
          }
          const sessionId =
            explicitSessionId || (titleResolution?.kind === 'resolved' ? titleResolution.sessionId : null);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionOpen({ sessionId });
          return { ok: true, result: res };
        }

        if (actionId === 'session.fork') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionFork({ sessionId, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.continue_with_replay') {
          if (!deps.sessionContinueWithReplay) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.continue_with_replay' };
          }
          const res = await deps.sessionContinueWithReplay(parsed.data as SessionContinueWithReplayRpcParams);
          return { ok: true, result: res };
        }

        if (actionId === 'session.rollback') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const rawTarget = (parsed.data as any)?.target;
          const target = rawTarget && typeof rawTarget === 'object' ? (rawTarget as SessionRollbackTarget) : undefined;
          const res = await deps.sessionRollback({ sessionId, ...(serverId ? { serverId } : {}), ...(target ? { target } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.checkpoint_code_rollback') {
          if (!deps.checkpointCodeRollback) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint_code_rollback' };
          }
          const request = parsed.data as CheckpointCodeRollbackActionRequest;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.checkpointCodeRollback({ request, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.checkpoint') {
          if (!deps.sessionCheckpoint) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint' };
          }
          const request = parsed.data as SessionCheckpointRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionCheckpoint({ request, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.restore') {
          if (!deps.sessionRestore) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.restore' };
          }
          const request = parsed.data as SessionRestoreRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionRestore({ request, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.handoff') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const targetMachineId = normalizeId((parsed.data as any).targetMachineId);
          if (!targetMachineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionHandoffStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const targetSessionStorageMode =
            (parsed.data as any).targetSessionStorageMode === 'direct' || (parsed.data as any).targetSessionStorageMode === 'persisted'
              ? (parsed.data as any).targetSessionStorageMode
              : undefined;
          const workspaceTransferParsed = SessionHandoffWorkspaceTransferSchema.safeParse((parsed.data as any).workspaceTransfer);
          const workspaceTransfer = workspaceTransferParsed.success ? workspaceTransferParsed.data : undefined;
          const res = await deps.sessionHandoffStart({
            sessionId,
            targetMachineId,
            ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
            ...(workspaceTransfer ? { workspaceTransfer } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.handoff.prepare_target') {
          if (!deps.sessionHandoffPrepareTarget) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target' };
          }
          const res = await deps.sessionHandoffPrepareTarget(parsed.data as SessionHandoffPrepareTargetRequest);
          return { ok: true, result: res };
        }

        if (actionId === 'session.handoff.prepare_target_result.get') {
          if (!deps.sessionHandoffPrepareTargetResultGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target_result.get' };
          }
          const res = await deps.sessionHandoffPrepareTargetResultGet(parsed.data as SessionHandoffPrepareTargetResultGetRequest);
          return { ok: true, result: res };
        }

        if (actionId === 'session.handoff.commit') {
          if (!deps.sessionHandoffCommit) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.commit' };
          }
          const res = await deps.sessionHandoffCommit(parsed.data as SessionHandoffCommitRequest);
          return { ok: true, result: res };
        }

        if (actionId === 'session.handoff.abort') {
          if (!deps.sessionHandoffAbort) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.abort' };
          }
          const res = await deps.sessionHandoffAbort(parsed.data as SessionHandoffAbortRequest);
          return { ok: true, result: res };
        }

        if (actionId === 'session.handoff.status.get') {
          if (!deps.sessionHandoffStatusGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.status.get' };
          }
          const res = await deps.sessionHandoffStatusGet(parsed.data as SessionHandoffStatusGetRequest);
          return { ok: true, result: res };
        }

        if (actionId === 'session.spawn_new') {
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: (parsed.data as any).agentId,
            backendTargetKey: (parsed.data as any).backendTargetKey,
          });
          if (!resolvedSelection.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.sessionSpawnNew({
            ...(((parsed.data as any).tag) ? { tag: String((parsed.data as any).tag) } : {}),
            ...(resolvedSelection.selection.agentId ? { agentId: resolvedSelection.selection.agentId } : {}),
            ...(((parsed.data as any).modelId) ? { modelId: String((parsed.data as any).modelId) } : {}),
            ...(resolvedSelection.selection.backendTargetKey ? { backendTargetKey: resolvedSelection.selection.backendTargetKey } : {}),
            ...(((parsed.data as any).title) ? { title: String((parsed.data as any).title) } : {}),
            ...(((parsed.data as any).path) ? { path: String((parsed.data as any).path) } : {}),
            ...(((parsed.data as any).host) ? { host: String((parsed.data as any).host) } : {}),
            ...(((parsed.data as any).initialMessage) ? { initialMessage: String((parsed.data as any).initialMessage) } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.spawn_picker') {
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: (parsed.data as any).agentId,
            backendTargetKey: (parsed.data as any).backendTargetKey,
          });
          if (!resolvedSelection.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.sessionSpawnPicker({
            ...(((parsed.data as any).tag) ? { tag: String((parsed.data as any).tag) } : {}),
            ...(resolvedSelection.selection.agentId ? { agentId: resolvedSelection.selection.agentId } : {}),
            ...(((parsed.data as any).modelId) ? { modelId: String((parsed.data as any).modelId) } : {}),
            ...(resolvedSelection.selection.backendTargetKey ? { backendTargetKey: resolvedSelection.selection.backendTargetKey } : {}),
            ...(((parsed.data as any).initialMessage) ? { initialMessage: String((parsed.data as any).initialMessage) } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'paths.list_recent') {
          const res = await deps.pathsListRecent({
            ...(((parsed.data as any).machineId) ? { machineId: String((parsed.data as any).machineId) } : {}),
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'machines.list') {
          const res = await deps.machinesList({
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'servers.list') {
          const res = await deps.serversList({
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'review.engines.list') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const res = await deps.reviewEnginesList({
            sessionId,
            ...(typeof (parsed.data as any).includeDisabled === 'boolean' ? { includeDisabled: (parsed.data as any).includeDisabled } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'agents.backends.list') {
          const res = await deps.agentsBackendsList({
            ...(typeof (parsed.data as any).includeDisabled === 'boolean' ? { includeDisabled: (parsed.data as any).includeDisabled } : {}),
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(((parsed.data as any).machineId) ? { machineId: String((parsed.data as any).machineId) } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'agents.models.list') {
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: (parsed.data as any).agentId,
            backendTargetKey: (parsed.data as any).backendTargetKey,
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
            ...(((parsed.data as any).machineId) ? { machineId: String((parsed.data as any).machineId) } : {}),
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(backendTargetKey ? { backendTargetKey } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.message.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const modelOverrideRaw = Object.prototype.hasOwnProperty.call(parsed.data, 'modelOverride')
            ? (parsed.data as any).modelOverride
            : undefined;
          const res = await deps.sessionSendMessage({
            sessionId,
            message: (parsed.data as any).message,
            ...(((parsed.data as any).permissionModeOverride) ? { permissionModeOverride: (parsed.data as any).permissionModeOverride } : {}),
            ...(modelOverrideRaw === null
              ? { modelOverride: null }
              : typeof modelOverrideRaw === 'string' && modelOverrideRaw.trim().length > 0
                ? { modelOverride: modelOverrideRaw.trim() }
                : {}),
            ...(typeof (parsed.data as any).wait === 'boolean' ? { wait: (parsed.data as any).wait } : {}),
            ...(typeof (parsed.data as any).timeoutSeconds === 'number' ? { timeoutSeconds: (parsed.data as any).timeoutSeconds } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.title.set') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionTitleSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.title.set' };
          }
          const title = String((parsed.data as any).title ?? '').trim();
          if (!title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTitleSet({ sessionId, title, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.stop') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionStop) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.stop' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionStop({ sessionId, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.permission_mode.set') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionPermissionModeSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission_mode.set' };
          }
          const permissionMode = normalizeId((parsed.data as any).permissionMode);
          if (!permissionMode) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionModeSet({ sessionId, permissionMode, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.model.set') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionModelSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.model.set' };
          }
          const modelId = normalizeId((parsed.data as any).modelId);
          if (!modelId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionModelSet({ sessionId, modelId, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.archive' || actionId === 'session.unarchive') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
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
          return { ok: true, result: res };
        }

        if (actionId === 'session.status.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionStatusGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.status.get' };
          }
          const live = (parsed.data as any).live === true;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionStatusGet({ sessionId, live, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.work_state.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionWorkStateGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.work_state.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionWorkStateGet({ sessionId, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.goal.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionGoalGet({ sessionId, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.goal.set') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.set' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const data = parsed.data as Record<string, unknown>;
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
          return { ok: true, result: res };
        }

        if (actionId === 'session.goal.clear') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalClear) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.clear' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionGoalClear({ sessionId, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.usageLimit.waitResume.enable') {
          const data = parsed.data as Record<string, unknown>;
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
          return { ok: true, result: res };
        }

        if (actionId === 'session.usageLimit.waitResume.cancel') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.cancel' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const data = parsed.data as Record<string, unknown>;
          const issueFingerprint = data.issueFingerprint;
          const res = await deps.sessionUsageLimitWaitResumeCancel({
            sessionId,
            ...(Object.prototype.hasOwnProperty.call(data, 'issueFingerprint')
              && (typeof issueFingerprint === 'string' || issueFingerprint === null)
              ? { issueFingerprint }
              : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.usageLimit.checkNow') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const data = parsed.data as Record<string, unknown>;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const operation = data.operation === 'switch_account_now' ? 'switch_account_now' : 'check_now';
          const resumePromptMode = data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
            ? data.resumePromptMode
            : undefined;
          if (operation === 'switch_account_now') {
            if (!deps.sessionUsageLimitSwitchAccountNow) {
              return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
            }
            const res = await deps.sessionUsageLimitSwitchAccountNow({
              sessionId,
              ...(typeof data.provider === 'string' && data.provider.trim().length > 0 ? { provider: data.provider.trim() } : {}),
              ...(resumePromptMode ? { resumePromptMode } : {}),
              ...(serverId ? { serverId } : {}),
            });
            return { ok: true, result: res };
          }

          if (!deps.sessionUsageLimitCheckNow) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
          }
          const res = await deps.sessionUsageLimitCheckNow({
            sessionId,
            ...(typeof data.provider === 'string' && data.provider.trim().length > 0 ? { provider: data.provider.trim() } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.vendor_plugin_catalog.list') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionVendorPluginCatalogList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.vendor_plugin_catalog.list' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionVendorPluginCatalogList({
            sessionId,
            ...(typeof (parsed.data as any).cwd === 'string' ? { cwd: (parsed.data as any).cwd } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.skill_catalog.list') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionSkillCatalogList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.skill_catalog.list' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionSkillCatalogList({
            sessionId,
            ...(typeof (parsed.data as any).cwd === 'string' ? { cwd: (parsed.data as any).cwd } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.history.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionEventsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.events.get' };
          }
          const limit = typeof (parsed.data as any).limit === 'number' ? (parsed.data as any).limit : undefined;
          const format = (parsed.data as any).format === 'raw' ? 'raw' : 'compact';
          const includeMeta = (parsed.data as any).includeMeta === true;
          const includeStructuredPayload = (parsed.data as any).includeStructuredPayload === true;
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
          return { ok: true, result: res };
        }

        if (actionId === 'session.transcript.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTranscriptGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.transcript.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTranscriptGet({
            sessionId,
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'cursor') ? { cursor: (((parsed.data as any).cursor ?? null) as any) } : {}),
            ...(typeof (parsed.data as any).direction === 'string' ? { direction: (parsed.data as any).direction } : {}),
            ...(typeof (parsed.data as any).scope === 'string' ? { scope: (parsed.data as any).scope } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'sidechainId') ? { sidechainId: (((parsed.data as any).sidechainId ?? null) as any) } : {}),
            ...(Array.isArray((parsed.data as any).roles) ? { roles: (parsed.data as any).roles } : {}),
            ...(typeof (parsed.data as any).includeTools === 'boolean' ? { includeTools: (parsed.data as any).includeTools } : {}),
            ...(typeof (parsed.data as any).includeReasoning === 'boolean' ? { includeReasoning: (parsed.data as any).includeReasoning } : {}),
            ...(typeof (parsed.data as any).includeEvents === 'boolean' ? { includeEvents: (parsed.data as any).includeEvents } : {}),
            ...(typeof (parsed.data as any).includeMeta === 'boolean' ? { includeMeta: (parsed.data as any).includeMeta } : {}),
            ...(typeof (parsed.data as any).includeStructuredPayload === 'boolean' ? { includeStructuredPayload: (parsed.data as any).includeStructuredPayload } : {}),
            ...(typeof (parsed.data as any).includeRaw === 'boolean' ? { includeRaw: (parsed.data as any).includeRaw } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'maxCharsPerMessage') ? { maxCharsPerMessage: (((parsed.data as any).maxCharsPerMessage ?? null) as any) } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'maxRawPayloadChars') ? { maxRawPayloadChars: (((parsed.data as any).maxRawPayloadChars ?? null) as any) } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.events.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionEventsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.events.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionEventsGet({
            sessionId,
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'cursor') ? { cursor: (((parsed.data as any).cursor ?? null) as any) } : {}),
            ...(typeof (parsed.data as any).direction === 'string' ? { direction: (parsed.data as any).direction } : {}),
            ...(typeof (parsed.data as any).scope === 'string' ? { scope: (parsed.data as any).scope } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'sidechainId') ? { sidechainId: (((parsed.data as any).sidechainId ?? null) as any) } : {}),
            ...(Array.isArray((parsed.data as any).roles) ? { roles: (parsed.data as any).roles } : {}),
            ...(Array.isArray((parsed.data as any).kinds) ? { kinds: (parsed.data as any).kinds } : {}),
            ...(typeof (parsed.data as any).format === 'string' ? { format: (parsed.data as any).format } : {}),
            ...(typeof (parsed.data as any).includeMeta === 'boolean' ? { includeMeta: (parsed.data as any).includeMeta } : {}),
            ...(typeof (parsed.data as any).includeStructuredPayload === 'boolean' ? { includeStructuredPayload: (parsed.data as any).includeStructuredPayload } : {}),
            ...(typeof (parsed.data as any).includeRaw === 'boolean' ? { includeRaw: (parsed.data as any).includeRaw } : {}),
            ...(typeof (parsed.data as any).maxTextChars === 'number' ? { maxTextChars: (parsed.data as any).maxTextChars } : {}),
            ...(typeof (parsed.data as any).maxPayloadChars === 'number' ? { maxPayloadChars: (parsed.data as any).maxPayloadChars } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.wait.idle') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionWaitIdle) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.wait.idle' };
          }
          const timeoutSeconds = typeof (parsed.data as any).timeoutSeconds === 'number' ? (parsed.data as any).timeoutSeconds : 300;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionWaitIdle({ sessionId, timeoutSeconds, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.permission.respond') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          if (!deps.sessionPermissionRespond) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionRespond({
            sessionId,
            decision: (parsed.data as any).decision,
            requestId: Object.prototype.hasOwnProperty.call(parsed.data, 'requestId') ? (((parsed.data as any).requestId ?? null) as any) : null,
            ...(Array.isArray((parsed.data as any).allowedTools) ? { allowedTools: (parsed.data as any).allowedTools } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'updatedPermissions') ? { updatedPermissions: (parsed.data as any).updatedPermissions } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'execPolicyAmendment') ? { execPolicyAmendment: (parsed.data as any).execPolicyAmendment } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
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
            requestId: Object.prototype.hasOwnProperty.call(parsed.data, 'requestId') ? (((parsed.data as any).requestId ?? null) as any) : null,
            answers: Array.isArray((parsed.data as any).answers) ? (((parsed.data as any).answers as unknown[]).map((entry: any) => ({
              question: String(entry?.question ?? ''),
              answer: String(entry?.answer ?? ''),
            }))) : [],
            ...(typeof (parsed.data as any).decision === 'string' ? { decision: (parsed.data as any).decision } : {}),
            ...(typeof (parsed.data as any).reason === 'string' ? { reason: (parsed.data as any).reason } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'updatedPermissions') ? { updatedPermissions: (parsed.data as any).updatedPermissions } : {}),
            ...(Array.isArray((parsed.data as any).allowedTools) ? { allowedTools: (parsed.data as any).allowedTools } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'execPolicyAmendment') ? { execPolicyAmendment: (parsed.data as any).execPolicyAmendment } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.mode.set') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const modeIdRaw = normalizeId((parsed.data as any).modeId);
          const availableModes = normalizeResolvedOptions(await deps.sessionModesList({ sessionId }));
          const modeId = resolveRequestedSessionModeId(modeIdRaw, availableModes);
          if (modeId && availableModes.length > 0) {
            if (!availableModes.some((option) => normalizeId(option.value) === modeId)) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
          }
          const res = await deps.sessionModeSet({ sessionId, modeId });
          return { ok: true, result: res };
        }

        if (actionId === 'session.target.primary.set') {
          const raw = (parsed.data as any).sessionId;
          const explicitSessionId = raw === null ? null : normalizeId(raw);
          const titleResolution =
            raw === null || explicitSessionId ? null : await resolveSessionIdByTitle(deps, (parsed.data as any).sessionTitle);
          if (titleResolution?.kind === 'ambiguous') {
            return { ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' };
          }
          const sessionId =
            raw === null
              ? null
              : explicitSessionId || (titleResolution?.kind === 'resolved' ? titleResolution.sessionId : null);
          const res = await deps.sessionTargetPrimarySet({ sessionId: sessionId || null });
          return { ok: true, result: res };
        }

        if (actionId === 'session.target.tracked.set') {
          const res = await deps.sessionTargetTrackedSet({
            sessionIds: Array.isArray((parsed.data as any).sessionIds) ? (((parsed.data as any).sessionIds as unknown[]).map((v) => String(v))) : [],
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.list') {
          const res = await deps.sessionList({
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'cursor') ? { cursor: (((parsed.data as any).cursor ?? null) as any) } : {}),
            ...(typeof (parsed.data as any).includeLastMessagePreview === 'boolean' ? { includeLastMessagePreview: (parsed.data as any).includeLastMessagePreview } : {}),
            ...(typeof (parsed.data as any).activeOnly === 'boolean' ? { activeOnly: (parsed.data as any).activeOnly } : {}),
            ...(typeof (parsed.data as any).archivedOnly === 'boolean' ? { archivedOnly: (parsed.data as any).archivedOnly } : {}),
            ...(typeof (parsed.data as any).includeSystem === 'boolean' ? { includeSystem: (parsed.data as any).includeSystem } : {}),
            ...(typeof (parsed.data as any).resumableOnly === 'boolean' ? { resumableOnly: (parsed.data as any).resumableOnly } : {}),
            ...(typeof (parsed.data as any).includeRows === 'boolean' ? { includeRows: (parsed.data as any).includeRows } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.activity.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionActivityGet({
            sessionId,
            ...(typeof (parsed.data as any).windowSeconds === 'number' ? { windowSeconds: (parsed.data as any).windowSeconds } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.messages.recent.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTranscriptGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.transcript.get' };
          }
          const includeUser = (parsed.data as any).includeUser !== false;
          const includeAssistant = (parsed.data as any).includeAssistant !== false;
          const roles: ('user' | 'assistant')[] = [];
          if (includeUser) roles.push('user');
          if (includeAssistant) roles.push('assistant');
          const res = await deps.sessionTranscriptGet({
            sessionId,
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'cursor') ? { cursor: (((parsed.data as any).cursor ?? null) as any) } : {}),
            roles,
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'maxCharsPerMessage') ? { maxCharsPerMessage: (((parsed.data as any).maxCharsPerMessage ?? null) as any) } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'memory.search') {
          const machineId = normalizeId((parsed.data as any).machineId);
          if (!machineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const query = (parsed.data as any).query as MemorySearchQueryV1;
          const res = await deps.daemonMemorySearch({ machineId, query, serverId: normalizeId(ctx.serverId) || null });
          return { ok: true, result: res };
        }

        if (actionId === 'memory.get_window') {
          const machineId = normalizeId((parsed.data as any).machineId);
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!machineId || !sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.daemonMemoryGetWindow({
            machineId,
            sessionId,
            seqFrom: Number((parsed.data as any).seqFrom ?? 0),
            seqTo: Number((parsed.data as any).seqTo ?? 0),
            serverId: normalizeId(ctx.serverId) || null,
          });
          return { ok: true, result: res };
        }

        if (actionId === 'memory.ensure_up_to_date') {
          const machineId = normalizeId((parsed.data as any).machineId);
          if (!machineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const sessionId = normalizeId((parsed.data as any).sessionId);
          const res = await deps.daemonMemoryEnsureUpToDate({
            machineId,
            ...(sessionId ? { sessionId } : {}),
            serverId: normalizeId(ctx.serverId) || null,
          });
          return { ok: true, result: res };
        }

        if (actionId === 'ui.voice_global.reset') {
          await deps.resetGlobalVoiceAgent();
          return { ok: true, result: { ok: true } };
        }

        if (actionId === 'ui.voice_agent.teleport') {
          if (!deps.teleportVoiceAgentToSessionRoot) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:ui.voice_agent.teleport' };
          }
          const sessionId = resolveSessionIdFromInput(parsed.data as any, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const result = await deps.teleportVoiceAgentToSessionRoot({ sessionId });
          if ((result as any)?.ok === false) {
            const errorCode = String((result as any)?.code ?? 'voice_teleport_failed');
            return { ok: false, errorCode, error: errorCode };
          }
          return { ok: true, result: { ok: true, sessionId } };
        }

        if (actionId === 'prompt_doc.update') {
          if (!deps.promptDocUpdate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_doc.update' };
          }
          const artifactId = normalizeId((parsed.data as any).artifactId);
          const title = String((parsed.data as any).title ?? '').trim();
          if (!artifactId || !title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.promptDocUpdate({
            artifactId,
            title,
            markdown: String((parsed.data as any).markdown ?? ''),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'folderId')
              ? { folderId: ((parsed.data as any).folderId ?? null) as string | null }
              : {}),
            ...(Array.isArray((parsed.data as any).tags)
              ? { tags: ((parsed.data as any).tags as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
              : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'prompt_bundle.update') {
          if (!deps.promptBundleUpdate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_bundle.update' };
          }
          const artifactId = normalizeId((parsed.data as any).artifactId);
          const title = String((parsed.data as any).title ?? '').trim();
          if (!artifactId || !title) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.promptBundleUpdate({
            artifactId,
            title,
            skillMarkdown: String((parsed.data as any).skillMarkdown ?? ''),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'folderId')
              ? { folderId: ((parsed.data as any).folderId ?? null) as string | null }
              : {}),
            ...(Array.isArray((parsed.data as any).tags)
              ? { tags: ((parsed.data as any).tags as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
              : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'prompt_asset.export') {
          if (!deps.promptAssetExport) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_asset.export' };
          }
          const artifactId = normalizeId((parsed.data as any).artifactId);
          const machineId = normalizeId((parsed.data as any).machineId);
          const assetTypeId = normalizeId((parsed.data as any).assetTypeId);
          const scope = (parsed.data as any).scope === 'project' ? 'project' : (parsed.data as any).scope === 'user' ? 'user' : null;
          if (!artifactId || !machineId || !assetTypeId || !scope) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.promptAssetExport({
            artifactId,
            machineId,
            assetTypeId,
            scope,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(typeof (parsed.data as any).directory === 'string' && String((parsed.data as any).directory).trim().length > 0
              ? { directory: String((parsed.data as any).directory).trim() }
              : {}),
            ...(typeof (parsed.data as any).targetPath === 'string' && String((parsed.data as any).targetPath).trim().length > 0
              ? { targetPath: String((parsed.data as any).targetPath).trim() }
              : {}),
            ...(typeof (parsed.data as any).targetName === 'string' && String((parsed.data as any).targetName).trim().length > 0
              ? { targetName: String((parsed.data as any).targetName).trim() }
              : {}),
            ...((parsed.data as any).installMode === 'copy' || (parsed.data as any).installMode === 'symlink'
              ? { installMode: (parsed.data as any).installMode }
              : {}),
          });
          if ((res as any)?.ok === false) {
            return {
              ok: false,
              errorCode: typeof (res as any).errorCode === 'string' ? (res as any).errorCode : 'action_failed',
              error: typeof (res as any).error === 'string' ? (res as any).error : 'action_failed',
            };
          }
          return { ok: true, result: res };
        }

        if (actionId === 'prompt_registry.install') {
          if (!deps.promptRegistryInstall) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:prompt_registry.install' };
          }
          const machineId = normalizeId((parsed.data as any).machineId);
          const sourceId = normalizeId((parsed.data as any).sourceId);
          const itemId = normalizeId((parsed.data as any).itemId);
          if (!machineId || !sourceId || !itemId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const installTargetRaw = (parsed.data as any).installTarget;
          const installTarget =
            installTargetRaw
            && typeof installTargetRaw === 'object'
            && typeof installTargetRaw.assetTypeId === 'string'
            && typeof installTargetRaw.targetName === 'string'
            && (installTargetRaw.scope === 'project' || installTargetRaw.scope === 'user')
              ? {
                  assetTypeId: installTargetRaw.assetTypeId,
                  scope: installTargetRaw.scope,
                  ...(typeof installTargetRaw.directory === 'string' && installTargetRaw.directory.trim().length > 0
                    ? { directory: installTargetRaw.directory.trim() }
                    : {}),
                  targetName: installTargetRaw.targetName,
                  ...((installTargetRaw.installMode === 'copy' || installTargetRaw.installMode === 'symlink')
                    ? { installMode: installTargetRaw.installMode }
                    : {}),
                }
              : undefined;
          const res = await deps.promptRegistryInstall({
            machineId,
            sourceId,
            itemId,
            configuredSources: Array.isArray((parsed.data as any).configuredSources) ? (parsed.data as any).configuredSources : [],
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(installTarget ? { installTarget } : {}),
          });
          if ((res as any)?.ok === false) {
            return {
              ok: false,
              errorCode: typeof (res as any).errorCode === 'string' ? (res as any).errorCode : 'action_failed',
              error: typeof (res as any).error === 'string' ? (res as any).error : 'action_failed',
            };
          }
          return { ok: true, result: res };
        }

      if (actionId === 'approval.request.list') {
        if (!deps.approvalsList) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const limitRaw = (parsed.data as any).limit;
        const listed = await deps.approvalsList({
          status: typeof (parsed.data as any).status === 'string' ? (parsed.data as any).status : null,
          limit: typeof limitRaw === 'number' ? limitRaw : null,
          serverId: normalizeId(ctx.serverId) || null,
        });
        return { ok: true, result: listed };
      }

      if (actionId === 'approval.request.get') {
        if (!deps.approvalsGet) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const artifactId = normalizeId((parsed.data as any).artifactId);
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
        const targetActionId = (parsed.data as any).actionId as ActionId;
        if (isApprovalActionId(targetActionId)) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }

        // Approvals eligibility is policy-driven (settings/surface), not safety-driven.
        // Safety metadata remains useful for UI copy and defaults, but it is not a hard gate here.
        const targetSpec = getActionSpec(targetActionId);
        const parsedTargetArgs = (targetSpec.inputSchema as any).safeParse((parsed.data as any).actionArgs ?? {});
        if (!parsedTargetArgs.success) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }

        const rawCreatedBy = (parsed.data as any).createdBy as ApprovalRequestV1['createdBy'];
        const forcedSurface = mapApprovalCreatedBySurface(ctx.surface ?? null);
        const actionArgsSessionId = normalizeId((parsedTargetArgs.data as any)?.sessionId);
        const ctxDefaultSessionId = normalizeId(ctx.defaultSessionId);
        const targetSessionId = actionArgsSessionId || ctxDefaultSessionId || null;
        const rawApprovalOrigin = Object.prototype.hasOwnProperty.call(parsed.data, 'origin')
          ? (parsed.data as any).origin
          : ctx.approvalOrigin;
        const requestSessionId = resolveExplicitApprovalRequestingSessionId(rawApprovalOrigin, ctx, targetSessionId);
        const approvalOrigin = resolveApprovalOriginForRequest(rawApprovalOrigin, requestSessionId);
        const rawAgentId = rawCreatedBy && typeof rawCreatedBy === 'object' ? normalizeId((rawCreatedBy as any).agentId) : null;
        const requestedSurface = parseActionSurfaceKey(ctx.surface);
        const createdBy: ApprovalRequestV1['createdBy'] = {
          surface: forcedSurface,
          ...(rawAgentId ? { agentId: rawAgentId } : {}),
          ...(requestSessionId ? { sessionId: requestSessionId } : {}),
        };

        const summary = String((parsed.data as any).summary ?? '').trim();
        if (!summary) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };

        const request: ApprovalRequestV1 = {
          v: 1,
          status: 'open',
          createdAtMs: now,
          updatedAtMs: now,
          createdBy,
          ...(requestedSurface ? { requestedSurface } : {}),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          approval: buildApprovalMetadata(targetSpec),
          actionId: targetActionId,
          actionArgs: parsedTargetArgs.data,
          summary,
          ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
          ...(Object.prototype.hasOwnProperty.call(parsed.data, 'preview') ? { preview: (parsed.data as any).preview } : {}),
        };
        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        return { ok: true, result: res };
      }

      if (actionId === 'approval.request.decide') {
        if (!deps.approvalsGet || !deps.approvalsUpdate) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const artifactId = normalizeId((parsed.data as any).artifactId);
        if (!artifactId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };

        const existingRaw = await deps.approvalsGet({ artifactId, serverId: normalizeId(ctx.serverId) || null });
        if (!existingRaw) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };

        const existingParsed = ApprovalRequestV1Schema.safeParse(existingRaw);
        if (!existingParsed.success) return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
        const existing = existingParsed.data;
        const effectiveServerId = normalizeId(ctx.serverId) || normalizeId(existing.serverId) || null;
        const decision = (parsed.data as any).decision;

        if (isApprovalActionId(existing.actionId)) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const isRecoverableApproved = decision === 'approve'
          && existing.status === 'approved'
          && existing.decision?.kind === 'approve'
          && !existing.execution;

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
          const nextRejected: ApprovalRequestV1 = {
            ...existing,
            status: 'rejected',
            updatedAtMs: now,
            decision: { kind: 'reject', decidedAtMs: now },
          };
          const updated = await deps.approvalsUpdate({ artifactId, request: nextRejected, serverId: effectiveServerId });
          if ((updated as any)?.ok === false) return { ok: false, errorCode: (updated as any).errorCode, error: (updated as any).error };
          if (isBlockingApprovalRequest(nextRejected)) {
            await resolveBlockingDecisionIfClaimed({
              artifactId,
              decision: 'reject',
              request: nextRejected,
              serverId: effectiveServerId,
            });
          }
          return buildApprovalDecisionResult(nextRejected);
        }

        let approvedRequest = existing;
        if (existing.status === 'open') {
          approvedRequest = {
            ...existing,
            status: 'approved',
            updatedAtMs: now,
            decision: { kind: 'approve', decidedAtMs: now },
          };

          const approved = await deps.approvalsUpdate({
            artifactId,
            request: approvedRequest,
            serverId: effectiveServerId,
          });
          if ((approved as any)?.ok === false) {
            return { ok: false, errorCode: (approved as any).errorCode, error: (approved as any).error };
          }
        }

        if (isBlockingApprovalRequest(approvedRequest)) {
          const claimed = await resolveBlockingDecisionIfClaimed({
            artifactId,
            decision: 'approve',
            request: approvedRequest,
            serverId: effectiveServerId,
          });
          if (claimed) return buildApprovalDecisionResult(approvedRequest);
        }

        const executed = await executeApprovedActionForRequest({
          artifactId,
          request: approvedRequest,
          effectiveServerId,
          ctx,
        });
        return executed.ok ? buildApprovalDecisionResult(executed.request) : executed;
      }

      return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    } catch (error) {
      const normalized = normalizeActionExecutorThrownError(error);
      return { ok: false, errorCode: normalized.errorCode, error: normalized.error };
    }
  };

  return {
    execute,
  };
}
