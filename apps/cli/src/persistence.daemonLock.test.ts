import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
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
  });
});
