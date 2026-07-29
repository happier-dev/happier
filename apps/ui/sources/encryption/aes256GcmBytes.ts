import { gcm } from '@noble/ciphers/aes.js';

const AES_256_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_AUTH_TAG_BYTES = 16;

function validate(input: Readonly<{ key: Uint8Array; nonce: Uint8Array }>): void {
    if (input.key.byteLength !== AES_256_KEY_BYTES || input.nonce.byteLength !== AES_GCM_NONCE_BYTES) {
        throw new Error('aes_256_gcm_invalid_parameters');
    }
}

function toWebCryptoArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const backing = bytes.buffer;
    if (
        backing instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === backing.byteLength
        && (backing as ArrayBuffer & Readonly<{ resizable?: boolean }>).resizable !== true
    ) {
        try {
            // Constructing a view rejects detached buffers without copying owned bytes.
            new Uint8Array(backing, 0, bytes.byteLength);
        } catch {
            throw new Error('aes_256_gcm_invalid_parameters');
        }
        return backing;
    }

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

async function importKey(subtle: SubtleCrypto, key: Uint8Array): Promise<CryptoKey> {
    return await subtle.importKey('raw', toWebCryptoArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealAes256GcmBytes(input: Readonly<{
    key: Uint8Array;
    nonce: Uint8Array;
    aad: Uint8Array;
    plaintext: Uint8Array;
}>): Promise<Uint8Array> {
    validate(input);
    const subtle = globalThis.crypto?.subtle ?? null;
    if (!subtle) return gcm(input.key, input.nonce, input.aad).encrypt(input.plaintext);
    const key = await importKey(subtle, input.key);
    return new Uint8Array(await subtle.encrypt({
        name: 'AES-GCM',
        iv: toWebCryptoArrayBuffer(input.nonce),
        additionalData: toWebCryptoArrayBuffer(input.aad),
    }, key, toWebCryptoArrayBuffer(input.plaintext)));
}

export async function openAes256GcmBytes(input: Readonly<{
    key: Uint8Array;
    nonce: Uint8Array;
    aad: Uint8Array;
    ciphertext: Uint8Array;
}>): Promise<Uint8Array> {
    validate(input);
    if (input.ciphertext.byteLength < AES_GCM_AUTH_TAG_BYTES) {
        throw new Error('aes_256_gcm_authentication_failed');
    }
    try {
        const subtle = globalThis.crypto?.subtle ?? null;
        if (!subtle) return gcm(input.key, input.nonce, input.aad).decrypt(input.ciphertext);
        const key = await importKey(subtle, input.key);
        return new Uint8Array(await subtle.decrypt({
            name: 'AES-GCM',
            iv: toWebCryptoArrayBuffer(input.nonce),
            additionalData: toWebCryptoArrayBuffer(input.aad),
        }, key, toWebCryptoArrayBuffer(input.ciphertext)));
    } catch {
        throw new Error('aes_256_gcm_authentication_failed');
    }
}
