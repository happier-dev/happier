import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getServerProfileById, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { probeServerFeaturesAtUrl, refreshAuthenticatedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

/** A transient native degradation is not authority to restart or retire a pinned carrier. */
export async function refreshDegradedHomeDescriptor(profile: ServerProfile, credentials: AuthCredentials): Promise<boolean> {
    const descriptor = profile.homeConnectionDescriptor;
    const https = descriptor?.endpoints.find(endpoint => endpoint.kind === 'https');
    if (!descriptor || !https) return false;
    // Prove the declared endpoint's Home before sending its scoped credential.
    const identity = await probeServerFeaturesAtUrl(descriptor.canonicalServerUrl, {
        runtimeOrigin: https.url, serverId: profile.id, force: true,
    });
    if (identity.status !== 'ready' || identity.serverIdentityId !== descriptor.homeServerIdentityId) return false;
    // The feature/profile owners parse and adjudicate the exact revision. Public
    // absence, stale revisions and equal-revision conflicts cannot retire Iroh.
    const observed = await refreshAuthenticatedServerFeaturesSnapshot({
        credentials, serverId: profile.id, force: true,
        scopedTransport: { canonicalServerUrl: descriptor.canonicalServerUrl,
            runtimeOrigin: https.url, carrier: 'https', release: async () => {} },
    });
    return observed.status === 'ready'
        && (getServerProfileById(profile.id)?.homeConnectionDescriptor?.revision ?? 0) > descriptor.revision;
}
