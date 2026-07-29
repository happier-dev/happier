import {
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
  actionAcceptsContextualSessionId,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap } from './actionToolCatalog';
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
      sessionAgentSpawnPolicyV1?: unknown;
      actionsSettings?: ActionsSettingsV1 | null;
      actionRequestId?: string | null;
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

function normalizeActionToolResult(actionId: string, result: ActionExecutorResult): ActionToolBridgeResult {
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

  return normalizeExecutionRunToolResult(result.result as Parameters<typeof normalizeExecutionRunToolResult>[0]);
}

async function buildActionExecutorContext(params: Readonly<{
  defaultSessionId: string;
  surface: 'mcp' | 'cli' | 'agent';
  options?: ActionToolExecutionOptions;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: (() => unknown) | null;
  actionsSettings?: ActionsSettingsV1 | null;
}>): Promise<Readonly<{
  defaultSessionId: string;
  surface: 'mcp' | 'cli' | 'agent';
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  callerPermissionMode?: string | null;
  sessionAgentSpawnPolicyV1?: unknown;
  actionsSettings?: ActionsSettingsV1 | null;
  actionRequestId?: string | null;
}>> {
  const callerPermissionMode = params.surface === 'agent' && params.resolveCallerPermissionMode
    ? await params.resolveCallerPermissionMode()
    : null;
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
    ...(sessionAgentSpawnPolicyV1 !== undefined
      ? { sessionAgentSpawnPolicyV1 }
      : {}),
    actionsSettings: params.actionsSettings ?? null,
  };
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
  resolveActionOptions: (args: Readonly<{
    actionId: ActionId | null;
    fieldPath: string | null;
    optionsSourceId: string | null;
    sessionId: string | null;
    limit: number | null;
    query: string | null;
  }>, defaultSessionId: string) => Promise<DynamicActionOptionsBridgeResult | null>;
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
        return normalizeActionToolResult(actionId, await params.executor.execute(
          actionId as ActionId,
          withDefaultSessionIdInput(
            actionId,
            argsRecord && Object.prototype.hasOwnProperty.call(argsRecord, 'input')
              ? normalizeActionExecuteInput(argsRecord.input)
              : {},
            defaultSessionId,
          ),
          await buildActionExecutorContext({
            defaultSessionId,
            surface,
            options,
            resolveCallerPermissionMode: params.resolveCallerPermissionMode,
            sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
            getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
            actionsSettings: readActionsSettings(),
          }),
        ));
      }

      const actionId = actionToolNameToId.get(toolName);
      if (!actionId) {
        return { ok: false, errorCode: 'unknown_tool', error: `Unknown action-backed tool: ${toolName}` };
      }

      return normalizeActionToolResult(actionId, await params.executor.execute(
        actionId as ActionId,
        withDefaultSessionIdInput(actionId, toolArgs, defaultSessionId),
        await buildActionExecutorContext({
          defaultSessionId,
          surface,
          options,
          resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
          getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
          actionsSettings: readActionsSettings(),
        }),
      ));
    },
    resolveActionOptions: async (args, defaultSessionId) => {
      const input: Record<string, unknown> = {};
      if (args.actionId) input.actionId = args.actionId;
      if (args.fieldPath) input.fieldPath = args.fieldPath;
      if (args.optionsSourceId) input.optionsSourceId = args.optionsSourceId;
      if (args.sessionId) input.sessionId = args.sessionId;
      if (typeof args.limit === 'number') input.limit = args.limit;
      if (typeof args.query === 'string') input.query = args.query;

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
