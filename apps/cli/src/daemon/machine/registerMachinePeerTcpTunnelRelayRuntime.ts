import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolvePeerRouteFeatureId } from '@happier-dev/protocol/machines/peer/mediation/routeFeature';
import type { FeaturesResponse, PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol';

import {
  registerPeerTcpTunnelRelayTerminator,
  type RegisterPeerTcpTunnelRelayTerminatorOptions,
} from '@/daemon/peer/mediation/tunnel/relay';
import { connectPeerTcpTunnelTcp } from '@/daemon/peer/mediation/tunnel/open';

type EventPort = Readonly<{
  subscribe(listener: (payload: PeerTcpTunnelRelayEnvelope) => void | Promise<void>): () => void;
  emit(payload: PeerTcpTunnelRelayEnvelope): void;
}>;

type Dependencies = Readonly<{
  registerTerminator: typeof registerPeerTcpTunnelRelayTerminator;
}>;

const productionDependencies: Dependencies = {
  registerTerminator: registerPeerTcpTunnelRelayTerminator,
};

/**
 * One capability/trust-root/terminator composition shared by ordinary daemons
 * and restricted Runner Machines. Callers only adapt their current exact
 * Machine socket; authorization and tunnel lifetime remain in the incumbent
 * relay terminator.
 */
export function registerMachinePeerTcpTunnelRelayRuntime(input: Readonly<{
  accountId: string;
  machineId: string;
  serverFeatures: FeaturesResponse;
  nowMs: () => number;
  eventPort: EventPort;
  observability?: RegisterPeerTcpTunnelRelayTerminatorOptions['observability'];
  voiceBinaryAppendConsumer?: RegisterPeerTcpTunnelRelayTerminatorOptions['voiceBinaryAppendConsumer'];
  voiceBinaryTerminalConsumer?: RegisterPeerTcpTunnelRelayTerminatorOptions['voiceBinaryTerminalConsumer'];
  resolveProviderBrokerApplicationTarget?: RegisterPeerTcpTunnelRelayTerminatorOptions['resolveProviderBrokerApplicationTarget'];
  resolvePreviewApplication?: RegisterPeerTcpTunnelRelayTerminatorOptions['resolvePreviewApplication'];
  onHandlerError?: (error: unknown) => void;
  dependencies?: Dependencies;
}>): Readonly<{ dispose(): Promise<void> }> | null {
  // This carrier also terminates application flows whose relay gates differ
  // from generic TCP. Register it for each enabled, actually installed consumer.
  const flowEnabled = (flowKind: 'tcp_tunnel' | 'voice_media' | 'provider_broker') => readServerEnabledBit(
    input.serverFeatures, resolvePeerRouteFeatureId({ flowKind, routeKind: 'server_relay' }),
  ) === true;
  if (!flowEnabled('tcp_tunnel')
    && !(input.voiceBinaryAppendConsumer && flowEnabled('voice_media'))
    && !(input.resolveProviderBrokerApplicationTarget && flowEnabled('provider_broker'))) return null;
  const relayAuthorizationTrustRoots = input.serverFeatures.capabilities.machines.peerMediation.grantSigningKeys
    .filter((key) => key.expiresAt == null || key.expiresAt > input.nowMs())
    .map((key) => ({
      keyId: key.keyId,
      publicKeyBase64Url: key.publicKey,
      expiresAt: key.expiresAt,
    }));
  if (relayAuthorizationTrustRoots.length === 0) return null;

  let handler: ((payload?: unknown) => void | Promise<void>) | null = null;
  const unsubscribe = input.eventPort.subscribe((payload) => {
    if (!handler) return;
    void Promise.resolve(handler(payload)).catch((error) => input.onHandlerError?.(error));
  });
  const socket = {
    on: (_event: string, next: (payload?: unknown) => void | Promise<void>) => {
      handler = next;
    },
    emit: (_event: string, payload: unknown) => input.eventPort.emit(payload as PeerTcpTunnelRelayEnvelope),
  };
  const caps = input.serverFeatures.capabilities.machines.tunnel.serverRouted;
  const terminator = (input.dependencies ?? productionDependencies).registerTerminator({
    accountId: input.accountId,
    machineId: input.machineId,
    socket,
    nowMs: input.nowMs,
    relayAuthorizationTrustRoots,
    connectTcp: connectPeerTcpTunnelTcp,
    ...(input.resolvePreviewApplication ? { resolvePreviewApplication: input.resolvePreviewApplication } : {}),
    maxFrameBytes: caps.maxFrameBytes,
    maxBinaryHeaderBytes: caps.maxBinaryHeaderBytes,
    maxRawPayloadBytes: caps.maxRawPayloadBytes,
    maxFramedMessageBytes: caps.maxFramedMessageBytes,
    maxActiveTunnels: caps.maxActiveTunnelsPerSocket,
    substreamCaps: caps.substreams,
    ...(input.observability ? { observability: input.observability } : {}),
    ...(input.voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer: input.voiceBinaryAppendConsumer } : {}),
    ...(input.voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer: input.voiceBinaryTerminalConsumer } : {}),
    ...(input.resolveProviderBrokerApplicationTarget
      ? { resolveProviderBrokerApplicationTarget: input.resolveProviderBrokerApplicationTarget }
      : {}),
  });

  let disposed = false;
  return Object.freeze({
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      handler = null;
      await terminator.dispose();
    },
  });
}
