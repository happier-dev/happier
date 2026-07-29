import { describe, expect, it } from 'vitest';

import { PEER_TCP_TUNNEL_OPEN_PATH_V2, PeerTcpTunnelOpenV2Schema } from './openAuthorizationV2';

const key32 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const signature64 = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg';
const open = {
  v: 2, kind: 'open', tunnelId: 'tunnel-1', targetMachineId: 'machine-1', routeKind: 'loopback_direct',
  destination: { host: '127.0.0.1', port: 12_345 },
  grant: {
    payload: {
      v: 2, grantId: 'grant-1', accountId: 'account-1', machineId: 'machine-1', flowKind: 'tcp_tunnel',
      routeKind: 'loopback_direct', scope: { kind: 'tcp_tunnel', tunnelId: 'tunnel-1', allowedPorts: [12_345], maxIdleMs: 1_000, maxDurationMs: 5_000 },
      iat: 1_000, exp: 2_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint-1',
      proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: key32,
    },
    signature: { keyId: 'server-key', alg: 'Ed25519', valueBase64Url: signature64 },
  },
  proof: { v: 2, kind: 'ephemeral_ed25519', signedGrantDigestBase64Url: key32, nonceBase64Url: 'AwMDAwMDAwMDAwMDAwMDAw', signatureBase64Url: signature64 },
} as const;

describe('PeerTcpTunnelOpenV2', () => {
  it('uses a strict proof-authorized open path without changing tunnel framing', () => {
    expect(PEER_TCP_TUNNEL_OPEN_PATH_V2).toBe('/peer-mediation/v2/tunnel/open');
    expect(PeerTcpTunnelOpenV2Schema.parse(open).v).toBe(2);
  });
  it('rejects unknown fields and mixed authorization versions', () => {
    expect(PeerTcpTunnelOpenV2Schema.safeParse({ ...open, extra: true }).success).toBe(false);
    expect(PeerTcpTunnelOpenV2Schema.safeParse({ ...open, grant: { ...open.grant, payload: { ...open.grant.payload, v: 1 } } }).success).toBe(false);
    expect(PeerTcpTunnelOpenV2Schema.safeParse({ ...open, proof: { ...open.proof, v: 1 } }).success).toBe(false);
  });
});
