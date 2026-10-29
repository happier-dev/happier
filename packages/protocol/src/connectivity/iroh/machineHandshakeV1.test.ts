import { describe, expect, it } from 'vitest';

import {
  IROH_MACHINE_CARRIER_FLOWS_V1,
  IROH_MACHINE_HANDSHAKE_VERSION_V1,
  IrohMachineHandshakeV1Schema,
  parseIrohMachineHandshakeV1,
  type IrohMachineHandshakeV1,
} from './machineHandshakeV1.js';

const SOURCE_ENDPOINT_ID = 'a'.repeat(64);
const TARGET_ENDPOINT_ID = 'b'.repeat(64);
/** Canonical unpadded base64url placeholders with the exact decoded lengths the schemas require. */
const EPHEMERAL_PUBLIC_KEY = 'A'.repeat(43); // 32 bytes
const GRANT_SIGNATURE = 'A'.repeat(86); // 64 bytes
const PROOF_DIGEST = 'A'.repeat(43); // 32 bytes
const PROOF_NONCE = 'A'.repeat(22); // 16 bytes
const PROOF_SIGNATURE = 'A'.repeat(86); // 64 bytes

function grantPayload() {
  return {
    v: 2 as const,
    grantId: 'grant-1',
    accountId: 'account-1',
    machineId: 'machine-2',
    flowKind: 'bounded_transfer' as const,
    routeKind: 'iroh_peer' as const,
    scope: {
      kind: 'bounded_transfer' as const,
      mode: 'carrier' as const,
    },
    iat: 1_000,
    exp: 10_000,
    aud: 'happier-daemon-route-grant' as const,
    endpointFingerprint: TARGET_ENDPOINT_ID,
    iroh: {
      initiator: {
        kind: 'machine' as const,
        machineId: 'machine-1',
        endpointId: SOURCE_ENDPOINT_ID,
      },
      target: {
        machineId: 'machine-2',
        endpointId: TARGET_ENDPOINT_ID,
      },
      operationKind: 'finite_transfer' as const,
    },
    proofKind: 'ephemeral_ed25519' as const,
    ephemeralPublicKeyBase64Url: EPHEMERAL_PUBLIC_KEY,
  };
}

function grant() {
  return {
    payload: grantPayload(),
    signature: {
      keyId: 'key-1',
      alg: 'Ed25519' as const,
      valueBase64Url: GRANT_SIGNATURE,
    },
  };
}

function proof() {
  return {
    v: 2 as const,
    kind: 'ephemeral_ed25519' as const,
    signedGrantDigestBase64Url: PROOF_DIGEST,
    nonceBase64Url: PROOF_NONCE,
    signatureBase64Url: PROOF_SIGNATURE,
  };
}

function handshake(overrides: Partial<IrohMachineHandshakeV1> = {}): IrohMachineHandshakeV1 {
  return {
    v: 1,
    accountId: 'account-1',
    initiator: {
      kind: 'machine',
      machineId: 'machine-1',
      endpointId: SOURCE_ENDPOINT_ID,
    },
    target: {
      machineId: 'machine-2',
      endpointId: TARGET_ENDPOINT_ID,
    },
    flow: 'finite_transfer',
    grant: grant(),
    proof: proof(),
    ...overrides,
  };
}

describe('IrohMachineHandshakeV1 (canonical happier/machine/1 handshake)', () => {
  it('admits the existing signed TCP tunnel scope without adding a destination authority', () => {
    const original = handshake();
    const tunnel = {
      ...original,
      flow: 'tcp_tunnel',
      grant: {
        ...original.grant,
        payload: {
          ...original.grant.payload,
          flowKind: 'tcp_tunnel',
          scope: { kind: 'tcp_tunnel', tunnelId: 'tunnel-1', allowedPorts: [3000], },
          iroh: { ...original.grant.payload.iroh!, operationKind: 'tcp_tunnel' },
        },
      },
    };
    expect(IrohMachineHandshakeV1Schema.safeParse(tunnel).success).toBe(true);
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...tunnel, destination: { host: '127.0.0.1', port: 3000 } }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...tunnel,
      grant: { ...tunnel.grant, payload: { ...tunnel.grant.payload, flowKind: 'bounded_transfer', scope: original.grant.payload.scope } },
    }).success).toBe(false);
  });

  it('exposes the closed v1 wire version, carrier flows, and strict shape', () => {
    expect(IROH_MACHINE_HANDSHAKE_VERSION_V1).toBe(1);
    expect(IROH_MACHINE_CARRIER_FLOWS_V1).toEqual(['finite_transfer', 'workspace_sync', 'tcp_tunnel']);
    expect(IrohMachineHandshakeV1Schema.parse(handshake())).toEqual(handshake());
  });

  it('rejects any handshake identity, orientation, or purpose binding that differs from its signed grant', () => {
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      initiator: { kind: 'machine', machineId: 'machine-inverted', endpointId: SOURCE_ENDPOINT_ID },
    }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      initiator: { kind: 'account_client', endpointId: SOURCE_ENDPOINT_ID },
    }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      grant: {
        ...grant(),
        payload: { ...grantPayload(), accountId: 'account-other' },
      },
    }).success).toBe(false);
  });

  it('rejects unknown fields, wrong versions, and missing grant or proof material', () => {
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), extra: true }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), v: 2 }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), grant: undefined }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), proof: undefined }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      grant: { ...grant(), payload: { ...grantPayload(), v: 1 } },
    }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      proof: { ...proof(), v: 1 },
    }).success).toBe(false);
  });

  it('rejects malformed endpoint identities, roles, and flows', () => {
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      initiator: { kind: 'machine', machineId: 'machine-1', endpointId: 'endpoint-1' },
    }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...handshake(),
      target: { machineId: 'machine-2', endpointId: 'A'.repeat(64) },
    }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), flow: 'file_transfer' }).success).toBe(false);
  });

  it('supports an authenticated Account client initiator without source Machine fields', () => {
    const accountClient = handshake({
      initiator: { kind: 'account_client', endpointId: SOURCE_ENDPOINT_ID },
      grant: {
        ...grant(),
        payload: {
          ...grantPayload(),
          iroh: {
            initiator: { kind: 'account_client', endpointId: SOURCE_ENDPOINT_ID },
            target: { machineId: 'machine-2', endpointId: TARGET_ENDPOINT_ID },
            operationKind: 'finite_transfer',
          },
        },
      },
    });

    expect(IrohMachineHandshakeV1Schema.parse(accountClient).initiator).toEqual({
      kind: 'account_client',
      endpointId: SOURCE_ENDPOINT_ID,
    });
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...accountClient,
      sourceMachineId: 'pseudo-machine',
    }).success).toBe(false);
  });

  it('does not carry transfer operation or byte authority in the finite-transfer handshake', () => {
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), operationId: 'transfer-1' }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({ ...handshake(), maxBytes: 1_024 }).success).toBe(false);
  });

  it('retains the consumed signed operation binding for workspace sync', () => {
    const workspaceGrant = {
      ...grant(),
      payload: {
        ...grantPayload(),
        flowKind: 'machine_rpc' as const,
        scope: {
          kind: 'machine_rpc' as const,
          rpcScopeId: 'workspace-1',
          allowedMethods: ['workspace.sync'],
          maxCalls: 1,
          maxIdleMs: 1_000,
        },
        iroh: {
          ...grantPayload().iroh,
          operationKind: 'workspace_sync' as const,
        },
      },
    };
    const workspaceHandshake = {
      ...handshake(),
      flow: 'workspace_sync' as const,
      operationId: 'workspace-1',
      grant: workspaceGrant,
    };

    expect(IrohMachineHandshakeV1Schema.parse(workspaceHandshake).operationId).toBe('workspace-1');
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...workspaceHandshake,
      operationId: 'workspace-other',
    }).success).toBe(false);
    expect(IrohMachineHandshakeV1Schema.safeParse({
      ...workspaceHandshake,
      operationId: undefined,
    }).success).toBe(false);
  });

  it('parses strictly through the canonical helper and throws on invalid input', () => {
    expect(parseIrohMachineHandshakeV1(handshake())).toEqual(handshake());
    expect(() => parseIrohMachineHandshakeV1({ ...handshake(), extra: true })).toThrow(TypeError);
    expect(() => parseIrohMachineHandshakeV1(null)).toThrow(TypeError);
  });
});
