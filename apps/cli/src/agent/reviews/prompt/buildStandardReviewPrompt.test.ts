import { describe, expect, it } from 'vitest';

import { buildStandardReviewPrompt } from './buildStandardReviewPrompt';

describe('buildStandardReviewPrompt', () => {
  it('requires initial reviews to inspect accessible workspace context before finalizing', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Review the current workspace thoroughly.',
    });

    expect(prompt).toContain('Inspect the accessible workspace');
    expect(prompt).toContain('Do not stop at a plan');
    expect(prompt).toContain('add a question instead of guessing');
  });

  it('includes explicit review scope guidance for normal review launches', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Review the current session changes.',
      intentInput: {
        engineIds: ['claude'],
        instructions: 'Review the current session changes.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(prompt).toContain('Review scope:');
    expect(prompt).toContain('Change type: committed');
    expect(prompt).toContain('Base: infer the repository');
    expect(prompt).toContain('Do not broaden the review to unrelated repository areas');
  });
});
