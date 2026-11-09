import {
  type ActionContextualDefaults,
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
} from '@happier-dev/protocol';
import {
  getActionToolIdForToolName,
  getEquivalentActionIdForBuiltInTool,
  isDirectManualToolAvailable,
  resolveActionToolCatalogAvailability,
} from './actionToolCatalog';
import type { HappierBuiltInToolDispatchResult } from './types';
import type { ResolveActionOptionsInput } from './createActionToolExecutorBridge';
import { projectSessionBoundActionToolInputSchema } from './actionToolContext';
import {
  actionExecuteToolInputSchema,
  changeTitleToolInputSchema,
  normalizeExecutionRunStartToolInput,
} from './manualToolContracts';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';

type DispatchDeps = Readonly<{
  changeTitle: (
    sessionId: string,
    title: string,
    options?: Readonly<{
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      actionRequestId?: string | null;
      signal?: AbortSignal;
    }>,
  ) => Promise<unknown>;
  executeActionByToolName: (
    toolName: string,
    args: unknown,
    defaultSessionId: string,
    options?: Readonly<{
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      actionRequestId?: string | null;
      signal?: AbortSignal;
    }>,
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

function err(errorCode: string, error: string, details?: unknown): Extract<HappierBuiltInToolDispatchResult, { ok: false }> {
  return {
    ok: false,
    errorCode,
    error,
    ...(details === undefined ? {} : { details }),
  };
}

export function unknownBuiltInHappierToolFailure(toolName: string): Extract<HappierBuiltInToolDispatchResult, { ok: false }> {
  return err('unknown_tool', `Unknown built-in Happier tool: ${toolName}`);
}

function normalizeChangeTitleResult(result: unknown): HappierBuiltInToolDispatchResult {
  if (typeof result !== 'object' || result === null) {
    return ok(result);
  }

  const changeTitleResult = result as { success?: unknown; errorCode?: unknown; error?: unknown };
  if (changeTitleResult.success !== false) {
    return ok(result);
  }

  const errorMessage = typeof changeTitleResult.error === 'string'
    ? changeTitleResult.error
    : 'Failed to change title';
  const errorCode = typeof changeTitleResult.errorCode === 'string' && changeTitleResult.errorCode.trim()
    ? changeTitleResult.errorCode
    : 'change_title_failed';
  return err(errorCode, errorMessage);
}

export async function dispatchBuiltInHappierTool(params: Readonly<{
  toolName: string;
  args: unknown;
  sessionId: string;
  sessionMachineId?: string | null;
  sessionRootPath?: string | null;
  surface?: 'mcp' | 'cli' | 'agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  actionRequestId?: string | null;
  signal?: AbortSignal;
  registry?: import('@/plugins/projection/registry/types').ResolvedContributionRegistry;
  pluginToolCatalog?: readonly import('@/plugins/runtime/toolCatalog').ProjectedPluginToolCatalogEntry[];
  requiredDirectActionIds?: readonly ActionId[];
  deps: DispatchDeps;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
  const surface = params.surface ?? 'agent';
  const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
  const actionsSettings = readActionsSettings();
  const resolveAvailability = (actionId: ActionId | string, toolName?: string) => resolveActionToolCatalogAvailability({
    actionId,
    toolName,
    surface,
    isActionEnabled,
    actionsSettings,
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
  const actionDisabled = (details: unknown) => err('action_disabled', 'Action is disabled', details);
  const executionOptions = params.approvalOrigin || params.actionRequestId || params.signal
    ? {
        ...(params.approvalOrigin ? { approvalOrigin: params.approvalOrigin } : {}),
        ...(params.actionRequestId ? { actionRequestId: params.actionRequestId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      }
    : undefined;

  const actionBackedActionId = getActionToolIdForToolName(params.toolName, {
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });
  if (actionBackedActionId) {
    const availability = resolveAvailability(actionBackedActionId, params.toolName);
    if (!availability.available) {
      return actionDisabled(availability);
    }
    const isDirectToolAvailable = isDirectManualToolAvailable({
      toolName: params.toolName,
      actionId: actionBackedActionId,
      surface,
      isActionEnabled,
      actionsSettings,
      registry: params.registry,
      pluginToolCatalog: params.pluginToolCatalog,
      requiredDirectActionIds: params.requiredDirectActionIds,
    });
    if (!isDirectToolAvailable) {
      return unknownBuiltInHappierToolFailure(params.toolName);
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
      return unknownBuiltInHappierToolFailure(params.toolName);
    }
  }

  if (params.toolName === 'change_title') {
    const parsed = changeTitleToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return actionInputValidationFailure(parsed.error);
    return normalizeChangeTitleResult(await params.deps.changeTitle(
      params.sessionId,
      parsed.data.title,
      ...(executionOptions ? [executionOptions] as const : [] as const),
    ));
  }

  if (params.toolName === 'action_spec_get') {
    const result = await params.deps.executeActionByToolName(
      params.toolName,
      params.args,
      params.sessionId,
      ...(executionOptions ? [executionOptions] : []),
    );
    if (!result.ok || typeof result.result !== 'object' || result.result === null) return result;
    const payload = result.result as Readonly<Record<string, unknown>>;
    if (typeof payload.actionSpec !== 'object' || payload.actionSpec === null) return result;
    const actionSpec = payload.actionSpec as Readonly<Record<string, unknown>>;
    if (typeof actionSpec.id !== 'string' || !Object.prototype.hasOwnProperty.call(actionSpec, 'inputSchema')) return result;
    return ok({
      ...payload,
      actionSpec: {
        ...actionSpec,
        inputSchema: projectSessionBoundActionToolInputSchema({
          actionId: actionSpec.id,
          inputSchema: actionSpec.inputSchema,
          context: {
            defaultSessionId: params.sessionId,
            defaultSessionMachineId: params.sessionMachineId,
            defaultSessionRootPath: params.sessionRootPath,
          },
          registry: params.registry,
          pluginToolCatalog: params.pluginToolCatalog,
          contextualDefaults: (actionSpec.contextualDefaults ?? null) as ActionContextualDefaults | null,
        }),
      },
    });
  }

  if (params.toolName === 'execution_run_start') {
    const normalized = normalizeExecutionRunStartToolInput({
      sessionId: params.sessionId,
      args: params.args,
    });
    if (!normalized.ok) return normalized;

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
      ...(executionOptions ? [executionOptions] : []),
    );
  }

  if (params.toolName === 'action_execute') {
    const parsed = actionExecuteToolInputSchema.safeParse(params.args ?? {});
    if (!parsed.success) return actionInputValidationFailure(parsed.error);
    // The bridge's current Action discovery owner admits the named or qualified target.
    return await params.deps.executeActionByToolName(
      'action_execute',
      {
        actionId: parsed.data.actionId,
        ...(Object.prototype.hasOwnProperty.call(parsed.data, 'input') ? { input: parsed.data.input } : {}),
      },
      params.sessionId,
      ...(executionOptions ? [executionOptions] : []),
    );
  }

  const actionId = actionBackedActionId;
  if (actionId) {
    return await params.deps.executeActionByToolName(
      params.toolName,
      params.args,
      params.sessionId,
      ...(executionOptions ? [executionOptions] : []),
    );
  }

  return unknownBuiltInHappierToolFailure(params.toolName);
}
