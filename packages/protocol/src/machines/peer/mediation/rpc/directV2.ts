import { z } from 'zod';

import { SignedDirectRouteGrantV2Schema } from '../directRouteGrantV2.js';
import { PeerRouteEphemeralProofV2Schema } from '../ephemeralPeerRouteProofV2.js';
import { DirectPeerRouteKindV1Schema } from '../routeKind.js';
import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';
import { PeerMachineRpcCommandReceiptRequestV1Schema, PeerMachineRpcCommandReceiptSuccessV1Schema } from './commandReceiptV1.js';
import { PeerMachineRpcDirectFallbackReasonCodeV1Schema } from './directV1.js';

export const PEER_MACHINE_RPC_DIRECT_PATH_V2 = '/peer-mediation/v2/rpc' as const;

export const PeerMachineRpcDirectRequestV2Schema = z.object({
  v: z.literal(2),
  requestId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
  grant: SignedDirectRouteGrantV2Schema,
  proof: PeerRouteEphemeralProofV2Schema,
  routeKind: DirectPeerRouteKindV1Schema,
  flowKind: z.literal('machine_rpc'),
  endpointFingerprint: z.string().min(1),
  commandReceipt: PeerMachineRpcCommandReceiptRequestV1Schema.optional(),
}).strict();

export const PeerMachineRpcDirectResponseV2Schema = z.discriminatedUnion('ok', [
  z.object({
    v: z.literal(2),
    ok: z.literal(true),
    receipt: z.literal(PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded),
    requestId: z.string().min(1),
    method: z.string().min(1),
    routeKind: DirectPeerRouteKindV1Schema,
    result: z.unknown(),
    commandReceipt: PeerMachineRpcCommandReceiptSuccessV1Schema.optional(),
  }).strict(),
  z.object({
    v: z.literal(2),
    ok: z.literal(false),
    receipt: z.union([
      z.literal(PEER_MEDIATION_RECEIPTS.rpcFellBackToServer),
      z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
    ]),
    requestId: z.string().min(1),
    method: z.string().min(1),
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1Schema,
  }).strict(),
]);

export type PeerMachineRpcDirectRequestV2 = z.infer<typeof PeerMachineRpcDirectRequestV2Schema>;
export type PeerMachineRpcDirectResponseV2 = z.infer<typeof PeerMachineRpcDirectResponseV2Schema>;
