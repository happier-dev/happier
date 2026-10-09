import {
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
  type ReviewCommentPrincipalHeaderV1,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap, resolveActionToolCatalogAvailability } from './actionToolCatalog';
import { normalizeExecutionRunToolResult } from './executionRunToolResult';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { bindContextualActionToolInput } from './actionToolContext';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string; details?: unknown }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{
      defaultSessionId: string;
      defaultSessionMachineId?: string | null;
      surface: 'mcp' | 'cli' | 'agent';
      authority?: 'account_automation';
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      callerPermissionMode?: string | null;
      causalPermissionAuthority?: unknown;
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
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

type DynamicActionOptionsResult = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  options: readonly ResolvedActionOption[];
}>;

type DynamicActionOptionsBridgeResult =
  | Readonly<{ ok: true; result: DynamicActionOptionsResult }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

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

function normalizeActionExecutorResult(result: ActionExecutorResult): ActionToolBridgeResult {
  return result.ok
    ? { ok: true, result: result.result }
    : {
        ok: false,
        errorCode: result.errorCode,
        error: result.error,
        ...(result.details !== undefined ? { details: result.details } : {}),
      };
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
    return {
      ok: false,
      errorCode: result.errorCode,
      error: result.error,
      ...(result.details !== undefined ? { details: result.details } : {}),
    };
  }

  return normalizeExecutionRunToolResult(
    result.result,
    actionId === 'execution.run.wait'
      ? { runId: readTrimmedStringField(isInputRecord(input) ? input : {}, 'runId') }
      : undefined,
  );
}

async function buildActionExecutorContext(params: Readonly<{
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  surface: 'mcp' | 'cli' | 'agent';
  options?: ActionToolExecutionOptions;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveActiveTurnPermissionWitness?: (() => Promise<unknown> | unknown) | null;
  sessionInputVia?: 'action' | 'mcp';
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: (() => unknown) | null;
  resolveRuntimeRunId?: () => string | undefined;
  actionsSettings?: ActionsSettingsV1 | null;
  expectedContributorOccurrenceId?: string;
  sessionListAccess?: 'current_session' | 'led_subtree';
  resolveReviewCommentActor?: (() => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null) | null;
}>): Promise<Readonly<{
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  surface: 'mcp' | 'cli' | 'agent';
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  authority?: 'account_automation';
  callerPermissionMode?: string | null;
  causalPermissionAuthority?: unknown;
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
  const callerPermissionMode = params.surface === 'agent' && params.resolveCallerPermissionMode
    ? await params.resolveCallerPermissionMode()
    : null;
  const reviewActor = params.surface !== 'cli' ? params.resolveReviewCommentActor?.() : null;
  const hasActiveTurnPermissionWitnessResolver =
    params.surface === 'agent'
    && typeof params.resolveActiveTurnPermissionWitness === 'function';
  let causalPermissionAuthority: unknown = null;
  let activeTurnId: string | null = null;
  if (hasActiveTurnPermissionWitnessResolver) {
    try {
      const rawWitness = await params.resolveActiveTurnPermissionWitness!();
      const witness = isInputRecord(rawWitness) ? rawWitness : null;
      causalPermissionAuthority = witness?.causalPermissionAuthority ?? null;
      activeTurnId = typeof witness?.turnId === 'string' && witness.turnId.trim().length > 0
        ? witness.turnId.trim()
        : null;
    } catch {
      // An active-turn reader failure is non-authorizing; do not fall back to
      // the mutable Session permission mode for an agent-originated call.
      causalPermissionAuthority = null;
    }
  }
  const sessionAgentSpawnPolicyV1 =
    params.getSessionAgentSpawnPolicyV1
      ? params.getSessionAgentSpawnPolicyV1()
      : params.sessionAgentSpawnPolicyV1;
  const origin = params.options?.approvalOrigin;
  const runtimeRunId = params.surface === 'agent' ? params.resolveRuntimeRunId?.() : undefined;
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
    ...(params.options?.signal ? { signal: params.options.signal } : {}),
    ...(params.options?.onWaitSnapshot ? { onWaitSnapshot: params.options.onWaitSnapshot } : {}),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(callerPermissionMode ? { callerPermissionMode } : {}),
    ...(hasActiveTurnPermissionWitnessResolver
      ? { causalPermissionAuthority: causalPermissionAuthority ?? null }
      : {}),
    ...(hasActiveTurnPermissionWitnessResolver && activeTurnId
      ? {
          sessionInputSource: {
            sourceSessionId: params.defaultSessionId,
            sourceTurnId: activeTurnId,
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
  surface?: 'mcp' | 'cli' | 'agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveActiveTurnPermissionWitness?: (() => Promise<unknown> | unknown) | null;
  /** Reads identity from the live host Session client, never tool arguments. */
  resolveReviewCommentActor?: (() => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null) | null;
  sessionInputVia?: 'action' | 'mcp';
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: (() => unknown) | null;
  resolveRuntimeRunId?: () => string | undefined;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  requiredDirectActionIds?: readonly ActionId[];
  defaultSessionMachineId?: string | null;
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
  const actionToolNameToId = createActionToolNameToIdMap({
    surface,
    isActionEnabled,
    actionsSettings: readActionsSettings(),
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
    requiredDirectActionIds: params.requiredDirectActionIds,
  });
  const resolveAvailability = (actionId: string) => resolveActionToolCatalogAvailability({
    actionId,
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
        const availability = resolveAvailability(actionId);
        if (!availability.available) {
          return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled', details: availability };
        }
        const actionInput = bindContextualActionToolInput({
          actionId,
          input: argsRecord && Object.prototype.hasOwnProperty.call(argsRecord, 'input')
            ? normalizeActionExecuteInput(argsRecord.input)
            : {},
          context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId },
          registry: params.registry,
          pluginToolCatalog: params.pluginToolCatalog,
        });
        return normalizeActionToolResult(actionId, await params.executor.execute(
          actionId as ActionId,
          actionInput,
          await buildActionExecutorContext({
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
                pluginToolCatalog: params.pluginToolCatalog,
              }),
          }),
        ), actionInput);
      }

      const actionId = actionToolNameToId.get(toolName);
      if (!actionId) {
        return { ok: false, errorCode: 'unknown_tool', error: `Unknown action-backed tool: ${toolName}` };
      }
      const availability = resolveAvailability(actionId);
      if (!availability.available) {
        return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled', details: availability };
      }

      const actionInput = bindContextualActionToolInput({
        actionId,
        input: toolArgs,
        context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId },
        registry: params.registry,
        pluginToolCatalog: params.pluginToolCatalog,
      });
      return normalizeActionToolResult(actionId, await params.executor.execute(
        actionId as ActionId,
        actionInput,
        await buildActionExecutorContext({
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
        {
          defaultSessionId,
          surface,
          ...(surface === 'agent' ? { authority: 'account_automation' as const } : {}),
          actionsSettings: readActionsSettings(),
        },
      );
      if (!result.ok) {
        return {
          ok: false,
          errorCode: result.errorCode,
          error: result.error,
          ...(result.details === undefined ? {} : { details: result.details }),
        };
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
