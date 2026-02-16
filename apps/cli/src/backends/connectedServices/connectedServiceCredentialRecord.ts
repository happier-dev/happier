import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export type ConnectedServiceOauthCredentialRecord = ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
export type ConnectedServiceOauthCredentialRecordWithExpiry = ConnectedServiceOauthCredentialRecord & { expiresAt: number };

export function requireConnectedServiceOauthCredentialRecord(
  record: ConnectedServiceCredentialRecordV1,
): ConnectedServiceOauthCredentialRecord {
  if (record.kind !== 'oauth') {
    throw new Error(`Expected oauth credential record for ${record.serviceId}/${record.profileId}`);
  }
  return record;
}

export function requireConnectedServiceOauthCredentialRecordWithExpiry(
  record: ConnectedServiceCredentialRecordV1,
): ConnectedServiceOauthCredentialRecordWithExpiry {
  const oauth = requireConnectedServiceOauthCredentialRecord(record);
  if (typeof oauth.expiresAt !== 'number') {
    throw new Error(`Expected oauth credential record with expiresAt for ${oauth.serviceId}/${oauth.profileId}`);
  }
  return oauth as ConnectedServiceOauthCredentialRecordWithExpiry;
}

export function buildConnectedServiceOauthAuthEntry(record: ConnectedServiceOauthCredentialRecordWithExpiry): Record<string, unknown> {
  return {
    type: 'oauth',
    refresh: record.oauth.refreshToken,
    access: record.oauth.accessToken,
    expires: record.expiresAt,
    ...(record.oauth.providerAccountId ? { accountId: record.oauth.providerAccountId } : {}),
  };
}
