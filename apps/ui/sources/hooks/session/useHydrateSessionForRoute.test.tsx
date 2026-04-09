import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHydrateSessionForRoute } from './useHydrateSessionForRoute';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSessionVisibleForMessageRouteSpy = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<boolean>>());
const getSessionEncryptionSpy = vi.hoisted(() => vi.fn<(sessionId: string) => unknown>());

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleForMessageRouteSpy(sessionId),
    encryption: {
      getSessionEncryption: (sessionId: string) => getSessionEncryptionSpy(sessionId),
    },
  },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  },
}));

describe('useHydrateSessionForRoute', () => {
  let previousStorageState: ReturnType<typeof storage.getState>;

  beforeEach(() => {
    previousStorageState = storage.getState();
    ensureSessionVisibleForMessageRouteSpy.mockReset();
    getSessionEncryptionSpy.mockReset();
  });

  afterEach(() => {
    storage.setState(previousStorageState, true);
    standardCleanup();
  });

  it('marks the route ready after hydration succeeds', async () => {
    const deferred = createDeferred<boolean>();
    ensureSessionVisibleForMessageRouteSpy.mockReturnValueOnce(deferred.promise);

    const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

    expect(hook.getCurrent()).toBe(false);

    deferred.resolve(true);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(hook.getCurrent()).toBe(true);
  });

  it('retries hydration after a failure and eventually succeeds', async () => {
    const deferred1 = createDeferred<boolean>();
    const deferred2 = createDeferred<boolean>();
    ensureSessionVisibleForMessageRouteSpy
      .mockReturnValueOnce(deferred1.promise)
      .mockReturnValueOnce(deferred2.promise);
    const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

    expect(hook.getCurrent()).toBe(false);

    deferred1.reject(new Error('hydrate failed'));
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(hook.getCurrent()).toBe(false);

    await vi.waitFor(() => {
      expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(2);
    }, { timeout: 3_000 });

    deferred2.resolve(true);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(hook.getCurrent()).toBe(true);
    expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when component unmounts', async () => {
    const deferred = createDeferred<boolean>();
    ensureSessionVisibleForMessageRouteSpy.mockReturnValue(deferred.promise);

    const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

    expect(hook.getCurrent()).toBe(false);

    deferred.reject(new Error('hydrate failed'));
    await flushHookEffects({ cycles: 1, turns: 1 });

    await hook.unmount();

    await new Promise((resolve) => setTimeout(resolve, 2_200));

    expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(1);
  });

  it('is ready immediately and skips hydration when the session is already authoritatively hydrated', async () => {
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        'session-1': {
          id: 'session-1',
          metadata: { path: '/tmp/demo' },
          agentState: { controlledByUser: true },
          encryptionMode: 'e2ee',
        } as any,
      },
    }));
    getSessionEncryptionSpy.mockReturnValue({ decryptMetadata: vi.fn() });

    const hook = await renderHook(() => useHydrateSessionForRoute('session-1', 'route.hydrate'));

    expect(hook.getCurrent()).toBe(true);
    expect(ensureSessionVisibleForMessageRouteSpy).not.toHaveBeenCalled();
  });
});
