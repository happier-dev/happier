import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseOperationInputV1Schema, DatabaseReadStatementInputV1Schema, type DatabaseRowsContinuationV1 } from '@happier-dev/plugin-sdk/database';
import { postgresqlReadOnlyRoleGuardSql } from '@happier-dev/deployment-protocol';
import { openPostgresqlConnection } from './postgresql.js';

const run = promisify(execFile);
const binaries = process.env.HAPPIER_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const target = { kind: 'manual', accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' }, savedSecretId: 'fixture' } as const;

describe('PostgreSQL demand connection against the real engine', () => {
    let directory: string;
    let started = false;
    let databaseUrl: string;
    let connection: Awaited<ReturnType<typeof openPostgresqlConnection>>;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'dbw-pg-'));
        await run(join(binaries, 'initdb'), ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
        await run(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-c listen_addresses='' -c log_statement=all -c shared_preload_libraries=pg_stat_statements -k ${directory}`, '-w', 'start']);
        started = true;
        databaseUrl = `postgresql://fixture@localhost/postgres?host=${encodeURIComponent(directory)}`;
        connection = await openPostgresqlConnection(databaseUrl);
        const setup = await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'CREATE TABLE items (id bigint PRIMARY KEY, note text, amount numeric, doc jsonb)', parameters: [] },
            { sql: "CREATE TYPE fixture_mood AS ENUM ('quiet','busy')", parameters: [] },
            { sql: "INSERT INTO items VALUES (1,NULL,1.000000000000000001,'null'),(2,'',2.1,'{}')", parameters: [] },
        ] });
        expect(setup.ok).toBe(true);
    });
    afterAll(async () => {
        if (connection) await connection.close();
        if (started) await run(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('proves a deployment login has only the dedicated read role before exposing its connection', async () => {
        const setup = await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'CREATE ROLE happier_ro LOGIN', parameters: [] },
            { sql: 'GRANT pg_read_all_data TO happier_ro', parameters: [] },
        ] });
        expect(setup.ok).toBe(true);
        await expect(openPostgresqlConnection(databaseUrl, undefined, { sessionGuardSql: postgresqlReadOnlyRoleGuardSql }))
            .rejects.toMatchObject({ code: '42501' });
        const readOnlyUrl = databaseUrl.replace('fixture@', 'happier_ro@');
        const reader = await openPostgresqlConnection(readOnlyUrl, undefined, { sessionGuardSql: postgresqlReadOnlyRoleGuardSql });
        try {
            expect(await reader.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT note FROM items WHERE id = $1', parameters: [{ type: 'integer', value: '1' }],
            } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
        } finally { await reader.close(); }
    });

    it('holds installed statistics facts for one demand and refreshes them with one setup call on reopen', async () => {
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
            sql: "SELECT count(*)::text FROM pg_catalog.pg_extension WHERE extname='pg_stat_statements'", parameters: [],
        } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: '0' }] }] }] });
        const logPath = join(directory, 'postgres.log');
        const statementCount = (log: string) => (log.match(/LOG:  (?:execute [^\n]*?:|statement:)/gu) ?? []).length;
        const beforeOpen = (await readFile(logPath, 'utf8')).length;
        const demand = await openPostgresqlConnection(databaseUrl);
        const opened = (await readFile(logPath, 'utf8')).slice(beforeOpen);
        const input = { operation: 'stats.read', target, request: { kind: 'stats.read', group: 'statements',
            selection: { page: { rows: 10 }, order: 'calls' } } } as const;
        try {
            expect(await demand.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT 1 AS control', parameters: [],
            } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
            for (let read = 0; read < 2; read++) {
                const beforeRead = (await readFile(logPath, 'utf8')).length;
                expect(await demand.execute(input)).toMatchObject({ ok: true, operation: 'stats.read', observation: {
                    status: 'unavailable', reason: 'extension_missing', group: 'statements', scope: { database: 'postgres' },
                } });
                expect(statementCount((await readFile(logPath, 'utf8')).slice(beforeRead))).toBe(2); // BEGIN and COMMIT; no discovery query.
            }
            expect(statementCount(opened)).toBe(1);
            expect(opened).toContain('pg_extension');
            expect((await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
                { sql: 'CREATE SCHEMA "fixture stats"', parameters: [] },
                { sql: 'CREATE EXTENSION pg_stat_statements SCHEMA "fixture stats"', parameters: [] },
            ] })).ok).toBe(true);
            expect(await demand.execute(input)).toMatchObject({ ok: true, observation: { status: 'unavailable', reason: 'extension_missing' } });
        } finally { await demand.close(); }
        const beforeReopen = (await readFile(logPath, 'utf8')).length;
        const refreshed = await openPostgresqlConnection(databaseUrl);
        try {
            expect(statementCount((await readFile(logPath, 'utf8')).slice(beforeReopen))).toBe(1);
            const beforeRead = (await readFile(logPath, 'utf8')).length;
            expect(await refreshed.execute(input)).toMatchObject({ ok: true, operation: 'stats.read', observation: {
                status: 'available', group: 'statements', scope: { database: 'postgres' },
                intervalBasis: { extensionVersion: expect.stringMatching(/^1\.\d+$/u) },
            } });
            expect(statementCount((await readFile(logPath, 'utf8')).slice(beforeRead))).toBe(3); // BEGIN, the demanded stats statement and COMMIT.
        } finally { await refreshed.close(); }
    });

    it('reads lossless ordered typed rows and zero-row metadata over the same demand connection', async () => {
        const statement = { sql: "SELECT 9223372036854775807::bigint AS duplicate, ''::text AS duplicate, NULL::text AS absent, 'null'::jsonb AS doc, 1.000000000000000001::numeric AS exact", parameters: [] };
        const result = await connection.execute({ operation: 'statement.run', target, mode: 'read', statement });
        expect(result).toMatchObject({ ok: true, operation: 'statement.run', results: [{
            columns: [{ name: 'duplicate', nativeType: 'int8' }, { name: 'duplicate', nativeType: 'text' }, { name: 'absent' }, { name: 'doc' }, { name: 'exact' }],
            rows: [{ cells: [{ type: 'integer', value: '9223372036854775807' }, { type: 'text', value: '' }, { type: 'null' }, { type: 'json', value: 'null' }, { type: 'decimal', value: '1.000000000000000001' }] }],
        }] });
        const empty = await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT id, note FROM items WHERE false', parameters: [] } });
        expect(empty).toMatchObject({ ok: true, results: [{ columns: [{ name: 'id', nativeType: 'int8' }, { name: 'note', nativeType: 'text' }], rows: [] }] });
        const before = (await readFile(join(directory, 'postgres.log'), 'utf8')).length;
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "SELECT 'quiet'::fixture_mood AS mood", parameters: [] } })).toMatchObject({ ok: true, results: [{ columns: [{ nativeType: expect.stringMatching(/^oid:\d+$/u) }], rows: [{ cells: [{ type: 'text', value: 'quiet' }] }] }] });
        const log = (await readFile(join(directory, 'postgres.log'), 'utf8')).slice(before);
        expect(log.match(/execute <unnamed>: SELECT /gu)).toHaveLength(1);
    });

    it('advances the returned read-SQL continuation beyond an oversized duplicate-label cell prefix', async () => {
        const input = DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', target, mode: 'read', demand: { rows: 1 },
            statement: { sql: "SELECT repeat('x',25_000_000) AS duplicate, 'tail' AS duplicate", parameters: [] } });
        const original = await connection.execute(input);
        if (!original.ok || original.operation !== 'statement.run') throw new Error('Expected a read-SQL result');
        const first = original.results[0];
        const firstCell = first?.rows[0]?.cells[0];
        if (!first || firstCell?.type !== 'partial' || first.completeness.complete) throw new Error('Expected an oversized partial read-SQL cell');
        const continuation = first.completeness.continuation;
        if (continuation?.kind !== 'rerun') throw new Error('Expected a read-SQL rerun continuation');
        expect(continuation.input).toBe('original');
        const resumed = await connection.execute({ ...input, demand: continuation.demand });
        if (!resumed.ok || resumed.operation !== 'statement.run') throw new Error('Expected the resumed read-SQL result');
        expect(resumed.results[0]?.columns.map(column => column.name)).toEqual(['duplicate']);
        expect(resumed.results[0]?.rows[0]?.cells).toHaveLength(1);
        const resumedCell = resumed.results[0]?.rows[0]?.cells[0];
        if (resumedCell?.type !== 'partial') throw new Error('Expected the resumed native value range');
        console.info('PostgreSQL read-SQL recovery ranges', { originalOffset: firstCell.range.offset,
            originalLength: firstCell.range.length, resumedOffset: resumedCell.range.offset, resumedLength: resumedCell.range.length });
        expect(resumedCell.range.offset).toBe(firstCell.range.offset + firstCell.range.length);
    }, 30_000); // Match the existing canonical Action-envelope boundary test allowance.

    it('rolls back an ordered write list on later failure and keeps read mode read-only', async () => {
        const failed = await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: "UPDATE items SET note='changed' WHERE id=1", parameters: [] },
            { sql: 'INSERT INTO items(id) VALUES (1)', parameters: [] },
        ] });
        expect(failed).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: '23505', statementIndex: 1 } });
        const read = await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT note FROM items WHERE id=1', parameters: [] } });
        expect(read).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'null' }] }] }] });
        const refused = await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "UPDATE items SET note='escape'", parameters: [] } });
        expect(refused).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: '25006' } });
        const escaped = await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "COMMIT; UPDATE items SET note='escape'", parameters: [] } });
        expect(escaped.ok).toBe(false);
        const analyze = await connection.execute({ operation: 'statement.explain', target, mode: 'analyze', accessMode: 'read', statement: { sql: 'SELECT * FROM items', parameters: [] } });
        expect(analyze.ok).toBe(true);
    });

    it('loads selected relation structure, typed filters and keyset pages without losing NULL or empty values', async () => {
        expect(await connection.execute({ operation: 'schemas.list', target, page: { rows: 10 } })).toMatchObject({ ok: true, schemas: expect.arrayContaining([{ name: 'public' }]) });
        expect(await connection.execute({ operation: 'relations.list', target, schema: 'public', page: { rows: 10 } })).toMatchObject({ ok: true, relations: [{ relation: { schema: 'public', name: 'items' }, kind: 'table' }] });
        const relation = { schema: 'public', name: 'items' };
        expect(await connection.execute({ operation: 'relation.structure', target, relation })).toMatchObject({ ok: true, structure: { primaryKey: ['id'], columns: [{ name: 'id', nativeType: 'bigint' }, { name: 'note', nullable: true }, { name: 'amount' }, { name: 'doc' }] } });
        const first = await connection.execute({ operation: 'rows.read', target, relation, columns: ['id', 'note'], order: [], page: { rows: 1 } });
        expect(first).toMatchObject({ ok: true, result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'null' }], identity: { key: [{ column: 'id', value: { type: 'integer', value: '1' } }] } }], completeness: { complete: false, reason: 'page', continuation: { kind: 'keyset' } } } });
        if (!first.ok || first.operation !== 'rows.read' || first.result.completeness.complete) throw new Error('Expected a keyset page');
        const continuation = first.result.completeness.continuation;
        if (continuation?.kind !== 'keyset') throw new Error('Expected a keyset continuation');
        const second = await connection.execute({ operation: 'rows.read', target, relation, columns: ['id', 'note'], order: [], page: { rows: 1, continuation } });
        expect(second).toMatchObject({ ok: true, result: { rows: [{ cells: [{ type: 'integer', value: '2' }, { type: 'text', value: '' }] }], completeness: { complete: true } } });
        expect(await connection.execute({ operation: 'rows.read', target, relation, columns: ['id'], order: [], filter: { kind: 'comparison', column: 'note', operator: 'eq', value: { type: 'text', value: '' } }, page: { rows: 10 } })).toMatchObject({ ok: true, result: { rows: [{ cells: [{ type: 'integer', value: '2' }] }] } });
        const filtered = DatabaseOperationInputV1Schema.parse({ operation: 'rows.read', target, relation, columns: ['id'], order: [], filter: { kind: 'comparison', column: 'id', operator: 'gte', value: { type: 'integer', value: '1' } }, page: { rows: 1 } });
        const filteredFirst = await connection.execute(filtered);
        if (!filteredFirst.ok || filteredFirst.operation !== 'rows.read' || filteredFirst.result.completeness.complete) throw new Error('Expected a filtered continuation');
        const filteredNext = DatabaseOperationInputV1Schema.parse({ ...filtered, page: { rows: 1, continuation: filteredFirst.result.completeness.continuation } });
        expect(await connection.execute(filteredNext)).toMatchObject({ ok: true, result: { rows: [{ cells: [{ type: 'integer', value: '2' }] }], completeness: { complete: true } } });
    });

    it('applies optimistic changes atomically and detects a stale original value', async () => {
        const relation = { schema: 'public', name: 'items' };
        const key = [{ column: 'id', value: { type: 'integer', value: '1' } }] as const;
        const conflict = await connection.execute({ operation: 'edits.apply', target, relation, changes: [
            { kind: 'insert', values: [{ column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '3' } } }] },
            { kind: 'update', key: [...key], values: [{ column: 'note', value: { kind: 'value', cell: { type: 'text', value: 'changed' } } }], original: [{ column: 'note', value: { type: 'text', value: 'stale' } }] },
        ] });
        expect(conflict).toMatchObject({ ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: 1 });
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT id FROM items WHERE id=3', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [] }] });
        expect(await connection.execute({ operation: 'edits.apply', target, relation, changes: [{ kind: 'update', key: [...key], values: [{ column: 'note', value: { kind: 'value', cell: { type: 'text', value: 'changed' } } }], original: [{ column: 'note', value: { type: 'null' } }] }] })).toMatchObject({ ok: true, status: 'committed', updated: '1' });
    });

    it('range-reads long UTF-8 cells by stable primary key and completes the retained value', async () => {
        await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: 'UPDATE items SET note=$1 WHERE id=1', parameters: [{ type: 'text', value: 'a🌍b' }] }] });
        const operand = { operation: 'cell.read', target, relation: { schema: 'public', name: 'items' }, key: [{ column: 'id', value: { type: 'integer', value: '1' } }], column: 'note' } as const;
        const first = await connection.execute({ ...operand, key: [...operand.key], range: { offset: 0, length: 5, unit: 'utf8_bytes' } });
        expect(first).toMatchObject({ ok: true, value: { type: 'partial', valueType: 'text', value: 'a🌍', encoding: 'utf8', range: { offset: 0, length: 5, unit: 'utf8_bytes', total: 6 } }, completeness: { complete: false, continuation: { kind: 'cell', range: { offset: 5 } } } });
        const last = await connection.execute({ ...operand, key: [...operand.key], range: { offset: 5, length: 5, unit: 'utf8_bytes' } });
        expect(last).toMatchObject({ ok: true, value: { type: 'partial', valueType: 'text', value: 'b' }, completeness: { complete: false } });
        expect(await connection.execute({ ...operand, key: [...operand.key], range: { offset: 0, length: 6, unit: 'utf8_bytes' } })).toMatchObject({ ok: true, value: { type: 'text', value: 'a🌍b' }, completeness: { complete: true } });
        expect(await connection.execute({ ...operand, key: [...operand.key], range: { offset: 0, length: Number.MAX_SAFE_INTEGER, unit: 'utf8_bytes' } })).toMatchObject({ ok: true, value: { type: 'text', value: 'a🌍b' }, completeness: { complete: true } });
    });

    it('reports a dropped staged relation as a reload conflict', async () => {
        expect((await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'CREATE TABLE dropped_fixture(id int PRIMARY KEY, note text)', parameters: [] },
            { sql: 'DROP TABLE dropped_fixture', parameters: [] },
        ] })).ok).toBe(true);
        expect(await connection.execute({ operation: 'edits.apply', target, relation: { schema: 'public', name: 'dropped_fixture' }, changes: [{ kind: 'update',
            key: [{ column: 'id', value: { type: 'integer', value: '1' } }], original: [{ column: 'note', value: { type: 'null' } }],
            values: [{ column: 'note', value: { kind: 'value', cell: { type: 'text', value: 'new' } } }],
        }] })).toMatchObject({ ok: false, status: 'conflict', code: 'database_edit_conflict', reason: 'relation_changed', changeIndex: 0 });
    });

    it('compares JSON and native values without equality operators through their exact original text', async () => {
        expect((await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'CREATE TABLE compare_fixture(id int PRIMARY KEY, doc json, markup xml)', parameters: [] },
            { sql: `INSERT INTO compare_fixture VALUES(1,'{"large":9223372036854775807}','<old/>')`, parameters: [] },
        ] })).ok).toBe(true);
        expect(await connection.execute({ operation: 'edits.apply', target, relation: { schema: 'public', name: 'compare_fixture' }, changes: [{ kind: 'update',
            key: [{ column: 'id', value: { type: 'integer', value: '1' } }],
            original: [{ column: 'doc', value: { type: 'json', value: '{"large":9223372036854775807}' } }, { column: 'markup', value: { type: 'text', value: '<old/>' } }],
            values: [{ column: 'doc', value: { kind: 'value', cell: { type: 'json', value: 'null' } } }, { column: 'markup', value: { kind: 'value', cell: { type: 'text', value: '<new/>' } } }],
        }] })).toMatchObject({ ok: true, status: 'committed', updated: '1' });
    });

    it('pages NULL sort values and composite keys with mixed directions without repeating rows', async () => {
        expect((await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'CREATE TABLE sort_fixture(a int,b int,n int,PRIMARY KEY(a,b))', parameters: [] },
            { sql: 'INSERT INTO sort_fixture VALUES(1,1,NULL),(1,2,NULL),(2,1,0),(2,2,0),(3,1,1)', parameters: [] },
        ] })).ok).toBe(true);
        const input = { operation: 'rows.read', target, relation: { schema: 'public', name: 'sort_fixture' }, columns: ['a', 'b'], order: [{ column: 'n', direction: 'asc', nulls: 'first' }, { column: 'b', direction: 'desc' }], page: { rows: 2 } } as const;
        const ids: string[] = [];
        let continuation: DatabaseRowsContinuationV1 | undefined;
        do {
            const result = await connection.execute({ ...input, columns: [...input.columns], order: [...input.order], page: { rows: 2, ...(continuation ? { continuation } : {}) } });
            if (!result.ok || result.operation !== 'rows.read') throw new Error('Expected a typed page');
            expect(result.result.rows[0]?.identity?.original).toEqual(expect.arrayContaining([{ column: 'n', value: expect.objectContaining({ type: expect.any(String) }) }]));
            ids.push(...result.result.rows.map(row => row.cells.slice(0, 2).map(cell => cell.type === 'integer' ? cell.value : '?').join(':')));
            const next = result.result.completeness.complete ? undefined : result.result.completeness.continuation;
            if (next && next.kind !== 'keyset') throw new Error('Expected a composite keyset');
            continuation = next;
        } while (continuation);
        expect(ids).toEqual(['1:2', '1:1', '2:2', '2:1', '3:1']);
    });

    it('establishes the shared lexer string mode even when connection options start with legacy strings', async () => {
        const address = new URL(databaseUrl);
        address.searchParams.set('options', '-c standard_conforming_strings=off');
        const demand = await openPostgresqlConnection(address.toString());
        try {
            expect(await demand.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SHOW standard_conforming_strings', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'on' }] }] }] });
        } finally { await demand.close(); }
    });

    it('reports an unknown write outcome when cancellation reaches the real COMMIT boundary', async () => {
        expect((await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
            { sql: 'CREATE TABLE commit_fixture(id int PRIMARY KEY)', parameters: [] },
            { sql: 'CREATE FUNCTION commit_fixture_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(60); RETURN NEW; END $$', parameters: [] },
            { sql: 'CREATE CONSTRAINT TRIGGER commit_fixture_wait AFTER INSERT ON commit_fixture DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commit_fixture_wait()', parameters: [] },
        ] })).ok).toBe(true);
        const address = new URL(databaseUrl);
        address.searchParams.set('application_name', 'dbw-commit-cancel');
        const demand = await openPostgresqlConnection(address.toString());
        const controller = new AbortController();
        const active = demand.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: 'INSERT INTO commit_fixture VALUES(1)', parameters: [] }] }, controller.signal);
        try {
            for (;;) {
                const observed = await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "SELECT count(*)::int FROM pg_stat_activity WHERE application_name='dbw-commit-cancel' AND query='COMMIT' AND state='active'", parameters: [] } });
                if (!observed.ok || observed.operation !== 'statement.run') throw new Error('Could not observe the fixture COMMIT');
                const cell = observed.results[0]?.rows[0]?.cells[0];
                if (cell?.type === 'integer' && cell.value === '1') break;
            }
            controller.abort();
            expect(await active).toMatchObject({ ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause: { code: '57014' } });
        } finally { controller.abort(); await demand.close(); }
    });

    it.each(['signal', 'close'] as const)('cancels the real active backend query on %s and disposes the demand', async method => {
        const observer = await openPostgresqlConnection(databaseUrl);
        const demand = await openPostgresqlConnection(databaseUrl);
        const controller = new AbortController();
        const statement = { sql: "SELECT pg_sleep(60) /* dbw-cancel-target */", parameters: [] };
        const active = demand.execute({ operation: 'statement.run', target, mode: 'read', statement }, controller.signal);
        const observe = async () => {
            const result = await observer.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: "SELECT count(*)::int FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE '%dbw-cancel-target%' AND state='active'", parameters: [],
            } });
            if (!result.ok || result.operation !== 'statement.run') throw new Error('Could not observe fixture query');
            const cell = result.results[0]!.rows[0]!.cells[0]!;
            if (cell.type !== 'integer') throw new Error('Could not read the backend count');
            return cell.value;
        };
        try {
            while (await observe() === '0') { /* Await the real backend boundary, not elapsed time. */ }
            if (method === 'signal') controller.abort(); else await demand.close();
            expect(await active).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
            expect(await observe()).toBe('0');
            expect(await demand.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT 1', parameters: [] } })).toMatchObject({ ok: false, code: 'database_connection_unavailable' });
        } finally { controller.abort(); await demand.close(); await observer.close(); }
    });
});
