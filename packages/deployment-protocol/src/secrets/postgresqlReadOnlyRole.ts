/** Shared PostgreSQL authority check for the dedicated query login.
 * SQL runs as the selected login before caller SQL; a read-only transaction
 * alone cannot establish database privileges. */
export const postgresqlReadOnlyRoleGuardSql = `DO $happier_guard$
BEGIN
  IF current_setting('server_version_num')::int < 140000
     OR current_user <> 'happier_ro'
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
       AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR NOT rolcanlogin))
     OR NOT pg_has_role(current_user, 'pg_read_all_data', 'USAGE')
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = current_user::regrole AND admin_option)
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname NOT IN (current_user, 'pg_read_all_data')
       AND pg_has_role(current_user, oid, 'MEMBER'))
     OR has_database_privilege(current_user, current_database(), 'CREATE')
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(current_user, oid, 'CREATE'))
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES')))
     OR EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S'
       AND has_sequence_privilege(current_user, oid, 'USAGE,UPDATE'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND has_function_privilege(current_user, p.oid, 'EXECUTE'))
  THEN
    RAISE EXCEPTION 'happier_read_role_unavailable' USING ERRCODE = '42501';
  END IF;
END
$happier_guard$;`;
