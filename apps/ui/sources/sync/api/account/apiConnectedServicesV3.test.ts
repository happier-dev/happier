import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createSuccessfulServerReachabilityProbeResponse, isServerReachabilityProbeRequest } from '@/dev/testkit';

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
      if (isServerReachabilityProbeRequest(url)) {
        return createSuccessfulServerReachabilityProbeResponse();
      }
      return { ok: true, status: 200, json: async () => ({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { registerConnectedServiceCredentialPlain } = await import('./apiConnectedServicesV3');
    const result = await registerConnectedServiceCredentialPlain(credentials, {
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
      revisionSemantics: 'revisioned',
      expectedCredentialRevision: null,
    });

    expect(result).toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
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
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ expectedCredentialRevision: null }));
  });

  it('classifies exact server-v0.2.1 mutation success as legacy and unfenced', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isServerReachabilityProbeRequest(input)) {
        return createSuccessfulServerReachabilityProbeResponse();
      }
      // Exact strict body accepted by server-v0.2.1 commit
      // 4913c1e533c872a0712ba1c25b3104fd470aacc2.
      expect(JSON.parse(String(init?.body))).toEqual({
        content: {
          t: 'plain',
          v: {
            v: 1,
            serviceId: 'github',
            profileId: 'work',
            kind: 'token',
            createdAt: 1,
            updatedAt: 1,
            expiresAt: null,
            oauth: null,
            token: { token: 'token', providerAccountId: null, providerEmail: null, raw: null },
          },
        },
      });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { registerConnectedServiceCredentialPlain } = await import('./apiConnectedServicesV3');
    await expect(registerConnectedServiceCredentialPlain(credentials, {
      serviceId: 'github',
      profileId: 'work',
      record: {
        v: 1,
        serviceId: 'github',
        profileId: 'work',
        kind: 'token',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
        oauth: null,
        token: { token: 'token', providerAccountId: null, providerEmail: null, raw: null },
      },
      revisionSemantics: 'legacy_unfenced',
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    });
  });

  it('treats 404 not found as a successful v3 disconnect (idempotent)', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (isServerReachabilityProbeRequest(url)) {
        return createSuccessfulServerReachabilityProbeResponse();
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_credential_not_found' }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { deleteConnectedServiceCredentialV3 } = await import('./apiConnectedServicesV3');
    await expect(deleteConnectedServiceCredentialV3(credentials, {
      serviceId: 'anthropic',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/anthropic/profiles/work/credential?expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
      expect.objectContaining({ method: 'DELETE', headers: expect.any(Headers) }),
    );
    const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/anthropic/profiles/work/credential?expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS');
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
  });

  it('sends the cleanup flag when deleting a plaintext credential that should be removed from auth groups', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (isServerReachabilityProbeRequest(url)) {
        return createSuccessfulServerReachabilityProbeResponse();
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { deleteConnectedServiceCredentialV3 } = await import('./apiConnectedServicesV3');
    await deleteConnectedServiceCredentialV3(credentials, {
      serviceId: 'claude-subscription',
      profileId: 'work',
      cleanupGroupReferences: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/claude-subscription/profiles/work/credential?cleanupGroupReferences=true&expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
      expect.objectContaining({ method: 'DELETE', headers: expect.any(Headers) }),
    );
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
      if (isServerReachabilityProbeRequest(url)) {
        return createSuccessfulServerReachabilityProbeResponse();
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS', content: { t: 'plain', v: record } }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceCredentialPlain } = await import('./apiConnectedServicesV3');
    const res = await getConnectedServiceCredentialPlain(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(res.content.t).toBe('plain');
    expect(res.credentialRevision).toBe('csr_1123456789ABCDEFGHJKMNPQRS');
    expect(res.content.v).toEqual(expect.objectContaining({ kind: 'token' }));
  });

  it('rejects a plaintext credential whose embedded binding differs from the requested route', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (isServerReachabilityProbeRequest(input)) {
        return createSuccessfulServerReachabilityProbeResponse();
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
          content: {
            t: 'plain',
            v: {
              v: 1,
              serviceId: 'anthropic',
              profileId: 'work',
              kind: 'token',
              createdAt: 1_000,
              updatedAt: 1_000,
              expiresAt: null,
              oauth: null,
              token: { token: 'tok', providerAccountId: null, providerEmail: null, raw: null },
            },
          },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceCredentialPlain } = await import('./apiConnectedServicesV3');
    await expect(getConnectedServiceCredentialPlain(credentials, {
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
});
