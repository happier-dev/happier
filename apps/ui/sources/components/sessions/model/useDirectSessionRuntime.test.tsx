import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineDirectSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn());
const subscribeActiveServerSpy = vi.hoisted(() =>
  vi.fn<(listener: (snapshot: { serverId: string }) => void) => () => void>(() => () => {}),
);
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn());
let activeServerSnapshot = { serverId: 'server-1' };

vi.mock('@/sync/ops/machineDirectSessions', () => ({
  machineDirectSessionStatusGet: machineDirectSessionStatusGetSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessionMessages: refreshSessionMessagesSpy,
  },
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => activeServerSnapshot,
  subscribeActiveServer: subscribeActiveServerSpy,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

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
    activeServerSnapshot = { serverId: 'server-1' };
    machineDirectSessionStatusGetSpy.mockReset();
    refreshSessionMessagesSpy.mockReset();
    subscribeActiveServerSpy.mockClear();
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-owned');
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
      const refreshMessages = createDeferred<void>();
      machineDirectSessionStatusGetSpy.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }));
      refreshSessionMessagesSpy.mockReturnValueOnce(refreshMessages.promise);

      const harness = await renderHarness();
      expect(unhandled).toEqual([]);

      await act(async () => {
        refreshMessages.resolve();
        await refreshMessages.promise;
      });

      expect(unhandled).toEqual([]);
      expect(harness.getCurrent().status).toBeNull();
      await harness.unmount();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('returns the current status instead of rejecting when status refresh fails', async () => {
    const refreshMessages = createDeferred<void>();
    machineDirectSessionStatusGetSpy.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
    }));
    refreshSessionMessagesSpy.mockReturnValueOnce(refreshMessages.promise);

    const harness = await renderHarness();

    const refreshPromise = harness.getCurrent().refreshNow();
    await act(async () => {
      refreshMessages.resolve();
      await refreshMessages.promise;
    });
    await expect(refreshPromise).resolves.toBeNull();
    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('does not reset the direct-session runtime when the active server changes but the session owner stays the same', async () => {
    const server1Status = createDeferred<any>();

    machineDirectSessionStatusGetSpy
      .mockImplementationOnce(async () => await server1Status.promise)
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
    refreshSessionMessagesSpy.mockResolvedValue(undefined);

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
    refreshSessionMessagesSpy.mockResolvedValue(undefined);
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
});
