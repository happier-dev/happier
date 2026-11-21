import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { DatabaseOperationResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { withDatabaseConnectionLogin, withDatabaseConnectionUrlOptions } from '../connection.js';
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
            await sql("GRANT SELECT (THREAD_ID) ON performance_schema.threads TO 'happier_ro'@'127.0.0.1'; GRANT SELECT ON performance_schema.events_statements_current TO 'happier_ro'@'127.0.0.1'; GRANT SELECT ON performance_schema.data_lock_waits TO 'happier_ro'@'127.0.0.1'");
            expect(await connection.execute({ operation: 'stats.read', target,
                request: { kind: 'stats.read', group: 'activity', selection: { page: { rows: 10 } } },
            })).toMatchObject({ ok: true, operation: 'stats.read', observation: {
                status: 'unavailable', group: 'activity', reason: 'visibility_restricted',
            } });
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                sql: 'SELECT PROCESSLIST_STATE FROM performance_schema.threads', parameters: [],
            } })).toMatchObject({ ok: false, code: 'database_engine_error', cause: { code: 'ER_COLUMNACCESS_DENIED_ERROR' } });
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

it.skipIf(!image)('creates and verifies a native TLS MySQL reader with exact schema grants', async () => {
    const name = `happier-native-mysql-read-role-${randomUUID()}`;
    await run('docker', ['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::3306',
        '--env', 'MYSQL_ROOT_PASSWORD=native-admin', '--env', 'MYSQL_ROOT_HOST=%', '--env', 'MYSQL_DATABASE=native_fixture', image!]);
    const sql = (statement: string) => run('docker', ['exec', '--env', 'MYSQL_PWD=native-admin', name,
        'mysql', '--protocol=TCP', '--host=127.0.0.1', '--user=root', '--batch', '--skip-column-names', '-e', statement]);
    try {
        await vi.waitFor(async () => { expect((await sql('SELECT 1')).stdout.trim()).toBe('1'); }, { timeout: 60_000 });
        await sql('CREATE TABLE native_fixture.items(id BIGINT PRIMARY KEY,note TEXT); CREATE DATABASE nativeXfixture; CREATE TABLE nativeXfixture.items(id BIGINT PRIMARY KEY)');
        const address = (await run('docker', ['port', name, '3306/tcp'])).stdout.trim();
        const base = `mysql://${address}/native_fixture`;
        const writer = await openMysqlConnection(withDatabaseConnectionLogin(base, 'root', 'native-admin'));
        try {
            const role = 'happier_ro_0123456789abcdef';
            expect(await writer.verifyReadRole()).toMatchObject({ ok: false, code: 'database_read_role_not_read_only' });
            const plan = await writer.prepareReadRole(role);
            expect(plan.statements[1]).toContain('`native\\_fixture`.*');
            const result = await writer.setupReadRole(plan);
            expect(result.ok ? { ok: true } : result).toEqual({ ok: true });
            if (!result.ok) return;
            const login = withDatabaseConnectionLogin(base, role, result.password);
            await expect(openMysqlConnection(login)).rejects.toMatchObject({ code: 'ER_ACCESS_DENIED_ERROR' });
            // MySQL's autogenerated fixture certificate uses its own CN, which must fail loopback identity verification.
            const ca = (await run('docker', ['exec', name, 'cat', '/var/lib/mysql/ca.pem'])).stdout;
            await expect(openMysqlConnection(login, undefined, { tls: { ca } })).rejects.toMatchObject({ code: 'HANDSHAKE_SSL_ERROR' });
            const encryptedFixtureLogin = withDatabaseConnectionUrlOptions(login, { ssl: JSON.stringify({ rejectUnauthorized: false }) });
            const reader = await openMysqlConnection(encryptedFixtureLogin);
            try {
                expect(await reader.verifyReadRole()).toEqual({ ok: true });
                for (const [sql, mode, expected] of [
                    ['SELECT id FROM items', 'read', { ok: true }],
                    ['SELECT id FROM nativeXfixture.items', 'read', { ok: false, cause: { code: 'ER_TABLEACCESS_DENIED_ERROR' } }],
                    ['UPDATE items SET note = NULL', 'write', { ok: false, cause: { code: 'ER_TABLEACCESS_DENIED_ERROR' } }],
                ] as const) {
                    const statement = { sql, parameters: [] };
                    const operation = mode === 'read' ? { mode, statement } : { mode, statements: [statement] };
                    expect(await reader.execute({ operation: 'statement.run', target, ...operation })).toMatchObject(expected);
                }
                await sql(`GRANT UPDATE ON native_fixture.items TO '${role}'@'%'`);
                expect(await reader.verifyReadRole()).toMatchObject({ ok: false, code: 'database_read_role_not_read_only' });
            } finally { await reader.close(); }
        } finally { await writer.close(); }
    } finally { await run('docker', ['stop', name]); }
}, 120_000);
