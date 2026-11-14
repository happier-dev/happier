import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealPrivateLabelV1, serializePrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';

import { projectMachinePoolPrivateLabelForRecipient } from './privateLabels';

const accountId = 'recipient-account';
const fingerprint = `content-public-key-sha256:${'a'.repeat(64)}`;

function encryptedPoolLabel() {
    const recipientSecretKey = new Uint8Array(32).fill(7);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey;
    const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
        dataKey: new Uint8Array(32).fill(3),
        recipientPublicKey,
        randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    return sealPrivateLabelV1({
        mode: 'e2ee',
        binding: { entity: 'machine_pool', field: 'name', id: 'pool-1' },
        value: 'Private Pool',
        dataKey: new Uint8Array(32).fill(3),
        recipients: [{
            accountId,
            envelope: {
                encryptedDataKey: encodeBase64(encryptedDataKey, 'base64'),
                recipientContentPublicKeyFingerprint: fingerprint,
            },
        }],
        randomBytes: (length) => new Uint8Array(length).fill(5),
    });
}

describe('Machine Pool private labels', () => {
    it('projects a valid historic label without consulting a current Account mode', () => {
        const stored = encryptedPoolLabel();

        expect(projectMachinePoolPrivateLabelForRecipient({
            serialized: serializePrivateLabelStoredV1(stored),
            recipientAccountId: accountId,
        })).toEqual({
            kind: 'available',
            label: {
                content: stored.content,
                recipientEnvelope: stored.recipients[0]!.envelope,
            },
        });
    });

    it('keeps raw historic labels readable until normal save', () => {
        expect(projectMachinePoolPrivateLabelForRecipient({
            serialized: 'Previously public Pool',
            recipientAccountId: accountId,
        })).toEqual({ kind: 'available', label: { content: { t: 'plain', v: 'Previously public Pool' }, recipientEnvelope: null, legacyPlaintext: true } });
    });
});
