import { decryptLegacyBase64 } from './messageCrypto';

export function decryptLegacyBase64Normalized(ciphertextBase64: string, secret: Uint8Array): unknown | null {
    return decryptLegacyBase64(ciphertextBase64, secret);
}
