import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scanWorkspaceManifestIntoCas', () => {
  it('commits scanned file blobs into CAS and reuses cache plus CAS on a second unreadable scan', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scan-cas-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-scan-workspace-'));
    const filePath = join(workspaceRoot, 'README.md');
    await writeFile(filePath, 'hello\n');

    try {
      const {
        createWorkspaceReplicationRelationshipStore,
      } = await import('../relationships/workspaceReplicationRelationshipStore');
      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        scanWorkspaceManifestIntoCas,
      } = await import('./scanWorkspaceManifestIntoCas');

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
      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      const digest = 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';

      await expect(scanWorkspaceManifestIntoCas({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        workspaceRoot,
      })).resolves.toEqual({
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest,
            executable: false,
            sizeBytes: 6,
          },
        ],
      });

      await expect(casStore.contains(digest)).resolves.toBe(true);
      await expect(readFile(casStore.resolveBlobPath(digest), 'utf8')).resolves.toBe('hello\n');

      await chmod(filePath, 0o000);

      await expect(scanWorkspaceManifestIntoCas({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        workspaceRoot,
      })).resolves.toEqual({
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest,
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
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scan-cas-abort-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-scan-workspace-abort-'));
    await writeFile(join(workspaceRoot, 'a.txt'), 'a\n');
    await writeFile(join(workspaceRoot, 'b.txt'), 'b\n');

    try {
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { scanWorkspaceManifestIntoCas } = await import('./scanWorkspaceManifestIntoCas');

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

      let calls = 0;
      await expect(scanWorkspaceManifestIntoCas({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        workspaceRoot,
        assertCanContinue() {
          calls += 1;
          if (calls > 1) {
            throw new Error('cancelled');
          }
        },
      })).rejects.toThrow('cancelled');
      expect(calls).toBeGreaterThan(0);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
