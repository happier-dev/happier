import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => unknown>(() => ({ on: vi.fn(), emit: vi.fn() })),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('session sockets transports', () => {
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
    const mod = await import('./sockets');
    mod.createUserScopedSocket({ token: 'fake-token' });

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts).not.toHaveProperty('transports');
  });

  it('can force websocket-only via config flag', async () => {
    process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
    reloadConfiguration();

    const mod = await import('./sockets');
    mod.createUserScopedSocket({ token: 'fake-token' });

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket']);
  });
});
