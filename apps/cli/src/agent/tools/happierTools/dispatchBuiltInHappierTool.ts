import { type ActionId, type ActionsSettingsV1, type ApprovalRequestOriginV1, type ResolvedActionOption } from '@happier-dev/protocol';
import {
  getActionToolIdForToolName,
  getEquivalentActionIdForBuiltInTool,
  isActionAvailableOnToolSurface,
  isActionDirectToolAvailableOnToolSurface,
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
  normalizeExecutionRunStartToolInput,
  pluginsReloadToolInputSchema,
} from './manualToolContracts';
import { reloadTrustedLocalPluginTool } from './reloadTrustedLocalPluginTool';

type DispatchDeps = Readonly<{
  changeTitle: (sessionId: string, title: string) => Promise<unknown>;
  executeActionByToolName: (
    toolName: string,
    args: unknown,
    defaultSessionId: string,
    options?: Readonly<{ approvalOrigin?: ApprovalRequestOriginV1 | null }>,
  ) => Promise<HappierBuiltInToolDispatchResult>;
  reloadPlugin?: (pluginId: string) => Promise<HappierBuiltInToolDispatchResult>;
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
  surface?: 'mcp' | 'cli' | 'session_agent';
  actionsSettings?: ActionsSettingsV1 | null;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  registry?: import('@/plugins/projection/registry/types').ResolvedContributionRegistry;
  deps: DispatchDeps;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
  const surface = params.surface ?? 'session_agent';
  const actionsSettings = params.actionsSettings ?? null;

  const actionBackedActionId = getActionToolIdForToolName(params.toolName, { registry: params.registry });
  if (actionBackedActionId) {
    const isAvailable = isActionAvailableOnToolSurface({
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
    });
    if (!isAvailable) {
      return err('action_disabled', 'Action is disabled');
    }
    if (!isActionDirectToolAvailableOnToolSurface({
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
    })) {
      return err('unknown_tool', `Unknown built-in Happier tool: ${params.toolName}`);
    }
  }

  const gatedManualActionId = actionBackedActionId ? null : getEquivalentActionIdForBuiltInTool(params.toolName, { registry: params.registry });
  if (
    gatedManualActionId
    && !isActionAvailableOnToolSurface({
      actionId: gatedManualActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
    })
  ) {
    return err('action_disabled', 'Action is disabled');
  }

  if (params.toolName === 'change_title') {
    const parsed = changeTitleToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid title payload');
    return normalizeChangeTitleResult(await params.deps.changeTitle(params.sessionId, parsed.data.title));
  }

  if (params.toolName === 'plugins_reload') {
    const parsed = pluginsReloadToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid plugin reload payload');
    if (params.deps.reloadPlugin) {
      return await params.deps.reloadPlugin(parsed.data.pluginId);
    }
    return await reloadTrustedLocalPluginTool({
      pluginId: parsed.data.pluginId,
    });
  }

  if (params.toolName === 'action_spec_search') {
    const result = await searchActionSpecsForSurface(params.args, surface, (id) => isActionEnabled(id));
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'action_spec_get') {
    const result = await getActionSpecForSurface(params.args, surface, (id) => isActionEnabled(id));
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'execution_run_start') {
    const normalized = normalizeExecutionRunStartToolInput({
      sessionId: params.sessionId,
      args: params.args,
    });
    if (!normalized.ok) return err(normalized.errorCode, normalized.error);

    const equivalentActionId = getExecutionRunStartEquivalentActionId(normalized.request);
    if (
      equivalentActionId
      && !isActionAvailableOnToolSurface({
        actionId: equivalentActionId,
        surface,
        isActionEnabled,
        actionsSettings,
        registry: params.registry,
      })
    ) {
      return err('action_disabled', 'Action is disabled');
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
    const result = await resolveActionOptionsForSurface(params.args, surface, (id) => isActionEnabled(id), resolver);
    return result.ok ? ok(result.result) : err(result.errorCode, result.error);
  }

  if (params.toolName === 'action_execute') {
    const parsed = actionExecuteToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return err('invalid_action_input', 'Invalid action execute request');
    if (!isActionAvailableOnToolSurface({
      actionId: parsed.data.actionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
    })) {
      return err('action_disabled', 'Action is disabled');
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
