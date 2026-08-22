import { describe, expect, it } from 'vitest';

import * as reviewStart from './reviewStart.js';

const reviewStartExports = reviewStart as typeof reviewStart & {
  REVIEW_SCM_SCOPE_INPUT_KEY?: unknown;
};

describe('ReviewStartInputSchema', () => {
  it('exports the canonical host-resolved SCM review scope key', () => {
    expect(reviewStartExports.REVIEW_SCM_SCOPE_INPUT_KEY).toBe('scmReviewScope');
  });

  it('preserves additive fields in the review start payload and engine config', () => {
    const parsed = reviewStart.ReviewStartInputSchema.parse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      base: { kind: 'none' },
      futureStartField: {
        kind: 'review_start.v2',
      },
      engines: {
        'acme.review': {
          futureEngineField: 'keep-me',
        },
      },
    });

    expect((parsed as any).futureStartField).toEqual({
      kind: 'review_start.v2',
    });
    expect(parsed.engines).toEqual({
      'acme.review': {
        futureEngineField: 'keep-me',
      },
    });
  });

  it('defaults review scope without injecting engine-specific config', () => {
    const parsed = reviewStart.ReviewStartInputSchema.parse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      base: { kind: 'none' },
    });

    expect(parsed.changeType).toBe('uncommitted');
    expect(parsed.engines).toEqual({});
  });

  it('preserves a qualified execution profile and its committed generation', () => {
    const parsed = reviewStart.ReviewStartInputSchema.parse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      profileId: 'acme.plugin/review',
      profileGenerationId: 'generation-7',
    });

    expect(parsed.profileId).toBe('acme.plugin/review');
    expect(parsed.profileGenerationId).toBe('generation-7');
  });

  it('rejects a review profile without its committed generation', () => {
    expect(reviewStart.ReviewStartInputSchema.safeParse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      profileId: 'acme.plugin/review',
    }).success).toBe(false);
  });

  it('rejects execution-run profiles on the inline current-session path', () => {
    expect(reviewStart.ReviewStartInputSchema.safeParse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      runLocation: 'current_session',
      profileId: 'acme.plugin/review',
      profileGenerationId: 'generation-7',
    }).success).toBe(false);
  });

  it('carries the strict selected pull request review scope under its own top-level key', () => {
    const scope = {
      kind: 'scm_pull_request_review_scope.v1',
      account: {
        service: { pluginId: 'happier.scm-github', localId: 'github' },
        accountId: 'account-7',
      },
      pullRequest: { number: 42 },
      observed: {
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        nativeRevision: 'PR_kwDOABCD',
        observedAtMs: 1_700_000_000_000,
      },
    };

    const parsed = reviewStart.ReviewStartInputSchema.parse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      scmPullRequestReviewScope: scope,
    });

    expect(parsed.scmPullRequestReviewScope).toEqual(scope);
    expect(parsed.scmReviewScope).toBeUndefined();
  });

  it('rejects a malformed selected pull request review scope rather than passing it through', () => {
    expect(reviewStart.ReviewStartInputSchema.safeParse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      scmPullRequestReviewScope: {
        kind: 'scm_pull_request_review_scope.v1',
        account: { service: { pluginId: 'happier.scm-github', localId: 'github' }, accountId: 'account-7' },
        pullRequest: { number: 42 },
        observed: {
          baseSha: '1111111111111111111111111111111111111111',
          headSha: '2222222222222222222222222222222222222222',
        },
      },
    }).success).toBe(false);
  });

  it('rejects malformed host-resolved SCM review scope', () => {
    expect(() => reviewStart.ReviewStartInputSchema.parse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      base: { kind: 'none' },
      scmReviewScope: {
        kind: 'legacy_plugin_scope',
        isGitWorktree: true,
      },
    })).toThrow();
  });
});
