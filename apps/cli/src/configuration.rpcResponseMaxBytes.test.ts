import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration rpc response max bytes', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_RPC_RESPONSE_MAX_BYTES',
    'HAPPIER_FILES_READ_MAX_BYTES',
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

  it('defaults the RPC response wire ceiling below the observed relay frame-death bracket', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_RPC_RESPONSE_MAX_BYTES;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect('rpcResponseMaxBytes' in configMod.configuration).toBe(true);
    const rpcResponseMaxBytes = (configMod.configuration as unknown as { rpcResponseMaxBytes: number })
      .rpcResponseMaxBytes;
    expect(rpcResponseMaxBytes).toBe(8_000_000);
  });

  it('reads the RPC response wire ceiling from env through configuration.ts only', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_RPC_RESPONSE_MAX_BYTES = '1234';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    const rpcResponseMaxBytes = (configMod.configuration as unknown as { rpcResponseMaxBytes: number })
      .rpcResponseMaxBytes;
    expect(rpcResponseMaxBytes).toBe(1234);
  });

  it('clamps the RPC response wire ceiling to the relay code-side frame cap', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_RPC_RESPONSE_MAX_BYTES = String(500_000_000);

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    const rpcResponseMaxBytes = (configMod.configuration as unknown as { rpcResponseMaxBytes: number })
      .rpcResponseMaxBytes;
    expect(rpcResponseMaxBytes).toBe(25_000_000);
  });

  it('bounds the single-reply payload knobs so a supported config cannot exceed the wire ceiling', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_RPC_RESPONSE_MAX_BYTES;
    process.env.HAPPIER_FILES_READ_MAX_BYTES = String(20_000_000);

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    const config = configMod.configuration as unknown as {
      filesReadMaxBytes: number;
      rpcResponseMaxBytes: number;
    };
    expect(config.filesReadMaxBytes).toBeLessThanOrEqual(config.rpcResponseMaxBytes);
    // base64 expands ~4/3, so the raw payload ceiling must leave that headroom.
    expect(config.filesReadMaxBytes).toBe(6_000_000);
  });
});
