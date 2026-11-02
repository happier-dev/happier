import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '../manifest/ingest.js';
import { PluginContributesV2Schema } from './v2.js';
import * as protocol from '../../index.js';

const renderer = { id: 'catalog', kind: 'declarative', root: { kind: 'text', text: 'Catalog' } };
const view = { id: 'store', renderer: 'catalog', title: 'Store', container: 'appPage', target: { kind: 'app' } };
const operations = { list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage' };
const actions = Object.values(operations).map(id => ({ id, title: id, scopes: ['machine'], surfaces: ['plugin'],
    execution: { target: 'daemon' }, dangerLevel: id === 'acquire' || id === 'manage' ? 'writesLocal' : 'safe' }));
const kind = { id: 'extension', title: { key: 'store.extension', fallback: 'Extensions' },
    description: 'Browse extensions', viewId: 'store', operations };
const manifest = (contributes: Readonly<Record<string, unknown>>) => ({ schemaVersion: 2, id: 'com.example.store', version: '1.0.0',
    displayName: 'External Store', runtime: { apiVersion: 1 }, contributes: { actions, ...contributes } });

describe('storeKinds canonical contribution admission', () => {
    it('preserves plugin item values while rejecting extra item envelope fields', () => {
        const schema = Reflect.get(protocol, 'PluginStoreItemV1Schema');
        expect(schema).toBeDefined();
        const item = { sourceId: 'source', itemId: 'publisher/item', title: 'A third-party item', version: '1.0.0',
            installed: false, value: { pluginOwnedField: { arbitrary: ['data', 42] } } };
        expect(schema.parse(item)).toEqual(item);
        expect(schema.safeParse({ ...item, undeclaredRouting: 'other' }).success).toBe(false);
        expect(schema.safeParse({ ...item, value: { invalidJson: () => 'invalid' } }).success).toBe(false);
    });

    it('admits only a closed qualified Store item reference', () => {
        const schema = Reflect.get(protocol, 'PluginStoreItemReferenceV1Schema');
        expect(schema).toBeDefined();
        const reference = { type: 'storeKind', kind: 'com.example.store/extension', sourceId: 'source', itemId: 'publisher/item' };
        expect(schema.parse(reference)).toEqual(reference);
        for (const invalid of [
            { ...reference, kind: 'extension' }, { ...reference, sourceId: '' },
            { ...reference, version: '' }, { ...reference, extra: true },
        ]) expect(schema.safeParse(invalid).success).toBe(false);
    });

    it('admits a localized kind bound to its declared same-plugin app view', () => {
        const result = ingestPluginManifestV2(manifest({ storeKinds: [kind], ui: { renderers: [renderer], views: [view] } }));
        expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
        if (result.ok) expect(Reflect.get(result.manifest.contributes, 'storeKinds')).toEqual([kind]);
    });

    it('rejects missing views, qualified view references and undeclared executable fields', () => {
        for (const invalid of [
            { ...kind, viewId: 'missing' },
            { ...kind, viewId: 'com.other.store/store' },
            { ...kind, viewId: 'com.example.store/store' },
            { ...kind, parse: 'parse-item' },
            { ...kind, registryKind: 'app' },
        ]) expect(ingestPluginManifestV2(manifest({ storeKinds: [invalid], ui: { renderers: [renderer], views: [view] } })).ok).toBe(false);
    });

    it('rejects a Store binding to a view outside the app page placement', () => {
        expect(PluginContributesV2Schema.safeParse({ actions, storeKinds: [kind], ui: { renderers: [renderer], views: [
            { ...view, container: 'rightSidebarTab' },
        ] } }).success).toBe(false);
    });

    it('rejects a missing lifecycle Action and an undeclared operation role', () => {
        for (const invalid of [
            { ...kind, operations: { ...operations, acquire: 'missing' } },
            { ...kind, operations: { ...operations, alternate: 'list' } },
        ]) expect(ingestPluginManifestV2(manifest({ storeKinds: [invalid], ui: { renderers: [renderer], views: [view] } })).ok).toBe(false);
    });

    it('withdraws an invalid sibling without losing a valid kind or renderer', () => {
        const result = ingestPluginManifestV2(manifest({ storeKinds: [
            { ...kind, id: 'broken', viewId: 'missing' }, kind,
        ], ui: { renderers: [renderer], views: [view] } }), { mode: 'load' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(Reflect.get(result.manifest.contributes, 'storeKinds')).toEqual([kind]);
            expect(result.manifest.contributes.ui.renderers).toEqual([renderer]);
            expect(result.diagnostics?.filter(item => item.code === 'plugin_contribution_skipped')).toHaveLength(1);
        }
    });
});
