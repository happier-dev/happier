import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    createServerFetchAtEndpoint: vi.fn(),
    endpointFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
    createServerFetchAtEndpoint: mocks.createServerFetchAtEndpoint,
}));

import { authApproveAtEndpoint } from './approve';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('authApproveAtEndpoint explicit target', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.endpointFetch.mockReset();
        mocks.createServerFetchAtEndpoint.mockReset();
        mocks.createServerFetchAtEndpoint.mockImplementation(() => mocks.endpointFetch);
    });

    it('refuses approval when the requesting client is cancelled during the status read', async () => {
        const controller = new AbortController();
        mocks.endpointFetch.mockImplementationOnce(async () => {
            controller.abort();
            return jsonResponse({ status: 'pending', supportsV2: true });
        });
        await expect(authApproveAtEndpoint(Object.assign({ endpointUrl: 'https://requester-home.test',
            token: 'requester-bearer', publicKeyBase64: 'guest-public-key', responseBase64: 'sealed-requester-response',
            responseKind: 'tokenOnly' as const }, { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.endpointFetch.mock.calls.map(([path]) => String(path).split('?')[0])).toEqual(['/v1/auth/request/status']);
    });

    it.each([
        { responseKind: 'tokenOnly' as const, responseBase64: 'opaque-response-b64' },
        // The declared kind is forwarded, never hard-coded to tokenOnly.
        { responseKind: 'dataKey' as const, responseBase64: 'opaque-datakey-response-b64' },
    ])('posts the $responseKind response to the explicit endpoint with the supplied token and no focused-Home use', async ({ responseKind, responseBase64 }) => {
        mocks.endpointFetch
            .mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }))
            .mockResolvedValueOnce(jsonResponse({ success: true }));

        await expect(authApproveAtEndpoint({
            endpointUrl: 'http://127.0.0.1:3005',
            serverId: 'srv_home_b',
            token: 'home-b-bearer',
            publicKeyBase64: 'pub-key-b64',
            responseBase64,
            responseKind,
        })).resolves.toBe('approved');

        expect(mocks.createServerFetchAtEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'http://127.0.0.1:3005',
            serverId: 'srv_home_b',
        }));
        expect(mocks.serverFetch).not.toHaveBeenCalled();

        const statusCall = mocks.endpointFetch.mock.calls[0];
        expect(String(statusCall?.[0])).toContain('/v1/auth/request/status?publicKey=pub-key-b64');
        const postCall = mocks.endpointFetch.mock.calls[1];
        expect(postCall?.[0]).toBe('/v1/auth/response');
        const init = postCall?.[1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer home-b-bearer');
        expect(JSON.parse(String(init.body))).toEqual({
            publicKey: 'pub-key-b64',
            response: responseBase64,
            responseKind,
            authorizeUnattendedTeamAccess: true,
        });
        expect(postCall?.[2]).toMatchObject({ includeAuth: false });
    });

    it.each([
        { status: 'authorized', result: 'already_authorized' },
        { status: 'not_found', result: 'not_found' },
    ])('reports $result without posting when the request status is $status', async ({ status, result }) => {
        mocks.endpointFetch
            .mockResolvedValueOnce(jsonResponse({ status, supportsV2: true }));

        await expect(authApproveAtEndpoint({
            endpointUrl: 'http://127.0.0.1:3005',
            token: 'home-b-bearer',
            publicKeyBase64: 'pub-key-b64',
            responseBase64: 'opaque-response-b64',
            responseKind: 'tokenOnly',
        })).resolves.toBe(result);

        expect(mocks.endpointFetch.mock.calls.map(([path]) => String(path).split('?')[0])).toEqual(['/v1/auth/request/status']);
    });
});
