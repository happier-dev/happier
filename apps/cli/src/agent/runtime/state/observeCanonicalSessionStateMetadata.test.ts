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
});
