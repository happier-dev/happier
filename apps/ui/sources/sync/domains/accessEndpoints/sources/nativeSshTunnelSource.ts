import type { NativeSshTunnelSnapshot, NativeSshTunnelStatus } from '@/sync/runtime/nativeSshTunnels/types';

import type { AccessEndpoint, AccessEndpointStatus } from '../model';
import { createScopedAccessEndpointRemediationAction } from '../remediation';
import {
    deriveAccessEndpointWsBaseUrl,
    normalizeAccessEndpointHttpBaseUrl,
} from '../classify';

export type NativeSshTunnelAccessEndpointInput = NativeSshTunnelSnapshot;

function toAccessEndpointStatus(status: NativeSshTunnelStatus): AccessEndpointStatus {
    switch (status) {
        case 'ready':
            return 'available';
        case 'degraded':
            return 'unknown';
        case 'failed':
        case 'stopped':
            return 'unavailable';
        case 'starting':
        default:
            return 'unknown';
    }
}

export function buildNativeSshTunnelAccessEndpoints(params: Readonly<{
    snapshot?: NativeSshTunnelAccessEndpointInput;
}>): readonly AccessEndpoint[] {
    if (!params.snapshot) {
        return [];
    }

    return params.snapshot.leases.flatMap((lease): AccessEndpoint[] => {
        if (lease.purpose !== 'server-http') {
            return [];
        }
        const httpBaseUrl = normalizeAccessEndpointHttpBaseUrl(lease.localUrl);
        if (!httpBaseUrl || !isLoopbackHttpUrl(httpBaseUrl)) {
            return [];
        }
        const wsBaseUrl = deriveAccessEndpointWsBaseUrl(httpBaseUrl);
        return [{
            id: `ssh-tunnel-native:${lease.remoteHostId}:${lease.key}`,
            label: 'settings.accessEndpoints.kind.ssh-tunnel-native',
            source: 'ssh-tunnel-native',
            remoteHostId: lease.remoteHostId,
            reachability: 'loopback',
            hostedHttpsCompatibility: 'not-applicable',
            durability: 'session',
            status: toAccessEndpointStatus(lease.status),
            httpBaseUrl,
            ...(wsBaseUrl ? { wsBaseUrl } : {}),
            diagnostics: [
                {
                    id: 'ssh-tunnel.native.this-device-only',
                    severity: 'info',
                    message: 'settings.accessEndpoints.limitation.this-device-only',
                    detail: 'settings.accessEndpoints.limitation.not-public-share-url',
                },
                ...params.snapshot!.platformLimitations.map((limitation) => ({
                    id: limitation.id,
                    severity: limitation.severity,
                    message: limitation.message,
                })),
            ],
            remediationActions: lease.status !== 'stopped'
                ? [createScopedAccessEndpointRemediationAction({
                    id: `ssh-tunnel-native:${lease.leaseId}:stop`,
                    ownerSurface: 'sshTunnel.stop',
                    payload: {
                        leaseId: lease.leaseId,
                        tunnelKey: lease.key,
                    },
                })]
                : [],
        }];
    });
}

function isLoopbackHttpUrl(value: string): boolean {
    try {
        const parsed = new URL(value);
        return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    } catch {
        return false;
    }
}
