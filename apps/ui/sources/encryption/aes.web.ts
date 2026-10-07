import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { openAesGcmPayloadWebCrypto, sealAesGcmPayloadWebCrypto } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';

import { decodeUTF8, encodeUTF8 } from './text';

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const plaintext = new TextEncoder().encode(data);
    const payload = await sealAesGcmPayloadWebCrypto(plaintext, decodeBase64(key64, 'base64'));
    return encodeBase64(payload, 'base64');
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    try {
        const payloadBytes = new Uint8Array(decodeBase64(data, 'base64'));
        const plaintextBytes = await openAesGcmPayloadWebCrypto(payloadBytes, decodeBase64(key64, 'base64'));
        return new TextDecoder().decode(plaintextBytes).trim();
    } catch {
        return null;
    }
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = (await encryptAESGCMString(decodeUTF8(data), key64)).trim();
    return decodeBase64(encrypted, 'base64');
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const raw = await decryptAESGCMString(encodeBase64(data, 'base64'), key64);
    return raw ? encodeUTF8(raw) : null;
}
