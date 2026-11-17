import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import { DatabaseOperationInputV1Schema, type DatabaseOperationInputV1 } from '@happier-dev/database-protocol';
import { quoteMysqlIdentifier } from '@happier-dev/databases/mysql';
import { mysqlConnectionOptions, mysqlNativeResult, openMysqlConnection, type MysqlConnection } from './mysql.js';

const address = process.env.HAPPIER_TEST_MYSQL_URL;
const suite = address ? describe : describe.skip;
suite('MySQL 8 real transport fixture', () => {
    let bootstrap: Connection;
    let connection: MysqlConnection;
    let databaseCreated = false;
    const database = `dbw_u3_${process.pid}`;
    const target = { kind: 'manual' as const, accountId: 'a', installationId: 'i', projectKey: 'p', savedSecretId: 's',
        workspace: { serverId: 'h', machineId: 'm', workspaceId: 'w', rootPath: '/project' } };
    const relation = (name: string) => ({ schema: database, name });
    const run = (sql: string) => connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql, parameters: [] } });
    beforeAll(async () => {
        bootstrap = await createConnection(mysqlConnectionOptions(address!));
        await bootstrap.query(`CREATE DATABASE ${quoteMysqlIdentifier(database)}`);
        databaseCreated = true;
        await bootstrap.query(`USE ${quoteMysqlIdentifier(database)}`);
        await bootstrap.query('CREATE TABLE items (id BIGINT UNSIGNED PRIMARY KEY,label TEXT NULL,amount DECIMAL(38,18),doc JSON,data VARBINARY(16),ts DATETIME(6),computed INT GENERATED ALWAYS AS (CHAR_LENGTH(label)) STORED) ENGINE=InnoDB');
        await bootstrap.execute('INSERT INTO items(id,label,amount,doc,data,ts) VALUES (?,?,?,?,?,?)', ['18446744073709551615', null, '123.000000000000000001', '{"large":18446744073709551615}', Buffer.from([0, 255]), '2026-11-16 12:34:56.123456']);
        await bootstrap.query("CREATE TABLE pages(a INT,b INT,label TEXT,PRIMARY KEY(a,b)) ENGINE=InnoDB");
        await bootstrap.query("INSERT INTO pages VALUES (1,1,'a'),(1,2,'a'),(2,1,NULL),(2,2,NULL)");
        await bootstrap.query('CREATE TABLE keyless(label TEXT) ENGINE=InnoDB');
        await bootstrap.query('CREATE TABLE nontransactional(id INT PRIMARY KEY,label TEXT) ENGINE=MyISAM');
        await bootstrap.query('CREATE TABLE triggered(id INT PRIMARY KEY,label TEXT NULL) ENGINE=InnoDB');
        await bootstrap.query('INSERT INTO triggered VALUES (1,NULL)');
        await bootstrap.query('CREATE TABLE trigger_audit(id INT) ENGINE=MyISAM');
        await bootstrap.query('CREATE TRIGGER triggered_after_update AFTER UPDATE ON triggered FOR EACH ROW INSERT INTO trigger_audit VALUES (NEW.id)');
        await bootstrap.query("CREATE FUNCTION analyze_mutate() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE items SET label='analyzed'; RETURN 1; END");
        await bootstrap.query('CREATE VIEW item_view AS SELECT id,label FROM items');
        await bootstrap.query('CREATE TABLE child(id INT PRIMARY KEY,parent BIGINT UNSIGNED,INDEX parent_idx(parent),CONSTRAINT parent_fk FOREIGN KEY(parent) REFERENCES items(id)) ENGINE=InnoDB');
        const url = new URL(address!); url.pathname = `/${database}`;
        connection = await openMysqlConnection(url.toString());
    });
    afterAll(async () => {
        await connection?.close();
        if (bootstrap) {
            if (databaseCreated) await bootstrap.query(`DROP DATABASE ${quoteMysqlIdentifier(database)}`);
            await bootstrap.end();
        }
    });

    it('round-trips exact native values, duplicate labels and zero-row metadata through prepared execute', async () => {
        const result = await run('SELECT id AS same,label AS same,amount,doc,data,ts,\'\' AS `empty` FROM items');
        if (!result.ok || result.operation !== 'statement.run') throw new Error(JSON.stringify(result));
        expect(result.results[0]!.rows[0]!.cells).toEqual([
            { type: 'integer', value: '18446744073709551615' }, { type: 'null' },
            { type: 'decimal', value: '123.000000000000000001' },
            { type: 'json', value: '{"large": 18446744073709551615}' },
            { type: 'binary', encoding: 'base64', value: 'AP8=' },
            { type: 'temporal', nativeType: 'DATETIME', value: '2026-11-16 12:34:56.123456' }, { type: 'text', value: '' },
        ]);
        expect(result.results[0]!.columns.slice(0, 2).map(column => column.name)).toEqual(['same', 'same']);
        const empty = await run('SELECT id AS same,label AS same FROM items WHERE FALSE');
        expect(empty).toMatchObject({ ok: true, results: [{ columns: [{ name: 'same' }, { name: 'same' }], rows: [] }] });
    });

    it('projects a bounded native read window by column ordinal when result labels are duplicated', async () => {
        const input = DatabaseOperationInputV1Schema.parse({ operation: 'statement.run', target, mode: 'read',
            statement: { sql: "SELECT 'duplicate' AS duplicate, UNHEX('00FF1020') AS duplicate", parameters: [] },
            demand: { rows: 1, window: { kind: 'cell', row: 0, column: 1, range: { offset: 1, length: 2, unit: 'bytes' } } },
        });
        const result = await connection.execute(input);
        if (!result.ok || result.operation !== 'statement.run') throw new Error(JSON.stringify(result));
        expect(result.results).toHaveLength(1);
        expect(result.results[0]!.columns.map(column => ({ name: column.name, semanticType: column.semanticType })))
            .toEqual([{ name: 'duplicate', semanticType: 'binary' }]);
        expect(result.results[0]!.rows).toEqual([{ cells: [{ type: 'partial', valueType: 'binary', encoding: 'base64',
            value: '/xA=', range: { offset: 1, length: 2, total: 4, unit: 'bytes' } }] }]);
        expect(result.results[0]!.completeness).toMatchObject({ complete: false, continuation: {
            kind: 'rerun', snapshot: false, input: 'original', demand: { window: { kind: 'cell', row: 0, column: 1,
                range: { offset: 3, length: 1, unit: 'bytes' } } },
        } });
    });

    it('executes native stats using the held database identity and the current requested selection', async () => {
        expect(await run('SELECT 1 AS control')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
        const input = DatabaseOperationInputV1Schema.parse({ operation: 'stats.read', target,
            request: { kind: 'stats.read', group: 'size', selection: {} },
        });
        const first = await connection.execute(input);
        expect(first).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'available', engineId: 'mysql', group: 'size', scope: { database },
            data: { bytes: expect.stringMatching(/^\d+$/u), measurement: 'table_bytes_estimate' },
        } });
        if (!first.ok || first.operation !== 'stats.read') throw new Error(JSON.stringify(first));
        const second = await connection.execute(input);
        if (!second.ok || second.operation !== 'stats.read') throw new Error(JSON.stringify(second));
        expect(second.observation.intervalBasis).toEqual(first.observation.intervalBasis);
        const selected = await connection.execute(DatabaseOperationInputV1Schema.parse({ operation: 'stats.read', target,
            request: { kind: 'stats.read', group: 'size', selection: { relation: relation('items') } },
        }));
        expect(selected).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'available', group: 'size', scope: { database, relation: relation('items') },
        } });
        if (!selected.ok || selected.operation !== 'stats.read') throw new Error(JSON.stringify(selected));
        expect(selected.observation.intervalBasis.databaseIdentity).toBe(first.observation.intervalBasis.databaseIdentity);
        expect(selected.observation.intervalBasis.bindingKey).toBe(first.observation.intervalBasis.bindingKey);
        expect(selected.observation.intervalBasis.selectionKey).not.toBe(first.observation.intervalBasis.selectionKey);
    });

    it('preserves ordinary read statements on a connection without a default database', async () => {
        const url = new URL(address!); url.pathname = '/';
        const unselected = await openMysqlConnection(url.toString());
        try {
            expect(await unselected.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT 1 AS control', parameters: [],
            } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
        } finally { await unselected.close(); }
    });

    it('blocks read transaction mutation, implicit-commit DDL, session escape and multiple statements', async () => {
        expect(await run("UPDATE items SET label='escaped'")).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' } });
        for (const sql of ["COMMIT; UPDATE items SET label='escaped'", 'CREATE TABLE escaped(id INT)', 'SET SESSION transaction_read_only=0', 'SET SESSION sql_mode=\'\'']) {
            expect(await run(sql)).toMatchObject({ ok: false, code: 'unsupported_action' });
        }
        expect(await run('SELECT label FROM items')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
        expect(await connection.execute({ operation: 'statement.explain', target, accessMode: 'read', mode: 'analyze', statement: { sql: 'SELECT id FROM items', parameters: [] } })).toMatchObject({ ok: true, operation: 'statement.explain', format: 'text' });
    });

    it('executes reviewed console statements in one transaction and rolls back on a later native error', async () => {
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'INSERT INTO keyless(label) VALUES (?)', parameters: [{ type: 'text', value: 'first; still one value' }] },
            { sql: 'INSERT INTO keyless(label) VALUES (?)', parameters: [{ type: 'text', value: 'second' }] },
        ] })).toMatchObject({ ok: true, results: [{ affectedRows: '1' }, { affectedRows: '1' }] });
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: "UPDATE items SET label='rolled back'", parameters: [] },
            { sql: 'UPDATE missing_console_relation SET label=?', parameters: [{ type: 'text', value: 'fails' }] },
        ] })).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: 'ER_NO_SUCH_TABLE', statementIndex: 1 } });
        expect(await run('SELECT label FROM items')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
        expect(await connection.execute({ operation: 'statement.explain', target, accessMode: 'write', mode: 'plan', statement: {
            sql: 'UPDATE items SET label=? WHERE id=?', parameters: [{ type: 'text', value: 'explained' }, { type: 'integer', value: '18446744073709551615' }],
        } })).toMatchObject({ ok: true, operation: 'statement.explain', format: 'json' });
    });

    it('rolls back a supported write Explain Analyze after the engine executes a stored function', async () => {
        expect(await connection.execute({ operation: 'statement.explain', target, accessMode: 'write', mode: 'analyze', statement: {
            sql: 'SELECT analyze_mutate()', parameters: [],
        } })).toMatchObject({ ok: true, operation: 'statement.explain', format: 'text' });
        expect(await run('SELECT label FROM items')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
    });

    it('admits every console statement before the first mutation, including nontransactional writes', async () => {
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'INSERT INTO nontransactional(id,label) VALUES (99,?)', parameters: [{ type: 'text', value: 'must not run' }] },
            { sql: 'COMMIT', parameters: [] },
        ] })).toMatchObject({ ok: false, code: 'unsupported_action' });
        expect(await run('SELECT COUNT(*) FROM nontransactional WHERE id=99')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '0' }] }] }] });
    });

    it('uses structure metadata, composite keyset and NULL continuation without losing hidden keys', async () => {
        const input: DatabaseOperationInputV1 = { operation: 'rows.read', target, relation: relation('pages'), columns: ['label'], order: [{ column: 'label', direction: 'asc', nulls: 'last' }], page: { rows: 2 } };
        const first = await connection.execute(input);
        expect(first).toMatchObject({ ok: true, operation: 'rows.read', result: { rows: [{ identity: { key: [{ column: 'a' }, { column: 'b' }] } }, {}], completeness: { complete: false, continuation: { kind: 'keyset' } } } });
        if (!first.ok || first.operation !== 'rows.read' || first.result.completeness.complete || first.result.completeness.continuation?.kind !== 'keyset') throw new Error(JSON.stringify(first));
        const next = await connection.execute({ ...input, page: { rows: 2, continuation: first.result.completeness.continuation } });
        expect(next).toMatchObject({ ok: true, result: { rows: [{ cells: [{ type: 'null' }] }, { cells: [{ type: 'null' }] }], completeness: { complete: true } } });
    });

    it('loads selected schema, relation, generated-column, index and ordered foreign-key metadata', async () => {
        expect(await connection.execute({ operation: 'schemas.list', target, search: database, page: { rows: 1 } })).toMatchObject({ ok: true, schemas: [{ name: database }] });
        expect(await connection.execute({ operation: 'relations.list', target, schema: database, search: 'item_view', page: { rows: 1 } })).toMatchObject({ ok: true, relations: [{ relation: relation('item_view'), kind: 'view' }] });
        expect(await connection.execute({ operation: 'relation.structure', target, relation: relation('child') })).toMatchObject({ ok: true, structure: {
            primaryKey: ['id'], indexes: [{ name: 'parent_idx', unique: false, primary: false, columns: [{ kind: 'column', column: 'parent', direction: 'asc' }] }, { name: 'PRIMARY', unique: true, primary: true }],
            foreignKeys: [{ name: 'parent_fk', columns: ['parent'], target: relation('items'), targetColumns: ['id'] }],
        } });
        const metadata = await connection.execute({ operation: 'relation.structure', target, relation: relation('items') });
        expect(metadata.ok && metadata.operation === 'relation.structure' && metadata.structure.columns.find(column => column.name === 'computed')?.generated).toBe(true);
    });

    it('rolls back an earlier update on a later optimistic conflict and permits no-op matches', async () => {
        const key = [{ column: 'id', value: { type: 'integer' as const, value: '18446744073709551615' } }];
        const update = (old: string | null, value: string) => ({ kind: 'update' as const, key, original: [{ column: 'label', value: old === null ? { type: 'null' as const } : { type: 'text' as const, value: old } }], values: [{ column: 'label', value: { kind: 'value' as const, cell: { type: 'text' as const, value } } }] });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('items'), changes: [update(null, 'first'), update('wrong', 'second')] })).toMatchObject({ ok: false, status: 'conflict', changeIndex: 1 });
        expect(await run('SELECT label FROM items')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('items'), changes: [update(null, 'A😀éZ')] })).toMatchObject({ ok: true, status: 'committed', updated: '1' });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('items'), changes: [update('A😀éZ', 'A😀éZ')] })).toMatchObject({ ok: true, status: 'committed', updated: '1' });
    });

    it('keeps keyless inserts available and views/nontransactional tables unavailable for edits', async () => {
        const insert = { kind: 'insert' as const, values: [{ column: 'label', value: { kind: 'value' as const, cell: { type: 'text' as const, value: 'value' } } }] };
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('keyless'), changes: [insert] })).toMatchObject({ ok: true, inserted: '1' });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('nontransactional'), changes: [insert] })).toMatchObject({ ok: false, status: 'unavailable', reason: 'nontransactional_storage_engine' });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('item_view'), changes: [insert] })).toMatchObject({ ok: false, status: 'unavailable', reason: 'relation_read_only' });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('keyless'), changes: [{ kind: 'delete', key: [{ column: 'label', value: { type: 'text', value: 'value' } }] }] })).toMatchObject({ ok: false, status: 'unavailable', reason: 'primary_key_required' });
    });

    it('preserves the accepted MySQL limitation: trigger writes to MyISAM survive a conflicting edit rollback', async () => {
        const update = (original: string | null, value: string) => ({ kind: 'update' as const,
            key: [{ column: 'id', value: { type: 'integer' as const, value: '1' } }],
            original: [{ column: 'label', value: original === null ? { type: 'null' as const } : { type: 'text' as const, value: original } }],
            values: [{ column: 'label', value: { kind: 'value' as const, cell: { type: 'text' as const, value } } }],
        });
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('triggered'), changes: [update(null, 'first'), update('wrong', 'second')] }))
            .toMatchObject({ ok: false, status: 'conflict', changeIndex: 1 });
        expect(await run('SELECT label FROM triggered')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
        expect(await run('SELECT COUNT(*) FROM trigger_audit')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
    });

    it('compares original JSON content using its native representation and preserves JSON null versus SQL NULL', async () => {
        expect(await connection.execute({ operation: 'edits.apply', target, relation: relation('items'), changes: [{
            kind: 'update', key: [{ column: 'id', value: { type: 'integer', value: '18446744073709551615' } }],
            original: [{ column: 'doc', value: { type: 'json', value: '{"large": 18446744073709551615}' } }],
            values: [{ column: 'doc', value: { kind: 'value', cell: { type: 'json', value: 'null' } } }],
        }] })).toMatchObject({ ok: true, updated: '1' });
        expect(await run('SELECT doc FROM items')).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'json', value: 'null' }] }] }] });
    });

    it('returns byte ranges on UTF-8 boundaries and exact binary slices', async () => {
        await bootstrap.execute('UPDATE items SET label=? WHERE id=?', ['A😀éZ', '18446744073709551615']);
        const base = { operation: 'cell.read' as const, target, relation: relation('items'), key: [{ column: 'id', value: { type: 'integer' as const, value: '18446744073709551615' } }] };
        expect(await connection.execute({ ...base, column: 'label', range: { offset: 0, length: 4, unit: 'utf8_bytes' } })).toMatchObject({ ok: true, value: { type: 'partial', value: 'A', range: { offset: 0, length: 1, total: 8 } }, completeness: { complete: false, continuation: { range: { offset: 1 } } } });
        expect(await connection.execute({ ...base, column: 'data', range: { offset: 1, length: 1, unit: 'bytes' } })).toMatchObject({ ok: true, value: { type: 'partial', value: '/w==', range: { offset: 1, length: 1, total: 2 } } });
    });

    it('cancels an observed running statement and releases its engine-side connection resources', async () => {
        const url = new URL(address!); url.pathname = `/${database}`;
        const cancellable = await openMysqlConnection(url.toString());
        const controller = new AbortController();
        const lock = `dbw_cancel_${process.pid}`;
        const pending = cancellable.execute({ operation: 'statement.run', target, mode: 'read', statement: {
            sql: 'SELECT GET_LOCK(?,0),SLEEP(30)', parameters: [{ type: 'text', value: lock }],
        } }, controller.signal);
        try {
            for (;;) {
                const [rows, fields] = await bootstrap.execute('SELECT IS_USED_LOCK(?)', [lock]);
                if (mysqlNativeResult(rows, fields).rows[0]?.[0] !== null) break;
            }
            controller.abort();
            expect(await pending).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
            const [rows, fields] = await bootstrap.execute('SELECT IS_USED_LOCK(?)', [lock]);
            expect(mysqlNativeResult(rows, fields).rows[0]?.[0]).toBeNull();
        } finally { controller.abort(); await cancellable.close(); }
    });

    it('preserves the engine cause when the cancellation control connection cannot authenticate', async () => {
        const user = `dbw_cancel_${process.pid}`;
        const url = new URL(address!); url.pathname = `/${database}`; url.username = user; url.password = 'before';
        let cancellable: MysqlConnection | undefined;
        let userCreated = false;
        const controller = new AbortController();
        const lock = `dbw_cancel_denied_${process.pid}`;
        let owner: string | number | Buffer | null | undefined;
        try {
            await bootstrap.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'before'`);
            userCreated = true;
            await bootstrap.query(`GRANT SELECT ON ${quoteMysqlIdentifier(database)}.* TO '${user}'@'%'`);
            cancellable = await openMysqlConnection(url.toString());
            const pending = cancellable.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT GET_LOCK(?,0),SLEEP(30)', parameters: [{ type: 'text', value: lock }],
            } }, controller.signal);
            do {
                const [rows, fields] = await bootstrap.execute('SELECT IS_USED_LOCK(?)', [lock]);
                owner = mysqlNativeResult(rows, fields).rows[0]?.[0];
            } while (owner === null);
            // Existing requests remain admitted; a new cancellation connection encounters changed authentication.
            await bootstrap.query(`ALTER USER '${user}'@'%' IDENTIFIED BY 'after'`);
            controller.abort();
            expect(await pending).toMatchObject({ ok: false, status: 'failed', code: 'database_engine_error', cause: { code: 'ER_ACCESS_DENIED_ERROR' } });
        } finally {
            controller.abort();
            await cancellable?.close().catch(() => {});
            if (typeof owner === 'number' || (typeof owner === 'string' && /^\d+$/u.test(owner))) {
                const [rows, fields] = await bootstrap.execute('SELECT IS_USED_LOCK(?)', [lock]);
                if (String(mysqlNativeResult(rows, fields).rows[0]?.[0]) === String(owner)) await bootstrap.query(`KILL CONNECTION ${owner}`);
            }
            if (userCreated) await bootstrap.query(`DROP USER '${user}'@'%'`);
        }
    });
});
