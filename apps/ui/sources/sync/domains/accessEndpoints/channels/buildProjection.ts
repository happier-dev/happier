import type { AccessEndpoint, AccessEndpointDiagnostic } from '../model';
import {
    classifyAccessChannelDirection,
    classifyAccessChannelKind,
} from './classify';
import type { AccessChannel, AccessChannelLimitation, AccessChannelProjectionInput } from './model';

/**
 * Native SSH runtime diagnostics, keyed by the id the supervisor stamps on them
 * (`native-ssh.<reason>`). The ambient `foreground-only` note is not listed: every native channel
 * already carries it as a static limitation.
 */
const NATIVE_DIAGNOSTIC_LIMITATION_REASONS = Object.freeze({
    'native-ssh.authentication-failed': 'authentication-failed',
    'native-ssh.host-key-untrusted': 'host-key-untrusted',
    'native-ssh.host-key-rejected': 'host-key-rejected',
    'native-ssh.host-key-mismatch': 'host-key-mismatch',
    'native-ssh.platform-suspended': 'platform-suspended',
    'native-ssh.loopback-bind-failed': 'loopback-bind-failed',
    'native-ssh.network-captive-portal': 'network-captive-portal',
    'native-ssh.remote-service-unreachable': 'remote-service-unreachable',
} as const satisfies Readonly<Record<string, AccessChannelLimitation['reason']>>);

function toNativeLimitations(
    diagnostics: readonly AccessEndpointDiagnostic[],
    idPrefix: string,
): readonly AccessChannelLimitation[] {
    return diagnostics.flatMap((diagnostic): AccessChannelLimitation[] => {
        const reason = NATIVE_DIAGNOSTIC_LIMITATION_REASONS[
            diagnostic.id as keyof typeof NATIVE_DIAGNOSTIC_LIMITATION_REASONS
        ];
        return reason
            ? [{ id: `${idPrefix}:${reason}`, severity: diagnostic.severity, reason }]
            : [];
    });
}

function buildLimitations(
    endpoint: AccessEndpoint,
    projectionDiagnostics: readonly AccessEndpointDiagnostic[],
): readonly AccessChannelLimitation[] {
    if (endpoint.source === 'ssh-tunnel-native' || endpoint.source === 'ssh-tunnel-desktop') {
        return [
            { id: `${endpoint.id}:this-device-only`, severity: 'info', reason: 'this-device-only' },
            { id: `${endpoint.id}:not-hosted-web-compatible`, severity: 'info', reason: 'not-hosted-web-compatible' },
            { id: `${endpoint.id}:not-public-share-url`, severity: 'info', reason: 'not-public-share-url' },
            { id: `${endpoint.id}:session-scoped`, severity: 'info', reason: 'session-scoped' },
            ...(endpoint.source === 'ssh-tunnel-native'
                ? [
                    { id: `${endpoint.id}:foreground-only`, severity: 'info' as const, reason: 'foreground-only' as const },
                    ...toNativeLimitations(projectionDiagnostics, endpoint.id),
                ]
                : []),
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

function buildChannel(
    endpoint: AccessEndpoint,
    projectionDiagnostics: readonly AccessEndpointDiagnostic[],
): AccessChannel {
    const kind = classifyAccessChannelKind(endpoint);
    return {
        id: `access-channel:${endpoint.id}`,
        label: endpoint.label,
        direction: classifyAccessChannelDirection(kind),
        kind,
        endpointIds: [endpoint.id],
        recommendedUse: buildRecommendedUse(endpoint),
        limitations: buildLimitations(endpoint, projectionDiagnostics),
        remediationActionIds: (endpoint.remediationActions ?? []).map((action) => action.id),
    };
}

/**
 * The native SSH channel exists as a capability even when it has no lease: authentication and
 * host-key failures happen before a tunnel is ever established, so the only way the user can see
 * why their phone cannot reach the host is an endpoint-less channel carrying those limitations.
 * `AccessChannel.endpointIds` is already plural and no renderer reads it.
 */
function buildEndpointlessNativeChannel(
    limitations: readonly AccessChannelLimitation[],
): AccessChannel {
    return {
        id: 'access-channel:ssh-tunnel-native',
        label: 'settings.accessEndpoints.kind.ssh-tunnel-native',
        direction: classifyAccessChannelDirection('ssh-tunnel-native'),
        kind: 'ssh-tunnel-native',
        endpointIds: [],
        recommendedUse: 'native-this-device',
        limitations: [
            { id: 'ssh-tunnel-native:this-device-only', severity: 'info', reason: 'this-device-only' },
            { id: 'ssh-tunnel-native:foreground-only', severity: 'info', reason: 'foreground-only' },
            ...limitations,
        ],
        remediationActionIds: [],
    };
}

export function buildAccessChannelProjection(
    input: AccessChannelProjectionInput,
): readonly AccessChannel[] {
    const diagnostics = input.diagnostics ?? [];
    const channels = input.endpoints.map((endpoint) => buildChannel(endpoint, diagnostics));
    if (channels.some((channel) => channel.kind === 'ssh-tunnel-native')) {
        return channels;
    }
    /**
     * Only a failure warrants a channel of its own. The runtime records every start/probe failure
     * at `severity: 'error'`; the ambient `foreground-only` and `platform-suspended` notes are
     * informational states of a capability the user is not currently trying to use.
     */
    const failureLimitations = toNativeLimitations(diagnostics, 'ssh-tunnel-native')
        .filter((limitation) => limitation.severity === 'error');
    return failureLimitations.length > 0
        ? [...channels, buildEndpointlessNativeChannel(failureLimitations)]
        : channels;
}
