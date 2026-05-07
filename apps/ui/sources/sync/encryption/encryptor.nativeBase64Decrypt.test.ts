import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { decodeHex } from '@/encryption/hex';
import { parseSerializedJsonValue } from '@happier-dev/protocol';

import { AES256Encryption, SecretBoxEncryption } from './encryptor';
import { UI_CRYPTO_GOLDEN_VECTORS } from './nativeCryptoWorker/cryptoGoldenVectors';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import type { CryptoWorkerScope } from './nativeCryptoWorker/types';

type Base64JsonDecryptor = Readonly<{
    decryptBase64?: (data: readonly string[]) => Promise<readonly (unknown | null)[]>;
}>;

const scope: CryptoWorkerScope = { accountId: 'account', serverId: 'server', generation: 1 };

function base64FromHex(hex: string): string {
    return encodeBase64(decodeHex(hex), 'base64');
}

function withoutPadding(value: string): string {
    return value.replace(/=+$/g, '');
}

function withWhitespace(value: string): string {
    return ` ${value.slice(0, 2)} \n${value.slice(2)} `;
}

function requireBase64Decryptor(encryptor: Base64JsonDecryptor): (data: readonly string[]) => Promise<readonly (unknown | null)[]> {
    expect(typeof encryptor.decryptBase64).toBe('function');
    return encryptor.decryptBase64!;
}

function nativeBinding() {
    const worker = createFakeCryptoWorker();
    return {
        getWorker: () => worker,
        getRouting: () => ({ mode: 'require' as const, minPayloadBytes: 0 }),
        getScope: () => scope,
        isScopeCurrent: () => true,
    };
}

describe('encryptor native base64 JSON decrypt', () => {
    it('keeps valid secretbox base64 JSON item order through the native worker', async () => {
        const key = decodeHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex);
        const encryptor = new SecretBoxEncryption(key, { nativeCryptoWorker: nativeBinding() });
        const decryptBase64 = requireBase64Decryptor(encryptor);
        const vectors = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;

        await expect(decryptBase64(vectors.map((vector) => base64FromHex(vector.encryptedHex)))).resolves.toEqual(
            vectors.map((vector) => parseSerializedJsonValue(vector.serialized)),
        );
    });

    it('returns null for invalid secretbox base64 native decrypt items', async () => {
        const key = decodeHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex);
        const encryptor = new SecretBoxEncryption(key, { nativeCryptoWorker: nativeBinding() });
        const decryptBase64 = requireBase64Decryptor(encryptor);
        const [objectVector, arrayVector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;

        await expect(decryptBase64([
            base64FromHex(objectVector.encryptedHex),
            'not-base64',
            base64FromHex(arrayVector.encryptedHex),
        ])).resolves.toEqual([
            parseSerializedJsonValue(objectVector.serialized),
            null,
            parseSerializedJsonValue(arrayVector.serialized),
        ]);

        const wrongKeyEncryptor = new SecretBoxEncryption(new Uint8Array(32).fill(250), {
            nativeCryptoWorker: nativeBinding(),
        });
        await expect(requireBase64Decryptor(wrongKeyEncryptor)([
            base64FromHex(objectVector.encryptedHex),
        ])).resolves.toEqual([null]);
    });

    it('keeps valid AES base64 JSON item order through the native worker', async () => {
        const key = decodeHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex);
        const encryptor = new AES256Encryption(key, { nativeCryptoWorker: nativeBinding() });
        const decryptBase64 = requireBase64Decryptor(encryptor);
        const vectors = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;

        await expect(decryptBase64(vectors.map((vector) => base64FromHex(vector.encryptedPayloadHex)))).resolves.toEqual(
            vectors.map((vector) => parseSerializedJsonValue(vector.serialized)),
        );
    });

    it('decrypts protocol-lenient AES base64 through the native worker seam', async () => {
        const key = decodeHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex);
        const encryptor = new AES256Encryption(key, { nativeCryptoWorker: nativeBinding() });
        const decryptBase64 = requireBase64Decryptor(encryptor);
        const [vector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;

        await expect(decryptBase64([
            withWhitespace(withoutPadding(base64FromHex(vector.encryptedPayloadHex))),
        ])).resolves.toEqual([
            parseSerializedJsonValue(vector.serialized),
        ]);
    });

    it('returns null for invalid AES base64 native decrypt items', async () => {
        const key = decodeHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex);
        const encryptor = new AES256Encryption(key, { nativeCryptoWorker: nativeBinding() });
        const decryptBase64 = requireBase64Decryptor(encryptor);
        const [objectVector, arrayVector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;

        await expect(decryptBase64([
            base64FromHex(objectVector.encryptedPayloadHex),
            'not-base64',
            base64FromHex(arrayVector.encryptedPayloadHex),
        ])).resolves.toEqual([
            parseSerializedJsonValue(objectVector.serialized),
            null,
            parseSerializedJsonValue(arrayVector.serialized),
        ]);

        const wrongKeyEncryptor = new AES256Encryption(new Uint8Array(32).fill(251), {
            nativeCryptoWorker: nativeBinding(),
        });
        await expect(requireBase64Decryptor(wrongKeyEncryptor)([
            base64FromHex(objectVector.encryptedPayloadHex),
        ])).resolves.toEqual([null]);
    });
});
