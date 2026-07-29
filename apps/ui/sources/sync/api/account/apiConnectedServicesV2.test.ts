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

describe('apiConnectedServicesV2 legacy read compatibility', () => {
  it('fetches a sealed credential record without exposing a write API', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1', ciphertext: 'cipher-1' },
          metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: null, expiresAt: 123 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = await import('./apiConnectedServicesV2');
    const result = await api.getConnectedServiceCredentialSealed(credentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result).toMatchObject({
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      sealed: { format: 'account_scoped_v1', ciphertext: 'cipher-1' },
    });
    expect(api).not.toHaveProperty('registerConnectedServiceCredentialSealed');
    expect(api).not.toHaveProperty('exchangeConnectedServiceOauthViaProxy');
    expect(api).not.toHaveProperty('startOpenAiCodexDeviceAuthViaProxy');
  });

  it('classifies the released unfenced read shape explicitly', async () => {
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
});
