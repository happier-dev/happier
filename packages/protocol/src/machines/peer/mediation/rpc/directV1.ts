import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PeerRouteNonceProofV1Schema } from '../directRouteGrantNonceV1.js';
import { SignedDirectRouteGrantV1Schema } from '../directRouteGrantV1.js';
import { DirectPeerRouteKindV1Schema } from '../routeKind.js';
import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';

export const PEER_MACHINE_RPC_DIRECT_PATH_V1 = '/peer-mediation/v1/rpc' as const;

export const PeerMachineRpcDirectFallbackReasonCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'server_required',
  'policy_denied',
  'grant_missing',
  'grant_invalid',
  'grant_expired',
  'grant_not_yet_valid',
  'grant_revoked',
  'grant_scope_mismatch',
  'grant_bad_signature',
  'grant_unknown_key',
  'endpoint_mismatch',
  'topology_unavailable',
  'method_unclassified',
  'method_not_allowed_by_grant',
  'nonce_invalid',
  'nonce_binding_mismatch',
  'nonce_bad_signature',
  'direct_call_limit_exceeded',
  'handler_unavailable',
]));

export const PeerMachineRpcDirectRequestV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    requestId: z.string().check(z.minLength(1)),
    method: z.string().check(z.minLength(1)),
    params: z.unknown(),
    grant: SignedDirectRouteGrantV1Schema,
    nonceProof: PeerRouteNonceProofV1Schema,
    routeKind: DirectPeerRouteKindV1Schema,
    flowKind: z.literal('machine_rpc'),
    endpointFingerprint: z.string().check(z.minLength(1)),
  }));

export const PeerMachineRpcDirectResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.looseObject({
      v: z.literal(1),
      ok: z.literal(true),
      receipt: z.literal(PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded),
      requestId: z.string().check(z.minLength(1)),
      method: z.string().check(z.minLength(1)),
      routeKind: DirectPeerRouteKindV1Schema,
      result: z.unknown(),
    }),
  z.looseObject({
      v: z.literal(1),
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

export type PeerMachineRpcDirectFallbackReasonCodeV1 = z.infer<typeof PeerMachineRpcDirectFallbackReasonCodeV1Schema>;
export type PeerMachineRpcDirectRequestV1 = z.infer<typeof PeerMachineRpcDirectRequestV1Schema>;
export type PeerMachineRpcDirectResponseV1 = z.infer<typeof PeerMachineRpcDirectResponseV1Schema>;
