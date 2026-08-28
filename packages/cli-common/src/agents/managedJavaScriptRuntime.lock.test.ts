import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeInstallDir,
} from './managedJavaScriptRuntime.js';

const tempDirs: string[] = [];

async function createHomeDir(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-managed-runtime-lock-'));
  tempDirs.push(homeDir);
  return homeDir;
}

function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createBootstrapDeps(params: Readonly<{
  extractionEntered?: () => void;
  extractionRelease?: Promise<void>;
}> = {}) {
  return {
    fetchNodeRuntimeReleaseAsset: async () => ({
      name: 'node-v25.8.0-linux-x64.tar.gz',
      url: 'https://nodejs.org/download/release/v25.8.0/node-runtime',
      digest: 'sha256:fixture',
      tag: 'v25.8.0',
      version: '25.8.0',
      binaryRelativePath: process.platform === 'win32' ? 'node.exe' : join('bin', 'node'),
    }),
    downloadGitHubReleaseAsset: async ({ destinationPath }: { destinationPath: string }) => {
      await writeFile(destinationPath, 'archive fixture', 'utf8');
    },
    extractGitHubReleaseAsset: async ({ outputPath }: { outputPath: string }) => {
      params.extractionEntered?.();
      await params.extractionRelease;
      const binaryPath = process.platform === 'win32'
        ? join(outputPath, 'node.exe')
        : join(outputPath, 'bin', 'node');
      await mkdir(dirname(binaryPath), { recursive: true });
      await writeFile(binaryPath, 'runtime fixture', 'utf8');
      if (process.platform !== 'win32') await chmod(binaryPath, 0o755);
    },
  };
}

describe('managed JavaScript runtime bootstrap lock', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('does not steal an aged lock from a bootstrap whose owner process is still active', async () => {
    const homeDir = await createHomeDir();
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' };
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const secondEntered = createDeferred();

    const first = ensureManagedJavaScriptRuntimeCommand(processEnv, createBootstrapDeps({
      extractionEntered: firstEntered.resolve,
      extractionRelease: releaseFirst.promise,
    }));
    await firstEntered.promise;

    const lockPath = join(managedJavaScriptRuntimeInstallDir(processEnv), '.lock', 'bootstrap.lock');
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, staleAt, staleAt);

    const second = ensureManagedJavaScriptRuntimeCommand(processEnv, createBootstrapDeps({
      extractionEntered: secondEntered.resolve,
    }));
    const secondBeforeRelease = await Promise.race([
      secondEntered.promise.then(() => 'entered' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 150)),
    ]);

    try {
      expect(secondBeforeRelease).toBe('waiting');
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }

    await expect(first).resolves.toBeTruthy();
    await expect(second).resolves.toBe(await first);
  });

  it('reclaims a lock whose owner process is gone', async () => {
    const homeDir = await createHomeDir();
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' };
    const lockPath = join(managedJavaScriptRuntimeInstallDir(processEnv), '.lock', 'bootstrap.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'dead-owner',
      processInstanceFingerprint: 'dead-owner-fingerprint',
    }), 'utf8');

    const runtimeCommand = await ensureManagedJavaScriptRuntimeCommand(
      processEnv,
      createBootstrapDeps(),
    );

    expect(runtimeCommand).toBeTruthy();
    await expect(access(runtimeCommand!)).resolves.toBeUndefined();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(managedJavaScriptRuntimeInstallDir(processEnv), 'current'))).resolves.toBeTruthy();
  });
});
