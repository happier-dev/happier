import { describe, expect, it } from 'vitest';
import {
    admitPluginListFilterFieldV1, admitPluginListFilterFieldValueV1, compileEntityListFilterV1,
    createPluginListFilterFieldRegistryV1, type PluginListFilterFactsV1, type PluginListFilterSelectionV1,
    conditionModelFromFilter, applyCollectionConditionEdit,
} from '@happier-dev/plugin-ui/components';
import { compileExternalReleaseStageFilter, externalReleaseStageSelection, externalReleaseReviews,
    admitExternalReleaseStage } from '../../fixtures/external-authoring/src/releaseStage.js';

describe('public plugin collection filter adapter through the RNW public entry', () => {
    it('filters independent plugin-owned release facts and preserves unavailable selections over retirement', () => {
        const declared = { id: 'release-stage', title: 'Release stage', source: { factKey: 'releaseStage' }, value: { kind: 'set' } } as const;
        const admitted = admitPluginListFilterFieldV1({ pluginId: 'test.release', field: declared, factKeys: new Set(['releaseStage']) });
        if (admitted.kind !== 'admitted') throw new Error('Invalid fixture');
        const registry = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([admitted.field]);
        const selection = applyCollectionConditionEdit(registry, {}, { type: 'add',
            condition: { fieldId: admitted.field.id, operator: 'is', values: ['ready'] } });
        expect(conditionModelFromFilter(registry, selection).rows).toMatchObject([
            { fieldId: admitted.field.id, operator: 'is', values: ['ready'], available: true },
        ]);
        const rows = [{ id: 'ready', stage: 'ready' }, { id: 'draft', stage: 'draft' }].map(row => {
            const value = admitPluginListFilterFieldValueV1(declared, row.stage);
            if (value.kind !== 'available') throw new Error('Invalid fact fixture');
            return { id: row.id, extensions: { [admitted.field.id]: value.value } };
        });
        const match = compileEntityListFilterV1(registry, selection);
        expect(rows.filter(row => match(row) === 'match').map(row => row.id)).toEqual(['ready']);
        expect(match({})).toBe('unavailable');
        const retired = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([]);
        expect(compileEntityListFilterV1(retired, selection)(rows[0]!)).toBe('unavailable');
        expect(compileEntityListFilterV1(registry, selection)(rows[0]!)).toBe('match');
    });

    it('keeps the same external page selection unavailable through field retirement and unheld facts, then recovers', () => {
        const selection = externalReleaseStageSelection('ready');
        const match = compileExternalReleaseStageFilter(selection);
        expect(externalReleaseReviews.filter(row => match(row) === 'match').map(row => row.id)).toEqual(['release']);
        const retired = compileExternalReleaseStageFilter(selection, false);
        expect(externalReleaseReviews.map(row => retired(row))).toEqual(['unavailable', 'unavailable', 'unavailable']);
        expect(match(admitExternalReleaseStage(undefined))).toBe('unavailable');
        expect(match(admitExternalReleaseStage(null))).toBe('miss');
        expect(match(admitExternalReleaseStage('ready'))).toBe('match');
        expect(compileExternalReleaseStageFilter(selection)(externalReleaseReviews[2]!)).toBe('match');
    });
});
