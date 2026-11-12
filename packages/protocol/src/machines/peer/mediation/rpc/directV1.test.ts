import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '../../../../rpc/index.js';

const baseGrant = {
  payload: {
    v: 1,
    grantId: 'grant_1',
    grantFamilyId: 'family_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'machine_rpc',
    routeKind: 'loopback_direct',
    scope: {
      kind: 'machine_rpc',
      rpcScopeId: 'rpc_scope_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
      maxIdleMs: 10_000,
    },
    iat: 1_000,
    exp: 601_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: 'endpoint_1',
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
  flowKind: 'machine_rpc',
  endpointFingerprint: 'endpoint_1',
  nonceBase64Url: 'nonce_1',
  signatureBase64Url: 'AbCdEf012_-',
} as const;

async function importRpcProtocol() {
  return await import('./index').catch((error: unknown) => ({ importError: error }));
}

describe('PeerMachineRpcDirectV1', () => {
  it('validates direct machine RPC envelopes', async () => {
    const protocol = await importRpcProtocol();
    expect(protocol).toHaveProperty('PeerMachineRpcDirectRequestV1Schema');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.PeerMachineRpcDirectRequestV1Schema.parse({
      v: 1,
      requestId: 'request_1',
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
      params: { includeWorkers: true },
      grant: baseGrant,
      nonceProof: baseNonceProof,
      routeKind: 'loopback_direct',
      flowKind: 'machine_rpc',
      endpointFingerprint: 'endpoint_1',
    }).requestId).toBe('request_1');
  });

  it('validates direct success and fallback receipts through the peer mediation receipt catalog', async () => {
    const protocol = await importRpcProtocol();
    expect(protocol).toHaveProperty('PeerMachineRpcDirectResponseV1Schema');
    if ('importError' in protocol) throw protocol.importError;

    expect(protocol.PeerMachineRpcDirectResponseV1Schema.parse({
      v: 1,
      ok: true,
      receipt: 'peer.rpc.direct_call_succeeded',
      requestId: 'request_1',
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
      routeKind: 'loopback_direct',
      result: { status: 'ready' },
    }).receipt).toBe('peer.rpc.direct_call_succeeded');

    expect(protocol.PeerMachineRpcDirectResponseV1Schema.parse({
      v: 1,
      ok: false,
      receipt: 'peer.rpc.fell_back_to_server',
      requestId: 'request_1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      reasonCode: 'server_required',
    }).reasonCode).toBe('server_required');
  });
});
