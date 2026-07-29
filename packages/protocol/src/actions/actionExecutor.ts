import {
  findActionInputFieldHint,
  filterResolvedActionOptions,
  getActionSpecForCatalogSurface,
  searchSerializedActionSpecsForSurface,
  serializeActionSpec,
  serializeActionFieldOptions,
} from './actionCatalog.js';
import { resolveActionApprovalFlow } from './actionApprovalMetadata.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { resolveRequestedSessionModeId } from './sessionModeIds.js';
import {
  findSpawnConfigOptionAliasConflicts,
  mergeSpawnConfigOptionAliases,
} from './sessionSpawnConfigOptions.js';
import type { AcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import type { ConnectedServiceBindingsV1 } from '../connect/connectedServiceBindings.js';
import {
  assertNonEscalatingPermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  type PermissionEscalationDecision,
} from './permissionPrivilege.js';
import type { ActionsSettingsV1 } from './actionSettings.js';
import { ActionSurfaceSchema, getActionSpec, isActionSpecSurfacedOn, type ActionSpec, type ActionSurfaces } from './actionSpecs.js';
import {
  resolveActionSurfaceAvailability,
  type ActionSurfaceAvailability,
} from './actionSurfaceAvailability.js';
import { isRuntimeActionIdV1, type ActionId } from './actionIds.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { MemorySearchQueryV1, MemorySearchResultV1 } from '../memory/memorySearch.js';
import type { MemoryWindowV1 } from '../memory/memoryWindow.js';
import {
  ApprovalRequestOriginV1Schema,
  ApprovalRequestV1Schema,
  type ApprovalRequestOriginV1,
  type ApprovalRequestV1,
} from '../approvals/approvalRequestV1.js';
import type { PromptRegistryConfiguredSourceV1 } from '../prompts/library/promptRegistriesV1.js';
import { ProviderConnectionIdSchema } from '../providers/ids.js';
import {
  BackendTargetKeySchema,
  buildBackendTargetKey,
  type BackendTargetRefV1,
} from '../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema } from '../backends/targets/backendTargetRefV2.js';
import type { SessionRollbackTarget } from '../sessions/rollback.js';
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
  type SessionHandoffPrepareTargetResumeRequest,
  type SessionHandoffStatusGetRequest,
  SessionHandoffWorkspaceTransferSchema,
  type SessionHandoffWorkspaceTransfer,
} from '../sessions/control/handoff/handoffSchemas.js';
import type { SessionContinueWithReplayRpcParams } from '../sessions/continueWithReplay.js';
import { SpawnSessionErrorCodeSchema } from '../sessions/spawnSession.js';
import { SessionControlErrorCodeSchema } from '../sessions/control/contract.js';
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
import { resolveActionBackendTargetSelection, type ActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';
import { dispatchRuntimeAction, type RuntimeActionExecute } from './executor/index.js';

import type {
  ActionExecuteResult,
  ActionExecutorContext,
  ActionExecutorDeps,
} from './executor/types.js';
export type {
  ActionExecuteResult,
  ActionExecutorContext,
  ActionExecutorDeps,
  ApprovalQueueListItemV1,
  ApprovalQueueListResultV1,
  ApprovalQueueQueryPlanV1,
} from './executor/types.js';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
}

function readRecord(raw: unknown): Readonly<Record<string, unknown>> {
  return isRecord(raw) ? raw : {};
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readNullableString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

function readRecordListProperty(raw: unknown, key: string): readonly Readonly<Record<string, unknown>>[] {
  const value = readRecord(raw)[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
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

function readPermissionResponseDecision(raw: unknown): 'allow' | 'deny' | null {
  return raw === 'allow' || raw === 'deny' ? raw : null;
}

function readApprovalRequestStatus(raw: unknown): ApprovalRequestV1['status'] | null {
  return raw === 'open'
    || raw === 'approved'
    || raw === 'rejected'
    || raw === 'executed'
    || raw === 'failed'
    || raw === 'canceled'
    ? raw
    : null;
}

function readNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

type ResolvedRunStartOptions = Readonly<{
  modelId?: string;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
}>;

/**
 * Canonical run-start model + config-option resolution shared by BOTH the execution.run.start
 * branch and the delegate/plan/voice fan-out. Merges the `configOptions` shorthand into the
 * canonical `sessionConfigOptionOverrides` via the SAME owner session spawn uses; a conflicting
 * value fails closed with `invalid_parameters` (never a silent second vocabulary reaching the run
 * request). The shorthand is merged away — callers must strip `configOptions` from the outgoing
 * request. Fail-safe: omitting every field yields an empty result identical to today's behavior.
 */
function resolveRunStartModelAndConfig(
  data: Readonly<Record<string, unknown>>,
): { ok: true; options: ResolvedRunStartOptions } | { ok: false } {
  const modelId = readNonEmptyString(data.modelId);
  const canonicalOverrides = data.sessionConfigOptionOverrides as AcpConfigOptionOverridesV1 | undefined;
  const configOptions = readConfigOptionsRecord(data.configOptions);
  if (findSpawnConfigOptionAliasConflicts({
    sessionConfigOptionOverrides: canonicalOverrides,
    configOptions,
  }).length > 0) {
    return { ok: false };
  }
  const merged = mergeSpawnConfigOptionAliases({
    ...(canonicalOverrides ? { sessionConfigOptionOverrides: canonicalOverrides } : {}),
    ...(configOptions ? { configOptions } : {}),
  });
  return {
    ok: true,
    options: {
      ...(modelId ? { modelId } : {}),
      ...(merged ? { sessionConfigOptionOverrides: merged } : {}),
    },
  };
}

function readConfigOptionsRecord(raw: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.every(([, value]) => (
    typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'boolean'
    || value === null
  ))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string | number | boolean | null>;
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function buildSessionSpawnNewArgs(
  data: Readonly<Record<string, unknown>>,
  selection: ActionBackendTargetSelection,
  ctx: ActionExecutorContext,
): Parameters<ActionExecutorDeps['sessionSpawnNew']>[0] {
  const args: Record<string, unknown> = {};
  assignIfDefined(args, 'tag', readNonEmptyString(data.tag));
  assignIfDefined(args, 'agentId', selection.agentId ?? undefined);
  assignIfDefined(args, 'modelId', readNonEmptyString(data.modelId));
  assignIfDefined(args, 'providerConnectionId', data.providerConnectionId === null
    ? null
    : readNonEmptyString(data.providerConnectionId));
  assignIfDefined(args, 'modelUpdatedAt', readFiniteNumber(data.modelUpdatedAt));
  assignIfDefined(args, 'backendTargetKey', selection.backendTargetKey ?? readNonEmptyString(data.backendTargetKey));
  assignIfDefined(args, 'backendTarget', data.backendTarget);
  assignIfDefined(args, 'title', readNonEmptyString(data.title));
  assignIfDefined(args, 'path', readNonEmptyString(data.path) ?? readNonEmptyString(data.directory));
  assignIfDefined(args, 'host', readNonEmptyString(data.host));
  assignIfDefined(args, 'machineId', readNonEmptyString(data.machineId));
  assignIfDefined(args, 'serverId', readNonEmptyString(data.serverId));
  assignIfDefined(args, 'initialMessage', readNonEmptyString(data.initialMessage) ?? readNonEmptyString(data.initialPrompt));
  assignIfDefined(args, 'permissionMode', readNonEmptyString(data.permissionMode));
  assignIfDefined(args, 'permissionModeUpdatedAt', readFiniteNumber(data.permissionModeUpdatedAt));
  assignIfDefined(args, 'agentModeId', readNonEmptyString(data.agentModeId));
  assignIfDefined(args, 'agentModeUpdatedAt', readFiniteNumber(data.agentModeUpdatedAt));
  assignIfDefined(args, 'sessionConfigOptionOverrides', data.sessionConfigOptionOverrides);
  assignIfDefined(args, 'configOptions', readConfigOptionsRecord(data.configOptions));
  assignIfDefined(args, 'profileId', readOptionalString(data.profileId));
  assignIfDefined(args, 'environmentVariables', readStringRecord(data.environmentVariables));
  assignIfDefined(args, 'connectedServices', data.connectedServices);
  assignIfDefined(args, 'connectedServicesUpdatedAt', readFiniteNumber(data.connectedServicesUpdatedAt));
  assignIfDefined(args, 'mcpSelection', data.mcpSelection);
  assignIfDefined(args, 'transcriptStorage', data.transcriptStorage);
  assignIfDefined(args, 'terminal', data.terminal);
  assignIfDefined(args, 'windowsRemoteSessionLaunchMode', data.windowsRemoteSessionLaunchMode);
  assignIfDefined(args, 'windowsRemoteSessionConsole', data.windowsRemoteSessionConsole);
  assignIfDefined(args, 'windowsTerminalWindowName', readNonEmptyString(data.windowsTerminalWindowName));
  assignIfDefined(args, 'runtimeDescriptorV1', data.runtimeDescriptorV1);
  assignIfDefined(args, 'actionRequestId', ctx.actionRequestId ?? undefined);
  assignIfDefined(args, 'resumeActionRequest', ctx.resumeActionRequest === true ? true : undefined);
  if (ctx.surface === 'agent') {
    assignIfDefined(args, 'callerSurface', 'agent');
    assignIfDefined(args, 'callerPermissionMode', ctx.callerPermissionMode ?? null);
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
  return ctx.surface === 'agent';
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

function assertAgentPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes?: readonly string[],
): PermissionEscalationDecision | null {
  if (!isAgentCaller(ctx)) return null;
  return assertNonEscalatingPermissionMode({
    requestedMode,
    callerMode: ctx.callerPermissionMode ?? 'default',
    supportedModes,
  });
}

function resolveAgentPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes?: readonly string[],
): PermissionEscalationDecision | null {
  if (!isAgentCaller(ctx)) return null;
  return resolveNearestPermissionModeAtOrBelow({
    requestedMode,
    callerMode: ctx.callerPermissionMode ?? 'default',
    supportedModes,
  });
}

function resolveSessionIdFromInput(input: unknown, ctx: ActionExecutorContext): string | null {
  const sessionId = normalizeId(readRecord(input).sessionId);
  if (sessionId) return sessionId;
  const fallback = normalizeId(ctx.defaultSessionId);
  return fallback || null;
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

function buildApprovalMetadata(spec: ActionSpec): NonNullable<ApprovalRequestV1['approval']> {
  return {
    flow: resolveActionApprovalFlow(spec.approval),
    result: spec.approval.result,
  };
}

async function buildApprovalPreview(params: Readonly<{
  deps: ActionExecutorDeps;
  actionId: ActionId;
  input: unknown;
  context: ActionExecutorContext;
}>): Promise<unknown> {
  const defaultPreview = {
    actionId: params.actionId,
    actionArgs: params.input,
  } as const;
  return await params.deps.buildApprovalPreview?.({
    actionId: params.actionId,
    input: params.input,
    context: params.context,
    defaultPreview,
  }) ?? defaultPreview;
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
  const sessionsFromField = readRecordListProperty(value, 'sessions');
  const sessions = sessionsFromField.length > 0 ? sessionsFromField : readRecordListProperty(value, 'items');

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
    const nextCursor = normalizeId(readRecord(response).nextCursor);
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
  const items = readRecordListProperty(value, 'items').length > 0
    ? readRecordListProperty(value, 'items')
    : Array.isArray(value)
      ? value.filter(isRecord)
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
            : typeof item?.path === 'string'
              ? item.path
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

function resolveExecutionBackendTargetSelectionForValue(value: string): ActionBackendTargetSelection | null {
  const normalizedValue = normalizeId(value);
  if (!normalizedValue) return null;
  const isExplicitTargetKey = BackendTargetKeySchema.safeParse(normalizedValue).success
    || BackendTargetKeyV2Schema.safeParse(normalizedValue).success;
  const candidateKey = isExplicitTargetKey
    ? normalizedValue
    : buildBackendTargetKey({ kind: 'builtInAgent', agentId: normalizedValue });
  const resolved = resolveActionBackendTargetSelection({
    backendTargetKey: candidateKey,
    ...(!isExplicitTargetKey ? { agentId: normalizedValue } : {}),
  });
  return resolved.ok ? resolved.selection : null;
}

function tryNormalizeExecutionBackendOptionValue(value: string): string | null {
  return resolveExecutionBackendTargetSelectionForValue(value)?.backendTargetKey ?? null;
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

function resolveAgentInventorySelection(input: Record<string, unknown>): ActionBackendTargetSelection | null {
  const resolvedSelection = resolveActionBackendTargetSelection({
    agentId: typeof input.agentId === 'string' ? input.agentId : undefined,
    backendTargetKey: typeof input.backendTargetKey === 'string' ? input.backendTargetKey : undefined,
  });
  if (!resolvedSelection.ok) return null;
  const selection = resolvedSelection.selection;
  if (!selection.agentId && !selection.backendTargetKey) return null;
  return selection;
}

function buildAgentInventorySelectionArgs(input: Record<string, unknown>): Readonly<{ agentId?: string; backendTargetKey?: string }> | null {
  const selection = resolveAgentInventorySelection(input);
  if (!selection) return null;
  return {
    ...(selection.agentId ? { agentId: selection.agentId } : {}),
    ...(selection.backendTargetKey ? { backendTargetKey: selection.backendTargetKey } : {}),
  };
}

async function resolveDynamicActionOptions(params: Readonly<{
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  optionsSourceId: string;
  input: Record<string, unknown>;
}>): Promise<ActionExecuteResult> {
  const { deps, ctx, optionsSourceId, input } = params;

  if (optionsSourceId === 'execution.backends.enabled' || optionsSourceId === 'agents.backends.enabled') {
    const result = await deps.agentsBackendsList({
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : { includeDisabled: false }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.machineId === 'string' ? { machineId: input.machineId } : {}),
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

  if (optionsSourceId === 'agents.models.available') {
    const selectionArgs = buildAgentInventorySelectionArgs(input);
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsModelsList({
      ...selectionArgs,
      ...(typeof input.machineId === 'string' ? { machineId: input.machineId } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'agents.session_modes.available') {
    if (!deps.agentsSessionModesList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.session_modes.list' };
    }
    const selectionArgs = buildAgentInventorySelectionArgs(input);
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsSessionModesList({
      ...selectionArgs,
      ...(typeof input.machineId === 'string' ? { machineId: input.machineId } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'agents.config_options.available') {
    if (!deps.agentsConfigOptionsList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.config_options.list' };
    }
    const selectionArgs = buildAgentInventorySelectionArgs(input);
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsConfigOptionsList({
      ...selectionArgs,
      ...(typeof input.machineId === 'string' ? { machineId: input.machineId } : {}),
      ...(typeof input.modelId === 'string' ? { modelId: input.modelId } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.paths.recent') {
    const result = await deps.pathsListRecent({
      ...(typeof input.machineId === 'string' ? { machineId: input.machineId } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.machines.available') {
    const result = await deps.machinesList({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.servers.available') {
    const result = await deps.serversList({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.profiles.available') {
    if (!deps.spawnProfilesList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.profiles.list' };
    }
    const selectionArgs = buildAgentInventorySelectionArgs(input);
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.spawnProfilesList({
      ...selectionArgs,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.connected_services.available') {
    if (!deps.spawnConnectedServicesList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.connected_services.list' };
    }
    const selectionArgs = buildAgentInventorySelectionArgs(input);
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.spawnConnectedServicesList({
      ...selectionArgs,
      ...(typeof input.includeUnavailable === 'boolean' ? { includeUnavailable: input.includeUnavailable } : {}),
    });
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.mcp_servers.preview') {
    if (!deps.spawnMcpServersPreview) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
    }
    const selectionArgs = buildAgentInventorySelectionArgs(input);
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const directory = typeof input.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : typeof input.path === 'string' && input.path.trim().length > 0
        ? input.path.trim()
        : undefined;
    const result = await deps.spawnMcpServersPreview({
      ...selectionArgs,
      ...(typeof input.machineId === 'string' ? { machineId: input.machineId } : {}),
      ...(directory ? { directory } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'selection') ? { selection: input.selection } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
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
  const record = readRecord(result);
  if (
    record.ok === true
    && isRecord(record.data)
  ) {
    return record.data;
  }
  return result;
}

function readFanoutStartError(result: unknown): { errorCode?: string; error: string } {
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
  if (createdBySurface === 'agent') return 'agent';
  if (createdBySurface === 'mcp') return 'mcp';
  if (createdBySurface === 'voice') return 'voice';
  if (createdBySurface === 'cli') return 'cli';
  return null;
}

function normalizeActionExecutorThrownError(error: unknown): Readonly<{ errorCode: string; error: string; details?: unknown }> {
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
  const protocolCode = rawCodes.find((value) => (
    SessionControlErrorCodeSchema.safeParse(value).success
    || SpawnSessionErrorCodeSchema.safeParse(value).success
  )) ?? '';
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

  if (protocolCode) {
    return {
      errorCode: protocolCode,
      error: message || protocolCode,
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

function completeSpawnActionResult(result: unknown): ActionExecuteResult {
  return completeActionResult(result, { treatReturnedErrorEnvelopeAsFailure: true });
}

export function createActionExecutor(deps: ActionExecutorDeps): Readonly<{
  execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}> {
  const policyAllowsAction = deps.isActionEnabled ?? ((_id: ActionId, _ctx: ActionExecutorContext) => true);
  const isActionEnabledByPolicy = (spec: ActionSpec, ctx: ActionExecutorContext) => policyAllowsAction(spec.id, ctx);
  const isActionEnabledBySurface = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionSpecSurfacedOn(spec, ctx.surface);
  const isActionEnabled = (spec: ActionSpec, ctx: ActionExecutorContext) => isActionEnabledBySurface(spec, ctx) && isActionEnabledByPolicy(spec, ctx);

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

  function actionDisabled(details: ActionSurfaceAvailability | null): ActionExecuteResult {
    return {
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      ...(details ? { details } : {}),
    };
  }

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

    const requestSurface = parseActionSurfaceKey(args.request.requestedSurface)
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
        ? { executedAtMs, ok: true, result: exec.result }
        : { executedAtMs, ok: false, errorCode: exec.errorCode, error: exec.error },
    };

    const updated = await deps.approvalsUpdate({ artifactId: args.artifactId, request: nextExecuted, serverId: args.effectiveServerId });
    const updateFailure = readActionFailureEnvelope(updated);
    if (updateFailure) return updateFailure;
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
    const availability = resolveAvailabilityForContext(spec, ctx);
    const approvalRouting = resolveActionApprovalRouting({
      actionId,
      spec,
      context: ctx,
      // Pass the raw policy-hook result through (boolean | undefined). When the hook is unwired,
      // `undefined` propagates so `resolveActionApprovalRouting` applies its centralized fail-safe
      // default instead of coercing an unwired dependency to "no approval" here. (F7)
      requiredByPolicy: ctx.bypassApprovals ? false : deps.isActionApprovalRequired?.(actionId, ctx),
    });
    const isApprovalAction = isApprovalActionId(actionId);
    if (availability ? !availability.available : !isActionEnabled(spec, ctx)) {
      return actionDisabled(availability);
    }
    const parsed = spec.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    const data = readRecord(parsed.data);

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
          preview: await buildApprovalPreview({
            deps,
            actionId,
            input: parsed.data,
            context: ctx,
          }),
          ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
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
          ...(ctx.reviewCommentPrincipal ? { reviewCommentPrincipal: ctx.reviewCommentPrincipal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }

      if (
        actionId === 'plugins.scaffold'
        || actionId === 'plugins.install'
        || actionId === 'plugins.uninstall'
        || actionId === 'plugins.reload'
        || actionId === 'plugins.list'
      ) {
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

      if (isRuntimeActionIdV1(actionId)) {
        const result = await dispatchRuntimeAction({
          actionId,
          input: parsed.data,
          context: ctx,
          runtimeActionExecute: deps.runtimeActionExecute,
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
        if (reviewInput.profileId && engineIds.length !== 1) {
          return {
            ok: false,
            errorCode: 'execution_run_profile_requires_single_engine',
            error: 'execution_run_profile_requires_single_engine',
          };
        }
        const instructions = reviewInput.instructions.trim();
        const permissionDecision = resolveAgentPermission(ctx, reviewInput.permissionMode, [
          'read_only',
          'default',
          'workspace_write',
          'yolo',
        ]);
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
            backendTarget: normalizeExecutionBackendTargetValue(engineId),
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
                backendTarget: normalizeExecutionBackendTargetValue(engineId),
                instructions,
                permissionMode,
                retentionPolicy: 'resumable',
                runClass: 'bounded',
                // Reviews should stream sidechain progress (and tool traffic) into the parent session.
                ioMode: 'streaming',
                ...(reviewInput.profileId && reviewInput.profileGenerationId
                  ? {
                      profileId: reviewInput.profileId,
                      profileGenerationId: reviewInput.profileGenerationId,
                    }
                  : {}),
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

        const backendTargetKeys: readonly string[] = Array.isArray(data.backendTargetKeys)
          ? data.backendTargetKeys
          : [];
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
        const permissionModeDefault = intent === 'delegate' ? 'workspace_write' : 'read_only';
        const requestedPermissionMode = data.permissionMode ?? permissionModeDefault;
        const permissionDecision = resolveAgentPermission(ctx, requestedPermissionMode, [
          'read_only',
          'default',
          'workspace_write',
          'yolo',
        ]);
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : requestedPermissionMode;

          const runOptions = resolveRunStartModelAndConfig(data);
          if (!runOptions.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const connectedServicesByBackendTargetKey = data.connectedServicesByBackendTargetKey;
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
            Readonly<{ bindings: ConnectedServiceBindingsV1 | undefined; defaultServiceIds: readonly string[] }>
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
              const targetSelection = connectedServicesByTargetKey.get(backendTargetKey);
              const connectedServices = targetSelection?.bindings;
              const connectedServicesDefaultServiceIds = targetSelection?.defaultServiceIds ?? [];
              return deps.executionRunStart(
                sessionId,
                {
                  intent,
                  backendTarget: normalizeExecutionBackendTargetValue(backendTargetKey),
                  instructions,
                  permissionMode,
                  retentionPolicy: data.retentionPolicy ?? 'ephemeral',
                  runClass: data.runClass ?? 'bounded',
                  ioMode: data.ioMode ?? 'request_response',
                  ...(typeof data.profileId === 'string' && typeof data.profileGenerationId === 'string'
                    ? {
                        profileId: data.profileId,
                        profileGenerationId: data.profileGenerationId,
                      }
                    : {}),
                  ...(runOptions.options.modelId ? { modelId: runOptions.options.modelId } : {}),
                  ...(runOptions.options.sessionConfigOptionOverrides
                    ? { sessionConfigOptionOverrides: runOptions.options.sessionConfigOptionOverrides }
                    : {}),
                  ...(connectedServices ? { connectedServices } : {}),
                  ...(connectedServicesDefaultServiceIds.length > 0
                    ? { connectedServicesDefaultServiceIds }
                    : {}),
                  intentInput: { ...data, backendTargetKey },
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
                query: typeof data.query === 'string' ? data.query : '',
                limit: typeof data.limit === 'number' ? data.limit : undefined,
                isActionEnabled: (id) => isActionEnabled(getActionSpec(id), ctx),
              }),
            },
          };
        }

        if (actionId === 'action.spec.get') {
          try {
            const requestedSpec = getActionSpec(String(data.id) as ActionId);
            const requestedAvailability = resolveAvailabilityForContext(requestedSpec, ctx);
            if (requestedAvailability ? !requestedAvailability.available : !isActionEnabled(requestedSpec, ctx)) {
              return actionDisabled(requestedAvailability);
            }
            return { ok: true, result: { actionSpec: serializeActionSpec(requestedSpec) } };
          } catch {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
        }

        if (actionId === 'action.options.resolve') {
          const actionIdRaw = normalizeId(data.actionId);
          const fieldPath = normalizeId(data.fieldPath);
          const directOptionsSourceId = normalizeId(data.optionsSourceId);
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

            optionsSourceId = normalizeId(readRecord(field).optionsSourceId) || directOptionsSourceId;
          }

          if (!optionsSourceId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }

          const dynamic = await resolveDynamicActionOptions({
            deps,
            ctx,
            optionsSourceId,
            input: data,
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
                data,
              ),
            },
          };
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
          const res = await deps.subagentsUpsert(parsed.data as SubagentRefInputV1);
          return completeActionResult(res);
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
          return completeActionResult(res);
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
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;

          const runOptions = resolveRunStartModelAndConfig(data);
          if (!runOptions.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const request: Record<string, unknown> = { ...data };
          delete request.sessionId;
          // The `configOptions` shorthand is merged into the canonical `sessionConfigOptionOverrides`
          // above; never forward it as a second vocabulary on the run request.
          delete request.configOptions;
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
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
          const permissionDecision = resolveAgentPermission(ctx, request.permissionMode, [
            'read_only',
            'default',
            'workspace_write',
            'yolo',
          ]);
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          if (permissionDecision?.ok === true) {
            request.permissionMode = permissionDecision.requestedMode;
          }
          const res = await deps.executionRunStart(sessionId, request, opts);
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.list') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunList(sessionId, parsed.data, opts);
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.get') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunGet(sessionId, { runId: data.runId, includeStructured: data.includeStructured === true }, opts);
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunSend(sessionId, {
            runId: data.runId,
            message: data.message,
            delivery: typeof data.delivery === 'string'
              ? data.delivery
              : 'steer_if_supported',
            ...(data.resume === true ? { resume: true } : {}),
          }, opts);
          return completeActionResult(res);
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
            runId: data.runId,
            ...(data.resume === true ? { resume: true } : {}),
          }, opts);
          return completeActionResult(res);
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
            ...(data.runId ? { runId: data.runId } : {}),
            ...(data.start ? { start: data.start } : {}),
            ...(data.resume === true ? { resume: true } : {}),
          }, opts);
          return completeActionResult(res);
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
            runId: data.runId,
            message: data.message,
            ...(data.displayMessage ? { displayMessage: data.displayMessage } : {}),
            ...(data.resume === true ? { resume: true } : {}),
          }, opts);
          return completeActionResult(res);
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
            runId: data.runId,
            streamId: data.streamId,
            ...(typeof data.cursor === 'number' ? { cursor: data.cursor } : {}),
            ...(typeof data.maxEvents === 'number' ? { maxEvents: data.maxEvents } : {}),
          }, opts);
          return completeActionResult(res);
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
            runId: data.runId,
            streamId: data.streamId,
          }, opts);
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.stop') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunStop(sessionId, { runId: data.runId }, opts);
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.action') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunAction(sessionId, { runId: data.runId, actionId: data.actionId, input: data.input }, opts);
          return completeActionResult(res);
        }

        if (actionId === 'execution.run.wait') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunWait(sessionId, {
            runId: data.runId,
            ...(typeof data.timeoutSeconds === 'number' ? { timeoutSeconds: data.timeoutSeconds } : {}),
            ...(typeof data.pollIntervalMs === 'number' ? { pollIntervalMs: data.pollIntervalMs } : {}),
          }, opts);
          return completeActionResult(res);
        }

        if (actionId === 'session.open') {
          const explicitSessionId = normalizeId(data.sessionId);
          const titleResolution = explicitSessionId ? null : await resolveSessionIdByTitle(deps, data.sessionTitle);
          if (titleResolution?.kind === 'ambiguous') {
            return { ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' };
          }
          const sessionId =
            explicitSessionId || (titleResolution?.kind === 'resolved' ? titleResolution.sessionId : null);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionOpen({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.fork') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionFork({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.continue_with_replay') {
          if (!deps.sessionContinueWithReplay) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.continue_with_replay' };
          }
          const res = await deps.sessionContinueWithReplay(parsed.data as SessionContinueWithReplayRpcParams);
          return completeActionResult(res);
        }

        if (actionId === 'session.rollback') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const rawTarget = data?.target;
          const target = rawTarget && typeof rawTarget === 'object' ? (rawTarget as SessionRollbackTarget) : undefined;
          const res = await deps.sessionRollback({ sessionId, ...(serverId ? { serverId } : {}), ...(target ? { target } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.checkpoint_code_rollback') {
          if (!deps.checkpointCodeRollback) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint_code_rollback' };
          }
          const request = parsed.data as CheckpointCodeRollbackActionRequest;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.checkpointCodeRollback({ request, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.checkpoint') {
          if (!deps.sessionCheckpoint) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint' };
          }
          const request = parsed.data as SessionCheckpointRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionCheckpoint({ request, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.restore') {
          if (!deps.sessionRestore) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.restore' };
          }
          const request = parsed.data as SessionRestoreRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionRestore({ request, ...(serverId ? { serverId } : {}) });
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
          const workspaceTransferParsed = SessionHandoffWorkspaceTransferSchema.safeParse(data.workspaceTransfer);
          const workspaceTransfer = workspaceTransferParsed.success ? workspaceTransferParsed.data : undefined;
          const res = await deps.sessionHandoffStart({
            sessionId,
            targetMachineId,
            ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
            ...(workspaceTransfer ? { workspaceTransfer } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
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

        if (actionId === 'session.spawn_new') {
          const spawnInput = data;
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: readNonEmptyString(spawnInput.agentId),
            backendTargetKey: readNonEmptyString(spawnInput.backendTargetKey),
            backendTarget: spawnInput.backendTarget as Parameters<typeof resolveActionBackendTargetSelection>[0]['backendTarget'],
            runtimeDescriptorV1: spawnInput.runtimeDescriptorV1 as Parameters<typeof resolveActionBackendTargetSelection>[0]['runtimeDescriptorV1'],
          });
          if (!resolvedSelection.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const permissionDecision = typeof spawnInput.permissionMode === 'string' && spawnInput.permissionMode.trim().length > 0
            ? assertAgentPermission(ctx, spawnInput.permissionMode)
            : null;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const effectiveSpawnInput = permissionDecision?.ok === true
            ? { ...spawnInput, permissionMode: permissionDecision.normalizedMode }
            : spawnInput;
          const res = await deps.sessionSpawnNew(buildSessionSpawnNewArgs(effectiveSpawnInput, resolvedSelection.selection, ctx));
          return completeSpawnActionResult(res);
        }

        if (actionId === 'session.spawn_picker') {
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: readOptionalString(data.agentId),
            backendTargetKey: readOptionalString(data.backendTargetKey),
          });
          if (!resolvedSelection.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.sessionSpawnPicker({
            ...((data.tag) ? { tag: String(data.tag) } : {}),
            ...(resolvedSelection.selection.agentId ? { agentId: resolvedSelection.selection.agentId } : {}),
            ...((data.modelId) ? { modelId: String(data.modelId) } : {}),
            ...(data.providerConnectionId !== undefined
              ? { providerConnectionId: data.providerConnectionId === null ? null : String(data.providerConnectionId) }
              : {}),
            ...(resolvedSelection.selection.backendTargetKey ? { backendTargetKey: resolvedSelection.selection.backendTargetKey } : {}),
            ...((data.initialMessage) ? { initialMessage: String(data.initialMessage) } : {}),
          });
          return completeSpawnActionResult(res);
        }

        if (actionId === 'paths.list_recent') {
          const res = await deps.pathsListRecent({
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
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
          });
          return completeActionResult(res);
        }

        if (actionId === 'agents.backends.list') {
          const res = await deps.agentsBackendsList({
            ...(typeof data.includeDisabled === 'boolean' ? { includeDisabled: data.includeDisabled } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
          });
          return completeActionResult(res);
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
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(backendTargetKey ? { backendTargetKey } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'agents.config_options.list') {
          if (!deps.agentsConfigOptionsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.config_options.list' };
          }
          const selectionArgs = buildAgentInventorySelectionArgs(data);
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsConfigOptionsList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((data.modelId) ? { modelId: String(data.modelId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'agents.session_modes.list') {
          if (!deps.agentsSessionModesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.session_modes.list' };
          }
          const selectionArgs = buildAgentInventorySelectionArgs(data);
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.agentsSessionModesList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.profiles.list') {
          if (!deps.spawnProfilesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.profiles.list' };
          }
          const selectionArgs = buildAgentInventorySelectionArgs(data);
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
          const selectionArgs = buildAgentInventorySelectionArgs(data);
          if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.spawnConnectedServicesList({
            ...selectionArgs,
            ...(typeof data.includeUnavailable === 'boolean' ? { includeUnavailable: data.includeUnavailable } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.mcp_servers.preview') {
          if (!deps.spawnMcpServersPreview) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
          }
          const selectionArgs = buildAgentInventorySelectionArgs(data);
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
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const modelOverrideRaw = Object.prototype.hasOwnProperty.call(data, 'modelOverride')
            ? data.modelOverride
            : undefined;
          const providerConnectionIdRaw = Object.prototype.hasOwnProperty.call(data, 'providerConnectionId')
            ? data.providerConnectionId
            : undefined;
          const permissionOverrideRaw = data.permissionModeOverride;
          const permissionDecision = typeof permissionOverrideRaw === 'string' && permissionOverrideRaw.trim().length > 0
            ? assertAgentPermission(ctx, permissionOverrideRaw)
            : null;
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const permissionModeOverride = permissionDecision?.ok === true
            ? permissionDecision.normalizedMode
            : typeof permissionOverrideRaw === 'string' && permissionOverrideRaw.trim().length > 0
              ? permissionOverrideRaw
              : undefined;
          const res = await deps.sessionSendMessage({
            sessionId,
            message: String(data.message ?? ''),
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
            ...(isAgentCaller(ctx)
              ? { callerSurface: 'agent' as const, callerPermissionMode: ctx.callerPermissionMode ?? null }
              : {}),
          });
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
          const res = await deps.sessionTitleSet({ sessionId, title, ...(serverId ? { serverId } : {}) });
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
          const permissionDecision = assertAgentPermission(ctx, permissionMode);
          if (permissionDecision?.ok === false) {
            return createPermissionPolicyResult(ctx, permissionDecision);
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionModeSet({
            sessionId,
            permissionMode: permissionDecision?.ok === true ? permissionDecision.normalizedMode : permissionMode,
            ...(serverId ? { serverId } : {}),
            ...(isAgentCaller(ctx)
              ? { callerSurface: 'agent' as const, callerPermissionMode: ctx.callerPermissionMode ?? null }
              : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.model.set') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionModelSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.model.set' };
          }
          const modelId = normalizeId(data.modelId);
          if (!modelId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const providerConnectionId = data.providerConnectionId === null
            ? null
            : normalizeId(data.providerConnectionId);
          if (data.providerConnectionId !== undefined && data.providerConnectionId !== null && !providerConnectionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionModelSet({
            sessionId,
            modelId,
            ...(data.providerConnectionId !== undefined ? { providerConnectionId } : {}),
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
            sessionId,
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
          const res = await deps.sessionWaitIdle({ sessionId, timeoutSeconds, ...(serverId ? { serverId } : {}) });
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
            decision,
            requestId: hasOwn(data, 'requestId') ? readNullableString(data.requestId) : null,
            ...(Array.isArray(data.allowedTools) ? { allowedTools: data.allowedTools } : {}),
            ...(hasOwn(data, 'updatedPermissions') ? { updatedPermissions: data.updatedPermissions } : {}),
            ...(hasOwn(data, 'execPolicyAmendment') ? { execPolicyAmendment: data.execPolicyAmendment } : {}),
            ...(serverId ? { serverId } : {}),
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
          const raw = data.sessionId;
          const explicitSessionId = raw === null ? null : normalizeId(raw);
          const titleResolution =
            raw === null || explicitSessionId ? null : await resolveSessionIdByTitle(deps, data.sessionTitle);
          if (titleResolution?.kind === 'ambiguous') {
            return { ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' };
          }
          const sessionId =
            raw === null
              ? null
              : explicitSessionId || (titleResolution?.kind === 'resolved' ? titleResolution.sessionId : null);
          const res = await deps.sessionTargetPrimarySet({ sessionId: sessionId || null });
          return completeActionResult(res);
        }

        if (actionId === 'session.target.tracked.set') {
          const res = await deps.sessionTargetTrackedSet({
            sessionIds: Array.isArray(data.sessionIds) ? ((data.sessionIds as unknown[]).map((v) => String(v))) : [],
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.list') {
          const res = await deps.sessionList({
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: readNullableString(data.cursor) } : {}),
            ...(typeof data.includeLastMessagePreview === 'boolean' ? { includeLastMessagePreview: data.includeLastMessagePreview } : {}),
            ...(typeof data.activeOnly === 'boolean' ? { activeOnly: data.activeOnly } : {}),
            ...(typeof data.archivedOnly === 'boolean' ? { archivedOnly: data.archivedOnly } : {}),
            ...(typeof data.includeSystem === 'boolean' ? { includeSystem: data.includeSystem } : {}),
            ...(typeof data.resumableOnly === 'boolean' ? { resumableOnly: data.resumableOnly } : {}),
            ...(typeof data.includeRows === 'boolean' ? { includeRows: data.includeRows } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.activity.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionActivityGet({
            sessionId,
            ...(typeof data.windowSeconds === 'number' ? { windowSeconds: data.windowSeconds } : {}),
          });
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
          const res = await deps.sessionTranscriptGet({
            sessionId,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: readNullableString(data.cursor) } : {}),
            roles,
            ...(hasOwn(data, 'maxCharsPerMessage') ? { maxCharsPerMessage: typeof data.maxCharsPerMessage === 'number' ? data.maxCharsPerMessage : null } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'memory.search') {
          const machineId = normalizeId(data.machineId);
          if (!machineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const query = data.query as MemorySearchQueryV1;
          const res = await deps.daemonMemorySearch({ machineId, query, serverId: normalizeId(ctx.serverId) || null });
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
        if (isApprovalActionId(targetActionId)) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }

        // Approvals eligibility is policy-driven (settings/surface), not safety-driven.
        // Safety metadata remains useful for UI copy and defaults, but it is not a hard gate here.
        const targetSpec = getActionSpec(targetActionId);
        const parsedTargetArgs = targetSpec.inputSchema.safeParse(data.actionArgs ?? {});
        if (!parsedTargetArgs.success) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
        const requestedSurface = parseActionSurfaceKey(ctx.surface);
        const createdBy: ApprovalRequestV1['createdBy'] = {
          surface: forcedSurface,
          ...(rawAgentId ? { agentId: rawAgentId } : {}),
          ...(requestSessionId ? { sessionId: requestSessionId } : {}),
        };

        const summary = String(data.summary ?? '').trim();
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
          ...(Object.prototype.hasOwnProperty.call(data, 'preview') ? { preview: data.preview } : {}),
        };
        const res = await deps.approvalsCreate({ request, serverId: normalizeId(ctx.serverId) || null });
        return completeActionResult(res);
      }

      if (actionId === 'approval.request.decide') {
        if (!deps.approvalsGet || !deps.approvalsUpdate) {
          return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
        }

        const artifactId = normalizeId(data.artifactId);
        if (!artifactId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };

        const existingRaw = await deps.approvalsGet({ artifactId, serverId: normalizeId(ctx.serverId) || null });
        if (!existingRaw) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };

        const existingParsed = ApprovalRequestV1Schema.safeParse(existingRaw);
        if (!existingParsed.success) return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
        const existing = existingParsed.data;
        const effectiveServerId = normalizeId(ctx.serverId) || normalizeId(existing.serverId) || null;
        const decision = data.decision;

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
          const updateFailure = readActionFailureEnvelope(updated);
          if (updateFailure) return updateFailure;
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
          const approvalFailure = readActionFailureEnvelope(approved);
          if (approvalFailure) return approvalFailure;
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
