import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration memoryEmbeddingsRemoteRequestTimeoutMs', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS'] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  it('defaults memoryEmbeddingsRemoteRequestTimeoutMs to 15000', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryEmbeddingsRemoteRequestTimeoutMs).toBe(15_000);
  });

  it('falls back to the default when HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS is below the minimum', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS = '5';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.memoryEmbeddingsRemoteRequestTimeoutMs).toBe(15_000);
  });
});
