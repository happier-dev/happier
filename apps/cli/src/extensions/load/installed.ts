import { resolve } from 'node:path';

import type { ExtensionSourceSpecV1 } from '@happier-dev/protocol';

import { createPluginStateStore, type PluginStateSourceRecord } from '../store/state';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '../store/paths';
import type { PluginCompatibilityDiagnostic } from '../diagnostics/types';
import { resolvePluginDaemonEntryPath } from '../manifest/daemonEntry';
import type { CanonicalPluginManifest } from '../manifest/types';
import {
  resolveLocalPathPluginSource,
  type ResolvedLocalPathPluginSourceSuccess,
} from '../sources/localPath';

export type LoadedPlugin = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  manifestDigest: string;
  daemonEntryPath: string | null;
  manifest: CanonicalPluginManifest;
  sourceSpec: ExtensionSourceSpecV1;
}>;

export type LoadInstalledPluginsResult = Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

// Backwards compatible resolution: older plugin state records may store a manifestPath override
// that no longer matches the default.

function mergeLoadedPluginSourceSpec(params: Readonly<{
  recordSource: PluginStateSourceRecord;
  resolvedSource: ResolvedLocalPathPluginSourceSuccess;
}>): ExtensionSourceSpecV1 {
  return {
    ...params.recordSource,
    resolvedPath: params.resolvedSource.pluginRootPath,
    manifestPath: params.resolvedSource.manifestPath,
    resolvedVersion: params.resolvedSource.manifest.version,
    resolvedDigest: params.resolvedSource.manifestDigest,
  };
}

export async function loadInstalledPlugins(params?: Readonly<{ happyHomeDir?: string }>): Promise<LoadInstalledPluginsResult> {
  const stateStore = createPluginStateStore({ happyHomeDir: params?.happyHomeDir });
  const state = await stateStore.read();
  const loadedPlugins: LoadedPlugin[] = [];
  const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};

  for (const [pluginId, record] of Object.entries(state.plugins)) {
    if (!record.state.enabled) {
      continue;
    }

    if (record.install.mode !== 'managed_install' && record.source.kind !== 'path') {
      diagnosticsByPluginId[pluginId] = [
        {
          code: 'plugin_source_kind_unsupported',
          message: `Plugin state source kind '${record.source.kind}' is unsupported for non-managed installs; expected 'path'`,
        },
      ];
      continue;
    }

    const defaultManifestPath = resolve(record.source.locator, PLUGIN_MANIFEST_RELATIVE_PATH);
    const resolvedLocator = record.install.mode === 'managed_install'
      ? record.install.installedPath
      : record.source.manifestPath && record.source.manifestPath !== defaultManifestPath
        ? record.source.manifestPath
        : record.source.locator;
    if (typeof resolvedLocator !== 'string' || resolvedLocator.trim().length === 0) {
      diagnosticsByPluginId[pluginId] = [
        {
          code: 'plugin_manifest_semantic_invalid',
          message: `Plugin state for '${pluginId}' is missing a resolvable install path`,
        },
      ];
      continue;
    }

    const resolvedSource = await resolveLocalPathPluginSource({
      locator: resolvedLocator,
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
    });
    if (!daemonEntryResolution.ok) {
      diagnosticsByPluginId[pluginId] = [daemonEntryResolution.diagnostic];
      continue;
    }

    loadedPlugins.push({
      pluginId,
      pluginRootPath: resolvedSource.pluginRootPath,
      manifestPath: resolvedSource.manifestPath,
      manifestDigest: resolvedSource.manifestDigest,
      daemonEntryPath: daemonEntryResolution.daemonEntryPath,
      manifest: resolvedSource.manifest,
      sourceSpec: mergeLoadedPluginSourceSpec({
        recordSource: record.source,
        resolvedSource,
      }),
    });
    diagnosticsByPluginId[pluginId] = [];
  }

  return {
    loadedPlugins: Object.freeze(loadedPlugins),
    diagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
  };
}
