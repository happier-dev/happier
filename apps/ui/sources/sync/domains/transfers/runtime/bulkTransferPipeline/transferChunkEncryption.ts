import {
    BOX_BUNDLE_PUBLIC_KEY_BYTES,
    deriveBoxPublicKeyFromSeed,
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { gcm } from '@noble/ciphers/aes.js';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';

// Chunk encryption is transfer-plumbing and should stay scoped to bulkTransferPipeline/** so
// feature code cannot bypass the canonical bulk transfer entrypoints.
const TRANSFER_CHUNK_DATA_KEY_BYTES = 32;
const TRANSFER_CHUNK_NONCE_BYTES = 12;
const TRANSFER_CHUNK_AUTH_TAG_BYTES = 16;
const TRANSFER_CHUNK_BUNDLE_VERSION = 0;

type RandomBytesFn = (length: number) => Uint8Array;

function toWebCryptoBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function getSubtleCrypto(): SubtleCrypto | null {
    return globalThis.crypto?.subtle ?? null;
}

function buildTransferChunkAad(params: Readonly<{
    transferId: string;
    sequence: number;
}>): Uint8Array {
    return new TextEncoder().encode(`${TRANSFER_CHUNK_BUNDLE_VERSION}:${params.transferId}:${params.sequence}`);
}

function parseRecipientPublicKeyBase64(recipientPublicKeyBase64: string): Uint8Array {
    const recipientPublicKey = decodeBase64(recipientPublicKeyBase64, 'base64');
    if (recipientPublicKey.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
        throw new Error('Invalid transfer recipient public key');
    }
    return recipientPublicKey;
}

async function importAesGcmKey(subtle: SubtleCrypto, dataKey: Uint8Array): Promise<CryptoKey> {
    return await subtle.importKey(
        'raw',
        toWebCryptoBuffer(dataKey),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
    );
}

async function encryptAesGcm(params: Readonly<{
    dataKey: Uint8Array;
    nonce: Uint8Array;
    aad: Uint8Array;
    payload: Uint8Array;
}>): Promise<Uint8Array> {
    const subtle = getSubtleCrypto();
    if (!subtle) {
        return gcm(params.dataKey, params.nonce, params.aad).encrypt(params.payload);
    }

    const key = await importAesGcmKey(subtle, params.dataKey);
    return new Uint8Array(
        await subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: toWebCryptoBuffer(params.nonce),
                additionalData: toWebCryptoBuffer(params.aad),
            },
            key,
            toWebCryptoBuffer(params.payload),
        ),
    );
}

async function decryptAesGcm(params: Readonly<{
    dataKey: Uint8Array;
    nonce: Uint8Array;
    aad: Uint8Array;
    ciphertext: Uint8Array;
}>): Promise<Uint8Array> {
    const subtle = getSubtleCrypto();
    if (!subtle) {
        return gcm(params.dataKey, params.nonce, params.aad).decrypt(params.ciphertext);
    }

    const key = await importAesGcmKey(subtle, params.dataKey);
    return new Uint8Array(
        await subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: toWebCryptoBuffer(params.nonce),
                additionalData: toWebCryptoBuffer(params.aad),
            },
            key,
            toWebCryptoBuffer(params.ciphertext),
        ),
    );
}

export function createTransferRecipientKeyPair(params?: Readonly<{
    randomBytes?: RandomBytesFn;
}>): Readonly<{
    recipientSecretKeySeed: Uint8Array;
    recipientPublicKeyBase64: string;
}> {
    const randomBytes = params?.randomBytes ?? getRandomBytes;
    const recipientSecretKeySeed = randomBytes(TRANSFER_CHUNK_DATA_KEY_BYTES);
    return {
        recipientSecretKeySeed,
        recipientPublicKeyBase64: encodeBase64(
            deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
            'base64',
        ),
    };
}

export async function createEncryptedTransferChunkEnvelope(params: Readonly<{
    transferId: string;
    sequence: number;
    payload: Uint8Array;
    recipientPublicKeyBase64: string;
    randomBytes?: RandomBytesFn;
}>): Promise<Readonly<{
    payloadBase64: string;
    encryptedDataKeyEnvelopeBase64: string;
}>> {
    const randomBytes = params.randomBytes ?? getRandomBytes;
    const dataKey = randomBytes(TRANSFER_CHUNK_DATA_KEY_BYTES);
    if (dataKey.length !== TRANSFER_CHUNK_DATA_KEY_BYTES) {
        throw new Error(`Invalid transfer data key length: ${dataKey.length}`);
    }
    const nonce = randomBytes(TRANSFER_CHUNK_NONCE_BYTES);
    if (nonce.length !== TRANSFER_CHUNK_NONCE_BYTES) {
        throw new Error(`Invalid transfer chunk nonce length: ${nonce.length}`);
    }

    const ciphertext = await encryptAesGcm({
        dataKey,
        nonce,
        aad: buildTransferChunkAad({
            transferId: params.transferId,
            sequence: params.sequence,
        }),
        payload: params.payload,
    });

    const encryptedChunk = new Uint8Array(1 + nonce.length + ciphertext.length);
    encryptedChunk[0] = TRANSFER_CHUNK_BUNDLE_VERSION;
    encryptedChunk.set(nonce, 1);
    encryptedChunk.set(ciphertext, 1 + nonce.length);

    const encryptedDataKeyEnvelope = sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey: parseRecipientPublicKeyBase64(params.recipientPublicKeyBase64),
        randomBytes,
    });

    return {
        payloadBase64: encodeBase64(encryptedChunk, 'base64'),
        encryptedDataKeyEnvelopeBase64: encodeBase64(encryptedDataKeyEnvelope, 'base64'),
    };
}

export async function decryptEncryptedTransferChunkEnvelope(params: Readonly<{
    transferId: string;
    sequence: number;
    payloadBase64: string;
    encryptedDataKeyEnvelopeBase64: string;
    recipientSecretKeySeed: Uint8Array;
}>): Promise<Uint8Array> {
    const encryptedDataKeyEnvelope = decodeBase64(params.encryptedDataKeyEnvelopeBase64, 'base64');
    const dataKey = openEncryptedDataKeyEnvelopeV1({
        envelope: encryptedDataKeyEnvelope,
        recipientSecretKeyOrSeed: params.recipientSecretKeySeed,
    });
    if (!dataKey || dataKey.length !== TRANSFER_CHUNK_DATA_KEY_BYTES) {
        throw new Error(`Invalid encrypted transfer data key for ${params.transferId}`);
    }

    const encryptedChunk = decodeBase64(params.payloadBase64, 'base64');
    const minimumBundleBytes = 1 + TRANSFER_CHUNK_NONCE_BYTES + TRANSFER_CHUNK_AUTH_TAG_BYTES;
    if (encryptedChunk.length < minimumBundleBytes) {
        throw new Error(`Invalid encrypted transfer chunk for ${params.transferId}`);
    }
    if (encryptedChunk[0] !== TRANSFER_CHUNK_BUNDLE_VERSION) {
        throw new Error(`Unsupported encrypted transfer chunk version for ${params.transferId}`);
    }

    const nonceStart = 1;
    const ciphertextStart = nonceStart + TRANSFER_CHUNK_NONCE_BYTES;
    const nonce = encryptedChunk.slice(nonceStart, ciphertextStart);
    const ciphertext = encryptedChunk.slice(ciphertextStart);
    try {
        return await decryptAesGcm({
            dataKey,
            nonce,
            aad: buildTransferChunkAad({
                transferId: params.transferId,
                sequence: params.sequence,
            }),
            ciphertext,
        });
    } catch {
        throw new Error(`Failed to decrypt transfer chunk for ${params.transferId}`);
    }
}
