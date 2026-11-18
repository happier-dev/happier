import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { DatabaseOperationInputV1, DatabaseTargetV1 } from '@happier-dev/database-protocol';
import { DatabaseOperationResultV1Schema, DatabaseTargetV1Schema } from '@happier-dev/database-protocol';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { openSqliteConnection, type SqliteConnection } from './sqlite.js';

const target: DatabaseTargetV1 = DatabaseTargetV1Schema.parse({ kind: 'worktree', accountId: 'a', installationId: 'i', projectKey: 'p',
    workspace: { serverId: 's', workspaceId: 'w', machineId: 'm', rootPath: '/work' }, source: { kind: 'sqlite_file', path: 'fixture.sqlite' } });
const relation = { schema: 'main', name: 'records' };
const value = (text: string) => ({ kind: 'value' as const, cell: { type: 'text' as const, value: text } });
const cell = (column: string, text: string) => ({ column, value: { type: 'text' as const, value: text } });
const dirs: string[] = []; const connections: SqliteConnection[] = [];
const measurements: Array<{ operation: string; elapsedMs: number }> = [];
afterAll(() => {
    const operations = [...new Set(measurements.map(item => item.operation))];
    console.info('SQLite caller-thread fixture observations', { node: process.version, rows: 4, columns: 8,
        operations: operations.map(operation => { const values = measurements.filter(item => item.operation === operation).map(item => item.elapsedMs); return { operation, samples: values.length, maxMs: Math.max(...values) }; }) });
});
afterEach(async () => { await Promise.all(connections.splice(0).map(connection => connection.close())); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(readOnly = false) {
    const dir = mkdtempSync(join(tmpdir(), 'happier-workbench-sqlite-')); dirs.push(dir);
    const path = join(dir, 'fixture.sqlite'); const db = openSqliteDatabaseSync(path);
    db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'default', bucket TEXT, amount INTEGER, payload JSON, bytes BLOB, derived TEXT GENERATED ALWAYS AS (upper(label)) VIRTUAL, parent_id INTEGER REFERENCES parent(id));
        CREATE INDEX records_label ON records(label DESC) WHERE label IS NOT NULL;
        CREATE TABLE keyless (label TEXT DEFAULT 'default');
        CREATE VIEW visible AS SELECT id,label FROM records;
        INSERT INTO records(id,label,bucket,amount,payload,bytes) VALUES (1,'',NULL,9223372036854775807,'null',x'00ff'), (2,'two','a',2,'{"n":9223372036854775807}',x''), (3,'three','a',3,NULL,NULL), (4,'four',NULL,4,NULL,NULL);`);
    db.close(); const connection = await openSqliteConnection(path, { readOnly }); connections.push(connection);
    const execute = async (input: DatabaseOperationInputV1) => { const started = performance.now(); const pending = connection.execute(input); measurements.push({ operation: input.operation, elapsedMs: performance.now() - started }); const result = await pending; expect(DatabaseOperationResultV1Schema.safeParse(result).success).toBe(true); return result; };
    return { connection, execute, path, dir };
}
describe('SQLite selected-file operations', () => {
    it('pages schema and relation summaries without hiding valid sqlite-prefixed user tables', async () => {
        const { execute, path } = await fixture(true);
        const db = openSqliteDatabaseSync(path); db.exec('CREATE TABLE sqlitex (id INTEGER)'); db.close();
        expect(await execute({ operation: 'schemas.list', target, page: { rows: 2 } })).toMatchObject({ ok: true, schemas: [{ name: 'main' }], completeness: { complete: true } });
        expect(await execute({ operation: 'relations.list', target, schema: 'main', search: 'sqlitex', page: { rows: 2 } })).toMatchObject({ ok: true, relations: [{ relation: { schema: 'main', name: 'sqlitex' }, kind: 'table' }], completeness: { complete: true } });
        expect(await execute({ operation: 'relations.list', target, schema: 'main', page: { rows: 1 } })).toMatchObject({ ok: true, relations: [{ relation: { name: 'keyless' } }], completeness: { complete: false, continuation: { kind: 'catalog', after: 'keyless' } } });
    });
    it('preserves native metadata, duplicate labels, NULL/empty/JSON and bigint values through the real SDK', async () => {
        const { execute } = await fixture(true);
        const result = await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT amount AS same,label AS same,bucket,payload,bytes FROM records WHERE id=?', parameters: [{ type: 'integer', value: '1' }] } });
        expect(result).toMatchObject({ ok: true, results: [{ columns: [{ name: 'same', nativeType: 'INTEGER' }, { name: 'same', nativeType: 'TEXT' }, {}, { nativeType: 'JSON' }, {}], rows: [{ cells: [{ type: 'integer', value: '9223372036854775807' }, { type: 'text', value: '' }, { type: 'null' }, { type: 'json', value: 'null' }, { type: 'binary', value: 'AP8=' }] }] }] });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT id,label FROM records WHERE 0', parameters: [] } })).toMatchObject({ ok: true, results: [{ columns: [{ name: 'id', nativeType: 'INTEGER' }, { name: 'label', nativeType: 'TEXT' }], rows: [] }] });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT amount AS same,bytes AS same FROM records WHERE id=1', parameters: [] },
            demand: { rows: 1, window: { kind: 'cell', row: 0, column: 1, range: { unit: 'bytes', offset: 1, length: 1 } } } })).toMatchObject({ ok: true, results: [{
            columns: [{ name: 'same', nativeType: 'BLOB' }], rows: [{ cells: [{ type: 'partial', valueType: 'binary', value: '/w==', range: { unit: 'bytes', offset: 1, length: 1, total: 2 } }] }],
            completeness: { complete: false },
        }] });
    });
    it('binds named, numbered and anonymous parameters in native index order', async () => {
        const { execute } = await fixture(true);
        const one = { type: 'text', value: 'one' } as const;
        const three = { type: 'text', value: 'three' } as const;
        const four = { type: 'integer', value: '9007199254740993' } as const;
        const five = { type: 'text', value: '' } as const;
        const six = { type: 'binary', encoding: 'base64', value: 'AQI=' } as const;
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: {
            sql: 'SELECT ?2, ?1, ?', parameters: [one, four, { type: 'null' }],
        } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [four, one, { type: 'null' }] }] }] });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: {
            sql: 'SELECT ?3, :same, @same, ?, :same AS repeated, ?1, ?4',
            parameters: [one, { type: 'null' }, three, four, five, six],
        } })).toMatchObject({ ok: true, results: [{
            columns: ['?3', ':same', '@same', '?', 'repeated', '?1', '?4'].map(name => ({ name })),
            rows: [{ cells: [three, four, five, six, four, one, four] }],
        }] });
    });
    it('reads native statistics with held file capabilities and typed unavailable groups', async () => {
        const { connection, execute } = await fixture(true);
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: {
            sql: 'SELECT 1 AS control', parameters: [],
        } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
        const facts = await execute({ operation: 'statement.run', target, mode: 'read', statement: {
            sql: "SELECT file,EXISTS(SELECT 1 FROM pragma_module_list WHERE name='dbstat') FROM pragma_database_list WHERE name='main'", parameters: [],
        } });
        if (!facts.ok || facts.operation !== 'statement.run') throw new Error('Missing native file facts');
        const filename = facts.results[0]?.rows[0]?.cells[0];
        const capability = facts.results[0]?.rows[0]?.cells[1];
        if (filename?.type !== 'text' || capability?.type !== 'integer') throw new Error('Invalid native file facts');
        const dbstat = capability.value === '1';
        const tablesInput = { operation: 'stats.read', target, request: { kind: 'stats.read', group: 'tables', selection: { relation } } } as const;
        const tables = await execute(tablesInput);
        expect(tables).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'available', group: 'tables', engineId: 'sqlite', scope: { database: filename.value, relation },
            data: [{ relation }], coverage: dbstat ? { status: 'complete' } : { status: 'partial', reasons: ['dbstat_unavailable'] },
        } });
        const size = await execute({ operation: 'stats.read', target, request: { kind: 'stats.read', group: 'size', selection: {} } });
        expect(size).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'available', group: 'size', scope: { database: filename.value },
            data: { measurement: 'page_allocation', bytes: expect.stringMatching(/^\d+$/u) },
        } });
        if (!tables.ok || tables.operation !== 'stats.read' || !size.ok || size.operation !== 'stats.read') throw new Error('Missing native statistics');
        expect(size.observation.intervalBasis.databaseIdentity).toEqual(tables.observation.intervalBasis.databaseIdentity);
        expect(size.observation.intervalBasis.bindingKey).toEqual(tables.observation.intervalBasis.bindingKey);
        expect(size.observation.intervalBasis.selectionKey).not.toEqual(tables.observation.intervalBasis.selectionKey);
        expect(await execute(tablesInput)).toMatchObject({ ok: true, operation: 'stats.read', observation: { intervalBasis: tables.observation.intervalBasis } });
        expect(await execute({ operation: 'stats.read', target, request: { kind: 'stats.read', group: 'size', selection: { relation } } })).toMatchObject({ ok: true, operation: 'stats.read', observation: dbstat
            ? { status: 'available', group: 'size', data: { measurement: 'page_allocation', bytes: expect.stringMatching(/^\d+$/u) } }
            : { status: 'unavailable', group: 'size', reason: 'dbstat_unavailable' } });
        expect(await execute({ operation: 'stats.read', target, request: { kind: 'stats.read', group: 'statements', selection: { page: { rows: 2 }, order: 'calls' } } })).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'unavailable', group: 'statements', reason: 'unsupported_group',
        } });
        const cancelled = new AbortController(); cancelled.abort();
        expect(await connection.execute(tablesInput, cancelled.signal)).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
    });
    it('returns selected structure and binds filters; pages mixed NULL order with a composite continuation', async () => {
        const { execute } = await fixture(true);
        expect(await execute({ operation: 'relation.structure', target, relation })).toMatchObject({ ok: true, structure: { primaryKey: ['id'], columns: expect.arrayContaining([expect.objectContaining({ name: 'id', nullable: false }), { name: 'derived', nativeType: 'TEXT', semanticType: 'text', nullable: true, generated: true, defaultExpression: null }]), indexes: [expect.objectContaining({ name: 'records_label', columns: [{ kind: 'column', column: 'label', direction: 'desc' }] })], foreignKeys: [{ columns: ['parent_id'], target: { schema: 'main', name: 'parent' }, targetColumns: ['id'], name: expect.any(String) }] } });
        const input = { operation: 'rows.read' as const, target, relation, columns: ['id', 'label'], filter: { kind: 'comparison' as const, column: 'id', operator: 'gte' as const, value: { type: 'integer' as const, value: '1' } }, order: [{ column: 'bucket', direction: 'asc' as const, nulls: 'first' as const }], page: { rows: 2 } };
        const first = DatabaseOperationResultV1Schema.parse(await execute(input));
        expect(first).toMatchObject({ ok: true, result: { rows: [{ cells: [{ value: '1' }, { value: '' }] }, { cells: [{ value: '4' }, { value: 'four' }] }], completeness: { complete: false, continuation: { kind: 'keyset' } } } });
        if (!first.ok || first.operation !== 'rows.read' || first.result.completeness.complete || first.result.completeness.continuation?.kind !== 'keyset') throw new Error('Missing keyset');
        expect(await execute({ ...input, page: { rows: 2, continuation: first.result.completeness.continuation } })).toMatchObject({ ok: true, result: { rows: [{ cells: [{ value: '2' }, { value: 'two' }] }, { cells: [{ value: '3' }, { value: 'three' }] }], completeness: { complete: true } } });
        expect(await execute({ ...input, filter: { kind: 'comparison', column: 'label', operator: 'eq', value: { type: 'text', value: "' OR 1=1 --" } } })).toMatchObject({ ok: true, result: { rows: [] } });
    });
    it('resumes envelope-truncated projected rows in hidden sort order without losing or repeating rows', async () => {
        const { execute, path } = await fixture();
        const db = openSqliteDatabaseSync(path);
        try {
            db.exec('CREATE TABLE projected_page (id INTEGER PRIMARY KEY, payload TEXT, rank INTEGER NOT NULL)');
            // Cells also occur in optimistic identity originals, so two rows
            // cross the real Action envelope while one complete row still fits.
            const payload = 'x'.repeat(Math.floor(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 4));
            const insert = db.prepare('INSERT INTO projected_page VALUES (?,?,?)');
            insert.run(1, payload, 30); insert.run(2, payload, 10); insert.run(3, payload, 20);
        } finally { db.close(); }
        const input = { operation: 'rows.read' as const, target, relation: { schema: 'main', name: 'projected_page' },
            columns: ['id', 'payload'], order: [{ column: 'rank', direction: 'asc' as const }], page: { rows: 3 } };
        let page: Extract<DatabaseOperationInputV1, { operation: 'rows.read' }>['page'] = input.page;
        for (const [position, expectedId] of ['2', '3', '1'].entries()) {
            const result = await execute({ ...input, page });
            if (!result.ok || result.operation !== 'rows.read') throw new Error('Missing projected row page');
            expect(result.result.columns.map(column => column.name)).toEqual(['id', 'payload']);
            expect(result.result.rows.map(row => row.cells[0])).toEqual([{ type: 'integer', value: expectedId }]);
            if (position === 2) { expect(result.result.completeness).toEqual({ complete: true }); continue; }
            expect(result.result.completeness).toMatchObject({ complete: false, reason: 'response_envelope', continuation: {
                kind: 'keyset', values: expect.arrayContaining([{ column: 'rank', value: { type: 'integer', value: String((position + 1) * 10) } }]),
            } });
            if (result.result.completeness.complete || result.result.completeness.continuation?.kind !== 'keyset') throw new Error('Missing envelope continuation');
            page = { rows: 3, continuation: result.result.completeness.continuation };
        }
    });
    it('applies changes atomically and rolls back earlier writes on optimistic conflicts and statement failures', async () => {
        const { execute } = await fixture();
        const key = [{ column: 'id', value: { type: 'integer' as const, value: '2' } }];
        expect(await execute({ operation: 'edits.apply', target, relation, changes: [{ kind: 'insert', values: [{ column: 'label', value: value('inserted') }] }, { kind: 'update', key, original: [cell('label', 'stale')], values: [{ column: 'label', value: value('changed') }] }] })).toMatchObject({ status: 'conflict', code: 'database_edit_conflict', changeIndex: 1 });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "SELECT count(*) AS count FROM records WHERE label='inserted'", parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: '0' }] }] }] });
        expect(await execute({ operation: 'edits.apply', target, relation, changes: [{ kind: 'update', key, original: [cell('label', 'two')], values: [{ column: 'label', value: value('changed') }] }, { kind: 'delete', key: [{ column: 'id', value: { type: 'integer', value: '3' } }] }] })).toMatchObject({ ok: true, updated: '1', deleted: '1' });
        expect(await execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: "INSERT INTO keyless VALUES ('rolled back')", parameters: [] }, { sql: 'INSERT INTO missing VALUES (1)', parameters: [] }] })).toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: expect.any(String), statementIndex: 1 } });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT * FROM keyless', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [] }] });
        expect(await execute({ operation: 'edits.apply', target, relation, changes: [{ kind: 'insert', values: [{ column: 'parent_id', value: { kind: 'value', cell: { type: 'integer', value: '999' } } }] }] })).toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine' } });
    });
    it('keeps views read-only and keyless tables insert-only, including DEFAULT and generated columns', async () => {
        const { execute } = await fixture();
        expect(await execute({ operation: 'edits.apply', target, relation: { schema: 'main', name: 'visible' }, changes: [{ kind: 'insert', values: [] }] })).toMatchObject({ ok: false, status: 'unavailable' });
        expect(await execute({ operation: 'edits.apply', target, relation: { schema: 'main', name: 'keyless' }, changes: [{ kind: 'insert', values: [{ column: 'label', value: { kind: 'default' } }] }] })).toMatchObject({ ok: true, inserted: '1' });
        expect(await execute({ operation: 'edits.apply', target, relation: { schema: 'main', name: 'keyless' }, changes: [{ kind: 'delete', key: [cell('label', 'default')] }] })).toMatchObject({ ok: false, status: 'unavailable' });
        expect(await execute({ operation: 'edits.apply', target, relation, changes: [{ kind: 'insert', values: [{ column: 'derived', value: value('bad') }] }] })).toMatchObject({ ok: false, code: 'invalid_action_input' });
    });
    it('reads binary and UTF-8 cell ranges and provides a single SQLite query plan', async () => {
        const { execute, path } = await fixture();
        const key = [{ column: 'id', value: { type: 'integer' as const, value: '1' } }];
        expect(await execute({ operation: 'cell.read', target, relation, key, column: 'bytes', range: { unit: 'bytes', offset: 0, length: 1 } })).toMatchObject({ ok: true, value: { type: 'partial', valueType: 'binary', value: 'AA==', range: { total: 2, length: 1 } }, completeness: { complete: false, continuation: { kind: 'cell', range: { offset: 1 } } } });
        expect(await execute({ operation: 'statement.explain', target, statement: { sql: 'SELECT * FROM records WHERE id=?', parameters: [{ type: 'integer', value: '1' }] }, mode: 'plan', accessMode: 'read' })).toMatchObject({ ok: true, format: 'text', plan: expect.stringContaining('SEARCH') });
        expect(await execute({ operation: 'statement.explain', target, statement: { sql: 'SELECT 1', parameters: [] }, mode: 'analyze', accessMode: 'read' })).toMatchObject({ ok: false, status: 'unavailable' });
        const db = openSqliteDatabaseSync(path); db.exec("UPDATE records SET label=x'00ff' WHERE id=1"); db.close();
        expect(await execute({ operation: 'cell.read', target, relation, key, column: 'label', range: { unit: 'bytes', offset: 0, length: 1 } })).toMatchObject({ ok: true, value: { type: 'partial', valueType: 'binary', value: 'AA==', range: { total: 2 } } });
    });
    it('never creates a missing selected database and enforces readonly admission at the native boundary', async () => {
        const { execute, dir } = await fixture(true); const missing = join(dir, 'missing.sqlite');
        await expect(openSqliteConnection(missing, { readOnly: false })).rejects.toThrow(); expect(existsSync(missing)).toBe(false);
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "INSERT INTO keyless VALUES ('forbidden')", parameters: [] } })).toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine' } });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "COMMIT; INSERT INTO keyless VALUES ('forbidden')", parameters: [] } })).toMatchObject({ ok: false, status: 'failed' });
        const escaped = join(dir, 'vacuum-copy.sqlite');
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'VACUUM main INTO ?', parameters: [{ type: 'text', value: escaped }] } })).toMatchObject({ ok: false, code: 'unsupported_action' });
        expect(existsSync(escaped)).toBe(false);
        const cancelled = new AbortController(); cancelled.abort();
        const { connection } = await fixture(); expect(await connection.execute({ operation: 'schemas.list', target, page: { rows: 3 } }, cancelled.signal)).toMatchObject({ status: 'cancelled' });
    });
    it('keeps expression/partial indexes, keyless offset paging and UTF-8 byte boundaries explicit', async () => {
        const { execute, path } = await fixture();
        const db = openSqliteDatabaseSync(path);
        db.exec(`CREATE INDEX records_expr ON records(lower(label),id DESC) WHERE id>1;
            CREATE TABLE nullable_pk (a TEXT,b TEXT,PRIMARY KEY(a,b));
            INSERT INTO nullable_pk VALUES (NULL,'x'),(NULL,'x');
            CREATE TABLE descending_pk (id INTEGER PRIMARY KEY DESC);
            INSERT INTO descending_pk VALUES (NULL),(NULL);
            INSERT INTO keyless VALUES ('one'),('two');
            UPDATE records SET label='é🙂tail' WHERE id=1;`);
        db.close();
        const result = await execute({ operation: 'relation.structure', target, relation });
        expect(result).toMatchObject({ ok: true, structure: { indexes: expect.arrayContaining([expect.objectContaining({ name: 'records_expr', columns: [{ kind: 'expression', expression: 'lower(label)', direction: 'asc' }, { kind: 'column', column: 'id', direction: 'desc' }], predicate: 'id>1' })]) } });
        expect(await execute({ operation: 'rows.read', target, relation: { schema: 'main', name: 'nullable_pk' }, columns: [], order: [], page: { rows: 1 } })).toMatchObject({ ok: true, result: { rows: [{ cells: [{ type: 'null' }, { value: 'x' }] }], completeness: { complete: false, continuation: { kind: 'offset', offset: 1 } } } });
        expect(await execute({ operation: 'rows.read', target, relation: { schema: 'main', name: 'descending_pk' }, columns: [], order: [], page: { rows: 1 } })).toMatchObject({ ok: true, result: { completeness: { complete: false, continuation: { kind: 'offset', offset: 1 } } } });
        const first = await execute({ operation: 'rows.read', target, relation: { schema: 'main', name: 'keyless' }, columns: [], order: [], page: { rows: 1 } });
        expect(first).toMatchObject({ ok: true, result: { completeness: { complete: false, continuation: { kind: 'offset', offset: 1 } } } });
        const key = [{ column: 'id', value: { type: 'integer' as const, value: '1' } }];
        expect(await execute({ operation: 'cell.read', target, relation, key, column: 'label', range: { unit: 'utf8_bytes', offset: 0, length: 4 } })).toMatchObject({ ok: true, value: { type: 'partial', value: 'é', range: { length: 2, total: 10 } }, completeness: { continuation: { kind: 'cell', range: { offset: 2 } } } });
        expect(await execute({ operation: 'cell.read', target, relation, key, column: 'label', range: { unit: 'utf8_bytes', offset: 1, length: 4 } })).toMatchObject({ ok: false, code: 'invalid_action_input', reason: 'invalid_cell_range_boundary' });
    });
    it('detects concurrent byte changes even with case-insensitive column collation and never replays RETURNING writes', async () => {
        const { execute, path } = await fixture();
        const db = openSqliteDatabaseSync(path);
        db.exec("CREATE TABLE nocase (id INTEGER PRIMARY KEY,label TEXT COLLATE NOCASE); INSERT INTO nocase VALUES (1,'TWO')"); db.close();
        expect(await execute({ operation: 'edits.apply', target, relation: { schema: 'main', name: 'nocase' }, changes: [{ kind: 'update', key: [{ column: 'id', value: { type: 'integer', value: '1' } }], values: [{ column: 'label', value: value('changed') }], original: [cell('label', 'two')] }] })).toMatchObject({ status: 'conflict', reason: 'row_changed' });
        const inserted = await execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: "INSERT INTO keyless VALUES ('only once') RETURNING label", parameters: [] }] });
        expect(inserted).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: 'only once' }] }] }] });
        if (!inserted.ok || inserted.operation !== 'statement.run') throw new Error('Missing statement result');
        expect(inserted.results[0]).not.toHaveProperty('affectedRows');
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT count(*) FROM keyless', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: '1' }] }] }] });
    });
});
describe('SQLite active native operation lifecycle', () => {
    let held: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => { held = await fixture(); });
    it('keeps the caller responsive during heavy SQL and rolls back cancellation before a later mutation on the held connection', async () => {
        const { connection, execute, path } = held;
        const turn = () => new Promise<void>(resolve => setImmediate(resolve));
        const cancel = new AbortController();
        let transactionSettled = false;
        const transaction = connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1000000) INSERT INTO keyless SELECT printf('%016x',n) FROM numbers", parameters: [] },
            { sql: "INSERT INTO keyless VALUES ('after heavy query')", parameters: [] },
        ] }, cancel.signal);
        void transaction.then(() => { transactionSettled = true; });
        // The journal appears during the million-row native INSERT. Cancellation
        // must roll it back after that call, without reaching the next mutation.
        while (!existsSync(`${path}-journal`) && !transactionSettled) await turn();
        expect(transactionSettled, 'the write transaction is active when cancellation is requested').toBe(false);
        await turn();
        cancel.abort();
        expect(await transaction).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT count(*) FROM keyless', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: '0' }] }] }] });
    });
    it('returns a committed write when cancellation arrives after the native result settles', async () => {
        const { connection, execute } = held;
        const late = new AbortController();
        const emit = Worker.prototype.emit;
        // Genuine Worker transport: deliver the abort after native COMMIT but
        // before the facade's result continuation can resume.
        const delivery = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
            const message = args[0];
            if (event === 'message' && message && typeof message === 'object' && 'kind' in message && message.kind === 'result') late.abort();
            return emit.call(this, event, ...args);
        });
        try {
            const committed = await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: "INSERT INTO keyless VALUES ('committed')", parameters: [] }] }, late.signal);
            expect(late.signal.aborted).toBe(true);
            expect(committed).toMatchObject({ ok: true, results: [{ affectedRows: '1' }] });
        } finally { delivery.mockRestore(); }
        expect(await execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT count(*) FROM keyless', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: '1' }] }] }] });
    });
    it('rolls back an active native transaction before closing the connection', async () => {
        const { connection, path } = held;
        const sql = "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1000000) SELECT sum((n%97)*(n%89)) AS checksum,sum(length(printf('%016x',n))) AS formatted_bytes FROM numbers";
        const turn = () => new Promise<void>(resolve => setImmediate(resolve));
        let disposingSettled = false;
        const disposing = connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: "INSERT INTO keyless VALUES ('before close')", parameters: [] }, { sql, parameters: [] },
            { sql: "INSERT INTO keyless VALUES ('after close')", parameters: [] },
        ] });
        void disposing.then(() => { disposingSettled = true; });
        while (!existsSync(`${path}-journal`) && !disposingSettled) await turn();
        expect(disposingSettled).toBe(false);
        const closing = connection.close();
        expect(await disposing).toMatchObject({ ok: false, status: 'cancelled' });
        await closing;
        const inspect = openSqliteDatabaseSync(path);
        try { expect(inspect.prepare('SELECT count(*) FROM keyless').values()).toEqual([[0n]]); }
        finally { inspect.close(); }
        expect(await connection.execute({ operation: 'schemas.list', target, page: { rows: 1 } })).toMatchObject({ ok: false, code: 'database_connection_unavailable' });
    });
});
