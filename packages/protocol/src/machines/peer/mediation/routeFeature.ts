import type { FeatureId } from '../../../features/catalog.js';

import type { PeerFlowKindV1 } from './flowKind.js';
import type { PeerRouteKindV1 } from './routeKind.js';

/**
 * Canonical flow-kind -> feature-gate mapping for peer-mediated routes.
 *
 * Every program that decides whether a peer route may be used answers the same question — the
 * server when it mints a route grant, the client when it decides to attempt a route, and the
 * daemon when it registers the loopback flow it will accept. They must consult the SAME feature
 * bit: a client that attempts a route the server refuses to authorize burns a round trip on every
 * attempt, and a server that authorizes a route the daemon never registers hands out a grant for
 * a route that can only fail.
 *
 * `voice_media` rides the peer TCP tunnel (loopback tunnel endpoint for direct, tunnel relay
 * socket for server-routed), so its direct route is gated by the tunnel direct-peer bit. Its
 * server-routed authorization is deliberately budgeted and gated as a live-stream relay
 * (`registerPeerMediationGrantRoutes.spec.ts`: "blocks daemon voice STT tunnel relay with the
 * live-stream relay gate even when generic tunnel relay is enabled").
 */
const DIRECT_ROUTE_FEATURE_ID_BY_FLOW_KIND: Readonly<Record<PeerFlowKindV1, FeatureId>> = {
  bounded_transfer: 'machines.transfer.directPeer',
  tcp_tunnel: 'machines.tunnel.directPeer',
  voice_media: 'machines.tunnel.directPeer',
  live_stream: 'machines.liveStream.directPeer',
  machine_rpc: 'machines.rpc.directPeer',
};

/**
 * Server-routed relays are owned by the relay that carries them: transfers by the transfer relay,
 * TCP tunnels by the tunnel relay, and voice/live-stream/machine-RPC fallback traffic by the
 * live-stream relay budget (there is no `machines.rpc.serverRouted` bit).
 */
const SERVER_ROUTED_FEATURE_ID_BY_FLOW_KIND: Readonly<Record<PeerFlowKindV1, FeatureId>> = {
  bounded_transfer: 'machines.transfer.serverRouted',
  tcp_tunnel: 'machines.tunnel.serverRouted',
  voice_media: 'machines.liveStream.serverRouted',
  live_stream: 'machines.liveStream.serverRouted',
  machine_rpc: 'machines.liveStream.serverRouted',
};

export function resolvePeerRouteFeatureId(input: Readonly<{
  flowKind: PeerFlowKindV1;
  routeKind: PeerRouteKindV1;
}>): FeatureId {
  return input.routeKind === 'server_relay'
    ? SERVER_ROUTED_FEATURE_ID_BY_FLOW_KIND[input.flowKind]
    : DIRECT_ROUTE_FEATURE_ID_BY_FLOW_KIND[input.flowKind];
}
