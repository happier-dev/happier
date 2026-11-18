import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    endpointFetch: vi.fn(),
}));

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import tweetnacl from 'tweetnacl';
import { sealTerminalProvisioningV3Payload, sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair } from './qrStart';

import { authApproveAtEndpoint } from './approve';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

let publicKey: Uint8Array;
let responses: Record<'tokenOnly' | 'dataKey', Uint8Array>;

describe('authApproveAtEndpoint explicit target', () => {
    beforeEach(() => {
        mocks.endpointFetch.mockReset();
        setRuntimeFetch(mocks.endpointFetch);
        publicKey = generateAuthKeyPair().publicKey;
        const createdAtMs = Date.now();
        const input = { terminalEphemeralPublicKey: publicKey, pairingSecret: new Uint8Array(32).fill(7),
            createdAtMs, expiresAtMs: createdAtMs + 60_000, randomBytes: tweetnacl.randomBytes };
        responses = { tokenOnly: sealTerminalProvisioningV3TokenOnlyPayload(input),
            dataKey: sealTerminalProvisioningV3Payload({ ...input, contentPrivateKey: new Uint8Array(32).fill(9) }) };
    });

    afterEach(() => resetRuntimeFetch());

    it('refuses approval when the requesting client is cancelled during the status read', async () => {
        const controller = new AbortController();
        mocks.endpointFetch.mockImplementationOnce(async () => {
            controller.abort();
            return jsonResponse({ status: 'pending', supportsV2: true });
        });
        await expect(authApproveAtEndpoint(Object.assign({ endpointUrl: 'https://requester-home.test',
            token: 'requester-bearer', publicKeyBase64: encodeBase64(publicKey), responseBase64: encodeBase64(responses.tokenOnly),
            responseKind: 'tokenOnly' as const }, { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.endpointFetch.mock.calls.map(([path]) => new URL(String(path)).pathname)).toEqual(['/v1/auth/request/status']);
    });

    it.each(['tokenOnly', 'dataKey'] as const)('posts the %s response to the explicit endpoint with the supplied token', async (responseKind) => {
        const responseBase64 = encodeBase64(responses[responseKind]);
        mocks.endpointFetch
            .mockResolvedValueOnce(jsonResponse({ status: 'pending', supportsV2: true }))
            .mockResolvedValueOnce(jsonResponse({ success: true }));

        await expect(authApproveAtEndpoint({
            endpointUrl: 'http://127.0.0.1:3005',
            serverId: 'srv_home_b',
            token: 'home-b-bearer',
            publicKeyBase64: encodeBase64(publicKey),
            responseBase64,
            responseKind,
        })).resolves.toBe('approved');

        const statusCall = mocks.endpointFetch.mock.calls[0];
        expect(new URL(String(statusCall?.[0])).searchParams.get('publicKey')).toBe(encodeBase64(publicKey));
        const postCall = mocks.endpointFetch.mock.calls[1];
        expect(postCall?.[0]).toBe('http://127.0.0.1:3005/v1/auth/response');
        const init = postCall?.[1] as RequestInit;
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer home-b-bearer');
        expect(JSON.parse(String(init.body))).toEqual({
            publicKey: encodeBase64(publicKey),
            response: responseBase64,
            responseKind,
            authorizeUnattendedTeamAccess: true,
        });
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
            publicKeyBase64: encodeBase64(publicKey),
            responseBase64: encodeBase64(responses.tokenOnly),
            responseKind: 'tokenOnly',
        })).resolves.toBe(result);

        expect(mocks.endpointFetch.mock.calls.map(([path]) => new URL(String(path)).pathname)).toEqual(['/v1/auth/request/status']);
    });
});
