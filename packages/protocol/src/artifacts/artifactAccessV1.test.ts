import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessGrantRowV1Schema, ArtifactAccessGrantsListResponseV1Schema,
  ArtifactRecipientKeyEnvelopeInputV1Schema } from './artifactAccessV1.js';

describe('Artifact grant mutation contract', () => {
  it('preserves the canonical nullable display label of an unnamed Account', () => {
    const grant = {
      principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', createdByAccountId: 'owner',
      createdAt: 0, display: { name: null, username: null },
    };
    expect(ArtifactAccessGrantRowV1Schema.parse(grant)).toEqual(grant);
    expect(ArtifactAccessGrantRowV1Schema.safeParse({ ...grant, display: { name: 42 } }).success).toBe(false);
    expect(ArtifactAccessGrantRowV1Schema.safeParse({ ...grant, display: { name: null, unrelated: true } }).success).toBe(false);
  });

  it('accepts a committed revocation without access and rejects a disclosed roster in that response', () => {
    const revoked = { artifactId: 'artifact', ownerAccountId: 'owner', access: null, grants: [], changed: true };
    expect(ArtifactAccessGrantMutationResponseV1Schema.parse(revoked)).toEqual(revoked);
    const { changed: _changed, ...unavailableList } = revoked;
    expect(ArtifactAccessGrantsListResponseV1Schema.safeParse(unavailableList).success).toBe(false);
    expect(ArtifactAccessGrantMutationResponseV1Schema.safeParse({ ...revoked, grants: [{
      principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', createdByAccountId: 'owner',
      createdAt: 0, display: { name: 'Recipient' },
    }] }).success).toBe(false);
  });
});

describe('Artifact recipient envelope contract', () => {
  it('accepts the canonical content-key fingerprint and rejects an unqualified digest', () => {
    const fingerprint = computeContentPublicKeyFingerprint(new Uint8Array(32).fill(1));
    const envelope = { recipientAccountId: 'recipient', encryptedDataKey: encodeBase64(new Uint8Array(105)), recipientContentPublicKeyFingerprint: fingerprint };
    expect(ArtifactRecipientKeyEnvelopeInputV1Schema.safeParse(envelope).success).toBe(true);
    expect(ArtifactRecipientKeyEnvelopeInputV1Schema.safeParse({ ...envelope, recipientContentPublicKeyFingerprint: '0'.repeat(64) }).success).toBe(false);
  });
});
