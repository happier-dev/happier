import { describe, expect, it } from 'vitest';
import {
    DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
    deriveBoxPublicKeyFromSeed,
    openEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';

import { encryptDataKeyForRecipientV0 } from './directShareEncryption';

describe('encryptDataKeyForRecipientV0', () => {
    it('emits the protocol v1 direct-share envelope for a 32-byte session data key', () => {
        const recipientSeed = new Uint8Array(32).fill(9);
        const recipientPublicKey = deriveBoxPublicKeyFromSeed(recipientSeed);
        const sessionDataKey = new Uint8Array(32).fill(4);

        const encryptedDataKey = encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(recipientPublicKey, 'base64'),
        );
        const envelope = decodeBase64(encryptedDataKey, 'base64');

        expect(envelope).toHaveLength(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope,
            recipientSecretKeyOrSeed: recipientSeed,
        })).toEqual(sessionDataKey);
    });
});
