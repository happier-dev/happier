import { z } from 'zod';

import { SignedDirectRouteGrantV2Schema } from '../directRouteGrantV2.js';
import { PeerRouteEphemeralProofV2Schema } from '../ephemeralPeerRouteProofV2.js';
import { PeerTcpTunnelEncodingSchema } from './encoding.js';
import { PeerTcpTunnelDestinationV1Schema } from './v1.js';

export const PEER_TCP_TUNNEL_OPEN_PATH_V2 = '/peer-mediation/v2/tunnel/open' as const;

export const PeerTcpTunnelOpenV2Schema = z.object({
  v: z.literal(2),
  kind: z.literal('open'),
  tunnelId: z.string().min(1),
  targetMachineId: z.string().min(1),
  routeKind: z.literal('loopback_direct'),
  destination: PeerTcpTunnelDestinationV1Schema,
  grant: SignedDirectRouteGrantV2Schema,
  proof: PeerRouteEphemeralProofV2Schema,
  supportedEncodings: z.array(PeerTcpTunnelEncodingSchema).min(1).optional(),
  selectedEncoding: PeerTcpTunnelEncodingSchema.optional(),
  allowV1Fallback: z.boolean().optional(),
}).strict();

export type PeerTcpTunnelOpenV2 = z.infer<typeof PeerTcpTunnelOpenV2Schema>;
