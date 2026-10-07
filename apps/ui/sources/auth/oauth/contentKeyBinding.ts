import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import sodium from '@/encryption/libsodium.lib';

export async function buildContentKeyBinding(secretBytes: Uint8Array): Promise<{
    contentPublicKey: string;
    contentPublicKeySig: string;
}> {
    const encryption = await Encryption.create(secretBytes);
    const contentPublicKeyBytes = encryption.contentDataKey;
    const signingKeyPair = sodium.crypto_sign_seed_keypair(secretBytes);

    const signature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signingKeyPair.privateKey,
        contentPublicKey: contentPublicKeyBytes,
    });
    return {
        contentPublicKey: encodeBase64(contentPublicKeyBytes),
        contentPublicKeySig: encodeBase64(signature),
    };
}
