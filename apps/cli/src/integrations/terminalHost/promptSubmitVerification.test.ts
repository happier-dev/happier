import { describe, expect, it } from 'vitest';

import {
    runTerminalPromptSubmission,
} from './promptSubmitVerification';

describe('runTerminalPromptSubmission', () => {
    it('verifies the paste before sending enter when a policy asks for it', async () => {
        const calls: string[] = [];

        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            verifyBeforeSubmit: async () => {
                calls.push('verify-before');
                return true;
            },
            submitEnter: async () => {
                calls.push('enter');
                return 'success';
            },
        })).resolves.toEqual({ success: true });

        expect(calls).toEqual(['verify-before', 'enter']);
    });

    it('does not submit when an explicit pre-submit verifier never proves the paste landed', async () => {
        const calls: string[] = [];

        await expect(runTerminalPromptSubmission({
            promptText: 'first\nsecond',
            verifyBeforeSubmit: async () => {
                calls.push('verify-before');
                return false;
            },
            submitEnter: async () => {
                calls.push('enter');
                return 'success';
            },
            wait: async () => {},
            maxPreSubmitPollMs: 0,
        })).resolves.toEqual({
            success: false,
            reason: 'verification_failed',
            phase: 'after_write_before_enter',
            duplicateRisk: 'possible',
            submitMayHaveReachedPane: false,
        });

        expect(calls).toEqual(['verify-before']);
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
});
