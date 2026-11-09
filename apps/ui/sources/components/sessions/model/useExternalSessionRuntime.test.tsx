import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExternalSessionStatusGetResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveExternalSessionBrowseHome } from '@/dev/testkit/harness/externalSessionBrowseHome';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { enterDemoMode, isDemoModeActive, resetDemoModeDepthForTests } from '@/demoMode/runtime/enterExitDemoMode';

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
const preferredServerListeners = vi.hoisted(() => new Set<unknown>());
const subscribePreferredServerSpy = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
// This is the daemon's next cursor reply, never the Sync-owned accepted cursor.
const acceptedTailCursorState = vi.hoisted(() => ({
  current: null as string | null,
  listeners: new Set<() => void>(),
}));

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});
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
  refreshNow: () => Promise<unknown>;
}>;

let servedHome: Awaited<ReturnType<typeof serveExternalSessionBrowseHome>> | null = null;
let signedOut = false;
let firstAttachRequestObserved = false;
let firstAttachReply = createDeferred<void>();
let statusRequestIssued = createDeferred<void>();
let statusRequestSignals: AbortSignal[] = [];
let attachRequestSignals: AbortSignal[] = [];
let materializeRequestIssued = createDeferred<void>();
let materializeRequestSignals: AbortSignal[] = [];
let materializeReply: Promise<unknown> = Promise.resolve(null);
let linkRequestIssued = createDeferred<void>();
let linkRequestSignals: AbortSignal[] = [];
let linkReply: Promise<unknown> = Promise.resolve(null);
let appStateBaseline = new Set<(state: string) => void>();
let documentBaseline = new Set<() => void>();
const rpcRequests = installSessionActionRpcBoundary(async (request, { serverUrl, signal }) => {
  const method = request.method.slice(request.method.indexOf(':') + 1);
  const home = Object.values(servedHome?.homes ?? {}).find(home => home.serverUrl === serverUrl);
  if (!home) throw new Error('External-session RPC reached an undeclared Home');
  const options = { serverId: home.id };
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET) {
    statusRequestSignals.push(signal);
    const response = machineExternalSessionStatusGetSpy(request.params, options);
    statusRequestIssued.resolve();
    const value: unknown = await response;
    // These daemon fixtures advertise no takeover/force-stop controls. Keep the
    // complete wire schema beneath the real client parser, unlike an ops stub.
    return ExternalSessionStatusGetResponseSchema.parse(value && typeof value === 'object' && Reflect.get(value, 'ok') === true
      ? { canTakeOverDirect: false, canTakeOverPersist: false, canForceStop: false, ...value }
      : value);
  }
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH) {
    attachRequestSignals.push(signal);
    firstAttachRequestObserved = true;
    const response = await machineExternalSessionAttachSpy(request.params, options);
    firstAttachReply.resolve();
    return response;
  }
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH)
    return machineExternalSessionDetachSpy(request.params, options);
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START) {
    materializeRequestSignals.push(signal);
    materializeRequestIssued.resolve();
    return materializeReply;
  }
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE) {
    linkRequestSignals.push(signal);
    linkRequestIssued.resolve();
    return linkReply;
  }
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE)
    return { ok: true, items: [], hasMore: false, tailCursor: acceptedTailCursorState.current };
  if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER)
    return { ok: true, items: [], truncated: false, hasMore: false, nextCursor: acceptedTailCursorState.current };
  throw new Error('Unexpected daemon RPC: ' + method);
});
await initializeRealAppRuntimeForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const serverRuntime = await import('@/sync/domains/server/serverRuntime');
const storageReaderBridge = await import('@/sync/domains/state/storageStateReaderBridge');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { markSessionSurfaceVisible, markSessionSurfaceHidden } = await import('@/sync/domains/session/sessionSurfaceVisibility');
const demandCoordinator = await import('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator');
let replaceExternalSessionStatusDemandViewportSpy = vi.spyOn(demandCoordinator, 'replaceExternalSessionStatusDemandViewport');

let previousState = storage.getState();
const subscribeStorage = storage.subscribe;

function setPreferredSessionHome(serverId: string) {
  storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId }) } });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function publishAcceptedCursor() {
  const row = storage.getState().sessions['session-1'];
  if (!row) throw new Error('Expected the real Session carrier');
  storage.setState({ sessions: { ...storage.getState().sessions, 'session-1': {
    ...row, currentStorageState: 'machine_only', metadata: { ...row.metadata!,
      externalSessionV1: { v: 1, agentId: 'opencode', machineId: 'machine-1', remoteSessionId: 'remote-1',
        linkedAtMs: 1,
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' } },
    },
  } } });
  markSessionSurfaceVisible('session-1');
  await sync.refreshSessionMessages('session-1');
  expect(sync.getAcceptedExternalSessionTailCursor('session-1')).toBe(acceptedTailCursorState.current);
}

async function settleMountedRuntime(enabled: boolean) {
  if (!enabled || signedOut || isDemoModeActive()) return;
  // The outer test deadline owns this genuine transport observation; add no shorter polling deadline.
  await waitForHomeGovernance(() => expect(firstAttachRequestObserved).toBe(true));
  await flushHookEffects();
}

async function renderHarness(options?: { preserveClock?: boolean }): Promise<{ getCurrent: () => HookValue; rerender: () => Promise<HookValue>; unmount: () => Promise<void> }> {
  const { useExternalSessionRuntime } = await import('./useExternalSessionRuntime');
  if (acceptedTailCursorState.current) await publishAcceptedCursor();
  const hook = await renderHook(() => useExternalSessionRuntime({
    sessionId: 'session-1',
    metadata: {
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        ...(acceptedTailCursorState.current ? { linkedAtMs: 1 } : {}),
        source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      },
    } as any,
  }));

  if (options?.preserveClock) {
    // vi.waitFor advances fake timers. These clock-boundary cases instead
    // await the real RPC boundary without consuming any of the lease.
    await firstAttachReply.promise;
    await flushHookEffects();
  } else {
    await settleMountedRuntime(true);
  }

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

  await settleMountedRuntime(initialEnabled);

  return {
    getCurrent: hook.getCurrent,
    rerender: async (enabled: boolean) => {
      await hook.rerender(enabled);
      await settleMountedRuntime(enabled);
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

  await settleMountedRuntime(true);

  return {
    getCurrent: hook.getCurrent,
    rerender: async (metadata: Record<string, unknown>) => {
      await hook.rerender(metadata);
      await flushHookEffects();
      return hook.getCurrent();
    },
    unmount: hook.unmount,
  };
}

describe('useExternalSessionRuntime', () => {
  beforeEach(async () => {
    appState.currentState = 'active';
    documentStub.visibilityState = 'visible';
    (globalThis as any).document = documentStub;
    appStateListeners.clear();
    documentListeners.clear();
    previousState = storage.getState();
    signedOut = false;
    firstAttachRequestObserved = false;
    firstAttachReply = createDeferred<void>();
    statusRequestIssued = createDeferred<void>();
    statusRequestSignals = [];
    attachRequestSignals = [];
    materializeRequestIssued = createDeferred<void>();
    materializeRequestSignals = [];
    materializeReply = Promise.resolve(null);
    linkRequestIssued = createDeferred<void>();
    linkRequestSignals = [];
    linkReply = Promise.resolve(null);
    const http = createHomeHubArtifactHttpBoundary('account-a');
    const sessions = createSessionMetadataHttpBoundary(() => ({}));
    const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
    servedHome = await serveExternalSessionBrowseHome({ homes: [
      ...['srv_server-1', 'srv_server-2', 'srv_server-owned-a', 'srv_server-owned-b', 'srv_server-owned'].map(key => ({
        key, serverUrl: 'https://external-' + key + '.test', serverIdentityId: key, accountId: 'account-a',
      })),
    ], route: ({ path, url, body, method }) => {
      if (path === '/v1/machines/read-batch' && method === 'POST') return createMachineReadBatchResponseFixture(body,
        id => id === machine.id ? machine : null);
      if (path === '/v1/machines/machine-1') return Response.json({ machine });
      if (path === '/v1/machines') return Response.json([machine]);
      return sessions.handle(url) ?? http.request(url);
    } });
    appStateBaseline = new Set(appStateListeners);
    documentBaseline = new Set(documentListeners);
    replaceExternalSessionStatusDemandViewportSpy = vi.spyOn(demandCoordinator, 'replaceExternalSessionStatusDemandViewport');
    machineExternalSessionStatusGetSpy.mockReset();
    machineExternalSessionAttachSpy.mockReset();
    machineExternalSessionDetachSpy.mockReset();
    replaceExternalSessionStatusDemandViewportSpy.mockClear();
    rpcRequests.length = 0;
    setPreferredSessionHome('srv_server-owned');
    preferredServerListeners.clear();
    subscribePreferredServerSpy.mockClear();
    let registeredSubscriptionDepth = 0;
    const subscribeRegisteredState = storageReaderBridge.subscribeRegisteredStorageState;
    vi.spyOn(storageReaderBridge, 'subscribeRegisteredStorageState').mockImplementation(listener => {
      registeredSubscriptionDepth += 1;
      try { return subscribeRegisteredState(listener); }
      finally { registeredSubscriptionDepth -= 1; }
    });
    // Measure the real preferred-Home selector subscription without replacing its logic.
    vi.spyOn(storage, 'subscribe').mockImplementation((listener) => {
      // The exact-Home HTTP authority briefly observes endpoint availability
      // through this bridge. It is not the React preferred-Home subscription.
      const requestAuthoritySubscription = registeredSubscriptionDepth > 0;
      if (!requestAuthoritySubscription) {
        subscribePreferredServerSpy();
        preferredServerListeners.add(listener);
      }
      const unsubscribe = subscribeStorage(listener);
      return () => {
        if (!requestAuthoritySubscription) preferredServerListeners.delete(listener);
        unsubscribe();
      };
    });
    acceptedTailCursorState.current = null;
    acceptedTailCursorState.listeners.clear();
    // Observe subscription ownership while retaining the real Sync subscription and notification.
    const subscribeTail = sync.subscribeAcceptedExternalSessionTailCursor.bind(sync);
    vi.spyOn(sync, 'subscribeAcceptedExternalSessionTailCursor').mockImplementation((sessionId, listener) => {
      acceptedTailCursorState.listeners.add(listener);
      const unsubscribe = subscribeTail(sessionId, listener);
      return () => { acceptedTailCursorState.listeners.delete(listener); unsubscribe(); };
    });
    machineExternalSessionAttachSpy.mockResolvedValue({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 60_000 });
    machineExternalSessionDetachSpy.mockResolvedValue({ ok: true, detached: true });
  });

  afterEach(async () => {
    await standardCleanup();
    vi.restoreAllMocks();
    markSessionSurfaceHidden('session-1');
    vi.useRealTimers();
    await servedHome?.dispose();
    servedHome = null;
    storage.setState(previousState, true);
    resetDemoModeDepthForTests();
    vi.clearAllMocks();
  });

  it('cancels a stalled status read when its view retires and can read again after reopening', async () => {
    machineExternalSessionStatusGetSpy.mockImplementationOnce(() => new Promise(() => {}));
    const hook = await renderHarnessWithEnabled(true);
    let read!: Promise<unknown>;
    act(() => { read = hook.getCurrent().refreshNow(); });
    await statusRequestIssued.promise;
    await hook.rerender(false);
    expect(statusRequestSignals[0]?.aborted).toBe(true);
    await expect(read).resolves.toBeNull();

    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true, machineOnline: true, runnerActive: false, activity: 'idle',
    });
    await hook.rerender(true);
    await act(async () => { await expect(hook.getCurrent().refreshNow()).resolves.toMatchObject({ ok: true }); });
    expect(statusRequestSignals[1]?.aborted).toBe(false);
    await hook.unmount();
  });

  it('retires only the materialize observer when its view unmounts and a fresh observer can retry', async () => {
    const { useExternalSessionRuntime } = await import('./useExternalSessionRuntime');
    const { useExternalSessionMaterialize } = await import('./useExternalSessionMaterialize');
    machineExternalSessionStatusGetSpy.mockResolvedValue({
      ok: true, machineOnline: true, runnerActive: false, activity: 'idle',
    });
    materializeReply = new Promise(() => {});
    const render = () => renderHook(() => {
      const runtime = useExternalSessionRuntime({ sessionId: 'session-1', metadata: {
        path: '/tmp/workspace', host: 'tester.local',
        externalSessionV1: { v: 1, agentId: 'opencode', machineId: 'machine-1', remoteSessionId: 'remote-1',
          linkedAtMs: 1, source: { kind: 'opencodeServer', directory: '/tmp/workspace' } },
      } });
      return useExternalSessionMaterialize({ sessionId: 'session-1', hasWriteAccess: true, externalSessionRuntime: runtime });
    });
    const first = await render();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = first.getCurrent().requestMaterialize();
      await materializeRequestIssued.promise;
    });
    await first.unmount();
    expect(materializeRequestSignals[0]?.aborted).toBe(true);
    await expect(pending).resolves.toBe(false);
    // Acknowledgement cancellation is not an operation Cancel/Discard request.
    expect(rpcRequests.filter(request => /operation\.(cancel|discard)/.test(request.method))).toHaveLength(0);
    materializeReply = Promise.resolve({ ok: false, error: { code: 'operation_conflict', message: 'Already admitted' } });
    const second = await render();
    await act(async () => { await expect(second.getCurrent().requestMaterialize()).resolves.toBe(false); });
    expect(materializeRequestSignals).toHaveLength(2);
    expect(second.getCurrent().materializeInFlight).toBe(false);
    await second.unmount();
  });

  it('releases a stalled candidate link on selection retirement and reuses the browser for another attempt', async () => {
    const { openExternalSessionCandidate, cancelExternalSessionCandidateOpen } = await import('../external/browse/openExternalSessionCandidate');
    const state = { requestToken: 0, linkingCandidateKey: null as string | null };
    linkReply = new Promise(() => {});
    const open = () => openExternalSessionCandidate({
      candidate: { remoteSessionId: 'remote-1', updatedAtMs: 1 },
      agentId: 'opencode', source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      actionsAllowed: true, offline: false, isSelectionCurrent: () => true,
      resolveCurrentTarget: () => ({ machineId: 'machine-1', serverId: 'srv_server-owned' }),
      state, onLinkingChange: () => {}, openSession: () => {},
    });
    const pending = open();
    await linkRequestIssued.promise;
    cancelExternalSessionCandidateOpen(state);
    expect(linkRequestSignals[0]?.aborted).toBe(true);
    await expect(pending).resolves.toBe('ignored');
    linkReply = Promise.resolve({ ok: true, sessionId: 'linked-session-1', created: false });
    await expect(open()).resolves.toBe('opened');
    expect(state.linkingCandidateKey).toBeNull();
    expect(linkRequestSignals).toHaveLength(2);
  });

  it('preserves the public runtime result identity until a returned field changes', async () => {
    const { useExternalSessionRuntime } = await import('./useExternalSessionRuntime');
    const metadata = { path: '/tmp/workspace', host: 'tester.local' };
    const hook = await renderHook((sessionId: string) => useExternalSessionRuntime({
      sessionId, metadata,
    }), { initialProps: 'session-1' });
    try {
      const initial = hook.getCurrent();
      await hook.rerender('session-1');
      expect(hook.getCurrent().externalSessionLink).toBe(initial.externalSessionLink);
      expect(hook.getCurrent().externalAgent).toBe(initial.externalAgent);
      expect(hook.getCurrent().sessionServerId).toBe(initial.sessionServerId);
      expect(hook.getCurrent().status).toBe(initial.status);
      expect(hook.getCurrent().refreshNow).toBe(initial.refreshNow);
      expect(hook.getCurrent()).toBe(initial);

      await hook.rerender('session-2');
      const changed = hook.getCurrent();
      expect(changed.refreshNow).not.toBe(initial.refreshNow);
      expect(changed).not.toBe(initial);
      await hook.rerender('session-2');
      expect(hook.getCurrent()).toBe(changed);
    } finally {
      await hook.unmount();
    }
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
    expect(appStateListeners).toEqual(appStateBaseline);
    expect(documentListeners).toEqual(documentBaseline);
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

      expect(appStateListeners).toEqual(appStateBaseline);
      expect(documentListeners).toEqual(documentBaseline);
      expect(preferredServerListeners).toHaveLength(0);
      expect(acceptedTailCursorState.listeners).toHaveLength(0);
      expect(replaceExternalSessionStatusDemandViewportSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionAttachSpy).not.toHaveBeenCalled();
      expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();

      await harness.rerender(true);
      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(appStateListeners).toHaveLength(appStateBaseline.size + 1);
      expect(documentListeners).toHaveLength(documentBaseline.size + 1);
      for (const listener of appStateBaseline) expect(appStateListeners.has(listener)).toBe(true);
      for (const listener of documentBaseline) expect(documentListeners.has(listener)).toBe(true);
      expect(preferredServerListeners).toHaveLength(1);
      expect(acceptedTailCursorState.listeners).toHaveLength(1);
      expect(subscribePreferredServerSpy).toHaveBeenCalledTimes(1);
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      const settledSubscriptions = subscribePreferredServerSpy.mock.calls.length;
      await harness.rerender(true);
      expect(subscribePreferredServerSpy).toHaveBeenCalledTimes(settledSubscriptions);
      expect(preferredServerListeners).toHaveLength(1);

      await harness.rerender(false);

      expect(appStateListeners).toEqual(appStateBaseline);
      expect(documentListeners).toEqual(documentBaseline);
      expect(preferredServerListeners).toHaveLength(0);
      expect(acceptedTailCursorState.listeners).toHaveLength(0);
      expect(machineExternalSessionDetachSpy).toHaveBeenCalledTimes(1);
      // Socket pool cleanup has its own timer. Prove the disabled hook emits
      // no renewal over the original lease lifetime instead of counting it.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      expect(machineExternalSessionStatusGetSpy).not.toHaveBeenCalled();

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
        serverId: 'srv_server-owned',
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
    await statusRequestIssued.promise;

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'srv_server-owned' });

    await act(async () => {
      const target = servedHome?.homes['srv_server-2'];
      if (!target) throw new Error('Expected the second declared Home');
      await serverRuntime.setActiveServer({ serverId: target.profileId });
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
    setPreferredSessionHome('srv_server-owned-a');

    const harness = await renderHarness();
    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'srv_server-owned-a' });
    machineExternalSessionStatusGetSpy.mockClear();

    await act(async () => {
      setPreferredSessionHome('srv_server-owned-b');
    });

    await harness.rerender();
    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineExternalSessionStatusGetSpy.mock.calls[0]?.[1]).toEqual({ serverId: 'srv_server-owned-b' });
    await harness.unmount();
  });

  it('exposes the canonical session server id from the runtime hook', async () => {
    const harness = await renderHarness();

    expect(harness.getCurrent().sessionServerId).toBe('srv_server-owned');

    await harness.unmount();
  });

  it('keeps an explicit one-shot status refresh available for takeover controls', async () => {
    machineExternalSessionStatusGetSpy
      .mockResolvedValueOnce({ ok: true, machineOnline: true, activity: 'active_recently', runnerActive: false })
      .mockResolvedValue({ ok: true, machineOnline: true, activity: 'idle', runnerActive: false });

    const harness = await renderHarness();
    machineExternalSessionStatusGetSpy.mockClear();

    await act(async () => {
      await harness.getCurrent().refreshNow();
    });

    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ takeoverReadiness: expect.anything() }),
      { serverId: 'srv_server-owned' },
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
    }), { serverId: 'srv_server-owned' });

    expect(machineExternalSessionAttachSpy.mock.calls[0]?.[0]).not.toHaveProperty('ttlMs');

    await harness.unmount();

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    }, { serverId: 'srv_server-owned' });
  });

  it('attaches and renews viewer demand with the Sync-owned accepted tail cursor', async () => {
    acceptedTailCursorState.current = 'happier_external_cursor_v1:YzA';
    const harness = await renderHarness();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledWith(expect.objectContaining({
      acceptedTailCursor: 'happier_external_cursor_v1:YzA',
    }), { serverId: 'srv_server-owned' });

    acceptedTailCursorState.current = 'happier_external_cursor_v1:YzE';
    await act(async () => {
      await publishAcceptedCursor();
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

      const harness = await renderHarness({ preserveClock: true });
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_499);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
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
    }), { serverId: 'srv_server-owned' });

    await harness.rerender(false);

    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    }, { serverId: 'srv_server-owned' });

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
    await statusRequestIssued.promise;

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
    await statusRequestIssued.promise;

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

    statusRequestIssued = createDeferred<void>();
    const secondRefreshPromise = harness.getCurrent().refreshNow();
    await statusRequestIssued.promise;
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

  it('waits for a natural viewer wake after initial attach fails without a producer expiry', async () => {
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
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);
      await act(async () => {
        appState.currentState = 'background';
        for (const handler of appStateListeners) handler('background');
      });
      await act(async () => {
        appState.currentState = 'active';
        for (const handler of appStateListeners) handler('active');
      });
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);

      await harness.unmount();

      expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
        machineId: 'machine-1',
        sessionId: 'session-1',
        leaseId: 'lease-recovered',
      }, { serverId: 'srv_server-owned' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the typed retryable disposition rather than classifying attach error text', async () => {
    vi.useFakeTimers();
    try {
      const expiresAtMs = Date.now() + 16;
      machineExternalSessionAttachSpy
        .mockResolvedValueOnce({ ok: true, leaseId: 'lease-recovered', expiresAtMs })
        .mockResolvedValue({ ok: false, errorCode: 'agent_unavailable', error: 'background_follow_not_supported', retryable: true });

      const harness = await renderHarness({ preserveClock: true });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      // Each failed renewal consumes half of the producer's remaining lease,
      // rounding only to the clock's next representable millisecond.
      for (const [elapsed, calls] of [[7, 1], [1, 2], [4, 3], [2, 4], [1, 5], [1, 5]] as const) {
        await act(async () => { await vi.advanceTimersByTimeAsync(elapsed); });
        expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(calls);
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(5);

      await harness.unmount();

      expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
        machineId: 'machine-1',
        sessionId: 'session-1',
        leaseId: 'lease-recovered',
      }, { serverId: 'srv_server-owned' });
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
        retryable: false,
      });

      const harness = await renderHarness();

      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

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

  it('retries a renewal a released daemon reports without retryability within its remaining lease', async () => {
    vi.useFakeTimers();
    try {
      machineExternalSessionAttachSpy
        .mockResolvedValueOnce({ ok: true, leaseId: 'lease-1', expiresAtMs: Date.now() + 16_000 })
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
        await vi.advanceTimersByTimeAsync(12_000);
      });

      expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(3);

      await harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an unacknowledged viewer attach and never renews its unknown lease after unmount', async () => {
    const deferredAttach = createDeferred<{ ok: true; leaseId: string; expiresAtMs: number }>();
    machineExternalSessionAttachSpy.mockImplementationOnce(() => deferredAttach.promise);

    const harness = await renderHarness();

    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(1);

    await harness.unmount();

    expect(attachRequestSignals[0]?.aborted).toBe(true);
    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();

    firstAttachRequestObserved = false;
    const reopened = await renderHarness();
    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);
    expect(attachRequestSignals[1]?.aborted).toBe(false);

    await act(async () => {
      deferredAttach.resolve({ ok: true, leaseId: 'late-lease', expiresAtMs: Date.now() + 60_000 });
      await deferredAttach.promise;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });

    // A cancelled acknowledgement cannot reveal a new lease id. The daemon's
    // existing lease expiry owns reclamation; the withdrawn viewer cannot renew it.
    expect(machineExternalSessionDetachSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionAttachSpy).toHaveBeenCalledTimes(2);
    await reopened.unmount();
    expect(machineExternalSessionDetachSpy).toHaveBeenCalledWith({
      machineId: 'machine-1', sessionId: 'session-1', leaseId: 'lease-1',
    }, { serverId: 'srv_server-owned' });
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
    const statusRead = createDeferred<{ ok: true; machineOnline: boolean; activity: 'running'; runnerActive: boolean }>();
    machineExternalSessionStatusGetSpy.mockReturnValueOnce(statusRead.promise);
    const harness = await renderHarness();

    let resolved: unknown = 'unset';
    await act(async () => {
      const pending = harness.getCurrent().refreshNow();
      await statusRequestIssued.promise;
      expect(machineExternalSessionStatusGetSpy).toHaveBeenCalledTimes(1);
      await disconnectActiveServerConnection();
      statusRead.resolve({ ok: true, machineOnline: true, activity: 'running', runnerActive: true });
      resolved = await pending;
    });

    expect(resolved).toBeNull();
    expect(harness.getCurrent().status).toBeNull();
    await harness.unmount();
  });

  it('never dispatches a viewer lease or status request while signed out at mount', async () => {
    signedOut = true;
    const homes = Object.values(servedHome?.homes ?? {});
    // Retire the fixture's credential writes through their own exact rollback.
    // Removing them independently would supersede its still-outstanding receipts.
    await servedHome?.dispose();
    servedHome = null;
    for (const home of homes) {
      expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
    }
    machineExternalSessionAttachSpy.mockClear();
    machineExternalSessionStatusGetSpy.mockClear();
    machineExternalSessionDetachSpy.mockClear();
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
