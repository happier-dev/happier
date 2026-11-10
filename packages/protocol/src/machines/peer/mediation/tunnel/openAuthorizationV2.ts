import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SignedDirectRouteGrantV2Schema } from '../directRouteGrantV2.js';
import { PeerRouteEphemeralProofV2Schema } from '../ephemeralPeerRouteProofV2.js';
import { PeerTcpTunnelEncodingSchema } from './encoding.js';
import { PeerTcpTunnelDestinationV1Schema } from './v1.js';
import { TcpTunnelServiceExportOpeningV1Schema } from '../directRouteGrantScopesV1.js';

export const PEER_TCP_TUNNEL_OPEN_PATH_V2 = '/peer-mediation/v2/tunnel/open' as const;

export const PeerTcpTunnelOpenV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  kind: z.literal('open'),
  tunnelId: z.string().check(z.minLength(1)),
  targetMachineId: z.string().check(z.minLength(1)),
  routeKind: z.enum(['loopback_direct', 'iroh_peer']),
  destination: PeerTcpTunnelDestinationV1Schema,
  serviceExport: z.optional(TcpTunnelServiceExportOpeningV1Schema),
  grant: SignedDirectRouteGrantV2Schema,
  proof: PeerRouteEphemeralProofV2Schema,
  supportedEncodings: z.optional(z.array(PeerTcpTunnelEncodingSchema).check(z.minLength(1))),
  selectedEncoding: z.optional(PeerTcpTunnelEncodingSchema),
}));

export type PeerTcpTunnelOpenV2 = z.infer<typeof PeerTcpTunnelOpenV2Schema>;
