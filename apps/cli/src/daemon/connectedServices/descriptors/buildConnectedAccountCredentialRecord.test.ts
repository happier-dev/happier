import { describe, expect, it } from 'vitest';

import {
  buildConnectedAccountCredentialRecordFromOauthPayload,
  buildConnectedAccountCredentialRecordFromTokenInput,
} from './buildConnectedAccountCredentialRecord';

describe('buildConnectedAccountCredentialRecordFromOauthPayload', () => {
  it('maps Codex account id and absolute expiry from descriptor metadata', () => {
    const now = 1700000000000;
    const record = buildConnectedAccountCredentialRecordFromOauthPayload({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      payload: {
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: 'identity',
        account_id: 'account-id',
        expires_at: now + 60_000,
        expires_in: 10,
      },
    });

    expect(record.expiresAt).toBe(now + 60_000);
    expect(record.oauth).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'identity',
      providerAccountId: 'account-id',
      providerEmail: null,
    });
  });

  it('maps Claude nested account metadata from descriptor metadata', () => {
    const now = 1700000000000;
    const record = buildConnectedAccountCredentialRecordFromOauthPayload({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      payload: {
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'user:profile',
        token_type: 'Bearer',
        expires_in: 120,
        account: {
          uuid: 'account-uuid',
          email_address: 'user@example.com',
        },
        uuid: 'wrong-top-level-uuid',
        email_address: 'wrong-top-level@example.com',
      },
    });

    expect(record.expiresAt).toBe(now + 120_000);
    expect(record.oauth).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: null,
      scope: 'user:profile',
      tokenType: 'Bearer',
      providerAccountId: 'account-uuid',
      providerEmail: 'user@example.com',
    });
  });

  it('maps Gemini identity token and relative expiry from descriptor metadata', () => {
    const now = 1700000000000;
    const record = buildConnectedAccountCredentialRecordFromOauthPayload({
      now,
      serviceId: 'gemini',
      profileId: 'work',
      payload: {
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: 'identity',
        scope: 'cloud profile',
        token_type: 'Bearer',
        expires_in: 45,
      },
    });

    expect(record.expiresAt).toBe(now + 45_000);
    expect(record.oauth).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'identity',
      scope: 'cloud profile',
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    });
  });
});

describe('buildConnectedAccountCredentialRecordFromTokenInput', () => {
  it('stores GitHub PAT input as a token credential with no OAuth fields', () => {
    const now = 1700000000000;
    const record = buildConnectedAccountCredentialRecordFromTokenInput({
      now,
      serviceId: 'github',
      profileId: 'work',
      token: '  github_pat_123  ',
    });

    expect(record).toMatchObject({
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
    expect('oauth' in record).toBe(false);
  });

  it('rejects blank token input before building a credential record', () => {
    expect(() => buildConnectedAccountCredentialRecordFromTokenInput({
      now: 1700000000000,
      serviceId: 'github',
      profileId: 'work',
      token: '   ',
    })).toThrow(/Missing personal access token/);
  });
});
