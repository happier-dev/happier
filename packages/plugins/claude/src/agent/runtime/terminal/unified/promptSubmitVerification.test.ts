import { describe, expect, it } from 'vitest';

import { createClaudePromptSubmitVerificationPolicy } from './promptSubmitVerification.js';

describe('Claude unified terminal prompt submit verification', () => {
  it('treats a matching collapsed paste marker as a still-pending multiline prompt after Enter', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

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
    expect(policy.verifyBeforeSubmitStaging?.({
      promptText: prompt,
      screenText: '❯ [Pasted text #1 +40 lines]',
    })).toBe(true);
  });

  it('uses the canonical composer marker despite new footer content and presentation-only line counts', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = [
      'The provider may collapse this prompt independently of logical newline count.',
      'Claude line wrapping and paste rendering are presentation details.',
    ].join('\n');
    const capturedScreen = [
      'previous assistant output',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯\u00a0[Pasted text #1 +7 lines]',
      '────────────────────────────────────────────────────────────────────────────────',
      '                                                                     /rc active',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');

    expect(policy.verifyBeforeSubmitStaging?.({
      promptText: prompt,
      screenText: capturedScreen,
    })).toBe(true);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: capturedScreen,
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

  it('detects a single-line prompt that remains visually wrapped in the composer after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = [
      'can you please give me a complete report as an assistant message of everything you analysed, all the reports,',
      'all the issues, improvements, suggestions, and your recommendations',
    ].join(' ');

    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        '❯ can you please give me a complete report as an assistant message of everything you analysed, all the reports,',
        '  all the issues, improvements, suggestions, and your recommendations',
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
  });

  it('verifies a direct-rendered prompt with an intentional blank paragraph before submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = [
      'great, awesome! great work',
      '',
      'but seems like a lot of texts are still not translated?',
      'http://localhost:5173/zh-Hant',
    ].join('\n');

    expect(policy.verifyBeforeSubmitStaging({
      promptText: prompt,
      screenText: [
        '────────────────────────────────────────────────',
        '❯ great, awesome! great work',
        '',
        '  but seems like a lot of texts are still not translated?',
        '  http://localhost:5173/zh-Hant',
        '────────────────────────────────────────────────',
        '  ⏵⏵ auto mode on (shift+tab to cycle)',
      ].join('\n'),
    })).toBe(true);
  });

  it('accepts a sufficiently long canonical visible composer window before and after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const words = Array.from({ length: 90 }, (_, index) => `incident-word-${index}`);
    const prompt = words.join(' ');
    const visiblePrefixWords = words.slice(0, 24);
    const visibleSuffixWords = words.slice(-24);

    expect(visiblePrefixWords.join(' ').length).toBeGreaterThanOrEqual(256);
    expect(visibleSuffixWords.join(' ').length).toBeGreaterThanOrEqual(256);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        `❯ ${visiblePrefixWords.slice(0, 8).join(' ')}`,
        `  ${visiblePrefixWords.slice(8, 16).join(' ')}`,
        `  ${visiblePrefixWords.slice(16).join(' ')}`,
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
    expect(policy.verifyBeforeSubmitStaging?.({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        `❯ ${visibleSuffixWords.slice(0, 8).join(' ')}`,
        `  ${visibleSuffixWords.slice(8, 16).join(' ')}`,
        `  ${visibleSuffixWords.slice(16).join(' ')}`,
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        `❯ ${visibleSuffixWords.slice(0, 8).join(' ')}`,
        `  ${visibleSuffixWords.slice(8, 16).join(' ')}`,
        `  ${visibleSuffixWords.slice(16).join(' ')}`,
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
    expect(policy.verifyBeforeSubmitStaging?.({
      promptText: prompt,
      screenText: `❯ ${prompt}`,
    })).toBe(true);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: `❯ ${visibleSuffixWords.slice(-8).join(' ')}`,
    })).toBe(false);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: `❯ ${'unrelated visible composer text '.repeat(12)}`,
    })).toBe(false);
  });

  it('recognizes Claude\'s count-free collapsed paste marker only in the current composer', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = `QA only: ${'single-line-pasted-content '.repeat(70)}`;

    expect(policy.verifyBeforeSubmitStaging({
      promptText: prompt,
      screenText: '❯ [Pasted text #1]',
    })).toBe(true);
    expect(policy.verifyAfterSubmit({
      promptText: prompt,
      screenText: [
        'previous assistant output',
        '❯ [Pasted text #1]',
        '',
        '│ > │',
      ].join('\n'),
    })).toBe(false);
  });
});
