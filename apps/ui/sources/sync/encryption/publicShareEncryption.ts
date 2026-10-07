import {
    openPublicShareDataKeyV1,
    sealPublicShareDataKeyV1,
} from '@happier-dev/protocol/crypto/publicShareEncryptedDataKeyEnvelopeV0';
import { getRandomBytes } from '@/platform/cryptoRandom';

/**
 * Wrap a data encryption key with the client-held public-link secret.
 *
 * @param dataEncryptionKey - The session's data encryption key to encrypt
 * @param token - The fragment secret (the path token only for retained 0.2 readers)
 * @returns Base64 encoded encrypted data key
 *
 * @remarks
 * Uses the Protocol-owned SecretBox and key derivation. New writers use an
 * independent URL-fragment secret that never reaches the server.
 */
export async function encryptDataKeyForPublicShare(
    dataEncryptionKey: Uint8Array,
    token: string
): Promise<string> {
    return sealPublicShareDataKeyV1({ dataKey: dataEncryptionKey, secret: token, randomBytes: getRandomBytes });
}

/**
 * Open a data encryption key using the exact secret selected by the link format.
 *
 * @param encryptedDataKey - The encrypted data key (base64)
 * @param token - A fragment secret, or the retained 0.2 path token
 * @returns Decrypted data encryption key, or null if decryption fails
 *
 * @remarks
 * This is the inverse of encryptDataKeyForPublicShare.
 */
export async function decryptDataKeyFromPublicShare(
    encryptedDataKey: string,
    token: string
): Promise<Uint8Array | null> {
    return openPublicShareDataKeyV1({ encryptedDataKey, secret: token });
}
