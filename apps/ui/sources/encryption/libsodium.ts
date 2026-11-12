import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { deriveBoxPublicKeyFromSeed, openBoxBundle, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';

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

export function encryptSecretBox(data: unknown, secret: Uint8Array): Uint8Array {
    return encryptSecretBoxBytes(new TextEncoder().encode(stringifySerializedJsonValue(data)), secret);
}

export function encryptSecretBoxBytes(data: Uint8Array, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = sodium.crypto_secretbox_easy(
        data,
        nonce,
        secret
    );
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptSecretBoxBytes(data: Uint8Array, secret: Uint8Array, onAuthenticationFailure?: () => void): Uint8Array | null {
    const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = data.slice(sodium.crypto_secretbox_NONCEBYTES);

    let decrypted: Uint8Array | null;
    try {
        decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, secret);
        if (!decrypted) {
            onAuthenticationFailure?.();
            return null;
        }
    } catch (error) {
        onAuthenticationFailure?.();
        return null;
    }
    return decrypted;
}
