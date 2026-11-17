/** Shared PostgreSQL authority check for the bounded write login (P3 R14). It runs as the
 * selected login before caller SQL: never a superuser or role administrator, and never a
 * member of a privileged or server-file/program role. Membership of the app's own
 * non-superuser owning role is the authority an editor is chosen for. */
export const postgresqlWriteRoleGuardSql = `DO $happier_guard$
BEGIN
  IF current_setting('server_version_num')::int < 140000
     OR current_user <> 'happier_rw'
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
       AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR NOT rolcanlogin))
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = current_user::regrole AND admin_option)
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER')
       AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
         OR (rolname LIKE 'pg\\_%' AND rolname <> 'pg_database_owner')))
  THEN
    RAISE EXCEPTION 'happier_write_role_unavailable' USING ERRCODE = '42501';
  END IF;
END
$happier_guard$;`;
