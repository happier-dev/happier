import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
]);

describe('session sockets loopback url resolution', () => {
  beforeEach(() => {
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    envScope.patch({
      HAPPIER_HOME_DIR: '/tmp/happier-cli-test-loopback-sockets',
      HAPPIER_SERVER_URL: 'http://localhost:3005',
      HAPPIER_WEBAPP_URL: 'http://localhost:8080',
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
    });
    reloadConfiguration();
  });

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
  });

  it('uses 127.0.0.1 instead of localhost for socket.io urls', async () => {
    const mod = await import('./sockets');
    mod.createUserScopedSocket({ token: 'fake-token' });

    expect(mockIo).toHaveBeenCalled();
    const calledUrl = mockIo.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain('http://127.0.0.1:3005');
  });
});
