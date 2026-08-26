import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import {
  projectBundledPluginCatalogEntries,
  readInstalledPluginCatalogSnapshot,
  type PluginCatalogEntry,
} from '@/plugins/projection/catalog/installed';
import { loadBundledPluginLocators } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  projectExecutablePluginToolCatalog,
  type ProjectedPluginToolCatalogEntry,
} from '@/plugins/runtime/toolCatalog';

export type CurrentDaemonPluginCatalogSnapshot = Readonly<{
  plugins: readonly PluginCatalogEntry[];
  tools: readonly ProjectedPluginToolCatalogEntry[];
}>;

const bundledPlugins = loadBundledPluginLocators(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS);

function projectCurrentDaemonPluginCatalogEntries(
  installedEntries: readonly PluginCatalogEntry[],
  runtimeRegistry?: Pick<ResolvedExecutablePluginRuntimeRegistry, 'pluginFinalPolicyCurrentGenerationsById'>,
): readonly PluginCatalogEntry[] {
  const installedPluginIds = new Set(installedEntries.map((entry) => entry.pluginId));
  const desiredGenerationByPluginId = Object.freeze(Object.fromEntries(
    [...(runtimeRegistry?.pluginFinalPolicyCurrentGenerationsById ?? new Map())]
      .map(([pluginId, current]) => [pluginId, current.immutableGenerationId]),
  ));
  return Object.freeze([
    ...installedEntries,
    ...projectBundledPluginCatalogEntries({
      loadedPlugins: bundledPlugins,
      desiredGenerationByPluginId,
      excludedPluginIds: installedPluginIds,
    }),
  ].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

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
  const lease = params.reloadController.tryAcquireRuntimeRegistry?.() ?? null;
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
