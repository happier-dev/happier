import { z } from 'zod';

import { PeerRouteNonceProofV1Schema } from '../directRouteGrantNonceV1.js';
import { SignedDirectRouteGrantV1Schema } from '../directRouteGrantV1.js';
import { DirectPeerRouteKindV1Schema } from '../routeKind.js';
import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';
import { PeerMachineRpcCommandReceiptRequestV1Schema, PeerMachineRpcCommandReceiptSuccessV1Schema } from './commandReceiptV1.js';

export const PEER_MACHINE_RPC_DIRECT_PATH_V1 = '/peer-mediation/v1/rpc' as const;

export const PeerMachineRpcDirectFallbackReasonCodeV1Schema = z.enum([
  'invalid_request',
  'server_required',
  'policy_denied',
  'grant_missing',
  'grant_invalid',
  'grant_expired',
  'grant_not_yet_valid',
  'grant_revoked',
  'grant_scope_mismatch',
  'grant_idle_expired',
  'grant_bad_signature',
  'grant_unknown_key',
  'endpoint_mismatch',
  'topology_unavailable',
  'method_unclassified',
  'method_not_allowed_by_grant',
  'command_receipt_required',
  'command_receipt_rejected',
  'nonce_invalid',
  'nonce_binding_mismatch',
  'nonce_bad_signature',
  'quarantined',
  'direct_call_limit_exceeded',
  'handler_unavailable',
]);

export const PeerMachineRpcDirectRequestV1Schema = z
  .object({
    v: z.literal(1),
    requestId: z.string().min(1),
    method: z.string().min(1),
    params: z.unknown(),
    grant: SignedDirectRouteGrantV1Schema,
    nonceProof: PeerRouteNonceProofV1Schema,
    routeKind: DirectPeerRouteKindV1Schema,
    flowKind: z.literal('machine_rpc'),
    endpointFingerprint: z.string().min(1),
    commandReceipt: PeerMachineRpcCommandReceiptRequestV1Schema.optional(),
  })
  .passthrough();

export const PeerMachineRpcDirectResponseV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      v: z.literal(1),
      ok: z.literal(true),
      receipt: z.literal(PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded),
      requestId: z.string().min(1),
      method: z.string().min(1),
      routeKind: DirectPeerRouteKindV1Schema,
      result: z.unknown(),
      commandReceipt: PeerMachineRpcCommandReceiptSuccessV1Schema.optional(),
    })
    .passthrough(),
  z
    .object({
      v: z.literal(1),
      ok: z.literal(false),
      receipt: z.union([
        z.literal(PEER_MEDIATION_RECEIPTS.rpcFellBackToServer),
        z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
      ]),
      requestId: z.string().min(1),
      method: z.string().min(1),
      reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1Schema,
    })
    .passthrough(),
]);

export type PeerMachineRpcDirectFallbackReasonCodeV1 = z.infer<typeof PeerMachineRpcDirectFallbackReasonCodeV1Schema>;
export type PeerMachineRpcDirectRequestV1 = z.infer<typeof PeerMachineRpcDirectRequestV1Schema>;
export type PeerMachineRpcDirectResponseV1 = z.infer<typeof PeerMachineRpcDirectResponseV1Schema>;
