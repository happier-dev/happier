import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { buildEstablishedHomeTransportDescriptor, resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import {
    buildHomeConnectionDescriptorForProfile, getActiveServerUrl, listServerProfiles,
    resolveServerProfileForPortableIdentity, type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import type { ParsedTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';

type TerminalApprovalTarget = Readonly<{
    endpointUrl: string;
    serverId?: string;
    descriptor?: HomeConnectionDescriptorV1;
    transportOptions?: Parameters<typeof resolveHomeEnrollmentTransport>[1];
    credentials: AuthCredentials | null;
}>;

/**
 * A Home is identified by its stable `serverIdentityId`; hostnames and ports are only
 * routing facts. A daemon pairing on this machine therefore advertises its own loopback
 * address for a Home this device may already know under a different host, so the link's
 * identity — not its URL — selects the signed-in profile.
 *
 * URL comparison survives only for a link that carries no identity at all, and then only
 * across profiles with no pinned identity of their own: an anonymous URL must never unlock
 * an identity-bound Home's credentials.
 */
function findSignedInProfileForTerminalLink(params: Readonly<{
    expectedServerIdentityId: string;
    endpointUrl: string;
}>): ServerProfile | null {
    const expectedServerIdentityId = params.expectedServerIdentityId.trim();
    if (expectedServerIdentityId) {
        const resolution = resolveServerProfileForPortableIdentity(expectedServerIdentityId);
        return resolution.kind === 'resolved' ? resolution.profile : null;
    }
    const targetKey = createServerUrlComparableKey(params.endpointUrl);
    if (!targetKey) return null;
    const matches = listServerProfiles().filter((profile) => (
        !profile.serverIdentityId
        && (
            createServerUrlComparableKey(profile.serverUrl) === targetKey
            || createServerUrlComparableKey(profile.canonicalServerUrl ?? '') === targetKey
            || createServerUrlComparableKey(profile.publicServerUrl ?? '') === targetKey
        )
    ));
    return matches.length === 1 ? matches[0]! : null;
}

export async function resolveTerminalApprovalTarget(params: Readonly<{
    parsed: ParsedTerminalConnectUrl;
    allowLoopbackServerOverride: boolean;
}>): Promise<TerminalApprovalTarget> {
    const focusedEndpointUrl = canonicalizeServerUrl(getActiveServerUrl());
    const expectedServerIdentityId = params.parsed.serverIdentityId ?? '';
    const suppliedDescriptor = params.parsed.homeConnectionDescriptor;
    const effectiveRequestedEndpointUrl = resolveEffectiveServerUrlOverride({
        requestedServerUrl: params.parsed.serverUrl ?? suppliedDescriptor?.canonicalServerUrl,
        activeServerUrl: focusedEndpointUrl,
        allowLoopbackOverride: params.allowLoopbackServerOverride,
    });
    if (suppliedDescriptor && suppliedDescriptor.homeServerIdentityId !== expectedServerIdentityId) {
        throw new Error('Terminal pairing descriptor identity does not match the link destination');
    }
    const requestedEndpointUrl = effectiveRequestedEndpointUrl
        || focusedEndpointUrl;
    if (!requestedEndpointUrl) throw new Error('Terminal pairing requires an explicit target server');

    const profile = findSignedInProfileForTerminalLink({
        expectedServerIdentityId,
        endpointUrl: requestedEndpointUrl,
    });
    const establishedEndpointUrl = profile ? profile.canonicalServerUrl ?? profile.serverUrl : requestedEndpointUrl;
    const endpointUrl = effectiveRequestedEndpointUrl || establishedEndpointUrl;
    // A link is discovery advice, not authority to reroute a saved Home's bearer.
    // Known credentials use that profile's published or established transport.
    // Loopback Homes publish no descriptor, so their established connection remains
    // the local-only fallback for identity-bearing URL-only pairing links.
    const publishedDescriptor = profile ? buildHomeConnectionDescriptorForProfile(profile) : null;
    const descriptor = profile
        ? publishedDescriptor
            ?? (profile.serverIdentityId
                ? buildEstablishedHomeTransportDescriptor({
                    canonicalServerUrl: profile.canonicalServerUrl ?? profile.serverUrl,
                    homeServerIdentityId: profile.serverIdentityId,
                })
                : null)
        : suppliedDescriptor;
    if (!profile || !descriptor) {
        return { endpointUrl, ...(descriptor ? { descriptor } : {}), credentials: null };
    }
    const serverId = expectedServerIdentityId.trim();
    const credentials = await TokenStorage.getCredentialsForServerUrl(
        profile.serverUrl,
        serverId ? { serverId } : {},
    );
    if (credentials) {
        const active = getActiveServerSnapshot();
        const isExactActiveHome = active.serverId === profile.serverIdentityId
            && createServerUrlComparableKey(active.serverUrl) === createServerUrlComparableKey(establishedEndpointUrl);
        const targetsEstablishedEndpoint = createServerUrlComparableKey(endpointUrl)
            === createServerUrlComparableKey(establishedEndpointUrl);
        const targetsActiveRuntimeOrigin = isExactActiveHome && Boolean(active.runtimeOrigin)
            && createServerUrlComparableKey(endpointUrl) === createServerUrlComparableKey(active.runtimeOrigin ?? '');
        const homeCarrier = isExactActiveHome ? getActiveServerHomeCarrier() : null;
        if (isExactActiveHome && (active.runtimeOrigin || homeCarrier)
            && (targetsActiveRuntimeOrigin || (!publishedDescriptor && targetsEstablishedEndpoint))) {
            // The connection owner has already authenticated this transport. Borrow it
            // even when the same Home's saved descriptor names another origin. A link
            // cannot establish that trust or replace the saved descriptor.
            return { endpointUrl, serverId, descriptor, credentials, transportOptions: {
                runtimeOrigin: active.runtimeOrigin,
                runtimeCarrier: active.carrier,
                homeCarrier,
            } };
        }
        if (!targetsEstablishedEndpoint) {
            // Preserve the explicit destination for fresh sign-in, rather than silently
            // approving another endpoint or disclosing a saved bearer to QR advice.
            return { endpointUrl, serverId, credentials: null };
        }
        if (!publishedDescriptor && profile.descriptorProvenance === 'advisory-only') {
            throw new Error('Terminal pairing requires the saved Home\'s verified transport');
        }
    }
    return { endpointUrl, ...(serverId ? { serverId } : {}), descriptor, credentials };
}
