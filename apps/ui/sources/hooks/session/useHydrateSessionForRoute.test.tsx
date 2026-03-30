import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHydrateSessionForRoute } from './useHydrateSessionForRoute';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSessionVisibleForMessageRouteSpy = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<boolean>>());

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleForMessageRouteSpy(sessionId),
  },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  },
}));

describe('useHydrateSessionForRoute', () => {
  beforeEach(() => {
    ensureSessionVisibleForMessageRouteSpy.mockReset();
  });

  afterEach(() => {
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
});
