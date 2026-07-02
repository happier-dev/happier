import { describe, expect, it } from 'vitest';

import {
    normalizeUsageLimitRecoverySettings,
    updateUsageLimitRecoveryRememberedMode,
} from './usageLimitRecoverySettings';

describe('usageLimitRecoverySettings', () => {
    it('preserves custom resume prompt settings while normalizing ask mode', () => {
        expect(normalizeUsageLimitRecoverySettings({
            v: 1,
            mode: 'ask',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Resume with the outage notes.',
        })).toEqual({
            v: 1,
            mode: 'ask',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Resume with the outage notes.',
        });
    });

    it('preserves a custom resume prompt when changing remembered mode', () => {
        expect(updateUsageLimitRecoveryRememberedMode({
            v: 1,
            mode: 'ask',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Pick up from the exact failure.',
        }, 'auto_wait')).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Pick up from the exact failure.',
        });
    });

    it('does not persist blank custom resume prompt text', () => {
        expect(updateUsageLimitRecoveryRememberedMode({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: '   ',
        }, 'ask')).toEqual({
            v: 1,
            mode: 'ask',
            promptMode: 'standard',
            resumePromptMode: 'custom',
        });
    });
});
