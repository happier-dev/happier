import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let ApiSessionClient: typeof import('./sessionClient').ApiSessionClient;
let logger: typeof import('@/ui/logger').logger;

function createAxiosConfig(params: Readonly<{
  method: string;
  url: string;
  headers?: AxiosHeaders;
  data?: unknown;
}>): InternalAxiosRequestConfig {
  return {
    method: params.method,
    url: params.url,
    headers: params.headers ?? new AxiosHeaders(),
    ...(params.data === undefined ? {} : { data: params.data }),
  };
}

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
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

describe('ApiSessionClient outbound diagnostics logging', () => {
  beforeAll(async () => {
    ({ ApiSessionClient } = await import('./sessionClient'));
    ({ logger } = await import('@/ui/logger'));
  });

  beforeEach(() => {
    sessionSocketStub = null;
    userSocketStub = null;
  });

  it('logs outbound ACP message shapes without leaking message content', () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        if (event === 'message') {
          return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => ({ ok: true }),
    });

    const debugSpy = vi.spyOn(logger, 'debug');
    debugSpy.mockClear();

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('claude' as any, { type: 'message', message: 'SUPER_SECRET_VALUE' } as any);

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes('[shape:session-out]'))).toBe(true);
  });

  it('serializes socket connection errors without leaking raw network error fields', () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => ({ ok: true }),
    });

    const debugSpy = vi.spyOn(logger, 'debug');
    debugSpy.mockClear();

    new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-socket-log' }));

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
    expect(calls).not.toContain('Authorization');
    expect(calls).not.toContain('Bearer SECRET');
    expect(calls).not.toContain('SECRET_BODY');
    expect(calls).not.toContain('SUPER_SECRET_PASSWORD');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });
});
