import { ingestPluginManifestV2, resolvePluginManifestSetReferencesV2, type PluginUnavailableSourceDiagnostic } from '@happier-dev/protocol/plugins/manifest/ingest';
import { normalizeParsedPluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectPluginManifestCompatibilityDiagnostic } from '@/plugins/manifest/diagnostics';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { excludeReplacedPluginIdentities } from './pluginIdentities';
import type { ResolvedPluginEnablement } from '../types';

export type AdmittedPluginContributionGraph = Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
  unavailablePlugins?: readonly PluginUnavailableSourceDiagnostic[];
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
  loadDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
  /** Bundled declarations admitted by the build publisher; see `resolvePluginManifestSetReferencesV2`. */
  declarationAdmittedPluginIds?: ReadonlySet<string>;
}>): AdmittedPluginContributionGraph {
  // Bundled references stand on their own: an installed plugin cannot repair
  // an invalid bundled declaration, or cause it to become newly admitted.
  const references = params.referenceGraph ?? (params.referencePlugins?.length
    ? admitPluginContributionGraph({ loadedPlugins: params.referencePlugins })
    : { loadedPlugins: [], diagnosticsByPluginId: {}, unavailablePlugins: [] });
  const enabled = (plugin: LoadedPlugin) => params.pluginEnablementById?.[plugin.pluginId]?.enabled !== false;
  const loadedPlugins = params.loadedPlugins.filter(enabled);
  const fallback = excludeReplacedPluginIdentities(references.loadedPlugins.filter(enabled), loadedPlugins);
  const selectedIds = new Set(loadedPlugins.map(plugin => plugin.pluginId));
  const unavailablePlugins = new Map((references.unavailablePlugins ?? []).map(source => [source.pluginId, source]));
  for (const [pluginId, diagnostics] of Object.entries(params.loadDiagnosticsByPluginId ?? {})) {
    if (!selectedIds.has(pluginId) && diagnostics[0]) {
      unavailablePlugins.set(pluginId, { pluginId, code: diagnostics[0].code });
    }
  }
  for (const [pluginId, fact] of Object.entries(params.pluginEnablementById ?? {})) {
    if (!fact.enabled) unavailablePlugins.set(pluginId, { pluginId, code: fact.unavailableCode ?? 'plugin_disabled' });
  }

  const affectedPluginIds = new Set(selectedIds);
  let remaining = [...fallback, ...loadedPlugins];
  const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
  while (selectedIds.size > 0 && remaining.length > 0) {
    const resolution = resolvePluginManifestSetReferencesV2(remaining.map(plugin => plugin.manifest), affectedPluginIds,
      { declarationAdmittedPluginIds: params.declarationAdmittedPluginIds, unavailablePlugins: [...unavailablePlugins.values()] });
    for (const source of resolution.unavailablePlugins ?? []) unavailablePlugins.set(source.pluginId, source);
    const referenceDiagnostics = [...(resolution.ok ? [] : resolution.diagnostics), ...(resolution.unavailableReferences ?? [])];
    if (referenceDiagnostics.length === 0) break;
    const failedIds = new Set(referenceDiagnostics.map(diagnostic => diagnostic.pluginId));
    const referenceManifests = remaining.map(plugin => plugin.manifest);
    remaining = remaining.flatMap(plugin => {
      if (!failedIds.has(plugin.pluginId)) return [plugin];
      const ingestion = ingestPluginManifestV2(plugin.manifest, { mode: 'load', referenceManifests, unavailablePlugins: [...unavailablePlugins.values()] });
      const diagnostics = ingestion.ok
        ? (ingestion.diagnostics ?? []).map(projectPluginManifestCompatibilityDiagnostic)
        : ingestion.diagnostics.map(diagnostic => ({
            ...projectPluginManifestCompatibilityDiagnostic(diagnostic), stage: 'normalization' as const,
          }));
      diagnosticsByPluginId[plugin.pluginId] = Object.freeze([
        ...(diagnosticsByPluginId[plugin.pluginId] ?? []), ...diagnostics,
      ]);
      if (!ingestion.ok && diagnostics[0]) unavailablePlugins.set(plugin.pluginId, { pluginId: plugin.pluginId, code: diagnostics[0].code });
      affectedPluginIds.add(plugin.pluginId);
      return ingestion.ok ? [{ ...plugin, manifest: normalizeParsedPluginManifestV2(ingestion.manifest),
        admissionDiagnostics: [...(plugin.admissionDiagnostics ?? []), ...diagnostics] }] : [];
    });
  }
  return Object.freeze({ loadedPlugins: Object.freeze(remaining.filter(plugin => selectedIds.has(plugin.pluginId))),
    diagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    ...(unavailablePlugins.size ? { unavailablePlugins: Object.freeze([...unavailablePlugins.values()]) } : {}) });
}
