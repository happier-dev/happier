import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64, sealBoxBundle, normalizeConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function mockServerConfig() {
  vi.doMock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
      serverId: 'test',
      serverUrl: 'https://api.example.test',
      kind: 'custom',
      generation: 1,
    }),
  }));
}

const credentials = { token: 't', secret: 's' };

function buildBundle(params: Readonly<{ publicKeyB64Url: string; payload: unknown }>): string {
  const recipientPublicKey = decodeBase64(params.publicKeyB64Url, 'base64url');
  const plaintext = new TextEncoder().encode(JSON.stringify(params.payload));
  const bundle = sealBoxBundle({
    plaintext,
    recipientPublicKey,
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
  return encodeBase64(bundle, 'base64url');
}

describe('ConnectedServiceOauthAdapters (proxy exchange)', () => {
  it.each([
    [404, { error: 'Not Found' }],
    // Exact predecessor route validates the closed service enum before entering its handler.
    [400, { statusCode: 400, error: 'Bad Request', message: 'params/serviceId Invalid enum value. Received antigravity' }],
  ])('reports an unsupported Antigravity relay on %s without treating provider failures as version failures', async (status, body) => {
    mockServerConfig();
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return new Response('', { status: 200 });
      return new Response(JSON.stringify(body), { status });
    }));
    const { getConnectedServiceOauthAdapter } = await import('./connectedServiceOauthAdapters');
    const adapter = getConnectedServiceOauthAdapter('antigravity')!;
    await expect(adapter.exchangeAuthorizationCodeForRecord({ credentials, profileId: 'work', code: 'code', verifier: 'verifier', redirectUri: adapter.defaultRedirectUri, state: 'state', now: 1 })).rejects.toThrow('connect_oauth_service_unsupported');
  });
  it('authorizes Antigravity with its native scope and preserves sealed project identity without an ID token', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return new Response('', { status: 200 });
      if (!url.endsWith('/v2/connect/antigravity/oauth/exchange')) return new Response('', { status: 404 });
      const body = JSON.parse(String(init?.body));
      expect(body.verifier).toBe('verifier');
      expect(body.redirectUri).toBe('http://localhost:54545/');
      return new Response(JSON.stringify({ bundle: buildBundle({
        publicKeyB64Url: body.publicKey,
        payload: {
          serviceId: 'antigravity', accessToken: 'access', refreshToken: 'refresh', idToken: null,
          scope: 'https://www.googleapis.com/auth/aicode', tokenType: 'Bearer',
          providerEmail: 'user@example.test', providerAccountId: 'google-account', expiresAt: 1234,
          raw: { antigravity: { clientId: 'native-client', authMethod: 'oauth-personal', projectId: 'verified-project', tierId: 'paid-tier' } },
        },
      }) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getConnectedServiceOauthAdapter } = await import('./connectedServiceOauthAdapters');
    const adapter = getConnectedServiceOauthAdapter('antigravity');
    expect(adapter).not.toBeNull();
    const url = new URL(adapter!.buildAuthorizationUrl({ redirectUri: adapter!.defaultRedirectUri, state: 'state', challenge: 'challenge' }));
    expect(url.searchParams.get('scope')?.split(' ')).toContain('https://www.googleapis.com/auth/aicode');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('state')).toBe('state');
    const record = await adapter!.exchangeAuthorizationCodeForRecord({ credentials, profileId: 'work', code: 'code', verifier: 'verifier', redirectUri: adapter!.defaultRedirectUri, state: 'state', now: 1 });
    expect(record.kind).toBe('oauth');
    if (record.kind !== 'oauth') throw new Error('Expected OAuth');
    expect(record.oauth.idToken).toBeNull();
    expect(record.oauth.providerAccountId).toBe('google-account');
    expect(normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)?.antigravity).toEqual({ clientId: 'native-client', authMethod: 'oauth-personal', projectId: 'verified-project', tierId: 'paid-tier' });
  });
  it('exchanges openai-codex codes via proxy and returns an oauth record', async () => {
    mockServerConfig();

    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v2/connect/openai-codex/oauth/exchange') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const bundle = buildBundle({
          publicKeyB64Url: String(body.publicKey ?? ''),
          payload: {
            serviceId: 'openai-codex',
            accessToken: 'acc',
            refreshToken: 'ref',
            idToken: 'id',
            scope: null,
            tokenType: null,
            providerEmail: null,
            providerAccountId: 'acct_123',
            expiresAt: 1234,
            raw: null,
          },
        });
        return new Response(JSON.stringify({ bundle }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceOauthAdapter } = await import('./connectedServiceOauthAdapters');
    const adapter = getConnectedServiceOauthAdapter('openai-codex');
    expect(adapter).not.toBeNull();

    const record = await adapter!.exchangeAuthorizationCodeForRecord({
      credentials,
      profileId: 'work',
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://localhost/cb',
      state: 'state',
      now: 1,
    });

    expect(record.kind).toBe('oauth');
    expect(record.serviceId).toBe('openai-codex');
    expect(record.profileId).toBe('work');
    if (record.kind === 'oauth') {
      expect(record.oauth.accessToken).toBe('acc');
      expect(record.oauth.refreshToken).toBe('ref');
      expect(record.oauth.idToken).toBe('id');
      expect(record.oauth.providerAccountId).toBe('acct_123');
    }
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v2/connect/openai-codex/oauth/exchange'))).toBe(true);
  });

  it('exchanges gemini codes via proxy and returns an oauth record', async () => {
    mockServerConfig();

    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v2/connect/gemini/oauth/exchange') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const bundle = buildBundle({
          publicKeyB64Url: String(body.publicKey ?? ''),
          payload: {
            serviceId: 'gemini',
            accessToken: 'acc',
            refreshToken: 'ref',
            idToken: null,
            scope: 'email',
            tokenType: 'Bearer',
            providerEmail: null,
            providerAccountId: null,
            expiresAt: 1234,
            raw: null,
          },
        });
        return new Response(JSON.stringify({ bundle }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceOauthAdapter } = await import('./connectedServiceOauthAdapters');
    const adapter = getConnectedServiceOauthAdapter('gemini');
    expect(adapter).not.toBeNull();

    const record = await adapter!.exchangeAuthorizationCodeForRecord({
      credentials,
      profileId: 'work',
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://localhost/cb',
      state: 'state',
      now: 1,
    });

    expect(record.kind).toBe('oauth');
    expect(record.serviceId).toBe('gemini');
    if (record.kind === 'oauth') {
      expect(record.oauth.accessToken).toBe('acc');
      expect(record.oauth.refreshToken).toBe('ref');
      expect(record.oauth.scope).toBe('email');
      expect(record.oauth.tokenType).toBe('Bearer');
    }
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v2/connect/gemini/oauth/exchange'))).toBe(true);
  });
});
