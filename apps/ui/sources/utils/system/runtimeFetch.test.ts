import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

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
    vi.doUnmock('@tauri-apps/plugin-http');
    vi.doUnmock('expo/fetch');
    vi.doUnmock('react-native');
});

describe('runtimeFetch', () => {
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
            const base = `http://127.0.0.1:${address.port}`;
            const operation = createBackoff()(() => runtimeFetch(`${base}/redirect`, {
                method: 'POST',
                headers: { Authorization: 'Bearer synthetic-request-credential' },
                body: 'synthetic-approval-body',
                redirect: 'manual',
            }));
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

    it('converts a manual credential request to the desktop native redirect control', async () => {
        const tauriFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null,
            { status: 307, headers: { location: 'https://other.example.test/auth' } }));
        vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: tauriFetchMock }));
        setTauriInternals({ invoke: () => null });
        const { runtimeFetch, readRuntimeFetchHost } = await import('./runtimeFetch');
        expect(await readRuntimeFetchHost('https://api.example.test/v1/auth')).toBe('native');
        await expect(runtimeFetch('https://api.example.test/v1/auth', {
            method: 'POST', body: 'synthetic-approval-body', redirect: 'manual',
        })).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false });
        expect(tauriFetchMock.mock.calls[0]?.[1]).toMatchObject({ maxRedirections: 0 });
    });

    it.each(['ios', 'android'] as const)('uses the redirect-aware native transport for %s credential requests', async (platformOS) => {
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
        await expect(runtimeFetch('https://api.example.test/v1/auth', {
            method: 'POST', body: 'synthetic-approval-body', redirect: 'manual',
        })).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false });
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

    it('uses tauri-plugin-http fetch when running in Tauri desktop', async () => {
        const tauriFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('tauri-ok', { status: 200 }));
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: tauriFetchMock,
        }));
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features', { headers: { 'x-test': '1' } });

        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
        expect(globalFetchMock).not.toHaveBeenCalled();
        const init = tauriFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('same-origin');
    });

    it('falls back to global fetch for relative URLs in Tauri desktop', async () => {
        const tauriFetchMock = vi.fn(async () => new Response('tauri-ok', { status: 200 }));
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: tauriFetchMock,
        }));
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('/v1/features');

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        expect(tauriFetchMock).not.toHaveBeenCalled();
    });

    it('falls back to global fetch for non-http schemes in Tauri desktop', async () => {
        const tauriFetchMock = vi.fn(async () => new Response('tauri-ok', { status: 200 }));
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: tauriFetchMock,
        }));
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch(new URL('file:///tmp/happier-transfer.bin'));

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        expect(tauriFetchMock).not.toHaveBeenCalled();
    });

    it('falls back to global fetch when tauri-plugin-http cannot be loaded', async () => {
        vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
        const globalFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => {
            throw new Error('plugin unavailable');
        });
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch, readRuntimeFetchHost } = await import('./runtimeFetch');
        expect(await readRuntimeFetchHost('https://api.example.test/v1/features')).toBe('browser');
        await runtimeFetch('https://api.example.test/v1/features');

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
    });
});
