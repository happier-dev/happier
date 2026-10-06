import { authChallenge, authChallengeV2 } from './challenge';
import { createAuthenticationFailure } from './authenticationFailure';
import { confirmAlternateIssuedHomeAddress } from './homeAddressTrust';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import sodium from '@/encryption/libsodium.lib';
import {
    FOREGROUND_FEATURE_PROBE_WAIT_BUDGET_MS,
    getServerFeaturesSnapshot,
    probeServerFeaturesAtUrl,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import * as serverHttp from '@/sync/http/client';
import type { ServerFetch, ServerFetchOptions } from '@/sync/http/client';
import {
    canonicalizeKeyChallengeV2AudienceOrigin,
    KeyChallengeV2IssueResponseSchema,
    readServerEnabledBit,
    signAccountContentKeyBindingV1,
    type KeyChallengeAuthRequest,
    type KeyChallengeV2IssueResponse,
} from '@happier-dev/protocol';
import type { TeamInvitationAccountAdmissionV1 } from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

type AuthRequest = (
    path: string,
    init?: RequestInit,
    options?: ServerFetchOptions,
) => Promise<Response>;

type AuthCredentialTarget = 'ordinary_home' | 'account_directory';

function resolveKeyAuthPaths(target: AuthCredentialTarget): Readonly<{
    challenge: string;
    redeem: string;
}> {
    return target === 'account_directory'
        ? {
            challenge: '/v1/auth/account-directory/challenge',
            redeem: '/v1/auth/account-directory',
        }
        : {
            challenge: '/v1/auth/challenge',
            redeem: '/v1/auth',
        };
}

type AuthTokenCoreParams = Readonly<{
    secret: Uint8Array;
    expectedAccountId?: string;
    expectedServerIdentityId?: string;
    admission?: TeamInvitationAccountAdmissionV1;
    requireExistingAccount?: true;
    /**
     * A challenge the Home already issued for this exact Account inside a
     * verified native flow. Reusing it is what carries that flow's server-owned
     * evidence into the credential; issuing a second challenge here would
     * silently downgrade the credential's recorded provenance.
     */
    issuedChallenge?: KeyChallengeV2IssueResponse;
    requireKeyChallengeV2: boolean;
    credentialTarget: AuthCredentialTarget;
    request: AuthRequest;
    probe: () => Promise<ServerFeaturesSnapshot>;
    resolveAudience: (features: ServerFeaturesSnapshot & { status: 'ready' }) => Readonly<{
        origin: string;
        serverIdentityId: string;
    }>;
}>;

function readObservedServerIdentityId(
    snapshot: ServerFeaturesSnapshot & { status: 'ready' },
): string | null {
    return String(
        snapshot.serverIdentityId
        ?? snapshot.features.capabilities.serverIdentity.serverIdentityId
        ?? '',
    ).trim() || null;
}

function throwEndpointIdentityMismatch(): never {
    throw new HappyError(
        'Authentication failed: selected server identity does not match the endpoint.',
        false,
        { kind: 'auth' },
    );
}

function readNestedBoolean(
    value: unknown,
    path: readonly string[],
): boolean | undefined {
    let current: unknown = value;
    for (const segment of path) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === 'boolean' ? current : undefined;
}

/**
 * `anchorUrl` is the focused Home's address captured *before* this authentication
 * probed it. A Home's own feature response can carry a connection descriptor that
 * rewrites the profile's canonical URL, so reading that URL afterwards would let
 * the endpoint under judgement choose the address it is judged against.
 */
function resolveSelectedKeyChallengeV2Audience(anchorUrl: string): Readonly<{
    origin: string;
    serverIdentityId: string;
}> {
    const active = getActiveServerSnapshot();
    const profile = getServerProfileById(active.serverId);
    const origin = canonicalizeKeyChallengeV2AudienceOrigin(anchorUrl);
    if (!origin || !profile?.serverIdentityId) {
        throw new Error('Authentication failed: selected server identity is unavailable for key-challenge v2.');
    }
    return { origin, serverIdentityId: profile.serverIdentityId };
}

async function throwAuthenticationFailure(response: Pick<Response, 'status' | 'json'>, target: AuthCredentialTarget): Promise<never> {
    throw createAuthenticationFailure(response.status, await response.json().catch(() => null), target);
}

function readAuthToken(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Authentication failed: invalid auth response.');
    }
    const token = (payload as { token?: unknown }).token;
    if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('Authentication failed: invalid auth response.');
    }
    return token;
}

async function authGetTokenCore(params: AuthTokenCoreParams): Promise<AuthCredentials> {
    const authPaths = resolveKeyAuthPaths(params.credentialTarget);
    const serverFeaturesSnapshot = await params.probe();
    const mayUseReleasedV1Fallback =
        params.credentialTarget === 'ordinary_home'
        && params.expectedAccountId === undefined
        && params.expectedServerIdentityId === undefined
        && !params.requireKeyChallengeV2;
    if (serverFeaturesSnapshot.status !== 'ready' && !mayUseReleasedV1Fallback) {
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
    const readyServerFeaturesSnapshot = serverFeaturesSnapshot.status === 'ready'
        ? serverFeaturesSnapshot
        : null;
    if (readyServerFeaturesSnapshot) {
        const observedServerIdentityId = readObservedServerIdentityId(
            readyServerFeaturesSnapshot,
        );
        if (
            params.expectedServerIdentityId
            && observedServerIdentityId !== params.expectedServerIdentityId
        ) {
            throwEndpointIdentityMismatch();
        }

        // Newer servers advertise this gate under the feature payload. Older
        // servers omit it, and omission remains compatible with v1 login.
        const keyChallengeEnabledRaw = readNestedBoolean(
            readyServerFeaturesSnapshot.features,
            ['features', 'auth', 'login', 'keyChallenge', 'enabled'],
        );
        if (keyChallengeEnabledRaw === false) {
            throw new Error('Authentication failed: key-challenge login is disabled on this server.');
        }
    }

    const supportsKeyChallengeV2 =
        readyServerFeaturesSnapshot?.features.capabilities.auth.keyChallenge.v2 === true;
    const requireKeyChallengeV2 =
        params.requireKeyChallengeV2
        || params.credentialTarget === 'account_directory';
    if (requireKeyChallengeV2 && !supportsKeyChallengeV2) {
        throw new Error('Authentication failed: key-challenge v2 is required for Account-bound login.');
    }

    let body: KeyChallengeAuthRequest;
    if (supportsKeyChallengeV2 && readyServerFeaturesSnapshot) {
        let issuedChallenge = params.issuedChallenge;
        if (!issuedChallenge) {
            const issueResponse = await params.request(authPaths.challenge, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(
                    params.expectedAccountId
                        ? { expectedAccountId: params.expectedAccountId }
                        : {},
                ),
            }, { includeAuth: false });
            if (!issueResponse.ok) {
                await throwAuthenticationFailure(issueResponse, params.credentialTarget);
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
            issuedChallenge = parsedIssue.data;
        }
        const expectedAudience = params.resolveAudience(readyServerFeaturesSnapshot);
        const acceptAlternateOrigin =
            issuedChallenge.audience.origin !== expectedAudience.origin
            && await confirmAlternateIssuedHomeAddress({
                issued: issuedChallenge.audience,
                expected: expectedAudience,
            });
        const assertion = authChallengeV2(params.secret, {
            challenge: issuedChallenge,
            expectedAudience,
            ...(acceptAlternateOrigin ? { acceptAlternateOrigin: true } : {}),
            ...(params.expectedAccountId ? { expectedAccountId: params.expectedAccountId } : {}),
            ...(params.requireExistingAccount ? { requireExistingAccount: true } : {}),
        });
        body = {
            challengeId: issuedChallenge.challengeId,
            signature: encodeBase64(assertion.signature),
            publicKey: encodeBase64(assertion.publicKey),
            ...(params.expectedAccountId ? { expectedAccountId: params.expectedAccountId } : {}),
            ...(params.admission ? { admission: params.admission } : {}),
            ...(params.requireExistingAccount ? { requireExistingAccount: true } : {}),
        };
    } else {
        const assertion = authChallenge(params.secret, params.expectedAccountId
            ? { expectedAccountId: params.expectedAccountId }
            : undefined);
        body = {
            challenge: encodeBase64(assertion.challenge),
            signature: encodeBase64(assertion.signature),
            publicKey: encodeBase64(assertion.publicKey),
            ...(params.expectedAccountId ? { expectedAccountId: params.expectedAccountId } : {}),
            ...(params.admission ? { admission: params.admission } : {}),
        };
    }

    // A v2 Home can repair a proven 0.2 Account's missing content-key binding
    // during ordinary secret-key sign-in, even without content-key sharing.
    // Retain the released v1 feature negotiation for older Homes.
    const supportsContentKeys = readyServerFeaturesSnapshot
        ? readServerEnabledBit(readyServerFeaturesSnapshot.features, 'sharing.contentKeys') === true
        : false;
    if (supportsContentKeys || supportsKeyChallengeV2 || params.expectedAccountId || params.requireExistingAccount) {
        const encryption = await Encryption.create(params.secret);
        const contentPublicKey = encryption.contentDataKey;

        const signingKeyPair = sodium.crypto_sign_seed_keypair(params.secret);
        const contentPublicKeySig = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signingKeyPair.privateKey,
            contentPublicKey,
        });

        body.contentPublicKey = encodeBase64(contentPublicKey);
        body.contentPublicKeySig = encodeBase64(contentPublicKeySig);
    }

    const response = await params.request(authPaths.redeem, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    }, { includeAuth: false });
    if (!response.ok) {
        await throwAuthenticationFailure(response, params.credentialTarget);
    }
    const payload: unknown = await response.json();
    return { token: readAuthToken(payload) };
}

/**
 * Authenticate against the focused Home. This compatibility wrapper retains
 * the historical string return and focused-server feature probe; all protocol
 * and signing decisions live in `authGetTokenCore`.
 */
export async function authGetToken(
    secret: Uint8Array,
    options?: Readonly<{
        expectedAccountId: string;
    }>,
): Promise<string> {
    const addressAnchorUrl = getActiveServerSnapshot().serverUrl;
    const credentials = await authGetTokenCore({
        secret,
        ...(options ? { expectedAccountId: options.expectedAccountId } : {}),
        requireKeyChallengeV2: Boolean(options),
        credentialTarget: 'ordinary_home',
        request: serverHttp.serverFetch,
        probe: async () => await getServerFeaturesSnapshot({
            // Always refresh the assertion scheme before login. A stale v1
            // snapshot must not keep an upgraded server on replayable v1.
            force: true,
            // Only an unbound login can use the released v1 fallback. Account-
            // bound login needs discovery and inherits the shared attempt bound.
            ...(options ? {} : { timeoutMs: FOREGROUND_FEATURE_PROBE_WAIT_BUDGET_MS }),
        }),
        resolveAudience: () => resolveSelectedKeyChallengeV2Audience(addressAnchorUrl),
    });
    return credentials.token;
}

export type AuthGetTokenAtEndpointParams = Readonly<{
    endpointUrl: string;
    /** Ephemeral request address; never used as the signed auth audience. */
    runtimeOrigin?: string;
    /**
     * Address fact this flow did not receive from `endpointUrl` itself — a scanned
     * or pasted Home descriptor's canonical URL. First contact is judged against
     * it; without one, the contacted endpoint is the anchor. A `canonicalServerUrl`
     * read back from a saved profile is not one, because the endpoint's own feature
     * response can rewrite it.
     */
    addressAnchorUrl?: string;
    /** Semantic browser/native carrier for this exact Home request. */
    homeCarrier?: HomeCarrier;
    signal?: AbortSignal;
    /** Captured flow lifetime; checked before each authentication request and result. */
    isCurrent?: () => boolean;
    serverId?: string;
    canonicalServerUrl?: string;
    serverIdentityId?: string;
    expectedAccountId?: string;
    admission?: TeamInvitationAccountAdmissionV1;
    /** Refuse to turn an unknown recovery key into a newly provisioned Account. */
    requireExistingAccount?: true;
    /** Reuse a challenge the Home already issued inside a verified native flow. */
    issuedChallenge?: KeyChallengeV2IssueResponse;
    secret: Uint8Array;
    requireKeyChallengeV2: boolean;
    /** Selects the dedicated server-controlled restricted mint route. */
    credentialTarget?: 'account_directory';
    /** Reuse the exact ready snapshot already verified during explicit endpoint discovery. */
    verifiedServerFeaturesSnapshot?: ServerFeaturesSnapshot & { status: 'ready' };
}>;

/**
 * Authenticate against an explicitly selected Home/Account Service endpoint.
 * `canonicalServerUrl` is the stable v2 audience; any runtime transport origin
 * belongs only to the request factory and is never used for signing.
 */
export async function authGetTokenAtEndpoint(
    params: AuthGetTokenAtEndpointParams,
): Promise<AuthCredentials> {
    const assertCurrent = () => {
        if (params.signal?.aborted || params.isCurrent?.() === false) {
            const error = new Error('Authentication cancelled');
            error.name = 'AbortError';
            throw error;
        }
    };
    assertCurrent();
    const anchorUrl = String(params.addressAnchorUrl ?? params.endpointUrl ?? '').trim();
    const expectedServerIdentityId = String(params.serverIdentityId ?? '').trim() || null;
    const targetServerId = String(params.serverId ?? expectedServerIdentityId ?? '').trim() || undefined;
    const endpointRequest = serverHttp.createServerFetchAtEndpoint({
        endpointUrl: params.endpointUrl,
        ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
        ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
        serverId: targetServerId,
        credentials: null,
        signal: params.signal,
    });
    const request: AuthRequest = async (path, init, options) => {
        assertCurrent();
        const response = await endpointRequest(path, init, options);
        assertCurrent();
        return response;
    };
    const credentials = await authGetTokenCore({
        secret: params.secret,
        ...(params.expectedAccountId ? { expectedAccountId: params.expectedAccountId } : {}),
        ...(params.admission ? { admission: params.admission } : {}),
        ...(params.requireExistingAccount ? { requireExistingAccount: true } : {}),
        ...(expectedServerIdentityId ? { expectedServerIdentityId } : {}),
        ...(params.issuedChallenge ? { issuedChallenge: params.issuedChallenge } : {}),
        requireKeyChallengeV2: params.requireKeyChallengeV2,
        credentialTarget: params.credentialTarget ?? 'ordinary_home',
        request,
        probe: async () => params.verifiedServerFeaturesSnapshot ?? await probeServerFeaturesAtUrl({
                endpointUrl: params.endpointUrl,
                ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
                ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
                serverId: targetServerId,
                signal: params.signal,
                force: true,
            }),
        resolveAudience: (snapshot) => {
            const origin = canonicalizeKeyChallengeV2AudienceOrigin(anchorUrl);
            const observedIdentity = readObservedServerIdentityId(snapshot);
            if (!origin || !(expectedServerIdentityId ?? observedIdentity)) {
                throw new Error('Authentication failed: selected server identity is unavailable for key-challenge v2.');
            }
            return {
                origin,
                serverIdentityId: expectedServerIdentityId ?? observedIdentity!,
            };
        },
    });
    assertCurrent();
    return credentials;
}
