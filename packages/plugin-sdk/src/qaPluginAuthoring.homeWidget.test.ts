import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';

it('changes Home widget Resource bytes through an Action and closes invalidation on disposal', async () => {
    const { createHomeWidgetPlugin } = await import('../fixtures/qa-plugin-authoring/qa-home-widget/index.js');
    const module = createHomeWidgetPlugin();
    expect(parsePluginManifest(module.manifest)).toMatchObject({ ok: true });
    const kit = await createPluginTestkit({ manifest: module.manifest, module });
    const resource = kit.registration('resources', 'summary');
    if (!resource) throw new Error('Summary Resource was not registered');
    const controller = new AbortController();
    const options = createTestResourceInvocationContext({ context: { kind: 'global' }, signal: controller.signal });
    const read = async () => JSON.parse(String(await resource.read(options)));
    let invalidations = 0;
    const observer = await resource.observe(() => { invalidations += 1; }, options);
    try {
        expect(await read()).toEqual({ completed: 0, goal: 3 });
        await expect(kit.invokeAction('set-completed', { completed: -1 })).rejects.toBeDefined();
        expect(await kit.invokeAction('set-completed', { completed: 2 })).toEqual({ completed: 2, goal: 3 });
        expect(await read()).toEqual({ completed: 2, goal: 3 });
        expect(invalidations).toBe(1);
        await kit.invokeAction('set-completed', { completed: 2 });
        expect(invalidations).toBe(1);
        await observer.dispose();
        await kit.invokeAction('set-completed', { completed: 0 });
        expect(await read()).toEqual({ completed: 0, goal: 3 });
        expect(invalidations).toBe(1);
        controller.abort();
        expect(() => resource.read(options)).toThrow();
        await kit.dispose();
        await expect(kit.invokeAction('set-completed', { completed: 1 })).rejects.toMatchObject({ code: 'plugin_testkit_disposed' });
    } finally { await observer.dispose(); await kit.dispose(); }
});
