import { describe, expect, it, vi } from 'vitest';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiResourceStore, isPluginUiResourceReadAuthorityLost, type PluginUiResourceClient, type PluginUiResourceProjection } from './resourceStore.js';

type Status = Readonly<{ status: Readonly<{ state: string }>; checkedAt: number }>;
const content = (state: string, checkedAt: number): ResourceContent => ({ contentType: 'application/json',
  digest: `${state}:${checkedAt}`, bytes: new TextEncoder().encode(JSON.stringify({ state, checkedAt })) });

function createProjection() {
  const decode = vi.fn((value: ResourceContent, previous: Status | undefined): Status => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value.bytes));
    if (!parsed || typeof parsed !== 'object' || !('state' in parsed) || typeof parsed.state !== 'string'
      || !('checkedAt' in parsed) || typeof parsed.checkedAt !== 'number') throw new Error('Invalid status');
    return { status: previous?.status.state === parsed.state ? previous.status : { state: parsed.state }, checkedAt: parsed.checkedAt };
  });
  return { projection: { decode } satisfies PluginUiResourceProjection<Status>, decode };
}

describe('shared typed Resource projections', () => {
  it('marks unhinted typed invalidations stale and retains fresh presentation only for the admitted identity', async () => {
    const identity = {};
    const value: ResourceContent = { contentType: 'application/json',
      get digest() { throw new Error('Typed invalidation must not prepare a digest'); },
      get bytes() { throw new Error('Typed invalidation must not prepare bytes'); } };
    let push: Parameters<NonNullable<PluginUiResourceClient['watchResource']>>[1] | undefined;
    let resolveRead: ((value: ResourceContent) => void) | undefined;
    let hold = false;
    let readCount = 0;
    const store = createPluginUiResourceStore({ client: {
      contentIdentity: () => identity,
      readResource: async () => {
        readCount++;
        return hold ? new Promise<ResourceContent>(resolve => { resolveRead = resolve; }) : value;
      },
      watchResource: async (_reference, listener) => {
        push = listener;
        return { admittedIdentity: identity, dispose() {} };
      },
    } });
    const entry = store.getEntry('status');
    const presentation = () => {
      const { freshness, pending } = entry.getSnapshot();
      return { freshness, pending };
    };
    let release = () => {};
    try {
      await entry.refresh();
      release = entry.subscribe(() => {}, true);
      await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
      hold = true;
      push!({ kind: 'invalidated' });
      expect(presentation()).toEqual({ freshness: 'stale', pending: 'refresh' });
      resolveRead!(value);
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      push!({ kind: 'invalidated', contentIdentity: identity });
      expect(presentation()).toEqual({ freshness: 'fresh', pending: 'idle' });
      expect(readCount, 'each invalidation must reread even when its presentation hint matches').toBe(3);
      resolveRead!(value);
    } finally { release(); store.dispose(); }
  });

  it('publishes same-process admitted identities without reading transport bytes or digests', async () => {
    let revision = { state: 'running' };
    const revisions = new WeakMap<ResourceContent, object>();
    let byteReads = 0;
    let digestReads = 0;
    const makeContent = (): ResourceContent => {
      const value = { contentType: 'application/json',
        get digest() { digestReads++; return 'transport-digest'; },
        get bytes() { byteReads++; return new Uint8Array(); } };
      revisions.set(value, revision);
      return value;
    };
    let push: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const readResource = vi.fn(async () => makeContent());
    const store = createPluginUiResourceStore({ client: { readResource,
      contentIdentity: value => revisions.get(value),
      watchResource: async (_reference, listener) => {
        push = listener;
        return { admittedIdentity: revision, dispose() {} };
      },
    } });
    const entry = store.getEntry('status');
    let release = () => {};
    try {
      await entry.refresh();
      const first = entry.getSnapshot().value;
      expect({ byteReads, digestReads }).toEqual({ byteReads: 0, digestReads: 0 });
      const published = vi.fn();
      const selected = entry.select({ decode: value => revisions.get(value) }, snapshot => snapshot.value);
      selected.getSnapshot();
      release = selected.subscribe(published, true);
      await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
      expect(readResource).toHaveBeenCalledTimes(1);
      published.mockClear();
      await entry.refresh();
      expect(entry.getSnapshot().value).toBe(first);
      expect(published).not.toHaveBeenCalled();
      revision = { state: 'passed' };
      push!({ version: 1, subscriptionId: 'status', kind: 'invalidated', digest: 'changed' });
      await vi.waitFor(() => expect(entry.getSnapshot().value !== first).toBe(true));
      expect(entry.getSnapshot().pending).toBe('idle');
      expect(published).toHaveBeenCalledTimes(1);
      expect({ byteReads, digestReads }).toEqual({ byteReads: 0, digestReads: 0 });
    } finally { release(); store.dispose(); }
  });

  it('only decodes demanded snapshots and shares each demanded model across selectors', async () => {
    let current = content('running', 1);
    let denied = false;
    const store = createPluginUiResourceStore({ client: { readResource: async () => {
      if (denied) throw Object.assign(new Error('Denied'), { code: 'denied' });
      return current;
    } } });
    const { projection, decode } = createProjection();
    const entry = store.getEntry('status');
    const first = entry.select(projection, snapshot => snapshot.value);
    const second = entry.select(projection, snapshot => snapshot.value?.status);
    try {
      await entry.refresh();
      expect(decode).not.toHaveBeenCalled();
      expect(first.getSnapshot()?.status.state).toBe('running');
      expect(second.getSnapshot()).toBe(first.getSnapshot()?.status);
      expect(decode).toHaveBeenCalledTimes(1);
      current = content('passed', 2);
      await entry.refresh();
      expect(decode).toHaveBeenCalledTimes(1);
      expect(second.getSnapshot()?.state).toBe('passed');
      expect(first.getSnapshot()?.checkedAt).toBe(2);
      expect(decode).toHaveBeenCalledTimes(2);
      denied = true;
      await entry.refresh();
      denied = false;
      current = content('passed', 3);
      await entry.refresh();
      // Even without a read during denial, a replacement cannot inherit the
      // typed baseline from the withdrawn authority.
      expect(first.getSnapshot()?.checkedAt).toBe(3);
      expect(decode).toHaveBeenLastCalledWith(current, undefined);
    } finally { store.dispose(); }
  });

  it('settles a refused replacement admission without retrying or revealing expired values', async () => {
    vi.useFakeTimers();
    const oldContent = content('running', 1);
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    let retired = false;
    const readResource = vi.fn(async () => {
      if (retired) throw Object.assign(new Error('Unavailable'), { code: 'unavailable', retryable: false });
      return oldContent;
    });
    const watchResource = vi.fn(async (_ref: unknown, listener: (event: ResourceSubscriptionEvent) => void) => {
      if (retired) throw Object.assign(new Error('Expired'), { code: 'expired_resource', retryable: false });
      deliver = listener;
      return { admittedDigest: oldContent.digest, dispose() {} };
    });
    const store = createPluginUiResourceStore({ client: { readResource, watchResource } });
    const { projection } = createProjection();
    const entry = store.getEntry('status');
    const selected = entry.select(projection, snapshot => snapshot.value?.status);
    const release = selected.subscribe(() => {}, true);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(selected.getSnapshot()?.state).toBe('running');
      retired = true;
      deliver!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
      expect(selected.getSnapshot()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(selected.getSnapshot()).toBeUndefined();
      expect(entry.getSnapshot()).toMatchObject({ pending: 'idle', subscription: 'ended' });
      expect(readResource).toHaveBeenCalledTimes(2);
      expect(watchResource).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); store.dispose(); vi.useRealTimers(); }
  });

  it('withdraws expired bytes and typed baselines immediately while preserving ordinary invalidation values', async () => {
    const oldContent = content('running', 1);
    const listeners: Array<(event: ResourceSubscriptionEvent) => void> = [];
    const reads: Array<{
      resolve(value: ResourceContent): void;
      reject(error: Error): void;
      signal?: AbortSignal;
      onProgress?(value: ResourceContent): void;
    }> = [];
    let unavailable = false;
    const watchResource = vi.fn(async (_ref: unknown, listener: (event: ResourceSubscriptionEvent) => void) => {
      listeners.push(listener);
      return { admittedDigest: oldContent.digest, dispose() {} };
    });
    const store = createPluginUiResourceStore({ client: {
      readResource: async (_ref, options) => {
        if (unavailable) throw Object.assign(new Error('Replacement unavailable'), { code: 'unavailable', retryable: false });
        return new Promise<ResourceContent>((resolve, reject) => { reads.push({ resolve, reject,
          signal: options?.signal, onProgress: options?.onProgress }); });
      },
      watchResource,
    } });
    const { projection, decode } = createProjection();
    const entry = store.getEntry('status');
    const selected = entry.select(projection, snapshot => snapshot.value?.status);
    const notify = vi.fn();
    const release = selected.subscribe(notify, true);
    try {
      reads[0]!.resolve(oldContent);
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      const oldValue = selected.getSnapshot();
      expect(oldValue?.state).toBe('running');
      listeners[0]!({ version: 1, subscriptionId: 'initial', kind: 'invalidated', digest: 'ordinary-refresh' });
      expect(entry.getSnapshot().value).toBe(oldContent);
      expect(selected.getSnapshot()).toBe(oldValue);
      reads[1]!.resolve(oldContent);
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      notify.mockClear();

      listeners[0]!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
      expect(entry.getSnapshot().value).toBeUndefined();
      expect(entry.getSnapshot().digest).toBeUndefined();
      expect(selected.getSnapshot()).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(watchResource).toHaveBeenCalledTimes(2);
      expect(reads).toHaveLength(3);
      expect(entry.getSnapshot().pending).toBe('initial');
      // The replacement is pending, not newly admitted. Its control state
      // cannot erase the loss fact sibling first-page consumers must observe.
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(true);

      unavailable = true;
      reads[2]!.reject(Object.assign(new Error('Replacement unavailable'), { code: 'unavailable', retryable: false }));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(entry.getSnapshot().value).toBeUndefined();
      expect(selected.getSnapshot()).toBeUndefined();
      expect(decode).toHaveBeenCalledTimes(1);
      expect(entry.getSnapshot().error).toMatchObject({ code: 'unavailable', message: 'Replacement unavailable' });
      expect(entry.getSnapshot().error?.diagnostics).toEqual(['expired_resource']);
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(true);
      listeners[1]!({ version: 1, subscriptionId: 'replacement', kind: 'complete' });
      expect(entry.getSnapshot().subscription).toBe('ended');
      expect(entry.getSnapshot().error?.diagnostics).toEqual(['expired_resource']);
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(true);

      unavailable = false;
      const refresh = entry.refresh();
      await vi.waitFor(() => expect(reads).toHaveLength(4));
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(true);
      const progress = content('running', 2);
      reads[3]!.onProgress?.(progress);
      expect(entry.getSnapshot()).toMatchObject({ value: progress, freshness: 'fresh', pending: 'initial' });
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(false);
      reads[3]!.resolve(content('running', 2));
      await refresh;
      expect(decode).toHaveBeenLastCalledWith(expect.anything(), undefined);
      expect(selected.getSnapshot()).not.toBe(oldValue);
      const replacement = selected.getSnapshot();
      const replacementContent = entry.getSnapshot().value;
      const readCount = reads.length;
      listeners[0]!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
      expect(selected.getSnapshot()).toBe(replacement);
      expect(entry.getSnapshot().value).toBe(replacementContent);
      expect(reads).toHaveLength(readCount);
      expect(watchResource).toHaveBeenCalledTimes(2);

      const refused = entry.refresh();
      await vi.waitFor(() => expect(reads).toHaveLength(5));
      reads[4]!.reject(Object.assign(new Error('Read denied'), { code: 'denied' }));
      await refused;
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(true);
      const recoverEmpty = entry.refresh();
      await vi.waitFor(() => expect(reads).toHaveLength(6));
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(true);
      const empty: ResourceContent = { contentType: 'text/plain', digest: 'admitted-empty', bytes: new Uint8Array() };
      reads[5]!.resolve(empty);
      await recoverEmpty;
      expect(entry.getSnapshot()).toMatchObject({ value: empty, freshness: 'fresh', pending: 'idle' });
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(false);
      // Ordinary transport failure still retains the last good admitted value,
      // including a genuinely empty read, without reviving the earlier loss.
      const transportFailure = entry.refresh();
      await vi.waitFor(() => expect(reads).toHaveLength(7));
      reads[6]!.reject(Object.assign(new Error('Transport unavailable'), { code: 'unavailable' }));
      await transportFailure;
      expect(entry.getSnapshot()).toMatchObject({ value: empty, freshness: 'stale',
        error: { code: 'unavailable', message: 'Transport unavailable' } });
      expect(isPluginUiResourceReadAuthorityLost(entry.getSnapshot())).toBe(false);
    } finally { release(); store.dispose(); }
  });

  it('decodes each changed ingress once and publishes only changed selected facts', async () => {
    let current = content('running', 1);
    const readResource = vi.fn(async () => current);
    const store = createPluginUiResourceStore({ client: { readResource } });
    const { projection, decode } = createProjection();
    const entry = store.getEntry('status');
    const first = entry.select(projection, snapshot => snapshot.value?.status);
    const second = store.getEntry('status').select(projection, snapshot => snapshot.value?.status);
    const freshness = entry.select(projection, snapshot => snapshot.value?.checkedAt);
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const releaseA = first.subscribe(notifyA, false);
    const releaseB = second.subscribe(notifyB, false);
    const releaseFreshness = freshness.subscribe(() => {}, false);
    try {
      await vi.waitFor(() => expect(first.getSnapshot()?.state).toBe('running'));
      const admitted = first.getSnapshot();
      expect(second.getSnapshot()).toBe(admitted);
      expect(readResource).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledTimes(1);
      notifyA.mockClear(); notifyB.mockClear();
      current = content('running', 2);
      await first.refresh();
      expect(decode).toHaveBeenCalledTimes(2);
      expect(first.getSnapshot()).toBe(admitted);
      expect(freshness.getSnapshot()).toBe(2);
      expect(notifyA).not.toHaveBeenCalled();
      expect(notifyB).not.toHaveBeenCalled();
      await first.refresh();
      expect(decode).toHaveBeenCalledTimes(2);
      current = content('passed', 3);
      await second.refresh();
      expect(first.getSnapshot()).toEqual({ state: 'passed' });
      expect(notifyA).toHaveBeenCalledTimes(1);
      expect(notifyB).toHaveBeenCalledTimes(1);
    } finally { releaseA(); releaseB(); releaseFreshness(); store.dispose(); }
  });

  it('retains admitted typed values on decode/read failure, clears them on authority loss and retirement', async () => {
    let current = content('running', 1);
    let failure = false;
    let watchListener: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const store = createPluginUiResourceStore({ client: {
      readResource: async () => { if (failure) throw new Error('Offline'); return current; },
      watchResource: async (_ref, listener) => { watchListener = listener; return { admittedDigest: current.digest, dispose() {} }; },
    } });
    const { projection } = createProjection();
    const selected = store.getEntry('status').select(projection, snapshot => snapshot);
    const release = selected.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(selected.getSnapshot().subscription).toBe('live'));
      await vi.waitFor(() => expect(selected.getSnapshot().value).toBeDefined());
      const admitted = selected.getSnapshot().value;
      current = { ...content('bad', 2), bytes: new TextEncoder().encode('{}') };
      await selected.refresh();
      expect(selected.getSnapshot()).toMatchObject({ value: admitted, freshness: 'stale', error: { message: 'Invalid status' } });
      failure = true;
      await selected.refresh();
      expect(selected.getSnapshot()).toMatchObject({ value: admitted, freshness: 'stale', error: { message: 'Offline' } });
      watchListener!({ version: 1, subscriptionId: 'status', kind: 'error', code: 'denied', diagnostics: [], retryable: false });
      expect(selected.getSnapshot().value).toBeUndefined();
      failure = false; current = content('passed', 3);
      await selected.refresh();
      expect(selected.getSnapshot().value?.status.state).toBe('passed');
      store.dispose();
      expect(selected.getSnapshot()).toMatchObject({ freshness: 'unknown', subscription: 'ended' });
      expect(selected.getSnapshot().value).toBeUndefined();
    } finally { release(); store.dispose(); }
  });
});
