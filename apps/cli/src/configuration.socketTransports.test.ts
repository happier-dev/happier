import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env.testkit';

describe('configuration socket transports', () => {
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

  it('defaults to websocket-first transports', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET;
    delete process.env.HAPPIER_SOCKET_TRANSPORTS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.socketIoTransports).toEqual(['websocket', 'polling']);
  });

  it('forces websocket-only when HAPPIER_SOCKET_FORCE_WEBSOCKET is enabled', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
    delete process.env.HAPPIER_SOCKET_TRANSPORTS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.socketIoTransports).toEqual(['websocket']);
  });

  it('respects explicit HAPPIER_SOCKET_TRANSPORTS ordering and filters invalid values', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SOCKET_TRANSPORTS = 'polling, websocket, nope, polling';
    delete process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.socketIoTransports).toEqual(['polling', 'websocket']);
  });
});

