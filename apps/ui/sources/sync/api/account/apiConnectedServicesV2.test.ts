import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';

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

const credentials: AuthCredentials = { token: 't', secret: 's' };

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

describe('apiConnectedServicesV2', () => {
	  it('registers a sealed credential record at the v2 endpoint', async () => {
	    mockServerConfig();
	    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
	      ok: true,
	      status: 200,
	      json: async () => ({ success: true }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { registerConnectedServiceCredentialSealed } = await import('./apiConnectedServicesV2');
    await registerConnectedServiceCredentialSealed(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: null, expiresAt: 123 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/profiles/work/credential',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error('Expected fetch init');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
  });

  it('throws HappyError when disconnect receives 404 not found', async () => {
    mockServerConfig();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'connect_credential_not_found' }),
      })) as unknown as typeof fetch,
    );

    const { deleteConnectedServiceCredential } = await import('./apiConnectedServicesV2');
    await expect(deleteConnectedServiceCredential(credentials, { serviceId: 'anthropic', profileId: 'work' })).rejects.toMatchObject({
      name: 'HappyError',
      message: 'connect_credential_not_found',
      status: 404,
      canTryAgain: false,
    } satisfies Partial<HappyError>);
  });

	  it('posts OAuth exchange params to the proxy endpoint and returns bundle', async () => {
	    mockServerConfig();
	    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
	      ok: true,
	      status: 200,
	      json: async () => ({ bundle: 'bundle-1' }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { exchangeConnectedServiceOauthViaProxy } = await import('./apiConnectedServicesV2');
    const result = await exchangeConnectedServiceOauthViaProxy(credentials, {
      serviceId: 'openai-codex',
      publicKey: 'pk-1',
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'state-1',
    });

    expect(result.bundle).toBe('bundle-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/oauth/exchange',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error('Expected fetch init');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual(
      expect.objectContaining({
        publicKey: 'pk-1',
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 'state-1',
      }),
    );
  });
});
