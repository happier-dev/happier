import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from './paths';
import { withPluginStoreLock } from './lock';

const roots: string[] = [];

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const startedAtMs = Date.now();
  while (!(await stat(path).then(() => true, () => false))) {
    if (Date.now() - startedAtMs >= timeoutMs) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  const result = await new Promise<Readonly<{ code: number | null; stderr: string }>>((resolvePromise) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code) => resolvePromise({ code, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(`Plugin-store lock child exited ${result.code}: ${result.stderr}`);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('withPluginStoreLock', () => {
  it('treats EPERM from the process liveness probe as alive and never enters', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-eperm-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'eperm-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    const livePid = 999_991;
    // Provenance: the plugin-store writer before exact-owner consolidation.
    const ownerRaw = JSON.stringify({ pid: livePid, createdAtMs: 1 });
    await mkdir(paths.locksDir, { recursive: true });
    await writeFile(lockPath, ownerRaw, 'utf8');
    await utimes(lockPath, new Date(1_000), new Date(1_000));

    const actualKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === livePid && signal === 0) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return actualKill(pid, signal);
    }) as typeof process.kill);
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_TIMEOUT_MS', '60');
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '1');
    const effect = vi.fn(async () => 'must-not-run');

    await expect(withPluginStoreLock({ paths, lockName, fn: effect }))
      .rejects.toThrow(`Timeout acquiring plugin store lock '${lockName}' after 60ms`);
    expect(effect).not.toHaveBeenCalled();
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(ownerRaw);
  });

  it('re-reads the same legacy owner identity before takeover and preserves a successor', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-legacy-race-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'legacy-successor-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    const stalePid = 999_992;
    const staleRaw = JSON.stringify({ pid: stalePid, createdAtMs: 1 });
    const successorRaw = JSON.stringify({ pid: process.pid, createdAtMs: Date.now() });
    await mkdir(paths.locksDir, { recursive: true });
    await writeFile(lockPath, staleRaw, 'utf8');
    await utimes(lockPath, new Date(1_000), new Date(1_000));

    const actualKill = process.kill.bind(process);
    let substituted = false;
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === stalePid && signal === 0) {
        unlinkSync(lockPath);
        writeFileSync(lockPath, successorRaw, { encoding: 'utf8', flag: 'wx' });
        substituted = true;
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return actualKill(pid, signal);
    }) as typeof process.kill);
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_TIMEOUT_MS', '75');
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '1');
    const effect = vi.fn(async () => 'must-not-run');

    await expect(withPluginStoreLock({ paths, lockName, fn: effect }))
      .rejects.toThrow(`Timeout acquiring plugin store lock '${lockName}' after 75ms`);
    expect(substituted).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(successorRaw);
  });

  it('takes over an exact dead legacy owner', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-legacy-dead-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'legacy-dead-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    const stalePid = 999_993;
    await mkdir(paths.locksDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: stalePid, createdAtMs: 1 }), 'utf8');

    const actualKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === stalePid && signal === 0) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return actualKill(pid, signal);
    }) as typeof process.kill);

    await expect(withPluginStoreLock({ paths, lockName, fn: async () => 'reclaimed' }))
      .resolves.toBe('reclaimed');
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still reclaims a canonical dead owner when unknown-record staleness is bounded past the timeout', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-canonical-dead-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'canonical-dead-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    const stalePid = 999_994;
    await mkdir(paths.locksDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: stalePid,
      ownerToken: 'canonical-dead-owner',
      processStartedAtMs: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    }), 'utf8');

    const actualKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === stalePid && signal === 0) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return actualKill(pid, signal);
    }) as typeof process.kill);
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_TIMEOUT_MS', '1000');
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '1');

    await expect(withPluginStoreLock({ paths, lockName, fn: async () => 'reclaimed' }))
      .resolves.toBe('reclaimed');
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases only its exact owner record and preserves a successor', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-successor-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'successor-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    const successorRaw = JSON.stringify({
      pid: process.pid,
      ownerToken: 'successor-owner-token',
      processStartedAtMs: Math.trunc(Date.now() - process.uptime() * 1_000),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });

    await expect(withPluginStoreLock({
      paths,
      lockName,
      fn: async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
        expect(owner).toEqual(expect.objectContaining({
          pid: process.pid,
          ownerToken: expect.any(String),
          processStartedAtMs: expect.any(Number),
        }));
        await unlink(lockPath);
        await writeFile(lockPath, successorRaw, { encoding: 'utf8', flag: 'wx' });
        return 'completed';
      },
    })).resolves.toBe('completed');

    await expect(readFile(lockPath, 'utf8')).resolves.toBe(successorRaw);
  });

  it('excludes a real second process until that exact owner releases', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-process-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'second-process-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    const readyPath = join(happyHomeDir, 'child-ready');
    const releasePath = join(happyHomeDir, 'child-release');
    const wrapperUrl = pathToFileURL(resolve(process.cwd(), 'src/utils/fs/jsonOwnerFileLock.ts')).href;
    const source = `
import { stat, writeFile } from 'node:fs/promises';
const { withJsonOwnerFileLock } = await import(${JSON.stringify(wrapperUrl)});
await withJsonOwnerFileLock({
  lockPath: process.env.HAPPIER_TEST_LOCK_PATH,
  timeoutMs: 5000,
  staleAfterMs: 60000,
  errorCode: 'child_plugin_store_lock_timeout',
  pollIntervalMs: 5,
}, async () => {
  await writeFile(process.env.HAPPIER_TEST_READY_PATH, 'ready', 'utf8');
  while (!(await stat(process.env.HAPPIER_TEST_RELEASE_PATH).then(() => true, () => false))) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
});
`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
      env: {
        ...process.env,
        HAPPIER_TEST_LOCK_PATH: lockPath,
        HAPPIER_TEST_READY_PATH: readyPath,
        HAPPIER_TEST_RELEASE_PATH: releasePath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    try {
      await waitForFile(readyPath);
      vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_TIMEOUT_MS', '75');
      vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '60000');
      const effect = vi.fn(async () => 'must-not-run');
      await expect(withPluginStoreLock({ paths, lockName, fn: effect }))
        .rejects.toThrow(`Timeout acquiring plugin store lock '${lockName}' after 75ms`);
      expect(effect).not.toHaveBeenCalled();

      await writeFile(releasePath, 'release', 'utf8');
      await waitForChild(child);
      await expect(withPluginStoreLock({ paths, lockName, fn: async () => 'acquired' }))
        .resolves.toBe('acquired');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
