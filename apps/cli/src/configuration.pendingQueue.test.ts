import { afterEach, describe, expect, it } from 'vitest';
import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env/envSnapshot';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from './configuration';

describe('configuration pending queue', () => {
  const envBackup = snapshotProcessEnv();
  const tempDirs: string[] = [];

  afterEach(() => {
    restoreProcessEnv(envBackup);
    reloadConfiguration();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  it('defaults idle wake polling to a slow defensive interval', () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_PENDING_QUEUE_IDLE_WAKE_POLL_INTERVAL_MS;

    reloadConfiguration();

    expect(configuration.pendingQueueIdleWakePollIntervalMs).toBe(30_000);
  });
});
