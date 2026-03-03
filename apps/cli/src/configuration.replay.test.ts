import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env.testkit';

describe('configuration replay', () => {
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

  it('defaults replaySeedCandidateLimit to 500', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_REPLAY_SEED_CANDIDATE_LIMIT;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.replaySeedCandidateLimit).toBe(500);
  });

  it('bounds replaySeedCandidateLimit to the /v1/messages limit (<=500)', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_REPLAY_SEED_CANDIDATE_LIMIT = '9999';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.replaySeedCandidateLimit).toBe(500);
  });

  it('defaults replaySeedMaxChars to 120000', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_REPLAY_MAX_SEED_CHARS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.replaySeedMaxChars).toBe(120_000);
  });
});
