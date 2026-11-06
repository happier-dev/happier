import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

beforeEach(() => {
  // Home activation may acquire reachability/features before the quota reader starts.
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
    if (path === '/v1/features' || path === '/v1/features/authenticated') {
      return Response.json(createRootLayoutFeaturesResponse());
    }
    return Response.json({}, { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

async function activateTestHome() {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
}

describe('apiConnectedServicesQuotasV3', () => {
  it.each(['current', 'predecessor'] as const)('projects retained fields from the stored plaintext quota snapshot (%s)', async shape => {
    await activateTestHome();
    let servedSnapshot = false;
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isServerFetchConnectivityProbeRequest(input)) {
        return Response.json({ ok: true });
      }
      const path = new URL(String(input)).pathname;
      if (path === '/v1/features' || path === '/v1/features/authenticated') {
        return Response.json(createRootLayoutFeaturesResponse());
      }
      if (path !== '/v3/connect/openai-codex/profiles/work/quotas') {
        return Response.json({}, { status: 404 });
      }
      // A rejected snapshot must yield a visible failed assertion rather than
      // leaving the API's retry loop pending for the whole test timeout.
      if (servedSnapshot) return Response.json({}, { status: 404 });
      servedSnapshot = true;
      return Response.json({
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
              retired: true,
              recoveryCredits: { availableCount: 1, retired: true,
                ...(shape === 'predecessor' ? { kind: 'usage_limit_resets' } : {}), credits: [
                { kind: 'quota_reset', status: 'available', retired: true,
                  ...(shape === 'predecessor' ? { providerCreditId: 'credit-a' } : {}) },
              ] },
            },
          },
          // A predecessor can retain a valid snapshot but disable healthy rereads.
          metadata: { fetchedAt: 1, staleAfterMs: 0, status: 'ok', refreshRequestedAt: 1 },
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getConnectedServiceQuotaSnapshotPlain } = await import('./apiConnectedServicesQuotasV3');
    const res = await getConnectedServiceQuotaSnapshotPlain(credentials, { serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.snapshot.serviceId).toBe('openai-codex');
    expect(res?.snapshot.recoveryCredits).toEqual({ availableCount: 1, credits: [{ kind: 'quota_reset', status: 'available',
      ...(shape === 'predecessor' ? { id: 'credit-a' } : {}) }] });
    expect(res?.snapshot).not.toHaveProperty('retired');
    expect(res?.metadata).toEqual({ fetchedAt: 1, staleAfterMs: 0, status: 'ok', refreshRequestedAt: 1 });
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
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url === 'https://api.example.test/v3/connect/openai-codex/profiles/work/quotas') {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return Promise.resolve(Response.json({ ok: true }));
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
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'connect_quotas_not_found' }, { status: 404 });
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
        return Response.json({ ok: true });
      }
      return Response.json({ success: true });
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
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'connect_quotas_not_found' }, { status: 404 });
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
