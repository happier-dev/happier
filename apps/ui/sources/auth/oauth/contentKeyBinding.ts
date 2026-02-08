import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import sodium from '@/encryption/libsodium.lib';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

export async function buildContentKeyBinding(secretBytes: Uint8Array): Promise<{
    contentPublicKey: string;
    contentPublicKeySig: string;
}> {
    const encryption = await Encryption.create(secretBytes);
    const contentPublicKeyBytes = encryption.contentDataKey;
    const signingKeyPair = sodium.crypto_sign_seed_keypair(secretBytes);

    const binding = new Uint8Array(CONTENT_KEY_BINDING_PREFIX.length + contentPublicKeyBytes.length);
    binding.set(CONTENT_KEY_BINDING_PREFIX, 0);
    binding.set(contentPublicKeyBytes, CONTENT_KEY_BINDING_PREFIX.length);

    const signature = sodium.crypto_sign_detached(binding, signingKeyPair.privateKey);
    return {
        contentPublicKey: encodeBase64(contentPublicKeyBytes),
        contentPublicKeySig: encodeBase64(signature),
    };
}
