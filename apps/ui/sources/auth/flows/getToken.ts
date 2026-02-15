import { authChallenge } from "./challenge";
import { encodeBase64 } from "@/encryption/base64";
import { Encryption } from "@/sync/encryption/encryption";
import sodium from '@/encryption/libsodium.lib';
import { isSessionSharingSupported } from '@/sync/api/capabilities/sessionSharingSupport';
import { serverFetch } from '@/sync/http/client';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

export async function authGetToken(secret: Uint8Array) {
    const { challenge, signature, publicKey } = authChallenge(secret);

    const body: any = {
        challenge: encodeBase64(challenge),
        signature: encodeBase64(signature),
        publicKey: encodeBase64(publicKey),
    };

    // Backward compatibility: only send new key fields when the server advertises support.
    // Older servers validate request bodies strictly and would reject unknown fields.
    const supportsSharing = await isSessionSharingSupported({ timeoutMs: 800 });
    if (supportsSharing) {
        const encryption = await Encryption.create(secret);
        const contentPublicKey = encryption.contentDataKey;

        const signingKeyPair = sodium.crypto_sign_seed_keypair(secret);
        const binding = new Uint8Array(CONTENT_KEY_BINDING_PREFIX.length + contentPublicKey.length);
        binding.set(CONTENT_KEY_BINDING_PREFIX, 0);
        binding.set(contentPublicKey, CONTENT_KEY_BINDING_PREFIX.length);
        const contentPublicKeySig = sodium.crypto_sign_detached(binding, signingKeyPair.privateKey);

        body.contentPublicKey = encodeBase64(contentPublicKey);
        body.contentPublicKeySig = encodeBase64(contentPublicKeySig);
    }

    const response = await serverFetch('/v1/auth', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    }, { includeAuth: false });
    if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status}`);
    }
    const data = await response.json() as { token: string };
    return data.token;
}
