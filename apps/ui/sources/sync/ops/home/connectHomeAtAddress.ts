import { Platform } from 'react-native';

import { TokenStorage } from '@/auth/storage/tokenStorage';

import {
    resolveEndpointReachabilityRemediation,
    type EndpointReachabilityRemediation,
} from '@/components/serverReachability/remediation';
import { observeAuthenticatedServerFeaturesFresh, probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import { adoptHomeProfileWithCredentials } from '@/sync/domains/server/adoptHomeProfile';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    adoptHomeProfile,
    defaultHomeNameForAddress,
    resolveServerProfileForPortableIdentity,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { isInsecureRemoteHttpServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { createEndpointReadinessProbe } from '@/sync/runtime/connectivity/createEndpointReadinessProbe';
import { isDesktopHost } from '@/utils/platform/desktopHost';

export type HomeAddressChangeConfirmation = Readonly<{ previousUrl: string; nextUrl: string }>;

export type ConnectHomeAtAddressInput = Readonly<{
    serverUrl: string;
    displayName?: string;
    source?: 'manual' | 'url' | 'notification';
    signal?: AbortSignal;
    confirmInsecureHttp: () => Promise<boolean>;
    confirmCanonicalUrl: (addressChange?: HomeAddressChangeConfirmation) => Promise<boolean>;
}>;

export type ConnectHomeAtAddressResult =
    | Readonly<{ kind: 'invalid_address' | 'declined' | 'mixed_content' }>
    | Readonly<{ kind: 'identity_mismatch'; home: string }>
    | Readonly<{ kind: 'unreachable'; remediation: EndpointReachabilityRemediation | null }>
    | Readonly<{ kind: 'connected'; profile: ServerProfile }>;

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const error = new Error('Home connection cancelled');
    error.name = 'AbortError';
    throw error;
}

/**
 * Connects a manually entered or supplied Home address without changing device focus. Every
 * check and confirmation finishes before profile adoption, which is the single commit point.
 * Once adoption begins it is not cancellable; a successful commit is always reported as connected.
 */
export async function connectHomeAtAddress(input: ConnectHomeAtAddressInput): Promise<ConnectHomeAtAddressResult> {
    throwIfAborted(input.signal);
    const enteredUrl = canonicalizeServerUrl(input.serverUrl);
    if (!enteredUrl) return { kind: 'invalid_address' };

    if (isInsecureRemoteHttpServerUrl(enteredUrl)) {
        const accepted = await input.confirmInsecureHttp();
        throwIfAborted(input.signal);
        if (!accepted) return { kind: 'declined' };
    }

    const readiness = await createEndpointReadinessProbe({
        endpoint: enteredUrl,
        token: null,
        ...(input.signal ? { signal: input.signal } : {}),
    })();
    throwIfAborted(input.signal);
    if (readiness.status === 'retry_later' && readiness.blockedBy === 'mixed_content') {
        return { kind: 'mixed_content' };
    }
    if (readiness.status !== 'ready') {
        return {
            kind: 'unreachable',
            remediation: resolveEndpointReachabilityRemediation({
                endpointUrl: enteredUrl,
                readiness,
                platformOs: Platform.OS,
                isDesktopShell: isDesktopHost(),
            }),
        };
    }

    const snapshot = await probeServerFeaturesAtUrl({
        endpointUrl: enteredUrl,
        // Home admission has no feature fallback: let the shared probe own its
        // request deadline instead of treating a short foreground wait as failure.
        timeoutMs: 0,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);
    if (snapshot.status !== 'ready') return { kind: 'unreachable', remediation: null };
    const advertisedUrl = canonicalizeServerUrl(snapshot.features.capabilities.server?.canonicalServerUrl ?? '');
    const learnedIdentity = snapshot.serverIdentityId
        ?? snapshot.features.capabilities.serverIdentity?.serverIdentityId
        ?? undefined;

    let canonicalServerUrl: string | undefined;
    if (advertisedUrl && advertisedUrl !== enteredUrl) {
        const accepted = await input.confirmCanonicalUrl();
        throwIfAborted(input.signal);
        if (accepted) canonicalServerUrl = advertisedUrl;
    } else if (advertisedUrl) {
        canonicalServerUrl = advertisedUrl;
    }

    if (canonicalServerUrl && canonicalServerUrl !== enteredUrl && isInsecureRemoteHttpServerUrl(canonicalServerUrl)) {
        const accepted = await input.confirmInsecureHttp();
        throwIfAborted(input.signal);
        if (!accepted) canonicalServerUrl = undefined;
    }

    throwIfAborted(input.signal);
    if (!canonicalServerUrl && learnedIdentity) {
        const existing = resolveServerProfileForPortableIdentity(learnedIdentity);
        if (existing.kind === 'resolved' && existing.profile.homeConnectionDescriptor) {
            // Keeping the entered URL grants no authority to replace a revisioned
            // descriptor. Continue with the established Home unchanged instead.
            return { kind: 'connected', profile: existing.profile };
        }
    }
    if (canonicalServerUrl && learnedIdentity) {
        const existing = resolveServerProfileForPortableIdentity(learnedIdentity);
        if (existing.kind === 'resolved' && existing.profile.homeConnectionDescriptor
            && createServerUrlComparableKey(existing.profile.canonicalServerUrl ?? existing.profile.serverUrl)
            !== createServerUrlComparableKey(canonicalServerUrl)) {
            const credentials = await TokenStorage.getCredentialsForServerUrl(
                existing.profile.canonicalServerUrl ?? existing.profile.serverUrl,
                { serverId: learnedIdentity },
            );
            throwIfAborted(input.signal);
            if (credentials) {
                // A public identity claim alone cannot authorize forwarding an incumbent
                // credential to another origin, including an address supplied by a link.
                const accepted = await input.confirmCanonicalUrl({
                    previousUrl: existing.profile.canonicalServerUrl ?? existing.profile.serverUrl,
                    nextUrl: enteredUrl,
                });
                throwIfAborted(input.signal);
                if (!accepted) return { kind: 'declined' };
                // The public projection cannot replace a saved generation. Observe the
                // exact descriptor at the address the user reached, without staging a
                // profile or switching focus before identity and credentials are proven.
                const observation = await observeAuthenticatedServerFeaturesFresh({
                    request: createServerFetchAtEndpoint({
                        endpointUrl: enteredUrl,
                        serverId: learnedIdentity,
                        credentials,
                        ...(input.signal ? { signal: input.signal } : {}),
                    }),
                });
                throwIfAborted(input.signal);
                if (observation.status !== 'ready') return { kind: 'unreachable', remediation: null };
                const descriptor = observation.features.homeConnectionDescriptor;
                if (observation.serverIdentityId !== learnedIdentity
                    || (descriptor && descriptor.homeServerIdentityId !== learnedIdentity)) {
                    return { kind: 'identity_mismatch', home: existing.profile.name };
                }
                if (!descriptor || createServerUrlComparableKey(descriptor.canonicalServerUrl)
                    !== createServerUrlComparableKey(canonicalServerUrl)) {
                    return { kind: 'unreachable', remediation: null };
                }
                const profile = await adoptHomeProfileWithCredentials({
                    descriptor,
                    credentials,
                    source: existing.profile.source ?? input.source ?? 'manual',
                    preserveUserLabel: true,
                    descriptorAuthority: 'current_connection_observation',
                    shouldCancel: () => input.signal?.aborted === true,
                });
                return { kind: 'connected', profile };
            }
            return { kind: 'unreachable', remediation: null };
        }
    }
    const saved = await adoptHomeProfile({
        descriptor: {
            serverUrl: enteredUrl,
            ...(canonicalServerUrl ? { canonicalServerUrl } : {}),
            displayName: input.displayName?.trim() || defaultHomeNameForAddress(enteredUrl),
            ...(learnedIdentity ? { homeServerIdentityId: learnedIdentity } : {}),
        },
        source: input.source ?? 'manual',
        preserveUserLabel: true,
    });
    return { kind: 'connected', profile: saved };
}
