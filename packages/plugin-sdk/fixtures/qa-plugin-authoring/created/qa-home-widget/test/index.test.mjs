import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createHomeWidgetPlugin } from '../dist/index.js';

test('public Action changes the widget Resource without a polling loop', async () => {
    const module = createHomeWidgetPlugin();
    const kit = await createPluginTestkit({ manifest: module.manifest, module });
    const resource = kit.registration('resources', 'summary');
    assert.ok(resource);
    const options = createTestResourceInvocationContext({ context: { kind: 'global' }, signal: new AbortController().signal });
    let invalidations = 0;
    const observer = await resource.observe(() => { invalidations += 1; }, options);
    try {
        await kit.invokeAction('set-completed', { completed: 1 });
        assert.deepEqual(JSON.parse(await resource.read(options)), { completed: 1, goal: 3 });
        assert.equal(invalidations, 1);
    } finally { await observer.dispose(); await kit.dispose(); }
});
