import { describe, expect, it } from 'vitest';

import {
  DirectRouteGrantPayloadV1Schema,
  SignedDirectRouteGrantV1Schema,
  createDirectRouteGrantSigningInputV1,
} from './directRouteGrantV1';

const basePayload = {
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
  endpointFingerprint: 'endpoint_1',
} as const;

describe('DirectRouteGrantV1', () => {
  it('accepts a signed bounded-transfer direct-route grant', () => {
    const parsed = SignedDirectRouteGrantV1Schema.parse({
      payload: basePayload,
      signature: {
        keyId: 'key_1',
        alg: 'Ed25519',
        valueBase64Url: 'AbCdEf012_-',
      },
    });

    expect(parsed.payload.routeKind).toBe('loopback_direct');
    expect(parsed.payload.scope.kind).toBe('bounded_transfer');
  });

  it('rejects server relay route grants', () => {
    const result = DirectRouteGrantPayloadV1Schema.safeParse({
      ...basePayload,
      routeKind: 'server_relay',
    });

    expect(result.success).toBe(false);
  });

  it('rejects grants whose scope kind or expiry window does not match the payload binding', () => {
    expect(DirectRouteGrantPayloadV1Schema.safeParse({
      ...basePayload,
      scope: {
        kind: 'tcp_tunnel',
        tunnelId: 'tunnel_1',
        allowedPorts: [3000],
        maxIdleMs: 30_000,
        maxDurationMs: 600_000,
      },
    }).success).toBe(false);

    expect(DirectRouteGrantPayloadV1Schema.safeParse({
      ...basePayload,
      exp: basePayload.iat,
    }).success).toBe(false);
  });

  it('accepts scoped bounded-transfer limits without authorizing arbitrary transfer tokens', () => {
    const parsed = DirectRouteGrantPayloadV1Schema.parse({
      ...basePayload,
      scope: {
        kind: 'bounded_transfer',
        mode: 'scope',
        transferScopeId: 'scope_1',
        allowedTransferIdPrefix: 'upload_',
        maxTransfers: 3,
        maxBytesPerTransfer: 1024,
        maxTotalBytes: 2048,
        maxIdleMs: 30_000,
      },
    });

    expect(parsed.scope).toEqual({
      kind: 'bounded_transfer',
      mode: 'scope',
      transferScopeId: 'scope_1',
      allowedTransferIdPrefix: 'upload_',
      maxTransfers: 3,
      maxBytesPerTransfer: 1024,
      maxTotalBytes: 2048,
      maxIdleMs: 30_000,
    });
  });

  it('accepts a daemon Voice STT scope without granting generic TCP ports', () => {
    const parsed = DirectRouteGrantPayloadV1Schema.parse({
      ...basePayload,
      flowKind: 'voice_media',
      scope: {
        kind: 'voice_media',
        tunnelId: 'voice-tunnel-1',
        applicationKind: 'speech_transcription',
        applicationAttemptId: 'attempt-1',
        applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
        maxIdleMs: 30_000,
        maxDurationMs: 600_000,
        maxTotalBytes: 8_388_608,
      },
    });

    expect(parsed.scope).toEqual({
      kind: 'voice_media',
      tunnelId: 'voice-tunnel-1',
      applicationKind: 'speech_transcription',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
      maxIdleMs: 30_000,
      maxDurationMs: 600_000,
      maxTotalBytes: 8_388_608,
    });
    expect('allowedPorts' in parsed.scope).toBe(false);
  });

  it('creates deterministic canonical signing input independent of insertion order', () => {
    const reorderedPayload = {
      exp: basePayload.exp,
      iat: basePayload.iat,
      endpointFingerprint: basePayload.endpointFingerprint,
      scope: {
        transferId: 'transfer_1',
        mode: 'single',
        maxBytes: 1024,
        kind: 'bounded_transfer',
      },
      aud: basePayload.aud,
      routeKind: basePayload.routeKind,
      flowKind: basePayload.flowKind,
      machineId: basePayload.machineId,
      accountId: basePayload.accountId,
      grantFamilyId: basePayload.grantFamilyId,
      grantId: basePayload.grantId,
      v: 1,
    } as const;

    expect(createDirectRouteGrantSigningInputV1(basePayload)).toBe(
      createDirectRouteGrantSigningInputV1(reorderedPayload),
    );
    expect(createDirectRouteGrantSigningInputV1(basePayload)).toBe(
      '{"accountId":"account_1","aud":"happier-daemon-route-grant","endpointFingerprint":"endpoint_1","exp":601000,"flowKind":"bounded_transfer","grantFamilyId":"family_1","grantId":"grant_1","iat":1000,"machineId":"machine_1","routeKind":"loopback_direct","scope":{"kind":"bounded_transfer","maxBytes":1024,"mode":"single","transferId":"transfer_1"},"v":1}',
    );
  });
});
