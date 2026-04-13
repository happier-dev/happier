import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/extensions/plugins/testkit/samplePluginFixture';

import { installMarketplacePlugin, readRemoteMarketplaceCatalog } from './marketplaceCatalog';

async function createArchivedSamplePluginFixture(rootName = `sample-plugin-${randomUUID()}`): Promise<Readonly<{
  pluginSourceRoot: string;
  archivePath: string;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-'));
  const archiveRoot = join(pluginSourceRoot, rootName);
  await materializeSamplePluginFixture(archiveRoot);
  const archivePath = join(pluginSourceRoot, `${rootName}.tar.gz`);
  await tar.c({
    gzip: true,
    file: archivePath,
    cwd: pluginSourceRoot,
    portable: true,
  }, [rootName]);
  return {
    pluginSourceRoot,
    archivePath,
  } as const;
}

describe('readRemoteMarketplaceCatalog', () => {
  it('loads a curated marketplace document, caches it, and preserves descriptor summaries', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveBytes = await readFile(archivePath);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          t: 'happier_plugin_marketplace_catalog_v1',
          schemaVersion: 1,
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          description: 'Curated plugin discovery feed',
          entries: [
            {
              schemaVersion: 1,
              id: SAMPLE_PLUGIN_ID,
              version: '1.0.0',
              displayName: 'Acme Sample',
              description: 'Sample plugin from the marketplace',
              engines: {
                happier: '^0.2.0',
              },
              targets: {
                daemon: {
                  entry: './daemon.mjs',
                },
              },
              contributions: {
                providers: [
                  {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    display: {
                      name: 'Acme Sample Provider',
                    },
                    ownedBackendIds: ['acme.sample.backend'],
                  },
                ],
                backends: [
                  {
                    kindVersion: 1,
                    id: 'acme.sample.backend',
                    providerId: 'acme.sample.provider',
                    runtimeKind: 'acp',
                    capabilities: {},
                    runtimeAdapters: [],
                  },
                ],
                hooks: [
                  {
                    hookApiVersion: 1,
                    id: 'backend.terminalRuntime.bindTranscript',
                    category: 'integration',
                    scope: 'backend',
                    handler: {
                      target: 'plugin',
                      exportName: 'bindTranscript',
                    },
                  },
                ],
              },
              source: {
                kind: 'archive',
                locator: `${url.origin}/plugins/acme.sample.tar.gz`,
                trustPolicy: 'prompt',
                installPolicy: 'managed_install',
              },
            },
          ],
        }));
        return;
      }

      if (url.pathname === '/plugins/acme.sample.tar.gz') {
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(archiveBytes);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind marketplace test server');
    }
    const catalogUrl = `http://127.0.0.1:${address.port}/catalog.json`;

    try {
      const first = await readRemoteMarketplaceCatalog({
        sourceUrl: catalogUrl,
        happyHomeDir: home,
        cacheMaxAgeMs: 60_000,
      });

      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.catalog.title).toBe('Curated Marketplace');
      expect(first.catalog.entries).toHaveLength(1);
      expect(first.catalog.entries[0]).toMatchObject({
        pluginId: SAMPLE_PLUGIN_ID,
        title: 'Acme Sample',
        source: {
          kind: 'archive',
        },
        installable: true,
      });
      expect(first.cache.fromCache).toBe(false);

      await new Promise<void>((resolve) => server.close(() => resolve()));

      const second = await readRemoteMarketplaceCatalog({
        sourceUrl: catalogUrl,
        happyHomeDir: home,
        cacheMaxAgeMs: 60_000,
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.catalog.entries[0]?.pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(second.cache.fromCache).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects duplicate plugin ids in the curated marketplace document', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveBytes = await readFile(archivePath);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          t: 'happier_plugin_marketplace_catalog_v1',
          schemaVersion: 1,
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            {
              schemaVersion: 1,
              id: SAMPLE_PLUGIN_ID,
              version: '1.0.0',
              displayName: 'Acme Sample',
              description: 'Attempts to install from a local path via a remote catalog',
              engines: {
                happier: '^0.2.0',
              },
              targets: {
                daemon: {
                  entry: './daemon.mjs',
                },
              },
              contributions: {
                providers: [],
                backends: [],
                hooks: [],
              },
              source: {
                kind: 'archive',
                locator: `${url.origin}/plugins/acme.sample.tar.gz`,
                trustPolicy: 'prompt',
                installPolicy: 'managed_install',
              },
            },
            {
              schemaVersion: 1,
              id: SAMPLE_PLUGIN_ID,
              version: '2.0.0',
              displayName: 'Acme Sample Duplicate',
              engines: {
                happier: '^0.2.0',
              },
              targets: {
                daemon: {
                  entry: './daemon.mjs',
                },
              },
              contributions: {
                providers: [],
                backends: [],
                hooks: [],
              },
              source: {
                kind: 'archive',
                locator: `${url.origin}/plugins/acme.sample.tar.gz`,
                trustPolicy: 'prompt',
                installPolicy: 'managed_install',
              },
            },
          ],
        }));
        return;
      }

      if (url.pathname === '/plugins/acme.sample.tar.gz') {
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(archiveBytes);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind marketplace test server');
    }
    const catalogUrl = `http://127.0.0.1:${address.port}/catalog.json`;

    try {
      const result = await readRemoteMarketplaceCatalog({
        sourceUrl: catalogUrl,
        happyHomeDir: home,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_manifest_semantic_invalid',
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects remote marketplace entries that try to install from a local path source', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-marketplace-path-source-'));
    await materializeSamplePluginFixture(pluginSourceRoot);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          t: 'happier_plugin_marketplace_catalog_v1',
          schemaVersion: 1,
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            {
              schemaVersion: 1,
              id: SAMPLE_PLUGIN_ID,
              version: '1.0.0',
              displayName: 'Acme Sample',
              engines: {
                happier: '^0.2.0',
              },
              targets: {
                daemon: {
                  entry: './daemon.mjs',
                },
              },
              contributions: {
                providers: [],
                backends: [],
                hooks: [],
              },
              source: {
                kind: 'path',
                locator: pluginSourceRoot,
                trustPolicy: 'prompt',
                installPolicy: 'link',
              },
            },
          ],
        }));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind marketplace test server');
    }
    const catalogUrl = `http://127.0.0.1:${address.port}/catalog.json`;

    try {
      const catalogResult = await readRemoteMarketplaceCatalog({
        sourceUrl: catalogUrl,
        happyHomeDir: home,
      });

      expect(catalogResult.ok).toBe(true);
      if (!catalogResult.ok) return;
      expect(catalogResult.catalog.entries[0]).toMatchObject({
        pluginId: SAMPLE_PLUGIN_ID,
        installable: false,
      });

      const installResult = await installMarketplacePlugin({
        sourceUrl: catalogUrl,
        pluginId: SAMPLE_PLUGIN_ID,
        happyHomeDir: home,
        skipIfInstalled: true,
      });

      expect(installResult.ok).toBe(false);
      if (installResult.ok) return;
      expect(installResult.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_kind_unsupported',
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });
});
