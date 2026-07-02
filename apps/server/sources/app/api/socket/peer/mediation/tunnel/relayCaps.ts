import {
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES,
    DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
    DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING,
    DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
    MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX,
    normalizeMachineTunnelPositiveInt,
    normalizeMachineTunnelPreferredEncoding,
    normalizeMachineTunnelSupportedEncodings,
    type MachineTunnelSubstreamCapabilities,
    type PeerTcpTunnelEncoding,
} from '@happier-dev/protocol';

export type PeerTcpTunnelRelayCaps = Readonly<{
    serverRoutedEnabled: boolean;
    maxBytes: number;
    maxActiveTunnelsPerSocket: number;
    maxFrameBytes: number;
    supportedEncodings: readonly PeerTcpTunnelEncoding[];
    preferredEncoding: PeerTcpTunnelEncoding;
    allowV1Fallback: boolean;
    maxBinaryHeaderBytes: number;
    maxRawPayloadBytes: number;
    maxFramedMessageBytes: number;
    substreams: MachineTunnelSubstreamCapabilities;
    maxIdleMs: number;
    maxDurationMs: number;
    allowedPorts: readonly number[];
}>;

export function resolvePeerTcpTunnelRelayCaps(input: Partial<PeerTcpTunnelRelayCaps>): PeerTcpTunnelRelayCaps {
    const supportedEncodings = normalizeMachineTunnelSupportedEncodings(
        input.supportedEncodings ?? DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS,
    );
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
        supportedEncodings,
        preferredEncoding: normalizeMachineTunnelPreferredEncoding(
            input.preferredEncoding ?? DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING,
            supportedEncodings,
        ),
        allowV1Fallback: input.allowV1Fallback ?? DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK,
        maxBinaryHeaderBytes: normalizeMachineTunnelPositiveInt(
            input.maxBinaryHeaderBytes,
            DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES,
            { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ),
        maxRawPayloadBytes: normalizeMachineTunnelPositiveInt(
            input.maxRawPayloadBytes,
            DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
            { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ),
        maxFramedMessageBytes: normalizeMachineTunnelPositiveInt(
            input.maxFramedMessageBytes,
            DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES,
            { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX },
        ),
        substreams: {
            maxConcurrentSubstreams: normalizeMachineTunnelPositiveInt(
                input.substreams?.maxConcurrentSubstreams,
                DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS,
                { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX },
            ),
            maxTotalSubstreams: normalizeMachineTunnelPositiveInt(
                input.substreams?.maxTotalSubstreams,
                DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS,
                { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX },
            ),
            maxBytesPerSubstream: normalizeMachineTunnelPositiveInt(
                input.substreams?.maxBytesPerSubstream,
                DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM,
                { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX },
            ),
            maxAggregateBytes: normalizeMachineTunnelPositiveInt(
                input.substreams?.maxAggregateBytes,
                DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES,
                { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX },
            ),
            maxSubstreamIdleMs: normalizeMachineTunnelPositiveInt(
                input.substreams?.maxSubstreamIdleMs,
                DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS,
            ),
            maxSessionIdleMs: normalizeMachineTunnelPositiveInt(
                input.substreams?.maxSessionIdleMs,
                DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS,
            ),
        },
        maxIdleMs: normalizeMachineTunnelPositiveInt(input.maxIdleMs, DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS),
        maxDurationMs: normalizeMachineTunnelPositiveInt(input.maxDurationMs, DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS),
        allowedPorts: input.allowedPorts ?? [],
    };
}
