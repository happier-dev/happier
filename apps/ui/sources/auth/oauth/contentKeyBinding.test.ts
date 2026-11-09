import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';

import { decodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { buildContentKeyBinding } from './contentKeyBinding';

describe('buildContentKeyBinding', () => {
    it('emits a binding the canonical protocol verifier accepts for this Account key', async () => {
        const accountSecret = new Uint8Array(32).fill(9);

        const result = await buildContentKeyBinding(accountSecret);

        const verified = verifyAccountContentKeyBindingV1({
            accountSigningPublicKey: tweetnacl.sign.keyPair.fromSeed(accountSecret).publicKey,
            contentPublicKey: decodeBase64(result.contentPublicKey),
            signature: decodeBase64(result.contentPublicKeySig),
        });

        // The binding names this secret's own content key, as the Account encryption owner derives it.
        const accountEncryption = await Encryption.create(accountSecret);
        expect(verified).not.toBeNull();
        expect(Array.from(verified!.contentPublicKey)).toEqual(Array.from(accountEncryption.contentDataKey));
    });
});
