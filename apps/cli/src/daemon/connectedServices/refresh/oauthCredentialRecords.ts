import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import { requireEncryptionCredentials, type Credentials } from '@/persistence';

export function openConnectedServiceRecord(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): ConnectedServiceCredentialRecordV1 {
  requireEncryptionCredentials(params.credentials);
  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: params.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error('Failed to decrypt connected service credential');
  }
  return ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
}

export function buildUpdatedOauthRecord(params: Readonly<{
  now: number;
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  next: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    scope?: string | null;
    tokenType?: string | null;
    providerAccountId?: string | null;
    providerEmail?: string | null;
    expiresAt: number | null;
    raw?: (ConnectedServiceCredentialRecordV1 & { kind: 'oauth' })['oauth']['raw'];
  }>;
}>): ConnectedServiceCredentialRecordV1 {
  return ConnectedServiceCredentialRecordV1Schema.parse({
    ...params.record,
    updatedAt: params.now,
    expiresAt: params.next.expiresAt,
    oauth: {
      ...params.record.oauth,
      accessToken: params.next.accessToken,
      refreshToken: params.next.refreshToken,
      idToken: params.next.idToken,
      scope: params.next.scope ?? params.record.oauth.scope,
      tokenType: params.next.tokenType ?? params.record.oauth.tokenType,
      providerAccountId: params.next.providerAccountId ?? params.record.oauth.providerAccountId,
      providerEmail: params.next.providerEmail ?? params.record.oauth.providerEmail,
      raw: params.next.raw === undefined ? params.record.oauth.raw : params.next.raw,
    },
  });
}

export function hasObservedOauthCredentialChanged(
  before: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
  after: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
): boolean {
  return before.updatedAt !== after.updatedAt
    || before.expiresAt !== after.expiresAt
    || before.oauth.accessToken !== after.oauth.accessToken
    || before.oauth.refreshToken !== after.oauth.refreshToken
    || before.oauth.idToken !== after.oauth.idToken
    || before.oauth.scope !== after.oauth.scope
    || before.oauth.tokenType !== after.oauth.tokenType;
}

export function isChangedUsableOauthCredentialRevision(input: Readonly<{
  before: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  after: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  authoritativeExpiresAt: number | null;
  now: number;
}>): boolean {
  return hasObservedOauthCredentialChanged(input.before, input.after)
    && input.after.oauth.accessToken.trim().length > 0
    && typeof input.authoritativeExpiresAt === 'number'
    && Number.isFinite(input.authoritativeExpiresAt)
    && input.authoritativeExpiresAt > input.now;
}
