import { describe, expect, it, vi } from 'vitest';

import { createMarketplaceIndex } from './index';
import { createMarketplaceSourceRegistryStore } from './sources/store';
import { requestExactMarketplaceInstall } from './exactInstall';
import type { MarketplaceIndexSourceConfig } from './service';
import { SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function createSnapshot(params: Readonly<{
  source: MarketplaceIndexSourceConfig;
  freshnessState?: 'fresh' | 'stale';
  registryProfileId?: string;
}>) {
  const fetchedAtMs = Date.now();
  return {
    source: { id: params.source.id, title: params.source.title, kind: 'curated' as const, sourceUrl: params.source.sourceUrl },
    freshness: {
      state: params.freshnessState ?? 'fresh',
      fetchedAtMs,
      ...(params.freshnessState === 'stale' ? { staleSinceMs: fetchedAtMs } : {}),
    },
    entries: [{
      pluginId: SAMPLE_PLUGIN_ID,
      publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Acme Sample', description: 'Reviewed curated plugin' },
      distribution: {
        kind: 'npm' as const,
        registryOrigin: 'https://registry.npmjs.org',
        packageName: '@acme/sample',
        version: '1.0.0',
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
        ...(params.registryProfileId ? { registryProfileId: params.registryProfileId } : {}),
      },
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      compatibility: { happier: '>=1.0.0', platforms: ['darwin' as const] },
      summary: { contributions: ['actions'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon' as const] },
      review: { status: 'approved' as const, reviewedAt: '2026-07-22T00:00:00.000Z' },
      categories: ['actions'],
      media: [],
      updatePolicy: 'curated-auto' as const,
      links: {},
    }],
    diagnostics: [],
  };
}

describe('requestExactMarketplaceInstall', () => {
  it('submits a community npm listing with exact version and SRI under manual policy', async () => {
    const home = await createTempDir('happier-community-marketplace-install-');
    const source = {
      id: 'marketplace:community-npm',
      title: 'Community npm',
      sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100',
      enabled: true,
      origin: 'community-npm' as const,
    };
    const snapshot = {
      ...createSnapshot({
        source: {
          ...source,
        },
      }),
      source: { id: source.id, title: source.title, kind: source.origin, sourceUrl: source.sourceUrl },
      entries: createSnapshot({
        source: {
          ...source,
        },
      }).entries.map((entry) => ({
        ...entry,
        review: { status: 'unreviewed' as const, reviewedAt: null },
        updatePolicy: 'manual' as const,
      })),
    };
    const requestChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: SAMPLE_PLUGIN_ID,
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));

    try {
      const result = await requestExactMarketplaceInstall({
        happyHomeDir: home,
        sourceId: source.id,
        pluginId: SAMPLE_PLUGIN_ID,
      }, {
        marketplaceIndexService: {
          querySources: async (raw) => createMarketplaceIndex({ revision: 1, sources: [snapshot], query: raw }),
        },
        requestChange,
      });

      expect(result).toMatchObject({ ok: true, change: { kind: 'committed' } });
      expect(requestChange).toHaveBeenCalledWith({
        request: expect.objectContaining({
          kind: 'installNpm',
          packageName: '@acme/sample',
          selector: '1.0.0',
          registryOrigin: 'https://registry.npmjs.org',
          expectedMarketplaceListing: expect.objectContaining({
            source: { id: source.id, kind: 'community-npm', sourceUrl: source.sourceUrl },
            integrity: snapshot.entries[0]!.distribution.integrity,
            review: { status: 'unreviewed', reviewedAt: null },
            updatePolicy: 'manual',
          }),
        }),
        approval: 'none',
      });
    } finally {
      await removeTempDir(home);
    }
  });

  it('re-reads a curated listing but submits it without caller-selected approval', async () => {
    const home = await createTempDir('happier-exact-marketplace-install-');
    const sourceUrl = 'https://marketplace.invalid/catalog.json';
    const envScope = createEnvKeyScope(['HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl });
    const requestChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-curated',
      review: createPluginInstallationReviewFixture({
        pluginId: SAMPLE_PLUGIN_ID,
        displayName: 'Sample plugin',
        packageIdentity: { name: '@acme/sample', version: '1.0.0' },
        source: { kind: 'npm', locator: '@acme/sample@1.0.0' },
        updateChannel: {
          kind: 'npm',
          packageName: '@acme/sample',
          registryOrigin: 'https://registry.npmjs.org',
        },
      }),
    }));

    try {
      const source = (await createMarketplaceSourceRegistryStore({ happyHomeDir: home }).read()).sources[0]!;
      const snapshot = createSnapshot({ source });
      const result = await requestExactMarketplaceInstall({
        happyHomeDir: home,
        sourceId: source.id,
        pluginId: SAMPLE_PLUGIN_ID,
      }, {
        marketplaceIndexService: {
          querySources: async (raw) => createMarketplaceIndex({ revision: 1, sources: [snapshot], query: raw }),
        },
        requestChange,
      });

      expect(result).toMatchObject({ ok: true, change: { kind: 'reviewRequired' } });
      expect(requestChange).toHaveBeenCalledWith({
        request: {
          kind: 'installNpm',
          packageName: '@acme/sample',
          selector: '1.0.0',
          registryOrigin: 'https://registry.npmjs.org',
          expectedMarketplaceListing: {
            source: { id: source.id, kind: 'curated', sourceUrl },
            pluginId: SAMPLE_PLUGIN_ID,
            publisher: { id: 'acme', displayName: 'Acme' },
            packageName: '@acme/sample',
            registryOrigin: 'https://registry.npmjs.org',
            version: '1.0.0',
            integrity: snapshot.entries[0]!.distribution.integrity,
            manifestDigest: snapshot.entries[0]!.manifestDigest,
            review: { status: 'approved', reviewedAt: '2026-07-22T00:00:00.000Z' },
            updatePolicy: 'automatic',
          },
        },
        approval: 'none',
      });
    } finally {
      envScope.restore();
      await removeTempDir(home);
    }
  });

  it('rejects stale canonical facts before contacting the daemon owner', async () => {
    const home = await createTempDir('happier-stale-marketplace-install-');
    const envScope = createEnvKeyScope(['HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.invalid/catalog.json' });
    const requestChange = vi.fn();

    try {
      const source = (await createMarketplaceSourceRegistryStore({ happyHomeDir: home }).read()).sources[0]!;
      const snapshot = createSnapshot({ source, freshnessState: 'stale' });
      await expect(requestExactMarketplaceInstall({
        happyHomeDir: home,
        sourceId: source.id,
        pluginId: SAMPLE_PLUGIN_ID,
      }, {
        marketplaceIndexService: {
          querySources: async (raw) => createMarketplaceIndex({ revision: 1, sources: [snapshot], query: raw }),
        },
        requestChange,
      })).resolves.toMatchObject({ ok: false, code: 'install_unavailable' });
      expect(requestChange).not.toHaveBeenCalled();
    } finally {
      envScope.restore();
      await removeTempDir(home);
    }
  });

  it('passes only the exact persisted private-profile binding to the daemon owner', async () => {
    const home = await createTempDir('happier-private-marketplace-install-');
    const sourceUrl = 'https://marketplace.invalid/catalog.json';
    const envScope = createEnvKeyScope(['HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl });
    const requestChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: SAMPLE_PLUGIN_ID,
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));

    try {
      const store = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
      const seeded = (await store.read()).sources[0]!;
      const source = await store.upsertSource({ sourceUrl, registryProfileId: 'registry_private' });
      const snapshot = createSnapshot({ source: { ...seeded, ...source }, registryProfileId: 'catalog-controlled' });
      const result = await requestExactMarketplaceInstall({
        happyHomeDir: home,
        sourceId: source.id,
        pluginId: SAMPLE_PLUGIN_ID,
      }, {
        marketplaceIndexService: {
          querySources: async (raw) => {
            const indexed = createMarketplaceIndex({ revision: 1, sources: [snapshot], query: raw });
            return {
              ...indexed,
              items: indexed.items.map((item) => ({
                ...item,
                artifactAccess: { state: 'available' as const, registryProfileId: 'registry_private' },
              })),
            };
          },
        },
        requestChange,
      });

      expect(result).toMatchObject({ ok: true });
      expect(requestChange).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({
          registryProfileId: 'registry_private',
          expectedMarketplaceListing: expect.objectContaining({ registryProfileId: 'registry_private' }),
        }),
      }));
      expect(JSON.stringify(requestChange.mock.calls)).not.toContain('catalog-controlled');
    } finally {
      envScope.restore();
      await removeTempDir(home);
    }
  });

  it('rejects an index item whose source URL no longer matches the persisted curated source', async () => {
    const home = await createTempDir('happier-mismatched-marketplace-source-');
    const envScope = createEnvKeyScope(['HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.invalid/catalog.json' });
    const requestChange = vi.fn();

    try {
      const source = (await createMarketplaceSourceRegistryStore({ happyHomeDir: home }).read()).sources[0]!;
      const snapshot = createSnapshot({
        source: { ...source, sourceUrl: 'https://replacement.invalid/catalog.json' },
      });
      await expect(requestExactMarketplaceInstall({
        happyHomeDir: home,
        sourceId: source.id,
        pluginId: SAMPLE_PLUGIN_ID,
      }, {
        marketplaceIndexService: {
          querySources: async (raw) => createMarketplaceIndex({ revision: 1, sources: [snapshot], query: raw }),
        },
        requestChange,
      })).resolves.toMatchObject({ ok: false, code: 'install_unavailable' });
      expect(requestChange).not.toHaveBeenCalled();
    } finally {
      envScope.restore();
      await removeTempDir(home);
    }
  });

  it('rejects when the persisted source binding changes while exact facts are loading', async () => {
    const home = await createTempDir('happier-rebound-marketplace-source-');
    const sourceUrl = 'https://marketplace.invalid/catalog.json';
    const envScope = createEnvKeyScope(['HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl });
    const requestChange = vi.fn();
    try {
      const store = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
      const source = await store.upsertSource({ sourceUrl, registryProfileId: 'registry_one' });
      const snapshot = createSnapshot({ source });
      const indexed = createMarketplaceIndex({ revision: 1, sources: [snapshot], query: { filters: {} } });
      await expect(requestExactMarketplaceInstall({
        happyHomeDir: home,
        sourceId: source.id,
        pluginId: SAMPLE_PLUGIN_ID,
      }, {
        marketplaceIndexService: {
          querySources: async () => {
            await store.upsertSource({ sourceUrl, registryProfileId: 'registry_two' });
            return {
              ...indexed,
              items: indexed.items.map((item) => ({
                ...item,
                artifactAccess: { state: 'available' as const, registryProfileId: 'registry_one' },
              })),
            };
          },
        },
        requestChange,
      })).resolves.toMatchObject({ ok: false, code: 'source_changed' });
      expect(requestChange).not.toHaveBeenCalled();
    } finally {
      envScope.restore();
      await removeTempDir(home);
    }
  });
});
