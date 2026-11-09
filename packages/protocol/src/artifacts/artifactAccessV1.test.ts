import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { ArtifactAccessActionOutputSchemasV1, ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessGrantRowV1Schema, ArtifactAccessGrantsListResponseV1Schema,
  ArtifactRecipientKeyEnvelopeInputV1Schema, ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema,
  ArtifactHttpReadV1Schema, ArtifactReadBatchHttpInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from './artifactAccessV1.js';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '../storage/artifactStoredContent.js';

describe('Artifact grant mutation contract', () => {
  it('accepts private-copy-free accepted version summaries on Artifact grant rows', () => {
    const row = { principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', createdByAccountId: 'owner',
      createdAt: 1, display: { name: null }, acceptedVersions: [{ version: '1.0.0', copies: 2, reportedAt: 1 }] };
    expect(ArtifactAccessGrantRowV1Schema.safeParse(row).success).toBe(true);
    expect(ArtifactAccessGrantRowV1Schema.safeParse({ ...row,
      acceptedVersions: [{ version: 'not a version', copies: 2, reportedAt: 1 }] }).success).toBe(false);
    expect(ArtifactAccessGrantRowV1Schema.safeParse({ ...row,
      acceptedVersions: [{ version: '1.0.0', copies: 2, reportedAt: 1, copyId: 'private' }] }).success).toBe(false);
  });
  it('retains a committed mutation receipt with pending recipient preparation through the Action output', () => {
    const receipt = { artifactId: 'artifact', ownerAccountId: 'owner', access: 'owner', grants: [], changed: true,
      preparation: { status: 'pending' } };
    for (const action of ['artifact.access.grants.set', 'artifact.access.grants.remove'] as const) {
      expect(ArtifactAccessActionOutputSchemasV1[action].parse(receipt)).toEqual(receipt);
      expect(ArtifactAccessActionOutputSchemasV1[action].safeParse({ ...receipt,
        preparation: { status: 'pending', content: 'must not disclose a failed read' } }).success).toBe(false);
    }
    expect(ArtifactAccessGrantsListResponseV1Schema.safeParse(receipt).success).toBe(false);
  });
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
  it('keeps header-only disclosure distinct from full detail and census custody', () => {
    const artifact = { id: 'artifact', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
      header: 'opaque', headerVersion: 1, bodyVersion: 1, publicAudience: 'none',
      dataEncryptionKey: 'opaque-envelope', seq: 1, createdAt: 1, updatedAt: 1 };
    const item = { artifactId: artifact.id, ok: true, artifact };
    const narrow = { projection: 'headers', items: [item] };
    expect(ArtifactReadBatchHttpInputV1Schema.parse({ artifactIds: [artifact.id], projection: 'headers' }))
      .toEqual({ artifactIds: [artifact.id], projection: 'headers' });
    expect(ArtifactReadBatchInputV1Schema.safeParse({ artifactIds: [artifact.id], projection: 'headers' }).success).toBe(false);
    expect(ArtifactReadHeadersBatchResponseV1Schema.parse(narrow)).toEqual(narrow);
    expect(ArtifactReadBatchResponseV1Schema.safeParse(narrow).success).toBe(false);
    expect(ArtifactReadHeadersBatchResponseV1Schema.safeParse({ ...narrow, items: [{ ...item, recipientCensus: null }] }).success).toBe(false);
    expect(ArtifactReadHeadersBatchResponseV1Schema.safeParse({ ...narrow, items: [{ ...item, artifact: { ...artifact, body: 'not demanded' } }] }).success).toBe(false);
    expect(ArtifactReadHeadersBatchResponseV1Schema.safeParse({ ...narrow, items: [{ ...item, artifactId: 'foreign' }] }).success).toBe(false);
  });

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
    const classified = { ...item, artifact: { ...artifact, kind: 'skill' } };
    expect(ArtifactReadBatchResponseV1Schema.parse({ items: [classified] })).toEqual({ items: [classified] });
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item, artifact: { ...artifact, kind: null } }] }).success).toBe(true);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item, artifact: { ...artifact, kind: 'private-name' } }] }).success).toBe(false);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [item] }).success).toBe(true);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item, artifactId: 'other' }] }).success).toBe(false);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item,
      artifact: { ...artifact, encryptionMode: 'e2ee' } }] }).success).toBe(false);
    expect(ArtifactReadBatchResponseV1Schema.safeParse({ items: [{ ...item,
      artifact: { ...artifact, authority: 'owner' } }] }).success).toBe(false);
    expect(ArtifactReadBatchInputV1Schema.safeParse({ artifactIds: ['artifact', 'artifact'] }).success).toBe(false);
  });
});
