import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import { seedWorkspaceReplicationCasBlobsFromManifest } from './seedWorkspaceReplicationCasBlobsFromManifest';

describe('seedWorkspaceReplicationCasBlobsFromManifest', () => {
  it('commits missing digests into the CAS store using the workspace manifest', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-wsrepl-seed-cas-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-wsrepl-seed-cas-workspace-'));
    try {
      const blobContent = Buffer.from('hello\n', 'utf8');
      const digest = `sha256:${createHash('sha256').update(blobContent).digest('hex')}`;
      const relativePath = 'blob.txt';
      await writeFile(join(workspaceRoot, relativePath), blobContent);

      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await expect(casStore.contains(digest)).resolves.toBe(false);

      await seedWorkspaceReplicationCasBlobsFromManifest({
        activeServerDir,
        sourceRootPath: workspaceRoot,
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath,
              digest,
              sizeBytes: blobContent.byteLength,
              executable: false,
            },
          ],
          fingerprint: 'fingerprint',
        },
        digests: [digest],
      });

      await expect(casStore.contains(digest)).resolves.toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the manifest relativePath is unsafe', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-wsrepl-seed-cas-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-wsrepl-seed-cas-workspace-'));
    try {
      const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      await expect(seedWorkspaceReplicationCasBlobsFromManifest({
        activeServerDir,
        sourceRootPath: workspaceRoot,
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: '../escape.txt',
              digest,
              sizeBytes: 1,
              executable: false,
            },
          ],
          fingerprint: 'fingerprint',
        },
        digests: [digest],
      })).rejects.toThrow('unsafe');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
