import { randomBytes } from 'node:crypto';

import {
  DIRECT_ROUTE_GRANT_TTL_MS,
  readServerEnabledBit,
  resolvePeerRouteFeatureId,
  type FeaturesResponse,
  type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import {
  startPeerMediationLoopbackServer as startPeerMediationLoopbackServerDefault,
  type StartPeerMediationLoopbackServerOptions,
} from '../loopback/server';
import type { PeerMachineLiveStreamDirectRuntimeOptions } from '../stream/registerRoutes';
import type { RegisterPeerTcpTunnelLoopbackRoutesOptions } from '../tunnel/registerRoutes';
import type { DirectRouteGrantTrustRoot } from '../verifyDirectRouteGrantV1';
import type { PeerMachineRpcDirectHandlerManager } from './registerRoutes';

const PEER_MEDIATION_MACHINE_RPC_DEFAULT_HOST = '127.0.0.1';
const PEER_MEDIATION_MACHINE_RPC_DEFAULT_PORT = 0;
const PEER_MEDIATION_MACHINE_RPC_ENDPOINT_FINGERPRINT_BYTES = 16;

export type StartPeerMediationMachineRpcLoopbackInput = Readonly<{
  accountId: string;
  machineId: string;
  accountSigningSeed?: Uint8Array;
  serverFeatures: FeaturesResponse;
  rpcHandlerManager: PeerMachineRpcDirectHandlerManager;
  nowMs?: () => number;
  endpointFingerprint?: () => string;
  endpointTtlMs?: number;
  host?: string;
  port?: number;
  localPerPeerMaxConcurrentCalls?: number;
  startPeerMediationLoopbackServer?: (
    options: StartPeerMediationLoopbackServerOptions,
  ) => ReturnType<typeof startPeerMediationLoopbackServerDefault>;
}>;

type PeerTcpTunnelDirectRuntimeOptions = Omit<
  RegisterPeerTcpTunnelLoopbackRoutesOptions,
  'nowMs' | 'expected' | 'trustRoots' | 'revokedGrantIds' | 'revokedGrantFamilyIds'
>;

export type StartPeerMediationLoopbackInput = Readonly<{
  accountId: string;
  machineId: string;
  accountSigningSeed?: Uint8Array;
  serverFeatures: FeaturesResponse;
  rpcHandlerManager?: PeerMachineRpcDirectHandlerManager;
  stream?: PeerMachineLiveStreamDirectRuntimeOptions;
  tunnel?: PeerTcpTunnelDirectRuntimeOptions;
  nowMs?: () => number;
  endpointFingerprint?: () => string;
  endpointTtlMs?: number;
  host?: string;
  port?: number;
  localPerPeerMaxConcurrentCalls?: number;
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
    }));
}

function resolveAccountPublicKey(accountSigningSeed: Uint8Array | undefined): string | null {
  if (!accountSigningSeed || accountSigningSeed.length !== tweetnacl.sign.seedLength) {
    return null;
  }
  const keyPair = tweetnacl.sign.keyPair.fromSeed(accountSigningSeed);
  return Buffer.from(keyPair.publicKey).toString('base64url');
}

export async function startPeerMediationMachineRpcLoopback(
  input: StartPeerMediationMachineRpcLoopbackInput,
): Promise<StartedPeerMediationMachineRpcLoopback | null> {
  if (readServerEnabledBit(input.serverFeatures, 'machines.rpc.directPeer') !== true) {
    return null;
  }
  const started = await startPeerMediationLoopback({
    accountId: input.accountId,
    machineId: input.machineId,
    accountSigningSeed: input.accountSigningSeed,
    serverFeatures: input.serverFeatures,
    rpcHandlerManager: input.rpcHandlerManager,
    ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    ...(input.endpointFingerprint ? { endpointFingerprint: input.endpointFingerprint } : {}),
    ...(input.endpointTtlMs ? { endpointTtlMs: input.endpointTtlMs } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(typeof input.port === 'number' ? { port: input.port } : {}),
    ...(typeof input.localPerPeerMaxConcurrentCalls === 'number'
      ? { localPerPeerMaxConcurrentCalls: input.localPerPeerMaxConcurrentCalls }
      : {}),
    ...(input.startPeerMediationLoopbackServer
      ? { startPeerMediationLoopbackServer: input.startPeerMediationLoopbackServer }
      : {}),
  });
  if (!started?.activeFlows.machine_rpc) return null;
  return {
    endpoint: started.endpoint,
    stop: started.stop,
  };
}

export async function startPeerMediationLoopback(
  input: StartPeerMediationLoopbackInput,
): Promise<StartedPeerMediationLoopback | null> {
  const rpcHandlerManager = input.rpcHandlerManager;
  const streamOptions = input.stream;
  const tunnelOptions = input.tunnel;
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
  if (!rpcEnabled && !liveStreamEnabled && !tunnelEnabled) return null;

  const nowMs = input.nowMs ?? Date.now;
  const now = nowMs();
  const trustRoots = resolveGrantTrustRoots({
    serverFeatures: input.serverFeatures,
    nowMs: now,
  });
  if (trustRoots.length === 0) {
    return null;
  }

  const accountPublicKey = resolveAccountPublicKey(input.accountSigningSeed);
  const supportsEphemeralProofV2 = input.serverFeatures.capabilities.machines.peerMediation
    .directRouteGrantProofMintVersions.includes(2);
  if (!accountPublicKey && !supportsEphemeralProofV2) {
    return null;
  }

  const endpointFingerprint = input.endpointFingerprint?.() ?? createPeerMediationMachineRpcEndpointFingerprint();
  const machineRpcExpected = {
    accountId: input.accountId,
    machineId: input.machineId,
    flowKind: 'machine_rpc' as const,
    routeKind: 'loopback_direct' as const,
    endpointFingerprint,
    ...(accountPublicKey ? { accountPublicKey } : {}),
  };
  const tcpTunnelExpected = {
    accountId: input.accountId,
    machineId: input.machineId,
    flowKind: 'tcp_tunnel' as const,
    routeKind: 'loopback_direct' as const,
    endpointFingerprint,
    ...(accountPublicKey ? { accountPublicKey } : {}),
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
    ...(accountPublicKey ? { accountPublicKey } : {}),
  };
  const primaryExpected = rpcEnabled ? machineRpcExpected : liveStreamEnabled ? liveStreamExpected : tcpTunnelExpected;
  const defaultEndpointTtlMs = Math.max(
    rpcEnabled ? DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault : 0,
    liveStreamEnabled ? DIRECT_ROUTE_GRANT_TTL_MS.directLiveStream : 0,
    tunnelEnabled ? DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel : 0,
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
    endpointExpiresAt: now + (input.endpointTtlMs ?? defaultEndpointTtlMs),
    directRouteGrantProofVerifierVersions: supportsEphemeralProofV2 ? [2] : [],
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
  });

  return {
    endpoint: started.endpoint,
    stop: started.stop,
    activeFlows: {
      ...(rpcEnabled ? { machine_rpc: true as const } : {}),
      ...(liveStreamEnabled ? { live_stream: true as const } : {}),
      ...(tunnelEnabled ? { tcp_tunnel: true as const } : {}),
    },
  };
}
