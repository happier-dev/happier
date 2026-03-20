import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceManifest } from '@happier-dev/protocol';

import {
  buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries,
  createScmSourceControllerWorkspaceExportArtifacts,
} from '@/scm/sourceController/workspaceExportArtifacts';
import { hashWorkspaceFile } from '@/scm/sourceController/workspaceExportPackaging/hashWorkspaceFile';
import { scanWorkspaceManifest } from '@/scm/sourceController/workspaceExportPackaging/scanWorkspaceManifest';

import { applySessionHandoffWorkspaceSyncArtifacts } from './applySessionHandoffWorkspaceSyncArtifacts';
import { createSessionHandoffWorkspaceSyncArtifacts } from './createSessionHandoffWorkspaceSyncArtifacts';

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

describe('applySessionHandoffWorkspaceSyncArtifacts', () => {
  it('applies changed workspace artifacts and removals onto the target workspace', async () => {
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

    const workspaceExportArtifacts = await buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries({
      entries: [
        { relativePath: 'README.md', sourcePath: join(sourceRoot, 'README.md') },
        { relativePath: 'keep.txt', sourcePath: join(sourceRoot, 'keep.txt') },
        { relativePath: 'new.ts', sourcePath: join(sourceRoot, 'new.ts') },
        { relativePath: 'readme-link', sourcePath: join(sourceRoot, 'readme-link') },
      ],
    });

    const syncArtifacts = createSessionHandoffWorkspaceSyncArtifacts({
      currentManifest,
      workspaceExportArtifacts,
    });

    const applied = await applySessionHandoffWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
    });

    expect(applied).toEqual({ targetPath: targetRoot });
    await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('new-readme\n');
    await expect(readFile(join(targetRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
    await expect(readFile(join(targetRoot, 'new.ts'), 'utf8')).resolves.toBe('export {}\n');
    await expect(readlink(join(targetRoot, 'readme-link'))).resolves.toBe('README.md');
    await expect(readFile(join(targetRoot, 'old.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
      ...createSessionHandoffWorkspaceSyncArtifacts({
        currentManifest,
        workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
          manifest: { entries: [], fingerprint: 'sha256:empty' },
          blobContentsByDigest: new Map(),
          sourceControllerMetadata: null,
        }),
      }),
      removedRelativePaths: ['../outside'],
      changedWorkspaceArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
        manifest: {
          entries: [
            {
              kind: 'file' as const,
              relativePath: 'README.md',
              digest,
              executable: false,
              sizeBytes: 6,
            },
          ],
          fingerprint: 'sha256:stay',
        },
        blobContentsByDigest: new Map([[digest, Buffer.from('hello\n', 'utf8')]]),
        sourceControllerMetadata: null,
      }),
    };

    await expect(applySessionHandoffWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
    })).rejects.toThrow('Workspace transfer path escapes target: ../outside');
  });

  it('fails closed when a changed symlink target escapes the target workspace', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-symlink-');
    await writeFile(join(targetRoot, 'README.md'), 'hello\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const syncArtifacts = {
      ...createSessionHandoffWorkspaceSyncArtifacts({
        currentManifest,
        workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
          manifest: { entries: [], fingerprint: 'sha256:empty' },
          blobContentsByDigest: new Map(),
          sourceControllerMetadata: null,
        }),
      }),
      changedWorkspaceArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
        manifest: {
          entries: [
            {
              kind: 'symlink' as const,
              relativePath: 'escape-link',
              target: '../outside',
            },
          ],
          fingerprint: 'sha256:escape',
        },
        blobContentsByDigest: new Map(),
        sourceControllerMetadata: null,
      }),
    };

    await expect(applySessionHandoffWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
    })).rejects.toThrow('Workspace transfer symlink target escapes target: ../outside');
  });

  it('replaces conflicting parent paths so nested changed entries can be applied', async () => {
    const targetRoot = await makeTempDir('handoff-sync-apply-parent-conflict-');
    await writeFile(join(targetRoot, 'src'), 'old-parent-file\n', 'utf8');

    const currentManifest = cloneWorkspaceManifest(await scanWorkspaceManifest({
      workspaceRoot: targetRoot,
    }));

    const sourceRoot = await makeTempDir('handoff-sync-apply-parent-conflict-source-');
    await writeFile(join(sourceRoot, 'src-index.ts'), 'export const ready = true;\n', 'utf8');

    const workspaceExportArtifacts = await buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries({
      entries: [
        { relativePath: 'src/index.ts', sourcePath: join(sourceRoot, 'src-index.ts') },
      ],
    });

    const syncArtifacts = createSessionHandoffWorkspaceSyncArtifacts({
      currentManifest,
      workspaceExportArtifacts,
    });

    await expect(applySessionHandoffWorkspaceSyncArtifacts({
      targetPath: targetRoot,
      syncArtifacts,
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

    const workspaceExportArtifacts = await buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries({
      entries: [
        { relativePath: '000-first.txt', sourcePath: join(sourceRoot, '000-first.txt') },
        { relativePath: 'locked/new.txt', sourcePath: join(sourceRoot, 'locked', 'new.txt') },
      ],
    });

    const syncArtifacts = createSessionHandoffWorkspaceSyncArtifacts({
      currentManifest,
      workspaceExportArtifacts,
    });

    try {
      await expect(applySessionHandoffWorkspaceSyncArtifacts({
        targetPath: targetRoot,
        syncArtifacts,
      })).rejects.toMatchObject({
        code: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
    } finally {
      await chmod(join(targetRoot, 'locked'), 0o755);
    }

    await expect(readFile(join(targetRoot, '000-first.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(targetRoot, 'locked', 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
