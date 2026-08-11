import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export type ClaudeSubscriptionCredentialIdentity = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
}>;

function readOptionalIdentityValue(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readClaudeSubscriptionCredentialIdentity(
  record: ConnectedServiceCredentialRecordV1 | null,
): ClaudeSubscriptionCredentialIdentity | null {
  if (!record || record.serviceId !== 'claude-subscription') return null;
  if (record.kind === 'oauth') {
    return {
      providerAccountId: readOptionalIdentityValue(record.oauth.providerAccountId),
      providerEmail: readOptionalIdentityValue(record.oauth.providerEmail),
    };
  }
  if (record.kind === 'token') {
    return {
      providerAccountId: readOptionalIdentityValue(record.token.providerAccountId),
      providerEmail: readOptionalIdentityValue(record.token.providerEmail),
    };
  }
  return null;
}
