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
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sealed: { format: 'account_scoped_v1', ciphertext: 'cipher' },
          metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotSealed } = await import('./apiConnectedServicesQuotasV2');
    const res = await getConnectedServiceQuotaSnapshotSealed(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.sealed?.ciphertext).toBe('cipher');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v2/connect/openai-codex/profiles/work/quotas',
      expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
    );
  });

  it('propagates caller abort signals to quota snapshot requests', async () => {
    mockServerConfig();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      if (url === 'https://api.example.test/v2/connect/openai-codex/profiles/work/quotas') {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotSealed } = await import('./apiConnectedServicesQuotasV2');
    const controller = new AbortController();
    void (getConnectedServiceQuotaSnapshotSealed as (
      creds: AuthCredentials,
      params: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>[1],
      opts: Readonly<{ signal?: AbortSignal }>,
    ) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>)(
      credentials,
      { serviceId: 'openai-codex', profileId: 'work' },
      { signal: controller.signal },
    ).catch(() => undefined);

    for (let i = 0; i < 10 && !requestSignal; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestSignal?.aborted).toBe(true);
  });

  it('returns null when the server has no snapshot', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_quotas_not_found' }) };
    });
    vi.stubGlobal(
      'fetch',
      fetchMock as unknown as typeof fetch,
    );

    const { getConnectedServiceQuotaSnapshotSealed } = await import('./apiConnectedServicesQuotasV2');
    const res = await getConnectedServiceQuotaSnapshotSealed(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res).toBeNull();
  });

  it('requests a daemon refresh (best-effort) via the refresh endpoint', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
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
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://api.example.test/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_quotas_not_found' }) };
    });
    vi.stubGlobal(
      'fetch',
      fetchMock as unknown as typeof fetch,
    );

    const { requestConnectedServiceQuotaSnapshotRefresh } = await import('./apiConnectedServicesQuotasV2');
    const ok = await requestConnectedServiceQuotaSnapshotRefresh(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(ok).toBe(false);
  });
});
