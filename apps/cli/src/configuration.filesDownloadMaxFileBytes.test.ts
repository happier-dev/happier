import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration files download max bytes', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_FILES_DOWNLOAD_MAX_FILE_BYTES',
  ] as const;
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

  async function loadDownloadMaxFileBytes(envValue: string | undefined): Promise<number> {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    if (envValue === undefined) delete process.env.HAPPIER_FILES_DOWNLOAD_MAX_FILE_BYTES;
    else process.env.HAPPIER_FILES_DOWNLOAD_MAX_FILE_BYTES = envValue;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    return configMod.configuration.filesDownloadMaxFileBytes;
  }

  it('does not cap downloads by default', async () => {
    // A multi-hundred-MB artifact (e.g. an APK) must be downloadable without configuration.
    expect(await loadDownloadMaxFileBytes(undefined)).toBeGreaterThan(8 * 1024 * 1024 * 1024);
  });

  it('treats 0 as unlimited', async () => {
    expect(await loadDownloadMaxFileBytes('0')).toBeGreaterThan(8 * 1024 * 1024 * 1024);
  });

  it('honours an explicit positive cap from env', async () => {
    expect(await loadDownloadMaxFileBytes('1234')).toBe(1234);
  });
});
