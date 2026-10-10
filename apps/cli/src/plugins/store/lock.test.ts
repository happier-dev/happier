import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function expectQueuedLockCancellation(params: Parameters<typeof withPluginStoreLock>[0]): Promise<void> {
  const abort = new AbortController();
  const operation = withPluginStoreLock({ ...params, signal: abort.signal });
  const assertion = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
  abort.abort();
  await assertion;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('withPluginStoreLock', () => {
  it('recovers exact dead quarantine ownership without using unknown-record age', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-quarantine-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'dead-quarantine.lock';
    const lockPath = join(paths.locksDir, lockName);
    const deadPid = 999_997;
    const artifactPath = `${lockPath}.reclaim-${deadPid}-1-00000000-0000-4000-8000-000000000001`;
    await mkdir(paths.locksDir, { recursive: true });
    await writeFile(artifactPath, JSON.stringify({ pid: deadPid, ownerToken: 'dead-owner',
      processStartedAtMs: 1, createdAtMs: 1, updatedAtMs: 1 }));
    const abort = new AbortController();
    let deadOwnerProbes = 0;
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid && signal === 0) {
        // A repeated recovery pass proves the first exact-death observation
        // failed to reclaim. End the test's own queued occurrence deterministically.
        if (++deadOwnerProbes > 2) abort.abort();
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return actualKill(pid, signal);
    }) as typeof process.kill);
    await expect(withPluginStoreLock({ paths, lockName, signal: abort.signal, fn: async () => 'recovered' })).resolves.toBe('recovered');
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('waits beyond the former cutoff until a live predecessor owner releases', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-slow-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'slow-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    await mkdir(paths.locksDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: 1 }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let settled = false;
    const operation = withPluginStoreLock({ paths, lockName, fn: async () => 'acquired' });
    const observed = operation.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const result = Promise.allSettled([observed]);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    vi.setSystemTime(10_001);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    expect(settled).toBe(false);
    await unlink(lockPath);
    expect(await result).toEqual([{ status: 'fulfilled', value: 'acquired' }]);
  });

  it('cancels queued lock admission and preserves an old unknown record rather than stealing it by age', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-store-lock-unknown-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const lockName = 'unknown-owner.lock';
    const lockPath = join(paths.locksDir, lockName);
    await mkdir(paths.locksDir, { recursive: true });
    const raw = JSON.stringify({ unsupportedOwner: 'live' });
    await writeFile(lockPath, raw);
    await utimes(lockPath, new Date(1_000), new Date(1_000));
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '1');
    vi.useFakeTimers({ toFake: ['Date'] });
    const abort = new AbortController();
    const reason = new Error('operation cancelled');
    const effect = vi.fn(async () => 'must-not-run');
    const operation = withPluginStoreLock({ paths, lockName, signal: abort.signal, fn: effect });
    const assertion = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    vi.setSystemTime(Date.now() + 10_001);
    abort.abort(reason);
    await assertion;
    expect(effect).not.toHaveBeenCalled();
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(raw);
  });
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
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '1');
    const effect = vi.fn(async () => 'must-not-run');

    await expectQueuedLockCancellation({ paths, lockName, fn: effect });
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
    vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '1');
    const effect = vi.fn(async () => 'must-not-run');

    await expectQueuedLockCancellation({ paths, lockName, fn: effect });
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

  it('still reclaims a canonical dead owner without using unknown-record age', async () => {
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
    const wrapperUrl = new URL('../../utils/fs/jsonOwnerFileLock.ts', import.meta.url).href;
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
    const settlement = waitForChild(child);

    try {
      await Promise.race([
        waitForFile(readyPath),
        settlement.then(() => { throw new Error('Lock owner exited before publishing readiness'); }),
      ]);
      vi.stubEnv('HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS', '60000');
      const effect = vi.fn(async () => 'must-not-run');
      await expectQueuedLockCancellation({ paths, lockName, fn: effect });
      expect(effect).not.toHaveBeenCalled();

      await writeFile(releasePath, 'release', 'utf8');
      await settlement;
      await expect(withPluginStoreLock({ paths, lockName, fn: async () => 'acquired' }))
        .resolves.toBe('acquired');
    } finally {
      child.kill('SIGKILL');
      await settlement.catch(() => undefined);
    }
  });
});
