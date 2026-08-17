import { createHash } from 'node:crypto';

import type {
  OauthCredentialRecord,
  TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

type LegacyRuntimeAuthFailureSourceInput = Readonly<{
  reportedCredentialRevision: string | null;
  reportedProviderAccountId: string | null;
  failingAccessTokenFingerprint: string | null;
  liveIdentity: Readonly<{
    providerAccountId: string | null;
    credentialRevision: string | null;
  }>;
  currentCredential: Readonly<{
    record: OauthCredentialRecord | TokenCredentialRecord;
    credentialRevision: string;
  }>;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeAccessTokenFingerprint(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized && /^sha256:[a-f0-9]{8}$/u.test(normalized) ? normalized : null;
}

function fingerprintAccessToken(accessToken: string): string {
  return `sha256:${createHash('sha256').update(accessToken).digest('hex').slice(0, 8)}`;
}

/**
 * Codex-only compatibility for predecessor runners whose failure report or
 * exact-identity response omitted the opaque credential revision.
 */
export function resolveCodexLegacyRuntimeAuthFailureSourceRevision(
  input: LegacyRuntimeAuthFailureSourceInput,
): string | null {
  if (input.reportedCredentialRevision !== null) return null;
  const current = input.currentCredential;
  if (
    input.liveIdentity.credentialRevision !== null
    && input.liveIdentity.credentialRevision !== current.credentialRevision
  ) return null;
  if (current.record.kind !== 'oauth') return null;

  const reportedProviderAccountId = normalizeNonEmptyString(input.reportedProviderAccountId);
  const reportedFingerprint = normalizeAccessTokenFingerprint(input.failingAccessTokenFingerprint);
  if (
    !reportedProviderAccountId
    || !reportedFingerprint
    || input.liveIdentity.providerAccountId !== reportedProviderAccountId
    || current.record.oauth.providerAccountId !== reportedProviderAccountId
    || fingerprintAccessToken(current.record.oauth.accessToken) !== reportedFingerprint
  ) return null;

  return current.credentialRevision;
}
