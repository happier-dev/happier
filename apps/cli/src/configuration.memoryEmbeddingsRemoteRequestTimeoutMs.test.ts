import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env.testkit';

describe('configuration memoryEmbeddingsRemoteRequestTimeoutMs', () => {
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

  it('defaults memoryEmbeddingsRemoteRequestTimeoutMs to 15000', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryEmbeddingsRemoteRequestTimeoutMs).toBe(15_000);
  });

  it('bounds HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS to at least 1000', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS = '5';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryEmbeddingsRemoteRequestTimeoutMs).toBe(1_000);
  });
});
