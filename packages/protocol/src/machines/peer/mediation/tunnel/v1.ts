import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from '../../../../zodRuntimePolicy.js';

import { PeerRouteNonceProofV1Schema, type PeerRouteNonceProofV1 } from '../directRouteGrantNonceV1.js';
import { SignedDirectRouteGrantV1Schema, type SignedDirectRouteGrantV1 } from '../directRouteGrantV1.js';
import {
  PeerTcpTunnelRelayAuthorizationSchema,
  type PeerTcpTunnelRelayAuthorization,
} from './authorization.js';
import { PeerTcpTunnelEncodingSchema } from './encoding.js';

export const PEER_TCP_TUNNEL_OPEN_PATH = '/peer-mediation/v1/tunnel/open' as const;
export const PEER_TCP_TUNNEL_STREAM_PATH = '/peer-mediation/v1/tunnel/stream' as const;

export const PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES = 1024 * 1024;
export const PEER_TCP_TUNNEL_MIN_WINDOW_BYTES = 64 * 1024;
export const PEER_TCP_TUNNEL_MAX_WINDOW_BYTES = 8 * 1024 * 1024;
export const PEER_TCP_TUNNEL_ACK_AFTER_BYTES = 64 * 1024;
export const PEER_TCP_TUNNEL_ACK_AFTER_MS = 100;
export const PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
export const PEER_TCP_TUNNEL_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const PeerTcpTunnelDirectionV1Schema = lazyZodSchema(() => z.enum(['client_to_daemon', 'daemon_to_client']));
export type PeerTcpTunnelDirectionV1 = z.infer<typeof PeerTcpTunnelDirectionV1Schema>;

export const PeerTcpTunnelRouteKindV1Schema = lazyZodSchema(() => z.enum(['loopback_direct', 'server_relay']));
export type PeerTcpTunnelRouteKindV1 = z.infer<typeof PeerTcpTunnelRouteKindV1Schema>;

export const PeerTcpTunnelDestinationV1Schema = lazyZodSchema(() => z.object({
  host: z.string().check(z.trim(), z.minLength(1)),
  port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
}));
export type PeerTcpTunnelDestinationV1 = z.infer<typeof PeerTcpTunnelDestinationV1Schema>;

export const PeerTcpTunnelOpenV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    kind: z.literal('open'),
    tunnelId: z.string().check(z.minLength(1)),
    targetMachineId: z.string().check(z.minLength(1)),
    routeKind: PeerTcpTunnelRouteKindV1Schema,
    destination: z.optional(PeerTcpTunnelDestinationV1Schema),
    grant: z.optional(SignedDirectRouteGrantV1Schema),
    nonceProof: z.optional(PeerRouteNonceProofV1Schema),
    relayAuthorization: z.optional(PeerTcpTunnelRelayAuthorizationSchema),
    supportedEncodings: z.optional(z.array(PeerTcpTunnelEncodingSchema).check(z.minLength(1))),
    selectedEncoding: z.optional(PeerTcpTunnelEncodingSchema),
  }).check(z.superRefine((open, ctx) => {
    if (open.routeKind !== 'server_relay') {
      if (open.relayAuthorization !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ['relayAuthorization'],
          message: 'TCP tunnel relay authorization is only valid for server relay opens',
        });
      }
      return;
    }

    const authorization = open.relayAuthorization;
    if (authorization === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ['relayAuthorization'],
        message: 'TCP tunnel server relay opens require relay authorization',
      });
      return;
    }

    const payload = authorization.payload;
    if (payload.targetMachineId !== open.targetMachineId) {
      ctx.addIssue({
        code: "custom",
        path: ['relayAuthorization', 'payload', 'targetMachineId'],
        message: 'TCP tunnel relay authorization target machine does not match the open frame',
      });
    }
    if (payload.tunnelId !== open.tunnelId) {
      ctx.addIssue({
        code: "custom",
        path: ['relayAuthorization', 'payload', 'tunnelId'],
        message: 'TCP tunnel relay authorization tunnel does not match the open frame',
      });
    }
    if (payload.flowKind === 'provider_broker') {
      if (open.destination !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ['destination'],
          message: 'Provider broker application relay cannot carry a TCP destination',
        });
      }
      return;
    }
    if (!payload.destination || !open.destination
      || payload.destination.host !== open.destination.host || payload.destination.port !== open.destination.port) {
      ctx.addIssue({
        code: "custom",
        path: ['relayAuthorization', 'payload', 'destination'],
        message: 'TCP tunnel relay authorization destination does not match the open frame',
      });
    }
  })));
export type PeerTcpTunnelOpenV1 = z.infer<typeof PeerTcpTunnelOpenV1Schema>;

export const PeerTcpTunnelOpenResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  tunnelId: z.string().check(z.minLength(1)),
  streamPath: z.literal(PEER_TCP_TUNNEL_STREAM_PATH),
  encoding: PeerTcpTunnelEncodingSchema,
  initialWindowBytes: z.number().check(z.int(), z.minimum(PEER_TCP_TUNNEL_MIN_WINDOW_BYTES), z.maximum(PEER_TCP_TUNNEL_MAX_WINDOW_BYTES)),
  maxFrameBytes: z.number().check(z.int(), z.positive(), z.maximum(PEER_TCP_TUNNEL_MAX_FRAME_BYTES)),
}));
export type PeerTcpTunnelOpenResponseV1 = z.infer<typeof PeerTcpTunnelOpenResponseV1Schema>;

export const PeerTcpTunnelOpenFrameV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('open'),
  open: PeerTcpTunnelOpenV1Schema,
}));
export type PeerTcpTunnelOpenFrameV1 = z.infer<typeof PeerTcpTunnelOpenFrameV1Schema>;

export const PeerTcpTunnelAckFrameV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('ack'),
  tunnelId: z.string().check(z.minLength(1)),
  direction: PeerTcpTunnelDirectionV1Schema,
  nextSequence: z.number().check(z.int(), z.nonnegative()),
  windowBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(PEER_TCP_TUNNEL_MAX_WINDOW_BYTES)),
}));
export type PeerTcpTunnelAckFrameV1 = z.infer<typeof PeerTcpTunnelAckFrameV1Schema>;

export const PeerTcpTunnelCloseFrameV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('close'),
  tunnelId: z.string().check(z.minLength(1)),
  direction: z.optional(PeerTcpTunnelDirectionV1Schema),
  halfClose: z._default(z.optional(z.boolean()), false),
  reasonCode: z.string().check(z.minLength(1)),
}));
export type PeerTcpTunnelCloseFrameV1 = z.infer<typeof PeerTcpTunnelCloseFrameV1Schema>;

export const PeerTcpTunnelAbortFrameV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('abort'),
  tunnelId: z.string().check(z.minLength(1)),
  reasonCode: z.string().check(z.minLength(1)),
}));
export type PeerTcpTunnelAbortFrameV1 = z.infer<typeof PeerTcpTunnelAbortFrameV1Schema>;

export const PeerTcpTunnelFrameV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PeerTcpTunnelOpenFrameV1Schema,
  PeerTcpTunnelAckFrameV1Schema,
  PeerTcpTunnelCloseFrameV1Schema,
  PeerTcpTunnelAbortFrameV1Schema,
]));
export type PeerTcpTunnelFrameV1 = z.infer<typeof PeerTcpTunnelFrameV1Schema>;

export type PeerTcpTunnelOpenGrantV1 = SignedDirectRouteGrantV1;
export type PeerTcpTunnelOpenNonceProofV1 = PeerRouteNonceProofV1;
export type PeerTcpTunnelOpenRelayAuthorization = PeerTcpTunnelRelayAuthorization;
