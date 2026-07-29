import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            get currentState() {
                                return appState.currentState;
                            },
                        },
                    }
    );
});

describe('createEndpointReadinessProbe', () => {
    afterEach(() => {
        runtimeFetchMock.mockReset();
        appState.currentState = 'active';
        vi.resetModules();
        vi.useRealTimers();
    });

    it('uses an async token resolver when provided', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /health
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // /v1/auth/ping

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: async () => 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);

        const lastCall = runtimeFetchMock.mock.calls.at(-1);
        const init = lastCall?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer token-1');
    });

    it('skips network probes when the app is backgrounded', async () => {
        appState.currentState = 'background';
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'retry_later' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
    });

    it('skips network probes when the runtime tab is hidden (web)', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        try {
            globalWithDocument.document = { visibilityState: 'hidden' };

            runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

            const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
            const probe = createEndpointReadinessProbe({
                endpoint: 'https://server.example.test',
                token: 'token-1',
                timeoutMs: 50,
            });

            await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'retry_later' }));
            expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('fails closed without network calls when the endpoint URL is invalid', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'localhost:3000',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'server_unreachable',
                errorMessage: expect.stringContaining('Invalid endpoint'),
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
    });

    it('strips username/password userinfo from the endpoint before probing', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /health
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // /v1/auth/ping

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://user:pass@server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
        expect(runtimeFetchMock.mock.calls[0]?.[0]).toBe('https://server.example.test/health');
    });

    it('returns server_unreachable when readiness probes are non-ok', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 404 })); // /health

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'server_unreachable',
                errorMessage: expect.stringContaining('Readiness probe returned 404'),
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns server_unreachable when /health is missing', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 404 })); // /health

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: null,
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'server_unreachable' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns retry_later when /health responds with 429 and parses Retry-After seconds', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 429, headers: { 'Retry-After': '2' } })); // /health

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'retry_later',
                retryAfterMs: 2000,
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('marks proxy maintenance 503 responses as planned server restarts', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response('Server reload in progress\n', {
                status: 503,
                headers: {
                    'Retry-After': '2',
                    'X-Happier-Retry-Reason': 'server_restarting',
                },
            })); // /health

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'retry_later',
                retryAfterMs: 2000,
                reason: 'server_restarting',
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns auth_failed when authenticated probe is rejected', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /health
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 })); // /v1/auth/ping

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'auth_failed',
                statusCode: 401,
                }),
        );

        const lastCall = runtimeFetchMock.mock.calls.at(-1);
        const init = lastCall?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer token-1');
    });

    it('skips the authenticated probe when the token resolver returns null', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /health
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 })); // would be /v1/auth/ping

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: () => null,
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns retry_later when the browser blocks mixed-content (https app → http endpoint)', async () => {
        const globalWithLocation = globalThis as unknown as { location?: { protocol?: string } };
        const originalLocation = globalWithLocation.location;
        try {
            globalWithLocation.location = { protocol: 'https:' };

            const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
            const probe = createEndpointReadinessProbe({
                endpoint: 'http://server.example.test',
                token: null,
                timeoutMs: 50,
            });

            await expect(probe()).resolves.toEqual(
                expect.objectContaining({
                    status: 'retry_later',
                    errorMessage: expect.stringContaining('mixed content'),
                }),
            );
            expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
        } finally {
            globalWithLocation.location = originalLocation;
        }
    });

    it('strips userinfo credentials from probe URLs before issuing network calls', async () => {
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // /health

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://admin:secret@custom.example.test:9443/base?token=abc#frag',
            token: null,
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        expect(runtimeFetchMock.mock.calls[0]?.[0]).toBe('https://custom.example.test:9443/base/health');
    });

    it('sanitizes error messages from runtimeFetch failures', async () => {
        runtimeFetchMock
            .mockRejectedValueOnce(
                new Error('Failed to fetch https://admin:secret@custom.example.test:9443/path/?token=abc#frag (Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)'),
            )
            ;

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://admin:secret@custom.example.test:9443/path/?token=abc#frag',
            token: 'token-1',
            timeoutMs: 50,
        });

        const result = await probe();
        expect(result.status).toBe('server_unreachable');
        if (result.status !== 'server_unreachable') {
            throw new Error('Expected server_unreachable');
        }
        expect(result.errorMessage).toContain('https://custom.example.test:9443/path');
        expect(result.errorMessage).not.toContain('admin:secret@');
        expect(result.errorMessage).not.toContain('token=abc');
        expect(result.errorMessage).toContain('Bearer [REDACTED]');
        expect(result.errorMessage).not.toContain('hdr.eyJ');
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });
});
