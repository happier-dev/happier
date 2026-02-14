import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { deriveBoxPublicKeyFromSeed, openBoxBundle, sealBoxBundle } from '@happier-dev/protocol';

export function getPublicKeyForBox(secretKey: Uint8Array): Uint8Array {
    return deriveBoxPublicKeyFromSeed(secretKey);
}

export function encryptBox(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    return sealBoxBundle({
        plaintext: data,
        recipientPublicKey,
        randomBytes: getRandomBytes,
    });
}

export function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    return openBoxBundle({
        bundle: encryptedBundle,
        recipientSecretKeyOrSeed: recipientSecretKey,
    });
}

export function encryptSecretBox(data: any, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = sodium.crypto_secretbox_easy(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptSecretBox(data: Uint8Array, secret: Uint8Array): any | null {
    const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = data.slice(sodium.crypto_secretbox_NONCEBYTES);

    try {
        const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, secret);
        if (!decrypted) {
            return null;
        }
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (error) {
        return null;
    }
}
