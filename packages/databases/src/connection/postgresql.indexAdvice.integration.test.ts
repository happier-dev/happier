import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { DatabaseOperationResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { openPostgresqlConnection } from './postgresql.js';

const binaries = process.env.HAPPIER_INDEX_ADVICE_POSTGRES_BIN;
const target = { kind: 'manual', accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' }, savedSecretId: 'fixture' } as const;
const workload = 'SELECT * FROM app."order; items" WHERE "lookup""id" = 417 ORDER BY sort_key';
const read = (sql: string) => ({ operation: 'statement.run', target, mode: 'read', statement: { sql, parameters: [] } } as const);
const advice = (statementKey: string) => ({ operation: 'stats.read', target,
    request: { kind: 'stats.read', group: 'indexAdvice', selection: { statementKey } } } as const);

it.skipIf(!binaries)('estimates from a selected stats row as happier_ro, resets hypotheses and leaves real indexes untouched', async () => {
    const socket = mkdtempSync(join(tmpdir(), 'dbw-index-advice-'));
    const data = join(socket, 'data');
    const log = join(socket, 'postgres.log');
    const run = (binary: string, args: string[]) =>
        execFileSync(join(binaries!, binary), args, { encoding: 'utf8' });
    const psql = (sql: string, user = 'fixture', db = 'postgres') =>
        run('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', user, '-d', db, '-c', sql]).trim();
    const open = (db: string) => openPostgresqlConnection(`postgresql://happier_ro@localhost/${db}?host=${encodeURIComponent(socket)}`);
    let pid: string | undefined;
    const opened: Array<Awaited<ReturnType<typeof open>>> = [];
    try {
        run('initdb', ['-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
        run('pg_ctl', ['-D', data, '-l', log, '-o',
            `-h '' -k ${socket} -c shared_preload_libraries=pg_stat_statements -c log_statement=all`, '-w', 'start']);
        pid = readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0];
        expect(psql('SHOW server_version_num')).toMatch(/^16\d{4}$/u);
        psql('CREATE ROLE happier_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
        psql(`CREATE SCHEMA metrics; CREATE EXTENSION pg_stat_statements SCHEMA metrics;
            CREATE SCHEMA "plan tools"; CREATE EXTENSION hypopg SCHEMA "plan tools";
            CREATE SCHEMA app; CREATE TABLE app."order; items" ("lookup""id" integer, sort_key integer, payload text);
            INSERT INTO app."order; items" SELECT i, i % 100, repeat('a', 160) FROM generate_series(1,100000) AS i;
            ANALYZE app."order; items";
            REVOKE EXECUTE ON FUNCTION "plan tools".hypopg_create_index(text), "plan tools".hypopg_reset() FROM PUBLIC;
            GRANT USAGE ON SCHEMA app, metrics, "plan tools" TO happier_ro;
            GRANT SELECT ON app."order; items" TO happier_ro;
            GRANT EXECUTE ON FUNCTION "plan tools".hypopg_create_index(text), "plan tools".hypopg_reset() TO happier_ro;`);
        psql('CREATE DATABASE missing_hypopg');
        psql('CREATE EXTENSION pg_stat_statements', 'fixture', 'missing_hypopg');

        // The same ordinary user runs the workload and the real native stats control.
        expect(psql(workload, 'happier_ro')).toMatch(/^417\|17\|a/u);
        psql('SELECT count(*) FROM app."order; items"', 'happier_ro');
        const reader = await open('postgres');
        opened.push(reader);
        expect(await reader.verifyReadRole()).toMatchObject({ ok: true });
        const result = await reader.execute({ operation: 'stats.read', target, request: {
            kind: 'stats.read', group: 'statements', selection: { order: 'totalTime', page: { rows: 30 } },
        } });
        if (!result.ok || result.operation !== 'stats.read' || result.observation.status !== 'available'
            || result.observation.group !== 'statements') throw new Error('Expected the real statements control');
        const selected = result.observation.data.find(row => row.shape?.includes('lookup'));
        const unsupported = result.observation.data.find(row => row.shape?.includes('count'));
        expect(selected?.key).toBeDefined();
        expect(unsupported?.key).toBeDefined();

        const nativeControl = psql(`BEGIN READ ONLY;
            EXPLAIN (GENERIC_PLAN) SELECT * FROM app."order; items" WHERE "lookup""id" = $1;
            SELECT "plan tools".hypopg_create_index('CREATE INDEX ON app."order; items" ("lookup""id")');
            EXPLAIN (GENERIC_PLAN) SELECT * FROM app."order; items" WHERE "lookup""id" = $1;
            SELECT "plan tools".hypopg_reset(); COMMIT;`, 'happier_ro');
        expect(nativeControl).toMatch(/Seq Scan[\s\S]*Index Scan using "</u);
        expect(psql('SELECT extversion FROM pg_extension WHERE extname = \'hypopg\'')).toMatch(/^1\.4\./u);

        const logOffset = readFileSync(log).length;
        const trial = await open('postgres');
        opened.push(trial);
        const suggestion = DatabaseOperationResultV1Schema.parse(await trial.execute(advice(selected!.key)));
        const trace = readFileSync(log).subarray(logOffset).toString();
        if (!suggestion.ok) throw new Error(JSON.stringify(suggestion) + '\n' + trace);
        expect(suggestion).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'available', group: 'indexAdvice', data: [{ relation: { schema: 'app', name: 'order; items' },
                column: 'lookup"id', baselineCost: expect.any(Number), candidateCost: expect.any(Number) }],
        } });
        if (!suggestion.ok || suggestion.operation !== 'stats.read' || suggestion.observation.status !== 'available'
            || suggestion.observation.group !== 'indexAdvice') throw new Error('Expected the real recommendation');
        const [index] = suggestion.observation.data;
        expect(index!.baselineCost / index!.candidateCost).toBeGreaterThanOrEqual(2);
        expect(trace.match(/(?:execute <unnamed>|statement):/gu)).toHaveLength(1 + 7 + 3 * 2);
        expect(trace.match(/SELECT pg_catalog\.set_config\('standard_conforming_strings'/gu)).toHaveLength(1);
        expect(trace.match(/statement: EXPLAIN \(GENERIC_PLAN, FORMAT JSON\)/gu)).toHaveLength(3);
        expect(trace).toContain("pg_catalog.format('CREATE INDEX ON %I.%I (%I)'");
        expect(trace).not.toContain('= 417');
        expect(await trial.execute(read('SELECT count(*) FROM "plan tools".hypopg()')))
            .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '0' }] }] }] });
        expect(psql('SELECT count(*) FROM pg_indexes WHERE schemaname = \'app\'')).toBe('0');
        expect(await reader.execute(advice('0:0:0:true'))).toMatchObject({
            ok: true, observation: { status: 'unavailable', reason: 'row_evicted' },
        });

        psql(workload);
        const hiddenKey = psql(`SELECT dbid::text || ':' || userid::text || ':' || queryid::text || ':' || toplevel::text
            FROM metrics.pg_stat_statements WHERE userid=(SELECT oid FROM pg_roles WHERE rolname=current_user)
                AND query='SELECT * FROM app."order; items" WHERE "lookup""id" = $1 ORDER BY sort_key'`);
        expect(hiddenKey).toMatch(/^\d+:\d+:-?\d+:true$/u);
        expect(await reader.execute(advice(hiddenKey))).toMatchObject({
            ok: true, observation: { status: 'unavailable', reason: 'visibility_restricted' },
        });
        psql('CREATE INDEX existing_lookup ON app."order; items" ("lookup""id")');
        expect(await reader.execute(advice(selected!.key))).toMatchObject({
            ok: true, observation: { status: 'available', data: [] },
        });
        psql('DROP INDEX app.existing_lookup');
        expect(await reader.execute(advice(unsupported!.key))).toMatchObject({
            ok: true, observation: { status: 'unavailable', reason: 'index_advice_statement_unsupported' },
        });

        const missing = await open('missing_hypopg');
        opened.push(missing);
        expect(await missing.execute(advice(selected!.key))).toMatchObject({ ok: true, observation: {
            status: 'unavailable', reason: 'hypopg_missing', remediation: expect.any(String),
        } });
        expect(await missing.execute(read('SELECT 1'))).toMatchObject({ ok: true });

        // Hold the relation lock until the advisory EXPLAIN is waiting, then abort the read.
        const cancelled = await open('postgres');
        opened.push(cancelled);
        const locker = new Client({ host: socket, database: 'postgres', user: 'fixture' });
        const abort = new AbortController();
        await locker.connect();
        try {
            await locker.query('BEGIN');
            await locker.query('LOCK TABLE app."order; items" IN ACCESS EXCLUSIVE MODE');
            const pending = cancelled.execute(advice(selected!.key), abort.signal);
            await expect.poll(() => psql(`SELECT count(*) FROM pg_stat_activity
                WHERE usename='happier_ro' AND query LIKE 'EXPLAIN (GENERIC_PLAN, FORMAT JSON)%'
                AND wait_event_type='Lock'`)).toBe('1');
            abort.abort();
            expect(await pending).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
            expect(await cancelled.execute(read('SELECT 1'))).toMatchObject({ ok: false, code: 'database_connection_unavailable' });
        } finally {
            abort.abort();
            await locker.end();
        }

        psql('REVOKE EXECUTE ON FUNCTION "plan tools".hypopg_reset() FROM happier_ro');
        expect(await reader.execute(advice(selected!.key))).toMatchObject({ ok: true, observation: {
            status: 'unavailable', reason: 'visibility_restricted',
        } });
        expect(await reader.execute(read('SELECT 1'))).toMatchObject({ ok: false, code: 'database_connection_unavailable' });
    } finally {
        for (const connection of opened) await connection.close();
        if (pid && pid === readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]) {
            run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
        }
        rmSync(socket, { recursive: true, force: true });
    }
}, 30_000);
