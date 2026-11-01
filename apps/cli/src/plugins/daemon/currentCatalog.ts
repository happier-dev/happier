import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { DaemonPluginCatalogReadRequest } from './catalogProjection';
import {
  projectBundledPluginCatalogEntries,
  readInstalledPluginCatalogSnapshot,
  type PluginCatalogEntry,
} from '@/plugins/projection/catalog/installed';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { readCurrentBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/snapshot';
import type { ResolvedPluginEnablement } from '@/plugins/projection/registry/types';
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

let bundledCatalogEntries: readonly PluginCatalogEntry[] | undefined;

function projectCurrentDaemonPluginCatalogEntries(
  installedEntries: readonly PluginCatalogEntry[],
  pluginEnablementById: Readonly<Record<string, ResolvedPluginEnablement>>,
  currentRuntimes?: ResolvedExecutablePluginRuntimeRegistry['pluginFinalPolicyCurrentRuntimesById'],
): readonly PluginCatalogEntry[] {
  // Session runners import shared daemon services but do not read this catalog.
  // Admit bundled declarations only for an actual catalog projection; the
  // locator owner already retains the immutable process-local admission.
  if (!bundledCatalogEntries) {
    const bundledPlugins = loadCurrentBundledPluginLocatorResult();
    // Bundled admission is immutable for this process. Retain its declaration
    // projection, not the changing installed state or serving runtime facts.
    bundledCatalogEntries = projectBundledPluginCatalogEntries(bundledPlugins);
  }
  const installedPluginIds = new Set(installedEntries.map((entry) => entry.pluginId));
  return Object.freeze([
    ...installedEntries.map(entry => pluginEnablementById[entry.pluginId]
      ? { ...entry, ...pluginEnablementById[entry.pluginId] }
      : entry),
    ...bundledCatalogEntries.filter((entry) => !installedPluginIds.has(entry.pluginId)).map((entry) => {
      const current = entry.manifest
        ? currentRuntimes?.get(entry.pluginId)
        : undefined;
      const desiredGeneration = current
        ? current.sourceCustody.kind === 'managed'
          ? current.sourceCustody.immutableGenerationId
          : current.occurrenceId
        : null;
      return {
        ...entry,
        ...pluginEnablementById[entry.pluginId],
        ...(!entry.manifest ? { enabled: false } : {}),
        desiredGeneration,
      };
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
  selection?: DaemonPluginCatalogReadRequest['selection'];
}>): Promise<CurrentDaemonPluginCatalogSnapshot> {
  const lease = params.reloadController.tryAcquireRuntimeRegistry();
  try {
    if (params.selection === 'tools') {
      // The controller observes durable adoption before serving publication,
      // including failures. Passive reads join that fact to their exact lease
      // without reopening installation and rollback metadata from disk.
      return {
        plugins: Object.freeze([]),
        tools: lease && lease.durableRevision === params.reloadController.readCurrentDurableRevision()
          ? projectCurrentDaemonPluginTools(lease.registry)
          : Object.freeze([]),
      };
    }

    const catalog = await readInstalledPluginCatalogSnapshot({ happyHomeDir: params.happyHomeDir });
    // A durable commit can lead publication of its derived serving lease. Do
    // not combine snapshots from different revisions: until a later read
    // acquires a matching lease, expose the durable catalog without runtime
    // diagnostics or tools.
    if (!lease || lease.durableRevision !== catalog.revision) {
      const pluginEnablementById = await readCurrentBundledPluginEnablement({
        happyHomeDir: params.happyHomeDir,
        machineEnabledById: catalog.bundledPluginEnabledById,
      });
      return {
        plugins: joinInstalledCatalogRuntimeIntrospection(
          projectCurrentDaemonPluginCatalogEntries(catalog.entries, pluginEnablementById),
          undefined,
        ),
        tools: Object.freeze([]),
      };
    }

    // These registry getters derive whole-registry facts. Read them once for
    // this synchronous projection, never once per catalog row. The next read
    // still observes the live activation owner rather than a retained cache.
    const runtimeSnapshot = {
      generation: lease.registry.generation,
      targetActivationFacts: lease.registry.targetActivationFacts,
      pluginDiagnosticsByPluginId: lease.registry.pluginDiagnosticsByPluginId,
      pluginFinalPolicyCurrentRuntimesById: lease.registry.pluginFinalPolicyCurrentRuntimesById,
    };
    const currentEntries = projectCurrentDaemonPluginCatalogEntries(
      catalog.entries,
      lease.registry.contributes.pluginEnablementById ?? await readCurrentBundledPluginEnablement({
        happyHomeDir: params.happyHomeDir,
        machineEnabledById: catalog.bundledPluginEnabledById,
      }),
      runtimeSnapshot.pluginFinalPolicyCurrentRuntimesById,
    );

    return {
      plugins: joinInstalledCatalogRuntimeIntrospection(currentEntries, runtimeSnapshot),
      tools: projectCurrentDaemonPluginTools(lease.registry),
    };
  } finally {
    await lease?.release();
  }
}
