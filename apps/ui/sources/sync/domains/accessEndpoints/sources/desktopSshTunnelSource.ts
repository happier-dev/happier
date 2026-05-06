import type { SshTunnelSnapshot, SshTunnelStatus } from '@happier-dev/protocol';

import type { AccessEndpoint, AccessEndpointStatus } from '../accessEndpointModel';
import {
    createAccessEndpointRemediationAction,
    createScopedAccessEndpointRemediationAction,
} from '../accessEndpointRemediation';
import {
    deriveAccessEndpointWsBaseUrl,
    normalizeAccessEndpointHttpBaseUrl,
} from '../classifyAccessEndpoint';

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
    const actions = snapshot.status === 'needs-auth'
        ? [createAccessEndpointRemediationAction('sshTunnel.authenticate')]
        : [
            createScopedAccessEndpointRemediationAction({
                id: `ssh-tunnel:${snapshot.tunnelKey}:reuse`,
                ownerSurface: 'sshTunnel.reuse',
                payload: { tunnelKey: snapshot.tunnelKey },
            }),
            createScopedAccessEndpointRemediationAction({
                id: `ssh-tunnel:${snapshot.tunnelKey}:stop`,
                ownerSurface: 'sshTunnel.stop',
                payload: { tunnelKey: snapshot.tunnelKey },
            }),
        ];

    if (!snapshot.remoteHostId) {
        return actions;
    }

    return [
        ...actions,
        createScopedAccessEndpointRemediationAction({
            id: `remote-host:${snapshot.remoteHostId}:setup`,
            ownerSurface: 'remoteHost.setup',
            payload: { remoteHostId: snapshot.remoteHostId },
        }),
    ];
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
            label: `SSH tunnel ${snapshot.localPort}`,
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
