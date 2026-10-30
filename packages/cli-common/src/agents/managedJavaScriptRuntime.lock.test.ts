import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    // Both install-lock contenders belong to this fixture, independently of the worker's build admission.
    vi.stubEnv('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED', '1');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('cancels a waiting bootstrap without disturbing the current lock owner', async () => {
    const homeDir = await createHomeDir();
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' };
    const lockPath = join(managedJavaScriptRuntimeInstallDir(processEnv), '.lock', 'bootstrap.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    const owner = JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now(), token: 'other-bootstrap' });
    await writeFile(lockPath, owner);
    const controller = new AbortController();
    const reason = new Error('bootstrap canceled');
    const pending = ensureManagedJavaScriptRuntimeCommand(processEnv, {
      fetchNodeRuntimeReleaseAsset: async () => { throw new Error('unexpected acquisition'); },
    }, { signal: controller.signal });
    const settled = pending.then(() => 'resolved', (error: unknown) => error);
    controller.abort(reason);
    const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 250))]);
    const retainedOwner = await readFile(lockPath, 'utf8');
    await rm(lockPath, { force: true });
    await settled;
    expect(outcome).toBe(reason);
    expect(retainedOwner).toBe(owner);
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
    const expiredAtMs = Date.now() - 10 * 60 * 1000;
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      createdAtMs: expiredAtMs,
      updatedAtMs: expiredAtMs,
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
