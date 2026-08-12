import { describe, expect, it, vi } from 'vitest';

import { runTerminalPromptSubmission } from './promptSubmitVerification';

describe('runTerminalPromptSubmission', () => {
  it('waits for exact prompt staging before sending Enter', async () => {
    const calls: string[] = [];
    let staged = false;

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      verifyStagedBeforeSubmit: async () => {
        calls.push('verify-staged');
        const result = staged;
        staged = true;
        return result;
      },
      submitEnter: async () => {
        calls.push('enter');
        return 'success';
      },
      remainingTimeoutMs: () => 100,
      wait: async (delayMs) => {
        calls.push(`wait:${delayMs}`);
      },
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual([
      'verify-staged',
      'wait:25',
      'verify-staged',
      'enter',
    ]);
  });

  it('does not send Enter when exact prompt staging exhausts the write deadline', async () => {
    const submitEnter = vi.fn();

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      verifyStagedBeforeSubmit: async () => false,
      submitEnter,
      remainingTimeoutMs: () => 0,
      wait: async () => {},
    })).resolves.toEqual({
      success: false,
      reason: 'timeout',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: false,
    });

    expect(submitEnter).not.toHaveBeenCalled();
  });

  it('submits immediately and then verifies the composer', async () => {
    const calls: string[] = [];

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => {
        calls.push('enter');
        return 'success';
      },
      verifyAfterSubmit: async () => {
        calls.push('verify-after');
        return false;
      },
      wait: async () => {},
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual(['enter', 'verify-after', 'verify-after']);
  });

  it('settles before verifying and retries enter once when the pasted prompt remains in the composer', async () => {
    const calls: string[] = [];
    let stillPending = true;

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => {
        calls.push('enter');
        return 'success';
      },
      verifyAfterSubmit: async () => {
        calls.push('verify-after');
        const result = stillPending;
        stillPending = false;
        return result;
      },
      wait: async (delayMs) => {
        calls.push(`wait:${delayMs}`);
      },
      submitRetryDelayMs: 10,
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual([
      'enter',
      'wait:10',
      'verify-after',
      'wait:10',
      'enter',
      'wait:10',
      'verify-after',
      'wait:10',
      'verify-after',
    ]);
  });

  it('fails visibly when the prompt is still pending after the retry enter', async () => {
    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => 'success',
      verifyAfterSubmit: async () => true,
      wait: async () => {},
    })).resolves.toEqual({
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: true,
    });
  });

  it('keeps delivery ambiguous when post-submit verification is unavailable', async () => {
    let submitCount = 0;

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => {
        submitCount += 1;
        return 'success';
      },
      verifyAfterSubmit: async () => {
        throw new Error('screen capture unavailable');
      },
      wait: async () => {},
    })).resolves.toEqual({
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    });

    expect(submitCount).toBe(1);
  });
});
