import { describe, expect, it } from 'vitest';

describe('buildConnectedAccountOauthCredentialRecord', () => {
  it('maps Codex OAuth payloads through the connected account descriptor', async () => {
    const mod = await import('./buildConnectedAccountCredentialRecord').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected connected account credential record builder module');

    const record = mod.buildConnectedAccountOauthCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      payload: {
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: 'id',
        expires_in: 60,
        account_id: 'acct_1',
      },
    });

    expect(record).toMatchObject({
      serviceId: 'openai-codex',
      kind: 'oauth',
      expiresAt: 61_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        providerAccountId: 'acct_1',
        providerEmail: null,
      },
    });
  });

  it('maps Claude OAuth account metadata through the connected account descriptor', async () => {
    const mod = await import('./buildConnectedAccountCredentialRecord').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected connected account credential record builder module');

    const record = mod.buildConnectedAccountOauthCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'default',
      payload: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 60,
        scope: 'user:inference',
        token_type: 'Bearer',
        account: {
          uuid: 'acct_2',
          email_address: 'user@example.com',
        },
      },
    });

    if (!record.oauth) throw new Error('expected OAuth credential record');
    expect(record.oauth.providerAccountId).toBe('acct_2');
    expect(record.oauth.providerEmail).toBe('user@example.com');
    expect(record.oauth.scope).toBe('user:inference');
    expect(record.oauth.tokenType).toBe('Bearer');
  });
});
