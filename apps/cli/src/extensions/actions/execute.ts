import type { ActionId } from '@happier-dev/protocol';

import type { ResolvedActionContribution, ResolvedContributionRegistry } from '@/extensions/registry/types';
import { loadPluginDaemonModule } from '@/extensions/runtime/loadPluginDaemonModule';
import type {
  PluginActionHandler,
  PluginActionHandlerRequest,
  PluginActionSurface,
} from '@/extensions/runtime/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/extensions/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/extensions/reload/runtimeLease';

type PluginActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

export type PluginActionExecutionAttempt = Readonly<
  | { matched: false }
  | { matched: true; result: PluginActionExecutorResult }
>;

type PluginActionExecutionRegistry = ResolvedContributionRegistry | ResolvedExecutablePluginRuntimeRegistry;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExecutablePluginRuntimeRegistry(
  registry: PluginActionExecutionRegistry,
): registry is ResolvedExecutablePluginRuntimeRegistry {
  return 'contributions' in registry;
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
    return { ok: false, errorCode: 'plugin_trust_approval_required', error: 'Plugin action requires explicit trust approval' };
  }
  if (errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED') {
    return { ok: false, errorCode: 'plugin_untrusted', error: 'Plugin action source is untrusted' };
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
  return isExecutablePluginRuntimeRegistry(registry) ? registry.contributions : registry;
}

function resolveActivatedPluginActionHandler(params: Readonly<{
  registry: PluginActionExecutionRegistry;
  actionId: string;
}>): PluginActionHandler | null {
  if (!isExecutablePluginRuntimeRegistry(params.registry)) {
    return null;
  }
  return params.registry.actionHandlersByActionId.get(params.actionId) ?? null;
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
    const result = await params.handler(createPluginActionHandlerRequest({
      action: params.action,
      input: params.input,
      defaultSessionId: params.defaultSessionId,
      surface: params.surface,
    }));
    return {
      matched: true,
      result: {
        ok: true,
        result: typeof result === 'undefined' ? null : result,
      },
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
    const contributions = readContributionRegistry(registry);
    const action = contributions.actionsById?.get(String(params.actionId))
      ?? contributions.actions.find((candidate) => candidate.definition.id === String(params.actionId));
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

    const activatedHandler = resolveActivatedPluginActionHandler({
      registry,
      actionId: action.definition.id,
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
}>): Promise<Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>>> {
  return await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: params.happyHomeDir,
    resolveRuntimeRegistry: async () => {
      const { resolveExecutablePluginRuntimeRegistry } = await import('@/extensions/runtime/resolveExecutablePluginRuntimeRegistry');
      return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: params.happyHomeDir });
    },
  });
}
