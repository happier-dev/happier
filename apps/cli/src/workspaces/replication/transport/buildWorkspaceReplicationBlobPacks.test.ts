import { describe, expect, it } from 'vitest';

describe('buildWorkspaceReplicationBlobPacks', () => {
  it('sorts missing digests deterministically and partitions them into stable packs', async () => {
    const { buildWorkspaceReplicationBlobPacks } = await import('./buildWorkspaceReplicationBlobPacks');

    expect(buildWorkspaceReplicationBlobPacks({
      blobs: [
        {
          digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          sizeBytes: 4,
        },
        {
          digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sizeBytes: 6,
        },
        {
          digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sizeBytes: 5,
        },
      ],
      blobPackTargetBytes: 10,
      blobPackMaxBlobs: 2,
      blobPackMaxSingleBlobBytes: 16,
    })).toEqual([
      {
        packId: 'pack_407470782fbe19aeffbbdd8127bfa87d45e1eeb927f5c0304d1e064eef117f77',
        digests: [
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ],
        totalBytes: 6,
      },
      {
        packId: 'pack_7e64aa1d6b34f743bc161f7c714f18edf1da408cbb4ec68e0fdfa304a560e315',
        digests: [
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ],
        totalBytes: 9,
      },
    ]);
  });

  it('counts pack partitions without requiring the caller to keep the full pack list', async () => {
    const {
      buildWorkspaceReplicationBlobPacks,
      countWorkspaceReplicationBlobPacks,
    } = await import('./buildWorkspaceReplicationBlobPacks');

    const blobs = Array.from({ length: 513 }, (_, index) => ({
      digest: `sha256:${index.toString(16).padStart(64, '0')}`,
      sizeBytes: index % 3 === 0 ? 2 : 1,
    }));

    const expectedPackCount = buildWorkspaceReplicationBlobPacks({
      blobs,
      blobPackTargetBytes: 12,
      blobPackMaxBlobs: 8,
      blobPackMaxSingleBlobBytes: 16,
    }).length;

    expect(countWorkspaceReplicationBlobPacks({
      blobs,
      blobPackTargetBytes: 12,
      blobPackMaxBlobs: 8,
      blobPackMaxSingleBlobBytes: 16,
    })).toBe(expectedPackCount);
  });

  it('throws when a single blob exceeds the configured max single-blob bytes', async () => {
    const { buildWorkspaceReplicationBlobPacks } = await import('./buildWorkspaceReplicationBlobPacks');

    expect(() => buildWorkspaceReplicationBlobPacks({
      blobs: [
        {
          digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          sizeBytes: 32,
        },
      ],
      blobPackTargetBytes: 16,
      blobPackMaxBlobs: 2,
      blobPackMaxSingleBlobBytes: 24,
    })).toThrow('Workspace replication blob exceeds max single-blob bytes');
  });

  it('reads each blob size once while building packs', async () => {
    const { buildWorkspaceReplicationBlobPacks } = await import('./buildWorkspaceReplicationBlobPacks');

    let sizeReads = 0;
    const blobs = [
      {
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        get sizeBytes() {
          sizeReads += 1;
          return 4;
        },
      },
      {
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        get sizeBytes() {
          sizeReads += 1;
          return 5;
        },
      },
      {
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        get sizeBytes() {
          sizeReads += 1;
          return 6;
        },
      },
    ] satisfies ReadonlyArray<{
      digest: string;
      readonly sizeBytes: number;
    }>;

    expect(buildWorkspaceReplicationBlobPacks({
      blobs,
      blobPackTargetBytes: 10,
      blobPackMaxBlobs: 2,
      blobPackMaxSingleBlobBytes: 16,
    })).toEqual([
      expect.objectContaining({
        digests: [
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ],
        totalBytes: 9,
      }),
      expect.objectContaining({
        digests: [
          'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ],
        totalBytes: 6,
      }),
    ]);

    expect(sizeReads).toBe(3);
  });
});
