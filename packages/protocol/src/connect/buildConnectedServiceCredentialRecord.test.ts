import { describe, expect, it } from 'vitest';
import { ConnectedServiceCredentialRecordV1Schema } from './connectedServiceSchemas';

import {
  buildConnectedServiceCredentialRecord,
  normalizeConnectedServiceOauthCredentialRawMetadata,
  type ConnectedServiceOauthCredentialRawMetadata,
} from './buildConnectedServiceCredentialRecord';

function rawFromUntypedCaller(value: unknown): ConnectedServiceOauthCredentialRawMetadata {
  // Boundary fixture: simulates a JS caller bypassing TypeScript excess-property checks.
  return value as ConnectedServiceOauthCredentialRawMetadata;
}

describe('buildConnectedServiceCredentialRecord', () => {
  it('preserves only verified Antigravity metadata through normalization and credential serialization', () => {
    const metadata = {
      antigravity: {
        clientId: 'native-client', authMethod: 'oauth-personal', projectId: ' project-a ', tierId: 'paid-tier',
        access_token: 'must-not-persist', scopes: ['fabricated-scope'], arbitrary: true,
      },
    };
    const safe = { antigravity: { clientId: 'native-client', authMethod: 'oauth-personal', projectId: 'project-a', tierId: 'paid-tier' } };
    expect(normalizeConnectedServiceOauthCredentialRawMetadata(metadata)).toEqual(safe);
    const record = buildConnectedServiceCredentialRecord({
      now: 1700000000000, serviceId: 'antigravity', profileId: 'work', kind: 'oauth', expiresAt: 1700003600000,
      oauth: {
        accessToken: 'at', refreshToken: 'rt', idToken: null, scope: 'granted-scope', tokenType: 'Bearer',
        providerAccountId: 'account-a', providerEmail: 'a@example.test', raw: rawFromUntypedCaller(metadata),
      },
    });
    const restored = ConnectedServiceCredentialRecordV1Schema.parse(JSON.parse(JSON.stringify(record)));
    expect(restored.oauth.raw).toEqual(safe);
    expect(restored.oauth.scope).toBe('granted-scope');
    expect(restored.oauth.idToken).toBeNull();
    expect(restored.expiresAt).toBe(1700003600000);
    const directWrite = ConnectedServiceCredentialRecordV1Schema.parse({ ...record, oauth: { ...record.oauth, raw: metadata } });
    expect(directWrite.oauth?.raw).toEqual(safe);
  });

  it('rejects unsupported Antigravity auth metadata instead of persisting it', () => {
    expect(() => normalizeConnectedServiceOauthCredentialRawMetadata({
      antigravity: { clientId: 'native-client', authMethod: 'oauth-business' },
    })).toThrow();
  });

  it('rejects token credentials and missing issuer metadata for Antigravity profiles', () => {
    expect(() => buildConnectedServiceCredentialRecord({
      now: 1, serviceId: 'antigravity', profileId: 'work', kind: 'token',
      token: { token: 'key', providerAccountId: null, providerEmail: null },
    })).toThrow();
    expect(() => buildConnectedServiceCredentialRecord({
      now: 1, serviceId: 'antigravity', profileId: 'work', kind: 'oauth',
      oauth: { accessToken: 'at', refreshToken: 'rt', idToken: null, scope: null, tokenType: null,
        providerAccountId: null, providerEmail: null },
    })).toThrow();
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
          },
        },
      },
    });

    expect(rec.oauth?.raw).toEqual({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'max_20x',
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
