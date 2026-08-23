import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

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

function resolveNonHealthCall(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string): RequestInit {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === expectedUrl);
  const init = call?.[1];
  if (!init) {
    throw new Error(`Expected fetch call for ${expectedUrl}`);
  }
  return init;
}

describe('apiConnectedServicesV2', () => {
	  it('registers a sealed credential record at the v2 endpoint', async () => {
	    mockServerConfig();
	    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }) };
      });
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { registerConnectedServiceCredentialSealed } = await import('./apiConnectedServicesV2');
    const result = await registerConnectedServiceCredentialSealed(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: null, expiresAt: 123 },
      expectedCredentialRevision: null,
    });

    expect(result).toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/profiles/work/credential',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v2/connect/openai-codex/profiles/work/credential');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ expectedCredentialRevision: null }));
  });

  it('fetches a sealed credential record from the v2 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1', ciphertext: 'cipher-1' },
          metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: null, expiresAt: 123 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceCredentialSealed } = await import('./apiConnectedServicesV2');
    const result = await getConnectedServiceCredentialSealed(credentials, { serviceId: 'openai-codex', profileId: 'work' });

    expect(result.sealed.format).toBe('account_scoped_v1');
    expect(result.credentialRevision).toBe('csr_1123456789ABCDEFGHJKMNPQRS');
    expect(result.sealed.ciphertext).toBe('cipher-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/profiles/work/credential',
      expect.objectContaining({
        method: 'GET',
        headers: expect.any(Headers),
      }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v2/connect/openai-codex/profiles/work/credential');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
  });

  it('classifies exact server-v0.2.1 sealed responses as legacy and unfenced', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sealed: { format: 'account_scoped_v1', ciphertext: 'cipher-1' },
          metadata: { kind: 'token' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceCredentialSealed } = await import('./apiConnectedServicesV2');
    await expect(getConnectedServiceCredentialSealed(credentials, {
      serviceId: 'github',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    }));
  });

  it.each([
    ['unsupported sealed format', { format: 'future_format', ciphertext: 'cipher-1' }, { kind: 'oauth' }],
    ['invalid metadata kind', { format: 'account_scoped_v1', ciphertext: 'cipher-1' }, { kind: 'future_kind' }],
  ])('rejects %s in a sealed credential response', async (_case, sealed, metadata) => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
          sealed,
          metadata,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceCredentialSealed } = await import('./apiConnectedServicesV2');
    await expect(getConnectedServiceCredentialSealed(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'HappyError',
      message: 'invalid response',
      canTryAgain: false,
      status: 200,
      kind: 'server',
    });
  });

  it('treats 404 not found as a successful disconnect (idempotent)', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_credential_not_found' }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { deleteConnectedServiceCredential } = await import('./apiConnectedServicesV2');
    await expect(deleteConnectedServiceCredential(credentials, {
      serviceId: 'anthropic',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/anthropic/profiles/work/credential?expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
      expect.objectContaining({ method: 'DELETE', headers: expect.any(Headers) }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v2/connect/anthropic/profiles/work/credential?expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS');
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
  });

  it('sends the cleanup flag when deleting a credential that should be removed from auth groups', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { deleteConnectedServiceCredential } = await import('./apiConnectedServicesV2');
    await deleteConnectedServiceCredential(credentials, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      cleanupGroupReferences: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/claude-subscription/profiles/work/credential?cleanupGroupReferences=true&expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
      expect.objectContaining({ method: 'DELETE', headers: expect.any(Headers) }),
    );
  });

  it('posts OAuth exchange params to the proxy endpoint and returns bundle', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ bundle: 'bundle-1' }) };
    });
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
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v2/connect/openai-codex/oauth/exchange');
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

  it('starts OpenAI Codex device auth via the v2 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          transactionId: 'csda-1',
          userCode: 'ABCD-EFGH',
          intervalMs: 5000,
          verificationUrl: 'https://auth.openai.com/codex/device',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { startOpenAiCodexDeviceAuthViaProxy } = await import('./apiConnectedServicesV2');
    const res = await startOpenAiCodexDeviceAuthViaProxy(credentials, { publicKey: 'pk-1' });

    expect(res.userCode).toBe('ABCD-EFGH');
    expect(res).toEqual(expect.objectContaining({ kind: 'transaction', transactionId: 'csda-1' }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/oauth/device/start',
      expect.objectContaining({ method: 'POST', headers: expect.any(Headers) }),
    );
  });

  it('polls OpenAI Codex device auth via the v2 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'pending', retryAfterMs: 8000 }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { pollOpenAiCodexDeviceAuthViaProxy } = await import('./apiConnectedServicesV2');
    const res = await pollOpenAiCodexDeviceAuthViaProxy(credentials, {
      auth: {
        kind: 'transaction',
        transactionId: 'csda-1',
        userCode: 'ABCD-EFGH',
        intervalMs: 5000,
        verificationUrl: 'https://auth.openai.com/codex/device',
      },
      publicKey: 'pk-1',
    });

    expect(res.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/oauth/device/poll',
      expect.objectContaining({ method: 'POST', headers: expect.any(Headers) }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v2/connect/openai-codex/oauth/device/poll');
    expect(JSON.parse(String(init.body))).toEqual({ transactionId: 'csda-1' });
  });

  it('uses the exact released 0.2.1 deviceAuthId poll shape when the start response is legacy', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/oauth/device/start')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deviceAuthId: 'released-device-1',
            userCode: 'ABCD-EFGH',
            intervalMs: 5000,
            verificationUrl: 'https://auth.openai.com/codex/device',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'pending', retryAfterMs: 5000 }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const {
      pollOpenAiCodexDeviceAuthViaProxy,
      startOpenAiCodexDeviceAuthViaProxy,
    } = await import('./apiConnectedServicesV2');
    const started = await startOpenAiCodexDeviceAuthViaProxy(credentials, { publicKey: 'pk-1' });
    await pollOpenAiCodexDeviceAuthViaProxy(credentials, { auth: started, publicKey: 'pk-1' });

    expect(started).toEqual(expect.objectContaining({
      kind: 'released_v0_2_1',
      deviceAuthId: 'released-device-1',
    }));
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v2/connect/openai-codex/oauth/device/poll');
    expect(JSON.parse(String(init.body))).toEqual({
      publicKey: 'pk-1',
      deviceAuthId: 'released-device-1',
      userCode: 'ABCD-EFGH',
      intervalMs: 5000,
    });
  });
});
