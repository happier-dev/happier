import { type SignedDirectRouteGrantV1 } from '@happier-dev/protocol';
import { verifyDirectRouteGrantV1, type DirectRouteGrantTrustRoot } from '../mediation/verifyDirectRouteGrantV1';

export const MACHINE_CARRIER_ALPN_V1 = 'happier/machine/1' as const;
export type MachineCarrierOperationKind = 'file_transfer' | 'attachment_transfer' | 'workspace_sync';
export type MachineCarrierRole = 'initiator' | 'acceptor';
export type MachineCarrierHandshake = Readonly<{
  sourceMachineId: string;
  targetMachineId: string;
  sourceEndpointId: string;
  targetEndpointId: string;
  role: MachineCarrierRole;
}>;
export class MachineCarrierError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MachineCarrierError'; }
}

export type MachineCarrierConnection = Readonly<{
  observedPath: 'direct' | 'relay' | 'unknown';
  close: () => Promise<void>;
}>;

type MachineCarrierInput = Readonly<{
  accountId: string;
  machineId: string;
  localEndpointId?: string;
  role?: MachineCarrierRole;
  trustRoots: readonly DirectRouteGrantTrustRoot[];
  nowMs: () => number;
  connect: (input: {
    alpn: typeof MACHINE_CARRIER_ALPN_V1;
    endpointId: string;
    operationKind: MachineCarrierOperationKind;
    operationId: string;
  }) => Promise<MachineCarrierConnection>;
}>;

/** Opens an authenticated machine stream; transfer semantics remain owned by callers. */
export function createMachineCarrierAdapter(input: MachineCarrierInput) {
  return {
    async open(request: {
      operationKind: MachineCarrierOperationKind;
      operationId: string;
      peerEndpointId: string;
      grant: SignedDirectRouteGrantV1;
      handshake?: MachineCarrierHandshake;
    }) {
      // Machine/1 is deliberately narrower than the generic peer-grant set:
      // legacy direct and server-relay routes must never enter this carrier.
      if (request.grant.payload.routeKind !== 'iroh_peer') {
        throw new MachineCarrierError('route_kind_unsupported', 'Machine carrier requires an iroh_peer grant.');
      }
      const handshake = request.handshake;
      if (handshake) {
        if (handshake.targetMachineId !== input.machineId) {
          throw new MachineCarrierError('target_machine_mismatch', 'Machine handshake target mismatch.');
        }
        if (input.localEndpointId && handshake.targetEndpointId !== input.localEndpointId) {
          throw new MachineCarrierError('target_endpoint_mismatch', 'Machine handshake target endpoint mismatch.');
        }
        if (handshake.sourceEndpointId !== request.peerEndpointId) {
          throw new MachineCarrierError('source_endpoint_mismatch', 'Machine handshake source endpoint mismatch.');
        }
        if (input.role && handshake.role !== input.role) {
          throw new MachineCarrierError('role_mismatch', 'Machine handshake role mismatch.');
        }
      }
      const flowKind = request.grant.payload.flowKind;
      if ((request.operationKind === 'file_transfer' || request.operationKind === 'attachment_transfer') && flowKind !== 'bounded_transfer') {
        throw new MachineCarrierError('grant_flow_mismatch', 'File and attachment carriers require a bounded-transfer grant.');
      }
      if (request.operationKind === 'workspace_sync' && flowKind !== 'bounded_transfer' && flowKind !== 'machine_rpc') {
        throw new MachineCarrierError('grant_flow_mismatch', 'Workspace sync requires a machine grant flow.');
      }
      const verification = verifyDirectRouteGrantV1({
        grant: request.grant,
        trustRoots: input.trustRoots,
        nowMs: input.nowMs(),
        expected: {
          accountId: input.accountId,
          machineId: input.machineId,
          // Existing grants use bounded_transfer for file/attachment and may
          // use machine_rpc for workspace relationships.
          flowKind: request.grant.payload.flowKind,
          routeKind: 'iroh_peer',
          endpointFingerprint: request.peerEndpointId,
        },
      });
      if (!verification.valid) {
        throw new MachineCarrierError(verification.reasonCode, `Machine route grant rejected: ${verification.reasonCode}.`);
      }
      const scope = verification.payload.scope;
      const boundId = scope.kind === 'bounded_transfer' && scope.mode === 'single'
        ? scope.transferId
        : scope.kind === 'machine_rpc' ? scope.rpcScopeId : undefined;
      if (boundId && boundId !== request.operationId) {
        throw new MachineCarrierError('grant_operation_mismatch', 'Machine route grant operation mismatch.');
      }
      const connection = await input.connect({
        alpn: MACHINE_CARRIER_ALPN_V1,
        endpointId: request.peerEndpointId,
        operationKind: request.operationKind,
        operationId: request.operationId,
      });
      return {
        alpn: MACHINE_CARRIER_ALPN_V1,
        operationKind: request.operationKind,
        operationId: request.operationId,
        observedPath: connection.observedPath ?? 'unknown',
        close: connection.close,
      };
    },
  };
}
