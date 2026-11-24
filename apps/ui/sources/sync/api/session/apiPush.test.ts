import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
        runtimeFetchWithServerReachability: vi.fn(),
        android: false,
        notificationCategoriesModule: null as { androidActionPresentationV1?: boolean } | null,
    };
});

vi.mock('react-native', async (importOriginal) => {
    const native = await importOriginal<typeof import('react-native')>();
    return {
        ...native,
        Platform: { ...native.Platform, get OS() { return mocks.android ? 'android' : 'ios'; } },
    };
});

vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'ExpoNotificationCategoriesModule' ? mocks.notificationCategoriesModule : null,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mocks.runtimeFetchWithServerReachability,
}));

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('apiPush', () => {
    const credentials = { token: 't', secret: 's' } satisfies AuthCredentials;
    const fetchSpy = vi.fn();

    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.runtimeFetchWithServerReachability.mockReset();
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        mocks.android = false;
        mocks.notificationCategoriesModule = null;
    });

    it('advertises action presentation only when the Android binary actually supports it', async () => {
        const { registerPushToken } = await import('./apiPush');
        const token = 'ExponentPushToken[android]';
        mocks.serverFetch.mockImplementation(async () => jsonResponse({ success: true }));
        mocks.android = true;
        await registerPushToken(credentials, token, { retry: 'none' });
        mocks.notificationCategoriesModule = { androidActionPresentationV1: true };
        await registerPushToken(credentials, token, { retry: 'none' });
        mocks.android = false;
        await registerPushToken(credentials, token, { retry: 'none' });

        expect(mocks.serverFetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
            { token },
            { token, androidActionPresentationV1: true },
            { token },
        ]);
    });

    it('fetchPushTokens parses a successful response', async () => {
        const { fetchPushTokens } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
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
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid' }, 401));

        await expect(fetchPushTokens(credentials)).rejects.toBeInstanceOf(HappyError);
    });

    it('deletePushToken url-encodes the token in the path', async () => {
        const { deletePushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

        await deletePushToken(credentials, 'ExponentPushToken[a/b]');

        expect(mocks.serverFetch).toHaveBeenCalledWith(
            expect.stringContaining('/v1/push-tokens/ExponentPushToken%5Ba%2Fb%5D'),
            expect.any(Object),
            expect.any(Object),
        );
    });

    it('deletePushToken treats 200 with empty body as success', async () => {
        const { deletePushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(deletePushToken(credentials, 'ExponentPushToken[abc]')).resolves.toBeUndefined();
    });

    it('deletePushToken treats 204 No Content as success', async () => {
        const { deletePushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(deletePushToken(credentials, 'ExponentPushToken[abc]')).resolves.toBeUndefined();
    });

    it('deletePushToken omits the json content-type header on body-less delete requests', async () => {
        const { deletePushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

        await deletePushToken(credentials, 'ExponentPushToken[abc]');

        const init = mocks.serverFetch.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = init?.headers as Record<string, string> | undefined;
        expect(init?.method).toBe('DELETE');
        expect(init?.body).toBeUndefined();
        expect(headers).toEqual(expect.objectContaining({
            Authorization: `Bearer ${credentials.token}`,
        }));
        expect(headers).not.toHaveProperty('Content-Type');
    });

    it('registerPushToken uses reachability-supervised runtime fetch for explicit endpoints when retry is disabled', async () => {
        const { registerPushToken } = await import('./apiPush');
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(jsonResponse({ success: true }));

        await registerPushToken(credentials, 'ExponentPushToken[abc]', {
            apiEndpoint: 'https://company.example.test',
            retry: 'none',
        });

        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledWith(
            expect.objectContaining({
                serverUrl: 'https://company.example.test',
                token: credentials.token,
                url: 'https://company.example.test/v1/push-tokens',
                init: expect.objectContaining({ method: 'POST' }),
            }),
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('registerPushToken treats 204 No Content as success', async () => {
        const { registerPushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(
            registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' }),
        ).resolves.toBeUndefined();
    });

    it('registerPushToken treats 200 with empty body as success', async () => {
        const { registerPushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(
            registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' }),
        ).resolves.toBeUndefined();
    });

    it('registerPushToken fails with a controlled error when response JSON is malformed', async () => {
        const { registerPushToken } = await import('./apiPush');
        mocks.serverFetch.mockResolvedValueOnce(new Response('null', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(
            registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' }),
        ).rejects.toThrow('Failed to register push token');
    });
});
