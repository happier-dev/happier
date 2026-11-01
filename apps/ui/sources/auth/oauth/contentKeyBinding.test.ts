import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils';
import { deriveAccountMachineKeyFromRecoverySecret, verifyAccountContentPublicKeyBinding } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import { buildContentKeyBinding } from './contentKeyBinding';

describe('buildContentKeyBinding', () => {
    it('publishes the genuine recovery-secret content key with its signing-key binding', async () => {
        const secret = new Uint8Array(32).fill(7);
        const result = await buildContentKeyBinding(secret);
        const content = tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey;
        expect(result.contentPublicKey).toBe(encodeBase64(content));
        expect(verifyAccountContentPublicKeyBinding({
            signingPublicKeyHex: bytesToHex(tweetnacl.sign.keyPair.fromSeed(secret).publicKey),
            contentPublicKeyB64: result.contentPublicKey,
            contentPublicKeySigB64: result.contentPublicKeySig,
        })).toBe(true);
    });
});
