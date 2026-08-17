import type {
  PluginUiHostApi,
  ResourceContent,
  ResourceSubscriptionEvent,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import type { Disposable } from '@happier-dev/plugin-sdk';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  usePluginHostApi,
  useLivePluginResource,
  usePluginResource,
  type PluginUiResourceSnapshot,
} from './index.js';
import {
  PluginHostApiProvider,
  createPluginUiResourceStore,
  type PluginUiResourceClient,
} from '../advanced/index.js';
import { PluginHostApiProviderInternal } from './context.js';
import { createSurfaceContext } from '../surfaceFixture.testSupport.js';

const resourceRef = { pluginId: 'acme.preview', localId: 'review-summary' } as const;

const surfaceContextFixture: SurfaceContext = createSurfaceContext({
  mount: {
    kind: 'destination',
    destination: { pluginId: 'acme.preview', localId: 'review-summary' },
    container: 'detailsTab',
  },
  target: { kind: 'session', sessionId: 'session-1' },
  locale: 'en',
  colorScheme: 'light',
  targetedContributions: {
    target: {
      pluginId: 'acme.preview',
      immutableGenerationId: 'resource-store-test',
    },
    points: [],
  },
});

function createHostApiStub(overrides: Partial<PluginUiHostApi> = {}) {
  let resource: ResourceContent = {
    contentType: 'application/json',
    digest: `sha256:${'1'.repeat(64)}`,
    bytes: new TextEncoder().encode('{"status":"ready"}'),
  };

  const api: PluginUiHostApi = {
    version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }),
    context: vi.fn(async () => surfaceContextFixture),
    watchContext: vi.fn(async (): Promise<Disposable> => ({ dispose: vi.fn() })),
    executeAction: vi.fn(async () => null),
    readResource: vi.fn(async () => resource),
    statOpenableContent: vi.fn(async () => { throw new Error('unsupported_host_method'); }),
    readOpenableContent: vi.fn(async () => { throw new Error('unsupported_host_method'); }),
    watchResource: vi.fn(async () => { throw new Error('unsupported_host_method'); }),
    openSurface: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    diagnostic: vi.fn(),
    readClipboard: vi.fn(async () => ''),
    writeClipboard: vi.fn(async () => undefined),
    openExternalLink: vi.fn(async () => undefined),
    ...overrides,
  } as PluginUiHostApi;

  return {
    api,
    setResource(nextResource: ResourceContent) {
      resource = nextResource;
    },
  };
}

function createAccountLifetime() {
  let current = true;
  const cancellations = new Set<() => void>();
  return {
    lifetime: {
      isCurrent: () => current,
      onRetire(cancel: () => void) {
        if (!current) {
          cancel();
          return { dispose: () => {} };
        }
        cancellations.add(cancel);
        return { dispose: () => { cancellations.delete(cancel); } };
      },
    },
    retire() {
      if (!current) return;
      current = false;
      for (const cancel of [...cancellations]) cancel();
      cancellations.clear();
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe('plugin host API hooks', () => {
  it('accepts a minimal bound Resource client without a Surface host facade', async () => {
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => ({
        contentType: 'application/json',
        digest: `sha256:${'9'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"session":"a"}'),
      })),
      watchResource: vi.fn(async () => ({ dispose: vi.fn() })),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const observed: PluginUiResourceSnapshot[] = [];
    const admitted = deferred<void>();
    const unsubscribe = entry.subscribe(() => {
      const snapshot = entry.getSnapshot();
      observed.push(snapshot);
      if (snapshot.freshness === 'fresh') admitted.resolve();
    }, true);

    await act(async () => { await admitted.promise; });

    expect(client.readResource).toHaveBeenCalledWith({
      pluginId: 'acme.preview',
      localId: 'review-summary',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.watchResource).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)).toMatchObject({
      freshness: 'fresh',
      subscription: 'live',
    });

    unsubscribe();
    store.dispose();
  });

  it('reads canonical Resource bytes while a live watch admission is still pending', async () => {
    const watchAdmission = deferred<Disposable>();
    const calls: string[] = [];
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => {
        calls.push('read');
        return {
          contentType: 'application/json',
          digest: `sha256:${'8'.repeat(64)}`,
          bytes: new TextEncoder().encode('{"session":"a"}'),
        };
      }),
      watchResource: vi.fn(async () => {
        calls.push('watch');
        return await watchAdmission.promise;
      }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const baselineAdmitted = deferred<void>();
    const unsubscribe = entry.subscribe(() => {
      if (entry.getSnapshot().freshness === 'fresh') baselineAdmitted.resolve();
    }, true);

    // A watch carries invalidations only. Its admission must not become the
    // sole route to the authoritative Resource snapshot: a pending transport
    // open still has to show the mounted Resource's current bytes.
    expect(calls).toEqual(['watch', 'read']);

    await act(async () => {
      await baselineAdmitted.promise;
    });
    expect(entry.getSnapshot()).toMatchObject({
      freshness: 'fresh',
      subscription: 'establishing',
    });

    await act(async () => {
      watchAdmission.resolve({ dispose: vi.fn() });
      await Promise.resolve();
    });
    // Establishment remains a level-triggered re-sync boundary even when the
    // independent baseline read has already completed.
    expect(calls).toEqual(['watch', 'read', 'read']);

    unsubscribe();
    store.dispose();
  });

  it('does not reread when contextual watch admission confirms the in-flight baseline digest', async () => {
    const digest = `sha256:${'3'.repeat(64)}`;
    const watchAdmission = deferred<Disposable & Readonly<{ admittedDigest?: string }>>();
    const calls: string[] = [];
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => {
        calls.push('read');
        return {
          contentType: 'application/json',
          digest,
          bytes: new TextEncoder().encode('{"session":"confirmed"}'),
        };
      }),
      watchResource: vi.fn(async () => {
        calls.push('watch');
        return await watchAdmission.promise;
      }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const admitted = deferred<void>();
    const unsubscribe = entry.subscribe(() => {
      const snapshot = entry.getSnapshot();
      if (snapshot.subscription === 'live' && snapshot.freshness === 'fresh') admitted.resolve();
    }, true);

    await act(async () => { await Promise.resolve(); });
    expect(calls).toEqual(['watch', 'read']);

    await act(async () => {
      watchAdmission.resolve({ dispose: vi.fn(), admittedDigest: digest });
      await admitted.promise;
    });

    // The known admission digest proves this in-flight canonical read already
    // crossed the watch's resynchronization boundary. A different digest must
    // still queue the normal second read.
    expect(calls).toEqual(['watch', 'read']);

    unsubscribe();
    store.dispose();
  });

  it('rereads canonical Resource bytes when an existing static entry gains its first live subscriber', async () => {
    const watchAdmission = deferred<Disposable>();
    const calls: string[] = [];
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => {
        calls.push('read');
        return {
          contentType: 'application/json',
          digest: `sha256:${'4'.repeat(64)}`,
          bytes: new TextEncoder().encode('{"session":"static-to-live"}'),
        };
      }),
      watchResource: vi.fn(async () => {
        calls.push('watch');
        return await watchAdmission.promise;
      }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const staticRead = deferred<void>();
    const unsubscribeStatic = entry.subscribe(() => {
      if (entry.getSnapshot().freshness === 'fresh') staticRead.resolve();
    }, false);
    let unsubscribeLive: (() => void) | undefined;

    try {
      await act(async () => { await staticRead.promise; });
      expect(calls).toEqual(['read']);

      unsubscribeLive = entry.subscribe(() => {}, true);

      // A first live subscriber activates the invalidation channel, but that
      // new lifecycle must not make the existing static snapshot its only
      // authoritative read while admission is pending.
      expect(calls).toEqual(['read', 'watch', 'read']);
    } finally {
      unsubscribeLive?.();
      unsubscribeStatic();
      watchAdmission.resolve({ dispose: vi.fn() });
      store.dispose();
    }
  });

  it('retries a transient initial watch-open failure without discarding last-known-good Resource bytes', async () => {
    vi.useFakeTimers();
    try {
      const lastKnownGood: ResourceContent = {
        contentType: 'application/json',
        digest: `sha256:${'7'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"status":"last-known-good"}'),
      };
      const recovered: ResourceContent = {
        contentType: 'application/json',
        digest: `sha256:${'6'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"status":"recovered"}'),
      };
      const recoveryRead = deferred<ResourceContent>();
      let reads = 0;
      const client: PluginUiResourceClient = {
        readResource: vi.fn(async () => {
          reads += 1;
          return reads === 1 ? lastKnownGood : await recoveryRead.promise;
        }),
        watchResource: vi.fn()
          .mockRejectedValueOnce(Object.assign(new Error('temporary transport failure'), {
            code: 'plugin_resource_transport_error',
          }))
          .mockResolvedValueOnce({ dispose: vi.fn() }),
      };
      const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
      const entry = store.getEntry('review-summary');
      const baseline = deferred<void>();
      const unsubscribeBaseline = entry.subscribe(() => {
        if (entry.getSnapshot().freshness === 'fresh') baseline.resolve();
      }, false);
      await act(async () => { await baseline.promise; });
      unsubscribeBaseline();

      const recoveredSnapshot = deferred<void>();
      const unsubscribeLive = entry.subscribe(() => {
        const snapshot = entry.getSnapshot();
        if (snapshot.subscription === 'live' && snapshot.digest === recovered.digest) recoveredSnapshot.resolve();
      }, true);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(entry.getSnapshot()).toMatchObject({
        value: lastKnownGood,
        digest: lastKnownGood.digest,
        freshness: 'stale',
        subscription: 'reconnecting',
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(client.watchResource).toHaveBeenCalledTimes(2);

      await act(async () => {
        recoveryRead.resolve(recovered);
        await recoveredSnapshot.promise;
      });
      expect(entry.getSnapshot()).toMatchObject({
        value: recovered,
        digest: recovered.digest,
        freshness: 'fresh',
        subscription: 'live',
      });

      unsubscribeLive();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an initial watch-open retry when its Account lifetime retires', async () => {
    vi.useFakeTimers();
    try {
      const account = createAccountLifetime();
      const client: PluginUiResourceClient = {
        readResource: vi.fn(async () => new Promise<ResourceContent>(() => {})),
        watchResource: vi.fn(async () => {
          throw Object.assign(new Error('temporary transport failure'), {
            code: 'plugin_resource_transport_error',
          });
        }),
      };
      const store = createPluginUiResourceStore({
        client,
        accountLifetime: account.lifetime,
        pluginId: 'acme.preview',
      });
      const entry = store.getEntry('review-summary');
      entry.subscribe(() => {
      }, true);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(entry.getSnapshot().subscription).toBe('reconnecting');

      account.retire();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(client.watchResource).toHaveBeenCalledTimes(1);
      expect(entry.getSnapshot()).toMatchObject({
        freshness: 'unknown',
        subscription: 'ended',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a terminal initial watch-open failure', async () => {
    vi.useFakeTimers();
    try {
      const client: PluginUiResourceClient = {
        readResource: vi.fn(async () => new Promise<ResourceContent>(() => {})),
        watchResource: vi.fn(async () => {
          throw Object.assign(new Error('generation is stale'), {
            code: 'plugin_generation_stale',
            retryable: false,
          });
        }),
      };
      const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
      const entry = store.getEntry('review-summary');
      const unsubscribe = entry.subscribe(() => {}, true);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(entry.getSnapshot().subscription).toBe('ended');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(client.watchResource).toHaveBeenCalledTimes(1);

      unsubscribe();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads canonical bytes when a terminal live watch admission fails', async () => {
    const value: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'c'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"snapshot-after-terminal-watch"}'),
    };
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => value),
      watchResource: vi.fn(async () => {
        throw Object.assign(new Error('generation is stale'), {
          code: 'plugin_generation_stale',
          retryable: false,
        });
      }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const unsubscribe = entry.subscribe(() => {}, true);

    await vi.waitFor(() => {
      expect(entry.getSnapshot().subscription).toBe('ended');
    });

    // A watch carries invalidations only. Even a settled admission failure
    // cannot suppress the canonical snapshot read for this mounted store.
    expect(client.readResource).toHaveBeenCalledTimes(1);
    expect(entry.getSnapshot()).toMatchObject({
      value,
      digest: value.digest,
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'ended',
    });

    unsubscribe();
    store.dispose();
  });

  it('rereads once after its last live consumer remounts without losing unsupported truth', async () => {
    const value: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'d'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"unsupported-remount"}'),
    };
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => value),
      watchResource: vi.fn(async () => {
        throw Object.assign(new Error('watching is unavailable'), {
          code: 'unsupported_host_method',
          retryable: false,
        });
      }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const firstUnsubscribe = entry.subscribe(() => {}, true);

    await vi.waitFor(() => {
      expect(client.readResource).toHaveBeenCalledTimes(1);
      expect(entry.getSnapshot().subscription).toBe('unsupported');
    });
    firstUnsubscribe();

    // No active watch remains, but this is a capability fact, not a terminal
    // Resource lifecycle state. The mounted store remains the one owner.
    expect(entry.getSnapshot().subscription).toBe('unsupported');

    const secondUnsubscribe = entry.subscribe(() => {}, true);
    await vi.waitFor(() => {
      expect(client.readResource).toHaveBeenCalledTimes(2);
    });
    expect(client.watchResource).toHaveBeenCalledTimes(1);
    expect(entry.getSnapshot()).toMatchObject({
      value,
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'unsupported',
    });

    secondUnsubscribe();
    store.dispose();
  });

  it('keeps last-known-good Resource bytes when the protocol completes a live watch', async () => {
    const value: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'5'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"complete"}'),
    };
    let deliver!: (event: ResourceSubscriptionEvent) => void;
    const dispose = vi.fn();
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => value),
      watchResource: vi.fn(async (_resource, listener) => {
        deliver = listener;
        return { dispose };
      }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('review-summary');
    const baseline = deferred<void>();
    const unsubscribe = entry.subscribe(() => {
      if (entry.getSnapshot().freshness === 'fresh') baseline.resolve();
    }, true);
    await act(async () => { await baseline.promise; });

    await act(async () => {
      deliver({ version: 1, subscriptionId: 'watch-1', kind: 'complete', diagnostics: [] });
    });

    expect(entry.getSnapshot()).toMatchObject({
      value,
      digest: value.digest,
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'ended',
    });
    expect(entry.getSnapshot().error).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.dispose();
  });

  // The removed "exposes the canonical SDK host API identity without a
  // framework-local facade" case only asserted that the `vi.fn()` stub above
  // returned what the same file told it to return, and would have passed
  // against an empty package (plan UI-D23). The architectural claim it borrowed
  // its name from is enforced structurally by `packageBoundary.test.ts`
  // ("does not declare a second PluginUiHostApi or export the host factory").
  it('fails clearly when a host API provider is missing', () => {
    function Probe() {
      usePluginHostApi();
      return null;
    }

    expect(() => {
      act(() => {
        renderer.create(<Probe />);
      });
    }).toThrow(/PluginHostApiProvider/);
  });

  it('keeps a successful snapshot when live watching is unavailable (UI-D05)', async () => {
    const host = createHostApiStub();
    const snapshots: PluginUiResourceSnapshot[] = [];
    let subscribedDuringRender = false;
    let isRendering = false;

    function Probe() {
      isRendering = true;
      const summary = usePluginResource(resourceRef);
      isRendering = false;
      snapshots.push(summary.resource);
      return null;
    }

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });

    expect(subscribedDuringRender).toBe(false);
    expect(host.api.readResource).toHaveBeenCalledWith(resourceRef, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    // The snapshot hook is snapshot-only: it never establishes a subscription.
    expect(host.api.watchContext).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toMatchObject({
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'unsupported',
    });
    expect(snapshots.at(-1)?.value).toMatchObject({ digest: `sha256:${'1'.repeat(64)}` });

    await act(async () => {
      tree?.unmount();
    });
  });

  it('preserves snapshot-only unsupported status across an unobserved remount', async () => {
    const host = createHostApiStub({
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
    });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      snapshots.push(usePluginResource(resourceRef).resource);
      return null;
    }

    function Harness({ mounted }: Readonly<{ mounted: boolean }>) {
      return (
        <PluginHostApiProvider hostApi={host.api}>
          {mounted ? <Probe /> : null}
        </PluginHostApiProvider>
      );
    }

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness mounted />);
    });
    expect(snapshots.at(-1)).toMatchObject({
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'unsupported',
    });

    await act(async () => {
      tree.update(<Harness mounted={false} />);
    });
    await act(async () => {
      tree.update(<Harness mounted />);
    });

    expect(host.api.watchResource).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toMatchObject({
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'unsupported',
    });
  });

  it('re-reads through the snapshot authority on explicit refresh', async () => {
    const host = createHostApiStub();
    let refresh: (() => void) | undefined;
    const digests: string[] = [];

    function Probe() {
      const summary = usePluginResource(resourceRef);
      refresh = summary.refresh;
      if (summary.resource.value) digests.push(summary.resource.value.digest);
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });
    expect(digests).toEqual([`sha256:${'1'.repeat(64)}`]);

    host.setResource({
      contentType: 'application/json',
      digest: `sha256:${'2'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"updated"}'),
    });
    await act(async () => {
      refresh?.();
    });

    expect(host.api.readResource).toHaveBeenCalledTimes(2);
    expect(digests.at(-1)).toBe(`sha256:${'2'.repeat(64)}`);
  });

  it('surfaces a failed initial read without fabricating a value', async () => {
    const host = createHostApiStub({
      readResource: vi.fn(async () => {
        throw Object.assign(new Error('plugin_resource_not_found'), { code: 'plugin_resource_not_found' });
      }),
    });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      const summary = usePluginResource(resourceRef);
      snapshots.push(summary.resource);
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });

    expect(snapshots.at(-1)).toMatchObject({
      freshness: 'unknown',
      pending: 'idle',
      error: { code: 'plugin_resource_not_found' },
      subscription: 'unsupported',
    });
  });

  it('keeps last-known-good bytes and publishes stale/error facts when an explicit refresh fails', async () => {
    const value: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'3'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"ready"}'),
    };
    let failRefresh = false;
    const host = createHostApiStub({
      readResource: vi.fn(async () => {
        if (failRefresh) throw Object.assign(new Error('temporary resource failure'), { code: 'temporary' });
        return value;
      }),
    });
    let refresh: (() => void) | undefined;
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      const summary = usePluginResource(resourceRef);
      refresh = summary.refresh;
      snapshots.push(summary.resource);
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });
    expect(snapshots.at(-1)).toMatchObject({
      value,
      digest: value.digest,
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'unsupported',
    });

    failRefresh = true;
    await act(async () => {
      refresh?.();
    });

    expect(snapshots.at(-1)).toMatchObject({
      value,
      digest: value.digest,
      freshness: 'stale',
      pending: 'idle',
      error: { code: 'temporary' },
      subscription: 'unsupported',
    });
  });

  it('keeps a live hook truthful when watchResource is not advertised', async () => {
    const watchResource: PluginUiHostApi['watchResource'] = vi.fn(async () => ({ dispose: vi.fn() }));
    const host = createHostApiStub({ watchResource });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      snapshots.push(useLivePluginResource(resourceRef).resource);
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });

    expect(watchResource).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toMatchObject({
      freshness: 'fresh',
      pending: 'idle',
      subscription: 'unsupported',
    });
  });

  it('reuses the same Resource entry when React replaces its subscription mode', async () => {
    const watchResource: PluginUiHostApi['watchResource'] = vi.fn(async () => ({ dispose: vi.fn() }));
    const host = createHostApiStub({
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      watchResource,
    });

    function Probe({ live }: Readonly<{ live: boolean }>) {
      const summary = live
        ? useLivePluginResource(resourceRef)
        : usePluginResource(resourceRef);
      return <output data-subscription={summary.resource.subscription} />;
    }

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe live={false} />
        </PluginHostApiProvider>,
      );
    });
    expect(watchResource).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe live />
        </PluginHostApiProvider>,
      );
      await Promise.resolve();
    });

    expect(watchResource).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType('output').props['data-subscription']).toBe('live');
  });

  it('coalesces bare and same-plugin Resource references without aliasing another plugin', async () => {
    const ownerValue: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"owner":true}'),
    };
    const otherValue: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'b'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"owner":false}'),
    };
    let failOwnerRefresh = false;
    const readResource: PluginUiHostApi['readResource'] = vi.fn(async (reference) => {
      const pluginId = typeof reference === 'string' ? 'acme.preview' : reference.pluginId;
      if (pluginId === 'acme.preview' && failOwnerRefresh) {
        throw Object.assign(new Error('temporary resource failure'), { code: 'temporary' });
      }
      return pluginId === 'acme.preview' ? ownerValue : otherValue;
    });
    const watchAdmissions: Array<ReturnType<typeof deferred<Disposable>>> = [];
    const watchResource: PluginUiHostApi['watchResource'] = vi.fn(() => {
      const admission = deferred<Disposable>();
      watchAdmissions.push(admission);
      return admission.promise;
    });
    const host = createHostApiStub({
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      readResource,
      watchResource,
    });
    const snapshots: Array<Readonly<{
      bare: PluginUiResourceSnapshot;
      qualified: PluginUiResourceSnapshot;
      other: PluginUiResourceSnapshot;
    }>> = [];
    let refreshOwner: (() => void) | undefined;
    const admitted = deferred<void>();
    const refreshFailed = deferred<void>();

    function Probe() {
      const bare = useLivePluginResource('review-summary');
      const qualified = useLivePluginResource(resourceRef);
      const other = useLivePluginResource({ pluginId: 'other.plugin', localId: 'review-summary' });
      refreshOwner = bare.refresh;
      if (bare.resource.freshness === 'fresh' && other.resource.freshness === 'fresh') {
        admitted.resolve();
      }
      if (bare.resource.error?.code === 'temporary') refreshFailed.resolve();
      snapshots.push({
        bare: bare.resource,
        qualified: qualified.resource,
        other: other.resource,
      });
      return null;
    }

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProviderInternal
          hostApi={host.api}
          accountLifetime={null}
          resourceStoreGeneration="generation-a"
          mountedPluginId="acme.preview"
        >
          <Probe />
        </PluginHostApiProviderInternal>,
      );
    });

    // The two qualified entries establish independent invalidation watches,
    // while their canonical baseline reads proceed without waiting for either
    // admission. The local spelling is normalized before both boundaries.
    expect(watchResource).toHaveBeenCalledTimes(2);
    expect(readResource).toHaveBeenCalledTimes(2);
    expect(readResource.mock.calls.map(([reference]) => reference)).toEqual([
      resourceRef,
      { pluginId: 'other.plugin', localId: 'review-summary' },
    ]);
    await act(async () => {
      for (const admission of watchAdmissions) admission.resolve({ dispose: vi.fn() });
      await admitted.promise;
    });

    const admittedSnapshots = snapshots.at(-1);
    if (!admittedSnapshots) throw new Error('Expected Resource snapshots after admission.');
    expect(readResource).toHaveBeenCalledTimes(4);
    // A settled watch is a level-triggered resync boundary. The two public
    // spellings still share one entry and one canonical identity for each
    // read/watch pair.
    expect(readResource.mock.calls.map(([reference]) => reference)).toEqual([
      resourceRef,
      { pluginId: 'other.plugin', localId: 'review-summary' },
      resourceRef,
      { pluginId: 'other.plugin', localId: 'review-summary' },
    ]);
    expect(watchResource.mock.calls.map(([reference]) => reference)).toEqual([
      resourceRef,
      { pluginId: 'other.plugin', localId: 'review-summary' },
    ]);
    expect(admittedSnapshots.bare).toBe(admittedSnapshots.qualified);
    expect(admittedSnapshots.bare.value).toBe(ownerValue);
    expect(admittedSnapshots.other).not.toBe(admittedSnapshots.bare);
    expect(admittedSnapshots.other.value).toBe(otherValue);

    failOwnerRefresh = true;
    await act(async () => {
      refreshOwner?.();
      await refreshFailed.promise;
    });

    const failed = snapshots.at(-1);
    if (!failed) throw new Error('Expected Resource snapshots after refresh.');
    expect(readResource).toHaveBeenCalledTimes(5);
    expect(failed.bare).toBe(failed.qualified);
    expect(failed.bare).toMatchObject({
      value: ownerValue,
      digest: ownerValue.digest,
      freshness: 'stale',
      pending: 'idle',
      error: { code: 'temporary' },
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it('re-reads canonical bytes when an invalidation repeats the fresh digest', async () => {
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const watchResource: PluginUiHostApi['watchResource'] = async (_resource, listener) => {
      deliver = listener;
      return { dispose: vi.fn() };
    };
    const firstValue: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'d'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"first"}'),
    };
    const currentValue: { value: ResourceContent } = { value: firstValue };
    const readResource = vi.fn(async () => currentValue.value);
    const host = createHostApiStub({
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      watchResource,
      readResource,
    });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      snapshots.push(useLivePluginResource(resourceRef).resource);
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });
    const before = snapshots.at(-1);
    if (!before || !deliver) throw new Error('Expected a live Resource subscription.');
    const readsBeforeInvalidation = readResource.mock.calls.length;
    const currentValueAfterInvalidation: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'e'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"current"}'),
    };
    currentValue.value = currentValueAfterInvalidation;

    await act(async () => {
      deliver({
        version: 1,
        subscriptionId: 'subscription-1',
        kind: 'invalidated',
        digest: before.digest!,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readResource).toHaveBeenCalledTimes(readsBeforeInvalidation + 1);
    expect(snapshots.at(-1)).toMatchObject({
      value: currentValueAfterInvalidation,
      digest: currentValueAfterInvalidation.digest,
      freshness: 'fresh',
      pending: 'idle',
    });
  });

  it('does not publish a semantic update when that duplicate-digest reread is identical', async () => {
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const watchResource: PluginUiHostApi['watchResource'] = async (_resource, listener) => {
      deliver = listener;
      return { dispose: vi.fn() };
    };
    const value: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'f'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"unchanged"}'),
    };
    const readResource = vi.fn(async () => value);
    const host = createHostApiStub({
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      watchResource,
      readResource,
    });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      snapshots.push(useLivePluginResource(resourceRef).resource);
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });
    const before = snapshots.at(-1);
    const renderCount = snapshots.length;
    if (!before || !deliver) throw new Error('Expected a live Resource subscription.');
    const readsBeforeInvalidation = readResource.mock.calls.length;

    await act(async () => {
      deliver({
        version: 1,
        subscriptionId: 'subscription-1',
        kind: 'invalidated',
        digest: before.digest!,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readResource).toHaveBeenCalledTimes(readsBeforeInvalidation + 1);
    expect(snapshots).toHaveLength(renderCount);
    expect(snapshots.at(-1)).toBe(before);
  });

  it('keeps an admitted snapshot stable across coalesced duplicate-digest wakeups', async () => {
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const watchResource: PluginUiHostApi['watchResource'] = async (_resource, listener) => {
      deliver = listener;
      return { dispose: vi.fn() };
    };
    const value: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'g'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"status":"unchanged"}'),
    };
    const firstReread = deferred<ResourceContent>();
    const firstRereadStarted = deferred<void>();
    let deferNextRead = false;
    const readResource = vi.fn(() => {
      if (deferNextRead) {
        deferNextRead = false;
        firstRereadStarted.resolve();
        return firstReread.promise;
      }
      return Promise.resolve(value);
    });
    const host = createHostApiStub({
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      watchResource,
      readResource,
    });
    const snapshots: PluginUiResourceSnapshot[] = [];
    const baselineAdmitted = deferred<void>();

    function Probe() {
      const resource = useLivePluginResource(resourceRef).resource;
      snapshots.push(resource);
      if (resource.freshness === 'fresh') baselineAdmitted.resolve();
      return null;
    }

    await act(async () => {
      renderer.create(
        <PluginHostApiProvider hostApi={host.api}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });
    // useSyncExternalStore subscribes from React's effect phase. Waiting for
    // the baseline inside the mounting act deadlocks that phase before the
    // Resource owner is allowed to establish its watch/read pair.
    await act(async () => {
      await baselineAdmitted.promise;
    });
    const before = snapshots.at(-1);
    const renderCount = snapshots.length;
    if (!before || !deliver) throw new Error('Expected a live Resource subscription.');
    const readsBeforeInvalidations = readResource.mock.calls.length;
    // A React subscription replacement may perform another initial read while
    // establishing the live store. Delay the first *invalidation* reread, not
    // a numerically assumed baseline call, so this regression tests the
    // Resource owner's coalescing contract rather than renderer timing.
    deferNextRead = true;

    await act(async () => {
      deliver({
        version: 1,
        subscriptionId: 'subscription-1',
        kind: 'invalidated',
        digest: before.digest!,
      });
      await firstRereadStarted.promise;
      deliver({
        version: 1,
        subscriptionId: 'subscription-1',
        kind: 'invalidated',
        digest: before.digest!,
      });
      firstReread.resolve(value);
      // Let the first reread settle and schedule the single coalesced follow-up
      // without making this regression wait indefinitely when that owner loses
      // the pending wakeup.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The two same-digest wakeups coalesce into one in-flight reread plus one
    // convergence reread, irrespective of renderer-owned baseline timing.
    expect(readResource).toHaveBeenCalledTimes(readsBeforeInvalidations + 2);
    expect(snapshots).toHaveLength(renderCount);
    expect(snapshots.at(-1)).toBe(before);
  });

  it('does not let a late Account-A read publish into an Account-B/generation store', async () => {
    const accountA = createAccountLifetime();
    const accountB = createAccountLifetime();
    const accountARead = deferred<ResourceContent>();
    const accountBValue: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'b'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"account":"b"}'),
    };
    let readCount = 0;
    const host = createHostApiStub({
      readResource: vi.fn(() => {
        readCount += 1;
        return readCount === 1 ? accountARead.promise : Promise.resolve(accountBValue);
      }),
    });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      snapshots.push(usePluginResource(resourceRef).resource);
      return null;
    }

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProviderInternal
          hostApi={host.api}
          accountLifetime={accountA.lifetime}
          resourceStoreGeneration="generation-a"
        >
          <Probe />
        </PluginHostApiProviderInternal>,
      );
    });

    await act(async () => {
      accountA.retire();
      tree?.update(
        <PluginHostApiProviderInternal
          hostApi={host.api}
          accountLifetime={accountB.lifetime}
          resourceStoreGeneration="generation-b"
        >
          <Probe />
        </PluginHostApiProviderInternal>,
      );
    });
    await act(async () => {
      accountARead.resolve({
        contentType: 'application/json',
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"account":"a"}'),
      });
      await Promise.resolve();
    });

    expect(snapshots.some((snapshot) => snapshot.digest === `sha256:${'a'.repeat(64)}`)).toBe(false);
    expect(snapshots.at(-1)).toMatchObject({
      digest: accountBValue.digest,
      freshness: 'fresh',
      pending: 'idle',
    });
  });

  it('does not alias an identical Resource reference across bound host-API lifetimes', async () => {
    const account = createAccountLifetime();
    const hostARead = deferred<ResourceContent>();
    const hostA = createHostApiStub({ readResource: vi.fn(() => hostARead.promise) });
    const hostBValue: ResourceContent = {
      contentType: 'application/json',
      digest: `sha256:${'c'.repeat(64)}`,
      bytes: new TextEncoder().encode('{"host":"b"}'),
    };
    const hostB = createHostApiStub({ readResource: vi.fn(async () => hostBValue) });
    const snapshots: PluginUiResourceSnapshot[] = [];

    function Probe() {
      snapshots.push(usePluginResource(resourceRef).resource);
      return null;
    }

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProviderInternal
          hostApi={hostA.api}
          accountLifetime={account.lifetime}
          resourceStoreGeneration="generation-a"
        >
          <Probe />
        </PluginHostApiProviderInternal>,
      );
    });

    await act(async () => {
      tree?.update(
        <PluginHostApiProviderInternal
          hostApi={hostB.api}
          accountLifetime={account.lifetime}
          resourceStoreGeneration="generation-a"
        >
          <Probe />
        </PluginHostApiProviderInternal>,
      );
    });
    await act(async () => {
      hostARead.resolve({
        contentType: 'application/json',
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"host":"a"}'),
      });
      await Promise.resolve();
    });

    expect(snapshots.some((snapshot) => snapshot.digest === `sha256:${'a'.repeat(64)}`)).toBe(false);
    expect(snapshots.at(-1)).toMatchObject({
      digest: hostBValue.digest,
      freshness: 'fresh',
      pending: 'idle',
    });
  });
});
