import { randomBytes } from 'node:crypto';
import { MACHINE_ALPN } from '@happier-dev/iroh-native/node';

import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { IrohEndpointDescriptorV1Schema } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

import type {
  FiniteTransferMachineTunnel,
  WorkspaceSyncMachineTunnel,
  WorkspaceSyncMachineTunnelOpen,
  WorkspaceSyncMachineTunnelOpenInput,
} from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import {
  awaitMachineCarrierControlPlane,
  awaitMachineCarrierTunnelOpen,
  MachineCarrierError,
  machineCarrierUnavailableError,
  verifyMachineCarrierHandshakeV1,
} from './machineCarrier';
import type { DaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import type { DirectRouteGrantTrustRoot } from '../mediation/verifyDirectRouteGrant';

type TargetMachineCarrierSnapshot = Readonly<{
  id: string;
  operationProtocolCapabilities?: unknown;
  operationProtocolCapabilitiesRevision?: unknown;
}>;

async function requireExpectedRemoteEndpoint<T extends Readonly<{
  remoteEndpointId: string;
  close(): Promise<void>;
}>>(tunnel: T, expectedRemoteEndpointId: string): Promise<T> {
  if (tunnel.remoteEndpointId === expectedRemoteEndpointId) return tunnel;
  await tunnel.close().catch(() => undefined);
  throw new MachineCarrierError(
    'transport_identity_mismatch',
    'Authenticated transport endpoint identity does not match the machine handshake.',
  );
}

/**
 * Creates the Lane 08 source-side opener over Lane 06's native tunnel
 * lifecycle. Authentication and descriptor pinning complete before the
 * loopback port is exposed; Mutagen bytes remain in the native tunnel and the
 * Lane 08 controller-owned socket.
 */
export function createWorkspaceMachineCarrierTunnelOpen(input: Readonly<{
  accountId: string;
  localMachineId: string;
  runtime: DaemonMachineIrohRuntime;
  resolveTrustRoots: () => readonly DirectRouteGrantTrustRoot[];
  readTargetMachine: (machineId: string, signal?: AbortSignal) => Promise<TargetMachineCarrierSnapshot | null>;
  mintGrant: (request: ReturnType<typeof DirectRouteGrantRequestV2Schema.parse>, signal?: AbortSignal) => Promise<unknown>;
  nowMs?: () => number;
}>): WorkspaceSyncMachineTunnelOpen {
  async function open(
    request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>,
  ): Promise<FiniteTransferMachineTunnel>;
  async function open(
    request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>,
  ): Promise<WorkspaceSyncMachineTunnel>;
  async function open(
    request: WorkspaceSyncMachineTunnelOpenInput,
  ): Promise<FiniteTransferMachineTunnel | WorkspaceSyncMachineTunnel> {
    if (request.sourceMachineId !== input.localMachineId) {
      throw machineCarrierUnavailableError();
    }
    request.signal?.throwIfAborted();
    const targetRead = request.signal
      ? input.readTargetMachine(request.targetMachineId, request.signal)
      : input.readTargetMachine(request.targetMachineId);
    const target = await awaitMachineCarrierControlPlane(targetRead, request.signal);
    const targetEndpoint = readMachineIrohEndpointAuthorityV1({
      capabilities: target?.operationProtocolCapabilities,
      revision: target?.operationProtocolCapabilitiesRevision,
    });
    if (!target || target.id !== request.targetMachineId || !targetEndpoint) {
      throw machineCarrierUnavailableError();
    }

    const proofHandle = createEphemeralPeerRouteProofHandleV2({
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    try {
      const grantRequest = DirectRouteGrantRequestV2Schema.parse({
        v: 2,
        kind: 'ephemeral_ed25519',
        ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
        machineId: request.targetMachineId,
        flowKind: request.flow === 'file_transfer' ? 'bounded_transfer' : 'machine_rpc',
        routeKind: 'iroh_peer',
        endpointFingerprint: targetEndpoint.endpointId,
        ttlMs: request.flow === 'file_transfer'
          ? DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier
          : DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault,
        scope: request.flow === 'file_transfer'
          ? { kind: 'bounded_transfer', mode: 'carrier' }
          : {
              kind: 'machine_rpc',
              rpcScopeId: request.operationId,
              allowedMethods: ['workspace.sync'],
              maxCalls: 1,
              maxIdleMs: DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault,
              highRiskSingleUseMethods: ['workspace.sync'],
            },
        iroh: {
          initiator: {
            kind: 'machine',
            machineId: input.localMachineId,
            endpointId: input.runtime.endpoint.endpointId,
          },
          target: {
            machineId: request.targetMachineId,
            endpointId: targetEndpoint.endpointId,
          },
          operationKind: request.flow === 'file_transfer' ? 'finite_transfer' : 'workspace_sync',
        },
      });
      request.signal?.throwIfAborted();
      const grantRequestResult = request.signal
        ? input.mintGrant(grantRequest, request.signal)
        : input.mintGrant(grantRequest);
      const grant = SignedDirectRouteGrantV2Schema.parse(await awaitMachineCarrierControlPlane(
        grantRequestResult,
        request.signal,
      ));
      const proof = proofHandle.sign(grant);
      request.signal?.throwIfAborted();
      const currentRead = request.signal
        ? input.readTargetMachine(request.targetMachineId, request.signal)
        : input.readTargetMachine(request.targetMachineId);
      const current = await awaitMachineCarrierControlPlane(currentRead, request.signal);
      const currentEndpoint = readMachineIrohEndpointAuthorityV1({
        capabilities: current?.operationProtocolCapabilities,
        revision: current?.operationProtocolCapabilitiesRevision,
      });
      if (
        !current || current.id !== request.targetMachineId
        || !currentEndpoint
        || currentEndpoint.endpointId !== grant.payload.iroh?.target.endpointId
      ) {
        throw machineCarrierUnavailableError();
      }
      const { revision: _revision, ...currentDescriptor } = currentEndpoint;
      const endpoint = IrohEndpointDescriptorV1Schema.parse(currentDescriptor);

      const handshake = IrohMachineHandshakeV1Schema.parse({
        v: 1,
        accountId: input.accountId,
        initiator: grant.payload.iroh?.initiator,
        target: grant.payload.iroh?.target,
        ...(request.flow === 'file_transfer'
          ? { flow: 'finite_transfer' as const }
          : { flow: 'workspace_sync' as const, operationId: request.operationId }),
        grant,
        proof,
      });
      const verified = verifyMachineCarrierHandshakeV1({
        handshake,
        accountId: input.accountId,
        machineId: input.localMachineId,
        localEndpointId: input.runtime.endpoint.endpointId,
        role: 'initiator',
        trustRoots: input.resolveTrustRoots(),
        nowMs: (input.nowMs ?? Date.now)(),
      });
      request.signal?.throwIfAborted();
      if (request.flow === 'file_transfer') {
        const tunnel = await requireExpectedRemoteEndpoint(await awaitMachineCarrierTunnelOpen(input.runtime.openTunnel({
            alpn: MACHINE_ALPN,
            remoteEndpointId: verified.remoteEndpointId,
            flow: 'finite_transfer',
            handshake,
          }, endpoint), request.signal), verified.remoteEndpointId);
        return {
          localPort: tunnel.localPort,
          observedPath: tunnel.observedPath,
          close: tunnel.close,
        };
      }
      const tunnel = await requireExpectedRemoteEndpoint(await awaitMachineCarrierTunnelOpen(input.runtime.openTunnel({
            alpn: MACHINE_ALPN,
            remoteEndpointId: verified.remoteEndpointId,
            flow: 'workspace_sync',
            operationId: request.operationId,
            handshake,
          }, endpoint), request.signal), verified.remoteEndpointId);
      return {
        localPort: tunnel.localPort,
        localCapability: tunnel.localCapability,
        observedPath: tunnel.observedPath,
        close: tunnel.close,
      };
    } finally {
      proofHandle.dispose();
    }
  }
  return open;
}
