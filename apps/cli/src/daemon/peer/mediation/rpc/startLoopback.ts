import { randomBytes } from 'node:crypto';

import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolvePeerRouteFeatureId } from '@happier-dev/protocol/machines/peer/mediation/routeFeature';
import type { FeaturesResponse, PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol';

import type { DaemonPeerMediationObservabilityEmitter } from '../observability/events';
import {
  startPeerMediationLoopbackServer as startPeerMediationLoopbackServerDefault,
  type PeerTcpTunnelDirectRuntimeOptions,
  type StartPeerMediationLoopbackServerOptions,
} from '../loopback/server';
import type { PeerMachineLiveStreamDirectRuntimeOptions } from '../stream/registerRoutes';
import type { DirectRouteGrantTrustRoot } from '../verifyDirectRouteGrant';
import type { PeerMediationLoopbackIrohMachineAdmissionOptions } from '../loopback/irohMachineAdmission';
import type { PeerMachineRpcDirectHandlerManager } from './registerRoutes';

const PEER_MEDIATION_MACHINE_RPC_DEFAULT_HOST = '127.0.0.1';
const PEER_MEDIATION_MACHINE_RPC_DEFAULT_PORT = 0;
const PEER_MEDIATION_MACHINE_RPC_ENDPOINT_FINGERPRINT_BYTES = 16;

export type StartPeerMediationLoopbackInput = Readonly<{
  accountId: string;
  machineId: string;
  serverFeatures: FeaturesResponse;
  /** Current authenticated Home authority. Startup features remain eligibility evidence only. */
  resolveTrustRoots?: () => readonly DirectRouteGrantTrustRoot[];
  rpcHandlerManager?: PeerMachineRpcDirectHandlerManager;
  stream?: PeerMachineLiveStreamDirectRuntimeOptions;
  tunnel?: PeerTcpTunnelDirectRuntimeOptions;
  irohMachineAdmission?: PeerMediationLoopbackIrohMachineAdmissionOptions;
  nowMs?: () => number;
  endpointFingerprint?: () => string;
  endpointTtlMs?: number;
  host?: string;
  port?: number;
  localPerPeerMaxConcurrentCalls?: number;
  /**
   * PMS-9 / P1-9: the shared daemon observability emitter. Supplying it here is what makes the
   * DIRECT routes observable at all; before this the emitter reached only the two relay
   * terminators, so the loopback route produced no flow facts.
   */
  observability?: DaemonPeerMediationObservabilityEmitter;
  startPeerMediationLoopbackServer?: (
    options: StartPeerMediationLoopbackServerOptions,
  ) => ReturnType<typeof startPeerMediationLoopbackServerDefault>;
}>;

export type StartedPeerMediationMachineRpcLoopback = Readonly<{
  endpoint: PeerLoopbackEndpointCandidateV1;
  stop: () => Promise<void>;
}>;

export type StartedPeerMediationLoopback = StartedPeerMediationMachineRpcLoopback & Readonly<{
  activeFlows: Readonly<{
    machine_rpc?: true;
    live_stream?: true;
    tcp_tunnel?: true;
    /**
     * §7.5: `voice_media` rides the tunnel endpoint but is its own flow kind. Omitting it here made
     * the daemon's own state report unable to show the substrate's most-used flow.
     */
    voice_media?: true;
  }>;
}>;

function createPeerMediationMachineRpcEndpointFingerprint(): string {
  return `pmrpc_${randomBytes(PEER_MEDIATION_MACHINE_RPC_ENDPOINT_FINGERPRINT_BYTES).toString('base64url')}`;
}

function resolveGrantTrustRoots(input: Readonly<{
  serverFeatures: FeaturesResponse;
  nowMs: number;
}>): DirectRouteGrantTrustRoot[] {
  const grantSigningKeys = input.serverFeatures.capabilities.machines.peerMediation.grantSigningKeys;
  return grantSigningKeys
    .filter((key) => key.expiresAt == null || key.expiresAt > input.nowMs)
    .map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicKey,
      expiresAt: key.expiresAt,
    }));
}

export async function startPeerMediationLoopback(
  input: StartPeerMediationLoopbackInput,
): Promise<StartedPeerMediationLoopback | null> {
  const rpcHandlerManager = input.rpcHandlerManager;
  const streamOptions = input.stream;
  const tunnelOptions = input.tunnel;
  const irohMachineAdmission = input.irohMachineAdmission;
  const rpcEnabled =
    rpcHandlerManager !== undefined && readServerEnabledBit(input.serverFeatures, 'machines.rpc.directPeer') === true;
  const liveStreamEnabled =
    streamOptions?.captureAdapter !== undefined
    && readServerEnabledBit(input.serverFeatures, 'machines.liveStream.directPeer') === true;
  const tunnelEnabled =
    tunnelOptions !== undefined && readServerEnabledBit(input.serverFeatures, 'machines.tunnel.directPeer') === true;
  // The voice-media flow rides the same loopback tunnel endpoint; `resolvePeerRouteFeatureId` is
  // the single owner of which bit gates it, shared with the grant-minting server and the client.
  const voiceMediaEnabled = tunnelOptions !== undefined
    && readServerEnabledBit(
      input.serverFeatures,
      resolvePeerRouteFeatureId({ flowKind: 'voice_media', routeKind: 'loopback_direct' }),
    ) === true;
  if (!rpcEnabled && !liveStreamEnabled && !tunnelEnabled && !irohMachineAdmission) return null;

  const nowMs = input.nowMs ?? Date.now;
  const now = nowMs();
  const trustRoots = resolveGrantTrustRoots({
    serverFeatures: input.serverFeatures,
    nowMs: now,
  });
  if (trustRoots.length === 0) {
    return null;
  }

  const endpointFingerprint = input.endpointFingerprint?.() ?? createPeerMediationMachineRpcEndpointFingerprint();
  const machineRpcExpected = {
    accountId: input.accountId,
    machineId: input.machineId,
    flowKind: 'machine_rpc' as const,
    routeKind: 'loopback_direct' as const,
    endpointFingerprint,
  };
  const tcpTunnelExpected = {
    accountId: input.accountId,
    machineId: input.machineId,
    flowKind: 'tcp_tunnel' as const,
    routeKind: 'loopback_direct' as const,
    endpointFingerprint,
  };
  const voiceMediaExpected = {
    ...tcpTunnelExpected,
    flowKind: 'voice_media' as const,
  };
  const liveStreamExpected = {
    accountId: input.accountId,
    machineId: input.machineId,
    flowKind: 'live_stream' as const,
    routeKind: 'loopback_direct' as const,
    endpointFingerprint,
  };
  // `expected` also supplies the shared app's local account/machine binding.
  // Iroh-only startup registers no legacy route, so this placeholder is never
  // used for direct admission; the Iroh route verifies its canonical handshake.
  const primaryExpected = rpcEnabled
    ? machineRpcExpected
    : liveStreamEnabled
      ? liveStreamExpected
      : tunnelEnabled
        ? tcpTunnelExpected
        : machineRpcExpected;
  const defaultEndpointTtlMs = Math.max(
    rpcEnabled ? DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault : 0,
    liveStreamEnabled ? DIRECT_ROUTE_GRANT_TTL_MS.directLiveStream : 0,
    tunnelEnabled ? DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel : 0,
    irohMachineAdmission ? DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault : 0,
  );
  const startPeerMediationLoopbackServer =
    input.startPeerMediationLoopbackServer ?? startPeerMediationLoopbackServerDefault;
  const started = await startPeerMediationLoopbackServer({
    nowMs,
    expected: primaryExpected,
    expectedByFlow: {
      ...(rpcEnabled ? { machine_rpc: machineRpcExpected } : {}),
      ...(liveStreamEnabled ? { live_stream: liveStreamExpected } : {}),
      ...(tunnelEnabled ? { tcp_tunnel: tcpTunnelExpected } : {}),
      ...(voiceMediaEnabled ? { voice_media: voiceMediaExpected } : {}),
    },
    trustRoots,
    ...(input.resolveTrustRoots ? { resolveTrustRoots: input.resolveTrustRoots } : {}),
    endpointExpiresAt: now + (input.endpointTtlMs ?? defaultEndpointTtlMs),
    host: input.host ?? PEER_MEDIATION_MACHINE_RPC_DEFAULT_HOST,
    port: input.port ?? PEER_MEDIATION_MACHINE_RPC_DEFAULT_PORT,
    ...(rpcEnabled
      ? {
          rpc: {
            rpcHandlerManager,
            ...(typeof input.localPerPeerMaxConcurrentCalls === 'number'
              ? { localPerPeerMaxConcurrentCalls: input.localPerPeerMaxConcurrentCalls }
              : {}),
          },
        }
      : {}),
    ...(liveStreamEnabled ? { stream: streamOptions ?? {} } : {}),
    ...(tunnelEnabled ? { tunnel: tunnelOptions } : {}),
    ...(irohMachineAdmission ? { irohMachineAdmission } : {}),
    ...(input.observability ? { observability: input.observability } : {}),
  });

  return {
    endpoint: started.endpoint,
    stop: started.stop,
    activeFlows: {
      ...(rpcEnabled ? { machine_rpc: true as const } : {}),
      ...(liveStreamEnabled ? { live_stream: true as const } : {}),
      ...(tunnelEnabled ? { tcp_tunnel: true as const } : {}),
      ...(voiceMediaEnabled ? { voice_media: true as const } : {}),
    },
  };
}
