import type { AccessEndpoint, AccessEndpointDiagnostic } from '../model';

export type AccessChannelDirection =
    | 'make-current-server-reachable'
    | 'reach-remote-server-from-this-device';

export type AccessChannelKind =
    | 'relay-access-provider'
    | 'ssh-tunnel-desktop'
    | 'ssh-tunnel-native'
    | 'server-profile-url'
    | 'peer-mediation'
    | 'manual-url';

export type AccessChannelLimitation = Readonly<{
    id: string;
    severity: 'info' | 'warning' | 'error';
    reason:
        | 'this-device-only'
        | 'not-hosted-web-compatible'
        | 'not-public-share-url'
        | 'session-scoped'
        | 'authentication-failed'
        | 'foreground-only'
        | 'host-key-mismatch'
        | 'host-key-rejected'
        | 'host-key-untrusted'
        | 'platform-suspended'
        | 'loopback-bind-failed'
        | 'network-captive-portal'
        | 'remote-service-unreachable'
        | 'requires-auth'
        | 'requires-host-key-trust';
}>;

export type AccessChannel = Readonly<{
    id: string;
    label: string;
    direction: AccessChannelDirection;
    kind: AccessChannelKind;
    endpointIds: readonly string[];
    recommendedUse:
        | 'multi-device'
        | 'native-this-device'
        | 'hosted-web'
        | 'lan-only'
        | 'diagnostic';
    limitations: readonly AccessChannelLimitation[];
    remediationActionIds: readonly string[];
}>;

export type AccessChannelProjectionInput = Readonly<{
    endpoints: readonly AccessEndpoint[];
    /**
     * Projection-level source diagnostics (`AccessEndpointProjection.diagnostics`). Native SSH
     * runtime limitations arrive here rather than on an endpoint because the failures that matter
     * most happen before any lease — and therefore any endpoint — exists.
     */
    diagnostics?: readonly AccessEndpointDiagnostic[];
}>;
