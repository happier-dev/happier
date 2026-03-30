import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationBaselineStore', () => {
  it('builds stable cache keys for normalized source and target roots', async () => {
    const { buildWorkspaceReplicationBaselineCacheKey } = await import('./baselineCacheKeys');

    const first = buildWorkspaceReplicationBaselineCacheKey({
      sourceMachineId: 'machine_a',
      sourceWorkspaceRoot: '/repo//nested/',
      targetMachineId: 'machine_b',
      targetWorkspaceRoot: '/copy/./',
      mode: 'one_way_safe',
    });
    const second = buildWorkspaceReplicationBaselineCacheKey({
      sourceMachineId: 'machine_a',
      sourceWorkspaceRoot: '/repo/nested',
      targetMachineId: 'machine_b',
      targetWorkspaceRoot: '/copy',
      mode: 'one_way_safe',
    });

    expect(first).toBe(second);
  });

  it('saves and loads a directional baseline under the active server replication root', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-baseline-'));

    try {
      const {
        createWorkspaceReplicationBaselineStore,
      } = await import('./workspaceReplicationBaselineStore');
      const {
        buildWorkspaceReplicationDirectionId,
        buildWorkspaceReplicationRelationshipId,
      } = await import('../relationships/workspaceReplicationRelationshipStore');

      const store = createWorkspaceReplicationBaselineStore({
        activeServerDir,
      });
      const scope = {
        sourceMachineId: 'machine_a',
        sourceWorkspaceRoot: '/repo',
        targetMachineId: 'machine_b',
        targetWorkspaceRoot: '/copy',
        mode: 'one_way_safe',
      } as const;
      const relationshipId = buildWorkspaceReplicationRelationshipId(scope);
      const directionId = buildWorkspaceReplicationDirectionId(scope);

      await store.save({
        scope,
        baseline: {
          manifestFingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          savedAtMs: 123,
        },
      });

      const filePath = store.resolveFilePath(scope);
      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      // This store is not deployed. Do not keep compatibility for schema-less records.
      delete persisted.schemaVersion;
      await writeFile(filePath, JSON.stringify(persisted), 'utf8');

      expect(store.resolveFilePath(scope)).toBe(
        join(
          activeServerDir,
          'workspace-replication',
          'relationships',
          relationshipId,
          'directionalBaselines',
          directionId,
          'baseline.json',
        ),
      );
      await expect(store.load(scope)).rejects.toThrow('Invalid workspace replication baseline record');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
