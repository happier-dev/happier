import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('ApiMachineClient transports', () => {
  const originalEnv = {
    serverUrl: process.env.HAPPIER_SERVER_URL,
    webappUrl: process.env.HAPPIER_WEBAPP_URL,
    forceWs: process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET,
  };

  beforeEach(() => {
    mockIo.mockReset();
    process.env.HAPPIER_SERVER_URL = 'http://localhost:3005';
    process.env.HAPPIER_WEBAPP_URL = 'http://localhost:8080';
    reloadConfiguration();
  });

  afterEach(() => {
    if (originalEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalEnv.serverUrl;
    if (originalEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalEnv.webappUrl;
    if (originalEnv.forceWs === undefined) delete process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET;
    else process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET = originalEnv.forceWs;
    reloadConfiguration();
  });

  it('uses the Engine.IO defaults by default (polling then upgrade)', async () => {
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

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts).not.toHaveProperty('transports');
  });

  it('can force websocket-only via config flag', async () => {
    process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
    reloadConfiguration();

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

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket']);
  });
});
