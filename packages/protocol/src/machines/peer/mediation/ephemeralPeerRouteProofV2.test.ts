import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import type { SignedDirectRouteGrantV2 } from './directRouteGrantV2';
import {
  PeerRouteEphemeralProofV2Schema,
  createEphemeralPeerRouteProofHandleV2,
  createPeerRouteProofSigningInputV2,
  digestSignedDirectRouteGrantV2,
  verifyPeerRouteEphemeralProofV2,
} from './ephemeralPeerRouteProofV2';

const grant = {
  payload: {
    v: 2,
    grantId: 'grant-v2',
    grantFamilyId: 'family-v2',
    accountId: 'account-1',
    machineId: 'machine-1',
    flowKind: 'machine_rpc',
    routeKind: 'loopback_direct',
    scope: {
      kind: 'machine_rpc',
      rpcScopeId: 'machine-1:daemon.getState',
      allowedMethods: ['daemon.getState'],
      maxCalls: 1,
      maxIdleMs: 30_000,
    },
    iat: 1_000,
    exp: 2_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: 'endpoint-1',
    proofKind: 'ephemeral_ed25519',
    ephemeralPublicKeyBase64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  },
  signature: {
    keyId: 'server-key',
    alg: 'Ed25519',
    valueBase64Url: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
  },
} satisfies SignedDirectRouteGrantV2;

describe('ephemeral peer-route proof V2', () => {
  it('creates and verifies one strict proof bound to the complete signed grant digest and nonce', () => {
    const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(length === 32 ? 1 : 2));
    const handle = createEphemeralPeerRouteProofHandleV2({ randomBytes });
    const boundGrant = {
      ...grant,
      payload: { ...grant.payload, ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url },
    } satisfies SignedDirectRouteGrantV2;

    const proof = handle.sign(boundGrant);

    expect(randomBytes).toHaveBeenNthCalledWith(1, 32);
    expect(randomBytes).toHaveBeenNthCalledWith(2, 16);
    expect(PeerRouteEphemeralProofV2Schema.parse(proof)).toEqual(proof);
    expect(verifyPeerRouteEphemeralProofV2({ grant: boundGrant, proof })).toEqual({ valid: true });
    expect(() => handle.sign(boundGrant)).toThrow('peer_route_ephemeral_handle_disposed');
  });

  it('binds the signature to key, complete signed grant digest, and nonce', () => {
    const handle = createEphemeralPeerRouteProofHandleV2({
      randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 3 : 4),
    });
    const boundGrant = {
      ...grant,
      payload: { ...grant.payload, ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url },
    } satisfies SignedDirectRouteGrantV2;
    const proof = handle.sign(boundGrant);

    expect(verifyPeerRouteEphemeralProofV2({
      grant: { ...boundGrant, signature: { ...boundGrant.signature, keyId: 'other-server-key' } },
      proof,
    })).toEqual({ valid: false, reasonCode: 'proof_grant_digest_mismatch' });
    expect(verifyPeerRouteEphemeralProofV2({
      grant: boundGrant,
      proof: { ...proof, nonceBase64Url: 'BQUFBQUFBQUFBQUFBQUFBQ' },
    })).toEqual({ valid: false, reasonCode: 'proof_bad_signature' });
    expect(verifyPeerRouteEphemeralProofV2({
      grant: {
        ...boundGrant,
        payload: {
          ...boundGrant.payload,
          ephemeralPublicKeyBase64Url: 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY',
        },
      },
      proof,
    }).valid).toBe(false);
  });

  it('uses fixed decoded byte lengths and the exact domain-separated signing input', () => {
    const digest = digestSignedDirectRouteGrantV2(grant);
    const nonce = new Uint8Array(16).fill(9);
    const input = createPeerRouteProofSigningInputV2({ digest, nonce });
    expect(digest).toHaveLength(32);
    expect(input).toHaveLength(new TextEncoder().encode('happier-peer-route-proof-v2\0').length + 32 + 16);
    expect(input.slice(-16)).toEqual(nonce);
  });

  it('rejects padded, malformed, and wrong-length proof fields before crypto', () => {
    const signature = new Uint8Array(tweetnacl.sign.signatureLength).fill(7);
    const base = {
      v: 2,
      kind: 'ephemeral_ed25519',
      signedGrantDigestBase64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      nonceBase64Url: 'AgICAgICAgICAgICAgICAg',
      signatureBase64Url: Buffer.from(signature).toString('base64url'),
    };
    expect(PeerRouteEphemeralProofV2Schema.safeParse(base).success).toBe(true);
    expect(PeerRouteEphemeralProofV2Schema.safeParse({
      ...base,
      signedGrantDigestBase64Url: `${base.signedGrantDigestBase64Url}=`,
    }).success).toBe(false);
    expect(PeerRouteEphemeralProofV2Schema.safeParse({
      ...base,
      nonceBase64Url: base.nonceBase64Url.slice(1),
    }).success).toBe(false);
    expect(PeerRouteEphemeralProofV2Schema.safeParse({
      ...base,
      signatureBase64Url: base.signatureBase64Url.replace(/.$/, '+'),
    }).success).toBe(false);
    expect(PeerRouteEphemeralProofV2Schema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it('dispose is idempotent and prevents signing even when signing fails', () => {
    const handle = createEphemeralPeerRouteProofHandleV2({
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });
    expect(() => handle.sign({ ...grant, payload: { ...grant.payload, v: 1 } } as unknown as SignedDirectRouteGrantV2))
      .toThrow();
    expect(() => handle.sign(grant)).toThrow('peer_route_ephemeral_handle_disposed');
    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });
});
