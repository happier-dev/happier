import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationRelationshipStore', () => {
  it('builds a stable relationship id across direction reversals but keeps direction ids directional', async () => {
    const {
      buildWorkspaceReplicationDirectionId,
      buildWorkspaceReplicationRelationshipId,
    } = await import('./workspaceReplicationRelationshipStore');

    const forward = {
      sourceMachineId: 'machine_a',
      sourceWorkspaceRoot: '/repo//nested/',
      targetMachineId: 'machine_b',
      targetWorkspaceRoot: '/copy/./',
      mode: 'one_way_safe',
      ignorePatterns: ['node_modules', '.git'],
    } as const;
    const reverse = {
      sourceMachineId: 'machine_b',
      sourceWorkspaceRoot: '/copy',
      targetMachineId: 'machine_a',
      targetWorkspaceRoot: '/repo/nested',
      mode: 'one_way_safe',
      ignorePatterns: ['.git', 'node_modules'],
    } as const;

    expect(buildWorkspaceReplicationRelationshipId(forward)).toBe(
      buildWorkspaceReplicationRelationshipId(reverse),
    );
    expect(buildWorkspaceReplicationDirectionId(forward)).not.toBe(
      buildWorkspaceReplicationDirectionId(reverse),
    );
  });

  it('persists a canonical relationship record under the active server replication root', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-relationship-'));

    try {
      const {
        buildWorkspaceReplicationRelationshipId,
        createWorkspaceReplicationRelationshipStore,
      } = await import('./workspaceReplicationRelationshipStore');

      const store = createWorkspaceReplicationRelationshipStore({
        activeServerDir,
      });
      const scope = {
        sourceMachineId: 'machine_b',
        sourceWorkspaceRoot: '/copy',
        targetMachineId: 'machine_a',
        targetWorkspaceRoot: '/repo',
        mode: 'one_way_safe',
        ignorePatterns: ['.git', 'node_modules'],
      } as const;
      const relationshipId = buildWorkspaceReplicationRelationshipId(scope);

      const persisted = await store.upsert({
        scope,
        now: () => 123,
      });

      expect(persisted).toMatchObject({
        schemaVersion: 1,
        relationshipId,
        createdAtMs: 123,
        updatedAtMs: 123,
        config: {
          mode: 'one_way_safe',
          ignorePatterns: ['.git', 'node_modules'],
        },
        endpoints: [
          {
            machineId: 'machine_a',
            rootPath: '/repo',
          },
          {
            machineId: 'machine_b',
            rootPath: '/copy',
          },
        ],
      });
      expect(store.resolveFilePath(relationshipId)).toBe(
        join(activeServerDir, 'workspace-replication', 'relationships', relationshipId, 'relationship.json'),
      );

      const filePath = store.resolveFilePath(relationshipId);
      const persistedJson = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      delete persistedJson.schemaVersion;
      await writeFile(filePath, JSON.stringify(persistedJson), 'utf8');

      // This store is not deployed. Do not keep compatibility for schema-less records.
      await expect(store.readByScope(scope)).resolves.toBeNull();
      await expect(store.read(relationshipId)).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
