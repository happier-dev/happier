import { describe, expect, it } from 'vitest';

import { normalizeCodeRabbitReviewStartInput } from './startInput.js';

describe('normalizeCodeRabbitReviewStartInput', () => {
  it('falls back to CodeRabbit review defaults for partial review-start input', () => {
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        reviewers: [],
        instructions: '   ',
        changeType: 'committed',
        base: { kind: 'none' },
        permissionMode: 'read_only',
        engines: { coderabbit: { gate: 'major' } },
      },
      fallbackInstructions: 'Review this change.',
    });

    expect(normalized).toMatchObject({
      reviewers: [{ kind: 'engine', engineId: 'coderabbit' }],
      instructions: 'Review this change.',
      changeType: 'committed',
      base: { kind: 'none' },
      permissionMode: 'read_only',
      engines: { coderabbit: { gate: 'major' } },
    });
  });

  it.each(['roster', 'legacy'] as const)('preserves the admitted qualified reviewer and its invocation options (%s)', format => {
    const reviewer = { kind: 'engine', engineId: 'agent:happier.review.coderabbit/coderabbit', options: { gate: 'major' } };
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        ...(format === 'roster' ? { reviewers: [reviewer] }
          : { engineIds: [reviewer.engineId], engines: { [reviewer.engineId]: reviewer.options } }),
        instructions: 'Review this change.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      fallbackInstructions: 'fallback',
    });

    expect(normalized.reviewers).toEqual([reviewer]);
  });
});
