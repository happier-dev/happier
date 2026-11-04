import { describe, expect, it } from 'vitest';
import { compileEntityListFilterV1 } from './entityListFilterV1.js';
import {
    admitPluginListFilterFieldV1, admitPluginListFilterFieldValueV1, createPluginListFilterFieldRegistryV1,
    PluginListFilterFieldV1Schema, validatePluginListFilterSelectionsV1, type PluginListFilterFactsV1, type PluginListFilterSelectionV1,
} from './pluginListFilterFieldV1.js';

const stage = { id: 'release-stage', title: 'Release stage', source: { factKey: 'releaseStage' }, value: { kind: 'set' } } as const;

describe('plugin list filter fields over held facts', () => {
    it('admits one closed declarative source and validates values at ingress', () => {
        const admitted = admitPluginListFilterFieldV1({ pluginId: 'test.release', field: stage, factKeys: new Set(['releaseStage']) });
        expect(admitted.kind).toBe('admitted');
        expect(admitPluginListFilterFieldV1({ pluginId: 'test.release', field: stage, factKeys: new Set() }).kind).toBe('invalid');
        expect(admitPluginListFilterFieldV1({ pluginId: 'test.release', field: stage, factKeys: new Set(['releaseStage']), hostFieldIds: new Set(['test.release/release-stage']) }).kind).toBe('invalid');
        expect(admitPluginListFilterFieldV1({ pluginId: 'test.release', field: stage, factKeys: new Set(['releaseStage']), hostFieldIds: new Set(['release-stage']) }).kind).toBe('admitted');
        expect(PluginListFilterFieldV1Schema.safeParse({ ...stage, source: { factKey: 'releaseStage', resource: 'stage' } }).success).toBe(false);
        expect(PluginListFilterFieldV1Schema.safeParse({ ...stage, match: 'script' }).success).toBe(false);
        expect(admitPluginListFilterFieldValueV1(stage, ['ready', 'stable'])).toEqual({ kind: 'available', value: ['ready', 'stable'] });
        expect(admitPluginListFilterFieldValueV1(stage, { stage: 'ready' }).kind).toBe('invalid');
        expect(admitPluginListFilterFieldValueV1({ ...stage, value: { kind: 'time' } }, 1.5).kind).toBe('invalid');
    });

    it('matches genuine plugin facts, keeps missing and retired facts unavailable, and never executes a plugin', () => {
        const admitted = admitPluginListFilterFieldV1({ pluginId: 'test.release', field: stage, factKeys: new Set(['releaseStage']) });
        if (admitted.kind !== 'admitted') throw new Error('Expected valid fixture');
        const fields = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([admitted.field]);
        const selection: PluginListFilterSelectionV1 = { extensions: { 'test.release/release-stage': { kind: 'set', include: ['ready'], exclude: ['blocked'] } } };
        const match = compileEntityListFilterV1(fields, selection);
        expect(match({ extensions: { 'test.release/release-stage': 'ready' } })).toBe('match');
        expect(match({ extensions: { 'test.release/release-stage': ['ready', 'blocked'] } })).toBe('miss');
        expect(match({})).toBe('unavailable');
        let unavailableFields: readonly string[] = [];
        expect(match({}, fields => { unavailableFields = fields; })).toBe('unavailable');
        expect(unavailableFields).toEqual(['test.release/release-stage']);
        unavailableFields = [];
        expect(match({ extensions: { 'test.release/release-stage': 'blocked' } }, fields => { unavailableFields = fields; })).toBe('miss');
        expect(unavailableFields).toEqual([]);
        expect(compileEntityListFilterV1(fields, selection, 'daemonRule')({ extensions: { 'test.release/release-stage': 'ready' } })).toBe('unavailable');
        const retired = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([]);
        expect(compileEntityListFilterV1(retired, selection)({ extensions: { 'test.release/release-stage': 'ready' } })).toBe('unavailable');
        const wrongKind: PluginListFilterSelectionV1 = { extensions: { 'test.release/release-stage': { kind: 'boolean', value: true } } };
        expect(compileEntityListFilterV1(fields, wrongKind)({ extensions: { 'test.release/release-stage': true } })).toBe('unavailable');
        expect(validatePluginListFilterSelectionsV1([admitted.field], selection.extensions)).toBe(true);
        expect(validatePluginListFilterSelectionsV1([admitted.field], wrongKind.extensions)).toBe(false);
        expect(validatePluginListFilterSelectionsV1([], selection.extensions)).toBe(false);
    });
});
