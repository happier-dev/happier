import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

function createRemoteArchiveResponse(archiveBytes: Buffer, options?: Readonly<{
  arrayBufferThrows?: boolean;
  contentLength?: number;
}>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(archiveBytes));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-length': String(options?.contentLength ?? archiveBytes.byteLength),
    }),
    body,
    arrayBuffer: options?.arrayBufferThrows
      ? vi.fn(async () => {
          throw new Error('arrayBuffer should not be called');
        })
      : vi.fn(async () => archiveBytes.buffer.slice(archiveBytes.byteOffset, archiveBytes.byteOffset + archiveBytes.byteLength)),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
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
    const archiveUrl = 'https://example.test/plugins/acme.sample.tar.gz';
    const response = createRemoteArchiveResponse(archiveBytes, {
      arrayBufferThrows: true,
      contentLength: archiveBytes.byteLength,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

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
      expect(fetchMock).toHaveBeenCalledWith(
        archiveUrl,
        expect.objectContaining({
          headers: {
            accept: 'application/octet-stream',
          },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(response.arrayBuffer).not.toHaveBeenCalled();

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
      HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS: '12345',
    });
    reloadConfiguration();

    const { pluginSourceRoot, archiveBytes } = await createArchivedSamplePluginFixture();
    const archiveUrl = 'https://example.test/plugins/acme.sample.tar.gz';
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createRemoteArchiveResponse(archiveBytes));

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

      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      expect(timeoutSpy).toHaveBeenCalledWith(12345);
      expect(fetchMock).toHaveBeenCalledWith(
        archiveUrl,
        expect.objectContaining({
          signal: timeoutSignal,
        }),
      );
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
    const archiveUrl = 'https://example.test/plugins/acme.sample.tar.gz';
    const response = createRemoteArchiveResponse(archiveBytes, {
      contentLength: archiveBytes.byteLength,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    try {
      const result = await inspectPluginSource({
        happyHomeDir: home,
        locator: archiveUrl,
        sourceKind: 'archive',
        skipIfInstalled: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
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
