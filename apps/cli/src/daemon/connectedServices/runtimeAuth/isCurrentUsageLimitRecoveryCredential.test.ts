import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { isCurrentUsageLimitRecoveryCredential } from './isCurrentUsageLimitRecoveryCredential';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit', serviceId: 'claude-subscription', profileId: 'work', groupId: null,
  credentialRevision: 'csr_original', sourceProviderAccountId: 'account-original',
  resetsAtMs: 2000, planType: null, rateLimits: null, source: 'structured_provider_error',
};
const record = buildConnectedServiceCredentialRecord({
  now: 1000, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
  expiresAt: 10000, oauth: { accessToken: 'access', refreshToken: 'refresh', providerAccountId: 'account-original', idToken: null, scope: null, tokenType: null, providerEmail: null },
});

describe('isCurrentUsageLimitRecoveryCredential', () => {
  it('accepts the same quota account after its credential refresh without claiming provider recovery', () => {
    expect(isCurrentUsageLimitRecoveryCredential({ classification, record, credentialRevision: 'csr_refreshed' })).toBe(true);
  });

  it('rejects a changed account even when a supplied revision claims to match', () => {
    expect(isCurrentUsageLimitRecoveryCredential({
      classification: { ...classification, sourceProviderAccountId: 'account-other' }, record,
      credentialRevision: 'csr_original',
    })).toBe(false);
  });

  it('requires the exact original revision when no provider account identity was recorded', () => {
    const withoutAccount = { ...classification, sourceProviderAccountId: null };
    expect(isCurrentUsageLimitRecoveryCredential({ classification: withoutAccount, record, credentialRevision: 'csr_original' })).toBe(true);
    expect(isCurrentUsageLimitRecoveryCredential({ classification: withoutAccount, record, credentialRevision: 'csr_other' })).toBe(false);
    expect(isCurrentUsageLimitRecoveryCredential({ classification: { ...withoutAccount, credentialRevision: null }, record, credentialRevision: null })).toBe(false);
  });

  it.each([{ groupId: 'group' }, { kind: 'auth_expired' as const }])('leaves other recovery policies with their owners (%j)', (patch) => {
    expect(isCurrentUsageLimitRecoveryCredential({ classification: { ...classification, ...patch }, record, credentialRevision: 'csr_original' })).toBe(false);
  });
});
