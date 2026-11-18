import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { answerDesktopHttpFetch, createDesktopHostInternals, desktopHttpFrame } from '@/dev/testkit/harness/desktopHttpHost';

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';

function setTauriInternals(value: unknown): void {
    if (value === undefined) {
        delete (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
        return;
    }
    (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = value;
}

afterEach(() => {
    setTauriInternals(undefined);
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock('expo/fetch');
    vi.doUnmock('react-native');
});

describe('runtimeFetch', () => {
    it.each(['ready', 'cancelled'] as const)('acknowledges server issuance only when the selected runtime fetch is invoked (%s)', async (outcome) => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return await createReactNativeNativeMock({ platformOS: 'ios' });
        });
        let releaseAdapter!: () => void;
        let adapterStarted!: () => void;
        const adapterGate = new Promise<void>(resolve => { releaseAdapter = resolve; });
        const resolvingAdapter = new Promise<void>(resolve => { adapterStarted = resolve; });
        let releaseResponse!: (response: Response) => void;
        const response = new Promise<Response>(resolve => { releaseResponse = resolve; });
        const events: string[] = [];
        const nativeFetch = vi.fn(() => { events.push('fetch'); return response; });
        // The native SDK is the external adapter boundary. Its module may load
        // asynchronously before the runtime can invoke the selected fetch.
        vi.doMock('expo/fetch', async () => {
            adapterStarted();
            await adapterGate;
            return { fetch: nativeFetch };
        });
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://api.example.test', credentials: null });
        const controller = new AbortController();
        const issued = vi.fn(() => { events.push('issued'); });
        const operation = request('/v2/usage/query-batch', { method: 'POST', signal: controller.signal }, {
            includeAuth: false, retry: 'none', onIssued: issued,
        });
        const settlement = operation.then(value => ({ value }), error => ({ error }));
        await resolvingAdapter;
        expect(issued).not.toHaveBeenCalled();
        expect(nativeFetch).not.toHaveBeenCalled();
        if (outcome === 'cancelled') controller.abort();
        releaseAdapter();
        if (outcome === 'cancelled') {
            expect(await settlement).toMatchObject({ error: { name: 'AbortError' } });
            expect(issued).not.toHaveBeenCalled();
            expect(nativeFetch).not.toHaveBeenCalled();
        } else {
            await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledTimes(1));
            expect(issued).toHaveBeenCalledTimes(1);
            expect(events).toEqual(['issued', 'fetch']);
            releaseResponse(new Response(null, { status: 200 }));
            expect(await settlement).toMatchObject({ value: { status: 200 } });
            expect(issued).toHaveBeenCalledTimes(1);
        }
    });

    it('does not acknowledge issuance when runtime adapter preparation fails', async () => {
        vi.resetModules();
        vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
        vi.stubGlobal('fetch', undefined);
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://api.example.test', credentials: null });
        const issued = vi.fn();
        await expect(request('/v2/usage/query-batch', { method: 'POST' }, {
            includeAuth: false, retry: 'none', onIssued: issued,
        })).rejects.toThrow('globalThis.fetch is not available');
        expect(issued).not.toHaveBeenCalled();
    });

    it('leaves manual hops to one credential-aware redirect follower', async () => {
        const hops: Array<{ path: string; credential: string | string[] | undefined }> = [];
        const server = createServer((request, response) => {
            hops.push({ path: request.url ?? '', credential: request.headers['x-private-key'] });
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing listener port');
            if (request.url === '/start') {
                response.writeHead(302, { Location: `http://localhost:${address.port}/target` });
            } else {
                response.writeHead(200);
            }
            response.end();
        });
        server.listen(0);
        await once(server, 'listening');
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing listener port');
            const { runtimeFetch } = await import('./runtimeFetch');
            const { fetchWithCredentialRedirectRefusal } = await import('@happier-dev/cli-common/homeTarget');
            const url = `http://127.0.0.1:${address.port}/start`;
            const init = { redirect: 'manual', headers: { 'x-private-key': 'synthetic-key' } } satisfies RequestInit;
            const raw = await runtimeFetch(url, init);
            await raw.body?.cancel();
            expect(raw.status).toBe(302);
            expect(hops).toEqual([{ path: '/start', credential: 'synthetic-key' }]);
            hops.length = 0;
            const followed = await fetchWithCredentialRedirectRefusal(url, init, runtimeFetch, new Set(['x-private-key']));
            await followed.body?.cancel();
            expect(followed.status).toBe(200);
            expect(hops).toEqual([
                { path: '/start', credential: 'synthetic-key' },
                { path: '/target', credential: undefined },
            ]);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it.each(['ios', 'android', 'tauri'] as const)('keeps native redirect credentials with the shared HTTP owner on %s', async (platformOS) => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const mocks = await import('@/dev/testkit/mocks/reactNative');
            return platformOS === 'tauri'
                ? mocks.createReactNativeWebMock()
                : await mocks.createReactNativeNativeMock({ platformOS });
        });
        const received: Array<{ path: string; authorization: boolean }> = [];
        const server = createServer((request, response) => {
            received.push({ path: request.url ?? '', authorization: request.headers.authorization !== undefined });
            if (request.url === '/start') {
                response.writeHead(302, { location: '/same-origin' });
            } else if (request.url === '/same-origin') {
                const address = target.address();
                if (!address || typeof address === 'string') throw new Error('Missing fixture address');
                // A different port is a different origin, even on the same host.
                response.writeHead(302, { location: `http://127.0.0.1:${address.port}/diff` });
            }
            response.end('diff --git a/a.ts b/a.ts');
        });
        const target = createServer((request, response) => {
            received.push({ path: request.url ?? '', authorization: request.headers.authorization !== undefined });
            response.end('diff --git a/a.ts b/a.ts');
        });
        server.listen(0, '127.0.0.1');
        target.listen(0, '127.0.0.1');
        await Promise.all([once(server, 'listening'), once(target, 'listening')]);
        const fetch = globalThis.fetch;
        // Native transport boundary deliberately models an implementation that
        // forwards headers on automatic redirects; manual mode exposes each hop.
        const nativeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const response = await fetch(input, { ...init, redirect: 'manual' });
            const location = response.headers.get('location');
            if (init?.redirect !== 'follow' || !location) return response;
            await response.body?.cancel();
            return nativeFetch(new URL(location, String(input)), init);
        };
        vi.doMock('expo/fetch', () => ({ fetch: nativeFetch }));
        if (platformOS === 'tauri') {
            setTauriInternals(createDesktopHostInternals(call => answerDesktopHttpFetch(call, nativeFetch)).internals);
        }
        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Missing fixture address');
            }
            const { runtimeFetchManualResponse } = await import('./runtimeFetch');
            const { createPluginHttpService, createFetchPluginHttpRuntime } = await import('@happier-dev/cli-common/plugins/http');
            const http = createPluginHttpService({ adapter: createFetchPluginHttpRuntime(runtimeFetchManualResponse) });
            const result = await http.request({ url: `http://127.0.0.1:${address.port}/start`,
                headers: { Authorization: 'Bearer synthetic-request-credential' }, redirect: 'follow' });
            expect(result.status).toBe(200);
            expect(new TextDecoder().decode(result.body)).toContain('diff --git');
            expect(received).toEqual([
                { path: '/start', authorization: true },
                { path: '/same-origin', authorization: true },
                { path: '/diff', authorization: false },
            ]);
        } finally {
            await Promise.all([server, target].map(async (fixture) => {
                fixture.closeAllConnections();
                await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
            }));
        }
    });

    it('lets the plugin HTTP owner follow a browser redirect to the final resource', async () => {
        const fetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetch(input, init);
            // The substituted platform boundary matches Chromium's opaque manual response.
            if (init?.redirect !== 'manual' || response.status !== 302) return response;
            await response.body?.cancel();
            return Object.defineProperties(new Response(null), {
                status: { value: 0 }, type: { value: 'opaqueredirect' }, url: { value: '' },
            });
        });
        const server = createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { location: '/diff' });
                response.end();
            } else response.end('diff --git a/a.ts b/a.ts');
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing fixture address');
            const { runtimeFetchManualResponse } = await import('./runtimeFetch');
            const { createPluginHttpService, createFetchPluginHttpRuntime } = await import('@happier-dev/cli-common/plugins/http');
            const http = createPluginHttpService({ adapter: createFetchPluginHttpRuntime(runtimeFetchManualResponse) });
            const result = await http.request({ url: `http://127.0.0.1:${address.port}/redirect`, redirect: 'follow' });
            expect(result.status).toBe(200);
            expect(new TextDecoder().decode(result.body)).toContain('diff --git');
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it.each([302, 307, 308])('scopes credentials and secret-body replay on a cross-origin %i redirect', async (status) => {
        let initialHopRequests = 0;
        let secondHopRequests = 0;
        let secondHopCredentials = false;
        let secondHopBody = false;
        const server = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += String(chunk);
            if (request.url === '/redirect') {
                initialHopRequests += 1;
                const address = server.address();
                if (!address || typeof address === 'string') throw new Error('Missing listener port');
                response.writeHead(status, { Location: `http://localhost:${address.port}/second-hop?secret=not-for-diagnostics` });
                response.end();
                return;
            }
            if (request.url?.startsWith('/second-hop')) {
                secondHopRequests += 1;
                secondHopCredentials ||= Boolean(request.headers.authorization);
                secondHopBody ||= body.length > 0;
            }
            const ownerAdmitted = request.headers.authorization === 'Bearer synthetic-request-credential'
                && body === 'synthetic-approval-body';
            response.writeHead(request.url === '/ordinary' && !ownerAdmitted ? 401 : 200);
            response.end('ok');
        });
        server.listen(0);
        await once(server, 'listening');
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing listener port');
            const { runtimeFetch } = await import('./runtimeFetch');
            const { createBackoff } = await import('@/utils/timing/time');
            const { fetchWithCredentialRedirectRefusal } = await import('@happier-dev/cli-common/homeTarget');
            const base = `http://127.0.0.1:${address.port}`;
            const operation = createBackoff()(() => fetchWithCredentialRedirectRefusal(`${base}/redirect`, {
                method: 'POST',
                headers: { Authorization: 'Bearer synthetic-request-credential' },
                body: 'synthetic-approval-body',
                redirect: 'manual',
            }, runtimeFetch));
            if (status === 302) expect((await operation).status).toBe(200);
            else await expect(operation).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status });
            expect(initialHopRequests).toBe(1);
            expect(secondHopRequests).toBe(status === 302 ? 1 : 0);
            expect(secondHopCredentials).toBe(false);
            expect(secondHopBody).toBe(false);
            const ordinary = await runtimeFetch(`${base}/ordinary`, {
                method: 'POST', headers: { Authorization: 'Bearer synthetic-request-credential' },
                body: 'synthetic-approval-body', redirect: 'manual',
            });
            expect(ordinary.status).toBe(200);
            expect(await ordinary.text()).toBe('ok');
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it('returns a manual desktop response with native redirect control', async () => {
        const host = createDesktopHostInternals(() => desktopHttpFrame({
            status: 307, statusText: 'Temporary Redirect', url: 'https://api.example.test/v1/auth',
            headers: [['location', 'https://other.example.test/auth']], streamed: false,
        }));
        setTauriInternals(host.internals);
        const { runtimeFetch, readRuntimeFetchHost } = await import('./runtimeFetch');
        expect(await readRuntimeFetchHost('https://api.example.test/v1/auth')).toBe('native');
        expect((await runtimeFetch('https://api.example.test/v1/auth', {
            method: 'POST', body: 'synthetic-approval-body', redirect: 'manual',
        })).status).toBe(307);
        expect(host.calls[0]?.args.clientConfig).toMatchObject({ maxRedirections: 0 });
    });

    it.each(['ios', 'android'] as const)('returns manual native responses on %s', async (platformOS) => {
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return await createReactNativeNativeMock({ platformOS });
        });
        const nativeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null,
            { status: 307, headers: { location: 'https://other.example.test/auth' } }));
        vi.doMock('expo/fetch', () => ({ fetch: nativeFetch }));
        const globalFetch = vi.fn(async () => new Response('unexpected-follow', { status: 200 }));
        vi.stubGlobal('fetch', globalFetch);
        const { runtimeFetch, readRuntimeFetchHost } = await import('./runtimeFetch');
        expect(await readRuntimeFetchHost('https://api.example.test/v1/auth')).toBe('native');
        expect((await runtimeFetch('https://api.example.test/v1/auth', {
            method: 'POST', body: 'synthetic-approval-body', redirect: 'manual',
        })).status).toBe(307);
        expect(nativeFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it.each(['ios', 'android'] as const)('adapts credential modes to the Expo native contract on %s', async (platformOS) => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return await createReactNativeNativeMock({ platformOS });
        });
        // Expo's native SDK accepts only include/omit; its JS fetch forwards the value unchanged.
        const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.credentials !== 'include' && init?.credentials !== 'omit') {
                throw new TypeError('Unsupported NativeRequestCredentials');
            }
            return Response.json({
                credentials: init.credentials,
                authorization: new Headers(init.headers).get('Authorization'),
                redirect: init.redirect,
            });
        });
        vi.doMock('expo/fetch', () => ({ fetch: nativeFetch }));
        const { runtimeFetch, runtimeFetchManualResponse } = await import('./runtimeFetch');
        const url = 'https://api.example.test/v1/features';
        const headers = { Authorization: 'Bearer synthetic-request-credential' };
        for (const credentials of [undefined, 'same-origin', 'include', 'omit'] as const) {
            const response = await runtimeFetch(url, { credentials, headers, redirect: 'manual' });
            expect(await response.json()).toEqual({
                credentials: credentials === 'include' ? 'include' : 'omit',
                authorization: headers.Authorization,
                redirect: 'manual',
            });
        }
        const response = await runtimeFetchManualResponse(url, { credentials: 'same-origin', headers });
        expect(await response.json()).toMatchObject({ credentials: 'omit', redirect: 'manual' });
    });

    it.each(['ios', 'android'] as const)('streams ordinary native discovery through the bounded feature decoder on %s', async (platformOS) => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return await createReactNativeNativeMock({ platformOS });
        });
        const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
        const { decodeServerFeaturesResponse, SERVER_FEATURES_RESPONSE_MAX_UTF8_BYTES } = await import('@/sync/api/capabilities/serverFeaturesParse');
        const payload = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
        const json = JSON.stringify(payload);
        // React Native's XHR-backed Response has no readable body stream.
        vi.stubGlobal('fetch', vi.fn(async () => Object.defineProperty(new Response(json), 'body', { value: undefined })));
        const nativeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(json));
        vi.doMock('expo/fetch', () => ({ fetch: nativeFetch }));
        const { runtimeFetch } = await import('./runtimeFetch');
        const url = 'https://api.example.test/v1/features';
        await expect(decodeServerFeaturesResponse(await runtimeFetch(url))).resolves.toEqual(payload);
        expect(nativeFetch.mock.calls[0]?.[1]?.redirect).toBeUndefined();
        nativeFetch.mockResolvedValueOnce(new Response(' '.repeat(SERVER_FEATURES_RESPONSE_MAX_UTF8_BYTES) + json));
        await expect(decodeServerFeaturesResponse(await runtimeFetch(url, { redirect: 'follow' }))).resolves.toBeNull();
        expect(nativeFetch.mock.calls[1]?.[1]?.redirect).toBe('follow');
    });

    it('preserves the global fetch receiver', async () => {
        vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
        const fetchMock = vi.fn(async function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
            // Browser fetch rejects a detached or object-method receiver.
            if (this !== globalThis) throw new TypeError('Illegal invocation');
            return new Response('ok', { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        const { runtimeFetch } = await import('./runtimeFetch');
        expect(await (await runtimeFetch('https://api.example.test/v1/features')).text()).toBe('ok');
    });

    it('defaults credentials to same-origin when omitted', async () => {
        vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { runtimeFetch, readRuntimeFetchHost } = await import('./runtimeFetch');
        expect(await readRuntimeFetchHost('https://api.example.test/v1/features')).toBe('browser');
        await runtimeFetch('https://api.example.test/v1/features');

        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('same-origin');
    });

    it('preserves explicit credentials', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features', { credentials: 'omit' });

        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('omit');
    });

    it('sends absolute http requests through the desktop host transport in Tauri desktop', async () => {
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        const host = createDesktopHostInternals(() => desktopHttpFrame({
            status: 200, statusText: 'OK', url: 'https://api.example.test/v1/features', headers: [], streamed: false,
        }, 'tauri-ok'));
        setTauriInternals(host.internals);

        const { runtimeFetch } = await import('./runtimeFetch');
        const response = await runtimeFetch('https://api.example.test/v1/features', { headers: { 'x-test': '1' } });

        expect(await response.text()).toBe('tauri-ok');
        expect(host.calls.map(call => call.command)).toEqual(['desktop_http_fetch']);
        expect(host.calls[0]?.args.clientConfig).toHaveProperty('headers', expect.arrayContaining([['x-test', '1']]));
        expect(globalFetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['relative URLs', '/v1/features'],
        ['non-http schemes', new URL('file:///tmp/happier-transfer.bin')],
    ] as const)('falls back to global fetch for %s in Tauri desktop', async (_label, target) => {
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        const host = createDesktopHostInternals(() => { throw new Error('unexpected desktop IPC'); });
        setTauriInternals(host.internals);

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch(target);

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        expect(host.calls).toEqual([]);
    });
});
