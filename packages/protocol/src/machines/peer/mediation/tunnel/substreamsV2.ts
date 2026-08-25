import { z } from 'zod';

export const PeerTcpTunnelSubstreamCapsV2Schema = z.object({
  maxConcurrentSubstreams: z.number().int().positive(),
  maxTotalSubstreams: z.number().int().positive(),
  maxBytesPerSubstream: z.number().int().positive(),
  maxAggregateBytes: z.number().int().positive(),
  maxSubstreamIdleMs: z.number().int().positive(),
  maxSessionIdleMs: z.number().int().positive(),
});
export type PeerTcpTunnelSubstreamCapsV2 = z.infer<typeof PeerTcpTunnelSubstreamCapsV2Schema>;
