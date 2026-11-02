import { expect, it } from 'vitest';
import * as sdk from '@happier-dev/plugin-sdk';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from './manifest.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from './testing/host.js';
import { createExternalStoreKind } from '../examples/public-authoring/storeKinds.js';

it('creates a listing URL preserving the qualified kind and item selection', () => {
    const createHref = Reflect.get(sdk, 'createPluginStoreItemHref');
    expect(createHref).toBeTypeOf('function');
    const selection = { type: 'storeKind', kind: 'com.example.store/extension', sourceId: 'source',
        itemId: 'publisher/item', version: '1.2.3' };
    const url = new URL(createHref(selection), 'https://happier.example');
    expect(url.pathname).toBe('/plugins/listing');
    expect(JSON.parse(url.searchParams.get('selection')!)).toEqual(selection);
});

it('runs the public Store fixture parser, preparation, acquisition and installed lifecycle through Actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-store-kind-'));
    const path = join(directory, 'theme.json');
    // The filesystem is the genuine external persistence boundary; Actions and parsing remain real.
    const plugin = createExternalStoreKind({
        read: async () => { try { return sdk.PluginStoreItemV1ProtocolSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
            catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; } },
        write: async item => { await writeFile(path, JSON.stringify(item)); },
        remove: async () => { await rm(path, { force: true }); },
    });
    // The author may expose the same Store Actions to CLI callers, as in the loaded R5 recipe.
    const admission = parsePluginManifest({ ...plugin.manifest, contributes: { ...plugin.manifest.contributes,
        actions: plugin.manifest.contributes.actions.map(action => ({ ...action, surfaces: [...action.surfaces, 'cli'] })),
    } });
    expect(admission.ok, JSON.stringify(admission.ok ? [] : admission.diagnostics)).toBe(true);
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const invoke = (id: Parameters<typeof kit.invokeAction>[0], input: Parameters<typeof kit.invokeAction>[1]) =>
        kit.invokeAction(id, input, { surface: 'plugin' });
    try {
        expect(await invoke('list', { query: 'ocean' })).toMatchObject([{ itemId: 'ocean' }]);
        expect(await invoke('list', { query: 'missing' })).toEqual([]);
        expect(await invoke('installed', {})).toEqual([]);
        const parsed = sdk.PluginStoreItemV1ProtocolSchema.safeParse(await invoke('read', { url: 'theme://community/ocean' }));
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw parsed.error;
        const prepared = await invoke('prepare', parsed.data);
        expect(prepared).toMatchObject({ sourceId: 'community', itemId: 'ocean', value: { background: '#123456' } });
        await expect(invoke('prepare', { ...parsed.data, value: { unsupported: true } }))
            .rejects.toThrow();
        expect(await invoke('acquire', prepared)).toMatchObject({ installed: true });
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(prepared);
        expect(await invoke('installed', {})).toMatchObject([{ itemId: 'ocean', installed: true }]);
        expect(await invoke('manage', {})).toEqual([]);
        expect(await invoke('installed', {})).toEqual([]);
    } finally { await kit.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('reports missing write confirmation through the canonical public author manifest validator', () => {
    const plugin = createExternalStoreKind({ read: async () => null, write: async () => {}, remove: async () => {} });
    for (const id of ['acquire', 'manage']) {
        const result = parsePluginManifest({ ...plugin.manifest, contributes: { ...plugin.manifest.contributes,
            actions: plugin.manifest.contributes.actions.map(action => {
                if (action.id !== id) return action;
                const { confirmation, ...withoutConfirmation } = action;
                return { ...withoutConfirmation, surfaces: [...action.surfaces, 'cli'] };
            }),
        } });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Missing confirmation must fail author validation');
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: expect.arrayContaining(['confirmation']) }),
        ]));
    }
});

it('lets Store lifecycle roles share an ordinary Action and preserves the localized declaration', () => {
    const plugin = definePlugin({ id: 'com.example.store', version: '1.0.0',
        storeKinds: { extension: { title: { key: 'store.extensions', fallback: 'Extensions' },
            description: 'Browse extensions', viewId: 'store', operations: {
                list: 'catalog', read: 'catalog', installed: 'catalog', prepare: 'catalog', acquire: 'catalog', manage: 'catalog',
            } } },
        actions: { catalog: { title: 'Catalog', scopes: ['machine'], surfaces: ['plugin'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', run: async () => ({}) } },
        ui: { renderers: [{ id: 'catalog-renderer', kind: 'declarative', root: { kind: 'text', text: 'Catalog' } }],
            views: [{ id: 'store', title: 'Store', renderer: 'catalog-renderer', container: 'appPage', target: { kind: 'app' } }] },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.diagnostics)).toBe(true);
    if (parsed.ok) {
        expect(Reflect.get(parsed.manifest.contributes, 'storeKinds')).toMatchObject([{ id: 'extension',
            title: { key: 'store.extensions', fallback: 'Extensions' }, description: 'Browse extensions', viewId: 'store',
            operations: { list: 'catalog', read: 'catalog', installed: 'catalog', prepare: 'catalog', acquire: 'catalog', manage: 'catalog' } }]);
        expect(parsed.manifest.contributes.ui.renderers).toHaveLength(1);
    }
});
