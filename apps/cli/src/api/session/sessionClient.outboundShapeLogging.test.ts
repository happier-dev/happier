import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {}, disconnect: async () => {}, destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {}, onDisconnected: () => () => {}, onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => { params.createTransport(); await params.onConnected?.(); },
    stop: async () => {},
  }),
}));

function createAxiosConfig(params: Readonly<{ method: string; url: string; headers?: AxiosHeaders; data?: unknown }>): InternalAxiosRequestConfig {
  return {
    method: params.method,
    url: params.url,
    headers: params.headers ?? new AxiosHeaders(),
    ...(params.data === undefined ? {} : { data: params.data }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionSocketStub = null;
  userSocketStub = null;
});

describe('ApiSessionClient outbound diagnostics logging', () => {
  it('logs durable outbound ACP shapes without leaking message content', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug');
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await client.enqueueAgentMessageCommitted(
      'claude',
      { type: 'message', message: 'SUPER_SECRET_VALUE' },
      { localId: 'shape-1', provenance: { kind: 'non_dependent', source: 'external' } },
    );

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(debugSpy.mock.calls.some((call) => String(call[0]).includes('[shape:session-out]'))).toBe(true);
    await client.close();
  });

  it('serializes socket connection errors without leaking raw network error fields', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug');
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-socket-log' }));
    const socketError = new AxiosError('socket failed', 'ECONNRESET', createAxiosConfig({
      method: 'get',
      url: 'https://relay:SUPER_SECRET_PASSWORD@api.example.test/socket.io/?token=SECRET',
      headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
      data: { secret: 'SECRET_BODY' },
    }));

    sessionSocketStub.trigger('connect_error', socketError);
    sessionSocketStub.trigger('error', socketError);

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).toContain('[API] Socket connection error');
    expect(calls).toContain('[API] Socket error');
    expect(calls).toContain('https://api.example.test/socket.io/');
    expect(calls).not.toContain('Bearer SECRET');
    expect(calls).not.toContain('SECRET_BODY');
    expect(calls).not.toContain('SUPER_SECRET_PASSWORD');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
    await client.close();
  });
});
