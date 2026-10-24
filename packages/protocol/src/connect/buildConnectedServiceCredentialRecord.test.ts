import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceOauthCredentialRawMetadata,
} from './buildConnectedServiceCredentialRecord';

function rawFromUntypedCaller(value: unknown): ConnectedServiceOauthCredentialRawMetadata {
  // Boundary fixture: simulates a JS caller bypassing TypeScript excess-property checks.
  return value as ConnectedServiceOauthCredentialRawMetadata;
}

describe('buildConnectedServiceCredentialRecord', () => {
  it('retains the selected Antigravity project while removing arbitrary native credential metadata', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1, serviceId: 'antigravity', profileId: 'personal', kind: 'oauth',
      oauth: {
        accessToken: 'access', refreshToken: 'refresh', idToken: null,
        scope: null, tokenType: 'Bearer', providerAccountId: null, providerEmail: null,
        raw: rawFromUntypedCaller({ project_id: ' selected-project ', client_secret: 'native-secret',
          refresh_token: 'duplicate-refresh', arbitrary: true }),
      },
    });
    expect(record.oauth?.raw).toEqual({ project_id: 'selected-project' });
  });
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

  it('preserves oauth raw provider metadata when provided', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
            organizationUuid: 'organization-id',
          },
        },
      },
    });

    expect(rec.oauth?.raw).toEqual({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'max_20x',
        organizationUuid: 'organization-id',
      },
    });
  });

  it('canonicalizes legacy Claude OAuth raw metadata into the safe provider metadata shape', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
        raw: rawFromUntypedCaller({
          'claude.ai_oauth': {
            subscriptionType: ' team ',
            rateLimitTier: 'team_5x',
            access_token: 'must-not-persist',
          },
        }),
      },
    });

    expect(rec.oauth?.raw).toEqual({
      claudeAiOauth: {
        subscriptionType: 'team',
        rateLimitTier: 'team_5x',
      },
    });
    expect(JSON.stringify(rec.oauth?.raw)).not.toContain('access-token');
  });

  it('strips secret-like and arbitrary oauth raw fields before persistence', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
        raw: rawFromUntypedCaller({
          access_token: 'raw-access-token',
          refresh_token: 'raw-refresh-token',
          id_token: 'raw-id-token',
          authorization: 'Bearer raw-authorization',
          arbitrary: { nested: true },
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
            access_token: 'nested-access-token',
            refresh_token: 'nested-refresh-token',
            id_token: 'nested-id-token',
            authorization: 'Bearer nested-authorization',
            arbitrary: { nested: true },
          },
        }),
      },
    });

    expect(rec.oauth?.raw).toEqual({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'max_20x',
      },
    });
    expect(JSON.stringify(rec.oauth?.raw)).not.toContain('access-token');
    expect(JSON.stringify(rec.oauth?.raw)).not.toContain('refresh-token');
    expect(JSON.stringify(rec.oauth?.raw)).not.toContain('raw-id-token');
    expect(JSON.stringify(rec.oauth?.raw)).not.toContain('authorization');
    expect(JSON.stringify(rec.oauth?.raw)).not.toContain('nested');
  });

  it('drops oauth raw metadata when only secret-like or arbitrary fields are present', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
        raw: rawFromUntypedCaller({
          access_token: 'raw-access-token',
          refresh_token: 'raw-refresh-token',
          id_token: 'raw-id-token',
          authorization: 'Bearer raw-authorization',
          arbitrary: { nested: true },
          claudeAiOauth: {
            access_token: 'nested-access-token',
            arbitrary: { nested: true },
          },
        }),
      },
    });

    expect(rec.oauth?.raw).toBeNull();
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
