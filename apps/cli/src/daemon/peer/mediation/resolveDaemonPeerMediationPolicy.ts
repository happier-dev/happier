import { parseOptionalBooleanEnv, type PeerFlowKindV1, type DirectPeerRouteKindV1 } from '@happier-dev/protocol';

export type ResolveDaemonPeerMediationPolicyInput = Readonly<{
    env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
}>;

const FLOW_ENV_KEYS: Readonly<Record<PeerFlowKindV1, string>> = Object.freeze({
    bounded_transfer: 'HAPPIER_DAEMON_PEER_MEDIATION_TRANSFER_DIRECT_ENABLED',
    tcp_tunnel: 'HAPPIER_DAEMON_PEER_MEDIATION_TUNNEL_DIRECT_ENABLED',
    voice_media: 'HAPPIER_DAEMON_PEER_MEDIATION_TUNNEL_DIRECT_ENABLED',
    live_stream: 'HAPPIER_DAEMON_PEER_MEDIATION_LIVE_STREAM_DIRECT_ENABLED',
    machine_rpc: 'HAPPIER_DAEMON_PEER_MEDIATION_RPC_DIRECT_ENABLED',
});

const ROUTE_ENV_KEYS: Readonly<Record<DirectPeerRouteKindV1, string>> = Object.freeze({
    loopback_direct: 'HAPPIER_DAEMON_PEER_MEDIATION_LOOPBACK_DIRECT_ENABLED',
    lan_direct: 'HAPPIER_DAEMON_PEER_MEDIATION_LAN_DIRECT_ENABLED',
    tailscale_serve_direct: 'HAPPIER_DAEMON_PEER_MEDIATION_TAILSCALE_SERVE_DIRECT_ENABLED',
});

function readEnv(env: ResolveDaemonPeerMediationPolicyInput['env'], key: string): string | undefined {
    return env[key];
}

export function resolveDaemonPeerMediationPolicy(
    input: ResolveDaemonPeerMediationPolicyInput,
): boolean | null {
    const route = parseOptionalBooleanEnv(readEnv(input.env, ROUTE_ENV_KEYS[input.routeKind]));
    if (route !== null) return route;

    const flow = parseOptionalBooleanEnv(readEnv(input.env, FLOW_ENV_KEYS[input.flowKind]));
    if (flow !== null) return flow;

    return parseOptionalBooleanEnv(readEnv(input.env, 'HAPPIER_DAEMON_PEER_MEDIATION_DIRECT_ENABLED'));
}
