import {
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap } from './actionToolCatalog';
import { bindContextualActionToolInput } from './contextualActionToolInput';
import { normalizeExecutionRunToolResult } from './normalizeExecutionRunToolResult';

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
      surface: 'mcp' | 'cli' | 'session_agent';
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      callerPermissionMode?: string | null;
      actionsSettings?: ActionsSettingsV1 | null;
      actionRequestId?: string | null;
    }>,
  ) => Promise<ActionExecutorResult>;
}>;

export type ActionToolExecutionOptions = Readonly<{
  approvalOrigin?: ApprovalRequestOriginV1 | null;
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

function normalizeActionExecutorResult(result: ActionExecutorResult): ActionToolBridgeResult {
  return result.ok
    ? { ok: true, result: result.result }
    : {
        ok: false,
        errorCode: result.errorCode,
        error: result.error,
        ...(result.details === undefined ? {} : { details: result.details }),
      };
}

function normalizeActionToolResult(actionId: ActionId, result: ActionExecutorResult): ActionToolBridgeResult {
  if (result.ok && result.result && typeof result.result === 'object' && (result.result as any).kind === 'approval_request_created') {
    return { ok: true, result: result.result };
  }
  if (!actionId.startsWith('execution.run.')) {
    return normalizeActionExecutorResult(result);
  }

  if (!result.ok) {
    return normalizeActionExecutorResult(result);
  }

  return normalizeExecutionRunToolResult(result.result as Parameters<typeof normalizeExecutionRunToolResult>[0]);
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

function readActionRequestId(origin: ApprovalRequestOriginV1 | null | undefined): string | null {
  if (!origin) return null;
  for (const value of [origin.toolCallId, origin.mcpRequestId, origin.messageId, origin.parentMessageId]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function createActionToolExecutorBridge(params: Readonly<{
  executor: ActionExecutorLike;
  isActionEnabled?: (id: ActionId) => boolean;
  surface?: 'mcp' | 'cli' | 'session_agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  resolveCallerPermissionMode?: (() => string | null | undefined) | null;
  defaultSessionMachineId?: string | null;
}>): Readonly<{
  executeActionByToolName: (toolName: string, toolArgs: unknown, defaultSessionId: string, options?: ActionToolExecutionOptions) => Promise<ActionToolBridgeResult>;
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
  const surface = params.surface ?? 'session_agent';
  const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
  const readCallerPermissionMode = () => params.resolveCallerPermissionMode?.() ?? null;

  return {
    executeActionByToolName: async (toolName, toolArgs, defaultSessionId, options) => {
      const callerPermissionMode = readCallerPermissionMode();
      const actionRequestId = readActionRequestId(options?.approvalOrigin);
      const context = {
        defaultSessionId,
        ...(params.defaultSessionMachineId ? { defaultSessionMachineId: params.defaultSessionMachineId } : {}),
        surface,
        ...(options?.approvalOrigin ? { approvalOrigin: options.approvalOrigin } : {}),
        ...(callerPermissionMode ? { callerPermissionMode } : {}),
        ...(actionRequestId ? { actionRequestId } : {}),
        actionsSettings: readActionsSettings(),
      } as const;
      if (toolName === 'action_execute') {
        const actionId = typeof (toolArgs as any)?.actionId === 'string' ? String((toolArgs as any).actionId).trim() : '';
        if (!actionId) {
          return { ok: false, errorCode: 'invalid_action_input', error: 'Missing actionId' };
        }
        const input = bindContextualActionToolInput({
          actionId,
          input: Object.prototype.hasOwnProperty.call(toolArgs ?? {}, 'input')
            ? normalizeActionExecuteInput((toolArgs as any).input)
            : {},
          context,
        });
        return normalizeActionToolResult(actionId as ActionId, await params.executor.execute(
          actionId as ActionId,
          input,
          context,
        ));
      }

      const actionToolNameToId = createActionToolNameToIdMap({
        surface,
        isActionEnabled,
        actionsSettings: readActionsSettings(),
      });
      const actionId = actionToolNameToId.get(toolName);
      if (!actionId) {
        return { ok: false, errorCode: 'unknown_tool', error: `Unknown action-backed tool: ${toolName}` };
      }

      return normalizeActionToolResult(actionId, await params.executor.execute(
        actionId,
        bindContextualActionToolInput({ actionId, input: toolArgs, context }),
        context,
      ));
    },
    resolveActionOptions: async (args, defaultSessionId) => {
      const callerPermissionMode = readCallerPermissionMode();
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
        {
          defaultSessionId,
          surface,
          ...(callerPermissionMode ? { callerPermissionMode } : {}),
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

      const payload = result.result;
      if (!payload || typeof payload !== 'object') {
        return {
          ok: false,
          errorCode: 'action_options_resolve_failed',
          error: 'Options source resolution failed',
        };
      }

      return {
        ok: true,
        result: {
          actionId: typeof (payload as any).actionId === 'string' ? (payload as any).actionId as ActionId : null,
          fieldPath: typeof (payload as any).fieldPath === 'string' ? (payload as any).fieldPath : null,
          optionsSourceId: typeof (payload as any).optionsSourceId === 'string' ? (payload as any).optionsSourceId : null,
          options: Array.isArray((payload as any).options) ? (payload as any).options : [],
        },
      } satisfies DynamicActionOptionsBridgeResult;
    },
    isActionEnabled,
  };
}
