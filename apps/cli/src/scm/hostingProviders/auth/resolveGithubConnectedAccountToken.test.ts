import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

describe('resolveGithubConnectedAccountToken', () => {
  it('uses GitHub token credentials for hosting-provider auth', async () => {
    const mod = await import('./resolveGithubConnectedAccountToken').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected GitHub connected account token resolver module');

    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'default',
      kind: 'token',
      token: {
        token: 'ghp_token',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });

    expect(mod.resolveGithubConnectedAccountToken(record)).toEqual({
      kind: 'available',
      token: 'ghp_token',
      profileId: 'default',
      credentialKind: 'token',
      providerAccountId: '42',
      providerEmail: 'octo@example.com',
    });
  });

  it('uses GitHub OAuth access tokens without requiring a refresh token path', async () => {
    const mod = await import('./resolveGithubConnectedAccountToken').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected GitHub connected account token resolver module');

    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 61_000,
      oauth: {
        accessToken: 'oauth-access',
        refreshToken: 'refresh-if-provider-issued-one',
        idToken: null,
        scope: 'repo read:user',
        tokenType: 'Bearer',
        providerAccountId: '42',
        providerEmail: null,
      },
    });

    expect(mod.resolveGithubConnectedAccountToken(record)).toMatchObject({
      kind: 'available',
      token: 'oauth-access',
      profileId: 'default',
      credentialKind: 'oauth',
    });
  });
});
