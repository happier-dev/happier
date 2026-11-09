import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTokenStorageModuleMock } from '@/dev/testkit';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

const CANONICAL_URL = 'https://home.example.test';
const HOME_ENDPOINT_ID = 'a'.repeat(64);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

function createCarrier(): Readonly<{
    carrier: HomeCarrier;
    calls: Array<Readonly<{ url: string; authorization: string | null }>>;
}> {
    const calls: Array<Readonly<{ url: string; authorization: string | null }>> = [];
    return {
        calls,
        carrier: {
            endpointId: HOME_ENDPOINT_ID,
            readObservedPath: () => 'relay',
            request: async (url, init) => {
                calls.push({
                    url,
                    authorization: new Headers(init.headers ?? {}).get('Authorization'),
                });
                return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            },
            createWebSocket: () => {
                throw new Error('not used by HTTP');
            },
        },
    };
}

async function loadClientWithActiveCarrier(carrier: HomeCarrier | null) {
    // The mocks below only take effect for a module graph built after them.
    vi.resetModules();
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        // A browser Iroh Home publishes no runtime origin: there is no loopback
        // listener to bind, and inventing one would put an untrue origin into
        // the request URL, the auth same-origin check, and the logs.
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: CANONICAL_URL,
            carrier: carrier ? ('iroh' as const) : undefined,
            generation: 1,
        }),
        getActiveServerHomeCarrier: () => carrier,
    }));
    vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => await createTokenStorageModuleMock({
        importOriginal: async <T,>() => await importOriginal<T>(),
        tokenStorage: {
            getCredentials: vi.fn(async () => ({ token: 'home-token' })),
            getCredentialsForServerUrl: vi.fn(async () => ({ token: 'home-token' })),
            invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            classifyPendingExternalAuthFirstKeyRejectedCredential: vi.fn(async (..._args: unknown[]) => ({ kind: 'allowed' as const })),
        },
    }));
    return await import('./client');
}

describe('serverFetch over a browser Iroh Home carrier', () => {
    it('refuses a redirect returned by the semantic Home carrier with the shared closed code', async () => {
        const { carrier } = createCarrier();
        const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(null,
            { status: 307, headers: { location: 'https://other.example.test/v1/sessions' } }));
        const client = await loadClientWithActiveCarrier({ ...carrier, request });
        await expect(client.serverFetch('/v1/sessions', {
            method: 'POST', body: 'synthetic-credential-body', redirect: 'follow',
        }, { retry: 'none' })).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 307 });
        expect(request.mock.calls[0]?.[1].redirect).toBe('manual');
    });

    it('sends the Home-scoped credential to the canonical URL through the carrier, not a fabricated origin', async () => {
        const { carrier, calls } = createCarrier();
        const runtimeFetch = vi.fn(async () => new Response(null, { status: 500 }));
        const client = await loadClientWithActiveCarrier(carrier);
        client.setRuntimeFetch(runtimeFetch as never);

        const response = await client.serverFetch('/v1/sessions', undefined, { retry: 'none' });

        expect(response.status).toBe(200);
        expect(runtimeFetch).not.toHaveBeenCalled();
        expect(calls).toEqual([{
            url: `${CANONICAL_URL}/v1/sessions`,
            authorization: 'Bearer home-token',
        }]);
    });

    it('never carries an absolute cross-origin URL, so a Home bearer cannot leave the Home', async () => {
        const { carrier, calls } = createCarrier();
        const runtimeFetch = vi.fn(async () => new Response(null, { status: 200 }));
        const client = await loadClientWithActiveCarrier(carrier);
        client.setRuntimeFetch(runtimeFetch as never);

        const response = await client.serverFetch(
            'https://cdn.elsewhere.test/asset.bin',
            undefined,
            { retry: 'none', includeAuth: false },
        );

        expect(response.status).toBe(200);
        expect(calls).toEqual([]);
        expect(runtimeFetch).toHaveBeenCalledTimes(1);
        const [requestedUrl, requestedInit] = runtimeFetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestedUrl).toBe('https://cdn.elsewhere.test/asset.bin');
        expect(new Headers(requestedInit.headers ?? {}).get('Authorization')).toBeNull();
    });

    it('leaves an HTTPS Home on the platform transport', async () => {
        const runtimeFetch = vi.fn(async () => new Response(null, { status: 200 }));
        const client = await loadClientWithActiveCarrier(null);
        client.setRuntimeFetch(runtimeFetch as never);

        await client.serverFetch('/v1/sessions', undefined, { retry: 'none' });

        expect(runtimeFetch).toHaveBeenCalledTimes(1);
    });
});

describe('createServerFetchAtEndpoint over a secondary Home carrier', () => {
    it('targets each Home through its own carrier while preserving that Home canonical URL', async () => {
        const first = createCarrier();
        const second = createCarrier();
        const runtimeFetch = vi.fn(async () => new Response(null, { status: 500 }));
        const client = await loadClientWithActiveCarrier(null);
        client.setRuntimeFetch(runtimeFetch as never);

        const requestFirst = client.createServerFetchAtEndpoint({
            endpointUrl: CANONICAL_URL,
            homeCarrier: first.carrier,
            credentials: { token: 'first-token' },
            serverId: 'server-a',
        });
        const requestSecond = client.createServerFetchAtEndpoint({
            endpointUrl: 'https://second.example.test',
            homeCarrier: second.carrier,
            credentials: { token: 'second-token' },
            serverId: 'server-b',
        });

        await requestFirst('/v1/sessions', undefined, { retry: 'none' });
        await requestSecond('/v1/sessions', undefined, { retry: 'none' });

        expect(first.calls).toEqual([{
            url: `${CANONICAL_URL}/v1/sessions`,
            authorization: 'Bearer first-token',
        }]);
        expect(second.calls).toEqual([{
            url: 'https://second.example.test/v1/sessions',
            authorization: 'Bearer second-token',
        }]);
        expect(runtimeFetch).not.toHaveBeenCalled();
    });
});
