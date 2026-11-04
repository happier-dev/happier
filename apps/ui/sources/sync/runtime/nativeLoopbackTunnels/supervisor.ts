import { createLoopbackTunnelStore } from './store';
import type {
    LoopbackTunnelAdapter,
    LoopbackTunnelFailureCodes,
    LoopbackTunnelLease,
    LoopbackTunnelLimitation,
    LoopbackTunnelLifecycleEvent,
    LoopbackTunnelNativeEvent,
    LoopbackTunnelProbeResult,
    LoopbackTunnelRequest,
    LoopbackTunnelSupervisor,
    LoopbackTunnelSupervisorOptions,
} from './types';

const DEFAULT_FAILURE_CODES: Required<LoopbackTunnelFailureCodes> = {
    suspended: 'loopback_tunnel_suspended',
    probeFailed: 'loopback_tunnel_probe_failed',
    staleGeneration: 'loopback_tunnel_stale_generation',
    disposed: 'loopback_tunnel_disposed',
};

/**
 * A tunnel was already acquired and then failed verification. Cleanup errors
 * remain available for lifecycle diagnostics and retry custody, but cannot
 * replace the post-acquisition failure that carrier policy must classify.
 */
export class LoopbackTunnelPostAcquisitionError extends Error {
    readonly cleanupError: unknown;

    constructor(message: string, cleanupError: unknown) {
        super(message);
        this.name = 'LoopbackTunnelPostAcquisitionError';
        this.cleanupError = cleanupError;
    }
}

/**
 * Lifecycle-only owner for every native loopback tunnel (SSH, Iroh). Native
 * adapters retain all socket and byte-copy ownership; this owner provides lease
 * keying, in-flight dedupe with reference counts, bounded probes, failed-start
 * diagnostics, degrade/restart, foreground recovery, and scoped release.
 */
export function createLoopbackTunnelSupervisor<
    Request extends LoopbackTunnelRequest,
    Lease extends LoopbackTunnelLease,
    Limitation extends LoopbackTunnelLimitation = LoopbackTunnelLimitation,
    Native = unknown,
>(input: LoopbackTunnelSupervisorOptions<Request, Lease, Limitation, Native>): LoopbackTunnelSupervisor<Request, Lease, Limitation> {
    const store = createLoopbackTunnelStore<Lease, Limitation, Request>({
        foregroundLimitation: input.platformLimitations?.foreground ?? null,
        suspendedLimitation: input.platformLimitations?.suspended ?? null,
    });
    const failureCodes: Required<LoopbackTunnelFailureCodes> = {
        suspended: input.failureCodes?.suspended ?? DEFAULT_FAILURE_CODES.suspended,
        probeFailed: input.failureCodes?.probeFailed ?? DEFAULT_FAILURE_CODES.probeFailed,
        staleGeneration: input.failureCodes?.staleGeneration ?? DEFAULT_FAILURE_CODES.staleGeneration,
        disposed: input.failureCodes?.disposed ?? DEFAULT_FAILURE_CODES.disposed,
    };
    /**
     * Acquisition admission closes synchronously when disposal begins (A9
     * lifecycle closure). Starts already admitted keep settling through the
     * disposal pass; a failed disposal reopens admission because the same
     * owner stays live for its documented retry.
     */
    let admissionClosed = false;
    const pending = new Map<string, { promise: Promise<Lease>; referenceCount: number }>();
    const nativeSubscriptions = new Map<string, () => void>();
    const listeners = new Set<(event: LoopbackTunnelLifecycleEvent<Lease>) => void>();
    const probeTimeoutMs = input.probeTimeoutMs ?? 15_000;
    const probeTimeoutReason = input.probeTimeoutReason ?? 'probe-timeout';

    function removeNativeSubscription(nativeTunnelId: string | null): void {
        if (!nativeTunnelId) return;
        nativeSubscriptions.get(nativeTunnelId)?.();
        nativeSubscriptions.delete(nativeTunnelId);
    }

    function notifyNativeEvent(key: string, nativeTunnelId: string, event: LoopbackTunnelNativeEvent): void {
        const stored = store.getByKey(key);
        if (!stored || stored.nativeTunnelId !== nativeTunnelId || event.tunnelHandle !== nativeTunnelId) return;
        const nextLease = input.updateLeaseForNativeEvent?.(stored.lease, event) ?? stored.lease;
        const status = event.type === 'ready' || event.type === 'path_changed'
            ? 'ready'
            : event.type === 'degraded'
                ? 'degraded'
                : event.type === 'closed'
                    ? 'stopped'
                    : stored.lease.status;
        const projected = { ...nextLease, status } as Lease;
        store.put(key, { ...stored, lease: projected });
        const lifecycleEvent: LoopbackTunnelLifecycleEvent<Lease> = { ...event, lease: projected };
        for (const listener of listeners) listener(lifecycleEvent);
        if (event.type === 'closed') {
            // Only authoritative native closure is terminal for this handle.
            // An `error` event reports a failed status observation; the adapter
            // continues polling and may still observe a later ready/path fact.
            removeNativeSubscription(nativeTunnelId);
            void detachStoppedNativeTunnel(key).catch(() => {
                const current = store.getByKey(key);
                if (current) store.updateStatus(current.lease.leaseId, 'failed');
            });
        }
    }

    function subscribeToNativeEvents(key: string, nativeTunnelId: string): void {
        removeNativeSubscription(nativeTunnelId);
        // Acquisition or a foreground probe can finish after suspension.
        // Keep the admitted lease, but do not restart its status observation.
        if (store.isSuspended()) return;
        const unsubscribe = input.adapter.subscribeLoopbackTunnelEvents?.(
            nativeTunnelId,
            (event) => notifyNativeEvent(key, nativeTunnelId, event),
        );
        if (unsubscribe) nativeSubscriptions.set(nativeTunnelId, unsubscribe);
    }

    async function runBoundedProbe(url: string, request: Request): Promise<LoopbackTunnelProbeResult> {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                input.probe(url, request),
                new Promise<LoopbackTunnelProbeResult>((resolve) => {
                    timeout = setTimeout(() => resolve({ ok: false, reason: probeTimeoutReason }), probeTimeoutMs);
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    /** Marks a stale ready lease degraded, stops its native tunnel, and keeps the entry for replacement. */
    async function degradeStoredLease(key: string, failureMessage: string): Promise<void> {
        const stale = store.getByKey(key);
        if (!stale) return;
        store.updateStatus(stale.lease.leaseId, 'degraded');
        if (stale.nativeTunnelId) {
            removeNativeSubscription(stale.nativeTunnelId);
            try {
                await input.adapter.stopLoopbackTunnel(stale.nativeTunnelId);
            } catch (cleanupError) {
                throw new LoopbackTunnelPostAcquisitionError(failureMessage, cleanupError);
            }
            const degraded = store.getByKey(key);
            if (degraded) store.put(key, { ...degraded, nativeTunnelId: null });
        }
    }

    /** Stops a stored native tunnel and detaches it while preserving the lease entry. */
    async function detachStoppedNativeTunnel(key: string): Promise<void> {
        const stale = store.getByKey(key);
        if (!stale?.nativeTunnelId) return;
        removeNativeSubscription(stale.nativeTunnelId);
        await input.adapter.stopLoopbackTunnel(stale.nativeTunnelId);
        const current = store.getByKey(key);
        if (current?.nativeTunnelId === stale.nativeTunnelId) {
            store.put(key, { ...current, nativeTunnelId: null });
        }
    }

    /**
     * Final owner cleanup is intentionally different from a caller release:
     * callers that shared an acquisition may each hold a reference, while a
     * failed acquisition returned no releasable handle at all. Disposal waits
     * for acquisitions already owned by this supervisor, then stops each exact
     * native handle once regardless of its reference count. Failed stops remain
     * stored so the same owner can retry them on a later disposal attempt.
     */
    async function dispose(): Promise<void> {
        // Admission shuts synchronously before the first await, so no start can
        // be admitted after disposal begins. Starts admitted before this point
        // settle below, and every handle they produced is stopped by this same
        // disposal pass rather than outliving the supervisor.
        admissionClosed = true;
        try {
            await Promise.allSettled([...pending.values()].map(({ promise }) => promise));
            const errors: unknown[] = [];
            for (const lease of store.snapshot().leases) {
                const stored = store.getByKey(lease.key);
                if (!stored) continue;
                if (stored.nativeTunnelId) {
                    removeNativeSubscription(stored.nativeTunnelId);
                    try {
                        await input.adapter.stopLoopbackTunnel(stored.nativeTunnelId);
                    } catch (error) {
                        store.updateStatus(stored.lease.leaseId, 'failed');
                        errors.push(error);
                        continue;
                    }
                }
                store.deleteByKey(lease.key);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Failed to dispose every loopback tunnel.');
        } catch (error) {
            // A failed disposal keeps this supervisor as the live owner for its
            // documented retry, so acquisition admission reopens.
            admissionClosed = false;
            throw error;
        }
    }

    return {
        async ensureTunnel(request) {
            if (admissionClosed) throw new Error(failureCodes.disposed);
            if (store.isSuspended()) throw new Error(failureCodes.suspended);
            const key = input.buildKey(request);
            const inFlight = pending.get(key);
            if (inFlight) {
                inFlight.referenceCount += 1;
                return await inFlight.promise;
            }

            const generation = input.getGeneration?.();
            const startPromise = (async () => {
                const existing = store.getByKey(key);
                let retainedReferenceCount = 0;
                if (existing?.lease.status === 'ready' && existing.lease.localUrl) {
                    const existingProbe = await runBoundedProbe(existing.lease.localUrl, request);
                    if (existingProbe.ok) {
                        // A retained lease deliberately ignores verification-only
                        // facts in its key. Once the newest request verifies, it
                        // becomes the request used for later foreground probes.
                        // Keeping the original request here would resurrect an
                        // expired token after suspend/resume.
                        store.put(key, { ...existing, request });
                        let retained = store.getByKey(key) ?? existing;
                        const referencesToRetain = pending.get(key)?.referenceCount ?? 1;
                        for (let index = 0; index < referencesToRetain; index += 1) {
                            retained = store.retain(key) ?? retained;
                        }
                        return retained.lease;
                    }
                    retainedReferenceCount = existing.referenceCount;
                    await degradeStoredLease(
                        key,
                        `${failureCodes.probeFailed}:${existingProbe.reason}`,
                    );
                }
                const stoppedExisting = store.getByKey(key);
                if (stoppedExisting && stoppedExisting.lease.status !== 'ready') {
                    retainedReferenceCount = Math.max(retainedReferenceCount, stoppedExisting.referenceCount);
                    try {
                        await detachStoppedNativeTunnel(key);
                    } catch (cleanupError) {
                        throw new LoopbackTunnelPostAcquisitionError(
                            `${failureCodes.probeFailed}:cleanup-pending`,
                            cleanupError,
                        );
                    }
                }

                let started: Awaited<ReturnType<LoopbackTunnelAdapter<Request, Native>['startLoopbackTunnel']>>;
                try {
                    started = await input.adapter.startLoopbackTunnel(request);
                } catch (error) {
                    const limitation = input.limitationForStartError?.(error) ?? null;
                    if (limitation) store.setRuntimeLimitation(limitation);
                    throw error;
                }
                const localUrl = `http://127.0.0.1:${started.localPort}`;
                const lease = input.createLease({
                    key,
                    request,
                    localPort: started.localPort,
                    ...(generation === undefined ? {} : { generation }),
                    ...(started.native === undefined ? {} : { native: started.native }),
                });
                // Probe the exact origin the lease publishes (carriers may report
                // their own loopback origin, e.g. the native Iroh lease origin).
                const probeResult = await runBoundedProbe(lease.localUrl ?? localUrl, request);
                if (!probeResult.ok) {
                    const limitation = input.limitationForProbeFailure?.(probeResult.reason) ?? null;
                    if (limitation) store.setRuntimeLimitation(limitation);
                    // Keep failed-lease bookkeeping (with the native id) so a cleanup stop that
                    // fails can be retried through releaseTunnel instead of leaking the tunnel.
                    const failedLease = { ...lease, status: 'failed' } as Lease;
                    store.put(key, {
                        lease: failedLease,
                        nativeTunnelId: started.nativeTunnelId,
                        referenceCount: retainedReferenceCount + (pending.get(key)?.referenceCount ?? 1),
                        request,
                    });
                    try {
                        await input.adapter.stopLoopbackTunnel(started.nativeTunnelId);
                        store.deleteByKey(key);
                    } catch (cleanupError) {
                        store.updateStatus(failedLease.leaseId, 'failed');
                        throw new LoopbackTunnelPostAcquisitionError(
                            `${failureCodes.probeFailed}:${probeResult.reason}`,
                            cleanupError,
                        );
                    }
                    throw new Error(`${failureCodes.probeFailed}:${probeResult.reason}`);
                }
                if (generation !== undefined && input.getGeneration?.() !== generation) {
                    try {
                        await input.adapter.stopLoopbackTunnel(started.nativeTunnelId);
                    } catch (cleanupError) {
                        throw new LoopbackTunnelPostAcquisitionError(
                            failureCodes.staleGeneration,
                            cleanupError,
                        );
                    }
                    throw new Error(failureCodes.staleGeneration);
                }
                // A verified healthy lease invalidates stale failure diagnostics.
                store.clearRuntimeLimitations();
                store.put(key, {
                    lease,
                    nativeTunnelId: started.nativeTunnelId,
                    referenceCount: retainedReferenceCount + (pending.get(key)?.referenceCount ?? 1),
                    request,
                });
                subscribeToNativeEvents(key, started.nativeTunnelId);
                return lease;
            })();

            pending.set(key, { promise: startPromise, referenceCount: 1 });
            try {
                return await startPromise;
            } finally {
                pending.delete(key);
            }
        },
        listTunnels: () => store.snapshot(),
        async releaseTunnel(leaseId) {
            const release = store.releaseByLeaseId(leaseId);
            if (!release?.released) return;
            if (release.stored.nativeTunnelId) {
                try {
                    removeNativeSubscription(release.stored.nativeTunnelId);
                    await input.adapter.stopLoopbackTunnel(release.stored.nativeTunnelId);
                    store.removeReleasedLease(leaseId);
                } catch (error) {
                    store.updateStatus(leaseId, 'failed');
                    throw error;
                }
                return;
            }
            store.removeReleasedLease(leaseId);
        },
        dispose,
        markSuspended() {
            store.markSuspended();
            // The existing app-lifecycle owner suspends observation together
            // with lease publication. Native transports may remain allocated,
            // but no polling/timer stays active in the background.
            for (const nativeTunnelId of [...nativeSubscriptions.keys()]) {
                removeNativeSubscription(nativeTunnelId);
            }
        },
        async markForeground() {
            store.markForeground();
            for (const lease of store.snapshot().leases) {
                const stored = store.getByKey(lease.key);
                if (!stored || !stored.lease.localUrl) continue;
                const result = await runBoundedProbe(stored.lease.localUrl, stored.request);
                if (result.ok) {
                    store.updateStatus(stored.lease.leaseId, 'ready');
                    store.clearRuntimeLimitations();
                    if (stored.nativeTunnelId) subscribeToNativeEvents(lease.key, stored.nativeTunnelId);
                    continue;
                }
                const limitation = input.limitationForProbeFailure?.(result.reason) ?? null;
                if (limitation) store.setRuntimeLimitation(limitation);
                store.updateStatus(stored.lease.leaseId, 'failed');
                await detachStoppedNativeTunnel(lease.key);
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
