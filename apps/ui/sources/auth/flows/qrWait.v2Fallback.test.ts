import { beforeAll, describe, expect, it, vi } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { generateAuthKeyPair } from './qrStart';
import { authQRWait } from './qrWait';
import { serverFetch } from '@/sync/http/client';

vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(),
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
        const expectedSecret = new Uint8Array([1, 2, 3, 4]);

        const tokenEncrypted = encodeBase64(encryptBox(new TextEncoder().encode(expectedToken), keypair.publicKey));
        const responseEncrypted = encodeBase64(encryptBox(expectedSecret, keypair.publicKey));

        const fetchMock = vi.mocked(serverFetch);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(
            makeJsonResponse(200, { state: 'authorized', tokenEncrypted, response: responseEncrypted }) as any,
        );

        const out = await authQRWait(keypair);
        expect(out?.token).toBe(expectedToken);
        expect(out?.secret).toEqual(expectedSecret);
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/v2/auth/account/request');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to /v1/auth/account/request when /v2 is missing', async () => {
        const keypair = generateAuthKeyPair();
        const expectedToken = 'tkn-test-2';
        const expectedSecret = new Uint8Array([9, 8, 7]);

        const responseEncrypted = encodeBase64(encryptBox(expectedSecret, keypair.publicKey));

        const fetchMock = vi.mocked(serverFetch);
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(makeJsonResponse(404, { error: 'Not Found' }) as any);
        fetchMock.mockResolvedValueOnce(
            makeJsonResponse(200, { state: 'authorized', token: expectedToken, response: responseEncrypted }) as any,
        );

        const out = await authQRWait(keypair);
        expect(out?.token).toBe(expectedToken);
        expect(out?.secret).toEqual(expectedSecret);
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
            '/v2/auth/account/request',
            '/v1/auth/account/request',
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
