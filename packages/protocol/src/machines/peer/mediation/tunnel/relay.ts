import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from '../../../../zodRuntimePolicy.js';

import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from './encoding.js';
import { PeerTcpTunnelFrameV1Schema } from './v1.js';

export const PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT = 'peer:tunnel:v1' as const;

export const PeerTcpTunnelRelayParticipantV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  // Optional per-tab viewer socket id (C-BRIDGE / C1). When a user participant carries its
  // socket id the relay bridge can deliver frames to that exact tab (`io.to(socketId)`) instead
  // of broadcasting to the whole-user room. Omitted preserves the legacy shared-room delivery.
  z.object({ kind: z.literal('user'), socketId: z.optional(z.string().check(z.minLength(1))) }),
  z.object({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1)) }),
]));
export type PeerTcpTunnelRelayParticipantV1 = z.infer<typeof PeerTcpTunnelRelayParticipantV1Schema>;

export const PeerTcpTunnelRelayEnvelopeV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    scopeUserId: z.string().check(z.minLength(1)),
    sender: PeerTcpTunnelRelayParticipantV1Schema,
    recipient: PeerTcpTunnelRelayParticipantV1Schema,
    frame: PeerTcpTunnelFrameV1Schema,
  }).check(z.superRefine((envelope, ctx) => {
    if (envelope.frame.kind !== 'open' || envelope.frame.open.routeKind !== 'server_relay') return;

    const authorization = envelope.frame.open.relayAuthorization;
    if (authorization === undefined) return;

    if (authorization.payload.accountId !== envelope.scopeUserId) {
      ctx.addIssue({
        code: "custom",
        path: ['frame', 'open', 'relayAuthorization', 'payload', 'accountId'],
        message: 'TCP tunnel relay authorization account does not match the relay envelope scope',
      });
    }
  })));
export type PeerTcpTunnelRelayEnvelopeV1 = z.infer<typeof PeerTcpTunnelRelayEnvelopeV1Schema>;

const Uint8ArrayPayloadSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value), z.custom<Uint8Array>(
    (value) => value instanceof Uint8Array,
    'Expected a binary tunnel frame payload',
  )));

export const PeerTcpTunnelRelayBinaryEnvelopeV2Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(2),
    scopeUserId: z.string().check(z.minLength(1)),
    sender: PeerTcpTunnelRelayParticipantV1Schema,
    recipient: PeerTcpTunnelRelayParticipantV1Schema,
    encoding: z.literal(PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2),
    frame: Uint8ArrayPayloadSchema,
  }));
export type PeerTcpTunnelRelayBinaryEnvelopeV2 = z.infer<typeof PeerTcpTunnelRelayBinaryEnvelopeV2Schema>;

export const PeerTcpTunnelRelayEnvelopeSchema = lazyZodSchema(() => z.union([
  PeerTcpTunnelRelayEnvelopeV1Schema,
  PeerTcpTunnelRelayBinaryEnvelopeV2Schema,
]));
export type PeerTcpTunnelRelayEnvelope = z.infer<typeof PeerTcpTunnelRelayEnvelopeSchema>;
