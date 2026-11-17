import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { postgresqlReadOnlyRoleGuardSql, postgresqlWriteRoleGuardSql } from '@happier-dev/deployment-protocol';

export type OwnServerDataEngine = 'postgresql' | 'mysql' | 'mariadb';

function refuse(code: string, reason: string): never {
    throw new PluginError({ code, message: 'The read-only database query is unavailable', details: { reason } });
}

/** MariaDB's implicit PUBLIC authority has not been proven by bootstrap. */
export function assertOwnServerDataQuerySupportedEngine(engine: OwnServerDataEngine):
    asserts engine is 'postgresql' | 'mysql' {
    if (engine === 'mariadb') refuse('unsupported_action', 'mariadb_read_role_authority_unproven');
}

export const ownServerMysqlNativeTextLiteral = (value: string) => `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`;

/** Reviewed bootstrap owns role authority. Ordinary query sessions consume its
 * admitted dedicated-login credential and never obtain administrator access. */
export function ownServerReadOnlyRoleGuardSql(engine: 'postgresql' | 'mysql',
    options: Readonly<{ mysqlGrantee?: string; database?: string }> = {}): string {
    if (engine === 'postgresql') return postgresqlReadOnlyRoleGuardSql;
    return ownServerMysqlRoleGuardSql({ user: 'happier_ro', grantee: options.mysqlGrantee ?? "'happier_ro'@'127.0.0.1'",
        database: options.database, privileges: ['SELECT', 'SHOW VIEW'] });
}

/** The bounded writer `happier_rw` (P3 R14): DML on the selected database only, nothing server-wide. */
export function ownServerWriteRoleGuardSql(engine: 'postgresql' | 'mysql', options: Readonly<{ database?: string }> = {}): string {
    if (engine === 'postgresql') return postgresqlWriteRoleGuardSql;
    return ownServerMysqlRoleGuardSql({ user: 'happier_rw', grantee: "'happier_rw'@'127.0.0.1'", database: options.database,
        privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW VIEW'] });
}

/** One MySQL account check for both dedicated logins: exactly `privileges` on the selected database, nothing else. */
function ownServerMysqlRoleGuardSql(options: Readonly<{ user: 'happier_ro' | 'happier_rw'; grantee: string; database?: string;
    privileges: readonly string[] }>): string {
    const grantee = ownServerMysqlNativeTextLiteral(options.grantee);
    const database = options.database ? ownServerMysqlNativeTextLiteral(options.database) : 'DATABASE()';
    const user = options.user;
    const privileges = options.privileges.map(privilege => `'${privilege}'`).join(', ');
    const roles = `NOT EXISTS (SELECT 1 FROM mysql.role_edges WHERE TO_USER = '${user}' AND TO_HOST = '127.0.0.1')\n`
                + `  AND NOT EXISTS (SELECT 1 FROM mysql.global_grants WHERE USER = '${user}' AND HOST = '127.0.0.1')\n`
                + "  AND @@mandatory_roles = ''";
    // Routine visibility includes built-in sys routines and is not an EXECUTE
    // grant. Reviewed administrator adoption checks the account's grant table.
    const routines = `NOT EXISTS (SELECT 1 FROM mysql.procs_priv WHERE User = '${user}' AND Host = '127.0.0.1')`;
    return `SET @happier_query_authorized = (
  ${roles} AND ${routines}
  AND NOT EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = ${grantee} AND (PRIVILEGE_TYPE <> 'USAGE' OR IS_GRANTABLE <> 'NO'))
  AND NOT EXISTS (SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${grantee}
    AND (TABLE_SCHEMA <> ${database} OR PRIVILEGE_TYPE NOT IN (${privileges}) OR IS_GRANTABLE <> 'NO'))
  AND (SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.SCHEMA_PRIVILEGES
    WHERE GRANTEE = ${grantee} AND TABLE_SCHEMA = ${database} AND PRIVILEGE_TYPE IN (${privileges})) = ${options.privileges.length}
  AND NOT EXISTS (SELECT 1 FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ${grantee})
  AND NOT EXISTS (SELECT 1 FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ${grantee})
);`;
}
