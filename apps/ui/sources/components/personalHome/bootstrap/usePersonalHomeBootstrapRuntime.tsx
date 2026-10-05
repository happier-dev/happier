import * as React from 'react';
import { useRouter, useSegments } from 'expo-router';
import { t } from '@/text';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { getDefaultSystemTaskRunner, waitForSystemTaskResult } from '@/components/systemTasks';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import type { SystemTaskAuthRequestApproval } from '@/components/systemTasks/approveSystemTaskAuthRequestPrompt';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useAppAccountIdentity } from '@/components/settings/machines/localControl/useThisComputerConnection';
import {
    confirmThisComputerAccountMove,
    isThisComputerAccountMove,
} from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { isDaemonOnActiveRelay } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { resolveThisComputerConnection } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    probeServerFeaturesAtUrl,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { probeAuthenticatedServerAuthPingEndpoint } from '@/sync/api/capabilities/probeAuthenticatedServerAuthPingEndpoint';
import {
    adoptHomeProfile,
    adoptPersonalHomeProfileAndComplete,
    findPersonalHomeBootstrapCompletedProfile,
    getServerProfileById,
    listServerProfiles,
    preflightHomeProfileAdoption,
    resolveSavedServerProfileByUrl,
    resolveUniqueServerProfileByUrl,
    setActiveServerId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    activateServerProfileIfSelectionImplicit,
    getActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { HappyError } from '@/utils/errors/errors';

import { createPersonalHomeBootstrapFacts } from './personalHomeBootstrapFacts';
import type {
    LocalDaemonStatus,
    PersonalHomeBootstrapOperation,
    PersonalHomeFacts,
    RelayRuntimeStatusSnapshot,
} from './personalHomeBootstrapTypes';
import { createThisComputerConnectionError } from './personalHomeComputerErrors';
import { PersonalHomeBootstrapGate } from './PersonalHomeBootstrapGate';
import { isPersonalHomeBootstrapRuntimeHost } from './personalHomeBootstrapHost';
import { awaitPersonalHomeBootstrapQaMutationPause } from './personalHomeBootstrapQaMutationPause';
import {
    runPersonalHomeBootstrapFromSystemTasks,
    type PersonalHomeEndpointSnapshot,
} from './runPersonalHomeBootstrapFromSystemTasks';
import type { PersonalHomeBootstrapOperationContext, PersonalHomeBootstrapOperationRunner } from './usePersonalHomeBootstrapController';

export function shouldBypassPersonalHomeBootstrapForSegments(segments: readonly string[]): boolean {
    const normalized = segments.filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
    if (normalized.length === 0 || normalized[0] === 'index') return false;
    return isPublicRouteForUnauthenticated([...segments]);
}

function normalizeUrl(value: unknown): string {
    const raw = String(value ?? '').trim();
    return canonicalizeServerUrl(raw) || raw.replace(/\/+$/u, '');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function isExactTokenOnlyCredential(
    value: unknown,
    expectedToken: string,
): value is Readonly<{ token: string }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && record.token === expectedToken;
}

/** Reads the account identity at the explicit endpoint with this Home's scoped token only. */
async function readAccountIdAtEndpoint(endpointUrl: string, token: string): Promise<string | null> {
    const fetchAt = createServerFetchAtEndpoint({ endpointUrl, credentials: null });
    const response = await fetchAt('/v1/account/profile', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
    }, { includeAuth: false });
    if (!response.ok) return null;
    const data = await response.json() as { id?: unknown };
    return typeof data?.id === 'string' && data.id.trim() ? data.id.trim() : null;
}

function profileMatchesUrl(profile: ServerProfile, url: string): boolean {
    const key = createServerUrlComparableKey(url) || normalizeUrl(url);
    return (createServerUrlComparableKey(profile.serverUrl) || normalizeUrl(profile.serverUrl)) === key
        || (createServerUrlComparableKey(profile.canonicalServerUrl ?? '') || normalizeUrl(profile.canonicalServerUrl)) === key;
}

function mapRelayStatus(status: ReturnType<typeof useLocalRelayRuntimeControl>['status'], error: string | null): RelayRuntimeStatusSnapshot | null {
    if (!status) return null;
    const active = status.service.active;
    const healthy = status.healthy === true;
    const state = !status.installed
        ? 'absent'
        : active === false
            ? 'stopped'
            : healthy
                ? 'healthy'
                : 'unhealthy';
    return {
        relayUrl: status.relayUrl,
        installed: status.installed,
        dataPresent: status.dataPresent,
        healthy: status.healthy,
        serviceActive: active,
        status: state,
        purpose: status.purpose,
        anonymousSignupEnabled: status.anonymousSignupEnabled,
        ...(error ? { error } : {}),
    };
}

function readAnonymousSignup(features: ServerFeaturesSnapshot): 'enabled' | 'disabled' | 'unknown' {
    if (features.status !== 'ready') return 'unknown';
    const methods = features.features.capabilities.auth.signup?.methods;
    if (!Array.isArray(methods)) return 'unknown';
    const anonymous = methods.find((method) => method.id === 'anonymous');
    return anonymous ? (anonymous.enabled ? 'enabled' : 'disabled') : 'unknown';
}

async function probePersonalHomeEndpoint(endpoint: string): Promise<PersonalHomeEndpointSnapshot> {
    const features = await probeServerFeaturesAtUrl({
        endpointUrl: endpoint,
        force: true,
    });
    if (features.status !== 'ready') {
        return {
            status: features.status === 'error' ? 'unreachable' : 'unknown',
        };
    }
    const serverIdentityId = String(
        features.serverIdentityId
        ?? features.features.capabilities.serverIdentity.serverIdentityId
        ?? '',
    ).trim();
    if (!serverIdentityId) return { status: 'unknown' };
    // Fail closed: a /v1/features descriptor is carried only when its Home
    // identity agrees with the independently observed server identity.
    const descriptor = features.features.homeConnectionDescriptor;
    const homeConnectionDescriptor = descriptor?.homeServerIdentityId === serverIdentityId
        ? descriptor
        : undefined;
    return {
        status: 'ready',
        serverIdentityId,
        storagePolicy: features.features.capabilities.encryption.storagePolicy,
        anonymousSignup: readAnonymousSignup(features),
        ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
    };
}

async function probeAnonymousSignupRefused(endpoint: string): Promise<boolean> {
    const endpointSnapshot = await probePersonalHomeEndpoint(endpoint);
    if (endpointSnapshot.status !== 'ready' || endpointSnapshot.anonymousSignup !== 'disabled') {
        return false;
    }

    try {
        await authGetTokenAtEndpoint({
            endpointUrl: endpoint,
            canonicalServerUrl: endpoint,
            serverIdentityId: endpointSnapshot.serverIdentityId,
            secret: await getRandomBytesAsync(32),
            requireKeyChallengeV2: true,
        });
        return false;
    } catch (error) {
        const code = error instanceof HappyError
            ? error.code
            : error && typeof error === 'object' && 'code' in error
                ? (error as { code?: unknown }).code
                : undefined;
        if (code === 'signup-disabled') {
            return true;
        }
        throw error;
    }
}

export type PersonalHomeBootstrapRuntime = Readonly<{
    readFacts: () => Promise<PersonalHomeFacts>;
    activeTask: SystemTaskRunState | null;
    operations: Partial<Record<PersonalHomeBootstrapOperation, PersonalHomeBootstrapOperationRunner>>;
    useExistingRuntime: PersonalHomeBootstrapOperationRunner;
    localServerUrl: string;
}>;

/**
 * Composes the existing runtime, Home profile, auth-storage and daemon owners for the
 * Desktop bootstrap gate. It deliberately does not own any state or switch the focused Home.
 */
export function usePersonalHomeBootstrapRuntime(): PersonalHomeBootstrapRuntime {
    const profilesGeneration = useServerProfilesGeneration();
    const relay = useLocalRelayRuntimeControl();
    const daemon = useLocalDaemonControl();
    const resolveLocalUrl = React.useCallback(
        () => normalizeUrl(relay.status?.relayUrl),
        [relay.status?.relayUrl],
    );

    // The existing local-machine setup task is the single daemon-setup owner. Token-only pairing
    // prompts are answered through the explicit Personal Home endpoint with its Home-scoped
    // token-only credential; the focused Home is never consulted.
    const setupRelayUrl = resolveLocalUrl();
    const setupHomeIdentity = React.useMemo(() => {
        if (!setupRelayUrl) return null;
        const local = resolveUniqueServerProfileByUrl(setupRelayUrl, { includeCanonicalServerUrl: true });
        return local?.serverIdentityId?.trim() || null;
    }, [profilesGeneration, setupRelayUrl]);
    const setupAccount = useServerCredentialAccountScopeResolution(setupHomeIdentity);
    const setupTask = useThisComputerSetupTask({
        ...(setupRelayUrl && setupHomeIdentity ? {
            authRequestApproval: {
                expectedRelayUrl: setupRelayUrl,
                serverId: setupHomeIdentity,
                ...(setupAccount.kind === 'bound' ? { expectedAccountId: setupAccount.scope.accountId } : {}),
            } satisfies SystemTaskAuthRequestApproval,
        } : {}),
    });
    const startSetupTask = setupTask.start;
    const activeTask = relay.activeTaskSnapshot
        ?? daemon.activeTaskSnapshot
        ?? (daemon.statusTaskSnapshot?.result ? null : daemon.statusTaskSnapshot)
        ?? setupTask.activeTaskSnapshot
        ?? null;
    // Progress is subscribed independently of authoritative fact reads. Reading the latest
    // snapshot after awaiting status must not restart those reads for every byte event.
    const activeTaskRef = React.useRef(activeTask);
    activeTaskRef.current = activeTask;
    // Daemon status is read through the daemon-control owner: one parser, one status state.
    const readDaemonStatus = daemon.readStatus;
    // Read at call time by prepare-computer, which only names the account it already verified.
    const appAccountIdentity = useAppAccountIdentity();
    const appAccountRef = React.useRef(appAccountIdentity);
    appAccountRef.current = appAccountIdentity;
    const readRelayStatus = relay.readStatus;

    const readFacts = React.useCallback(async (): Promise<PersonalHomeFacts> => {
        const authoritativeRelayStatus = await readRelayStatus();
        const profiles = listServerProfiles();
        const localUrl = normalizeUrl(authoritativeRelayStatus?.relayUrl);
        const candidate = localUrl
            ? resolveUniqueServerProfileByUrl(localUrl, { includeCanonicalServerUrl: true })
            : null;
        let completed = findPersonalHomeBootstrapCompletedProfile(profiles);
        const activeSelection = getActiveServerSnapshot();
        const activeProfile = getServerProfileById(activeSelection.serverId);
        const explicitlySelectedOtherHome = activeSelection.isSelectionExplicit === true
            && activeProfile != null
            && (localUrl
                ? !profileMatchesUrl(activeProfile, localUrl)
                : activeProfile.serverIdentityId !== completed?.serverIdentityId);
        const relayRuntime = mapRelayStatus(authoritativeRelayStatus, relay.lastErrorMessage);
        let localHomeReachability: PersonalHomeFacts['localHomeReachability'] = 'unknown';
        let localHomeIdentity = candidate?.serverIdentityId ?? null;
        let anonymousSignup: PersonalHomeFacts['anonymousSignup'] = relayRuntime?.anonymousSignupEnabled === true
            ? 'enabled'
            : relayRuntime?.anonymousSignupEnabled === false
                ? 'disabled'
                : 'unknown';
        let localHomeAuth: PersonalHomeFacts['localHomeAuth'] = 'missing';

        if (localUrl && (relayRuntime?.installed || candidate || completed)) {
            const features = await probeServerFeaturesAtUrl({
                endpointUrl: localUrl,
                ...(localHomeIdentity ? { serverId: localHomeIdentity } : {}),
                force: true,
            }).catch(() => null);
            if (features?.status === 'ready') {
                localHomeReachability = 'reachable';
                localHomeIdentity = features.serverIdentityId
                    ?? features.features.capabilities.serverIdentity.serverIdentityId
                    ?? localHomeIdentity;
                anonymousSignup = readAnonymousSignup(features);
            } else if (features) {
                localHomeReachability = 'unreachable';
            }
            const credentials = await TokenStorage.getCredentialsForServerUrl(
                localUrl,
                localHomeIdentity ? { serverId: localHomeIdentity } : {},
            );
            if (credentials?.token) {
                const probe = await probeAuthenticatedServerAuthPingEndpoint({ endpoint: localUrl, token: credentials.token });
                localHomeAuth = probe.status === 'ready' ? 'present' : probe.status === 'auth_failed' ? 'invalid' : 'unknown';
                if (probe.status === 'server_unreachable') localHomeReachability = 'unreachable';
            }
        }

        // A persisted completion fact is bound to an exact Home identity.  A URL match
        // alone must never let another Home inherit this device's bootstrap readiness.
        if (
            completed
            && localHomeIdentity
            && completed.serverIdentityId !== localHomeIdentity
        ) {
            completed = null;
        }

        // Daemon facts are read through the awaited daemon-control owner so they are fresh at
        // call time rather than a stale render-time projection, then verified against this
        // Personal Home: readiness requires the daemon's URL and account identity to match.
        // A read that ran and FAILED is a blocking fact about this computer, never "no daemon yet":
        // reporting it as absent would start an automatic setup run from an unknown state.
        // R12 exception: a read that failed only because nobody chose who manages this computer's
        // `happier` yet is "not set up", because setup's first step asks exactly that question.
        const daemonRead = await readDaemonStatus({ relayUrl: localUrl, serverIdentityId: localHomeIdentity })
            .then((status) => ({ status, failure: null, cliChoiceRequired: false }), (error: unknown) => ({
                status: null,
                failure: isCliChoiceRequiredError(error)
                    ? null
                    : error instanceof Error && error.message ? error.message : 'The daemon status read failed.',
                cliChoiceRequired: isCliChoiceRequiredError(error),
            }));
        const daemonStatus = daemonRead.status;
        let daemonFacts: PersonalHomeFacts['daemon'] = daemonRead.failure !== null
            ? { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null, error: daemonRead.failure }
            : daemonRead.cliChoiceRequired
                ? { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null }
                : daemonStatus;
        if (daemonStatus) {
            const urlMatches = isDaemonOnActiveRelay({
                activeRelayUrl: localUrl,
                daemonRelayUrl: daemonStatus.daemonServerUrl,
                daemonAlternateRelayUrls: [daemonStatus.daemonComparableKey],
            }) === true;
            let accountMatches: boolean | null = null;
            if (urlMatches && daemonStatus.daemonAccountId) {
                const daemonCredentials = await TokenStorage.getCredentialsForServerUrl(
                    localUrl,
                    localHomeIdentity ? { serverId: localHomeIdentity } : {},
                ).catch(() => null);
                const daemonToken = typeof daemonCredentials?.token === 'string' && daemonCredentials.token.trim()
                    ? daemonCredentials.token.trim()
                    : '';
                const accountId = daemonToken
                    ? await readAccountIdAtEndpoint(localUrl, daemonToken).catch(() => null)
                    : null;
                accountMatches = accountId != null && accountId === daemonStatus.daemonAccountId;
            }
            daemonFacts = {
                ...daemonStatus,
                servesPersonalHome: urlMatches === true
                    && Boolean(daemonStatus.daemonAccountId)
                    && accountMatches === true,
            };
        }
        // R10 D4: an implicit selection the app already holds credentials for (the 0.2 default
        // Cloud selection, say) is the user's Home too. It is kept until they choose a Personal
        // Home, so the first launch of this app never silently creates and focuses one.
        let signedInOtherHome: PersonalHomeFacts['signedInOtherHome'] = null;
        if (
            !completed
            && !explicitlySelectedOtherHome
            && activeProfile != null
            && activeProfile.source !== 'desktop-personal-home'
            && !(localUrl && profileMatchesUrl(activeProfile, localUrl))
        ) {
            const activeCredentials = await TokenStorage.getCredentialsForServerUrl(
                activeProfile.serverUrl,
                activeProfile.serverIdentityId ? { serverId: activeProfile.serverIdentityId } : {},
            ).catch(() => null);
            if (activeCredentials?.token) {
                signedInOtherHome = {
                    serverId: activeProfile.id,
                    label: activeProfile.name?.trim() || toServerUrlDisplay(activeProfile.serverUrl),
                };
            }
        }

        return createPersonalHomeBootstrapFacts({
            hostIsDesktop: true,
            isDesktopMainWindow: true,
            explicitlySelectedOtherHome,
            signedInOtherHome,
            completedPersonalHomeProfile: completed,
            candidateLocalProfile: candidate,
            relayRuntime,
            localHomeReachability,
            localHomeIdentity,
            localHomeAuth,
            anonymousSignup,
            daemon: daemonFacts,
            activeTask: activeTaskRef.current,
        });
    }, [
        readDaemonStatus,
        readRelayStatus,
        relay.lastErrorMessage,
    ]);

    const runRelayTaskAndWait = relay.runTaskAndWait;
    const runBootstrapWithDisposition = React.useCallback(async (
        existingRuntimeDisposition?: 'use-this-local-home',
        trigger: 'automatic' | 'retry' | 'manual' = 'manual',
    ): Promise<void> => {
        const result = await runPersonalHomeBootstrapFromSystemTasks({
            ...(existingRuntimeDisposition ? { existingRuntimeDisposition } : {}),
            ...(trigger === 'retry' ? { allowErasedRuntimeRecreate: true } : {}),
            deps: {
                runRelayTask: async (kind, options) => {
                    // Checked-in loaded-QA seam: inert unless a QA driver armed this exact durable
                    // mutation. It only delays the request, so the canonical admission/precondition
                    // owners still decide whether a competing uninstall/erase wins.
                    await awaitPersonalHomeBootstrapQaMutationPause(kind);
                    return await runRelayTaskAndWait(kind, options);
                },
                probeEndpoint: probePersonalHomeEndpoint,
                readCredentials: async ({ serverUrl, serverIdentityId }) => (
                    await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: serverIdentityId })
                ),
                createLocalAccount: async ({
                    endpoint,
                    canonicalServerUrl,
                    serverIdentityId,
                    resumePendingSeedOnly,
                }) => {
                    const custodyTarget = { serverId: serverIdentityId };
                    const seed = await TokenStorage.getPendingPersonalHomeBootstrapSeed(
                        canonicalServerUrl,
                        custodyTarget,
                    );
                    if (!seed) {
                        throw new Error(resumePendingSeedOnly
                            ? 'Personal Home pending seed custody is unavailable for retained data.'
                            : 'Personal Home seed custody is unavailable.');
                    }
                    return await authGetTokenAtEndpoint({
                        endpointUrl: endpoint,
                        canonicalServerUrl,
                        serverIdentityId,
                        secret: seed,
                        requireKeyChallengeV2: true,
                    });
                },
                preparePendingBootstrapSeed: async ({ serverUrl, serverIdentityId, allowCreate }) => {
                    const urlSeed = await TokenStorage.getPendingPersonalHomeBootstrapSeed(serverUrl);
                    const identitySeed = serverIdentityId
                        ? await TokenStorage.getPendingPersonalHomeBootstrapSeed(
                            serverUrl,
                            { serverId: serverIdentityId },
                        )
                        : null;
                    if (urlSeed && identitySeed && !equalBytes(urlSeed, identitySeed)) return false;

                    let seed = identitySeed ?? urlSeed;
                    if (!seed) {
                        if (!allowCreate) return false;
                        const generatedSeed = await getRandomBytesAsync(32);
                        if (!(await TokenStorage.setPendingPersonalHomeBootstrapSeed(
                            serverUrl,
                            {},
                            generatedSeed,
                        ))) return false;
                        const verifiedSeed = await TokenStorage.getPendingPersonalHomeBootstrapSeed(serverUrl);
                        if (!verifiedSeed || !equalBytes(verifiedSeed, generatedSeed)) {
                            throw new Error('Personal Home bootstrap seed could not be verified.');
                        }
                        seed = verifiedSeed;
                    }

                    if (serverIdentityId && !identitySeed) {
                        if (!(await TokenStorage.setPendingPersonalHomeBootstrapSeed(
                            serverUrl,
                            { serverId: serverIdentityId },
                            seed,
                        ))) return false;
                        const promotedSeed = await TokenStorage.getPendingPersonalHomeBootstrapSeed(
                            serverUrl,
                            { serverId: serverIdentityId },
                        );
                        if (!promotedSeed || !equalBytes(promotedSeed, seed)) {
                            throw new Error('Personal Home bootstrap seed could not be verified.');
                        }
                    }
                    return true;
                },
                persistCredentials: async ({ serverUrl, serverIdentityId, credentials }) => {
                    const target = preflightHomeProfileAdoption({
                        descriptor: {
                            serverUrl,
                            canonicalServerUrl: serverUrl,
                            homeServerIdentityId: serverIdentityId,
                        },
                        source: 'desktop-personal-home',
                        preserveUserLabel: true,
                    });
                    if (!target.serverIdentityId) {
                        throw new Error('Personal Home credential persistence requires a stable identity.');
                    }
                    const credentialTarget = { serverId: target.serverIdentityId };
                    if (!(await TokenStorage.setCredentialsForServerUrl(
                        target.canonicalServerUrl,
                        credentialTarget,
                        credentials,
                    ))) {
                        return false;
                    }
                    const readback = await TokenStorage.getCredentialsForServerUrl(
                        target.canonicalServerUrl,
                        credentialTarget,
                    );
                    return isExactTokenOnlyCredential(readback, credentials.token);
                },
                verifyAuthenticatedAccess: async ({ endpoint, token }) => (
                    await probeAuthenticatedServerAuthPingEndpoint({ endpoint, token })
                ).status === 'ready',
                clearPendingBootstrapSeed: async ({ serverUrl, serverIdentityId }) => {
                    const identityCleared = await TokenStorage.clearPendingPersonalHomeBootstrapSeed(
                        serverUrl,
                        { serverId: serverIdentityId },
                    );
                    const urlCleared = await TokenStorage.clearPendingPersonalHomeBootstrapSeed(serverUrl);
                    return identityCleared && urlCleared;
                },
                preflightCompletedProfile: ({ canonicalServerUrl, localServerUrl, serverIdentityId }) => {
                    preflightHomeProfileAdoption({
                        descriptor: {
                            serverUrl: localServerUrl,
                            canonicalServerUrl,
                            homeServerIdentityId: serverIdentityId,
                        },
                        source: 'desktop-personal-home',
                        preserveUserLabel: true,
                    });
                },
                probeAnonymousSignupRefused: async ({ endpoint }) => (
                    await probeAnonymousSignupRefused(endpoint)
                ),
                adoptCompletedProfile: async ({ canonicalServerUrl, localServerUrl, serverIdentityId, connectionDescriptor }) => {
                    const credentials = await TokenStorage.getCredentialsForServerUrl(
                        canonicalServerUrl,
                        { serverId: serverIdentityId },
                    );
                    const token = typeof credentials?.token === 'string' ? credentials.token.trim() : '';
                    if (!token || !isExactTokenOnlyCredential(credentials, token)) {
                        throw new Error('Verified Personal Home credentials are unavailable for profile adoption.');
                    }
                    return await adoptPersonalHomeProfileAndComplete({
                        // The canonical /v1/features descriptor when present; otherwise the
                        // exact legacy HTTPS descriptor behavior for this loopback Home.
                        descriptor: connectionDescriptor ?? {
                            serverUrl: localServerUrl,
                            canonicalServerUrl,
                            homeServerIdentityId: serverIdentityId,
                        },
                        source: 'desktop-personal-home',
                        preserveUserLabel: true,
                    });
                },
            },
        });
        const completedProfile = getServerProfileById(result.profileId);
        const completedIdentity = completedProfile?.serverIdentityId;
        if (
            !completedProfile
            || !completedIdentity
            || completedProfile.personalHomeBootstrapCompleted !== true
        ) {
            throw new Error('Verified Personal Home completion did not retain its stable Home identity.');
        }
        await activateServerProfileIfSelectionImplicit(result.profileId);
        // Credential/profile writes are non-focusing. Ask the existing auth owner to re-read the
        // selected Home. The profile owner activates the first local Home only while selection
        // remains implicit; an explicit device or tab selection stays unchanged.
        await getCurrentAuth()?.refreshFromActiveServer();
    }, [runRelayTaskAndWait]);
    const runBootstrap = React.useCallback<PersonalHomeBootstrapOperationRunner>(async (
        _facts,
        context: Readonly<{ trigger: 'automatic' | 'retry' | 'manual' }> = { trigger: 'manual' },
    ) => {
        await runBootstrapWithDisposition(undefined, context.trigger);
    }, [runBootstrapWithDisposition]);
    const useExistingRuntime = React.useCallback<PersonalHomeBootstrapOperationRunner>(async (
        _facts,
        context: Readonly<{ trigger: 'automatic' | 'retry' | 'manual' }> = { trigger: 'manual' },
    ) => {
        await runBootstrapWithDisposition('use-this-local-home', context.trigger);
    }, [runBootstrapWithDisposition]);

    const prepareComputer = React.useCallback<PersonalHomeBootstrapOperationRunner>(async (
        facts,
        context: PersonalHomeBootstrapOperationContext = { trigger: 'manual' },
    ) => {
        const runner = getDefaultSystemTaskRunner();
        const localUrl = resolveLocalUrl();
        if (!localUrl) {
            throw new Error('Personal Home runtime status did not provide a canonical local origin.');
        }
        if (resolveSavedServerProfileByUrl(localUrl, { includeCanonicalServerUrl: true }).kind === 'ambiguous') {
            throw new Error(t('personalHome.bootstrap.homeIdentityAmbiguous'));
        }
        const identity = facts.localHomeIdentity
            ?? facts.completedPersonalHomeProfile?.serverIdentityId
            ?? null;

        // The expected account identity is derived from this Home's scoped token against the
        // explicit endpoint BEFORE the idempotence check: a daemon on the same endpoint that is
        // authenticated as another account must never read as ready for this Home.
        const homeCredentials = await TokenStorage.getCredentialsForServerUrl(
            localUrl,
            identity ? { serverId: identity } : {},
        );
        const homeToken = typeof homeCredentials?.token === 'string' && homeCredentials.token.trim()
            ? homeCredentials.token.trim()
            : '';
        const expectedAccountId = homeToken
            ? await readAccountIdAtEndpoint(localUrl, homeToken).catch(() => null)
            : null;
        if (!expectedAccountId) {
            throw new Error('Could not verify the Personal Home account for the daemon on this computer.');
        }

        // One classification of this computer's daemon against this Home and its account — the
        // same owner every other surface describing this computer uses.
        const appAccount = appAccountRef.current;
        const connectionFor = (status: LocalDaemonStatus | null) => resolveThisComputerConnection({
            daemon: status
                ? { ...status, daemonAlternateRelayUrls: [status.daemonComparableKey] }
                : null,
            activeRelayUrl: localUrl,
            activeLocalRelayUrl: localUrl,
            appAccountId: expectedAccountId,
            appAccountLabel: appAccount.accountId === expectedAccountId ? appAccount.accountLabel : null,
        });
        const daemonReadyForHome = (status: LocalDaemonStatus | null): boolean =>
            status != null
            && !status.error
            && Boolean(status.machineId)
            && status.daemonMachineRegistered !== false
            && connectionFor(status)?.status === 'aligned';

        // Authoritative daemon facts through the daemon-control owner decide idempotence.
        // A failed read rejects and fails this operation by name; it never starts setup (RV2-30).
        // Except `cli_choice_required` (R12): setup's first step asks that question, so run it.
        let status = await readDaemonStatus({ relayUrl: localUrl, serverIdentityId: identity }).catch((error: unknown) => {
            if (isCliChoiceRequiredError(error)) return null;
            throw error;
        });
        // R12: a Retry of a CLI switch that moved this Home's service but not every other one reruns
        // that convergence with the recorded choice; this Home reading ready does not settle it.
        const reconvergeCliChoice = context.trigger === 'retry'
            && context.previousErrorCode === 'cli_choice_service_convergence_failed';
        if (reconvergeCliChoice || !daemonReadyForHome(status)) {
            // R10 D1 / U7: a daemon signed in to another account (on this Home or another) is the
            // user's own setup. Automatic preparation never moves it; an explicit retry asks
            // first, naming both accounts. Absent, stopped or unapproved daemons move nobody.
            const before = connectionFor(status);
            if (before && isThisComputerAccountMove(before)) {
                if (context.trigger === 'automatic' || !(await confirmThisComputerAccountMove(before))) {
                    throw createThisComputerConnectionError(before);
                }
            }
            // Run the existing configure/auth/pair/install/start/verify task against this Home's
            // explicit descriptor. This replaces the focused-Home repair/start path.
            const taskId = await startSetupTask(buildLocalMachineSetupSystemTaskSpec({
                activeRelayUrl: localUrl,
                activeWebappUrl: localUrl,
                activeLocalRelayUrl: localUrl,
                activeServerIdentityId: identity,
                activeAccountId: expectedAccountId,
                installService: true,
                startService: true,
                verifyService: true,
                ...(reconvergeCliChoice ? { convergeCliChoice: true } : {}),
            }));
            const result = await waitForSystemTaskResult(runner, taskId);
            if (!result.ok) {
                // The task's code travels with its message, so recovery (and its Retry) knows what failed.
                throw Object.assign(new Error(result.error.message), { code: result.error.code });
            }
            // Fresh post-task readback: task events are diagnostics, not readiness facts.
            status = await readDaemonStatus({ relayUrl: localUrl, serverIdentityId: identity });
        }

        if (daemonReadyForHome(status)) return;
        const after = connectionFor(status);
        if (after && after.status !== 'aligned') {
            throw createThisComputerConnectionError(after);
        }
        if (status?.daemonMachineRegistered === false) {
            throw new Error('The Personal Home daemon machine is not registered yet.');
        }
        throw new Error('Background service did not reach a ready state for this Home.');
    }, [readDaemonStatus, resolveLocalUrl, startSetupTask]);

    const operations = React.useMemo<PersonalHomeBootstrapRuntime['operations']>(() => ({
        'ensure-home-ready': runBootstrap,
        'prepare-computer': prepareComputer,
    }), [prepareComputer, runBootstrap]);

    return {
        readFacts,
        activeTask,
        operations,
        useExistingRuntime,
        localServerUrl: resolveLocalUrl(),
    };
}

/** The status read failed only because this computer's one-CLI question is unanswered (R12). */
function isCliChoiceRequiredError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'cli_choice_required');
}

function shouldRouteExistingRuntimeToGenericHome(error: unknown, facts: PersonalHomeFacts): boolean {
    const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
    if (code === 'personal_home_existing_runtime_conflict') return true;
    // A generic Home without verified credentials is signed into like any other Home. A Personal
    // Home whose credentials live with another Happier app on this computer (S18) is not routed
    // silently: the gate names that state first and offers the recovery-key sign-in as its choice.
    return code === 'personal_home_credentials_unverified'
        && facts.relayRuntime?.purpose?.kind !== 'personal-home';
}

function completedProfileInitialFacts(profile: ServerProfile): PersonalHomeFacts {
    return createPersonalHomeBootstrapFacts({
        hostIsDesktop: true,
        isDesktopMainWindow: true,
        explicitlySelectedOtherHome: false,
        completedPersonalHomeProfile: profile,
        candidateLocalProfile: profile,
        relayRuntime: null,
        localHomeReachability: 'unknown',
        localHomeIdentity: profile.serverIdentityId ?? null,
        localHomeAuth: 'unknown',
        anonymousSignup: 'unknown',
        daemon: null,
        activeTask: null,
    });
}

function PersonalHomeBootstrapRuntimeInner(props: Readonly<{
    children: React.ReactNode;
    initialFacts?: PersonalHomeFacts;
}>): React.ReactElement {
    const runtime = usePersonalHomeBootstrapRuntime();
    const router = useRouter();
    const useExistingRuntime = React.useCallback<PersonalHomeBootstrapOperationRunner>(async (facts) => {
        try {
            await runtime.useExistingRuntime(facts);
        } catch (error) {
            if (shouldRouteExistingRuntimeToGenericHome(error, facts)) {
                router.push(`/server?url=${encodeURIComponent(runtime.localServerUrl)}&auto=1`);
                return;
            }
            throw error;
        }
    }, [router, runtime.localServerUrl, runtime.useExistingRuntime]);
    const useAnotherHome = React.useCallback(() => {
        router.push('/server');
    }, [router]);
    const signInToExistingRuntime = React.useCallback(() => {
        router.push(`/server?url=${encodeURIComponent(runtime.localServerUrl)}&auto=1`);
    }, [router, runtime.localServerUrl]);
    const keepSignedInHome = React.useCallback(async (serverId: string) => {
        // A device-scoped selection is explicit, which is the durable "keep this Home" answer.
        await setActiveServerId(serverId, { scope: 'device' });
    }, []);
    return (
        <PersonalHomeBootstrapGate
            bypass={false}
            readFacts={runtime.readFacts}
            activeTask={runtime.activeTask}
            operations={runtime.operations}
            initialFacts={props.initialFacts}
            useExistingRuntimeOperation={useExistingRuntime}
            onUseAnotherHome={useAnotherHome}
            onKeepSignedInHome={keepSignedInHome}
            onSignInToExistingRuntime={signInToExistingRuntime}
        >
            {props.children}
        </PersonalHomeBootstrapGate>
    );
}

function EligibleDesktopPersonalHomeBootstrapRuntime(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const segments = useSegments();
    if (shouldBypassPersonalHomeBootstrapForSegments(segments)) return <>{props.children}</>;

    const completedProfile = findPersonalHomeBootstrapCompletedProfile(listServerProfiles());
    return (
        <PersonalHomeBootstrapRuntimeInner
            initialFacts={completedProfile ? completedProfileInitialFacts(completedProfile) : undefined}
        >
            {props.children}
        </PersonalHomeBootstrapRuntimeInner>
    );
}

export function PersonalHomeBootstrapRuntimeMount(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    // This guard must stay outside the runtime component. Unsupported desktop hosts,
    // off-Desktop runtimes, and overlay windows render without constructing relay, daemon,
    // TokenStorage, network, or bootstrap-controller hooks. Tauri is currently the only host
    // with the native system-task commands required by Personal Home bootstrap.
    // A durable profile instead seeds synchronous ready facts into that same controller: children
    // render on the first pass while normal health/auth/daemon recovery continues in the shell.
    if (!isPersonalHomeBootstrapRuntimeHost()) return <>{props.children}</>;
    return (
        <EligibleDesktopPersonalHomeBootstrapRuntime>
            {props.children}
        </EligibleDesktopPersonalHomeBootstrapRuntime>
    );
}
