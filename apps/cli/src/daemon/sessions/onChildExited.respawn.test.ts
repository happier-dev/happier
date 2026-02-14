import { describe, expect, it, vi } from 'vitest';

import { createOnChildExited } from './onChildExited';

describe('createOnChildExited', () => {
  it('invokes onUnexpectedExit hook for non-zero exits with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ happySessionId: 'session-1', pid: 123 }),
      expect.objectContaining({ code: 1 }),
    );
  });
});

