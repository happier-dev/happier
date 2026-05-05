import { createDecipheriv } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeBase64 } from '@/encryption/base64';
import { parseSerializedJsonValue } from '@happier-dev/protocol';

import { AES256Encryption, SecretBoxEncryption } from './encryptor';

type UiCryptoGoldenVectors = Readonly<{
    schema: 'happier.uiCryptoGoldenVectors.v1';
    secretboxJson: Readonly<{
        keyHex: string;
        nonceHex: string;
        values: ReadonlyArray<Readonly<{
            name: string;
            encryptedHex: string;
            serialized: string;
        }>>;
    }>;
    aesGcmJson: Readonly<{
        keyHex: string;
        ivHex: string;
        values: ReadonlyArray<Readonly<{
            name: string;
            encryptedPayloadHex: string;
            nativeBase64Payload: string;
            serialized: string;
        }>>;
    }>;
}>;

async function readVectors(): Promise<UiCryptoGoldenVectors> {
    const module = await import('./nativeCryptoWorker/cryptoGoldenVectors');
    const value = Reflect.get(module, 'UI_CRYPTO_GOLDEN_VECTORS');
    expect(value).toEqual(expect.objectContaining({
        schema: 'happier.uiCryptoGoldenVectors.v1',
    }));
    return value as UiCryptoGoldenVectors;
}

function bytesFromHex(hex: string): Uint8Array {
    expect(hex.length % 2).toBe(0);
    return Uint8Array.from(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

function decryptNativeAesCombinedPayload(nativeBase64Payload: string, keyHex: string): string | null {
    try {
        const combined = Buffer.from(nativeBase64Payload, 'base64');
        const iv = combined.subarray(0, 12);
        const ciphertext = combined.subarray(12, combined.length - 16);
        const tag = combined.subarray(combined.length - 16);
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

describe('UI_CRYPTO_GOLDEN_VECTORS', () => {
    it('decrypts secretbox JSON vectors through the app encryptor', async () => {
        const vectors = await readVectors();
        const encryptor = new SecretBoxEncryption(bytesFromHex(vectors.secretboxJson.keyHex));

        const decrypted = await encryptor.decrypt(
            vectors.secretboxJson.values.map((vector) => bytesFromHex(vector.encryptedHex)),
        );

        expect(decrypted).toEqual(
            vectors.secretboxJson.values.map((vector) => parseSerializedJsonValue(vector.serialized)),
        );
    });

    it('decrypts outer-prefixed AES-GCM vectors through the app encryptor seam', async () => {
        const vectors = await readVectors();
        const encryptor = new AES256Encryption(bytesFromHex(vectors.aesGcmJson.keyHex), {
            decryptString: async (payload) => decryptNativeAesCombinedPayload(payload, vectors.aesGcmJson.keyHex),
        });

        const decrypted = await encryptor.decrypt(
            vectors.aesGcmJson.values.map((vector) => bytesFromHex(vector.encryptedPayloadHex)),
        );

        expect(decrypted).toEqual(
            vectors.aesGcmJson.values.map((vector) => parseSerializedJsonValue(vector.serialized)),
        );
    });

    it('pins AES native payload base64 to the bytes after the Happier version prefix', async () => {
        const vectors = await readVectors();

        for (const vector of vectors.aesGcmJson.values) {
            const payload = bytesFromHex(vector.encryptedPayloadHex);
            expect(payload[0]).toBe(0);
            expect(Buffer.from(payload.slice(1)).toString('base64')).toBe(vector.nativeBase64Payload);
            expect(decodeBase64(vector.nativeBase64Payload)).toEqual(payload.slice(1));
        }
    });
});
