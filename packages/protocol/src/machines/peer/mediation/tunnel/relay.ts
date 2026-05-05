import { z } from 'zod';

import { PeerTcpTunnelFrameV1Schema } from './v1.js';

export const PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT = 'peer:tunnel:v1' as const;

export const PeerTcpTunnelRelayParticipantV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('machine'), machineId: z.string().min(1) }),
]);
export type PeerTcpTunnelRelayParticipantV1 = z.infer<typeof PeerTcpTunnelRelayParticipantV1Schema>;

export const PeerTcpTunnelRelayEnvelopeV1Schema = z.object({
  v: z.literal(1),
  scopeUserId: z.string().min(1),
  sender: PeerTcpTunnelRelayParticipantV1Schema,
  recipient: PeerTcpTunnelRelayParticipantV1Schema,
  frame: PeerTcpTunnelFrameV1Schema,
});
export type PeerTcpTunnelRelayEnvelopeV1 = z.infer<typeof PeerTcpTunnelRelayEnvelopeV1Schema>;
