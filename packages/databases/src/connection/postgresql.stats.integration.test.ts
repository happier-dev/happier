import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { openPostgresqlConnection } from './postgresql.js';

const run = promisify(execFile);
const binaries = process.env.HAPPIER_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const target = { kind: 'manual', accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' }, savedSecretId: 'fixture' } as const;

it('reports native statistics prerequisites and visibility restrictions while keeping ordinary reads usable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbw-pg-unloaded-'));
    let ownedPid: string | undefined;
    let connection: Awaited<ReturnType<typeof openPostgresqlConnection>> | undefined;
    try {
        await run(join(binaries, 'initdb'), ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
        await run(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'),
            '-o', `-c listen_addresses='' -c shared_preload_libraries='' -k ${directory}`, '-w', 'start']);
        ownedPid = (await readFile(join(directory, 'data/postmaster.pid'), 'utf8')).split('\n')[0];
        await run(join(binaries, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-U', 'fixture', '-d', 'postgres',
            '-c', 'CREATE EXTENSION pg_stat_statements']);
        connection = await openPostgresqlConnection(`postgresql://fixture@localhost/postgres?host=${encodeURIComponent(directory)}`);
        const read = { operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT 1 AS control', parameters: [] } } as const;
        expect(await connection.execute(read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
        expect(await connection.execute({ operation: 'stats.read', target, request: {
            kind: 'stats.read', group: 'statements', selection: { page: { rows: 10 }, order: 'calls' },
        } })).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'unavailable', group: 'statements', reason: 'preload_restart_required', scope: { database: 'postgres' },
        } });
        expect(await connection.execute(read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }] }] }] });
        // The same SQLSTATE from ordinary user SQL is an engine failure, never a statistics diagnosis.
        expect(await connection.execute({ ...read, statement: { sql: 'SELECT * FROM pg_stat_statements', parameters: [] } }))
            .toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: '55000' } });
        expect(await connection.execute(read)).toMatchObject({ ok: true });
        await run(join(binaries, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-U', 'fixture', '-d', 'postgres',
            '-c', 'CREATE ROLE stats_reader LOGIN; CREATE TABLE items(id integer PRIMARY KEY); GRANT SELECT ON items TO stats_reader; REVOKE SELECT ON pg_stat_statements FROM PUBLIC; REVOKE EXECUTE ON FUNCTION pg_catalog.pg_database_size(name), pg_catalog.pg_relation_size(regclass), pg_catalog.pg_stat_get_activity(integer) FROM PUBLIC']);
        const restricted = await openPostgresqlConnection(`postgresql://stats_reader@localhost/postgres?host=${encodeURIComponent(directory)}`);
        try {
            expect(await restricted.execute(read)).toMatchObject({ ok: true });
            for (const request of [
                { kind: 'stats.read', group: 'statements', selection: { page: { rows: 10 }, order: 'calls' } },
                { kind: 'stats.read', group: 'size', selection: {} },
                { kind: 'stats.read', group: 'tables', selection: { schema: 'public', page: { rows: 10 } } },
                { kind: 'stats.read', group: 'indexes', selection: { schema: 'public', page: { rows: 10 } } },
                { kind: 'stats.read', group: 'activity', selection: { page: { rows: 10 } } },
            ] as const) {
                expect(await restricted.execute({ operation: 'stats.read', target, request })).toMatchObject({
                    ok: true, operation: 'stats.read', observation: { status: 'unavailable', group: request.group, reason: 'visibility_restricted' },
                });
                expect(await restricted.execute(read)).toMatchObject({ ok: true });
            }
            expect(await restricted.execute({ ...read, statement: { sql: 'SELECT pg_database_size(current_database())', parameters: [] } }))
                .toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: '42501' } });
            expect(await restricted.execute({ ...read, statement: { sql: 'SELECT * FROM missing_relation', parameters: [] } }))
                .toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: '42P01' } });
            expect(await connection.execute({ operation: 'stats.read', target, request: {
                kind: 'stats.read', group: 'activity', selection: { activityKey: 'not-an-integer' },
            } })).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: '22P02' } });
        } finally { await restricted.close(); }
    } finally {
        await connection?.close();
        if (ownedPid && ownedPid === (await readFile(join(directory, 'data/postmaster.pid'), 'utf8')).split('\n')[0]) {
            await run(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
        }
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);
