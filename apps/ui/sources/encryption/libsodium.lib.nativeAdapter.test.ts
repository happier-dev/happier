import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveBoxPublicKeyFromSeed,
    deriveBoxSecretKeyFromSeed,
} from '@happier-dev/protocol';

describe('native libsodium compatibility adapter', () => {
    it('does not import the JSI installer package at module evaluation time', () => {
        const source = readFileSync(join(__dirname, 'libsodium.lib.ts'), 'utf8');

        expect(source).not.toContain('@more-tech/react-native-libsodium');
    });

    it('exposes the crypto primitives used by app startup without native JSI install side effects', async () => {
        const sodium = (await import('./libsodium.lib')).default;
        await sodium.ready;

        const seed = new Uint8Array(32).fill(7);
        const boxKeyPair = sodium.crypto_box_seed_keypair(seed);
        expect(boxKeyPair.privateKey).toEqual(deriveBoxSecretKeyFromSeed(seed));
        expect(boxKeyPair.publicKey).toEqual(deriveBoxPublicKeyFromSeed(seed));

        const message = new TextEncoder().encode('signed payload');
        const signingKeyPair = sodium.crypto_sign_seed_keypair(seed);
        const signature = sodium.crypto_sign_detached(message, signingKeyPair.privateKey);
        expect(signature).toHaveLength(tweetnacl.sign.signatureLength);
        expect(sodium.crypto_sign_verify_detached(signature, message, signingKeyPair.publicKey)).toBe(true);
        expect(sodium.crypto_sign_verify_detached(signature, new TextEncoder().encode('tampered'), signingKeyPair.publicKey)).toBe(false);

        const secret = new Uint8Array(sodium.crypto_secretbox_KEYBYTES).fill(3);
        const nonce = new Uint8Array(sodium.crypto_secretbox_NONCEBYTES).fill(4);
        const boxed = sodium.crypto_secretbox_easy(message, nonce, secret);
        expect(boxed).toHaveLength(message.length + tweetnacl.secretbox.overheadLength);
        expect(sodium.crypto_secretbox_open_easy(boxed, nonce, secret)).toEqual(message);
        expect(sodium.crypto_secretbox_open_easy(boxed, nonce, new Uint8Array(secret.length).fill(5))).toBeNull();
    });
});
