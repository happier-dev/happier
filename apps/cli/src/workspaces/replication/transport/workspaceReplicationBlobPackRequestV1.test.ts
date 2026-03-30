import { describe, expect, it } from 'vitest';

describe('workspaceReplicationBlobPackRequestV1', () => {
    it('parses blob-pack open bodies (v1) and fails closed on invalid inputs', async () => {
        const { parseWorkspaceReplicationBlobPackRequestV1 } = await import('./workspaceReplicationBlobPackRequestV1');
        const { createWorkspaceReplicationPackIdForDigests } = await import('./workspaceReplicationPackId');

        const digests = ['sha256:0000000000000000000000000000000000000000000000000000000000000000'];
        const packId = createWorkspaceReplicationPackIdForDigests(digests);
        expect(parseWorkspaceReplicationBlobPackRequestV1({
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests,
        }, { maxBlobs: 10 })).toEqual({
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests,
        });

        // Fail closed: do not silently drop blank digest entries (prevents request-body smuggling).
        expect(parseWorkspaceReplicationBlobPackRequestV1({
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests: [...digests, '   '],
        }, { maxBlobs: 10 })).toBeNull();

        expect(parseWorkspaceReplicationBlobPackRequestV1({
            t: 'workspace_replication_blob_pack_v1',
            packId: 'pack_other',
            digests,
        }, { maxBlobs: 10 })).toBeNull();

        expect(parseWorkspaceReplicationBlobPackRequestV1({
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests: [...digests, ...digests],
        }, { maxBlobs: 10 })).toBeNull();

        expect(parseWorkspaceReplicationBlobPackRequestV1({
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests: ['sha256:b', 'sha256:a'],
        }, { maxBlobs: 10 })).toBeNull();

        expect(parseWorkspaceReplicationBlobPackRequestV1({
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests: ['sha256:a', 'sha256:b'],
        }, { maxBlobs: 1 })).toBeNull();
    });
});
