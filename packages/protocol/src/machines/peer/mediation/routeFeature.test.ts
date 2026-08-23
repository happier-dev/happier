import { describe, expect, it } from 'vitest';

import { isFeatureId } from '../../../features/catalog.js';

import { PeerFlowKindV1Schema } from './flowKind.js';
import { PeerRouteKindV1Schema } from './routeKind.js';
import { resolvePeerRouteFeatureId } from './routeFeature.js';

describe('resolvePeerRouteFeatureId', () => {
  it('gates the direct voice-media route on the tunnel bit it actually rides', () => {
    // The daemon registers the `voice_media` loopback flow behind `machines.tunnel.directPeer`
    // and the client attempts it behind the same bit; minting behind the live-stream bit would
    // authorize a route the daemon never accepts.
    expect(resolvePeerRouteFeatureId({ flowKind: 'voice_media', routeKind: 'loopback_direct' }))
      .toBe('machines.tunnel.directPeer');
  });

  it('keeps the voice-media relay on the live-stream relay budget', () => {
    expect(resolvePeerRouteFeatureId({ flowKind: 'voice_media', routeKind: 'server_relay' }))
      .toBe('machines.liveStream.serverRouted');
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
});
