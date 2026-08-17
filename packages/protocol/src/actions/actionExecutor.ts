import {
  findActionInputFieldHint,
  filterResolvedActionOptions,
  searchSerializedActionSpecsForSurface,
  serializeActionFieldOptions,
  serializeActionSpec,
} from './actionCatalog.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { resolveActionOptionSourceRoute } from './actionOptionSources.js';
import { resolveRequestedSessionModeId } from './sessionModeIds.js';
import { ActionSurfaceSchema, getActionSpec, type ActionSpec, type ActionSurfaces, type SessionSpawnNewInput } from './actionSpecs.js';
import { resolveActionSurfaceAvailability, type ActionSurfaceAvailability } from './actionSurfaceAvailability.js';
import { resolveActionApprovalFlow } from './actionApprovalMetadata.js';
import type { ActionId } from './actionIds.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../memory/memoryWindow.js';
import { ApprovalRequestOriginV1Schema, ApprovalRequestV1Schema, type ApprovalRequestOriginV1, type ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import type { PromptRegistryConfiguredSourceV1 } from '../promptLibrary/promptRegistriesV1.js';
import { BackendTargetKeySchema, BackendTargetRefSchema, buildBackendTargetKey, parseBackendTargetKey, type BackendTargetRefV1 } from '../backendTargets/backendTargetRef.js';
import type { SessionRollbackTarget } from '../sessionRollback.js';
import {
  SessionHandoffWorkspaceTransferSchema,
  type SessionHandoffWorkspaceTransfer,
} from '../sessionControl/handoff/handoffSchemas.js';
import {
  SessionControlErrorCodeSchema,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
} from '../sessionControl/contract.js';
import {
  assertNonEscalatingPermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  type PermissionEscalationDecision,
} from './permissionPrivilege.js';
import type { ActionsSettingsV1 } from './actionSettings.js';
import type { ReviewStartInput } from '../reviews/reviewStart.js';
import type { AcpConfigOptionOverridesV1 } from '../sessionMetadata/metadataOverridesV1.js';
import type { ConnectedServiceBindingsV1 } from '../connect/connectedServiceBindings.js';
import {
  PendingRequestedActionV1Schema,
  type PendingRequestedActionV1,
} from '../sessionMessages/pendingRequestedActionV1.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import type { SessionMcpSelectionV1 } from '../mcpServers/sessionSelectionV1.js';
import {
  mergeSpawnConfigOptionAliases,
  type SpawnConfigOptionValue,
} from './sessionSpawnConfigOptions.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from './executionRunActionPermissionMode.js';

/**
 * Resolve the canonical run-start model + config-option selection from an agent-facing action
 * input, reusing the SAME merge owner as session spawn (`mergeSpawnConfigOptionAliases`). Returns
 * the canonical `sessionConfigOptionOverrides` (merging any `configOptions` shorthand) plus the
 * `modelId`. A conflicting value supplied in both the shorthand and canonical forms is a typed
 * `invalid_parameters` rejection — never a silent drop.
 */
function resolveRunStartModelAndConfig(input: Readonly<Record<string, unknown>>):
  | { ok: true; modelId?: string; sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 }
  | { ok: false; error: string } {
  const modelIdRaw = input.modelId;
  const modelId = typeof modelIdRaw === 'string' && modelIdRaw.trim().length > 0 ? modelIdRaw : undefined;
  const merged = mergeSpawnConfigOptionAliases({
    sessionConfigOptionOverrides: (input.sessionConfigOptionOverrides as AcpConfigOptionOverridesV1 | undefined) ?? null,
    configOptions: (input.configOptions as Readonly<Record<string, SpawnConfigOptionValue>> | undefined) ?? null,
  });
  if (!merged.ok) {
    const optionIds = merged.conflicts.map((conflict) => conflict.optionId).join(', ');
    return { ok: false, error: `configOptions must agree with sessionConfigOptionOverrides (${optionIds})` };
  }
  return {
    ok: true,
    ...(modelId ? { modelId } : {}),
    ...(merged.value ? { sessionConfigOptionOverrides: merged.value } : {}),
  };
}

export type ActionExecuteResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

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
   * Optional origin metadata for approval requests created while handling a transcript tool call.
   * Stored on the approval so UI surfaces can link the approval back to the exact tool row.
   */
  approvalOrigin?: ApprovalRequestOriginV1 | null;

  /**
   * Effective permission mode of the running caller. Session-agent actions use this
   * to enforce the non-escalation invariant before host adapters execute work.
   */
  callerPermissionMode?: string | null;

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

type SessionStopActionDependencyResult = Readonly<{
  success: boolean;
  message?: string;
  code?: string;
  recovery?: string;
}> | Readonly<{
  ok: boolean;
  code?: string;
  errorCode?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}>;

export type ActionExecutorDeps = Readonly<{
  // Execution runs (session-scoped RPC)
  executionRunStart: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunList: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunGet: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunSend: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
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

  // Session navigation/spawn (client-side)
  sessionOpen: (args: Readonly<{ sessionId: string }>) => Promise<unknown>;
  sessionFork: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionRollback: (args: Readonly<{ sessionId: string; serverId?: string | null; target?: SessionRollbackTarget }>) => Promise<unknown>;
  sessionHandoffStart?: (args: Readonly<{
    sessionId: string;
    targetMachineId: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionSpawnNew: (args: Readonly<{
    tag?: string;
    tags?: readonly string[];
    agentId?: string;
    backend?: string;
    target?: string;
    modelId?: string;
    backendTargetKey?: string;
    backendTarget?: BackendTargetRefV1;
    title?: string;
    path?: string;
    directory?: string;
    host?: string;
    machineId?: string;
    prompt?: string;
    initialPrompt?: string;
    initialMessage?: string;
    permissionMode?: string;
    agentModeId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    configOptions?: Record<string, string | number | boolean | null>;
    profileId?: string;
    environmentVariables?: Record<string, string>;
    connectedServices?: ConnectedServiceBindingsV1;
    connectedServicesUpdatedAt?: number;
    mcpSelection?: SessionMcpSelectionV1;
    transcriptStorage?: 'persisted' | 'direct';
    terminal?: SessionSpawnNewInput['terminal'];
    windowsRemoteSessionLaunchMode?: 'hidden' | 'windows_terminal' | 'console';
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    windowsTerminalWindowName?: string;
    codexBackendMode?: SessionSpawnNewInput['codexBackendMode'];
    agentRuntimeDescriptorV1?: SessionSpawnNewInput['agentRuntimeDescriptorV1'];
    /** Typed source recipe for a Replay-seeded child; required semantics when present. */
    sourceContext?: SessionSpawnNewInput['sourceContext'];
    surface?: keyof ActionSurfaces | null;
    callerSurface?: keyof ActionSurfaces | null;
    callerPermissionMode?: string | null;
    actionRequestId?: string | null;
    resumeActionRequest?: boolean;
  }>) => Promise<unknown>;
  sessionSpawnPicker: (args: Readonly<{ tag?: string; agentId?: string; modelId?: string; initialMessage?: string }>) => Promise<unknown>;

  // Local inventory + discovery (voice)
  pathsListRecent: (args: Readonly<{ machineId?: string; limit?: number }>) => Promise<unknown>;
  machinesList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  serversList: (args: Readonly<{ limit?: number }>) => Promise<unknown>;
  reviewEnginesList: (args: Readonly<{ sessionId: string; includeDisabled?: boolean }>) => Promise<unknown>;
  agentsBackendsList: (args: Readonly<{ includeDisabled?: boolean; limit?: number }>) => Promise<unknown>;
  agentsModelsList: (args: Readonly<{ agentId: string; machineId?: string; limit?: number; backendTargetKey?: string }>) => Promise<unknown>;
  agentsConfigOptionsList?: (args: Readonly<{ agentId: string; machineId?: string; limit?: number; backendTargetKey?: string; modelId?: string }>) => Promise<unknown>;
  agentsSessionModesList?: (args: Readonly<{ agentId: string; machineId?: string; limit?: number; backendTargetKey?: string }>) => Promise<unknown>;
  sessionsSpawnProfilesList?: (args: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    includeDisabled?: boolean;
    limit?: number;
  }>) => Promise<unknown>;
  sessionsSpawnConnectedServicesList?: (args: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    includeDisabled?: boolean;
    includeUnavailable?: boolean;
    limit?: number;
  }>) => Promise<unknown>;
  sessionsSpawnMcpServersPreview?: (args: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    machineId?: string;
    serverId?: string;
    path?: string;
    directory?: string;
    mcpSelection?: SessionMcpSelectionV1;
    selection?: SessionMcpSelectionV1;
    limit?: number;
  }>) => Promise<unknown>;

  // Session messaging (socket message event, server-scoped)
  sessionSendMessage: (args: Readonly<{
    sessionId: string;
    message: string;
    requestedAction: PendingRequestedActionV1;
    permissionModeOverride?: string;
    modelOverride?: string | null;
    wait?: boolean;
    timeoutSeconds?: number;
    serverId?: string | null;
    callerSurface?: keyof ActionSurfaces | null;
    callerPermissionMode?: string | null;
  }>) => Promise<unknown>;
  sessionTitleSet?: (args: Readonly<{ sessionId: string; title: string; serverId?: string | null }>) => Promise<unknown>;
  sessionStop?: (args: Readonly<{ sessionId: string; serverId?: string | null }>) => Promise<SessionStopActionDependencyResult>;
  sessionPermissionModeSet?: (args: Readonly<{
    sessionId: string;
    permissionMode: string;
    serverId?: string | null;
    callerSurface?: keyof ActionSurfaces | null;
    callerPermissionMode?: string | null;
  }>) => Promise<unknown>;
  sessionModelSet?: (args: Readonly<{ sessionId: string; modelId: string; serverId?: string | null }>) => Promise<unknown>;
  sessionArchiveSet?: (args: Readonly<{ sessionId: string; archived: boolean; serverId?: string | null }>) => Promise<unknown>;
  sessionStatusGet?: (args: Readonly<{ sessionId: string; live?: boolean; serverId?: string | null }>) => Promise<unknown>;
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
  sessionVendorPluginCatalogList?: (args: Readonly<{ sessionId: string; cwd?: string; serverId?: string | null }>) => Promise<unknown>;
  sessionSkillCatalogList?: (args: Readonly<{ sessionId: string; cwd?: string; serverId?: string | null }>) => Promise<unknown>;
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
  sessionUsageLimitConsumeResetCredit?: (args: Readonly<{
    sessionId: string;
    provider?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    serverId?: string | null;
  }>) => Promise<unknown>;
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
    roles?: readonly ('event' | 'agent' | 'user' | 'unknown')[];
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

  // Permission response (session RPC, server-scoped)
  sessionPermissionRespond?: (args: Readonly<{
    sessionId: string;
    decision: 'allow' | 'deny';
    requestId?: string | null;
    serverId?: string | null;
  }>) => Promise<unknown>;
  sessionUserActionAnswer?: (args: Readonly<{
    sessionId: string;
    requestId?: string | null;
    answers: readonly Readonly<{ question: string; values: readonly string[] }>[];
    decision?: 'approve' | 'reject' | 'request_changes';
    reason?: string;
    updatedPermissions?: unknown;
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
  approvalsCreate?: (args: Readonly<{ request: ApprovalRequestV1; serverId?: string | null }>) => Promise<{ artifactId: string }>;
  approvalsGet?: (args: Readonly<{ artifactId: string; serverId?: string | null }>) => Promise<ApprovalRequestV1 | null>;
  approvalsUpdate?: (args: Readonly<{ artifactId: string; request: ApprovalRequestV1; serverId?: string | null }>) => Promise<{ ok: true } | { ok: false; errorCode: string; error: string }>;
  /**
   * Wake a live blocking waiter after approval.request.decide records a decision.
   * Returning resolved=true means the blocking caller owns approved-action execution.
   */
  approvalsResolveBlockingDecision?: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    decision: 'approve' | 'reject';
    serverId?: string | null;
  }>) => Promise<Readonly<{ resolved: boolean }>>;
  approvalsWaitForDecision?: (args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
  }>) => Promise<
    | Readonly<{ decision: 'approve'; request: ApprovalRequestV1 }>
    | Readonly<{ decision: 'reject'; request: ApprovalRequestV1; reason?: string }>
    | Readonly<{ decision: 'canceled'; request: ApprovalRequestV1; reason?: string }>
  >;

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

function readOpaqueIdentifier(raw: unknown): string {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : '';
}

function normalizeUsageLimitActionResult(result: unknown, sessionId: string): unknown {
  return normalizeSessionUsageLimitRecoveryOperationResultV1(result, { sessionId });
}

function resolveApprovalOriginForRequest(
  rawOrigin: unknown,
  expectedSessionId: string | null,
): ApprovalRequestOriginV1 | null {
  if (rawOrigin == null) return null;

  const parsed = ApprovalRequestOriginV1Schema.safeParse(rawOrigin);
  if (!parsed.success) return null;

  const normalizedExpectedSessionId = normalizeId(expectedSessionId);
  if (normalizedExpectedSessionId && parsed.data.sessionId !== normalizedExpectedSessionId) {
    return null;
  }

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

function pickBoolean(input: any, key: string): boolean | undefined {
  return typeof input?.[key] === 'boolean' ? input[key] : undefined;
}

function hasOwn(input: any, key: string): boolean {
  return Boolean(input && Object.prototype.hasOwnProperty.call(input, key));
}

const ActionSurfaceKeySchema = ActionSurfaceSchema.keyof();

function parseActionSurfaceKey(value: unknown): keyof ActionSurfaces | null {
  const parsed = ActionSurfaceKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isSessionAgentCaller(ctx: ActionExecutorContext): boolean {
  return ctx.surface === 'session_agent';
}

function createPermissionPolicyResult(
  ctx: ActionExecutorContext,
  decision: Exclude<PermissionEscalationDecision, { ok: true }>,
): ActionExecuteResult {
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

function assertSessionAgentPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes?: readonly string[],
): PermissionEscalationDecision | null {
  if (!isSessionAgentCaller(ctx)) return null;
  return assertNonEscalatingPermissionMode({
    requestedMode,
    callerMode: ctx.callerPermissionMode ?? 'default',
    supportedModes,
  });
}

function resolveSessionAgentPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes?: readonly string[],
): PermissionEscalationDecision | null {
  if (!isSessionAgentCaller(ctx)) return null;
  return resolveNearestPermissionModeAtOrBelow({
    requestedMode,
    callerMode: ctx.callerPermissionMode ?? 'default',
    supportedModes,
  });
}

function resolveSessionIdFromInput(input: any, ctx: ActionExecutorContext): string | null {
  const sessionId = normalizeId(input?.sessionId);
  if (sessionId) return sessionId;
  const fallback = normalizeId(ctx.defaultSessionId);
  return fallback || null;
}

function mapApprovalCreatedBySurface(surface: ActionExecutorContext['surface']): ApprovalRequestV1['createdBy']['surface'] {
  if (surface === 'voice_tool' || surface === 'voice_action_block') return 'voice';
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

function isApprovalActionId(actionId: ActionId): boolean {
  return actionId === 'approval.request.create' || actionId === 'approval.request.decide';
}

function isBlockingApprovalRequest(request: ApprovalRequestV1): boolean {
  return request.approval?.flow === 'blocking';
}

function hasRecordedApprovalDecision(request: ApprovalRequestV1): boolean {
  return request.status === 'approved' && request.decision?.kind === 'approve';
}

function hasRecordedRejectionDecision(request: ApprovalRequestV1): boolean {
  return request.status === 'rejected' && request.decision?.kind === 'reject';
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

function normalizeExecutionBackendOptionValue(value: string): string {
  const parsed = BackendTargetKeySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return buildBackendTargetKey({ kind: 'builtInAgent', agentId: value });
}

function normalizeSpawnTargetOptionAlias(value: string): string {
  const trimmed = value.trim();
  return trimmed === 'customAcp' ? trimmed : normalizeExecutionBackendOptionValue(trimmed);
}

type AgentInventoryRequest =
  | Readonly<{
      ok: true;
      value: Readonly<{
        agentId: string;
        machineId?: string;
        limit?: number;
        backendTargetKey?: string;
        modelId?: string;
      }>;
    }>
  | Readonly<{ ok: false }>;

type SpawnTargetSelection =
  | Readonly<{
      ok: true;
      agentId?: string;
      backendTargetKey?: string;
    }>
  | Readonly<{ ok: false }>;

function resolveSpawnTargetSelection(input: Record<string, unknown>): SpawnTargetSelection {
  const targetKeys: string[] = [];
  const agentId = normalizeId(input.agentId);

  for (const field of ['backend', 'target'] as const) {
    const rawAlias = normalizeId(input[field]);
    if (rawAlias) targetKeys.push(normalizeSpawnTargetOptionAlias(rawAlias));
  }

  const backendTargetKeyRaw = normalizeId(input.backendTargetKey);
  if (backendTargetKeyRaw) {
    const parsedKey = BackendTargetKeySchema.safeParse(backendTargetKeyRaw);
    if (!parsedKey.success) return { ok: false };
    targetKeys.push(parsedKey.data);
  }

  const backendTargetParsed = BackendTargetRefSchema.safeParse(input.backendTarget);
  if (backendTargetParsed.success) {
    targetKeys.push(buildBackendTargetKey(backendTargetParsed.data));
  } else if (input.backendTarget !== undefined) {
    return { ok: false };
  }

  const concreteTargetKeys = targetKeys.filter((targetKey) => targetKey !== 'customAcp');
  const uniqueConcreteTargetKeys = [...new Set(concreteTargetKeys)];
  if (uniqueConcreteTargetKeys.length > 1) return { ok: false };
  const hasCustomAcpAlias = targetKeys.includes('customAcp');

  const backendTargetKey = uniqueConcreteTargetKeys[0];
  if ((agentId === 'customAcp' || hasCustomAcpAlias) && backendTargetKey?.startsWith('agent:')) return { ok: false };
  if (hasCustomAcpAlias && agentId && agentId !== 'customAcp') return { ok: false };
  if (!backendTargetKey) return { ok: true, ...((agentId || hasCustomAcpAlias) ? { agentId: agentId || 'customAcp' } : {}) };

  const parsedTarget = parseBackendTargetKey(backendTargetKey);
  const derivedAgentId = parsedTarget.kind === 'builtInAgent' ? parsedTarget.agentId : 'customAcp';
  if (hasCustomAcpAlias && derivedAgentId !== 'customAcp') return { ok: false };
  if (agentId && agentId !== derivedAgentId) return { ok: false };
  return { ok: true, agentId: derivedAgentId, backendTargetKey };
}

function resolveAgentInventoryRequest(input: Record<string, unknown>): AgentInventoryRequest {
  const targetSelection = resolveSpawnTargetSelection(input);
  if (!targetSelection.ok) return { ok: false };
  const resolvedAgentId = targetSelection.agentId;
  const backendTargetKey = targetSelection.backendTargetKey;
  if (resolvedAgentId === 'customAcp' && !backendTargetKey) {
    return { ok: false };
  }
  if (!resolvedAgentId) {
    return { ok: false };
  }
  const modelId = readOpaqueIdentifier(input.modelId);

  return {
    ok: true,
    value: {
      agentId: resolvedAgentId,
      ...(input.machineId ? { machineId: String(input.machineId) } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(backendTargetKey ? { backendTargetKey } : {}),
      ...(modelId ? { modelId } : {}),
    },
  };
}

type SpawnDiscoveryRequest =
  | Readonly<{
      ok: true;
      value: Readonly<{
        agentId?: string;
        backendTargetKey?: string;
        machineId?: string;
        serverId?: string;
        path?: string;
        directory?: string;
        includeDisabled?: boolean;
        includeUnavailable?: boolean;
        limit?: number;
        mcpSelection?: SessionMcpSelectionV1;
        selection?: SessionMcpSelectionV1;
      }>;
    }>
  | Readonly<{ ok: false }>;

function resolveSpawnDiscoveryRequest(input: Record<string, unknown>): SpawnDiscoveryRequest {
  const targetSelection = resolveSpawnTargetSelection(input);
  if (!targetSelection.ok) return { ok: false };

  const path = normalizeId(input.path);
  const directory = normalizeId(input.directory);
  if (path && directory && path !== directory) return { ok: false };

  return {
    ok: true,
    value: {
      ...(targetSelection.agentId ? { agentId: targetSelection.agentId } : {}),
      ...(targetSelection.backendTargetKey ? { backendTargetKey: targetSelection.backendTargetKey } : {}),
      ...(input.machineId ? { machineId: String(input.machineId) } : {}),
      ...(input.serverId ? { serverId: String(input.serverId) } : {}),
      ...(path ? { path } : {}),
      ...(directory ? { directory } : {}),
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : {}),
      ...(typeof input.includeUnavailable === 'boolean' ? { includeUnavailable: input.includeUnavailable } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...((input.mcpSelection) ? { mcpSelection: input.mcpSelection as SessionMcpSelectionV1 } : {}),
      ...((input.selection) ? { selection: input.selection as SessionMcpSelectionV1 } : {}),
    },
  };
}

async function resolveDynamicActionOptions(params: Readonly<{
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  optionsSourceId: string;
  input: Record<string, unknown>;
}>): Promise<ActionExecuteResult> {
  const { deps, ctx, optionsSourceId, input } = params;
  const route = resolveActionOptionSourceRoute(optionsSourceId);
  if (!route) {
    return { ok: false, errorCode: 'options_source_not_supported', error: 'options_source_not_supported' };
  }

  if (route.kind === 'executionBackends') {
    const result = await deps.agentsBackendsList({
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : { includeDisabled: false }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return {
      ok: true,
      result: normalizeResolvedOptions(result).map((option) => ({
        ...option,
        value: normalizeExecutionBackendOptionValue(option.value),
      })),
    };
  }

  if (route.kind === 'reviewEngines') {
    const sessionId = resolveSessionIdFromInput(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.reviewEnginesList({
      sessionId,
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (route.kind === 'sessionModes') {
    const sessionId = resolveSessionIdFromInput(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.sessionModesList({ sessionId });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (route.kind === 'agentInventory') {
    const handler = deps[route.depsKey];
    if (!handler) {
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${route.unsupportedActionId}`,
      };
    }
    const resolved = resolveAgentInventoryRequest(input);
    if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await handler(resolved.value);
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (route.kind === 'localInventory') {
    const handler = deps[route.depsKey];
    if (!handler) {
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${route.unsupportedActionId}`,
      };
    }
    const result = await handler({
      ...(input.machineId ? { machineId: String(input.machineId) } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    } as never);
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (route.kind === 'spawnDiscovery') {
    const handler = deps[route.depsKey];
    if (!handler) {
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${route.unsupportedActionId}`,
      };
    }
    const resolved = resolveSpawnDiscoveryRequest(input);
    if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await handler(resolved.value as never);
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
  const execution = request.execution;
  if (!execution || (request.status !== 'executed' && request.status !== 'failed')) return null;
  if (execution.ok) {
    return { ok: true, result: execution.result };
  }
  const errorCode = typeof execution.errorCode === 'string' && execution.errorCode.trim().length > 0
    ? execution.errorCode
    : 'action_failed';
  const error = typeof execution.error === 'string' && execution.error.trim().length > 0
    ? execution.error
    : errorCode;
  return { ok: false, errorCode, error };
}

function resolveApprovalRequestExecutionSurface(createdBySurface: ApprovalRequestV1['createdBy']['surface']): keyof ActionSurfaces | null {
  if (createdBySurface === 'session_agent') return 'session_agent';
  if (createdBySurface === 'mcp') return 'mcp';
  if (createdBySurface === 'voice') return 'voice_tool';
  if (createdBySurface === 'cli') return 'cli';
  return null;
}

function normalizeActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string; details?: unknown }> {
  const anyErr = error as any;
  const rawDetails = anyErr?.details;
  const details = rawDetails && typeof rawDetails === 'object'
    && Object.hasOwn(rawDetails, 'spawnResponse')
    && typeof (rawDetails as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (rawDetails as { spawnNonce: string }).spawnNonce.trim().length > 0
    ? { spawnNonce: (rawDetails as { spawnNonce: string }).spawnNonce.trim(), accepted: true as const }
    : undefined;
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
    return {
      errorCode: rawCode,
      error: message || rawCode,
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

function readActionExecuteFailure(result: unknown): Readonly<{ errorCode: string; error: string }> | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Readonly<Record<string, unknown>>;
  if (record.ok !== false) return null;
  const errorCode = typeof record.errorCode === 'string' && record.errorCode.trim().length > 0
    ? record.errorCode
    : 'action_failed';
  const error = typeof record.error === 'string' && record.error.trim().length > 0
    ? record.error
    : errorCode;
  return { errorCode, error };
}

export function createActionExecutor(deps: ActionExecutorDeps): Readonly<{
  execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}> {
  const liveBlockingApprovalArtifactIds = new Set<string>();
  const policyAllowsAction = deps.isActionEnabled ?? ((_id: ActionId, _ctx: ActionExecutorContext) => true);
  const resolveAvailability = (spec: ActionSpec, ctx: ActionExecutorContext) =>
    resolveActionSurfaceAvailability({
      actionId: spec.id as ActionId,
      surface: ctx.surface ?? null,
      settings: ctx.actionsSettings ?? null,
      isActionEnabled: (id) => policyAllowsAction(id, ctx),
    });
  const isActionEnabled = (spec: ActionSpec, ctx: ActionExecutorContext) => resolveAvailability(spec, ctx).available;
  const actionDisabled = (availability: ActionSurfaceAvailability): ActionExecuteResult => ({
    ok: false,
    errorCode: 'action_disabled',
    error: 'action_disabled',
    details: availability,
  });

  async function executeApprovedActionForRequest(args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    ctx: ActionExecutorContext;
    effectiveServerId: string | null;
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

  async function resolveBlockingDecisionWaiter(args: Readonly<{
    artifactId: string;
    request: ApprovalRequestV1;
    decision: 'approve' | 'reject';
    effectiveServerId: string | null;
  }>): Promise<boolean> {
    if (!isBlockingApprovalRequest(args.request)) return false;
    const resolved = await deps.approvalsResolveBlockingDecision?.({
      artifactId: args.artifactId,
      request: args.request,
      decision: args.decision,
      serverId: args.effectiveServerId,
    });
    return liveBlockingApprovalArtifactIds.has(args.artifactId) || resolved?.resolved === true;
  }

  const execute = async (actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult> => {
    const ctx: ActionExecutorContext = context ?? {};

    const spec = getActionSpec(actionId);
    const availability = resolveAvailability(spec, ctx);
    if (!availability.available) return actionDisabled(availability);
    const approvalRouting = resolveActionApprovalRouting({
      actionId,
      spec,
      context: ctx,
      requiredByPolicy: ctx.bypassApprovals ? false : deps.isActionApprovalRequired?.(actionId, ctx) === true,
    });
    const isApprovalAction = isApprovalActionId(actionId);
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
        const requestingSessionId = resolvePolicyApprovalRequestingSessionId(ctx.approvalOrigin, ctx, targetSessionId);
        const approvalOrigin = resolveApprovalOriginForRequest(ctx.approvalOrigin, requestingSessionId);
        const requestedSurface = parseActionSurfaceKey(ctx.surface);
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
          actionId,
          actionArgs: parsed.data,
          approval: {
            flow: approvalRouting.flow,
            result: approvalRouting.result,
          },
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
          summary: buildApprovalSummary(spec, targetSessionId),
          preview: { actionId, actionArgs: parsed.data },
          ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
        };

        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        if (approvalRouting.flow === 'blocking') {
          if (!deps.approvalsWaitForDecision || !deps.approvalsUpdate) {
            return { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' };
          }

          const artifactId = (res as any)?.artifactId;
          const effectiveServerId = normalizeId(ctx.serverId) || null;
          liveBlockingApprovalArtifactIds.add(artifactId);
          try {
            const decision = await deps.approvalsWaitForDecision({
              artifactId,
              request,
              serverId: effectiveServerId,
            });
            const now = Date.now();

            if (decision.decision === 'reject' || decision.decision === 'canceled') {
              const nextRequest: ApprovalRequestV1 = decision.decision === 'reject' && hasRecordedRejectionDecision(decision.request)
                ? decision.request
                : {
                    ...decision.request,
                    status: decision.decision === 'reject' ? 'rejected' : 'canceled',
                    updatedAtMs: now,
                    ...(decision.decision === 'reject' ? { decision: { kind: 'reject' as const, decidedAtMs: now } } : {}),
                  };
              if (nextRequest !== decision.request) {
                const updated = await deps.approvalsUpdate({ artifactId, request: nextRequest, serverId: effectiveServerId });
                if ((updated as any)?.ok === false) return { ok: false, errorCode: (updated as any).errorCode, error: (updated as any).error };
              }
              const errorCode = decision.decision === 'reject' ? 'approval_rejected' : 'approval_canceled';
              return { ok: false, errorCode, error: errorCode };
            }

            const recordedExecutionResult = buildActionExecuteResultFromRecordedApprovalExecution(decision.request);
            if (recordedExecutionResult) return recordedExecutionResult;

            const approvedRequest: ApprovalRequestV1 = hasRecordedApprovalDecision(decision.request)
              ? decision.request
              : {
                  ...decision.request,
                  status: 'approved',
                  updatedAtMs: now,
                  decision: { kind: 'approve', decidedAtMs: now },
                };
            if (approvedRequest !== decision.request) {
              const approved = await deps.approvalsUpdate({ artifactId, request: approvedRequest, serverId: effectiveServerId });
              if ((approved as any)?.ok === false) return { ok: false, errorCode: (approved as any).errorCode, error: (approved as any).error };
            }
            const executed = await executeApprovedActionForRequest({
              artifactId,
              request: approvedRequest,
              ctx,
              effectiveServerId,
            });
            return executed.ok ? executed.exec : executed;
          } finally {
            liveBlockingApprovalArtifactIds.delete(artifactId);
          }
        }

        return {
          ok: true,
          result: {
            kind: 'approval_request_created',
            artifactId: (res as any)?.artifactId,
            actionId,
          },
        };
      }

      // Switch by actionId; keep substrate generic.
      if (actionId === 'review.start') {
        const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const serverId = resolveServerIdForSession(deps, ctx, sessionId);
        const opts = serverId ? { serverId } : undefined;

        const reviewInput = parsed.data as ReviewStartInput;
        const engineIds = reviewInput.engineIds;
        const instructions = reviewInput.instructions.trim();
        const permissionDecision = resolveSessionAgentPermission(
          ctx,
          reviewInput.permissionMode,
          EXECUTION_RUN_ACTION_PERMISSION_MODES,
        );
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : reviewInput.permissionMode;
        const intentInputBase = { ...reviewInput, permissionMode };
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
          const failure = readActionExecuteFailure(result);
          if (failure) return { ok: false, ...failure };
          return { ok: true, result };
        }

        const results = await fanoutStarts({
          keys: engineIds,
          startOne: async (engineId) =>
            deps.executionRunStart(
              sessionId,
              {
                intent: 'review',
                backendTarget: parseBackendTargetKey(normalizeExecutionBackendOptionValue(engineId)),
                instructions,
                permissionMode,
                retentionPolicy: 'resumable',
                runClass: 'bounded',
                // Reviews should stream sidechain progress (and tool traffic) into the parent session.
                ioMode: 'streaming',
                intentInput: { ...intentInputBase, engineId },
              },
              opts,
            ),
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
        const requestedPermissionMode = (parsed.data as any).permissionMode ?? permissionModeDefault;
        const permissionDecision = resolveSessionAgentPermission(
          ctx,
          requestedPermissionMode,
          EXECUTION_RUN_ACTION_PERMISSION_MODES,
        );
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : requestedPermissionMode;

        // Connected-services selection: a per-target override wins over the blanket selection.
        // Normalize the simple/object forms to canonical bindings at this ONE boundary; a malformed
        // selection is a typed rejection, never a silent drop.
        const blanketConnectedServices = (parsed.data as any).connectedServices;
        const connectedServicesByBackendTargetKey =
          (parsed.data as any).connectedServicesByBackendTargetKey &&
          typeof (parsed.data as any).connectedServicesByBackendTargetKey === 'object'
            ? (parsed.data as any).connectedServicesByBackendTargetKey as Record<string, unknown>
            : {};
        const connectedServicesByTarget = new Map<
          string,
          Readonly<{ bindings: ConnectedServiceBindingsV1 | undefined; defaultServiceIds: readonly string[] }>
        >();
        for (const backendTargetKey of backendTargetKeys) {
          const rawSelection = Object.prototype.hasOwnProperty.call(connectedServicesByBackendTargetKey, backendTargetKey)
            ? connectedServicesByBackendTargetKey[backendTargetKey]
            : blanketConnectedServices;
          // Preserve bare per-service defaults (RO-F5): the run-start owner resolves them and merges
          // UNDER explicit pins, so a mixed bare+explicit selection resolves instead of failing closed.
          const normalized = normalizeConnectedServiceSelectionInput(rawSelection);
          if (!normalized.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: normalized.error };
          }
          connectedServicesByTarget.set(backendTargetKey, {
            bindings: normalized.bindings,
            defaultServiceIds: normalized.defaultServiceIds,
          });
        }

        // Model + config-option (reasoning effort) selection: reuse the SAME canonical merge owner
        // as session spawn. A conflicting shorthand/canonical value is a typed rejection here.
        const runOptions = resolveRunStartModelAndConfig(parsed.data as Record<string, unknown>);
        if (!runOptions.ok) {
          return { ok: false, errorCode: 'invalid_parameters', error: runOptions.error };
        }

        const results = await fanoutStarts({
          keys: backendTargetKeys,
          startOne: async (backendTargetKey) => {
            const targetSelection = connectedServicesByTarget.get(backendTargetKey);
            const connectedServices = targetSelection?.bindings;
            const connectedServicesDefaultServiceIds = targetSelection?.defaultServiceIds ?? [];
            return deps.executionRunStart(
              sessionId,
              {
                intent,
                backendTarget: parseBackendTargetKey(backendTargetKey),
                instructions,
                permissionMode,
                retentionPolicy: (parsed.data as any).retentionPolicy ?? 'ephemeral',
                runClass: (parsed.data as any).runClass ?? 'bounded',
                ioMode: (parsed.data as any).ioMode ?? 'request_response',
                ...(connectedServices ? { connectedServices } : {}),
                ...(connectedServicesDefaultServiceIds.length > 0
                  ? { connectedServicesDefaultServiceIds }
                  : {}),
                ...(runOptions.modelId ? { modelId: runOptions.modelId } : {}),
                ...(runOptions.sessionConfigOptionOverrides
                  ? { sessionConfigOptionOverrides: runOptions.sessionConfigOptionOverrides }
                  : {}),
                intentInput: { ...(parsed.data as any), backendTargetKey },
              },
              opts,
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
                query: typeof (parsed.data as any).query === 'string' ? (parsed.data as any).query : '',
                limit: typeof (parsed.data as any).limit === 'number' ? (parsed.data as any).limit : undefined,
                isActionEnabled: (id) => isActionEnabled(getActionSpec(id), ctx),
              }),
            },
          };
        }

        if (actionId === 'action.spec.get') {
          try {
            const requestedSpec = getActionSpec(String((parsed.data as any).id) as ActionId);
            const requestedAvailability = resolveAvailability(requestedSpec, ctx);
            if (!requestedAvailability.available) return actionDisabled(requestedAvailability);
            return { ok: true, result: { actionSpec: serializeActionSpec(requestedSpec) } };
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
            const requestedSpec = getActionSpec(actionIdRaw as ActionId);
            const requestedAvailability = resolveAvailability(requestedSpec, ctx);
            if (!requestedAvailability.available) return actionDisabled(requestedAvailability);
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

        if (actionId === 'execution.run.start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;

          const { sessionId: _ignored, ...request } = parsed.data as any;
          // Model + config-option (reasoning effort) selection: merge the `configOptions` shorthand
          // into the canonical `sessionConfigOptionOverrides` using the SAME owner as session spawn.
          // A conflicting shorthand/canonical value is a typed rejection.
          const runOptions = resolveRunStartModelAndConfig(request as Record<string, unknown>);
          if (!runOptions.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: runOptions.error };
          }
          delete request.configOptions;
          if (runOptions.sessionConfigOptionOverrides) {
            request.sessionConfigOptionOverrides = runOptions.sessionConfigOptionOverrides;
          } else {
            delete request.sessionConfigOptionOverrides;
          }
          if (runOptions.modelId) {
            request.modelId = runOptions.modelId;
          } else {
            delete request.modelId;
          }
          // Normalize the agent-friendly connected-services selection (simple string / object) to
          // canonical bindings at this ONE boundary; malformed input is a typed rejection.
          if (request.connectedServices !== undefined) {
            // Preserve bare per-service defaults (RO-F5) alongside explicit pins; the run-start owner
            // resolves + merges them (mixed bare+explicit resolves instead of failing closed).
            const normalized = normalizeConnectedServiceSelectionInput(request.connectedServices);
            if (!normalized.ok) {
              return { ok: false, errorCode: 'invalid_parameters', error: normalized.error };
            }
            if (normalized.bindings) {
              request.connectedServices = normalized.bindings;
            } else {
              delete request.connectedServices;
            }
            if (normalized.defaultServiceIds.length > 0) {
              request.connectedServicesDefaultServiceIds = normalized.defaultServiceIds;
            } else {
              delete request.connectedServicesDefaultServiceIds;
            }
          }
          const permissionDecision = resolveSessionAgentPermission(
            ctx,
            request.permissionMode,
            EXECUTION_RUN_ACTION_PERMISSION_MODES,
          );
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          if (permissionDecision?.ok === true) {
            request.permissionMode = permissionDecision.requestedMode;
          }
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

        if (actionId === 'session.rollback') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const rawTarget = (parsed.data as any)?.target;
          const target = rawTarget && typeof rawTarget === 'object' ? (rawTarget as SessionRollbackTarget) : undefined;
          const res = await deps.sessionRollback({ sessionId, ...(serverId ? { serverId } : {}), ...(target ? { target } : {}) });
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

        if (actionId === 'session.spawn_new') {
          const spawnInput = parsed.data as SessionSpawnNewInput;
          const permissionDecision = typeof spawnInput.permissionMode === 'string' && spawnInput.permissionMode.trim().length > 0
            ? assertSessionAgentPermission(ctx, spawnInput.permissionMode)
            : null;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const effectiveSpawnInput = permissionDecision?.ok === true
            ? { ...spawnInput, permissionMode: permissionDecision.normalizedMode }
            : spawnInput;
          const res = await deps.sessionSpawnNew({
            ...effectiveSpawnInput,
            surface: ctx.surface ?? null,
            ...(ctx.actionRequestId ? { actionRequestId: ctx.actionRequestId } : {}),
            ...(ctx.resumeActionRequest === true ? { resumeActionRequest: true } : {}),
            ...(isSessionAgentCaller(ctx)
              ? { callerSurface: 'session_agent' as const, callerPermissionMode: ctx.callerPermissionMode ?? null }
              : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.spawn_picker') {
          const res = await deps.sessionSpawnPicker({
            ...(((parsed.data as any).tag) ? { tag: String((parsed.data as any).tag) } : {}),
            ...(((parsed.data as any).agentId) ? { agentId: String((parsed.data as any).agentId) } : {}),
            ...(((parsed.data as any).modelId) ? { modelId: String((parsed.data as any).modelId) } : {}),
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
          });
          return { ok: true, result: res };
        }

        if (actionId === 'agents.models.list') {
          const resolved = resolveAgentInventoryRequest(parsed.data as Record<string, unknown>);
          if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsModelsList(resolved.value);
          return { ok: true, result: res };
        }

        if (actionId === 'agents.session_modes.list') {
          if (!deps.agentsSessionModesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.session_modes.list' };
          const resolved = resolveAgentInventoryRequest(parsed.data as Record<string, unknown>);
          if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsSessionModesList(resolved.value);
          return { ok: true, result: res };
        }

        if (actionId === 'agents.config_options.list') {
          if (!deps.agentsConfigOptionsList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.config_options.list' };
          const resolved = resolveAgentInventoryRequest(parsed.data as Record<string, unknown>);
          if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsConfigOptionsList(resolved.value);
          return { ok: true, result: res };
        }

        if (actionId === 'sessions.spawn.profiles.list') {
          if (!deps.sessionsSpawnProfilesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.profiles.list' };
          const resolved = resolveSpawnDiscoveryRequest(parsed.data as Record<string, unknown>);
          if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionsSpawnProfilesList(resolved.value);
          return { ok: true, result: res };
        }

        if (actionId === 'sessions.spawn.connected_services.list') {
          if (!deps.sessionsSpawnConnectedServicesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.connected_services.list' };
          const resolved = resolveSpawnDiscoveryRequest(parsed.data as Record<string, unknown>);
          if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionsSpawnConnectedServicesList(resolved.value);
          return { ok: true, result: res };
        }

        if (actionId === 'sessions.spawn.mcp_servers.preview') {
          if (!deps.sessionsSpawnMcpServersPreview) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
          const resolved = resolveSpawnDiscoveryRequest(parsed.data as Record<string, unknown>);
          if (!resolved.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionsSpawnMcpServersPreview(resolved.value);
          return { ok: true, result: res };
        }

        if (actionId === 'session.message.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const modelOverrideRaw = Object.prototype.hasOwnProperty.call(parsed.data, 'modelOverride')
            ? (parsed.data as any).modelOverride
            : undefined;
          const permissionOverrideRaw = (parsed.data as any).permissionModeOverride;
          const permissionModeForAgent = isSessionAgentCaller(ctx)
            && !(typeof permissionOverrideRaw === 'string' && permissionOverrideRaw.trim().length > 0)
              ? ctx.callerPermissionMode ?? 'default'
              : permissionOverrideRaw;
          const permissionDecision = typeof permissionModeForAgent === 'string' && permissionModeForAgent.trim().length > 0
            ? assertSessionAgentPermission(ctx, permissionModeForAgent)
            : null;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const res = await deps.sessionSendMessage({
            sessionId,
            message: (parsed.data as any).message,
            requestedAction: PendingRequestedActionV1Schema.parse(
              parsed.data.requestedAction ?? { v: 1, kind: 'steer_if_active' },
            ),
            ...(permissionDecision?.ok === true
              ? { permissionModeOverride: permissionDecision.normalizedMode }
              : permissionOverrideRaw ? { permissionModeOverride: permissionOverrideRaw } : {}),
            ...(modelOverrideRaw === null
              ? { modelOverride: null }
              : typeof modelOverrideRaw === 'string' && modelOverrideRaw.trim().length > 0
                ? { modelOverride: modelOverrideRaw }
                : {}),
            ...(typeof (parsed.data as any).wait === 'boolean' ? { wait: (parsed.data as any).wait } : {}),
            ...(typeof (parsed.data as any).timeoutSeconds === 'number' ? { timeoutSeconds: (parsed.data as any).timeoutSeconds } : {}),
            ...(serverId ? { serverId } : {}),
            ...(isSessionAgentCaller(ctx)
              ? { callerSurface: 'session_agent' as const, callerPermissionMode: ctx.callerPermissionMode ?? null }
              : {}),
          });
          const failure = readActionExecuteFailure(res);
          if (failure) return { ok: false, ...failure };
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
          const stopFailed = 'success' in res ? res.success === false : res.ok === false;
          if (stopFailed) {
            const errorCode = res.code?.trim()
              || ('errorCode' in res ? res.errorCode?.trim() : undefined)
              || 'session_stop_failed';
            const error = ('error' in res ? res.error?.trim() : undefined)
              || res.message?.trim()
              || errorCode;
            return {
              ok: false,
              errorCode,
              error,
              details: res,
            };
          }
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
          const permissionDecision = assertSessionAgentPermission(ctx, permissionMode);
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionModeSet({
            sessionId,
            permissionMode: permissionDecision?.ok === true ? permissionDecision.normalizedMode : permissionMode,
            ...(serverId ? { serverId } : {}),
            ...(isSessionAgentCaller(ctx)
              ? { callerSurface: 'session_agent' as const, callerPermissionMode: ctx.callerPermissionMode ?? null }
              : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.model.set') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionModelSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.model.set' };
          }
          const modelId = readOpaqueIdentifier((parsed.data as any).modelId);
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

        if (actionId === 'session.terminalComposer.clear') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTerminalComposerClear) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.terminalComposer.clear' };
          }
          const expectedStateAtMs = (parsed.data as any).expectedStateAtMs;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTerminalComposerClear({
            sessionId,
            ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.pendingInput.interruptAndRun') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          const localId = normalizeId((parsed.data as any).localId);
          if (!sessionId || !localId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionPendingInputInterruptAndRun) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.pendingInput.interruptAndRun' };
          }
          const expectedStateAtMs = (parsed.data as any).expectedStateAtMs;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPendingInputInterruptAndRun({
            sessionId,
            localId,
            ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
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

        if (actionId === 'session.usageLimit.waitResume.enable') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeEnable) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.enable' };
          }
          const data = parsed.data as Record<string, unknown>;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionUsageLimitWaitResumeEnable({
            sessionId,
            ...(typeof data.issueFingerprint === 'string' ? { issueFingerprint: data.issueFingerprint } : {}),
            ...(data.remember === true ? { remember: true } : {}),
            ...(data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
              ? { resumePromptMode: data.resumePromptMode }
              : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: normalizeUsageLimitActionResult(res, sessionId) };
        }

        if (actionId === 'session.usageLimit.waitResume.cancel') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.cancel' };
          }
          const data = parsed.data as Record<string, unknown>;
          const issueFingerprint = data.issueFingerprint;
          const armedAtMs = data.armedAtMs;
          const runtimeAuthRecoveryAttemptId = data.runtimeAuthRecoveryAttemptId;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionUsageLimitWaitResumeCancel({
            sessionId,
            ...(typeof issueFingerprint === 'string' || issueFingerprint === null ? { issueFingerprint } : {}),
            ...(typeof armedAtMs === 'number' ? { armedAtMs } : {}),
            ...(typeof runtimeAuthRecoveryAttemptId === 'string' ? { runtimeAuthRecoveryAttemptId } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: normalizeUsageLimitActionResult(res, sessionId) };
        }

        if (actionId === 'session.usageLimit.checkNow') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const data = parsed.data as Record<string, unknown>;
          const operation = data.operation === 'switch_account_now'
            ? 'switch_account_now'
            : 'check_now';
          if (operation === 'switch_account_now' && !deps.sessionUsageLimitSwitchAccountNow) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
          }
          if (operation === 'check_now' && !deps.sessionUsageLimitCheckNow) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const handler = operation === 'switch_account_now'
            ? deps.sessionUsageLimitSwitchAccountNow
            : deps.sessionUsageLimitCheckNow;
          const res = await handler?.({
            sessionId,
            ...(typeof data.provider === 'string' && data.provider.trim().length > 0 ? { provider: data.provider.trim() } : {}),
            ...(data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
              ? { resumePromptMode: data.resumePromptMode }
              : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: normalizeUsageLimitActionResult(res, sessionId) };
        }

        if (actionId === 'session.usageLimit.consumeResetCredit') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitConsumeResetCredit) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.consumeResetCredit' };
          }
          const data = parsed.data as Record<string, unknown>;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionUsageLimitConsumeResetCredit({
            sessionId,
            ...(typeof data.provider === 'string' && data.provider.trim().length > 0 ? { provider: data.provider.trim() } : {}),
            ...(data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
              ? { resumePromptMode: data.resumePromptMode }
              : {}),
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: normalizeUsageLimitActionResult(res, sessionId) };
        }

        if (actionId === 'session.history.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionHistoryGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.history.get' };
          }
          const limit = typeof (parsed.data as any).limit === 'number' ? (parsed.data as any).limit : undefined;
          const format = (parsed.data as any).format === 'raw' ? 'raw' : 'compact';
          const includeMeta = (parsed.data as any).includeMeta === true;
          const includeStructuredPayload = (parsed.data as any).includeStructuredPayload === true;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionHistoryGet({
            sessionId,
            ...(typeof limit === 'number' ? { limit } : {}),
            format,
            includeMeta,
            includeStructuredPayload,
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
          const data = parsed.data as any;
          const res = await deps.sessionTranscriptGet({
            sessionId,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: ((data.cursor ?? null) as any) } : {}),
            ...(data.direction === 'before' || data.direction === 'after' ? { direction: data.direction } : {}),
            ...(data.scope === 'main' || data.scope === 'sidechain' || data.scope === 'all' ? { scope: data.scope } : {}),
            ...(hasOwn(data, 'sidechainId') ? { sidechainId: ((data.sidechainId ?? null) as any) } : {}),
            ...(Array.isArray(data.roles) ? { roles: data.roles } : {}),
            ...(pickBoolean(data, 'includeTools') !== undefined ? { includeTools: pickBoolean(data, 'includeTools') } : {}),
            ...(pickBoolean(data, 'includeReasoning') !== undefined ? { includeReasoning: pickBoolean(data, 'includeReasoning') } : {}),
            ...(pickBoolean(data, 'includeEvents') !== undefined ? { includeEvents: pickBoolean(data, 'includeEvents') } : {}),
            ...(pickBoolean(data, 'includeMeta') !== undefined ? { includeMeta: pickBoolean(data, 'includeMeta') } : {}),
            ...(pickBoolean(data, 'includeStructuredPayload') !== undefined ? { includeStructuredPayload: pickBoolean(data, 'includeStructuredPayload') } : {}),
            ...(pickBoolean(data, 'includeRaw') !== undefined ? { includeRaw: pickBoolean(data, 'includeRaw') } : {}),
            ...(hasOwn(data, 'maxCharsPerMessage') ? { maxCharsPerMessage: ((data.maxCharsPerMessage ?? null) as any) } : {}),
            ...(hasOwn(data, 'maxRawPayloadChars') ? { maxRawPayloadChars: ((data.maxRawPayloadChars ?? null) as any) } : {}),
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
          const data = parsed.data as any;
          const res = await deps.sessionEventsGet({
            sessionId,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: ((data.cursor ?? null) as any) } : {}),
            ...(data.direction === 'before' || data.direction === 'after' ? { direction: data.direction } : {}),
            ...(data.scope === 'main' || data.scope === 'sidechain' || data.scope === 'all' ? { scope: data.scope } : {}),
            ...(hasOwn(data, 'sidechainId') ? { sidechainId: ((data.sidechainId ?? null) as any) } : {}),
            ...(Array.isArray(data.roles) ? { roles: data.roles } : {}),
            ...(Array.isArray(data.kinds) ? { kinds: data.kinds } : {}),
            ...(data.format === 'raw' || data.format === 'compact' ? { format: data.format } : {}),
            ...(pickBoolean(data, 'includeMeta') !== undefined ? { includeMeta: pickBoolean(data, 'includeMeta') } : {}),
            ...(pickBoolean(data, 'includeStructuredPayload') !== undefined ? { includeStructuredPayload: pickBoolean(data, 'includeStructuredPayload') } : {}),
            ...(pickBoolean(data, 'includeRaw') !== undefined ? { includeRaw: pickBoolean(data, 'includeRaw') } : {}),
            ...(typeof data.maxTextChars === 'number' ? { maxTextChars: data.maxTextChars } : {}),
            ...(typeof data.maxPayloadChars === 'number' ? { maxPayloadChars: data.maxPayloadChars } : {}),
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
              values: Array.isArray(entry?.values)
                ? entry.values.map((value: unknown) => String(value))
                : typeof entry?.answer === 'string'
                  ? [entry.answer]
                  : [],
            }))) : [],
            ...(typeof (parsed.data as any).decision === 'string' ? { decision: (parsed.data as any).decision } : {}),
            ...(typeof (parsed.data as any).reason === 'string' ? { reason: (parsed.data as any).reason } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'updatedPermissions') ? { updatedPermissions: (parsed.data as any).updatedPermissions } : {}),
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
          actionId: targetActionId,
          actionArgs: parsedTargetArgs.data,
          approval: buildApprovalMetadata(targetSpec),
          ...(approvalOrigin ? { origin: approvalOrigin } : {}),
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
          await resolveBlockingDecisionWaiter({
            artifactId,
            request: nextRejected,
            decision: 'reject',
            effectiveServerId,
          });
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

        const delegatedToBlockingWaiter = await resolveBlockingDecisionWaiter({
          artifactId,
          request: approvedRequest,
          decision: 'approve',
          effectiveServerId,
        });
        if (delegatedToBlockingWaiter) {
          return buildApprovalDecisionResult(approvedRequest);
        }

        const executed = await executeApprovedActionForRequest({
          artifactId,
          request: approvedRequest,
          ctx,
          effectiveServerId,
        });
        if (!executed.ok) return executed;
        return buildApprovalDecisionResult(executed.request);
      }

      return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
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

  return {
    execute,
  };
}
