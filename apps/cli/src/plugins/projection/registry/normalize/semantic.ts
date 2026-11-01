import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { PluginOwnedSemanticContribution } from './registry';

export type PluginContributionCanonicalizer = (
  entry: (typeof PLUGIN_CONTRIBUTION_CATALOG_V2)[number], value: unknown, pluginId: string,
) => unknown;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Select after admission, before reading or projecting unrelated declaration families. */
export function* readPluginSemanticContributions(
  plugin: LoadedPlugin,
  selection: Readonly<{ family: 'agents' | 'providers'; keys: ReadonlySet<string> }> | undefined,
  canonicalize: PluginContributionCanonicalizer,
): Iterable<PluginOwnedSemanticContribution> {
  const selected = selection?.keys;
  if (selected && ![...selected].some(key => key.startsWith(`${plugin.pluginId}/`))) return;
  for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    if (selection && entry.manifestKey !== selection.family) continue;
    for (const raw of entry.readEntries(plugin.manifest.contributes)) {
      if (selected && (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string'
        || !selected.has(buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: raw.id }))))) continue;
      const definition = canonicalize(entry, raw, plugin.pluginId);
      if (!isRecord(definition)) continue;
      const introspection = entry.projectIntrospection(definition);
      yield Object.freeze({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        ...(introspection.localId ? { identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: introspection.localId }) } : {}),
        family: entry.manifestKey,
        conflictKey: entry.conflictKey(definition),
        introspection,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
  }
}
