import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration prompt transfer JSON max bytes', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES',
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

  it('defaults prompt transfer JSON max bytes to the UI-aligned value', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect('promptTransferJsonMaxBytes' in configMod.configuration).toBe(true);
    const promptTransferJsonMaxBytes = (configMod.configuration as unknown as { promptTransferJsonMaxBytes: number })
      .promptTransferJsonMaxBytes;
    expect(promptTransferJsonMaxBytes).toBe(2_500_000);
  });

  it('reads prompt transfer JSON max bytes from env through configuration.ts only', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = '1234';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    const promptTransferJsonMaxBytes = (configMod.configuration as unknown as { promptTransferJsonMaxBytes: number })
      .promptTransferJsonMaxBytes;
    expect(promptTransferJsonMaxBytes).toBe(1234);
  });

  it('clamps prompt transfer JSON max bytes to defensive maximums', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = String(500_000_000);

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    const promptTransferJsonMaxBytes = (configMod.configuration as unknown as { promptTransferJsonMaxBytes: number })
      .promptTransferJsonMaxBytes;
    expect(promptTransferJsonMaxBytes).toBe(10_000_000);
  });
});
