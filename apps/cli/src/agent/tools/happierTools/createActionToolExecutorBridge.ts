import {
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
  actionAcceptsContextualSessionId,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap } from './actionToolCatalog';
import type { ResolveActionOptionsInput } from './actionSpecDiscovery';
import { normalizeExecutionRunToolResult } from './executionRunToolResult';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

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
      surface: 'mcp' | 'cli' | 'agent';
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      callerPermissionMode?: string | null;
      causalPermissionAuthority?: unknown;
      sessionAgentSpawnPolicyV1?: unknown;
      actionsSettings?: ActionsSettingsV1 | null;
      actionRequestId?: string | null;
      expectedContributorImmutableGenerationId?: string;
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

export type ActionToolExecutionOptions = Readonly<{
  approvalOrigin?: ApprovalRequestOriginV1 | null;
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
  surface: 'mcp' | 'cli' | 'agent';
  options?: ActionToolExecutionOptions;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveCausalPermissionAuthority?: (() => Promise<unknown> | unknown) | null;
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: (() => unknown) | null;
  actionsSettings?: ActionsSettingsV1 | null;
  expectedContributorImmutableGenerationId?: string;
}>): Promise<Readonly<{
  defaultSessionId: string;
  surface: 'mcp' | 'cli' | 'agent';
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  callerPermissionMode?: string | null;
  causalPermissionAuthority?: unknown;
  sessionAgentSpawnPolicyV1?: unknown;
  actionsSettings?: ActionsSettingsV1 | null;
  actionRequestId?: string | null;
  expectedContributorImmutableGenerationId?: string;
}>> {
  const callerPermissionMode = params.surface === 'agent' && params.resolveCallerPermissionMode
    ? await params.resolveCallerPermissionMode()
    : null;
  const hasCausalPermissionAuthorityResolver =
    params.surface === 'agent'
    && typeof params.resolveCausalPermissionAuthority === 'function';
  let causalPermissionAuthority: unknown = null;
  if (hasCausalPermissionAuthorityResolver) {
    try {
      causalPermissionAuthority = await params.resolveCausalPermissionAuthority!();
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
  const actionRequestId = origin
    ? [origin.toolCallId, origin.mcpRequestId, origin.messageId, origin.parentMessageId]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
        ?.trim() ?? null
    : null;
  return {
    defaultSessionId: params.defaultSessionId,
    surface: params.surface,
    ...(params.options?.approvalOrigin ? { approvalOrigin: params.options.approvalOrigin } : {}),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(callerPermissionMode ? { callerPermissionMode } : {}),
    ...(hasCausalPermissionAuthorityResolver
      ? { causalPermissionAuthority: causalPermissionAuthority ?? null }
      : {}),
    ...(sessionAgentSpawnPolicyV1 !== undefined
      ? { sessionAgentSpawnPolicyV1 }
      : {}),
    ...(params.expectedContributorImmutableGenerationId
      ? { expectedContributorImmutableGenerationId: params.expectedContributorImmutableGenerationId }
      : {}),
    actionsSettings: params.actionsSettings ?? null,
  };
}

function resolveExpectedContributorImmutableGenerationId(params: Readonly<{
  actionId: string;
  toolName?: string;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): string | undefined {
  const generations = new Set(
    (params.pluginToolCatalog ?? [])
      .filter((tool) => (
        tool.actionId === params.actionId
        && (params.toolName === undefined || tool.name === params.toolName)
      ))
      .map((tool) => tool.expectedContributorImmutableGenerationId?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return generations.size === 1 ? [...generations][0] : undefined;
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

function hasUsableSessionId(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function withDefaultSessionIdInput(actionId: string, input: unknown, defaultSessionId: string): unknown {
  const normalizedDefaultSessionId = String(defaultSessionId ?? '').trim();
  if (!normalizedDefaultSessionId || !actionAcceptsContextualSessionId(actionId) || !isInputRecord(input)) {
    return input;
  }
  if (hasUsableSessionId(input.sessionId)) {
    return input;
  }
  return {
    ...input,
    sessionId: normalizedDefaultSessionId,
  };
}

export function createActionToolExecutorBridge(params: Readonly<{
  executor: ActionExecutorLike;
  isActionEnabled?: (id: ActionId) => boolean;
  surface?: 'mcp' | 'cli' | 'agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveCausalPermissionAuthority?: (() => Promise<unknown> | unknown) | null;
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: (() => unknown) | null;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
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
  });

  return {
    executeActionByToolName: async (toolName, toolArgs, defaultSessionId, options) => {
      if (toolName === 'action_execute') {
        const argsRecord = isInputRecord(toolArgs) ? toolArgs : null;
        const actionId = argsRecord ? readTrimmedStringField(argsRecord, 'actionId') : '';
        if (!actionId) {
          return { ok: false, errorCode: 'invalid_action_input', error: 'Missing actionId' };
        }
        const actionInput = withDefaultSessionIdInput(
          actionId,
          argsRecord && Object.prototype.hasOwnProperty.call(argsRecord, 'input')
            ? normalizeActionExecuteInput(argsRecord.input)
            : {},
          defaultSessionId,
        );
        return normalizeActionToolResult(actionId, await params.executor.execute(
          actionId as ActionId,
          actionInput,
          await buildActionExecutorContext({
            defaultSessionId,
            surface,
            options,
            resolveCallerPermissionMode: params.resolveCallerPermissionMode,
            resolveCausalPermissionAuthority: params.resolveCausalPermissionAuthority,
            sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
            getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
            actionsSettings: readActionsSettings(),
            expectedContributorImmutableGenerationId:
              resolveExpectedContributorImmutableGenerationId({
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

      const actionInput = withDefaultSessionIdInput(actionId, toolArgs, defaultSessionId);
      return normalizeActionToolResult(actionId, await params.executor.execute(
        actionId as ActionId,
        actionInput,
        await buildActionExecutorContext({
          defaultSessionId,
          surface,
          options,
          resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          resolveCausalPermissionAuthority: params.resolveCausalPermissionAuthority,
          sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
          getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
          actionsSettings: readActionsSettings(),
          expectedContributorImmutableGenerationId:
            resolveExpectedContributorImmutableGenerationId({
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
        { defaultSessionId, surface, actionsSettings: readActionsSettings() },
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
