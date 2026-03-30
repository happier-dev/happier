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

function resolveNonHealthCall(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string): RequestInit {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === expectedUrl);
  const init = call?.[1];
  if (!init) {
    throw new Error(`Expected fetch call for ${expectedUrl}`);
  }
  return init;
}

describe('apiConnectedServicesV3', () => {
  it('registers a plaintext credential record at the v3 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { registerConnectedServiceCredentialPlain } = await import('./apiConnectedServicesV3');
    await registerConnectedServiceCredentialPlain(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'token',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: null,
        oauth: null,
        token: { token: 'tok', providerAccountId: null, providerEmail: null, raw: null },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/openai-codex/profiles/work/credential',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/openai-codex/profiles/work/credential');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
  });

  it('treats 404 not found as a successful v3 disconnect (idempotent)', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_credential_not_found' }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { deleteConnectedServiceCredentialV3 } = await import('./apiConnectedServicesV3');
    await expect(deleteConnectedServiceCredentialV3(credentials, { serviceId: 'anthropic', profileId: 'work' })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/anthropic/profiles/work/credential',
      expect.objectContaining({ method: 'DELETE', headers: expect.any(Headers) }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/anthropic/profiles/work/credential');
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
  });

  it('reads a plaintext credential record from the v3 endpoint', async () => {
    mockServerConfig();
    const record = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: null,
      oauth: null,
      token: { token: 'tok', providerAccountId: null, providerEmail: null, raw: null },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ content: { t: 'plain', v: record } }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceCredentialPlain } = await import('./apiConnectedServicesV3');
    const res = await getConnectedServiceCredentialPlain(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(res.content.t).toBe('plain');
    expect(res.content.v).toEqual(expect.objectContaining({ kind: 'token' }));
  });
});
