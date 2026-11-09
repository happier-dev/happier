import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';
import {
    deriveBoxPublicKeyFromSeed} from '@happier-dev/protocol/crypto/boxBundle';
import {
    openEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    signAccountContentKeyBindingV1,
} from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';

import {
    encryptDataKeyForRecipientV0,
    verifyRecipientContentPublicKeyBinding,
} from './directShareEncryption';

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

        expect(envelope).toHaveLength(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope,
            recipientSecretKeyOrSeed: recipientSeed,
        })).toEqual(sessionDataKey);
    });
});

describe('verifyRecipientContentPublicKeyBinding', () => {
    function createRecipient() {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
        const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(
            new Uint8Array(32).fill(22),
        ).publicKey;
        return {
            signingPublicKeyHex: encodeHex(signing.publicKey),
            contentPublicKeyB64: encodeBase64(contentPublicKey, 'base64'),
            contentPublicKeySigB64: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey,
            }), 'base64'),
        };
    }

    it('accepts a binding produced by the canonical protocol signer', () => {
        expect(verifyRecipientContentPublicKeyBinding(createRecipient())).toBe(true);
    });

    it('rejects a binding presented under a different signing key', () => {
        const other = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));

        expect(verifyRecipientContentPublicKeyBinding({
            ...createRecipient(),
            signingPublicKeyHex: encodeHex(other.publicKey),
        })).toBe(false);
    });

    it('rejects a tampered signature and malformed encodings', () => {
        const recipient = createRecipient();
        const tampered = decodeBase64(recipient.contentPublicKeySigB64, 'base64');
        tampered[0] ^= 0xff;

        expect(verifyRecipientContentPublicKeyBinding({
            ...recipient,
            contentPublicKeySigB64: encodeBase64(tampered, 'base64'),
        })).toBe(false);
        expect(verifyRecipientContentPublicKeyBinding({
            ...recipient,
            signingPublicKeyHex: 'not-hex',
        })).toBe(false);
    });

    it('rejects a correctly signed low-order content public key', () => {
        // Sealing to a low-order X25519 key would produce a predictable shared
        // secret, so a valid signature over it must not make it a usable
        // recipient key.
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(24));
        const lowOrderContentPublicKey = new Uint8Array(tweetnacl.box.publicKeyLength);
        const label = new TextEncoder().encode('Happy content key v1');
        const message = new Uint8Array(label.length + 1 + lowOrderContentPublicKey.length);
        message.set(label, 0);
        message[label.length] = 0;
        message.set(lowOrderContentPublicKey, label.length + 1);

        expect(verifyRecipientContentPublicKeyBinding({
            signingPublicKeyHex: encodeHex(signing.publicKey),
            contentPublicKeyB64: encodeBase64(lowOrderContentPublicKey, 'base64'),
            contentPublicKeySigB64: encodeBase64(
                tweetnacl.sign.detached(message, signing.secretKey),
                'base64',
            ),
        })).toBe(false);
    });
});
