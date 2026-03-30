import { describe, expect, it } from 'vitest';

import { getRandomBytes } from '@/platform/cryptoRandom';

import { AES256Encryption, BoxEncryption, SecretBoxEncryption } from './encryptor';

describe('encryptor top-level undefined handling', () => {
    it('preserves undefined for secret-box encryption', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));

        const encrypted = await encryptor.encrypt([undefined]);
        const decrypted = await encryptor.decrypt(encrypted);

        expect(decrypted).toEqual([undefined]);
    });

    it('preserves undefined for box encryption', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));

        const encrypted = await encryptor.encrypt([undefined]);
        const decrypted = await encryptor.decrypt(encrypted);

        expect(decrypted).toEqual([undefined]);
    });

    it('preserves undefined for aes-256 encryption', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));

        const encrypted = await encryptor.encrypt([undefined]);
        const decrypted = await encryptor.decrypt(encrypted);

        expect(decrypted).toEqual([undefined]);
    });
});
