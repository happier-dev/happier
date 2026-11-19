import { describe, expect, it } from 'vitest';
import { definePlugin } from './index.public.js';
import { parsePluginManifest } from './manifest.js';
import { createPluginRegistrationScope } from './registration/scope.js';
import { derivePluginDaemonContributionRegistrationRights } from '../../protocol/src/plugins/contributions/catalog.js';
import { projectPluginPortableUiDeclarationsV1 } from '../../protocol/src/plugins/contributions/ui/declarationProjection.js';
import { PluginManifestV2Schema } from '../../protocol/src/plugins/manifest/v2.js';
import { createListExtensionSource } from '../fixtures/external-targeted-packages/list-extension-source.js';
import { admitPluginListFilterFieldV1, compileEntityListFilterV1, createPluginListFilterFieldRegistryV1,
    type PluginListFilterFactsV1, type PluginListFilterSelectionV1 } from './ui/index.public.js';

describe('public list extension authoring', () => {
    it('admits and projects a Workflow Run column backed by a held numeric fact', () => {
        const plugin = definePlugin({
            id: 'com.acme.run-columns',
            version: '1.0.0',
            ui: { listExtensions: { timing: {
                entity: 'workflowRun',
                filterFields: [{
                    id: 'duration',
                    title: 'Duration',
                    source: { factKey: 'durationMs' },
                    value: { kind: 'number', unit: 'ms' },
                    column: { title: 'Duration', align: 'end', defaultHidden: true },
                }],
            } } },
        });
        const parsed = parsePluginManifest(plugin.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const manifest = PluginManifestV2Schema.parse(parsed.manifest);
        const entry = projectPluginPortableUiDeclarationsV1(manifest)['listExtension:com.acme.run-columns:timing'];
        expect(entry?.listExtension).toMatchObject({
            entity: 'workflowRun',
            filterFields: [{
                id: 'duration',
                source: { factKey: 'durationMs' },
                value: { kind: 'number', unit: 'ms' },
                column: { title: 'Duration', align: 'end', defaultHidden: true },
            }],
        });
    });

    it('rejects wrong entities, executable declarations, dangling Resources and marks from another entity', () => {
        const manifest = definePlugin({ id: 'com.acme.invalid-list', version: '1.0.0' }).manifest;
        const field = { id: 'stage', title: 'Stage', source: { factKey: 'stage' }, value: { kind: 'set' } };
        const parse = (listExtensions: readonly unknown[]) => parsePluginManifest({
            ...manifest, contributes: { ...manifest.contributes, ui: { listExtensions } },
        });
        expect(parse([{ id: 'bad', entity: 'session', filterFields: [field] }]).ok).toBe(false);
        expect(parse([{ id: 'bad', entity: 'sessionWork', filterFields: [field], render: 'callback' }]).ok).toBe(false);
        const resource = parse([{ id: 'bad', entity: 'sessionWork', filterFields: [{ ...field, source: { resource: 'missing' } }] }]);
        expect(resource).toMatchObject({ ok: false, diagnostics: [{ code: 'plugin_manifest_dangling_reference' }] });
        const source = createListExtensionSource();
        expect(parsePluginManifest({ ...source.manifest, contributes: { ...source.manifest.contributes, ui: {
            listExtensions: [{ id: 'bad', entity: 'sessionWork', filterFields: [{ ...field, source: { resource: 'inspect' } }] }],
        } } })).toMatchObject({ ok: false, diagnostics: [{ code: 'plugin_manifest_wrong_family_reference' }] });
        const mismatch = parse([
            { id: 'runs', entity: 'workflow', filterFields: [field] },
            { id: 'sessions', entity: 'sessionWork', rowMark: { fieldId: 'stage', slot: 'mark' } },
        ]);
        expect(mismatch.ok).toBe(false);
        expect(parse([
            { id: 'base', entity: 'sessionWork', filterFields: [field] },
            { id: 'mark', entity: 'sessionWork', rowMark: { fieldId: 'stage', slot: 'mark' } },
        ]).ok).toBe(true);
        expect(parse([
            { id: 'base', entity: 'sessionWork', filterFields: [field] },
            { id: 'mark', entity: 'sessionWork', rowMark: { fieldId: 'com.acme.invalid-list/stage', slot: 'mark' } },
        ]).ok).toBe(true);
        expect(parse([
            { id: 'base', entity: 'sessionWork', filterFields: [field] },
            { id: 'duplicate', entity: 'workflow', filterFields: [field] },
        ])).toMatchObject({ ok: false, diagnostics: [{ code: 'plugin_manifest_duplicate_contribution_id' }] });
        expect(parsePluginManifest({ ...manifest, contributes: { ...manifest.contributes, ui: { listExtensions: 42 } } }).ok).toBe(false);
    });

    it('admits an external author declaration, projects it, and evaluates held facts without Resource reads', async () => {
        let reads = 0;
        const plugin = createListExtensionSource(() => reads++);
        const parsed = parsePluginManifest(plugin.manifest);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const manifest = PluginManifestV2Schema.parse(parsed.manifest);
        expect(reads).toBe(0);
        const rights = derivePluginDaemonContributionRegistrationRights(manifest.contributes);
        expect(rights.map(right => right.family).sort()).toEqual(['actions', 'resources']);
        const scope = createPluginRegistrationScope({ pluginId: parsed.manifest.id, target: { realm: 'daemon' }, rights });
        await plugin.activate(scope.api);
        expect(scope.commit().map(registration => registration.family).sort()).toEqual(['actions', 'resources']);
        const entries = projectPluginPortableUiDeclarationsV1(manifest);
        expect(entries['listExtension:com.acme.release:releases']).toMatchObject({
            contributionKind: 'listExtension', pluginId: 'com.acme.release',
        });
        const extension = entries['listExtension:com.acme.release:releases']?.listExtension;
        if (!extension) throw new Error('Expected projected list extension');
        expect(extension.id).toBe('releases');
        expect(extension.rowMark?.fieldId).toBe('com.acme.release/release-stage');
        const admitted = admitPluginListFilterFieldV1({ pluginId: parsed.manifest.id,
            field: extension.filterFields![0], factKeys: new Set(['releaseStage']) });
        if (admitted.kind !== 'admitted') throw new Error('Expected admitted public field');
        const registry = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([admitted.field]);
        const selected: PluginListFilterSelectionV1 = { extensions: { [admitted.field.id]: { kind: 'set', include: ['ready'], exclude: [] } } };
        const match = compileEntityListFilterV1(registry, selected);
        expect(match({ extensions: { [admitted.field.id]: 'ready' } })).toBe('match');
        expect(match({ extensions: { [admitted.field.id]: 'blocked' } })).toBe('miss');
        expect(match({})).toBe('unavailable');
        expect(compileEntityListFilterV1(createPluginListFilterFieldRegistryV1([]), selected)({})).toBe('unavailable');
        expect(reads).toBe(0);
    });
});
