import { describe, expect, it, vi } from 'vitest';

import {
    runTerminalPromptSubmission,
} from './promptSubmitVerification';

describe('runTerminalPromptSubmission', () => {
  it('waits for provider redraw beyond the write budget until the session ends', async () => {
    const lifetime = new AbortController();
    let elapsedMs = 0;
    let enterCount = 0;
    const result = await runTerminalPromptSubmission({
      promptText: 'loaded prompt',
      signal: lifetime.signal,
      remainingTimeoutMs: () => Math.max(0, 15_000 - elapsedMs),
      verifyStagedBeforeSubmit: async () => elapsedMs >= 20_000,
      submitEnter: async () => { enterCount += 1; return 'success'; },
      verifyAfterSubmit: async () => elapsedMs < 30_000,
      wait: async delayMs => { elapsedMs += delayMs; },
    });

    expect(result).toEqual({ success: true });
    expect(enterCount).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
  });

  it.each([false, true])('stops on session cancellation without another Enter (submitted=%s)', async submitted => {
    const lifetime = new AbortController();
    let enterCount = 0;
    let elapsedMs = 0;
    const result = await runTerminalPromptSubmission({
      promptText: 'loaded prompt',
      signal: lifetime.signal,
      remainingTimeoutMs: () => Math.max(0, 1_000 - elapsedMs),
      verifyStagedBeforeSubmit: async () => submitted,
      submitEnter: async () => { enterCount += 1; return 'success'; },
      verifyAfterSubmit: async () => true,
      wait: async () => { elapsedMs += 100; lifetime.abort(); },
    });

    expect(result).toMatchObject({
      success: false,
      reason: 'verification_failed',
      phase: submitted ? 'after_enter_unknown' : 'after_write_before_enter',
      submitMayHaveReachedPane: submitted,
    });
    expect(enterCount).toBe(submitted ? 1 : 0);
    expect(elapsedMs).toBe(100);
  });

  it.each(['accepted', 'retired'] as const)('stops waiting when canonical delivery is %s before staging is observed', async state => {
    let deliveryState: 'accepted' | 'retired' | null = null;
    let enterCount = 0;
    const result = await runTerminalPromptSubmission({
      promptText: 'loaded prompt',
      signal: new AbortController().signal,
      resolveDeliveryState: () => deliveryState,
      remainingTimeoutMs: () => 0,
      verifyStagedBeforeSubmit: async () => { deliveryState = state; return false; },
      submitEnter: async () => { enterCount += 1; return 'success'; },
    });
    expect(result).toMatchObject(state === 'accepted'
      ? { success: true }
      : { success: false, phase: 'after_write_before_enter', submitMayHaveReachedPane: false });
    expect(enterCount).toBe(0);
  });

    it('honors canonical acceptance arriving during a failed staging capture without Enter', async () => {
    let accepted = false;
    let enterCount = 0;
    const result = await runTerminalPromptSubmission({
      promptText: 'manually accepted prompt',
      signal: new AbortController().signal,
      resolveDeliveryState: () => accepted ? 'accepted' : null,
      verifyStagedBeforeSubmit: async () => { accepted = true; throw new Error('capture unavailable'); },
      submitEnter: async () => { enterCount += 1; return 'success'; },
    });
    expect(result).toEqual({ success: true });
    expect(enterCount).toBe(0);
  });

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
            remainingTimeoutMs: () => 1_000,
            wait: async (delayMs) => {
                calls.push(`wait:${delayMs}`);
            },
        })).resolves.toEqual({ success: true });

        expect(calls).toEqual([
            'verify-staged',
            'wait:250',
            'verify-staged',
            'enter',
        ]);
    });

    it('does not send Enter when exact prompt staging exhausts the write deadline', async () => {
        const verifyStagedBeforeSubmit = vi.fn(async () => false);
        const submitEnter = vi.fn();

        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            verifyStagedBeforeSubmit,
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

        expect(verifyStagedBeforeSubmit).toHaveBeenCalledOnce();
        expect(submitEnter).not.toHaveBeenCalled();
    });

    it('submits when the final deadline observation proves the exact prompt is staged', async () => {
        const submitEnter = vi.fn(async ({ remainingTimeoutMs }: Readonly<{ remainingTimeoutMs?: number | undefined }>) => {
            expect(remainingTimeoutMs).toBeUndefined();
            return 'success' as const;
        });

        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            verifyStagedBeforeSubmit: async ({ remainingTimeoutMs }) => {
                expect(remainingTimeoutMs).toBeUndefined();
                return true;
            },
            submitEnter,
            remainingTimeoutMs: () => 0,
            wait: async () => {},
        })).resolves.toEqual({ success: true });

        expect(submitEnter).toHaveBeenCalledOnce();
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

    it('waits for a delayed composer redraw within the operation budget without resubmitting', async () => {
        let elapsedMs = 0;
        const submitEnter = vi.fn(async () => 'success' as const);

        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            submitEnter,
            // Claude 2.1.280 can record acceptance before its composer redraws.
            verifyAfterSubmit: async () => elapsedMs < 500,
            remainingTimeoutMs: () => Math.max(0, 1_000 - elapsedMs),
            wait: async (delayMs) => { elapsedMs += delayMs; },
        })).resolves.toEqual({ success: true });

        expect(submitEnter).toHaveBeenCalledOnce();
        expect(elapsedMs).toBeGreaterThanOrEqual(500);
        expect(elapsedMs).toBeLessThanOrEqual(1_000);
    });

    it('keeps delivery ambiguous when the composer remains pending until the operation deadline', async () => {
        let elapsedMs = 0;
        const submitEnter = vi.fn(async () => 'success' as const);

        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            submitEnter,
            verifyAfterSubmit: async () => true,
            remainingTimeoutMs: () => Math.max(0, 1_000 - elapsedMs),
            wait: async (delayMs) => { elapsedMs += delayMs; },
        })).resolves.toEqual({
            success: false,
            reason: 'verification_failed',
            phase: 'after_enter_unknown',
            duplicateRisk: 'possible',
            submitMayHaveReachedPane: true,
        });

        expect(submitEnter).toHaveBeenCalledOnce();
        expect(elapsedMs).toBe(1_000);
    });

    it('does not invent a retry budget when the caller provides none', async () => {
        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            submitEnter: async () => 'success',
            verifyAfterSubmit: async () => true,
            wait: async () => {},
        })).resolves.toMatchObject({ success: false, reason: 'verification_failed' });
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
