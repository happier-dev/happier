import { describe, expect, it } from 'vitest';

import { buildStandardReviewPrompt } from './buildStandardReviewPrompt';

describe('buildStandardReviewPrompt', () => {
  it('lets a Hunt inspect unchanged files instead of restricting it to a comparison', () => {
    const prompt = buildStandardReviewPrompt({ instructions: 'Find security issues.', intentInput: {
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Find security issues.', scope: 'repository',
    } });
    expect(prompt).toContain('entire repository');
    expect(prompt).not.toContain('Change type:');
    expect(prompt).not.toContain('Do not broaden');
  });
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
