import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  IrohPeerInitiatorV2Schema,
  IrohPeerTargetV2Schema,
  SignedDirectRouteGrantV2Schema,
  type IrohPeerInitiatorV2,
} from '../../machines/peer/mediation/directRouteGrantV2.js';
import { PeerRouteEphemeralProofV2Schema } from '../../machines/peer/mediation/ephemeralPeerRouteProofV2.js';

/**
 * Canonical authenticated handshake for the Iroh `happier/machine/1` carrier (V1).
 *
 * This module is the single wire definition of the first authenticated control
 * message on a machine/1 connection (lane-06 I9). It reuses the existing signed
 * machine/peer grant and ephemeral proof material verbatim — it must never grow
 * a second bearer token, account token, signature scheme, or nonce codec.
 *
 * Wire contract: the object is strict/closed (identity, routing, and
 * authorization envelope). `initiator`/`target` are the exact relationship
 * signed in `grant.payload.iroh`. Expiry is the signed grant's `exp` only — a
 * separate expiry field would be a second, competing decision-maker.
 */

export const IROH_MACHINE_HANDSHAKE_VERSION_V1 = 1 as const;

/** Machine-carrier operation flows admitted on `happier/machine/1`. */
export const IROH_MACHINE_CARRIER_FLOWS_V1 = [
  'finite_transfer',
  'workspace_sync',
  'tcp_tunnel',
] as const;

export const IrohMachineCarrierFlowV1Schema = lazyZodSchema(() => z.enum(IROH_MACHINE_CARRIER_FLOWS_V1));

function equalInitiator(left: IrohPeerInitiatorV2, right: IrohPeerInitiatorV2): boolean {
  return left.kind === right.kind
    && left.endpointId === right.endpointId
    && (left.kind !== 'machine' || (right.kind === 'machine' && left.machineId === right.machineId));
}

const IrohMachineHandshakeCommonV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(IROH_MACHINE_HANDSHAKE_VERSION_V1),
    accountId: z.string().min(1),
    initiator: IrohPeerInitiatorV2Schema,
    target: IrohPeerTargetV2Schema,
    grant: SignedDirectRouteGrantV2Schema,
    proof: PeerRouteEphemeralProofV2Schema,
  }).strict());

export const IrohMachineHandshakeV1Schema = lazyZodSchema(() => z
  .discriminatedUnion('flow', [
    IrohMachineHandshakeCommonV1Schema.extend({
      flow: z.literal('finite_transfer'),
    }).strict(),
    IrohMachineHandshakeCommonV1Schema.extend({
      flow: z.literal('tcp_tunnel'),
    }).strict(),
    IrohMachineHandshakeCommonV1Schema.extend({
      flow: z.literal('workspace_sync'),
      operationId: z.string().min(1),
    }).strict(),
  ])
  .superRefine((handshake, ctx) => {
    const payload = handshake.grant.payload;
    const binding = payload.iroh;
    if (payload.routeKind !== 'iroh_peer' || !binding) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grant', 'payload', 'iroh'],
        message: 'Machine/1 handshakes require an iroh_peer grant binding',
      });
      return;
    }
    const equalBindings =
      handshake.accountId === payload.accountId
      && equalInitiator(handshake.initiator, binding.initiator)
      && handshake.target.machineId === binding.target.machineId
      && handshake.target.endpointId === binding.target.endpointId
      && handshake.flow === binding.operationKind;
    if (!equalBindings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grant', 'payload', 'iroh'],
        message: 'Machine/1 handshake fields must equal the signed absolute Iroh binding',
      });
    }
    if (handshake.flow !== 'workspace_sync') {
      return;
    }
    const scopeOperationId = payload.scope.kind === 'bounded_transfer'
      ? payload.scope.mode === 'single' ? payload.scope.transferId : undefined
      : payload.scope.kind === 'machine_rpc' ? payload.scope.rpcScopeId : undefined;
    if (!scopeOperationId || scopeOperationId !== handshake.operationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationId'],
        message: 'Machine/1 operationId must equal the signed single-operation grant scope id',
      });
    }
  }));

export type IrohMachineCarrierFlowV1 = z.infer<typeof IrohMachineCarrierFlowV1Schema>;
export type IrohMachineHandshakeV1 = z.infer<typeof IrohMachineHandshakeV1Schema>;

/** Strict, bounded parser for remotely supplied machine/1 handshakes. */
export function parseIrohMachineHandshakeV1(value: unknown): IrohMachineHandshakeV1 {
  const result = IrohMachineHandshakeV1Schema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid Iroh machine handshake');
  return result.data;
}
