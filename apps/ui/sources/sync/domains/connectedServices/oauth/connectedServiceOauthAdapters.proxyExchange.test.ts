import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceIdSchema, decodeBase64, encodeBase64, sealBoxBundle } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

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
  it('uses Antigravity OAuth without borrowing the Gemini client or account identity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)).pathname;
      if (url.split('?')[0] === '/v1/features') return new Response(JSON.stringify(createRootLayoutFeaturesResponse({ capabilities: { connectedServices: { credentialDelete: { revisionGuard: false }, credentialWrite: { revisionGuard: false }, supportedServiceIds: [...ConnectedServiceIdSchema.options] } } })), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return new Response('', { status: 200 });
      if (url.endsWith('/v2/connect/antigravity/oauth/exchange') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ bundle: buildBundle({
          publicKeyB64Url: body.publicKey,
          payload: {
            serviceId: 'antigravity', accessToken: 'agy-access', refreshToken: 'agy-refresh',
            idToken: null, scope: 'email', tokenType: 'Bearer', providerEmail: 'selected@example.test',
            providerAccountId: 'selected-google-id', expiresAt: 1234, raw: null,
          },
        }) }), { status: 200 });
      }
      return new Response('', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const supported = await getServerFeaturesSnapshot({ force: true });
    expect(supported.status).toBe('ready');
    const { getConnectedServiceOauthAdapter } = await import('./connectedServiceOauthAdapters');
    const adapter = getConnectedServiceOauthAdapter('antigravity');
    expect(adapter).not.toBeNull();
    const gemini = getConnectedServiceOauthAdapter('gemini')!;
    const authorization = new URL(adapter!.buildAuthorizationUrl({
      redirectUri: adapter!.defaultRedirectUri, state: 'attempt', challenge: 'proof',
    }));
    expect(adapter!.defaultRedirectUri).toBe('https://antigravity.google/oauth-callback');
    expect(authorization.searchParams.get('client_id')).not.toBe(new URL(gemini.buildAuthorizationUrl({
      redirectUri: gemini.defaultRedirectUri, state: 'attempt', challenge: 'proof',
    })).searchParams.get('client_id'));
    expect(authorization.searchParams.get('scope')?.split(' ')).toContain('https://www.googleapis.com/auth/aicode');
    expect(authorization.searchParams.get('state')).toBe('attempt');
    expect(authorization.searchParams.get('code_challenge')).toBe('proof');
    const record = await adapter!.exchangeAuthorizationCodeForRecord({
      credentials, profileId: 'personal', code: 'code', verifier: 'verifier',
      redirectUri: adapter!.defaultRedirectUri, state: 'attempt', now: 1,
    });
    expect(record).toMatchObject({
      serviceId: 'antigravity', profileId: 'personal', kind: 'oauth',
      oauth: { accessToken: 'agy-access', refreshToken: 'agy-refresh',
        providerEmail: 'selected@example.test', providerAccountId: 'selected-google-id' },
    });
  });
  it('exchanges openai-codex codes via proxy and returns an oauth record', async () => {

    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = new URL(String(input)).pathname;
      if (url.split('?')[0] === '/v1/features') return new Response(JSON.stringify(createRootLayoutFeaturesResponse({ capabilities: { connectedServices: { credentialDelete: { revisionGuard: false }, credentialWrite: { revisionGuard: false }, supportedServiceIds: [...ConnectedServiceIdSchema.options] } } })), { status: 200, headers: { 'content-type': 'application/json' } });
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

    const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const supported = await getServerFeaturesSnapshot({ force: true });
    expect(supported.status).toBe('ready');
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

    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = new URL(String(input)).pathname;
      if (url.split('?')[0] === '/v1/features') return new Response(JSON.stringify(createRootLayoutFeaturesResponse({ capabilities: { connectedServices: { credentialDelete: { revisionGuard: false }, credentialWrite: { revisionGuard: false }, supportedServiceIds: [...ConnectedServiceIdSchema.options] } } })), { status: 200, headers: { 'content-type': 'application/json' } });
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

    const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const supported = await getServerFeaturesSnapshot({ force: true });
    expect(supported.status).toBe('ready');
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
