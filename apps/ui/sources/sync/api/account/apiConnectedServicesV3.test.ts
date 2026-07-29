import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/utils/timing/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/timing/time')>();
  const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
  return { ...actual, backoff: immediate, backoffForever: immediate };
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

describe('apiConnectedServicesV3 legacy read compatibility', () => {
  it('reads a plaintext credential record without exposing a write API', async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          content: { t: 'plain', v: record },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = await import('./apiConnectedServicesV3');
    const result = await api.getConnectedServiceCredentialPlain(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.content).toEqual({ t: 'plain', v: record });
    expect(result.credentialRevision).toBe('csr_0123456789ABCDEFGHJKMNPQRS');
    expect(api).not.toHaveProperty('registerConnectedServiceCredentialPlain');
  });
});
