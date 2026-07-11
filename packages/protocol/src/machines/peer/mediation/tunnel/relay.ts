import { z } from 'zod';

import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from './encoding.js';
import { PeerTcpTunnelFrameV1Schema } from './v1.js';

export const PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT = 'peer:tunnel:v1' as const;

export const PeerTcpTunnelRelayParticipantV1Schema = z.discriminatedUnion('kind', [
  // Optional per-tab viewer socket id (C-BRIDGE / C1). When a user participant carries its
  // socket id the relay bridge can deliver frames to that exact tab (`io.to(socketId)`) instead
  // of broadcasting to the whole-user room. Omitted preserves the legacy shared-room delivery.
  z.object({ kind: z.literal('user'), socketId: z.string().min(1).optional() }),
  z.object({ kind: z.literal('machine'), machineId: z.string().min(1) }),
]);
export type PeerTcpTunnelRelayParticipantV1 = z.infer<typeof PeerTcpTunnelRelayParticipantV1Schema>;

export const PeerTcpTunnelRelayEnvelopeV1Schema = z
  .object({
    v: z.literal(1),
    scopeUserId: z.string().min(1),
    sender: PeerTcpTunnelRelayParticipantV1Schema,
    recipient: PeerTcpTunnelRelayParticipantV1Schema,
    frame: PeerTcpTunnelFrameV1Schema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.frame.kind !== 'open' || envelope.frame.open.routeKind !== 'server_relay') return;

    const authorization = envelope.frame.open.relayAuthorization;
    if (authorization === undefined) return;

    if (authorization.payload.accountId !== envelope.scopeUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['frame', 'open', 'relayAuthorization', 'payload', 'accountId'],
        message: 'TCP tunnel relay authorization account does not match the relay envelope scope',
      });
    }
  });
export type PeerTcpTunnelRelayEnvelopeV1 = z.infer<typeof PeerTcpTunnelRelayEnvelopeV1Schema>;

const Uint8ArrayPayloadSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  'Expected a binary tunnel frame payload',
);

export const PeerTcpTunnelRelayBinaryEnvelopeV2Schema = z
  .object({
    v: z.literal(2),
    scopeUserId: z.string().min(1),
    sender: PeerTcpTunnelRelayParticipantV1Schema,
    recipient: PeerTcpTunnelRelayParticipantV1Schema,
    encoding: z.literal(PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2),
    frame: Uint8ArrayPayloadSchema,
  })
  .strict();
export type PeerTcpTunnelRelayBinaryEnvelopeV2 = z.infer<typeof PeerTcpTunnelRelayBinaryEnvelopeV2Schema>;

export const PeerTcpTunnelRelayEnvelopeSchema = z.union([
  PeerTcpTunnelRelayEnvelopeV1Schema,
  PeerTcpTunnelRelayBinaryEnvelopeV2Schema,
]);
export type PeerTcpTunnelRelayEnvelope = z.infer<typeof PeerTcpTunnelRelayEnvelopeSchema>;
