import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('acquireDaemonLock', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-cli-daemon-lock-');
    applyEnvValues({ HAPPIER_HOME_DIR: homeDir });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    vi.unmock('@/daemon/doctor');
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
  }, 120_000);

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
    const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');

    const fileHandle = await acquireDaemonLock(1, 1);

    expect(fileHandle).not.toBeNull();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
    if (fileHandle) await releaseDaemonLock(fileHandle);
  }, 120_000);

  it('opens Windows daemon locks with read/write access before fsync', async () => {
    const observedLockFlags: string[] = [];
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const [path, flags] = args;
          if (String(path).endsWith('.lock')) {
            observedLockFlags.push(String(flags));
          }
          return actual.open(...args);
        },
      };
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    try {
      const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');
      const fileHandle = await acquireDaemonLock(1, 1);

      expect(fileHandle).not.toBeNull();
      expect(observedLockFlags).toContain('wx+');
      if (fileHandle) await releaseDaemonLock(fileHandle);
    } finally {
      platformSpy.mockRestore();
    }
  }, 120_000);

  it('does not replace a fresh live unclassified lock holder', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');

    const { acquireDaemonLock } = await import('@/persistence');

    await expect(acquireDaemonLock(1, 1)).resolves.toBeNull();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('does not replace an old live unclassified lock holder', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');
    const old = new Date(Date.now() - 120_000);
    await utimes(configuration.daemonLockFile, old, old);

    const { acquireDaemonLock } = await import('@/persistence');

    await expect(acquireDaemonLock(2, 1)).resolves.toBeNull();
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('does not replace a lock holder when PID liveness is denied with EPERM', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    try {
      const { acquireDaemonLock } = await import('@/persistence');
      await expect(acquireDaemonLock(1, 1)).resolves.toBeNull();
      expect(existsSync(configuration.daemonLockFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('can clear live daemon state without removing the held singleton lock', async () => {
    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonStateFile), { recursive: true });
    await writeFile(configuration.daemonStateFile, '{}', 'utf8');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');

    const { clearDaemonStateForTestTeardown } = await import('@/persistence');

    await clearDaemonStateForTestTeardown({ includeLockFile: false });

    expect(existsSync(configuration.daemonStateFile)).toBe(false);
    expect(existsSync(configuration.daemonLockFile)).toBe(true);
  });

  it('default stale-state cleanup preserves a live unclassified singleton lock', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    await mkdir(dirname(configuration.daemonStateFile), { recursive: true });
    await writeFile(configuration.daemonStateFile, '{}', 'utf8');
    await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
    await writeFile(configuration.daemonLockFile, String(process.pid), 'utf8');

    const { clearDaemonStateForTestTeardown } = await import('@/persistence');
    await clearDaemonStateForTestTeardown();

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

  it('does not remove a same-PID successor lock when releasing an old lock handle', async () => {
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: async () => ({ kind: 'unknown' as const }),
    }));

    const { configuration } = await import('@/configuration');
    const { acquireDaemonLock, releaseDaemonLock } = await import('@/persistence');

    const oldHandle = await acquireDaemonLock(1, 1);
    expect(oldHandle).not.toBeNull();
    await unlink(configuration.daemonLockFile);
    const successorHandle = await acquireDaemonLock(1, 1);
    expect(successorHandle).not.toBeNull();

    await releaseDaemonLock(oldHandle!);

    expect(existsSync(configuration.daemonLockFile)).toBe(true);
    await releaseDaemonLock(successorHandle!);
  });
});
