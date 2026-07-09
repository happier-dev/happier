import { ACTION_IDS, type ActionId } from '@happier-dev/protocol/actions';
import Ajv, { type ValidateFunction } from 'ajv';

import type {
  ResolvedActionContribution,
  ResolvedContributionRegistry,
  ResolvedToolContribution,
} from '@/plugins/projection/registry/types';
import { loadPluginDaemonModule } from '@/plugins/runtime/loadPluginDaemonModule';
import type {
  PluginActionHandler,
  PluginActionHandlerRequest,
  PluginActionResult,
  PluginActionSurface,
} from '@/plugins/runtime/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

type PluginActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

export type PluginActionExecutionAttempt = Readonly<
  | { matched: false }
  | { matched: true; result: PluginActionExecutorResult }
>;

type PluginActionExecutionRegistry = ResolvedContributionRegistry | ResolvedExecutablePluginRuntimeRegistry;

type PluginActionRegistryLease = Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  release: () => Promise<void> | void;
}>;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
const jsonSchemaValidators = new WeakMap<object, ValidateFunction>();
const BUILT_IN_ACTION_IDS = new Set<string>(ACTION_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBuiltInActionId(actionId: string): boolean {
  return BUILT_IN_ACTION_IDS.has(actionId);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPluginActionResult(value: unknown): value is PluginActionResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok === true) {
    return true;
  }
  return isRecord(value.error)
    && typeof value.error.code === 'string'
    && value.error.code.trim().length > 0
    && typeof value.error.message === 'string'
    && value.error.message.trim().length > 0;
}

function compileJsonSchema(schema: object): ValidateFunction | null {
  const cached = jsonSchemaValidators.get(schema);
  if (cached) {
    return cached;
  }
  try {
    const compiled = ajv.compile(schema);
    jsonSchemaValidators.set(schema, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function validatePluginActionInput(params: Readonly<{
  action: ResolvedActionContribution;
  input: unknown;
}>): PluginActionExecutorResult | null {
  const schema = params.action.definition.inputSchema;
  if (!isRecord(schema)) {
    return null;
  }
  const validate = compileJsonSchema(schema);
  if (!validate || !validate(params.input)) {
    return {
      ok: false,
      errorCode: 'plugin_action_input_schema_invalid',
      error: 'Plugin action input does not match its manifest inputSchema',
    };
  }
  return null;
}

function validatePluginActionSuccessData(params: Readonly<{
  action: ResolvedActionContribution;
  data: unknown;
}>): PluginActionExecutorResult | null {
  const schema = params.action.definition.outputSchema;
  if (!isRecord(schema)) {
    return null;
  }
  const validate = compileJsonSchema(schema);
  if (!validate || !validate(params.data)) {
    return {
      ok: false,
      errorCode: 'plugin_action_result_schema_invalid',
      error: 'Plugin action returned data that does not match its manifest resultSchema',
    };
  }
  return null;
}

function normalizePluginActionHandlerResult(params: Readonly<{
  action: ResolvedActionContribution;
  result: unknown;
}>): PluginActionExecutorResult {
  if (!isPluginActionResult(params.result)) {
    return {
      ok: false,
      errorCode: 'plugin_action_result_invalid',
      error: 'Plugin action returned an invalid result envelope',
    };
  }
  if (!params.result.ok) {
    return {
      ok: false,
      errorCode: params.result.error.code,
      error: params.result.error.message,
    };
  }

  const data = hasOwn(params.result, 'data') ? params.result.data : null;
  const validationFailure = validatePluginActionSuccessData({
    action: params.action,
    data,
  });
  if (validationFailure) {
    return validationFailure;
  }
  return {
    ok: true,
    result: data,
  };
}

function isExecutablePluginRuntimeRegistry(
  registry: PluginActionExecutionRegistry,
): registry is ResolvedExecutablePluginRuntimeRegistry {
  return 'contributes' in registry;
}

function readPluginActionHandlerExportName(action: ResolvedActionContribution): string | null {
  const execution = isRecord(action.definition.execution) ? action.definition.execution : null;
  const handler = execution && isRecord(execution.handler) ? execution.handler : null;
  if (!handler) {
    return null;
  }
  if (handler.target !== 'plugin' && handler.target !== 'daemon') {
    return null;
  }
  const exportName = typeof handler.exportName === 'string' ? handler.exportName.trim() : '';
  return exportName.length > 0 ? exportName : null;
}

function resolvePluginActionHandlerExport(params: Readonly<{
  moduleNamespace: Readonly<Record<string, unknown>> & Readonly<{ default?: unknown }>;
  exportName: string;
}>): PluginActionHandler | null {
  const directExport = params.moduleNamespace[params.exportName];
  if (typeof directExport === 'function') {
    return directExport as PluginActionHandler;
  }

  const defaultExport = params.moduleNamespace.default;
  if (isRecord(defaultExport)) {
    const nestedExport = defaultExport[params.exportName];
    if (typeof nestedExport === 'function') {
      return nestedExport as PluginActionHandler;
    }
  }

  return null;
}

function normalizePluginActionError(error: unknown, action: ResolvedActionContribution): PluginActionExecutorResult {
  const errorCode = error instanceof Error ? String((error as Error & { code?: string }).code ?? '') : '';
  if (errorCode === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED') {
    return {
      ok: false,
      errorCode: 'plugin_trust_approval_required',
      error: error instanceof Error
        ? error.message
        : 'Plugin action requires explicit trust approval because source trustPolicy is not local_trusted',
    };
  }
  if (errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED') {
    return {
      ok: false,
      errorCode: 'plugin_untrusted',
      error: error instanceof Error
        ? error.message
        : "Plugin action source trustPolicy:'untrusted' denies daemon code execution",
    };
  }
  return {
    ok: false,
    errorCode: 'plugin_action_execution_failed',
    error: error instanceof Error
      ? error.message
      : `Plugin action '${action.definition.id}' failed`,
  };
}

function readContributionRegistry(registry: PluginActionExecutionRegistry): ResolvedContributionRegistry {
  return isExecutablePluginRuntimeRegistry(registry) ? registry.contributes : registry;
}

function resolveActivatedPluginActionHandler(params: Readonly<{
  registry: PluginActionExecutionRegistry;
  contributes: ResolvedContributionRegistry;
  action: ResolvedActionContribution;
}>): PluginActionHandler | null {
  if (!isExecutablePluginRuntimeRegistry(params.registry)) {
    return null;
  }
  const actionId = params.action.definition.id;
  const directHandler = params.registry.actionHandlersByActionId.get(actionId);
  if (directHandler) {
    return directHandler;
  }

  const tool = resolveToolContributionForAction({
    contributes: params.contributes,
    action: params.action,
  });
  return tool
    ? params.registry.actionHandlersByActionId.get(tool.definition.id) ?? null
    : null;
}

function resolveToolContributionForAction(params: Readonly<{
  contributes: ResolvedContributionRegistry;
  action: ResolvedActionContribution;
}>): ResolvedToolContribution | null {
  const actionId = params.action.definition.id;
  const tools = params.contributes.toolsById
    ? [...params.contributes.toolsById.values()]
    : params.contributes.tools ?? [];
  return tools.find((candidate) => candidate.definition.actionId === actionId) ?? null;
}

function resolveActivationEventForAction(params: Readonly<{
  contributes: ResolvedContributionRegistry;
  action: ResolvedActionContribution;
}>): string {
  const actionId = params.action.definition.id;
  const command = [...(params.contributes.commandsById?.values() ?? [])]
    .find((candidate) => candidate.definition.actionId === actionId);
  if (command) {
    return `onCommand:${command.definition.id}`;
  }
  const tool = resolveToolContributionForAction(params);
  if (tool) {
    return `onTool:${tool.definition.id}`;
  }
  return `onAction:${actionId}`;
}

async function activateOwningPluginForAction(params: Readonly<{
  registry: PluginActionExecutionRegistry;
  contributes: ResolvedContributionRegistry;
  action: ResolvedActionContribution;
}>): Promise<PluginActionExecutorResult | null> {
  if (!isExecutablePluginRuntimeRegistry(params.registry)) {
    return null;
  }
  const activationResults = await params.registry.activatePluginsByEvent(resolveActivationEventForAction({
    contributes: params.contributes,
    action: params.action,
  }));
  const pluginId = params.action.pluginId;
  if (!pluginId) {
    return null;
  }
  const diagnostics = activationResults.find((result) => result.pluginId === pluginId)?.diagnostics ?? [];
  const activationFailure = diagnostics.find((diagnostic) => diagnostic.code === 'plugin_activation_failed');
  if (!activationFailure) {
    return null;
  }
  return {
    ok: false,
    errorCode: activationFailure.code,
    error: activationFailure.message,
  };
}

function createPluginActionHandlerRequest(params: Readonly<{
  action: ResolvedActionContribution;
  input: unknown;
  defaultSessionId?: string;
  surface: PluginActionSurface;
}>): PluginActionHandlerRequest {
  return {
    actionId: params.action.definition.id,
    pluginId: params.action.pluginId ?? '',
    input: params.input,
    context: {
      ...(params.defaultSessionId ? { defaultSessionId: params.defaultSessionId } : {}),
      surface: params.surface,
    },
    provenance: {
      ...(params.action.manifestPath ? { manifestPath: params.action.manifestPath } : {}),
      ...(params.action.manifestDigest ? { manifestDigest: params.action.manifestDigest } : {}),
      ...(params.action.sourceSpec?.kind ? { sourceKind: params.action.sourceSpec.kind } : {}),
    },
  };
}

async function executePluginActionHandler(params: Readonly<{
  action: ResolvedActionContribution;
  handler: PluginActionHandler;
  input: unknown;
  defaultSessionId?: string;
  surface: PluginActionSurface;
}>): Promise<PluginActionExecutionAttempt> {
  try {
    const inputValidationFailure = validatePluginActionInput({
      action: params.action,
      input: params.input,
    });
    if (inputValidationFailure) {
      return {
        matched: true,
        result: inputValidationFailure,
      };
    }

    const result = await params.handler(createPluginActionHandlerRequest({
      action: params.action,
      input: params.input,
      defaultSessionId: params.defaultSessionId,
      surface: params.surface,
    }));
    return {
      matched: true,
      result: normalizePluginActionHandlerResult({
        action: params.action,
        result,
      }),
    };
  } catch (error) {
    return {
      matched: true,
      result: normalizePluginActionError(error, params.action),
    };
  }
}

export async function executePluginActionIfAvailable(params: Readonly<{
  happyHomeDir?: string;
  registry?: ResolvedContributionRegistry;
  runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  actionId: ActionId | string;
  input: unknown;
  context: Readonly<{
    defaultSessionId?: string;
    surface?: PluginActionSurface;
  }>;
}>): Promise<PluginActionExecutionAttempt> {
  const actionId = String(params.actionId);
  if (!params.runtimeRegistry && !params.registry && isBuiltInActionId(actionId)) {
    return { matched: false };
  }

  const lease = (!params.runtimeRegistry && !params.registry)
    ? await resolvePluginActionRegistry({ happyHomeDir: params.happyHomeDir })
    : null;
  const registry = params.runtimeRegistry
    ?? params.registry
    ?? lease?.registry;
  if (!registry) {
    return { matched: false };
  }
  try {
    const contributes = readContributionRegistry(registry);
    const action = contributes.actionsById?.get(actionId)
      ?? contributes.actions.find((candidate) => candidate.definition.id === actionId);
    if (!action || action.provenance !== 'external') {
      return { matched: false };
    }

    const surface = params.context.surface ?? 'cli';
    if (action.definition.surfaces[surface] !== true) {
      return {
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_unavailable',
          error: 'Plugin action is not available on the requested surface',
        },
      };
    }

    const pluginId = action.pluginId;
    if (!pluginId || !action.daemonEntryPath) {
      return {
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_handler_missing',
          error: 'Plugin action requires a daemon entry handler',
        },
      };
    }

    const activationFailure = await activateOwningPluginForAction({
      registry,
      contributes,
      action,
    });
    if (activationFailure) {
      return {
        matched: true,
        result: activationFailure,
      };
    }

    const activatedHandler = resolveActivatedPluginActionHandler({
      registry,
      contributes,
      action,
    });
    if (activatedHandler) {
      return await executePluginActionHandler({
        action,
        handler: activatedHandler,
        input: params.input,
        defaultSessionId: params.context.defaultSessionId,
        surface,
      });
    }

    const exportName = readPluginActionHandlerExportName(action);
    if (!exportName) {
      return {
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_handler_missing',
          error: 'Plugin action requires a plugin handler export',
        },
      };
    }

    let moduleNamespace: Awaited<ReturnType<typeof loadPluginDaemonModule>>;
    try {
      moduleNamespace = await loadPluginDaemonModule({
        daemonEntryPath: action.daemonEntryPath,
        devDaemonEntryPath: action.devDaemonEntryPath,
        cacheKey: action.manifestDigest,
        trustPolicy: action.sourceSpec?.trustPolicy,
      });
    } catch (error) {
      return {
        matched: true,
        result: normalizePluginActionError(error, action),
      };
    }

    const handler = resolvePluginActionHandlerExport({ moduleNamespace, exportName });
    if (!handler) {
      return {
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_handler_missing',
          error: `Plugin action handler export '${exportName}' was not found`,
        },
      };
    }

    return await executePluginActionHandler({
      action,
      handler,
      input: params.input,
      defaultSessionId: params.context.defaultSessionId,
      surface,
    });
  } finally {
    await lease?.release();
  }
}

async function resolvePluginActionRegistry(params: Readonly<{
  happyHomeDir?: string;
}>): Promise<PluginActionRegistryLease> {
  const { acquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
  return await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: params.happyHomeDir,
    resolveRuntimeRegistry: async () => {
      const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
      return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: params.happyHomeDir });
    },
  });
}
