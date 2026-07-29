import { describe, expect, it, vi } from 'vitest';

import {
  completeStartupCancellationCleanup,
} from './startupLaunchCancellation';

describe('completeStartupCancellationCleanup', () => {
  it('retries the same tracked object at its promoted runner PID', async () => {
    const wrapperPid = 4_242;
    const runnerPid = 4_243;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon' as const,
      happySessionId: `PID-${wrapperPid}`,
    };
    const pidToTrackedSession = new Map([[wrapperPid, tracked]]);
    const onChildExited = vi.fn(async (pid: number) => {
      if (pid === wrapperPid) {
        pidToTrackedSession.delete(wrapperPid);
        tracked.pid = runnerPid;
        pidToTrackedSession.set(runnerPid, tracked);
        return;
      }
      pidToTrackedSession.delete(runnerPid);
    });

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      pidToTrackedSession,
      onChildExited,
    })).resolves.toEqual({ status: 'stopped' });
    expect(onChildExited.mock.calls.map(([pid]) => pid)).toEqual([
      wrapperPid,
      runnerPid,
    ]);
    expect([...pidToTrackedSession.values()]).not.toContain(tracked);
  });

  it('reports incomplete when canonical cleanup retains the exact owner', async () => {
    const pid = 4_242;
    const tracked = {
      pid,
      startedBy: 'daemon' as const,
      happySessionId: `PID-${pid}`,
    };
    const pidToTrackedSession = new Map([[pid, tracked]]);

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      pidToTrackedSession,
      onChildExited: vi.fn(async () => undefined),
    })).resolves.toEqual({
      status: 'incomplete',
      reason: 'exit_cleanup_incomplete',
    });
    expect(pidToTrackedSession.get(pid)).toBe(tracked);
  });
});
