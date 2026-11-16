import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { OwnServerDataQueryNative, OwnServerReadOnlyDataQueryInput } from './dataQuery';
import { assertOwnServerDataQuerySupportedEngine, executeOwnServerReadOnlyDataQuery, ownServerReadOnlyRoleGuardSql } from './dataQuery';

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
const mysqlIdentifier = (value: string) => `\`${value.replaceAll('`', '``')}\``;

/** Called only from the reviewed bindings writer. Administrator credentials stay
 * inside the selected container; queries never obtain this setup command. */
export async function bootstrapOwnServerReadOnlyDataRoleForHost(input: Pick<OwnServerReadOnlyDataQueryInput,
    'engine' | 'database' | 'port' | 'password' | 'signal'>, native: OwnServerDataQueryNative): Promise<void> {
    const engine = input.engine;
    assertOwnServerDataQuerySupportedEngine(engine);
    const passwordBase64 = Buffer.from(input.password).toString('base64');
    const run = async (sql: string) => {
        const postgres = engine === 'postgresql';
        const command = postgres
            ? 'PGPASSWORD="${POSTGRES_PASSWORD:-}" exec psql -X -v ON_ERROR_STOP=1 --username="${POSTGRES_USER:-postgres}" --dbname="$1" --port="$3" -At -f -'
            : 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}" exec "$2" --user=root --host=127.0.0.1 --database="$1" --port="$3" --batch --raw --skip-column-names';
        const result = await native.run({ argv: ['sh', '-c', command, 'happier-data-role', postgres ? `dbname='${input.database.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : input.database,
            postgres ? 'psql' : 'mysql', String(input.port ?? (postgres ? 5432 : 3306))], stdin: Buffer.from(sql), env: {}, signal: input.signal });
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
    await executeOwnServerReadOnlyDataQuery({ ...input, sql: 'SELECT 1 AS happier_role_ready', params: {} }, native);
}
