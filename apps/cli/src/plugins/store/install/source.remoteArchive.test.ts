import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { inspectPluginSource } from './source';

async function createArchivedSamplePluginFixture(rootName = `sample-plugin-${randomUUID()}`): Promise<Readonly<{
  pluginSourceRoot: string;
  archivePath: string;
  archiveBytes: Buffer;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
  const archiveRoot = join(pluginSourceRoot, 'package');
  await materializeSamplePluginFixture(archiveRoot);
  await writeFile(join(archiveRoot, 'package.json'), JSON.stringify({
    name: '@acme/sample-plugin',
    version: '1.0.0',
    keywords: ['happier-plugin'],
    files: ['.happier-plugin', 'daemon.mjs', 'agentRuntime.mjs'],
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
    archivePath,
    archiveBytes: await readFile(archivePath),
  } as const;
}

async function createLegacyReleaseArchiveFixture(): Promise<Readonly<{
  pluginSourceRoot: string;
  archivePath: string;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-legacy-release-source-'));
  await materializeSamplePluginFixture(join(pluginSourceRoot, 'package'));
  const archivePath = join(pluginSourceRoot, `sample-plugin-${randomUUID()}.tar.gz`);
  await tar.c({
    gzip: true,
    file: archivePath,
    cwd: pluginSourceRoot,
    portable: true,
  }, ['package']);
  return { pluginSourceRoot, archivePath };
}

/**
 * Remote archive acquisition now owns its own destination-assessed, DNS-pinned
 * connection, so the boundary a test can substitute is a real HTTP server, not
 * an ambient `fetch`. A loopback origin is the caller's own network intent, the
 * one case the acquisition policy admits as private.
 */
const servers: Server[] = [];

async function startArchiveServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function stopArchiveServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await stopArchiveServers();
});

describe('inspectPluginSource remote archive downloads', () => {
  it('rejects legacy release archives that do not satisfy the canonical npm plugin package contract', async () => {
    const home = await createTempDir('happier-plugin-legacy-release-rejection-');
    const { pluginSourceRoot, archivePath } = await createLegacyReleaseArchiveFixture();

    try {
      await expect(inspectPluginSource({
        happyHomeDir: home,
        locator: archivePath,
        sourceKind: 'archive',
      })).resolves.toEqual({
        ok: false,
        errorCode: 'plugin_install_failed',
        errorMessage: 'Archive plugin candidate rejected (package_json_missing): Candidate is missing required file: "package.json"',
      });
      const cacheEntries = await readdir(createPluginRegistryStateStore({ happyHomeDir: home }).paths.cacheDir);
      expect(cacheEntries.filter((entry) => entry.startsWith('.candidate-') || entry.startsWith('plugin-archive-preview-'))).toEqual([]);
    } finally {
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('infers local .tgz archives as installable plugin archives', async () => {
    const home = await createTempDir('happier-plugin-local-tgz-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
    });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();
    const tgzPath = archivePath.replace(/\.tar\.gz$/i, '.tgz');
    await cp(archivePath, tgzPath);

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: tgzPath,
      });

      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      if (!result.ok) return;
      expect(result.pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(result.sourceKind).toBe('archive');
      expect(result.source.trustPolicy).toBe('prompt');
      expect((await createPluginRegistryStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('streams remote archive downloads to disk without relying on arrayBuffer', async () => {
    const home = await createTempDir('happier-plugin-remote-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1048576',
    });
    reloadConfiguration();

    const { pluginSourceRoot, archiveBytes } = await createArchivedSamplePluginFixture();
    const observedRequests: Readonly<{ url: string; accept: string | undefined }>[] = [];
    const port = await startArchiveServer((request, response) => {
      observedRequests.push({ url: request.url ?? '', accept: request.headers.accept });
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(archiveBytes.byteLength),
      });
      response.end(archiveBytes);
    });
    const archiveUrl = `http://127.0.0.1:${port}/plugins/acme.sample.tar.gz`;

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: archiveUrl,
        sourceKind: 'archive',
        sourceSpecOverride: {
          kind: 'archive',
          locator: 'https://example.test/plugins/substituted-provenance.tar.gz',
          trustPolicy: 'local_trusted',
          installPolicy: 'managed_install',
        },
      });

      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      if (!result.ok) return;
      expect(result.pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(result.installedPath).toBeNull();
      expect(result.manifestPath).toContain('.happier-plugin/plugin.json');
      expect(observedRequests).toEqual([
        { url: '/plugins/acme.sample.tar.gz', accept: 'application/octet-stream' },
      ]);

      expect(result.source).toMatchObject({
        kind: 'archive',
        locator: archiveUrl,
        trustPolicy: 'prompt',
      });
      const store = createPluginRegistryStateStore({ happyHomeDir: home });
      expect((await store.read()).plugins).toEqual({});
      const cacheEntries = await readdir(store.paths.cacheDir);
      expect(cacheEntries.filter((entry) => entry.startsWith('plugin-download-'))).toHaveLength(0);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('uses the shared remote fetch timeout policy for archive downloads', async () => {
    const home = await createTempDir('happier-plugin-remote-install-');
    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'PATH',
      'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES',
      'HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS',
    ]);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1048576',
      HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS: '250',
    });
    reloadConfiguration();

    const { pluginSourceRoot } = await createArchivedSamplePluginFixture();
    // The server accepts the connection and never answers, so only the shared
    // remote-fetch timeout can end the acquisition.
    const port = await startArchiveServer(() => undefined);
    const archiveUrl = `http://127.0.0.1:${port}/plugins/acme.sample.tar.gz`;

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: archiveUrl,
        sourceKind: 'archive',
        sourceSpecOverride: {
          kind: 'archive',
          locator: archiveUrl,
          trustPolicy: 'local_trusted',
          installPolicy: 'managed_install',
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorMessage).toContain('timed out after 250ms');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('preserves a local archive symlink locator as provenance instead of dereferencing it', async () => {
    const home = await createTempDir('happier-plugin-archive-symlink-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1048576',
    });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveSymlinkPath = join(pluginSourceRoot, `sample-plugin-${randomUUID()}.symlink.tar.gz`);
    await symlink(archivePath, archiveSymlinkPath);

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: archiveSymlinkPath,
        sourceKind: 'archive',
      });

      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      if (!result.ok) return;
      expect(result.pluginId).toBe(SAMPLE_PLUGIN_ID);

      expect(result.source).toMatchObject({ kind: 'archive', locator: archiveSymlinkPath });
      expect((await createPluginRegistryStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a remote archive exceeds the configured size limit and cleans up staging', async () => {
    const home = await createTempDir('happier-plugin-remote-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1',
    });
    reloadConfiguration();

    const { pluginSourceRoot, archiveBytes } = await createArchivedSamplePluginFixture();
    let requestCount = 0;
    const port = await startArchiveServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(archiveBytes.byteLength),
      });
      response.end(archiveBytes);
    });
    const archiveUrl = `http://127.0.0.1:${port}/plugins/acme.sample.tar.gz`;

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: archiveUrl,
        sourceKind: 'archive',
        skipIfInstalled: true,
      });

      expect(requestCount).toBe(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorCode).toBe('plugin_install_failed');
      expect(result.errorMessage).toContain('exceeds the configured size limit');

      const store = createPluginRegistryStateStore({ happyHomeDir: home });
      const cacheEntries = await readdir(store.paths.cacheDir);
      expect(cacheEntries.filter((entry) => entry.startsWith('plugin-download-'))).toHaveLength(0);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when an archive payload contains symbolic links', async () => {
    const home = await createTempDir('happier-plugin-remote-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES']);
    envScope.patch({
      HAPPIER_HOME_DIR: home,
      PATH: process.env.PATH ?? '',
      HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: '1048576',
    });
    reloadConfiguration();

    const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    const rootName = `sample-plugin-${randomUUID()}`;
    const archiveRoot = join(pluginSourceRoot, rootName);
    const outsidePath = join(pluginSourceRoot, 'outside-secret.txt');
    const archivePath = join(pluginSourceRoot, `${rootName}.tar.gz`);
    await materializeSamplePluginFixture(archiveRoot);
    await writeFile(outsidePath, 'secret', 'utf8');
    await symlink(outsidePath, join(archiveRoot, 'escape.txt'));
    await tar.c({
      gzip: true,
      file: archivePath,
      cwd: pluginSourceRoot,
      portable: true,
    }, [rootName]);

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: archivePath,
        sourceKind: 'archive',
        skipIfInstalled: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorCode).toBe('plugin_install_failed');

      const store = createPluginRegistryStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });
});
