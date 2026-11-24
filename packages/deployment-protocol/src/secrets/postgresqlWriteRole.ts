/** The native authority floor shared by staging restore and workbench logins. */
export const postgresqlBoundedLoginAuthoritySql = `rolcanlogin
    AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
    AND NOT pg_catalog.pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'pg_read_server_files', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'pg_write_server_files', 'MEMBER')`;

const writeLoginProof = `SELECT FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND current_user = 'happier_rw'
      AND pg_catalog.current_setting('server_version_num')::int >= 140000
      AND ${postgresqlBoundedLoginAuthoritySql}
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member = current_user::regrole AND admin_option)
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_roles AS member_role
        WHERE member_role.rolname <> current_user AND pg_catalog.pg_has_role(current_user, member_role.oid, 'MEMBER')
          AND (member_role.rolsuper OR member_role.rolcreaterole OR member_role.rolcreatedb
            OR member_role.rolreplication OR member_role.rolbypassrls
            OR (pg_catalog.left(member_role.rolname, 3) = 'pg_' AND member_role.rolname <> 'pg_database_owner')))`;

/** Prove the login's authority before adopting or publishing a binding. */
export const postgresqlWriteRoleGuardSql = `DO $happier_guard$
BEGIN
  IF NOT EXISTS (${writeLoginProof}) THEN
    RAISE EXCEPTION 'happier_write_role_unavailable' USING ERRCODE = '42501';
  END IF;
END
$happier_guard$;`;

/** One guarded acquisition returns the transaction role, or NULL for the DML grant arm. */
export const postgresqlWriteRoleSetupSql = `SELECT CASE WHEN owner.rolsuper THEN NULL ELSE owner.rolname END
    FROM pg_catalog.pg_database AS db JOIN pg_catalog.pg_roles AS owner ON owner.oid = db.datdba
    WHERE db.datname = pg_catalog.current_database() AND EXISTS (${writeLoginProof})
      AND (owner.rolsuper OR pg_catalog.pg_has_role(current_user, owner.oid,
        CASE WHEN pg_catalog.current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END))`;
