import { describe, expect, it } from 'vitest';

import { isFeatureId } from '../../../features/catalog.js';

import { PeerFlowKindV1Schema } from './flowKind.js';
import { PeerRouteKindV1Schema } from './routeKind.js';
import { PeerTcpTunnelRelayAuthorizationFlowKindV1Schema } from './tunnel/authorization.js';
import { resolvePeerRouteFeatureId } from './routeFeature.js';

describe('resolvePeerRouteFeatureId', () => {
  it('gates the direct voice-media route on the tunnel bit it actually rides', () => {
    // The daemon registers the `voice_media` loopback flow behind `machines.tunnel.directPeer`
    // and the client attempts it behind the same bit; minting behind the live-stream bit would
    // authorize a route the daemon never accepts.
    expect(resolvePeerRouteFeatureId({ flowKind: 'voice_media', routeKind: 'loopback_direct' }))
      .toBe('machines.tunnel.directPeer');
  });

  it('resolves a catalog feature id for every flow kind and route kind', () => {
    for (const flowKind of PeerFlowKindV1Schema.options) {
      for (const routeKind of PeerRouteKindV1Schema.options) {
        const featureId = resolvePeerRouteFeatureId({ flowKind, routeKind });
        expect(isFeatureId(featureId), `${flowKind}/${routeKind} -> ${featureId}`).toBe(true);
        expect(featureId).toContain(routeKind === 'server_relay' ? 'serverRouted' : 'directPeer');
      }
    }
  });

  it('resolves the private provider-broker relay carrier to the master credential-resource decision', () => {
    // The relayed broker carrier serves private Home→broker admission (administration
    // resource tests and admitted broker requests). It follows the master
    // `teams.credentialResources` decision; the public external-API exposure bit must
    // never widen or gate this private path (Lane 10: private access stays independent
    // of external API access).
    expect(resolvePeerRouteFeatureId({ flowKind: 'provider_broker', routeKind: 'server_relay' }))
      .toBe('teams.credentialResources');
  });

  it('never resolves a relay flow to the public external-API exposure bit', () => {
    for (const flowKind of PeerTcpTunnelRelayAuthorizationFlowKindV1Schema.options) {
      const featureId = resolvePeerRouteFeatureId({ flowKind, routeKind: 'server_relay' });
      expect(isFeatureId(featureId), `${flowKind} -> ${featureId}`).toBe(true);
      expect(featureId.startsWith('teams.credentialResources.externalApi'), `${flowKind} -> ${featureId}`).toBe(false);
    }
  });

  it('keeps relay-authorization flows on the same relay owners as their grant-flow twins', () => {
    expect(resolvePeerRouteFeatureId({ flowKind: 'tcp_tunnel', routeKind: 'server_relay' }))
      .toBe('machines.tunnel.serverRouted');
    expect(resolvePeerRouteFeatureId({ flowKind: 'voice_media', routeKind: 'server_relay' }))
      .toBe('machines.liveStream.serverRouted');
  });
});
