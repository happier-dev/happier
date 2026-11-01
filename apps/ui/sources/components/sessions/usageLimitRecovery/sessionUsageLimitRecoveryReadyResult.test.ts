import { describe, expect, it, vi } from 'vitest';

import { handleReadyUsageLimitRecoveryResult } from './sessionUsageLimitRecoveryReadyResult';

describe('handleReadyUsageLimitRecoveryResult', () => {
    it('keeps an active ready issue actionable without treating readiness as provider recovery', async () => {
        const resumeInactiveSession = vi.fn(async () => false);
        const markReady = vi.fn();

        const result = await handleReadyUsageLimitRecoveryResult({
            sessionActive: true,
            resumeInactiveSession,
            markReady,
        });

        expect(result).toBe('ready');
        expect(resumeInactiveSession).not.toHaveBeenCalled();
        expect(markReady).toHaveBeenCalledTimes(1);
    });

    it('keeps an inactive ready issue visible when silent resume fails', async () => {
        const resumeInactiveSession = vi.fn(async () => false);
        const markReady = vi.fn();

        const result = await handleReadyUsageLimitRecoveryResult({
            sessionActive: false,
            resumeInactiveSession,
            markReady,
        });

        expect(result).toBe('resume_failed');
        expect(resumeInactiveSession).toHaveBeenCalledTimes(1);
        expect(markReady).toHaveBeenCalledTimes(1);
    });

    it('keeps an inactive ready issue actionable after the runtime launch succeeds', async () => {
        const resumeInactiveSession = vi.fn(async () => true);
        const markReady = vi.fn();

        const result = await handleReadyUsageLimitRecoveryResult({
            sessionActive: false,
            resumeInactiveSession,
            markReady,
        });

        expect(result).toBe('ready');
        expect(resumeInactiveSession).toHaveBeenCalledTimes(1);
        expect(markReady).toHaveBeenCalledTimes(1);
    });
});
