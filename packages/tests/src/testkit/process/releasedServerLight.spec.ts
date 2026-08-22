import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  RELEASED_SERVER_V0_2_1_COMMIT,
  RELEASED_SERVER_V0_2_1_VERSION,
  prepareReleasedServerV021Artifact,
  resolveReleasedServerV021ArtifactPrerequisite,
  startReleasedServerLight,
  verifyReleasedServerArtifactProvenance,
  type ReleasedServerArtifactManifest,
} from './releasedServerLight';
import { spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';

const archiveName = 'happier-server-v0.2.1-darwin-arm64.tar.gz';
const archiveSha256 = 'b9f72dd17606e955cb2c66acc3f729561617ed46db34d4cf78b433f990c1870c';

function manifest(overrides: Record<string, unknown> = {}): ReleasedServerArtifactManifest {
  return {
    schemaVersion: 'v1',
    product: 'happier-server',
    channel: 'preview',
    version: RELEASED_SERVER_V0_2_1_VERSION,
    publishedAt: '2026-04-15T00:00:00.000Z',
    records: [{
      schemaVersion: 'v1',
      product: 'happier-server',
      channel: 'preview',
      version: RELEASED_SERVER_V0_2_1_VERSION,
      os: 'darwin',
      arch: 'arm64',
      url: `https://example.test/${archiveName}`,
      sha256: archiveSha256,
      build: { commitSha: RELEASED_SERVER_V0_2_1_COMMIT, workflowRunId: '123' },
      ...overrides,
    }],
  };
}

function fakeSpawnedProcess(stop = vi.fn(async () => {})): SpawnedProcess {
  const child = new EventEmitter() as SpawnedProcess['child'];
  Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  return {
    child,
    stdoutPath: '/tmp/released-server.stdout.log',
    stderrPath: '/tmp/released-server.stderr.log',
    stop,
  };
}

async function createReleasedPayload(payloadRoot: string): Promise<void> {
  await mkdir(join(payloadRoot, 'generated', 'sqlite-client'), { recursive: true });
  await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20260401000000_initial'), { recursive: true });
  await mkdir(join(payloadRoot, 'node_modules'), { recursive: true });
  await writeFile(join(payloadRoot, 'happier-server'), '#!/bin/sh\n', 'utf8');
  await writeFile(
    join(payloadRoot, 'generated', 'sqlite-client', 'libquery_engine-darwin-arm64.dylib.node'),
    'engine',
    'utf8',
  );
  await writeFile(
    join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20260401000000_initial', 'migration.sql'),
    'CREATE TABLE Example(id TEXT);\n',
    'utf8',
  );
}

describe('released server-light artifact lifecycle', () => {
  it('fails an explicitly configured exact-release gate when its immutable artifact is absent', () => {
    expect(() => resolveReleasedServerV021ArtifactPrerequisite({
      defaultArtifactDir: '/unused/default',
      env: { HAPPIER_E2E_RELEASED_SERVER_V0_2_1_DIR: '/configured/v0.2.1' },
      platform: 'darwin',
      arch: 'arm64',
      fileExists: () => false,
    })).toThrow(/artifact prerequisite is missing/i);
  });

  it('reports an honest skip reason when the optional default immutable artifact is absent', () => {
    expect(resolveReleasedServerV021ArtifactPrerequisite({
      defaultArtifactDir: '/default/v0.2.1',
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      fileExists: () => false,
    })).toEqual({
      status: 'skipped',
      reason: expect.stringMatching(/artifact prerequisite is missing/i),
    });
  });

  it('resolves the pinned paths and checksum only when both immutable artifact files exist', () => {
    expect(resolveReleasedServerV021ArtifactPrerequisite({
      defaultArtifactDir: '/default/v0.2.1',
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      fileExists: () => true,
    })).toEqual({
      status: 'ready',
      archivePath: resolve('/default/v0.2.1/happier-server-v0.2.1-darwin-arm64.tar.gz'),
      manifestPath: resolve('/default/v0.2.1/darwin-arm64.json'),
      expectedArchiveSha256: archiveSha256,
    });
  });

  it('resolves the registered Ubuntu linux-x64 artifact with its pinned immutable checksum', () => {
    expect(resolveReleasedServerV021ArtifactPrerequisite({
      defaultArtifactDir: '/ci/v0.2.1',
      env: {},
      platform: 'linux',
      arch: 'x64',
      fileExists: () => true,
    })).toEqual({
      status: 'ready',
      archivePath: resolve('/ci/v0.2.1/happier-server-v0.2.1-linux-x64.tar.gz'),
      manifestPath: resolve('/ci/v0.2.1/linux-x64.json'),
      expectedArchiveSha256: 'fe43480d40ab10e53a2743d5f87649b13421ef080a4c304f0dae9b26d4fd666f',
    });
  });

  it('downloads and provenance-verifies the pinned Ubuntu artifact for the required CI gate', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'released-server-v0.2.1-linux-x64-'));
    const linuxArchiveName = 'happier-server-v0.2.1-linux-x64.tar.gz';
    const linuxArchiveSha256 = 'fe43480d40ab10e53a2743d5f87649b13421ef080a4c304f0dae9b26d4fd666f';
    const downloads: string[] = [];
    try {
      const prepared = await prepareReleasedServerV021Artifact({
        artifactDir,
        platform: 'linux',
        arch: 'x64',
        __deps: {
          downloadFile: async (url, destinationPath) => {
            downloads.push(url);
            if (url.endsWith('/linux-x64.json')) {
              await writeFile(destinationPath, JSON.stringify({
                schemaVersion: 'v1',
                product: 'happier-server',
                channel: 'preview',
                version: RELEASED_SERVER_V0_2_1_VERSION,
                os: 'linux',
                arch: 'x64',
                url: `https://github.com/happier-dev/happier/releases/download/server-preview/${linuxArchiveName}`,
                sha256: linuxArchiveSha256,
                build: { commitSha: RELEASED_SERVER_V0_2_1_COMMIT, workflowRunId: null },
              }), 'utf8');
              return;
            }
            await writeFile(destinationPath, 'pinned linux archive fixture', 'utf8');
          },
          sha256File: async () => linuxArchiveSha256,
        },
      });

      expect(downloads).toEqual([
        'https://github.com/happier-dev/happier/releases/download/server-preview/linux-x64.json',
        `https://github.com/happier-dev/happier/releases/download/server-preview/${linuxArchiveName}`,
      ]);
      expect(prepared).toEqual({
        status: 'ready',
        archivePath: resolve(artifactDir, linuxArchiveName),
        manifestPath: resolve(artifactDir, 'linux-x64.json'),
        expectedArchiveSha256: linuxArchiveSha256,
      });
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['version', manifest({ version: '0.2.2' })],
    ['commit', manifest({ build: { commitSha: '0000000000000000000000000000000000000000' } })],
    ['manifest checksum', manifest({ sha256: '1'.repeat(64) })],
  ])('rejects a %s provenance mismatch', (_label, artifactManifest) => {
    expect(() => verifyReleasedServerArtifactProvenance({
      manifest: artifactManifest,
      archiveName,
      archiveSha256,
      callerExpectedArchiveSha256: archiveSha256,
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
    })).toThrow(/released server artifact provenance mismatch/i);
  });

  it('rejects an archive checksum that differs from the caller-supplied checksum', () => {
    expect(() => verifyReleasedServerArtifactProvenance({
      manifest: manifest(),
      archiveName,
      archiveSha256: '2'.repeat(64),
      callerExpectedArchiveSha256: archiveSha256,
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
    })).toThrow(/caller checksum/i);
  });

  it('accepts the official per-platform v1 manifest shape', () => {
    const latestManifest = manifest();
    const platformManifest = latestManifest.records?.[0] as ReleasedServerArtifactManifest;
    expect(verifyReleasedServerArtifactProvenance({
      manifest: platformManifest,
      archiveName,
      archiveSha256,
      callerExpectedArchiveSha256: archiveSha256,
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
    })).toBe(platformManifest);
  });

  it('extracts beneath testDir and launches the exact payload binary with disposable SQLite, files, auth, migrations, and engine paths', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'released-server-light-plan-'));
    const archivePath = join(testDir, archiveName);
    const manifestPath = join(testDir, 'latest.json');
    await writeFile(archivePath, 'immutable archive fixture', 'utf8');
    await writeFile(manifestPath, JSON.stringify(manifest()), 'utf8');

    let spawnParams: Parameters<typeof spawnLoggedProcess>[0] | undefined;
    const proc = fakeSpawnedProcess();
    const started = await startReleasedServerLight({
      testDir,
      archivePath,
      manifestPath,
      expectedArchiveSha256: archiveSha256,
      platform: 'darwin',
      arch: 'arm64',
      __deps: {
        sha256File: async () => archiveSha256,
        extractReleasePayloadRootFromArchive: async ({ extractDir }) => {
          const payloadRoot = join(extractDir, archiveName.replace(/\.tar\.gz$/u, ''));
          await createReleasedPayload(payloadRoot);
          return payloadRoot;
        },
        reserveAvailablePort: async () => 43123,
        spawnLoggedProcess: (params) => {
          spawnParams = params;
          return proc;
        },
        waitForOkHealth: async () => {},
      },
    });

    expect(spawnParams).toBeDefined();
    expect(spawnParams?.command).toBe(resolve(started.runtimeRoot, 'happier-server'));
    expect(spawnParams?.args).toEqual([]);
    expect(spawnParams?.cwd).toBe(started.runtimeRoot);
    expect(spawnParams?.env).toMatchObject({
      PORT: '43123',
      PUBLIC_URL: 'http://127.0.0.1:43123',
      HAPPIER_DB_PROVIDER: 'sqlite',
      HAPPY_DB_PROVIDER: 'sqlite',
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: resolve(started.runtimeRoot, 'prisma/sqlite/migrations'),
      PRISMA_QUERY_ENGINE_LIBRARY: resolve(
        started.runtimeRoot,
        'generated/sqlite-client/libquery_engine-darwin-arm64.dylib.node',
      ),
      DATABASE_URL: `file:${resolve(testDir, 'released-server-v0.2.1-data/happier-server-light.sqlite')}`,
      HAPPIER_SERVER_LIGHT_FILES_DIR: resolve(testDir, 'released-server-v0.2.1-data/files'),
      HOME: resolve(testDir, 'released-server-v0.2.1-auth/home'),
    });
    expect(resolve(started.runtimeRoot).startsWith(`${resolve(testDir)}/`)).toBe(true);
    expect(basename(spawnParams?.command ?? '')).toBe('happier-server');

    await started.stop();
    expect(proc.stop).toHaveBeenCalledTimes(1);
    expect(existsSync(started.runtimeExtractDir)).toBe(false);
  });

  it('stops the spawned process and removes the extraction root when health startup fails', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'released-server-light-failed-start-'));
    const archivePath = join(testDir, archiveName);
    const manifestPath = join(testDir, 'latest.json');
    await writeFile(archivePath, 'immutable archive fixture', 'utf8');
    await writeFile(manifestPath, JSON.stringify(manifest()), 'utf8');
    const stop = vi.fn(async () => {});
    const proc = fakeSpawnedProcess(stop);

    await expect(startReleasedServerLight({
      testDir,
      archivePath,
      manifestPath,
      expectedArchiveSha256: archiveSha256,
      platform: 'darwin',
      arch: 'arm64',
      __deps: {
        sha256File: async () => archiveSha256,
        extractReleasePayloadRootFromArchive: async ({ extractDir }) => {
          const payloadRoot = join(extractDir, archiveName.replace(/\.tar\.gz$/u, ''));
          await createReleasedPayload(payloadRoot);
          return payloadRoot;
        },
        reserveAvailablePort: async () => 43124,
        spawnLoggedProcess: () => proc,
        waitForOkHealth: async () => {
          throw new Error('health failed');
        },
      },
    })).rejects.toThrow('health failed');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(existsSync(resolve(testDir, 'released-server-v0.2.1-runtime'))).toBe(false);
  });
});
