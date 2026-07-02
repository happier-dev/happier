import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const createdClients: Array<{ close: () => Promise<void> }> = [];

vi.mock('@/features/usageLimitRecoveryFeatureGate', () => ({
  resolveUsageLimitRecoveryEnabled: async () => true,
  usageLimitRecoveryDisabledResult: () => ({
    ok: false,
    errorCode: 'feature_disabled',
    error: 'sessions.usageLimitRecovery is disabled.',
  }),
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub,
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

describe('ApiSessionClient runtime controls', () => {
  afterEach(async () => {
    for (const client of createdClients.splice(0)) {
      await client.close().catch(() => undefined);
    }
    sessionSocketStub = null;
    userSocketStub = null;
  });

  it('routes usage-limit recovery RPCs through installed runtime controls', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'resumed' }));

    client.setSessionRuntimeControls({
      enableUsageLimitWaitResume,
      cancelUsageLimitWaitResume,
      checkUsageLimitRecoveryNow,
    });

    await expect(client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`,
      params: { sessionId: 's1', issueFingerprint: 'usage-limit:s1:reset', rememberPreference: true },
    })).resolves.toEqual({ ok: true, recovery: { status: 'waiting' } });
    await expect(client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL}`,
      params: { sessionId: 's1', issueFingerprint: 'usage-limit:s1:reset' },
    })).resolves.toEqual({ ok: true, recovery: { status: 'cancelled' } });
    await expect(client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      params: { sessionId: 's1' },
    })).resolves.toEqual({ ok: true, status: 'resumed' });

    expect(enableUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:reset',
      rememberPreference: true,
    });
    expect(cancelUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:reset',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('routes connected-service auth invalidation RPCs through installed runtime controls', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);
    const invalidateConnectedServiceAuthTransports = vi.fn(async () => undefined);

    client.setSessionRuntimeControls({
      invalidateConnectedServiceAuthTransports,
    });

    await expect(client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
      params: {},
    })).resolves.toEqual({ ok: true });

    expect(invalidateConnectedServiceAuthTransports).toHaveBeenCalledTimes(1);
  });
});
