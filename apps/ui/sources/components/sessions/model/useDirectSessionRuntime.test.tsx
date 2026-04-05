import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
const documentListeners = vi.hoisted(() => new Set<() => void>());
const documentStub = vi.hoisted(() => ({
  visibilityState: 'visible' as DocumentVisibilityState,
  addEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
    if (event === 'visibilitychange' && typeof handler === 'function') {
      documentListeners.add(handler as () => void);
    }
  }),
  removeEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
    if (event === 'visibilitychange' && typeof handler === 'function') {
      documentListeners.delete(handler as () => void);
    }
  }),
}));

const machineDirectSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineDirectSessionAttachSpy = vi.hoisted(() => vi.fn());
const machineDirectSessionDetachSpy = vi.hoisted(() => vi.fn());
const subscribeActiveServerSpy = vi.hoisted(() =>
  vi.fn<(listener: (snapshot: { serverId: string }) => void) => () => void>(() => () => {}),
);
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
let activeServerSnapshot = { serverId: 'server-1' };

vi.mock('@/sync/ops/machineDirectSessions', () => ({
  machineDirectSessionStatusGet: machineDirectSessionStatusGetSpy,
  machineDirectSessionAttach: machineDirectSessionAttachSpy,
  machineDirectSessionDetach: machineDirectSessionDetachSpy,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => activeServerSnapshot,
  subscribeActiveServer: subscribeActiveServerSpy,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: { OS: 'web' },
    AppState: {
      get currentState() {
        return appState.currentState;
      },
      addEventListener: (_event: string, handler: (state: string) => void) => {
        appStateListeners.add(handler);
        return { remove: () => appStateListeners.delete(handler) };
      },
    },
  });
});

type HookValue = ReturnType<typeof import('./useDirectSessionRuntime')['useDirectSessionRuntime']>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function renderHarness(): Promise<{ getCurrent: () => HookValue; unmount: () => Promise<void> }> {
  const { useDirectSessionRuntime } = await import('./useDirectSessionRuntime');
  const hook = await renderHook(() => useDirectSessionRuntime({
    sessionId: 'session-1',
    metadata: {
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      },
    } as any,
  }));

  return {
    getCurrent: hook.getCurrent,
    unmount: hook.unmount,
  };
}

describe('useDirectSessionRuntime', () => {
  beforeEach(() => {
    appState.currentState = 'active';
    documentStub.visibilityState = 'visible';
    appStateListeners.clear();
    documentListeners.clear();
    activeServerSnapshot = { serverId: 'server-1' };
    machineDirectSessionStatusGetSpy.mockReset();
    machineDirectSessionAttachSpy.mockReset();
    machineDirectSessionDetachSpy.mockReset();
    subscribeActiveServerSpy.mockClear();
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-owned');
    machineDirectSessionAttachSpy.mockResolvedValue({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 });
    machineDirectSessionDetachSpy.mockResolvedValue({ ok: true, detached: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not emit an unhandled rejection when status fails before transcript refresh completes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      machineDirectSessionStatusGetSpy.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }));

      const harness = await renderHarness();
      expect(unhandled).toEqual([]);

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(unhandled).toEqual([]);
      expect(harness.getCurrent().status).toBeNull();
      await harness.unmount();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('returns the current status instead of rejecting when status refresh fails', async () => {
    machineDirectSessionStatusGetSpy
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }))
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }));

    const harness = await renderHarness();

    const refreshPromise = harness.getCurrent().refreshNow();
    await expect(refreshPromise).resolves.toBeNull();
    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('does not reset the direct-session runtime when the active server changes but the session owner stays the same', async () => {
    const server1Status = createDeferred<any>();

    machineDirectSessionStatusGetSpy
      .mockImplementationOnce(async () => await server1Status.promise)
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });

    const harness = await renderHarness();

    expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(machineDirectSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'server-owned' });

    await act(async () => {
      activeServerSnapshot = { serverId: 'server-2' };
      const subscriber = subscribeActiveServerSpy.mock.calls[0]?.[0];
      if (subscriber) subscriber(activeServerSnapshot);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      server1Status.resolve({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });
      await server1Status.promise;
    });

    expect(harness.getCurrent().status).not.toBeNull();
    await harness.unmount();
  });

  it('re-resolves the preferred owner on refresh calls even when the active server is unchanged', async () => {
    machineDirectSessionStatusGetSpy
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false })
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'running', runnerActive: true })
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
    resolvePreferredServerIdForSessionIdSpy
      .mockReturnValueOnce('server-owned-a')
      .mockReturnValueOnce('server-owned-a')
      .mockReturnValueOnce('server-owned-b')
      .mockReturnValue('server-owned-b');

    const harness = await renderHarness();

    expect(machineDirectSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'server-owned-a' });

    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineDirectSessionStatusGetSpy.mock.calls[1]?.[1]).toEqual({ serverId: 'server-owned-b' });
    await harness.unmount();
  });

  it('polling direct-session status does not trigger transcript catch-up side effects', async () => {
    machineDirectSessionStatusGetSpy
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'active_recently', runnerActive: false })
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });

    const harness = await renderHarness();

    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineDirectSessionStatusGetSpy).toHaveBeenCalled();
    await harness.unmount();
  });

  it('attaches a direct-session view lease while mounted and detaches it on unmount', async () => {
    const harness = await renderHarness();

    expect(machineDirectSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'opencode',
      remoteSessionId: 'remote-1',
    }), { serverId: 'server-owned' });

    await harness.unmount();

    expect(machineDirectSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    }, { serverId: 'server-owned' });
  });

  it('pauses direct-session polling and renewals when the runtime is hidden, then recovers on visibility restore', async () => {
    vi.useFakeTimers();
    try {
      const harness = await renderHarness();

      expect(machineDirectSessionAttachSpy).toHaveBeenCalledTimes(1);
      expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        appState.currentState = 'background';
        documentStub.visibilityState = 'hidden';
        for (const handler of appStateListeners) handler('background');
        for (const handler of documentListeners) handler();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineDirectSessionDetachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3_000);
          vi.advanceTimersByTime(3_000);
        });
      });

      expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(1);
      expect(machineDirectSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        appState.currentState = 'active';
        documentStub.visibilityState = 'visible';
        for (const handler of appStateListeners) handler('active');
        for (const handler of documentListeners) handler();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineDirectSessionAttachSpy).toHaveBeenCalledTimes(2);
      expect(machineDirectSessionStatusGetSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
