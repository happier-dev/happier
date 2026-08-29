import { authChallenge, authChallengeV2 } from "./challenge";
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
    canonicalizeKeyChallengeV2AudienceOrigin,
    KeyChallengeV2IssueResponseSchema,
    readServerEnabledBit,
    type KeyChallengeAuthRequest,
} from '@happier-dev/protocol';
import { HappyError } from '@/utils/errors/errors';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

function resolveSelectedKeyChallengeV2Audience(): Readonly<{
    origin: string;
    serverIdentityId: string;
}> {
    const active = getActiveServerSnapshot();
    const profile = getServerProfileById(active.serverId);
    const origin = profile
        ? canonicalizeKeyChallengeV2AudienceOrigin(profile.serverUrl)
        : null;
    if (!origin || !profile?.serverIdentityId) {
        throw new Error('Authentication failed: selected server identity is unavailable for key-challenge v2.');
    }
    return { origin, serverIdentityId: profile.serverIdentityId };
}

async function throwAuthenticationFailure(response: Pick<Response, 'status' | 'json'>): Promise<never> {
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

export async function authGetToken(
    secret: Uint8Array,
    options?: Readonly<{
        expectedAccountId: string;
    }>,
) {
    const serverFeaturesSnapshot =
        await getServerFeaturesSnapshot({
            timeoutMs: 800,
            // The assertion scheme is selected from this response. A ready cached v1
            // snapshot must not keep ordinary login on replayable v1 after a server
            // has upgraded to v2. Errors still fail closed in the feature owner.
            force: true,
        });
    if (options) {
        assertCurrentAccountStoredContentServerCompatibility(
            serverFeaturesSnapshot,
        );
    }
    if (serverFeaturesSnapshot.status !== 'ready') {
        throw new HappyError(
            'Authentication failed: server capability probe did not return a valid response.',
            true,
            {
                kind:
                    serverFeaturesSnapshot.status === 'error'
                    && serverFeaturesSnapshot.reason === 'response_status'
                        ? 'server'
                        : 'network',
            },
        );
    }

    const serverFeatures = serverFeaturesSnapshot.features;
    // Backward compatibility:
    // - New servers explicitly advertise `features.auth.login.keyChallenge.enabled`.
    // - Older servers don't advertise it at all. In that case we must NOT fail fast,
    //   because key-challenge login may still be supported (the server just predates this gate).
    const keyChallengeEnabledRaw = (serverFeatures as any)?.features?.auth?.login?.keyChallenge?.enabled;
    if (typeof keyChallengeEnabledRaw === 'boolean' && keyChallengeEnabledRaw === false) {
        throw new Error('Authentication failed: key-challenge login is disabled on this server.');
    }

    const supportsKeyChallengeV2 =
        serverFeatures.capabilities.auth.keyChallenge.v2 === true;
    if (options && !supportsKeyChallengeV2) {
        throw new Error('Authentication failed: key-challenge v2 is required for Account-bound login.');
    }
    let body: KeyChallengeAuthRequest;
    if (supportsKeyChallengeV2) {
        const issueResponse = await serverFetch('/v1/auth/challenge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(
                options ? { expectedAccountId: options.expectedAccountId } : {},
            ),
        }, { includeAuth: false });
        if (!issueResponse.ok) {
            await throwAuthenticationFailure(issueResponse);
        }
        let issuePayload: unknown;
        try {
            issuePayload = await issueResponse.json();
        } catch {
            throw new Error('Authentication failed: invalid key-challenge v2 response.');
        }
        const parsedIssue = KeyChallengeV2IssueResponseSchema.safeParse(issuePayload);
        if (!parsedIssue.success) {
            throw new Error('Authentication failed: invalid key-challenge v2 response.');
        }
        const assertion = authChallengeV2(secret, {
            challenge: parsedIssue.data,
            expectedAudience: resolveSelectedKeyChallengeV2Audience(),
            ...(options ? { expectedAccountId: options.expectedAccountId } : {}),
        });
        body = {
            challengeId: parsedIssue.data.challengeId,
            signature: encodeBase64(assertion.signature),
            publicKey: encodeBase64(assertion.publicKey),
            ...(options ? { expectedAccountId: options.expectedAccountId } : {}),
        };
    } else {
        const assertion = authChallenge(secret, options);
        body = {
            challenge: encodeBase64(assertion.challenge),
            signature: encodeBase64(assertion.signature),
            publicKey: encodeBase64(assertion.publicKey),
            ...(options ? { expectedAccountId: options.expectedAccountId } : {}),
        };
    }

    // Backward compatibility: only send new key fields when the server advertises support.
    // Older servers validate request bodies strictly and would reject unknown fields.
    const supportsContentKeys =
        readServerEnabledBit(serverFeatures, 'sharing.contentKeys') === true;
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
        await throwAuthenticationFailure(response);
    }
    const data = await response.json() as { token: string };
    return data.token;
}
