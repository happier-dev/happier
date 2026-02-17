import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env.testkit';

describe('configuration memory limits', () => {
  const envBackup = snapshotProcessEnv();
  const tempDirs: string[] = [];

  afterEach(() => {
    restoreProcessEnv(envBackup);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('defaults memoryMaxTranscriptWindowMessages to 250', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryMaxTranscriptWindowMessages).toBe(250);
  });

  it('bounds HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES to max 500', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES = '9999';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryMaxTranscriptWindowMessages).toBe(500);
  });
});

