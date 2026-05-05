import { z } from 'zod';

export const PeerRouteKindV1Schema = z.enum([
  'loopback_direct',
  'lan_direct',
  'tailscale_serve_direct',
  'server_relay',
]);

export const DirectPeerRouteKindV1Schema = z.enum([
  'loopback_direct',
  'lan_direct',
  'tailscale_serve_direct',
]);

export type PeerRouteKindV1 = z.infer<typeof PeerRouteKindV1Schema>;
export type DirectPeerRouteKindV1 = z.infer<typeof DirectPeerRouteKindV1Schema>;
