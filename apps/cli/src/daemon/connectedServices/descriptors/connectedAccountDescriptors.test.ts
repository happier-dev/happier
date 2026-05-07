import { describe, expect, it } from 'vitest';

describe('connected account descriptors', () => {
  it('describes existing connected service credential families', async () => {
    const mod = await import('./connectedAccountDescriptors').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected connected account descriptor module');

    expect(mod.getConnectedAccountDescriptor('openai-codex')).toMatchObject({
      id: 'openai-codex',
      displayName: 'OpenAI Codex',
      credentialKind: 'oauth',
      oauth: {
        refreshTokenBody: 'form',
      },
    });
    expect(mod.getConnectedAccountDescriptor('openai')).toMatchObject({
      id: 'openai',
      credentialKind: 'token',
    });
    expect(mod.getConnectedAccountDescriptor('anthropic')).toMatchObject({
      id: 'anthropic',
      credentialKind: 'token',
    });
    expect(mod.getConnectedAccountDescriptor('claude-subscription')).toMatchObject({
      id: 'claude-subscription',
      credentialKind: 'oauth',
      oauth: {
        refreshTokenBody: 'json',
      },
    });
    expect(mod.getConnectedAccountDescriptor('gemini')).toMatchObject({
      id: 'gemini',
      credentialKind: 'oauth',
      oauth: {
        refreshTokenBody: 'form',
      },
    });
    expect(mod.getConnectedAccountDescriptor('github')).toMatchObject({
      id: 'github',
      displayName: 'GitHub',
      credentialKind: 'token',
      ui: {
        oauthAddActionModes: [],
      },
    });
  });

  it('resolves OAuth config from descriptor defaults and env overrides', async () => {
    const mod = await import('./connectedAccountDescriptors').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected connected account descriptor module');

    const config = mod.resolveConnectedAccountOauthConfig('gemini', {
      HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_ID: 'env-client',
      HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET: 'env-secret',
      HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL: 'https://example.test/token',
    });

    expect(config).toEqual({
      clientId: 'env-client',
      clientSecret: 'env-secret',
      tokenUrl: 'https://example.test/token',
      refreshTokenBody: 'form',
      scopes: expect.any(Array),
    });
  });
});
