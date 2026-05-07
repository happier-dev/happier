import type { AccessEndpoint } from '../model';
import type { AccessChannelDirection, AccessChannelKind } from './model';

export function classifyAccessChannelKind(endpoint: AccessEndpoint): AccessChannelKind {
    switch (endpoint.source) {
        case 'relay-access':
            return 'relay-access-provider';
        case 'ssh-tunnel-desktop':
            return 'ssh-tunnel-desktop';
        case 'ssh-tunnel-native':
            return 'ssh-tunnel-native';
        case 'server-profile':
        case 'local-runtime':
            return 'server-profile-url';
        case 'peer-mediation':
            return 'peer-mediation';
        case 'remote-host':
        case 'user':
        default:
            return 'manual-url';
    }
}

export function classifyAccessChannelDirection(kind: AccessChannelKind): AccessChannelDirection {
    return kind === 'ssh-tunnel-desktop' || kind === 'ssh-tunnel-native'
        ? 'reach-remote-server-from-this-device'
        : 'make-current-server-reachable';
}
