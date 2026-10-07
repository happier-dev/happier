import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import {
    canonicalizeKeyChallengeV2AudienceOrigin,
    type KeyChallengeV2Audience,
} from '@happier-dev/protocol/auth/keyChallenge';

import {
    getServerProfileById,
    isServerProfilePersonalHomeBootstrapCompleted,
} from '@/sync/domains/server/serverProfiles';

export type ResolvedHomeAuthenticationTarget = Readonly<{
    endpointUrl: string;
    canonicalServerUrl: string;
    /**
     * The address fact this flow did not receive from the endpoint it is about to
     * contact, used to judge a first-contact key-challenge audience. A scanned or
     * pasted descriptor carries its own canonical URL out of band; a saved profile
     * only vouches for the address the person selected, because its
     * `canonicalServerUrl` may itself have been adopted from that endpoint's
     * feature response.
     */
    addressAnchorUrl: string;
    serverId: string;
    serverIdentityId: string;
}>;

export function resolveHomeAuthenticationTarget(target: HomeTargetInput): ResolvedHomeAuthenticationTarget | null {
    if (target.kind === 'saved_profile') {
        const profile = getServerProfileById(target.profileRef);
        const serverIdentityId = String(profile?.serverIdentityId ?? '').trim();
        const endpointUrl = String(profile?.serverUrl ?? '').trim();
        const canonicalServerUrl = String(profile?.canonicalServerUrl ?? endpointUrl).trim();
        if (!profile || !serverIdentityId || !endpointUrl || !canonicalServerUrl) return null;
        return {
            endpointUrl,
            canonicalServerUrl,
            addressAnchorUrl: endpointUrl,
            serverId: profile.id,
            serverIdentityId,
        };
    }
    if (target.kind === 'descriptor') {
        const endpointUrl = target.descriptor.endpoints.find((endpoint) => endpoint.kind === 'https')?.url
            ?? target.descriptor.canonicalServerUrl;
        return {
            endpointUrl,
            canonicalServerUrl: target.descriptor.canonicalServerUrl,
            addressAnchorUrl: target.descriptor.canonicalServerUrl,
            serverId: target.descriptor.homeServerIdentityId,
            serverIdentityId: target.descriptor.homeServerIdentityId,
        };
    }
    return null;
}

/**
 * Personal Home presentation must follow the identity-bound bootstrap receipt.
 * Descriptors and URLs deliberately do not imply purpose from their address or name.
 */
export function isPersonalHomeAuthenticationTarget(target: HomeTargetInput): boolean {
    return target.kind === 'saved_profile'
        && isServerProfilePersonalHomeBootstrapCompleted(getServerProfileById(target.profileRef));
}

/**
 * Resolves the exact stable Home audience used by Key Challenge proofs. Runtime
 * endpoints and device-local profile ids are routing facts and are never
 * promoted into the signed audience.
 */
export function resolveHomeKeyChallengeExpectedAudience(
    target: HomeTargetInput,
): Required<KeyChallengeV2Audience> | null {
    const resolved = resolveHomeAuthenticationTarget(target);
    const origin = resolved
        ? canonicalizeKeyChallengeV2AudienceOrigin(resolved.canonicalServerUrl)
        : null;
    if (!resolved || !origin) return null;
    return { origin, serverIdentityId: resolved.serverIdentityId };
}
