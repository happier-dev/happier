import { z } from 'zod';

export const DIRECT_ROUTE_GRANT_TTL_MS = Object.freeze({
  boundedTransferSingle: 10 * 60_000,
  boundedTransferScopedDefault: 10 * 60_000,
  boundedTransferScopedMin: 5 * 60_000,
  boundedTransferScopedMax: 30 * 60_000,
  loopbackMachineRpcDefault: 5 * 60_000,
  loopbackMachineRpcMin: 1 * 60_000,
  loopbackMachineRpcMax: 15 * 60_000,
  lanTailscaleMachineRpcMin: 1 * 60_000,
  lanTailscaleMachineRpcMax: 5 * 60_000,
  directTcpTunnel: 15 * 60_000,
  serverRelayedTcpTunnel: 5 * 60_000,
  directLiveStream: 10 * 60_000,
  serverRelayedLiveStream: 5 * 60_000,
} as const);

export const DirectRouteGrantCachePolicyV1Schema = z.object({
  ttlMs: z.number().int().positive(),
  renewable: z.boolean().default(false),
});

export type DirectRouteGrantCachePolicyV1 = z.infer<typeof DirectRouteGrantCachePolicyV1Schema>;

export function clampDirectRouteGrantTtlMs(value: number, minMs: number, maxMs: number): number {
  if (!Number.isFinite(value)) return minMs;
  return Math.min(maxMs, Math.max(minMs, Math.floor(value)));
}
