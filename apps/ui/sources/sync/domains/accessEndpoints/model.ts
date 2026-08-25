import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';

export type AccessEndpointSource =
    | 'server-profile'
    | 'relay-access'
    | 'remote-host'
    | 'local-runtime'
    | 'ssh-tunnel-desktop'
    | 'ssh-tunnel-native'
    | 'peer-mediation'
    | 'user';

export type AccessEndpointReachability =
    | 'loopback'
    | 'lan'
    | 'private-network'
    | 'public';

export type AccessEndpointHostedHttpsCompatibility =
    | 'compatible'
    | 'mixed-content-blocked'
    | 'requires-configuration'
    | 'not-applicable'
    | 'unknown';

export type AccessEndpointDurability =
    | 'persistent'
    | 'session'
    | 'temporary';

export type AccessEndpointStatus =
    | 'available'
    | 'unavailable'
    | 'needs-auth'
    | 'requires-configuration'
    | 'unknown';

export type AccessEndpointDiagnosticSeverity =
    | 'info'
    | 'warning'
    | 'error';

export type AccessEndpointDiagnostic = Readonly<{
    id: string;
    severity: AccessEndpointDiagnosticSeverity;
    message: string;
    detail?: string;
}>;

export type AccessEndpointRemediationOwnerSurface =
    | 'tailscale.install'
    | 'tailscale.login'
    | 'tailscale.serve.enable'
    | 'tailscale.serve.approve'
    | 'tailscale.funnel.approve'
    | 'cloudflare.configure'
    | 'serverProfile.configureShareableUrl'
    | 'remoteHost.add'
    | 'remoteHost.setup'
    | 'sshTunnel.start'
    | 'sshTunnel.reuse'
    | 'sshTunnel.stop'
    | 'sshTunnel.authenticate'
    | 'sshTunnel.trustHost';

export type AccessEndpointRemediationAction = Readonly<{
    id: string;
    label: string;
    ownerSurface: AccessEndpointRemediationOwnerSurface;
    payload?: Readonly<Record<string, unknown>>;
}>;

export type AccessEndpoint = Readonly<{
    id: string;
    label: string;
    source: AccessEndpointSource;
    providerId?: RelayAccessProviderId;
    remoteHostId?: string;
    reachability: AccessEndpointReachability;
    hostedHttpsCompatibility: AccessEndpointHostedHttpsCompatibility;
    durability: AccessEndpointDurability;
    status: AccessEndpointStatus;
    httpBaseUrl: string;
    wsBaseUrl?: string;
    diagnostics?: readonly AccessEndpointDiagnostic[];
    remediationActions?: readonly AccessEndpointRemediationAction[];
}>;

export type AccessEndpointClientContext =
    | 'hosted-https-web'
    | 'web'
    | 'desktop'
    | 'native';

export type AccessEndpointProjection = Readonly<{
    endpoints: readonly AccessEndpoint[];
    remediationActions: readonly AccessEndpointRemediationAction[];
    /**
     * Source-level conditions that exist independently of any endpoint. A native SSH tunnel whose
     * authentication or host-key check fails never produces a lease, therefore never produces an
     * endpoint — so a limitation carried only inside an endpoint is dropped in exactly the failure
     * case the user needs to see.
     */
    diagnostics: readonly AccessEndpointDiagnostic[];
}>;
