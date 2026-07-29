import { describe, expect, it } from 'vitest';

import { createClaudePromptSubmitVerificationPolicy } from './promptSubmitVerification.js';

describe('Claude unified terminal prompt submit verification', () => {
  it('treats a matching collapsed paste marker as a still-pending multiline prompt after Enter', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

    expect(policy.shouldVerifyBeforeSubmit(prompt)).toBe(false);
    expect(policy.shouldVerifyAfterSubmit(prompt)).toBe(true);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        'previous output',
        '❯ [Pasted text #1 +40 lines]',
        '────────────────────────',
        '⏵⏵ auto mode on',
      ].join('\n'),
    })).toBe(true);
  });

  it('verifies every non-empty single-line prompt after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();

    expect(policy.shouldVerifyAfterSubmit('single line prompt')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('   ')).toBe(false);
  });

  it('detects a single-line prompt that remains exactly in the composer after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = 'continue';

    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        'Please run /login · API Error: 401 Invalid authentication credentials',
        '❯ continue',
        '⏵⏵ auto mode on',
      ].join('\n'),
    })).toBe(true);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        '❯ continue',
        'Claude acted on the submitted prompt.',
        '│ > │',
      ].join('\n'),
    })).toBe(false);
  });
});
