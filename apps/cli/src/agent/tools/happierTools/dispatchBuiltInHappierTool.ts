import { z } from 'zod';
import {
  buildBackendTargetKey,
  listActionSpecs,
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
} from '@happier-dev/protocol';
import {
  getEquivalentActionIdForBuiltInTool,
  isActionDirectToolAvailableOnToolSurface,
  isManualToolDirectAvailableOnToolSurface,
  resolveActionAvailabilityOnToolSurface,
} from './actionToolCatalog';
import type { HappierBuiltInToolDispatchResult } from './types';
import {
  getActionSpecForSurface,
  resolveActionOptionsForSurface,
  searchActionSpecsForSurface,
} from './actionSpecDiscovery';
import {
  actionExecuteToolInputSchema,
  changeTitleToolInputSchema,
  executionRunStartToolInputSchema,
  normalizeExecutionRunStartToolInput,
} from './manualToolContracts';

type DispatchDeps = Readonly<{
  changeTitle: (
    sessionId: string,
    title: string,
    options?: Readonly<{ approvalOrigin?: ApprovalRequestOriginV1 | null }>,
  ) => Promise<unknown>;
  startExecutionRun: (sessionId: string, request: unknown) => Promise<HappierBuiltInToolDispatchResult>;
  executeActionByToolName: (
    toolName: string,
    args: unknown,
    defaultSessionId: string,
    options?: Readonly<{ approvalOrigin?: ApprovalRequestOriginV1 | null }>,
  ) => Promise<HappierBuiltInToolDispatchResult>;
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
    .map((spec) => String(spec.bindings?.mcpToolName ?? '').trim())
    .filter((toolName) => toolName.length > 0),
);

const ACTION_ID_BY_TOOL_NAME = new Map(
  listActionSpecs()
    .map((spec) => [String(spec.bindings?.mcpToolName ?? '').trim(), spec.id] as const)
    .filter(([toolName]) => toolName.length > 0),
);

function getExecutionRunStartEquivalentActionId(args: unknown): ActionId | null {
  const intent = typeof (args as { intent?: unknown } | null)?.intent === 'string'
    ? String((args as { intent?: unknown }).intent).trim()
    : '';
  switch (intent) {
    case 'review':
      return 'review.start';
    case 'plan':
      return 'subagents.plan.start';
    case 'delegate':
      return 'subagents.delegate.start';
    case 'voice_agent':
      return 'voice_agent.start';
    default:
      return null;
  }
}

const EXECUTION_RUN_START_ACTION_TOOL_NAME_BY_INTENT = Object.freeze({
  plan: 'subagents_plan_start',
  delegate: 'subagents_delegate_start',
  voice_agent: 'voice_agent_start',
} as const);

function ok(result: unknown): HappierBuiltInToolDispatchResult {
  return { ok: true, result };
}

function err(errorCode: string, error: string, details?: unknown): HappierBuiltInToolDispatchResult {
  return details === undefined ? { ok: false, errorCode, error } : { ok: false, errorCode, error, details };
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
  surface?: 'mcp' | 'cli' | 'session_agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  deps: DispatchDeps;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
  const surface = params.surface ?? 'session_agent';
  const actionsSettings = params.getActionsSettings?.() ?? params.actionsSettings ?? null;
  const actionExecutionOptions = params.approvalOrigin ? { approvalOrigin: params.approvalOrigin } : undefined;
  const actionExecutionOptionsArgs = actionExecutionOptions ? [actionExecutionOptions] as const : [] as const;

  const executionRunStartEquivalentActionId = params.toolName === 'execution_run_start'
    ? getExecutionRunStartEquivalentActionId(params.args)
    : null;
  if (executionRunStartEquivalentActionId) {
    const availability = resolveActionAvailabilityOnToolSurface({
      actionId: executionRunStartEquivalentActionId,
      surface,
      actionsSettings,
      isActionEnabled,
    });
    if (!availability.available) {
      return err('action_disabled', 'Action is disabled', availability);
    }
  }

  const actionBackedActionId = ACTION_ID_BY_TOOL_NAME.get(params.toolName) ?? null;
  if (actionBackedActionId) {
    const availability = resolveActionAvailabilityOnToolSurface({
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
    });
    if (!availability.available) {
      return err('action_disabled', 'Action is disabled', availability);
    }
    if (!isActionDirectToolAvailableOnToolSurface({
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
    })) {
      return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
    }
  }

  const gatedManualActionId = actionBackedActionId ? null : getEquivalentActionIdForBuiltInTool(params.toolName);
  if (gatedManualActionId) {
    const availability = resolveActionAvailabilityOnToolSurface({
      actionId: gatedManualActionId,
      surface,
      isActionEnabled,
      actionsSettings,
    });
    if (!availability.available) {
      return err('action_disabled', 'Action is disabled', availability);
    }
    if (!isManualToolDirectAvailableOnToolSurface({
      toolName: params.toolName,
      actionId: gatedManualActionId,
      surface,
      isActionEnabled,
      actionsSettings,
    })) {
      return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
    }
  }

  if (params.toolName === 'change_title') {
    const parsed = changeTitleToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid title payload');
    return normalizeChangeTitleResult(await params.deps.changeTitle(
      params.sessionId,
      parsed.data.title,
      ...(actionExecutionOptions ? [actionExecutionOptions] as const : [] as const),
    ));
  }

  if (params.toolName === 'action_spec_search') {
    const result = await searchActionSpecsForSurface(params.args, surface, (id) => isActionEnabled(id), actionsSettings);
    return result.ok ? ok(result.result) : err(result.errorCode, result.error, result.details);
  }

  if (params.toolName === 'action_spec_get') {
    const result = await getActionSpecForSurface(params.args, surface, (id) => isActionEnabled(id), actionsSettings);
    return result.ok ? ok(result.result) : err(result.errorCode, result.error, result.details);
  }

  if (params.toolName === 'execution_run_start') {
    const parsed = executionRunStartToolInputSchema.safeParse(params.args ?? {});
    if (parsed.success) {
      const intent = parsed.data.intent;
      const actionToolName = EXECUTION_RUN_START_ACTION_TOOL_NAME_BY_INTENT[intent as keyof typeof EXECUTION_RUN_START_ACTION_TOOL_NAME_BY_INTENT];

      // Prefer action-backed intent starts (plan/delegate/voice) for convergence across CLI/MCP/built-in tools.
      // Fall back to the legacy execution.run.start path for older payloads that cannot satisfy action schemas.
      const instructions = typeof parsed.data.instructions === 'string' ? parsed.data.instructions.trim() : '';
      if (actionToolName && instructions) {
        if (typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.trim() !== params.sessionId) {
          return err('execution_run_not_allowed', 'This tool call is scoped to a different session');
        }

        const backendTarget = parsed.data.backendTarget ?? {
          kind: 'builtInAgent' as const,
          agentId: String(parsed.data.backendId ?? '').trim(),
        };

        return await params.deps.executeActionByToolName(
          actionToolName,
          {
            ...(typeof (params.args as any) === 'object' && params.args !== null ? (params.args as Record<string, unknown>) : {}),
            sessionId: params.sessionId,
            instructions,
            backendTargetKeys: [buildBackendTargetKey(backendTarget)],
          },
          params.sessionId,
          ...actionExecutionOptionsArgs,
        );
      }
    }

    const normalized = normalizeExecutionRunStartToolInput({
      sessionId: params.sessionId,
      args: params.args,
    });
    if (!normalized.ok) return err(normalized.errorCode, normalized.error);
    return await params.deps.startExecutionRun(params.sessionId, normalized.request);
  }

  if (params.toolName === 'action_options_resolve') {
    const resolver = params.deps.resolveActionOptions;
    if (!resolver) return err('options_source_not_supported', 'Options source is not supported');
    const result = await resolveActionOptionsForSurface(params.args, surface, (id) => isActionEnabled(id), resolver, actionsSettings);
    return result.ok ? ok(result.result) : err(result.errorCode, result.error, result.details);
  }

  if (params.toolName === 'action_execute') {
    const parsed = actionExecuteToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid action execute request');
    const availability = resolveActionAvailabilityOnToolSurface({
      actionId: parsed.data.actionId as ActionId,
      surface,
      isActionEnabled,
      actionsSettings,
    });
    if (!availability.available) {
      return err('action_disabled', 'Action is disabled', availability);
    }
    return await params.deps.executeActionByToolName(
      'action_execute',
      {
        actionId: parsed.data.actionId,
        ...(Object.prototype.hasOwnProperty.call(parsed.data, 'input') ? { input: parsed.data.input } : {}),
      },
      params.sessionId,
      ...actionExecutionOptionsArgs,
    );
  }

  if (ACTION_TOOL_NAMES.has(params.toolName)) {
    const actionId = ACTION_ID_BY_TOOL_NAME.get(params.toolName) ?? null;
    if (actionId) {
      const availability = resolveActionAvailabilityOnToolSurface({
        actionId,
        surface,
        isActionEnabled,
        actionsSettings,
      });
      if (!availability.available) {
        return err('action_disabled', 'Action is disabled', availability);
      }
    }
    return await params.deps.executeActionByToolName(params.toolName, params.args, params.sessionId, ...actionExecutionOptionsArgs);
  }

  return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
}
