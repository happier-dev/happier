import * as React from 'react';
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

const machineExternalSessionStatusGetSpy = vi.hoisted(() => vi.fn());
const machineExternalSessionAttachSpy = vi.hoisted(() => vi.fn());
const machineExternalSessionDetachSpy = vi.hoisted(() => vi.fn());
const subscribeActiveServerSpy = vi.hoisted(() =>
  vi.fn<(listener: (snapshot: { serverId: string }) => void) => () => void>(() => () => {}),
);
const resolveSessionTargetServerIdSpy = vi.hoisted(() => vi.fn());
const preferredServerIdState = vi.hoisted(() => ({
  current: 'server-owned' as string | null,
}));
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
let activeServerSnapshot = { serverId: 'server-1' };

vi.mock('@/sync/ops/machineExternalSessions', () => ({
  machineExternalSessionStatusGet: machineExternalSessionStatusGetSpy,
  machineExternalSessionAttach: machineExternalSessionAttachSpy,
  machineExternalSessionDetach: machineExternalSessionDetachSpy,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => activeServerSnapshot,
  subscribeActiveServer: subscribeActiveServerSpy,
}));
vi.mock('./resolveSessionTargetServerId', () => ({
  resolveSessionTargetServerId: (sessionId: string, fallbackServerId?: string | null) =>
    resolveSessionTargetServerIdSpy(sessionId, fallbackServerId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: () => preferredServerIdState.current,
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

type HookValue = Readonly<{
  externalSessionLink: unknown;
  sessionServerId: string | null;
  status: unknown;
  refreshNow: () => Promise<unknown>;
}>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function renderHarness(): Promise<{ getCurrent: () => HookValue; rerender: () => Promise<HookValue>; unmount: () => Promise<void> }> {
  const { useExternalSessionRuntime } = await import('./useExternalSessionRuntime');
  const hook = await renderHook(() => useExternalSessionRuntime({
    sessionId: 'session-1',
    metadata: {
      externalSessionV1: {
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
    rerender: hook.rerender,
    unmount: hook.unmount,
  };
}

async function renderHarnessWithEnabled(initialEnabled: boolean): Promise<{
  getCurrent: () => HookValue;
  rerender: (enabled: boolean) => Promise<HookValue>;
  unmount: () => Promise<void>;
}> {
  const { useExternalSessionRuntime } = await import('./useExternalSessionRuntime');
  const hook = await renderHook(
    (enabled: boolean) => useExternalSessionRuntime({
      sessionId: 'session-1',
      metadata: {
        externalSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
        },
      } as any,
      enabled,
    }),
    {
      initialProps: initialEnabled,
    },
  );

  return {
    getCurrent: hook.getCurrent,
    rerender: async (enabled: boolean) => {
      await hook.rerender(enabled);
      return hook.getCurrent();
    },
    unmount: hook.unmount,
  };
}

async function renderHarnessWithMetadata(initialMetadata: Record<string, unknown>): Promise<{
  getCurrent: () => HookValue;
  rerender: (metadata: Record<string, unknown>) => Promise<HookValue>;
  unmount: () => Promise<void>;
}> {
  const { useExternalSessionRuntime } = await import('./useExternalSessionRuntime');
  const hook = await renderHook(
    (metadata: Record<string, unknown>) => useExternalSessionRuntime({
      sessionId: 'session-1',
      metadata: metadata as any,
    }),
    {
      initialProps: initialMetadata,
    },
  );

  return {
    getCurrent: hook.getCurrent,
    rerender: async (metadata: Record<string, unknown>) => {
      await hook.rerender(metadata);
      return hook.getCurrent();
    },
    unmount: hook.unmount,
  };
}

describe('useExternalSessionRuntime', () => {
  beforeEach(() => {
    appState.currentState = 'active';
    documentStub.visibilityState = 'visible';
    appStateListeners.clear();
    documentListeners.clear();
    activeServerSnapshot = { serverId: 'server-1' };
    machineExternalSessionStatusGetSpy.mockReset();
    machineExternalSessionAttachSpy.mockReset();
    machineExternalSessionDetachSpy.mockReset();
    subscribeActiveServerSpy.mockClear();
    resolveSessionTargetServerIdSpy.mockReset();
    resolveSessionTargetServerIdSpy.mockImplementation(() => {
      throw new Error('legacy wrapper should not be used in useExternalSessionRuntime');
    });
    preferredServerIdState.current = 'server-owned';
    machineExternalSessionAttachSpy.mockResolvedValue({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 });
    machineExternalSessionDetachSpy.mockResolvedValue({ ok: true, detached: true });
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
      machineExternalSessionStatusGetSpy.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
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
    machineExternalSessionStatusGetSpy
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

    machineExternalSessionStatusGetSpy
      .mockImplementationOnce(async () => await server1Status.promise)
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });

    const harness = await renderHarness();

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'server-owned' });

    await act(async () => {
      activeServerSnapshot = { serverId: 'server-2' };
      const subscriber = subscribeActiveServerSpy.mock.calls[0]?.[0];
      if (subscriber) subscriber(activeServerSnapshot);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      server1Status.resolve({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });
      await server1Status.promise;
    });

    expect(harness.getCurrent().status).not.toBeNull();
    await harness.unmount();
  });

  it('re-resolves the preferred owner on refresh calls even when the active server is unchanged', async () => {
    machineExternalSessionStatusGetSpy
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false })
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'running', runnerActive: true })
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
    preferredServerIdState.current = 'server-owned-a';

    const harness = await renderHarness();

    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'server-owned-a' });
    machineExternalSessionStatusGetSpy.mockClear();

    await act(async () => {
      preferredServerIdState.current = 'server-owned-b';
    });

    await harness.rerender();
    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'server-owned-b' });
    await harness.unmount();
  });

  it('exposes the canonical session server id from the runtime hook', async () => {
    const harness = await renderHarness();

    expect(harness.getCurrent().sessionServerId).toBe('server-owned');

    await harness.unmount();
  });

  it('polling direct-session status does not trigger transcript catch-up side effects', async () => {
    machineExternalSessionStatusGetSpy
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'active_recently', runnerActive: false })
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });

    const harness = await renderHarness();

    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalled();
    await harness.unmount();
  });

  it('attaches a direct-session view lease while mounted and detaches it on unmount', async () => {
    const harness = await renderHarness();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'opencode',
      remoteSessionId: 'remote-1',
    }), { serverId: 'server-owned' });

    await harness.unmount();

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    }, { serverId: 'server-owned' });
  });

  it('detaches the direct-session view lease when the runtime is disabled without unmounting', async () => {
    const harness = await renderHarnessWithEnabled(true);

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'opencode',
      remoteSessionId: 'remote-1',
    }), { serverId: 'server-owned' });

    await harness.rerender(false);

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    }, { serverId: 'server-owned' });

    await harness.unmount();
  });

  it('ignores a stale in-flight status refresh after the runtime is disabled', async () => {
    const statusRefresh = createDeferred<any>();
    machineExternalSessionStatusGetSpy.mockImplementationOnce(async () => await statusRefresh.promise);

    const harness = await renderHarnessWithEnabled(true);

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);

    await harness.rerender(false);
    expect(harness.getCurrent().status).toBeNull();

    await act(async () => {
      statusRefresh.resolve({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
      await statusRefresh.promise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('invalidates an in-flight status refresh and re-requests status when the direct-session target changes', async () => {
    const firstStatusRefresh = createDeferred<any>();
    const secondStatusRefresh = createDeferred<any>();
    machineExternalSessionStatusGetSpy
      .mockImplementationOnce(async () => await firstStatusRefresh.promise)
      .mockImplementationOnce(async () => await secondStatusRefresh.promise);

    const initialMetadata = {
      externalSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace-a' },
      },
    } as const;

    const harness = await renderHarnessWithMetadata(initialMetadata as any);

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      remoteSessionId: 'remote-1',
      source: { kind: 'opencodeServer', directory: '/tmp/workspace-a' },
    }));

    await act(async () => {
      await harness.rerender({
        externalSessionV1: {
          ...initialMetadata.externalSessionV1,
          remoteSessionId: 'remote-2',
          source: { kind: 'opencodeServer', directory: '/tmp/workspace-b' },
        },
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(2);
    expect(machineExternalSessionStatusGetSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      remoteSessionId: 'remote-2',
      source: { kind: 'opencodeServer', directory: '/tmp/workspace-b' },
    }));

    await act(async () => {
      firstStatusRefresh.resolve({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
      await firstStatusRefresh.promise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(harness.getCurrent().status).toBeNull();

    await act(async () => {
      secondStatusRefresh.resolve({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });
      await secondStatusRefresh.promise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(harness.getCurrent().status).toEqual(expect.objectContaining({
      activity: 'idle',
      runnerActive: false,
    }));

    await harness.unmount();
  });

  it('pauses direct-session polling and renewals when the runtime is hidden, then recovers on visibility restore', async () => {
    vi.useFakeTimers();
    try {
      const harness = await renderHarness();

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        appState.currentState = 'background';
        documentStub.visibilityState = 'hidden';
        for (const handler of appStateListeners) handler('background');
        for (const handler of documentListeners) handler();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineExternalSessionDetachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3_000);
          vi.advanceTimersByTime(3_000);
        });
      });

      expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        appState.currentState = 'active';
        documentStub.visibilityState = 'visible';
        for (const handler of appStateListeners) handler('active');
        for (const handler of documentListeners) handler();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);
      expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries attach after a transient attach failure while the view remains visible', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy
        .mockRejectedValueOnce(new Error('temporary attach failure'))
        .mockResolvedValue({ ok: true, leaseId: 'lease-recovered', expiresAtMs: Date.now() + 60_000 });

      const harness = await renderHarness();

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();

      expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
        machineId: 'machine-1',
        sessionId: 'session-1',
        leaseId: 'lease-recovered',
      }, { serverId: 'server-owned' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries attach after a handled attach error response while the view remains visible', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy
        .mockResolvedValueOnce({ ok: false, errorCode: 'machine_offline', error: 'temporarily offline' })
        .mockResolvedValue({ ok: true, leaseId: 'lease-recovered', expiresAtMs: Date.now() + 60_000 });

      const harness = await renderHarness();

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();

      expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
        machineId: 'machine-1',
        sessionId: 'session-1',
        leaseId: 'lease-recovered',
      }, { serverId: 'server-owned' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not detach and reattach when metadata changes only direct-session follow policy fields', async () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      },
    } as const;

    const harness = await renderHarnessWithMetadata(metadata as any);

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
    machineExternalSessionAttachSpy.mockClear();
    machineExternalSessionDetachSpy.mockClear();

    await act(async () => {
      await harness.rerender({
        externalSessionV1: {
          ...metadata.externalSessionV1,
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: 123,
          },
        },
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionAttachSpy).not.toHaveBeenCalled();

    await harness.unmount();
  });
});
