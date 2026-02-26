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

describe('apiConnectedServicesQuotasV3', () => {
  it('gets the latest plaintext quota snapshot from the v3 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: {
          t: 'plain',
          v: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 2,
            planLabel: null,
            accountLabel: null,
            meters: [],
          },
        },
        metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotPlain } = await import('./apiConnectedServicesQuotasV3');
    const res = await getConnectedServiceQuotaSnapshotPlain(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.serviceId).toBe('openai-codex');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/openai-codex/profiles/work/quotas',
      expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
    );
  });

  it('returns null when the server has no snapshot', async () => {
    mockServerConfig();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'connect_quotas_not_found' }),
      })) as unknown as typeof fetch,
    );

    const { getConnectedServiceQuotaSnapshotPlain } = await import('./apiConnectedServicesQuotasV3');
    const res = await getConnectedServiceQuotaSnapshotPlain(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res).toBeNull();
  });

  it('requests a daemon refresh (best-effort) via the refresh endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { requestConnectedServiceQuotaSnapshotRefreshV3 } = await import('./apiConnectedServicesQuotasV3');
    const ok = await requestConnectedServiceQuotaSnapshotRefreshV3(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/openai-codex/profiles/work/quotas/refresh',
      expect.objectContaining({ method: 'POST', headers: expect.any(Headers) }),
    );
  });

  it('treats missing snapshots as a non-fatal refresh request failure', async () => {
    mockServerConfig();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'connect_quotas_not_found' }),
      })) as unknown as typeof fetch,
    );

    const { requestConnectedServiceQuotaSnapshotRefreshV3 } = await import('./apiConnectedServicesQuotasV3');
    const ok = await requestConnectedServiceQuotaSnapshotRefreshV3(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(ok).toBe(false);
  });
});

