export const PEER_MEDIATION_RECEIPTS = Object.freeze({
  routeGrantMinted: 'peer.route_grant.minted',
  routeGrantVerified: 'peer.route_grant.verified',
  routeGrantRejected: 'peer.route_grant.rejected',
  routeGrantRevoked: 'peer.route_grant.revoked',
  routePolicyResolved: 'peer.route_policy.resolved',
  routeSelected: 'peer.route.selected',
  routeFallback: 'peer.route.fallback',
  rpcDirectCallSucceeded: 'peer.rpc.direct_call_succeeded',
  rpcFellBackToServer: 'peer.rpc.fell_back_to_server',
  tunnelOpened: 'peer.tunnel.opened',
  tunnelClosed: 'peer.tunnel.closed',
  streamStarted: 'peer.stream.started',
  streamPaused: 'peer.stream.paused',
  streamBandwidthCapped: 'peer.stream.bandwidth_capped',
} as const);

export type PeerMediationReceipt = (typeof PEER_MEDIATION_RECEIPTS)[keyof typeof PEER_MEDIATION_RECEIPTS];
