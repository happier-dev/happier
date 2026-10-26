import { spawn } from 'node:child_process';
import { link as linkMock, mkdir, mkdtemp, readFile, readdir, rename as renameMock, rm, rm as rmMock, rmdir as rmdirMock, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ownerPublicationBarrier = vi.hoisted(() => {
  let targetLockPath: string | null = null;
  let pausedPath: string | null = null;
  let enteredResolve: (() => void) | null = null;
  let releaseResolve: (() => void) | null = null;
  let entered = Promise.resolve();
  let release = Promise.resolve();

  return {
    arm(lockPath: string) {
      targetLockPath = lockPath;
      pausedPath = null;
      entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
    },
    shouldPause(path: string): boolean {
      return targetLockPath !== null
        && pausedPath === null
        && (path === targetLockPath || path.startsWith(`${targetLockPath}.owner-`));
    },
    async pause(path: string): Promise<void> {
      pausedPath = path;
      enteredResolve?.();
      await release;
    },
    waitUntilEntered: async () => await entered,
    getPausedPath(): string {
      if (pausedPath === null) throw new Error('Owner publication did not pause');
      return pausedPath;
    },
    release: () => releaseResolve?.(),
    reset() {
      targetLockPath = null;
      releaseResolve?.();
    },
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    rmdir: vi.fn(actual.rmdir),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      if (!ownerPublicationBarrier.shouldPause(path)) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') {
            return async (...writeArgs: Parameters<typeof target.writeFile>) => {
              await ownerPublicationBarrier.pause(path);
              return await target.writeFile(...writeArgs);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }),
  };
});

import {
  reclaimJsonOwnerFileLockSnapshot,
  withJsonOwnerFileLock,
} from './jsonOwnerFileLock';

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 100): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function spawnSuccessorGuard(lockPath: string, readyPath: string, releasePath: string): ReturnType<typeof spawn> {
  const source = `
import { unlink, writeFile, stat } from 'node:fs/promises';
const guardPath = process.env.HAPPIER_TEST_GUARD_PATH;
await unlink(guardPath);
await writeFile(guardPath, JSON.stringify({
  pid: process.pid,
  ownerToken: 'three-process-successor',
  processStartedAtMs: Math.trunc(Date.now() - process.uptime() * 1000),
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
}), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
await writeFile(process.env.HAPPIER_TEST_READY_PATH, 'ready', 'utf8');
while (!(await stat(process.env.HAPPIER_TEST_RELEASE_PATH).then(() => true, () => false))) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}
`;
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      HAPPIER_TEST_GUARD_PATH: `${lockPath}.reclaim`,
      HAPPIER_TEST_READY_PATH: readyPath,
      HAPPIER_TEST_RELEASE_PATH: releasePath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function spawnContender(lockPath: string, enteredPath: string): ReturnType<typeof spawn> {
  const modulePath = resolve(process.cwd(), 'src/utils/fs/jsonOwnerFileLock.ts');
  const source = `
import { writeFile } from 'node:fs/promises';
const { withJsonOwnerFileLock } = await import(${JSON.stringify(modulePath)});
await withJsonOwnerFileLock({
  lockPath: process.env.HAPPIER_TEST_LOCK_PATH,
  timeoutMs: 5000,
  staleAfterMs: 1,
  errorCode: 'child_contender_timeout',
  pollIntervalMs: 10,
}, async () => {
  await writeFile(process.env.HAPPIER_TEST_ENTERED_PATH, 'entered', 'utf8');
});
`;
  return spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    env: {
      ...process.env,
      HAPPIER_TEST_LOCK_PATH: lockPath,
      HAPPIER_TEST_ENTERED_PATH: enteredPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function killSpawnedChild(child: ReturnType<typeof spawn> | null): void {
  child?.kill('SIGKILL');
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`child exited ${child.exitCode}`);
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`child exited ${code}`)));
    child.once('error', reject);
  });
}

afterEach(() => {
  ownerPublicationBarrier.reset();
  vi.mocked(linkMock).mockClear();
  vi.mocked(renameMock).mockClear();
  vi.mocked(renameMock).mockImplementation(async (...args) => await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((actual) => actual.rename(...args)));
  vi.mocked(rmMock).mockClear();
  vi.mocked(rmMock).mockImplementation(async (...args) => await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((actual) => actual.rm(...args)));
  vi.mocked(rmdirMock).mockClear();
  vi.mocked(rmdirMock).mockImplementation(async (...args) => await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((actual) => actual.rmdir(...args)));
});

describe('withJsonOwnerFileLock', () => {
  it('reports the active owner once while waiting and leaves acquisition cancellable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-owner-lock-wait-'));
    const lockPath = join(root, 'owner.lock');
    const onWait = vi.fn();
    const controller = new AbortController();
    let releaseOwner = () => {};
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const owner = withJsonOwnerFileLock({
      lockPath, timeoutMs: Number.POSITIVE_INFINITY, staleAfterMs: 1_000,
      errorCode: 'lock_timeout', onWait,
    }, async () => { markEntered(); await released; });
    let contender: Promise<void> | undefined;
    try {
      await entered;
      expect(onWait).not.toHaveBeenCalled();
      const originalOwner = await readFile(lockPath, 'utf8');
      contender = withJsonOwnerFileLock({
        lockPath, timeoutMs: Number.POSITIVE_INFINITY, staleAfterMs: 1_000,
        errorCode: 'lock_timeout', pollIntervalMs: 2, signal: controller.signal, onWait,
      }, async () => { throw new Error('Contender acquired the active lock'); });
      await vi.waitFor(() => expect(onWait).toHaveBeenCalledOnce());
      expect(onWait).toHaveBeenCalledWith({
        pid: process.pid, heldForMs: expect.any(Number), waitedForMs: expect.any(Number),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onWait).toHaveBeenCalledOnce();
      const cancelled = expect(contender).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await cancelled;
      expect(await readFile(lockPath, 'utf8')).toBe(originalOwner);
    } finally {
      controller.abort();
      await contender?.catch(() => {});
      releaseOwner();
      await owner;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cancels lock acquisition without disturbing the active owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-owner-lock-cancel-'));
    const lockPath = join(root, 'owner.lock');
    let releaseOwner = () => {};
    let markEntered = () => {};
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const released = new Promise<void>(resolve => { releaseOwner = resolve; });
    const owner = withJsonOwnerFileLock({ lockPath, timeoutMs: 1_000, staleAfterMs: 1_000, errorCode: 'lock_timeout' }, async () => {
      markEntered();
      await released;
    });
    try {
      await entered;
      const originalOwner = await readFile(lockPath, 'utf8');
      const controller = new AbortController();
      controller.abort();
      await expect(withJsonOwnerFileLock({
        lockPath, timeoutMs: 100, staleAfterMs: 1_000, errorCode: 'lock_timeout', signal: controller.signal,
      }, async () => { throw new Error('Cancelled contender acquired the lock'); })).rejects.toMatchObject({ name: 'AbortError' });
      expect(await readFile(lockPath, 'utf8')).toBe(originalOwner);
    } finally {
      releaseOwner();
      await owner;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the exact Remote HEAD predecessor artifact and preserves live, fresh-dead, malformed, and missing owners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-predecessor-'));
    const acquiredAt = '1970-01-01T00:00:01.000Z';
    // Provenance: Remote HEAD 490a27a, connectedServiceStateSharingLock.ts:106-110.
    const livePredecessorRaw = `{"pid":${process.pid},"providerId":"claude","acquiredAt":"${acquiredAt}"}`;
    const cases = [
      { name: 'live', raw: livePredecessorRaw },
      { name: 'fresh-dead', raw: '{"pid":999999,"providerId":"claude","acquiredAt":"2999-01-01T00:00:00.000Z"}' },
      { name: 'malformed', raw: '{"pid":"ambiguous","providerId":"claude","acquiredAt":"1970-01-01T00:00:01.000Z"}' },
      { name: 'missing', raw: null },
    ] as const;
    try {
      for (const entry of cases) {
        const lockPath = join(dir, `${entry.name}.lock`);
        await mkdir(lockPath);
        if (entry.raw !== null) await writeFile(join(lockPath, 'owner.json'), entry.raw, 'utf8');
        const startedAtMs = Date.now();
        await expect(withJsonOwnerFileLock({
          lockPath,
          timeoutMs: 500,
          staleAfterMs: 1,
          errorCode: `predecessor_${entry.name}_timeout`,
          pollIntervalMs: 2,
        }, async () => 'must-not-run')).rejects.toThrow(`predecessor_${entry.name}_timeout`);
        expect(Date.now() - startedAtMs).toBeLessThan(2_000);
        await expect(stat(lockPath)).resolves.toMatchObject({});
        if (entry.raw !== null) await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toBe(entry.raw);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims only a stale dead exact predecessor artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-dead-predecessor-'));
    const lockPath = join(dir, 'legacy.lock');
    // Provenance: Remote HEAD 490a27a, connectedServiceStateSharingLock.ts:106-110.
    const deadPredecessorRaw = '{"pid":999999,"providerId":null,"acquiredAt":"1970-01-01T00:00:01.000Z"}';
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), deadPredecessorRaw, 'utf8');
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 1,
        errorCode: 'dead_predecessor_timeout',
        pollIntervalMs: 2,
      }, async () => 'reclaimed')).resolves.toBe('reclaimed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves an exact predecessor successor substituted immediately before directory quarantine', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-predecessor-race-'));
    const lockPath = join(dir, 'legacy.lock');
    const staleRaw = '{"pid":999999,"providerId":null,"acquiredAt":"1970-01-01T00:00:01.000Z"}';
    const successorRaw = `{"pid":${process.pid},"providerId":"claude","acquiredAt":"1970-01-01T00:00:01.000Z"}`;
    let contenderEnteredResolve!: () => void;
    const contenderEntered = new Promise<void>((resolvePromise) => {
      contenderEnteredResolve = resolvePromise;
    });
    let contender: Promise<string> | null = null;
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), staleRaw, 'utf8');
      vi.mocked(renameMock).mockImplementationOnce(async (oldPath, newPath) => {
        expect(String(oldPath)).toBe(lockPath);
        await actual.rm(lockPath, { recursive: true, force: true });
        await actual.mkdir(lockPath);
        await actual.writeFile(join(lockPath, 'owner.json'), successorRaw, 'utf8');
        await actual.rename(oldPath, newPath);
        contender = withJsonOwnerFileLock({
          lockPath,
          timeoutMs: 1_500,
          staleAfterMs: 1,
          errorCode: 'legacy_quarantine_contender_timeout',
          pollIntervalMs: 5,
        }, async () => {
          contenderEnteredResolve();
          return 'must-not-enter';
        });
        expect(await settlesWithin(contenderEntered, 500)).toBe(false);
      });
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 1,
        errorCode: 'predecessor_successor_timeout',
        pollIntervalMs: 2,
      }, async () => 'must-not-run')).rejects.toThrow('predecessor_successor_timeout');
      await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toBe(successorRaw);
      await expect(contender).rejects.toThrow('legacy_quarantine_contender_timeout');
      await expect(readdir(dir)).resolves.toEqual(['legacy.lock']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scavenges the exact empty legacy quarantine and owner sidecar left by a release crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-release-crash-'));
    const lockPath = join(dir, 'legacy.lock');
    const suffix = '999998-1000-00000000-0000-4000-8000-000000000004';
    const quarantinePath = `${lockPath}.legacy-${suffix}`;
    const cleanupPath = `${lockPath}.cleanup-${suffix}`;
    const deadOwnerRaw = '{"pid":999999,"providerId":"claude","acquiredAt":"1970-01-01T00:00:01.000Z"}';
    try {
      await mkdir(quarantinePath);
      await writeFile(cleanupPath, deadOwnerRaw, 'utf8');

      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 1_000,
        staleAfterMs: 1,
        errorCode: 'release_crash_scavenge_timeout',
        pollIntervalMs: 5,
      }, async () => 'recovered')).resolves.toBe('recovered');

      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds legacy directories and recovers stale orphan reclaim guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-artifacts-'));
    const legacyPath = join(dir, 'legacy.lock');
    const orphanPath = join(dir, 'orphan.lock');
    try {
      await mkdir(legacyPath);
      const started = Date.now();
      await expect(withJsonOwnerFileLock({ lockPath: legacyPath, timeoutMs: 500, staleAfterMs: 60_000, errorCode: 'legacy_timeout', pollIntervalMs: 5 }, async () => {})).rejects.toThrow('legacy_timeout');
      expect(Date.now() - started).toBeLessThan(2_000);
      await writeFile(join(legacyPath, 'owner.json'), '{"pid":999999,"providerId":null,"acquiredAt":"1970-01-01T00:00:01.000Z"}', 'utf8');
      await expect(withJsonOwnerFileLock({ lockPath: legacyPath, timeoutMs: 100, staleAfterMs: 1, errorCode: 'legacy_dead', pollIntervalMs: 2 }, async () => 'legacy-ok')).resolves.toBe('legacy-ok');
      await writeFile(`${orphanPath}.reclaim`, '', 'utf8');
      await utimes(`${orphanPath}.reclaim`, new Date(1_000), new Date(1_000));
      await expect(withJsonOwnerFileLock({ lockPath: orphanPath, timeoutMs: 500, staleAfterMs: 1, errorCode: 'guard_timeout', pollIntervalMs: 5 }, async () => 'ok')).resolves.toBe('ok');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves a fresh reclaim owner and never leaks a canonical owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-live-guard-'));
    const lockPath = join(dir, 'owner.lock');
    const guardRaw = JSON.stringify({ pid: process.pid, ownerToken: 'live', processStartedAtMs: Math.trunc(Date.now() - (process.uptime() * 1_000)), createdAtMs: Date.now(), updatedAtMs: Date.now() });
    try {
      await writeFile(`${lockPath}.reclaim`, guardRaw, 'utf8');
      await expect(withJsonOwnerFileLock({ lockPath, timeoutMs: 500, staleAfterMs: 60_000, errorCode: 'live_guard_timeout', pollIntervalMs: 5 }, async () => {})).rejects.toThrow('live_guard_timeout');
      await expect(readFile(`${lockPath}.reclaim`, 'utf8')).resolves.toBe(guardRaw);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not publish a reclaim guard until its complete private bytes are fsynced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-complete-guard-'));
    const lockPath = join(dir, 'owner.lock');
    const staleRaw = 'stale-owner';
    try {
      await writeFile(lockPath, staleRaw, 'utf8');
      ownerPublicationBarrier.arm(`${lockPath}.reclaim`);
      const reclaim = reclaimJsonOwnerFileLockSnapshot(lockPath, staleRaw);
      await ownerPublicationBarrier.waitUntilEntered();
      await expect(readFile(`${lockPath}.reclaim`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      ownerPublicationBarrier.release();
      await expect(reclaim).resolves.toBe('reclaimed');
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      ownerPublicationBarrier.release();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('recovers a fully published reclaim guard after its process dies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-dead-guard-'));
    const lockPath = join(dir, 'owner.lock');
    const deadGuardRaw = JSON.stringify({
      pid: 999_999,
      ownerToken: 'dead-guard-owner',
      processStartedAtMs: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    try {
      await writeFile(`${lockPath}.reclaim`, deadGuardRaw, 'utf8');
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 60_000,
        errorCode: 'dead_guard_timeout',
        pollIntervalMs: 2,
      }, async () => 'recovered')).resolves.toBe('recovered');
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reclaims the expected owner after a previous reclaimer dies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-dead-reclaimer-'));
    const lockPath = join(dir, 'owner.lock');
    const expectedRaw = 'expected-owner';
    const deadGuardRaw = JSON.stringify({
      pid: 999_999,
      ownerToken: 'dead-reclaimer',
      processStartedAtMs: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    try {
      await writeFile(lockPath, expectedRaw, 'utf8');
      await writeFile(`${lockPath}.reclaim`, deadGuardRaw, 'utf8');

      await expect(reclaimJsonOwnerFileLockSnapshot(lockPath, expectedRaw)).resolves.toBe('reclaimed');
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves a canonical owner that appears immediately after guard publication', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-canonical-successor-'));
    const lockPath = join(dir, 'owner.lock');
    const successorRaw = JSON.stringify({
      pid: process.pid,
      ownerToken: 'canonical-successor',
      processStartedAtMs: Math.trunc(Date.now() - (process.uptime() * 1_000)),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    vi.mocked(linkMock).mockImplementationOnce(async (...args) => {
      await actual.link(...args);
      await actual.writeFile(lockPath, successorRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    });
    try {
      await expect(reclaimJsonOwnerFileLockSnapshot(lockPath, 'older-observation')).resolves.toBe('successor_preserved');
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(successorRaw);
      await expect(readFile(`${lockPath}.reclaim`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      let entered = false;
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 1,
        errorCode: 'canonical_successor_timeout',
        pollIntervalMs: 5,
      }, async () => {
        entered = true;
      })).rejects.toThrow('canonical_successor_timeout');
      expect(entered).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('removes only its own publication when a reclaim guard races the hard link', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-raced-guard-'));
    const lockPath = join(dir, 'owner.lock');
    const guardRaw = JSON.stringify({ pid: process.pid, ownerToken: 'racer', processStartedAtMs: Math.trunc(Date.now() - (process.uptime() * 1_000)), createdAtMs: Date.now(), updatedAtMs: Date.now() });
    vi.mocked(linkMock).mockImplementationOnce(async (...args) => {
      await actual.link(...args);
      await actual.writeFile(`${lockPath}.reclaim`, guardRaw, 'utf8');
    });
    try {
      await expect(withJsonOwnerFileLock({ lockPath, timeoutMs: 500, staleAfterMs: 60_000, errorCode: 'raced_guard_timeout', pollIntervalMs: 5 }, async () => {})).rejects.toThrow('raced_guard_timeout');
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${lockPath}.reclaim`, 'utf8')).resolves.toBe(guardRaw);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('publishes complete private owner bytes and removes the preparation file before the effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-complete-publication-'));
    const lockPath = join(dir, 'owner.lock');
    try {
      await withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 100,
        staleAfterMs: 1,
        errorCode: 'complete_publication_lock_timeout',
      }, async () => {
        const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
        expect(record).toMatchObject({
          pid: process.pid,
          ownerToken: expect.any(String),
          processStartedAtMs: expect.any(Number),
          createdAtMs: expect.any(Number),
          updatedAtMs: expect.any(Number),
        });
        await expect(readdir(dir)).resolves.toEqual(['owner.lock']);
        if (process.platform !== 'win32') {
          expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
        }
      });
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails without entering the effect and removes preparation bytes when publication is denied', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(linkMock).mockImplementation(actual.link).mockRejectedValueOnce(Object.assign(new Error('EPERM'), {
      code: 'EPERM',
    }));
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-publication-denied-'));
    const lockPath = join(dir, 'owner.lock');
    const effect = vi.fn(async () => 'must-not-run');
    try {
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 100,
        staleAfterMs: 1,
        errorCode: 'denied_publication_lock_timeout',
      }, effect)).rejects.toMatchObject({ code: 'EPERM' });
      expect(effect).not.toHaveBeenCalled();
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never exposes a stale incomplete owner that can admit two effects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-publication-'));
    const lockPath = join(dir, 'owner.lock');
    let firstEffectResolve: (() => void) | null = null;
    let contenderEffectResolve: (() => void) | null = null;
    let releaseContender!: () => void;
    const firstEffectEntered = new Promise<void>((resolve) => {
      firstEffectResolve = resolve;
    });
    const contenderEffectEntered = new Promise<void>((resolve) => {
      contenderEffectResolve = resolve;
    });
    const contenderRelease = new Promise<void>((resolve) => {
      releaseContender = resolve;
    });
    const options = {
      lockPath,
      timeoutMs: 1_000,
      staleAfterMs: 1,
      errorCode: 'publication_lock_timeout',
      pollIntervalMs: 2,
    } as const;

    try {
      ownerPublicationBarrier.arm(lockPath);
      const first = withJsonOwnerFileLock(options, async () => {
        firstEffectResolve?.();
        return 'first';
      });
      await ownerPublicationBarrier.waitUntilEntered();
      await utimes(ownerPublicationBarrier.getPausedPath(), new Date(1_000), new Date(1_000));

      const contender = withJsonOwnerFileLock(options, async () => {
        contenderEffectResolve?.();
        await contenderRelease;
        return 'contender';
      });
      await contenderEffectEntered;
      ownerPublicationBarrier.release();

      const firstEnteredWhileContenderHeldLock = await settlesWithin(firstEffectEntered);
      releaseContender();
      await expect(Promise.all([first, contender])).resolves.toEqual(['first', 'contender']);
      expect(firstEnteredWhileContenderHeldLock).toBe(false);
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      ownerPublicationBarrier.release();
      releaseContender();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantines a stale snapshot without deleting a successor owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-successor-'));
    const lockPath = join(dir, 'owner.lock');
    const staleRaw = JSON.stringify({ pid: 999_999, ownerToken: 'stale' });
    const successorRaw = JSON.stringify({ pid: process.pid, ownerToken: 'successor' });
    try {
      await writeFile(lockPath, successorRaw, 'utf8');
      let canonicalPathRemainedOccupied = true;
      await expect(reclaimJsonOwnerFileLockSnapshot(lockPath, staleRaw, async (quarantinePath) => {
        canonicalPathRemainedOccupied = await readFile(lockPath, 'utf8').then(() => true, () => false);
        return await readFile(quarantinePath, 'utf8');
      })).resolves.toBe('successor_preserved');
      expect(canonicalPathRemainedOccupied).toBe(true);
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(successorRaw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves a fresh successor guard installed during reclaim cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-guard-successor-'));
    const lockPath = join(dir, 'owner.lock');
    const staleRaw = JSON.stringify({ pid: 999_999, ownerToken: 'stale' });
    const successorGuardRaw = JSON.stringify({
      pid: process.pid,
      ownerToken: 'fresh-successor-guard',
      processStartedAtMs: Math.trunc(Date.now() - (process.uptime() * 1_000)),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    try {
      await writeFile(lockPath, staleRaw, 'utf8');
      await expect(reclaimJsonOwnerFileLockSnapshot(lockPath, staleRaw, async (quarantinePath) => {
        await unlink(`${lockPath}.reclaim`);
        await writeFile(`${lockPath}.reclaim`, successorGuardRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return await readFile(quarantinePath, 'utf8');
      })).resolves.toBe('reclaimed');
      await expect(readFile(`${lockPath}.reclaim`, 'utf8')).resolves.toBe(successorGuardRaw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps guard cleanup continuously exclusive while its pathname is quarantined', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-cleanup-exclusion-'));
    const lockPath = join(dir, 'owner.lock');
    const staleRaw = JSON.stringify({ pid: 999_999, ownerToken: 'stale' });
    let cleanupMovedResolve!: () => void;
    let releaseCleanupResolve!: () => void;
    const cleanupMoved = new Promise<void>((resolve) => {
      cleanupMovedResolve = resolve;
    });
    const releaseCleanup = new Promise<void>((resolve) => {
      releaseCleanupResolve = resolve;
    });
    let paused = false;
    const successorReadyPath = join(dir, 'successor-ready');
    const successorReleasePath = join(dir, 'successor-release');
    const contenderEnteredPath = join(dir, 'contender-entered');
    let successor: ReturnType<typeof spawn> | null = null;
    let contender: ReturnType<typeof spawn> | null = null;
    try {
      await writeFile(lockPath, staleRaw, 'utf8');
      vi.mocked(renameMock).mockImplementation(async (oldPath, newPath) => {
        if (!paused && String(oldPath) === `${lockPath}.reclaim` && String(newPath).includes('.cleanup-')) {
          paused = true;
          successor = spawnSuccessorGuard(lockPath, successorReadyPath, successorReleasePath);
          await waitForFile(successorReadyPath);
          await actual.rename(oldPath, newPath);
          cleanupMovedResolve();
          await releaseCleanup;
          return;
        }
        await actual.rename(oldPath, newPath);
      });

      const reclaim = reclaimJsonOwnerFileLockSnapshot(lockPath, staleRaw);
      await cleanupMoved;
      contender = spawnContender(lockPath, contenderEnteredPath);

      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500));
      expect(await stat(contenderEnteredPath).then(() => true, () => false)).toBe(false);
      releaseCleanupResolve();
      await expect(reclaim).resolves.toBe('reclaimed');
      await writeFile(successorReleasePath, 'release', 'utf8');
      await waitForFile(contenderEnteredPath);
      await Promise.all([successor, contender]
        .filter((child): child is ReturnType<typeof spawn> => child !== null)
        .map(waitForChild));
    } finally {
      releaseCleanupResolve();
      killSpawnedChild(successor);
      killSpawnedChild(contender);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scavenges only stale dead exact private owner artifacts during acquisition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-private-scavenge-'));
    const lockPath = join(dir, 'owner.lock');
    const deadPrivatePath = `${lockPath}.owner-999999-1000-00000000-0000-4000-8000-000000000001`;
    const livePrivatePath = `${lockPath}.owner-${process.pid}-1000-00000000-0000-4000-8000-000000000002`;
    const owner = (pid: number, ownerToken: string) => JSON.stringify({
      pid,
      ownerToken,
      processStartedAtMs: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    try {
      await writeFile(deadPrivatePath, owner(999_999, 'dead-private'), 'utf8');
      await writeFile(livePrivatePath, owner(process.pid, 'live-private'), 'utf8');
      await utimes(deadPrivatePath, new Date(1_000), new Date(1_000));
      await utimes(livePrivatePath, new Date(1_000), new Date(1_000));

      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 2_000,
        staleAfterMs: 1,
        errorCode: 'private_scavenge_timeout',
        pollIntervalMs: 5,
      }, async () => undefined)).resolves.toBeUndefined();

      await expect(readFile(deadPrivatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(livePrivatePath, 'utf8')).resolves.toContain('live-private');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scavenges a proven orphaned quarantine after its reclaimer is SIGKILLed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-sigkill-scavenge-'));
    const lockPath = join(dir, 'owner.lock');
    const quarantinedPath = join(dir, 'quarantined');
    const modulePath = resolve(process.cwd(), 'src/utils/fs/jsonOwnerFileLock.ts');
    const staleRaw = JSON.stringify({
      pid: 999_999,
      ownerToken: 'dead-target',
      processStartedAtMs: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const source = `
import { writeFile, stat } from 'node:fs/promises';
const { withJsonOwnerFileLock } = await import(${JSON.stringify(modulePath)});
await withJsonOwnerFileLock({
  lockPath: process.env.HAPPIER_TEST_LOCK_PATH,
  timeoutMs: 5000,
  staleAfterMs: 1,
  errorCode: 'killed_reclaimer_timeout',
  pollIntervalMs: 10,
  readQuarantinedRaw: async (path) => {
    await writeFile(process.env.HAPPIER_TEST_QUARANTINED_PATH, path, 'utf8');
    while (true) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  },
}, async () => undefined);
`;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      await writeFile(lockPath, staleRaw, 'utf8');
      child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
        env: {
          ...process.env,
          HAPPIER_TEST_LOCK_PATH: lockPath,
          HAPPIER_TEST_QUARANTINED_PATH: quarantinedPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      await waitForFile(quarantinedPath);
      child.kill('SIGKILL');
      await new Promise<void>((resolvePromise) => child?.once('exit', () => resolvePromise()));

      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 5_000,
        staleAfterMs: 1,
        errorCode: 'post_sigkill_timeout',
        pollIntervalMs: 10,
      }, async () => undefined)).resolves.toBeUndefined();

      const lockArtifacts = (await readdir(dir)).filter((name) => name.startsWith('owner.lock'));
      expect(lockArtifacts).toEqual([]);
    } finally {
      child?.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scavenges an aged legacy quarantine when both distinct actor and owner pids are dead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-legacy-scavenge-'));
    const lockPath = join(dir, 'owner.lock');
    const legacyPath = `${lockPath}.legacy-999998-1000-00000000-0000-4000-8000-000000000003`;
    try {
      await mkdir(legacyPath);
      await writeFile(join(legacyPath, 'owner.json'), JSON.stringify({
        pid: 999_999,
        providerId: 'claude',
        acquiredAt: '1970-01-01T00:00:01.000Z',
      }), 'utf8');

      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 1,
        errorCode: 'legacy_scavenge_timeout',
        pollIntervalMs: 5,
      }, async () => undefined)).resolves.toBeUndefined();
      await expect(stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores a successor guard substituted immediately before stale-guard quarantine', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-stale-guard-race-'));
    const lockPath = join(dir, 'owner.lock');
    const guardPath = `${lockPath}.reclaim`;
    const successorRaw = JSON.stringify({
      pid: process.pid,
      ownerToken: 'successor-during-quarantine',
      processStartedAtMs: Math.trunc(Date.now() - (process.uptime() * 1_000)),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    let contenderEnteredResolve!: () => void;
    const contenderEntered = new Promise<void>((resolvePromise) => {
      contenderEnteredResolve = resolvePromise;
    });
    let contender: Promise<string> | null = null;
    try {
      await writeFile(guardPath, '', 'utf8');
      await utimes(guardPath, new Date(1_000), new Date(1_000));
      vi.mocked(renameMock).mockImplementationOnce(async (oldPath, newPath) => {
        expect(String(oldPath)).toBe(guardPath);
        await actual.unlink(guardPath);
        await actual.writeFile(guardPath, successorRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await actual.rename(oldPath, newPath);
        contender = withJsonOwnerFileLock({
          lockPath,
          timeoutMs: 1_500,
          staleAfterMs: 1,
          errorCode: 'stale_guard_quarantine_contender_timeout',
          pollIntervalMs: 5,
        }, async () => {
          contenderEnteredResolve();
          return 'must-not-enter';
        });
        expect(await settlesWithin(contenderEntered, 500)).toBe(false);
      });
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 1,
        errorCode: 'stale_guard_successor_timeout',
        pollIntervalMs: 2,
      }, async () => 'must-not-run')).rejects.toThrow('stale_guard_successor_timeout');
      await expect(readFile(guardPath, 'utf8')).resolves.toBe(successorRaw);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(contender).rejects.toThrow('stale_guard_quarantine_contender_timeout');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves an in-place refreshed malformed guard with the same inode and bytes', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-refreshed-guard-'));
    const lockPath = join(dir, 'owner.lock');
    const guardPath = `${lockPath}.reclaim`;
    try {
      await writeFile(guardPath, '', 'utf8');
      await utimes(guardPath, new Date(1_000), new Date(1_000));
      vi.mocked(renameMock).mockImplementationOnce(async (oldPath, newPath) => {
        expect(String(oldPath)).toBe(guardPath);
        const fresh = new Date(Date.now() + 10_000);
        await actual.utimes(guardPath, fresh, fresh);
        await actual.rename(oldPath, newPath);
      });
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 500,
        staleAfterMs: 1,
        errorCode: 'refreshed_guard_timeout',
        pollIntervalMs: 2,
      }, async () => 'must-not-run')).rejects.toThrow('refreshed_guard_timeout');
      await expect(readFile(guardPath, 'utf8')).resolves.toBe('');
      expect((await stat(guardPath)).mtimeMs).toBeGreaterThan(Date.now());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when quarantined ownership cannot be read after rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-unknown-'));
    const lockPath = join(dir, 'owner.lock');
    const effect = vi.fn(async () => 'must-not-run');
    try {
      await writeFile(lockPath, 'malformed-stale-owner', 'utf8');
      await utimes(lockPath, new Date(1_000), new Date(1_000));

      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 1_000,
        staleAfterMs: 1,
        errorCode: 'unknown_owner_lock',
        pollIntervalMs: 2,
        readQuarantinedRaw: async () => {
          throw new Error('injected quarantine read failure');
        },
      }, effect)).rejects.toThrow('unknown_owner_lock_compromised');

      expect(effect).not.toHaveBeenCalled();
      await expect(readFile(lockPath, 'utf8')).resolves.toBe('malformed-stale-owner');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes two reclaimers racing on one malformed stale owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-reclaimers-'));
    const lockPath = join(dir, 'owner.lock');
    let active = 0;
    let maxActive = 0;
    let effects = 0;
    try {
      await writeFile(lockPath, 'malformed-owner', 'utf8');
      await utimes(lockPath, new Date(1_000), new Date(1_000));
      const run = () => withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 1_000,
        staleAfterMs: 1,
        errorCode: 'test_lock_timeout',
        pollIntervalMs: 2,
      }, async () => {
        effects += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });

      await Promise.all([run(), run()]);

      expect(effects).toBe(2);
      expect(maxActive).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a dead owner and uses current-schema process-start evidence to distinguish pid reuse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-pid-'));
    const deadLockPath = join(dir, 'dead.lock');
    const reusedLockPath = join(dir, 'reused.lock');
    try {
      await writeFile(deadLockPath, JSON.stringify({
        pid: 999_999,
        ownerToken: 'dead-owner',
        processStartedAtMs: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      }), 'utf8');
      await expect(withJsonOwnerFileLock({
        lockPath: deadLockPath,
        timeoutMs: 1_000,
        staleAfterMs: 1,
        errorCode: 'dead_lock_timeout',
        pollIntervalMs: 2,
      }, async () => 'reclaimed')).resolves.toBe('reclaimed');

      const ambiguousRaw = JSON.stringify({
        pid: process.pid,
        ownerToken: 'prior-incarnation',
        processStartedAtMs: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      await writeFile(reusedLockPath, ambiguousRaw, 'utf8');
      await expect(withJsonOwnerFileLock({
        lockPath: reusedLockPath,
        timeoutMs: 1_000,
        staleAfterMs: 1,
        errorCode: 'reused_pid_lock_timeout',
        pollIntervalMs: 2,
      }, async () => 'reused-pid-reclaimed')).resolves.toBe('reused-pid-reclaimed');
      await expect(readFile(reusedLockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
