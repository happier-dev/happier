import { describe, expect, it, vi } from 'vitest';

const installedBoundary = vi.hoisted(() => ({
  readInstalledPluginCatalog: vi.fn(async () => []),
  readInstalledPluginCatalogSnapshot: vi.fn(async () => ({ revision: -1, entries: [] })),
}));

vi.mock('@/plugins/projection/catalog/installed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/catalog/installed')>();
  return {
    ...actual,
    readInstalledPluginCatalog: installedBoundary.readInstalledPluginCatalog,
    readInstalledPluginCatalogSnapshot: installedBoundary.readInstalledPluginCatalogSnapshot,
  };
});

vi.mock('@/plugins/projection/registry/sources/generatedBundledPluginManifests', () => ({
  BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: Object.freeze([]),
}));

import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectPluginCatalogEntryIntrospection } from '@/plugins/projection/introspection/catalogEntry';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

function buildManagedProviderCatalogEntry() {
  const manifest = normalizePluginManifestV2({
    schemaVersion: 2,
    id: 'acme.vertical-a',
    version: '1.0.0',
    displayName: 'Vertical A',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/plugin.js' },
    contributes: {
      providers: [{
        v: 1,
        id: 'packed-managed-provider',
        name: 'Packed managed provider',
        kind: 'aggregator',
        endpointTemplates: [{
          id: 'packed-openai-responses',
          protocol: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          capabilities: {
            streaming: 'supported', toolRoundTrips: 'supported',
            statefulResponses: 'unknown', reasoningControls: 'supported',
          },
        }],
        catalog: {
          source: 'static',
          manualModelPolicy: 'allowed',
          staticModels: [{
            id: 'packed-model',
            name: 'Packed model',
            capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' },
          }],
        },
        managedRuntime: { kind: 'managed', endpointTemplateIds: ['packed-openai-responses'] },
      }],
    },
  });
  const source = {
    kind: 'path', locator: '/plugins/acme.vertical-a', trustPolicy: 'local_trusted',
    installPolicy: 'link', resolvedPath: '/plugins/acme.vertical-a',
    manifestPath: '/plugins/acme.vertical-a/plugin.json',
  } as const;
  const entry = {
    pluginId: 'acme.vertical-a', title: 'Vertical A', description: null, version: '1.0.0',
    enabled: true, desiredGeneration: 'generation-1', appliedGeneration: null, admittedIntegrity: null,
    source,
    install: { mode: 'link', manifestVersion: '1.0.0' },
    compatibility: { status: 'compatible', diagnostics: [] },
    manifestPath: '/plugins/acme.vertical-a/plugin.json', manifest,
    diagnostics: [],
    contributionIntrospection: projectPluginCatalogEntryIntrospection({
      pluginId: 'acme.vertical-a', pluginVersion: '1.0.0', source, manifest,
      generation: 0, host: 'cli', platform: 'darwin', occurredAtMs: 1, diagnostics: [],
    }),
  } satisfies PluginCatalogEntry;
  return { entry, contributes: manifest.contributes as unknown as Readonly<Record<string, unknown>> };
}

describe('readCurrentDaemonPluginCatalogSnapshot', () => {
  it('projects the whole catalog when an installed plugin declares a registration-required managed provider', async () => {
    const { entry, contributes } = buildManagedProviderCatalogEntry();
    // The daemon derives its activation facts from the catalog's registration
    // rights, so the read side must agree with that exact producer rather than
    // a hand-written ref.
    const registrationRefs = derivePluginDaemonContributionRegistrationRights(contributes)
      .map(({ family, localId }) => ({ family, localId }));
    expect(registrationRefs).toEqual([{ family: 'providers', localId: 'packed-managed-provider' }]);
    installedBoundary.readInstalledPluginCatalog.mockResolvedValueOnce([entry] as never);
    installedBoundary.readInstalledPluginCatalogSnapshot.mockResolvedValueOnce({
      revision: 4,
      entries: [entry],
    } as never);
    const reloadController = {
      tryAcquireRuntimeRegistry: () => ({
        registry: {
          contributes: { tools: [], actionsById: new Map() },
          generation: 4,
          targetActivationFacts: [{
            pluginId: 'acme.vertical-a', pluginVersion: '1.0.0', source: 'localPath',
            generation: '4', host: 'daemon', platform: 'darwin', occurredAtMs: 10,
            status: 'active',
            required: registrationRefs,
            bound: registrationRefs,
            diagnostics: [],
          }],
        },
        source: 'active',
        durableRevision: 4,
        release: async () => {},
      }),
    } as unknown as PluginReloadController;

    const snapshot = await readCurrentDaemonPluginCatalogSnapshot({ reloadController });

    expect(snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(['acme.vertical-a']);
    expect(snapshot.plugins[0]?.contributionIntrospection.contributions).toEqual([
      expect.objectContaining({
        contribution: expect.objectContaining({
          family: 'providers',
          kind: 'delegatedDomain',
          domainId: 'packed-managed-provider',
          qualifiedId: 'acme.vertical-a/providers/packed-managed-provider',
        }),
        registration: { requirement: 'required', state: 'bound', generation: '4' },
        activation: { state: 'active', generation: '4' },
      }),
    ]);
  });


  it('fails tool projection closed when no current runtime lease is available', async () => {
    const reloadController = {
      tryAcquireRuntimeRegistry: () => null,
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({
      reloadController,
      happyHomeDir: '/test/home',
    })).resolves.toEqual({
      plugins: [],
      tools: [],
    });
  });

  it('releases the exact runtime lease after projecting the catalog', async () => {
    const release = vi.fn(async () => {});
    const registry = {
      contributes: {
        tools: [],
        actionsById: new Map(),
      },
    };
    const reloadController = {
      tryAcquireRuntimeRegistry: () => ({
        registry,
        source: 'active',
        durableRevision: -1,
        release,
      }),
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({
      reloadController,
    })).resolves.toEqual({
      plugins: [],
      tools: [],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('binds each daemon-published tool to the exact contributor generation in its runtime lease', async () => {
    const release = vi.fn(async () => {});
    const reloadController = {
      tryAcquireRuntimeRegistry: () => ({
        registry: {
          contributes: {
            immutableGenerationIdsByPluginId: {
              'acme.review.plugin': 'generation-g',
            },
            tools: [{
              provenance: 'external',
              pluginId: 'acme.review.plugin',
              definition: {
                id: 'review-tool',
                actionId: 'acme.review.plugin/review-start',
                name: 'acme_review_start',
                title: 'Acme Review Start',
                description: 'Start an Acme review.',
                inputSchema: { type: 'object', additionalProperties: false },
                surfaces: ['agent', 'mcp', 'cli'],
              },
            }],
            actionsById: new Map([[
              'acme.review.plugin/review-start',
              {
                provenance: 'external',
                pluginId: 'acme.review.plugin',
                definition: { id: 'review-start' },
              },
            ]]),
          },
          targetActionInvocations: {
            evaluateCatalogPolicy: () => ({ outcome: 'visible' as const }),
          },
        },
        source: 'active',
        durableRevision: -1,
        release,
      }),
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({ reloadController })).resolves.toMatchObject({
      tools: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/review-start',
        expectedContributorImmutableGenerationId: 'generation-g',
      }],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains an attributed diagnostic from a runtime lease that matches the durable catalog revision', async () => {
    const { entry } = buildManagedProviderCatalogEntry();
    const currentDiagnostic = {
      code: 'point_absent',
      message: 'Targeted contribution admission rejected (point_absent).',
      stage: 'normalization',
      contribution: { pluginId: entry.pluginId, localId: 'provider-a' },
      details: {
        targetPluginId: 'acme.target',
        pointId: 'providers',
        protocol: { id: 'provider', version: 1 },
      },
    } as const;
    const currentRelease = vi.fn(async () => {});
    const reloadController = {
      tryAcquireRuntimeRegistry: () => ({
        registry: {
          contributes: { tools: [], actionsById: new Map() },
          pluginDiagnosticsByPluginId: { [entry.pluginId]: [currentDiagnostic] },
        },
        source: 'active',
        durableRevision: 8,
        release: currentRelease,
      }),
    } as unknown as PluginReloadController;
    installedBoundary.readInstalledPluginCatalog.mockResolvedValueOnce([entry] as never);
    installedBoundary.readInstalledPluginCatalogSnapshot.mockResolvedValueOnce({
      revision: 8,
      entries: [entry],
    } as never);

    await expect(readCurrentDaemonPluginCatalogSnapshot({ reloadController })).resolves.toMatchObject({
      plugins: [expect.objectContaining({
        pluginId: entry.pluginId,
        contributionIntrospection: expect.objectContaining({
          diagnostics: [expect.objectContaining({
            data: expect.objectContaining({ code: 'point_absent' }),
          })],
        }),
      })],
      tools: [],
    });
    expect(currentRelease).toHaveBeenCalledOnce();
  });

  it('fails the runtime projection closed when a newer catalog cannot be paired with a current lease', async () => {
    const staleRelease = vi.fn(async () => {});
    const staleRegistry = {
      contributes: {
        immutableGenerationIdsByPluginId: { 'happier.channels': 'generation-6' },
        tools: [{
          provenance: 'external',
          pluginId: 'happier.channels',
          definition: {
            id: 'channel-tool',
            actionId: 'happier.channels/channel-a',
            name: 'happier_channel_a',
            title: 'Happier Channel A',
            description: 'Run a stale channel action.',
            inputSchema: { type: 'object', additionalProperties: false },
            surfaces: ['agent', 'mcp', 'cli'],
          },
        }],
        actionsById: new Map([[
          'happier.channels/channel-a',
          {
            provenance: 'external',
            pluginId: 'happier.channels',
            definition: { id: 'channel-a' },
          },
        ]]),
      },
      targetActionInvocations: {
        evaluateCatalogPolicy: () => ({ outcome: 'visible' as const }),
      },
      pluginDiagnosticsByPluginId: {
        'happier.channels': [{
          code: 'point_absent',
          message: 'Targeted contribution admission rejected (point_absent).',
          stage: 'normalization',
          contribution: { pluginId: 'happier.channels', localId: 'channel-a' },
        }],
      },
    };
    const tryAcquireRuntimeRegistry = vi.fn(() => ({
      registry: staleRegistry,
      source: 'active' as const,
      durableRevision: 6,
      release: staleRelease,
    }));
    const reloadController = {
      tryAcquireRuntimeRegistry,
    } as unknown as PluginReloadController;
    installedBoundary.readInstalledPluginCatalog.mockResolvedValueOnce([] as never);
    installedBoundary.readInstalledPluginCatalogSnapshot.mockResolvedValueOnce({
      revision: 7,
      entries: [],
    } as never);

    await expect(readCurrentDaemonPluginCatalogSnapshot({ reloadController })).resolves.toEqual({
      plugins: [],
      tools: [],
    });
    expect(tryAcquireRuntimeRegistry).toHaveBeenCalledOnce();
    expect(staleRelease).toHaveBeenCalledOnce();
  });
});
