import { describe, expect, it } from 'vitest';

import {
  buildConnectedAccountCredentialRecordFromTokenInput,
  buildConnectedServiceCredentialRecord,
} from './buildConnectedServiceCredentialRecord';

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

  it('builds a GitHub PAT as a token record without OAuth fields', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'github_pat_123',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(rec).toMatchObject({
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      expiresAt: null,
      token: {
        token: 'github_pat_123',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    expect('oauth' in rec).toBe(false);
    expect('refreshToken' in (rec.token ?? {})).toBe(false);
  });
});

describe('buildConnectedAccountCredentialRecordFromTokenInput', () => {
  it('stores GitHub PAT input as a descriptor-checked token credential', () => {
    const now = 1700000000000;
    const rec = buildConnectedAccountCredentialRecordFromTokenInput({
      now,
      serviceId: 'github',
      profileId: 'work',
      token: '  github_pat_123  ',
    });

    expect(rec).toMatchObject({
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      expiresAt: null,
      token: {
        token: 'github_pat_123',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    expect('oauth' in rec).toBe(false);
  });

  it('stores Bitbucket API token input with descriptor-required email or username metadata', () => {
    const now = 1700000000000;
    const rec = buildConnectedAccountCredentialRecordFromTokenInput({
      now,
      serviceId: 'bitbucket',
      profileId: 'work',
      token: '  bitbucket-api-token  ',
      providerEmail: '  dev@example.com  ',
      providerAccountId: '  dev@example.com  ',
    });

    expect(rec).toMatchObject({
      serviceId: 'bitbucket',
      profileId: 'work',
      kind: 'token',
      expiresAt: null,
      token: {
        token: 'bitbucket-api-token',
        providerAccountId: 'dev@example.com',
        providerEmail: 'dev@example.com',
      },
    });
    expect('oauth' in rec).toBe(false);
  });

  it('rejects Bitbucket API token input when email or username metadata is missing', () => {
    expect(() => buildConnectedAccountCredentialRecordFromTokenInput({
      now: 1700000000000,
      serviceId: 'bitbucket',
      profileId: 'work',
      token: 'bitbucket-api-token',
    })).toThrow(/Missing Bitbucket email or username/);
  });

  it('rejects token input for descriptor services that do not support tokens', () => {
    expect(() => buildConnectedAccountCredentialRecordFromTokenInput({
      now: 1700000000000,
      serviceId: 'openai-codex',
      profileId: 'work',
      token: 'token',
    })).toThrow(/does not support token credentials/);
  });
});
