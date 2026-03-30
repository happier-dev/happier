import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceManifest } from '@happier-dev/protocol';

import { hashWorkspaceFile } from './workspaceExportPackaging/hashWorkspaceFile';
import { scanWorkspaceManifest } from './workspaceExportPackaging/scanWorkspaceManifest';
import {
  createWorkspaceSyncArtifactsFromManifest,
} from './workspaceSyncArtifacts';
import { applyWorkspaceSyncArtifacts } from './applyWorkspaceSyncArtifacts';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';

const tempRoots: string[] = [];

function cloneWorkspaceManifest(manifest: Readonly<{ entries: readonly WorkspaceManifest['entries'][number][]; fingerprint?: string }>): WorkspaceManifest {
  return {
    entries: manifest.entries.map((entry) => ({ ...entry })),
    ...(manifest.fingerprint ? { fingerprint: manifest.fingerprint } : {}),
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

function createSourcePathBlobProviderFromManifest(sourceRoot: string, manifest: WorkspaceManifest): Readonly<{
  getBlobFilePath: (digest: string) => string | null;
}> {
  const firstPathByDigest = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file') continue;
    if (!firstPathByDigest.has(entry.digest)) {
      firstPathByDigest.set(entry.digest, join(sourceRoot, entry.relativePath));
    }
  }
  return {
    getBlobFilePath: (digest) => firstPathByDigest.get(digest) ?? null,
  };
}

describe('applyWorkspaceSyncArtifacts', () => {
  it('fails closed when file changes are present but the blobProvider cannot resolve required blob digests', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-target-');
    await writeFile(join(targetRoot, 'README.md'), 'old-readme\n', 'utf8');
    await writeFile(join(targetRoot, 'keep.txt'), 'keep\n', 'utf8');
    await writeFile(join(targetRoot, 'old.ts'), 'old\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const sourceRoot = await makeTempDir('handoff-sync-apply-source-');
    await writeFile(join(sourceRoot, 'README.md'), 'new-readme\n', 'utf8');
    await writeFile(join(sourceRoot, 'keep.txt'), 'keep\n', 'utf8');
    await writeFile(join(sourceRoot, 'new.ts'), 'export {}\n', 'utf8');
    await symlink('README.md', join(sourceRoot, 'readme-link'));

    const nextManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: sourceRoot,
    }));

    const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
      currentManifest,
      nextManifest,
    });

    await expect(applyWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
      blobProvider: {
        getBlobFilePath: () => null,
      },
    })).rejects.toThrow(/blob/i);
  });

  it('applies changed workspace artifacts from a CAS-backed blob provider when inline blobs are absent', async () => {
    const activeServerDir = await makeTempDir('handoff-sync-apply-cas-');
    const targetRoot = await makeTempDir('handoff-sync-apply-provider-target-');
    await writeFile(join(targetRoot, 'README.md'), 'old-readme\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const sourceRoot = await makeTempDir('handoff-sync-apply-provider-source-');
    await writeFile(join(sourceRoot, 'README.md'), 'new-readme\n', 'utf8');
    await writeFile(join(sourceRoot, 'keep.txt'), 'keep\n', 'utf8');

    const nextManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: sourceRoot,
    }));
    const casStore = createWorkspaceReplicationCasStore({ activeServerDir });

    for (const entry of nextManifest.entries) {
      if (entry.kind !== 'file') {
        continue;
      }
      await casStore.commitFile({
        digest: entry.digest,
        sourcePath: join(sourceRoot, entry.relativePath),
      });
    }

    const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
      currentManifest,
      nextManifest,
      sourceControllerMetadata: null,
    });

    const applied = await applyWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
      blobProvider: {
        getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
      },
    });

    expect(applied).toEqual({ targetPath: targetRoot });
    await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('new-readme\n');
    await expect(readFile(join(targetRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
  });

  it('fails closed when a removed path escapes the target workspace', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-escape-');
    await writeFile(join(targetRoot, 'README.md'), 'hello\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));
    const digest = await hashWorkspaceFile({
      filePath: join(targetRoot, 'README.md'),
    });
    const syncArtifacts = {
      ...createWorkspaceSyncArtifactsFromManifest({
        currentManifest,
        nextManifest: { entries: [] },
      }),
      removedRelativePaths: ['../outside'],
    };

    await expect(applyWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
      blobProvider: createSourcePathBlobProviderFromManifest(targetRoot, {
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest,
            executable: false,
            sizeBytes: 6,
          },
        ],
      }),
    })).rejects.toThrow('Workspace transfer path escapes target: ../outside');
  });

  it('fails closed when a changed symlink target escapes the target workspace', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-symlink-');
    await writeFile(join(targetRoot, 'README.md'), 'hello\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const syncArtifacts = {
      ...createWorkspaceSyncArtifactsFromManifest({
        currentManifest,
        nextManifest: {
          entries: [
            {
              kind: 'symlink',
              relativePath: 'escape-link',
              target: '../outside',
            },
          ],
        },
      }),
    };

    await expect(applyWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
      blobProvider: {
        getBlobFilePath: () => null,
      },
    })).rejects.toThrow('Workspace transfer symlink target escapes target: ../outside');
  });

  it('replaces conflicting parent paths so nested changed entries can be applied', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-parent-conflict-');
    await writeFile(join(targetRoot, 'src'), 'old-parent-file\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const sourceRoot = await makeTempDir('handoff-sync-apply-parent-conflict-source-');
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'src', 'index.ts'), 'export const ready = true;\n', 'utf8');

    const nextManifest: WorkspaceManifest = {
      entries: [
        {
          kind: 'directory',
          relativePath: 'src',
        },
        {
          kind: 'file',
          relativePath: 'src/index.ts',
          digest: await hashWorkspaceFile({ filePath: join(sourceRoot, 'src', 'index.ts') }),
          executable: false,
          sizeBytes: Buffer.byteLength('export const ready = true;\n'),
        },
      ],
    };

    const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
      currentManifest,
      nextManifest,
    });

    await expect(applyWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
      blobProvider: createSourcePathBlobProviderFromManifest(sourceRoot, nextManifest),
    })).resolves.toEqual({ targetPath: targetRoot });
    await expect(readFile(join(targetRoot, 'src/index.ts'), 'utf8')).resolves.toBe('export const ready = true;\n');
  });

  it('rolls back touched sync paths when apply fails after partial mutation', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-rollback-');
    await writeFile(join(targetRoot, '000-first.txt'), 'old\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    await mkdir(join(targetRoot, 'locked'), { recursive: true });
    await chmod(join(targetRoot, 'locked'), 0o500);

    const sourceRoot = await makeTempDir('handoff-sync-apply-rollback-source-');
    await mkdir(join(sourceRoot, 'locked'), { recursive: true });
    await writeFile(join(sourceRoot, '000-first.txt'), 'new\n', 'utf8');
    await writeFile(join(sourceRoot, 'locked', 'new.txt'), 'new-file\n', 'utf8');

    const nextManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: sourceRoot,
    }));

    const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
      currentManifest,
      nextManifest,
    });

    try {
      await expect(applyWorkspaceSyncArtifacts({
        targetPath: targetRoot,
        syncArtifacts,
        blobProvider: createSourcePathBlobProviderFromManifest(sourceRoot, nextManifest),
      })).rejects.toMatchObject({
        code: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
    } finally {
      await chmod(join(targetRoot, 'locked'), 0o755);
    }

    await expect(readFile(join(targetRoot, '000-first.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(targetRoot, 'locked', 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back touched sync paths when apply is aborted after a partial mutation', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-abort-');
    await writeFile(join(targetRoot, '000-first.txt'), 'old\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const sourceRoot = await makeTempDir('handoff-sync-apply-abort-source-');
    await mkdir(join(sourceRoot, 'nested'), { recursive: true });
    await writeFile(join(sourceRoot, '000-first.txt'), 'new\n', 'utf8');
    await writeFile(join(sourceRoot, 'nested', 'new.txt'), 'new-file\n', 'utf8');

    const nextManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: sourceRoot,
    }));

    const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
      currentManifest,
      nextManifest,
    });

    const params: Parameters<typeof applyWorkspaceSyncArtifacts>[0] & Readonly<{
      assertCanContinue: () => Promise<void>;
    }> = {
      targetPath: targetRoot,
      syncArtifacts,
      blobProvider: createSourcePathBlobProviderFromManifest(sourceRoot, nextManifest),
      assertCanContinue: async () => {
        const firstFile = await readFile(join(targetRoot, '000-first.txt'), 'utf8').catch(() => null);
        if (firstFile === 'new\n') {
          throw new Error('abort requested');
        }
      },
    };

    await expect(applyWorkspaceSyncArtifacts(params)).rejects.toThrow('abort requested');
    await expect(readFile(join(targetRoot, '000-first.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(targetRoot, 'nested', 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
