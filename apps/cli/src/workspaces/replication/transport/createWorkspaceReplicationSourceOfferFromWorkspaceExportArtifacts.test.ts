import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { fingerprintWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/fingerprintWorkspaceManifest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts', () => {
  it('commits workspace export blobs into CAS and derives a canonical source offer without re-scanning', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-offer-artifacts-'));

    try {
      const readmeContent = Buffer.from('hello\n', 'utf8');
      const sourceContent = Buffer.from('export const ready = true;\n', 'utf8');
      const readmeDigest = createSha256Digest(readmeContent);
      const sourceDigest = createSha256Digest(sourceContent);
      const workspaceExportArtifacts = createScmSourceControllerWorkspaceExportArtifacts({
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'src/index.ts',
              digest: sourceDigest,
              sizeBytes: sourceContent.byteLength,
              executable: false,
            },
            {
              kind: 'directory',
              relativePath: 'src',
            },
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: readmeDigest,
              sizeBytes: readmeContent.byteLength,
              executable: false,
            },
          ],
          fingerprint: 'sha256:not-canonical',
        },
        blobContentsByDigest: new Map([
          [readmeDigest, readmeContent],
          [sourceDigest, sourceContent],
        ]),
        sourceControllerMetadata: {
          nestedRepositories: ['vendor/tools'],
          supportsSafeReplace: true,
        },
      });

      const {
        createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts,
      } = await import('./createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts');
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');

      const offer = await createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts({
        activeServerDir,
        source: {
          machineId: 'machine_source',
          rootPath: '/workspace/source',
        },
        target: {
          machineId: 'machine_target',
          rootPath: '/workspace/target',
        },
        mode: 'one_way_safe',
        workspaceExportArtifacts,
      });
      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      const canonicalFingerprint = fingerprintWorkspaceManifest({
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest: readmeDigest,
            sizeBytes: readmeContent.byteLength,
            executable: false,
          },
          {
            kind: 'directory',
            relativePath: 'src',
          },
          {
            kind: 'file',
            relativePath: 'src/index.ts',
            digest: sourceDigest,
            sizeBytes: sourceContent.byteLength,
            executable: false,
          },
        ],
      });

      expect(offer.relationshipId).toMatch(/^rel_/);
      expect(offer.directionId).toMatch(/^dir_/);
      expect(offer.sourceFingerprint).toBe(canonicalFingerprint);
      expect(offer.manifest).toEqual({
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest: readmeDigest,
            sizeBytes: readmeContent.byteLength,
            executable: false,
          },
          {
            kind: 'directory',
            relativePath: 'src',
          },
          {
            kind: 'file',
            relativePath: 'src/index.ts',
            digest: sourceDigest,
            sizeBytes: sourceContent.byteLength,
            executable: false,
          },
        ],
        fingerprint: canonicalFingerprint,
      });
      expect(offer.blobIndex).toEqual([
        {
          digest: readmeDigest,
          sizeBytes: readmeContent.byteLength,
        },
        {
          digest: sourceDigest,
          sizeBytes: sourceContent.byteLength,
        },
      ]);
      expect(offer.sourceControllerMetadata).toEqual({
        nestedRepositories: ['vendor/tools'],
        supportsSafeReplace: true,
      });
      await expect(casStore.contains(readmeDigest)).resolves.toBe(true);
      await expect(casStore.contains(sourceDigest)).resolves.toBe(true);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a manifest-referenced blob is missing from the export artifacts', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-offer-artifacts-'));

    try {
      const {
        createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts,
      } = await import('./createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts');

      await expect(createWorkspaceReplicationSourceOfferFromWorkspaceExportArtifacts({
        activeServerDir,
        source: {
          machineId: 'machine_source',
          rootPath: '/workspace/source',
        },
        target: {
          machineId: 'machine_target',
          rootPath: '/workspace/target',
        },
        mode: 'one_way_safe',
        workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
          manifest: {
            entries: [
              {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                sizeBytes: 6,
                executable: false,
              },
            ],
          },
          blobContentsByDigest: new Map(),
          sourceControllerMetadata: null,
        }),
      })).rejects.toThrow(
        'Missing workspace blob for replication source offer: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
