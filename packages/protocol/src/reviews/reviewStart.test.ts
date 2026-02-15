import { describe, expect, it } from 'vitest';

import { ReviewStartInputSchema } from './reviewStart.js';

describe('ReviewStartInputSchema', () => {
  it('does not require explicit coderabbit engine config', () => {
    const parsed = ReviewStartInputSchema.parse({
      engineIds: ['coderabbit'],
      instructions: 'Review.',
      changeType: 'committed',
      base: { kind: 'none' },
    });

    // When coderabbit is selected, surfaces should not need to inject an empty config object.
    expect(parsed.engines?.coderabbit).toEqual({});
  });
});

