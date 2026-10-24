import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { buildUpdatedOauthRecord } from './oauthCredentialRecords';

describe('buildUpdatedOauthRecord', () => {
  it('preserves unavailable context evidence but replaces or clears provider-attested context', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null,
        tokenType: 'Bearer', providerAccountId: 'user', providerEmail: null,
        raw: { claudeAiOauth: { subscriptionType: 'max', organizationUuid: 'organization-a' } } },
    });
    if (record.kind !== 'oauth') throw new Error('Expected OAuth fixture');
    const next = { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', idToken: null, expiresAt: 1000 };
    expect(buildUpdatedOauthRecord({ now: 2, record, next }).oauth?.raw).toEqual(record.oauth.raw);
    expect(buildUpdatedOauthRecord({ now: 2, record, next: { ...next,
      raw: { claudeAiOauth: { organizationUuid: 'organization-b' } } } }).oauth?.raw)
      .toEqual({ claudeAiOauth: { organizationUuid: 'organization-b' } });
    expect(buildUpdatedOauthRecord({ now: 2, record, next: { ...next, raw: null } }).oauth?.raw).toBeNull();
  });
});
