import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2, type ParsedPluginManifestV2 } from '@happier-dev/protocol';

import {
  loadInstalledPlugins,
  type LoadInstalledPluginsResult,
} from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { projectDaemonPluginVoiceModelPackCatalogV1 } from './pluginModelPackCatalog.js';

const pluginId = 'examples.public-sdk-review-assistant';
const pluginVersion = '0.1.0';
const modelOrigin = 'https://models.example.com';

const daemonHost = {
  executionHost: 'daemon' as const,
  hostVersion: '1.5.0',
  platform: 'darwin' as const,
  architecture: 'arm64' as const,
  runtimeFamilies: { sherpa_zipformer_streaming: { abiVersion: 1 } },
};

async function readPublicAuthoringManifest(): Promise<ParsedPluginManifestV2> {
  // This example is code-defined. Consume its canonical evaluated entrypoint;
  // a handwritten source manifest would create a second authority beside
  // `definePlugin(publicAuthoringDefinition)`.
  const publicAuthoringModule = await import(
    new URL('../../../../../packages/plugin-sdk/examples/public-authoring/index.ts', import.meta.url).href
  ) as Readonly<{ manifest: unknown }>;
  const ingested = ingestPluginManifestV2(publicAuthoringModule.manifest);
  expect(ingested.ok, ingested.ok ? undefined : JSON.stringify(ingested.diagnostics)).toBe(true);
  if (!ingested.ok) throw new Error('public_authoring_manifest_ingestion_failed');
  return ingested.manifest;
}

function projectLoadedPlugins(
  loadResult: LoadInstalledPluginsResult,
  grantedNetworkOrigins: readonly string[] = [modelOrigin],
) {
  const contributions = projectLoadedPluginContributes({
    loadResult,
    provenance: 'external',
  });
  const registry = createResolvedContributionRegistry(contributions);
  const projection = buildPluginProjectionV2({ registry, generation: 12 });
  const catalog = projectDaemonPluginVoiceModelPackCatalogV1({
    plugins: loadResult.loadedPlugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      pluginVersion: plugin.manifest.version,
      artifactBinding: {
        kind: 'materialization',
        immutableGenerationId: 'public-authoring-fixture-local-generation',
      },
      enabled: true,
      authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
      grantedNetworkOrigins,
      contributions: (registry.voiceModelPacks ?? [])
        .filter((entry) => entry.pluginId === plugin.pluginId)
        .map((entry) => entry.definition),
    })),
    host: daemonHost,
  });
  return { registry, projection, catalog };
}

async function installPublicAuthoringFixture(manifest: ParsedPluginManifestV2): Promise<Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  setEnabled(enabled: boolean): Promise<void>;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-authoring-home-'));
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-public-authoring-plugin-'));
  const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  const daemonEntrypoint = manifest.entrypoints?.daemon;
  if (!daemonEntrypoint) throw new Error('public_authoring_daemon_entrypoint_missing');
  const daemonEntrypointPath = join(pluginRoot, daemonEntrypoint);
  await mkdir(dirname(daemonEntrypointPath), { recursive: true });
  await writeFile(daemonEntrypointPath, 'export function activate() {}\n', 'utf8');
  const store = createPluginStateStore({ happyHomeDir });

  async function setEnabled(enabled: boolean): Promise<void> {
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'link',
            manifestVersion: pluginVersion,
            installedPath: null,
          },
          state: { enabled },
        },
      },
    });
  }

  await setEnabled(true);
  return { happyHomeDir, pluginRoot, setEnabled };
}

describe('public declarative voice model-pack authoring integration fixture', () => {
  it('flows cold-JSON settings and a model pack to the selected-daemon catalog without mixing executable Voice runtime state into the pack row', async () => {
    const manifest = await readPublicAuthoringManifest();
    const fixture = await installPublicAuthoringFixture(manifest);
    try {
      const enabledLoad = await loadInstalledPlugins({ happyHomeDir: fixture.happyHomeDir });
      const enabled = projectLoadedPlugins(enabledLoad);
      const ungranted = projectLoadedPlugins(enabledLoad, []);
      const qualifiedPackId = `${pluginId}/english-small`;
      const qualifiedSettingsId = `${pluginId}/preferences`;
      const qualifiedVoiceProviderId = `${pluginId}/credentialed-browser`;

      expect(manifest.contributes.settings).toEqual([
        expect.objectContaining({ id: 'preferences', scope: 'account' }),
      ]);
      expect(enabledLoad.loadedPlugins).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({
            contributes: expect.objectContaining({
              settings: [expect.objectContaining({ id: 'preferences', scope: 'account' })],
            }),
          }),
        }),
      ]);
      expect(enabled.registry.settings).toEqual([
        expect.objectContaining({ pluginId, definition: expect.objectContaining({ id: 'preferences' }) }),
      ]);
      expect(enabled.projection.settingsById).toHaveProperty(qualifiedSettingsId);
      expect(enabled.projection.familiesById.voiceModelPacks?.entriesById).toHaveProperty(qualifiedPackId);
      expect(enabled.catalog).toEqual([
        expect.objectContaining({
          status: 'available',
          installable: true,
          loadable: false,
          identity: { pluginId, packId: 'english-small' },
          sourceLabel: { pluginId, pluginVersion },
        }),
      ]);
      expect(ungranted.catalog).toEqual([
        expect.objectContaining({
          status: 'blocked',
          reason: 'network_origin_not_granted',
          installable: false,
          loadable: false,
        }),
      ]);

      expect(manifest.contributes.voiceProviders).toContainEqual(expect.objectContaining({
        id: 'credentialed-browser',
      }));
      expect(enabled.projection.familiesById.voiceProviders?.entriesById).toHaveProperty(
        qualifiedVoiceProviderId,
      );
      expect(enabled.catalog[0]).not.toHaveProperty('register');
      expect(enabled.catalog[0]).not.toHaveProperty('transport');
      expect(enabled.catalog[0]).not.toHaveProperty('parser');
      expect(enabled.catalog[0]).not.toHaveProperty('server');

      await fixture.setEnabled(false);
      const disabled = projectLoadedPlugins(await loadInstalledPlugins({ happyHomeDir: fixture.happyHomeDir }));

      expect(disabled.projection.settingsById).not.toHaveProperty(qualifiedSettingsId);
      expect(disabled.projection.familiesById.voiceModelPacks?.entriesById ?? {}).not.toHaveProperty(qualifiedPackId);
      expect(disabled.projection.familiesById.voiceProviders?.entriesById ?? {}).not.toHaveProperty(
        qualifiedVoiceProviderId,
      );
      expect(disabled.catalog).toEqual([]);
    } finally {
      await Promise.all([
        rm(fixture.happyHomeDir, { recursive: true, force: true }),
        rm(fixture.pluginRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
