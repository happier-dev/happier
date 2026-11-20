import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';

import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { buildHomeConnectionDescriptorForProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

export function resolveReversePairingHome(profile: ServerProfile, publicDiscovery?: Readonly<{
    serverIdentityId: string | null;
    descriptor?: HomeConnectionDescriptorV1;
}>): Readonly<{ descriptor: HomeConnectionDescriptorV1; requiresAuthenticatedObservation: boolean }> | null {
    const stored = buildHomeConnectionDescriptorForProfile(profile);
    if (stored && profile.serverIdentityId === stored.homeServerIdentityId) {
        return { descriptor: stored, requiresAuthenticatedObservation: false };
    }
    const descriptor = publicDiscovery?.descriptor;
    if (!publicDiscovery || !descriptor || descriptor.homeServerIdentityId !== publicDiscovery.serverIdentityId) return null;
    if (profile.serverIdentityId && profile.serverIdentityId !== descriptor.homeServerIdentityId) return null;

    // Fresh devices have a redacted public observation. It can start the credentialless
    // request on the exact HTTPS Home reached by Welcome. Only authenticated features
    // can establish the stored descriptor after approval.
    const contactedHome = createServerUrlComparableKey(profile.serverUrl);
    if (!contactedHome || createServerUrlComparableKey(descriptor.canonicalServerUrl) !== contactedHome) return null;
    if (!descriptor.endpoints.some((endpoint) => endpoint.kind === 'https'
        && createServerUrlComparableKey(endpoint.url) === contactedHome)) return null;
    return {
        descriptor: { ...descriptor, endpoints: [{ kind: 'https', url: descriptor.canonicalServerUrl }] },
        requiresAuthenticatedObservation: true,
    };
}

export function resolveObservedReversePairingHome(profile: ServerProfile) {
    const observation = getCachedServerFeaturesSnapshot({ serverId: profile.id });
    return resolveReversePairingHome(profile, observation?.status === 'ready' ? {
        serverIdentityId: observation.serverIdentityId ?? null,
        descriptor: observation.features.homeConnectionDescriptor,
    } : undefined);
}
