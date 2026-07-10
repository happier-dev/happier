import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

export function readProviderAccountId(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind === 'oauth') {
    const accountId = record.oauth.providerAccountId;
    return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : null;
  }
  const accountId = record.token.providerAccountId;
  return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : null;
}

/**
 * A stable per-account identity fragment for the launch fingerprint. EXCLUDES all rotating
 * access/refresh token bytes; includes only serviceId + profileId + providerAccountId so a
 * same-account token refresh keeps the fingerprint unchanged (no managed-server churn) while two
 * different accounts never collapse to one identity.
 */
export function identityFragment(
  record: ConnectedServiceCredentialRecordV1,
  groupId?: string | null,
): string {
  const base = `${record.serviceId}:${record.profileId}:${readProviderAccountId(record) ?? ''}`;
  // R4-4/F3: a GROUP selection scopes the identity by pool so two distinct pools sharing one active
  // profile never collapse to one identity (registry authz + managed-server fingerprint stay
  // per-pool). Generation is deliberately EXCLUDED: consumers treat the identity as an opaque
  // equality key, and a generation-only bump must not re-mint (no managed-server churn).
  return groupId ? `${base}:group:${groupId}` : base;
}

export function requireTokenCredential(
  record: ConnectedServiceCredentialRecordV1,
  serviceId: string,
): Extract<ConnectedServiceCredentialRecordV1, { kind: 'token' }> {
  if (record.kind !== 'token') {
    throw new Error(`OpenCode ${serviceId} auth requires token credentials`);
  }
  return record;
}
