import {
  type ActionId,
  type ResolvedActionOption,
} from '@happier-dev/protocol';
import { createMcpActionToolNameToIdMap } from './mcpActionToolCatalog';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{ defaultSessionId: string; surface: 'mcp' }>,
  ) => Promise<ActionExecutorResult>;
}>;

type ActionToolBridgeResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type DynamicActionOptionsResult = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  options: readonly ResolvedActionOption[];
}>;

type DynamicActionOptionsBridgeResult =
  | Readonly<{ ok: true; result: DynamicActionOptionsResult }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

function normalizeActionExecutorResult(result: ActionExecutorResult): ActionToolBridgeResult {
  return result.ok
    ? { ok: true, result: result.result }
    : { ok: false, errorCode: result.errorCode, error: result.error };
}

export function createActionToolExecutorBridge(params: Readonly<{
  executor: ActionExecutorLike;
  isActionEnabled?: (id: ActionId) => boolean;
}>): Readonly<{
  executeActionByToolName: (toolName: string, toolArgs: unknown, defaultSessionId: string) => Promise<ActionToolBridgeResult>;
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
  const actionToolNameToId = createMcpActionToolNameToIdMap(isActionEnabled);

  return {
    executeActionByToolName: async (toolName, toolArgs, defaultSessionId) => {
      if (toolName === 'action_execute') {
        const actionId = typeof (toolArgs as any)?.actionId === 'string' ? String((toolArgs as any).actionId).trim() : '';
        if (!actionId) {
          return { ok: false, errorCode: 'invalid_action_input', error: 'Missing actionId' };
        }
        return normalizeActionExecutorResult(await params.executor.execute(
          actionId as ActionId,
          Object.prototype.hasOwnProperty.call(toolArgs ?? {}, 'input') ? (toolArgs as any).input : {},
          { defaultSessionId, surface: 'mcp' },
        ));
      }

      const actionId = actionToolNameToId.get(toolName);
      if (!actionId) {
        return { ok: false, errorCode: 'unknown_tool', error: `Unknown action-backed tool: ${toolName}` };
      }

      return normalizeActionExecutorResult(await params.executor.execute(
        actionId,
        toolArgs,
        { defaultSessionId, surface: 'mcp' },
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
        { defaultSessionId, surface: 'mcp' },
      );
      if (!result.ok) {
        return { ok: false, errorCode: result.errorCode, error: result.error };
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
