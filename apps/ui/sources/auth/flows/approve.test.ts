import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

import { authApprove, AuthApproveUnsupportedResponseError } from './approve';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('authApprove', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
    });

    it('requires an explicit new-reader capability before releasing a token-only response', async () => {
        const tokenOnly = new Uint8Array([1, 2, 3]);
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        await expect(authApprove('token', new Uint8Array(32), new Uint8Array(), new Uint8Array(), {
            answerTokenOnly: tokenOnly,
        })).rejects.toBeInstanceOf(AuthApproveUnsupportedResponseError);
        expect(mocks.serverFetch.mock.calls.some(([path]) => path === '/v1/auth/response')).toBe(false);

        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true, supportsTokenOnly: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
        await expect(authApprove('token', new Uint8Array(32), new Uint8Array(), new Uint8Array(), {
            answerTokenOnly: tokenOnly,
        })).resolves.toBe('approved');
        const posted = mocks.serverFetch.mock.calls.at(-1)?.[1] as RequestInit;
        expect(JSON.parse(String(posted.body)).response).toBe(encodeBase64(tokenOnly));
    });

    it('falls back to v1 response when server supports v2 but caller has no v2 payload', async () => {
        const token = 'token';
        const publicKey = new Uint8Array([1, 2, 3, 4]);
        const answerV1 = new Uint8Array([9, 8, 7]);
        const answerV2 = new Uint8Array();

        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        await authApprove(token, publicKey, answerV1, answerV2);

        const secondCall = mocks.serverFetch.mock.calls.at(-1);
        expect(secondCall?.[0]).toBe('/v1/auth/response');
        const init = secondCall?.[1] as RequestInit | undefined;
        expect(typeof init?.body).toBe('string');
        const parsed = JSON.parse(String(init?.body)) as { response?: unknown };
        expect(parsed.response).toBe(encodeBase64(answerV1));
    });

    it('uses v2 response when server supports v2 and caller provides a v2 payload', async () => {
        const token = 'token';
        const publicKey = new Uint8Array([1, 2, 3, 4]);
        const answerV1 = new Uint8Array([9, 8, 7]);
        const answerV2 = new Uint8Array([5, 6]);

        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        await authApprove(token, publicKey, answerV1, answerV2);

        const secondCall = mocks.serverFetch.mock.calls.at(-1);
        const init = secondCall?.[1] as RequestInit | undefined;
        const parsed = JSON.parse(String(init?.body)) as { response?: unknown };
        expect(parsed.response).toBe(encodeBase64(answerV2));
    });

    it('addresses both requests at the explicit endpoint when one is given', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        await authApprove('token', new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([5, 6]), {
            endpointUrl: 'https://relay.example.test/',
        });

        const requestedPaths = mocks.serverFetch.mock.calls.map((call) => String(call[0]));
        expect(requestedPaths[0]).toMatch(/^https:\/\/relay\.example\.test\/v1\/auth\/request\/status\?publicKey=/);
        expect(requestedPaths[1]).toBe('https://relay.example.test/v1/auth/response');
    });

    it('supports lazy v1 payloads when v2 is unavailable', async () => {
        const token = 'token';
        const publicKey = new Uint8Array([1, 2, 3, 4]);
        const answerV1 = vi.fn(() => new Uint8Array([9, 8, 7]));
        const answerV2 = new Uint8Array();

        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: false }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

        await authApprove(token, publicKey, answerV1, answerV2);

        expect(answerV1).toHaveBeenCalledTimes(1);
        const secondCall = mocks.serverFetch.mock.calls.at(-1);
        expect(secondCall?.[0]).toBe('/v1/auth/response');
        const init = secondCall?.[1] as RequestInit | undefined;
        const parsed = JSON.parse(String(init?.body)) as { response?: unknown };
        expect(parsed.response).toBe(encodeBase64(new Uint8Array([9, 8, 7])));
    });
});
