import type { PostgresqlCompiledStatement } from './operations.js';
import { postgresqlWorkbenchReadSql } from './workbenchIdentity.js';

export const postgresqlReadRoleSchemas: PostgresqlCompiledStatement = {
    text: postgresqlWorkbenchReadSql(`SELECT nspname FROM pg_catalog.pg_namespace
        WHERE nspname <> 'information_schema' AND pg_catalog.left(nspname, 3) <> 'pg_'`),
    values: [],
};

/** Check the named role's effective rights including PUBLIC, without switching roles.
 * Members can activate other roles, so they require a dedicated direct-grant login. */
export function postgresqlReadRoleProof(role: string, schemas: readonly string[] | null): PostgresqlCompiledStatement {
    return {
        text: postgresqlWorkbenchReadSql(`SELECT r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
            AND NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
            AND pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CONNECT')
            AND NOT pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE, CONNECT WITH GRANT OPTION')
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_namespace n
                WHERE pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE, USAGE WITH GRANT OPTION')
            )
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_class c
                -- The built-in pg_settings view grants PUBLIC updates to session settings only.
                WHERE (c.oid <> 'pg_catalog.pg_settings'::pg_catalog.regclass AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
                    c.relowner = r.oid OR pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE, TRUNCATE, TRIGGER')
                    OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT, UPDATE, REFERENCES, SELECT WITH GRANT OPTION')
                    OR EXISTS (SELECT FROM pg_catalog.aclexplode(c.relacl) a
                        WHERE a.grantee IN (0, r.oid) AND a.privilege_type = 'MAINTAIN')
                )) OR (c.relkind = 'S' AND pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE, UPDATE, SELECT WITH GRANT OPTION'))
            )
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE p.proowner = r.oid OR (p.prosecdef AND n.nspname <> 'information_schema'
                    AND pg_catalog.left(n.nspname, 3) <> 'pg_'
                    AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE')
                    AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
            )
            AND NOT EXISTS (
                SELECT FROM pg_catalog.jsonb_array_elements_text($2::jsonb) AS scope(name)
                LEFT JOIN pg_catalog.pg_namespace n ON n.nspname::text = scope.name
                WHERE n.oid IS NULL OR NOT pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE')
                    OR EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid
                        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                        AND NOT pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT'))
            )
            FROM pg_catalog.pg_roles r WHERE r.rolname = $1`),
        values: [role, schemas ? JSON.stringify(schemas) : null],
    };
}
