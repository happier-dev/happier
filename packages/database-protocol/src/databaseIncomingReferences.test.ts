import { expect, it } from 'vitest';
import { DatabaseOperationResultV1Schema } from './databaseOperations.js';

it('preserves aligned incoming references and accepts older structure results', () => {
    const structure = {
        relation: { schema: 'public', name: 'parents' },
        kind: 'table',
        columns: [],
        primaryKey: ['tenant', 'id'],
        indexes: [],
        foreignKeys: [],
        capabilities: [],
    };
    const result = { ok: true, operation: 'relation.structure', structure };
    const incoming = {
        name: 'parent_fk',
        source: { schema: 'app', name: 'children' },
        sourceColumns: ['owner_id', 'owner_tenant'],
        targetColumns: ['id', 'tenant'],
    };
    const withIncoming = { ...result, structure: { ...structure, incomingForeignKeys: [incoming] } };

    expect(DatabaseOperationResultV1Schema.parse(result)).toEqual(result);
    expect(DatabaseOperationResultV1Schema.parse(withIncoming)).toEqual(withIncoming);
    expect(DatabaseOperationResultV1Schema.safeParse({
        ...result,
        structure: { ...structure, incomingForeignKeys: [{ ...incoming, targetColumns: ['id'] }] },
    }).success).toBe(false);
});
