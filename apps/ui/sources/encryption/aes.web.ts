import { decodeBase64, encodeBase64 } from '@/encryption/base64';

import { decodeUTF8, encodeUTF8 } from './text';

const IV_LENGTH_BYTES = 12;

async function importAesGcmKeyFromBase64(keyB64: string): Promise<CryptoKey> {
    const keyBytes = decodeBase64(keyB64, 'base64');
    return await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptAesGcmBytes(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const ciphertextBytes = new Uint8Array(ciphertext);

    const out = new Uint8Array(iv.length + ciphertextBytes.length);
    out.set(iv, 0);
    out.set(ciphertextBytes, iv.length);
    return out;
}

async function decryptAesGcmBytes(payload: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    if (payload.byteLength < IV_LENGTH_BYTES) {
        throw new Error('Invalid AES-GCM payload');
    }
    const iv = payload.slice(0, IV_LENGTH_BYTES);
    const ciphertextBytes = payload.slice(IV_LENGTH_BYTES);
    const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertextBytes);
    return new Uint8Array(plaintext);
}

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const key = await importAesGcmKeyFromBase64(key64);
    const plaintext = new TextEncoder().encode(data);
    const payload = await encryptAesGcmBytes(plaintext, key);
    return encodeBase64(payload, 'base64');
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    try {
        const key = await importAesGcmKeyFromBase64(key64);
        const payloadBytes = decodeBase64(data, 'base64');
        const plaintextBytes = await decryptAesGcmBytes(payloadBytes, key);
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

