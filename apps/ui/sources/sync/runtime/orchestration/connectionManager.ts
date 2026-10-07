import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
    captureActiveServerRuntimeTarget,
    getActiveServerHomeCarrier,
    publishActiveServerRuntimeOrigin,
    releaseActiveServerRuntimeOrigin,
} from '@/sync/domains/server/serverRuntime';
import { ServerScopedTransportUnavailableError } from './serverScopedRpc/resolveServerScopedTransport';
import { sync, syncHydrateLocalState, syncRestore, syncSwitchServer } from '@/sync/sync';
import { abortServerFetches } from '@/sync/http/client';
import { getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';
import {
    acquireEligibleHomeCarrier,
    readHomeApplicationCarrierEligibility,
    type AcquiredHomeCarrier,
} from '@/sync/runtime/homeCarrierPolicy';
import { startNativeLoopbackTunnelRuntimeAppStateLifecycle } from '@/sync/runtime/nativeLoopbackTunnels/runtime';
import type { IrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/types';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    getAppliedActiveServerId,
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    publishAppliedActiveServerRuntimeAvailability,
    publishAppliedActiveServerSnapshot,
    publishApplyingActiveServerId,
} from './appliedActiveServerRuntime';

export {
    getAppliedActiveServerId,
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    subscribeAppliedActiveServer,
    subscribeAppliedActiveServerRuntimeAvailability,
    subscribeApplyingActiveServer,
    type AppliedActiveServerSnapshot,
} from './appliedActiveServerRuntime';

let activeSwitchPromise: Promise<AuthCredentials | null> | null = null;
// The cold restore's transport phase. Boot paints once restore's local phase has
// run, so the UI can ask for a switch, retry or disconnect while the carrier is
// still pending; those wait here instead of racing a second bootstrap.
let coldRestorePromise: Promise<void> | null = null;

async function awaitColdRestore(): Promise<void> {
    if (coldRestorePromise) await coldRestorePromise.catch(() => undefined);
}
let lastAppliedGeneration = -1;
// The bearer the singleton Sync runtime was last applied with (`null` = signed
// out). Signing in or out keeps the same Home and generation, so the applied
// runtime is reusable only while it still holds the credential now stored for
// that Home; otherwise a sign-in inside a running tab never starts Sync and a
// sign-out leaves the previous Account's socket running.
let appliedCredentialToken: string | null = null;
let requestedGeneration = -1;
let activeRecoveryPromise: Promise<void> | null = null;
let recoveryRuntime: IrohHomeTunnelRuntime | null = null;
let recoveryUnsubscribe: (() => void) | null = null;

function readCredentialToken(credentials: AuthCredentials | null): string | null {
    const token = credentials?.token?.trim() ?? '';
    return token || null;
}

function startActiveIrohRecoveryLifecycle(runtime: IrohHomeTunnelRuntime): void {
    if (recoveryRuntime === runtime && recoveryUnsubscribe) return;
    recoveryUnsubscribe?.();
    recoveryRuntime = runtime;
    recoveryUnsubscribe = runtime.subscribeRecoveryRequired((event) => {
        if (!event.activePublication) return;
        const snapshot = getActiveServerSnapshot();
        const profile = getServerProfileById(snapshot.serverId);
        if (profile?.serverIdentityId?.trim() !== event.homeServerIdentityId) return;
        fireAndForget(retryActiveServerConnection(), {
            tag: 'connectionManager.retryActiveServerConnection.nativeIrohRecovery',
        });
    });
}
async function resolveCredentialsForActiveServer(
    snapshot: Readonly<ReturnType<typeof getActiveServerSnapshot>>,
): Promise<AuthCredentials | null> {
    if (!snapshot.serverUrl) {
        return await TokenStorage.getCredentials();
    }
    return await TokenStorage.getCredentialsForServerUrl(snapshot.serverUrl, {
        serverId: snapshot.serverId,
    });
}

function isActiveSwitchTargetCurrent(
    snapshot: Readonly<ReturnType<typeof getActiveServerSnapshot>>,
    targetGeneration: number,
): boolean {
    const currentSnapshot = getActiveServerSnapshot();
    return currentSnapshot.generation === snapshot.generation
        && currentSnapshot.serverId === snapshot.serverId
        && currentSnapshot.serverUrl === snapshot.serverUrl
        && Math.max(requestedGeneration, currentSnapshot.generation) <= targetGeneration;
}

function capturePublicationTargetForSnapshot(
    snapshot: Readonly<ReturnType<typeof getActiveServerSnapshot>>,
): ReturnType<typeof captureActiveServerRuntimeTarget> | null {
    const current = getActiveServerSnapshot();
    if (
        current.serverId !== snapshot.serverId
        || current.serverUrl !== snapshot.serverUrl
        || current.generation !== snapshot.generation
    ) return null;
    return captureActiveServerRuntimeTarget();
}

function capturePreparedSyncTarget(
    snapshot: Readonly<ReturnType<typeof getActiveServerSnapshot>>,
): import('@/sync/sync').SyncServerTarget | null {
    const current = getActiveServerSnapshot();
    if (
        current.serverId !== snapshot.serverId
        || current.serverUrl !== snapshot.serverUrl
        || current.generation !== snapshot.generation
    ) return null;
    return {
        serverId: current.serverId,
        serverUrl: current.serverUrl,
        generation: current.generation,
        ...(current.runtimeOrigin ? { runtimeOrigin: current.runtimeOrigin } : {}),
        ...(current.carrier ? { carrier: current.carrier } : {}),
        homeCarrier: getActiveServerHomeCarrier(),
    };
}

function isPublicationTargetCurrent(
    target: ReturnType<typeof captureActiveServerRuntimeTarget>,
): boolean {
    const current = captureActiveServerRuntimeTarget();
    return current.serverId === target.serverId && current.generation === target.generation;
}

/**
 * Focused-Home browser Iroh carriers this switch owner holds, keyed by lease.
 * A browser has no loopback listener to lease, so these handles — not a runtime
 * origin — are what the switch owns and must release when the Home, credential,
 * or generation changes.
 *
 * It is a keyed collection rather than one slot for the same reason the native
 * runtime keeps `publicationsByLeaseId`: a lease whose release failed stays
 * owned here so a later switch, retry, or logout retries exactly that lease,
 * and acquiring the next carrier can never overwrite that custody. Secondary
 * Homes are owned by the concurrent-server cache and are never released here.
 */
type AcquiredBrowserHomeCarrier = Extract<AcquiredHomeCarrier, { kind: 'browser_iroh' }>['carrier'];

const activeBrowserHomeCarriers = new Map<string, Readonly<{
    carrier: AcquiredBrowserHomeCarrier;
    release: () => Promise<void>;
    target: ReturnType<typeof captureActiveServerRuntimeTarget>;
}>>();

/**
 * Unpublishes and releases every retained focused-Home carrier. It runs before
 * any acquisition, so a superseded lease is always released exactly once per
 * attempt. Unpublishing first means a failed release still leaves no transport
 * published for this Home.
 */
async function releaseActiveBrowserHomeCarriers(): Promise<void> {
    for (const [leaseId, published] of [...activeBrowserHomeCarriers]) {
        releaseActiveServerRuntimeOrigin({ target: published.target, leaseId });
        try {
            await published.release();
            if (activeBrowserHomeCarriers.get(leaseId) === published) {
                activeBrowserHomeCarriers.delete(leaseId);
            }
        } catch {
            // Retain custody so the next switch, retry, or logout releases this
            // exact lease again. A failed release must not block the switch.
        }
    }
}

/**
 * Acquires and publishes the focused Home's Iroh carrier before
 * `syncSwitchServer`, so the existing `serverFetch` and Socket.IO readers
 * resolve the same transport for this same active generation. A browser uses
 * the relay-only semantic carrier (it cannot bind the native loopback listener);
 * every other host keeps the native lease and its verified runtime origin. A
 * Home without an adopted Iroh endpoint (or without an endpoint-scoped
 * credential) keeps the established canonical HTTPS/SSH behavior unchanged, and
 * any carrier from a prior Home/generation is released during the switch.
 */
async function ensureIrohHomeTunnelForActiveSwitch(
    snapshot: Readonly<ReturnType<typeof getActiveServerSnapshot>>,
    credentials: AuthCredentials | null,
    publicationTarget: ReturnType<typeof captureActiveServerRuntimeTarget>,
    mode: 'initial_selection' | 'pinned_recovery',
): Promise<void> {
    const token = credentials?.token?.trim() ?? '';
    const profile = getServerProfileById(snapshot.serverId);
    const descriptor = profile?.homeConnectionDescriptor;
    // A prior focused-Home carrier never survives a switch or a credential loss:
    // the publication below is the only thing that may reinstate one.
    await releaseActiveBrowserHomeCarriers();
    if (!isPublicationTargetCurrent(publicationTarget)) {
        throw new ServerScopedTransportUnavailableError();
    }
    if (!token || !credentials || !profile || !descriptor) {
        if (!token) await getIrohHomeTunnelRuntime().releaseActiveHomeTunnels();
        await getIrohHomeTunnelRuntime().releaseLeasesForStaleTargets();
        return;
    }

    if (readHomeApplicationCarrierEligibility() === 'standard_only') {
        await getIrohHomeTunnelRuntime().releaseActiveHomeTunnels();
    }

    const acquired = await acquireEligibleHomeCarrier({
        mode: readHomeApplicationCarrierEligibility() === 'standard_only' ? 'initial_selection' : mode,
        descriptor,
        verification: { kind: 'authenticated', token },
        credentials,
        acquireNative: async (input) => {
            // The focused lifecycle retains its established publication and
            // recovery duties; the shared primitive decides only which carrier
            // is eligible and whether HTTPS fallback is allowed.
            startNativeLoopbackTunnelRuntimeAppStateLifecycle();
            const irohRuntime = getIrohHomeTunnelRuntime();
            startActiveIrohRecoveryLifecycle(irohRuntime);
            return await irohRuntime.ensureHomeTunnel(input);
        },
    });
    if (acquired.kind === 'fail_closed' || acquired.kind === 'unavailable') {
        if (acquired.kind === 'unavailable') throw new ServerScopedTransportUnavailableError();
        if (acquired.fallbackAllowed) throw new ServerScopedTransportUnavailableError();
        throw acquired.error;
    }
    if (acquired.kind === 'native_iroh') return;
    if (acquired.kind === 'https') {
        if (!publishActiveServerRuntimeOrigin({
            target: publicationTarget,
            leaseId: `https-fallback:${publicationTarget.serverId}:${publicationTarget.generation}`,
            runtimeOrigin: acquired.runtimeOrigin,
            carrier: 'https',
        })) {
            throw new ServerScopedTransportUnavailableError();
        }
        return;
    }

    const carrier = acquired.carrier;
    activeBrowserHomeCarriers.set(carrier.leaseId, {
        carrier,
        release: acquired.release,
        target: publicationTarget,
    });
    if (!publishActiveServerRuntimeOrigin({
        target: publicationTarget,
        leaseId: carrier.leaseId,
        homeCarrier: carrier,
        carrier: 'iroh',
    })) {
        // Focus moved while the carrier was being acquired. The caller keeps
        // exact release custody and fails closed before Sync sees the target.
        await releaseActiveBrowserHomeCarriers();
        throw new ServerScopedTransportUnavailableError();
    }
}

/**
 * Single-shot recovery owner for the focused Home. Native terminal events,
 * foreground reprobes, and the visible Retry action all reacquire the verified
 * runtime origin here before asking the existing Sync lifecycle to reconnect.
 */
export async function retryActiveServerConnection(): Promise<void> {
    if (activeRecoveryPromise) return await activeRecoveryPromise;
    activeRecoveryPromise = (async () => {
        const snapshot = getActiveServerSnapshot();
        if (
            !isAppliedActiveServerRuntimeAvailable()
            ||
            getAppliedActiveServerId() !== snapshot.serverId
            || getAppliedActiveServerSnapshot().generation !== snapshot.generation
        ) {
            // A failed staged switch has no applied socket for this target to
            // retry. Re-enter the serialized switch owner so credentials,
            // carrier and Sync are prepared as one exact target transaction.
            await switchConnectionToActiveServer();
            return;
        }
        abortServerFetches();
        const credentials = await resolveCredentialsForActiveServer(snapshot);
        const publicationTarget = capturePublicationTargetForSnapshot(snapshot);
        if (!publicationTarget) return;
        await ensureIrohHomeTunnelForActiveSwitch(
            snapshot,
            credentials,
            publicationTarget,
            snapshot.carrier === 'iroh' && readHomeApplicationCarrierEligibility() !== 'standard_only'
                ? 'pinned_recovery'
                : 'initial_selection',
        );
        if (!isPublicationTargetCurrent(publicationTarget)) return;
        sync.retryNow();
    })();
    try {
        await activeRecoveryPromise;
    } finally {
        activeRecoveryPromise = null;
    }
}

async function applyPendingServerSwitches(): Promise<AuthCredentials | null> {
    await awaitColdRestore();
    while (true) {
        const snapshot = getActiveServerSnapshot();
        const targetGeneration = Math.max(requestedGeneration, snapshot.generation);

        const credentials = await resolveCredentialsForActiveServer(snapshot);
        if (!isActiveSwitchTargetCurrent(snapshot, targetGeneration)) continue;
        const canReuseAppliedRuntime = (
            targetGeneration <= lastAppliedGeneration
            && isAppliedActiveServerRuntimeAvailable()
            && getAppliedActiveServerSnapshot().serverId === snapshot.serverId
            && getAppliedActiveServerSnapshot().serverUrl === snapshot.serverUrl
            && getAppliedActiveServerSnapshot().generation === targetGeneration
            && appliedCredentialToken === readCredentialToken(credentials)
        );
        if (canReuseAppliedRuntime) {
            return credentials;
        }

        requestedGeneration = targetGeneration;
        abortServerFetches();
        const publicationTarget = capturePublicationTargetForSnapshot(snapshot);
        if (!publicationTarget) continue;
        await ensureIrohHomeTunnelForActiveSwitch(snapshot, credentials, publicationTarget, 'initial_selection');
        if (!isActiveSwitchTargetCurrent(snapshot, targetGeneration)) continue;
        const syncTarget = capturePreparedSyncTarget(snapshot);
        if (!syncTarget) continue;
        // Publish this before Sync begins its reset. The applied snapshot still
        // names the last successful Home, but that singleton runtime is no
        // longer a valid transport once this call starts.
        publishApplyingActiveServerId(snapshot.serverId, targetGeneration);
        try {
            await syncSwitchServer(credentials, syncTarget);
        } catch (error) {
            // A newer staged target superseded this bootstrap while Sync was
            // awaiting its own target-bound setup. Keep the singleton fenced
            // and continue the serialized owner with that newer target.
            if (!isActiveSwitchTargetCurrent(snapshot, targetGeneration)) continue;
            throw error;
        }
        lastAppliedGeneration = targetGeneration;
        appliedCredentialToken = readCredentialToken(credentials);
        publishAppliedActiveServerSnapshot(syncTarget);
    }
}

export async function switchConnectionToActiveServer(): Promise<AuthCredentials | null> {
    const snapshot = getActiveServerSnapshot();
    requestedGeneration = Math.max(requestedGeneration, snapshot.generation);
    if (!activeSwitchPromise) {
        activeSwitchPromise = applyPendingServerSwitches();
    }

    try {
        return await activeSwitchPromise;
    } finally {
        activeSwitchPromise = null;
    }
}

/**
 * Disconnects the focused server without consulting persisted credentials.
 * First-key recovery deliberately keeps rejected credentials as recovery
 * custody, so the ordinary switch operation must not be used for retirement.
 */
export async function disconnectActiveServerConnection(): Promise<void> {
    await awaitColdRestore();
    if (activeSwitchPromise) {
        await activeSwitchPromise.catch(() => null);
    }
    const snapshot = getActiveServerSnapshot();
    const publicationTarget = capturePublicationTargetForSnapshot(snapshot);
    if (!publicationTarget) return;
    requestedGeneration = Math.max(requestedGeneration, snapshot.generation);
    publishAppliedActiveServerRuntimeAvailability(false);
    abortServerFetches();
    await ensureIrohHomeTunnelForActiveSwitch(snapshot, null, publicationTarget, 'initial_selection');
    await syncSwitchServer(null);
    lastAppliedGeneration = Math.max(lastAppliedGeneration, snapshot.generation);
    appliedCredentialToken = null;
    publishAppliedActiveServerSnapshot(snapshot, false);
}

/**
 * Retire the focused connection only while it still belongs to the Home that
 * emitted an asynchronous credential-invalidity fact. The invalidation bus is
 * intentionally asynchronous, so consulting whichever Home is focused after
 * waiting would let an old Home disconnect its successor.
 */
export async function disconnectActiveServerConnectionIfCurrent(target: Readonly<{
    serverId: string;
    serverUrl: string;
    generation?: number;
}>): Promise<boolean> {
    if (activeSwitchPromise) {
        await activeSwitchPromise.catch(() => null);
    }
    const snapshot = getActiveServerSnapshot();
    if (
        snapshot.serverId !== target.serverId
        || createServerUrlComparableKey(snapshot.serverUrl) !== createServerUrlComparableKey(target.serverUrl)
        || (target.generation !== undefined && snapshot.generation !== target.generation)
    ) {
        return false;
    }
    await disconnectActiveServerConnection();
    return true;
}

/**
 * Cold-restore entrypoint. The local phase runs synchronously, before this returns:
 * this Account/Home's warm cache reaches the store before the carrier is asked for,
 * so an unreachable Home still paints its last-known list. The returned promise is
 * the transport phase: the verified carrier is prepared before Sync reads its origin.
 */
export function restoreConnectionToActiveServer(credentials: AuthCredentials): Promise<void> {
    const snapshot = getActiveServerSnapshot();
    syncHydrateLocalState(credentials, {
        serverId: snapshot.serverId,
        serverUrl: snapshot.serverUrl,
        generation: snapshot.generation,
    });
    const transport = restoreTransportToActiveServer(credentials, snapshot);
    const clearColdRestore = (): void => {
        if (coldRestorePromise === transport) coldRestorePromise = null;
    };
    coldRestorePromise = transport;
    void transport.then(clearColdRestore, clearColdRestore);
    return transport;
}

async function restoreTransportToActiveServer(
    credentials: AuthCredentials,
    snapshot: ReturnType<typeof getActiveServerSnapshot>,
): Promise<void> {
    const publicationTarget = capturePublicationTargetForSnapshot(snapshot);
    if (!publicationTarget) throw new ServerScopedTransportUnavailableError();
    abortServerFetches();
    await ensureIrohHomeTunnelForActiveSwitch(snapshot, credentials, publicationTarget, 'initial_selection');
    const syncTarget = capturePreparedSyncTarget(snapshot);
    if (!syncTarget) throw new ServerScopedTransportUnavailableError();
    publishApplyingActiveServerId(syncTarget.serverId, syncTarget.generation);
    await syncRestore(credentials, syncTarget);
    lastAppliedGeneration = Math.max(lastAppliedGeneration, snapshot.generation);
    appliedCredentialToken = readCredentialToken(credentials);
    publishAppliedActiveServerSnapshot(syncTarget);
}
