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
});
