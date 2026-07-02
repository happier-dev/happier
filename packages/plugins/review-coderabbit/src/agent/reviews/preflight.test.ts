import { describe, expect, it } from 'vitest';

import { preflightCodeRabbitReviewScope } from './scopePreflight.js';
import { runCodeRabbitReviewStartPreflight } from './startPreflight.js';

function createSupportedScmReviewScope(paths: readonly string[] = ['a.txt']): unknown {
  const changedPaths = paths.map((path) => ({
    path,
    previousPath: null,
    kind: 'modified',
    hasCommittedDelta: true,
    hasUncommittedDelta: false,
    diff: {
      committedAvailable: true,
      uncommittedAvailable: false,
      isBinary: false,
    },
  }));
  return {
    kind: 'review_scm_scope.v1',
    status: 'supported',
    scmBackendId: 'git',
    scmMode: '.git',
    repositoryRoot: '/workspace',
    worktreeRoot: '/workspace',
    baseRef: { source: 'branch_upstream', ref: 'origin/main' },
    selectedPaths: paths,
    committedPaths: changedPaths,
    uncommittedPaths: [],
    changedPaths,
    diff: { committedAvailable: true, uncommittedAvailable: false },
    diagnostics: [],
  };
}

describe('CodeRabbit review preflight', () => {
  it('reports missing CODERABBIT_API_KEY as start-preflight remediation', async () => {
    await expect(runCodeRabbitReviewStartPreflight({
      cwd: '/workspace',
      env: {},
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review this change.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
    })).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('CODERABBIT_API_KEY'),
    });
  });

  it('accepts committed scope from host-resolved review facts without probing git locally', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/not-a-local-git-worktree',
      intentInput: {
        changeType: 'committed',
        base: { kind: 'none' },
      },
      scope: createSupportedScmReviewScope(['a.txt']),
    })).resolves.toEqual({ ok: true, eligibleFileCount: 1 });
  });

  it('rejects host-resolved scopes that exceed the configured file limit', async () => {
    await expect(runCodeRabbitReviewStartPreflight({
      cwd: '/not-a-local-git-worktree',
      env: {
        CODERABBIT_API_KEY: 'test-key',
        HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES: '1',
      },
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review this change.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      scope: createSupportedScmReviewScope(['a.txt', 'b.txt']),
    })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('Too many reviewable files'),
    });
  });

  it('rejects empty host-resolved session scopes without local fallback probing', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/not-a-local-git-worktree',
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review nested scope.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      scope: createSupportedScmReviewScope([]),
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('No reviewable files'),
    });
  });
});
