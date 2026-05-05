import {
    DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
    DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
    normalizeMachineTunnelPositiveInt,
} from '@happier-dev/protocol';

export type PeerTcpTunnelRelayCaps = Readonly<{
    serverRoutedEnabled: boolean;
    maxBytes: number;
    maxActiveTunnelsPerSocket: number;
    maxFrameBytes: number;
    maxIdleMs: number;
    maxDurationMs: number;
    allowedPorts: readonly number[];
}>;

export function resolvePeerTcpTunnelRelayCaps(input: Partial<PeerTcpTunnelRelayCaps>): PeerTcpTunnelRelayCaps {
    return {
        serverRoutedEnabled: input.serverRoutedEnabled === true,
        maxBytes: normalizeMachineTunnelPositiveInt(input.maxBytes, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES, {
            max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
        }),
        maxActiveTunnelsPerSocket: normalizeMachineTunnelPositiveInt(
            input.maxActiveTunnelsPerSocket,
            DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
            { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX },
        ),
        maxFrameBytes: normalizeMachineTunnelPositiveInt(
            input.maxFrameBytes,
            DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
            { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ),
        maxIdleMs: normalizeMachineTunnelPositiveInt(input.maxIdleMs, DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS),
        maxDurationMs: normalizeMachineTunnelPositiveInt(input.maxDurationMs, DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS),
        allowedPorts: input.allowedPorts ?? [],
    };
}
