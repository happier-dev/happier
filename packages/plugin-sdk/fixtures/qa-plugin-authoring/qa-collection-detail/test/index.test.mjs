import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createCollectionDetailPlugin } from '../dist/index.js';

test('row completion updates the public Resource and empty rows can be restored', async () => {
    const module = createCollectionDetailPlugin();
    const kit = await createPluginTestkit({ manifest: module.manifest, module });
    const resource = kit.registration('resources', 'rows');
    assert.ok(resource);
    const options = createTestResourceInvocationContext({ context: { kind: 'global' }, signal: new AbortController().signal });
    try {
        assert.equal((await kit.invokeAction('set-complete', { rowId: 'release-guide', completed: true })).ok, true);
        assert.equal(JSON.parse(await resource.read(options)).rows[0].completed, true);
        await kit.invokeAction('clear', {});
        assert.deepEqual(JSON.parse(await resource.read(options)), { rows: [] });
        await kit.invokeAction('restore', {});
        assert.equal(JSON.parse(await resource.read(options)).rows.length, 2);
    } finally { await kit.dispose(); }
});
