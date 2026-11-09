import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';

it('runs collection row Actions against its live Resource and retires observers', async () => {
    const { createCollectionDetailPlugin } = await import('../fixtures/qa-plugin-authoring/qa-collection-detail/index.js');
    const module = createCollectionDetailPlugin();
    expect(parsePluginManifest(module.manifest)).toMatchObject({ ok: true });
    const kit = await createPluginTestkit({ manifest: module.manifest, module });
    const resource = kit.registration('resources', 'rows');
    if (!resource) throw new Error('Rows Resource was not registered');
    const signal = new AbortController().signal;
    const options = createTestResourceInvocationContext({ context: { kind: 'global' }, signal });
    const read = async () => JSON.parse(String(await resource.read(options)));
    let invalidations = 0;
    const observer = await resource.observe(() => { invalidations += 1; }, options);
    try {
        expect((await read()).rows).toHaveLength(2);
        await expect(kit.invokeAction('set-complete', { rowId: '', completed: true })).rejects.toBeDefined();
        expect(await kit.invokeAction('set-complete', { rowId: 'missing', completed: true }))
            .toEqual({ ok: false, code: 'row_not_found' });
        expect(await kit.invokeAction('set-complete', { rowId: 'release-guide', completed: true }))
            .toMatchObject({ ok: true, row: { id: 'release-guide', completed: true } });
        expect((await read()).rows[0].completed).toBe(true);
        expect(invalidations).toBe(1);
        await kit.invokeAction('set-complete', { rowId: 'release-guide', completed: true });
        expect(invalidations).toBe(1);
        await observer.dispose();
        await kit.invokeAction('clear', {});
        expect(await read()).toEqual({ rows: [] });
        expect(invalidations).toBe(1);
        await kit.invokeAction('restore', {});
        expect((await read()).rows).toHaveLength(2);
        expect((await read()).rows[0].completed).toBe(false);
        await kit.dispose();
        await expect(kit.invokeAction('restore', {})).rejects.toMatchObject({ code: 'plugin_testkit_disposed' });
        expect(() => resource.read(options)).toThrow();
    } finally { await observer.dispose(); await kit.dispose(); }
});
