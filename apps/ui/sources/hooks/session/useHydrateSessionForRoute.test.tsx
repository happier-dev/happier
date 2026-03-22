import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useHydrateSessionForRoute } from './useHydrateSessionForRoute';
import { renderScreen } from '@/dev/testkit';


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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function Harness(props: Readonly<{ sessionId: string; tag: string; onReadyChange: (ready: boolean) => void }>) {
  const ready = useHydrateSessionForRoute(props.sessionId, props.tag);

  React.useEffect(() => {
    props.onReadyChange(ready);
  }, [props, ready]);

  return null;
}

describe('useHydrateSessionForRoute', () => {
  beforeEach(() => {
    ensureSessionVisibleForMessageRouteSpy.mockReset();
  });

  it('marks the route ready after hydration succeeds', async () => {
    const deferred = createDeferred<boolean>();
    ensureSessionVisibleForMessageRouteSpy.mockReturnValueOnce(deferred.promise);
    const states: boolean[] = [];

    await renderScreen(<Harness sessionId="session-1" tag="route.hydrate" onReadyChange={(ready) => states.push(ready)} />);

    expect(states.at(-1)).toBe(false);

    await act(async () => {
      deferred.resolve(true);
      await deferred.promise;
      await Promise.resolve();
    });

    expect(states.at(-1)).toBe(true);
  });

  it('retries hydration after a failure and eventually succeeds', async () => {
    const deferred1 = createDeferred<boolean>();
    const deferred2 = createDeferred<boolean>();
    ensureSessionVisibleForMessageRouteSpy
      .mockReturnValueOnce(deferred1.promise)
      .mockReturnValueOnce(deferred2.promise);
    const states: boolean[] = [];

    await renderScreen(<Harness sessionId="session-1" tag="route.hydrate" onReadyChange={(ready) => states.push(ready)} />);

    expect(states.at(-1)).toBe(false);

    // First attempt fails
    await act(async () => {
      deferred1.reject(new Error('hydrate failed'));
      try {
        await deferred1.promise;
      } catch {
        // expected rejection for this test
      }
      await Promise.resolve();
    });

    expect(states.at(-1)).toBe(false);

    // Wait for retry delay (should be ~2 seconds)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2100));
    });

    // Second attempt succeeds
    await act(async () => {
      deferred2.resolve(true);
      await deferred2.promise;
      await Promise.resolve();
    });

    expect(states.at(-1)).toBe(true);
    expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when component unmounts', async () => {
    const deferred = createDeferred<boolean>();
    ensureSessionVisibleForMessageRouteSpy.mockReturnValue(deferred.promise);
    const states: boolean[] = [];

    let instance: renderer.ReactTestRenderer;
    instance = (await renderScreen(<Harness sessionId="session-1" tag="route.hydrate" onReadyChange={(ready) => states.push(ready)} />)).tree;

    expect(states.at(-1)).toBe(false);

    // Fail the first attempt
    await act(async () => {
      deferred.reject(new Error('hydrate failed'));
      try {
        await deferred.promise;
      } catch {
        // expected rejection
      }
      await Promise.resolve();
    });

    // Unmount before retry
    await act(async () => {
      instance!.unmount();
    });

    // Wait past retry delay
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2100));
    });

    // Should not have retried after unmount
    expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledTimes(1);
  });
});
