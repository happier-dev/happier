import {
    CRYPTO_GOLDEN_VECTORS,
    encodeBase64,
    openEncryptedDataKeyEnvelopeV1,
    parseSerializedJsonValue,
} from '@happier-dev/protocol';
import sodium from 'libsodium-wrappers';

import { UI_CRYPTO_GOLDEN_VECTORS } from '../../sources/sync/encryption/nativeCryptoWorker/cryptoGoldenVectors';
import {
    type AesGcmJsonInput,
    type DataKeyEnvelopeInput,
    type FuzzCase,
    type SecretboxJsonInput,
    base64FromBytes,
    base64FromHex,
    bytesFromHex,
    decodeBase64OrNull,
    fixedBytes,
    mutateFirstByte,
    parseSerializedJsonOrNull,
    randomBytes,
    toArrayBuffer,
} from './cryptoWorkerMalformedInputFuzzShared';

export function buildDataKeyEnvelopeCases(
    iterations: number,
    nextRandom: () => number,
): Array<FuzzCase<DataKeyEnvelopeInput, string>> {
    const direct = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
    const compatibility = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.compatibilitySeed;
    const validSecret = base64FromHex(direct.recipientSecretKeyOrSeed.hex);

    const cases: Array<FuzzCase<DataKeyEnvelopeInput, string>> = [
        {
            label: 'valid direct-secret data-key envelope',
            input: {
                envelopeBase64: base64FromHex(direct.envelope.hex),
                recipientSecretKeyOrSeedBase64: validSecret,
            },
            expected: base64FromHex(direct.dataKey.hex),
        },
        {
            label: 'wrong recipient data-key envelope',
            input: {
                envelopeBase64: base64FromHex(direct.envelope.hex),
                recipientSecretKeyOrSeedBase64: base64FromBytes(fixedBytes(0xee, 32)),
            },
            expected: null,
        },
        {
            label: 'unsupported version data-key envelope',
            input: {
                envelopeBase64: base64FromHex(CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.unsupportedVersionEnvelope.hex),
                recipientSecretKeyOrSeedBase64: validSecret,
            },
            expected: null,
        },
    ];

    for (let index = 0; index < iterations; index += 1) {
        cases.push({
            label: `random malformed data-key envelope ${index}`,
            input: {
                envelopeBase64: base64FromBytes(randomBytes(nextRandom, 0, 96)),
                recipientSecretKeyOrSeedBase64: index % 2 === 0
                    ? validSecret
                    : base64FromBytes(randomBytes(nextRandom, 0, 64)),
            },
            expected: null,
        });
    }

    cases.push({
        label: 'valid compatibility-seed data-key envelope after invalids',
        input: {
            envelopeBase64: base64FromHex(compatibility.envelope.hex),
            recipientSecretKeyOrSeedBase64: base64FromHex(compatibility.recipientSecretKeyOrSeed.hex),
        },
        expected: base64FromHex(compatibility.dataKey.hex),
        validAfterInvalid: true,
    });
    return cases;
}

export function buildSecretboxJsonCases(
    iterations: number,
    nextRandom: () => number,
): Array<FuzzCase<SecretboxJsonInput, unknown>> {
    const [objectVector, arrayVector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;
    const keyBase64 = base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex);
    const wrongKeyBase64 = base64FromBytes(fixedBytes(0xab, 32));

    const cases: Array<FuzzCase<SecretboxJsonInput, unknown>> = [
        {
            label: 'valid secretbox JSON object',
            input: {
                ciphertextBase64: base64FromHex(objectVector.encryptedHex),
                keyBase64,
            },
            expected: parseSerializedJsonValue(objectVector.serialized),
        },
        {
            label: 'wrong secretbox key',
            input: {
                ciphertextBase64: base64FromHex(arrayVector.encryptedHex),
                keyBase64: wrongKeyBase64,
            },
            expected: null,
        },
        {
            label: 'truncated secretbox ciphertext',
            input: {
                ciphertextBase64: base64FromBytes(bytesFromHex(arrayVector.encryptedHex).slice(0, 8)),
                keyBase64,
            },
            expected: null,
        },
    ];

    for (let index = 0; index < iterations; index += 1) {
        cases.push({
            label: `random malformed secretbox JSON ${index}`,
            input: {
                ciphertextBase64: base64FromBytes(randomBytes(nextRandom, 0, 128)),
                keyBase64: index % 2 === 0 ? keyBase64 : base64FromBytes(randomBytes(nextRandom, 0, 64)),
            },
            expected: null,
        });
    }

    cases.push({
        label: 'valid secretbox JSON array after invalids',
        input: {
            ciphertextBase64: base64FromHex(arrayVector.encryptedHex),
            keyBase64,
        },
        expected: parseSerializedJsonValue(arrayVector.serialized),
        validAfterInvalid: true,
    });
    return cases;
}

export function buildAesGcmJsonCases(
    iterations: number,
    nextRandom: () => number,
): Array<FuzzCase<AesGcmJsonInput, unknown>> {
    const [objectVector, arrayVector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;
    const keyBase64 = base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex);
    const wrongKeyBase64 = base64FromBytes(fixedBytes(0xcd, 32));
    const unsupportedVersionPayload = mutateFirstByte(bytesFromHex(arrayVector.encryptedPayloadHex), 1);

    const cases: Array<FuzzCase<AesGcmJsonInput, unknown>> = [
        {
            label: 'valid AES-GCM JSON object',
            input: {
                encryptedPayloadBase64: base64FromHex(objectVector.encryptedPayloadHex),
                keyBase64,
            },
            expected: parseSerializedJsonValue(objectVector.serialized),
        },
        {
            label: 'wrong AES-GCM key',
            input: {
                encryptedPayloadBase64: base64FromHex(arrayVector.encryptedPayloadHex),
                keyBase64: wrongKeyBase64,
            },
            expected: null,
        },
        {
            label: 'unsupported AES-GCM version byte',
            input: {
                encryptedPayloadBase64: base64FromBytes(unsupportedVersionPayload),
                keyBase64,
            },
            expected: null,
        },
    ];

    for (let index = 0; index < iterations; index += 1) {
        cases.push({
            label: `random malformed AES-GCM JSON ${index}`,
            input: {
                encryptedPayloadBase64: base64FromBytes(randomBytes(nextRandom, 0, 160)),
                keyBase64: index % 2 === 0 ? keyBase64 : base64FromBytes(randomBytes(nextRandom, 0, 64)),
            },
            expected: null,
        });
    }

    cases.push({
        label: 'valid AES-GCM JSON array after invalids',
        input: {
            encryptedPayloadBase64: base64FromHex(arrayVector.encryptedPayloadHex),
            keyBase64,
        },
        expected: parseSerializedJsonValue(arrayVector.serialized),
        validAfterInvalid: true,
    });
    return cases;
}

export function decryptDataKeyEnvelopeCase(input: DataKeyEnvelopeInput): string | null {
    const envelope = decodeBase64OrNull(input.envelopeBase64);
    const recipientSecretKeyOrSeed = decodeBase64OrNull(input.recipientSecretKeyOrSeedBase64);
    if (!envelope || !recipientSecretKeyOrSeed) return null;
    const opened = openEncryptedDataKeyEnvelopeV1({
        envelope,
        recipientSecretKeyOrSeed,
    });
    return opened ? encodeBase64(opened, 'base64') : null;
}

export function decryptSecretboxJsonCase(input: SecretboxJsonInput): unknown | null {
    const ciphertext = decodeBase64OrNull(input.ciphertextBase64);
    const key = decodeBase64OrNull(input.keyBase64);
    if (!ciphertext || !key) return null;
    if (key.length !== sodium.crypto_secretbox_KEYBYTES) return null;
    if (ciphertext.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) return null;

    const nonce = ciphertext.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const boxed = ciphertext.slice(sodium.crypto_secretbox_NONCEBYTES);
    try {
        const opened = sodium.crypto_secretbox_open_easy(boxed, nonce, key);
        if (!opened) return null;
        return parseSerializedJsonOrNull(new TextDecoder().decode(toArrayBuffer(opened)));
    } catch {
        return null;
    }
}

export async function decryptAesGcmJsonCase(input: AesGcmJsonInput): Promise<unknown | null> {
    const payload = decodeBase64OrNull(input.encryptedPayloadBase64);
    const keyBytes = decodeBase64OrNull(input.keyBase64);
    if (!payload || !keyBytes) return null;
    if (keyBytes.length !== 32) return null;
    if (payload.length < 1 + 12 + 16) return null;
    if (payload[0] !== 0) return null;

    try {
        const key = await globalThis.crypto.subtle.importKey(
            'raw',
            toArrayBuffer(keyBytes),
            { name: 'AES-GCM' },
            false,
            ['decrypt'],
        );
        const plaintext = await globalThis.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: toArrayBuffer(payload.slice(1, 13)) },
            key,
            toArrayBuffer(payload.slice(13)),
        );
        return parseSerializedJsonOrNull(new TextDecoder().decode(new Uint8Array(plaintext)));
    } catch {
        return null;
    }
}
