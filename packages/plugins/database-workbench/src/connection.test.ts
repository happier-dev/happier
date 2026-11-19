import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { DatabaseManualTargetV1 } from '@happier-dev/plugin-sdk/database';
import { openManualDatabaseConnection, type DatabaseWorkbenchConnection } from './connection.js';

const target: DatabaseManualTargetV1 = {
    kind: 'manual', accountId: 'account', installationId: 'installation', projectKey: 'project', savedSecretId: 'selected-secret',
    workspace: { serverId: 'server', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' },
};
const directories: string[] = [];
const connections: DatabaseWorkbenchConnection[] = [];
afterEach(async () => {
    await Promise.all(connections.splice(0).map(connection => connection.close()));
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('manual Saved Secret native connection selection', () => {
    it.each(['file', 'sqlite'])('opens the selected %s SQLite path and enforces the admitted read or write opening mode', async scheme => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-manual-')); directories.push(directory);
        const path = join(directory, 'selected database.sqlite');
        const db = openSqliteDatabaseSync(path);
        db.exec("CREATE TABLE selected(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO selected VALUES (1,'selected');"); db.close();
        const secretValue = pathToFileURL(path).toString().replace(/^file:/u, `${scheme}:`);
        const read = await openManualDatabaseConnection({ target, secretValue, access: 'read' }); connections.push(read);
        expect(read.engine).toBe('sqlite');
        expect(await read.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT label FROM selected', parameters: [] } }))
            .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'selected' }] }] }] });
        expect(await read.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: "UPDATE selected SET label='forbidden'", parameters: [] }] }))
            .toMatchObject({ ok: false, status: 'failed' });
        const write = await openManualDatabaseConnection({ target, secretValue, access: 'write' }); connections.push(write);
        expect(await write.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{ sql: "UPDATE selected SET label='changed'", parameters: [] }] }))
            .toMatchObject({ ok: true });
        expect(await read.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT label FROM selected', parameters: [] } }))
            .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'changed' }] }] }] });
        expect(JSON.stringify(write)).not.toContain(secretValue);
    });

    it.skipIf(process.platform === 'win32')('keeps a remote file host from selecting an unrelated local SQLite file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-manual-host-')); directories.push(directory);
        const path = join(directory, 'local.sqlite');
        const db = openSqliteDatabaseSync(path); db.exec('CREATE TABLE local_only(id INTEGER)'); db.close();
        const address = pathToFileURL(path); address.hostname = 'other-machine';
        await expect(openManualDatabaseConnection({ target, secretValue: address.toString(), access: 'read' }))
            .rejects.toMatchObject({ code: 'ERR_INVALID_FILE_URL_HOST' });
    });

    it('reports the URL owner error without disclosing malformed secret content', async () => {
        const secretValue = '{"url":"postgresql://user:private-credential@host/db"}';
        await expect(openManualDatabaseConnection({ target, secretValue, access: 'read' })).rejects.toMatchObject({
            code: 'invalid_database_connection_url', message: 'The database connection URL is invalid',
        });
    });

    it('honors cancellation before opening a selected SQLite file and never creates a missing file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-manual-abort-')); directories.push(directory);
        const path = join(directory, 'missing.sqlite');
        const controller = new AbortController(); controller.abort();
        await expect(openManualDatabaseConnection({ target, secretValue: pathToFileURL(path).toString(), access: 'write', signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(existsSync(path)).toBe(false);
    });
});

describe('manual Saved Secret selection through the real PostgreSQL driver', () => {
    const run = promisify(execFile);
    const binaries = process.env.HAPPIER_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
    let directory: string;
    let started = false;
    let secretValue: string;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'dbw-manual-pg-'));
        await run(join(binaries, 'initdb'), ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
        await run(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-c listen_addresses='' -k ${directory}`, '-w', 'start']);
        started = true;
        secretValue = `postgresql://fixture@localhost/postgres?host=${encodeURIComponent(directory)}`;
    });
    afterAll(async () => {
        if (started) await run(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
        if (directory) await rm(directory, { recursive: true, force: true });
    });
    it('uses the acquired address on its private native connection', async () => {
        const connection = await openManualDatabaseConnection({ target, secretValue, access: 'read' }); connections.push(connection);
        expect(connection.engine).toBe('postgresql');
        expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "SELECT 'manual-postgresql'::text", parameters: [] } }))
            .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'manual-postgresql' }] }] }] });
        expect(JSON.stringify(connection)).not.toContain(secretValue);
    });
});

const mysqlAddress = process.env.HAPPIER_TEST_MYSQL_URL;
it.skipIf(!mysqlAddress)('selects the real MySQL adapter for an acquired manual address', async () => {
    const connection = await openManualDatabaseConnection({ target, secretValue: mysqlAddress!, access: 'read' }); connections.push(connection);
    expect(connection.engine).toBe('mysql');
    expect(await connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: "SELECT 'manual-mysql'", parameters: [] } }))
        .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'manual-mysql' }] }] }] });
    expect(JSON.stringify(connection)).not.toContain(mysqlAddress!);
});

it('publishes only the parsed network endpoint in cold connection descriptors', async () => {
    const { describeDatabaseConnection } = await import('./connection.js');
    expect(describeDatabaseConnection('postgresql://alice:private@[::1]:5432/billing?token=private'))
        .toMatchObject({ engine: 'postgresql', endpointLabel: '[::1]:5432' });
    expect(describeDatabaseConnection('mysql://alice:private@db/billing')).toMatchObject({ endpointLabel: 'db' });
    expect(describeDatabaseConnection('file:///private/billing.sqlite')).not.toHaveProperty('endpointLabel');
});
