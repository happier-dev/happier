import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

describe('aes.web', () => {
    it('encrypts and decrypts large payloads without stack overflow', async () => {
        const { encryptAESGCMString, decryptAESGCMString } = await import('./aes.web');

        const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const keyB64 = encodeBase64(keyBytes, 'base64');

        const plaintext = 'a'.repeat(400_000);
        const encrypted = await encryptAESGCMString(plaintext, keyB64);
        expect(typeof encrypted).toBe('string');

        const decrypted = await decryptAESGCMString(encrypted, keyB64);
        expect(decrypted).toBe(plaintext);
    });
});

