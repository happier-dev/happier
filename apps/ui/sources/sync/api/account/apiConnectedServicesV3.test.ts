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

describe('apiConnectedServicesV3', () => {
  it('registers a plaintext credential record at the v3 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));
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
    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error('Expected fetch init');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
  });

  it('throws HappyError when v3 disconnect receives 404 not found', async () => {
    mockServerConfig();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'connect_credential_not_found' }),
      })) as unknown as typeof fetch,
    );

    const { deleteConnectedServiceCredentialV3 } = await import('./apiConnectedServicesV3');
    await expect(deleteConnectedServiceCredentialV3(credentials, { serviceId: 'anthropic', profileId: 'work' })).rejects.toMatchObject({
      name: 'HappyError',
      message: 'connect_credential_not_found',
      status: 404,
      canTryAgain: false,
    } satisfies Partial<HappyError>);
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ content: { t: 'plain', v: record } }),
    }));
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
