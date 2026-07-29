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
      tools: projectExecutablePluginToolCatalog(lease.registry),
    };
  } finally {
    await lease.release();
  }
}
