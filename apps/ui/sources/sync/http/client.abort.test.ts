import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

beforeEach(async () => {
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', name: 'HTTP Home' });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('abort-account') });
});

afterEach(async () => {
    vi.useRealTimers();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    const { resetRuntimeFetch } = await import('./client');
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('serverFetch abort handling', () => {
    it('refuses a request before fetch when its admitted server basis is no longer active', async () => {
        const admitted = getActiveServerSnapshot();
        await upsertAndActivateServer({ serverUrl: 'https://server-b.example.test', name: 'Other Home' });
        const fetchMock = vi.fn(async () =>
            new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        await expect(serverFetch(
            '/v3/connect/openai-codex/profiles/work/quotas/refresh',
            {
                method: 'POST',
                headers: { Authorization: 'Bearer token-a' },
            },
            {
                includeAuth: false,
                retry: 'none',
                expectedActiveServer: {
                    serverId: admitted.serverId,
                    generation: admitted.generation,
                },
            },
        )).rejects.toMatchObject({
            name: 'StaleServerGenerationError',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('aborts in-flight requests when abortServerFetches is called', async () => {
        let observeIssued!: () => void;
        const issued = new Promise<void>((resolve) => { observeIssued = resolve; });
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (new URL(String(_input)).pathname === '/v1/auth/ping') return Response.json({});
            return await new Promise<Response>((_resolve, reject) => {
                observeIssued();
                const signal = init?.signal;
                if (!signal) {
                    reject(new Error('missing signal'));
                    return;
                }
                if (signal.aborted) {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                    return;
                }
                signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { abortServerFetches, serverFetch } = await import('./client');
        const pending = serverFetch('/v1/health', undefined, { retry: 'none' });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'ServerFetchAbortedForServerSwitchError' });
        await issued;
        abortServerFetches();
        await rejected;
    });

    it('rejects authenticated absolute-URL requests that target a different host than the active server', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        await expect(serverFetch('https://other.example.test/v1/account/profile')).rejects.toThrow(
            /active server/i,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects cross-origin requests when an explicit Authorization header is provided (even with includeAuth=false)', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        await expect(serverFetch(
            'https://other.example.test/v1/account/profile',
            {
                method: 'GET',
                headers: { Authorization: 'Bearer share-token' },
            },
            { includeAuth: false },
        )).rejects.toThrow(/active server/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects authenticated captured endpoints that are not valid absolute URLs', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { createServerFetchAtEndpoint } = await import('./client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'api.example.test', credentials: { token: createAccountTokenForTests('abort-account') } });
        await expect(request('/v1/account/profile', undefined, { retry: 'none' })).rejects.toBeInstanceOf(Error);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects explicit Authorization headers for captured endpoints that are not valid absolute URLs', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { createServerFetchAtEndpoint } = await import('./client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'api.example.test', credentials: null });
        await expect(request(
            '/v1/account/profile',
            { headers: { Authorization: 'Bearer share-token' } },
            { includeAuth: false, retry: 'none' },
        )).rejects.toBeInstanceOf(Error);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
