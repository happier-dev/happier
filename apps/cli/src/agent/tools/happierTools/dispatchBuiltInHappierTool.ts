import { type ActionId, type ActionsSettingsV1, type ApprovalRequestOriginV1, type ResolvedActionOption } from '@happier-dev/protocol';
import {
  getActionToolIdForToolName,
  getEquivalentActionIdForBuiltInTool,
  isDirectManualToolAvailable,
  isActionDirectToolAvailableOnToolSurface,
  resolveActionToolCatalogAvailability,
} from './actionToolCatalog';
import type { HappierBuiltInToolDispatchResult } from './types';
import {
  getActionSpecForSurface,
  resolveActionOptionsForSurface,
  searchActionSpecsForSurface,
  type ResolveActionOptionsInput,
} from './actionSpecDiscovery';
import {
  actionExecuteToolInputSchema,
  changeTitleToolInputSchema,
  normalizeExecutionRunStartToolInput,
} from './manualToolContracts';

type DispatchDeps = Readonly<{
  changeTitle: (
    sessionId: string,
    title: string,
    options?: Readonly<{ approvalOrigin?: ApprovalRequestOriginV1 | null }>,
  ) => Promise<unknown>;
  executeActionByToolName: (
    toolName: string,
    args: unknown,
    defaultSessionId: string,
    options?: Readonly<{ approvalOrigin?: ApprovalRequestOriginV1 | null }>,
  ) => Promise<HappierBuiltInToolDispatchResult>;
  resolveActionOptions?: (args: ResolveActionOptionsInput) => Promise<
    | Readonly<{
        ok: true;
        result: Readonly<{
          actionId: ActionId | null;
          fieldPath: string | null;
          optionsSourceId: string | null;
          options: readonly ResolvedActionOption[];
        }>;
      }>
    | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>
    | null
  >;
  isActionEnabled?: (id: ActionId) => boolean;
}>;

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

function ok(result: unknown): HappierBuiltInToolDispatchResult {
  return { ok: true, result };
}

function err(errorCode: string, error: string, details?: unknown): HappierBuiltInToolDispatchResult {
  return {
    ok: false,
    errorCode,
    error,
    ...(details === undefined ? {} : { details }),
  };
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
  sessionMachineId?: string | null;
  surface?: 'mcp' | 'cli' | 'agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  registry?: import('@/plugins/projection/registry/types').ResolvedContributionRegistry;
  pluginToolCatalog?: readonly import('@/plugins/runtime/toolCatalog').ProjectedPluginToolCatalogEntry[];
  deps: DispatchDeps;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
  const surface = params.surface ?? 'agent';
  const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
  const actionsSettings = readActionsSettings();
  const resolveAvailability = (actionId: ActionId | string) => resolveActionToolCatalogAvailability({
    actionId,
    surface,
    isActionEnabled,
    actionsSettings,
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
  const actionDisabled = (details: unknown) => err('action_disabled', 'Action is disabled', details);

  const actionBackedActionId = getActionToolIdForToolName(params.toolName, {
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
  if (actionBackedActionId) {
    const availability = resolveAvailability(actionBackedActionId);
    if (!availability.available) {
      return actionDisabled(availability);
    }
    const isDirectToolAvailable = isActionDirectToolAvailableOnToolSurface({
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
    }) || isDirectManualToolAvailable({
      toolName: params.toolName,
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
    });
    if (!isDirectToolAvailable) {
      return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
    }
  }

  const gatedManualActionId = actionBackedActionId ? null : getEquivalentActionIdForBuiltInTool(params.toolName, {
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
  if (
    gatedManualActionId
  ) {
    const availability = resolveAvailability(gatedManualActionId);
    if (!availability.available) {
      return actionDisabled(availability);
    }
    if (!isDirectManualToolAvailable({
      toolName: params.toolName,
      actionId: gatedManualActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
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
      ...(params.approvalOrigin ? [{ approvalOrigin: params.approvalOrigin }] as const : [] as const),
    ));
  }

  if (params.toolName === 'action_spec_search') {
    const result = await searchActionSpecsForSurface(params.args, surface, (id) => isActionEnabled(id), actionsSettings);
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'action_spec_get') {
    const result = await getActionSpecForSurface(
      params.args,
      surface,
      (id) => isActionEnabled(id),
      actionsSettings,
      {
        defaultSessionId: params.sessionId,
        defaultSessionMachineId: params.sessionMachineId,
      },
    );
    return result.ok ? ok(result.result) : err(result.errorCode, result.error, result.details);
  }

  if (params.toolName === 'execution_run_start') {
    const normalized = normalizeExecutionRunStartToolInput({
      sessionId: params.sessionId,
      args: params.args,
    });
    if (!normalized.ok) return err(normalized.errorCode, normalized.error);

    const equivalentActionId = getExecutionRunStartEquivalentActionId(normalized.request);
    if (equivalentActionId) {
      const availability = resolveAvailability(equivalentActionId);
      if (!availability.available) {
        return actionDisabled(availability);
      }
    }

    return await params.deps.executeActionByToolName(
      'execution_run_start',
      normalized.request,
      params.sessionId,
      ...(params.approvalOrigin ? [{ approvalOrigin: params.approvalOrigin }] : []),
    );
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
    const availability = resolveAvailability(parsed.data.actionId);
    if (!availability.available) {
      return actionDisabled(availability);
    }
    return await params.deps.executeActionByToolName(
      'action_execute',
      {
        actionId: parsed.data.actionId,
        ...(Object.prototype.hasOwnProperty.call(parsed.data, 'input') ? { input: parsed.data.input } : {}),
      },
      params.sessionId,
      ...(params.approvalOrigin ? [{ approvalOrigin: params.approvalOrigin }] : []),
    );
  }

  const actionId = actionBackedActionId;
  if (actionId) {
    return await params.deps.executeActionByToolName(
      params.toolName,
      params.args,
      params.sessionId,
      ...(params.approvalOrigin ? [{ approvalOrigin: params.approvalOrigin }] : []),
    );
  }

  return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
}
