import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

describe('sessionHandoffWorkspaceReplicationServerRouted', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('fails closed when workspace pack transfer ids contain an oversized digest list', async () => {
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '128';

    const { parseSessionHandoffWorkspaceBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );

    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const digests = Array.from({ length: 10 }, () => digest);
    const encodedDigests = Buffer.from(JSON.stringify(digests), 'utf8').toString('base64url');

    // This is attacker-controlled input in server-routed transfers. Reject rather than buffering a huge JSON list.
    expect(parseSessionHandoffWorkspaceBlobPackTransferId(
      `session-handoff:handoff_1:workspace-pack:pack_1:${encodedDigests}`,
    )).toBeNull();
  });

  it('fails closed when workspace pack transfer ids contain a packId that does not match the digest set', async () => {
    const { parseSessionHandoffWorkspaceBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );

    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const digests = [digest];
    const encodedDigests = Buffer.from(JSON.stringify(digests), 'utf8').toString('base64url');

    expect(parseSessionHandoffWorkspaceBlobPackTransferId(
      `session-handoff:handoff_1:workspace-pack:pack_other:${encodedDigests}`,
    )).toBeNull();
  });

  it('fails closed when workspace pack transfer ids contain too many digests', async () => {
    const { parseSessionHandoffWorkspaceBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    // Default config is currently 256 max blobs per pack; exceed it here to ensure we fail closed
    // rather than allowing attacker-controlled transfer IDs to trigger huge CAS seeding loops.
    const digests = Array.from({ length: 257 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
    const packId = createWorkspaceReplicationPackIdForDigests(digests);
    const encodedDigests = Buffer.from(JSON.stringify(digests), 'utf8').toString('base64url');

    expect(parseSessionHandoffWorkspaceBlobPackTransferId(
      `session-handoff:handoff_1:workspace-pack:${packId}:${encodedDigests}`,
    )).toBeNull();
  });

  it('rejects building workspace pack transfer ids with too many digests', async () => {
    const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const digests = Array.from({ length: 257 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
    const packId = createWorkspaceReplicationPackIdForDigests(digests);

    expect(() => buildSessionHandoffWorkspaceBlobPackTransferId({
      handoffId: 'handoff_1',
      packId,
      digests,
    })).toThrow('Invalid workspace blob-pack digest list');
  });

  it('seeds missing workspace replication CAS blobs via blobProvider', async () => {
    const { createSessionHandoffWorkspaceReplicationBlobPackPayloadSource } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-seed-cas-'));
    const blobRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-seed-cas-blobs-'));
    try {
      const blobContent = Buffer.from('hello\n', 'utf8');
      const digest = `sha256:${createHash('sha256').update(blobContent).digest('hex')}`;
      const blobPath = join(blobRoot, 'blob.txt');
      await writeFile(blobPath, blobContent);

      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await expect(casStore.contains(digest)).resolves.toBe(false);

      const payloadSource = await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack-1',
        digests: [digest],
        blobProvider: {
          getBlobFilePath: (candidate) => (candidate === digest ? blobPath : null),
        },
      });

      try {
        expect(payloadSource.kind).toBe('file');
        await expect(casStore.contains(digest)).resolves.toBe(true);
      } finally {
        await disposeTransferPayloadSource(payloadSource);
      }
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
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
      })).rejects.toThrow('blobProvider');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

});
