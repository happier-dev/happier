import { describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  createApiSessionSocketStub,
  type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

type MockConnectionState = Readonly<{
  phase: string;
  reason: string | null;
  attempt: number;
  nextRetryAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastErrorMessage: string | null;
}>;

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const harness = vi.hoisted(() => ({
  sessionSocket: null as ApiSessionSocketStub | null,
  userSocket: null as ApiSessionSocketStub | null,
  startDeferred: null as Deferred | null,
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!harness.userSocket) throw new Error('Missing user socket stub');
    return harness.userSocket as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!harness.sessionSocket) throw new Error('Missing session socket stub');
    return {
      socket: harness.sessionSocket as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => harness.sessionSocket?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: {
    createTransport: () => unknown;
    onStateChange?: (state: MockConnectionState) => void;
  }) => {
    let startPromise: Promise<void> | null = null;
    let state: MockConnectionState = {
      phase: 'idle',
      reason: null,
      attempt: 0,
      nextRetryAt: null,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastErrorMessage: null,
    };

    return {
      getState: () => state,
      reportProbeResult: vi.fn(),
      start: () => {
        if (!startPromise) {
          startPromise = (async () => {
            state = { ...state, phase: 'connecting' };
            params.onStateChange?.(state);
            params.createTransport();
            if (!harness.startDeferred) throw new Error('Missing start deferred');
            await harness.startDeferred.promise;
            if (harness.sessionSocket) {
              harness.sessionSocket.connected = true;
            }
            state = { ...state, phase: 'online', lastConnectedAt: Date.now() };
            params.onStateChange?.(state);
          })();
        }
        return startPromise;
      },
      stop: async () => {},
    };
  },
}));

describe('ApiSessionClient socket write readiness', () => {
  it('delays metadata updater execution until the managed session socket is online', async () => {
    harness.startDeferred = createDeferred();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event, payload: any) => {
        if (event === 'update-metadata') {
          return { result: 'success', metadata: payload.metadata, version: payload.expectedVersion + 1 };
        }
        return { result: 'success' };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-ready-metadata' }));
    const updater = vi.fn((metadata) => ({ ...metadata, startupReady: true }));

    const updatePromise = client.updateMetadata(updater);
    await Promise.resolve();
    await Promise.resolve();
    const updaterCallsBeforeOnline = updater.mock.calls.length;

    harness.startDeferred.resolve();
    await updatePromise;

    expect(updaterCallsBeforeOnline).toBe(0);
    expect(updater).toHaveBeenCalledTimes(1);
    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith('update-metadata', expect.any(Object));
  });

  it('delays agent-state updater execution until the managed session socket is online', async () => {
    harness.startDeferred = createDeferred();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event, payload: any) => {
        if (event === 'update-state') {
          return { result: 'success', agentState: payload.agentState, version: payload.expectedVersion + 1 };
        }
        return { result: 'success' };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-ready-state' }));
    const updater = vi.fn((agentState) => ({ ...agentState, startupReady: true }));

    const updatePromise = client.updateAgentState(updater);
    await Promise.resolve();
    await Promise.resolve();
    const updaterCallsBeforeOnline = updater.mock.calls.length;

    harness.startDeferred.resolve();
    await updatePromise;

    expect(updaterCallsBeforeOnline).toBe(0);
    expect(updater).toHaveBeenCalledTimes(1);
    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith('update-state', expect.any(Object));
  });

  it('delays runtime activity projection writes until the managed session socket is online', async () => {
    harness.startDeferred = createDeferred();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event, payload: any) => {
        if (event === 'update-runtime-activity') {
          return {
            result: 'success',
            didWrite: true,
            runtimeActivityActiveCount: payload.runtimeActivityActiveCount,
            runtimeActivityObservedAt: payload.runtimeActivityObservedAt,
            runtimeActivityExpiresAt: payload.runtimeActivityExpiresAt,
            runtimeActivitySourceClass: payload.runtimeActivitySourceClass,
          };
        }
        return { result: 'success' };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-ready-runtime-activity' }));

    const updatePromise = client.updateRuntimeActivityProjection({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.sessionSocket.emitWithAck).not.toHaveBeenCalled();

    harness.startDeferred.resolve();
    await expect.poll(() => harness.sessionSocket?.connected === true).toBe(true);
    await updatePromise;

    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith('update-runtime-activity', {
      sid: 's-ready-runtime-activity',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(harness.sessionSocket.emitWithAck.mock.calls.map((call) => call[0])).not.toContain('update-state');
    expect(harness.sessionSocket.emitWithAck.mock.calls.map((call) => call[0])).not.toContain('update-metadata');
    expect(harness.sessionSocket.emit).not.toHaveBeenCalledWith(
      'session-alive',
      expect.objectContaining({ thinking: true }),
    );
  });
});
