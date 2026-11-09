import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import { isDynamicPluginResourceContributionV2 } from '@happier-dev/protocol/plugins/contributions/v2';

import type { PluginStateFileV1, PluginStateSourceRecord } from '@/plugins/store/state';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
  resolvePluginDaemonEntryPath,
  shouldResolvePluginDevelopmentEntrypoint,
} from '@/plugins/manifest/daemonEntry';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { StoredApprovedPluginManifest } from '@/plugins/store/registry/generationStore';
import type { ResolvedLocalPathPluginSourceSuccess } from '@/plugins/discovery/sources/localPath';
import { resolveInstalledPluginSource } from '@/plugins/discovery/sources/resolve';
import { readGeneratedPluginUiArtifactsManifest, readGeneratedPluginCompiledManifestSync } from '@/plugins/install/ui/generatedArtifacts';

export type LoadedPlugin = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath: string | null;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV2;
  /** Descriptive build input of the adopted Account graph, never activation authority. */
  compiledAccountManifest?: CanonicalPluginManifest;
  manifest: CanonicalPluginManifest;
  admissionDiagnostics?: readonly PluginCompatibilityDiagnostic[];
  sourceSpec: PluginSourceSpecV1;
}>;

export type LoadInstalledPluginsResult = Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
  /** Current committed epochs aligned with the loaded registry snapshot. */
  materializationIdsByPluginId?: Readonly<Record<string, string>>;
}>;

function mergeLoadedPluginSourceSpec(params: Readonly<{
  recordSource: PluginStateSourceRecord;
  resolvedSource: ResolvedLocalPathPluginSourceSuccess;
}>): PluginSourceSpecV1 {
  return {
    ...params.recordSource,
    resolvedPath: params.resolvedSource.pluginRootPath,
    manifestPath: params.resolvedSource.manifestPath,
    resolvedVersion: params.resolvedSource.manifest.version,
  };
}

export async function loadPluginsFromState(
  state: PluginStateFileV1,
  materializationIdsByPluginId: Readonly<Record<string, string>> = {},
  approvedAuthorityManifestsByPluginId: Readonly<Record<string, StoredApprovedPluginManifest>> = {},
): Promise<LoadInstalledPluginsResult> {
  const loadedPlugins: LoadedPlugin[] = [];
  const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};

  for (const [pluginId, record] of Object.entries(state.plugins)) {
    if (!record.state.enabled) {
      continue;
    }

    const resolvedSource = await resolveInstalledPluginSource({
      record,
      approvedAuthorityManifest: approvedAuthorityManifestsByPluginId[pluginId],
    });
    if (!resolvedSource.ok) {
      diagnosticsByPluginId[pluginId] = resolvedSource.diagnostics;
      continue;
    }

    if (resolvedSource.manifest.id !== pluginId) {
      diagnosticsByPluginId[pluginId] = [
        {
          code: 'plugin_manifest_semantic_invalid',
          message: `Plugin state id '${pluginId}' does not match manifest id '${resolvedSource.manifest.id}'`,
        },
      ];
      continue;
    }

    const daemonEntryResolution = await resolvePluginDaemonEntryPath({
      pluginRootPath: resolvedSource.pluginRootPath,
      manifest: resolvedSource.manifest,
      ...(resolvedSource.diagnostics?.length ? { admissionDiagnostics: resolvedSource.diagnostics } : {}),
      resolveDevEntrypoint: shouldResolvePluginDevelopmentEntrypoint(record),
    });
    if (!daemonEntryResolution.ok) {
      diagnosticsByPluginId[pluginId] = [daemonEntryResolution.diagnostic];
      continue;
    }
    const generatedUiArtifactsManifest = await readGeneratedPluginUiArtifactsManifest(
      resolvedSource.pluginRootPath,
    );
    const compiledAccountManifest = generatedUiArtifactsManifest
      && resolvedSource.manifest.contributes.resources.some(resource => isDynamicPluginResourceContributionV2(resource) && resource.execution?.target === 'account')
      ? readGeneratedPluginCompiledManifestSync(resolvedSource.pluginRootPath, pluginId) : null;

    const loadedPlugin: LoadedPlugin = {
      pluginId,
      pluginRootPath: resolvedSource.pluginRootPath,
      manifestPath: resolvedSource.manifestPath,
      daemonEntryPath: daemonEntryResolution.daemonEntryPath,
      devDaemonEntryPath: daemonEntryResolution.devDaemonEntryPath,
      ...(generatedUiArtifactsManifest ? { generatedUiArtifactsManifest } : {}),
      ...(compiledAccountManifest ? { compiledAccountManifest } : {}),
      manifest: resolvedSource.manifest,
      sourceSpec: mergeLoadedPluginSourceSpec({
        recordSource: record.source,
        resolvedSource,
      }),
    };
    loadedPlugins.push(loadedPlugin);
    diagnosticsByPluginId[pluginId] = resolvedSource.diagnostics ?? [];
  }

  return {
    loadedPlugins: Object.freeze(loadedPlugins),
    diagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    materializationIdsByPluginId: Object.freeze({ ...materializationIdsByPluginId }),
  };
}

export async function loadInstalledPlugins(params?: Readonly<{ happyHomeDir?: string; pluginIds?: readonly string[] }>): Promise<LoadInstalledPluginsResult> {
  const stateStore = createPluginRegistryStateStore({ happyHomeDir: params?.happyHomeDir });
  const snapshot = await stateStore.readSnapshot();
  return await loadPluginsFromState(
    params?.pluginIds ? { ...snapshot.state, plugins: Object.fromEntries(Object.entries(snapshot.state.plugins)
      .filter(([pluginId]) => params.pluginIds!.includes(pluginId))) } : snapshot.state,
    snapshot.materializationIdsByPluginId,
    snapshot.approvedAuthorityManifestsByPluginId,
  );
}
