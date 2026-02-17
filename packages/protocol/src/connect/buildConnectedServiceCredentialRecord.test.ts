import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from './buildConnectedServiceCredentialRecord';

describe('buildConnectedServiceCredentialRecord', () => {
  it('builds an oauth record for codex tokens', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_1',
        providerEmail: 'user@example.com',
      },
    });

    expect(rec).toEqual({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_1',
        providerEmail: 'user@example.com',
        raw: null,
      },
      token: null,
    });
  });

  it('builds a token record for setup-token credentials', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: {
        token: 'setup-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    expect(rec.kind).toBe('token');
    expect(rec.serviceId).toBe('anthropic');
    expect(rec.expiresAt).toBeNull();
  });
});

