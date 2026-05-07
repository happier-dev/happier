import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export type GithubConnectedAccountTokenResolution =
  | Readonly<{
      kind: 'available';
      token: string;
      profileId: string;
      credentialKind: 'oauth' | 'token';
      providerAccountId: string | null;
      providerEmail: string | null;
    }>
  | Readonly<{ kind: 'missing' }>;

function normalizeNonEmptyString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveGithubConnectedAccountToken(
  record: ConnectedServiceCredentialRecordV1 | null | undefined,
): GithubConnectedAccountTokenResolution {
  if (!record || record.serviceId !== 'github') {
    return { kind: 'missing' };
  }

  if (record.kind === 'token') {
    const token = normalizeNonEmptyString(record.token.token);
    if (!token) return { kind: 'missing' };
    return {
      kind: 'available',
      token,
      profileId: record.profileId,
      credentialKind: 'token',
      providerAccountId: record.token.providerAccountId,
      providerEmail: record.token.providerEmail,
    };
  }

  const token = normalizeNonEmptyString(record.oauth.accessToken);
  if (!token) return { kind: 'missing' };
  return {
    kind: 'available',
    token,
    profileId: record.profileId,
    credentialKind: 'oauth',
    providerAccountId: record.oauth.providerAccountId,
    providerEmail: record.oauth.providerEmail,
  };
}
