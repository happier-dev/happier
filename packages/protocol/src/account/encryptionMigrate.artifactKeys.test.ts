import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountEncryptionMigrateArtifactsDirectiveSchema } from './encryptionMigrate.js';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '../storage/artifactStoredContent.js';
import { encodeBase64 } from '../crypto/base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { x25519 } from '@noble/curves/ed25519';

describe('Artifact encryption transition directive', () => {
  it.each(['expectedDataEncryptionKey', 'recipientKeyEnvelopes', 'revisions'] as const)(
    'rejects an omitted %s while accepting an explicit plain source and empty recipient subset', (field) => {
      const item = { artifactId: '11111111-1111-4111-8111-111111111111',
        expectedHeaderVersion: 1, expectedBodyVersion: 1, header: 'header', body: 'body',
        expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], blobs: [], revisions: [] };
      expect(AccountEncryptionMigrateArtifactsDirectiveSchema.safeParse({ action: 'migrate', items: [item] }).success).toBe(true);
      const incomplete: Partial<typeof item> = { ...item };
      delete incomplete[field];
      expect(AccountEncryptionMigrateArtifactsDirectiveSchema.safeParse({ action: 'migrate', items: [incomplete] }).success).toBe(false);
    },
  );

  it('carries a replacement recipient subset and exact source key while rejecting duplicate recipients', () => {
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: randomBytes(32),
      recipientPublicKey: x25519.getPublicKey(randomBytes(32)), randomBytes }));
    const recipient = { recipientAccountId: 'member', encryptedDataKey: envelope,
      recipientContentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64) };
    const item = { artifactId: '11111111-1111-4111-8111-111111111111',
      expectedHeaderVersion: 1, expectedBodyVersion: 1, header: 'header', body: 'body',
      expectedDataEncryptionKey: envelope, dataEncryptionKey: envelope, recipientKeyEnvelopes: [recipient], blobs: [], revisions: [] };
    const result = AccountEncryptionMigrateArtifactsDirectiveSchema.parse({ action: 'migrate', items: [item] });
    expect(result).toEqual({ action: 'migrate', items: [item] });
    expect(AccountEncryptionMigrateArtifactsDirectiveSchema.safeParse({ action: 'migrate', items: [{ ...item,
      recipientKeyEnvelopes: [recipient, recipient] }] }).success).toBe(false);
    expect(AccountEncryptionMigrateArtifactsDirectiveSchema.safeParse({ action: 'migrate', items: [{ ...item,
      recipientKeyEnvelopes: [{ ...recipient, dataKey: 'must-never-cross-the-server' }] }] }).success).toBe(false);
  });

  it('carries the exact retained revision conversion and rejects duplicate versions or unknown mutation fields', () => {
    const revision = { bodyVersion: 2, expectedBody: 'source-body', body: 'target-body' };
    const item = { artifactId: '11111111-1111-4111-8111-111111111111',
      expectedHeaderVersion: 1, expectedBodyVersion: 3, header: 'header', body: 'body',
      expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], blobs: [], revisions: [revision] };
    expect(AccountEncryptionMigrateArtifactsDirectiveSchema.parse({ action: 'migrate', items: [item] }))
      .toEqual({ action: 'migrate', items: [item] });
    for (const revisions of [[revision, revision], [{ ...revision, overwriteHistory: true }]]) {
      expect(AccountEncryptionMigrateArtifactsDirectiveSchema.safeParse({ action: 'migrate', items: [{ ...item, revisions }] }).success)
        .toBe(false);
    }
  });

  it('preserves retained bodies above the old head-field cap under the owning request budget', () => {
    const body = 'a'.repeat(4_000_001);
    const item = { artifactId: '11111111-1111-4111-8111-111111111111',
      expectedHeaderVersion: 1, expectedBodyVersion: 3, header: 'header', body: 'body',
      expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], blobs: [],
      revisions: [{ bodyVersion: 2, expectedBody: body, body }] };
    expect(AccountEncryptionMigrateArtifactsDirectiveSchema.safeParse({ action: 'migrate', items: [item] }).success).toBe(true);
  });
});
