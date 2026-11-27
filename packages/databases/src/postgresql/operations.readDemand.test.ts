import { describe, expect, it } from 'vitest';
import { executePostgresqlOperation, type PostgresqlQuery } from './operations.js';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';

describe('PostgreSQL page and cell demand', () => {
    it('reads only columns and primary-key metadata per page and cell while Structure keeps its foreign keys', async () => {
        const relation = { schema: 'public', name: 'items' };
        const target = createDatabaseDescriptorV1Fixture().target;
        const queries: string[] = [];
        const query: PostgresqlQuery = async ({ text }) => {
            queries.push(text);
            const fields = text.startsWith('SELECT "id"') ? [{ name: 'id', dataTypeID: 20 }] : [];
            let rows: (string | null)[][];
            if (text.includes('SELECT c.relkind,c.oid')) rows = [['r', '123']];
            else if (text.includes('format_type')) rows = [['id', '20', 'bigint', 'true', null, 'false'], ['body', '25', 'text', 'false', null, 'false']];
            else if (text.includes('pg_catalog.pg_index')) rows = [['items_pkey', 'true', 'true', '["id"]', null, '["id"]', '["asc"]']];
            else if (text.includes('pg_catalog.pg_constraint')) rows = [['items_parent', 'public', 'parent', '["id"]', '["id"]', 't']];
            else if (text.startsWith('SELECT "id"')) rows = [['7'], ['8']];
            else if (text.startsWith('SELECT substring')) rows = [['\\x6869', '2']];
            else throw new Error('Unexpected PostgreSQL statement');
            return { fields, rows, command: 'SELECT', rowCount: rows.length };
        };
        const structure = await executePostgresqlOperation({ operation: 'relation.structure', target, relation }, query);
        expect(structure).toMatchObject({ ok: true, structure: { primaryKey: ['id'], foreignKeys: [{ name: 'items_parent' }] } });
        expect(queries.splice(0)).toHaveLength(4);

        const page = await executePostgresqlOperation({ operation: 'rows.read', target, relation, columns: ['id'], order: [], page: { rows: 1 } }, query);
        expect(page).toMatchObject({ ok: true, result: {
            rows: [{ identity: { key: [{ column: 'id', value: { type: 'integer', value: '7' } }] } }],
            completeness: { continuation: { kind: 'keyset' } },
        } });
        expect.soft(queries.splice(0)).toHaveLength(4);
        const cell = await executePostgresqlOperation({ operation: 'cell.read', target, relation, column: 'body',
            key: [{ column: 'id', value: { type: 'integer', value: '7' } }], range: { unit: 'utf8_bytes', offset: 0, length: 2 } }, query);
        expect(cell).toMatchObject({ ok: true, value: { type: 'text', value: 'hi' }, completeness: { complete: true } });
        expect(queries).toHaveLength(4);
    });
});
