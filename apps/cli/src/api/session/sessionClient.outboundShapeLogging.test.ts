import { describe, expect, it, vi } from 'vitest';

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
  it('logs outbound ACP message shapes without leaking message content', async () => {
    vi.resetModules();

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

    const { ApiSessionClient } = await import('./sessionClient');
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug');
    debugSpy.mockClear();

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('claude' as any, { type: 'message', message: 'SUPER_SECRET_VALUE' } as any);

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes('[shape:session-out]'))).toBe(true);
  });
});
