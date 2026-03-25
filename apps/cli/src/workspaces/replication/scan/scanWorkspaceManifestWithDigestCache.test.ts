import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scanWorkspaceManifestWithDigestCache', () => {
  it('reuses a saved relationship-scoped digest cache entry when the file cannot be reread', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scan-cache-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-workspace-'));
    const filePath = join(workspaceRoot, 'README.md');
    await writeFile(filePath, 'hello\n');

    try {
      const {
        createWorkspaceReplicationRelationshipStore,
      } = await import('../relationships/workspaceReplicationRelationshipStore');
      const {
        createWorkspaceReplicationDigestCacheStore,
      } = await import('./workspaceReplicationDigestCacheStore');
      const {
        scanWorkspaceManifestWithDigestCache,
      } = await import('./scanWorkspaceManifestWithDigestCache');

      const relationships = createWorkspaceReplicationRelationshipStore({
        activeServerDir,
      });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine_a',
        sourceWorkspaceRoot: workspaceRoot,
        targetMachineId: 'machine_b',
        targetWorkspaceRoot: '/copy',
        mode: 'one_way_safe',
      });
      const digestCacheStore = createWorkspaceReplicationDigestCacheStore({
        activeServerDir,
      });

      await expect(scanWorkspaceManifestWithDigestCache({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        workspaceRoot,
      })).resolves.toEqual({
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            executable: false,
            sizeBytes: 6,
          },
        ],
      });

      await expect(digestCacheStore.load(relationship.relationshipId)).resolves.toMatchObject({
        entries: {
          'README.md': {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
            executable: false,
          },
        },
      });

      await chmod(filePath, 0o000);

      await expect(scanWorkspaceManifestWithDigestCache({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        workspaceRoot,
      })).resolves.toEqual({
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            executable: false,
            sizeBytes: 6,
          },
        ],
      });
    } finally {
      await chmod(filePath, 0o644).catch(() => undefined);
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('aborts scanning when assertCanContinue throws (cancellation/lease-loss)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scan-cache-abort-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-workspace-abort-'));
    await writeFile(join(workspaceRoot, 'a.txt'), 'a\n');
    await writeFile(join(workspaceRoot, 'b.txt'), 'b\n');

    try {
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { scanWorkspaceManifestWithDigestCache } = await import('./scanWorkspaceManifestWithDigestCache');

      const relationships = createWorkspaceReplicationRelationshipStore({
        activeServerDir,
      });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine_a',
        sourceWorkspaceRoot: workspaceRoot,
        targetMachineId: 'machine_b',
        targetWorkspaceRoot: '/copy',
        mode: 'one_way_safe',
      });

      let scannedCount = 0;
      let shouldCancel = false;

      await expect(scanWorkspaceManifestWithDigestCache({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        workspaceRoot,
        assertCanContinue() {
          if (shouldCancel) {
            throw new Error('cancelled');
          }
        },
        onFileScanned() {
          scannedCount += 1;
          shouldCancel = true;
        },
      })).rejects.toThrow('cancelled');

      expect(scannedCount).toBe(1);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
