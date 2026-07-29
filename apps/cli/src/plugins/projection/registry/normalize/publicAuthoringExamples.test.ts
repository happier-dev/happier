import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';

import { buildPluginContributionRegistry } from './package';

const examplesRoot = fileURLToPath(new URL('../../../../../../../packages/plugin-sdk/examples', import.meta.url));

function listInstallableExampleRoots(): readonly string[] {
  return readdirSync(examplesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(examplesRoot, entry.name))
    .filter((exampleRoot) => {
      try {
        readFileSync(join(exampleRoot, '.happier-plugin', 'plugin.json'), 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function readLoadedExamplePlugin(exampleRoot: string): LoadedPlugin {
  const manifestPath = join(exampleRoot, '.happier-plugin', 'plugin.json');
  const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const manifest = readCanonicalPluginManifest(rawManifest);
  expect(manifest, `${manifestPath} must normalize through the CLI plugin manifest projection`).not.toBeNull();
  if (!manifest) {
    throw new Error(`Failed to normalize ${manifestPath}`);
  }

  return {
    pluginId: manifest.id,
    pluginRootPath: exampleRoot,
    manifestPath,
    manifestDigest: `sha256:${manifest.id}`,
    daemonEntryPath: null,
    devDaemonEntryPath: null,
    manifest,
    sourceSpec: {
      kind: 'path',
      locator: exampleRoot,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: manifest.version,
      resolvedDigest: `sha256:${manifest.id}`,
    },
  };
}

describe('plugin SDK public installable examples', () => {
  it('normalizes through the CLI contribution registry projection', () => {
    const loadedPlugins = listInstallableExampleRoots().map(readLoadedExamplePlugin);
    expect(loadedPlugins.map((plugin) => plugin.pluginId).sort()).toEqual([
      'examples.descriptor-only',
      'examples.hosted-web',
      'examples.multi-mode-fallback',
      'examples.public-sdk-review-assistant',
      'examples.react-native-dev-hot-reload',
      'examples.react-native-installed',
    ]);

    const registry = buildPluginContributionRegistry({ loadedPlugins });
    const examplePluginIds = loadedPlugins.map((plugin) => plugin.pluginId).sort();

    expect([...new Set(registry.uiViewsV2.map((entry) => entry.pluginId))].sort()).toEqual(examplePluginIds);
    expect([...new Set(registry.uiRenderersV2.map((entry) => entry.pluginId))].sort()).toEqual(examplePluginIds);
    expect(registry.surfacePlacements).toEqual([]);
    expect(registry.hostedWeb).toEqual([]);
    expect(registry.reactNativeBundles).toEqual([]);
    expect(registry.uiArtifacts).toEqual([]);
  });
});
