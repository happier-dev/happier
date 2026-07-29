import { describe, expect, it } from 'vitest';

import {
    createDeterministicRandomBytesFromBase64,
    transferChunkEncryptionVectors,
} from '@happier-dev/protocol';

import {
    createEncryptedTransferChunkEnvelope,
    decryptEncryptedTransferChunkEnvelope,
} from './transferChunkEncryption';

describe('transferChunkEncryption', () => {
    it.each(transferChunkEncryptionVectors)('matches the shared Node/Web vector %s', async (vector) => {
        const envelope = await createEncryptedTransferChunkEnvelope({
            transferId: vector.transferId,
            sequence: vector.sequence,
            payload: new TextEncoder().encode(vector.payloadUtf8),
            recipientPublicKeyBase64: vector.recipientPublicKeyBase64,
            randomBytes: createDeterministicRandomBytesFromBase64(vector.randomBytesBase64),
        });

        expect(envelope).toEqual({
            payloadBase64: vector.payloadBase64,
            encryptedDataKeyEnvelopeBase64: vector.encryptedDataKeyEnvelopeBase64,
        });

        const decrypted = await decryptEncryptedTransferChunkEnvelope({
            transferId: vector.transferId,
            sequence: vector.sequence,
            payloadBase64: vector.payloadBase64,
            encryptedDataKeyEnvelopeBase64: vector.encryptedDataKeyEnvelopeBase64,
            recipientSecretKeySeed: Uint8Array.from(Buffer.from(vector.recipientSecretKeySeedBase64, 'base64')),
        });
        expect(new TextDecoder().decode(decrypted)).toBe(vector.payloadUtf8);
    });

});
