import {
    captureActiveServerRuntimeTarget,
    publishActiveServerRuntimeOrigin,
    releaseActiveServerRuntimeOrigin,
    type ActiveServerRuntimeTarget,
} from '@/sync/domains/server/serverProfiles';

import {
    IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR,
    IROH_HOME_TUNNEL_STALE_FOCUS_ERROR,
} from '@happier-dev/iroh-native';
import { releaseRetainedIrohMachineTransferLeases } from './machineTransferLifecycle';
import { createIrohHomeTunnelSupervisor, IROH_HOME_TUNNEL_DISPOSED_ERROR, type IrohHomeTunnelSupervisor, type IrohNativeLifecycleModule } from './supervisor';
import type {
    IrohHomeTunnelAcquireInput,
    IrohHomeTunnelRequest,
    IrohHomeRuntimeOriginLease,
    IrohHomeTunnelRecoveryRequired,
    IrohHomeTunnelRuntime,
} from './types';
import type { IrohRelayPolicy } from '@happier-dev/iroh-native';
import { startNativeLoopbackTunnelRuntimeAppStateLifecycle } from '@/sync/runtime/nativeLoopbackTunnels/runtime';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';

export const DEFAULT_IROH_RELAY_POLICY: IrohRelayPolicy = 'automatic';

type PublishedIrohHomeLease = Readonly<{
    target: ActiveServerRuntimeTarget;
    release: () => Promise<void>;
}>;

/**
 * UI lifecycle runtime for the native Iroh Home tunnel. Acquires/releases the
 * native lease through the shared loopback supervisor, publishes the runtime
 * origin only after the full verification chain succeeds, and keeps every
 * publication target-scoped so a stale lifecycle event can never clear or
 * overwrite another Home's origin.
 */
export function createIrohHomeTunnelRuntime(params: Readonly<{
    native?: IrohNativeLifecycleModule | null;
    createSupervisor?: () => IrohHomeTunnelSupervisor;
}> = {}): IrohHomeTunnelRuntime {
    const supervisor = params.createSupervisor?.() ?? createIrohHomeTunnelSupervisor({ native: params.native });
    const publicationsByLeaseId = new Map<string, PublishedIrohHomeLease>();
    const recoveryListeners = new Set<(event: IrohHomeTunnelRecoveryRequired) => void>();
    /**
     * Disposal closes this runtime's admission synchronously when it begins:
     * new acquisition calls are refused, starts admitted before disposal began
     * settle and have their late handles released instead of published, and
     * the still-published singleton accepts no work. A failed disposal reopens
     * admission because this same instance stays the live owner for its
     * documented cleanup retry.
     */
    let disposed = false;

    function notifyRecoveryRequired(event: IrohHomeTunnelRecoveryRequired): void {
        for (const listener of recoveryListeners) listener(event);
    }

    // Native events carry transport facts only. This UI owner attaches the
    // existing Home/active-generation publication target and is the sole
    // place where a carrier event can affect runtimeOrigin.
    let unsubscribeLifecycle = supervisor.subscribe((event) => {
        const published = publicationsByLeaseId.get(event.lease.leaseId);
        if (event.type === 'ready' && event.lease.localUrl && published) {
            publishActiveServerRuntimeOrigin({
                target: published.target,
                leaseId: event.lease.leaseId,
                runtimeOrigin: event.lease.localUrl,
                carrier: 'iroh',
            });
            return;
        }
        if (event.type === 'degraded' || event.type === 'closed') {
            if (published) {
                releaseActiveServerRuntimeOrigin({ target: published.target, leaseId: event.lease.leaseId });
            }
            if (event.type === 'closed') {
                notifyRecoveryRequired({
                    leaseId: event.lease.leaseId,
                    homeServerIdentityId: event.lease.homeServerIdentityId,
                    reason: 'terminal',
                    activePublication: published !== undefined,
                });
            }
        }
    });

    function validateAcquireInput(input: IrohHomeTunnelAcquireInput): void {
        if (!input.homeServerIdentityId.trim() || !input.endpoint.endpointId.trim() || !input.canonicalServerUrl.trim()) {
            throw new Error(IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR);
        }
    }

    /** Releases native leases (and their scoped publications) for prior Home/focus generations. */
    async function releaseStalePublicationLeases(target: ActiveServerRuntimeTarget): Promise<void> {
        for (const [leaseId, published] of [...publicationsByLeaseId]) {
            if (published.target.serverId === target.serverId && published.target.generation === target.generation) continue;
            // Scoped unpublish first: a stale event must never clear another Home's origin.
            releaseActiveServerRuntimeOrigin({ target: published.target, leaseId });
            try {
                await published.release();
                if (publicationsByLeaseId.get(leaseId) === published) {
                    publicationsByLeaseId.delete(leaseId);
                }
            } catch {
                // Keep ownership so the existing switch/logout/dispose cleanup
                // paths can retry the failed native stop.
            }
        }
    }

    async function releaseActiveHomeTunnels(): Promise<void> {
        const errors: unknown[] = [];
        for (const [leaseId, published] of [...publicationsByLeaseId]) {
            releaseActiveServerRuntimeOrigin({ target: published.target, leaseId });
            try {
                await published.release();
                if (publicationsByLeaseId.get(leaseId) === published) {
                    publicationsByLeaseId.delete(leaseId);
                }
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Failed to release every active Iroh Home tunnel.');
    }

    async function acquireHomeRuntimeOrigin(
        input: IrohHomeTunnelAcquireInput,
    ): Promise<IrohHomeRuntimeOriginLease> {
        if (disposed) throw new Error(IROH_HOME_TUNNEL_DISPOSED_ERROR);
        validateAcquireInput(input);
        const request: IrohHomeTunnelRequest = {
            // The reusable transport lease is scoped to the Home identity, not
            // whichever local profile happens to be focused by this caller.
            remoteHostId: input.homeServerIdentityId.trim(),
            purpose: 'home',
            homeServerIdentityId: input.homeServerIdentityId,
            endpointId: input.endpoint.endpointId,
            canonicalServerUrl: input.canonicalServerUrl,
            policy: input.policy ?? DEFAULT_IROH_RELAY_POLICY,
            ...(input.endpoint.relayUrls ? { relayUrls: input.endpoint.relayUrls } : {}),
            ...(input.endpoint.directAddresses ? { directAddresses: input.endpoint.directAddresses } : {}),
            verification: input.verification,
        };
        const lease = await supervisor.ensureTunnel(request);
        if (disposed) {
            // Disposal began while this admitted start was settling. The late
            // handle is released instead of returned; a failed stop stays owned
            // by the supervisor for its disposal retry.
            await supervisor.releaseTunnel(lease.leaseId).catch(() => undefined);
            throw new Error(IROH_HOME_TUNNEL_DISPOSED_ERROR);
        }
        const runtimeOrigin = lease.localUrl?.trim() ?? '';
        if (!runtimeOrigin) {
            await supervisor.releaseTunnel(lease.leaseId);
            throw new Error(`${IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR}:runtime-origin-missing`);
        }
        let releasePromise: Promise<void> | null = null;
        let released = false;
        const release = (): Promise<void> => {
            if (released) return Promise.resolve();
            releasePromise ??= supervisor.releaseTunnel(lease.leaseId).then(() => {
                released = true;
            }).catch((error: unknown) => {
                // Concurrent callers still share one attempt, while the
                // supervisor retains a failed native stop for a later retry.
                releasePromise = null;
                throw error;
            });
            return releasePromise;
        };
        return {
            ...lease,
            runtimeOrigin,
            release,
        };
    }

    return {
        acquireHomeRuntimeOrigin,

        async ensureHomeTunnel(input) {
            if (disposed) throw new Error(IROH_HOME_TUNNEL_DISPOSED_ERROR);
            const target = captureActiveServerRuntimeTarget();
            // A lease belonging to the prior Home/generation is released as part of this switch.
            await releaseStalePublicationLeases(target);
            // Resolves only after the shared supervisor verified health, authenticated
            // reachability, and Home identity against the lease's exact runtime origin.
            const lease = await acquireHomeRuntimeOrigin(input);
            const published = publishActiveServerRuntimeOrigin({
                target,
                leaseId: lease.leaseId,
                runtimeOrigin: lease.runtimeOrigin,
                carrier: 'iroh',
            });
            if (!published) {
                const rejectedPublication: PublishedIrohHomeLease = {
                    target,
                    release: lease.release,
                };
                publicationsByLeaseId.set(lease.leaseId, rejectedPublication);
                try {
                    await rejectedPublication.release();
                    if (publicationsByLeaseId.get(lease.leaseId) === rejectedPublication) {
                        publicationsByLeaseId.delete(lease.leaseId);
                    }
                } catch {
                    // Fail closed regardless. Keep cleanup ownership so the
                    // existing switch/logout/dispose paths can retry it.
                }
                throw new Error(IROH_HOME_TUNNEL_STALE_FOCUS_ERROR);
            }
            // The active publication owns exactly one supervisor reference.
            // Replacing it (including with a retained lease carrying the same
            // leaseId) releases the superseded active reference without
            // disturbing independent enrollment/secondary-Home references.
            const superseded = [...publicationsByLeaseId.entries()].filter(([, prior]) => (
                prior.target.serverId === target.serverId
                && prior.target.generation === target.generation
            ));
            publicationsByLeaseId.set(lease.leaseId, {
                target,
                release: lease.release,
            });
            for (const [priorLeaseId, prior] of superseded) {
                if (priorLeaseId !== lease.leaseId) {
                    releaseActiveServerRuntimeOrigin({ target: prior.target, leaseId: priorLeaseId });
                }
                try {
                    await prior.release();
                    if (priorLeaseId !== lease.leaseId && publicationsByLeaseId.get(priorLeaseId) === prior) {
                        publicationsByLeaseId.delete(priorLeaseId);
                    }
                } catch {
                    // The verified replacement remains authoritative. Retain
                    // failed cleanup ownership for the next ensure/logout/dispose.
                }
            }
            return lease;
        },

        async releaseHomeTunnel(leaseId) {
            const published = publicationsByLeaseId.get(leaseId) ?? null;
            if (published) releaseActiveServerRuntimeOrigin({ target: published.target, leaseId });
            if (published) await published.release();
            else await supervisor.releaseTunnel(leaseId);
            publicationsByLeaseId.delete(leaseId);
        },

        releaseActiveHomeTunnels,

        async dispose() {
            disposed = true;
            try {
                for (const [leaseId, published] of publicationsByLeaseId) {
                    releaseActiveServerRuntimeOrigin({ target: published.target, leaseId });
                }
                // The supervisor is the sole owner of every native handle,
                // including acquisitions that failed before returning a lease.
                await supervisor.dispose();
                publicationsByLeaseId.clear();
                unsubscribeLifecycle();
                unsubscribeLifecycle = () => undefined;
                recoveryListeners.clear();
            } catch (error) {
                // A failed disposal keeps this runtime as the live owner for
                // its documented cleanup retry, so admission reopens.
                disposed = false;
                throw error;
            }
        },

        async releaseLeasesForStaleTargets() {
            await releaseStalePublicationLeases(captureActiveServerRuntimeTarget());
        },

        markSuspended(): void {
            supervisor.markSuspended();
            // Degrade the native leases and unpublish every origin so requests
            // fail back to the stable canonical carrier while suspended.
            for (const [leaseId, published] of publicationsByLeaseId) {
                releaseActiveServerRuntimeOrigin({ target: published.target, leaseId });
            }
        },

        async markForeground(): Promise<void> {
            // The shared supervisor re-probes stored leases with their original
            // request facts; only verified-ready leases are republished here.
            await supervisor.markForeground();
            const target = captureActiveServerRuntimeTarget();
            for (const lease of supervisor.listTunnels().leases) {
                const published = publicationsByLeaseId.get(lease.leaseId);
                if (lease.status !== 'ready' || !lease.localUrl) {
                    notifyRecoveryRequired({
                        leaseId: lease.leaseId,
                        homeServerIdentityId: lease.homeServerIdentityId,
                        reason: 'foreground_probe_failed',
                        activePublication: published !== undefined,
                    });
                    continue;
                }
                if (!published || published.target.serverId !== target.serverId) continue;
                if (published.target.generation !== target.generation) {
                    notifyRecoveryRequired({
                        leaseId: lease.leaseId,
                        homeServerIdentityId: lease.homeServerIdentityId,
                        reason: 'stale_generation',
                        activePublication: true,
                    });
                    continue;
                }
                if (publishActiveServerRuntimeOrigin({
                    target,
                    leaseId: lease.leaseId,
                    runtimeOrigin: lease.localUrl,
                    carrier: 'iroh',
                })) {
                    publicationsByLeaseId.set(lease.leaseId, { ...published, target });
                }
            }
        },

        subscribeRecoveryRequired(listener) {
            recoveryListeners.add(listener);
            return () => recoveryListeners.delete(listener);
        },

        listTunnels: () => supervisor.listTunnels(),
    };
}

let singletonRuntime: IrohHomeTunnelRuntime | null = null;
let singletonDisposePromise: Promise<void> | null = null;

export function getIrohHomeTunnelRuntime(params: Readonly<{
    native?: IrohNativeLifecycleModule | null;
    createSupervisor?: () => IrohHomeTunnelSupervisor;
}> = {}): IrohHomeTunnelRuntime {
    if (!singletonRuntime) {
        singletonRuntime = createIrohHomeTunnelRuntime(params);
        if (!isRuntimeActive()) singletonRuntime.markSuspended();
    }
    return singletonRuntime;
}

export async function disposeIrohHomeTunnelRuntime(): Promise<void> {
    // This is the existing application-level Iroh disposal hook. Retained
    // machine HTTP stops must succeed before the shared endpoint owner is
    // considered disposable, and a failure remains retryable on the next call.
    await releaseRetainedIrohMachineTransferLeases();
    const runtime = singletonRuntime;
    if (!runtime) return;
    if (singletonDisposePromise) return await singletonDisposePromise;
    singletonDisposePromise = (async () => {
        await runtime.dispose();
        if (singletonRuntime === runtime) {
            singletonRuntime = null;
        }
    })();
    try {
        await singletonDisposePromise;
    } finally {
        singletonDisposePromise = null;
    }
}

/** Stable lifecycle-neutral production seam consumed by enrollment/secondary Home owners. */
export async function acquireIrohHomeRuntimeOrigin(
    input: IrohHomeTunnelAcquireInput,
): Promise<IrohHomeRuntimeOriginLease> {
    // Enrollment and secondary Homes need the same activity owner as the
    // focused connection, including when no focused connection exists yet.
    startNativeLoopbackTunnelRuntimeAppStateLifecycle();
    return await getIrohHomeTunnelRuntime().acquireHomeRuntimeOrigin(input);
}

export function subscribeIrohHomeTunnelRecoveryRequired(
    listener: (event: IrohHomeTunnelRecoveryRequired) => void,
): () => void {
    return getIrohHomeTunnelRuntime().subscribeRecoveryRequired(listener);
}
