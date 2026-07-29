import { describe, expect, it } from 'vitest';

import {
  PEER_MACHINE_RPC_DIRECT_PATH_V2,
  PeerMachineRpcDirectRequestV2Schema,
  PeerMachineRpcDirectResponseV2Schema,
} from './directV2';
import { PEER_MEDIATION_RECEIPTS } from '../receipts';

const request = {
  v: 2,
  requestId: 'request-1',
  method: 'daemon.memory.status',
  params: {},
  grant: {
    payload: {
      v: 2,
      grantId: 'grant-1',
      accountId: 'account-1',
      machineId: 'machine-1',
      flowKind: 'machine_rpc',
      routeKind: 'loopback_direct',
      scope: {
        kind: 'machine_rpc', rpcScopeId: 'rpc-1', allowedMethods: ['daemon.memory.status'],
        maxCalls: 1, maxIdleMs: 1_000,
      },
      iat: 1_000,
      exp: 2_000,
      aud: 'happier-daemon-route-grant',
      endpointFingerprint: 'endpoint-1',
      proofKind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    },
    signature: {
      keyId: 'server-key', alg: 'Ed25519',
      valueBase64Url: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
    },
  },
  proof: {
    v: 2,
    kind: 'ephemeral_ed25519',
    signedGrantDigestBase64Url: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    nonceBase64Url: 'BAQEBAQEBAQEBAQEBAQEBA',
    signatureBase64Url: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQ',
  },
  routeKind: 'loopback_direct',
  flowKind: 'machine_rpc',
  endpointFingerprint: 'endpoint-1',
} as const;

describe('PeerMachineRpcDirectV2', () => {
  it('uses a strict versioned RPC request and response path', () => {
    expect(PEER_MACHINE_RPC_DIRECT_PATH_V2).toBe('/peer-mediation/v2/rpc');
    expect(PeerMachineRpcDirectRequestV2Schema.parse(request).v).toBe(2);
    expect(PeerMachineRpcDirectResponseV2Schema.parse({
      v: 2,
      ok: true,
      receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
      requestId: 'request-1',
      method: 'daemon.memory.status',
      routeKind: 'loopback_direct',
      result: {},
    }).ok).toBe(true);
  });

  it('rejects unknown fields and mixed V1/V2 grant or proof shapes', () => {
    expect(PeerMachineRpcDirectRequestV2Schema.safeParse({ ...request, extra: true }).success).toBe(false);
    expect(PeerMachineRpcDirectRequestV2Schema.safeParse({
      ...request,
      grant: { ...request.grant, payload: { ...request.grant.payload, v: 1 } },
    }).success).toBe(false);
    expect(PeerMachineRpcDirectRequestV2Schema.safeParse({
      ...request,
      proof: { ...request.proof, v: 1 },
    }).success).toBe(false);
  });
});
