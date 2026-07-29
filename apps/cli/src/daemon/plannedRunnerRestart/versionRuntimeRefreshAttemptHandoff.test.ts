import { describe, expect, it, vi } from 'vitest';

import { createVersionRuntimeRefreshAttemptHandoff } from './versionRuntimeRefreshAttemptHandoff';

describe('createVersionRuntimeRefreshAttemptHandoff', () => {
  it('moves a one-shot transient spawn override with wrapper PID promotion and consumes it once', async () => {
    vi.useFakeTimers();
    try {
      const transientSpawnOptions = { directory: '/repo', resume: 'vendor-1' };
      const handoff = createVersionRuntimeRefreshAttemptHandoff({
        timeoutMs: 100,
        timeoutCompletion: 'timeout',
        supersededCompletion: 'superseded',
        cancelledCompletion: 'cancelled',
      });
      const attempt = handoff.create({
        sessionId: 'sess-1',
        previousPid: 111,
        transientSpawnOptions,
      });

      handoff.transferPid('sess-1', 111, 222);

      expect(handoff.takeTransientSpawnOptions('sess-1', 111)).toBeUndefined();
      expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toBe(transientSpawnOptions);
      expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toBeUndefined();
      handoff.settle('sess-1', 222, 'success');
      await expect(attempt.promise).resolves.toBe('success');
      await vi.advanceTimersByTimeAsync(100);
      await expect(attempt.promise).resolves.toBe('success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out through the promoted PID key without retaining the transient spawn override', async () => {
    vi.useFakeTimers();
    try {
      const handoff = createVersionRuntimeRefreshAttemptHandoff({
        timeoutMs: 100,
        timeoutCompletion: 'timeout',
        supersededCompletion: 'superseded',
        cancelledCompletion: 'cancelled',
      });
      const attempt = handoff.create({
        sessionId: 'sess-1',
        previousPid: 111,
        transientSpawnOptions: { directory: '/repo' },
      });

      handoff.transferPid('sess-1', 111, 222);
      await vi.advanceTimersByTimeAsync(100);

      await expect(attempt.promise).resolves.toBe('timeout');
      expect(handoff.takeTransientSpawnOptions('sess-1', 111)).toBeUndefined();
      expect(handoff.takeTransientSpawnOptions('sess-1', 222)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
