import { z } from 'zod';

const LEGACY_DIRECT_PEER_ROUTE_KINDS_V1 = [
  'loopback_direct',
  'lan_direct',
  'tailscale_serve_direct',
] as const;

export const PeerRouteKindV1Schema = z.enum([
  ...LEGACY_DIRECT_PEER_ROUTE_KINDS_V1,
  'server_relay',
  'iroh_peer',
]);

export const DirectPeerRouteKindV1Schema = z.enum(LEGACY_DIRECT_PEER_ROUTE_KINDS_V1);

/**
 * Route kinds accepted for endpoint-bound peer grants. Server relay remains a
 * separate server-mediated ingress and is intentionally excluded here.
 */
export const AUTHORIZED_PEER_ENDPOINT_ROUTE_KINDS_V1 = [
  ...LEGACY_DIRECT_PEER_ROUTE_KINDS_V1,
  'iroh_peer',
] as const;

export const AuthorizedPeerEndpointRouteKindV1Schema = z.enum(AUTHORIZED_PEER_ENDPOINT_ROUTE_KINDS_V1);

export type PeerRouteKindV1 = z.infer<typeof PeerRouteKindV1Schema>;
export type DirectPeerRouteKindV1 = z.infer<typeof DirectPeerRouteKindV1Schema>;
export type AuthorizedPeerEndpointRouteKindV1 = z.infer<typeof AuthorizedPeerEndpointRouteKindV1Schema>;
