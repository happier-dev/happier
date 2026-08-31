import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { mkdir, readFile, readdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('acquireDaemonLock', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
  let homeDir: string;

  beforeEach(async () => {
    vi.doUnmock('@/daemon/doctor');
    vi.doUnmock('node:fs/promises');
    homeDir = await createTempDir('happier-cli-daemon-lock-');
    applyEnvValues({ HAPPIER_HOME_DIR: homeDir });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    vi.doUnmock('@/daemon/doctor');
    vi.doUnmock('node:fs/promises');
    await removeTempDir(homeDir);
  });

  it('does not clear the lock file when daemon doctor import fails', async () => {
    vi.doMock('@/daemon/doctor', () => {
      throw new Error('doctor import failed');
    });

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');

    const { acquireDaemonLock } = await import('@/persistence');

    await expect(acquireDaemonLock(1, 1)).rejects.toThrow();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('uses string lock flags for Bun-compatible Windows runtimes', async () => {
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const [path, flags] = args;
          if (String(path).endsWith('.lock') && typeof flags === 'number') {
            const error = Object.assign(
              new Error(`ENOENT: no such file or directory, open '${String(path)}'`),
              { code: 'ENOENT' as const },
            );
            throw error;
          }
          return actual.open(...args);
        },
      };
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock } = await import('@/persistence');

    const fileHandle = await acquireDaemonLock(1, 1);

    expect(fileHandle).not.toBeNull();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
    await fileHandle?.close();
  });

  it('treats the lock as valid when the lock PID is alive but process classification is unavailable', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');

    const { acquireDaemonLock } = await import('@/persistence');

    const fileHandle = await acquireDaemonLock(1, 1);

    expect(fileHandle).toBeNull();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('can clear live daemon state without removing the held singleton lock', async () => {
    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonStateFile), { recursive: true });
    await writeFile(configuration.daemonStateFile, '{}', 'utf8');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');

    const { clearDaemonStateForTests } = await import('@/persistence');

    await clearDaemonStateForTests({ includeLockFile: false });

    expect(existsSync(configuration.daemonStateFile)).toBe(false);
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('does not remove a successor-owned lock file when releasing an old lock handle', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');

    const fileHandle = await acquireDaemonLock(1, 1);
    expect(fileHandle).not.toBeNull();
    await writeFile(configuration.daemonLockFile, '999999', 'utf8');

    await releaseDaemonLock(fileHandle!);

    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('preserves a successor lock that replaces the observed owner during release', async () => {
    let reclaimGuardPublished = false;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        link: async (...args: Parameters<typeof actual.link>) => {
          await actual.link(...args);
          const guardPath = String(args[1]);
          if (guardPath.endsWith('.lock.reclaim')) {
            reclaimGuardPublished = true;
            const lockPath = guardPath.slice(0, -'.reclaim'.length);
            await actual.unlink(lockPath);
            await actual.writeFile(lockPath, '999999', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          }
        },
      };
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');
    const fileHandle = await acquireDaemonLock(1, 1);
    expect(fileHandle).not.toBeNull();

    await releaseDaemonLock(fileHandle!);

    expect(reclaimGuardPublished).toBe(true);
    await expect(readFile(configuration.daemonLockFile, 'utf8')).resolves.toBe('999999');
    await expect(readdir(dirname(configuration.daemonLockFile))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining('.lock.reclaim')]),
    );
  });

  it('preserves a successor lock that replaces a stale observation during acquisition', async () => {
    const staleLockPid = 999_997;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === staleLockPid) return true;
      return true;
    }) as typeof process.kill);
    let reclaimGuardPublished = false;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        link: async (...args: Parameters<typeof actual.link>) => {
          await actual.link(...args);
          const guardPath = String(args[1]);
          if (guardPath.endsWith('.lock.reclaim')) {
            reclaimGuardPublished = true;
            const lockPath = guardPath.slice(0, -'.reclaim'.length);
            await actual.unlink(lockPath);
            await actual.writeFile(lockPath, '999999', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          }
        },
      };
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'not_daemon' as const }),
    }));

    try {
      const { configuration } = await import('@/configuration');
      await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
      await writeFile(configuration.daemonLockFile, String(staleLockPid), 'utf8');
      const { acquireDaemonLock } = await import('@/persistence');

      await expect(acquireDaemonLock(2, 1)).resolves.toBeNull();
      expect(reclaimGuardPublished).toBe(true);
      await expect(readFile(configuration.daemonLockFile, 'utf8')).resolves.toBe('999999');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('preserves the first lock when the same process attempts a concurrent second acquisition', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({
        kind: 'daemon' as const,
        process: { pid: process.pid, command: 'happier daemon start-sync', type: 'daemon' },
      }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');

    const firstHandle = await acquireDaemonLock(1, 1);
    const secondHandle = await acquireDaemonLock(1, 1);

    expect(firstHandle).not.toBeNull();
    expect(secondHandle).toBeNull();
    await expect(readFile(configuration.daemonLockFile, 'utf8')).resolves.toBe(String(process.pid));
    await releaseDaemonLock(firstHandle!);
  });

  it('closes but preserves an unproved partial lock publication when writing the owner PID fails', async () => {
    let createdHandleClosed = false;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args);
          const [path, flags] = args;
          if (!String(path).endsWith('.lock') || flags !== 'wx') {
            return handle;
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'writeFile') {
                return async () => {
                  await target.writeFile('partial-owner');
                  throw Object.assign(new Error('lock owner write failed'), { code: 'EIO' });
                };
              }
              if (property === 'close') {
                return async () => {
                  createdHandleClosed = true;
                  await target.close();
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock } = await import('@/persistence');

    await expect(acquireDaemonLock(1, 1)).resolves.toBeNull();
    expect(createdHandleClosed).toBe(true);
    await expect(readFile(configuration.daemonLockFile, 'utf8')).resolves.toBe('partial-owner');
  });

  it('does not reclaim a successor that replaces a failed lock publication before cleanup', async () => {
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args);
          const [path, flags] = args;
          if (!String(path).endsWith('.lock') || flags !== 'wx') {
            return handle;
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'writeFile') {
                return async () => {
                  await target.writeFile(String(process.pid));
                  await actual.unlink(path);
                  await actual.writeFile(path, '999999', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                  throw Object.assign(new Error('lock owner write failed after replacement'), { code: 'EIO' });
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock } = await import('@/persistence');

    await expect(acquireDaemonLock(1, 1)).resolves.toBeNull();
    await expect(readFile(configuration.daemonLockFile, 'utf8')).resolves.toBe('999999');
  });

  it('preserves a live lock when process probing is permission denied', async () => {
    const lockPid = 999_998;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === lockPid) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return true;
    }) as typeof process.kill);
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    try {
      const { configuration } = await import('@/configuration');
      await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
      await writeFile(configuration.daemonLockFile, String(lockPid), 'utf8');
      const { acquireDaemonLock } = await import('@/persistence');

      await expect(acquireDaemonLock(1, 1)).resolves.toBeNull();
      await expect(readFile(configuration.daemonLockFile, 'utf8')).resolves.toBe(String(lockPid));
    } finally {
      killSpy.mockRestore();
    }
  });

  it('preserves a fresh empty lock during another starter publication window', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, '', 'utf8');
    const { acquireDaemonLock } = await import('@/persistence');

    await expect(acquireDaemonLock(2, 1)).resolves.toBeNull();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('exact-reclaims an old empty lock after bounded re-observation', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, '', 'utf8');
    await utimes(configuration.daemonLockFile, new Date(1_000), new Date(1_000));
    const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');

    const fileHandle = await acquireDaemonLock(3, 1);

    expect(fileHandle).not.toBeNull();
    await releaseDaemonLock(fileHandle!);
  });
});
