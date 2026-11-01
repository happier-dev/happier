import { ingestPluginManifestV2, resolvePluginManifestSetReferencesV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { normalizeParsedPluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectPluginManifestCompatibilityDiagnostic } from '@/plugins/manifest/diagnostics';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { excludeReplacedPluginIdentities } from './pluginIdentities';
import type { ResolvedPluginEnablement } from '../types';

export type AdmittedPluginContributionGraph = Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

export function isPluginAdmissionExclusion(diagnostic: PluginCompatibilityDiagnostic): boolean {
  return diagnostic.code === 'plugin_manifest_invalid' && diagnostic.stage === 'normalization';
}

/** One admission decision for declarations, activation and catalog diagnostics. */
export function admitPluginContributionGraph(params: Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  referencePlugins?: readonly LoadedPlugin[];
  referenceGraph?: AdmittedPluginContributionGraph;
  pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): AdmittedPluginContributionGraph {
  // Bundled references stand on their own: an installed plugin cannot repair
  // an invalid bundled declaration, or cause it to become newly admitted.
  const references = params.referenceGraph ?? (params.referencePlugins?.length
    ? admitPluginContributionGraph({ loadedPlugins: params.referencePlugins })
    : { loadedPlugins: [], diagnosticsByPluginId: {} });
  const loadedPlugins = params.loadedPlugins.filter(plugin => params.pluginEnablementById?.[plugin.pluginId]?.enabled !== false);
  const fallback = excludeReplacedPluginIdentities(references.loadedPlugins, loadedPlugins);
  const selectedIds = new Set(loadedPlugins.map(plugin => plugin.pluginId));
  const affectedPluginIds = new Set(selectedIds);
  let remaining = [...fallback, ...loadedPlugins];
  const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
  while (selectedIds.size > 0 && remaining.length > 0) {
    const resolution = resolvePluginManifestSetReferencesV2(remaining.map(plugin => plugin.manifest), affectedPluginIds);
    if (resolution.ok) break;
    const failedIds = new Set(resolution.diagnostics.map(diagnostic => diagnostic.pluginId));
    const referenceManifests = remaining.map(plugin => plugin.manifest);
    remaining = remaining.flatMap(plugin => {
      if (!failedIds.has(plugin.pluginId)) return [plugin];
      const ingestion = ingestPluginManifestV2(plugin.manifest, { mode: 'load', referenceManifests });
      const diagnostics = ingestion.ok
        ? (ingestion.diagnostics ?? []).map(projectPluginManifestCompatibilityDiagnostic)
        : ingestion.diagnostics.map(diagnostic => ({
            ...projectPluginManifestCompatibilityDiagnostic(diagnostic), stage: 'normalization' as const,
          }));
      diagnosticsByPluginId[plugin.pluginId] = Object.freeze([
        ...(diagnosticsByPluginId[plugin.pluginId] ?? []), ...diagnostics,
      ]);
      affectedPluginIds.add(plugin.pluginId);
      return ingestion.ok ? [{ ...plugin, manifest: normalizeParsedPluginManifestV2(ingestion.manifest),
        admissionDiagnostics: [...(plugin.admissionDiagnostics ?? []), ...diagnostics] }] : [];
    });
  }
  return Object.freeze({ loadedPlugins: Object.freeze(remaining.filter(plugin => selectedIds.has(plugin.pluginId))),
    diagnosticsByPluginId: Object.freeze(diagnosticsByPluginId) });
}
