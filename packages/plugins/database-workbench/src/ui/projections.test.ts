import { expect, it } from 'vitest';
import type { DatabaseRowsResultV1, DatabaseRelationStructureV1 } from '@happier-dev/database-protocol';
import { projectRelationPage } from './projections.js';

it('keeps incomplete and exact values intact while joining structural column facts by name', () => {
    const columns: DatabaseRelationStructureV1['columns'] = [
        { name: 'id', nativeType: 'bigint', semanticType: 'integer', nullable: false, generated: false },
        { name: 'payload', nativeType: 'bytea', semanticType: 'binary', nullable: true, generated: false },
    ];
    const structure: DatabaseRelationStructureV1 = { relation: { schema: 'app', name: 'events' }, kind: 'table',
        columns, primaryKey: ['id'], indexes: [], foreignKeys: [{ name: 'parent', columns: ['id'], target: { schema: 'archive', name: 'events' }, targetColumns: ['parent_id'] }], capabilities: [] };
    const result: DatabaseRowsResultV1 = { columns, rows: [{ cells: [
        { type: 'integer', value: '9007199254740993' },
        { type: 'partial', valueType: 'binary', value: 'AA==', encoding: 'base64', range: { offset: 0, length: 1, total: 42, unit: 'bytes' } },
    ], identity: { key: [{ column: 'id', value: { type: 'integer', value: '9007199254740993' } }], original: [] } }], completeness: { complete: false, reason: 'response_envelope' } };
    const page = projectRelationPage(result, structure);
    expect(page.columns[0]).toMatchObject({ primaryKey: true, foreignKey: { schema: 'archive', table: 'events', column: 'parent_id' } });
    expect(page.rows[0]?.cells).toBe(result.rows[0]?.cells);
    expect(page.completeness).toBe(result.completeness);
    expect(projectRelationPage(result, structure).rows[0]?.rowKey).toBe(page.rows[0]?.rowKey);
});
