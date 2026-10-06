import { describe, expect, it } from 'vitest';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { PluginDeclarativeDocumentV1Schema } from '@happier-dev/protocol';
import { readPluginResourceStoreSnapshot } from './pluginSurfaceResourceRead';
import { projectDeclarativeDataResourceSnapshot } from './declarativeDataSource';

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
