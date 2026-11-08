import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import { createEndpointReadinessProbe, readEndpointReadinessResultFromState } from './createEndpointReadinessProbe';
import {
    acquireServerReachabilitySupervisor,
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
} from './serverReachabilitySupervisorPool';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
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
    it('preserves a closed refusal in the endpoint readiness projection', () => {
        const failure = { code: 'credential_request_redirect_refused', retryable: false, status: 307 } as const;
        expect(readEndpointReadinessResultFromState({
            phase: 'offline', reason: 'server_unreachable', attempt: 1, nextRetryAt: null,
            lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: 'Request redirect refused', failure,
        })).toMatchObject({ status: 'server_unreachable', failure });
    });

    afterEach(async () => {
        await resetServerReachabilitySupervisors();
        runtimeFetchMock.mockReset();
        appState.currentState = 'active';
        vi.useRealTimers();
    });

    it('uses an async token resolver when provided', async () => {
        runtimeFetchMock
            .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: async () => 'token-1',
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);

        const lastCall = runtimeFetchMock.mock.calls.at(-1);
        const init = lastCall?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer token-1');
    });

    it('shares an in-flight Home probe and stays pending beyond the old endpoint deadline', async () => {
        vi.useFakeTimers();
        const response = createDeferred<Response>();
        runtimeFetchMock.mockReturnValue(response.promise);
        const leasePromise = acquireServerReachabilitySupervisor({ serverUrl: 'https://shared.example.test', token: 'token-1' });
        let settled = false;
        const result = createEndpointReadinessProbe({ endpoint: 'https://shared.example.test', token: 'token-1' })()
            .then((value) => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(1200);
        expect(settled).toBe(false);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        response.resolve(new Response('{}', { status: 200 }));
        await expect(result).resolves.toMatchObject({ status: 'ready' });
        await (await leasePromise).release();
    });

    it('cancels caller demand without turning shared Home reachability into an outage', async () => {
        vi.useFakeTimers();
        const response = createDeferred<Response>();
        runtimeFetchMock.mockReturnValue(response.promise);
        const leasePromise = acquireServerReachabilitySupervisor({ serverUrl: 'https://shared.example.test', token: 'token-1' });
        const controller = new AbortController();
        const result = createEndpointReadinessProbe({ endpoint: 'https://shared.example.test', token: 'token-1', signal: controller.signal })();
        const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejection;
        response.resolve(new Response('{}', { status: 200 }));
        const lease = await leasePromise;
        expect(peekServerReachabilityState('https://shared.example.test', 'token-1')?.phase).toBe('online');
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        await lease.release();
    });

    it('skips network probes when the app is backgrounded', async () => {
        appState.currentState = 'background';
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));


        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
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

            const probe = createEndpointReadinessProbe({
                endpoint: 'https://server.example.test',
                token: 'token-1',
            });

            await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'retry_later' }));
            expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('fails closed without network calls when the endpoint URL is invalid', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const probe = createEndpointReadinessProbe({
            endpoint: 'localhost:3000',
            token: 'token-1',
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'server_unreachable',
                errorMessage: expect.stringContaining('Invalid endpoint'),
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
    });

    it.each([
        { name: 'tokenless /health', token: null },
        { name: 'authenticated ping', token: 'token-1' },
    ])('returns server_unreachable when the $name probe is non-ok (404)', async ({ token }) => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 404 }));

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'server_unreachable' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: '429 with Retry-After',
            response: () => new Response(JSON.stringify({ ok: true }), { status: 429, headers: { 'Retry-After': '2' } }),
            expected: { status: 'retry_later', retryAfterMs: 2000 },
        },
        {
            name: 'proxy-maintenance 503 as a planned server restart',
            response: () => new Response('Server reload in progress\n', {
                status: 503,
                headers: { 'Retry-After': '2', 'X-Happier-Retry-Reason': 'server_restarting' },
            }),
            expected: { status: 'retry_later', retryAfterMs: 2000, reason: 'server_restarting' },
        },
    ])('maps $name to retry_later with the canonical retry schedule', async ({ response, expected }) => {
        vi.useFakeTimers();
        runtimeFetchMock.mockResolvedValueOnce(response());

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining(expected));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns auth_failed when authenticated probe is rejected', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 })); // /v1/auth/ping

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'auth_failed',
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

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: () => null,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns retry_later when the browser blocks mixed-content (https app → http endpoint)', async () => {
        const globalWithLocation = globalThis as unknown as { location?: { protocol?: string } };
        const originalLocation = globalWithLocation.location;
        try {
            globalWithLocation.location = { protocol: 'https:' };

            const probe = createEndpointReadinessProbe({
                endpoint: 'http://server.example.test',
                token: null,
            });

            await expect(probe()).resolves.toEqual(
                expect.objectContaining({
                    status: 'retry_later',
                    blockedBy: 'mixed_content',
                }),
            );
            expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
        } finally {
            globalWithLocation.location = originalLocation;
        }
    });

    it.each([
        { name: 'tokenless', token: null, url: 'https://custom.example.test:9443/base/health' },
        { name: 'authenticated', token: 'token-1', url: 'https://custom.example.test:9443/base/v1/auth/ping' },
    ])('strips userinfo/query/hash from $name probe URLs before issuing network calls', async ({ token, url }) => {
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://admin:secret@custom.example.test:9443/base?token=abc#frag',
            token,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        expect(runtimeFetchMock.mock.calls[0]?.[0]).toBe(url);
    });

    it('sanitizes error messages from runtimeFetch failures', async () => {
        runtimeFetchMock
            .mockRejectedValueOnce(
                new Error('Failed to fetch https://admin:secret@custom.example.test:9443/path/?token=abc#frag (Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)'),
            )
            ;

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://admin:secret@custom.example.test:9443/path/?token=abc#frag',
            token: 'token-1',
        });

        const result = await probe();
        expect(result.status).toBe('server_unreachable');
        if (result.status !== 'server_unreachable') {
            throw new Error('Expected server_unreachable');
        }
        // Redaction detail is owned by sanitizeEndpointErrorMessage.test.ts; this proves the probe applies it.
        expect(result.errorMessage).not.toContain('admin:secret@');
        expect(result.errorMessage).not.toContain('hdr.eyJ');
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });
});
