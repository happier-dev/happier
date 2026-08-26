import { describe, expect, it, vi } from 'vitest';

const installedBoundary = vi.hoisted(() => ({
  readInstalledPluginCatalogSnapshot: vi.fn(async () => ({ revision: 8, entries: [] })),
}));

vi.mock('@/plugins/projection/catalog/installed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/catalog/installed')>();
  return {
    ...actual,
    readInstalledPluginCatalogSnapshot: installedBoundary.readInstalledPluginCatalogSnapshot,
  };
});

vi.mock('@/plugins/projection/registry/sources/generatedBundledPluginManifests', () => ({
  BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: Object.freeze([Object.freeze({
    pluginId: 'happier.channels',
    manifest: {
      schemaVersion: 2,
      id: 'happier.channels',
      version: '0.0.0',
      displayName: 'Channels',
      engines: { happier: '^0.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    manifestPath: 'bundled:happier.channels',
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: '/bundled/happier.channels',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: '0.0.0',
    }),
  })]),
}));

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

function runtimeLease() {
  return {
    registry: {
      contributes: { tools: [], actionsById: new Map() },
      pluginDiagnosticsByPluginId: {
        'happier.channels': [{
          code: 'target_semantics_unavailable',
          message: 'Targeted contribution admission rejected (target_semantics_unavailable).',
          stage: 'normalization',
          contribution: { pluginId: 'happier.channels', localId: 'providers' },
          details: {
            targetPluginId: 'happier.channels',
            pointId: 'providers',
            protocol: { id: 'happier.channels/providers', version: 1 },
          },
        }],
      },
      pluginFinalPolicyCurrentGenerationsById: new Map([['happier.channels', {
        immutableGenerationId: 'bundled-generation',
        desiredImmutableGenerationId: 'bundled-generation',
        appliedImmutableGenerationId: 'bundled-generation',
        distribution: { kind: 'bundled' },
        applied: true,
        selectedAccess: [],
      }]]),
    },
    source: 'active' as const,
    durableRevision: 8,
    release: vi.fn(async () => {}),
  };
}

describe('current daemon bundled plugin catalog', () => {
  it('retains an attributable bundled diagnostic in the one current catalog', async () => {
    const lease = runtimeLease();
    const reloadController = {
      tryAcquireRuntimeRegistry: () => lease,
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({ reloadController })).resolves.toMatchObject({
      plugins: [{
        pluginId: 'happier.channels',
        desiredGeneration: 'bundled-generation',
        appliedGeneration: 'bundled-generation',
        source: { kind: 'bundled' },
        contributionIntrospection: {
          diagnostics: [expect.objectContaining({
            data: expect.objectContaining({
              code: 'target_semantics_unavailable',
              details: {
                targetPluginId: 'happier.channels',
                pointId: 'providers',
                protocol: { id: 'happier.channels/providers', version: 1 },
              },
            }),
            plugin: { id: 'happier.channels', version: '0.0.0', source: 'bundled' },
          })],
        },
      }],
      tools: [],
    });
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it('keeps an installed local happier-prefixed plugin external instead of adding its bundled twin', async () => {
    const externalEntry = {
      pluginId: 'happier.channels',
      desiredGeneration: 'external-generation',
      appliedGeneration: null,
      admittedIntegrity: null,
      title: 'Local Channels',
      description: null,
      version: '0.0.0-dev',
      enabled: true,
      source: {
        kind: 'path',
        locator: '/plugins/happier.channels',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: '/plugins/happier.channels',
        manifestPath: '/plugins/happier.channels/plugin.json',
      },
      install: { mode: 'link', manifestVersion: '0.0.0-dev' },
      compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/happier.channels/plugin.json',
      manifest: null,
      contributionIntrospection: { version: 1, generation: 0, diagnostics: [], contributions: [] },
      diagnostics: [],
    } satisfies PluginCatalogEntry;
    installedBoundary.readInstalledPluginCatalogSnapshot.mockResolvedValueOnce({
      revision: 9,
      entries: [externalEntry],
    } as never);
    const reloadController = {
      tryAcquireRuntimeRegistry: () => null,
    } as unknown as PluginReloadController;

    const snapshot = await readCurrentDaemonPluginCatalogSnapshot({ reloadController });

    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins[0]).toMatchObject({
      pluginId: 'happier.channels',
      source: { kind: 'path' },
    });
  });
});
