import { describe, expect, it } from 'vitest';

import { ReviewStartInputSchema } from './reviewStart.js';

describe('ReviewStartInputSchema', () => {
  it('preserves additive fields in the review start payload and engine config', () => {
    const parsed = ReviewStartInputSchema.parse({
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
    const parsed = ReviewStartInputSchema.parse({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      base: { kind: 'none' },
    });

    expect(parsed.changeType).toBe('uncommitted');
    expect(parsed.engines).toEqual({});
  });
});
