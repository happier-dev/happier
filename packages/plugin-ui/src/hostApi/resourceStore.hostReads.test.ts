import { describe, expect, it, vi } from 'vitest';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey } from './resourceStore.js';

const content = (digest: string): ResourceContent => ({ contentType: 'application/json', digest,
  bytes: new TextEncoder().encode(JSON.stringify({ digest })) });

describe('host reads in the canonical Resource store', () => {
  it('admits intermediate bytes into the same pending entry and refuses late progress after authority withdrawal', async () => {
    let publishProgress: ((value: ResourceContent) => void) | undefined;
    let finish: ((value: ResourceContent) => void) | undefined;
    let invalidate: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const store = createPluginUiResourceStore({ client: {
      readResource: async (_reference, options) => {
        publishProgress = options?.onProgress;
        return new Promise(resolve => { finish = resolve; });
      },
      watchResource: async (_reference, listener) => { invalidate = listener; return { dispose() {} }; },
    } });
    const entry = store.getEntry({ hostRead: 'usage.query', input: { queries: [{}] } });
    const release = entry.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
      const first = content('first');
      publishProgress?.(first);
      expect(entry.getSnapshot()).toMatchObject({ value: first, freshness: 'fresh', pending: 'initial' });
      publishProgress!(content('first'));
      expect(entry.getSnapshot().value).toBe(first);
      invalidate!({ version: 1, subscriptionId: 'host', kind: 'error', code: 'denied', diagnostics: [], retryable: false });
      expect(entry.getSnapshot().value).toBeUndefined();
      publishProgress!(content('late-progress'));
      finish!(content('late-final'));
      await Promise.resolve();
      expect(entry.getSnapshot()).toMatchObject({ pending: 'idle', error: { code: 'denied' } });
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { release(); store.dispose(); }
  });

  it('shares equivalent host requests while keeping Action and plugin identities separate', async () => {
    const store = createPluginUiResourceStore({ pluginId: 'acme', client: {
      readResource: async reference => content(pluginUiResourceReferenceKey(reference, 'acme')),
    } });
    const first = store.getEntry({ hostRead: 'usage.query', input: { queries: [{ period: { startMs: 0, endMs: 1 }, metric: 'tokens' }] } });
    const equivalent = store.getEntry({ hostRead: 'usage.query', input: { queries: [{ metric: 'tokens', period: { endMs: 1, startMs: 0 } }] } });
    const other = store.getEntry({ hostRead: 'usage.query', input: { queries: [{ period: { startMs: 0, endMs: 2 }, metric: 'tokens' }] } });
    const quota = store.getEntry({ hostRead: 'connectedServices.quota.get', input: { queries: [{ period: { startMs: 0, endMs: 1 }, metric: 'tokens' }] } });
    const plugin = store.getEntry({ pluginId: 'usage.query', localId: 'undefined' });
    await expect(first.refresh()).resolves.toMatchObject({ freshness: 'fresh' });
    expect(first.getSnapshot()).toBe(equivalent.getSnapshot());
    expect(first.getSnapshot()).not.toBe(other.getSnapshot());
    expect(first.getSnapshot()).not.toBe(quota.getSnapshot());
    expect(first.getSnapshot()).not.toBe(plugin.getSnapshot());
    await expect(plugin.refresh()).resolves.toMatchObject({ freshness: 'fresh' });
    expect(first.getSnapshot().digest).not.toBe(plugin.getSnapshot().digest);
    store.dispose();
  });

  it('progresses shared subscribers, retains failed refresh values, and blocks completion after retirement', async () => {
    let current = content('first');
    let fail = false;
    let finish: ((value: ResourceContent) => void) | undefined;
    let held = false;
    let retire: (() => void) | undefined;
    let active = true;
    let invalidate: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const store = createPluginUiResourceStore({ accountLifetime: {
      isCurrent: () => active, onRetire: listener => { retire = listener; return { dispose() {} }; },
    }, client: {
      readResource: async () => {
        if (fail) throw new Error('Offline');
        if (held) return new Promise(resolve => { finish = resolve; });
        return current;
      },
      watchResource: async (_reference, listener) => {
        invalidate = listener;
        return { admittedDigest: current.digest, dispose() {} };
      },
    } });
    const entry = store.getEntry({ hostRead: 'usage.query', input: { queries: [{}] } });
    await entry.refresh();
    const releaseA = entry.subscribe(() => {}, true);
    const releaseB = entry.subscribe(() => {}, true);
    await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
    current = content('next');
    invalidate!({ version: 1, subscriptionId: 'host', kind: 'invalidated', digest: current.digest });
    await vi.waitFor(() => expect(entry.getSnapshot().value).toBe(current));
    fail = true;
    await expect(entry.refresh()).resolves.toMatchObject({ value: current, freshness: 'stale', error: { message: 'Offline' } });
    fail = false;
    held = true;
    const refresh = entry.refresh();
    active = false;
    retire!();
    await refresh;
    finish!(content('late'));
    await Promise.resolve();
    expect(entry.getSnapshot().value).toBeUndefined();
    expect(entry.getSnapshot().pending).toBe('idle');
    releaseA(); releaseB(); store.dispose();
  });
});
