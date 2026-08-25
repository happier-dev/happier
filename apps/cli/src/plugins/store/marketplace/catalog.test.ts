import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { createMarketplaceCatalogDocument, createMarketplaceCatalogEntry } from '@/plugins/testkit/marketplaceCatalog';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';

import { readRemoteMarketplaceCatalog } from './catalog';

async function createArchivedSamplePluginFixture(rootName = `sample-plugin-${randomUUID()}`): Promise<Readonly<{
  pluginSourceRoot: string;
  pluginRoot: string;
  archivePath: string;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-'));
  const archiveRoot = join(pluginSourceRoot, 'package');
  await materializeSamplePluginFixture(archiveRoot);
  await writeFile(join(archiveRoot, 'package.json'), JSON.stringify({
    name: '@acme/sample-plugin',
    version: '1.0.0',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
  }), 'utf8');
  const archivePath = join(pluginSourceRoot, `${rootName}.tar.gz`);
  await tar.c({
    gzip: true,
    file: archivePath,
    cwd: pluginSourceRoot,
    portable: true,
  }, ['package']);
  return {
    pluginSourceRoot,
    pluginRoot: archiveRoot,
    archivePath,
  } as const;
}

describe('readRemoteMarketplaceCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects stale manifest-shaped marketplace entries that do not match the protocol descriptor contract', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          t: 'happier_plugin_marketplace_catalog_v1',
          schemaVersion: 1,
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          description: 'Stale marketplace schema',
          entries: [
            {
              schemaVersion: 1,
              id: SAMPLE_PLUGIN_ID,
              version: '1.0.0',
              displayName: 'Acme Sample',
              description: 'Legacy manifest-shaped marketplace entry',
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
    }
  });

  it('loads a curated marketplace document, caches it, and preserves descriptor summaries', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const { pluginSourceRoot, pluginRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveBytes = await readFile(archivePath);
    const manifestRaw = await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8');
    const manifestDigest = `sha256:${createHash('sha256').update(manifestRaw).digest('hex')}`;

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          description: 'Curated plugin discovery feed',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              description: 'Sample plugin from the marketplace',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
              categories: ['providers'],
            }),
          ],
        })));
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

  it('fails closed when a remote marketplace catalog exceeds the configured body size limit', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'PATH',
      'HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES',
    ]);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES: '32',
    });
    reloadConfiguration();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        const payload = JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
            }),
          ],
        }));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        });
        res.end(payload);
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

    try {
      const result = await readRemoteMarketplaceCatalog({
        sourceUrl: `http://127.0.0.1:${address.port}/catalog.json`,
        happyHomeDir: home,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/size limit/i),
        }),
      ]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('uses the shared remote fetch timeout policy for marketplace catalog reads', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'PATH',
      'HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS',
    ]);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS: '250',
    });
    reloadConfiguration();

    // The server accepts the connection and never answers, so only the shared
    // remote-fetch timeout can end the catalog read.
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind marketplace test server');
    }

    try {
      const result = await readRemoteMarketplaceCatalog({
        sourceUrl: `http://127.0.0.1:${address.port}/catalog.json`,
        happyHomeDir: home,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('timed out after 250ms'),
        }),
      ]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('parses a protocol marketplace archive without granting trust locally', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1048576',
    });
    reloadConfiguration();

    const { pluginSourceRoot, pluginRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveBytes = await readFile(archivePath);
    const manifestRaw = await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8');
    const manifestDigest = `sha256:${createHash('sha256').update(manifestRaw).digest('hex')}`;

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
              id: 'marketplace.acme.sample',
              manifestId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              version: '1.0.0',
              description: 'Sample plugin from the protocol-backed marketplace schema',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: './plugins/acme.sample.tar.gz',
              digest: manifestDigest,
              categories: ['providers'],
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
    const expectedArchiveUrl = `http://127.0.0.1:${address.port}/plugins/acme.sample.tar.gz`;

    try {
      const catalogResult = await readRemoteMarketplaceCatalog({
        sourceUrl: catalogUrl,
        happyHomeDir: home,
      });

      expect(catalogResult.ok).toBe(true);
      if (!catalogResult.ok) return;
      expect(catalogResult.catalog.entries[0]).toMatchObject({
        pluginId: SAMPLE_PLUGIN_ID,
        title: 'Acme Sample',
        description: 'Sample plugin from the protocol-backed marketplace schema',
        version: '1.0.0',
        manifest: null,
        manifestDigest,
        source: {
          kind: 'archive',
          locator: expectedArchiveUrl,
          trustPolicy: 'prompt',
          installPolicy: 'managed_install',
        },
        installable: true,
        diagnostics: [],
      });

    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('resolves relative archive locators during catalog parsing', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1048576',
    });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveBytes = await readFile(archivePath);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              description: 'Sample plugin resolved from relative archive locator',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: './plugins/acme.sample.tar.gz',
            }),
          ],
        })));
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
    const expectedArchiveUrl = `http://127.0.0.1:${address.port}/plugins/acme.sample.tar.gz`;

    try {
      const catalogResult = await readRemoteMarketplaceCatalog({
        sourceUrl: catalogUrl,
        happyHomeDir: home,
      });

      expect(catalogResult.ok).toBe(true);
      if (!catalogResult.ok) return;
      expect(catalogResult.catalog.entries[0]).toMatchObject({
        pluginId: SAMPLE_PLUGIN_ID,
        installable: true,
        source: {
          kind: 'archive',
          locator: expectedArchiveUrl,
          trustPolicy: 'prompt',
        },
      });

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
        res.end(JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              description: 'Attempts to install from a local path via a remote catalog',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
            }),
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample Duplicate',
              version: '2.0.0',
              sourceUrl: `${url.origin}/entries/acme.sample-duplicate.json`,
              packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
            }),
          ],
        })));
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
        res.end(JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              description: 'Sample plugin with unsupported path package locator',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: pluginSourceRoot,
            }),
          ],
        })));
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
      expect(catalogResult.catalog.entries[0]?.diagnostics).toEqual(
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

  it('marks unsupported archive locator schemes as non-installable with a clean diagnostic', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: 'ftp://example.test/plugins/acme.sample.tar.gz',
            }),
          ],
        })));
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
      expect(catalogResult.catalog.entries[0]?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_kind_unsupported',
            message: expect.stringMatching(/unsupported.*locator/i),
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('fails closed when a relative archive locator attempts to switch origins via a network-path reference', async () => {
    const home = await createTempDir('happier-plugin-marketplace-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(createMarketplaceCatalogDocument({
          sourceUrl: `${url.origin}/catalog.json`,
          title: 'Curated Marketplace',
          entries: [
            createMarketplaceCatalogEntry({
              pluginId: SAMPLE_PLUGIN_ID,
              title: 'Acme Sample',
              description: 'Sample plugin with a network-path archive locator',
              sourceUrl: `${url.origin}/entries/acme.sample.json`,
              packageUrl: '//evil.example/plugins/acme.sample.tar.gz',
            }),
          ],
        })));
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
      expect(catalogResult.catalog.entries[0]?.diagnostics).toEqual(
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
    }
  });
});
