import type { LoadedPlugin } from './installed';
import { admitDecodedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { projectPluginManifestCompatibilityDiagnostic } from '@/plugins/manifest/diagnostics';
import type { PluginStateFileV1 } from '@/plugins/store/state';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { readAdmittedPluginRegistryState } from '@/plugins/store/registry/admittedState';
import { resolvePluginStorePathLayout } from '@/plugins/store/pathLayout';
import { readInstalledPluginSourceDiagnostic } from './installedSource';

export type AdmittedInstalledPluginDeclaration = Pick<LoadedPlugin, 'pluginId' | 'pluginRootPath' | 'manifestPath' | 'manifest' | 'sourceSpec'>;

/**
 * Read-only declarations accepted by the installation writer. This does not
 * resolve executable entrypoints, read source manifests, or activate plugins.
 */
export async function loadAdmittedInstalledPluginDeclarations(happyHomeDir: string): Promise<Readonly<{
  state: PluginStateFileV1;
  loadedPlugins: readonly AdmittedInstalledPluginDeclaration[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>> {
  const current = await readAdmittedPluginRegistryState(resolvePluginStorePathLayout(happyHomeDir));
  const state: PluginStateFileV1 = current?.catalog ?? { t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: {} };
  const loadedPlugins: AdmittedInstalledPluginDeclaration[] = [];
  const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
  for (const [pluginId, record] of Object.entries(state.plugins)) {
    if (!record.state.enabled) continue;
    const sourceDiagnostic = readInstalledPluginSourceDiagnostic(record);
    if (sourceDiagnostic) {
      diagnosticsByPluginId[pluginId] = [sourceDiagnostic];
      continue;
    }
    const manifest = current?.revision.plugins[pluginId]?.approvedAuthorityManifest;
    if (!manifest) {
      diagnosticsByPluginId[pluginId] = [{
        code: 'plugin_manifest_missing',
        message: `Plugin '${record.source.locator}' has no accepted manifest projection`,
      }];
      continue;
    }
    const admission = admitDecodedPluginManifestV2(manifest, { mode: 'load' });
    if (admission.diagnostics?.length) {
      diagnosticsByPluginId[pluginId] = admission.diagnostics.map(projectPluginManifestCompatibilityDiagnostic);
    }
    if (!admission.ok) continue;
    loadedPlugins.push({
      pluginId,
      pluginRootPath: record.source.resolvedPath,
      manifestPath: record.source.manifestPath,
      manifest: admission.manifest,
      sourceSpec: record.source,
    });
  }
  return { state, loadedPlugins, diagnosticsByPluginId };
}
