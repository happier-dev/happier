import { describe, expect, it } from 'vitest';

const canonicalFingerprint = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('workspaceReplicationSourceOfferCodec', () => {
  it('roundtrips a canonical workspace replication source offer', async () => {
    const { workspaceReplicationSourceOfferCodec } = await import('./workspaceReplicationSourceOfferCodec');

    const encoded = workspaceReplicationSourceOfferCodec.encode({
      offerId: 'offer_123',
      relationshipId: 'relationship_123',
      directionId: 'direction_123',
      sourceFingerprint: canonicalFingerprint,
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest: 'sha256:blob_123',
            sizeBytes: 6,
            executable: false,
          },
        ],
        fingerprint: canonicalFingerprint,
      },
      blobIndex: [
        {
          digest: 'sha256:blob_123',
          sizeBytes: 6,
        },
      ],
      sourceControllerMetadata: {
        nestedRepositories: [],
        supportsSafeReplace: true,
      },
    });

    expect(
      workspaceReplicationSourceOfferCodec.decode({
        transferId: 'offer_transfer_123',
        payload: encoded,
      }),
    ).toEqual({
      offerId: 'offer_123',
      relationshipId: 'relationship_123',
      directionId: 'direction_123',
      sourceFingerprint: canonicalFingerprint,
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest: 'sha256:blob_123',
            sizeBytes: 6,
            executable: false,
          },
        ],
        fingerprint: canonicalFingerprint,
      },
      blobIndex: [
        {
          digest: 'sha256:blob_123',
          sizeBytes: 6,
        },
      ],
      sourceControllerMetadata: {
        nestedRepositories: [],
        supportsSafeReplace: true,
      },
    });
  });

  it('fails closed on malformed source-offer payloads', async () => {
    const { workspaceReplicationSourceOfferCodec } = await import('./workspaceReplicationSourceOfferCodec');

    expect(() =>
      workspaceReplicationSourceOfferCodec.decode({
        transferId: 'offer_transfer_invalid',
        payload: Buffer.from(JSON.stringify({
          offerId: 'offer_123',
          relationshipId: 'relationship_123',
          directionId: 'direction_123',
          sourceFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          manifest: {
            entries: [],
          },
          blobIndex: [
            {
              digest: '',
              sizeBytes: 6,
            },
          ],
        }), 'utf8'),
      }),
    ).toThrow('Invalid workspace replication source offer');
  });
});
