import { describe, expect, it } from 'vitest';
import { compileEntityListFilterV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { applyCollectionConditionEdit, conditionModelFromFilter } from '@happier-dev/plugin-ui/components';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from './settingsCollectionAdapter';

describe('Settings column slot and P6 field binding', () => {
    const adapter = defineSettingsCollectionAdapter(['service', 'status']);
    const row: SettingsCollectionRowFacts<'service' | 'status'> = {
        key: 'qualified-account', title: 'Personal', context: 'Code tools', status: null,
        fields: { service: ['plugin:service'], status: null },
    };
    it('does not widen unknown or future narrowing, including negative selections', () => {
        expect(compileEntityListFilterV1(adapter.registry, { status: { include: ['connected'], exclude: [] } })(row)).toBe('unavailable');
        expect(compileEntityListFilterV1(adapter.registry, { status: { include: [], exclude: ['connected'] } })(row)).toBe('unavailable');
        expect(compileEntityListFilterV1(adapter.registry, { future: { include: ['x'], exclude: [] } })(row)).toBe('unavailable');
    });
    it('uses the P6 include/exclude evaluator and preserves known empty facts', () => {
        const match = compileEntityListFilterV1(adapter.registry, { service: { include: ['plugin:service'], exclude: [] } });
        expect(match(row)).toBe('match');
        expect(match({ ...row, fields: { service: [] } })).toBe('miss');
        expect(match({ ...row, fields: {} })).toBe('unavailable');
        expect(compileEntityListFilterV1(adapter.registry, { service: { include: ['other'], exclude: [] } })(row)).toBe('miss');
    });
    it('keeps one context slot, zero counts, icon-only status and expanded rollup suppression', () => {
        const render = {
            identity: 'mark', context: (line: string) => line,
            count: (value: number) => String(value),
            status: (status: string, options: { iconOnly: true }) => `${status}:${options.iconOnly}`,
            trailing: (status: unknown, count: unknown) => `${status}/${count}`,
        };
        expect(adapter.slots({ ...row, count: 0, rollup: 'needs_reauth', expanded: false }, render))
            .toEqual({ identity: 'mark', title: 'Personal', children: 'Code tools', trailing: 'needs_reauth:true/0' });
        expect(adapter.slots({ ...row, count: null, rollup: 'needs_reauth', expanded: true }, render).trailing).toBe('null/null');
    });
    it('edits Settings include/exclude through the shared P6 editor model without dropping opaque narrowing', () => {
        const initial = { future: { include: ['held'], exclude: [] } };
        expect(conditionModelFromFilter(adapter.registry, initial).availableFields.map(field => field.id)).toEqual(['service', 'status']);
        const included = applyCollectionConditionEdit(adapter.registry, initial, { type: 'add',
            condition: { fieldId: 'service', operator: 'is', values: ['plugin:service'] } });
        const excluded = applyCollectionConditionEdit(adapter.registry, included, { type: 'add',
            condition: { fieldId: 'service', operator: 'is_not', values: ['other'] } });
        expect(excluded).toEqual({ ...initial, service: { include: ['plugin:service'], exclude: ['other'] } });
        expect(compileEntityListFilterV1(adapter.registry, excluded)(row)).toBe('unavailable');
        const unknown = conditionModelFromFilter(adapter.registry, excluded).rows.find(condition => condition.fieldId === 'unavailableFields')!;
        const known = applyCollectionConditionEdit(adapter.registry, excluded, { type: 'remove', rowId: unknown.id });
        expect(compileEntityListFilterV1(adapter.registry, known)(row)).toBe('match');
        expect(applyCollectionConditionEdit(adapter.registry, known, { type: 'clear' })).toEqual({});
        expect(() => applyCollectionConditionEdit(adapter.registry, known, { type: 'add',
            condition: { fieldId: 'status', operator: 'is', values: [123] } })).toThrow();
        expect(initial).toEqual({ future: { include: ['held'], exclude: [] } });
    });
});
