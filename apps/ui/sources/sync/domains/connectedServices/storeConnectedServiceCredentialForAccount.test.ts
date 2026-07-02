import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

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

const legacyCredentials: AuthCredentials = {
  token: 't',
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

function sampleRecord(): ConnectedServiceCredentialRecordV1 {
  const now = Date.now();
  return {
    v: 1,
    serviceId: 'github',
    profileId: 'work',
    kind: 'token',
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    oauth: null,
    token: { token: 'tok', providerAccountId: null, providerEmail: null, raw: null },
  };
}

describe('storeConnectedServiceCredentialForAccount', () => {
  it('stores plaintext credentials via v3 when account mode is plain', async () => {
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
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/github/profiles/work/credential') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.content?.t).toBe('plain');
        expect(body?.content?.v?.kind).toBe('token');
        expect(body?.content?.v?.serviceId).toBe('github');
        expect(body?.reconnect).toEqual({ allowProviderIdentityChange: true });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'github',
      profileId: 'work',
      record: sampleRecord(),
    }, { allowProviderIdentityChange: true });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('/v3/connect/github/profiles/work/credential'))).toBe(true);
  });

  it('stores sealed credentials via v2 when account mode is e2ee', async () => {
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
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v2/connect/github/profiles/work/credential') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.sealed?.format).toBe('account_scoped_v1');
        expect(typeof body?.sealed?.ciphertext).toBe('string');
        expect(body?.metadata?.kind).toBe('token');
        expect(body?.reconnect).toEqual({ allowProviderIdentityChange: true });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'github',
      profileId: 'work',
      record: sampleRecord(),
    }, { allowProviderIdentityChange: true, randomBytes: (length) => new Uint8Array(length).fill(1) });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('/v2/connect/github/profiles/work/credential'))).toBe(true);
  });
});
