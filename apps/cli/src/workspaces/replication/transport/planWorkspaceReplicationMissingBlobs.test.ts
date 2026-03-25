import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('planWorkspaceReplicationMissingBlobs', () => {
  it('returns only CAS-missing blobs plus truthful byte and file counts', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-missing-blobs-'));
    const existingPath = join(activeServerDir, 'existing.txt');

    try {
      await writeFile(existingPath, 'hello\n', 'utf8');

      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { planWorkspaceReplicationMissingBlobs } = await import('./planWorkspaceReplicationMissingBlobs');

      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      await casStore.commitFile({
        digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
        sourcePath: existingPath,
      });

      await expect(planWorkspaceReplicationMissingBlobs({
        activeServerDir,
        blobIndex: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
          },
          {
            digest: 'sha256:bf718b6f653bebcce8cd256dfa69dd0b21358d4c54d9993d8d4f020fb20f95fc',
            sizeBytes: 9,
          },
        ],
      })).resolves.toEqual({
        missingBlobs: [
          {
            digest: 'sha256:bf718b6f653bebcce8cd256dfa69dd0b21358d4c54d9993d8d4f020fb20f95fc',
            sizeBytes: 9,
          },
        ],
        plannedFileCount: 1,
        plannedByteCount: 9,
        alreadyPresentFileCount: 1,
        alreadyPresentByteCount: 6,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('dedupes repeated digests in the blob index so the engine never transfers the same CAS blob twice', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-missing-blobs-dedupe-'));
    try {
      const { planWorkspaceReplicationMissingBlobs } = await import('./planWorkspaceReplicationMissingBlobs');

      await expect(planWorkspaceReplicationMissingBlobs({
        activeServerDir,
        blobIndex: [
          {
            digest: 'sha256:bf718b6f653bebcce8cd256dfa69dd0b21358d4c54d9993d8d4f020fb20f95fc',
            sizeBytes: 9,
          },
          {
            digest: 'sha256:bf718b6f653bebcce8cd256dfa69dd0b21358d4c54d9993d8d4f020fb20f95fc',
            sizeBytes: 9,
          },
        ],
      })).resolves.toEqual({
        missingBlobs: [
          {
            digest: 'sha256:bf718b6f653bebcce8cd256dfa69dd0b21358d4c54d9993d8d4f020fb20f95fc',
            sizeBytes: 9,
          },
        ],
        plannedFileCount: 1,
        plannedByteCount: 9,
        alreadyPresentFileCount: 0,
        alreadyPresentByteCount: 0,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
