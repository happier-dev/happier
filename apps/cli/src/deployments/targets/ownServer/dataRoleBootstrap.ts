import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { OwnServerDataQueryNative } from './dataQueryNative';
import { assertOwnServerDataQuerySupportedEngine, ownServerReadOnlyRoleGuardSql, ownServerWriteRoleGuardSql, type OwnServerDataEngine } from './dataRoleGuard';
import { postgresqlWriteRoleGuardSql } from '@happier-dev/deployment-protocol';

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
const mysqlIdentifier = (value: string) => `\`${value.replaceAll('`', '``')}\``;

function runOwnServerPostgresqlAdmin(input: Readonly<{ database: string; port?: number; signal: AbortSignal }>,
    sql: string, native: OwnServerDataQueryNative, loopback?: true) {
    const database = `dbname='${input.database.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    // The setup effect binds both libpq host fields to the selected container.
    // Kept role bootstraps retain their existing administrator socket defaults.
    const conninfo = loopback ? `${database} host=127.0.0.1 hostaddr=127.0.0.1` : database;
    return native.run({ argv: ['sh', '-c',
        'PGPASSWORD="${POSTGRES_PASSWORD:-}" exec psql -X -q -v ON_ERROR_STOP=1 --username="${POSTGRES_USER:-postgres}" --dbname="$1" --port="$2" -At -f -',
        'happier-postgresql-admin', conninfo, String(input.port ?? 5432)], stdin: Buffer.from(sql), env: {}, signal: input.signal });
}

/** The reviewed Enable Action supplies the exact database and this function supplies all SQL.
 * The built-in information_schema keeps extension installation out of writable app schemas.
 * Stats discovery reads the installed namespace from pg_extension. */
export async function enableOwnServerPostgresqlStatisticsForHost(input: Readonly<{
    database: string; port?: number; signal: AbortSignal;
}>, native: OwnServerDataQueryNative): Promise<'enabled' | 'restart_required'> {
    const result = await runOwnServerPostgresqlAdmin(input, `BEGIN;
SET LOCAL search_path = information_schema;
SELECT EXISTS (
    SELECT FROM regexp_split_to_table(current_setting('shared_preload_libraries'), ',') AS library(name)
    WHERE btrim(library.name, ' "') IN ('pg_stat_statements', '$libdir/pg_stat_statements')
) AS preloaded, EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed \\gset
\\if :preloaded
\\if :installed
\\else
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
\\endif
COMMIT;
SELECT 'enabled';
\\else
ROLLBACK;
SELECT 'restart_required';
\\endif
`, native, true);
    const status = result.stdout.trim();
    if (result.exitCode !== 0 || result.stdoutTruncated || (status !== 'enabled' && status !== 'restart_required'))
        return refuse('database_statistics_setup_failed');
    return status;
}

/** Called only from the reviewed bindings writer. Administrator credentials stay
 * inside the selected container; queries never obtain this setup command. */
export async function bootstrapOwnServerReadOnlyDataRoleForHost(input: Readonly<{
    engine: OwnServerDataEngine; database: string; port?: number; password: string; signal: AbortSignal;
}>, native: OwnServerDataQueryNative): Promise<void> {
    const engine = input.engine;
    assertOwnServerDataQuerySupportedEngine(engine);
    const passwordBase64 = Buffer.from(input.password).toString('base64');
    const run = async (sql: string) => {
        const result = engine === 'postgresql' ? await runOwnServerPostgresqlAdmin(input, sql, native)
            : await native.run({ argv: ['sh', '-c',
                'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}" exec mysql --user=root --host=127.0.0.1 --database="$1" --port="$2" --batch --raw --skip-column-names',
                'happier-data-role', input.database, String(input.port ?? 3306)], stdin: Buffer.from(sql), env: {}, signal: input.signal });
        if (result.stdoutTruncated) return refuse('read_role_unavailable');
        if (result.exitCode !== 0) return refuse(result.exitCode === 127 ? 'unsupported_action' : 'read_role_unavailable');
        return result.stdout.trim();
    };
    if (engine === 'postgresql') {
        await run(`BEGIN;
SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='happier_ro') AS role_exists \\gset
\\if :role_exists
SET LOCAL ROLE happier_ro;
${ownServerReadOnlyRoleGuardSql('postgresql')}
RESET ROLE;
\\else
CREATE ROLE happier_ro LOGIN;
GRANT pg_read_all_data TO happier_ro;
ALTER ROLE happier_ro SET default_transaction_read_only = on;
SET LOCAL ROLE happier_ro;
${ownServerReadOnlyRoleGuardSql('postgresql')}
RESET ROLE;
\\endif
ALTER ROLE happier_ro SET default_transaction_read_only = on;
SELECT convert_from(decode('${passwordBase64}','base64'),'UTF8') AS role_password \\gset
ALTER ROLE happier_ro PASSWORD :'role_password';
COMMIT;
`);
    } else {
        const account = "'happier_ro'@'127.0.0.1'";
        const exists = await run(`SELECT IF(EXISTS(SELECT 1 FROM mysql.user WHERE User='happier_ro' AND Host='127.0.0.1'),'exists','absent');`);
        if (exists !== 'exists' && exists !== 'absent') return refuse('read_role_unavailable');
        const verifyRole = async () => {
            const authorized = await run(`${ownServerReadOnlyRoleGuardSql(engine, { mysqlGrantee: account, database: input.database })}\nSELECT @happier_query_authorized;`);
            if (authorized !== '1') return refuse('read_role_unavailable');
        };
        if (exists === 'exists') await verifyRole();
        // QUOTE owns the engine's password literal; no caller value is SQL syntax.
        await run(`SET SESSION sql_mode='';
SET @role_password=CONVERT(FROM_BASE64('${passwordBase64}') USING utf8mb4);
SET @role_statement=CONCAT('${exists === 'exists' ? 'ALTER' : 'CREATE'} USER ${account.replaceAll("'", "''")} IDENTIFIED BY ',QUOTE(@role_password),'${exists === 'absent' ? ' ACCOUNT LOCK' : ''}');
PREPARE happier_role_setup FROM @role_statement;
EXECUTE happier_role_setup;
DEALLOCATE PREPARE happier_role_setup;
${exists === 'absent' ? `GRANT SELECT, SHOW VIEW ON ${mysqlIdentifier(input.database)}.* TO ${account};` : ''}
`);
        if (exists === 'absent') {
            // MySQL account DDL is not transactional. Refused setup must leave
            // the new login locked even when server-wide roles grant writes.
            await verifyRole();
            await run(`ALTER USER ${account} ACCOUNT UNLOCK;`);
        }
    }
    // This fixed readiness statement is bootstrap's login proof, not a public
    // query transport. Keep its output independent of legacy result mappers.
    const postgres = engine === 'postgresql';
    const ready = await native.run({
        argv: postgres ? ['psql', '-X', '-q', '-At', '--no-password', '--host=127.0.0.1', '--username=happier_ro',
            `--dbname=dbname='${input.database.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`,
            '--port', String(input.port ?? 5432), '-v', 'ON_ERROR_STOP=1', '-f', '-']
            : ['mysql', '--no-defaults', '--binary-mode', '--batch', '--raw', '--skip-column-names',
                '--protocol=TCP', '--host=127.0.0.1', '--user=happier_ro', `--database=${input.database}`,
                `--port=${input.port ?? 3306}`],
        stdin: Buffer.from(postgres ? `BEGIN READ ONLY;\n${ownServerReadOnlyRoleGuardSql('postgresql')}\nSELECT 1;\nROLLBACK;\n`
            : 'START TRANSACTION READ ONLY;\nSELECT 1;\nROLLBACK;\n'),
        env: postgres ? { PGPASSWORD: input.password, PGHOSTADDR: '', PGCLIENTENCODING: 'UTF8',
            PGOPTIONS: '-c default_transaction_read_only=on -c standard_conforming_strings=on', LC_ALL: 'C' }
            : { MYSQL_PWD: input.password, LC_ALL: 'C' },
        signal: input.signal,
    });
    if (ready.exitCode !== 0 || ready.stdoutTruncated || ready.stdout.trim() !== '1') return refuse('read_role_unavailable');
}

/** The bounded write login `happier_rw` (P3 R14), called only from the reviewed bindings
 * writer like the reader above. A non-superuser app owner is granted to it; a superuser-owned
 * app gets DML grants on its user schemas instead. It is never a superuser, role administrator
 * or server-file/program role, and the container administrator login never leaves the container. */
export async function bootstrapOwnServerWriteDataRoleForHost(input: Readonly<{
    engine: OwnServerDataEngine; database: string; port?: number; password: string; signal: AbortSignal;
}>, native: OwnServerDataQueryNative): Promise<void> {
    assertOwnServerDataQuerySupportedEngine(input.engine);
    if (input.engine === 'mysql') return bootstrapMysqlWriteRole({ ...input, engine: 'mysql' }, native);
    const passwordBase64 = Buffer.from(input.password).toString('base64');
    const port = String(input.port ?? 5432);
    const database = `dbname='${input.database.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    const setup = await runOwnServerPostgresqlAdmin(input, `BEGIN;
SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='happier_rw') AS role_exists \\gset
\\if :role_exists
SET LOCAL ROLE happier_rw;
${postgresqlWriteRoleGuardSql}
RESET ROLE;
\\else
CREATE ROLE happier_rw LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
\\endif
SELECT r.rolsuper AS owner_super, quote_ident(r.rolname) AS owner_ident
  FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = current_database() \\gset
\\if :owner_super
DO $happier_grants$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname !~ '^pg_' LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO happier_rw', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO happier_rw', schema_name);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO happier_rw', schema_name);
  END LOOP;
END
$happier_grants$;
\\else
GRANT :owner_ident TO happier_rw;
\\endif
SET LOCAL ROLE happier_rw;
${postgresqlWriteRoleGuardSql}
RESET ROLE;
SELECT convert_from(decode('${passwordBase64}','base64'),'UTF8') AS role_password \\gset
ALTER ROLE happier_rw PASSWORD :'role_password';
COMMIT;
`, native);
    if (setup.stdoutTruncated || setup.exitCode !== 0) return refuse(setup.exitCode === 127 ? 'unsupported_action' : 'write_role_unavailable');
    // This fixed readiness statement is bootstrap's login proof, not a query transport.
    const ready = await native.run({
        argv: ['psql', '-X', '-q', '-At', '--no-password', '--host=127.0.0.1', '--username=happier_rw',
            `--dbname=${database}`, '--port', port, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        stdin: Buffer.from(`BEGIN;\n${postgresqlWriteRoleGuardSql}\nSELECT 1;\nROLLBACK;\n`),
        env: { PGPASSWORD: input.password, PGHOSTADDR: '', PGCLIENTENCODING: 'UTF8',
            PGOPTIONS: '-c standard_conforming_strings=on', LC_ALL: 'C' },
        signal: input.signal,
    });
    if (ready.exitCode !== 0 || ready.stdoutTruncated || ready.stdout.trim() !== '1') return refuse('write_role_unavailable');
}

/** MySQL `happier_rw`: DML and SHOW VIEW on the selected database only, created locked and
 * unlocked only after the shared guard proves that is all it holds (account DDL is not transactional). */
async function bootstrapMysqlWriteRole(input: Readonly<{ engine: 'mysql'; database: string; port?: number; password: string;
    signal: AbortSignal }>, native: OwnServerDataQueryNative): Promise<void> {
    const port = String(input.port ?? 3306);
    const run = async (sql: string) => {
        const result = await native.run({ argv: ['sh', '-c',
            'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}" exec mysql --user=root --host=127.0.0.1 --database="$1" --port="$2" --batch --raw --skip-column-names',
            'happier-data-role', input.database, port], stdin: Buffer.from(sql), env: {}, signal: input.signal });
        if (result.stdoutTruncated) return refuse('write_role_unavailable');
        if (result.exitCode !== 0) return refuse(result.exitCode === 127 ? 'unsupported_action' : 'write_role_unavailable');
        return result.stdout.trim();
    };
    const account = "'happier_rw'@'127.0.0.1'";
    const verifyRole = async () => {
        const authorized = await run(`${ownServerWriteRoleGuardSql('mysql', { database: input.database })}\nSELECT @happier_query_authorized;`);
        if (authorized !== '1') return refuse('write_role_unavailable');
    };
    const exists = await run(`SELECT IF(EXISTS(SELECT 1 FROM mysql.user WHERE User='happier_rw' AND Host='127.0.0.1'),'exists','absent');`);
    if (exists !== 'exists' && exists !== 'absent') return refuse('write_role_unavailable');
    if (exists === 'exists') await verifyRole();
    // QUOTE owns the engine's password literal; no caller value is SQL syntax.
    await run(`SET SESSION sql_mode='';
SET @role_password=CONVERT(FROM_BASE64('${Buffer.from(input.password).toString('base64')}') USING utf8mb4);
SET @role_statement=CONCAT('${exists === 'exists' ? 'ALTER' : 'CREATE'} USER ${account.replaceAll("'", "''")} IDENTIFIED BY ',QUOTE(@role_password),'${exists === 'absent' ? ' ACCOUNT LOCK' : ''}');
PREPARE happier_role_setup FROM @role_statement;
EXECUTE happier_role_setup;
DEALLOCATE PREPARE happier_role_setup;
${exists === 'absent' ? `GRANT SELECT, INSERT, UPDATE, DELETE, SHOW VIEW ON ${mysqlIdentifier(input.database)}.* TO ${account};` : ''}
`);
    if (exists === 'absent') {
        await verifyRole();
        await run(`ALTER USER ${account} ACCOUNT UNLOCK;`);
    }
    const ready = await native.run({
        argv: ['mysql', '--no-defaults', '--binary-mode', '--batch', '--raw', '--skip-column-names', '--protocol=TCP',
            '--host=127.0.0.1', '--user=happier_rw', `--database=${input.database}`, `--port=${port}`],
        stdin: Buffer.from('START TRANSACTION;\nSELECT 1;\nROLLBACK;\n'),
        env: { MYSQL_PWD: input.password, LC_ALL: 'C' }, signal: input.signal,
    });
    if (ready.exitCode !== 0 || ready.stdoutTruncated || ready.stdout.trim() !== '1') return refuse('write_role_unavailable');
}
