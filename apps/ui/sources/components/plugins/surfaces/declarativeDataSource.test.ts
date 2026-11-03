import { describe, expect, it, vi } from 'vitest';
import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { PluginDeclarativeDocumentV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring';
import { readPluginResourceStoreSnapshot } from './pluginSurfaceResourceRead';
import { projectDeclarativeDataResourceSnapshot } from './declarativeDataSource';

describe('Resource natural-read recovery', () => {
    const fresh = { contentType: 'application/json', digest: 'fresh', bytes: new TextEncoder().encode('{}') };

    it.each([false, true])('re-acquires retained expiry through the existing loader (explicit refresh: %s)', async (refresh) => {
        let expired = true;
        // Resource acquisition is the external boundary; both shared owners stay real.
        const readResource = vi.fn(async () => {
            if (expired) throw Object.assign(new Error('Expired read authority'), { code: 'expired_resource', retryable: false });
            return fresh;
        });
        const store = createPluginUiResourceStore({ client: { readResource } });
        const entry = store.getEntry('native-pr');
        const release = entry.subscribe(() => {}, false);
        try {
            await vi.waitFor(() => expect(entry.getSnapshot().error?.code).toBe('expired_resource'));
            expired = false;
            const recovered = await readPluginResourceStoreSnapshot(entry, undefined, refresh);
            expect(recovered.error).toBeUndefined();
            expect(recovered.value?.digest).toBe('fresh');
            expect(readResource).toHaveBeenCalledTimes(2);
        } finally { release(); store.dispose(); }
    });

    it('lets a dependent natural read await replacement instead of settling transient expiry', async () => {
        let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
        const store = createPluginUiResourceStore({ client: {
            readResource: async () => fresh,
            watchResource: async (_ref, listener) => {
                deliver = listener;
                return { admittedDigest: fresh.digest, dispose() {} };
            },
        } });
        const entry = store.getEntry('native-pr');
        let dependent: ReturnType<typeof readPluginResourceStoreSnapshot> | undefined;
        const release = entry.subscribe(() => {
            if (entry.getSnapshot().error?.code === 'expired_resource' && !dependent) {
                dependent = readPluginResourceStoreSnapshot(entry);
            }
        }, true);
        try {
            await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
            deliver!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
            expect(dependent).toBeDefined();
            const result = await dependent;
            expect(result?.error).toBeUndefined();
            expect(result?.value?.digest).toBe('fresh');
        } finally { release(); store.dispose(); }
    });

    it.each(['denied', 'collection_update_required'])('keeps a permanent %s refusal settled on natural reads', async (code) => {
        const readResource = vi.fn(async () => {
            throw Object.assign(new Error('Read refused'), { code, retryable: false });
        });
        const store = createPluginUiResourceStore({ client: { readResource } });
        const entry = store.getEntry('native-pr');
        const release = entry.subscribe(() => {}, false);
        try {
            await vi.waitFor(() => expect(entry.getSnapshot().error?.code).toBe(code));
            const refused = await readPluginResourceStoreSnapshot(entry);
            expect(refused.error?.code).toBe(code);
            expect(refused.value).toBeUndefined();
            expect(readResource).toHaveBeenCalledTimes(1);
        } finally { release(); store.dispose(); }
    });
});

describe('declarative Resource data projection', () => {
    it('reads real Resource bytes, retains authorized values on read failure and removes retired output', async () => {
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'com.acme.checks', localId: 'summary' },
                inputSchema: { type: 'object', additionalProperties: false }, input: {},
                outputSchema: { type: 'object', properties: { count: { type: 'number' }, token: { type: 'string' } }, required: ['count'], additionalProperties: false } },
            value: { path: ['count'], type: 'number' } } });
        if (document.root.kind !== 'metric') throw new Error('Expected metric');
        const node = document.root;
        let failed = false;
        // This is the real network/client boundary; store, read lifecycle and projection remain real.
        const store = createPluginUiResourceStore({ pluginId: 'com.acme.checks', client: { readResource: async () => {
            if (failed) throw Object.assign(new Error('Machine asleep'), { code: 'unavailable', retryable: false });
            return { contentType: 'application/json', digest: 'v1', bytes: new TextEncoder().encode(JSON.stringify({ count: 7, token: 'private' })) };
        } } });
        const entry = store.getEntry(node.data.kind === 'resource' ? node.data.resource : 'never');
        const initial = await readPluginResourceStoreSnapshot(entry);
        expect(initial.error).toBeUndefined();
        expect(initial.value?.contentType).toBe('application/json');
        expect(new TextDecoder('utf-8', { fatal: true }).decode(initial.value!.bytes)).toBe('{"count":7,"token":"private"}');
        expect(projectDeclarativeDataResourceSnapshot(node, initial, true).node).toMatchObject({ data: { kind: 'value', value: 7 } });
        failed = true;
        const refreshed = await entry.refresh();
        expect(projectDeclarativeDataResourceSnapshot(node, refreshed, true)).toMatchObject({ node: { data: { value: 7 } }, freshness: 'stale', errorCode: 'unavailable' });
        const good = projectDeclarativeDataResourceSnapshot(node, initial, true);
        const malformed = { ...initial, digest: 'invalid', value: { ...initial.value!, digest: 'invalid',
            bytes: new TextEncoder().encode('{"count":"wrong"}') } };
        const retained = projectDeclarativeDataResourceSnapshot(node, malformed, true, good);
        expect(retained).toMatchObject({ node: { data: { value: 7 } }, digest: 'v1', freshness: 'stale', errorCode: 'declarative_data_output_invalid' });
        expect(retained.node).toBe(good.node);
        expect(projectDeclarativeDataResourceSnapshot(node, malformed, false, good).node).toBeNull();
        expect(projectDeclarativeDataResourceSnapshot(node, { freshness: 'unknown', pending: 'idle', subscription: 'ended',
            error: { code: 'denied', message: 'Read denied' } }, true, good).node).toBeNull();
        store.dispose();
        expect(projectDeclarativeDataResourceSnapshot(node, entry.getSnapshot(), false).node).toBeNull();
    });
});
