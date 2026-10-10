import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('apiPush', () => {
    const credentials = { token: 't', secret: 's' } satisfies AuthCredentials;
    const fetchBoundary = vi.fn<typeof fetch>();

    beforeEach(async () => {
        vi.resetModules();
        fetchBoundary.mockReset();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://selected.example.test' });
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
            return await fetchBoundary(input, init);
        });
    });

    afterEach(async () => {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        vi.unstubAllGlobals();
    });

    it('fetchPushTokens parses a successful response', async () => {
        const { fetchPushTokens } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(jsonResponse({
            tokens: [
                { id: 't1', token: 'ExponentPushToken[current]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
            ],
        }));

        const tokens = await fetchPushTokens(credentials);
        expect(tokens).toEqual([
            { id: 't1', token: 'ExponentPushToken[current]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
        ]);
    });

    it('fetchPushTokens throws a typed error on non-retryable 4xx', async () => {
        const { fetchPushTokens } = await import('./apiPush');
        const { HappyError } = await import('@/utils/errors/errors');
        fetchBoundary.mockResolvedValueOnce(jsonResponse({ error: 'invalid' }, 401));

        await expect(fetchPushTokens(credentials)).rejects.toBeInstanceOf(HappyError);
    });

    it('deletePushToken url-encodes the token in the path', async () => {
        const { deletePushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true }));

        await deletePushToken(credentials, 'ExponentPushToken[a/b]');

        expect(fetchBoundary).toHaveBeenCalledWith(
            expect.stringContaining('/v1/push-tokens/ExponentPushToken%5Ba%2Fb%5D'),
            expect.any(Object),
        );
    });

    it('deletePushToken does not send JSON content type without a request body', async () => {
        const { deletePushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true }));

        await deletePushToken(credentials, 'ExponentPushToken[abc]');

        const init = fetchBoundary.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('Content-Type')).toBeNull();
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
    });

    it('deletePushToken treats 200 with empty body as success', async () => {
        const { deletePushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(deletePushToken(credentials, 'ExponentPushToken[abc]')).resolves.toBeUndefined();
    });

    it('deletePushToken treats 204 No Content as success', async () => {
        const { deletePushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(deletePushToken(credentials, 'ExponentPushToken[abc]')).resolves.toBeUndefined();
    });

    it('registerPushToken uses reachability-supervised runtime fetch for explicit endpoints when retry is disabled', async () => {
        const { registerPushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true }));

        await registerPushToken(credentials, 'ExponentPushToken[abc]', {
            apiEndpoint: 'https://company.example.test',
            retry: 'none',
        });

        expect(fetchBoundary).toHaveBeenCalledTimes(1);
        expect(fetchBoundary).toHaveBeenCalledWith(
            'https://company.example.test/v1/push-tokens',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(new Headers(fetchBoundary.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer t');
        expect(fetchBoundary.mock.calls.some(([input]) => String(input).startsWith('https://selected.example.test'))).toBe(false);
    });

    it('registerPushToken sends bytes to the verified runtime origin while retaining the canonical Home key', async () => {
        const { registerPushToken } = await import('./apiPush');
        const { subscribeServerReachabilityState, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        onTestFinished(subscribeServerReachabilityState('https://home.example.test', () => {}, credentials.token));
        fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true }));

        await registerPushToken(credentials, 'ExponentPushToken[abc]', {
            apiEndpoint: 'https://home.example.test',
            runtimeOrigin: 'http://127.0.0.1:45991',
            clientServerUrl: 'https://home.example.test',
            retry: 'none',
        });

        expect(fetchBoundary).toHaveBeenCalledWith(
            'http://127.0.0.1:45991/v1/push-tokens',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ token: 'ExponentPushToken[abc]', clientServerUrl: 'https://home.example.test' }),
            }),
        );
        expect(peekServerReachabilityState('https://home.example.test', credentials.token)?.phase).toBe('online');
    });

    it('deletePushToken sends bytes to the verified runtime origin while retaining the canonical Home key', async () => {
        const { deletePushToken } = await import('./apiPush');
        const { subscribeServerReachabilityState, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        onTestFinished(subscribeServerReachabilityState('https://home.example.test', () => {}, credentials.token));
        fetchBoundary.mockResolvedValueOnce(jsonResponse({ success: true }));

        await deletePushToken(credentials, 'ExponentPushToken[abc]', {
            apiEndpoint: 'https://home.example.test',
            runtimeOrigin: 'http://127.0.0.1:45991',
        });

        expect(fetchBoundary).toHaveBeenCalledWith(
            'http://127.0.0.1:45991/v1/push-tokens/ExponentPushToken%5Babc%5D',
            expect.objectContaining({ method: 'DELETE' }),
        );
        expect(peekServerReachabilityState('https://home.example.test', credentials.token)?.phase).toBe('online');
    });

    it('registerPushToken treats 204 No Content as success', async () => {
        const { registerPushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(
            registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' }),
        ).resolves.toBeUndefined();
    });

    it('registerPushToken treats 200 with empty body as success', async () => {
        const { registerPushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(
            registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' }),
        ).resolves.toBeUndefined();
    });

    it('registerPushToken fails with a controlled error when response JSON is malformed', async () => {
        const { registerPushToken } = await import('./apiPush');
        fetchBoundary.mockResolvedValueOnce(new Response('null', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(
            registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' }),
        ).rejects.toThrow('Failed to register push token');
    });
});
