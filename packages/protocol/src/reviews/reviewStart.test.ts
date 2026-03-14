import { describe, expect, it } from 'vitest';

import { ReviewStartInputSchema } from './reviewStart.js';

describe('ReviewStartInputSchema', () => {
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
