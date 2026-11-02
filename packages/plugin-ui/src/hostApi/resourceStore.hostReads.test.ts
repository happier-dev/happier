import { describe, expect, it, vi } from 'vitest';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey } from './resourceStore.js';

const content = (digest: string): ResourceContent => ({ contentType: 'application/json', digest,
  bytes: new TextEncoder().encode(JSON.stringify({ digest })) });

describe('host reads in the canonical Resource store', () => {
  it.each(['unavailable', 'unsupported_method'])('refreshes retained bytes when resumed watch admission is %s', async code => {
    let current = content('first');
    let watchFailure = false;
    let reads = 0;
    const store = createPluginUiResourceStore({ client: {
      readResource: async () => { reads++; return current; },
      watchResource: async () => {
        if (watchFailure) throw Object.assign(new Error('Watch unavailable'), { code, retryable: code === 'unavailable' });
        return { admittedDigest: current.digest, dispose() {} };
      },
    } });
    const entry = store.getEntry('status');
    let release = entry.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
      await vi.waitFor(() => expect(entry.getSnapshot().digest).toBe('first'));
      release();
      current = content('changed-while-hidden');
      watchFailure = true;
      release = entry.subscribe(() => {}, true);
      await vi.waitFor(() => expect(entry.getSnapshot().digest).toBe(current.digest));
      expect(reads).toBe(2);
    } finally { release(); store.dispose(); }
  });

  it('reuses retained bytes only after resumed watch admission confirms their digest', async () => {
    let current = content('first');
    let reads = 0;
    let admit: (() => void) | undefined;
    const store = createPluginUiResourceStore({ client: {
      readResource: async () => { reads++; return current; },
      watchResource: async () => new Promise(resolve => { admit = () => resolve({ admittedDigest: current.digest, dispose() {} }); }),
    } });
    const entry = store.getEntry({ hostRead: 'machines.services.list', input: { serverId: 'home', machineId: 'machine' } });
    let release = entry.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(entry.getSnapshot().digest).toBe('first'));
      admit!();
      await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
      expect(reads).toBe(1);
      const baseline = entry.getSnapshot().value;
      release();
      release = entry.subscribe(() => {}, true);
      expect(entry.getSnapshot()).toMatchObject({ value: baseline, subscription: 'establishing' });
      expect(reads, 'a retained live remount waits for existing digest admission instead of rereading').toBe(1);
      admit!();
      await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
      expect(reads).toBe(1);
      expect(entry.getSnapshot().value).toBe(baseline);
      release();
      current = content('changed-while-hidden');
      release = entry.subscribe(() => {}, true);
      admit!();
      await vi.waitFor(() => expect(entry.getSnapshot().digest).toBe(current.digest));
      expect(reads).toBe(2);
    } finally { release(); store.dispose(); }
  });

  it('publishes one settled state for equal reads queued behind an in-flight invalidation', async () => {
    const reads: { resolve(value: ResourceContent): void }[] = [];
    let push: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const store = createPluginUiResourceStore({ client: {
      readResource: async () => new Promise(resolve => reads.push({ resolve })),
      watchResource: async (_reference, listener) => { push = listener; return { admittedDigest: 'baseline', dispose() {} }; },
    } });
    const entry = store.getEntry('status');
    const states: string[] = [];
    const release = entry.subscribe(() => states.push(entry.getSnapshot().pending), true);
    try {
      reads[0]!.resolve(content('baseline'));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      const baseline = reads.length;
      const before = entry.getSnapshot().value;
      states.length = 0;
      const signal = () => push!({ version: 1, subscriptionId: 'status', kind: 'invalidated', digest: 'unknown' });
      const requested = entry.refresh();
      let settled = false;
      void requested.then(() => { settled = true; });
      for (let index = 0; index < 30; index++) signal();
      reads.at(-1)!.resolve(content('baseline'));
      await vi.waitFor(() => expect(reads).toHaveLength(baseline + 2));
      expect.soft(entry.getSnapshot().pending, 'queued work has not settled yet').toBe('refresh');
      expect.soft(settled, 'refresh completion includes the queued convergence read').toBe(false);
      reads.at(-1)!.resolve(content('baseline'));
      await expect(requested).resolves.toMatchObject({ pending: 'idle' });
      expect(states, 'equal queued reads must not produce idle/refresh feedback').toEqual(['refresh', 'idle']);
      expect(entry.getSnapshot().value).toBe(before);
      expect(reads).toHaveLength(baseline + 2);
      // A queued invalidation still crosses the canonical read boundary: its
      // digest alone cannot prove that a later real change is absent.
      signal();
      signal();
      reads.at(-1)!.resolve(content('baseline'));
      await vi.waitFor(() => expect(reads).toHaveLength(baseline + 4));
      reads.at(-1)!.resolve(content('changed'));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(entry.getSnapshot().digest).toBe('changed');
    } finally { release(); store.dispose(); }
  });

  it('coalesces pushes behind one read but lets an explicit superseding refresh cancel it', async () => {
    const reads: { signal?: AbortSignal; resolve(value: ResourceContent): void }[] = [];
    let push: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const store = createPluginUiResourceStore({ client: {
      readResource: async (_reference, options) => new Promise(resolve => reads.push({ signal: options?.signal, resolve })),
      watchResource: async (_reference, listener) => { push = listener; return { admittedDigest: 'baseline', dispose() {} }; },
    } });
    const entry = store.getEntry({ hostRead: 'usage.query', input: { queries: [{}] } });
    const release = entry.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(push).toBeDefined());
      reads[0]!.resolve(content('baseline'));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      const baseline = reads.length;
      const signal = () => push!({ version: 1, subscriptionId: 'usage', kind: 'invalidated', digest: 'changed' });
      signal();
      for (let index = 0; index < 30; index++) signal();
      expect(reads).toHaveLength(baseline + 1);
      expect(reads.at(-1)!.signal?.aborted).toBe(false);
      reads.at(-1)!.resolve(content('intermediate'));
      await vi.waitFor(() => expect(reads).toHaveLength(baseline + 2));
      reads.at(-1)!.resolve(content('latest'));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(entry.getSnapshot().digest).toBe('latest');
      expect(reads).toHaveLength(baseline + 2);

      signal();
      const retired = reads.at(-1)!;
      for (let index = 0; index < 30; index++) signal();
      const retry = entry.refresh({ supersede: true });
      expect.soft(retired.signal?.aborted, 'Recovery cancels the active read immediately').toBe(true);
      expect.soft(reads, 'Recovery consumes the queued wakes with one replacement').toHaveLength(baseline + 4);
      // Also resolve the retired boundary to distinguish cancellation from a queued refresh.
      retired.resolve(content('retired'));
      await vi.waitFor(() => expect(reads).toHaveLength(baseline + 4));
      reads.at(-1)!.resolve(content('retry'));
      await expect(retry).resolves.toMatchObject({ digest: 'retry', pending: 'idle' });
      expect(reads).toHaveLength(baseline + 4);
    } finally { release(); store.dispose(); }
  });

  it('keeps a reopened deployment stage source and a different step out of retained log bytes', async () => {
    const reference = { hostRead: 'deployments.logs' as const, input: { serverId: 'home', environmentId: 'environment',
      deploymentId: 'deployment', targetLinkId: 'target', machineId: 'machine', installationId: 'installation',
      kind: 'build' as const, ref: 'build', tail: true as const }, sourceRevision: 'first-source' };
    const store = createPluginUiResourceStore({ client: { async readResource(selected) {
      if (typeof selected === 'string' || !('hostRead' in selected) || selected.hostRead !== 'deployments.logs')
        throw new Error('Expected the exact deployment stage at the transport boundary');
      return content(`${selected.input.ref}/${selected.sourceRevision}`);
    } } });
    try {
      const first = store.getEntry(reference);
      await first.refresh();
      const reopened = store.getEntry({ ...reference, sourceRevision: 'reopened-source' });
      const other = store.getEntry({ ...reference, input: { ...reference.input, ref: 'cleanup' } });
      expect(reopened.getSnapshot().value).toBeUndefined();
      expect(other.getSnapshot().value).toBeUndefined();
      await reopened.refresh();
      await other.refresh();
      expect(first.getSnapshot().digest).toBe('build/first-source');
      expect(reopened.getSnapshot().digest).toBe('build/reopened-source');
      expect(other.getSnapshot().digest).toBe('cleanup/first-source');
    } finally { store.dispose(); }
  });

  it('does not borrow log bytes from a replaced native owner or source', async () => {
    const reference = { hostRead: 'machines.services.logs' as const,
      input: { serverId: 'home', machineId: 'machine', serviceId: 'worker' },
      expectedGeneration: 'first-owner', sourceRevision: 'first-source' };
    const store = createPluginUiResourceStore({ client: { async readResource(selected) {
      if (typeof selected === 'string' || !('hostRead' in selected) || selected.hostRead !== 'machines.services.logs') {
        throw new Error('Expected the native log reference at the transport boundary');
      }
      return content(`${selected.expectedGeneration}/${selected.sourceRevision}`);
    } } });
    try {
      const first = store.getEntry(reference);
      await first.refresh();
      const replacedOwner = store.getEntry({ ...reference, expectedGeneration: 'replacement-owner' });
      const replacedSource = store.getEntry({ ...reference, sourceRevision: 'replacement-source' });
      expect(replacedOwner.getSnapshot().value).toBeUndefined();
      expect(replacedSource.getSnapshot().value).toBeUndefined();
      await replacedOwner.refresh();
      await replacedSource.refresh();
      expect(first.getSnapshot().digest).toBe('first-owner/first-source');
      expect(replacedOwner.getSnapshot().digest).toBe('replacement-owner/first-source');
      expect(replacedSource.getSnapshot().digest).toBe('first-owner/replacement-source');
    } finally { store.dispose(); }
  });

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
