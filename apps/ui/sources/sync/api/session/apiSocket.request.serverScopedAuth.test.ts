import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';

import { createDeferred } from '@/dev/testkit';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

// Resolve the real transport owner during collection so graph loading is outside the request-ordering test.
await import('./apiSocket');

const tokenStorageMock = vi.hoisted(() => ({
    getCredentials: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
    invalidateCredentialsTokenForServerUrl: vi.fn(),
    classifyPendingExternalAuthFirstKeyRejectedCredential: vi.fn(),
    readPendingExternalAuthStateForServerUrl: vi.fn(),
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

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: tokenStorageMock,
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => serverRuntimeMock.getActiveServerSnapshot(),
    getActiveServerHomeCarrier: () => null,
}));

describe('apiSocket.request server-scoped credentials', () => {
    const longTimeoutMs = 120_000;

    beforeEach(async () => {
        tokenStorageMock.getCredentials.mockReset();
        tokenStorageMock.getCredentialsForServerUrl.mockReset();
        tokenStorageMock.invalidateCredentialsTokenForServerUrl.mockReset();
        tokenStorageMock.classifyPendingExternalAuthFirstKeyRejectedCredential.mockReset();
        tokenStorageMock.readPendingExternalAuthStateForServerUrl.mockReset();
        tokenStorageMock.classifyPendingExternalAuthFirstKeyRejectedCredential.mockResolvedValue({ kind: 'allowed' });
        tokenStorageMock.readPendingExternalAuthStateForServerUrl.mockResolvedValue({
            serverMismatch: false,
            value: null,
        });
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

    it('retains an explicit frame request without consulting stored credentials and rejects retirement', async () => {
        const { apiSocket } = await import('./apiSocket');
        let current = true;
        const request = vi.fn(async () => new Response('frame', { status: 200 }));
        // Configuration is the transport boundary; no real socket is needed for this HTTP contract.
        Object.assign(apiSocket, { config: { endpoint: 'https://embed.example.test', token: 'hap_v1_child',
            socketRole: { clientType: 'session-scoped', sessionId: 's1' }, request, isCurrent: () => current } });
        expect(await (await apiSocket.request('/v2/sessions/s1')).text()).toBe('frame');
        expect(tokenStorageMock.getCredentialsForServerUrl).not.toHaveBeenCalled();
        current = false;
        await expect(apiSocket.request('/v2/sessions/s1')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        expect(request).toHaveBeenCalledTimes(1);
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

    it('keeps a configured browser-Iroh request on its prepared Home while another Home is staged', async () => {
        serverRuntimeMock.getActiveServerSnapshot.mockReturnValue({
            serverId: 'staged-home-b',
            serverUrl: 'https://staged-home-b.example.test',
            kind: 'custom',
            generation: 22,
        });
        const carrierRequest = vi.fn(async (url: string, init: RequestInit) => {
            expect(new Headers(init.headers).get('Authorization')).toBe('Bearer applied-home-a-token');
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const homeCarrier: HomeCarrier = {
            endpointId: 'iroh-applied-home-a',
            readObservedPath: () => 'relay',
            request: carrierRequest,
            createWebSocket: () => ({}),
        };
        const globalFetch = vi.fn(async () => {
            throw new Error('Staged global fetch must not be used');
        });
        vi.stubGlobal('fetch', globalFetch as unknown as typeof fetch);

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://applied-home-a.example.test',
            token: 'applied-home-a-token',
            serverId: 'applied-home-a',
            generation: 11,
            runtimeOrigin: 'https://applied-home-a.example.test',
            carrier: 'iroh',
            homeCarrier,
        });

        await expect(apiSocket.request('/v1/ping')).resolves.toBeInstanceOf(Response);

        expect(carrierRequest).toHaveBeenCalledWith(
            'https://applied-home-a.example.test/v1/ping',
            expect.any(Object),
        );
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('refuses a captured prepared request after the socket is configured for another Home', async () => {
        const fetchMock = vi.fn(async () => new Response('wrong Home request', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://applied-home-a.example.test',
            token: 'applied-home-a-token',
            serverId: 'applied-home-a',
            generation: 11,
        });
        const requestForAppliedHome = apiSocket.createRequestForPreparedTarget({
            endpoint: 'https://applied-home-a.example.test',
            serverId: 'applied-home-a',
            generation: 11,
        });

        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://staged-home-b.example.test',
            token: 'staged-home-b-token',
            serverId: 'staged-home-b',
            generation: 22,
        });

        await expect(requestForAppliedHome('/v3/automations/settings')).rejects.toMatchObject({
            name: 'StaleServerGenerationError',
        });
        expect(fetchMock).not.toHaveBeenCalled();
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

    it.each(['credentials', 'response'] as const)('rejects a Home switch with socket reconfiguration during %s', async (phase) => {
        const { apiSocket } = await import('./apiSocket');
        // Socket configuration is the external connection boundary exercised by this suite.
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://stack.example.test', token: 'unused', serverId: 'stack', generation: 1,
        });
        const switchHome = () => {
            serverRuntimeMock.getActiveServerSnapshot.mockReturnValue({
                serverId: 'other', serverUrl: 'https://other.example.test', kind: 'custom', generation: 2,
            });
            Reflect.set(apiSocket, 'config', {
                endpoint: 'https://other.example.test', token: 'other-token', serverId: 'other', generation: 2,
            });
        };
        tokenStorageMock.getCredentialsForServerUrl.mockImplementation(async () => {
            if (phase === 'credentials') switchHome();
            return { token: 'original-token', secret: 's' };
        });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (phase === 'response' && String(input).endsWith('/v1/ping')) switchHome();
            return new Response('ok', { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(apiSocket.request('/v1/ping')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('https://other.example.test'))).toBe(false);
        if (phase === 'credentials') expect(fetchMock).not.toHaveBeenCalled();
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

    it('reads current state for no-store requests while an older GET is outstanding', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let reads = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            if (!String(input).endsWith('/v1/ping')) return new Response('ok');
            if (++reads === 1) {
                await gate;
                return Response.json({ state: 'delivering' });
            }
            return Response.json({ state: 'committed' });
        }));
        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });
        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'config', { endpoint: 'https://stack.example.test', token: 'unused' });
        const oldRead = apiSocket.request('/v1/ping');
        await vi.waitFor(() => expect(reads).toBe(1));
        const currentRead = apiSocket.request('/v1/ping', { cache: 'no-store' });
        await Promise.resolve();
        release();
        await expect((await oldRead).json()).resolves.toEqual({ state: 'delivering' });
        await expect((await currentRead).json()).resolves.toEqual({ state: 'committed' });
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
            // "The network is down" must fail every readiness route: an authenticated client probes
            // /v1/auth/ping, a tokenless one probes /health.
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
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

    it('keeps a prepared socket target behind reachability supervision', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                throw new TypeError('Network request failed');
            }
            if (url.endsWith('/v1/ping')) {
                return new Response('application request should have been gated', { status: 200 });
            }
            return new Response('ok', { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://prepared-home.example.test',
            token: 'prepared-home-token',
            serverId: 'prepared-home',
            generation: 7,
        });

        await expect(apiSocket.request('/v1/ping')).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });

        const applicationCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/ping'));
        expect(applicationCalls).toHaveLength(0);
    }, longTimeoutMs);

    it('aborts a prepared request when its socket configuration is retired', async () => {
        let requestSignal: AbortSignal | undefined;
        let resolveIssued: (() => void) | undefined;
        let resolveResponse: (() => void) | undefined;
        const issued = new Promise<void>((resolve) => {
            resolveIssued = resolve;
        });
        const responseReleased = new Promise<void>((resolve) => {
            resolveResponse = resolve;
        });
        const homeCarrier: HomeCarrier = {
            endpointId: 'retired-prepared-home',
            readObservedPath: () => 'relay',
            request: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
                requestSignal = init.signal ?? undefined;
                resolveIssued?.();
                void responseReleased.then(() => _resolve(Response.json({ ok: true })));
                init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
            }),
            createWebSocket: () => ({}),
        };

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'requestConfigurationAbortController', new AbortController());
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://retired-prepared-home.example.test',
            token: 'retired-prepared-home-token',
            serverId: 'retired-prepared-home',
            generation: 8,
            carrier: 'iroh',
            homeCarrier,
        });

        const pending = apiSocket.request('/v1/ping', undefined, { retry: 'none' });
        await issued;
        apiSocket.invalidateRequests();
        resolveResponse?.();

        await expect(pending).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        expect(requestSignal?.aborted).toBe(true);
    });

    it('recovers prepared socket credentials after a target-scoped 401 without consulting staged selection', async () => {
        serverRuntimeMock.getActiveServerSnapshot.mockReturnValue({
            serverId: 'staged-home-b',
            serverUrl: 'https://staged-home-b.example.test',
            kind: 'custom',
            generation: 22,
        });
        // A replacement may already be stored before the rejected bearer is
        // invalidated. In that case no credential-retirement fanout fires and
        // the config-bound request can safely adopt the replacement.
        tokenStorageMock.invalidateCredentialsTokenForServerUrl.mockResolvedValue(false);
        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({
            token: 'prepared-home-refreshed-token',
            secret: 's',
        });
        let requests = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('https://prepared-home-a.example.test/v1/ping');
            requests += 1;
            const authorization = new Headers(init?.headers).get('Authorization');
            if (requests === 1) {
                expect(authorization).toBe('Bearer prepared-home-old-token');
                return new Response('unauthorized', { status: 401 });
            }
            expect(authorization).toBe('Bearer prepared-home-refreshed-token');
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'requestConfigurationAbortController', new AbortController());
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://prepared-home-a.example.test',
            token: 'prepared-home-old-token',
            serverId: 'prepared-home-a',
            generation: 11,
        });

        await expect(apiSocket.request('/v1/ping', undefined, { retry: 'none' })).resolves.toMatchObject({ status: 200 });
        expect(tokenStorageMock.invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith(
            'https://prepared-home-a.example.test',
            'prepared-home-old-token',
            { serverId: 'prepared-home-a' },
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(Reflect.get(apiSocket, 'config')).toMatchObject({
            token: 'prepared-home-refreshed-token',
        });
    });

    it('keeps every coalesced prepared GET current after a target-scoped 401 recovery', async () => {
        tokenStorageMock.invalidateCredentialsTokenForServerUrl.mockResolvedValue(false);
        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({
            token: 'prepared-home-refreshed-token',
            secret: 's',
        });
        const firstRequestIssued = createDeferred<void>();
        const releaseRejectedResponse = createDeferred<void>();
        let requests = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('https://prepared-home-a.example.test/v1/ping');
            requests += 1;
            if (requests === 1) {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer prepared-home-old-token');
                firstRequestIssued.resolve();
                await releaseRejectedResponse.promise;
                return new Response('unauthorized', { status: 401 });
            }
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer prepared-home-refreshed-token');
            return Response.json({ ok: true });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'requestConfigurationAbortController', new AbortController());
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://prepared-home-a.example.test',
            token: 'prepared-home-old-token',
            serverId: 'prepared-home-a',
            generation: 11,
        });

        const first = apiSocket.request('/v1/ping', undefined, { retry: 'none' });
        await firstRequestIssued.promise;
        const second = apiSocket.request('/v1/ping', undefined, { retry: 'none' });
        releaseRejectedResponse.resolve();

        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(Reflect.get(apiSocket, 'config')).toMatchObject({
            token: 'prepared-home-refreshed-token',
        });
    });

    it('does not retry a prepared request after credential retirement invalidates its configuration', async () => {
        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({
            token: 'replacement-that-must-not-race-retirement',
            secret: 's',
        });
        const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { apiSocket } = await import('./apiSocket');
        Reflect.set(apiSocket, 'requestConfigurationAbortController', new AbortController());
        Reflect.set(apiSocket, 'config', {
            endpoint: 'https://retired-credential-home.example.test',
            token: 'rejected-token',
            serverId: 'retired-credential-home',
            generation: 9,
        });
        tokenStorageMock.invalidateCredentialsTokenForServerUrl.mockImplementation(async () => {
            apiSocket.invalidateRequests('credentials-changed');
            return true;
        });

        await expect(apiSocket.request('/v1/ping', undefined, { retry: 'none' }))
            .rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
