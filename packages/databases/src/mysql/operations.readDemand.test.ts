import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { describe, expect, it } from 'vitest';
import { executeMysqlOperation, type MysqlNativeResult, type MysqlQuery } from './operations.js';

describe('MySQL page and cell demand', () => {
    it('reads only columns and primary-key metadata per page and cell while Structure keeps its foreign keys', async () => {
        const relation = { schema: 'app', name: 'items' };
        const target = createDatabaseDescriptorV1Fixture().target;
        const queries: string[] = [];
        const query: MysqlQuery = async ({ text }) => {
            queries.push(text);
            let rows: MysqlNativeResult['rows'];
            const fields = text.startsWith('SELECT `id`') ? [{ name: 'id', columnType: 8, characterSet: 63 }] : [];
            if (text.includes('information_schema.TABLES')) rows = [['BASE TABLE', 'InnoDB', 'YES']];
            else if (text.includes('information_schema.COLUMNS')) rows = [['id', 'bigint', 'bigint', 'NO', null, ''], ['body', 'text', 'text', 'YES', null, '']];
            else if (text.includes('information_schema.STATISTICS')) rows = [['PRIMARY', 0, 'id', 'A', null]];
            else if (text.includes('information_schema.KEY_COLUMN_USAGE')) rows = [[0, 'items_parent', 'app', 'parent', 'id', 'id', 1]];
            else if (text.startsWith('SELECT `id`')) rows = [['7'], ['8']];
            else if (text.startsWith('SELECT SUBSTRING')) rows = [[Buffer.from('hi'), '2']];
            else throw new Error('Unexpected MySQL statement');
            return { rows, fields };
        };

        const structure = await executeMysqlOperation({ operation: 'relation.structure', target, relation }, query);
        expect(structure).toMatchObject({ ok: true, structure: { primaryKey: ['id'], foreignKeys: [{ name: 'items_parent' }] } });
        expect(queries.splice(0)).toHaveLength(4);

        const page = await executeMysqlOperation({ operation: 'rows.read', target, relation, columns: ['id'], order: [], page: { rows: 1 } }, query);
        expect(page).toMatchObject({ ok: true, result: {
            rows: [{ identity: { key: [{ column: 'id', value: { type: 'integer', value: '7' } }] } }],
            completeness: { continuation: { kind: 'keyset' } },
        } });
        expect.soft(queries.splice(0)).toHaveLength(4);

        const cell = await executeMysqlOperation({ operation: 'cell.read', target, relation, column: 'body',
            key: [{ column: 'id', value: { type: 'integer', value: '7' } }], range: { unit: 'utf8_bytes', offset: 0, length: 2 } }, query);
        expect(cell).toMatchObject({ ok: true, value: { type: 'text', value: 'hi' }, completeness: { complete: true } });
        expect(queries).toHaveLength(4);
    });
});
