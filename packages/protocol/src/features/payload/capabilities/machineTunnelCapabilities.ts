import { z } from 'zod';

import {
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
  PeerTcpTunnelEncodingSchema,
  type PeerTcpTunnelEncoding,
} from '../../../machines/peer/mediation/tunnel/encoding.js';

export const DEFAULT_MACHINE_TUNNEL_DIRECT_ALLOWED_PORTS: readonly number[] = Object.freeze([]);
export const DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS = 30_000;
export const DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS = 300_000;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET = 8;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES = 64 * 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS: readonly PeerTcpTunnelEncoding[] = Object.freeze([
  PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
]);
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING = PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK = true;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES = 16 * 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES = 512 * 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS = 32;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS = 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM = DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES = DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS = DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS = DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX = 128;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX = 8 * 1024 * 1024;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX = 8 * 1024 * 1024 * 1024;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX = 4096;

export function normalizeMachineTunnelPositiveInt(
  raw: unknown,
  fallback: number,
  input: Readonly<{ min?: number; max?: number }> = {},
): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  const min = input.min ?? 1;
  const max = input.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(normalized > 0 ? normalized : fallback, min), max);
}

export function normalizeMachineTunnelAllowedPorts(raw: unknown): readonly number[] {
  if (!Array.isArray(raw)) return DEFAULT_MACHINE_TUNNEL_DIRECT_ALLOWED_PORTS;
  const ports = new Set<number>();
  for (const entry of raw) {
    const value = normalizeMachineTunnelPositiveInt(entry, 0, { min: 0, max: 65_535 });
    if (value >= 1 && value <= 65_535) {
      ports.add(value);
    }
  }
  return Object.freeze([...ports].sort((a, b) => a - b));
}

export function normalizeMachineTunnelSupportedEncodings(raw: unknown): readonly PeerTcpTunnelEncoding[] {
  const candidates = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS;
  const encodings: PeerTcpTunnelEncoding[] = [];
  for (const candidate of candidates) {
    const parsed = PeerTcpTunnelEncodingSchema.safeParse(
      typeof candidate === 'string' ? candidate.trim() : candidate,
    );
    if (parsed.success && !encodings.includes(parsed.data)) {
      encodings.push(parsed.data);
    }
  }
  return Object.freeze(encodings.length > 0 ? encodings : [...DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS]);
}

export function normalizeMachineTunnelPreferredEncoding(
  raw: unknown,
  supportedEncodings: readonly PeerTcpTunnelEncoding[] = DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS,
): PeerTcpTunnelEncoding {
  const parsed = PeerTcpTunnelEncodingSchema.safeParse(typeof raw === 'string' ? raw.trim() : raw);
  if (parsed.success && supportedEncodings.includes(parsed.data)) {
    return parsed.data;
  }
  if (supportedEncodings.includes(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING)) {
    return DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING;
  }
  return supportedEncodings[0] ?? PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
}

export const MachineTunnelDirectPeerCapabilitiesSchema = z.object({
  allowedPorts: z
    .preprocess((raw) => [...normalizeMachineTunnelAllowedPorts(raw)], z.array(z.number().int().min(1).max(65_535)))
    .optional()
    .default([...DEFAULT_MACHINE_TUNNEL_DIRECT_ALLOWED_PORTS]),
  maxIdleMs: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS),
      z.number().int().positive(),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS),
  maxDurationMs: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS),
      z.number().int().positive(),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS),
});
export type MachineTunnelDirectPeerCapabilities = z.infer<typeof MachineTunnelDirectPeerCapabilitiesSchema>;

export const DEFAULT_MACHINE_TUNNEL_DIRECT_PEER_CAPABILITIES: MachineTunnelDirectPeerCapabilities = {
  allowedPorts: [...DEFAULT_MACHINE_TUNNEL_DIRECT_ALLOWED_PORTS],
  maxIdleMs: DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
  maxDurationMs: DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
};

export const MachineTunnelSubstreamCapabilitiesSchema = z.object({
  maxConcurrentSubstreams: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(
        raw,
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS,
        { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX },
      ),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS),
  maxTotalSubstreams: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(
        raw,
        DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS,
        { max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX },
      ),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAMS_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS),
  maxBytesPerSubstream: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM),
  maxAggregateBytes: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES),
  maxSubstreamIdleMs: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS),
      z.number().int().positive(),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS),
  maxSessionIdleMs: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS),
      z.number().int().positive(),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS),
});
export type MachineTunnelSubstreamCapabilities = z.infer<typeof MachineTunnelSubstreamCapabilitiesSchema>;

export const DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES: MachineTunnelSubstreamCapabilities = {
  maxConcurrentSubstreams: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_CONCURRENT_SUBSTREAMS,
  maxTotalSubstreams: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_TOTAL_SUBSTREAMS,
  maxBytesPerSubstream: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_PER_SUBSTREAM,
  maxAggregateBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_AGGREGATE_BYTES,
  maxSubstreamIdleMs: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SUBSTREAM_IDLE_MS,
  maxSessionIdleMs: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_SESSION_IDLE_MS,
};

export const MachineTunnelServerRoutedCapabilitiesSchema = z.object({
  maxBytes: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES),
  maxActiveTunnelsPerSocket: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET),
  maxFrameBytes: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES),
  supportedEncodings: z
    .preprocess((raw) => [...normalizeMachineTunnelSupportedEncodings(raw)], z.array(PeerTcpTunnelEncodingSchema))
    .optional()
    .default([...DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS]),
  preferredEncoding: z
    .preprocess((raw) => normalizeMachineTunnelPreferredEncoding(raw), PeerTcpTunnelEncodingSchema)
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING),
  allowV1Fallback: z.boolean().optional().default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK),
  maxBinaryHeaderBytes: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES),
  maxRawPayloadBytes: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES),
  maxFramedMessageBytes: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES, {
        max: MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX,
      }),
      z.number().int().positive().max(MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES),
  substreams: MachineTunnelSubstreamCapabilitiesSchema.optional().default(DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES),
  maxIdleMs: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS),
      z.number().int().positive(),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS),
  maxDurationMs: z
    .preprocess(
      (raw) => normalizeMachineTunnelPositiveInt(raw, DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS),
      z.number().int().positive(),
    )
    .optional()
    .default(DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS),
  disabledReason: z.string().min(1).optional().default('relay_disabled_by_server_policy'),
});
export type MachineTunnelServerRoutedCapabilities = z.infer<typeof MachineTunnelServerRoutedCapabilitiesSchema>;

export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_CAPABILITIES: MachineTunnelServerRoutedCapabilities = {
  maxBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES,
  maxActiveTunnelsPerSocket: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET,
  maxFrameBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES,
  supportedEncodings: [...DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_SUPPORTED_ENCODINGS],
  preferredEncoding: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_PREFERRED_ENCODING,
  allowV1Fallback: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_ALLOW_V1_FALLBACK,
  maxBinaryHeaderBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BINARY_HEADER_BYTES,
  maxRawPayloadBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
  maxFramedMessageBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAMED_MESSAGE_BYTES,
  substreams: DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
  maxIdleMs: DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS,
  maxDurationMs: DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS,
  disabledReason: 'relay_disabled_by_server_policy',
};

export const MachineTunnelCapabilitiesSchema = z.object({
  directPeer: MachineTunnelDirectPeerCapabilitiesSchema.optional().default(DEFAULT_MACHINE_TUNNEL_DIRECT_PEER_CAPABILITIES),
  serverRouted: MachineTunnelServerRoutedCapabilitiesSchema.optional().default(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_CAPABILITIES),
});
export type MachineTunnelCapabilities = z.infer<typeof MachineTunnelCapabilitiesSchema>;

export const DEFAULT_MACHINE_TUNNEL_CAPABILITIES: MachineTunnelCapabilities = {
  directPeer: DEFAULT_MACHINE_TUNNEL_DIRECT_PEER_CAPABILITIES,
  serverRouted: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_CAPABILITIES,
};
