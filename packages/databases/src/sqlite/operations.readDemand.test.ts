import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { expect, it } from 'vitest';

import { executeSqliteOperation, type SqliteNativeValue, type SqliteQuery } from './operations.js';

it('keeps page and cell statement counts independent of SQLite secondary indexes', () => {
    const db = openSqliteDatabaseSync(':memory:');
    try {
        db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT, parent_id INTEGER REFERENCES parent(id));
            INSERT INTO items (id, body) VALUES (7, 'hi'), (8, 'next');
            CREATE INDEX items_body ON items(body);
            CREATE INDEX items_parent ON items(parent_id);
            CREATE INDEX items_lower_body ON items(lower(body)) WHERE body IS NOT NULL;`);
        const target = createDatabaseDescriptorV1Fixture().target;
        const relation = { schema: 'main', name: 'items' };
        const statements: string[] = [];
        const query: SqliteQuery = statement => {
            statements.push(statement.text);
            const prepared = db.prepare(statement.text, statement);
            // The native adapter returns SQLite storage values in column order.
            return { columns: prepared.columns(), rows: prepared.values(...statement.values) as SqliteNativeValue[][], changes: null };
        };
        const structure = executeSqliteOperation({ operation: 'relation.structure', target, relation }, query);
        expect(structure).toMatchObject({ ok: true, structure: {
            primaryKey: ['id'], indexes: expect.arrayContaining([{ name: 'items_lower_body', unique: false, primary: false,
                columns: [{ kind: 'expression', expression: 'lower(body)', direction: 'asc' }], predicate: 'body IS NOT NULL' }]),
            foreignKeys: [{ name: 'items_fk_0', columns: ['parent_id'] }],
        } });
        expect(statements.splice(0)).toHaveLength(10);

        const page = executeSqliteOperation({ operation: 'rows.read', target, relation, columns: ['id'], order: [], page: { rows: 1 } }, query);
        expect(page).toMatchObject({ ok: true, result: {
            rows: [{ identity: { key: [{ column: 'id', value: { type: 'integer', value: '7' } }] } }],
            completeness: { continuation: { kind: 'keyset' } },
        } });
        expect.soft(statements.splice(0)).toHaveLength(4);
        const cell = executeSqliteOperation({ operation: 'cell.read', target, relation, column: 'body',
            key: [{ column: 'id', value: { type: 'integer', value: '7' } }], range: { unit: 'utf8_bytes', offset: 0, length: 2 } }, query);
        expect(cell).toMatchObject({ ok: true, value: { type: 'text', value: 'hi' } });
        expect(statements).toHaveLength(4);
    } finally { db.close(); }
});
