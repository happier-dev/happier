import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as module from '../dist/index.js';

test('Action writes invalidate the live Resource and disposed readers stay quiet', async () => {
    const plugin = await createPluginTestkit({ manifest: module.manifest, module });
    const controller = new AbortController();
    const options = createTestResourceInvocationContext({ signal: controller.signal, context: { kind: 'global' } });
    let observer;
    try {
        const resource = plugin.registration('resources', 'document');
        assert.ok(resource);
        await plugin.invokeAction('document-write', { text: '' });
        let invalidations = 0;
        observer = await resource.observe(() => { invalidations += 1; }, options);
        for (const surface of ['ui', 'agent', 'cli', 'mcp']) {
            const text = `Review notes from ${surface}`;
            assert.deepEqual(await plugin.invokeAction('document-write', { text }, { surface }), { text });
            assert.equal(await resource.read(options), text);
        }
        assert.equal(invalidations, 4);
        await plugin.invokeAction('document-write', { text: 'Review notes from mcp' });
        assert.equal(invalidations, 4);
        await assert.rejects(plugin.invokeAction('document-write', { text: false }));
        await observer.dispose(); await observer.dispose();
        await plugin.invokeAction('document-write', { text: '' });
        assert.equal(await resource.read(options), '');
        assert.equal(invalidations, 4);
        controller.abort();
        assert.throws(() => resource.read(options));
    } finally {
        await observer?.dispose(); controller.abort(); await plugin.dispose();
    }
});
