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
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /v1/version
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /health
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // /v1/auth/ping

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: async () => 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(3);

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

    it('returns server_unreachable when /v1/version is non-200 and does not proceed', async () => {
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 500 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'server_unreachable',
                errorMessage: expect.stringContaining('Version probe returned'),
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns retry_later when /health responds with 429 and parses Retry-After seconds', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /v1/version
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
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns auth_failed when authenticated probe is rejected', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /v1/version
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
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /v1/version
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // /health
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 })); // would be /v1/auth/ping

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: () => null,
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    });

    it('sanitizes error messages from runtimeFetch failures', async () => {
        runtimeFetchMock.mockRejectedValueOnce(
            new Error('Failed to fetch https://admin:secret@custom.example.test:9443/path/?token=abc#frag (Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)'),
        );

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
    });
});
