import { afterEach, describe, expect, it } from 'vitest';

import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env/envSnapshot';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { configuration, reloadConfiguration } from './configuration';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from './daemon/spawn/sessionWebhookTimeoutPolicy';

describe('configuration daemon spawn hook timeout', () => {
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

  it('defaults to the same budget as daemon session spawn requests', () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_DAEMON_SPAWN_HOOK_DISPATCH_TIMEOUT_MS;

    reloadConfiguration();

    expect(configuration.daemonSpawnHookDispatchTimeoutMs).toBe(DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS);
  });

  it('allows shorter explicit budgets for defensive fail-closed deployments', () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_DAEMON_SPAWN_HOOK_DISPATCH_TIMEOUT_MS = '120000';

    reloadConfiguration();

    expect(configuration.daemonSpawnHookDispatchTimeoutMs).toBe(120_000);
  });
});
