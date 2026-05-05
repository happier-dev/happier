import { z } from 'zod';

export const DEFAULT_MACHINE_TUNNEL_DIRECT_ALLOWED_PORTS: readonly number[] = Object.freeze([]);
export const DEFAULT_MACHINE_TUNNEL_MAX_IDLE_MS = 30_000;
export const DEFAULT_MACHINE_TUNNEL_MAX_DURATION_MS = 300_000;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET = 8;
export const DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES = 64 * 1024;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_ACTIVE_TUNNELS_PER_SOCKET_HARD_MAX = 128;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_FRAME_BYTES_HARD_MAX = 8 * 1024 * 1024;
export const MACHINE_TUNNEL_SERVER_ROUTED_MAX_BYTES_HARD_MAX = 8 * 1024 * 1024 * 1024;

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
