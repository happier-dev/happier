import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/protocol/actions/externalActionLimits';
import { executeOwnServerReadOnlyDataQuery, type OwnServerDataQueryNative } from './dataQuery';
import { bootstrapOwnServerReadOnlyDataRoleForHost } from './dataRoleBootstrap';

const base = { engine: 'postgresql' as const, database: 'app', password: 'private-password',
    params: {}, signal: new AbortController().signal };
function boundary(stdout: string, stdoutTruncated = false, exitCode = 0) {
    const run = vi.fn<OwnServerDataQueryNative['run']>(async () => ({ exitCode, stdout, stdoutTruncated }));
    return { run };
}

function sizedNativeResult(engine: 'postgresql' | 'mysql' = 'postgresql') {
    const columns = [{ name: 'value' }, { name: 'empty' }, { name: 'missing' }];
    const first: [string, string, null] = ['😀"\\\n', '', null];
    const measure = (value: string) => measureExternalActionResultResponseEnvelopeUtf8BytesV1({
        ok: true, columns, rows: [first, [value, '', null]], complete: true,
    });
    const available = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - 1 - measure('');
    const unit = engine === 'postgresql' ? '\u0001' : '\t';
    const unitBytes = measure(unit) - measure('');
    const large = unit.repeat(Math.floor(available / unitBytes)) + 'a'.repeat(available % unitBytes);
    const csvRow = (value: string) => `"${value.replaceAll('"', '""')}","",\n`;
    const xmlText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const xmlRow = (value: string) => `<row><field name="value">${xmlText(value)}</field><field name="empty"></field><field name="missing" xsi:nil="true" /></row>`;
    const native = (values: string[]) => engine === 'postgresql' ? 'value,empty,missing\n' + values.map(csvRow).join('')
        : '<resultset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + values.map(xmlRow).join('') + '</resultset>';
    return { columns, first, large, native };
}

describe('native read-role query', () => {
    it('keeps named values separate from SQL and returns CSV columns, null and quoted multiline data', async () => {
        const native = boundary('name,empty,missing\n"hello,\nworld","",\n');
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql: "SELECT :'value' AS name, '' AS empty, NULL AS missing",
            params: { value: "'; DROP TABLE important; --" } }, native)).resolves.toEqual({
            columns: [{ name: 'name' }, { name: 'empty' }, { name: 'missing' }],
            rows: [['hello,\nworld', '', null]], complete: true,
        });
        const request = native.run.mock.calls[0]![0];
        expect(request.argv).toContain('--username=happier_ro');
        expect(request.argv).toContain("value='; DROP TABLE important; --");
        expect(request.argv.join(' ')).not.toContain(base.password);
        expect(request.env.PGPASSWORD).toBe(base.password);
        const sql = new TextDecoder().decode(request.stdin);
        expect(sql).toContain('BEGIN READ ONLY;');
        expect(sql).toContain("SELECT :'value' AS name");
        expect(sql).not.toContain('DROP TABLE important');
    });

    it.each(['SELECT 1;\n\\! echo unsafe', 'SELECT 1 \\gexec', '\\copy t FROM PROGRAM cat', 'SELECT :value',
        "SELECT 'ok'; SELECT 2", "SET standard_conforming_strings=off; SELECT 2",
        'COMMIT; SET default_transaction_read_only=off; INSERT INTO important VALUES (1)'])('refuses client commands or multiple statements before execution: %s', async sql => {
        const native = boundary('value\n1\n');
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql }, native)).rejects.toMatchObject({ code: 'unsupported_action' });
        expect(native.run).not.toHaveBeenCalled();
    });

    it.each(["SELECT '\\! inert'", "SELECT E'\\\\! inert'", 'SELECT $$\\! inert;$$',
        'SELECT $body$\\! inert;$body$', 'SELECT 1 /* \\! inert; */', 'SELECT 1 -- \\! inert;\n'])('preserves inert quoted/comment text: %s', async sql => {
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql }, boundary('value\n1\n'))).resolves.toMatchObject({ complete: true });
    });

    it('returns only complete captured CSV rows when the existing native capture truncates', async () => {
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql: 'SELECT value FROM t' }, boundary('value\nfirst\n"part', true)))
            .resolves.toEqual({ columns: [{ name: 'value' }], rows: [['first']], complete: false,
                diagnostic: { code: 'native_output_truncated' } });
    });

    it('preserves Unicode, NULL and empty text just under the complete Action envelope bound', async () => {
        const fixture = sizedNativeResult();
        const result = await executeOwnServerReadOnlyDataQuery({ ...base, sql: 'SELECT value, empty, missing FROM t' },
            boundary(fixture.native([fixture.first[0], fixture.large])));
        expect(result.complete).toBe(true);
        expect(result.columns).toEqual(fixture.columns);
        expect(result.rows[0]).toEqual(fixture.first);
        expect(result.rows[1]?.[0]).toBe(fixture.large);
        expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ok: true, ...result }))
            .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - 1);
    });

    it.each(['postgresql', 'mysql'] as const)('keeps the fitting whole-row prefix when the %s Action envelope including its diagnostic exceeds the bound', async engine => {
        const fixture = sizedNativeResult(engine);
        const complete = fixture.native([fixture.first[0], fixture.large, '😀']);
        // Decoding must stop at the bound, rather than building all later rows
        // and projecting afterwards. An unread malformed tail makes that visible.
        const stdout = engine === 'postgresql' ? complete + '"unfinished'
            : complete.replace('</resultset>', '<row><invalid-field /></row></resultset>');
        const result = await executeOwnServerReadOnlyDataQuery({ ...base, engine, sql: 'SELECT value, empty, missing FROM t' },
            boundary(stdout));
        expect(result.complete).toBe(false);
        expect(result.diagnostic?.code).toBe('action_result_size_limit');
        expect(result.columns).toEqual(fixture.columns);
        expect(result.rows).toEqual([fixture.first]);
        expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ok: true, ...result }))
            .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    });

    it('returns explicit incompleteness when the column header alone cannot fit the Action envelope', async () => {
        const emptyBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({
            ok: true, columns: [{ name: '' }], rows: [], complete: true,
        });
        const remaining = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1 - emptyBytes;
        const unitBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({
            ok: true, columns: [{ name: '\u0001' }], rows: [], complete: true,
        }) - emptyBytes;
        const header = '\u0001'.repeat(Math.floor(remaining / unitBytes)) + 'a'.repeat(remaining % unitBytes);
        const result = await executeOwnServerReadOnlyDataQuery({ ...base, sql: 'SELECT value FROM t' }, boundary(header + '\n'));
        expect(result.columns.length).toBe(0);
        expect(result).toEqual({ columns: [], rows: [], complete: false, diagnostic: { code: 'action_result_size_limit' } });
        expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ok: true, ...result }))
            .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    });

    it('does not relabel a database refusal as successful or disclose native stderr', async () => {
        const native: OwnServerDataQueryNative = { run: async () => ({ exitCode: 1, stdout: '', stdoutTruncated: false,
            stderr: 'ERROR: permission denied private-password' }) };
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql: 'INSERT INTO t VALUES (1)' }, native))
            .rejects.toMatchObject({ code: 'query_failed', details: { exitCode: 1 } });
    });

    it('reports an absent in-container database client as an unsupported prerequisite', async () => {
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql: 'SELECT 1' }, boundary('', false, 127)))
            .rejects.toMatchObject({ code: 'unsupported_action', details: { reason: 'database_client_unavailable' } });
    });

    it('accepts native parameter names beside the client-control and reserved namespace boundaries', async () => {
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, sql: "SELECT :'on_error_stop' AS value",
            params: { on_error_stop: 'ordinary value', happier: 'ordinary value', a0_b: 'ordinary value' } }, boundary('value\nordinary value\n')))
            .resolves.toMatchObject({ rows: [['ordinary value']], complete: true });
    });

    it('refuses PostgreSQL COPY raw output rather than inventing a result header', async () => {
        await expect(executeOwnServerReadOnlyDataQuery({ ...base,
            sql: "/* native copy stream */ COPY (SELECT 'first' UNION ALL SELECT 'second') TO STDOUT" }, boundary('first\nsecond\n')))
            .rejects.toMatchObject({ code: 'unsupported_action', details: { reason: 'unsupported_native_result' } });
    });

    it('uses MySQL server parameter variables and preserves XML null versus the string NULL', async () => {
        const native = boundary('<?xml version="1.0"?>\n<resultset statement="SELECT @value" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            + '<row><field name="value">NULL</field><field name="missing" xsi:nil="true" /><field name="text">a&amp;b&lt;c</field></row></resultset>');
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, engine: 'mysql', sql: 'SELECT @value',
            params: { value: "a'\\!" } }, native)).resolves.toEqual({ columns: [{ name: 'value' }, { name: 'missing' }, { name: 'text' }],
            rows: [['NULL', null, 'a&b<c']], complete: true });
        const request = native.run.mock.calls[0]![0];
        expect(request.argv).toContain('--binary-mode');
        expect(request.argv).toContain('--user=happier_ro');
        expect(request.argv.join(' ')).not.toContain(base.password);
        expect(request.env.MYSQL_PWD).toBe(base.password);
        const sql = new TextDecoder().decode(request.stdin);
        expect(sql).toContain('START TRANSACTION READ ONLY;');
        expect(sql).toContain('PREPARE happier_query FROM @happier_query_sql;');
        expect(sql).not.toContain("a'\\!");
    });

    it('refuses unproven MariaDB role authority before query or bootstrap native effects', async () => {
        const native = boundary('');
        const request = { ...base, engine: 'mariadb' as const, sql: 'SELECT 1' };
        await expect(executeOwnServerReadOnlyDataQuery(request, native)).rejects.toMatchObject({
            code: 'unsupported_action', details: { reason: 'mariadb_read_role_authority_unproven' },
        });
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost(request, native)).rejects.toMatchObject({
            code: 'unsupported_action', details: { reason: 'mariadb_read_role_authority_unproven' },
        });
        expect(native.run).not.toHaveBeenCalled();
    });
});

// The native endpoint is the system boundary: this fixture replaces Docker's
// container transport with an owned Unix socket, retaining the real psql/client
// parser, role, grants, transactions and database underneath it.
const postgresBin = '/usr/lib/postgresql/16/bin';
it.skipIf(!existsSync(join(postgresBin, 'initdb')))('real PostgreSQL rejects writes, DDL, transaction bypass and role escalation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-query-pg-'));
    const data = join(root, 'data');
    const ctl = (args: string[]) => execFileSync(join(postgresBin, 'pg_ctl'), ['-D', data, ...args], { stdio: 'pipe' });
    execFileSync(join(postgresBin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    await writeFile(join(data, 'pg_hba.conf'), 'local all happier_ro scram-sha-256\nlocal all all trust\n');
    ctl(['-l', join(root, 'server.log'), '-o', `-c listen_addresses= -k ${root}`, '-w', 'start']);
    // The PID is recorded before teardown; pg_ctl addresses only this owned DB.
    const pid = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    expect(pid).toBeGreaterThan(0);
    const psql = (sql: string, username?: string) => spawnSync(join(postgresBin, 'psql'), ['-X', '-h', root, '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', ...(username ? [`--username=${username}`] : []), '-At', '-c', sql],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: base.password } });
    try {
        const setup = psql("CREATE TABLE query_fixture (value text); INSERT INTO query_fixture VALUES ('original');");
        expect(setup.status, setup.stderr).toBe(0);
        const native: OwnServerDataQueryNative = { run: async request => {
            const args = request.argv.slice(1).map(arg => arg === '--host=127.0.0.1' ? `--host=${root}` : arg);
            const result = spawnSync(request.argv[0] === 'sh' ? 'sh' : join(postgresBin, 'psql'), args, { input: request.stdin,
                env: { ...process.env, PATH: `${postgresBin}:${process.env.PATH}`, PGHOST: root,
                    POSTGRES_USER: userInfo().username, ...request.env }, encoding: 'utf8' });
            return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false };
        } };
        await bootstrapOwnServerReadOnlyDataRoleForHost({ ...base, database: 'postgres' }, native);
        const payload = "hello'; DELETE FROM query_fixture; --\n\\! echo unsafe";
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, database: 'postgres', sql: "SELECT :'value' AS value",
            params: { value: payload } }, native)).resolves.toMatchObject({ rows: [[payload]], complete: true });
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, database: 'postgres',
            sql: "SELECT '' AS empty, NULL AS missing, 'HAPPIER_NULL' AS marker, 'literal;' AS text; -- trailing ;" }, native))
            .resolves.toMatchObject({ rows: [['', null, 'HAPPIER_NULL', 'literal;']], complete: true });
        for (const sql of ['\\! printf unsafe', "\\copy query_fixture TO PROGRAM 'printf unsafe'", '\\set ON_ERROR_STOP off',
            'SELECT 1; COMMIT; SET default_transaction_read_only=off; INSERT INTO query_fixture VALUES (1)']) {
            await expect(executeOwnServerReadOnlyDataQuery({ ...base, database: 'postgres', sql }, native))
                .rejects.toMatchObject({ code: 'unsupported_action' });
        }
        for (const sql of ['INSERT INTO query_fixture VALUES (\'changed\')', 'CREATE TABLE public.unwanted(value int)',
            'SET ROLE postgres']) {
            await expect(executeOwnServerReadOnlyDataQuery({ ...base, database: 'postgres', sql }, native))
                .rejects.toMatchObject({ code: 'query_failed' });
        }
        const bypass = psql("BEGIN READ WRITE; INSERT INTO query_fixture VALUES ('changed')", 'happier_ro');
        expect(bypass.status).not.toBe(0);
        expect(bypass.stderr).toContain('permission denied');
        expect(psql('SELECT value FROM query_fixture').stdout.trim()).toBe('original');
        expect(psql("CREATE FUNCTION public.query_writer() RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN INSERT INTO query_fixture VALUES ('wrong'); RETURN 1; END$$;").status).toBe(0);
        await expect(executeOwnServerReadOnlyDataQuery({ ...base, database: 'postgres', sql: 'SELECT public.query_writer()' }, native))
            .rejects.toMatchObject({ code: 'query_failed' });
        expect(psql('SELECT value FROM query_fixture').stdout.trim()).toBe('original');
        expect(psql('DROP FUNCTION public.query_writer()').status).toBe(0);
        const originalPassword = psql("SELECT rolpassword FROM pg_authid WHERE rolname='happier_ro'").stdout;
        expect(psql('ALTER ROLE happier_ro CREATEROLE').status).toBe(0);
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost({ ...base, database: 'postgres', password: 'replacement' }, native))
            .rejects.toMatchObject({ code: 'read_role_unavailable' });
        expect(psql("SELECT rolpassword FROM pg_authid WHERE rolname='happier_ro'").stdout === originalPassword).toBe(true);
        expect(psql('ALTER ROLE happier_ro NOCREATEROLE').status).toBe(0);
        expect(psql('GRANT pg_read_all_data TO happier_ro WITH ADMIN OPTION').status).toBe(0);
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost({ ...base, database: 'postgres' }, native))
            .rejects.toMatchObject({ code: 'read_role_unavailable' });
        expect(psql('REVOKE ADMIN OPTION FOR pg_read_all_data FROM happier_ro').status).toBe(0);
        // PostgreSQL 14's default PUBLIC CREATE must refuse before caller SQL.
        expect(psql('GRANT CREATE ON SCHEMA public TO PUBLIC').status).toBe(0);
        await expect(bootstrapOwnServerReadOnlyDataRoleForHost({ ...base, database: 'postgres' }, native))
            .rejects.toMatchObject({ code: 'read_role_unavailable' });
    } finally { ctl(['-m', 'fast', '-w', 'stop']); await rm(root, { recursive: true, force: true }); }
});
