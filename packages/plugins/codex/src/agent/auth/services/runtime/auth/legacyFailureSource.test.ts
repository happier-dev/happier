import { createHash } from 'node:crypto';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveCodexLegacyRuntimeAuthFailureSourceRevision } from './legacyFailureSource.js';

const currentRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const accessToken = 'current-access';
const fingerprint = `sha256:${createHash('sha256').update(accessToken).digest('hex').slice(0, 8)}`;

function currentCredential() {
  return {
    credentialRevision: currentRevision,
    record: buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken,
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_work',
        providerEmail: null,
      },
    }),
  };
}

describe('resolveCodexLegacyRuntimeAuthFailureSourceRevision', () => {
  it('accepts a revision-free predecessor only from matching account and token evidence', () => {
    expect(resolveCodexLegacyRuntimeAuthFailureSourceRevision({
      reportedCredentialRevision: null,
      reportedProviderAccountId: 'acct_work',
      failingAccessTokenFingerprint: fingerprint,
      liveIdentity: { providerAccountId: 'acct_work', credentialRevision: null },
      currentCredential: currentCredential(),
    })).toBe(currentRevision);
  });

  it.each([
    ['provider account', { reportedProviderAccountId: 'acct_other' }],
    ['token fingerprint', { failingAccessTokenFingerprint: 'sha256:deadbeef' }],
    ['live revision', { liveIdentity: { providerAccountId: 'acct_work', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbb' } }],
  ])('rejects mismatched predecessor %s evidence', (_label, override) => {
    expect(resolveCodexLegacyRuntimeAuthFailureSourceRevision({
      reportedCredentialRevision: null,
      reportedProviderAccountId: 'acct_work',
      failingAccessTokenFingerprint: fingerprint,
      liveIdentity: { providerAccountId: 'acct_work', credentialRevision: null },
      currentCredential: currentCredential(),
      ...override,
    })).toBeNull();
  });

  it('rejects revisioned reports because predecessor compatibility is revision-free only', () => {
    expect(resolveCodexLegacyRuntimeAuthFailureSourceRevision({
      reportedCredentialRevision: currentRevision,
      reportedProviderAccountId: null,
      failingAccessTokenFingerprint: null,
      liveIdentity: { providerAccountId: 'acct_work', credentialRevision: null },
      currentCredential: currentCredential(),
    })).toBeNull();
  });
});
