import type {
    AccessEndpoint,
    AccessEndpointClientContext,
    AccessEndpointRemediationAction,
    AccessEndpointProjection,
} from './model';
import {
    buildLocalRuntimeAccessEndpoints,
    type LocalRuntimeAccessEndpointCandidate,
} from './sources/localRuntimeSource';
import {
    buildRelayAccessEndpoints,
    type RelayAccessEndpointInput,
} from './sources/relayAccessSource';
import {
    buildRemoteHostAccessEndpointRemediations,
    type RemoteHostAccessEndpointInput,
} from './sources/remoteHostSource';
import {
    buildServerProfileAccessEndpoints,
    type ServerProfileAccessEndpointInput,
} from './sources/serverProfileSource';
import {
    buildSshTunnelAccessEndpoints,
    type SshTunnelAccessEndpointInput,
} from './sources/desktopSshTunnelSource';
import {
    buildNativeSshTunnelAccessEndpoints,
    buildNativeSshTunnelDiagnostics,
    type NativeSshTunnelAccessEndpointInput,
} from './sources/nativeSshTunnelSource';

export type BuildAccessEndpointProjectionParams = Readonly<{
    clientContext?: AccessEndpointClientContext;
    serverProfiles?: readonly ServerProfileAccessEndpointInput[];
    relayAccess?: readonly RelayAccessEndpointInput[];
    localRuntimeCandidates?: readonly LocalRuntimeAccessEndpointCandidate[];
    remoteHosts?: readonly RemoteHostAccessEndpointInput[];
    sshTunnelSnapshots?: readonly SshTunnelAccessEndpointInput[];
    nativeSshTunnelSnapshot?: NativeSshTunnelAccessEndpointInput;
}>;

function statusRank(endpoint: AccessEndpoint): number {
    switch (endpoint.status) {
        case 'available':
            return 0;
        case 'needs-auth':
            return 1;
        case 'requires-configuration':
            return 2;
        case 'unknown':
            return 3;
        case 'unavailable':
            return 4;
        default:
            return 5;
    }
}

function durabilityRank(endpoint: AccessEndpoint): number {
    switch (endpoint.durability) {
        case 'persistent':
            return 0;
        case 'session':
            return 1;
        case 'temporary':
            return 2;
        default:
            return 3;
    }
}

function hostedCompatibilityRank(endpoint: AccessEndpoint): number {
    switch (endpoint.hostedHttpsCompatibility) {
        case 'compatible':
            return 0;
        case 'requires-configuration':
            return 1;
        case 'unknown':
            return 2;
        case 'not-applicable':
            return 3;
        case 'mixed-content-blocked':
            return 4;
        default:
            return 5;
    }
}

function desktopReachabilityRank(endpoint: AccessEndpoint): number {
    switch (endpoint.reachability) {
        case 'loopback':
            return 0;
        case 'lan':
            return 1;
        case 'private-network':
            return 2;
        case 'public':
            return 3;
        default:
            return 4;
    }
}

function hostedReachabilityRank(endpoint: AccessEndpoint): number {
    switch (endpoint.reachability) {
        case 'public':
            return 0;
        case 'private-network':
            return 1;
        case 'lan':
            return 2;
        case 'loopback':
            return 3;
        default:
            return 4;
    }
}

export function sortAccessEndpoints(
    endpoints: readonly AccessEndpoint[],
    clientContext: AccessEndpointClientContext = 'desktop',
): readonly AccessEndpoint[] {
    return [...endpoints].sort((left, right) => {
        const rankDelta = statusRank(left) - statusRank(right);
        if (rankDelta !== 0) return rankDelta;

        if (clientContext === 'hosted-https-web') {
            const compatibilityDelta = hostedCompatibilityRank(left) - hostedCompatibilityRank(right);
            if (compatibilityDelta !== 0) return compatibilityDelta;
            const reachabilityDelta = hostedReachabilityRank(left) - hostedReachabilityRank(right);
            if (reachabilityDelta !== 0) return reachabilityDelta;
        } else {
            const reachabilityDelta = desktopReachabilityRank(left) - desktopReachabilityRank(right);
            if (reachabilityDelta !== 0) return reachabilityDelta;
        }

        const durabilityDelta = durabilityRank(left) - durabilityRank(right);
        if (durabilityDelta !== 0) return durabilityDelta;
        return left.id.localeCompare(right.id);
    });
}

export function buildAccessEndpointProjection(
    params: BuildAccessEndpointProjectionParams,
): AccessEndpointProjection {
    const clientContext = params.clientContext ?? 'desktop';
    const endpoints = [
        ...buildServerProfileAccessEndpoints({
            profiles: params.serverProfiles ?? [],
            clientContext,
        }),
        ...buildRelayAccessEndpoints({
            relayAccess: params.relayAccess ?? [],
            clientContext,
        }),
        ...buildLocalRuntimeAccessEndpoints({
            candidates: params.localRuntimeCandidates ?? [],
            clientContext,
        }),
        ...buildSshTunnelAccessEndpoints({
            snapshots: params.sshTunnelSnapshots ?? [],
        }),
        ...buildNativeSshTunnelAccessEndpoints({
            snapshot: params.nativeSshTunnelSnapshot,
        }),
    ];
    const endpointRemediationActions = endpoints.flatMap((endpoint): readonly AccessEndpointRemediationAction[] => (
        endpoint.remediationActions ?? []
    ));
    return {
        endpoints: sortAccessEndpoints(endpoints, clientContext),
        remediationActions: [
            ...buildRemoteHostAccessEndpointRemediations(params.remoteHosts ?? []),
            ...endpointRemediationActions,
        ],
        diagnostics: buildNativeSshTunnelDiagnostics({
            snapshot: params.nativeSshTunnelSnapshot,
        }),
    };
}
