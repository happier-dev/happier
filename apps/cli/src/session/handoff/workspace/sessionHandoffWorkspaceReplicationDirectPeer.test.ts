import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { disposeTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

function createSha256DigestForPayload(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('session handoff direct-peer workspace replication publication', () => {
  const envSnapshot = { ...process.env };

  afterEach(async () => {
    process.env = { ...envSnapshot };
    vi.resetModules();
  });

  it('publishes blob-pack transferIds that fit within the direct-peer URL param length budget (no embedded digests)', async () => {
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = String(1024 * 1024 * 1024);
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '256';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = String(1024 * 1024 * 1024);

	    vi.resetModules();
	    const { buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId } = await import(
	      './sessionHandoffWorkspaceReplicationDirectPeer'
	    );
	    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
	      './sessionHandoffWorkspaceReplicationDirectPeer'
	    );
    const { buildSessionHandoffWorkspaceManifestTransferId } = await import(
      './sessionHandoffWorkspaceReplicationServerRouted'
    );
    const { buildWorkspaceReplicationBlobPacks } = await import(
      '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-publication-'));
    try {
      const workspaceRoot = join(activeServerDir, 'workspace-root');
      await mkdir(join(workspaceRoot, 'files'), { recursive: true });
      const entries: WorkspaceManifest['entries'] = [];
      for (let i = 0; i < 257; i++) {
        const relativePath = `files/file-${i}.txt`;
        const filePath = join(workspaceRoot, relativePath);
        const payload = Buffer.from(`payload-${i}`, 'utf8');
        await writeFile(filePath, payload);
        const digest = createSha256DigestForPayload(payload);
        entries.push({
          kind: 'file',
          relativePath,
          digest,
          sizeBytes: payload.byteLength,
          executable: false,
        });
      }

      const manifest: WorkspaceManifest = { entries };

      const onDemandScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-1',
        activeServerDir,
        sourceRootPath: workspaceRoot,
        manifest,
      });

      const packDigests = buildWorkspaceReplicationBlobPacks({
        blobs: entries
          .filter((entry): entry is Extract<typeof entry, { kind: 'file' }> => entry.kind === 'file')
          .map((entry) => ({ digest: entry.digest, sizeBytes: entry.sizeBytes })),
        blobPackTargetBytes: 1024 * 1024,
        blobPackMaxBlobs: 256,
        blobPackMaxSingleBlobBytes: 1024 * 1024 * 1024,
      })[0]?.digests ?? [];
      const packId = createWorkspaceReplicationPackIdForDigests(packDigests);
      const packTransferId = buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId({
        handoffId: 'handoff-1',
        packId,
      });

      expect(onDemandScope.allowTransferId(packTransferId)).toBe(true);

      // directPeerTransport encodes transferId into a base64url path param and Fastify caps params at 4k chars.
      const encodedPathKeyLength = Buffer.from(packTransferId, 'utf8').toString('base64url').length;
      expect(encodedPathKeyLength).toBeLessThanOrEqual(4096);

      const resolved = await onDemandScope.resolvePayloadSourceOnOpen({
        transferId: packTransferId,
        requestBody: {
          t: 'workspace_replication_blob_pack_v1',
          packId,
          digests: packDigests,
        },
      });
      expect(resolved).toMatchObject({ kind: 'file' });

      const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId: 'handoff-1' });
      expect(onDemandScope.allowTransferId(manifestTransferId)).toBe(true);
      const resolvedManifest = await onDemandScope.resolvePayloadSourceOnOpen({
        transferId: manifestTransferId,
        requestBody: {},
      });
      expect(resolvedManifest).toMatchObject({ kind: 'file' });

      await disposeTransferPayloadSource(resolved as any);
      await disposeTransferPayloadSource(resolvedManifest as any);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('sets maxResolvedTransfers high enough to serve pack-by-pack direct-peer requests for large manifests (no fixed 10k cap)', async () => {
    vi.resetModules();
    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { countWorkspaceReplicationBlobPacks } = await import(
      '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks'
    );
    const { configuration } = await import('@/configuration');
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-max-resolved-'));
    try {
      const buildManifest = (digestCount: number): WorkspaceManifest => {
        const entries: WorkspaceManifest['entries'] = [];
        for (let i = 0; i < digestCount; i++) {
          entries.push({
            kind: 'file',
            relativePath: `files/file-${i}.txt`,
            digest: `sha256:${i.toString(16).padStart(64, '0')}`,
            sizeBytes: 1,
            executable: false,
          });
        }
        return { entries };
      };

      const smallDigestCount = 12;
      const smallManifest = buildManifest(smallDigestCount);
      const smallExpectedPackCount = countWorkspaceReplicationBlobPacks({
        blobs: smallManifest.entries.filter(
          (entry): entry is Extract<typeof entry, { kind: 'file' }> => entry.kind === 'file',
        ).map((entry) => ({
          digest: entry.digest,
          sizeBytes: entry.sizeBytes,
        })),
        blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
        blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
      });
      const smallScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-small-1',
        activeServerDir,
        sourceRootPath: activeServerDir,
        manifest: smallManifest,
      });
      expect(smallScope.maxResolvedTransfers).toBe(smallExpectedPackCount + 1);

      const largeDigestCount = 12_345;
      const largeManifest = buildManifest(largeDigestCount);
      const largeExpectedPackCount = countWorkspaceReplicationBlobPacks({
        blobs: largeManifest.entries.filter(
          (entry): entry is Extract<typeof entry, { kind: 'file' }> => entry.kind === 'file',
        ).map((entry) => ({
          digest: entry.digest,
          sizeBytes: entry.sizeBytes,
        })),
        blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
        blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
      });
      expect(largeExpectedPackCount).toBeLessThan(largeDigestCount);
      const largeScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-large-1',
        activeServerDir,
        sourceRootPath: activeServerDir,
        manifest: largeManifest,
      });
      expect(largeScope.maxResolvedTransfers).toBe(largeExpectedPackCount + 1);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('dedupes duplicate manifest digests when computing the direct-peer pack budget', async () => {
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '2';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = String(1024 * 1024);
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = String(1024 * 1024);

    vi.resetModules();
    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { countWorkspaceReplicationBlobPacks } = await import(
      '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-dedup-budget-'));
    try {
      const digestA = 'sha256:0000000000000000000000000000000000000000000000000000000000000001';
      const digestB = 'sha256:0000000000000000000000000000000000000000000000000000000000000002';
      const digestC = 'sha256:0000000000000000000000000000000000000000000000000000000000000003';

      const manifest: WorkspaceManifest = {
        entries: [
          {
            kind: 'file',
            relativePath: 'files/a.txt',
            digest: digestA,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/a-duplicate.txt',
            digest: digestA,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/a-duplicate-2.txt',
            digest: digestA,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/b.txt',
            digest: digestB,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/c.txt',
            digest: digestC,
            sizeBytes: 1,
            executable: false,
          },
        ],
      };

      const uniquePackCount = countWorkspaceReplicationBlobPacks({
        blobs: [
          { digest: digestA, sizeBytes: 1 },
          { digest: digestB, sizeBytes: 1 },
          { digest: digestC, sizeBytes: 1 },
        ],
        blobPackTargetBytes: 1024 * 1024,
        blobPackMaxBlobs: 2,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
      });

      const scope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-dedup-budget-1',
        activeServerDir,
        sourceRootPath: activeServerDir,
        manifest,
      });

      expect(scope.maxResolvedTransfers).toBe(uniquePackCount + 1);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects direct-peer blob-pack requests that include digests outside the manifest', async () => {
    vi.resetModules();
    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-pack-outside-manifest-'));
    try {
      const entries: WorkspaceManifest['entries'] = [];
      const digestA = 'sha256:0000000000000000000000000000000000000000000000000000000000000001';
      const digestB = 'sha256:0000000000000000000000000000000000000000000000000000000000000002';
      entries.push({
        kind: 'file',
        relativePath: 'files/a.bin',
        digest: digestA,
        sizeBytes: 1,
        executable: false,
      });
      entries.push({
        kind: 'file',
        relativePath: 'files/b.bin',
        digest: digestB,
        sizeBytes: 1,
        executable: false,
      });

      const manifest: WorkspaceManifest = { entries };
      const scope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-pack-outside-manifest-1',
        activeServerDir,
        sourceRootPath: activeServerDir,
        manifest,
      });

      const invalidDigest = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const validDigests = [digestA, invalidDigest].sort((left, right) => left.localeCompare(right));
      const invalidPackId = createWorkspaceReplicationPackIdForDigests(validDigests);
      const invalidTransferId = `session-handoff:handoff-pack-outside-manifest-1:workspace-pack-direct:${invalidPackId}`;

      await expect(
        scope.resolvePayloadSourceOnOpen({
          transferId: invalidTransferId,
          requestBody: {
            t: 'workspace_replication_blob_pack_v1',
            packId: invalidPackId,
            digests: validDigests,
          },
        }),
      ).rejects.toThrow('Invalid direct-peer blob-pack request body');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects multi-digest blob-pack requests whose total bytes exceed the blob-pack target bytes (no oversized on-demand packs)', async () => {
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '10';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = '5';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = '100';

    vi.resetModules();
    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-pack-oversized-'));
    try {
      const digestA = 'sha256:0000000000000000000000000000000000000000000000000000000000000001';
      const digestB = 'sha256:0000000000000000000000000000000000000000000000000000000000000002';
      const digests = [digestA, digestB].sort((left, right) => left.localeCompare(right));
      const packId = createWorkspaceReplicationPackIdForDigests(digests);
      const transferId = buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId({
        handoffId: 'handoff-pack-oversized-1',
        packId,
      });

      const manifest: WorkspaceManifest = {
        entries: [
          {
            kind: 'file',
            relativePath: 'files/a.bin',
            digest: digestA,
            sizeBytes: 4,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/b.bin',
            digest: digestB,
            sizeBytes: 4,
            executable: false,
          },
        ],
      };
      const scope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-pack-oversized-1',
        activeServerDir,
        sourceRootPath: activeServerDir,
        manifest,
      });

      await expect(scope.resolvePayloadSourceOnOpen({
        transferId,
        requestBody: {
          t: 'workspace_replication_blob_pack_v1',
          packId,
          digests,
        },
      })).rejects.toThrow('Invalid direct-peer blob-pack request body');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('accepts a valid digest subset even when it is not part of the canonical full-manifest pack partition (on-demand packs match engine missing-blob batching)', async () => {
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '2';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = String(1024 * 1024);
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = String(1024 * 1024);

    vi.resetModules();
    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );
    const { buildWorkspaceReplicationBlobPacks } = await import(
      '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-pack-mismatch-'));
    try {
      const workspaceRoot = join(activeServerDir, 'workspace');
      await mkdir(join(workspaceRoot, 'files'), { recursive: true });
      const payloadA = Buffer.from('payload-A', 'utf8');
      const payloadB = Buffer.from('payload-B', 'utf8');
      const payloadC = Buffer.from('payload-C', 'utf8');
      const payloadD = Buffer.from('payload-D', 'utf8');
      const digestA = createSha256DigestForPayload(payloadA);
      const digestB = createSha256DigestForPayload(payloadB);
      const digestC = createSha256DigestForPayload(payloadC);
      const digestD = createSha256DigestForPayload(payloadD);
      const pathA = join(workspaceRoot, 'files', 'a.bin');
      const pathB = join(workspaceRoot, 'files', 'b.bin');
      const pathC = join(workspaceRoot, 'files', 'c.bin');
      const pathD = join(workspaceRoot, 'files', 'd.bin');
      await writeFile(pathA, payloadA);
      await writeFile(pathB, payloadB);
      await writeFile(pathC, payloadC);
      await writeFile(pathD, payloadD);

      const manifest: WorkspaceManifest = {
        entries: [
          {
            kind: 'file',
            relativePath: 'files/a.bin',
            digest: digestA,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/b.bin',
            digest: digestB,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/c.bin',
            digest: digestC,
            sizeBytes: 1,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/d.bin',
            digest: digestD,
            sizeBytes: 1,
            executable: false,
          },
        ],
      };

      const scope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-pack-mismatch-1',
        activeServerDir,
        sourceRootPath: workspaceRoot,
        manifest,
      });

      const subsetDigests = [digestB, digestC].sort((left, right) => left.localeCompare(right));
      const subsetPackId = createWorkspaceReplicationPackIdForDigests(subsetDigests);
      const subsetTransferId = buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId({
        handoffId: 'handoff-pack-mismatch-1',
        packId: subsetPackId,
      });

      const fullManifestPackIds = buildWorkspaceReplicationBlobPacks({
        blobs: manifest.entries
          .filter((entry): entry is Extract<typeof entry, { kind: 'file' }> => entry.kind === 'file')
          .map((entry) => ({ digest: entry.digest, sizeBytes: entry.sizeBytes })),
        blobPackTargetBytes: 1024 * 1024,
        blobPackMaxBlobs: 2,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
      }).map((pack) => pack.packId);
      expect(fullManifestPackIds).not.toContain(subsetPackId);

      // The direct-peer scope must serve any pack requested by the engine's missing-blob batching,
      // even when that digest set doesn't match the source's full-manifest pack partition.
      expect(scope.allowTransferId(subsetTransferId)).toBe(true);
      const resolved = await scope.resolvePayloadSourceOnOpen({
        transferId: subsetTransferId,
        requestBody: {
          t: 'workspace_replication_blob_pack_v1',
          packId: subsetPackId,
          digests: subsetDigests,
        },
      });
      expect(resolved).toMatchObject({ kind: 'file' });
      await disposeTransferPayloadSource(resolved as any);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects on-demand blob-pack requests when digests are not strings (no toString coercion)', async () => {
    vi.resetModules();
    const { createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId } = await import(
      './sessionHandoffWorkspaceReplicationDirectPeer'
    );
    const { createWorkspaceReplicationPackIdForDigests } = await import(
      '@/workspaces/replication/transport/workspaceReplicationPackId'
    );

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-digests-type-'));
    try {
      const workspaceRoot = join(activeServerDir, 'workspace');
      await mkdir(join(workspaceRoot, 'files'), { recursive: true });
      const payloadA = Buffer.from('payload-A', 'utf8');
      const payloadB = Buffer.from('payload-B', 'utf8');
      const digestA = createSha256DigestForPayload(payloadA);
      const digestB = createSha256DigestForPayload(payloadB);
      const pathA = join(workspaceRoot, 'files', 'a.bin');
      const pathB = join(workspaceRoot, 'files', 'b.bin');
      await writeFile(pathA, payloadA);
      await writeFile(pathB, payloadB);

      const manifest: WorkspaceManifest = {
        entries: [
          {
            kind: 'file',
            relativePath: 'files/a.bin',
            digest: digestA,
            sizeBytes: payloadA.byteLength,
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'files/b.bin',
            digest: digestB,
            sizeBytes: payloadB.byteLength,
            executable: false,
          },
        ],
      };

      const onDemandScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: 'handoff-digest-types-1',
        activeServerDir,
        sourceRootPath: workspaceRoot,
        manifest,
      });

      const digests = [digestA, digestB].sort((left, right) => left.localeCompare(right));
      const packId = createWorkspaceReplicationPackIdForDigests(digests);
      const transferId = buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId({
        handoffId: 'handoff-digest-types-1',
        packId,
      });

      await expect(onDemandScope.resolvePayloadSourceOnOpen({
        transferId,
        requestBody: {
          t: 'workspace_replication_blob_pack_v1',
          packId,
          digests: [
            { toString: () => digests[0] },
            { toString: () => digests[1] },
          ],
        },
      })).rejects.toThrow();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
