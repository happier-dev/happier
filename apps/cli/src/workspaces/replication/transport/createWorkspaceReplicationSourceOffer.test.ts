import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('createWorkspaceReplicationSourceOffer', () => {
  it('seeds CAS when creating an offer from a manifest so blob-pack streaming does not depend on external blob providers', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-source-offer-manifest-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-source-root-'));

    try {
      await writeFile(join(workspaceRoot, 'README.md'), 'hello\n');

      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./createWorkspaceReplicationBlobPackPayloadSource');
      const {
        createWorkspaceReplicationSourceOfferFromManifest,
      } = await import('./createWorkspaceReplicationSourceOffer');

      const digest = 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
      const offer = await createWorkspaceReplicationSourceOfferFromManifest({
        activeServerDir,
        source: {
          machineId: 'machine_a',
          rootPath: workspaceRoot,
        },
        target: {
          machineId: 'machine_b',
          rootPath: '/copy',
        },
        mode: 'one_way_safe',
        seedCasFromWorkspaceRoot: true,
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest,
              executable: false,
              sizeBytes: 6,
            },
          ],
        },
      });

      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      await expect(casStore.contains(digest)).resolves.toBe(true);
      await expect(readFile(casStore.resolveBlobPath(digest), 'utf8')).resolves.toBe('hello\n');

      const packSource = await createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack_from_manifest',
        digests: offer.blobIndex.map((blob) => blob.digest),
      });
      expect(packSource.kind).toBe('file');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not require source filesystem access when creating an offer from a manifest (target-side planning)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-source-offer-target-'));

    try {
      const {
        createWorkspaceReplicationSourceOfferFromManifest,
      } = await import('./createWorkspaceReplicationSourceOffer');

      await expect(createWorkspaceReplicationSourceOfferFromManifest({
        activeServerDir,
        source: {
          machineId: 'machine_a',
          rootPath: '/path/that/does/not/exist',
        },
        target: {
          machineId: 'machine_b',
          rootPath: '/copy',
        },
        mode: 'one_way_safe',
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              executable: false,
              sizeBytes: 6,
            },
          ],
        },
      })).resolves.toMatchObject({
        blobIndex: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
          },
        ],
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
            },
          ],
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('builds a manifest-first source offer backed by CAS with a deduplicated blob index', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-source-offer-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-source-root-'));

    try {
      await mkdir(join(workspaceRoot, 'nested'), { recursive: true });
      await writeFile(join(workspaceRoot, 'README.md'), 'hello\n');
      await writeFile(join(workspaceRoot, 'nested', 'copy.md'), 'hello\n');
      await symlink('../README.md', join(workspaceRoot, 'nested', 'readme-link'));

      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        createWorkspaceReplicationSourceOffer,
      } = await import('./createWorkspaceReplicationSourceOffer');

      const offer = await createWorkspaceReplicationSourceOffer({
        activeServerDir,
        source: {
          machineId: 'machine_a',
          rootPath: workspaceRoot,
        },
        target: {
          machineId: 'machine_b',
          rootPath: '/copy',
        },
        mode: 'one_way_safe',
      });

      expect(offer).toMatchObject({
        offerId: expect.stringMatching(/^offer_[A-Za-z0-9_-]+$/u),
        relationshipId: expect.stringMatching(/^rel_[A-Za-z0-9_-]+$/u),
        directionId: expect.stringMatching(/^dir_[A-Za-z0-9_-]+$/u),
        sourceFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        manifest: {
          fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              executable: false,
              sizeBytes: 6,
            },
            {
              kind: 'directory',
              relativePath: 'nested',
            },
            {
              kind: 'file',
              relativePath: 'nested/copy.md',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              executable: false,
              sizeBytes: 6,
            },
            {
              kind: 'symlink',
              relativePath: 'nested/readme-link',
              target: '../README.md',
            },
          ],
        },
        blobIndex: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
          },
        ],
      });
      expect(offer.sourceFingerprint).toBe(offer.manifest.fingerprint);

      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      await expect(casStore.contains(offer.blobIndex[0]!.digest)).resolves.toBe(true);
      await expect(readFile(casStore.resolveBlobPath(offer.blobIndex[0]!.digest), 'utf8')).resolves.toBe('hello\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects legacy non-streaming source offer files even when within the legacy whole-buffer max bytes (prevents whole-buffer JSON parsing)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-source-offer-legacy-'));
    try {
      const filePath = join(dir, 'offer-legacy.txt');
      await writeFile(
        filePath,
        JSON.stringify({
          offerId: 'offer_legacy_1',
          relationshipId: 'rel_legacy_1',
          directionId: 'dir_legacy_1',
          sourceFingerprint: `sha256:${'a'.repeat(64)}`,
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: `sha256:${'b'.repeat(64)}`,
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: `sha256:${'c'.repeat(64)}`,
          },
          blobIndex: [
            {
              digest: `sha256:${'b'.repeat(64)}`,
              sizeBytes: 6,
            },
          ],
        }),
        'utf8',
      );

      const { readWorkspaceReplicationSourceOfferFromFile } = await import('./workspaceReplicationSourceOfferFileFormat');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'offer_legacy_1',
        filePath,
      })).rejects.toThrow(/legacy/i);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('roundtrips a very large source offer through the streaming file format (file-backed, no whole-buffer JSON)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-source-offer-large-'));
    try {
      const filePath = join(dir, 'offer-large.txt');
      const entryCount = 50_000;
      const entries = Array.from({ length: entryCount }, (_, index) => ({
        relativePath: `files/file-${String(index).padStart(6, '0')}.txt`,
        kind: 'file' as const,
        digest: `sha256:${index.toString(16).padStart(64, '0')}`,
        sizeBytes: 1,
        executable: false,
      }));
      const offer = {
        offerId: 'offer_large_1',
        relationshipId: 'rel_large_1',
        directionId: 'dir_large_1',
        sourceFingerprint: `sha256:${'d'.repeat(64)}`,
        manifest: {
          entries,
          fingerprint: `sha256:${'e'.repeat(64)}`,
        },
        blobIndex: entries.map((entry) => ({ digest: entry.digest, sizeBytes: entry.sizeBytes })),
      };

      const {
        writeWorkspaceReplicationSourceOfferToFile,
        readWorkspaceReplicationSourceOfferFromFile,
      } = await import('./workspaceReplicationSourceOfferFileFormat');

      await writeWorkspaceReplicationSourceOfferToFile({
        offer: offer as any,
        filePath,
      });

      const readBack = await readWorkspaceReplicationSourceOfferFromFile({
        transferId: offer.offerId,
        filePath,
      });

      expect(readBack.offerId).toBe(offer.offerId);
      expect(readBack.manifest.entries).toHaveLength(entryCount);
      expect(readBack.blobIndex).toHaveLength(entryCount);
      expect(readBack.manifest.entries[0]).toMatchObject({ relativePath: 'files/file-000000.txt', kind: 'file' });
      expect(readBack.manifest.entries[entryCount - 1]).toMatchObject({
        relativePath: `files/file-${String(entryCount - 1).padStart(6, '0')}.txt`,
        kind: 'file',
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
