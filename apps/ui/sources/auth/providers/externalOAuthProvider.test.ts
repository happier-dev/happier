import { afterEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import { createExternalOAuthProvider } from './externalOAuthProvider';

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://api.example.test',
}));

vi.mock('@/utils/timing/time', () => ({
    backoff: async <T>(fn: () => Promise<T>) => await fn(),
}));

type MockFetchResponse = {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
};

function jsonResponse(params: { ok: boolean; status: number; body: unknown }): MockFetchResponse {
    return {
        ok: params.ok,
        status: params.status,
        json: async () => params.body,
    };
}

function stubFetch(
    handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: unknown }>,
) {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
        const result = await handler(String(input), init);
        return jsonResponse(result) as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function createProvider() {
    return createExternalOAuthProvider({
        id: 'github',
        displayName: 'GitHub',
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('createExternalOAuthProvider', () => {
    it('returns the external signup URL when params endpoint is successful', async () => {
        stubFetch(async () => ({
            ok: true,
            status: 200,
            body: { url: 'https://oauth.example.test/signup' },
        }));

        const provider = createProvider();
        await expect(provider.getExternalSignupUrl({ publicKey: 'pk' })).resolves.toBe(
            'https://oauth.example.test/signup',
        );
    });

    it('returns the external keyless login URL when params endpoint is successful', async () => {
        let capturedUrl: string | null = null;
        stubFetch(async (url) => {
            capturedUrl = url;
            return {
                ok: true,
                status: 200,
                body: { url: 'https://oauth.example.test/login' },
            };
        });

        const provider = createProvider();
        expect(provider.getExternalLoginUrl).toBeDefined();
        await expect(provider.getExternalLoginUrl!({ proofHash: 'abc123' })).resolves.toBe(
            'https://oauth.example.test/login',
        );
        expect(capturedUrl).toContain('/v1/auth/external/github/params');
        expect(capturedUrl).toContain('mode=keyless');
        expect(capturedUrl).toContain('proofHash=abc123');
    });

    it('throws config HappyError when external OAuth is not configured', async () => {
        stubFetch(async () => ({
            ok: false,
            status: 400,
            body: { error: 'oauth_not_configured' },
        }));

        const provider = createProvider();
        await expect(provider.getExternalSignupUrl({ publicKey: 'pk' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind: 'config',
                status: 400,
                canTryAgain: false,
            } satisfies Partial<HappyError>),
        );
    });

    it('throws for successful signup response payloads missing a URL', async () => {
        stubFetch(async () => ({ ok: true, status: 200, body: { url: '' } }));

        const provider = createProvider();
        await expect(provider.getExternalSignupUrl({ publicKey: 'pk' })).rejects.toThrow('external-signup-unavailable');
    });

    it('maps connect params 400 failures into config HappyError payloads', async () => {
        stubFetch(async () => ({
            ok: false,
            status: 400,
            body: { error: 'provider_disabled' },
        }));

        const provider = createProvider();
        await expect(provider.getConnectUrl({ token: 't', secret: 's' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind: 'config',
                status: 400,
                message: 'provider_disabled',
            } satisfies Partial<HappyError>),
        );
    });

    it('maps connect params 401 failures into auth HappyError payloads', async () => {
        stubFetch(async () => ({
            ok: false,
            status: 401,
            body: { error: 'unauthorized' },
        }));

        const provider = createProvider();
        await expect(provider.getConnectUrl({ token: 't', secret: 's' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind: 'auth',
                status: 401,
                message: 'unauthorized',
            } satisfies Partial<HappyError>),
        );
    });

    it.each([
        { status: 409, error: 'username-taken', expectedMessage: 'username-taken' },
        { status: 409, error: 'provider-already-linked', expectedMessage: 'provider-already-linked' },
        { status: 400, error: 'invalid-username', expectedMessage: 'invalid-username' },
    ])(
        'maps finalize failures to HappyError for status=$status error=$error',
        async ({ status, error, expectedMessage }) => {
            stubFetch(async () => ({
                ok: false,
                status,
                body: { error },
            }));

            const provider = createProvider();
            await expect(
                provider.finalizeConnect({ token: 't', secret: 's' }, { pending: 'pending-1', username: 'octocat' }),
            ).rejects.toEqual(
                expect.objectContaining({
                    name: 'HappyError',
                    kind: 'auth',
                    status,
                    message: expectedMessage,
                } satisfies Partial<HappyError>),
            );
        },
    );

    it.each([
        { status: 404, error: 'not-connected', kind: 'config' as const },
        { status: 403, error: 'forbidden', kind: 'auth' as const },
    ])('maps disconnect status=$status failures into HappyError kind=$kind', async ({ status, error, kind }) => {
        stubFetch(async () => ({
            ok: false,
            status,
            body: { error },
        }));

        const provider = createProvider();
        await expect(provider.disconnect({ token: 't', secret: 's' })).rejects.toEqual(
            expect.objectContaining({
                name: 'HappyError',
                kind,
                status,
                message: error,
            } satisfies Partial<HappyError>),
        );
    });
});
