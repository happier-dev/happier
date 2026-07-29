import { describe, expect, it } from 'vitest';

import {
  PEER_MEDIATION_RECEIPTS,
  PeerLoopbackEndpointCandidateV1Schema,
  PeerLoopbackProbeRequestV1Schema,
  PeerLoopbackProbeResponseV1Schema,
} from './index';

const baseGrant = {
  payload: {
    v: 1,
    grantId: 'grant_1',
    grantFamilyId: 'family_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'bounded_transfer',
    routeKind: 'loopback_direct',
    scope: {
      kind: 'bounded_transfer',
      mode: 'single',
      transferId: 'transfer_1',
      maxBytes: 1024,
    },
    iat: 1_000,
    exp: 601_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: 'loopback_endpoint_1',
  },
  signature: {
    keyId: 'key_1',
    alg: 'Ed25519',
    valueBase64Url: 'AbCdEf012_-',
  },
} as const;

const baseNonceProof = {
  v: 1,
  grantId: 'grant_1',
  routeKind: 'loopback_direct',
  flowKind: 'bounded_transfer',
  endpointFingerprint: 'loopback_endpoint_1',
  nonceBase64Url: 'nonce_1',
  signatureBase64Url: 'AbCdEf012_-',
} as const;

describe('PeerLoopbackEndpointV1', () => {
  it('accepts only loopback endpoint candidates without URL secrets or fragments', () => {
    expect(PeerLoopbackEndpointCandidateV1Schema.parse({
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
      endpointFingerprint: 'loopback_endpoint_1',
      expiresAt: 10_000,
      directRouteGrantProofVerifierVersions: [2],
    })).toMatchObject({
      url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
      directRouteGrantProofVerifierVersions: [2],
    });

    expect(PeerLoopbackEndpointCandidateV1Schema.parse({
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
      endpointFingerprint: 'legacy-endpoint',
      expiresAt: 10_000,
    }).directRouteGrantProofVerifierVersions).toEqual([]);

    expect(PeerLoopbackEndpointCandidateV1Schema.safeParse({
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
      endpointFingerprint: 'unknown-verifier',
      expiresAt: 10_000,
      directRouteGrantProofVerifierVersions: [3],
    }).success).toBe(false);

    for (const url of [
      'http://192.168.1.20:3000/peer-mediation/v1/probe',
      'http://0.0.0.0:3000/peer-mediation/v1/probe',
      'http://daemon.localhost:3000/peer-mediation/v1/probe',
      'http://user:pass@127.0.0.1:3000/peer-mediation/v1/probe',
      'http://127.0.0.1:3000/peer-mediation/v1/probe?grant=secret',
      'http://127.0.0.1:3000/peer-mediation/v1/probe#secret',
    ]) {
      expect(PeerLoopbackEndpointCandidateV1Schema.safeParse({
        v: 1,
        routeKind: 'loopback_direct',
        url,
        endpointFingerprint: 'loopback_endpoint_1',
        expiresAt: 10_000,
      }).success).toBe(false);
    }
  });

  it('validates probe request and response receipts through the peer-mediation catalog', () => {
    expect(PeerLoopbackProbeRequestV1Schema.parse({
      v: 1,
      grant: baseGrant,
      nonceProof: baseNonceProof,
    }).grant.payload.grantId).toBe('grant_1');

    expect(PeerLoopbackProbeResponseV1Schema.parse({
      v: 1,
      ok: true,
      receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
      routeKind: 'loopback_direct',
      flowKind: 'bounded_transfer',
      endpointFingerprint: 'loopback_endpoint_1',
    }).receipt).toBe('peer.route.selected');

    expect(PeerLoopbackProbeResponseV1Schema.parse({
      v: 1,
      ok: false,
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'grant_endpoint_mismatch',
    }).receipt).toBe('peer.route.fallback');
  });
});
