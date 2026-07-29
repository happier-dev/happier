import { describe, expect, it } from 'vitest';

import {
  PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2,
  PeerMachineLiveStreamDirectStartRequestV2Schema,
} from './directV2';

const key32 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const signature64 = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg';

const request = {
  v: 2,
  streamId: 'stream-1',
  streamFamily: 'screen',
  routeKind: 'loopback_direct',
  flowKind: 'live_stream',
  endpointFingerprint: 'endpoint-1',
  grant: {
    payload: {
      v: 2, grantId: 'grant-1', accountId: 'account-1', machineId: 'machine-1',
      flowKind: 'live_stream', routeKind: 'loopback_direct',
      scope: { kind: 'live_stream', streamId: 'stream-1', streamFamily: 'screen', maxBitrateBps: 1_000, maxDurationMs: 5_000 },
      iat: 1_000, exp: 2_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint-1',
      proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: key32,
    },
    signature: { keyId: 'server-key', alg: 'Ed25519', valueBase64Url: signature64 },
  },
  proof: {
    v: 2, kind: 'ephemeral_ed25519', signedGrantDigestBase64Url: key32,
    nonceBase64Url: 'AwMDAwMDAwMDAwMDAwMDAw', signatureBase64Url: signature64,
  },
  startRequest: {
    v: 1, streamId: 'stream-1', streamFamily: 'screen', routeKind: 'loopback_direct',
    sourceMachineId: 'machine-1', targetMachineId: 'viewer-1', maxBitrateBps: 1_000,
    maxFramesPerSecond: 10, maxFrameBytes: 1_000, maxDurationMs: 5_000,
  },
} as const;

describe('peer machine live-stream direct V2', () => {
  it('owns a strict V2 admission path with the canonical V2 grant and proof', () => {
    expect(PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2).toBe('/peer-mediation/v2/live-stream/start');
    expect(PeerMachineLiveStreamDirectStartRequestV2Schema.parse(request).v).toBe(2);
  });

  it('rejects unknown and mixed-version authorization envelopes', () => {
    expect(PeerMachineLiveStreamDirectStartRequestV2Schema.safeParse({ ...request, extra: true }).success).toBe(false);
    expect(PeerMachineLiveStreamDirectStartRequestV2Schema.safeParse({
      ...request, grant: { ...request.grant, payload: { ...request.grant.payload, v: 1 } },
    }).success).toBe(false);
    expect(PeerMachineLiveStreamDirectStartRequestV2Schema.safeParse({
      ...request, proof: { ...request.proof, v: 1 },
    }).success).toBe(false);
  });
});
