import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { decodeHex } from '@/encryption/hex';
import { CRYPTO_GOLDEN_VECTORS, parseSerializedJsonValue } from '@happier-dev/protocol';

import { UI_CRYPTO_GOLDEN_VECTORS } from './cryptoGoldenVectors';
import { createFakeCryptoWorker } from './fakeCryptoWorker';

const scope = { accountId: 'account-a', serverId: 'server-a', generation: 1 };

function base64FromHex(hex: string): string {
    return encodeBase64(decodeHex(hex));
}

function withoutPadding(value: string): string {
    return value.replace(/=+$/g, '');
}

function withWhitespace(value: string): string {
    return ` ${value.slice(0, 2)} \n${value.slice(2)} `;
}

describe('createFakeCryptoWorker', () => {
    it('reports itself as an available reference implementation', async () => {
        const worker = createFakeCryptoWorker();

        expect(await worker.probe()).toMatchObject({
            available: true,
            failureReason: 0,
        });
    });

    it('decrypts data-key envelopes with direct and compatibility secret material', async () => {
        const worker = createFakeCryptoWorker();
        const direct = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
        const compatibility = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.compatibilitySeed;

        const result = await worker.decryptDataKeyEnvelopeV1({
            scope,
            items: [
                {
                    envelopeBase64: base64FromHex(direct.envelope.hex),
                    recipientSecretKeyOrSeedBase64: base64FromHex(direct.recipientSecretKeyOrSeed.hex),
                },
                {
                    envelopeBase64: base64FromHex(compatibility.envelope.hex),
                    recipientSecretKeyOrSeedBase64: base64FromHex(compatibility.recipientSecretKeyOrSeed.hex),
                },
                {
                    envelopeBase64: base64FromHex(CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.malformedEnvelope.hex),
                    recipientSecretKeyOrSeedBase64: base64FromHex(direct.recipientSecretKeyOrSeed.hex),
                },
            ],
        });

        expect(result).toEqual({
            status: 'ok',
            source: 'reference',
            items: [
                base64FromHex(direct.dataKey.hex),
                base64FromHex(compatibility.dataKey.hex),
                null,
            ],
        });
    });

    it('decrypts data-key envelopes with protocol-lenient base64 fields', async () => {
        const worker = createFakeCryptoWorker();
        const direct = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;

        const result = await worker.decryptDataKeyEnvelopeV1({
            scope,
            items: [{
                envelopeBase64: withWhitespace(base64FromHex(direct.envelope.hex)),
                recipientSecretKeyOrSeedBase64: withoutPadding(base64FromHex(direct.recipientSecretKeyOrSeed.hex)),
            }],
        });

        expect(result).toEqual({
            status: 'ok',
            source: 'reference',
            items: [base64FromHex(direct.dataKey.hex)],
        });
    });

    it('decrypts secretbox JSON vectors through the same payload contract native uses', async () => {
        const worker = createFakeCryptoWorker();

        const result = await worker.decryptSecretboxJson({
            scope,
            items: UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values.map((vector) => ({
                ciphertextBase64: base64FromHex(vector.encryptedHex),
                keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex),
            })),
        });

        expect(result.items).toEqual(
            UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values.map((vector) => parseSerializedJsonValue(vector.serialized)),
        );
    });

    it('decrypts secretbox JSON with protocol-lenient base64 fields', async () => {
        const worker = createFakeCryptoWorker();
        const [vector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;

        const result = await worker.decryptSecretboxJson({
            scope,
            items: [{
                ciphertextBase64: withWhitespace(base64FromHex(vector.encryptedHex)),
                keyBase64: withoutPadding(base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex)),
            }],
        });

        expect(result).toEqual({
            status: 'ok',
            source: 'reference',
            items: [parseSerializedJsonValue(vector.serialized)],
        });
    });

    it('returns null per invalid secretbox JSON item without dropping valid items', async () => {
        const worker = createFakeCryptoWorker();
        const [objectVector, arrayVector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;

        const result = await worker.decryptSecretboxJson({
            scope,
            items: [
                {
                    ciphertextBase64: base64FromHex(objectVector.encryptedHex),
                    keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex),
                },
                {
                    ciphertextBase64: base64FromHex(arrayVector.encryptedHex),
                    keyBase64: base64FromHex('f'.repeat(64)),
                },
                {
                    ciphertextBase64: 'not-base64',
                    keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex),
                },
                {
                    ciphertextBase64: base64FromHex(arrayVector.encryptedHex),
                    keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex),
                },
            ],
        });

        expect(result).toEqual({
            status: 'ok',
            source: 'reference',
            items: [
                parseSerializedJsonValue(objectVector.serialized),
                null,
                null,
                parseSerializedJsonValue(arrayVector.serialized),
            ],
        });
    });

    it('decrypts AES-GCM JSON vectors through the same payload contract native uses', async () => {
        const worker = createFakeCryptoWorker();

        const result = await worker.decryptAesGcmJson({
            scope,
            items: UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values.map((vector) => ({
                encryptedPayloadBase64: base64FromHex(vector.encryptedPayloadHex),
                keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex),
            })),
        });

        expect(result.items).toEqual(
            UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values.map((vector) => parseSerializedJsonValue(vector.serialized)),
        );
    });

    it('decrypts AES-GCM JSON with protocol-lenient base64 fields', async () => {
        const worker = createFakeCryptoWorker();
        const [vector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;

        const result = await worker.decryptAesGcmJson({
            scope,
            items: [{
                encryptedPayloadBase64: withWhitespace(base64FromHex(vector.encryptedPayloadHex)),
                keyBase64: withoutPadding(base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex)),
            }],
        });

        expect(result).toEqual({
            status: 'ok',
            source: 'reference',
            items: [parseSerializedJsonValue(vector.serialized)],
        });
    });

    it('returns null per invalid AES-GCM JSON item without dropping valid items', async () => {
        const worker = createFakeCryptoWorker();
        const [objectVector, arrayVector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;

        const result = await worker.decryptAesGcmJson({
            scope,
            items: [
                {
                    encryptedPayloadBase64: base64FromHex(objectVector.encryptedPayloadHex),
                    keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex),
                },
                {
                    encryptedPayloadBase64: base64FromHex(arrayVector.encryptedPayloadHex),
                    keyBase64: base64FromHex('e'.repeat(64)),
                },
                {
                    encryptedPayloadBase64: 'not-base64',
                    keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex),
                },
                {
                    encryptedPayloadBase64: base64FromHex(arrayVector.encryptedPayloadHex),
                    keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex),
                },
            ],
        });

        expect(result).toEqual({
            status: 'ok',
            source: 'reference',
            items: [
                parseSerializedJsonValue(objectVector.serialized),
                null,
                null,
                parseSerializedJsonValue(arrayVector.serialized),
            ],
        });
    });
});
