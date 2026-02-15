import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import type { Machine } from './types';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => any>(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    io: { on: vi.fn() },
  })),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('ApiMachineClient loopback url resolution', () => {
  const originalEnv = {
    homeDir: process.env.HAPPIER_HOME_DIR,
    activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,
    serverUrl: process.env.HAPPIER_SERVER_URL,
    webappUrl: process.env.HAPPIER_WEBAPP_URL,
    publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
  };

  beforeEach(() => {
    mockIo.mockReset();

    process.env.HAPPIER_HOME_DIR = '/tmp/happier-cli-test-loopback-machine';
    process.env.HAPPIER_SERVER_URL = 'http://localhost:3005';
    process.env.HAPPIER_WEBAPP_URL = 'http://localhost:8080';
    delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    reloadConfiguration();
  });

  afterEach(() => {
    if (originalEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalEnv.homeDir;
    if (originalEnv.activeServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = originalEnv.activeServerId;
    if (originalEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalEnv.serverUrl;
    if (originalEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalEnv.webappUrl;
    if (originalEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = originalEnv.publicServerUrl;

    reloadConfiguration();
  });

  it('uses 127.0.0.1 instead of localhost for machine socket connection urls', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    expect(mockIo).toHaveBeenCalled();
    const calledUrl = mockIo.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain('http://127.0.0.1:3005');
  }, 15_000);
});
