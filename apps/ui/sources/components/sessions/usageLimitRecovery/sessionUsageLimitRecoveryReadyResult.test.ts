import { describe, expect, it, vi } from 'vitest';

import { handleReadyUsageLimitRecoveryResult } from './sessionUsageLimitRecoveryReadyResult';

describe('handleReadyUsageLimitRecoveryResult', () => {
    it('marks an active ready issue resolved without resuming', async () => {
        const resumeInactiveSession = vi.fn(async () => false);
        const markResolved = vi.fn();
        const markReady = vi.fn();

        const result = await handleReadyUsageLimitRecoveryResult({
            sessionActive: true,
            resumeInactiveSession,
            markResolved,
            markReady,
        });

        expect(result).toBe('resolved');
        expect(resumeInactiveSession).not.toHaveBeenCalled();
        expect(markResolved).toHaveBeenCalledTimes(1);
        expect(markReady).not.toHaveBeenCalled();
    });

    it('keeps an inactive ready issue visible when silent resume fails', async () => {
        const resumeInactiveSession = vi.fn(async () => false);
        const markResolved = vi.fn();
        const markReady = vi.fn();

        const result = await handleReadyUsageLimitRecoveryResult({
            sessionActive: false,
            resumeInactiveSession,
            markResolved,
            markReady,
        });

        expect(result).toBe('resume_failed');
        expect(resumeInactiveSession).toHaveBeenCalledTimes(1);
        expect(markResolved).not.toHaveBeenCalled();
        expect(markReady).toHaveBeenCalledTimes(1);
    });

    it('marks an inactive ready issue resolved only after silent resume succeeds', async () => {
        const resumeInactiveSession = vi.fn(async () => true);
        const markResolved = vi.fn();
        const markReady = vi.fn();

        const result = await handleReadyUsageLimitRecoveryResult({
            sessionActive: false,
            resumeInactiveSession,
            markResolved,
            markReady,
        });

        expect(result).toBe('resolved');
        expect(resumeInactiveSession).toHaveBeenCalledTimes(1);
        expect(markResolved).toHaveBeenCalledTimes(1);
        expect(markReady).not.toHaveBeenCalled();
    });
});
