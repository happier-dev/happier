import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('workspaceReplicationCasStore', () => {
  it('commits a verified blob into the canonical sha256 CAS path', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-cas-'));
    const sourcePath = join(activeServerDir, 'source.bin');
    const payload = Buffer.from('workspace-replication-cas-payload', 'utf8');
    await writeFile(sourcePath, payload);

    const { createWorkspaceReplicationCasStore } = await import('./workspaceReplicationCasStore');

    try {
      const store = createWorkspaceReplicationCasStore({ activeServerDir });
      const digest = createSha256Digest(payload);

      const committed = await store.commitFile({
        digest,
        sourcePath,
      });

      const hex = digest.slice('sha256:'.length);
      expect(committed).toEqual({
        digest,
        blobPath: join(activeServerDir, 'workspace-replication', 'cas', 'sha256', hex.slice(0, 2), hex),
        sizeBytes: payload.length,
      });
      await expect(store.contains(digest)).resolves.toBe(true);
      await expect(readFile(store.resolveBlobPath(digest))).resolves.toEqual(payload);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects a blob whose content does not match the requested digest', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-cas-'));
    const sourcePath = join(activeServerDir, 'source.bin');
    const payload = Buffer.from('workspace-replication-cas-payload', 'utf8');
    await writeFile(sourcePath, payload);

    const { createWorkspaceReplicationCasStore } = await import('./workspaceReplicationCasStore');

    try {
      const store = createWorkspaceReplicationCasStore({ activeServerDir });

      await expect(store.commitFile({
        digest: createSha256Digest(Buffer.from('different-payload', 'utf8')),
        sourcePath,
      })).rejects.toThrow('Workspace replication CAS digest mismatch');

      await expect(store.contains(createSha256Digest(payload))).resolves.toBe(false);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
