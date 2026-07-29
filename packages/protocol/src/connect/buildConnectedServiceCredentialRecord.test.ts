import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceOauthCredentialRawMetadata,
} from './buildConnectedServiceCredentialRecord';

function rawFromUntypedCaller(value: unknown): ConnectedServiceOauthCredentialRawMetadata {
  // Boundary fixture: simulates a JS caller or historical stored shape bypassing TypeScript excess-property checks.
  return value as ConnectedServiceOauthCredentialRawMetadata;
}

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

  it('preserves sanitized provider-owned oauth raw metadata', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
        raw: {
          claudeAiOauth: {
            subscriptionType: ' max ',
            rateLimitTier: 'max_20x',
            accessToken: 'must-not-persist',
          },
          unrelated: {
            value: 'must-not-persist',
          },
        },
      },
    });

    expect(rec.kind).toBe('oauth');
    if (rec.kind === 'oauth') {
      expect(rec.oauth.raw).toEqual({
        claudeAiOauth: {
          subscriptionType: 'max',
          rateLimitTier: 'max_20x',
        },
      });
    }
  });

  it('canonicalizes legacy Claude OAuth raw metadata into the safe provider metadata shape', () => {
    const now = 1700000000000;
    const rec = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
        raw: rawFromUntypedCaller({
          'claude.ai_oauth': {
            subscriptionType: ' team ',
            rateLimitTier: 'team_5x',
            accessToken: 'must-not-persist',
          },
        }),
      },
    });

    expect(rec.kind).toBe('oauth');
    if (rec.kind === 'oauth') {
      expect(rec.oauth.raw).toEqual({
        claudeAiOauth: {
          subscriptionType: 'team',
          rateLimitTier: 'team_5x',
        },
      });
    }
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
