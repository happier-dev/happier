import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseContinuationV1Schema, type DatabaseStatsReadV1 } from '@happier-dev/database-protocol';
import { compilePostgresqlStatsV1 } from './stats.js';
import { executePostgresqlOperation, type PostgresqlQuery } from './operations.js';
import { compilePostgresqlSetupV1, decodePostgresqlSetupV1 } from './setup.js';
import type { DatabaseStatsNativeRowV1, DatabaseStatsSqlPlanV1 } from '../stats.js';

const binaries = process.env.HAPPIER_DATABASE_STATS_POSTGRES_BIN ?? '';
/** Opt in with installed server binaries; uses only its temporary cluster. */
describe.skipIf(!binaries)('PostgreSQL stats against a real engine', () => {
    let directory = '';
    let data = '';
    let socket = '';
    let started = false;
    let ownedPid: number | undefined;
    function psql(sql: string, database = 'postgres'): string {
        return execFileSync(join(binaries, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', database, '-c', sql], { encoding: 'utf8' });
    }
    function execute(plan: DatabaseStatsSqlPlanV1, database = 'postgres') {
        expect(plan.status).toBe('compiled');
        if (plan.status !== 'compiled') throw new Error(plan.reason);
        expect(plan.statements).toHaveLength(1);
        const statement = plan.statements[0]!;
        const parameters = statement.parameters.map(value => typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`).join(',');
        const output = psql(`PREPARE stats_query AS SELECT row_to_json(r) FROM (${statement.sql}) r; EXECUTE stats_query${parameters ? `(${parameters})` : ''}`, database);
        const rows = output.trim() ? output.trim().split('\n').map(line => JSON.parse(line) as DatabaseStatsNativeRowV1) : [];
        return plan.decode([rows], { observedAtMs: 1000, database,
            intervalBasis: { bindingKey: 'test-cluster', databaseIdentity: database, selectionKey: 'selected' } });
    }
    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), 'dbw-stats-pg-'));
        data = join(directory, 'data');
        socket = join(directory, 'socket');
        mkdirSync(socket);
        execFileSync(join(binaries, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale'], { stdio: 'pipe' });
        execFileSync(join(binaries, 'pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-F -h '' -k ${socket} -c shared_preload_libraries=pg_stat_statements`, '-w', 'start'], { stdio: 'pipe' });
        started = true;
        ownedPid = Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);
        psql(`CREATE SCHEMA selected; CREATE SCHEMA neighbor; CREATE TABLE selected.items(id bigint PRIMARY KEY, value text);
            CREATE TABLE neighbor.private(id bigint); INSERT INTO selected.items SELECT n,'value' FROM generate_series(1,25) n;
            CREATE SCHEMA "custom stats"; CREATE EXTENSION pg_stat_statements WITH SCHEMA "custom stats";
            SELECT count(*) FROM selected.items;`);
    });
    afterAll(() => {
        if (started && ownedPid === Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0])) {
            execFileSync(join(binaries, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
        }
        rmSync(directory, { recursive: true, force: true });
    });
    it('executes selected stats groups through the shared native operation owner using held installed facts', async () => {
        const query: PostgresqlQuery = async statement => {
            const parameters = statement.values.map(value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`).join(',');
            const output = psql(`PREPARE stats_operation AS SELECT row_to_json(r) FROM (${statement.text}) r; EXECUTE stats_operation${parameters ? `(${parameters})` : ''}`);
            const objects = output.trim() ? output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : [];
            // This real psql JSON-row transport supplies text values; stats needs aliases, not type OIDs.
            const fields = Object.keys(objects[0] ?? {}).map(name => ({ name, dataTypeID: 25 }));
            return { fields, rows: objects.map(row => fields.map(field => {
                const value = row[field.name];
                return value === null || value === undefined ? null : value === true ? 't' : value === false ? 'f' : typeof value === 'object' ? JSON.stringify(value) : String(value);
            })), command: 'SELECT', rowCount: objects.length };
        };
        const target = { kind: 'manual', accountId: 'a', installationId: 'i', projectKey: 'p', savedSecretId: 's',
            workspace: { serverId: 'h', machineId: 'm', workspaceId: 'w', rootPath: directory } } as const;
        const facts = decodePostgresqlSetupV1(await query(compilePostgresqlSetupV1()));
        expect(facts).toMatchObject({ database: 'postgres', currentUser: 'postgres', serverAddress: null,
            pgStatStatements: { schema: 'custom stats', version: expect.stringMatching(/^1\.\d+$/u) } });
        expect(facts.databaseOid).toMatch(/^\d+$/u);
        expect(facts.engineStartedAt).not.toBe('');
        const options = { stats: { database: facts.database, intervalBasis: { bindingKey: 'fixture', databaseIdentity: facts.databaseOid, selectionKey: 'selected' },
            pgStatStatements: facts.pgStatStatements } };
        const requests = [
            { kind: 'stats.read', group: 'size', selection: {} },
            { kind: 'stats.read', group: 'tables', selection: { schema: 'selected', page: { rows: 10 } } },
            { kind: 'stats.read', group: 'indexes', selection: { relation: { schema: 'selected', name: 'items' } } },
            { kind: 'stats.read', group: 'activity', selection: { page: { rows: 10 } } },
            { kind: 'stats.read', group: 'statements', selection: { page: { rows: 100 }, order: 'calls' } },
        ] as const satisfies readonly DatabaseStatsReadV1[];
        for (const request of requests) {
            const result = await executePostgresqlOperation({ operation: 'stats.read', target, request }, query, options);
            expect(result).toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'available', group: request.group, engineId: 'postgresql' } });
            if (result.ok && result.operation === 'stats.read') expect(result.observation.observedAtMs).toBeGreaterThan(0);
        }
    });
    it('resumes the original typed stats request using only the returned offset and finishes at the page boundary', () => {
        psql('CREATE SCHEMA paged; CREATE TABLE paged.alpha(id integer); CREATE TABLE paged.beta(id integer); CREATE TABLE paged.gamma(id integer);');
        const request = { kind: 'stats.read', group: 'tables', selection: { schema: 'paged', page: { rows: 1 } } } as const satisfies DatabaseStatsReadV1;
        const first = execute(compilePostgresqlStatsV1(request));
        expect(first).toMatchObject({ status: 'available', group: 'tables', data: [{ relation: { schema: 'paged', name: 'alpha' } }] });
        const minimal = DatabaseContinuationV1Schema.parse({ kind: 'stats', offset: 1 });
        expect(first.status === 'available' && first.completeness).toEqual({ complete: false, reason: 'page', continuation: minimal });
        if (minimal.kind !== 'stats') throw new Error('Expected stats continuation');
        const second = execute(compilePostgresqlStatsV1({ ...request, selection: { ...request.selection, page: { ...request.selection.page, offset: minimal.offset } } }));
        if (second.status !== 'available' || second.group !== 'tables' || second.completeness.complete) throw new Error('Expected a second stats page');
        expect(second.data.map(row => row.relation)).toEqual([{ schema: 'paged', name: 'beta' }]);
        const continuation = second.completeness.continuation;
        if (continuation?.kind !== 'stats') throw new Error('Expected another stats continuation');
        const last = execute(compilePostgresqlStatsV1({ ...request, selection: { ...request.selection, page: { ...request.selection.page, offset: continuation.offset } } }));
        if (last.status !== 'available' || last.group !== 'tables') throw new Error('Expected the terminal stats page');
        expect(last.data.map(row => row.relation)).toEqual([{ schema: 'paged', name: 'gamma' }]);
        expect(last.completeness).toEqual({ complete: true });
    });
    it('returns only demanded schema tables and their ordered indexes with relation size', () => {
        const tables = execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'tables', selection: { schema: 'selected', page: { rows: 10 } } }));
        expect(tables).toMatchObject({ status: 'available', group: 'tables', data: [{ relation: { schema: 'selected', name: 'items' } }] });
        if (tables.status === 'available' && tables.group === 'tables') {
            expect(tables.data).toHaveLength(1);
            expect(tables.data[0]).not.toHaveProperty('estimatedRows');
        }
        const indexes = execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'indexes', selection: { relation: { schema: 'selected', name: 'items' } } }));
        expect(indexes).toMatchObject({ status: 'available', group: 'indexes', data: [{ name: 'items_pkey', columns: ['id'], primary: true, constraint: true }] });
        const size = execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'size', selection: { relation: { schema: 'selected', name: 'items' } } }));
        expect(size).toMatchObject({ status: 'available', group: 'size' });
        if (size.status === 'available' && size.group === 'size') expect(BigInt(size.data.bytes)).toBeGreaterThan(0n);
    });
    it('reads custom-schema statement evidence and sanitizes query text, with activity on the same database', () => {
        const statements = execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'statements', selection: { page: { rows: 100 }, order: 'calls' } },
            { pgStatStatements: { schema: 'custom stats', version: '1.10' } }));
        expect(statements).toMatchObject({ status: 'available', group: 'statements', intervalBasis: { extensionVersion: '1.10' } });
        if (statements.status === 'available' && statements.group === 'statements') {
            expect(statements.data.length).toBeGreaterThan(0);
            expect(statements.data.every(row => row.database === 'postgres')).toBe(true);
            expect(statements.data.every(row => row.calls !== undefined && (row.shape || row.omittedTextReason))).toBe(true);
        }
        expect(execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'activity', selection: { page: { rows: 10 } } })))
            .toMatchObject({ status: 'available', group: 'activity' });
    });
    it('does not trust the global reset marker when selective statement reset leaves it unchanged', () => {
        psql('SELECT 987654321::bigint AS selective_reset_probe');
        const queryId = psql(`SELECT queryid FROM "custom stats".pg_stat_statements
            WHERE query LIKE '%selective_reset_probe%' AND queryid IS NOT NULL LIMIT 1`).trim();
        expect(queryId).toMatch(/^-?\d+$/u);
        const before = psql('SELECT stats_reset::text FROM "custom stats".pg_stat_statements_info').trim();
        psql(`SELECT "custom stats".pg_stat_statements_reset(0,0,${queryId})`);
        const after = psql('SELECT stats_reset::text FROM "custom stats".pg_stat_statements_info').trim();
        expect(after).toBe(before);
        const observation = execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'statements', selection: { page: { rows: 100 }, order: 'calls' } },
            { pgStatStatements: { schema: 'custom stats', version: '1.10' } }));
        expect(observation).toMatchObject({ status: 'available', coverage: { status: 'partial', reasons: ['reset_marker_unavailable'] } });
    });
    it('marks legacy statement counters incomparable when extension reset and eviction markers are unavailable', () => {
        psql('CREATE DATABASE legacy_stats');
        psql("CREATE EXTENSION pg_stat_statements VERSION '1.8'; SELECT 42", 'legacy_stats');
        const observation = execute(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'statements', selection: { page: { rows: 100 }, order: 'calls' } },
            { pgStatStatements: { schema: 'public', version: '1.8' } }), 'legacy_stats');
        expect(observation).toMatchObject({ status: 'available', coverage: { status: 'partial', reasons: ['reset_marker_unavailable', 'eviction_possible'] } });
        if (observation.status === 'available' && observation.group === 'statements') expect(observation.data.length).toBeGreaterThan(0);
    });
});
