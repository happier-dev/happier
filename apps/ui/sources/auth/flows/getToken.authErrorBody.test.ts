import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

import { authGetToken, AuthTokenRequestError } from './getToken';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function readyFeaturesResponse(): Response {
    return jsonResponse({
        features: {
            auth: { login: { keyChallenge: { enabled: true } } },
            sharing: { contentKeys: { enabled: false } },
        },
        capabilities: {},
    });
}

describe('authGetToken auth error body', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        mocks.serverFetch.mockReset();
    });

    it('surfaces the typed signup-disabled error code from a 403 body', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(readyFeaturesResponse())
            .mockResolvedValueOnce(jsonResponse({ error: 'signup-disabled' }, 403));

        const failure = await authGetToken(new Uint8Array(32)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(AuthTokenRequestError);
        const typed = failure as AuthTokenRequestError;
        expect(typed.status).toBe(403);
        expect(typed.code).toBe('signup-disabled');
    });

    it('still fails with a null code when the error body is not JSON', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(readyFeaturesResponse())
            .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

        const failure = await authGetToken(new Uint8Array(32)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(AuthTokenRequestError);
        const typed = failure as AuthTokenRequestError;
        expect(typed.status).toBe(500);
        expect(typed.code).toBeNull();
    });
});
