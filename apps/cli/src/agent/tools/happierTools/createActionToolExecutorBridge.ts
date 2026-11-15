import {
  type ActionId,
  type ActionExecuteResult,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
  type ReviewCommentPrincipalHeaderV1,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap, resolveActionToolCatalogAvailability, resolveDiscoveredPluginActionAvailability } from './actionToolCatalog';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { isAgentStartActionInvocationV1, requiresActionAgentStartDepthV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizeExecutionRunToolResult } from './executionRunToolResult';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { bindContextualActionToolInput } from './actionToolContext';
import { materializeActionRequestAttributionV1, type ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

type ActionExecutorResult = ActionExecuteResult;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{
      defaultSessionId: string;
      defaultSessionMachineId?: string | null;
      surface: import('./actionToolCatalog').HappierBuiltInToolSurface;
      authority?: 'account_automation';
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      callerPermissionMode?: string | null;
      causalPermissionAuthority?: unknown;
      nativeRealtimeInput?: true;
      actionRequestAttributionV1?: ActionRequestAttributionV1;
      sessionInputSource?: unknown;
      sessionAgentSpawnPolicyV1?: unknown;
      runtimeRunId?: string;
      actionsSettings?: ActionsSettingsV1 | null;
      actionRequestId?: string | null;
      signal?: AbortSignal;
      onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
      expectedContributorOccurrenceId?: string;
      sessionListAccess?: 'current_session' | 'led_subtree';
      reviewCommentPrincipal?: ReviewCommentPrincipalHeaderV1;
    }>,
  ) => Promise<ActionExecutorResult>;
}>;

type ActionToolBridgeResult =
  | Readonly<{ ok: true; result: unknown }>
  | ActionExecuteFailure;

type DynamicActionOptionsResult = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  options: readonly ResolvedActionOption[];
}>;

type DynamicActionOptionsBridgeResult =
  | Readonly<{ ok: true; result: DynamicActionOptionsResult }>
  | ActionExecuteFailure;

export type ResolveActionOptionsInput = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  sessionId: string | null;
  limit: number | null;
  query: string | null;
}> & Readonly<Record<string, unknown>>;

export type ActionToolExecutionOptions = Readonly<{
  signal?: AbortSignal;
  onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  /** Host-stamped invocation identity; independent from descriptive transcript provenance. */
  actionRequestId?: string | null;
}>;

function normalizeActionExecutorFailure(result: Extract<ActionExecutorResult, { ok: false }>): ActionExecuteFailure {
  const { operationCredentialUses: _operationCredentialUses, ...failure } = result;
  return failure;
}

function normalizeActionExecutorResult(result: ActionExecutorResult): ActionToolBridgeResult {
  return result.ok ? { ok: true, result: result.result } : normalizeActionExecutorFailure(result);
}

function normalizeActionToolResult(
  actionId: string,
  result: ActionExecutorResult,
  input: unknown,
): ActionToolBridgeResult {
  if (result.ok && isInputRecord(result.result) && result.result.kind === 'approval_request_created') {
    return { ok: true, result: result.result };
  }
  if (!actionId.startsWith('execution.run.')) {
    return normalizeActionExecutorResult(result);
  }

  if (!result.ok) {
    return normalizeActionExecutorResult(result);
  }

  return normalizeExecutionRunToolResult(
    result.result,
    actionId === 'execution.run.wait'
      ? { runId: readTrimmedStringField(isInputRecord(input) ? input : {}, 'runId') }
      : undefined,
  );
}

async function buildActionExecutorContext(params: Readonly<{
  actionId: string;
  input: unknown;
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  surface: import('./actionToolCatalog').HappierBuiltInToolSurface;
  options?: ActionToolExecutionOptions;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveActiveTurnPermissionWitness?: (() => Promise<unknown> | unknown) | null;
  sessionInputVia?: 'action' | 'mcp';
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: ((signal?: AbortSignal) => unknown) | null;
  resolveRuntimeRunId?: () => string | undefined;
  actionsSettings?: ActionsSettingsV1 | null;
  expectedContributorOccurrenceId?: string;
  sessionListAccess?: 'current_session' | 'led_subtree';
  resolveReviewCommentActor?: (() => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null) | null;
}>): Promise<Readonly<{
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  surface: import('./actionToolCatalog').HappierBuiltInToolSurface;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  authority?: 'account_automation';
  callerPermissionMode?: string | null;
  causalPermissionAuthority?: unknown;
  nativeRealtimeInput?: true;
  signal?: AbortSignal;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  sessionInputSource?: unknown;
  sessionAgentSpawnPolicyV1?: unknown;
  actionsSettings?: ActionsSettingsV1 | null;
  runtimeRunId?: string;
  actionRequestId?: string | null;
  expectedContributorOccurrenceId?: string;
  sessionListAccess?: 'current_session' | 'led_subtree';
  reviewCommentPrincipal?: ReviewCommentPrincipalHeaderV1;
  onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
}>> {
  let callerPermissionMode = (params.surface === 'agent' || params.surface === 'voice') && params.resolveCallerPermissionMode
    ? await params.resolveCallerPermissionMode()
    : null;
  const reviewActor = params.surface !== 'cli' ? params.resolveReviewCommentActor?.() : null;
  const hasActiveTurnPermissionWitnessResolver =
    params.surface !== 'cli'
    && typeof params.resolveActiveTurnPermissionWitness === 'function';
  let causalPermissionAuthority: unknown = null;
  let activeTurnAttribution: unknown;
  let activeDiscussionAddressing: unknown;
  let activeTurnId: string | null = null;
  let activeInputId: string | null = null;
  let nativeRealtimeInput = false;
  let admissionSignal: AbortSignal | undefined;
  if (hasActiveTurnPermissionWitnessResolver) {
    try {
      const rawWitness = await params.resolveActiveTurnPermissionWitness!();
      const witness = isInputRecord(rawWitness) ? rawWitness : null;
      nativeRealtimeInput = isInputRecord(witness?.nativeRealtimeAdmission);
      admissionSignal = witness?.signal instanceof AbortSignal ? witness.signal : undefined;
      if (nativeRealtimeInput) callerPermissionMode = typeof witness?.callerPermissionMode === 'string'
        ? witness.callerPermissionMode : null;
      causalPermissionAuthority = witness?.causalPermissionAuthority ?? null;
      activeTurnAttribution = witness?.actionRequestAttributionV1;
      activeDiscussionAddressing = witness?.discussionAddressing;
      activeTurnId = typeof witness?.turnId === 'string' && witness.turnId.trim().length > 0
        ? witness.turnId.trim()
        : null;
      activeInputId = typeof witness?.inputId === 'string' && witness.inputId.trim().length > 0
        ? witness.inputId.trim()
        : null;
    } catch {
      // An active-turn reader failure is non-authorizing; do not fall back to
      // the mutable Session permission mode for an agent-originated call.
      causalPermissionAuthority = null;
    }
  }
  const signal = params.options?.signal && admissionSignal
    ? AbortSignal.any([params.options.signal, admissionSignal]) : params.options?.signal ?? admissionSignal;
  const sessionAgentSpawnPolicyV1 =
    params.getSessionAgentSpawnPolicyV1 && (requiresActionAgentStartDepthV1(params.actionId)
      || isAgentStartActionInvocationV1(params.actionId, isInputRecord(params.input) ? params.input : {}))
      ? await params.getSessionAgentSpawnPolicyV1(signal)
      : params.sessionAgentSpawnPolicyV1;
  const origin = params.options?.approvalOrigin;
  const runtimeRunId = (params.surface === 'agent' || params.surface === 'voice') ? params.resolveRuntimeRunId?.() : undefined;
  const explicitActionRequestId = params.options?.actionRequestId;
  const actionRequestId = typeof explicitActionRequestId === 'string'
    && explicitActionRequestId.trim().length > 0
    ? explicitActionRequestId.trim()
    : origin
      ? [origin.toolCallId, origin.mcpRequestId, origin.messageId, origin.parentMessageId]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          ?.trim() ?? null
      : null;
  return {
    defaultSessionId: params.defaultSessionId,
    ...(runtimeRunId ? { runtimeRunId } : {}),
    ...(params.defaultSessionMachineId ? { defaultSessionMachineId: params.defaultSessionMachineId } : {}),
    surface: params.surface,
    ...(reviewActor && reviewActor.sessionId === params.defaultSessionId ? { reviewCommentPrincipal: { actor: reviewActor } } : {}),
    ...(params.surface === 'agent' ? { authority: 'account_automation' as const } : {}),
    ...(params.sessionListAccess
      ? { sessionListAccess: params.sessionListAccess }
      : params.surface === 'agent'
        ? { sessionListAccess: 'led_subtree' as const }
        : {}),
    ...(params.options?.approvalOrigin ? { approvalOrigin: params.options.approvalOrigin } : {}),
    ...(signal ? { signal } : {}),
    ...(nativeRealtimeInput ? { nativeRealtimeInput: true as const } : {}),
    ...(params.options?.onWaitSnapshot ? { onWaitSnapshot: params.options.onWaitSnapshot } : {}),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(callerPermissionMode ? { callerPermissionMode } : {}),
    ...(hasActiveTurnPermissionWitnessResolver
      ? { causalPermissionAuthority: causalPermissionAuthority ?? null }
      : {}),
    ...(activeTurnAttribution !== undefined
      ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(activeTurnAttribution) }
      : {}),
    ...(hasActiveTurnPermissionWitnessResolver && activeTurnId
      ? {
          sessionInputSource: {
            sourceSessionId: params.defaultSessionId,
            sourceTurnId: activeTurnId,
            ...(activeInputId ? { sourceInputId: activeInputId } : {}),
            ...(activeDiscussionAddressing !== undefined ? { discussionAddressing: activeDiscussionAddressing } : {}),
            via: params.sessionInputVia ?? 'action',
          },
        }
      : {}),
    ...(sessionAgentSpawnPolicyV1 !== undefined
      ? { sessionAgentSpawnPolicyV1 }
      : {}),
    ...(params.expectedContributorOccurrenceId
      ? { expectedContributorOccurrenceId: params.expectedContributorOccurrenceId }
      : {}),
    actionsSettings: params.actionsSettings ?? null,
  };
}

function resolveExpectedContributorOccurrenceId(params: Readonly<{
  actionId: string;
  toolName?: string;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): string | undefined {
  const occurrences = new Set(
    (params.pluginToolCatalog ?? [])
      .filter((tool) => (
        tool.actionId === params.actionId
        && (params.toolName === undefined || tool.name === params.toolName)
      ))
      .map((tool) => tool.expectedContributorOccurrenceId?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return occurrences.size === 1 ? [...occurrences][0] : undefined;
}

function normalizeActionExecuteInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;

  const trimmed = input.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return input;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function readTrimmedStringField(record: Record<string, unknown>, field: string): string {
  return readStringField(record, field)?.trim() ?? '';
}

function readActionOptionsPayload(payload: unknown): DynamicActionOptionsResult | null {
  if (!isInputRecord(payload)) return null;
  const actionId = readStringField(payload, 'actionId');
  const fieldPath = readStringField(payload, 'fieldPath');
  const optionsSourceId = readStringField(payload, 'optionsSourceId');
  const optionsCandidate = payload.options;

  return {
    actionId: actionId as ActionId | null,
    fieldPath,
    optionsSourceId,
    options: Array.isArray(optionsCandidate) ? optionsCandidate as readonly ResolvedActionOption[] : [],
  };
}

export function createActionToolExecutorBridge(params: Readonly<{
  executor: ActionExecutorLike;
  isActionEnabled?: (id: ActionId) => boolean;
  surface?: import('./actionToolCatalog').HappierBuiltInToolSurface;
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveActiveTurnPermissionWitness?: (() => Promise<unknown> | unknown) | null;
  /** Reads identity from the live host Session client, never tool arguments. */
  resolveReviewCommentActor?: (() => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null) | null;
  sessionInputVia?: 'action' | 'mcp';
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: ((signal?: AbortSignal) => unknown) | null;
  resolveRuntimeRunId?: () => string | undefined;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  requiredDirectActionIds?: readonly ActionId[];
  /** Map from the same admitted inventory used by tool registration. */
  actionToolNameToId?: ReadonlyMap<string, string>;
  defaultSessionMachineId?: string | null;
  defaultSessionRootPath?: string | null;
  /** Exact host-owned Session corpus available to non-Agent tool surfaces. */
  resolveSessionListAccess?: (defaultSessionId: string) => 'current_session' | 'led_subtree' | undefined;
}>): Readonly<{
  executeActionByToolName: (
    toolName: string,
    toolArgs: unknown,
    defaultSessionId: string,
    options?: ActionToolExecutionOptions,
  ) => Promise<ActionToolBridgeResult>;
  resolveActionOptions: (args: ResolveActionOptionsInput, defaultSessionId: string) => Promise<DynamicActionOptionsBridgeResult | null>;
  isActionEnabled: (id: ActionId) => boolean;
}> {
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  const surface = params.surface ?? 'agent';
  const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
  const actionToolNameToId = params.actionToolNameToId ?? createActionToolNameToIdMap({
    surface,
    isActionEnabled,
    actionsSettings: readActionsSettings(),
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
    requiredDirectActionIds: params.requiredDirectActionIds,
  });
  const resolveAvailability = (actionId: string, toolName?: string) => resolveActionToolCatalogAvailability({
    actionId,
    toolName,
    surface,
    isActionEnabled,
    actionsSettings: readActionsSettings(),
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });

  return {
    executeActionByToolName: async (toolName, toolArgs, defaultSessionId, options) => {
      if (toolName === 'action_execute') {
        const argsRecord = isInputRecord(toolArgs) ? toolArgs : null;
        const actionId = argsRecord ? readTrimmedStringField(argsRecord, 'actionId') : '';
        if (!actionId) {
          return { ok: false, errorCode: 'invalid_action_input', error: 'Missing actionId' };
        }
        const executorContext = await buildActionExecutorContext({
          actionId,
          input: argsRecord?.input,
          defaultSessionId,
          defaultSessionMachineId: params.defaultSessionMachineId,
          surface,
          options,
          resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          resolveActiveTurnPermissionWitness: params.resolveActiveTurnPermissionWitness,
          resolveReviewCommentActor: params.resolveReviewCommentActor,
          sessionInputVia: params.sessionInputVia,
          sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
          getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
          resolveRuntimeRunId: params.resolveRuntimeRunId,
          actionsSettings: readActionsSettings(),
          sessionListAccess: params.resolveSessionListAccess?.(defaultSessionId),
          expectedContributorOccurrenceId: resolveExpectedContributorOccurrenceId({ actionId, pluginToolCatalog: params.pluginToolCatalog }),
        });
        let definition: import('@happier-dev/protocol').ActionDefinitionV1 | null = null;
        if (parseQualifiedPluginActionId(actionId)) {
          const discovery = await params.executor.execute('action.spec.get', { id: actionId }, executorContext);
          if (!discovery.ok) return normalizeActionExecutorResult(discovery);
          const parsed = ActionDefinitionV1Schema.safeParse(isInputRecord(discovery.result) ? discovery.result.actionSpec : null);
          if (!parsed.success || parsed.data.id !== actionId) {
            return { ok: false, errorCode: 'action_disabled', error: 'Action is unavailable' };
          }
          definition = parsed.data;
        }
        const availability = definition
          ? resolveDiscoveredPluginActionAvailability({ actionId, surfaces: definition.surfaces, surface, actionsSettings: executorContext.actionsSettings })
          : resolveAvailability(actionId);
        if (!availability.available) {
          return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled', details: availability };
        }
        const actionInput = bindContextualActionToolInput({
          actionId,
          contextualDefaults: definition?.contextualDefaults,
          input: argsRecord && Object.prototype.hasOwnProperty.call(argsRecord, 'input')
            ? normalizeActionExecuteInput(argsRecord.input)
            : {},
          context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId, defaultSessionRootPath: params.defaultSessionRootPath },
          registry: params.registry,
          pluginToolCatalog: params.pluginToolCatalog,
        });
        return normalizeActionToolResult(actionId, await params.executor.execute(
          actionId as ActionId,
          actionInput,
          executorContext,
        ), actionInput);
      }

      const actionId = actionToolNameToId.get(toolName);
      if (!actionId) {
        return { ok: false, errorCode: 'unknown_tool', error: `Unknown action-backed tool: ${toolName}` };
      }
      const availability = resolveAvailability(actionId, toolName);
      if (!availability.available) {
        return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled', details: availability };
      }

      const actionInput = bindContextualActionToolInput({
        actionId,
        input: toolArgs,
        context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId, defaultSessionRootPath: params.defaultSessionRootPath },
        registry: params.registry,
        pluginToolCatalog: params.pluginToolCatalog,
      });
      return normalizeActionToolResult(actionId, await params.executor.execute(
        actionId as ActionId,
        actionInput,
        await buildActionExecutorContext({
          actionId,
          input: actionInput,
          defaultSessionId,
          defaultSessionMachineId: params.defaultSessionMachineId,
          surface,
          options,
          resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          resolveActiveTurnPermissionWitness: params.resolveActiveTurnPermissionWitness,
          resolveReviewCommentActor: params.resolveReviewCommentActor,
          sessionInputVia: params.sessionInputVia,
          sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
          getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
          resolveRuntimeRunId: params.resolveRuntimeRunId,
          actionsSettings: readActionsSettings(),
          sessionListAccess: params.resolveSessionListAccess?.(defaultSessionId),
          expectedContributorOccurrenceId:
            resolveExpectedContributorOccurrenceId({
              actionId,
              toolName,
              pluginToolCatalog: params.pluginToolCatalog,
            }),
        }),
      ), actionInput);
    },
    resolveActionOptions: async (args, defaultSessionId) => {
      const {
        actionId,
        fieldPath,
        optionsSourceId,
        sessionId,
        limit,
        query,
        ...context
      } = args;
      const input: Record<string, unknown> = { ...context };
      if (actionId) input.actionId = actionId;
      if (fieldPath) input.fieldPath = fieldPath;
      if (optionsSourceId) input.optionsSourceId = optionsSourceId;
      if (sessionId) input.sessionId = sessionId;
      if (typeof limit === 'number') input.limit = limit;
      if (typeof query === 'string') input.query = query;

      const result = await params.executor.execute(
        'action.options.resolve',
        input,
        await buildActionExecutorContext({ actionId: 'action.options.resolve', input, defaultSessionId, surface,
          actionsSettings: readActionsSettings(), resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          resolveActiveTurnPermissionWitness: params.resolveActiveTurnPermissionWitness,
          resolveReviewCommentActor: params.resolveReviewCommentActor,
          sessionInputVia: params.sessionInputVia,
          sessionListAccess: params.resolveSessionListAccess?.(defaultSessionId) }),
      );
      if (!result.ok) {
        return normalizeActionExecutorFailure(result);
      }

      const payload = readActionOptionsPayload(result.result);
      if (!payload) {
        return {
          ok: false,
          errorCode: 'action_options_resolve_failed',
          error: 'Options source resolution failed',
        };
      }

      return {
        ok: true,
        result: payload,
      } satisfies DynamicActionOptionsBridgeResult;
    },
    isActionEnabled,
  };
}
