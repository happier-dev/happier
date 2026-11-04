import { describe, expect, it } from 'vitest';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from './projection';
import { createPluginUiProjectionUnionPublication, type PluginUiProjectionUnionMember } from './projectionUnion';

function member(): PluginUiProjectionUnionMember {
    // The #70 PERF Account's per-Machine indexes contain about 85 plugins.
    const ids = Array.from({ length: 85 }, (_, index) => `acme.heap-${index}`);
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'heap-root' };
    const origin = (pluginId: string) => ({ serverIdentityId: 'home', sourceRef: {
        machineId: 'machine', pluginId, sourceCustody,
    } });
    return {
        machineId: 'machine', serverId: 'home', serverIdentityId: 'home', phase: 'current', interactionEnabled: true,
        projection: {
            ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: Object.fromEntries(ids.map(id => [id, {
                id, displayName: id, version: '1.0.0', enabled: true,
                source: { kind: 'localPath' as const, locator: '/heap' }, occurrenceId: id,
                sourceCustody, executionOrigin: origin(id),
            }])),
            unknownEntriesById: Object.fromEntries(ids.map(pluginId => [pluginId, {
                pluginId, contributionKind: 'unknown', occurrenceId: pluginId, executionOrigin: origin(pluginId), value: 1,
            }])),
        },
    };
}

function reachableModels(root: unknown): readonly PluginUiProjectionModel[] {
    const seen = new Set<object>();
    const models: PluginUiProjectionModel[] = [];
    const visit = (value: unknown) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if ('actionsById' in value && 'installedPackagesById' in value) models.push(value as PluginUiProjectionModel);
        if (value instanceof Map) for (const [key, entry] of value) { visit(key); visit(entry); }
        else if (value instanceof Set) for (const entry of value) visit(entry);
        else for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor && 'value' in descriptor) visit(descriptor.value);
        }
    };
    visit(root);
    return models;
}

describe('projection union retained memory', () => {
    it('shares absent contribution dictionaries throughout its retained publication graph', () => {
        const input = member();
        const owner = createPluginUiProjectionUnionPublication();
        const first = owner.publish([input]);
        const families = Object.keys(EMPTY_PLUGIN_UI_PROJECTION).filter(key => key.endsWith('ById') || key.endsWith('ByPluginId'));
        const dictionary = (model: PluginUiProjectionModel, key: string): unknown => Reflect.get(model, key);
        const roots = [EMPTY_PLUGIN_UI_PROJECTION, input.projection!, first.pluginUiProjection!];
        const duplicates = reachableModels(first).flatMap(model => families.filter(key => {
            const value = dictionary(model, key);
            return value && typeof value === 'object' && Object.keys(value).length === 0
                && !roots.some(root => dictionary(root, key) === value);
        }));
        expect(duplicates).toHaveLength(0);

        const changed = { ...input, projection: { ...input.projection!, unknownEntriesById: {
            ...input.projection!.unknownEntriesById,
            'acme.heap-0': { ...input.projection!.unknownEntriesById['acme.heap-0'], value: 2 },
        } } };
        const next = owner.publish([changed]);
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-0']).toMatchObject({ value: 2 });
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-1']).toBe(first.pluginUiProjection?.unknownEntriesById['acme.heap-1']);
        expect(owner.publish([changed])).toBe(next);
        expect(Object.keys(owner.publish([]).pluginUiProjection?.unknownEntriesById ?? {})).toHaveLength(0);
    });

    it('allocates empty sets by supplied plugins rather than by every absent contribution family', () => {
        const input = member();
        const owner = createPluginUiProjectionUnionPublication();
        const NativeSet = globalThis.Set;
        let emptySets = 0;
        // Allocation instrumentation forwards every construction to the real Set.
        // No domain logic or Set behavior is replaced.
        globalThis.Set = new Proxy(NativeSet, { construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget) as Set<unknown>;
            if (value.size === 0) emptySets++;
            return value;
        } });
        let result;
        try { result = owner.publish([input]); }
        finally { globalThis.Set = NativeSet; }
        expect(Object.keys(result.pluginUiProjection?.unknownEntriesById ?? {})).toHaveLength(85);
        const pluginCount = Object.keys(input.projection!.installedPackagesById).length;
        const absentFamilies = Object.keys(EMPTY_PLUGIN_UI_PROJECTION).filter(key =>
            (key.endsWith('ById') || key.endsWith('ByPluginId'))
            && Object.keys(Reflect.get(input.projection!, key)).length === 0);
        // Control sets still scale with real plugins. Absent contribution families
        // must not introduce their own plugin × family allocation multiplier.
        expect(emptySets).toBeLessThan(pluginCount * absentFamilies.length);
    });
});
