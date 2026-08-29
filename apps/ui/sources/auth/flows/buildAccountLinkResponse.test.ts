import { beforeAll, describe, expect, it } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { decryptBox } from '@/encryption/libsodium';
import { generateAuthKeyPair } from './qrStart';
import { buildAccountLinkResponse } from './buildAccountLinkResponse';

describe('buildAccountLinkResponse', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it('builds a token-only response for plaintext credentials', () => {
        const recipient = generateAuthKeyPair();
        const encrypted = buildAccountLinkResponse({ token: 'home-token' }, recipient.publicKey);
        const plaintext = decryptBox(encrypted, recipient.secretKey);
        expect(plaintext && new TextDecoder().decode(plaintext)).toBe('{"type":"tokenOnly"}');
    });

    it('preserves data-key material as a typed response', () => {
        const recipient = generateAuthKeyPair();
        const encrypted = buildAccountLinkResponse({
            token: 'home-token',
            encryption: { publicKey: 'pub', machineKey: 'machine' },
        }, recipient.publicKey);
        const plaintext = decryptBox(encrypted, recipient.secretKey);
        expect(plaintext && JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
            type: 'dataKey',
            publicKey: 'pub',
            machineKey: 'machine',
        });
    });
});
