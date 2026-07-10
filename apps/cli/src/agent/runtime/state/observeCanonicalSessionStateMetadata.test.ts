import { describe, expect, it, vi } from 'vitest';

import { observeCanonicalSessionStateMetadata } from './observeCanonicalSessionStateMetadata';

describe('observeCanonicalSessionStateMetadata', () => {
  it('does not mirror display.title again for unrelated metadata updates', async () => {
    const applyHappierField = vi.fn(async () => ({ ok: true as const }));
    const session = {
      sessionId: 'session-1',
      getMetadataSnapshot: vi.fn(() => ({
        summary: {
          text: 'Canonical title',
          updatedAt: 123,
        },
        hostPid: Math.floor(Math.random() * 10_000),
      })),
      waitForMetadataUpdate: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };

    const observer = observeCanonicalSessionStateMetadata({
      session,
      sessionState: { applyHappierField },
    });

    await observer.mirrorCurrentDisplayTitle('reconciliation');
    await vi.waitFor(() => {
      expect(session.waitForMetadataUpdate).toHaveBeenCalledTimes(2);
    });
    observer.dispose();

    expect(applyHappierField).toHaveBeenCalledTimes(1);
    expect(applyHappierField).toHaveBeenCalledWith({
      ctx: { sessionId: 'session-1' },
      fieldId: 'display.title',
      value: 'Canonical title',
      reason: 'reconciliation',
    });
  });

  it('keeps observing after a transient metadata wait failure', async () => {
    vi.useFakeTimers();
    try {
      const applyHappierField = vi.fn(async () => ({ ok: true as const }));
      let waitCalls = 0;
      const session = {
        sessionId: 'session-1',
        getMetadataSnapshot: vi.fn(() => ({
          summary: {
            text: waitCalls >= 2 ? 'Recovered title' : 'Initial title',
            updatedAt: waitCalls >= 2 ? 2 : 1,
          },
        })),
        waitForMetadataUpdate: vi.fn(async (abortSignal?: AbortSignal) => {
          waitCalls += 1;
          if (waitCalls === 1) return false;
          if (waitCalls === 2) return true;
          return await new Promise<boolean>((resolve) => {
            if (abortSignal?.aborted) return resolve(false);
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          });
        }),
      };

      const observer = observeCanonicalSessionStateMetadata({
        session,
        sessionState: { applyHappierField },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(session.waitForMetadataUpdate).toHaveBeenCalledTimes(1);
      expect(applyHappierField).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(applyHappierField).toHaveBeenCalledWith({
          ctx: { sessionId: 'session-1' },
          fieldId: 'display.title',
          value: 'Recovered title',
          reason: 'user-mutation',
        });
      });

      observer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
