import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/extensions/plugins/testkit/samplePluginFixture';
import { createPluginStateStore } from '../store/pluginStateStore';
import { loadInstalledPlugins } from '../loader/loadInstalledPlugins';
import { installPluginFromSource } from './installPluginFromSource';

async function createArchivedSamplePluginFixture(rootName = `sample-plugin-${randomUUID()}`): Promise<Readonly<{
  pluginSourceRoot: string;
  archivePath: string;
  archiveBytes: Buffer;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
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
    archiveBytes: await readFile(archivePath),
  } as const;
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

describe('installPluginFromSource remote archive downloads', () => {
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
      const result = await installPluginFromSource({
        happyHomeDir: home,
        locator: archiveUrl,
        sourceKind: 'archive',
        skipIfInstalled: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(result.manifestPath).toBe(join(result.installedPath ?? '', '.happier-plugin', 'plugin.json'));
      expect(fetchMock).toHaveBeenCalledWith(
        archiveUrl,
        expect.objectContaining({
          headers: {
            accept: 'application/octet-stream',
          },
        }),
      );
      expect(response.arrayBuffer).not.toHaveBeenCalled();

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toMatchObject({
        source: {
          kind: 'archive',
          locator: archiveUrl,
        },
        install: {
          mode: 'managed_install',
        },
      });

      const loaded = await loadInstalledPlugins({ happyHomeDir: home });
      expect(loaded.loadedPlugins.map((plugin) => plugin.manifest.id)).toEqual([SAMPLE_PLUGIN_ID]);
      expect(loaded.loadedPlugins[0]).toMatchObject({
        sourceSpec: {
          kind: 'archive',
          locator: archiveUrl,
          installPolicy: 'managed_install',
        },
      });

      const cacheEntries = await readdir(store.paths.cacheDir);
      expect(cacheEntries.filter((entry) => entry.startsWith('plugin-download-'))).toHaveLength(0);
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
      const result = await installPluginFromSource({
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

      const store = createPluginStateStore({ happyHomeDir: home });
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
      const result = await installPluginFromSource({
        happyHomeDir: home,
        locator: archivePath,
        sourceKind: 'archive',
        skipIfInstalled: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorCode).toBe('plugin_install_failed');
      expect(result.errorMessage).toContain('symbolic link');

      const store = createPluginStateStore({ happyHomeDir: home });
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
