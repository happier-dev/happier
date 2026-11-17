import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { openPostgresqlConnection } from './postgresql.js';

const run = promisify(execFile);
const image = process.env.HAPPIER_TEST_NATIVE_POSTGRES_IMAGE;
const target = { kind: 'manual' as const, accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' }, savedSecretId: 'fixture' };
const proxy = 'exec 3<>/dev/tcp/127.0.0.1/5432 || exit; cat <&3 & reader=$!; cat <&0 >&3 & writer=$!; wait -n "$reader" "$writer"; kill "$reader" "$writer" 2>/dev/null; wait';

it.skipIf(!image)('preserves private PostgreSQL read-role framing and native cancellation over admitted streams', async () => {
    const name = `happier-native-pg-${randomUUID()}`;
    await run('docker', ['run', '--detach', '--rm', '--name', name, '--network', 'none',
        '--env', 'POSTGRES_PASSWORD=native-admin', '--env', 'POSTGRES_DB=native_fixture', image!]);
    const sql = (statement: string) => run('docker', ['exec', '--env', 'PGPASSWORD=native-admin', name,
        'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '--host=127.0.0.1', '--username=postgres', '--dbname=native_fixture', '-c', statement]);
    let opened = 0; let closed = 0;
    const openStream = async () => {
        const child = spawn('docker', ['exec', '-i', name, '/bin/bash', '-c', proxy], { stdio: ['pipe', 'pipe', 'ignore'] });
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
        const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
        opened++;
        let closing: Promise<void> | undefined;
        return { stream, close() { return closing ??= (async () => {
            stream.once('error', () => {}); stream.destroy(); child.kill(); await exit; closed++;
        })(); } };
    };
    try {
        await vi.waitFor(async () => { expect((await sql('SELECT 1')).stdout.trim()).toBe('1'); }, { timeout: 60_000 });
        await sql("CREATE ROLE happier_ro LOGIN PASSWORD 'native-fixture-password'; GRANT pg_read_all_data TO happier_ro; CREATE TABLE items(id bigint PRIMARY KEY,note text); INSERT INTO items VALUES(1,NULL)");
        // The host owns guard policy. The driver must execute its supplied SQL
        // and settle a refused login before exposing any operation connection.
        await expect(openPostgresqlConnection('postgresql://postgres:native-admin@unreachable.invalid/native_fixture', undefined,
            { openStream, sessionGuardSql: "DO $$BEGIN RAISE EXCEPTION 'fixture_guard' USING ERRCODE='42501'; END$$" }))
            .rejects.toMatchObject({ code: '42501' });
        expect(closed).toBe(1);
        const connection = await openPostgresqlConnection('postgresql://happier_ro:native-fixture-password@unreachable.invalid/native_fixture', undefined, { openStream });
        try {
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: "SELECT note AS duplicate, ''::text AS duplicate, 9223372036854775807::bigint AS exact FROM items WHERE id=$1",
                parameters: [{ type: 'integer', value: '1' }],
            } })).toMatchObject({ ok: true, results: [{ columns: [{ name: 'duplicate' }, { name: 'duplicate' }, { name: 'exact' }],
                rows: [{ cells: [{ type: 'null' }, { type: 'text', value: '' }, { type: 'integer', value: '9223372036854775807' }] }] }] });
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', statement: {
                sql: "UPDATE items SET note='forbidden'", parameters: [],
            } })).toMatchObject({ ok: false });
            const cancellation = new AbortController();
            const pending = connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT pg_sleep(60)', parameters: [],
            } }, cancellation.signal);
            await vi.waitFor(async () => {
                expect((await sql("SELECT COUNT(*) FROM pg_stat_activity WHERE usename='happier_ro' AND state='active' AND query LIKE '%pg_sleep(60)%'")).stdout.trim()).toBe('1');
            }, { timeout: 60_000 });
            cancellation.abort();
            expect(await pending).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
            expect((await sql("SELECT COUNT(*) FROM pg_stat_activity WHERE usename='happier_ro' AND state='active' AND query LIKE '%pg_sleep(60)%'")).stdout.trim()).toBe('0');
        } finally { await connection.close(); }
        expect(closed).toBe(opened);
        expect(opened).toBe(3);
    } finally { await run('docker', ['stop', name]); }
}, 120_000);
