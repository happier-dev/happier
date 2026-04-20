import { describe, expect, it, vi } from 'vitest';

import { createCodexAbortHandler } from './createCodexAbortHandler';

describe('createCodexAbortHandler', () => {
    it('stores the remote session id, cancels an in-flight ACP turn, and resets abort controllers', async () => {
        let storedSessionIdForResume: string | null = 'resume-keep';
        let storedSessionIdFromLocalControl = true;
        const abortStartOrLoad = vi.fn();
        const abortTurn = vi.fn();
        const resetAbortControllers = vi.fn();
        const cancel = vi.fn(async () => {});

        const handleAbort = createCodexAbortHandler({
            getRemoteSessionId: () => 'thread-123',
            getStoredSessionIdForResume: () => storedSessionIdForResume,
            setStoredSessionIdForResume: (next) => {
                storedSessionIdForResume = next;
            },
            setStoredSessionIdFromLocalControl: (next) => {
                storedSessionIdFromLocalControl = next;
            },
            cancelCurrentTurn: cancel,
            abortStartOrLoad,
            abortTurn,
            resetAbortControllers,
            logDebug: vi.fn(),
        });

        await handleAbort();

        expect(abortStartOrLoad).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(abortTurn).toHaveBeenCalledTimes(1);
        expect(storedSessionIdForResume).toBe('thread-123');
        expect(storedSessionIdFromLocalControl).toBe(false);
        expect(resetAbortControllers).toHaveBeenCalledTimes(1);
    });

    it('uses the app-server cancel path when Codex ACP is not active', async () => {
        let storedSessionIdForResume: string | null = 'resume-keep';
        let storedSessionIdFromLocalControl = true;
        const abortStartOrLoad = vi.fn();
        const abortTurn = vi.fn();
        const resetAbortControllers = vi.fn();
        const cancel = vi.fn(async () => {});

        const handleAbort = createCodexAbortHandler({
            getRemoteSessionId: () => null,
            getStoredSessionIdForResume: () => storedSessionIdForResume,
            setStoredSessionIdForResume: (next) => {
                storedSessionIdForResume = next;
            },
            setStoredSessionIdFromLocalControl: (next) => {
                storedSessionIdFromLocalControl = next;
            },
            cancelCurrentTurn: cancel,
            abortStartOrLoad,
            abortTurn,
            resetAbortControllers,
            logDebug: vi.fn(),
        });

        await handleAbort();

        expect(abortStartOrLoad).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(abortTurn).toHaveBeenCalledTimes(1);
        expect(storedSessionIdForResume).toBe('resume-keep');
        expect(storedSessionIdFromLocalControl).toBe(true);
        expect(resetAbortControllers).toHaveBeenCalledTimes(1);
    });
});
