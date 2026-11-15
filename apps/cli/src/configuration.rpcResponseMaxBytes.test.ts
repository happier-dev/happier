import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES } from '@happier-dev/protocol/socketRpc';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration rpc response max bytes', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_RPC_RESPONSE_MAX_BYTES'] as const;
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

  async function loadConfiguration(rpcResponseMaxBytesEnv: string | undefined) {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    if (rpcResponseMaxBytesEnv === undefined) {
      delete process.env.HAPPIER_RPC_RESPONSE_MAX_BYTES;
    } else {
      process.env.HAPPIER_RPC_RESPONSE_MAX_BYTES = rpcResponseMaxBytesEnv;
    }
    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    return configMod.configuration;
  }

  it('defaults the reply ceiling to what the relay socket accepts in one packet', async () => {
    const configuration = await loadConfiguration(undefined);

    expect(configuration.rpcResponseMaxBytes).toBe(SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES);
  });

  it('lets an operator whose relay accepts larger packets raise the ceiling', async () => {
    const configuration = await loadConfiguration('40000000');

    expect(configuration.rpcResponseMaxBytes).toBe(40_000_000);
  });
});
