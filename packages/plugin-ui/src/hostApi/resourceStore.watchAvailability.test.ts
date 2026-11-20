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
  const recoveryListeners = new Set<() => void>();
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
    onWatchRecovery(listener: () => void) {
      recoveryListeners.add(listener);
      return { dispose() { recoveryListeners.delete(listener); } };
    },
    reconnect() { online = true; for (const listener of [...recoveryListeners]) listener(); },
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
    vi.useFakeTimers();
    const host = createReconnectingHostApi();
    const client = { ...createPluginUiHostApiResourceClient(host.api), onWatchRecovery: host.onWatchRecovery };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => undefined, true);

    // Mounted while the daemon is unreachable: the mount cannot serve the
    // subscription right now, but this is not a capability fact about the host.
    await vi.waitFor(() => {
      expect(entry.getSnapshot().subscription).toBe('reconnecting');
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.watchResource).toHaveBeenCalledTimes(1);

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
    vi.useFakeTimers();
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

    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchResource).toHaveBeenCalledTimes(1);
    watchOnline = true;
    // Explicit Retry is also a recovery signal for public hosts without a
    // host-private reconnect subscription.
    await entry.refresh();
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
    const errors: (string | undefined)[] = [];
    const unsubscribe = entry.subscribe(() => {
      observed.push(entry.getSnapshot().subscription);
      errors.push(entry.getSnapshot().error?.code);
    }, true);

    await vi.waitFor(() => {
      expect(disposeWatch).toHaveBeenCalledTimes(1);
    });
    expect(entry.getSnapshot().subscription).toBe('ended');
    expect(errors).toContain('expired_resource');
    expect(observed).not.toContain('live');
    expect(api.watchResource).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.dispose();
  });

  it('replaces a watch whose read authority retires before acknowledgement and publishes fresh data', async () => {
    let deliverFirst!: (event: ResourceSubscriptionEvent) => void;
    let acknowledgeFirst!: (watch: Disposable) => void;
    const firstWatch = new Promise<Disposable>(resolve => { acknowledgeFirst = resolve; });
    const disposeFirst = vi.fn();
    const disposeReplacement = vi.fn();
    let current = onlineValue;
    const watchResource = vi.fn<(resource: unknown, listener: (event: ResourceSubscriptionEvent) => void) => Promise<Disposable>>()
      .mockImplementationOnce((_resource, listener) => {
        deliverFirst = listener;
        return firstWatch;
      })
      .mockResolvedValue({ dispose: disposeReplacement });
    const store = createPluginUiResourceStore({ client: { readResource: async () => current, watchResource } });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => {}, true);
    const retired: ResourceSubscriptionEvent = { version: 1, subscriptionId: 'sub-1', kind: 'error',
      code: 'expired_resource', diagnostics: ['plugin_read_authority_retired'] };
    try {
      await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({ value: onlineValue, subscription: 'establishing' }));
      current = refreshedValue;
      deliverFirst(retired);
      expect(entry.getSnapshot().value).toBeUndefined();
      deliverFirst(retired);
      acknowledgeFirst({ dispose: disposeFirst });

      await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({
        value: refreshedValue, freshness: 'fresh', pending: 'idle', subscription: 'live',
      }));
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(disposeFirst).toHaveBeenCalledTimes(1);
      expect(watchResource).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  it('reads fresh bytes when watch read authority retires during first open and Refresh', async () => {
    vi.useFakeTimers();
    const listeners: ((event: ResourceSubscriptionEvent) => void)[] = [];
    const activeWatches = new Set<AbortSignal>();
    const releases: (() => void)[] = [];
    let watchCanSettle = false;
    let current = refreshedValue;
    const watchResource = vi.fn(async (_resource: unknown, listener: (event: ResourceSubscriptionEvent) => void,
      options?: { signal?: AbortSignal }) => {
      listeners.push(listener);
      const signal = options!.signal!;
      activeWatches.add(signal);
      signal.addEventListener('abort', () => activeWatches.delete(signal), { once: true });
      if (!watchCanSettle) await new Promise<void>(resolve => releases.push(resolve));
      return { admittedDigest: current.digest, dispose() {} };
    });
    const readResource = vi.fn(async (_resource: unknown, options?: { signal?: AbortSignal }) => {
      if (!watchCanSettle && activeWatches.size > 0) {
        // An old binding can settle after withdrawal. Its bytes must stay private.
        await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return onlineValue;
      }
      return current;
    });
    const store = createPluginUiResourceStore({ client: { readResource, watchResource } });
    const entry = store.getEntry('review-summary');
    const settledValues: ResourceContent[] = [];
    const release = entry.subscribe(() => {
      const snapshot = entry.getSnapshot();
      if (snapshot.value !== undefined && snapshot.pending === 'idle') settledValues.push(snapshot.value);
    }, true);
    const retired = (subscriptionId: string): ResourceSubscriptionEvent => ({ version: 1, subscriptionId,
      kind: 'error', code: 'expired_resource', diagnostics: ['plugin_read_authority_retired'] });
    try {
      listeners[0]!(retired('initial'));
      expect(entry.getSnapshot()).toMatchObject({ pending: 'initial', subscription: 'establishing' });
      listeners[1]!(retired('replacement'));
      await vi.advanceTimersByTimeAsync(0);

      expect(entry.getSnapshot()).toMatchObject({
        value: refreshedValue, freshness: 'fresh', pending: 'idle', subscription: 'reconnecting',
      });
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(watchResource).toHaveBeenCalledTimes(2);

      current = { ...refreshedValue, digest: `sha256:${'c'.repeat(64)}`, bytes: new TextEncoder().encode('{"status":"current"}') };
      const refreshed = entry.refresh({ supersede: true });
      listeners[2]!(retired('refresh'));
      listeners[3]!(retired('refresh-replacement'));
      expect(entry.getSnapshot().value).toBeUndefined();
      expect(await refreshed).toMatchObject({ value: current, pending: 'idle', subscription: 'reconnecting' });
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(settledValues).not.toContain(onlineValue);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(watchResource).toHaveBeenCalledTimes(4);
      expect(readResource).toHaveBeenCalledTimes(6);

      watchCanSettle = true;
      expect(await entry.refresh()).toMatchObject({ value: current, pending: 'idle', subscription: 'live' });
      expect(watchResource).toHaveBeenCalledTimes(5);
    } finally {
      release();
      store.dispose();
      for (const finish of releases) finish();
      vi.useRealTimers();
    }
  });

  it('replaces an established expired watch and delivers replacement data to the same consumer', async () => {
    vi.useFakeTimers();
    let current = onlineValue;
    const listeners: ((event: ResourceSubscriptionEvent) => void)[] = [];
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const readResource = vi.fn(async () => current);
    const watchResource = vi.fn(async (
      _resource: unknown,
      listener: (event: ResourceSubscriptionEvent) => void,
    ): Promise<Disposable> => {
      listeners.push(listener);
      const dispose = vi.fn();
      disposals.push(dispose);
      return { dispose };
    });
    const store = createPluginUiResourceStore({ client: { readResource, watchResource } });
    const entry = store.getEntry('review-summary');
    const values: (ResourceContent | undefined)[] = [];
    const unsubscribe = entry.subscribe(() => { values.push(entry.getSnapshot().value); }, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.getSnapshot()).toMatchObject({ value: onlineValue, subscription: 'live' });

    current = refreshedValue;
    listeners[0]!({ version: 1, subscriptionId: 'sub-1', kind: 'error',
      code: 'expired_resource', diagnostics: ['stale_generation'] });
    expect(entry.getSnapshot().value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.getSnapshot()).toMatchObject({ value: refreshedValue, freshness: 'fresh', subscription: 'live' });
    expect(values).toContain(undefined);
    expect(values.at(-1)).toBe(refreshedValue);
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    expect(watchResource).toHaveBeenCalledTimes(2);

    const readCount = readResource.mock.calls.length;
    listeners[0]!({ version: 1, subscriptionId: 'sub-1', kind: 'invalidated', digest: onlineValue.digest });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readResource).toHaveBeenCalledTimes(readCount);
    expect(watchResource).toHaveBeenCalledTimes(2);
    expect(entry.getSnapshot().value).toBe(refreshedValue);
    unsubscribe();
    store.dispose();
    expect(disposals[1]).toHaveBeenCalledTimes(1);
  });

  it('withdraws authority and rejects a pending read without reopening the watch', async () => {
    vi.useFakeTimers();
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    let finishRead: ((value: ResourceContent) => void) | undefined;
    let readSignal: AbortSignal | undefined;
    let holdRead = false;
    const disposeWatch = vi.fn();
    const readResource: PluginUiHostApi['readResource'] = async (_resource, options) => {
      if (!holdRead) return onlineValue;
      readSignal = options?.signal;
      return new Promise(resolve => { finishRead = resolve; });
    };
    const watchResource = vi.fn(async (
      _resource: unknown,
      listener: (event: ResourceSubscriptionEvent) => void,
    ): Promise<Disposable> => {
      deliver = listener;
      return { dispose: disposeWatch };
    });
    const store = createPluginUiResourceStore({ client: { readResource, watchResource } });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.getSnapshot()).toMatchObject({ value: onlineValue, subscription: 'live' });

    holdRead = true;
    const refreshing = entry.refresh();
    deliver!({ version: 1, subscriptionId: 'sub-1', kind: 'error', code: 'denied', diagnostics: [] });
    expect(readSignal?.aborted).toBe(true);
    expect(entry.getSnapshot()).toMatchObject({ error: { code: 'denied' }, pending: 'idle', subscription: 'ended' });
    expect(entry.getSnapshot().value).toBeUndefined();
    finishRead!(refreshedValue);
    await refreshing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entry.getSnapshot().value).toBeUndefined();
    expect(watchResource).toHaveBeenCalledTimes(1);
    expect(disposeWatch).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispose();
  });

  it('releases a late physical watch when disposed during establishment', async () => {
    vi.useFakeTimers();
    let finishWatch: ((watch: Disposable) => void) | undefined;
    let watchSignal: AbortSignal | undefined;
    const disposeWatch = vi.fn();
    const watchResource: PluginUiHostApi['watchResource'] = vi.fn(async (_resource, _listener, options) => {
      watchSignal = options?.signal;
      return new Promise<Disposable>(resolve => { finishWatch = resolve; });
    });
    const store = createPluginUiResourceStore({ client: { readResource: async () => onlineValue, watchResource } });
    const entry = store.getEntry('review-summary');
    const subscriptions: string[] = [];
    entry.subscribe(() => { subscriptions.push(entry.getSnapshot().subscription); }, true);
    expect(entry.getSnapshot().subscription).toBe('establishing');

    store.dispose();
    expect(watchSignal?.aborted).toBe(true);
    finishWatch!({ dispose: disposeWatch });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(disposeWatch).toHaveBeenCalledTimes(1);
    expect(watchResource).toHaveBeenCalledTimes(1);
    expect(entry.getSnapshot()).toMatchObject({ subscription: 'ended', pending: 'idle' });
    expect(entry.getSnapshot().value).toBeUndefined();
    expect(subscriptions).not.toContain('live');
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

  it.each([
    ['plugin_resource_not_found', 'ended'],
    ['action_forbidden', 'ended'],
    ['plugin_resource_transport_not_supported', 'unsupported'],
    ['unsupported_method', 'unsupported'],
  ] as const)('settles %s admission without reopening an unchanged Resource during an idle minute', async (code, subscription) => {
    vi.useFakeTimers();
    const watchResource = vi.fn(async () => {
      throw Object.assign(new Error('Resource watch refused'), { code, retryable: false });
    });
    const store = createPluginUiResourceStore({ client: { readResource: async () => onlineValue, watchResource } });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.getSnapshot()).toMatchObject({ subscription, pending: 'idle' });
    if (subscription === 'ended') expect(entry.getSnapshot().error).toMatchObject({ code, retryable: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchResource).toHaveBeenCalledTimes(1);
    await entry.refresh();
    expect(watchResource).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispose();
  });
});
