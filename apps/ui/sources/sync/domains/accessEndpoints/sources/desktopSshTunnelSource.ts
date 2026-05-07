import type { SshTunnelSnapshot, SshTunnelStatus } from '@happier-dev/protocol';

import type { AccessEndpoint, AccessEndpointStatus } from '../model';
import { createScopedAccessEndpointRemediationAction } from '../remediation';
import {
    deriveAccessEndpointWsBaseUrl,
    normalizeAccessEndpointHttpBaseUrl,
} from '../classify';

export type SshTunnelAccessEndpointInput = SshTunnelSnapshot;

function toAccessEndpointStatus(status: SshTunnelStatus): AccessEndpointStatus {
    switch (status) {
        case 'available':
            return 'available';
        case 'needs-auth':
            return 'needs-auth';
        case 'unavailable':
            return 'unavailable';
        case 'starting':
        case 'unknown':
        default:
            return 'unknown';
    }
}

function buildSshTunnelRemediationActions(snapshot: SshTunnelAccessEndpointInput) {
    if (snapshot.status === 'needs-auth') {
        return [];
    }

    return [createScopedAccessEndpointRemediationAction({
        id: `ssh-tunnel:${snapshot.tunnelKey}:stop`,
        ownerSurface: 'sshTunnel.stop',
        payload: { tunnelKey: snapshot.tunnelKey },
    })];
}

export function buildSshTunnelAccessEndpoints(params: Readonly<{
    snapshots: readonly SshTunnelAccessEndpointInput[];
}>): readonly AccessEndpoint[] {
    const endpoints: AccessEndpoint[] = [];

    for (const snapshot of params.snapshots) {
        const httpBaseUrl = normalizeAccessEndpointHttpBaseUrl(snapshot.httpBaseUrl);
        if (!httpBaseUrl) continue;

        const wsBaseUrl = normalizeAccessEndpointHttpBaseUrl(snapshot.wsBaseUrl) ?? deriveAccessEndpointWsBaseUrl(httpBaseUrl);
        endpoints.push({
            id: `ssh-tunnel:${snapshot.tunnelKey}`,
            label: 'settings.accessEndpoints.kind.ssh-tunnel-desktop',
            source: 'ssh-tunnel-desktop',
            reachability: 'loopback',
            hostedHttpsCompatibility: 'not-applicable',
            durability: 'session',
            status: toAccessEndpointStatus(snapshot.status),
            httpBaseUrl,
            ...(wsBaseUrl ? { wsBaseUrl } : {}),
            diagnostics: [{
                id: 'ssh-tunnel.local-device-only',
                severity: 'info',
                message: 'accessEndpoints.sshTunnel.localDeviceOnly',
                detail: 'accessEndpoints.sshTunnel.localDeviceOnlyDetail',
            }],
            remediationActions: buildSshTunnelRemediationActions(snapshot),
        });
    }

    return endpoints;
}
