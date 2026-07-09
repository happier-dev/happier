import { resolve } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';

import { createPluginStateStore, type PluginStateSourceRecord } from '@/plugins/store/state';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { resolvePluginDaemonEntryPath } from '@/plugins/manifest/daemonEntry';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { isTrustPolicyLocallyTrusted } from '@/plugins/install/ui/trustedSource';
import {
  resolveLocalPathPluginSource,
  type ResolvedLocalPathPluginSourceSuccess,
} from '@/plugins/discovery/sources/localPath';

export type LoadedPlugin = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  manifestDigest: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath: string | null;
  manifest: CanonicalPluginManifest;
  sourceSpec: PluginSourceSpecV1;
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
}>): PluginSourceSpecV1 {
  return {
    ...params.recordSource,
    resolvedPath: params.resolvedSource.pluginRootPath,
    manifestPath: params.resolvedSource.manifestPath,
    resolvedVersion: params.resolvedSource.manifest.version,
    resolvedDigest: params.resolvedSource.manifestDigest,
  };
}

function shouldResolveDevEntrypoint(record: Readonly<{
  source: PluginStateSourceRecord;
  install: Readonly<{ mode: string }>;
}>): boolean {
  return record.source.kind === 'path'
    && record.install.mode === 'link'
    && isTrustPolicyLocallyTrusted(record.source.trustPolicy);
}

export async function loadInstalledPlugins(params?: Readonly<{ happyHomeDir?: string }>): Promise<LoadInstalledPluginsResult> {
  const stateStore = createPluginStateStore({ happyHomeDir: params?.happyHomeDir });
  const state = await stateStore.read();
  const loadedPlugins: LoadedPlugin[] = [];
  const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
  const loadedByManifestId = new Map<string, {
    statePluginId: string;
    pluginRootPath: string;
    loadedPlugin: LoadedPlugin | null;
  }>();

  for (const [pluginId, record] of Object.entries(state.plugins)) {
    if (!record.state.enabled) {
      continue;
    }

    if (record.source.kind === 'bundled') {
      diagnosticsByPluginId[pluginId] = [
        {
          code: 'plugin_source_kind_unsupported',
          message: `Plugin state source kind 'bundled' is host-derived bundled provenance and cannot be claimed by installed plugin state`,
        },
      ];
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

    const existingLoaded = loadedByManifestId.get(resolvedSource.manifest.id);
    if (existingLoaded) {
      const message = `Duplicate plugin id '${resolvedSource.manifest.id}' from '${resolvedSource.pluginRootPath}' conflicts with '${existingLoaded.pluginRootPath}'`;
      if (existingLoaded.loadedPlugin) {
        const loadedIndex = loadedPlugins.indexOf(existingLoaded.loadedPlugin);
        if (loadedIndex >= 0) {
          loadedPlugins.splice(loadedIndex, 1);
        }
        existingLoaded.loadedPlugin = null;
      }
      diagnosticsByPluginId[existingLoaded.statePluginId] = [
        {
          code: 'plugin_manifest_duplicate_id',
          message,
        },
      ];
      diagnosticsByPluginId[pluginId] = [
        {
          code: 'plugin_manifest_duplicate_id',
          message,
        },
      ];
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
      resolveDevEntrypoint: shouldResolveDevEntrypoint(record),
    });
    if (!daemonEntryResolution.ok) {
      diagnosticsByPluginId[pluginId] = [daemonEntryResolution.diagnostic];
      continue;
    }

    const loadedPlugin: LoadedPlugin = {
      pluginId,
      pluginRootPath: resolvedSource.pluginRootPath,
      manifestPath: resolvedSource.manifestPath,
      manifestDigest: resolvedSource.manifestDigest,
      daemonEntryPath: daemonEntryResolution.daemonEntryPath,
      devDaemonEntryPath: daemonEntryResolution.devDaemonEntryPath,
      manifest: resolvedSource.manifest,
      sourceSpec: mergeLoadedPluginSourceSpec({
        recordSource: record.source,
        resolvedSource,
      }),
    };
    loadedPlugins.push(loadedPlugin);
    loadedByManifestId.set(resolvedSource.manifest.id, {
      statePluginId: pluginId,
      pluginRootPath: resolvedSource.pluginRootPath,
      loadedPlugin,
    });
    diagnosticsByPluginId[pluginId] = [];
  }

  return {
    loadedPlugins: Object.freeze(loadedPlugins),
    diagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
  };
}
