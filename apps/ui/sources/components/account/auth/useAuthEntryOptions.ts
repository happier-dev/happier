import * as React from 'react';
import type { FeaturesResponse } from '@happier-dev/protocol';
import type { ProjectedAuthenticationCatalog } from '@happier-dev/cli-common/authentication/authMethodCatalog';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type { HomeSignInServicePolicyV1 } from '@happier-dev/protocol';

import type { AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { HomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    probeServerFeaturesAtUrl,
    subscribeServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { t } from '@/text';
import { getServerRetentionPolicy } from '@/sync/api/capabilities/serverRetentionPolicyClient';
import { formatServerRetentionDisclosure } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import type { RelayRetentionDisclosureState } from '@/components/onboarding/unauthShell/RelayRetentionDisclosure';
import {
    getServerProfileById,
    isServerProfilePersonalHomeBootstrapCompleted,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    projectAuthEntryMethodCapabilities,
    projectAuthenticationMethodCapabilities,
    type HomeAuthenticationAction,
} from '@/auth/capabilities/authMethodCapabilities';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { fireAndForget } from '@/utils/system/fireAndForget';

type AuthEntryServerAvailability = 'loading' | 'ready' | 'legacy' | 'unavailable' | 'incompatible';

export type AuthEntryOptions = Readonly<{
    authenticationCatalog?: ProjectedAuthenticationCatalog;
    authenticationActions?: readonly HomeAuthenticationAction[];
    keyChallengeV2Available?: boolean;
    /** Home explicitly selected/requested by the user; absent for a seeded fallback profile. */
    requestedHomeTarget?: HomeTargetInput;
    homeTarget?: HomeTargetInput;
    homeLabel?: string;
    /** Identity-bound receipt that this target is this device's managed Personal Home. */
    isPersonalHome?: true;
    homeTransport?: AccountDirectoryAuthTransport;
    signInServicePolicy?: HomeSignInServicePolicyV1;
    observedHomeServerIdentityId?: string;
    serverAvailability: AuthEntryServerAvailability;
    /**
     * The live auth-entry probe failed while the released feature contract
     * answered, so the options come from that catalog. Welcome keeps the
     * Home usable and offers one retry rather than hiding it.
     */
    authEntryUnavailable: boolean;
    serverUrlForCopy: string;
    showAuthActions: boolean;
    /** What the Home deletes, or that it could not be checked; never absent once the Home answered. */
    retentionDisclosure?: RelayRetentionDisclosureState | null;
    retryServerCheck: () => void;
}>;

type ObservedAuthEntryOptions = Pick<
    AuthEntryOptions,
    | 'showAuthActions'
    | 'authEntryUnavailable'
    | 'authenticationCatalog'
    | 'authenticationActions'
    | 'keyChallengeV2Available'
    | 'signInServicePolicy'
    | 'observedHomeServerIdentityId'
    | 'retentionDisclosure'
>;

function createUnobservedAuthEntryOptions(): ObservedAuthEntryOptions {
    return {
        authenticationCatalog: { provenance: 'legacy', methods: [] },
        authenticationActions: [],
        keyChallengeV2Available: false,
        signInServicePolicy: undefined,
        observedHomeServerIdentityId: undefined,
        authEntryUnavailable: false,
        showAuthActions: false,
        retentionDisclosure: null,
    };
}

export type UsableAuthEntryObservation = Readonly<{
    serverAvailability: Extract<AuthEntryServerAvailability, 'ready' | 'legacy'>;
    options: ObservedAuthEntryOptions & Readonly<{
        authenticationActions: readonly HomeAuthenticationAction[];
        keyChallengeV2Available: boolean;
    }>;
}>;

/**
 * Projects a usable Home's entry actions: the auth-entry projection when the
 * Home served one, otherwise the released feature catalog (with the legacy
 * key-provision fallback). Shared by the focused-Home entry and exact saved-Home
 * authentication so both advertise identical methods for the same Home.
 */
export function createUsableAuthEntryObservation(input: Readonly<{
    features: FeaturesResponse | null;
    entryProjection: Parameters<typeof projectAuthEntryMethodCapabilities>[0] | null;
    authEntryUnavailable: boolean;
}>): UsableAuthEntryObservation {
    const authMethodCapabilities = input.entryProjection
        ? projectAuthEntryMethodCapabilities(input.entryProjection)
        : projectAuthenticationMethodCapabilities(input.features);
    const observedHomeServerIdentityId = input.features?.capabilities.serverIdentity?.serverIdentityId ?? undefined;

    if (
        !authMethodCapabilities.usesStructuredMethods
        && authMethodCapabilities.legacyEnabledSignupMethodIds.length === 0
        && authMethodCapabilities.legacyEnabledLoginMethodIds.length === 0
    ) {
        return {
            serverAvailability: 'legacy',
            options: {
                authenticationCatalog: authMethodCapabilities.catalog,
                authenticationActions: [{
                    method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
                    action: { id: 'provision', mode: 'keyed' },
                    execution: { kind: 'generated_key' },
                }],
                keyChallengeV2Available: false,
                signInServicePolicy: input.features?.signInService,
                ...(observedHomeServerIdentityId ? { observedHomeServerIdentityId } : {}),
                authEntryUnavailable: input.authEntryUnavailable,
                showAuthActions: true,
                },
        };
    }

    return {
        serverAvailability: 'ready',
        options: {
            authenticationCatalog: authMethodCapabilities.catalog,
            authenticationActions: authMethodCapabilities.authenticationActions,
            // Auth-entry owns the live method/action list. The released feature
            // contract still owns key-challenge wire-version negotiation.
            keyChallengeV2Available: input.features?.capabilities?.auth?.keyChallenge?.v2 === true,
            signInServicePolicy: input.entryProjection
                ? input.entryProjection.signInService
                : input.features?.signInService,
            ...(observedHomeServerIdentityId ? { observedHomeServerIdentityId } : {}),
            authEntryUnavailable: input.authEntryUnavailable,
            showAuthActions: true,
            retentionDisclosure: null,
        },
    };
}

function createCachedAuthEntryObservation(
    snapshot: ServerFeaturesSnapshot | null,
): UsableAuthEntryObservation | null {
    if (!snapshot || snapshot.status === 'error') return null;
    if (snapshot.status === 'unsupported' && snapshot.reason === 'invalid_payload') return null;
    return createUsableAuthEntryObservation({
        features: snapshot.status === 'ready' ? snapshot.features : null,
        entryProjection: null,
        authEntryUnavailable: false,
    });
}

/**
 * Reads the Home's retention policy for the pre-sign-in disclosure. A policy that answered becomes
 * its summary; a failed read becomes "could not check" with a retry that forces a new read, so the
 * disclosure never falls silent (silence would read as "nothing is deleted").
 */
function readRetentionDisclosure(params: Readonly<{
    serverId: string;
    force: boolean;
    isCurrent: () => boolean;
    apply: (disclosure: RelayRetentionDisclosureState | null) => void;
}>): void {
    void getServerRetentionPolicy({ serverId: params.serverId, force: params.force }).then((read) => {
        if (!params.isCurrent()) return;
        if (read.status === 'ready') {
            const summary = formatServerRetentionDisclosure(read.policy);
            params.apply(summary ? { kind: 'summary', summary } : null);
            return;
        }
        params.apply({ kind: 'unreadable', retry: () => readRetentionDisclosure({ ...params, force: true }) });
    });
}

function isSameRetentionDisclosure(
    current: RelayRetentionDisclosureState | null,
    next: RelayRetentionDisclosureState | null,
): boolean {
    if (current === null || next === null) return current === next;
    if (current.kind === 'summary' && next.kind === 'summary') return current.summary === next.summary;
    return false;
}

/** Canonical deterministic provider choice for keyed account provisioning surfaces. */
export function resolvePreferredProvisionProviderId(features: FeaturesResponse | null): string | null {
    const methods = projectAuthenticationMethodCapabilities(features);
    return methods.configuredKeyedProvisionProviderIds[0]
        ?? methods.keyedProvisionProviderIds[0]
        ?? null;
}

export function useAuthEntryOptions(): AuthEntryOptions {
    const activeServerSnapshot = useActiveServerSnapshot();
    const activeProfile = activeServerSnapshot.serverId
        ? getServerProfileById(activeServerSnapshot.serverId)
        : null;
    const activeHomeCarrier = activeServerSnapshot.serverId ? getActiveServerHomeCarrier() : null;
    const enrollmentDescriptor = !activeServerSnapshot.runtimeOrigin && !activeHomeCarrier
        ? activeProfile?.homeConnectionDescriptor
        : undefined;
    const [enrollmentRead, setEnrollmentRead] = React.useState<Readonly<{
        serverId: string;
        descriptor: typeof enrollmentDescriptor;
        transport: HomeEnrollmentTransport;
    }> | null>(null);
    const readCachedServerFeaturesSnapshot = React.useCallback(
        () => getCachedServerFeaturesSnapshot({ serverId: activeServerSnapshot.serverId || undefined }),
        [activeServerSnapshot.serverId],
    );
    const cachedServerFeaturesSnapshot = React.useSyncExternalStore(
        subscribeServerFeaturesSnapshot,
        readCachedServerFeaturesSnapshot,
        readCachedServerFeaturesSnapshot,
    );
    const cachedObservation = React.useMemo(
        () => createCachedAuthEntryObservation(cachedServerFeaturesSnapshot),
        [cachedServerFeaturesSnapshot],
    );
    const cachedObservationRef = React.useRef(cachedObservation);
    cachedObservationRef.current = cachedObservation;
    const activeObservationKey = createServerUrlComparableKey(activeServerSnapshot.serverUrl) ?? activeServerSnapshot.serverUrl;
    const initialObservationRef = React.useRef(cachedObservation);
    const [serverAvailability, setServerAvailability] = React.useState<AuthEntryServerAvailability>(
        () => initialObservationRef.current?.serverAvailability ?? 'loading',
    );
    const [serverCheckNonce, setServerCheckNonce] = React.useState(0);
    const [serverFeaturesRecoveryNonce, setServerFeaturesRecoveryNonce] = React.useState(0);
    const consumedForcedServerCheckNonceRef = React.useRef(0);
    const consumedRecoveredServerFeaturesSnapshotRef = React.useRef<ServerFeaturesSnapshot | null>(null);
    const [options, setOptions] = React.useState<ObservedAuthEntryOptions>(
        () => initialObservationRef.current?.options ?? createUnobservedAuthEntryOptions(),
    );
    const lastUsableObservationRef = React.useRef<Readonly<{
        key: string;
        observation: UsableAuthEntryObservation;
    }> | null>(initialObservationRef.current
        ? { key: activeObservationKey, observation: initialObservationRef.current }
        : null);

    const serverUrlForCopy = React.useMemo(() => {
        const raw = activeServerSnapshot?.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : '';
        return raw || t('status.unknown');
    }, [activeServerSnapshot?.serverUrl]);

    const activeServerComparableKey = React.useMemo(
        () => createServerUrlComparableKey(activeServerSnapshot?.serverUrl ?? '') ?? '',
        [activeServerSnapshot?.serverUrl],
    );
    React.useEffect(() => {
        if (serverAvailability !== 'unavailable') return;
        if (!cachedServerFeaturesSnapshot || cachedServerFeaturesSnapshot.status === 'error') return;
        if (consumedRecoveredServerFeaturesSnapshotRef.current === cachedServerFeaturesSnapshot) return;

        consumedRecoveredServerFeaturesSnapshotRef.current = cachedServerFeaturesSnapshot;
        setServerFeaturesRecoveryNonce((value) => value + 1);
    }, [cachedServerFeaturesSnapshot, serverAvailability]);

    React.useEffect(() => {
        let mounted = true;
        let authEntryController: AbortController | null = null;
        let enrollmentTransport: HomeEnrollmentTransport | null = null;
        const releaseEnrollmentTransport = () => {
            const transport = enrollmentTransport;
            enrollmentTransport = null;
            if (transport) fireAndForget(transport.close(), { tag: 'useAuthEntryOptions.releaseEnrollmentTransport' });
        };
        setEnrollmentRead(null);
        const retainedObservation = lastUsableObservationRef.current?.key === activeObservationKey
            ? lastUsableObservationRef.current.observation
            : cachedObservationRef.current;
        const commitUsableObservation = (observation: UsableAuthEntryObservation) => {
            if (!mounted) return;
            lastUsableObservationRef.current = { key: activeObservationKey, observation };
            setOptions(observation.options);
            setServerAvailability(observation.serverAvailability);
        };
        const commitRetainedUnavailable = (observation: UsableAuthEntryObservation) => {
            commitUsableObservation({
                ...observation,
                options: { ...observation.options, authEntryUnavailable: true },
            });
        };
        const commitTerminalUnavailable = (availability: Extract<AuthEntryServerAvailability, 'unavailable' | 'incompatible'>) => {
            if (!mounted) return;
            lastUsableObservationRef.current = null;
            setOptions(createUnobservedAuthEntryOptions());
            setServerAvailability(availability);
        };
        const forceServerCheck = serverCheckNonce > consumedForcedServerCheckNonceRef.current;
        if (forceServerCheck) {
            consumedForcedServerCheckNonceRef.current = serverCheckNonce;
        }

        void (async () => {
            try {
                if (retainedObservation) {
                    commitUsableObservation(retainedObservation);
                } else if (mounted) {
                    setServerAvailability('loading');
                    setOptions(createUnobservedAuthEntryOptions());
                }

                // Sign-in owns an anonymous, mount-scoped enrollment carrier.
                // It does not publish or replace the authenticated active lease.
                if (enrollmentDescriptor) {
                    const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
                    const resolved = await resolveHomeEnrollmentTransport(enrollmentDescriptor);
                    if (!resolved.ok) {
                        commitTerminalUnavailable('unavailable');
                        return;
                    }
                    enrollmentTransport = resolved.transport;
                    if (!mounted) {
                        releaseEnrollmentTransport();
                        return;
                    }
                }

                authEntryController = new AbortController();
                // Independent observations share the mount/target cancellation lifetime.
                const [featuresSnapshot, authEntry] = await Promise.all([
                        enrollmentTransport ? probeServerFeaturesAtUrl({
                            endpointUrl: enrollmentTransport.canonicalServerUrl,
                            runtimeOrigin: enrollmentTransport.runtimeOrigin,
                            ...(enrollmentTransport.homeCarrier ? { homeCarrier: enrollmentTransport.homeCarrier } : {}),
                            serverId: enrollmentTransport.homeServerIdentityId,
                            force: forceServerCheck,
                            signal: authEntryController.signal,
                        }) : getServerFeaturesSnapshot({
                            signal: authEntryController.signal,
                            // A retry nonce grants one forced revalidation. Keeping force
                            // sticky after the retry succeeds would force unrelated cache recovery.
                            force: forceServerCheck,
                        }),
                        fetchHomeAuthEntry({
                            signal: authEntryController.signal,
                            ...(enrollmentTransport ? {
                                endpointUrl: enrollmentTransport.canonicalServerUrl,
                                runtimeOrigin: enrollmentTransport.runtimeOrigin,
                                ...(enrollmentTransport.homeCarrier ? { homeCarrier: enrollmentTransport.homeCarrier } : {}),
                                serverId: enrollmentTransport.homeServerIdentityId,
                            } : {
                                endpointUrl: activeServerSnapshot.serverUrl,
                                runtimeOrigin: activeServerSnapshot.runtimeOrigin,
                                ...(activeHomeCarrier ? { homeCarrier: activeHomeCarrier } : {}),
                                serverId: activeServerSnapshot.serverId,
                            }),
                        }),
                ]);

                if (featuresSnapshot.status === 'error') {
                    releaseEnrollmentTransport();
                    if (retainedObservation) commitRetainedUnavailable(retainedObservation);
                    else commitTerminalUnavailable('unavailable');
                    return;
                }

                if (featuresSnapshot.status === 'unsupported' && featuresSnapshot.reason === 'invalid_payload') {
                    releaseEnrollmentTransport();
                    commitTerminalUnavailable('incompatible');
                    return;
                }

                if (enrollmentTransport && (featuresSnapshot.status !== 'ready'
                    || featuresSnapshot.features.capabilities.serverIdentity.serverIdentityId !== enrollmentTransport.homeServerIdentityId)) {
                    releaseEnrollmentTransport();
                    commitTerminalUnavailable('incompatible');
                    return;
                }

                if (authEntry.kind === 'incompatible'
                    || (authEntry.kind === 'ready' && authEntry.projection.state === 'update_required')) {
                    releaseEnrollmentTransport();
                    commitTerminalUnavailable('incompatible');
                    return;
                }
                if (authEntry.kind === 'ready' && authEntry.projection.state !== 'ready') {
                    releaseEnrollmentTransport();
                    // The Home answered and refused entry. That is its decision,
                    // not an outage to paper over with the feature catalog.
                    commitTerminalUnavailable('unavailable');
                    return;
                }
                // A failed live probe (outage or timeout of the request-scoped
                // auth-entry route) never hides a Home the released feature
                // contract already described: degrade to that catalog exactly
                // like an older Home without auth entry and let Welcome show a
                // notice with one retry. The `unavailable` availability is
                // reserved for a failed feature probe.
                const authEntryUnavailable = authEntry.kind === 'unavailable';
                const features = featuresSnapshot.status === 'ready' ? featuresSnapshot.features : null;
                const observation = createUsableAuthEntryObservation({
                    features,
                    // Only a Home projection that actually carries entry actions can be
                    // projected; a terminal refusal is not a method catalog.
                    entryProjection: authEntry.kind === 'ready' && authEntry.projection.state === 'ready'
                        ? authEntry.projection
                        : null,
                    authEntryUnavailable,
                });
                if (mounted && enrollmentTransport) {
                    setEnrollmentRead({
                        serverId: activeServerSnapshot.serverId,
                        descriptor: enrollmentDescriptor,
                        transport: enrollmentTransport,
                    });
                }
                commitUsableObservation(observation);
                if (observation.serverAvailability === 'ready' && mounted) {
                    if (enrollmentTransport) {
                        // This reader has no explicit transport seam. Do not ask a
                        // different machine at the canonical loopback address.
                        setOptions((current) => ({ ...current, retentionDisclosure: {
                            kind: 'unreadable', retry: () => setServerCheckNonce((nonce) => nonce + 1),
                        } }));
                        return;
                    }
                    // Sign-in never waits on this: the disclosure fills in beside the actions.
                    readRetentionDisclosure({
                        serverId: activeServerSnapshot.serverId,
                        force: false,
                        isCurrent: () => mounted,
                        apply: (retentionDisclosure) => setOptions((current) => (
                            isSameRetentionDisclosure(current.retentionDisclosure ?? null, retentionDisclosure)
                                ? current
                                : { ...current, retentionDisclosure }
                        )),
                    });
                }
            } catch {
                releaseEnrollmentTransport();
                if (retainedObservation) commitRetainedUnavailable(retainedObservation);
                else commitTerminalUnavailable('unavailable');
            }
        })();

        return () => {
            mounted = false;
            authEntryController?.abort('welcome-auth-entry-unmounted');
            releaseEnrollmentTransport();
        };
    // Metadata/identity publication does not retire an anonymous Home observation.
    // Real target/transport changes do; recovery is signaled by the feature cache owner.
    }, [activeObservationKey, activeServerComparableKey, activeServerSnapshot.runtimeOrigin, activeHomeCarrier, enrollmentDescriptor, serverCheckNonce, serverFeaturesRecoveryNonce]);

    const carrierSnapshot = activeHomeCarrier ? getActiveServerSnapshot() : null;
    const exactActiveHomeCarrier = carrierSnapshot?.serverId === activeServerSnapshot.serverId
        && carrierSnapshot.generation === activeServerSnapshot.generation
        ? activeHomeCarrier
        : null;
    const exactEnrollmentTransport = enrollmentRead?.serverId === activeServerSnapshot.serverId
        && enrollmentRead.descriptor === enrollmentDescriptor
        ? enrollmentRead.transport : null;
    return {
        serverAvailability,
        serverUrlForCopy,
        ...(activeServerSnapshot.serverId ? {
            homeTarget: { kind: 'saved_profile', profileRef: activeServerSnapshot.serverId } as const,
            ...(activeServerSnapshot.isSelectionExplicit === true
                ? { requestedHomeTarget: { kind: 'saved_profile', profileRef: activeServerSnapshot.serverId } as const }
                : {}),
            homeLabel: activeProfile ? resolveHomeDisplayLabel(activeProfile, activeProfile.id) : serverUrlForCopy,
            ...(isServerProfilePersonalHomeBootstrapCompleted(activeProfile)
                ? { isPersonalHome: true as const }
                : {}),
            ...(exactActiveHomeCarrier
                ? { homeTransport: { homeCarrier: exactActiveHomeCarrier } }
                : activeServerSnapshot.runtimeOrigin
                    ? { homeTransport: { runtimeOrigin: activeServerSnapshot.runtimeOrigin } }
                    : exactEnrollmentTransport
                        ? { homeTransport: {
                            ...(exactEnrollmentTransport.runtimeOrigin ? { runtimeOrigin: exactEnrollmentTransport.runtimeOrigin } : {}),
                            ...(exactEnrollmentTransport.homeCarrier ? { homeCarrier: exactEnrollmentTransport.homeCarrier } : {}),
                        } }
                    : {}),
        } : {}),
        ...options,
        ...(enrollmentDescriptor && !exactEnrollmentTransport ? {
            showAuthActions: false,
            serverAvailability: serverAvailability === 'ready' || serverAvailability === 'legacy' ? 'loading' as const : serverAvailability,
        } : {}),
        retryServerCheck: React.useCallback(() => {
            setServerCheckNonce((value) => value + 1);
        }, []),
    };
}
