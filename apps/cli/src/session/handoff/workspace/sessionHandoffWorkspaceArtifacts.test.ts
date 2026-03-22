import { constants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ScmBackend } from '@/scm/types';
import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import {
    createSessionHandoffTransferredBundles,
    sessionHandoffTransferredBundlesCodec,
} from '../transfer/sessionHandoffTransferredBundles';
import {
    buildSessionHandoffWorkspaceExportArtifacts,
    buildSessionHandoffWorkspaceExportPayload,
    importSessionHandoffWorkspaceArtifacts,
} from './sessionHandoffWorkspaceArtifacts';
import * as workspaceArtifactsModule from './sessionHandoffWorkspaceArtifacts';
import { walkWorkspaceExportTree } from '@/scm/sourceController/workspaceExportFallbackEntries';

type WorkspaceImportParamsHasLegacyBundle =
  'bundle' extends keyof Parameters<typeof importSessionHandoffWorkspaceArtifacts>[0] ? true : false;

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readGit(cwd: string, args: readonly string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function createSourceControllerTestBackend(input: {
  detectionRootPath: string;
  sourceController?: ScmBackend['sourceController'];
}): ScmBackend {
  return {
    id: 'git',
    selection: {
      modeSelectionScores: {
        '.git': 200,
      },
    },
    sourceController: input.sourceController,
    detectRepo: async () => ({
      isRepo: true,
      mode: '.git',
      rootPath: input.detectionRootPath,
    }),
    getCapabilities: () => ({
      readStatus: true,
      readDiffFile: true,
      readDiffCommit: true,
      readLog: true,
      readBranches: true,
      readStash: true,
      writeInclude: true,
      writeExclude: true,
      writeDiscard: true,
      writeCommit: true,
      writeCommitPathSelection: true,
      writeCommitLineSelection: true,
      writeBackout: true,
      writeRemoteFetch: true,
      writeRemotePull: true,
      writeRemotePush: true,
      writeRemotePublish: true,
      worktreeCreate: false,
      changeSetModel: 'index',
      supportedDiffAreas: ['included', 'pending', 'both'],
      writeBranchCreate: true,
      writeBranchCheckout: true,
      writeStash: true,
    }),
    describeBackend: async () => {
      throw new Error('not needed in this test');
    },
    statusSnapshot: async () => {
      throw new Error('not needed in this test');
    },
    diffFile: async () => {
      throw new Error('not needed in this test');
    },
    diffCommit: async () => {
      throw new Error('not needed in this test');
    },
    changeInclude: async () => {
      throw new Error('not needed in this test');
    },
    changeExclude: async () => {
      throw new Error('not needed in this test');
    },
    changeDiscard: async () => {
      throw new Error('not needed in this test');
    },
    commitCreate: async () => {
      throw new Error('not needed in this test');
    },
    commitBackout: async () => {
      throw new Error('not needed in this test');
    },
    logList: async () => {
      throw new Error('not needed in this test');
    },
    branchList: async () => {
      throw new Error('not needed in this test');
    },
    branchCreate: async () => {
      throw new Error('not needed in this test');
    },
    branchCheckout: async () => {
      throw new Error('not needed in this test');
    },
    worktreeCreate: async () => {
      throw new Error('not needed in this test');
    },
    worktreeRemove: async () => {
      throw new Error('not needed in this test');
    },
    worktreePrune: async () => {
      throw new Error('not needed in this test');
    },
    remoteFetch: async () => {
      throw new Error('not needed in this test');
    },
    remotePull: async () => {
      throw new Error('not needed in this test');
    },
    remotePush: async () => {
      throw new Error('not needed in this test');
    },
    remotePublish: async () => {
      throw new Error('not needed in this test');
    },
    stashList: async () => {
      throw new Error('not needed in this test');
    },
    stashDrop: async () => {
      throw new Error('not needed in this test');
    },
    stashPop: async () => {
      throw new Error('not needed in this test');
    },
    stashApply: async () => {
      throw new Error('not needed in this test');
    },
    stashShow: async () => {
      throw new Error('not needed in this test');
    },
  } satisfies ScmBackend;
}

async function buildRequiredWorkspaceExportArtifacts(
  params: Parameters<typeof buildSessionHandoffWorkspaceExportArtifacts>[0],
): Promise<ScmSourceControllerWorkspaceExportArtifacts> {
  const artifacts = await buildSessionHandoffWorkspaceExportArtifacts(params);
  if (!artifacts) {
    throw new Error('Expected workspace export artifacts');
  }
  return artifacts;
}

describe('sessionHandoffWorkspaceArtifacts', () => {
  it('keeps workspace import artifact-first internally', () => {
    expectTypeOf<WorkspaceImportParamsHasLegacyBundle>().toEqualTypeOf<false>();
    expect('exportSessionHandoffWorkspaceBundle' in workspaceArtifactsModule).toBe(false);
    expect('deriveSessionHandoffWorkspaceBundleFromExportArtifacts' in workspaceArtifactsModule).toBe(false);
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0, tempRoots.length).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('exports tracked, untracked, git metadata, and selected ignored files', async () => {
    const root = await makeTempDir('handoff-workspace-');
    await runGit(root, ['init']);
    await writeFile(join(root, '.gitignore'), 'dist/\n.env.local\n');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'src', 'tracked.txt'), 'tracked\n');
    await writeFile(join(root, 'notes.txt'), 'notes\n');
    await writeFile(join(root, 'dist', 'ignored.txt'), 'ignored\n');
    await writeFile(join(root, '.env.local'), 'SECRET=1\n');
    await symlink('tracked.txt', join(root, 'tracked-link'));
    await runGit(root, ['add', '.gitignore', 'src/tracked.txt']);

    const defaultArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(defaultArtifacts).toEqual(expect.objectContaining({
      manifest: expect.objectContaining({
        entries: expect.arrayContaining([
        expect.objectContaining({ relativePath: '.git/HEAD', kind: 'file' }),
        expect.objectContaining({ relativePath: '.gitignore', kind: 'file' }),
        expect.objectContaining({ relativePath: 'notes.txt', kind: 'file' }),
        expect.objectContaining({ relativePath: 'src/tracked.txt', kind: 'file' }),
        expect.objectContaining({ relativePath: 'tracked-link', kind: 'symlink', target: 'tracked.txt' }),
        ]),
      }),
    }));
    expect(defaultArtifacts.manifest.entries.some((entry) => entry.relativePath === 'dist/ignored.txt')).toBe(false);
    expect(defaultArtifacts.manifest.entries.some((entry) => entry.relativePath === '.env.local')).toBe(false);

    const selectedIgnoredArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**', '.env.local'],
      },
    });

    expect(selectedIgnoredArtifacts.manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'dist/ignored.txt', kind: 'file' }),
      expect.objectContaining({ relativePath: '.env.local', kind: 'file' }),
    ]));
  });

  it('exports worktree contents without non-portable git metadata when .git is a gitdir file', async () => {
    const root = await makeTempDir('handoff-worktree-');
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    await mkdir(repo, { recursive: true });
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.name', 'Happier Test']);
    await runGit(repo, ['config', 'user.email', 'happier-test@example.com']);
    await writeFile(join(repo, 'README.md'), 'main\n');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'init']);
    await runGit(repo, ['worktree', 'add', '-b', 'handoff-test-branch', worktree, 'HEAD']);

    const gitPointer = await readFile(join(worktree, '.git'), 'utf8');
    expect(gitPointer).toContain('gitdir:');

    const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: worktree,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(workspaceExportArtifacts.manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'README.md', kind: 'file' }),
    ]));
    expect(workspaceExportArtifacts.manifest.entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
  });

  it('derives a replication-style manifest and staged blob map directly from export artifacts', async () => {
    const root = await makeTempDir('handoff-export-artifacts-');
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(root, 'bin', 'run.sh'), 0o755);
    await writeFile(join(root, 'docs', 'copy.sh'), '#!/bin/sh\necho hi\n');
    await writeFile(join(root, 'README.md'), 'hello\n');
    await symlink('../README.md', join(root, 'docs', 'readme-link'));

    const artifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(artifacts.manifest.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifacts.manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'bin', kind: 'directory' }),
      expect.objectContaining({ relativePath: 'docs', kind: 'directory' }),
      expect.objectContaining({ relativePath: 'docs/readme-link', kind: 'symlink', target: '../README.md' }),
      expect.objectContaining({ relativePath: 'README.md', kind: 'file', executable: false, sizeBytes: 6 }),
      expect.objectContaining({ relativePath: 'bin/run.sh', kind: 'file', executable: true, sizeBytes: 18 }),
      expect.objectContaining({ relativePath: 'docs/copy.sh', kind: 'file', executable: false, sizeBytes: 18 }),
    ]));

    const shellEntries = artifacts.manifest.entries.filter(
      (entry): entry is Extract<(typeof artifacts.manifest.entries)[number], { kind: 'file' }> =>
        entry.kind === 'file' && (entry.relativePath === 'bin/run.sh' || entry.relativePath === 'docs/copy.sh'),
    );
    expect(shellEntries).toHaveLength(2);
    expect(new Set(shellEntries.map((entry) => entry.digest)).size).toBe(1);
    expect(artifacts.blobContentsByDigest.size).toBe(2);
    expect(Buffer.from(artifacts.blobContentsByDigest.get(shellEntries[0]!.digest) ?? []).toString('utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('builds a manifest-only handoff export payload with a file-backed blob provider without eagerly seeding CAS', async () => {
    const activeServerDir = await makeTempDir('handoff-export-payload-active-server-');
    const root = await makeTempDir('handoff-export-payload-root-');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'hello\n');
    await writeFile(join(root, 'docs', 'copy.md'), 'hello\n');
    await symlink('../README.md', join(root, 'docs', 'readme-link'));

    const exportPayload = await buildSessionHandoffWorkspaceExportPayload({
      activeServerDir,
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(exportPayload.workspaceExportArtifacts).toEqual(expect.objectContaining({
      manifest: expect.objectContaining({
        entries: expect.arrayContaining([
          {
            kind: 'file',
            relativePath: 'README.md',
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            executable: false,
            sizeBytes: 6,
          },
          {
            kind: 'directory',
            relativePath: 'docs',
          },
          {
            kind: 'file',
            relativePath: 'docs/copy.md',
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            executable: false,
            sizeBytes: 6,
          },
          {
            kind: 'symlink',
            relativePath: 'docs/readme-link',
            target: '../README.md',
          },
        ]),
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      }),
      blobContentsByDigest: new Map(),
    }));
    expect(exportPayload.blobProvider).toBeDefined();

    const casStore = createWorkspaceReplicationCasStore({
      activeServerDir,
    });
    await expect(casStore.contains('sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03')).resolves.toBe(false);
    expect(
      exportPayload.blobProvider!.getBlobFilePath(
        'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
      ),
    ).toBe(join(root, 'README.md'));
    await expect(
      readFile(
        exportPayload.blobProvider!.getBlobFilePath(
          'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
        )!,
        'utf8',
      ),
    ).resolves.toBe('hello\n');
  });

  it('imports a linked worktree bundle as plain workspace content without git admin state', async () => {
    const root = await makeTempDir('handoff-worktree-import-reject-');
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const target = join(root, 'target');
    await mkdir(repo, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.txt'), 'old\n');
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.name', 'Happier Test']);
    await runGit(repo, ['config', 'user.email', 'happier-test@example.com']);
    await writeFile(join(repo, 'README.md'), 'main\n');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'init']);
    await runGit(repo, ['worktree', 'add', '-b', 'handoff-import-test-branch', worktree, 'HEAD']);

    const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: worktree,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('main\n');
    await expect(readFile(join(target, '.git'), 'utf8')).rejects.toThrow();
  });

  it('exports linked-worktree git metadata and restores branch context on replace-existing import', async () => {
    const root = await makeTempDir('handoff-worktree-import-git-metadata-');
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const target = join(root, 'target');
    await mkdir(repo, { recursive: true });
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.name', 'Happier Test']);
    await runGit(repo, ['config', 'user.email', 'happier-test@example.com']);
    await writeFile(join(repo, 'README.md'), 'main\n');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'init']);
    await runGit(tmpdir(), ['clone', repo, target]);
    await runGit(repo, ['worktree', 'add', '-b', 'handoff-import-branch', worktree, 'HEAD']);
    await writeFile(join(worktree, 'README.md'), 'feature\n');
    await runGit(worktree, ['add', 'README.md']);
    await runGit(worktree, ['commit', '-m', 'feature']);
    const headRevision = await readGit(worktree, ['rev-parse', 'HEAD']);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: worktree,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    expect(workspaceExportArtifacts).toHaveProperty('sourceControllerMetadata', {
      provider: 'git',
      checkoutKind: 'branch',
      branchName: 'handoff-import-branch',
      headRevision,
    });

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readGit(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('handoff-import-branch');
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('feature\n');
    await expect(readGit(target, ['status', '--short', '--branch'])).resolves.toContain('## handoff-import-branch');
  });

  it('exports linked-worktree detached metadata and restores detached HEAD context on replace-existing import', async () => {
    const root = await makeTempDir('handoff-worktree-import-detached-git-metadata-');
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const target = join(root, 'target');
    await mkdir(repo, { recursive: true });
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.name', 'Happier Test']);
    await runGit(repo, ['config', 'user.email', 'happier-test@example.com']);
    await writeFile(join(repo, 'README.md'), 'main\n');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'init']);
    await runGit(repo, ['worktree', 'add', '-b', 'handoff-import-detached-branch', worktree, 'HEAD']);
    await writeFile(join(worktree, 'README.md'), 'detached\n');
    await runGit(worktree, ['add', 'README.md']);
    await runGit(worktree, ['commit', '-m', 'detached-feature']);
    const headRevision = await readGit(worktree, ['rev-parse', 'HEAD']);
    await runGit(worktree, ['checkout', headRevision]);
    await runGit(tmpdir(), ['clone', repo, target]);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: worktree,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    expect(workspaceExportArtifacts).toHaveProperty('sourceControllerMetadata', {
      provider: 'git',
      checkoutKind: 'detached',
      headRevision,
    });

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readGit(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).rejects.toThrow();
    await expect(readGit(target, ['rev-parse', 'HEAD'])).resolves.toBe(headRevision);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('detached\n');
    await expect(readGit(target, ['status', '--short', '--branch'])).resolves.toContain('## HEAD (no branch)');
  });

  it('runs portable workspace entry guards through the shared source-controller seam before import staging', async () => {
    const target = await makeTempDir('handoff-import-portability-');
    const registry = createScmBackendRegistry([
      createSourceControllerTestBackend({
        detectionRootPath: target,
        sourceController: {
          inspectWorkspaceLocation: async () => null,
          assertPortableWorkspaceEntries: async ({ entries }) => {
            if (entries.some((entry) => entry.relativePath === '.backend/private')) {
              throw new Error('backend-owned metadata is not portable');
            }
          },
        },
      }),
    ]);

    await expect(importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: '.backend/private',
              kind: 'file',
              digest: 'sha256:secret',
              sizeBytes: 7,
              executable: false,
            },
          ],
          fingerprint: 'sha256:portability-test',
        },
        blobContentsByDigest: new Map([
          ['sha256:secret', Buffer.from('secret\n', 'utf8')],
        ]),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      registry,
    })).rejects.toThrow('backend-owned metadata is not portable');
  });

  it('rejects non-portable source-controller transfer entries before export artifacts are built', async () => {
    const root = await makeTempDir('handoff-export-portability-');
    await writeFile(join(root, 'README.md'), 'hello\n');
    await mkdir(join(root, '.backend'), { recursive: true });
    await writeFile(join(root, '.backend', 'private'), 'secret\n');

    const registry = createScmBackendRegistry([
      createSourceControllerTestBackend({
        detectionRootPath: root,
        sourceController: {
          inspectWorkspaceLocation: async () => null,
          resolveWorkspaceTransferEntries: async () => [
            {
              relativePath: '.backend/private',
              sourcePath: join(root, '.backend', 'private'),
            },
          ],
          classifyPortableWorkspaceTransferEntry: ({ sourcePath }) =>
            sourcePath.endsWith('/.backend/private') ? 'non_portable' : 'portable',
        },
      }),
    ]);

    await expect(buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      registry,
    })).rejects.toThrow('non-portable workspace path: .backend/private');
  });

  it('prefers a backend-owned workspace export artifact hook before legacy transfer resolution during handoff export', async () => {
    const root = await makeTempDir('handoff-export-source-controller-artifacts-');
    await writeFile(join(root, 'README.md'), 'fallback\n');

    const resolveWorkspaceExportArtifacts = vi.fn(async () => ({
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file' as const,
            digest: 'sha256:hooked',
            sizeBytes: 7,
            executable: false,
          },
        ],
        fingerprint: 'sha256:fingerprint',
      },
      blobContentsByDigest: new Map([
        ['sha256:hooked', Buffer.from('hooked\n', 'utf8')],
      ]),
      sourceControllerMetadata: {
        provider: 'git',
        checkoutKind: 'branch',
        branchName: 'feature/backend-hook',
      },
    }));
    const resolveWorkspaceTransferEntries = vi.fn(async () => {
      throw new Error('legacy transfer entries should stay unused');
    });
    const registry = createScmBackendRegistry([
      createSourceControllerTestBackend({
        detectionRootPath: root,
        sourceController: {
          inspectWorkspaceLocation: async () => null,
          resolveWorkspaceExportArtifacts,
          resolveWorkspaceTransferEntries,
        },
      }),
    ]);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      registry,
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    expect(workspaceExportArtifacts).toMatchObject({
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest: 'sha256:hooked',
            sizeBytes: 7,
            executable: false,
          },
        ],
        fingerprint: 'sha256:fingerprint',
      },
      sourceControllerMetadata: {
        provider: 'git',
        checkoutKind: 'branch',
        branchName: 'feature/backend-hook',
      },
    });
    expect(Buffer.from(workspaceExportArtifacts.blobContentsByDigest.get('sha256:hooked') ?? []).toString('utf8')).toBe('hooked\n');
    expect(resolveWorkspaceExportArtifacts).toHaveBeenCalledTimes(1);
    expect(resolveWorkspaceExportArtifacts).toHaveBeenCalledWith({
      context: expect.objectContaining({
        cwd: root,
        detection: expect.objectContaining({
          rootPath: root,
        }),
      }),
      workspaceTransfer: {
        strategy: 'transfer_snapshot',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    expect(resolveWorkspaceTransferEntries).not.toHaveBeenCalled();
  });

  it('exports workspace artifacts for sync-changes using the same source-controller export seam', async () => {
    const root = await makeTempDir('handoff-sync-changes-strategy-');
    await writeFile(join(root, 'README.md'), 'hello\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    expect(workspaceExportArtifacts.manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'README.md',
        kind: 'file',
      }),
    ]));
  });

  it('falls back to plain workspace export for ignored nested directories inside a git repo', async () => {
    const root = await makeTempDir('handoff-ignored-nested-workspace-');
    const nestedWorkspace = join(root, '.project', 'logs', 'workspace-source');
    await runGit(root, ['init']);
    await writeFile(join(root, '.gitignore'), '.project/\n');
    await mkdir(nestedWorkspace, { recursive: true });
    await writeFile(join(nestedWorkspace, 'README.md'), 'ignored nested workspace\n');
    await runGit(root, ['add', '.gitignore']);

    const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: nestedWorkspace,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(workspaceExportArtifacts.manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'README.md',
        kind: 'file',
      }),
    ]));
    expect(workspaceExportArtifacts.manifest.entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
  });

  it('skips unreadable workspace entries instead of failing the export', async () => {
    const root = await makeTempDir('handoff-unreadable-');
    await writeFile(join(root, 'README.md'), 'hello\n');
    await writeFile(join(root, 'blocked.txt'), 'blocked\n');
    await mkdir(join(root, 'private'), { recursive: true });
    await writeFile(join(root, 'private', 'secret.txt'), 'secret\n');

    await chmod(join(root, 'blocked.txt'), 0o000);
    await chmod(join(root, 'private'), 0o000);

    try {
      const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
        sourcePath: root,
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });

      expect(workspaceExportArtifacts.manifest.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ relativePath: 'README.md', kind: 'file' }),
      ]));
      expect(workspaceExportArtifacts.manifest.entries.some((entry) => entry.relativePath === 'blocked.txt')).toBe(false);
      expect(workspaceExportArtifacts.manifest.entries.some((entry) => entry.relativePath.startsWith('private/'))).toBe(false);
    } finally {
      await chmod(join(root, 'blocked.txt'), 0o644);
      await chmod(join(root, 'private'), 0o755);
    }
  });

  it('exports large workspace subtrees without recursive stack overflow', async () => {
    const workspaceRoot = '/workspace';
    const fileCount = 100_000;
    const makeDirectoryEntry = (name: string) => ({
      name,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    const makeFileEntry = (name: string) => ({
      name,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    });
    const entries = await walkWorkspaceExportTree({
      root: workspaceRoot,
      readDirectory: async (path) => {
        if (path === workspaceRoot) {
          return [makeDirectoryEntry('nested')];
        }
        if (path === `${workspaceRoot}/nested`) {
          return Array.from({ length: fileCount }, (_, index) => makeFileEntry(`file-${index}.txt`));
        }
        return [];
      },
    });

    expect(entries).toHaveLength(fileCount);
    expect(entries[0]).toBe('nested/file-0.txt');
    expect(entries.at(-1)).toBe(`nested/file-${fileCount - 1}.txt`);
  });

  it('creates a sibling copy or replaces the target path when importing', async () => {
    const root = await makeTempDir('handoff-import-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.txt'), 'old\n');
    await writeFile(join(source, 'README.md'), 'hello\n');

    const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    const sibling = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(sibling.targetPath).not.toBe(target);
    await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(sibling.targetPath, 'README.md'), 'utf8')).resolves.toBe('hello\n');

    const replaced = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(replaced.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('hello\n');
  });

  it('applies sync-changes imports onto the existing target workspace', async () => {
    const root = await makeTempDir('handoff-sync-import-replace-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'README.md'), 'old\n');
    await writeFile(join(target, 'remove-me.txt'), 'remove\n');
    await writeFile(join(source, 'README.md'), 'new\n');
    await writeFile(join(source, 'keep.txt'), 'keep\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('new\n');
    await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
    await expect(access(join(target, 'remove-me.txt'))).rejects.toThrow();
  });

  it('applies sync-changes imports from a CAS-backed blob provider when export artifacts are manifest-only', async () => {
    const root = await makeTempDir('handoff-sync-import-provider-');
    const activeServerDir = await makeTempDir('handoff-sync-import-provider-cas-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'README.md'), 'old\n');
    await writeFile(join(source, 'README.md'), 'new\n');
    await writeFile(join(source, 'keep.txt'), 'keep\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
    for (const entry of workspaceExportArtifacts.manifest.entries) {
      if (entry.kind !== 'file') {
        continue;
      }
      await casStore.commitFile({
        digest: entry.digest,
        sourcePath: join(source, entry.relativePath),
      });
    }

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        ...workspaceExportArtifacts,
        blobContentsByDigest: new Map(),
      },
      blobProvider: {
        getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('new\n');
    await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
  });

  it('keeps target-only ignored files outside the sync scope during sync-changes import', async () => {
    const root = await makeTempDir('handoff-sync-import-ignored-target-');
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'README.md'), 'new\n');
    await writeFile(join(target, 'README.md'), 'old\n');
    await writeFile(join(target, 'ignored.log'), 'keep me\n');
    const registry = createScmBackendRegistry([
      createSourceControllerTestBackend({
        detectionRootPath: root,
        sourceController: {
          inspectWorkspaceLocation: async () => null,
          resolveWorkspaceTransferEntries: async ({ context }) => (await walkWorkspaceExportTree({
            root: context.cwd,
            readDirectory: async (directory) => await readdir(directory, { withFileTypes: true }),
          }))
            .filter((relativePath) => relativePath !== 'ignored.log')
            .map((relativePath) => ({
              relativePath,
              sourcePath: join(context.cwd, relativePath),
            })),
        },
      }),
    ]);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      registry,
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      registry,
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('new\n');
    await expect(readFile(join(target, 'ignored.log'), 'utf8')).resolves.toBe('keep me\n');
  });

  it('syncs only directories implied by transferred entries during sync-changes import', async () => {
    const root = await makeTempDir('handoff-sync-import-empty-directories-');
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(join(source, 'empty-source'), { recursive: true });
    await mkdir(join(target, 'empty-target'), { recursive: true });
    await writeFile(join(source, 'README.md'), 'new\n');
    await writeFile(join(target, 'README.md'), 'old\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    expect(workspaceExportArtifacts.manifest.entries.some((entry) => entry.relativePath === 'empty-source')).toBe(false);

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('new\n');
    await expect(access(join(target, 'empty-source'), constants.F_OK)).rejects.toThrow();
    await expect(access(join(target, 'empty-target'), constants.F_OK)).resolves.toBeUndefined();
  });

  it('preserves workspace files when sync-changes imports target the same existing path', async () => {
    const root = await makeTempDir('handoff-sync-import-same-path-');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), 'same-path\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: root,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: root,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(root);
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('same-path\n');
  });

  it('creates a sibling copy before applying sync-changes when conflict policy requests it', async () => {
    const root = await makeTempDir('handoff-sync-import-sibling-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'README.md'), 'old\n');
    await writeFile(join(source, 'README.md'), 'new\n');
    await writeFile(join(source, 'nested.txt'), 'added\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).not.toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(imported.targetPath, 'README.md'), 'utf8')).resolves.toBe('new\n');
    await expect(readFile(join(imported.targetPath, 'nested.txt'), 'utf8')).resolves.toBe('added\n');
  });

  it('falls back to a writable local path when sync-changes import targets an uncreatable parent tree', async () => {
    const root = await makeTempDir('handoff-sync-import-uncreatable-target-');
    const source = join(root, 'source');
    const lockedRoot = join(root, 'locked-root');
    const requestedTarget = join(lockedRoot, 'foreign', 'repo');
    await mkdir(source, { recursive: true });
    await mkdir(lockedRoot, { recursive: true });
    await writeFile(join(source, 'README.md'), 'hello\n');
    await writeFile(join(source, 'nested.txt'), 'sync\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    await chmod(lockedRoot, 0o555);
    try {
      const imported = await importSessionHandoffWorkspaceArtifacts({
        workspaceExportArtifacts,
        targetPath: requestedTarget,
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });

      expect(imported.targetPath).not.toBe(requestedTarget);
      expect(imported.targetPath.startsWith(lockedRoot)).toBe(false);
      await expect(readFile(join(imported.targetPath, 'README.md'), 'utf8')).resolves.toBe('hello\n');
      await expect(readFile(join(imported.targetPath, 'nested.txt'), 'utf8')).resolves.toBe('sync\n');
      await expect(access(requestedTarget, constants.F_OK)).rejects.toThrow();
    } finally {
      await chmod(lockedRoot, 0o755);
    }
  });

  it('reconciles imported workspaces through the shared source-controller seam', async () => {
    const root = await makeTempDir('handoff-import-source-controller-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(source, { recursive: true });
    await runGit(source, ['init']);
    await writeFile(join(source, 'README.md'), 'hello\n');
    await runGit(source, ['add', 'README.md']);
    const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    const reconcilePostMaterialization = vi.fn(async () => undefined);
    const registry = createScmBackendRegistry([
      createSourceControllerTestBackend({
        detectionRootPath: target,
        sourceController: {
          inspectWorkspaceLocation: async () => null,
          reconcilePostMaterialization,
        },
      }),
    ]);

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      registry,
    });

    expect(imported.targetPath).toBe(target);
    expect(reconcilePostMaterialization).toHaveBeenCalledWith({
      context: expect.objectContaining({
        cwd: target,
        detection: expect.objectContaining({
          rootPath: target,
        }),
      }),
      checkoutMaterialization: expect.objectContaining({
        targetPath: target,
        sourcePath: undefined,
        previousTargetPath: undefined,
        sourceControllerMetadata: workspaceExportArtifacts.sourceControllerMetadata,
      }),
      sourcePath: undefined,
      previousTargetPath: undefined,
      sourceControllerMetadata: workspaceExportArtifacts.sourceControllerMetadata,
    });
  });

  it('imports directly from replication export artifacts without re-deriving an inline wire bundle first', async () => {
    const root = await makeTempDir('handoff-import-artifacts-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(join(source, 'bin'), { recursive: true });
    await writeFile(join(source, 'README.md'), 'hello\n');
    await writeFile(join(source, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(source, 'bin', 'run.sh'), 0o755);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('hello\n');
    await expect(readFile(join(target, 'bin', 'run.sh'), 'utf8')).resolves.toBe('#!/bin/sh\necho hi\n');
  });

  it('falls back to a writable local path when snapshot import targets an uncreatable parent tree', async () => {
    const root = await makeTempDir('handoff-import-uncreatable-target-');
    const source = join(root, 'source');
    const lockedRoot = join(root, 'locked-root');
    const requestedTarget = join(lockedRoot, 'foreign', 'repo');
    await mkdir(source, { recursive: true });
    await mkdir(lockedRoot, { recursive: true });
    await writeFile(join(source, 'README.md'), 'hello\n');

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    await chmod(lockedRoot, 0o555);
    try {
      const imported = await importSessionHandoffWorkspaceArtifacts({
        workspaceExportArtifacts,
        targetPath: requestedTarget,
        workspaceTransfer: {
          enabled: true,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });

      expect(imported.targetPath).not.toBe(requestedTarget);
      expect(imported.targetPath.startsWith(lockedRoot)).toBe(false);
      await expect(readFile(join(imported.targetPath, 'README.md'), 'utf8')).resolves.toBe('hello\n');
      await expect(access(requestedTarget, constants.F_OK)).rejects.toThrow();
    } finally {
      await chmod(lockedRoot, 0o755);
    }
  });

  it('materializes snapshot imports from a CAS-backed blob provider when export artifacts are manifest-only', async () => {
    const root = await makeTempDir('handoff-snapshot-import-provider-');
    const activeServerDir = await makeTempDir('handoff-snapshot-import-provider-cas-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(join(source, 'bin'), { recursive: true });
    await writeFile(join(source, 'README.md'), 'hello\n');
    await writeFile(join(source, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(source, 'bin', 'run.sh'), 0o755);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
    for (const entry of workspaceExportArtifacts.manifest.entries) {
      if (entry.kind !== 'file') {
        continue;
      }
      await casStore.commitFile({
        digest: entry.digest,
        sourcePath: join(source, entry.relativePath),
      });
    }

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        ...workspaceExportArtifacts,
        blobContentsByDigest: new Map(),
      },
      blobProvider: {
        getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('hello\n');
    await expect(readFile(join(target, 'bin', 'run.sh'), 'utf8')).resolves.toBe('#!/bin/sh\necho hi\n');
  });

  it('preserves executable files after transferred-bundle wire serialization and import reconstruction', async () => {
    const root = await makeTempDir('handoff-import-transferred-artifacts-');
    const source = join(root, 'source');
    const target = join(root, 'repo');
    await mkdir(join(source, 'bin'), { recursive: true });
    await writeFile(join(source, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(source, 'bin', 'run.sh'), 0o755);

    const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    if (!workspaceExportArtifacts) throw new Error('Expected workspace export artifacts');

    const decoded = sessionHandoffTransferredBundlesCodec.decode({
      transferId: 'session_handoff_workspace_artifacts_test',
      payload: sessionHandoffTransferredBundlesCodec.encode(createSessionHandoffTransferredBundles({
        workspaceExportArtifacts,
      })),
    });

    const imported = await importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: decoded.workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(imported.targetPath).toBe(target);
    await expect(readFile(join(target, 'bin', 'run.sh'), 'utf8')).resolves.toBe('#!/bin/sh\necho hi\n');
    await expect(access(join(target, 'bin', 'run.sh'), constants.X_OK)).resolves.toBeUndefined();
  });

  it('rejects imported entries whose relativePath escapes the target workspace', async () => {
    const root = await makeTempDir('handoff-import-reject-');
    const target = join(root, 'repo');
    await mkdir(target, { recursive: true });

    await expect(importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: '../escaped.txt',
              kind: 'file',
              digest: 'sha256:escaped',
              sizeBytes: 5,
              executable: false,
            },
          ],
          fingerprint: 'sha256:escaped-fingerprint',
        },
        blobContentsByDigest: new Map([
          ['sha256:escaped', Buffer.from('oops\n', 'utf8')],
        ]),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    })).rejects.toThrow(/workspace transfer path|escapes/i);
  });

  it('rejects symlink targets that resolve outside the imported workspace', async () => {
    const root = await makeTempDir('handoff-import-symlink-reject-');
    const target = join(root, 'repo');
    await mkdir(target, { recursive: true });

    await expect(importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'safe-link',
              kind: 'symlink',
              target: '../../outside.txt',
            },
          ],
          fingerprint: 'sha256:symlink-fingerprint',
        },
        blobContentsByDigest: new Map(),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    })).rejects.toThrow(/symlink target|workspace/i);
  });

  it('keeps the existing target workspace intact when replace_existing import verification fails', async () => {
    const root = await makeTempDir('handoff-import-atomic-replace-');
    const target = join(root, 'repo');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.txt'), 'old\n');

    await expect(importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:missing-readme',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:missing-readme-fingerprint',
        },
        blobContentsByDigest: new Map(),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    })).rejects.toThrow(/missing blob|content/i);

    await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(target, 'README.md'), 'utf8')).rejects.toThrow();
  });

  it('cleans up failed sibling-copy imports before promotion', async () => {
    const root = await makeTempDir('handoff-import-atomic-sibling-');
    const target = join(root, 'repo');
    const siblingTarget = join(root, 'repo-handoff');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.txt'), 'old\n');

    await expect(importSessionHandoffWorkspaceArtifacts({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:missing-readme',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:missing-readme-fingerprint',
        },
        blobContentsByDigest: new Map(),
      },
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    })).rejects.toThrow(/missing blob|content/i);

    await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(siblingTarget, 'README.md'), 'utf8')).rejects.toThrow();
  });

  it('keeps the existing target workspace intact when snapshot import is aborted before promotion', async () => {
    const root = await makeTempDir('handoff-import-abort-replace-');
    const target = join(root, 'repo');
    const source = join(root, 'source');
    await mkdir(target, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(target, 'old.txt'), 'old\n');
    await writeFile(join(source, 'README.md'), 'new\n');

    const workspaceExportArtifacts = await buildRequiredWorkspaceExportArtifacts({
      sourcePath: source,
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    const params: Parameters<typeof importSessionHandoffWorkspaceArtifacts>[0] & Readonly<{
      assertCanContinue: () => Promise<void>;
    }> = {
      workspaceExportArtifacts,
      targetPath: target,
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      assertCanContinue: async () => {
        throw new Error('abort requested');
      },
    };

    await expect(importSessionHandoffWorkspaceArtifacts(params)).rejects.toThrow('abort requested');
    await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(readFile(join(target, 'README.md'), 'utf8')).rejects.toThrow();
  });
});
