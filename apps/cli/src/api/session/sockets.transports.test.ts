import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => unknown>(() => ({ on: vi.fn(), emit: vi.fn() })),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

const envScope = createEnvKeyScope([
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_SOCKET_FORCE_WEBSOCKET',
]);

describe('session sockets transports', () => {
  beforeEach(() => {
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    envScope.patch({
      HAPPIER_SERVER_URL: 'http://localhost:3005',
      HAPPIER_WEBAPP_URL: 'http://localhost:8080',
      HAPPIER_SOCKET_FORCE_WEBSOCKET: undefined,
    });
    reloadConfiguration();
  });

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
  });

  it('uses websocket-first transports by default (fallback to polling)', async () => {
    const mod = await import('./sockets');
    mod.createUserScopedSocket({ token: 'fake-token' });

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket', 'polling']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('can force websocket-only via config flag', async () => {
    process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
    reloadConfiguration();

    const mod = await import('./sockets');
    mod.createUserScopedSocket({ token: 'fake-token' });

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });
});
