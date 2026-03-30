import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('createWorkspaceReplicationCasBackedImportArtifacts', () => {
  it('builds manifest-only workspace export artifacts with a CAS-backed blob provider from a source offer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-apply-bridge-'));
    const sourceFilePath = join(activeServerDir, 'README.md');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { createWorkspaceReplicationCasBackedImportArtifacts } = await import('./createWorkspaceReplicationCasBackedImportArtifacts');

      await writeFile(sourceFilePath, payload);
      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await casStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      const result = createWorkspaceReplicationCasBackedImportArtifacts({
        activeServerDir,
        sourceOffer: {
          offerId: 'offer_123',
          relationshipId: 'rel_123',
          directionId: 'dir_123',
          sourceFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest,
                sizeBytes: payload.byteLength,
                executable: false,
              },
            ],
            fingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          blobIndex: [
            {
              digest,
              sizeBytes: payload.byteLength,
            },
          ],
          sourceControllerMetadata: {
            nestedRepositories: ['vendor/tools'],
            supportsSafeReplace: true,
          },
        },
      });

      expect(result.workspaceExportArtifacts).toEqual({
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest,
              sizeBytes: payload.byteLength,
              executable: false,
            },
          ],
          fingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        sourceControllerMetadata: {
          nestedRepositories: ['vendor/tools'],
          supportsSafeReplace: true,
        },
      });
      expect(result.blobProvider.getBlobFilePath(digest)).toBe(casStore.resolveBlobPath(digest));
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('preserves a manifest-only source offer without source-controller metadata', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-apply-bridge-'));

    try {
      const { createWorkspaceReplicationCasBackedImportArtifacts } = await import('./createWorkspaceReplicationCasBackedImportArtifacts');

      const result = createWorkspaceReplicationCasBackedImportArtifacts({
        activeServerDir,
        sourceOffer: {
          offerId: 'offer_456',
          relationshipId: 'rel_456',
          directionId: 'dir_456',
          sourceFingerprint: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          manifest: {
            entries: [
              {
                relativePath: 'docs',
                kind: 'directory',
              },
            ],
            fingerprint: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          },
          blobIndex: [],
        },
      });

      expect(result.workspaceExportArtifacts).toEqual({
        manifest: {
          entries: [
            {
              relativePath: 'docs',
              kind: 'directory',
            },
          ],
          fingerprint: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
