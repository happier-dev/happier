import { describe, expect, it } from 'vitest';

import { selectSessionsForBackfill } from './selectSessionsForBackfill';

describe('selectSessionsForBackfill', () => {
  it('stops at the first old session in last_30_days mode', () => {
    const nowMs = 60 * 24 * 60 * 60 * 1000;
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;

    const res = selectSessionsForBackfill({
      nowMs,
      backfillPolicy: 'last_30_days',
      sessions: [
        { id: 's1', updatedAt: nowMs } as any,
        { id: 's2', updatedAt: nowMs - 10_000 } as any,
        { id: 's3', updatedAt: nowMs - thirtyOneDaysMs } as any,
        { id: 's4', updatedAt: nowMs } as any,
      ],
    });

    expect(res.sessionIds).toEqual(['s1', 's2']);
    expect(res.shouldStopPaging).toBe(true);
  });

  it('includes all sessions in all_history mode', () => {
    const nowMs = 1_000_000_000;

    const res = selectSessionsForBackfill({
      nowMs,
      backfillPolicy: 'all_history',
      sessions: [{ id: 's1', updatedAt: nowMs } as any, { id: 's2', updatedAt: nowMs - 999 } as any],
    });

    expect(res.sessionIds).toEqual(['s1', 's2']);
    expect(res.shouldStopPaging).toBe(false);
  });
});
