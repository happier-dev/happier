import { createAccountContentPublicKeyBindingMessage } from '@happier-dev/protocol';
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

    const binding = createAccountContentPublicKeyBindingMessage(contentPublicKeyBytes);

    const signature = sodium.crypto_sign_detached(binding, signingKeyPair.privateKey);
    return {
        contentPublicKey: encodeBase64(contentPublicKeyBytes),
        contentPublicKeySig: encodeBase64(signature),
    };
}
