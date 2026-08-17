import { authChallenge } from "./challenge";
import { encodeBase64 } from "@/encryption/base64";
import { Encryption } from "@/sync/encryption/encryption";
import sodium from '@/encryption/libsodium.lib';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    assertCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import { serverFetch } from '@/sync/http/client';
import {
    AuthErrorCodeSchema,
    readServerEnabledBit,
    type KeyChallengeAuthRequest,
} from '@happier-dev/protocol';
import { HappyError } from '@/utils/errors/errors';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

export async function authGetToken(
    secret: Uint8Array,
    options?: Readonly<{
        expectedAccountId: string;
    }>,
) {
    const serverFeaturesSnapshot =
        await getServerFeaturesSnapshot({
            timeoutMs: 800,
            force: Boolean(options),
        });
    const serverFeatures =
        serverFeaturesSnapshot.status === 'ready'
            ? serverFeaturesSnapshot.features
            : null;
    if (serverFeatures) {
        // Backward compatibility:
        // - New servers explicitly advertise `features.auth.login.keyChallenge.enabled`.
        // - Older servers don't advertise it at all. In that case we must NOT fail fast,
        //   because key-challenge login may still be supported (the server just predates this gate).
        const keyChallengeEnabledRaw = (serverFeatures as any)?.features?.auth?.login?.keyChallenge?.enabled;
        if (typeof keyChallengeEnabledRaw === 'boolean' && keyChallengeEnabledRaw === false) {
            throw new Error('Authentication failed: key-challenge login is disabled on this server.');
        }
    }
    if (options) {
        assertCurrentAccountStoredContentServerCompatibility(
            serverFeaturesSnapshot,
        );
    }

    const { challenge, signature, publicKey } =
        authChallenge(secret, options);

    const body: KeyChallengeAuthRequest = {
        challenge: encodeBase64(challenge),
        signature: encodeBase64(signature),
        publicKey: encodeBase64(publicKey),
        ...(options
            ? {
                expectedAccountId:
                    options.expectedAccountId,
            }
            : {}),
    };

    // Backward compatibility: only send new key fields when the server advertises support.
    // Older servers validate request bodies strictly and would reject unknown fields.
    const supportsContentKeys =
        serverFeatures ? readServerEnabledBit(serverFeatures, 'sharing.contentKeys') === true : false;
    if (supportsContentKeys || options) {
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
        let code: string | undefined;
        try {
            const payload = await response.json() as unknown;
            const candidate = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
                ? (payload as { error?: unknown }).error
                : undefined;
            const parsed = AuthErrorCodeSchema.safeParse(candidate);
            if (parsed.success) {
                code = parsed.data;
            }
        } catch {
            // A non-JSON failure still retains its HTTP classification below.
        }

        const isServerFailure = response.status >= 500;
        throw new HappyError(
            `Authentication failed: ${response.status}`,
            isServerFailure,
            {
                status: response.status,
                kind: isServerFailure ? 'server' : 'auth',
                ...(code ? { code } : {}),
            },
        );
    }
    const data = await response.json() as { token: string };
    return data.token;
}
