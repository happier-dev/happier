import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries } from '@/scm/sourceController/workspaceExportArtifacts';

describe('createWorkspaceReplicationSourceOffer', () => {
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

  it('adapts existing workspace export artifacts into a canonical source offer without rescanning the workspace', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-source-offer-from-artifacts-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-source-artifacts-root-'));

    try {
      await mkdir(join(workspaceRoot, 'nested'), { recursive: true });
      await writeFile(join(workspaceRoot, 'README.md'), 'hello\n');
      await writeFile(join(workspaceRoot, 'nested', 'copy.md'), 'hello\n');
      await symlink('../README.md', join(workspaceRoot, 'nested', 'readme-link'));

      const workspaceExportArtifacts = await buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries({
        entries: [
          { relativePath: 'README.md', sourcePath: join(workspaceRoot, 'README.md') },
          { relativePath: 'nested/copy.md', sourcePath: join(workspaceRoot, 'nested', 'copy.md') },
          { relativePath: 'nested/readme-link', sourcePath: join(workspaceRoot, 'nested', 'readme-link') },
        ],
      });
      await rm(workspaceRoot, { recursive: true, force: true });

      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        createWorkspaceReplicationSourceOfferFromExportArtifacts,
      } = await import('./createWorkspaceReplicationSourceOfferFromExportArtifacts');

      const offer = await createWorkspaceReplicationSourceOfferFromExportArtifacts({
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
        workspaceExportArtifacts,
      });

      expect(offer).toMatchObject({
        offerId: expect.stringMatching(/^offer_[A-Za-z0-9_-]+$/u),
        relationshipId: expect.stringMatching(/^rel_[A-Za-z0-9_-]+$/u),
        directionId: expect.stringMatching(/^dir_[A-Za-z0-9_-]+$/u),
        sourceFingerprint: workspaceExportArtifacts.manifest.fingerprint,
        blobIndex: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
          },
        ],
      });
      expect(offer.manifest).toEqual({
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
        fingerprint: workspaceExportArtifacts.manifest.fingerprint,
      });

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
});
