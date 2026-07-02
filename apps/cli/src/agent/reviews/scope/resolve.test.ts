import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createScmCapabilities,
  type ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';

import { resolveReviewScmScope } from './resolve';

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
});
