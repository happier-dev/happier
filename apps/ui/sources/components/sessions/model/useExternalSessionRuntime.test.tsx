import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { enterDemoMode, resetDemoModeDepthForTests } from '@/demoMode/runtime/enterExitDemoMode';

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
const replaceExternalSessionStatusDemandViewportSpy = vi.hoisted(() => vi.fn());
const subscribeActiveServerSpy = vi.hoisted(() =>
  vi.fn<(listener: (snapshot: { serverId: string }) => void) => () => void>(() => () => {}),
);
const resolveSessionTargetServerIdSpy = vi.hoisted(() => vi.fn());
const preferredServerIdState = vi.hoisted(() => ({
  current: 'server-owned' as string | null,
}));
const preferredServerListeners = vi.hoisted(() => new Set<() => void>());
const subscribePreferredServerSpy = vi.hoisted(() => vi.fn((listener: () => void) => {
  preferredServerListeners.add(listener);
  return () => {
    preferredServerListeners.delete(listener);
  };
}));
const noopSubscribe = vi.hoisted(() => () => () => {});
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
const acceptedTailCursorState = vi.hoisted(() => ({
  current: null as string | null,
  listeners: new Set<() => void>(),
}));
let activeServerSnapshot = { serverId: 'server-1' };
let activeAccountIsCurrent = true;

vi.mock('@/sync/ops/machineExternalSessions', () => ({
  machineExternalSessionStatusGet: machineExternalSessionStatusGetSpy,
  machineExternalSessionAttach: machineExternalSessionAttachSpy,
  machineExternalSessionDetach: machineExternalSessionDetachSpy,
}));
vi.mock('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator', () => ({
  replaceExternalSessionStatusDemandViewport: replaceExternalSessionStatusDemandViewportSpy,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => activeServerSnapshot,
  subscribeActiveServer: subscribeActiveServerSpy,
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
  captureActiveServerAccountScopeCurrentness: () => ({
    isCurrent: () => activeAccountIsCurrent,
    onRetire: () => ({ dispose() {} }),
  }),
}));
vi.mock('./resolveSessionTargetServerId', () => ({
  resolveSessionTargetServerId: (sessionId: string, fallbackServerId?: string | null) =>
    resolveSessionTargetServerIdSpy(sessionId, fallbackServerId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: (
    _sessionId: string,
    _fallbackServerId?: string | null,
    enabled = true,
  ) => React.useSyncExternalStore(
    enabled ? subscribePreferredServerSpy : noopSubscribe,
    () => enabled ? preferredServerIdState.current : null,
    () => null,
  ),
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    getAcceptedExternalSessionTailCursor: () => acceptedTailCursorState.current,
    subscribeAcceptedExternalSessionTailCursor: (_sessionId: string, listener: () => void) => {
      acceptedTailCursorState.listeners.add(listener);
      return () => acceptedTailCursorState.listeners.delete(listener);
    },
  },
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
  externalAgent: unknown;
  sessionServerId: string | null;
  status: unknown;
  refreshNow: (options?: Readonly<{ takeoverReadiness?: 'fresh' }>) => Promise<unknown>;
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
        agentId: 'opencode',
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
          agentId: 'opencode',
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
    (globalThis as any).document = documentStub;
    appStateListeners.clear();
    documentListeners.clear();
    activeServerSnapshot = { serverId: 'server-1' };
    activeAccountIsCurrent = true;
    machineExternalSessionStatusGetSpy.mockReset();
    machineExternalSessionAttachSpy.mockReset();
    machineExternalSessionDetachSpy.mockReset();
    replaceExternalSessionStatusDemandViewportSpy.mockReset();
    subscribeActiveServerSpy.mockClear();
    resolveSessionTargetServerIdSpy.mockReset();
    resolveSessionTargetServerIdSpy.mockImplementation(() => {
      throw new Error('legacy wrapper should not be used in useExternalSessionRuntime');
    });
    preferredServerIdState.current = 'server-owned';
    preferredServerListeners.clear();
    subscribePreferredServerSpy.mockClear();
    acceptedTailCursorState.current = null;
    acceptedTailCursorState.listeners.clear();
    machineExternalSessionAttachSpy.mockResolvedValue({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 });
    machineExternalSessionDetachSpy.mockResolvedValue({ ok: true, detached: true });
  });

  afterEach(() => {
    resetDemoModeDepthForTests();
    vi.clearAllMocks();
  });

  it('keeps linked demo sessions inert while preserving their canonical link', async () => {
    enterDemoMode();

    const harness = await renderHarness();

    expect(harness.getCurrent().externalSessionLink).toEqual(expect.objectContaining({
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
    }));
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionAttachSpy).not.toHaveBeenCalled();
    expect(appStateListeners).toHaveLength(0);
    expect(documentListeners).toHaveLength(0);
    expect(preferredServerListeners).toHaveLength(0);
    expect(acceptedTailCursorState.listeners).toHaveLength(0);
    expect(replaceExternalSessionStatusDemandViewportSpy).not.toHaveBeenCalled();
    await expect(harness.getCurrent().refreshNow()).resolves.toBeNull();
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

    await harness.unmount();

    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
  });

  it('installs no runtime subscriptions while disabled and subscribes exactly once when enabled', async () => {
    vi.useFakeTimers();
    try {
      const harness = await renderHarnessWithEnabled(false);

      expect(appStateListeners).toHaveLength(0);
      expect(documentListeners).toHaveLength(0);
      expect(preferredServerListeners).toHaveLength(0);
      expect(acceptedTailCursorState.listeners).toHaveLength(0);
      expect(replaceExternalSessionStatusDemandViewportSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionAttachSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await harness.rerender(true);
      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(appStateListeners).toHaveLength(1);
      expect(documentListeners).toHaveLength(1);
      expect(preferredServerListeners).toHaveLength(1);
      expect(acceptedTailCursorState.listeners).toHaveLength(1);
      expect(subscribePreferredServerSpy).toHaveBeenCalledTimes(1);
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await harness.rerender(false);

      expect(appStateListeners).toHaveLength(0);
      expect(documentListeners).toHaveLength(0);
      expect(preferredServerListeners).toHaveLength(0);
      expect(acceptedTailCursorState.listeners).toHaveLength(0);
      expect(machineExternalSessionDetachSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      await harness.unmount();
      expect(machineExternalSessionDetachSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes pushed external-Agent observation independently from legacy control status', async () => {
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      activity: 'idle',
      runnerActive: true,
    });
    const observation = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: {
          pluginId: 'happier.opencode',
          localId: 'opencode',
        },
        source: {
          kind: 'opencode.server',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
      status: 'working',
      observedAtMs: 1_000,
      expiresAtMs: 2_000,
    } as const;
    const harness = await renderHarnessWithMetadata({
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      },
      externalAgentObservationV1: observation,
      externalProvider: {
        ...observation,
        status: 'waiting',
      },
    });

    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(harness.getCurrent().externalAgent).toEqual(observation);
    expect(harness.getCurrent().status).toEqual(expect.objectContaining({
      runnerActive: true,
    }));

    await harness.unmount();
  });

  it('issues zero recurring status RPCs when canonical pushed status is present', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionStatusGetSpy.mockResolvedValue({
        ok: true,
        machineOnline: true,
        activity: 'running',
        runnerActive: true,
      });
      const harness = await renderHarnessWithMetadata({
        externalSessionV1: {
          v: 1,
          agentId: 'opencode',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
        },
        externalAgentObservationV1: {
          v: 1,
          qualifiedLinkIdentity: {
            v: 1,
            agent: {
              pluginId: 'happier.opencode',
              localId: 'opencode',
            },
            source: {
              kind: 'opencode.server',
              contractVersion: 1,
            },
          },
          linkGeneration: 'link-generation-1',
          status: 'working',
          observedAtMs: 1_000,
          expiresAtMs: 2_000,
        },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      await harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes focused-session open demand even when no session list collector is mounted', async () => {
    const harness = await renderHarnessWithMetadata({
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
        linkedAtMs: 1_234,
      },
    });

    expect(replaceExternalSessionStatusDemandViewportSpy).toHaveBeenCalledWith(
      expect.any(String),
      [{
        serverId: 'server-owned',
        sessionId: 'session-1',
        machineId: 'machine-1',
        linkGeneration: '1234',
        demand: 'open',
      }],
    );
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

    const viewportId = replaceExternalSessionStatusDemandViewportSpy.mock.calls
      .find(([, entries]) => Array.isArray(entries) && entries.length === 1)?.[0];
    await harness.unmount();
    expect(replaceExternalSessionStatusDemandViewportSpy).toHaveBeenCalledWith(
      viewportId,
      [],
    );
  });

  it('does not replace unchanged open demand when pushed observation metadata changes', async () => {
    const externalSessionV1 = {
      v: 1,
      agentId: 'opencode',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      linkedAtMs: 1_234,
    } as const;
    const observation = {
      v: 1,
      qualifiedLinkIdentity: {
        v: 1,
        agent: {
          pluginId: 'happier.opencode',
          localId: 'opencode',
        },
        source: {
          kind: 'opencode.server',
          contractVersion: 1,
        },
      },
      linkGeneration: '1234',
      status: 'working',
      observedAtMs: 1_000,
      expiresAtMs: 2_000,
    } as const;
    const harness = await renderHarnessWithMetadata({
      externalSessionV1,
      externalAgentObservationV1: observation,
    });

    expect(harness.getCurrent().externalAgent).toEqual(observation);
    expect(replaceExternalSessionStatusDemandViewportSpy).toHaveBeenCalledTimes(1);
    replaceExternalSessionStatusDemandViewportSpy.mockClear();

    const waitingObservation = {
      ...observation,
      status: 'waiting' as const,
      observedAtMs: 1_100,
      expiresAtMs: 2_100,
    };
    await harness.rerender({
      externalSessionV1: { ...externalSessionV1 },
      externalAgentObservationV1: waitingObservation,
    });

    expect(harness.getCurrent().externalAgent).toEqual(waitingObservation);
    expect(replaceExternalSessionStatusDemandViewportSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

    await harness.unmount();
    expect(replaceExternalSessionStatusDemandViewportSpy).toHaveBeenCalledWith(
      expect.any(String),
      [],
    );
  });

  it('does not emit an unhandled rejection when status fails before transcript refresh completes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const harness = await renderHarness();
      machineExternalSessionStatusGetSpy.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }));

      await act(async () => {
        await harness.getCurrent().refreshNow();
      });
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

  it('propagates terminal status auth while treating connectivity failures as unavailable', async () => {
    const terminalAuthError = { kind: 'auth', canTryAgain: false };
    machineExternalSessionStatusGetSpy
      .mockRejectedValueOnce(terminalAuthError)
      .mockRejectedValueOnce(new Error('Network request failed'));
    const harness = await renderHarness();

    await act(async () => {
      await expect(harness.getCurrent().refreshNow()).rejects.toBe(terminalAuthError);
    });
    await act(async () => {
      await expect(harness.getCurrent().refreshNow()).resolves.toBeNull();
    });

    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('fails a status preflight closed without discarding the last displayed status', async () => {
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true,
      machineOnline: true,
      activity: 'idle',
      runnerActive: false,
    });

    const harness = await renderHarness();
    await act(async () => {
      await harness.getCurrent().refreshNow();
    });
    machineExternalSessionStatusGetSpy.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
    }));

    const refreshPromise = harness.getCurrent().refreshNow();
    await expect(refreshPromise).resolves.toBeNull();
    expect(harness.getCurrent().status).toEqual(expect.objectContaining({
      activity: 'idle',
      runnerActive: false,
    }));
    await harness.unmount();
  });

  it('does not reset the direct-session runtime when the active server changes but the session owner stays the same', async () => {
    const server1Status = createDeferred<any>();

    machineExternalSessionStatusGetSpy
      .mockImplementationOnce(async () => await server1Status.promise)
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });

    const harness = await renderHarness();
    const refreshPromise = harness.getCurrent().refreshNow();

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
      await refreshPromise;
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
    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

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

  it('keeps an explicit one-shot status refresh available for takeover controls', async () => {
    machineExternalSessionStatusGetSpy
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'active_recently', runnerActive: false })
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });

    const harness = await renderHarness();
    machineExternalSessionStatusGetSpy.mockClear();

    await act(async () => {
      await harness.getCurrent().refreshNow({ takeoverReadiness: 'fresh' });
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ takeoverReadiness: 'fresh' }),
      { serverId: 'server-owned' },
    );
    await harness.unmount();
  });

  it('attaches a direct-session view lease while mounted and detaches it on unmount', async () => {
    const harness = await renderHarness();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'opencode',
      remoteSessionId: 'remote-1',
    }), { serverId: 'server-owned' });

    await harness.unmount();

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    }, { serverId: 'server-owned' });
  });

  it('attaches and renews viewer demand with the Sync-owned accepted tail cursor', async () => {
    acceptedTailCursorState.current = 'happier_external_cursor_v1:YzA';
    const harness = await renderHarness();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      acceptedTailCursor: 'happier_external_cursor_v1:YzA',
    }), { serverId: 'server-owned' });

    acceptedTailCursorState.current = 'happier_external_cursor_v1:YzE';
    await act(async () => {
      for (const listener of acceptedTailCursorState.listeners) listener();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);
    expect(machineExternalSessionAttachSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      leaseId: 'lease-1',
      acceptedTailCursor: 'happier_external_cursor_v1:YzE',
    }));

    await harness.unmount();
  });

  it('renews the transcript viewer lease independently from status refresh', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy.mockImplementation(async (request: { leaseId?: string }) => ({
        ok: true,
        leaseId: request.leaseId ?? 'lease-1',
        expiresAtMs: Date.now() + 11_000,
      }));

      const harness = await renderHarness();
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);
      expect(machineExternalSessionAttachSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        machineId: 'machine-1',
        sessionId: 'session-1',
        leaseId: 'lease-1',
      }));

      await harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches the direct-session view lease when the runtime is disabled without unmounting', async () => {
    const harness = await renderHarnessWithEnabled(true);

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'opencode',
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

  it('immediately replaces the viewer lease when the canonical link generation and qualified authority change', async () => {
    const harness = await renderHarnessWithMetadata({
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
        linkedAtMs: 1,
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'thirdparty.plugin-a', localId: 'opencode' },
          source: { kind: 'opencodeServer', contractVersion: 1 },
        },
      },
    });

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();

    await harness.rerender({
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
        linkedAtMs: 2,
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'thirdparty.plugin-b', localId: 'opencode' },
          source: { kind: 'opencodeServer', contractVersion: 1 },
        },
      },
    });
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);
    expect(machineExternalSessionDetachSpy.mock.invocationCallOrder[0]).toBeLessThan(
      machineExternalSessionAttachSpy.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );

    await harness.unmount();
  });

  it('ignores a stale in-flight status refresh after the runtime is disabled', async () => {
    const statusRefresh = createDeferred<any>();
    machineExternalSessionStatusGetSpy.mockImplementationOnce(async () => await statusRefresh.promise);

    const harness = await renderHarnessWithEnabled(true);
    const refreshPromise = harness.getCurrent().refreshNow();

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);

    await harness.rerender(false);
    expect(harness.getCurrent().status).toBeNull();

    await act(async () => {
      statusRefresh.resolve({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
      await refreshPromise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('fails an old status preflight closed when a newer target refresh succeeds first', async () => {
    const firstStatusRefresh = createDeferred<any>();
    const secondStatusRefresh = createDeferred<any>();
    machineExternalSessionStatusGetSpy
      .mockImplementationOnce(async () => await firstStatusRefresh.promise)
      .mockImplementationOnce(async () => await secondStatusRefresh.promise);

    const initialMetadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'opencodeServer', directory: '/tmp/workspace-a' },
      },
    } as const;

    const harness = await renderHarnessWithMetadata(initialMetadata as any);
    const firstRefreshPromise = harness.getCurrent().refreshNow();

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

    const secondRefreshPromise = harness.getCurrent().refreshNow();
    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(2);
    expect(machineExternalSessionStatusGetSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      remoteSessionId: 'remote-2',
      source: { kind: 'opencodeServer', directory: '/tmp/workspace-b' },
    }));

    await act(async () => {
      secondStatusRefresh.resolve({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });
      await secondRefreshPromise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(harness.getCurrent().status).toEqual(expect.objectContaining({
      activity: 'idle',
      runnerActive: false,
    }));

    let firstRefreshResult: unknown;
    await act(async () => {
      firstStatusRefresh.resolve({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
      firstRefreshResult = await firstRefreshPromise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(firstRefreshResult).toBeNull();
    expect(harness.getCurrent().status).toEqual(expect.objectContaining({
      activity: 'idle',
      runnerActive: false,
    }));

    await harness.unmount();
  });

  it('pauses transcript viewer lease renewals when hidden, then reacquires on visibility restore', async () => {
    vi.useFakeTimers();
    try {
      const harness = await renderHarness();

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

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

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        appState.currentState = 'active';
        documentStub.visibilityState = 'visible';
        for (const handler of appStateListeners) handler('active');
        for (const handler of documentListeners) handler();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);

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

  it('does not poll attach when the daemon lacks the canonical follow data plane', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy.mockResolvedValue({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'background_follow_not_supported',
      });

      const harness = await renderHarness();

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await harness.unmount();
      expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops attaching once the daemon reports the failure as non-retryable', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy.mockResolvedValue({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'external_session_follow_unavailable',
        retryable: false,
      });

      const harness = await renderHarness();

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await harness.unmount();
      expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying a failure a released daemon reports without retryability', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy
        .mockResolvedValueOnce({
          ok: false,
          errorCode: 'agent_unavailable',
          error: 'external_session_agent_unavailable',
        })
        .mockResolvedValue({ ok: true, leaseId: 'lease-recovered', expiresAtMs: Date.now() + 60_000 });

      const harness = await renderHarness();

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches a viewer lease whose attach resolves after the view is gone', async () => {
    const deferredAttach = createDeferred<{ ok: true; leaseId: string; expiresAtMs: number }>();
    machineExternalSessionAttachSpy.mockImplementationOnce(() => deferredAttach.promise);

    const harness = await renderHarness();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

    await harness.unmount();

    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();

    await act(async () => {
      deferredAttach.resolve({ ok: true, leaseId: 'late-lease', expiresAtMs: Date.now() + 60_000 });
      await deferredAttach.promise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'late-lease',
    }, { serverId: 'server-owned' });
  });

  it('does not detach and reattach when metadata changes only direct-session follow policy fields', async () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
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

  it('never publishes a status read that resolves after the Account retires', async () => {
    const statusRead = createDeferred<{ ok: true; machineOnline: boolean }>();
    machineExternalSessionStatusGetSpy.mockReturnValueOnce(statusRead.promise);
    const harness = await renderHarness();

    let resolved: unknown = 'unset';
    await act(async () => {
      const pending = harness.getCurrent().refreshNow();
      await Promise.resolve();
      activeAccountIsCurrent = false;
      statusRead.resolve({ ok: true, machineOnline: true });
      resolved = await pending;
    });

    expect(resolved).toBeNull();
    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('never attaches or detaches a viewer lease once the Account has retired', async () => {
    activeAccountIsCurrent = false;
    const harness = await renderHarness();

    await act(async () => {
      await Promise.resolve();
    });

    expect(machineExternalSessionAttachSpy).not.toHaveBeenCalled();
    await expect(harness.getCurrent().refreshNow()).resolves.toBeNull();
    expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

    await harness.unmount();

    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
  });
});
