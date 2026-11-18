import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createScmCapabilities,
  ScmComparisonSchema,
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
  it.each(['selectedPaths', 'selectedFiles'])('refuses repository scope with %s at direct scope admission', async key => {
    const scope = await resolveReviewScmScope({ cwd: '/repo', registry: createScmBackendRegistry([]),
      intentInput: { scope: 'repository', [key]: ['src/auth.ts'] } });
    expect(scope).toMatchObject({ status: 'unsupported', diagnostics: [{ code: 'scm_status_unavailable' }] });
  });

  it('uses selected PR source endpoints without asking ambient Git for a base or head', async () => {
    const baseOid = '1'.repeat(40);
    const headOid = '2'.repeat(40);
    const scope = await resolveReviewScmScope({ cwd: '/prepared-pr', registry: createScmBackendRegistry([]),
      intentInput: { scmPullRequestReviewScope: { kind: 'scm_pull_request_review_scope.v1',
        account: { service: { pluginId: 'happier.scm-github', localId: 'github' }, accountId: 'selected-account' },
        pullRequest: { number: 42 }, observed: { baseSha: baseOid, headSha: headOid, nativeRevision: 'selected', observedAtMs: 1 } } } });
    expect(scope).toMatchObject({ status: 'supported', repositoryRoot: '/prepared-pr',
      baseRef: { source: 'explicit', ref: baseOid }, revisionRange: { kind: 'revisionRange', baseOid, headOid } });
    await expect(resolveReviewScmScope({ cwd: '/prepared-pr', registry: createScmBackendRegistry([]),
      intentInput: { scmPullRequestReviewScope: { kind: 'scm_pull_request_review_scope.v1',
        nativeService: { pluginId: 'happier.scm-github', localId: 'github' }, pullRequest: { number: 42 },
        observed: { baseSha: baseOid, headSha: headOid, nativeRevision: 'selected', observedAtMs: 1 } },
      selectedPaths: ['../outside.ts'] } })).resolves.toMatchObject({ status: 'unsupported' });
  });
  it('resolves captured endpoints and selected files without reading the ambient checkout', async () => {
    const comparison = ScmComparisonSchema.parse({ id: 'selected-turn', source: { kind: 'turnCheckpoint', sessionId: 'session', turnId: 'turn' },
      repository: { rootPath: '/captured-repo' }, endpoints: { before: 'captured-base', after: 'captured-head' },
      inventory: { state: 'complete', reasons: [], files: ['selected.ts', 'other-selected.ts'].map(path => ({
        path, changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' }, occurrences: [],
      })) } });
    const registry = createScmBackendRegistry([]);
    const resolve = (selectedPaths?: string[]) => resolveReviewScmScope({ cwd: '/ambient-repo', registry,
      intentInput: { comparisonId: comparison.id, comparison, ...(selectedPaths ? { selectedPaths } : {}) } });
    await expect(resolve()).resolves.toMatchObject({ status: 'supported', repositoryRoot: '/captured-repo',
      baseRef: { source: 'explicit', ref: 'captured-base' }, comparison: { id: comparison.id,
        source: comparison.source, endpoints: comparison.endpoints },
      selectedPaths: ['selected.ts', 'other-selected.ts'] });
    await expect(resolve(['selected.ts'])).resolves.toMatchObject({ status: 'supported', selectedPaths: ['selected.ts'] });
    await expect(resolve(['unrelated.ts'])).resolves.toMatchObject({ status: 'unsupported' });
    await expect(resolve(['../unrelated.ts'])).resolves.toMatchObject({ status: 'unsupported' });
    await expect(resolveReviewScmScope({ cwd: '/ambient-repo', registry,
      intentInput: { comparisonId: 'different-comparison', comparison } })).resolves.toMatchObject({ status: 'unsupported' });
  });
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
      // A repository review must not inherit the changed-path selection. The
      // engine can inspect unchanged files under the resolved repository root.
      await expect(resolveReviewScmScope({ cwd, intentInput: { scope: 'repository' } })).resolves.toMatchObject({
        status: 'supported', scope: 'repository', repositoryRoot: cwd, selectedPaths: [],
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
          reviewers: [{ kind: 'engine', engineId: 'coderabbit' }],
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
          reviewers: [{ kind: 'engine', engineId: 'deepsec' }],
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
