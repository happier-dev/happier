import { describe, expect, it, vi } from 'vitest';

import { runTerminalPromptSubmission } from '@/integrations/terminalHost/promptSubmitVerification';

import { createClaudePromptSubmitVerificationPolicy } from './claudePromptSubmitVerification';

describe('createClaudePromptSubmitVerificationPolicy', () => {
  it('hands a positively foreign composer back without submitting it, while ambiguous capture still waits', async () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const promptText = 'authorized prompt';
    const foreignScreen = '❯ A changed user draft\n  with a separate paragraph';
    const submitEnter = vi.fn(async () => 'success' as const);
    const result = await runTerminalPromptSubmission({
      promptText,
      verifyStagedBeforeSubmit: async () => policy.isPromptStagedBeforeSubmit({ promptText, screenText: foreignScreen }),
      submitEnter,
      remainingTimeoutMs: () => 0,
    });
    expect(result).toMatchObject({
      success: false, reason: 'verification_failed', phase: 'after_write_before_enter', submitMayHaveReachedPane: false,
    });
    expect(submitEnter).not.toHaveBeenCalled();
    expect(policy.isPromptStillPendingAfterSubmit({ promptText, screenText: foreignScreen })).toBe(false);
    // No cursor/style evidence: these may be a suggestion or an in-progress paste marker.
    expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: '❯ Try editing a file' })).toBe(false);
    expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: '❯ [Pasted text #1' })).toBe(false);
  });

  it('verifies every non-empty prompt after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();

    expect(policy.shouldVerifyAfterSubmit('first line\nsecond line')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('first line\r\nsecond line')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('single line prompt')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('   ')).toBe(false);
  });

  it('detects a single-line prompt that remains exactly in the composer after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = 'Reply exactly with WIN-CLAUDE-UNIFIED-CS-AFTERFIX2-FIRST-20260629T1535Z and nothing else.';

    expect(policy.shouldVerifyAfterSubmit(prompt)).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: `Claude Code\n> ${prompt}`,
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        prompt,
        '',
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

    expect(policy.isPromptStillPendingAfterSubmit({
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

    expect(policy.isPromptStagedBeforeSubmit?.({
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

  it('submits a staged URL wrapped inside the token', async () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = `Check https://example.invalid/?q=${'a'.repeat(90)}`;
    const screenText = [
      `❯ Check https://example.invalid/?q=${'a'.repeat(50)}`,
      `  ${'a'.repeat(40)}`,
    ].join('\n');
    const submitEnter = vi.fn(async () => 'success' as const);

    expect(policy.isPromptStagedBeforeSubmit?.({
      promptText: prompt,
      screenText,
    })).toBe(true);
    expect(await runTerminalPromptSubmission({
      promptText: prompt,
      verifyStagedBeforeSubmit: async ({ promptText }) => policy.isPromptStagedBeforeSubmit?.({
        promptText,
        screenText,
      }) ?? false,
      submitEnter,
      verifyAfterSubmit: async () => false,
      remainingTimeoutMs: () => 0,
      wait: async () => {},
      postSubmitSettleMs: 0,
    })).toEqual({ success: true });
    expect(submitEnter).toHaveBeenCalledOnce();
  });

  it('submits a prompt whose small terminal viewport exposes only a short matching tail', async () => {
    // Claude Code 2.1.280, real tmux probe at 40x15: the composer scrolls to its
    // last three rows after paste, even though the complete prompt was written.
    const promptText = `${'Review the message delivery implementation. '.repeat(10)}\n\nExplain whether the message arrived, and report any remaining issue.`;
    const screenText = [
      '─'.repeat(40),
      '❯ Explain whether the message',
      '  arrived, and report any remaining',
      '  issue.',
      '─'.repeat(40),
      '  ⏸ plan mode on',
    ].join('\n');
    const policy = createClaudePromptSubmitVerificationPolicy();
    const submitEnter = vi.fn(async () => 'success' as const);

    expect(await runTerminalPromptSubmission({
      promptText,
      verifyStagedBeforeSubmit: async () => policy.isPromptStagedBeforeSubmit({ promptText, screenText }),
      submitEnter,
      verifyAfterSubmit: async () => false,
      remainingTimeoutMs: () => 0,
      wait: async () => {},
      postSubmitSettleMs: 0,
    })).toEqual({ success: true });
    expect(submitEnter).toHaveBeenCalledOnce();
    expect(policy.isPromptStillPendingAfterSubmit({ promptText, screenText })).toBe(true);
    expect(() => policy.isPromptStagedBeforeSubmit({
      promptText,
      screenText: screenText.replace('remaining', 'unrelated'),
    })).toThrow();
  });

  it('accepts a sufficiently long canonical visible composer window before and after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const words = Array.from({ length: 90 }, (_, index) => `incident-word-${index}`);
    const prompt = words.join(' ');
    const visiblePrefixWords = words.slice(0, 24);
    const visibleSuffixWords = words.slice(-24);

    expect(visiblePrefixWords.join(' ').length).toBeGreaterThanOrEqual(256);
    expect(visibleSuffixWords.join(' ').length).toBeGreaterThanOrEqual(256);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        `❯ ${visiblePrefixWords.slice(0, 8).join(' ')}`,
        `  ${visiblePrefixWords.slice(8, 16).join(' ')}`,
        `  ${visiblePrefixWords.slice(16).join(' ')}`,
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
    expect(policy.isPromptStagedBeforeSubmit?.({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        `❯ ${visibleSuffixWords.slice(0, 8).join(' ')}`,
        `  ${visibleSuffixWords.slice(8, 16).join(' ')}`,
        `  ${visibleSuffixWords.slice(16).join(' ')}`,
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        `❯ ${visibleSuffixWords.slice(0, 8).join(' ')}`,
        `  ${visibleSuffixWords.slice(8, 16).join(' ')}`,
        `  ${visibleSuffixWords.slice(16).join(' ')}`,
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
    expect(policy.isPromptStagedBeforeSubmit?.({
      promptText: prompt,
      screenText: `❯ ${prompt}`,
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: `❯ ${visibleSuffixWords.slice(-8).join(' ')}`,
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: `❯ ${'unrelated visible composer text '.repeat(12)}`,
    })).toBe(false);
  });

  it('recognizes a current collapsed pasted prompt after submit with footer rows below it', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        '┄'.repeat(20),
        '› [Pasted text #1 +40 lines]',
        '─'.repeat(20),
        '⏵⏵ auto mode on (shift+tab to cycle)',
      ].join('\n'),
    })).toBe(true);
    expect(policy.isPromptStagedBeforeSubmit?.({
      promptText: prompt,
      screenText: '❯ [Pasted text #1 +40 lines]',
    })).toBe(true);
  });

  it('recognizes Claude\'s count-free collapsed paste marker only in the current composer', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = `QA only: ${'single-line-pasted-content '.repeat(70)}`;

    expect(policy.isPromptStagedBeforeSubmit?.({
      promptText: prompt,
      screenText: '❯ [Pasted text #1]',
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        'previous assistant output',
        '❯ [Pasted text #1]',
        '',
        '│ > │',
      ].join('\n'),
    })).toBe(false);
  });

  it('verifies chunked native paste markers without accepting a mixed user draft or historical paste', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const promptText = 'large escaped prompt '.repeat(100_000);
    // Claude Code 2.1.287 renders separate Herdr IPC pastes as adjacent blocks.
    const markers = '[Pasted text #1][Pasted text #2][Pasted text #3 +7 lines]';
    expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: `❯ ${markers}` })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({ promptText, screenText: `❯ ${markers}` })).toBe(true);
    for (const composer of [`user draft ${markers}`, `${markers} user draft`, '[Pasted text #1][not a paste marker]']) {
      expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: `❯ ${composer}` })).toBe(false);
    }
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText, screenText: `❯ ${markers}\n\n│ > │`,
    })).toBe(false);
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

    expect(policy.isPromptStagedBeforeSubmit?.({
      promptText: prompt,
      screenText: capturedScreen,
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: capturedScreen,
    })).toBe(true);
  });

  it('does not treat a stale submitted marker above an empty composer as pending after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        'earlier submitted prompt',
        '❯ [Pasted text #1 +40 lines]',
        '',
        '│ > │',
      ].join('\n'),
    })).toBe(false);
  });

  // Live capture (Claude Code 2.1.301): a prompt starting with `!` flips Claude into bash mode on
  // paste, the `!` is consumed and the rest sits on a `!`-marked prompt line above the
  // `! for shell mode` footer. Without recognizing it the text was never seen as staged, Enter was
  // never sent, and the command stayed in the terminal prompt.
  describe('bash mode (prompt starting with "!")', () => {
    const RULE = '────────────────────────────────────────────────';
    const FOOTER = '  ! for shell mode';
    const bashScreen = (promptLine: string) => ['', RULE, promptLine, RULE, FOOTER].join('\n');
    const normalEmptyScreen = ['', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');

    it('sees the prompt staged on the bash-mode prompt line, and still pending until the command ran', () => {
      const policy = createClaudePromptSubmitVerificationPolicy();
      const promptText = '! echo hi';

      expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: bashScreen('!  echo hi') })).toBe(true);
      expect(policy.isPromptStillPendingAfterSubmit({ promptText, screenText: bashScreen('!  echo hi') })).toBe(true);
      expect(policy.isPromptStillPendingAfterSubmit({ promptText, screenText: normalEmptyScreen })).toBe(false);
    });

    it('does not take other text on the bash-mode prompt line for the authorized prompt', () => {
      const policy = createClaudePromptSubmitVerificationPolicy();
      const promptText = '! echo hi';

      expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: bashScreen('!  ls') })).toBe(false);
      expect(policy.isPromptStagedBeforeSubmit({ promptText, screenText: bashScreen('! Try "fix typecheck errors"') })).toBe(false);
    });

    it('does not read the footer hint as the staged prompt', () => {
      const policy = createClaudePromptSubmitVerificationPolicy();

      expect(policy.isPromptStagedBeforeSubmit({
        promptText: '! for shell mode',
        screenText: bashScreen('! Try "fix typecheck errors"'),
      })).toBe(false);
    });

    it('rejects historical shell input when the active composer contains a foreign draft', () => {
      const screenText = [
        bashScreen('! echo hi'),
        '❯ a different current user draft',
        '  with a second paragraph',
        RULE,
        '  ? for shortcuts',
      ].join('\n');
      expect(() => createClaudePromptSubmitVerificationPolicy().isPromptStagedBeforeSubmit({
        promptText: '! echo hi', screenText,
      })).toThrow('Claude composer changed');
    });

    it('verifies the complete visible shell draft including wrapped continuation lines', () => {
      const policy = createClaudePromptSubmitVerificationPolicy();
      const screenText = [RULE, '! echo hi', '  && echo another-command', RULE, FOOTER].join('\n');
      expect(policy.isPromptStagedBeforeSubmit({ promptText: '! echo hi', screenText })).toBe(false);
      expect(policy.isPromptStagedBeforeSubmit({
        promptText: '! echo hi && echo another-command', screenText,
      })).toBe(true);
    });

    it('requires an authorized shell request before accepting shell input', () => {
      expect(createClaudePromptSubmitVerificationPolicy().isPromptStagedBeforeSubmit({
        promptText: 'echo hi', screenText: bashScreen('! echo hi'),
      })).toBe(false);
    });

    it('does not submit historical shell input while a permission dialog owns the terminal', () => {
      const screenText = [bashScreen('! echo hi'), 'Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n');
      expect(createClaudePromptSubmitVerificationPolicy().isPromptStagedBeforeSubmit({
        promptText: '! echo hi', screenText,
      })).toBe(false);
    });
  });
});
