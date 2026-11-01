import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { isCurrentUsageLimitRecoveryCredential, isCurrentUsageLimitRecoverySource } from './isCurrentUsageLimitRecoveryCredential';
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
  it('does not carry an unknown organization across a credential rotation', () => {
    expect(isCurrentUsageLimitRecoveryCredential({ classification, record, credentialRevision: 'csr_refreshed' })).toBe(false);
    expect(isCurrentUsageLimitRecoveryCredential({ classification, record, credentialRevision: 'csr_original' })).toBe(true);
  });

  it('keeps account-only provider recovery valid across token rotation', () => {
    if (record.kind !== 'oauth') throw new Error('expected OAuth fixture');
    const accountOnlyRecord = buildConnectedServiceCredentialRecord({
      now: 1000, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: 10000,
      oauth: { ...record.oauth, raw: null },
    });
    expect(isCurrentUsageLimitRecoveryCredential({
      classification: { ...classification, serviceId: 'openai-codex' },
      record: accountOnlyRecord, credentialRevision: 'csr_refreshed',
    })).toBe(true);
  });

  it('rejects a changed account even when a supplied revision claims to match', () => {
    expect(isCurrentUsageLimitRecoveryCredential({
      classification: { ...classification, sourceProviderAccountId: 'account-other' }, record,
      credentialRevision: 'csr_original',
    })).toBe(false);
  });

  it('rejects a different or unattested organization despite the same provider user and revision', () => {
    expect(isCurrentUsageLimitRecoveryCredential({
      classification: { ...classification, sourceProviderOrganizationId: 'org-original' }, record,
      credentialRevision: 'csr_original',
    })).toBe(false);
  });

  it('preserves attested quota context across token rotation and rejects organization substitution', () => {
    if (record.kind !== 'oauth') throw new Error('expected OAuth fixture');
    const organizationRecord = buildConnectedServiceCredentialRecord({
      now: 1000, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth', expiresAt: 10000,
      oauth: { ...record.oauth, raw: { claudeAiOauth: { organizationUuid: 'org-original' } } },
    });
    expect(isCurrentUsageLimitRecoveryCredential({
      classification: { ...classification, sourceProviderOrganizationId: 'org-original' },
      record: organizationRecord, credentialRevision: 'csr_refreshed',
    })).toBe(true);
    expect(isCurrentUsageLimitRecoveryCredential({
      classification: { ...classification, sourceProviderOrganizationId: 'org-other' },
      record: organizationRecord, credentialRevision: 'csr_original',
    })).toBe(false);
    expect(isCurrentUsageLimitRecoveryCredential({ classification,
      record: organizationRecord, credentialRevision: 'csr_refreshed',
    })).toBe(false);
    expect(isCurrentUsageLimitRecoveryCredential({ classification,
      record: organizationRecord, credentialRevision: 'csr_original',
    })).toBe(true);
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
  it.each(['credential', 'live authorization'])('rejects cancellation during asynchronous %s qualification', async (phase) => {
    let current = true;
    expect(await isCurrentUsageLimitRecoverySource({ classification,
      isCurrentRecovery: () => current,
      resolveCredential: async () => {
        if (phase === 'credential') current = false;
        return { record, credentialRevision: 'csr_original' };
      },
      authorizeLiveSource: async () => { current = false; return true; },
    })).toBe(false);
  });

});
