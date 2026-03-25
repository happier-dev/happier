import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
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
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
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

  it('registerPushToken uses fetch for explicit endpoints when retry is disabled', async () => {
    const { registerPushToken } = await import('./apiPush');
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true }));

    await registerPushToken(credentials, 'ExponentPushToken[abc]', { apiEndpoint: 'https://company.example.test', retry: 'none' });

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://company.example.test/v1/push-tokens',
            expect.objectContaining({ method: 'POST' }),
    );
    expect(mocks.serverFetch).not.toHaveBeenCalled();
  });

  it('registerPushToken treats 204 No Content as success', async () => {
    const { registerPushToken } = await import('./apiPush');
    mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' })).resolves.toBeUndefined();
  });

  it('registerPushToken treats 200 with empty body as success', async () => {
    const { registerPushToken } = await import('./apiPush');
    mocks.serverFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' })).resolves.toBeUndefined();
  });

  it('registerPushToken fails with a controlled error when response JSON is malformed', async () => {
    const { registerPushToken } = await import('./apiPush');
    mocks.serverFetch.mockResolvedValueOnce(new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
        }));

        await expect(registerPushToken(credentials, 'ExponentPushToken[abc]', { retry: 'none' })).rejects.toThrow('Failed to register push token');
    });
});
