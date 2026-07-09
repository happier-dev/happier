import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { ApiSessionClient } from './sessionClient';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
type CapturedRuntimeHandlerRegistration = {
  rpcHandlerManager: Parameters<typeof registerSessionControlHandlers>[0];
  getSessionMetadata: NonNullable<Parameters<typeof registerSessionControlHandlers>[1]['getSessionMetadata']>;
  sessionRuntimeControls: Parameters<typeof registerSessionControlHandlers>[1]['sessionRuntimeControls'];
};
const runtimeHandlerRegistrations = vi.hoisted(() => [] as Array<{
  rpcHandlerManager: Parameters<typeof registerSessionControlHandlers>[0];
  getSessionMetadata: NonNullable<Parameters<typeof registerSessionControlHandlers>[1]['getSessionMetadata']>;
  sessionRuntimeControls: Parameters<typeof registerSessionControlHandlers>[1]['sessionRuntimeControls'];
}>);

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
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown }) => ({
    start: async () => {
      params.createTransport();
    },
    stop: async () => {},
  }),
}));

vi.mock('./client/executionRuns/registerSessionClientRuntimeHandlers', () => ({
  registerSessionClientRuntimeHandlers: vi.fn((params: CapturedRuntimeHandlerRegistration) => {
    runtimeHandlerRegistrations.push({
      rpcHandlerManager: params.rpcHandlerManager,
      getSessionMetadata: params.getSessionMetadata,
      sessionRuntimeControls: params.sessionRuntimeControls,
    });
  }),
}));

function installSessionControlHandlersFromLatestClient(): void {
  const params = runtimeHandlerRegistrations.at(-1);
  if (!params) throw new Error('Missing runtime handler registration');
  registerSessionControlHandlers(params.rpcHandlerManager, {
    getSessionMetadata: params.getSessionMetadata,
    sessionRuntimeControls: params.sessionRuntimeControls,
    isUsageLimitRecoveryEnabled: async () => true,
  });
}

describe('ApiSessionClient runtime controls', () => {
  afterEach(() => {
    sessionSocketStub = null;
    userSocketStub = null;
    runtimeHandlerRegistrations.length = 0;
  });

  it('routes pending queue materialize-next RPCs through the session client guard', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    installSessionControlHandlersFromLatestClient();
    const materializeNextPendingMessageSafely = vi
      .spyOn(client, 'materializeNextPendingMessageSafely')
      .mockResolvedValue({ type: 'no_pending' });

    await expect(client.rpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT,
      { reconcileWhenEmpty: 'force' },
    )).resolves.toEqual({ type: 'no_pending' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
    });
  });

  it('does not treat a live steer callback as permission to materialize durable pending rows mid-turn', () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 1,
      pendingVersion: 7,
      latestTurnStatus: 'in_progress',
      agentState: {
        capabilities: {
          inFlightSteerAvailable: true,
        },
      },
    }));
    client.onUserMessage(() => undefined);

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('routes connected-service auth invalidation RPCs through installed runtime controls', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    installSessionControlHandlersFromLatestClient();
    const invalidateConnectedServiceAuthTransports = vi.fn(async () => undefined);

    client.setSessionRuntimeControls({
      invalidateConnectedServiceAuthTransports,
    });

    await expect(client.rpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS,
      {},
    )).resolves.toEqual({ ok: true });

    expect(invalidateConnectedServiceAuthTransports).toHaveBeenCalledTimes(1);
  });

});
