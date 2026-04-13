import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ExtensionSourceSpecV1, PluginManifestV1 } from '@happier-dev/protocol';

import { createPluginStateStore } from '../store/pluginStateStore';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '../store/pluginPaths';
import type { PluginCompatibilityDiagnostic } from '../shared/pluginDiagnostics';
import { resolveLocalPathPluginSource } from '../sources/resolveLocalPathPluginSource';

export type LoadedPlugin = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  manifestDigest: string;
  daemonEntryPath: string | null;
  manifest: PluginManifestV1;
  sourceSpec: ExtensionSourceSpecV1;
}>;

export type LoadInstalledPluginsResult = Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function resolveCanonicalExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return path;
    }
    throw error;
  }
}

async function resolveDaemonEntryPath(
  pluginRootPath: string,
  manifest: PluginManifestV1,
): Promise<Readonly<
  | { ok: true; daemonEntryPath: string | null }
  | { ok: false; diagnostic: PluginCompatibilityDiagnostic }
>> {
  const daemonEntry = manifest.targets.daemon?.entry;
  if (!daemonEntry) {
    return {
      ok: true,
      daemonEntryPath: null,
    };
  }
  const resolvedPath = resolve(pluginRootPath, daemonEntry);
  const canonicalResolvedPath = await resolveCanonicalExistingPath(resolvedPath);
  if (!isPathInsideRoot(pluginRootPath, canonicalResolvedPath)) {
    return {
      ok: false,
      diagnostic: {
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin daemon entry '${daemonEntry}' escapes the plugin root`,
      },
    };
  }
  return {
    ok: true,
    daemonEntryPath: canonicalResolvedPath,
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

    const daemonEntryResolution = await resolveDaemonEntryPath(
      resolvedSource.pluginRootPath,
      resolvedSource.manifest,
    );
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
      sourceSpec: record.install.mode === 'managed_install' ? record.source : resolvedSource.sourceSpec,
    });
    diagnosticsByPluginId[pluginId] = [];
  }

  return {
    loadedPlugins: Object.freeze(loadedPlugins),
    diagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
  };
}
