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
