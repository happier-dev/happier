const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/http/client', () => ({ serverFetch: (...args: unknown[]) => network.request(...args) }));
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { decryptBox, encryptBox } from '@/encryption/libsodium';
import sodium from '@/encryption/libsodium.lib';
import { buildAccountLinkResponse, openAccountLinkResponse } from './buildAccountLinkResponse';

describe('account link credential variants', () => {
    beforeAll(async () => { await sodium.ready; });
    beforeEach(() => { network.request.mockReset(); network.request.mockImplementation(async () => new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 })); });
    const recipient = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
    const legacy: AuthCredentials = { token: 'token', secret: encodeBase64(new Uint8Array(32).fill(5), 'base64url') };
    const dataKey: AuthCredentials = {
        token: 'token', encryption: {
            publicKey: encodeBase64(new Uint8Array(32).fill(6)),
            machineKey: encodeBase64(new Uint8Array(32).fill(7)),
        },
    };

    it('refuses exporting stale same-Account data-key credentials through Account QR linking', async () => {
        const accountId = 'same-account';
        const token = `h.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.s`;
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
        const content = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(13)).publicKey;
        const prefix = new TextEncoder().encode('Happy content key v1\u0000');
        const message = new Uint8Array(prefix.length + content.length);
        message.set(prefix); message.set(content, prefix.length);
        network.request.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path.endsWith('/v1/account/encryption') ? { mode: 'e2ee', updatedAt: 2 } : { user: {
                id: accountId, firstName: '', lastName: null, avatar: null, username: '', bio: null, status: 'none',
                publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(content),
                contentPublicKeySig: encodeBase64(tweetnacl.sign.detached(message, signing.secretKey)),
            } }), { status: 200 }));
        await expect(buildAccountLinkResponse({ ...dataKey, token }, recipient.publicKey, { supportsCredentialVariants: true }))
            .rejects.toMatchObject({ code: 'account_key_provisioning_unavailable' });
    });

    it('preserves exact legacy and data-key credentials and explicit absence of keys for new readers', async () => {
        for (const credentials of [legacy, dataKey, { token: 'token' }]) {
            const payload = await buildAccountLinkResponse(credentials, recipient.publicKey, { supportsCredentialVariants: true });
            expect(openAccountLinkResponse(payload, recipient.secretKey, 'token')).toEqual(credentials);
        }
    });

    it('keeps released raw legacy responses but refuses to mislabel data-key or keyless accounts', async () => {
        const payload = await buildAccountLinkResponse(legacy, recipient.publicKey);
        expect(decryptBox(payload, recipient.secretKey)).toEqual(new Uint8Array(32).fill(5));
        expect(openAccountLinkResponse(payload, recipient.secretKey, 'token')).toEqual(legacy);
        await expect(buildAccountLinkResponse(dataKey, recipient.publicKey)).rejects.toThrow();
        await expect(buildAccountLinkResponse({ token: 'token' }, recipient.publicKey)).rejects.toThrow();
        expect(openAccountLinkResponse(encryptBox(new Uint8Array([1, 2, 3]), recipient.publicKey), recipient.secretKey, 'token')).toBeNull();
    });
});
