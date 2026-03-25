import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationDigestCacheStore', () => {
  it('persists a relationship-scoped digest cache under the replication relationship directory', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-digest-cache-'));

    try {
      const {
        createWorkspaceReplicationRelationshipStore,
      } = await import('../relationships/workspaceReplicationRelationshipStore');
      const {
        createWorkspaceReplicationDigestCacheStore,
      } = await import('./workspaceReplicationDigestCacheStore');

      const relationships = createWorkspaceReplicationRelationshipStore({
        activeServerDir,
      });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine_a',
        sourceWorkspaceRoot: '/repo',
        targetMachineId: 'machine_b',
        targetWorkspaceRoot: '/copy',
        mode: 'one_way_safe',
      });
      const store = createWorkspaceReplicationDigestCacheStore({
        activeServerDir,
      });

      await store.save({
        relationshipId: relationship.relationshipId,
        entries: {
          'README.md': {
            sizeBytes: 6,
            mtimeMs: 123,
            executable: false,
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
          },
        },
      });

      expect(store.resolveFilePath(relationship.relationshipId)).toBe(
        join(
          activeServerDir,
          'workspace-replication',
          'relationships',
          relationship.relationshipId,
          'digestCache',
          'cache.json',
        ),
      );

      const filePath = store.resolveFilePath(relationship.relationshipId);
      const persistedJson = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      delete persistedJson.schemaVersion;
      await writeFile(filePath, JSON.stringify(persistedJson), 'utf8');

      // This store is not deployed. Do not keep compatibility for schema-less records.
      await expect(store.load(relationship.relationshipId)).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
