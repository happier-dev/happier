import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createScmCapabilities,
  type ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';

import { resolveReviewScmScope } from './resolve';

const scmCatalogMock = vi.hoisted(() => {
  type TestScmBackendRegistry = Readonly<{
    listBackends: () => readonly unknown[];
    selectBackend: () => Promise<null>;
  }>;
  let defaultRegistry: TestScmBackendRegistry | ScmBackendRegistry | null = null;
  const runWithScmBackendRegistryLease = vi.fn(async <T>(
    registry: ScmBackendRegistry | undefined,
    run: (resolvedRegistry: TestScmBackendRegistry | ScmBackendRegistry) => Promise<T>,
  ): Promise<T> => {
    if (registry) return await run(registry);
    if (!defaultRegistry) throw new Error('test default SCM registry not configured');
    return await run(defaultRegistry);
  });
  return {
    runWithScmBackendRegistryLease,
    setDefaultRegistry: (registry: ScmBackendRegistry | null) => {
      defaultRegistry = registry;
    },
  };
});

vi.mock('@/scm/scmBackendCatalog', () => ({
  runWithScmBackendRegistryLease: scmCatalogMock.runWithScmBackendRegistryLease,
}));

function createGitBackend(snapshot: ScmStatusSnapshotResponse['snapshot']): ScmBackend {
  const notNeeded = async () => {
    throw new Error('not needed in review scope resolver test');
  };
  return {
    id: 'git',
    selection: { modeSelectionScores: { '.git': 100 } },
    detectRepo: async () => ({ isRepo: true, rootPath: snapshot?.repo.rootPath ?? null, mode: '.git' }),
    getCapabilities: () => createScmCapabilities({ readStatus: true, readDiffFile: true }),
    describeBackend: notNeeded,
    statusSnapshot: async () => ({ success: true, snapshot }),
    worktreesEnrichment: notNeeded,
    diffFile: notNeeded,
    diffCommit: notNeeded,
    changeInclude: notNeeded,
    changeExclude: notNeeded,
    changeDiscard: notNeeded,
    commitCreate: notNeeded,
    commitBackout: notNeeded,
    logList: notNeeded,
    branchList: notNeeded,
    branchCreate: notNeeded,
    branchCheckout: notNeeded,
    branchMerge: notNeeded,
    branchRebase: notNeeded,
    branchOperationContinue: notNeeded,
    branchOperationAbort: notNeeded,
    worktreeCreate: notNeeded,
    worktreeRemove: notNeeded,
    worktreePrune: notNeeded,
    remoteAdd: notNeeded,
    remoteSetUrl: notNeeded,
    remoteRemove: notNeeded,
    remoteFetch: notNeeded,
    remotePull: notNeeded,
    remotePush: notNeeded,
    remotePublish: notNeeded,
    repositoryClone: notNeeded,
    repositoryInit: notNeeded,
    hostingRepositoryDescribePublishTargets: notNeeded,
    hostingRepositoryPublish: notNeeded,
    stashList: notNeeded,
    stashShow: notNeeded,
    stashApply: notNeeded,
    stashPop: notNeeded,
    stashDrop: notNeeded,
    pullRequestList: notNeeded,
    pullRequestGet: notNeeded,
    pullRequestOpenCompose: notNeeded,
    pullRequestOpenOrReuse: notNeeded,
    pullRequestCheckout: notNeeded,
    pullRequestPrepareWorktree: notNeeded,
    pullRequestRunStacked: notNeeded,
  };
}

describe('resolveReviewScmScope', () => {
  it('uses the async SCM backend registry resolver when no registry is injected', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-scope-default-registry-'));
    try {
      scmCatalogMock.setDefaultRegistry(createScmBackendRegistry([
        createGitBackend({
          projectKey: 'project-1',
          fetchedAt: 123,
          repo: {
            isRepo: true,
            rootPath: cwd,
            backendId: 'git',
            mode: '.git',
            defaultBranch: 'main',
            worktrees: [],
            remotes: [],
          },
          capabilities: createScmCapabilities({
            readStatus: true,
            readDiffFile: true,
            supportedDiffAreas: ['pending', 'both'],
          }),
          branch: {
            head: 'feature',
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
          },
          stashCount: 0,
          hasConflicts: false,
          entries: [{
            path: 'src/review.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: '',
            pendingStatus: 'M',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
              includedAdded: 0,
              includedRemoved: 0,
              pendingAdded: 1,
              pendingRemoved: 1,
              isBinary: false,
            },
          }],
          totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 1,
          },
        }),
      ]));
      scmCatalogMock.runWithScmBackendRegistryLease.mockClear();

      await expect(resolveReviewScmScope({ cwd })).resolves.toMatchObject({
        kind: 'review_scm_scope.v1',
        status: 'supported',
        scmBackendId: 'git',
        repositoryRoot: cwd,
        selectedPaths: ['src/review.ts'],
      });
      expect(scmCatalogMock.runWithScmBackendRegistryLease).toHaveBeenCalledWith(
        undefined,
        expect.any(Function),
      );
    } finally {
      scmCatalogMock.setDefaultRegistry(null);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('builds supported Git review scope from SCM status snapshots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-scope-git-'));
    try {
      const registry = createScmBackendRegistry([
        createGitBackend({
          projectKey: 'project-1',
          fetchedAt: 123,
          repo: {
            isRepo: true,
            rootPath: cwd,
            backendId: 'git',
            mode: '.git',
            defaultBranch: 'main',
            worktrees: [],
            remotes: [],
          },
          capabilities: createScmCapabilities({
            readStatus: true,
            readDiffFile: true,
            supportedDiffAreas: ['included', 'pending', 'both'],
          }),
          branch: {
            head: 'feature',
            upstream: 'origin/feature',
            ahead: 0,
            behind: 0,
            detached: false,
          },
          stashCount: 0,
          hasConflicts: false,
          entries: [{
            path: 'src/auth.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: '',
            pendingStatus: 'M',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
              includedAdded: 0,
              includedRemoved: 0,
              pendingAdded: 3,
              pendingRemoved: 1,
              isBinary: false,
            },
          }],
          totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 3,
            pendingRemoved: 1,
          },
        }),
      ]);

      await expect(resolveReviewScmScope({
        cwd,
        registry,
        intentInput: {
          engineIds: ['coderabbit'],
          instructions: 'Review.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
        },
      })).resolves.toMatchObject({
        kind: 'review_scm_scope.v1',
        status: 'supported',
        scmBackendId: 'git',
        scmMode: '.git',
        repositoryRoot: cwd,
        selectedPaths: ['src/auth.ts'],
        baseRef: { source: 'branch_upstream', ref: 'origin/feature' },
        uncommittedPaths: [
          expect.objectContaining({
            path: 'src/auth.ts',
            hasUncommittedDelta: true,
            diff: expect.objectContaining({ uncommittedAvailable: true }),
          }),
        ],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns unsupported scope when no SCM backend detects a repository', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-scope-none-'));
    try {
      const registry = createScmBackendRegistry([]);
      await expect(resolveReviewScmScope({ cwd, registry })).resolves.toMatchObject({
        kind: 'review_scm_scope.v1',
        status: 'unsupported',
        diagnostics: [expect.objectContaining({ code: 'not_repository' })],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not read provider-owned engine config when resolving selected scope paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-scope-generic-selected-'));
    try {
      const registry = createScmBackendRegistry([
        createGitBackend({
          projectKey: 'project-1',
          fetchedAt: 123,
          repo: {
            isRepo: true,
            rootPath: cwd,
            backendId: 'git',
            mode: '.git',
            defaultBranch: 'main',
            worktrees: [],
            remotes: [],
          },
          capabilities: createScmCapabilities({
            readStatus: true,
            readDiffFile: true,
            supportedDiffAreas: ['included', 'pending', 'both'],
          }),
          branch: {
            head: 'feature',
            upstream: 'origin/feature',
            ahead: 0,
            behind: 0,
            detached: false,
          },
          stashCount: 0,
          hasConflicts: false,
          entries: [{
            path: 'src/auth.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: '',
            pendingStatus: 'M',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
              includedAdded: 0,
              includedRemoved: 0,
              pendingAdded: 3,
              pendingRemoved: 1,
              isBinary: false,
            },
          }, {
            path: 'src/secret.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: '',
            pendingStatus: 'M',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
              includedAdded: 0,
              includedRemoved: 0,
              pendingAdded: 5,
              pendingRemoved: 2,
              isBinary: false,
            },
          }],
          totals: {
            includedFiles: 0,
            pendingFiles: 2,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 8,
            pendingRemoved: 3,
          },
        }),
      ]);

      await expect(resolveReviewScmScope({
        cwd,
        registry,
        intentInput: {
          engineIds: ['deepsec'],
          instructions: 'Review.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          selectedFiles: ['src/auth.ts'],
          engines: {
            deepsec: { selectedFiles: ['src/secret.ts'] },
          },
        },
      })).resolves.toMatchObject({
        kind: 'review_scm_scope.v1',
        status: 'supported',
        selectedPaths: ['src/auth.ts'],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
