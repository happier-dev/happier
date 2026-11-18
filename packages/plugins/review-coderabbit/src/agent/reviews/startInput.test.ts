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

  it('selects CodeRabbit as the native reviewer for plugin-local execution', () => {
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        reviewers: [{ kind: 'engine', engineId: 'deepsec' }],
        instructions: 'Review this change.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      fallbackInstructions: 'fallback',
    });

    expect(normalized.reviewers).toEqual([{ kind: 'engine', engineId: 'coderabbit' }]);
  });
});
