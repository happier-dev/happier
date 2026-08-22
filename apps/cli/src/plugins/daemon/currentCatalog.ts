import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import {
  readInstalledPluginCatalog,
  type PluginCatalogEntry,
} from '@/plugins/projection/catalog/installed';
import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';
import {
  projectExecutablePluginToolCatalog,
  type ProjectedPluginToolCatalogEntry,
} from '@/plugins/runtime/toolCatalog';

export type CurrentDaemonPluginCatalogSnapshot = Readonly<{
  plugins: readonly PluginCatalogEntry[];
  tools: readonly ProjectedPluginToolCatalogEntry[];
}>;

function projectCurrentDaemonPluginTools(
  registry: Parameters<typeof projectExecutablePluginToolCatalog>[0],
): readonly ProjectedPluginToolCatalogEntry[] {
  const immutableGenerationIdsByPluginId =
    registry.contributes.immutableGenerationIdsByPluginId ?? {};
  return Object.freeze(projectExecutablePluginToolCatalog(registry).flatMap((tool) => {
    const actionPluginId = registry.contributes.actionsById
      ?.get(tool.actionId)
      ?.pluginId
      ?.trim();
    const immutableGenerationId = actionPluginId
      ? immutableGenerationIdsByPluginId[actionPluginId]?.trim()
      : undefined;
    // A long-lived MCP server must retain the exact Action contributor it
    // advertised. Without this lease-local fence, a replacement could run
    // through the old server's Tool catalog.
    return immutableGenerationId
      ? [Object.freeze({
          ...tool,
          expectedContributorImmutableGenerationId: immutableGenerationId,
        })]
      : [];
  }));
}

/**
 * Reads the daemon's ordinary installed/current-state view. Durable desired
 * identity comes from the registry snapshot; applied identity and runtime
 * introspection come from the one active runtime-registry lease.
 */
export async function readCurrentDaemonPluginCatalog(params: Readonly<{
  reloadController: PluginReloadController;
  happyHomeDir?: string;
}>): Promise<readonly PluginCatalogEntry[]> {
  return (await readCurrentDaemonPluginCatalogSnapshot(params)).plugins;
}

export async function readCurrentDaemonPluginCatalogSnapshot(params: Readonly<{
  reloadController: PluginReloadController;
  happyHomeDir?: string;
}>): Promise<CurrentDaemonPluginCatalogSnapshot> {
  const lease = params.reloadController.tryAcquireRuntimeRegistry?.() ?? null;
  if (!lease) {
    return {
      plugins: await readInstalledPluginCatalog(
        params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : undefined,
      ),
      tools: Object.freeze([]),
    };
  }
  try {
    return {
      plugins: joinInstalledCatalogRuntimeIntrospection(
        await readInstalledPluginCatalog(
          params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : undefined,
        ),
        lease.registry,
      ),
      tools: projectCurrentDaemonPluginTools(lease.registry),
    };
  } finally {
    await lease.release();
  }
}
