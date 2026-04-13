import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';

const tokenStorageMock = vi.hoisted(() => ({
    getCredentials: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
}));
const serverRuntimeMock = vi.hoisted(() => ({
    generation: 1,
    getActiveServerSnapshot: vi.fn(() => ({
        serverId: 'stack',
        serverUrl: 'https://stack.example.test',
        kind: 'custom',
        generation: serverRuntimeMock.generation,
    })),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: tokenStorageMock,
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => serverRuntimeMock.getActiveServerSnapshot(),
}));

describe('apiSocket.request server-scoped credentials', () => {
    const longTimeoutMs = 120_000;

    beforeEach(async () => {
        tokenStorageMock.getCredentials.mockReset();
        tokenStorageMock.getCredentialsForServerUrl.mockReset();
        serverRuntimeMock.generation = 1;
        serverRuntimeMock.getActiveServerSnapshot.mockReset();
        serverRuntimeMock.getActiveServerSnapshot.mockImplementation(() => ({
            serverId: 'stack',
            serverUrl: 'https://stack.example.test',
            kind: 'custom',
            generation: serverRuntimeMock.generation,
        }));

        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }

        const key = '__HAPPIER_GLOBAL_IN_FLIGHT_HTTP_REQUESTS_BY_KEY__';
        const tokenKey = '__HAPPIER_GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN__';
        const g = globalThis as any;
        const hosts = [
            g,
            g?.process,
            typeof process !== 'undefined' ? (process as any) : null,
        ];
        for (const host of hosts) {
            const inFlight = host?.[key];
            if (!inFlight) continue;
            if (Object.prototype.toString.call(inFlight) === '[object Map]') {
                (inFlight as Map<unknown, unknown>).clear();
            } else {
                delete host[key];
            }

            const tokenCache = host?.[tokenKey];
            if (!tokenCache) continue;
            if (Object.prototype.toString.call(tokenCache) === '[object Map]') {
                (tokenCache as Map<unknown, unknown>).clear();
            } else {
                delete host[tokenKey];
            }
        }
    });

    afterEach(async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }
        vi.unstubAllGlobals();
    });

    it('prefers credentials scoped to the configured endpoint', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });
        tokenStorageMock.getCredentials.mockResolvedValue({ token: 'global-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await apiSocket.request('/v1/ping');

        expect(tokenStorageMock.getCredentialsForServerUrl).toHaveBeenCalledWith('https://stack.example.test', {
            serverId: 'stack',
        });
        const pingCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/v1/ping'));
        expect(pingCalls).toHaveLength(1);
        const init = pingCalls[0]?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-token');
    }, longTimeoutMs);

    it('does not force the active serverId when the configured endpoint is a different origin', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        serverRuntimeMock.getActiveServerSnapshot.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://server-b.example.test', token: 'unused' };

        await expect(apiSocket.request('/v1/ping')).rejects.toThrow(
            'Refused authenticated request to https://server-b.example.test',
        );

        expect(tokenStorageMock.getCredentialsForServerUrl).toHaveBeenCalledWith('https://server-b.example.test', undefined);
    });

    it('does not allow request option headers to override the Authorization header', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        vi.resetModules();

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await apiSocket.request('/v1/ping', {
            headers: {
                authorization: 'Bearer attacker-lower',
                Authorization: 'Bearer attacker-upper',
            },
        });

        const pingCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/v1/ping'));
        expect(pingCalls).toHaveLength(1);
        const init = pingCalls[0]?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-token');
    });

    it('rejects stale responses when active server generation changes mid-request', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            serverRuntimeMock.generation = 2;
            return new Response('ok', { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });
        tokenStorageMock.getCredentials.mockResolvedValue({ token: 'global-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await expect(apiSocket.request('/v1/ping')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });

    it('does not fall back to active-server credentials when endpoint-scoped credentials are missing', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue(null);
        tokenStorageMock.getCredentials.mockResolvedValue({ token: 'global-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await expect(apiSocket.request('/v1/ping')).rejects.toThrow('No authentication credentials');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('dedupes concurrent GET requests for the same URL', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        const [a, b] = await Promise.all([apiSocket.request('/v1/ping'), apiSocket.request('/v1/ping')]);
        const pingCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/v1/ping'));
        expect(pingCalls).toHaveLength(1);
        await expect(a.json()).resolves.toEqual({ ok: true });
        await expect(b.json()).resolves.toEqual({ ok: true });
    });

    it('does not include raw auth tokens in global in-flight request keys', async () => {
        let resolvePing: (response: Response) => void = () => {
            throw new Error('Expected ping response resolver to be defined');
        };
        const pingPromise = new Promise<Response>((resolve) => { resolvePing = resolve; });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response('ok', { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/ping')) {
                return await pingPromise;
            }
            return new Response('ok', { status: 200, headers: new Headers() });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        const requestPromise = apiSocket.request('/v1/ping');
        // Allow the request to progress past its initial awaits (credentials lookup) so the in-flight key is recorded.
        await Promise.resolve();

        const key = '__HAPPIER_GLOBAL_IN_FLIGHT_HTTP_REQUESTS_BY_KEY__';
        const host = typeof process !== 'undefined' ? (process as any) : (globalThis as any);
        const inFlight = host?.[key] as Map<string, unknown> | undefined;
        expect(inFlight).toBeTruthy();
        expect(Array.from((inFlight ?? new Map()).keys()).join('\n')).not.toContain('scoped-token');

        resolvePing(new Response('ok', { status: 200, headers: new Headers() }));
        await expect(requestPromise).resolves.toBeInstanceOf(Response);
    });

    it('dedupes concurrent GET requests across module instances', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        const modA = await import('./apiSocket');
        (modA.apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        vi.resetModules();

        const modB = await import('./apiSocket');
        (modB.apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        const [a, b] = await Promise.all([modA.apiSocket.request('/v1/ping'), modB.apiSocket.request('/v1/ping')]);
        const pingCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/v1/ping'));
        expect(pingCalls).toHaveLength(1);
        await expect(a.json()).resolves.toEqual({ ok: true });
        await expect(b.json()).resolves.toEqual({ ok: true });
    });

    it('dedupes concurrent GET requests even when server generation differs, but preserves stale rejection', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        serverRuntimeMock.generation = 1;
        const reqA = apiSocket.request('/v1/ping');

        serverRuntimeMock.generation = 2;
        const reqB = apiSocket.request('/v1/ping');

        await expect(reqA).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        await expect((await reqB).json()).resolves.toEqual({ ok: true });
        const pingCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/v1/ping'));
        expect(pingCalls).toHaveLength(1);
    });

    it('reuses a cross-realm global in-flight request map (vitest module isolation)', async () => {
        const key = '__HAPPIER_GLOBAL_IN_FLIGHT_HTTP_REQUESTS_BY_KEY__';
        const foreignMap = runInNewContext('new Map()') as unknown as Map<string, Promise<Response>>;

        // Cross-realm sanity check: this is the class of bug we want to guard against.
        expect(foreignMap instanceof Map).toBe(false);

        vi.resetModules();
        const modA = await import('./apiSocket');
        const initialMap = (modA.apiSocket as any).inFlightHttpRequestsByKey as unknown;

        const g = globalThis as any;
        const hosts = [
            g,
            g?.process,
            typeof process !== 'undefined' ? (process as any) : null,
        ];
        const host = hosts.find((candidate) =>
            candidate
            && typeof candidate === 'object'
            && (candidate as any)[key] === initialMap
        );
        expect(host).toBeTruthy();

        (host as any)[key] = foreignMap;

        vi.resetModules();
        const modB = await import('./apiSocket');
        expect((modB.apiSocket as any).inFlightHttpRequestsByKey).toBe(foreignMap);
    });

    it('gates requests behind server reachability (does not attempt request while unreachable)', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            if (url.endsWith('/v1/ping')) {
                return new Response('ok', { status: 200 });
            }
            return new Response('ok', { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await expect(apiSocket.request('/v1/ping')).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });

        const pingCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/v1/ping'));
        expect(pingCalls).toHaveLength(0);
    }, longTimeoutMs);
});
