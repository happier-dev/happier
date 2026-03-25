import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { configuration } from '@/configuration';

describe('sessionHandoffWorkspaceReplicationServerRouted', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('builds bounded workspace pack transfer ids (no digest list encoding)', async () => {
    const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const digests = Array.from(
      { length: configuration.workspaceReplicationBlobPackMaxBlobs },
      (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`,
    );
    const packId = createWorkspaceReplicationPackIdForDigests(digests);

    const transferId = buildSessionHandoffWorkspaceBlobPackTransferId({
      handoffId: 'handoff_1',
      packId,
    });
    expect(transferId).toContain(':workspace-pack:');
    // Server-routed machine transfer caps ids at 256 chars; workspace replication must stay within it.
    expect(transferId.length).toBeLessThanOrEqual(256);
  });

  it('parses workspace pack transfer ids and extracts handoffId/packId', async () => {
    const { buildSessionHandoffWorkspaceBlobPackTransferId, parseSessionHandoffWorkspaceBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );

    const transferId = buildSessionHandoffWorkspaceBlobPackTransferId({
      handoffId: 'handoff_1',
      packId: 'pack_123',
    });
    expect(parseSessionHandoffWorkspaceBlobPackTransferId(transferId)).toEqual({
      handoffId: 'handoff_1',
      packId: 'pack_123',
    });
  });

  it('parses workspace blob-pack open bodies (v1) and fails closed on invalid inputs', async () => {
    const { parseSessionHandoffWorkspaceBlobPackOpenBody } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const digests = ['sha256:0000000000000000000000000000000000000000000000000000000000000000'];
    const packId = createWorkspaceReplicationPackIdForDigests(digests);
    expect(parseSessionHandoffWorkspaceBlobPackOpenBody({
      t: 'workspace_replication_blob_pack_v1',
      packId,
      digests,
    })).toEqual({
      t: 'workspace_replication_blob_pack_v1',
      packId,
      digests,
    });

    // Fail closed: do not silently drop blank digest entries (prevents request-body smuggling).
    expect(parseSessionHandoffWorkspaceBlobPackOpenBody({
      t: 'workspace_replication_blob_pack_v1',
      packId,
      digests: [...digests, '   '],
    })).toBeNull();

    expect(parseSessionHandoffWorkspaceBlobPackOpenBody({
      t: 'workspace_replication_blob_pack_v1',
      packId: 'pack_other',
      digests,
    })).toBeNull();

    expect(parseSessionHandoffWorkspaceBlobPackOpenBody({
      t: 'workspace_replication_blob_pack_v1',
      packId,
      digests: [...digests, ...digests],
    })).toBeNull();
  });

  it('seeds missing workspace replication CAS blobs via blobProvider', async () => {
    const { createSessionHandoffWorkspaceReplicationBlobPackPayloadSource } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-seed-cas-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-seed-cas-blobs-'));
    try {
      const blobContent = Buffer.from('hello\n', 'utf8');
      const digest = `sha256:${createHash('sha256').update(blobContent).digest('hex')}`;
      const blobRelativePath = 'blob.txt';
      const blobPath = join(workspaceRoot, blobRelativePath);
      await writeFile(blobPath, blobContent);

      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await expect(casStore.contains(digest)).resolves.toBe(false);

      const payloadSource = await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack-1',
        digests: [digest],
        sourceRootPath: workspaceRoot,
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: blobRelativePath,
              digest,
              sizeBytes: blobContent.byteLength,
              executable: false,
            },
          ],
          fingerprint: 'fingerprint',
        },
      });

      try {
        expect(payloadSource.kind).toBe('file');
        await expect(casStore.contains(digest)).resolves.toBe(true);
      } finally {
        await disposeTransferPayloadSource(payloadSource);
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails with a clear error when CAS is missing and blobProvider is unavailable', async () => {
    const { createSessionHandoffWorkspaceReplicationBlobPackPayloadSource } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-seed-cas-'));
    try {
      await expect(createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack-1',
        digests: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      })).rejects.toThrow('sourceRootPath');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

});
