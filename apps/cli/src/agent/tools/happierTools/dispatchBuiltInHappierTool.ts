import { z } from 'zod';
import {
  listActionSpecs,
  type ActionId,
  type ResolvedActionOption,
} from '@happier-dev/protocol';
import type { HappierBuiltInToolDispatchResult } from './types';
import {
  actionOptionsResolveSchema,
  actionSpecGetSchema,
  actionSpecSearchSchema,
  getActionSpecForMcpSurface,
  resolveActionOptionsForMcpSurface,
  searchActionSpecsForMcpSurface,
} from './actionSpecDiscovery';
const actionExecuteSchema = z.object({
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough();
const executionRunStartSchema = z.object({
  sessionId: z.string().min(1).optional(),
  intent: z.string().min(1),
  backendId: z.string().min(1),
  instructions: z.string().optional(),
  permissionMode: z.string().min(1).optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
}).passthrough();

type DispatchDeps = Readonly<{
  changeTitle: (sessionId: string, title: string) => Promise<unknown>;
  startExecutionRun: (sessionId: string, request: unknown) => Promise<HappierBuiltInToolDispatchResult>;
  executeActionByToolName: (toolName: string, args: unknown, defaultSessionId: string) => Promise<HappierBuiltInToolDispatchResult>;
  resolveActionOptions?: (args: Readonly<{
    actionId: ActionId | null;
    fieldPath: string | null;
    optionsSourceId: string | null;
    sessionId: string | null;
    limit: number | null;
    query: string | null;
  }>) => Promise<
    | Readonly<{
        ok: true;
        result: Readonly<{
          actionId: ActionId | null;
          fieldPath: string | null;
          optionsSourceId: string | null;
          options: readonly ResolvedActionOption[];
        }>;
      }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
    | null
  >;
  isActionEnabled?: (id: ActionId) => boolean;
}>;

const ACTION_TOOL_NAMES = new Set(
  listActionSpecs()
    .filter((spec) => spec.surfaces.mcp === true)
    .map((spec) => String(spec.bindings?.mcpToolName ?? '').trim())
    .filter((toolName) => toolName.length > 0),
);

function ok(result: unknown): HappierBuiltInToolDispatchResult {
  return { ok: true, result };
}

function err(errorCode: string, error: string): HappierBuiltInToolDispatchResult {
  return { ok: false, errorCode, error };
}

function normalizeChangeTitleResult(result: unknown): HappierBuiltInToolDispatchResult {
  if (typeof result !== 'object' || result === null) {
    return ok(result);
  }

  const changeTitleResult = result as { success?: unknown; error?: unknown };
  if (changeTitleResult.success !== false) {
    return ok(result);
  }

  const errorMessage = typeof changeTitleResult.error === 'string'
    ? changeTitleResult.error
    : 'Failed to change title';
  return err('change_title_failed', errorMessage);
}

export async function dispatchBuiltInHappierTool(params: Readonly<{
  toolName: string;
  args: unknown;
  sessionId: string;
  deps: DispatchDeps;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const isActionEnabled = params.deps.isActionEnabled ?? (() => true);

  if (params.toolName === 'change_title') {
    const parsed = z.object({ title: z.string().min(1) }).passthrough().safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid title payload');
    return normalizeChangeTitleResult(await params.deps.changeTitle(params.sessionId, parsed.data.title));
  }

  if (params.toolName === 'action_spec_search') {
    const result = await searchActionSpecsForMcpSurface(params.args, (id) => isActionEnabled(id));
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'action_spec_get') {
    const result = await getActionSpecForMcpSurface(params.args, (id) => isActionEnabled(id));
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'execution_run_start') {
    const parsed = executionRunStartSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid execution run payload');
    if (typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.trim() !== params.sessionId) {
      return err('execution_run_not_allowed', 'This tool call is scoped to a different session');
    }
    return await params.deps.startExecutionRun(params.sessionId, {
      intent: parsed.data.intent,
      backendId: parsed.data.backendId,
      instructions: parsed.data.instructions,
      permissionMode: parsed.data.permissionMode ?? 'read_only',
      retentionPolicy: parsed.data.retentionPolicy ?? 'ephemeral',
      runClass: parsed.data.runClass ?? 'bounded',
      ioMode: parsed.data.ioMode ?? 'request_response',
    });
  }

  if (params.toolName === 'action_options_resolve') {
    const resolver = params.deps.resolveActionOptions;
    if (!resolver) return err('options_source_not_supported', 'Options source is not supported');
    const result = await resolveActionOptionsForMcpSurface(params.args, (id) => isActionEnabled(id), resolver);
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'action_execute') {
    const parsed = actionExecuteSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid action execute request');
    return await params.deps.executeActionByToolName(
      'action_execute',
      {
        actionId: parsed.data.actionId,
        ...(Object.prototype.hasOwnProperty.call(parsed.data, 'input') ? { input: parsed.data.input } : {}),
      },
      params.sessionId,
    );
  }

  if (ACTION_TOOL_NAMES.has(params.toolName)) {
    return await params.deps.executeActionByToolName(params.toolName, params.args, params.sessionId);
  }

  return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
}
