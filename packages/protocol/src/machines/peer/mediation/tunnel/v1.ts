import { z } from 'zod';

import { decodeBase64 } from '../../../../crypto/base64.js';
import { PeerRouteNonceProofV1Schema, type PeerRouteNonceProofV1 } from '../directRouteGrantNonceV1.js';
import { SignedDirectRouteGrantV1Schema, type SignedDirectRouteGrantV1 } from '../directRouteGrantV1.js';
import {
  PeerTcpTunnelRelayAuthorizationSchema,
  type PeerTcpTunnelRelayAuthorization,
  type PeerTcpTunnelRelayAuthorizationV1,
} from './authorization.js';
import { PeerTcpTunnelEncodingSchema } from './encoding.js';

export const PEER_TCP_TUNNEL_OPEN_PATH = '/peer-mediation/v1/tunnel/open' as const;
export const PEER_TCP_TUNNEL_STREAM_PATH = '/peer-mediation/v1/tunnel/stream' as const;
export const PEER_TCP_TUNNEL_ENCODING_V1 = 'json_base64_v1' as const;

export const PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES = 1024 * 1024;
export const PEER_TCP_TUNNEL_MIN_WINDOW_BYTES = 64 * 1024;
export const PEER_TCP_TUNNEL_MAX_WINDOW_BYTES = 8 * 1024 * 1024;
export const PEER_TCP_TUNNEL_ACK_AFTER_BYTES = 64 * 1024;
export const PEER_TCP_TUNNEL_ACK_AFTER_MS = 100;
export const PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
export const PEER_TCP_TUNNEL_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const PeerTcpTunnelDirectionV1Schema = z.enum(['client_to_daemon', 'daemon_to_client']);
export type PeerTcpTunnelDirectionV1 = z.infer<typeof PeerTcpTunnelDirectionV1Schema>;

export const PeerTcpTunnelRouteKindV1Schema = z.enum(['loopback_direct', 'server_relay']);
export type PeerTcpTunnelRouteKindV1 = z.infer<typeof PeerTcpTunnelRouteKindV1Schema>;

export const PeerTcpTunnelDestinationV1Schema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535),
});
export type PeerTcpTunnelDestinationV1 = z.infer<typeof PeerTcpTunnelDestinationV1Schema>;

export const PeerTcpTunnelOpenV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('open'),
    tunnelId: z.string().min(1),
    targetMachineId: z.string().min(1),
    routeKind: PeerTcpTunnelRouteKindV1Schema,
    destination: PeerTcpTunnelDestinationV1Schema,
    grant: SignedDirectRouteGrantV1Schema.optional(),
    nonceProof: PeerRouteNonceProofV1Schema.optional(),
    relayAuthorization: PeerTcpTunnelRelayAuthorizationSchema.optional(),
    supportedEncodings: z.array(PeerTcpTunnelEncodingSchema).min(1).optional(),
    selectedEncoding: PeerTcpTunnelEncodingSchema.optional(),
    allowV1Fallback: z.boolean().optional(),
  })
  .superRefine((open, ctx) => {
    if (open.routeKind !== 'server_relay') {
      if (open.relayAuthorization !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relayAuthorization'],
          message: 'TCP tunnel relay authorization is only valid for server relay opens',
        });
      }
      return;
    }

    const authorization = open.relayAuthorization;
    if (authorization === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relayAuthorization'],
        message: 'TCP tunnel server relay opens require relay authorization',
      });
      return;
    }

    const payload = authorization.payload;
    if (payload.targetMachineId !== open.targetMachineId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relayAuthorization', 'payload', 'targetMachineId'],
        message: 'TCP tunnel relay authorization target machine does not match the open frame',
      });
    }
    if (payload.tunnelId !== open.tunnelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relayAuthorization', 'payload', 'tunnelId'],
        message: 'TCP tunnel relay authorization tunnel does not match the open frame',
      });
    }
    if (payload.destination.host !== open.destination.host || payload.destination.port !== open.destination.port) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relayAuthorization', 'payload', 'destination'],
        message: 'TCP tunnel relay authorization destination does not match the open frame',
      });
    }
  });
export type PeerTcpTunnelOpenV1 = z.infer<typeof PeerTcpTunnelOpenV1Schema>;

export const PeerTcpTunnelOpenResponseV1Schema = z.object({
  v: z.literal(1),
  tunnelId: z.string().min(1),
  streamPath: z.literal(PEER_TCP_TUNNEL_STREAM_PATH),
  encoding: PeerTcpTunnelEncodingSchema,
  initialWindowBytes: z.number().int().min(PEER_TCP_TUNNEL_MIN_WINDOW_BYTES).max(PEER_TCP_TUNNEL_MAX_WINDOW_BYTES),
  maxFrameBytes: z.number().int().positive().max(PEER_TCP_TUNNEL_MAX_FRAME_BYTES),
});
export type PeerTcpTunnelOpenResponseV1 = z.infer<typeof PeerTcpTunnelOpenResponseV1Schema>;

export const PeerTcpTunnelOpenFrameV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('open'),
  open: PeerTcpTunnelOpenV1Schema,
});
export type PeerTcpTunnelOpenFrameV1 = z.infer<typeof PeerTcpTunnelOpenFrameV1Schema>;

export const PeerTcpTunnelDataFrameV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('data'),
  tunnelId: z.string().min(1),
  direction: PeerTcpTunnelDirectionV1Schema,
  sequence: z.number().int().nonnegative(),
  payloadBase64: z.string().min(1),
});
export type PeerTcpTunnelDataFrameV1 = z.infer<typeof PeerTcpTunnelDataFrameV1Schema>;

export const PeerTcpTunnelAckFrameV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('ack'),
  tunnelId: z.string().min(1),
  direction: PeerTcpTunnelDirectionV1Schema,
  nextSequence: z.number().int().nonnegative(),
  windowBytes: z.number().int().nonnegative().max(PEER_TCP_TUNNEL_MAX_WINDOW_BYTES),
});
export type PeerTcpTunnelAckFrameV1 = z.infer<typeof PeerTcpTunnelAckFrameV1Schema>;

export const PeerTcpTunnelCloseFrameV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('close'),
  tunnelId: z.string().min(1),
  direction: PeerTcpTunnelDirectionV1Schema.optional(),
  halfClose: z.boolean().optional().default(false),
  reasonCode: z.string().min(1),
});
export type PeerTcpTunnelCloseFrameV1 = z.infer<typeof PeerTcpTunnelCloseFrameV1Schema>;

export const PeerTcpTunnelAbortFrameV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('abort'),
  tunnelId: z.string().min(1),
  reasonCode: z.string().min(1),
});
export type PeerTcpTunnelAbortFrameV1 = z.infer<typeof PeerTcpTunnelAbortFrameV1Schema>;

export const PeerTcpTunnelFrameV1Schema = z.discriminatedUnion('kind', [
  PeerTcpTunnelOpenFrameV1Schema,
  PeerTcpTunnelDataFrameV1Schema,
  PeerTcpTunnelAckFrameV1Schema,
  PeerTcpTunnelCloseFrameV1Schema,
  PeerTcpTunnelAbortFrameV1Schema,
]);
export type PeerTcpTunnelFrameV1 = z.infer<typeof PeerTcpTunnelFrameV1Schema>;

export type ValidatePeerTcpTunnelDataFrameCapsResult =
  | Readonly<{ ok: true; decodedBytes: number }>
  | Readonly<{
      ok: false;
      reasonCode: 'frame_invalid' | 'encoded_frame_too_large' | 'payload_base64_invalid' | 'decoded_payload_too_large';
    }>;

export function validatePeerTcpTunnelDataFrameCaps(input: Readonly<{
  frame: unknown;
  maxEncodedFrameBytes: number;
  maxDecodedPayloadBytes: number;
}>): ValidatePeerTcpTunnelDataFrameCapsResult {
  const parsed = PeerTcpTunnelDataFrameV1Schema.safeParse(input.frame);
  if (!parsed.success) return { ok: false, reasonCode: 'frame_invalid' };

  const encodedFrameBytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
  if (encodedFrameBytes > input.maxEncodedFrameBytes) {
    return { ok: false, reasonCode: 'encoded_frame_too_large' };
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(parsed.data.payloadBase64);
  } catch {
    return { ok: false, reasonCode: 'payload_base64_invalid' };
  }

  if (decoded.byteLength > input.maxDecodedPayloadBytes) {
    return { ok: false, reasonCode: 'decoded_payload_too_large' };
  }

  return { ok: true, decodedBytes: decoded.byteLength };
}

export type PeerTcpTunnelOpenGrantV1 = SignedDirectRouteGrantV1;
export type PeerTcpTunnelOpenNonceProofV1 = PeerRouteNonceProofV1;
export type PeerTcpTunnelOpenRelayAuthorizationV1 = PeerTcpTunnelRelayAuthorizationV1;
export type PeerTcpTunnelOpenRelayAuthorization = PeerTcpTunnelRelayAuthorization;
