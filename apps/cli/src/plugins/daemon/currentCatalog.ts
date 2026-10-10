import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import {
  projectBundledPluginCatalogEntries,
  readInstalledPluginCatalogSnapshot,
  type PluginCatalogEntry,
} from '@/plugins/projection/catalog/installed';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  projectOccurrenceBoundExecutablePluginToolCatalog,
  type ProjectedPluginToolCatalogEntry,
} from '@/plugins/runtime/toolCatalog';

export type CurrentDaemonPluginCatalogSnapshot = Readonly<{
  plugins: readonly PluginCatalogEntry[];
  tools: readonly ProjectedPluginToolCatalogEntry[];
}>;

function projectCurrentDaemonPluginCatalogEntries(
  installedEntries: readonly PluginCatalogEntry[],
  runtimeRegistry?: Pick<ResolvedExecutablePluginRuntimeRegistry, 'pluginFinalPolicyCurrentRuntimesById'>,
): readonly PluginCatalogEntry[] {
  // Session runners import shared daemon services but do not read this catalog.
  // Admit bundled declarations only for an actual catalog projection; the
  // locator owner already retains the immutable process-local admission.
  const bundledPlugins = loadCurrentBundledPluginLocatorResult();
  const installedPluginIds = new Set(installedEntries.map((entry) => entry.pluginId));
  const desiredGenerationByPluginId = Object.freeze(Object.fromEntries(
    [...(runtimeRegistry?.pluginFinalPolicyCurrentRuntimesById ?? new Map())]
      .map(([pluginId, current]) => [
        pluginId,
        current.sourceCustody.kind === 'managed'
          ? current.sourceCustody.immutableGenerationId
          : current.occurrenceId,
      ]),
  ));
  return Object.freeze([
    ...installedEntries,
    ...projectBundledPluginCatalogEntries({
      loadedPlugins: bundledPlugins.loadedPlugins,
      pluginFailures: bundledPlugins.pluginFailures,
      desiredGenerationByPluginId,
      excludedPluginIds: installedPluginIds,
    }),
  ].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

function projectCurrentDaemonPluginTools(
  registry: Parameters<typeof projectOccurrenceBoundExecutablePluginToolCatalog>[0],
): readonly ProjectedPluginToolCatalogEntry[] {
  return projectOccurrenceBoundExecutablePluginToolCatalog(registry);
}

/**
 * Reads the daemon's one current plugin catalog. Durable desired identity for
 * external plugins comes from the registry snapshot; data-only generated
 * locators supply bundled entries. Applied identity and runtime introspection
 * come from the one active runtime-registry lease.
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
  const catalogParams = params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : undefined;
  const lease = params.reloadController.tryAcquireRuntimeRegistry();
  try {
    const catalog = await readInstalledPluginCatalogSnapshot(catalogParams);
    // A durable commit can lead publication of its derived serving lease. Do
    // not combine snapshots from different revisions: until a later read
    // acquires a matching lease, expose the durable catalog without runtime
    // diagnostics or tools.
    if (!lease || lease.durableRevision !== catalog.revision) {
      return {
        plugins: projectCurrentDaemonPluginCatalogEntries(catalog.entries),
        tools: Object.freeze([]),
      };
    }

    const currentEntries = projectCurrentDaemonPluginCatalogEntries(catalog.entries, lease.registry);

    return {
      plugins: joinInstalledCatalogRuntimeIntrospection(currentEntries, lease.registry),
      tools: projectCurrentDaemonPluginTools(lease.registry),
    };
  } finally {
    await lease?.release();
  }
}
