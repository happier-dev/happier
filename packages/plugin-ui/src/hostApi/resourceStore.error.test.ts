import { describe, expect, it, vi } from 'vitest';

import {
  createPluginUiResourceStore,
  type PluginUiResourceClient,
} from './resourceStore.js';
import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';

describe('plugin UI Resource store read failures', () => {
  it.each(['denied', 'unavailable'] as const)('distinguishes authoritative %s watch-open refusal from a nonretryable transport outage', async (code) => {
    const value = { contentType: 'application/json', digest: 'private', bytes: new TextEncoder().encode('7') };
    let baselineRead = true;
    const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
      // Keep the independent live baseline pending so a later successful read
      // cannot legitimately supersede the watch-open failure under assertion.
      readResource: () => {
        if (baselineRead) { baselineRead = false; return Promise.resolve(value); }
        return new Promise(() => {});
      },
      watchResource: async () => { throw Object.assign(new Error('Watch refused'), { code, retryable: false }); },
    } });
    const entry = store.getEntry('private-metric');
    await entry.refresh();
    const release = entry.subscribe(() => {}, true);
    await vi.waitFor(() => expect(entry.getSnapshot().error?.code).toBe(code));
    expect(entry.getSnapshot().value).toBe(code === 'denied' ? undefined : value);
    expect(entry.getSnapshot().freshness).toBe(code === 'denied' ? 'unknown' : 'stale');
    release();
    store.dispose();
  });

  it.each([
    { code: 'denied', retryable: false },
    { code: 'plugin_resource_session_access_unavailable' },
    { code: 'plugin_resource_context_unavailable' },
    { code: 'plugin_resource_path_denied' },
    { code: 'unavailable', diagnostics: [{ code: 'plugin_generation_stale' }] },
  ])('withdraws private bytes on authoritative read refusal $code and admits a later authorized read', async (failure) => {
    const value = { contentType: 'application/json', digest: 'private', bytes: new TextEncoder().encode('7') };
    let refused = false;
    const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
      readResource: async () => {
        if (refused) throw Object.assign(new Error('Read authority lost'), failure);
        return value;
      },
    } });
    const entry = store.getEntry('private-metric');
    await expect(entry.refresh()).resolves.toMatchObject({ value, freshness: 'fresh' });
    refused = true;
    const withdrawn = await entry.refresh();
    expect(withdrawn.value).toBeUndefined();
    expect(withdrawn.digest).toBeUndefined();
    expect(withdrawn).toMatchObject({ freshness: 'unknown', pending: 'idle', error: { code: failure.code } });
    refused = false;
    await expect(entry.refresh()).resolves.toMatchObject({ value, freshness: 'fresh' });
    store.dispose();
  });

  it.each([
    { code: 'denied', diagnostics: [] },
    { code: 'unavailable', diagnostics: ['plugin_resource_session_access_unavailable'] },
    { code: 'unavailable', diagnostics: ['plugin_resource_context_unavailable'] },
    { code: 'stale_surface', diagnostics: ['plugin_generation_stale'] },
    { code: 'expired_resource', diagnostics: [] },
  ] as const)('withdraws private watch output on $code and rejects a late in-flight read', async (failure) => {
    const value = { contentType: 'application/json', digest: 'private', bytes: new TextEncoder().encode('7') };
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    let finishRead: ((content: typeof value) => void) | undefined;
    let pending = false;
    const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
      readResource: () => pending ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve(value),
      watchResource: async (_resource, listener) => {
        deliver = listener;
        return { admittedDigest: value.digest, dispose() {} };
      },
    } });
    const entry = store.getEntry('private-metric');
    await entry.refresh();
    const release = entry.subscribe(() => {}, true);
    await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
    pending = true;
    const refresh = entry.refresh();
    deliver!({ version: 1, subscriptionId: 'private-watch', kind: 'error', ...failure, diagnostics: [...failure.diagnostics] });
    expect(entry.getSnapshot().value).toBeUndefined();
    expect(entry.getSnapshot().digest).toBeUndefined();
    await expect(refresh).resolves.toMatchObject({ freshness: 'unknown', pending: 'idle', error: { code: failure.code } });
    finishRead!(value);
    await Promise.resolve();
    expect(entry.getSnapshot().value).toBeUndefined();
    pending = false;
    await expect(entry.refresh()).resolves.toMatchObject({ value, freshness: 'fresh' });
    release();
    store.dispose();
  });

  it('retains an already requested read for the first static subscriber without queuing another baseline', async () => {
    const value = { contentType: 'text/plain', digest: 'requested', bytes: new TextEncoder().encode('requested') };
    const reads: Array<{ resolve: (content: typeof value) => void; signal?: AbortSignal }> = [];
    const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
      readResource: (_resource, options) => new Promise(resolve => { reads.push({ resolve, signal: options?.signal }); }),
    } });
    const entry = store.getEntry('live-activity');
    const refresh = entry.refresh();
    const releaseAction = entry.subscribe(() => undefined, false);
    const releaseMount = entry.subscribe(() => undefined, false);
    // The Action's static retention must survive the last physical mount.
    releaseMount();
    expect(reads[0]!.signal?.aborted).toBe(false);
    reads[0]!.resolve(value);
    await expect(refresh).resolves.toMatchObject({ digest: 'requested', freshness: 'fresh', pending: 'idle' });
    await Promise.resolve();
    expect(reads).toHaveLength(1);
    expect(entry.getSnapshot()).toMatchObject({ digest: 'requested', freshness: 'fresh', pending: 'idle' });
    releaseAction();
    store.dispose();
  });

  it('acknowledges the requested reread only after its shared snapshot settles', async () => {
    const makeValue = (digest: string) => ({ contentType: 'text/plain', digest, bytes: new TextEncoder().encode(digest) });
    const reads: Array<{
      resolve: (value: ReturnType<typeof makeValue>) => void;
      reject: (error: Error) => void;
    }> = [];
    // The daemon read is the genuine asynchronous boundary; the store and its
    // shared entry/queued-read lifecycle remain real.
    const client: PluginUiResourceClient = {
      readResource: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const first = store.getEntry('live-activity');
    const second = store.getEntry({ pluginId: 'acme.preview', localId: 'live-activity' });
    const releaseFirst = first.subscribe(() => undefined, false);
    const releaseSecond = second.subscribe(() => undefined, false);
    let acknowledged = false;
    const refresh = first.refresh();
    expect(refresh).toBeInstanceOf(Promise);
    void Promise.resolve(refresh).then(() => { acknowledged = true; });
    reads[0]!.resolve(makeValue('baseline'));
    await vi.waitFor(() => { expect(reads).toHaveLength(2); });
    expect(acknowledged).toBe(false);
    reads[1]!.resolve(makeValue('refreshed'));
    await expect(refresh).resolves.toMatchObject({ digest: 'refreshed', freshness: 'fresh', pending: 'idle' });
    expect(second.getSnapshot()).toBe(first.getSnapshot());

    const failedRefresh = second.refresh();
    reads[2]!.reject(Object.assign(new Error('Resource unavailable'), { code: 'unavailable' }));
    await expect(failedRefresh).resolves.toMatchObject({
      digest: 'refreshed', freshness: 'stale', pending: 'idle', error: { code: 'unavailable' },
    });
    releaseFirst();
    releaseSecond();
    store.dispose();
  });

  it('settles outstanding acknowledgements without publishing retired or unobserved reads', async () => {
    const reads: Array<{ resolve: (value: { contentType: string; digest: string; bytes: Uint8Array }) => void; signal?: AbortSignal }> = [];
    const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
      readResource: (_resource, options) => new Promise(resolve => { reads.push({ resolve, signal: options?.signal }); }),
    } });
    const entry = store.getEntry('live-activity');
    const release = entry.subscribe(() => undefined, false);
    const queuedRefresh = entry.refresh();
    release();
    await expect(queuedRefresh).resolves.toMatchObject({ pending: 'idle', error: { code: 'plugin_resource_aborted' } });
    expect(reads[0]!.signal?.aborted).toBe(true);
    reads[0]!.resolve({ contentType: 'text/plain', digest: 'late-unobserved', bytes: new Uint8Array() });
    await Promise.resolve();
    expect(entry.getSnapshot().digest).toBeUndefined();

    const releaseAgain = entry.subscribe(() => undefined, false);
    const retiredRefresh = entry.refresh();
    store.dispose();
    await expect(retiredRefresh).resolves.toMatchObject({ pending: 'idle', error: { code: 'plugin_surface_retired' } });
    expect(reads[1]!.signal?.aborted).toBe(true);
    reads[1]!.resolve({ contentType: 'text/plain', digest: 'late-retired', bytes: new Uint8Array() });
    await Promise.resolve();
    expect(entry.getSnapshot().digest).toBeUndefined();
    releaseAgain();
  });

  it('preserves the mounted Resource failure discriminator instead of collapsing unavailable branches', async () => {
    const readResource = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Resource is not declared for this plugin'), {
        code: 'unavailable',
        // Hosted-web requests arrive through the SDK client transport, whose
        // typed wire diagnostics carry the machine-readable branch in `code`.
        diagnostics: [{ code: 'plugin_resource_not_found', severity: 'error' }],
      }))
      .mockRejectedValueOnce(Object.assign(new Error('The daemon transport is unavailable'), {
        code: 'unavailable',
        diagnostics: [{ code: 'plugin_resource_transport_error', severity: 'error' }],
      }));
    const client: PluginUiResourceClient = { readResource };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('live-activity');
    const unsubscribe = entry.subscribe(() => undefined, false);

    await vi.waitFor(() => {
      expect(entry.getSnapshot().error).toEqual({
        code: 'unavailable',
        diagnostics: ['plugin_resource_not_found'],
        message: 'Resource is not declared for this plugin',
      });
    });

    entry.refresh();
    await vi.waitFor(() => {
      // Both mounted failures use the public `unavailable` envelope. The
      // author-facing store must retain the exact protocol diagnostic so a
      // declaration failure cannot be presented as an offline transport error.
      expect(entry.getSnapshot().error).toEqual({
        code: 'unavailable',
        diagnostics: ['plugin_resource_transport_error'],
        message: 'The daemon transport is unavailable',
      });
    });

    unsubscribe();
    store.dispose();
  });
});
