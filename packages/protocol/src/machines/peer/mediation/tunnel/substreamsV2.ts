import { z } from 'zod';

import { PeerTcpTunnelDestinationV1Schema, PeerTcpTunnelDirectionV1Schema } from './v1.js';

const SubstreamBaseV2Schema = z.object({
  version: z.literal(2),
  tunnelId: z.string().min(1),
  substreamId: z.string().min(1),
});

export const PeerTcpTunnelSubstreamOpenFrameV2Schema = SubstreamBaseV2Schema.extend({
  kind: z.literal('open'),
  destination: PeerTcpTunnelDestinationV1Schema,
});
export type PeerTcpTunnelSubstreamOpenFrameV2 = z.infer<typeof PeerTcpTunnelSubstreamOpenFrameV2Schema>;

export const PeerTcpTunnelSubstreamDataFrameV2Schema = SubstreamBaseV2Schema.extend({
  kind: z.literal('data'),
  direction: PeerTcpTunnelDirectionV1Schema,
  sequence: z.number().int().nonnegative(),
  payloadLength: z.number().int().nonnegative(),
});
export type PeerTcpTunnelSubstreamDataFrameV2 = z.infer<typeof PeerTcpTunnelSubstreamDataFrameV2Schema>;

export const PeerTcpTunnelSubstreamAckFrameV2Schema = SubstreamBaseV2Schema.extend({
  kind: z.literal('ack'),
  direction: PeerTcpTunnelDirectionV1Schema,
  nextSequence: z.number().int().nonnegative(),
  windowBytes: z.number().int().nonnegative(),
});
export type PeerTcpTunnelSubstreamAckFrameV2 = z.infer<typeof PeerTcpTunnelSubstreamAckFrameV2Schema>;

export const PeerTcpTunnelSubstreamCloseFrameV2Schema = SubstreamBaseV2Schema.extend({
  kind: z.literal('close'),
  direction: PeerTcpTunnelDirectionV1Schema.optional(),
  halfClose: z.boolean().optional().default(false),
  reasonCode: z.string().min(1),
});
export type PeerTcpTunnelSubstreamCloseFrameV2 = z.infer<typeof PeerTcpTunnelSubstreamCloseFrameV2Schema>;

export const PeerTcpTunnelSubstreamAbortFrameV2Schema = SubstreamBaseV2Schema.extend({
  kind: z.literal('abort'),
  reasonCode: z.string().min(1),
});
export type PeerTcpTunnelSubstreamAbortFrameV2 = z.infer<typeof PeerTcpTunnelSubstreamAbortFrameV2Schema>;

export const PeerTcpTunnelSubstreamFrameV2Schema = z.discriminatedUnion('kind', [
  PeerTcpTunnelSubstreamOpenFrameV2Schema,
  PeerTcpTunnelSubstreamDataFrameV2Schema,
  PeerTcpTunnelSubstreamAckFrameV2Schema,
  PeerTcpTunnelSubstreamCloseFrameV2Schema,
  PeerTcpTunnelSubstreamAbortFrameV2Schema,
]);
export type PeerTcpTunnelSubstreamFrameV2 = z.infer<typeof PeerTcpTunnelSubstreamFrameV2Schema>;

export const PeerTcpTunnelSubstreamCapsV2Schema = z.object({
  maxConcurrentSubstreams: z.number().int().positive(),
  maxTotalSubstreams: z.number().int().positive(),
  maxBytesPerSubstream: z.number().int().positive(),
  maxAggregateBytes: z.number().int().positive(),
  maxSubstreamIdleMs: z.number().int().positive(),
  maxSessionIdleMs: z.number().int().positive(),
});
export type PeerTcpTunnelSubstreamCapsV2 = z.infer<typeof PeerTcpTunnelSubstreamCapsV2Schema>;
