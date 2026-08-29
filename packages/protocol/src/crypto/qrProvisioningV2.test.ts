import { describe, expect, it } from 'vitest';
import { encodeBase64 } from './base64.js';
import {
  HomeQrInviteV2Schema,
  computeHomeQrBindingProofV2,
  computeHomeQrConfirmationCodeV2,
  deriveHomeQrBindingKeyV2,
  deriveHomeQrRendezvousSecretV2,
} from './qrProvisioningV2.js';

describe('Home QR provisioning v2', () => {
  const secret = new Uint8Array(32).fill(7);
  const key = new Uint8Array(32).fill(8);
  const params = { qrSecret: secret, pairId: 'pair-1', homeServerIdentityId: 'srv_home', requesterPublicKey: key, expiresAtMs: 2_000 } as const;

  it('derives domain-separated rendezvous and binding values', () => {
    expect(deriveHomeQrRendezvousSecretV2(secret)).not.toEqual(deriveHomeQrBindingKeyV2(secret));
    expect(computeHomeQrBindingProofV2(params)).toHaveLength(43);
    expect(computeHomeQrConfirmationCodeV2(params)).toMatch(/^\d{6}$/u);
  });

  it('rejects malformed, wrong-intent, and non-32-byte invites', () => {
    const home = { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] };
    expect(HomeQrInviteV2Schema.parse({ v: 2, intent: 'home_device', pairId: 'p', home, qrSecretBase64Url: encodeBase64(secret, 'base64url'), issuedAtMs: 1_000, expiresAtMs: 2_000 })).toBeTruthy();
    expect(HomeQrInviteV2Schema.safeParse({ v: 2, intent: 'account', pairId: 'p', home, qrSecretBase64Url: encodeBase64(secret, 'base64url'), issuedAtMs: 1_000, expiresAtMs: 2_000 }).success).toBe(false);
    expect(HomeQrInviteV2Schema.safeParse({ v: 2, intent: 'home_device', pairId: 'p', home, qrSecretBase64Url: encodeBase64(new Uint8Array(31), 'base64url'), issuedAtMs: 1_000, expiresAtMs: 2_000 }).success).toBe(false);
  });
});
