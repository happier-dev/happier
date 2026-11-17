import { expect, it } from 'vitest';
import { foreignKeyNavigation, foreignKeyBack } from './location.js';
import type { WorkbenchLocation } from './models.js';

const location: WorkbenchLocation = { targetKey: 'target', relation: { database: 'db', schema: 'public', name: 'child' }, mode: 'data',
    columns: ['tenant', 'parent'], sort: [{ column: 'parent', direction: 'desc' }], conditions: { kind: 'null', column: 'note', isNull: false },
    page: { rows: 25, offset: 50 }, fkTrail: [] };
const foreignKey = { name: 'parent_fk', columns: ['tenant', 'parent'], target: { database: 'db', schema: 'other', name: 'parent' }, targetColumns: ['tenant_id', 'id'] };
it('navigates a composite FK with exact typed bound values and restores the full source location on Back', () => {
    const result = foreignKeyNavigation(location, foreignKey, ['parent', 'tenant'], [{ type: 'integer', value: '9007199254740993' }, { type: 'text', value: "a' OR 1=1" }]);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a bound FK destination');
    expect(result.location).toMatchObject({ relation: foreignKey.target, columns: [], sort: [], page: { rows: 25, offset: 0 }, conditions: {
        kind: 'and', filters: [{ kind: 'comparison', column: 'tenant_id', operator: 'eq', value: { type: 'text', value: "a' OR 1=1" } },
            { kind: 'comparison', column: 'id', operator: 'eq', value: { type: 'integer', value: '9007199254740993' } }] } });
    expect(foreignKeyBack(result.location)).toEqual(location);
});
it('does not invent a referenced row for NULL, missing, or incomplete foreign key values', () => {
    expect(foreignKeyNavigation(location, foreignKey, ['tenant', 'parent'], [{ type: 'text', value: 'a' }, { type: 'null' }])).toEqual({ status: 'unavailable', reason: 'null_key' });
    expect(foreignKeyNavigation(location, foreignKey, ['tenant'], [{ type: 'text', value: 'a' }])).toEqual({ status: 'unavailable', reason: 'missing_key' });
    expect(foreignKeyNavigation(location, foreignKey, ['tenant', 'parent'], [{ type: 'text', value: 'a' }, { type: 'partial', valueType: 'text', value: 'x', encoding: 'utf8', range: { offset: 0, length: 1, unit: 'utf8_bytes', total: 8 } }])).toEqual({ status: 'unavailable', reason: 'partial_key' });
});
