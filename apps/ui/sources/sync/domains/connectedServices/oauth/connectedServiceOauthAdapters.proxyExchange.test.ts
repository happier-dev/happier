import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64, sealBoxBundle } from '@happier-dev/protocol';

vi.mock('@/utils/timing/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/timing/time')>();
  const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
  return {
    ...actual,
    backoff: immediate,
    backoffForever: immediate,
  };
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
