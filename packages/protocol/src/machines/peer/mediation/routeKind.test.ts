import { describe, expect, it } from 'vitest';

import {
  AUTHORIZED_PEER_ENDPOINT_ROUTE_KINDS_V1,
  AuthorizedPeerEndpointRouteKindV1Schema,
  PeerRouteKindV1Schema,
} from './routeKind.js';

describe('peer route kinds', () => {
  it('includes Iroh as one semantic peer route kind', () => {
    expect(PeerRouteKindV1Schema.parse('iroh_peer')).toBe('iroh_peer');
    expect(PeerRouteKindV1Schema.options).toContain('iroh_peer');
  });

  it('authorizes only legacy direct endpoint routes and Iroh', () => {
    expect(AUTHORIZED_PEER_ENDPOINT_ROUTE_KINDS_V1).toEqual([
      'loopback_direct',
      'lan_direct',
      'tailscale_serve_direct',
      'iroh_peer',
    ]);

    for (const routeKind of AUTHORIZED_PEER_ENDPOINT_ROUTE_KINDS_V1) {
      expect(AuthorizedPeerEndpointRouteKindV1Schema.parse(routeKind)).toBe(routeKind);
    }
    expect(AuthorizedPeerEndpointRouteKindV1Schema.safeParse('server_relay').success).toBe(false);
    expect(AuthorizedPeerEndpointRouteKindV1Schema.safeParse('arbitrary_route').success).toBe(false);
  });
});
