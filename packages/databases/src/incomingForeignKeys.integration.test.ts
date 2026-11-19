import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import type {
    DatabaseOperationInputV1,
    DatabaseOperationResultV1,
    DatabaseRelationV1,
} from '@happier-dev/plugin-sdk/database';
import { mysqlConnectionOptions, mysqlNativeResult } from './connection/mysql.js';
import { executeMysqlOperation } from './mysql/operations.js';
import { executePostgresqlOperation } from './postgresql/operations.js';
import { executeSqliteOperation } from './sqlite/operations.js';

const postgresUrl = process.env.HAPPIER_TEST_NATIVE_POSTGRES_URL;
const mysqlUrl = process.env.HAPPIER_TEST_NATIVE_MYSQL_URL;
const target = {
    kind: 'manual', accountId: 'fixture', installationId: 'fixture', projectKey: 'fixture', savedSecretId: 'fixture',
    workspace: { serverId: 'fixture', machineId: 'fixture', workspaceId: 'fixture', rootPath: '/fixture' },
} as const;

function structureInput(relation: DatabaseRelationV1): DatabaseOperationInputV1 {
    return { operation: 'relation.structure', target, relation };
}

function structureResult(result: DatabaseOperationResultV1) {
    if (!result.ok || result.operation !== 'relation.structure') throw new Error('Expected relation structure');
    return result.structure;
}

function serverFixture(schemaA: string, schemaB: string) {
    const relation = { schema: schemaA, name: 'parent_table' };
    const left = { schema: schemaA, name: 'left_child' };
    const right = { schema: schemaB, name: 'right_child' };
    return { relation, left, statements: [
        `CREATE SCHEMA ${schemaA}`,
        `CREATE SCHEMA ${schemaB}`,
        `CREATE TABLE ${schemaA}.other_parent (id INT PRIMARY KEY)`,
        `CREATE TABLE ${schemaA}.parent_table (first_id INT NOT NULL, second_id INT NOT NULL,
            parent_id INT, PRIMARY KEY(second_id,first_id),
            CONSTRAINT forward_key FOREIGN KEY (parent_id) REFERENCES ${schemaA}.other_parent(id))`,
        `CREATE TABLE ${schemaA}.left_child (alpha INT, beta INT,
            CONSTRAINT same_name FOREIGN KEY (beta,alpha) REFERENCES ${schemaA}.parent_table(second_id,first_id))`,
        `CREATE TABLE ${schemaB}.right_child (left_id INT, right_id INT,
            CONSTRAINT same_name FOREIGN KEY (right_id,left_id) REFERENCES ${schemaA}.parent_table(second_id,first_id))`,
        `CREATE TABLE ${schemaB}.unrelated_child (parent_id INT,
            CONSTRAINT unrelated FOREIGN KEY (parent_id) REFERENCES ${schemaA}.other_parent(id))`,
    ], outgoing: [{ name: 'forward_key', target: { schema: schemaA, name: 'other_parent' }, columns: ['parent_id'], targetColumns: ['id'] }],
    incoming: [
        { name: 'same_name', source: left, sourceColumns: ['beta', 'alpha'], targetColumns: ['second_id', 'first_id'] },
        { name: 'same_name', source: right, sourceColumns: ['right_id', 'left_id'], targetColumns: ['second_id', 'first_id'] },
    ] };
}

it.skipIf(!postgresUrl)('returns distinct ordered PostgreSQL incoming keys in the existing catalog round trip', async () => {
    const client = new Client({ connectionString: postgresUrl });
    await client.connect();
    try {
        await client.query('BEGIN');
        const id = randomUUID().replaceAll('-', '');
        const fixture = serverFixture(`d41_a_${id}`, `d41_b_${id}`);
        for (const sql of fixture.statements) await client.query(sql);
        let calls = 0;
        const read = async (relation: DatabaseRelationV1) => structureResult(await executePostgresqlOperation(structureInput(relation), statement => {
            calls++;
            return client.query<string[]>({ ...statement, rowMode: 'array', types: { getTypeParser: () => value => value } });
        }));
        const result = await read(fixture.relation);
        expect(result.foreignKeys).toEqual(fixture.outgoing);
        expect(result.incomingForeignKeys).toEqual(fixture.incoming);
        expect(calls).toBe(4);
        calls = 0;
        expect((await read(fixture.left)).incomingForeignKeys).toEqual([]);
        expect(calls).toBe(4);

        const schema = fixture.relation.schema;
        await client.query(`CREATE TABLE ${schema}.partitioned_parent(id INT PRIMARY KEY) PARTITION BY LIST (id);
            CREATE TABLE ${schema}.parent_partition PARTITION OF ${schema}.partitioned_parent FOR VALUES IN (1);
            CREATE TABLE ${schema}.partitioned_child(id INT CONSTRAINT partition_key REFERENCES ${schema}.partitioned_parent) PARTITION BY LIST (id);
            CREATE TABLE ${schema}.child_partition PARTITION OF ${schema}.partitioned_child FOR VALUES IN (1)`);
        const parent = await read({ schema, name: 'partitioned_parent' });
        expect(parent.incomingForeignKeys).toEqual([
            { name: 'partition_key', source: { schema, name: 'partitioned_child' }, sourceColumns: ['id'], targetColumns: ['id'] },
        ]);
        const partition = await read({ schema, name: 'parent_partition' });
        expect(partition.incomingForeignKeys).toMatchObject([
            { source: { schema, name: 'partitioned_child' }, sourceColumns: ['id'], targetColumns: ['id'] },
        ]);
    } finally {
        try { await client.query('ROLLBACK'); } finally { await client.end(); }
    }
});

it.skipIf(!mysqlUrl)('returns distinct ordered MySQL incoming keys across databases in the existing catalog round trip', async () => {
    const client = await createConnection(mysqlConnectionOptions(mysqlUrl!));
    const id = randomUUID().replaceAll('-', '');
    const schemaA = `d41_a_${id}`;
    const schemaB = `d41_b_${id}`;
    try {
        const fixture = serverFixture(schemaA, schemaB);
        for (const sql of fixture.statements) await client.query(sql);
        let calls = 0;
        const read = async (relation: DatabaseRelationV1) => structureResult(await executeMysqlOperation(structureInput(relation), async statement => {
            calls++;
            const [rows, fields] = await client.execute(statement.text, statement.values);
            return mysqlNativeResult(rows, fields);
        }));
        const result = await read(fixture.relation);
        expect(result.foreignKeys).toEqual(fixture.outgoing);
        expect(result.incomingForeignKeys).toEqual(fixture.incoming);
        expect(calls).toBe(4);
        calls = 0;
        expect((await read(fixture.left)).incomingForeignKeys).toEqual([]);
        expect(calls).toBe(4);
    } finally {
        try {
            await client.query(`DROP DATABASE IF EXISTS ${schemaB}`);
            await client.query(`DROP DATABASE IF EXISTS ${schemaA}`);
        } finally { await client.end(); }
    }
}, 30_000);

it('resolves SQLite implicit composite keys and finds only references from the selected schema in a single FK statement', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(`
            ATTACH ':memory:' AS scope;
            CREATE TABLE main.parent_table(id INTEGER PRIMARY KEY);
            CREATE TABLE main.other_schema_child(parent_id REFERENCES parent_table);
            CREATE TABLE scope.other_parent(id INTEGER PRIMARY KEY);
            CREATE TABLE scope.parent_table(
                first_id INT, second_id INT, parent_id REFERENCES other_parent,
                PRIMARY KEY(second_id,first_id)
            );
            CREATE TABLE scope.left_child(alpha INT, beta INT, FOREIGN KEY (beta,alpha) REFERENCES PARENT_TABLE);
            CREATE TABLE scope.right_child(left_id INT, right_id INT,
                FOREIGN KEY (right_id,left_id) REFERENCES parent_table(SECOND_ID,FIRST_ID));
            CREATE TABLE scope.unrelated_child(parent_id REFERENCES other_parent);
            CREATE TABLE scope.invalid_child(parent_id REFERENCES parent_table);
        `);
        let calls = 0;
        const relation = { schema: 'scope', name: 'parent_table' };
        const read = (name: string) => structureResult(executeSqliteOperation(structureInput({ ...relation, name }), statement => {
            calls++;
            const query = db.prepare(statement.text);
            query.setReturnArrays(true);
            return { columns: [], rows: query.all(...statement.values), changes: null };
        }));
        const result = read(relation.name);
        expect(result.foreignKeys).toEqual([
            { name: 'parent_table_fk_0', target: { schema: 'scope', name: 'other_parent' }, columns: ['parent_id'], targetColumns: ['id'] },
        ]);
        expect(result.incomingForeignKeys).toEqual([
            { name: 'left_child_fk_0', source: { schema: 'scope', name: 'left_child' }, sourceColumns: ['beta', 'alpha'], targetColumns: ['second_id', 'first_id'] },
            { name: 'right_child_fk_0', source: { schema: 'scope', name: 'right_child' }, sourceColumns: ['right_id', 'left_id'], targetColumns: ['second_id', 'first_id'] },
        ]);
        // Identity, columns, indexes, one FK lookup, and two reads for the PK index.
        expect(calls).toBe(6);
        calls = 0;
        expect(read('left_child').incomingForeignKeys).toEqual([]);
        expect(calls).toBe(4);
    } finally { db.close(); }
});
