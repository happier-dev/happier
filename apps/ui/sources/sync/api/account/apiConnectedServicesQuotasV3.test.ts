import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

async function activateTestHome() {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'tab' });
}

describe('apiConnectedServicesQuotasV3', () => {
  it('gets the latest plaintext quota snapshot from the v3 endpoint', async () => {
    await activateTestHome();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isServerFetchConnectivityProbeRequest(input)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
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
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotPlain } = await import('./apiConnectedServicesQuotasV3');
    const res = await getConnectedServiceQuotaSnapshotPlain(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.serviceId).toBe('openai-codex');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v3/connect/openai-codex/profiles/work/quotas',
      expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
    );
  });

  it('propagates caller abort signals to quota snapshot requests', async () => {
    await activateTestHome();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (isServerFetchConnectivityProbeRequest(input)) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      if (url === 'https://api.example.test/v3/connect/openai-codex/profiles/work/quotas') {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotPlain } = await import('./apiConnectedServicesQuotasV3');
    const controller = new AbortController();
    const pending = getConnectedServiceQuotaSnapshotPlain(
      credentials,
      { serviceId: 'openai-codex', profileId: 'work' },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();
    await rejected;

    expect(requestSignal?.aborted).toBe(true);
  });

  it('returns null when the server has no snapshot', async () => {
    await activateTestHome();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isServerFetchConnectivityProbeRequest(input)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_quotas_not_found' }) };
    });
    vi.stubGlobal(
      'fetch',
      fetchMock as unknown as typeof fetch,
    );

    const { getConnectedServiceQuotaSnapshotPlain } = await import('./apiConnectedServicesQuotasV3');
    const res = await getConnectedServiceQuotaSnapshotPlain(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res).toBeNull();
  });

  it('requests a daemon refresh (best-effort) via the refresh endpoint', async () => {
    await activateTestHome();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isServerFetchConnectivityProbeRequest(input)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
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
    await activateTestHome();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isServerFetchConnectivityProbeRequest(input)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'connect_quotas_not_found' }) };
    });
    vi.stubGlobal(
      'fetch',
      fetchMock as unknown as typeof fetch,
    );

    const { requestConnectedServiceQuotaSnapshotRefreshV3 } = await import('./apiConnectedServicesQuotasV3');
    const ok = await requestConnectedServiceQuotaSnapshotRefreshV3(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(ok).toBe(false);
  });
});
