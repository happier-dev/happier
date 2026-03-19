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

    beforeEach(() => {
        tokenStorageMock.getCredentials.mockReset();
        tokenStorageMock.getCredentialsForServerUrl.mockReset();
        serverRuntimeMock.generation = 1;
        serverRuntimeMock.getActiveServerSnapshot.mockClear();

        const key = '__HAPPIER_GLOBAL_IN_FLIGHT_HTTP_REQUESTS_BY_KEY__';
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
        }
    });

    afterEach(() => {
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

        expect(tokenStorageMock.getCredentialsForServerUrl).toHaveBeenCalledWith('https://stack.example.test');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-token');
    }, longTimeoutMs);

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

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
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
            await Promise.resolve();
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
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(a.json()).resolves.toEqual({ ok: true });
        await expect(b.json()).resolves.toEqual({ ok: true });
    });

    it('dedupes concurrent GET requests across module instances', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            await Promise.resolve();
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
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(a.json()).resolves.toEqual({ ok: true });
        await expect(b.json()).resolves.toEqual({ ok: true });
    });

    it('dedupes concurrent GET requests even when server generation differs, but preserves stale rejection', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            await Promise.resolve();
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
        expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
