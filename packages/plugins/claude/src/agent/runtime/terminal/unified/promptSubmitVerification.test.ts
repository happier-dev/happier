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
        '>> auto mode on',
      ].join('\n'),
    })).toBe(true);
  });

  it('keeps single-line prompts on the fast submit path', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();

    expect(policy.shouldVerifyAfterSubmit('single line prompt')).toBe(false);
    expect(policy.verifyAfterSubmit({
      promptText: 'single line prompt',
      screenText: '❯ [Pasted text #1 +40 lines]',
    })).toBe(false);
  });
});
