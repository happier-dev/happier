import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { bootstrapOwnServerWriteDataRoleForHost } from './dataRoleBootstrap';
import type { OwnServerDataQueryNative } from './dataQueryNative';
import { createNativePostgresqlFixture, nativePostgresqlAvailable } from './nativePostgresql.testkit';

describe('native write-role bootstrap (P3 R14)', () => {
    it.skipIf(!nativePostgresqlAvailable)('bootstraps a bounded PostgreSQL writer for superuser- and member-owned apps', async () => {
        await withTempDir('happier-role-rw-', async directory => {
            const postgres = await createNativePostgresqlFixture(directory);
            try {
                // Replace only the container process boundary with this owned database.
                const native: OwnServerDataQueryNative = { run: async request => {
                    const result = spawnSync(request.argv[0]!, request.argv.slice(1), { input: request.stdin,
                        env: { ...process.env, PATH: `${dirname(postgres.psqlPath)}:${process.env.PATH}`,
                            PGHOST: directory, POSTGRES_USER: 'fixture', ...request.env }, encoding: 'utf8' });
                    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false };
                } };
                await postgres.execute('CREATE ROLE app_owner LOGIN');
                await postgres.execute('CREATE DATABASE member_app OWNER app_owner');
                await postgres.execute('SET ROLE app_owner; CREATE TABLE owned(id serial PRIMARY KEY, value text)', 'member_app');
                await postgres.execute('CREATE TABLE role_fixture(id serial PRIMARY KEY, value text); INSERT INTO role_fixture(value) VALUES (\'original\')');
                const writer = (database: string, sql: string) => spawnSync(postgres.psqlPath, ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
                    '--host=127.0.0.1', '--port', String(postgres.port), '--username=happier_rw', `--dbname=${database}`, '-c', sql],
                { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'write-password' } });
                const signal = new AbortController().signal;
                // G1: the superuser-owned app gets DML grants and the writer commits a row.
                await bootstrapOwnServerWriteDataRoleForHost({ engine: 'postgresql', database: 'postgres', port: postgres.port,
                    password: 'write-password', signal }, native);
                expect(writer('postgres', "INSERT INTO role_fixture(value) VALUES ('written') RETURNING value").stdout.trim()).toBe('written');
                expect((await postgres.execute("SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname='happier_rw'")).stdout)
                    .toContain('f        | f             | f           | f              | f');
                const fileRead = writer('postgres', "SELECT pg_read_file('/etc/hostname')");
                expect(fileRead.status).not.toBe(0);
                expect(fileRead.stderr).toContain('permission denied');
                expect(writer('postgres', 'CREATE ROLE escalated').status).not.toBe(0);
                // A member-owned app: the writer acts through the app's owning role.
                await bootstrapOwnServerWriteDataRoleForHost({ engine: 'postgresql', database: 'member_app', port: postgres.port,
                    password: 'write-password', signal }, native);
                expect(writer('member_app', "INSERT INTO owned(value) VALUES ('member') RETURNING value").stdout.trim()).toBe('member');
                // Tampered authority is refused without rotating the password.
                const password = async () => (await postgres.execute("SELECT rolpassword FROM pg_authid WHERE rolname='happier_rw'")).stdout;
                const original = await password();
                await postgres.execute('ALTER ROLE happier_rw CREATEROLE');
                await expect(bootstrapOwnServerWriteDataRoleForHost({ engine: 'postgresql', database: 'postgres', port: postgres.port,
                    password: 'replacement', signal }, native)).rejects.toMatchObject({ code: 'write_role_unavailable' });
                expect(await password()).toBe(original);
            } finally { await postgres.close(); }
        });
    });
});
