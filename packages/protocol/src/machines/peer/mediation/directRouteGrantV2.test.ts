import { describe, expect, it } from 'vitest';

import {
  DirectRouteGrantPayloadV2Schema,
  DirectRouteGrantRequestV2Schema,
  SignedDirectRouteGrantV2Schema,
  createDirectRouteGrantSigningInputV2,
  type IrohPeerRouteBindingV2,
} from './directRouteGrantV2';

const publicKeyBase64Url = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const sourceEndpointId = 'a'.repeat(64);
const targetEndpointId = 'b'.repeat(64);

const irohBinding: IrohPeerRouteBindingV2 = {
  initiator: {
    kind: 'machine',
    machineId: 'machine-source',
    endpointId: sourceEndpointId,
  },
  target: {
    machineId: 'machine-target',
    endpointId: targetEndpointId,
  },
  operationKind: 'finite_transfer',
};

function payload() {
  return {
    v: 2 as const,
    grantId: 'grant-v2',
    grantFamilyId: 'family-v2',
    accountId: 'account-1',
    machineId: 'machine-1',
    flowKind: 'machine_rpc' as const,
    routeKind: 'loopback_direct' as const,
    scope: {
      kind: 'machine_rpc' as const,
      rpcScopeId: 'machine-1:daemon.getState',
      allowedMethods: ['daemon.getState'],
      maxCalls: 1,
      maxIdleMs: 30_000,
    },
    iat: 1_000,
    exp: 2_000,
    aud: 'happier-daemon-route-grant' as const,
    endpointFingerprint: 'endpoint-1',
    proofKind: 'ephemeral_ed25519' as const,
    ephemeralPublicKeyBase64Url: publicKeyBase64Url,
  };
}

describe('DirectRouteGrantV2', () => {
  it('retains the exact managed export occurrence and loopback destination in signed TCP authority', () => {
    const serviceExport = {
      exportKey: 'postgres',
      service: { kind: 'deployment', machineId: 'machine-target', environmentId: 'environment',
        environmentInstanceId: 'instance', composeService: 'db', serviceId: 'instance/db' },
      installationId: 'installation', deploymentId: 'deployment', generation: 'generation',
      destination: { host: '127.0.0.1', port: 5432 },
    };
    const input = {
      ...payload(), machineId: 'machine-target', flowKind: 'tcp_tunnel', routeKind: 'iroh_peer',
      endpointFingerprint: targetEndpointId,
      iroh: { ...irohBinding, operationKind: 'tcp_tunnel' },
      scope: { kind: 'tcp_tunnel', tunnelId: 'service-tunnel', allowedPorts: [5432], serviceExport },
    };
    const parsed = DirectRouteGrantPayloadV2Schema.parse(input);
    expect(parsed.scope).toEqual(input.scope);
    const signingInput = createDirectRouteGrantSigningInputV2(parsed);
    const changed = DirectRouteGrantPayloadV2Schema.parse({ ...input, scope: {
      ...input.scope, serviceExport: { ...serviceExport, generation: 'replacement' },
    } });
    expect(createDirectRouteGrantSigningInputV2(changed)).not.toEqual(signingInput);
    for (const destination of [{ host: '192.168.1.1', port: 5432 }, { host: '127.0.0.1', port: 6379 }]) {
      expect(DirectRouteGrantPayloadV2Schema.safeParse({ ...input, scope: {
        ...input.scope, serviceExport: { ...serviceExport, destination },
      } }).success).toBe(false);
    }
    expect(DirectRouteGrantPayloadV2Schema.safeParse({ ...input, scope: {
      ...input.scope, allowedPorts: [5432, 6379],
    } }).success).toBe(false);
    expect(DirectRouteGrantPayloadV2Schema.safeParse({ ...input, scope: {
      ...input.scope, serviceExport: { ...serviceExport, service: { ...serviceExport.service, machineId: 'other-machine' } },
    } }).success).toBe(false);
  });

  it('requires and signs the canonical machine/1 binding on iroh_peer requests and payloads', () => {
    const scope = {
      kind: 'bounded_transfer' as const,
      mode: 'carrier' as const,
    };
    const request = {
      v: 2 as const,
      kind: 'ephemeral_ed25519' as const,
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: irohBinding.target.machineId,
      flowKind: 'bounded_transfer' as const,
      routeKind: 'iroh_peer' as const,
      endpointFingerprint: targetEndpointId,
      ttlMs: 1_000,
      scope,
      iroh: irohBinding,
    };
    const grantPayload = {
      ...request,
      grantId: 'grant-iroh-v2',
      accountId: 'account-1',
      iat: 1_000,
      exp: 2_000,
      aud: 'happier-daemon-route-grant' as const,
      proofKind: 'ephemeral_ed25519' as const,
    };
    const { kind: _kind, ttlMs: _ttlMs, ...payloadFields } = grantPayload;
    void _kind;
    void _ttlMs;

    expect(DirectRouteGrantRequestV2Schema.parse(request).iroh).toEqual(irohBinding);
    expect(DirectRouteGrantPayloadV2Schema.parse(payloadFields).iroh).toEqual(irohBinding);
    expect(DirectRouteGrantRequestV2Schema.safeParse({ ...request, iroh: undefined }).success).toBe(false);
    expect(DirectRouteGrantPayloadV2Schema.safeParse({ ...payloadFields, iroh: undefined }).success).toBe(false);
    expect(DirectRouteGrantPayloadV2Schema.safeParse({
      ...payloadFields,
      machineId: irohBinding.initiator.kind === 'machine'
        ? irohBinding.initiator.machineId
        : 'unexpected-account-client',
    }).success).toBe(false);
  });

  it('owns the strict machine/1 binding validation on V2', () => {
    const request = {
      v: 2 as const,
      kind: 'ephemeral_ed25519' as const,
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: irohBinding.target.machineId,
      flowKind: 'bounded_transfer' as const,
      routeKind: 'iroh_peer' as const,
      endpointFingerprint: targetEndpointId,
      ttlMs: 1_000,
      scope: {
        kind: 'bounded_transfer' as const,
        mode: 'carrier' as const,
      },
      iroh: irohBinding,
    };

    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      iroh: { ...irohBinding, initiator: { ...irohBinding.initiator, kind: 'browser' } },
    }).success).toBe(false);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      iroh: { ...irohBinding, operationKind: 'tcp_tunnel' },
    }).success).toBe(false);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      iroh: { ...irohBinding, target: { ...irohBinding.target, endpointId: sourceEndpointId } },
    }).success).toBe(false);
  });

  it('admits an authenticated Account client without inventing a source Machine', () => {
    const accountClientBinding: IrohPeerRouteBindingV2 = {
      initiator: { kind: 'account_client', endpointId: sourceEndpointId },
      target: { machineId: 'machine-target', endpointId: targetEndpointId },
      operationKind: 'finite_transfer',
    };
    const request = {
      v: 2 as const,
      kind: 'ephemeral_ed25519' as const,
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: accountClientBinding.target.machineId,
      flowKind: 'bounded_transfer' as const,
      routeKind: 'iroh_peer' as const,
      endpointFingerprint: accountClientBinding.target.endpointId,
      ttlMs: 1_000,
      scope: {
        kind: 'bounded_transfer' as const,
        mode: 'carrier' as const,
      },
      iroh: accountClientBinding,
    };

    expect(DirectRouteGrantRequestV2Schema.parse(request).iroh).toEqual(accountClientBinding);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      iroh: {
        ...accountClientBinding,
        initiator: { ...accountClientBinding.initiator, machineId: 'pseudo-machine' },
      },
    }).success).toBe(false);
  });

  it('rejects operation and byte claims on a finite-transfer carrier grant', () => {
    const request = {
      v: 2 as const,
      kind: 'ephemeral_ed25519' as const,
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: irohBinding.target.machineId,
      flowKind: 'bounded_transfer' as const,
      routeKind: 'iroh_peer' as const,
      endpointFingerprint: targetEndpointId,
      ttlMs: 1_000,
      scope: {
        kind: 'bounded_transfer' as const,
        mode: 'carrier' as const,
      },
      iroh: irohBinding,
    };

    expect(DirectRouteGrantRequestV2Schema.parse(request).scope).toEqual({
      kind: 'bounded_transfer',
      mode: 'carrier',
    });
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      scope: { ...request.scope, transferId: 'transfer-1' },
    }).success).toBe(false);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      scope: { ...request.scope, maxBytes: 1_024 },
    }).success).toBe(false);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      ...request,
      iroh: { ...irohBinding, operationKind: 'file_transfer' },
    }).success).toBe(false);
  });

  it('rejects Account-client workspace sync because that operation requires a Machine initiator', () => {
    const accountClientWorkspaceBinding: IrohPeerRouteBindingV2 = {
      initiator: { kind: 'account_client', endpointId: sourceEndpointId },
      target: { machineId: 'machine-target', endpointId: targetEndpointId },
      operationKind: 'workspace_sync',
    };

    expect(DirectRouteGrantRequestV2Schema.safeParse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: accountClientWorkspaceBinding.target.machineId,
      flowKind: 'machine_rpc',
      routeKind: 'iroh_peer',
      endpointFingerprint: accountClientWorkspaceBinding.target.endpointId,
      ttlMs: 1_000,
      scope: {
        kind: 'machine_rpc',
        rpcScopeId: 'workspace-sync-1',
        allowedMethods: ['daemon.memory.status'],
        maxCalls: 1,
        maxIdleMs: 1_000,
      },
      iroh: accountClientWorkspaceBinding,
    }).success).toBe(false);
  });

  it('parses a complete strict V2 request and signed grant without changing V1', () => {
    expect(DirectRouteGrantRequestV2Schema.parse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: 'machine-1',
      flowKind: 'machine_rpc',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint-1',
      ttlMs: 1_000,
      scope: payload().scope,
    })).toMatchObject({ v: 2, kind: 'ephemeral_ed25519' });

    expect(SignedDirectRouteGrantV2Schema.parse({
      payload: payload(),
      signature: {
        keyId: 'server-key',
        alg: 'Ed25519',
        valueBase64Url: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
      },
    }).payload.ephemeralPublicKeyBase64Url).toBe(publicKeyBase64Url);
  });

  it('rejects unknown fields and non-canonical or wrong-length base64url values', () => {
    expect(DirectRouteGrantPayloadV2Schema.safeParse({ ...payload(), extra: true }).success).toBe(false);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: `${publicKeyBase64Url}=`,
      machineId: 'machine-1',
      flowKind: 'machine_rpc',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint-1',
      ttlMs: 1_000,
      scope: payload().scope,
    }).success).toBe(false);
    expect(DirectRouteGrantPayloadV2Schema.safeParse({
      ...payload(),
      ephemeralPublicKeyBase64Url: publicKeyBase64Url.slice(1),
    }).success).toBe(false);
    expect(DirectRouteGrantRequestV2Schema.safeParse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: 'machine-1',
      flowKind: 'machine_rpc',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint-1',
      ttlMs: 1_000,
      scope: { ...payload().scope, extra: true },
    }).success).toBe(false);
  });

  it('canonicalizes every parsed V2 grant binding', () => {
    const reordered = {
      proofKind: 'ephemeral_ed25519' as const,
      endpointFingerprint: 'endpoint-1',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      aud: 'happier-daemon-route-grant' as const,
      exp: 2_000,
      iat: 1_000,
      scope: payload().scope,
      routeKind: 'loopback_direct' as const,
      flowKind: 'machine_rpc' as const,
      machineId: 'machine-1',
      accountId: 'account-1',
      grantFamilyId: 'family-v2',
      grantId: 'grant-v2',
      v: 2 as const,
    };
    expect(createDirectRouteGrantSigningInputV2(reordered)).toBe(
      createDirectRouteGrantSigningInputV2(payload()),
    );
  });

  it('binds the closed Voice media application authority to the signed grant scope', () => {
    const scope = {
      kind: 'voice_media' as const,
      tunnelId: 'voice-tunnel-1',
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
    };
    expect(DirectRouteGrantRequestV2Schema.parse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: 'machine-1',
      flowKind: 'voice_media',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint-1',
      ttlMs: 1_000,
      scope,
    }).scope).toEqual(scope);

    expect(DirectRouteGrantRequestV2Schema.safeParse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: 'machine-1',
      flowKind: 'tcp_tunnel',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint-1',
      ttlMs: 1_000,
      scope,
    }).success).toBe(false);

    expect(DirectRouteGrantRequestV2Schema.safeParse({
      v: 2,
      kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: publicKeyBase64Url,
      machineId: 'machine-1',
      flowKind: 'voice_media',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint-1',
      ttlMs: 1_000,
      scope: {
        ...scope,
        applicationKind: 'agent_realtime',
      },
    }).success).toBe(false);
  });
});
