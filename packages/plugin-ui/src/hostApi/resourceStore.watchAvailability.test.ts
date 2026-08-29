import type { Disposable } from '@happier-dev/plugin-sdk';
import type {
  PluginUiHostApi,
  ResourceContent,
  ResourceSubscriptionEvent,
} from '@happier-dev/plugin-sdk/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPluginUiHostApiResourceClient,
  createPluginUiResourceStore,
} from './resourceStore.js';

const onlineValue: ResourceContent = {
  contentType: 'application/json',
  digest: `sha256:${'a'.repeat(64)}`,
  bytes: new TextEncoder().encode('{"status":"online"}'),
};
const refreshedValue: ResourceContent = {
  contentType: 'application/json',
  digest: `sha256:${'b'.repeat(64)}`,
  bytes: new TextEncoder().encode('{"status":"refreshed"}'),
};

/**
 * A mounted host whose daemon-owned methods are narrowed while the daemon is
 * unreachable and re-advertised on reconnect WITHOUT replacing the adapter —
 * the documented React Native behavior (`getInstalledMethods`).
 */
function createReconnectingHostApi() {
  let online = false;
  let current = onlineValue;
  let deliver: ((event: ResourceSubscriptionEvent) => void) | null = null;
  const disposeWatch = vi.fn();
  const offline = () => Object.assign(new Error('The daemon transport is unavailable.'), {
    code: 'unavailable',
    retryable: true,
  });
  const readResource = vi.fn(async () => {
    if (!online) throw offline();
    return current;
  });
  const watchResource = vi.fn(async (
    _resource: unknown,
    listener: (event: ResourceSubscriptionEvent) => void,
  ): Promise<Disposable> => {
    if (!online) throw offline();
    deliver = listener;
    return { dispose: disposeWatch };
  });
  return {
    api: {
      version: () => Object.freeze({
        apiVersion: '1.0.0',
        wireVersion: 1,
        methods: online ? ['readResource', 'watchResource'] : [],
      }),
      readResource,
      watchResource,
    } as unknown as PluginUiHostApi,
    readResource,
    watchResource,
    reconnect() { online = true; },
    setResource(next: ResourceContent) { current = next; },
    invalidate(digest: string) {
      deliver?.({ version: 1, subscriptionId: 'sub-1', kind: 'invalidated', digest });
    },
  };
}

describe('plugin UI Resource watch availability', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient invalidation reread in the live Resource owner', async () => {
    vi.useFakeTimers();
    let deliver: ((event: ResourceSubscriptionEvent) => void) | null = null;
    let failNextRead = false;
    const readResource = vi.fn(async () => {
      if (failNextRead) {
        failNextRead = false;
        throw Object.assign(new Error('temporary read outage'), { code: 'unavailable', retryable: true });
      }
      return onlineValue;
    });
    const watchResource = vi.fn(async (
      _resource: unknown,
      listener: (event: ResourceSubscriptionEvent) => void,
    ): Promise<Disposable> => {
      deliver = listener;
      return { dispose: vi.fn() };
    });
    const store = createPluginUiResourceStore({
      client: { readResource, watchResource },
      pluginId: 'acme.preview',
    });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => undefined, true);

    await vi.advanceTimersByTimeAsync(0);
    expect(entry.getSnapshot()).toMatchObject({ freshness: 'fresh', subscription: 'live' });
    expect(deliver).not.toBeNull();

    failNextRead = true;
    deliver!({ version: 1, subscriptionId: 'sub-1', kind: 'invalidated', digest: onlineValue.digest });
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.getSnapshot()).toMatchObject({ value: onlineValue, freshness: 'stale', subscription: 'live' });
    const failedReadCount = readResource.mock.calls.length;

    await vi.advanceTimersByTimeAsync(249);
    expect(readResource).toHaveBeenCalledTimes(failedReadCount);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(readResource).toHaveBeenCalledTimes(failedReadCount + 1);
    expect(entry.getSnapshot()).toMatchObject({ value: onlineValue, freshness: 'fresh', subscription: 'live' });

    unsubscribe();
    store.dispose();
  });

  it('resumes live watching on the same entry when a reconnect re-advertises watchResource', async () => {
    const host = createReconnectingHostApi();
    const client = createPluginUiHostApiResourceClient(host.api);
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => undefined, true);

    // Mounted while the daemon is unreachable: the mount cannot serve the
    // subscription right now, but this is not a capability fact about the host.
    await vi.waitFor(() => {
      expect(entry.getSnapshot().subscription).toBe('reconnecting');
    });

    host.reconnect();

    await vi.waitFor(
      () => {
        expect(entry.getSnapshot()).toMatchObject({
          value: onlineValue,
          digest: onlineValue.digest,
          freshness: 'fresh',
          pending: 'idle',
          subscription: 'live',
        });
      },
      { timeout: 4_000 },
    );

    // The recovered watch is a real invalidation channel on the SAME entry, and
    // the last-known-good value survives the transition rather than flashing.
    host.setResource(refreshedValue);
    host.invalidate(refreshedValue.digest);
    await vi.waitFor(() => {
      expect(entry.getSnapshot()).toMatchObject({
        value: refreshedValue,
        digest: refreshedValue.digest,
        freshness: 'fresh',
        subscription: 'live',
      });
    });
    expect(store.getEntry('review-summary').getSnapshot()).toBe(entry.getSnapshot());

    unsubscribe();
    store.dispose();
  });

  it('keeps the last-known-good value continuous while the watch is only temporarily down', async () => {
    // The finding's exact shape: canonical reads still recover bytes while the
    // invalidation channel cannot open. Recovery must reuse the SAME entry
    // without ever dropping the value it already admitted.
    let watchOnline = false;
    let deliver: ((event: ResourceSubscriptionEvent) => void) | null = null;
    const readResource = vi.fn(async () => onlineValue);
    const watchResource = vi.fn(async (
      _resource: unknown,
      listener: (event: ResourceSubscriptionEvent) => void,
    ): Promise<Disposable> => {
      if (!watchOnline) {
        throw Object.assign(new Error('The daemon transport is unavailable.'), {
          code: 'unavailable',
          retryable: true,
        });
      }
      deliver = listener;
      return { dispose: vi.fn() };
    });
    const api = {
      version: () => Object.freeze({
        apiVersion: '1.0.0',
        wireVersion: 1,
        methods: ['readResource'],
      }),
      readResource,
      watchResource,
    } as unknown as PluginUiHostApi;
    const store = createPluginUiResourceStore({
      client: createPluginUiHostApiResourceClient(api),
      pluginId: 'acme.preview',
    });
    const entry = store.getEntry('review-summary');
    const observed: (ResourceContent | undefined)[] = [];
    const unsubscribe = entry.subscribe(() => {
      observed.push(entry.getSnapshot().value);
    }, true);

    await vi.waitFor(() => {
      expect(entry.getSnapshot()).toMatchObject({
        value: onlineValue,
        subscription: 'reconnecting',
      });
    });

    watchOnline = true;
    await vi.waitFor(
      () => { expect(entry.getSnapshot().subscription).toBe('live'); },
      { timeout: 4_000 },
    );
    expect(entry.getSnapshot()).toMatchObject({
      value: onlineValue,
      digest: onlineValue.digest,
      freshness: 'fresh',
      pending: 'idle',
    });
    expect(store.getEntry('review-summary').getSnapshot()).toBe(entry.getSnapshot());

    // No admitted value was ever withdrawn on the way back to live: a recovery
    // that rebuilt the entry or cleared it would show a hole here.
    const firstAdmitted = observed.findIndex((value) => value !== undefined);
    expect(firstAdmitted).toBeGreaterThanOrEqual(0);
    expect(observed.slice(firstAdmitted).every((value) => value === onlineValue)).toBe(true);

    // The recovered channel is the real one: its events drive this entry.
    deliver?.({ version: 1, subscriptionId: 'sub-1', kind: 'invalidated', digest: onlineValue.digest });
    await vi.waitFor(() => { expect(readResource.mock.calls.length).toBeGreaterThan(1); });

    unsubscribe();
    store.dispose();
  });

  it('never promotes a watch to live after a terminal event raced its establishment', async () => {
    // The SDK client flushes everything buffered before its acknowledgement
    // BEFORE `watchResource` resolves, so a terminal arm can reach the store
    // while establishment is still in flight. Freshness must stay monotonic:
    // the subscription ends, and the late physical handle is released.
    const disposeWatch = vi.fn();
    const api = {
      version: () => Object.freeze({
        apiVersion: '1.0.0',
        wireVersion: 1,
        methods: ['readResource', 'watchResource'],
      }),
      readResource: vi.fn(async () => onlineValue),
      watchResource: vi.fn(async (
        _resource: unknown,
        listener: (event: ResourceSubscriptionEvent) => void,
      ): Promise<Disposable> => {
        listener({
          version: 1,
          subscriptionId: 'sub-1',
          kind: 'error',
          code: 'expired_resource',
          diagnostics: ['stale_generation'],
        });
        return { dispose: disposeWatch };
      }),
    } as unknown as PluginUiHostApi;
    const client = createPluginUiHostApiResourceClient(api);
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const observed: string[] = [];
    const unsubscribe = entry.subscribe(() => {
      observed.push(entry.getSnapshot().subscription);
    }, true);

    await vi.waitFor(() => {
      expect(disposeWatch).toHaveBeenCalledTimes(1);
    });
    expect(entry.getSnapshot().subscription).toBe('ended');
    expect(observed).not.toContain('live');

    unsubscribe();
    store.dispose();
  });

  it('keeps a host that genuinely cannot watch permanently unsupported', async () => {
    const readResource = vi.fn(async () => onlineValue);
    const watchResource = vi.fn(async () => {
      throw Object.assign(new Error('watching is not installed for this mount'), {
        code: 'unsupported_method',
        retryable: false,
      });
    });
    const api = {
      version: () => Object.freeze({
        apiVersion: '1.0.0',
        wireVersion: 1,
        methods: ['readResource'],
      }),
      readResource,
      watchResource,
    } as unknown as PluginUiHostApi;
    const store = createPluginUiResourceStore({
      client: createPluginUiHostApiResourceClient(api),
      pluginId: 'acme.preview',
    });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => undefined, true);

    await vi.waitFor(() => {
      expect(entry.getSnapshot()).toMatchObject({
        value: onlineValue,
        freshness: 'fresh',
        pending: 'idle',
        subscription: 'unsupported',
      });
    });

    // A structural refusal is remembered: no retry loop, no second attempt.
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    expect(watchResource.mock.calls.length).toBeLessThanOrEqual(1);
    expect(entry.getSnapshot().subscription).toBe('unsupported');

    unsubscribe();
    store.dispose();
  });
});
