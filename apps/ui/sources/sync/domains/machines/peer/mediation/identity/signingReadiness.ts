import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';

export const PEER_ROUTE_SIGNING_IDENTITY_REQUIRED_CAPABILITY = 'peer_route_signing_identity_v1' as const;
export const PEER_ROUTE_SIGNING_IDENTITY_UNAVAILABLE_REASON = 'peer_route_signing_identity_unavailable' as const;

export type PeerRouteSigningReadiness =
    | Readonly<{
        status: 'ready';
        credentialMode: 'legacy_account_signing';
        signingIdentity: 'account_signing_v1';
    }>
    | Readonly<{
        status: 'unavailable';
        credentialMode: 'data_key_keyless';
        reasonCode: typeof PEER_ROUTE_SIGNING_IDENTITY_UNAVAILABLE_REASON;
        requiredCapability: typeof PEER_ROUTE_SIGNING_IDENTITY_REQUIRED_CAPABILITY;
    }>;

export type PeerRouteSigningIdentityUnavailable = Extract<PeerRouteSigningReadiness, { status: 'unavailable' }>;

export function resolvePeerRouteSigningReadiness(credentials: AuthCredentials): PeerRouteSigningReadiness {
    if (isLegacyAuthCredentials(credentials)) {
        return {
            status: 'ready',
            credentialMode: 'legacy_account_signing',
            signingIdentity: 'account_signing_v1',
        };
    }
    return {
        status: 'unavailable',
        credentialMode: 'data_key_keyless',
        reasonCode: PEER_ROUTE_SIGNING_IDENTITY_UNAVAILABLE_REASON,
        requiredCapability: PEER_ROUTE_SIGNING_IDENTITY_REQUIRED_CAPABILITY,
    };
}

export function createPeerRouteSigningIdentityUnavailableError(
    readiness: PeerRouteSigningIdentityUnavailable,
): Error & Readonly<{
    code: typeof PEER_ROUTE_SIGNING_IDENTITY_UNAVAILABLE_REASON;
    reasonCode: typeof PEER_ROUTE_SIGNING_IDENTITY_UNAVAILABLE_REASON;
    requiredCapability: typeof PEER_ROUTE_SIGNING_IDENTITY_REQUIRED_CAPABILITY;
}> {
    return Object.assign(new Error(readiness.reasonCode), {
        code: readiness.reasonCode,
        reasonCode: readiness.reasonCode,
        requiredCapability: readiness.requiredCapability,
    });
}
