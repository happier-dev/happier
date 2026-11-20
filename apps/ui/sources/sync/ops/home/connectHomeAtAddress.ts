import { Platform } from 'react-native';

import { TokenStorage } from '@/auth/storage/tokenStorage';

import {
    resolveEndpointReachabilityRemediation,
    type EndpointReachabilityRemediation,
} from '@/components/serverReachability/remediation';
import { observeAuthenticatedServerFeaturesFresh, primeServerFeaturesSnapshot, probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import { adoptHomeProfileWithCredentials } from '@/sync/domains/server/adoptHomeProfile';
import { readHomeAddressSelection, resolveHomeConnectionAddress, type HomeAddressSelection } from '@/sync/domains/server/homeAddressSelection';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    adoptHomeProfile,
    defaultHomeNameForAddress,
    isActiveServerSelectionExplicit,
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

    const resolution = learnedIdentity ? resolveServerProfileForPortableIdentity(learnedIdentity) : null;
    const existing = resolution?.kind === 'resolved' ? resolution.profile : null;
    const previousSelection = existing ? readHomeAddressSelection(existing) : undefined;
    let useCanonical = true;
    if (advertisedUrl && advertisedUrl !== enteredUrl) {
        useCanonical = previousSelection?.enteredUrl === enteredUrl
            && previousSelection.canonicalServerUrl === advertisedUrl
            ? previousSelection.useCanonical
            : await input.confirmCanonicalUrl();
        throwIfAborted(input.signal);
    }

    if (useCanonical && advertisedUrl && advertisedUrl !== enteredUrl && isInsecureRemoteHttpServerUrl(advertisedUrl)) {
        const accepted = await input.confirmInsecureHttp();
        throwIfAborted(input.signal);
        if (!accepted) useCanonical = false;
    }

    const canonicalServerUrl = advertisedUrl || existing?.canonicalServerUrl || existing?.serverUrl || enteredUrl;
    const addressSelection: HomeAddressSelection | undefined = learnedIdentity && advertisedUrl && advertisedUrl !== enteredUrl
        ? { serverIdentityId: learnedIdentity, enteredUrl, canonicalServerUrl: advertisedUrl, useCanonical }
        : undefined;
    throwIfAborted(input.signal);
    if (existing && learnedIdentity) {
        const previousUrl = existing.canonicalServerUrl ?? existing.serverUrl;
        const canonicalChanged = createServerUrlComparableKey(previousUrl) !== createServerUrlComparableKey(canonicalServerUrl);
        const unknownAddress = !useCanonical
            && createServerUrlComparableKey(enteredUrl) !== createServerUrlComparableKey(existing.serverUrl)
            && enteredUrl !== previousSelection?.enteredUrl;
        if (canonicalChanged || unknownAddress) {
            const credentials = await TokenStorage.getCredentialsForServerUrl(
                // Retained pre-fix profiles may have a different canonical metadata
                // URL. The credential owner admits only their established serverUrl.
                existing.serverUrl,
                { serverId: learnedIdentity, storageReadFailure: 'surface' },
            );
            throwIfAborted(input.signal);
            // Public discovery can persist a build's startup hint before a supplied
            // Home is opened. That hint is not a saved address-change authority.
            // Preserve consent for every chosen, adopted or authenticated Home.
            const unusedStartupHint = !credentials
                && !isActiveServerSelectionExplicit()
                && existing.lastUsedAt === 0
                && !existing.canonicalServerUrl
                && !existing.homeConnectionDescriptor
                && (existing.source === 'stack-env' || existing.source === 'url' || existing.source === 'preconfigured');
            if (!unusedStartupHint) {
                // Selecting Keep does not grant permission to route a saved Home's
                // future sign-in to an origin claiming its identity, even while signed out.
                const accepted = await input.confirmCanonicalUrl({ previousUrl, nextUrl: enteredUrl });
                throwIfAborted(input.signal);
                if (!accepted) return { kind: 'declined' };
            }
            if (credentials) {
                // A public identity claim alone cannot authorize forwarding an incumbent
                // credential to another origin, including an address supplied by a link.
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
                    return { kind: 'identity_mismatch', home: existing.name };
                }
                if ((existing.homeConnectionDescriptor && !descriptor)
                    || (descriptor && createServerUrlComparableKey(descriptor.canonicalServerUrl)
                        !== createServerUrlComparableKey(canonicalServerUrl))) {
                    return { kind: 'unreachable', remediation: null };
                }
                if (canonicalChanged) {
                    const profile = await adoptHomeProfileWithCredentials({
                        descriptor: descriptor ?? { serverUrl: canonicalServerUrl, canonicalServerUrl, homeServerIdentityId: learnedIdentity },
                        credentials,
                        source: existing.source ?? input.source ?? 'manual',
                        preserveUserLabel: true,
                        ...(addressSelection ? { addressSelection } : {}),
                        descriptorAuthority: 'current_connection_observation',
                        shouldCancel: () => input.signal?.aborted === true,
                    });
                    return { kind: 'connected', profile };
                }
            }
            if (canonicalChanged && existing.homeConnectionDescriptor) return { kind: 'unreachable', remediation: null };
        }
    }
    const saved = await adoptHomeProfile({
        descriptor: existing?.homeConnectionDescriptor ?? {
            serverUrl: canonicalServerUrl,
            canonicalServerUrl,
            displayName: input.displayName?.trim() || defaultHomeNameForAddress(enteredUrl),
            ...(learnedIdentity ? { homeServerIdentityId: learnedIdentity } : {}),
        },
        source: existing?.source ?? input.source ?? 'manual',
        preserveUserLabel: true,
        ...(addressSelection ? { addressSelection } : {}),
    });
    // The admitted endpoint already returned a public feature snapshot. Share it with
    // the profile's consumers only when they will use that same endpoint.
    if (createServerUrlComparableKey(resolveHomeConnectionAddress(saved)) === createServerUrlComparableKey(enteredUrl)) {
        primeServerFeaturesSnapshot({ serverId: saved.id, snapshot });
    }
    return { kind: 'connected', profile: saved };
}
