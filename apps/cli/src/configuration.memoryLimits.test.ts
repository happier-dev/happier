import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env/envSnapshot';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration memory limits', () => {
  const envBackup = snapshotProcessEnv();
  const tempDirs: string[] = [];

  afterEach(() => {
    restoreProcessEnv(envBackup);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  it('defaults memoryMaxTranscriptWindowMessages to 250', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryMaxTranscriptWindowMessages).toBe(250);
  });

  it('bounds HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES to max 500', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES = '9999';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryMaxTranscriptWindowMessages).toBe(500);
  });
});
