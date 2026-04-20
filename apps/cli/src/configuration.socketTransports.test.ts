import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration socket transports', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SOCKET_FORCE_WEBSOCKET', 'HAPPIER_SOCKET_TRANSPORTS'] as const;
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

  it('defaults to polling-first transports (upgrade to websocket when available)', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET;
    delete process.env.HAPPIER_SOCKET_TRANSPORTS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.socketIoTransports).toEqual(['polling', 'websocket']);
  });

  it('forces websocket-only when HAPPIER_SOCKET_FORCE_WEBSOCKET is enabled', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
    delete process.env.HAPPIER_SOCKET_TRANSPORTS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.socketIoTransports).toEqual(['websocket']);
  });

  it('respects explicit HAPPIER_SOCKET_TRANSPORTS ordering and filters invalid values', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SOCKET_TRANSPORTS = 'polling, websocket, nope, polling';
    delete process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.socketIoTransports).toEqual(['polling', 'websocket']);
  });
});
