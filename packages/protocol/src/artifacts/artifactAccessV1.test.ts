import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessGrantRowV1Schema, ArtifactAccessGrantsListResponseV1Schema,
  ArtifactRecipientKeyEnvelopeInputV1Schema, ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema } from './artifactAccessV1.js';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '../storage/artifactStoredContent.js';

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

describe('Artifact selected HTTP read contract', () => {
  it('requires the read owner classification instead of guessing retryability from a refusal code', () => {
    const refusal = { artifactId: 'artifact', ok: false, error: 'artifact_content_unavailable' };
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [refusal] }).success).toBe(false);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...refusal, status: 409, retryable: false }] }).success).toBe(true);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...refusal, status: 500, retryable: true }] }).success).toBe(true);
  });

  it('binds each detail to its addressed identity and requires encrypted recipient custody', () => {
    const artifact = { id: 'artifact', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: 'opaque', headerVersion: 1, body: 'opaque', bodyVersion: 1, publicAudience: 'none',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 1 };
    const item = { artifactId: artifact.id, ok: true, artifact, recipientCensus: null };
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [item] }).success).toBe(true);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item, artifactId: 'other' }] }).success).toBe(false);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item,
      artifact: { ...artifact, encryptionMode: 'e2ee' } }] }).success).toBe(false);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item,
      artifact: { ...artifact, authority: 'owner' } }] }).success).toBe(false);
    expect(ArtifactReadBatchInputV1Schema.safeParse({ artifactIds: ['artifact', 'artifact'] }).success).toBe(false);
  });
});
