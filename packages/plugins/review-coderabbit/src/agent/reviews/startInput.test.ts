import { describe, expect, it } from 'vitest';

import { normalizeCodeRabbitReviewStartInput } from './startInput.js';

describe('normalizeCodeRabbitReviewStartInput', () => {
  it('falls back to CodeRabbit review defaults for partial review-start input', () => {
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        engineIds: [],
        instructions: '   ',
        changeType: 'committed',
        base: { kind: 'none' },
        permissionMode: 'read_only',
      },
      fallbackInstructions: 'Review this change.',
    });

    expect(normalized).toMatchObject({
      engineIds: ['coderabbit'],
      instructions: 'Review this change.',
      changeType: 'committed',
      base: { kind: 'none' },
      permissionMode: 'read_only',
    });
  });

  it('keeps CodeRabbit as the only engine id for plugin-local execution', () => {
    const normalized = normalizeCodeRabbitReviewStartInput({
      intentInput: {
        engineIds: ['deepsec'],
        instructions: 'Review this change.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      fallbackInstructions: 'fallback',
    });

    expect(normalized.engineIds).toEqual(['coderabbit']);
  });
});
