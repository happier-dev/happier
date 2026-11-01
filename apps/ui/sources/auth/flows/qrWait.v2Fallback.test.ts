import { beforeAll, describe, expect, it, vi } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { generateAuthKeyPair } from './qrStart';
import { authQRWait } from './qrWait';
import { serverFetch } from '@/sync/http/client';
import { buildAccountLinkResponse } from './buildAccountLinkResponse';

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    generation: 0,
}));

const setServerProfileIdentityForUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    setServerProfileIdentityForUrl: (...args: unknown[]) => setServerProfileIdentityForUrlMock(...args),
}));

type StubResponse = {
    ok: boolean;
    status: number;
    json: () => Promise<any>;
};

function makeJsonResponse(status: number, payload: any): StubResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}

describe('authQRWait v2 fallback', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it('uses /v2/auth/account/request when available', async () => {
        const keypair = generateAuthKeyPair();
        const expectedToken = 'tkn-test-1';
        const expectedSecret = new Uint8Array(32).fill(4);

        const tokenEncrypted = encodeBase64(encryptBox(new TextEncoder().encode(expectedToken), keypair.publicKey));
        const responseEncrypted = encodeBase64(encryptBox(expectedSecret, keypair.publicKey));

        const fetchMock = vi.mocked(serverFetch);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(
            makeJsonResponse(200, { state: 'authorized', tokenEncrypted, response: responseEncrypted }) as any,
        );

        const out = await authQRWait(keypair);
        expect(out?.token).toBe(expectedToken);
        expect(out).toEqual({ token: expectedToken, secret: encodeBase64(expectedSecret, 'base64url') });
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/v2/auth/account/request');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to /v1/auth/account/request when /v2 is missing', async () => {
        const keypair = generateAuthKeyPair();
        const expectedToken = 'tkn-test-2';
        const expectedSecret = new Uint8Array(32).fill(7);

        const responseEncrypted = encodeBase64(encryptBox(expectedSecret, keypair.publicKey));

        const fetchMock = vi.mocked(serverFetch);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(makeJsonResponse(404, { error: 'Not Found' }) as any);
        fetchMock.mockResolvedValueOnce(
            makeJsonResponse(200, { state: 'authorized', token: expectedToken, response: responseEncrypted }) as any,
        );

        const out = await authQRWait(keypair);
        expect(out?.token).toBe(expectedToken);
        expect(out).toEqual({ token: expectedToken, secret: encodeBase64(expectedSecret, 'base64url') });
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
            '/v2/auth/account/request',
            '/v1/auth/account/request',
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stores server identity from authorized auth responses', async () => {
        const keypair = generateAuthKeyPair();
        const expectedToken = 'tkn-test-identity';
        const expectedSecret = new Uint8Array(32).fill(6);
        const responseEncrypted = encodeBase64(encryptBox(expectedSecret, keypair.publicKey));

        setServerProfileIdentityForUrlMock.mockClear();
        const fetchMock = vi.mocked(serverFetch);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(
            makeJsonResponse(200, {
                state: 'authorized',
                token: expectedToken,
                response: responseEncrypted,
                serverIdentityId: 'srv_auth_identity',
            }) as any,
        );

        const out = await authQRWait(keypair);

        expect(out?.token).toBe(expectedToken);
        expect(setServerProfileIdentityForUrlMock).toHaveBeenCalledWith(
            'https://relay.example.test',
            'srv_auth_identity',
        );
    });

    it('preserves sealed data-key credentials and token-only variants through account polling', async () => {
        const keypair = generateAuthKeyPair();
        for (const credentials of [
            { token: 'keyless-token' },
            { token: 'keyed-token', encryption: {
                publicKey: encodeBase64(new Uint8Array(32).fill(1)),
                machineKey: encodeBase64(new Uint8Array(32).fill(2)),
            } },
        ]) {
            const fetchMock = vi.mocked(serverFetch);
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 }));
            const payload = await buildAccountLinkResponse(credentials, keypair.publicKey, { supportsCredentialVariants: true });
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                state: 'authorized', token: credentials.token, response: encodeBase64(payload),
            }), { status: 200 }));
            expect(await authQRWait(keypair)).toEqual(credentials);
        }
    });
});
