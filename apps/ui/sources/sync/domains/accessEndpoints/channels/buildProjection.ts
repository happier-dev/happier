import type { AccessEndpoint } from '../model';
import {
    classifyAccessChannelDirection,
    classifyAccessChannelKind,
} from './classify';
import type { AccessChannel, AccessChannelLimitation, AccessChannelProjectionInput } from './model';

function buildLimitations(endpoint: AccessEndpoint): readonly AccessChannelLimitation[] {
    if (endpoint.source === 'ssh-tunnel-native' || endpoint.source === 'ssh-tunnel-desktop') {
        const diagnosticLimitations = (endpoint.diagnostics ?? [])
            .map((diagnostic): AccessChannelLimitation | null => {
                switch (diagnostic.id) {
                    case 'native-ssh.authentication-failed':
                        return {
                            id: `${endpoint.id}:authentication-failed`,
                            severity: diagnostic.severity,
                            reason: 'authentication-failed',
                        };
                    case 'native-ssh.host-key-untrusted':
                        return {
                            id: `${endpoint.id}:host-key-untrusted`,
                            severity: diagnostic.severity,
                            reason: 'host-key-untrusted',
                        };
                    case 'native-ssh.host-key-rejected':
                        return {
                            id: `${endpoint.id}:host-key-rejected`,
                            severity: diagnostic.severity,
                            reason: 'host-key-rejected',
                        };
                    case 'native-ssh.host-key-mismatch':
                        return {
                            id: `${endpoint.id}:host-key-mismatch`,
                            severity: diagnostic.severity,
                            reason: 'host-key-mismatch',
                        };
                    case 'native-ssh.platform-suspended':
                        return {
                            id: `${endpoint.id}:platform-suspended`,
                            severity: diagnostic.severity,
                            reason: 'platform-suspended',
                        };
                    case 'native-ssh.loopback-bind-failed':
                        return {
                            id: `${endpoint.id}:loopback-bind-failed`,
                            severity: diagnostic.severity,
                            reason: 'loopback-bind-failed',
                        };
                    case 'native-ssh.network-captive-portal':
                        return {
                            id: `${endpoint.id}:network-captive-portal`,
                            severity: diagnostic.severity,
                            reason: 'network-captive-portal',
                        };
                    case 'native-ssh.remote-service-unreachable':
                        return {
                            id: `${endpoint.id}:remote-service-unreachable`,
                            severity: diagnostic.severity,
                            reason: 'remote-service-unreachable',
                        };
                    default:
                        return null;
                }
            })
            .filter((limitation): limitation is AccessChannelLimitation => limitation !== null);
        return [
            { id: `${endpoint.id}:this-device-only`, severity: 'info', reason: 'this-device-only' },
            { id: `${endpoint.id}:not-hosted-web-compatible`, severity: 'info', reason: 'not-hosted-web-compatible' },
            { id: `${endpoint.id}:not-public-share-url`, severity: 'info', reason: 'not-public-share-url' },
            { id: `${endpoint.id}:session-scoped`, severity: 'info', reason: 'session-scoped' },
            ...(endpoint.source === 'ssh-tunnel-native'
                ? [{ id: `${endpoint.id}:foreground-only`, severity: 'info' as const, reason: 'foreground-only' as const }]
                : []),
            ...diagnosticLimitations,
        ];
    }
    return endpoint.status === 'needs-auth'
        ? [{ id: `${endpoint.id}:requires-auth`, severity: 'warning', reason: 'requires-auth' }]
        : [];
}

function buildRecommendedUse(endpoint: AccessEndpoint): AccessChannel['recommendedUse'] {
    if (endpoint.source === 'ssh-tunnel-native') return 'native-this-device';
    if (endpoint.source === 'ssh-tunnel-desktop') return 'diagnostic';
    if (endpoint.hostedHttpsCompatibility === 'compatible') return 'hosted-web';
    if (endpoint.reachability === 'lan') return 'lan-only';
    if (endpoint.status !== 'available') return 'diagnostic';
    return 'multi-device';
}

function buildChannel(endpoint: AccessEndpoint): AccessChannel {
    const kind = classifyAccessChannelKind(endpoint);
    return {
        id: `access-channel:${endpoint.id}`,
        label: endpoint.label,
        direction: classifyAccessChannelDirection(kind),
        kind,
        endpointIds: [endpoint.id],
        recommendedUse: buildRecommendedUse(endpoint),
        limitations: buildLimitations(endpoint),
        remediationActionIds: (endpoint.remediationActions ?? []).map((action) => action.id),
    };
}

export function buildAccessChannelProjection(
    input: AccessChannelProjectionInput,
): readonly AccessChannel[] {
    return input.endpoints.map(buildChannel);
}
