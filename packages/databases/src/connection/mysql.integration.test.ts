import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { DatabaseOperationResultV1Schema } from '@happier-dev/database-protocol';
import { openMysqlConnection } from './mysql.js';

const run = promisify(execFile);
const image = process.env.HAPPIER_TEST_NATIVE_MYSQL_IMAGE;
const target = { kind: 'manual' as const, accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' }, savedSecretId: 'fixture' };
// This exact bridge uses Bash and cat shipped by the current mysql:8.4 template.
const proxy = 'exec 3<>/dev/tcp/127.0.0.1/3306; cat <&3 & reader=$!; cat <&0 >&3 & writer=$!; wait -n "$reader" "$writer"; kill "$reader" "$writer" 2>/dev/null; wait';

it.skipIf(!image)('uses container-local MySQL authority with lossless native frames and cancellation on its borrowed streams', async () => {
    const name = `happier-native-mysql-${randomUUID()}`;
    await run('docker', ['run', '--detach', '--rm', '--name', name, '--network', 'none',
        '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '--env', 'MYSQL_DATABASE=native_fixture', image!]);
    const sql = (statement: string) => run('docker', ['exec', name, 'mysql', '--protocol=TCP', '--host=127.0.0.1', '--user=root', '--batch', '--skip-column-names', '-e', statement]);
    let opened = 0; let closed = 0;
    const openStream = async () => {
        const child = spawn('docker', ['exec', '-i', name, '/bin/bash', '-c', proxy], { stdio: ['pipe', 'pipe', 'ignore'] });
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
        const exit = new Promise<void>((resolve, reject) => {
            child.once('error', reject); child.once('close', () => resolve());
        });
        opened++;
        let closing: Promise<void> | undefined;
        return { stream, close() {
            return closing ??= (async () => { stream.destroy(); child.kill(); await exit; closed++; })();
        } };
    };
    try {
        await vi.waitFor(async () => { expect((await sql('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=\'native_fixture\'')).stdout.trim()).toBe('1'); }, { timeout: 60_000 });
        await sql("CREATE USER 'happier_ro'@'127.0.0.1' IDENTIFIED BY 'native-fixture-password'; GRANT SELECT, SHOW VIEW ON native_fixture.* TO 'happier_ro'@'127.0.0.1'; CREATE TABLE native_fixture.items(id BIGINT PRIMARY KEY,note TEXT); INSERT INTO native_fixture.items VALUES(1,NULL)");
        // The host is deliberately unreachable. Every connection, including
        // cancellation, must consume the admitted container-local stream.
        const connection = await openMysqlConnection('mysql://happier_ro:native-fixture-password@unreachable.invalid/native_fixture', undefined, { openStream });
        try {
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: "SELECT note AS duplicate, '' AS duplicate, CAST(9223372036854775807 AS SIGNED) AS exact FROM items WHERE id=?",
                parameters: [{ type: 'integer', value: '1' }],
            } })).toMatchObject({ ok: true, results: [{ columns: [{ name: 'duplicate' }, { name: 'duplicate' }, { name: 'exact' }],
                rows: [{ cells: [{ type: 'null' }, { type: 'text', value: '' }, { type: 'integer', value: '9223372036854775807' }] }] }] });
            const size = await connection.execute({ operation: 'stats.read', target,
                request: { kind: 'stats.read', group: 'size', selection: {} } });
            expect(size).toMatchObject({ ok: true, operation: 'stats.read', observation: {
                status: 'available', engineId: 'mysql', scope: { database: 'native_fixture' },
                data: { bytes: expect.stringMatching(/^\d+$/u), measurement: 'table_bytes_estimate' },
            } });
            expect(DatabaseOperationResultV1Schema.safeParse(size).success).toBe(true);
            for (const request of [
                { kind: 'stats.read', group: 'statements', selection: { page: { rows: 10 }, order: 'calls' } },
                { kind: 'stats.read', group: 'tables', selection: { schema: 'native_fixture', page: { rows: 10 } } },
                { kind: 'stats.read', group: 'indexes', selection: { schema: 'native_fixture', page: { rows: 10 } } },
                { kind: 'stats.read', group: 'activity', selection: { page: { rows: 10 } } },
            ] as const) {
                expect(await connection.execute({ operation: 'stats.read', target, request })).toMatchObject({
                    ok: true, operation: 'stats.read', observation: { status: 'unavailable', group: request.group, reason: 'visibility_restricted' },
                });
                expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                    sql: 'SELECT 1', parameters: [],
                } })).toMatchObject({ ok: true });
            }
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT * FROM performance_schema.threads', parameters: [],
            } })).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: 'ER_TABLEACCESS_DENIED_ERROR' } });
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', statement: {
                sql: "UPDATE items SET note='forbidden'", parameters: [],
            } })).toMatchObject({ ok: false });
            const cancellation = new AbortController();
            const pending = connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT SLEEP(60)', parameters: [],
            } }, cancellation.signal);
            await vi.waitFor(async () => {
                expect((await sql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='happier_ro' AND INFO LIKE '%SLEEP(60)%'")).stdout.trim()).toBe('1');
            }, { timeout: 60_000 });
            cancellation.abort();
            expect(await pending).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
        } finally { await connection.close(); }
        expect(closed).toBe(opened);
        expect(opened).toBe(2);
    } finally { await run('docker', ['stop', name]); }
}, 120_000);
