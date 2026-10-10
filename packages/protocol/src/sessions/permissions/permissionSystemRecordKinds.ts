/**
 * The `permission` System Record address and kinds, as a dependency-free leaf: the System Record
 * kind/namespace unions read them at module load, so they must not wait on the mediation schemas.
 */
export const SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE = 'permission' as const;
export const SESSION_PERMISSION_SYSTEM_RECORD_KINDS = [
  'remote_settlement.v1',
  'remote_grant.v1',
] as const;
