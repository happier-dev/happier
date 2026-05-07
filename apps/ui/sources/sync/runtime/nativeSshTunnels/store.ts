import { buildSshTarget, parseSshTarget } from '@happier-dev/protocol';

import type {
    NativeSshTunnelLease,
    NativeSshTunnelLimitation,
    NativeSshTunnelRequest,
    NativeSshTunnelSnapshot,
    NativeSshTunnelStatus,
} from './types';

type StoredLease = {
    lease: NativeSshTunnelLease;
    nativeTunnelId: string | null;
    referenceCount: number;
};

export function buildNativeSshTunnelKey(request: NativeSshTunnelRequest): string {
    const parsedTarget = parseSshTarget(request.sshTarget);
    return JSON.stringify({
        remoteHostId: request.remoteHostId.trim(),
        sshTarget: buildSshTarget({
            username: parsedTarget.username.trim(),
            host: parsedTarget.host.trim().toLowerCase(),
        }),
        sshPort: request.sshPort ?? 22,
        destinationHost: request.destinationHost.trim().toLowerCase(),
        destinationPort: request.destinationPort,
        purpose: request.purpose,
    });
}

export function createNativeSshTunnelStore() {
    const leasesByKey = new Map<string, StoredLease>();
    const foregroundLimitation: NativeSshTunnelLimitation = {
        id: 'native-ssh.foreground-only',
        severity: 'info',
        reason: 'foreground-only',
        message: 'settings.accessEndpoints.limitation.foreground-only',
    };
    const suspendedLimitation: NativeSshTunnelLimitation = {
        id: 'native-ssh.platform-suspended',
        severity: 'warning',
        reason: 'platform-suspended',
        message: 'settings.accessEndpoints.limitation.platform-suspended',
    };
    let suspended = false;
    const runtimeLimitationsByReason = new Map<NativeSshTunnelLimitation['reason'], NativeSshTunnelLimitation>();

    return {
        getByKey(key: string): StoredLease | null {
            return leasesByKey.get(key) ?? null;
        },
        put(key: string, stored: StoredLease): void {
            leasesByKey.set(key, stored);
        },
        retain(key: string): StoredLease | null {
            const stored = leasesByKey.get(key) ?? null;
            if (!stored) {
                return null;
            }
            const next = {
                ...stored,
                referenceCount: stored.referenceCount + 1,
            };
            leasesByKey.set(key, next);
            return next;
        },
        deleteByKey(key: string): StoredLease | null {
            const stored = leasesByKey.get(key) ?? null;
            leasesByKey.delete(key);
            return stored;
        },
        releaseByLeaseId(leaseId: string): Readonly<{ stored: StoredLease; released: boolean }> | null {
            for (const [key, stored] of leasesByKey) {
                if (stored.lease.leaseId === leaseId) {
                    if (stored.referenceCount > 1) {
                        leasesByKey.set(key, {
                            ...stored,
                            referenceCount: stored.referenceCount - 1,
                        });
                        return { stored, released: false };
                    }
                    return { stored, released: true };
                }
            }
            return null;
        },
        removeReleasedLease(leaseId: string): void {
            for (const [key, stored] of leasesByKey) {
                if (stored.lease.leaseId === leaseId) {
                    leasesByKey.delete(key);
                    return;
                }
            }
        },
        updateStatus(leaseId: string, status: NativeSshTunnelStatus): void {
            for (const [key, stored] of leasesByKey) {
                if (stored.lease.leaseId === leaseId) {
                    leasesByKey.set(key, {
                        ...stored,
                        lease: {
                            ...stored.lease,
                            status,
                        },
                    });
                }
            }
        },
        markSuspended(): void {
            suspended = true;
            for (const [key, stored] of leasesByKey) {
                leasesByKey.set(key, {
                    ...stored,
                    lease: {
                        ...stored.lease,
                        status: 'degraded',
                    },
                });
            }
        },
        markForeground(): void {
            suspended = false;
        },
        isSuspended(): boolean {
            return suspended;
        },
        setRuntimeLimitation(limitation: NativeSshTunnelLimitation): void {
            runtimeLimitationsByReason.set(limitation.reason, limitation);
        },
        clearRuntimeLimitation(reason: NativeSshTunnelLimitation['reason']): void {
            runtimeLimitationsByReason.delete(reason);
        },
        snapshot(): NativeSshTunnelSnapshot {
            return {
                leases: [...leasesByKey.values()].map((stored) => stored.lease),
                platformLimitations: [
                    foregroundLimitation,
                    ...(suspended ? [suspendedLimitation] : []),
                    ...runtimeLimitationsByReason.values(),
                ],
            };
        },
    };
}
