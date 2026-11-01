import { describe, expect, it, vi } from 'vitest';

import { createCodexAbortHandler } from './abortHandler.js';

describe('createCodexAbortHandler', () => {
  it('stores the active remote session id before cancelling the turn', async () => {
    let storedSessionIdForResume: string | null = 'old-session';
    let storedSessionIdFromLocalControl = true;

    let identityAtCancellation: { sessionId: string | null; fromLocalControl: boolean } | undefined;
    const cancelCurrentTurn = vi.fn(async () => {
      identityAtCancellation = {
        sessionId: storedSessionIdForResume,
        fromLocalControl: storedSessionIdFromLocalControl,
      };
    });
    const abortTurn = vi.fn();
    const resetAbortControllers = vi.fn();

    await createCodexAbortHandler({
      getRemoteSessionId: () => 'thread-123',
      getStoredSessionIdForResume: () => storedSessionIdForResume,
      setStoredSessionIdForResume: (value) => {
        storedSessionIdForResume = value;
      },
      setStoredSessionIdFromLocalControl: (value) => {
        storedSessionIdFromLocalControl = value;
      },
      cancelCurrentTurn,
      abortStartOrLoad: vi.fn(),
      abortTurn,
      resetAbortControllers,
      logDebug: vi.fn(),
    })();

    expect(storedSessionIdForResume).toBe('thread-123');
    expect(storedSessionIdFromLocalControl).toBe(false);
    expect(identityAtCancellation).toEqual({ sessionId: 'thread-123', fromLocalControl: false });
    expect(cancelCurrentTurn).toHaveBeenCalledTimes(1);
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(resetAbortControllers).toHaveBeenCalledTimes(1);
  });
});

