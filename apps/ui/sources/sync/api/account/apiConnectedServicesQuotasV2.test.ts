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

describe('apiConnectedServicesQuotasV2', () => {
  it('gets the latest sealed quota snapshot from the v2 endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: 'cipher' },
        metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotSealed } = await import('./apiConnectedServicesQuotasV2');
    const res = await getConnectedServiceQuotaSnapshotSealed(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.sealed?.ciphertext).toBe('cipher');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/profiles/work/quotas',
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

    const { getConnectedServiceQuotaSnapshotSealed } = await import('./apiConnectedServicesQuotasV2');
    const res = await getConnectedServiceQuotaSnapshotSealed(credentials, { serviceId: 'openai-codex', profileId: 'work' });
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

    const { requestConnectedServiceQuotaSnapshotRefresh } = await import('./apiConnectedServicesQuotasV2');
    const ok = await requestConnectedServiceQuotaSnapshotRefresh(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/profiles/work/quotas/refresh',
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

    const { requestConnectedServiceQuotaSnapshotRefresh } = await import('./apiConnectedServicesQuotasV2');
    const ok = await requestConnectedServiceQuotaSnapshotRefresh(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(ok).toBe(false);
  });
});
