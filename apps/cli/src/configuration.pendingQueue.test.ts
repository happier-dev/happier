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

  it('does not expose a Pending idle wake polling authority', () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_PENDING_QUEUE_IDLE_WAKE_POLL_INTERVAL_MS = '60000';

    reloadConfiguration();

    expect('pendingQueueIdleWakePollIntervalMs' in configuration).toBe(false);
  });
});
