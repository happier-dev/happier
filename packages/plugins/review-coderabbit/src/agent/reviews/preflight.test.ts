import { describe, expect, it } from 'vitest';

import { preflightCodeRabbitReviewScope, type CodeRabbitReviewScopeFacts } from './scopePreflight.js';
import { normalizeCodeRabbitReviewStartInput } from './startInput.js';

function reviewInput(intentInput: unknown) {
  return normalizeCodeRabbitReviewStartInput({ intentInput, fallbackInstructions: 'Review.' });
}

function createSupportedScmReviewScope(paths: readonly string[] = ['a.txt']): CodeRabbitReviewScopeFacts {
  const changedPaths: CodeRabbitReviewScopeFacts['changedPaths'] = paths.map((path) => ({
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
    selectedPaths: [...paths],
    committedPaths: changedPaths,
    uncommittedPaths: [],
    changedPaths,
    diff: { committedAvailable: true, uncommittedAvailable: false },
    diagnostics: [],
  };
}

describe('CodeRabbit review preflight', () => {
  it('leaves native login and API-key readiness with the canonical Agent auth owner', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/workspace',
      reviewInput: reviewInput({
        reviewers: [{ kind: 'engine', engineId: 'coderabbit' }],
        instructions: 'Review this change.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      }),
      scope: createSupportedScmReviewScope(),
    })).resolves.toEqual({
      ok: true, eligibleFileCount: 1,
    });
  });

  it('accepts committed scope from host-resolved review facts without probing git locally', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/not-a-local-git-worktree',
      reviewInput: reviewInput({
        changeType: 'committed',
        base: { kind: 'none' },
      }),
      scope: createSupportedScmReviewScope(['a.txt']),
    })).resolves.toEqual({ ok: true, eligibleFileCount: 1 });
  });

  it('does not impose a local file ceiling before the vendor evaluates the scope (U3)', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/not-a-local-git-worktree',
      reviewInput: reviewInput({
        reviewers: [{ kind: 'engine', engineId: 'coderabbit' }],
        instructions: 'Review this change.',
        changeType: 'committed',
        base: { kind: 'none' },
      }),
      scope: createSupportedScmReviewScope(['a.txt', 'b.txt']),
    })).resolves.toEqual({ ok: true, eligibleFileCount: 2 });
  });

  it('rejects empty host-resolved session scopes without local fallback probing', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/not-a-local-git-worktree',
      reviewInput: reviewInput({
        reviewers: [{ kind: 'engine', engineId: 'coderabbit' }],
        instructions: 'Review nested scope.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      }),
      scope: createSupportedScmReviewScope([]),
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('No reviewable files'),
    });
  });

  it('refuses an explicit file selection that CodeRabbit cannot pass to its CLI', async () => {
    await expect(preflightCodeRabbitReviewScope({
      cwd: '/workspace',
      reviewInput: reviewInput({
        changeType: 'committed',
        base: { kind: 'none' },
        selectedPaths: ['a.txt'],
      }),
      scope: createSupportedScmReviewScope(['a.txt']),
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('exact file paths'),
    });
  });
});
