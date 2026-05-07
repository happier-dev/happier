import { createNativeSshTunnelStore, buildNativeSshTunnelKey } from './store';
import { DEFAULT_NATIVE_SSH_TUNNEL_PROBE_TIMEOUT_MS, probeNativeSshTunnel } from './probe';
import type {
    NativeSshTunnelAdapter,
    NativeSshTunnelLimitation,
    NativeSshTunnelLease,
    NativeSshTunnelProbe,
    NativeSshTunnelProbeResult,
    NativeSshTunnelRequest,
    NativeSshTunnelSupervisor,
} from './types';

const DEFAULT_ADAPTER: NativeSshTunnelAdapter = {
    async startLoopbackTunnel() {
        throw new Error('native_ssh_tunnel_unavailable');
    },
    async stopLoopbackTunnel() {},
};

function nowIso(): string {
    return new Date().toISOString();
}

function createLeaseId(key: string): string {
    return `native-ssh:${key}`;
}

function limitationForProbeResult(result: NativeSshTunnelProbeResult): NativeSshTunnelLimitation | null {
    if (result.ok) {
        return null;
    }
    return {
        id: `native-ssh.${result.reason}`,
        severity: 'error',
        reason: result.reason,
        message: `settings.accessEndpoints.limitation.${result.reason}`,
    };
}

function limitationForStartError(error: unknown): NativeSshTunnelLimitation | null {
    const code = readNativeSshErrorCode(error);
    if (!isNativeSshTunnelLimitationReason(code)) {
        return null;
    }
    return {
        id: `native-ssh.${code}`,
        severity: 'error',
        reason: code,
        message: `settings.accessEndpoints.limitation.${code}`,
    };
}

function isNativeSshTunnelLimitationReason(
    value: string | null,
): value is NativeSshTunnelLimitation['reason'] {
    return value === 'authentication-failed'
        || value === 'host-key-mismatch'
        || value === 'host-key-rejected'
        || value === 'host-key-untrusted'
        || value === 'loopback-bind-failed'
        || value === 'network-captive-portal'
        || value === 'remote-service-unreachable';
}

function readNativeSshErrorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') {
        return null;
    }
    const candidate = error as { code?: unknown; userInfo?: unknown; nativeErrorCode?: unknown };
    if (typeof candidate.code === 'string') {
        return candidate.code;
    }
    if (typeof candidate.nativeErrorCode === 'string') {
        return candidate.nativeErrorCode;
    }
    if (candidate.userInfo && typeof candidate.userInfo === 'object') {
        const userInfo = candidate.userInfo as { code?: unknown };
        if (typeof userInfo.code === 'string') {
            return userInfo.code;
        }
    }
    return null;
}

function nativeSshRuntimeErrorLimitationReasons(): readonly NativeSshTunnelLimitation['reason'][] {
    return [
        'authentication-failed',
        'host-key-mismatch',
        'host-key-rejected',
        'host-key-untrusted',
        'loopback-bind-failed',
        'network-captive-portal',
        'remote-service-unreachable',
    ];
}

export function createNativeSshTunnelSupervisor(params: Readonly<{
    adapter?: NativeSshTunnelAdapter;
    probe?: NativeSshTunnelProbe;
    probeTimeoutMs?: number;
}> = {}): NativeSshTunnelSupervisor {
    const adapter = params.adapter ?? DEFAULT_ADAPTER;
    const probe = params.probe ?? probeNativeSshTunnel;
    const probeTimeoutMs = params.probeTimeoutMs ?? DEFAULT_NATIVE_SSH_TUNNEL_PROBE_TIMEOUT_MS;
    const store = createNativeSshTunnelStore();
    const inFlightByKey = new Map<string, {
        promise: Promise<NativeSshTunnelLease>;
        referenceCount: number;
    }>();

    async function stopStoredLease(key: string): Promise<void> {
        const stale = store.deleteByKey(key);
        if (stale?.nativeTunnelId) {
            await adapter.stopLoopbackTunnel(stale.nativeTunnelId);
        }
    }

    async function degradeStoredLease(key: string): Promise<void> {
        const stale = store.getByKey(key);
        if (!stale) {
            return;
        }
        store.updateStatus(stale.lease.leaseId, 'degraded');
        if (stale.nativeTunnelId) {
            await adapter.stopLoopbackTunnel(stale.nativeTunnelId);
            const degraded = store.getByKey(key);
            if (degraded) {
                store.put(key, {
                    ...degraded,
                    nativeTunnelId: null,
                });
            }
        }
    }

    async function detachStoppedNativeTunnel(key: string): Promise<void> {
        const stale = store.getByKey(key);
        if (!stale?.nativeTunnelId) {
            return;
        }
        await adapter.stopLoopbackTunnel(stale.nativeTunnelId);
        const current = store.getByKey(key);
        if (current?.nativeTunnelId === stale.nativeTunnelId) {
            store.put(key, {
                ...current,
                nativeTunnelId: null,
            });
        }
    }

    async function runBoundedProbe(localUrl: string): Promise<NativeSshTunnelProbeResult> {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                probe(localUrl),
                new Promise<NativeSshTunnelProbeResult>((resolve) => {
                    timeout = setTimeout(() => {
                        resolve({ ok: false, reason: 'remote-service-unreachable' });
                    }, probeTimeoutMs);
                }),
            ]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    return {
        async ensureTunnel(request: NativeSshTunnelRequest): Promise<NativeSshTunnelLease> {
            if (store.isSuspended()) {
                throw new Error('native_ssh_tunnel_suspended');
            }
            const key = buildNativeSshTunnelKey(request);
            const inFlight = inFlightByKey.get(key);
            if (inFlight) {
                inFlight.referenceCount += 1;
                return await inFlight.promise;
            }

            const startPromise = (async () => {
                const existing = store.getByKey(key);
                let retainedReferenceCount = 0;
                if (existing?.lease.status === 'ready' && existing.lease.localUrl) {
                    const existingProbe = await runBoundedProbe(existing.lease.localUrl);
                    if (existingProbe.ok) {
                        let retained = existing;
                        const referencesToRetain = inFlightByKey.get(key)?.referenceCount ?? 1;
                        for (let index = 0; index < referencesToRetain; index += 1) {
                            retained = store.retain(key) ?? retained;
                        }
                        return retained.lease;
                    }
                    retainedReferenceCount = existing.referenceCount;
                    await degradeStoredLease(key);
                }
                const stoppedExisting = store.getByKey(key);
                if (stoppedExisting && stoppedExisting.lease.status !== 'ready') {
                    retainedReferenceCount = Math.max(retainedReferenceCount, stoppedExisting.referenceCount);
                    await detachStoppedNativeTunnel(key);
                }

                let started: Awaited<ReturnType<NativeSshTunnelAdapter['startLoopbackTunnel']>>;
                try {
                    started = await adapter.startLoopbackTunnel(request);
                } catch (error) {
                    const limitation = limitationForStartError(error);
                    if (limitation) {
                        store.setRuntimeLimitation(limitation);
                    }
                    throw error;
                }
                const localUrl = `http://127.0.0.1:${started.localPort}`;
                const lease: NativeSshTunnelLease = {
                    leaseId: createLeaseId(key),
                    key,
                    remoteHostId: request.remoteHostId,
                    localUrl,
                    channelMode: 'loopback-port',
                    purpose: request.purpose,
                    status: 'ready',
                    startedAt: nowIso(),
                };
                const probeResult = await runBoundedProbe(localUrl);
                if (!probeResult.ok) {
                    const limitation = limitationForProbeResult(probeResult);
                    if (limitation) {
                        store.setRuntimeLimitation(limitation);
                    }
                    const failedLease = {
                        ...lease,
                        status: 'failed' as const,
                    };
                    store.put(key, {
                        lease: failedLease,
                        nativeTunnelId: started.nativeTunnelId,
                        referenceCount: retainedReferenceCount + (inFlightByKey.get(key)?.referenceCount ?? 1),
                    });
                    try {
                        await adapter.stopLoopbackTunnel(started.nativeTunnelId);
                        store.deleteByKey(key);
                    } catch (error) {
                        store.updateStatus(failedLease.leaseId, 'failed');
                        throw error;
                    }
                    throw new Error(`native_ssh_tunnel_probe_failed:${probeResult.reason}`);
                }
                for (const reason of nativeSshRuntimeErrorLimitationReasons()) {
                    store.clearRuntimeLimitation(reason);
                }
                store.put(key, {
                    lease,
                    nativeTunnelId: started.nativeTunnelId,
                    referenceCount: retainedReferenceCount + (inFlightByKey.get(key)?.referenceCount ?? 1),
                });
                return lease;
            })();

            inFlightByKey.set(key, {
                promise: startPromise,
                referenceCount: 1,
            });
            try {
                return await startPromise;
            } finally {
                inFlightByKey.delete(key);
            }
        },
        listTunnels() {
            return store.snapshot();
        },
        async releaseTunnel(leaseId) {
            const release = store.releaseByLeaseId(leaseId);
            if (release?.released && release.stored.nativeTunnelId) {
                try {
                    await adapter.stopLoopbackTunnel(release.stored.nativeTunnelId);
                    store.removeReleasedLease(leaseId);
                } catch (error) {
                    store.updateStatus(leaseId, 'failed');
                    throw error;
                }
                return;
            }
            if (release?.released) {
                store.removeReleasedLease(leaseId);
            }
        },
        markSuspended() {
            store.markSuspended();
        },
        async markForeground() {
            store.markForeground();
            for (const lease of store.snapshot().leases) {
                if (!lease.localUrl) continue;
                const result = await runBoundedProbe(lease.localUrl);
                store.updateStatus(lease.leaseId, result.ok ? 'ready' : 'failed');
                if (!result.ok) {
                    const limitation = limitationForProbeResult(result);
                    if (limitation) {
                        store.setRuntimeLimitation(limitation);
                    }
                    await detachStoppedNativeTunnel(lease.key);
                } else {
                    store.clearRuntimeLimitation('network-captive-portal');
                }
            }
        },
    };
}

export { buildNativeSshTunnelKey };
