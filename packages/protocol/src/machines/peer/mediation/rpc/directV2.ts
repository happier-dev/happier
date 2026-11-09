import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SignedDirectRouteGrantV2Schema } from '../directRouteGrantV2.js';
import { PeerRouteEphemeralProofV2Schema } from '../ephemeralPeerRouteProofV2.js';
import { DirectPeerRouteKindV1Schema } from '../routeKind.js';
import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';
import { PeerMachineRpcDirectFallbackReasonCodeV1Schema } from './directV1.js';

export const PEER_MACHINE_RPC_DIRECT_PATH_V2 = '/peer-mediation/v2/rpc' as const;

export const PeerMachineRpcDirectRequestV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  requestId: z.string().check(z.minLength(1)),
  method: z.string().check(z.minLength(1)),
  params: z.unknown(),
  grant: SignedDirectRouteGrantV2Schema,
  proof: PeerRouteEphemeralProofV2Schema,
  routeKind: DirectPeerRouteKindV1Schema,
  flowKind: z.literal('machine_rpc'),
  endpointFingerprint: z.string().check(z.minLength(1)),
}));

export const PeerMachineRpcDirectResponseV2Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    v: z.literal(2),
    ok: z.literal(true),
    receipt: z.literal(PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded),
    requestId: z.string().check(z.minLength(1)),
    method: z.string().check(z.minLength(1)),
    routeKind: DirectPeerRouteKindV1Schema,
    result: z.unknown(),
  }),
  z.strictObject({
    v: z.literal(2),
    ok: z.literal(false),
    receipt: z.union([
      z.literal(PEER_MEDIATION_RECEIPTS.rpcFellBackToServer),
      z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
    ]),
    requestId: z.string().check(z.minLength(1)),
    method: z.string().check(z.minLength(1)),
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1Schema,
  }),
]));

export type PeerMachineRpcDirectRequestV2 = z.infer<typeof PeerMachineRpcDirectRequestV2Schema>;
export type PeerMachineRpcDirectResponseV2 = z.infer<typeof PeerMachineRpcDirectResponseV2Schema>;
