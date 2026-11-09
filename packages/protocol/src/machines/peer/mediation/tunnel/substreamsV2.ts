import { z } from 'zod/mini';

export const PeerTcpTunnelSubstreamCapsV2Schema = z.object({
  maxConcurrentSubstreams: z.optional(z.number().check(z.int(), z.positive())),
  maxTotalSubstreams: z.optional(z.number().check(z.int(), z.positive())),
  maxBytesPerSubstream: z.optional(z.number().check(z.int(), z.positive())),
  maxAggregateBytes: z.optional(z.number().check(z.int(), z.positive())),
  maxSubstreamIdleMs: z.optional(z.number().check(z.int(), z.positive())),
  maxSessionIdleMs: z.optional(z.number().check(z.int(), z.positive())),
});
export type PeerTcpTunnelSubstreamCapsV2 = z.infer<typeof PeerTcpTunnelSubstreamCapsV2Schema>;
