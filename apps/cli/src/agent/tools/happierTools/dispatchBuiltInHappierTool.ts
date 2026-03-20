import { z } from 'zod';
import {
  BackendTargetRefSchema,
  ExecutionRunStartRequestSchema,
  listActionSpecs,
  type ActionId,
  type ResolvedActionOption,
} from '@happier-dev/protocol';
import type { HappierBuiltInToolDispatchResult } from './types';
import {
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
  backendTarget: BackendTargetRefSchema.optional(),
  backendId: z.string().min(1).optional(),
  instructions: z.string().optional(),
  display: z.unknown().optional(),
  intentInput: z.unknown().optional(),
  initialContextMode: z.enum(['bootstrap', 'first_turn']).optional(),
  resumeHandle: z.unknown().optional(),
  replay: z.unknown().optional(),
  permissionMode: z.string().min(1).optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasBackendTarget = typeof value.backendTarget !== 'undefined';
  const backendId = typeof value.backendId === 'string' ? value.backendId.trim() : '';
  if (!hasBackendTarget && !backendId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backendTarget'],
      message: 'backendTarget is required (or provide legacy backendId)',
    });
  }
});

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

const ACTION_ID_BY_TOOL_NAME = new Map(
  listActionSpecs()
    .filter((spec) => spec.surfaces.mcp === true)
    .map((spec) => [String(spec.bindings?.mcpToolName ?? '').trim(), spec.id] as const)
    .filter(([toolName]) => toolName.length > 0),
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

    const backendTarget = parsed.data.backendTarget ?? {
      kind: 'builtInAgent' as const,
      agentId: String(parsed.data.backendId ?? '').trim(),
    };

    const request = ExecutionRunStartRequestSchema.safeParse({
      intent: parsed.data.intent,
      backendTarget,
      ...(typeof parsed.data.instructions === 'string' ? { instructions: parsed.data.instructions } : {}),
      ...(typeof parsed.data.display !== 'undefined' ? { display: parsed.data.display } : {}),
      ...(typeof parsed.data.intentInput !== 'undefined' ? { intentInput: parsed.data.intentInput } : {}),
      permissionMode: parsed.data.permissionMode ?? 'read_only',
      retentionPolicy: parsed.data.retentionPolicy ?? 'ephemeral',
      runClass: parsed.data.runClass ?? 'bounded',
      ioMode: parsed.data.ioMode ?? 'request_response',
      ...(typeof parsed.data.initialContextMode !== 'undefined' ? { initialContextMode: parsed.data.initialContextMode } : {}),
      ...(typeof parsed.data.resumeHandle !== 'undefined' ? { resumeHandle: parsed.data.resumeHandle } : {}),
      ...(typeof parsed.data.replay !== 'undefined' ? { replay: parsed.data.replay } : {}),
    });
    if (!request.success) return err('invalid_action_input', 'Invalid execution run payload');

    return await params.deps.startExecutionRun(params.sessionId, request.data);
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
    if (!isActionEnabled(parsed.data.actionId as ActionId)) {
      return err('action_disabled', 'Action is disabled');
    }
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
    const actionId = ACTION_ID_BY_TOOL_NAME.get(params.toolName) ?? null;
    if (actionId && !isActionEnabled(actionId)) {
      return err('action_disabled', 'Action is disabled');
    }
    return await params.deps.executeActionByToolName(params.toolName, params.args, params.sessionId);
  }

  return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
}
