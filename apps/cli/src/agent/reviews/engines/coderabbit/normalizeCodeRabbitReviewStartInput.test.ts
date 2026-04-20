import { describe, expect, it } from 'vitest';

import { normalizeCodeRabbitReviewStartInput } from './normalizeCodeRabbitReviewStartInput';

describe('normalizeCodeRabbitReviewStartInput', () => {
  it('falls back to canonical coderabbit defaults when partial review-start input leaves required fields blank', () => {
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        engineIds: [],
        instructions: '   ',
        changeType: 'committed',
        base: { kind: 'none' },
        permissionMode: 'read_only',
      },
      fallbackInstructions: 'Review the current scope.',
    });

    expect(normalized.engineIds).toEqual(['coderabbit']);
    expect(normalized.instructions).toBe('Review the current scope.');
    expect(normalized.changeType).toBe('committed');
    expect(normalized.base).toEqual({ kind: 'none' });
  });

  it('canonicalizes the review engine id to coderabbit even when the caller supplies a different engine id', () => {
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        engineIds: ['claude'],
        instructions: 'Review the current scope.',
        changeType: 'committed',
        base: { kind: 'none' },
        permissionMode: 'read_only',
      },
      fallbackInstructions: 'Review the current scope.',
    });

    expect(normalized.engineIds).toEqual(['coderabbit']);
    expect(normalized.instructions).toBe('Review the current scope.');
  });
});
