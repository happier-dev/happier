import { describe, expect, it } from 'vitest';

import { ReviewStartInputSchema } from './reviewStart.js';

describe('ReviewStartInputSchema', () => {
  it('preserves additive fields in the review start payload and engine config', () => {
    const parsed = ReviewStartInputSchema.parse({
      engineIds: ['coderabbit'],
      instructions: 'Review.',
      base: { kind: 'none' },
      futureStartField: {
        kind: 'review_start.v2',
      },
      engines: {
        coderabbit: {
          plain: true,
          futureCoderabbitField: 'keep-me',
        },
      },
    });

    expect((parsed as any).futureStartField).toEqual({
      kind: 'review_start.v2',
    });
    expect((parsed.engines?.coderabbit as any)?.futureCoderabbitField).toBe('keep-me');
  });

  it('defaults review scope to uncommitted changes and does not require explicit coderabbit engine config', () => {
    const parsed = ReviewStartInputSchema.parse({
      engineIds: ['coderabbit'],
      instructions: 'Review.',
      base: { kind: 'none' },
    });

    expect(parsed.changeType).toBe('uncommitted');
    // When coderabbit is selected, surfaces should not need to inject an empty config object.
    expect(parsed.engines?.coderabbit).toEqual({});
  });
});
