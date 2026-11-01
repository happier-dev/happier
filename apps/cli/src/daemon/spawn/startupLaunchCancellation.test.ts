import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPidPresent } from '@happier-dev/cli-common/process';

import {
  completeStartupCancellationCleanup,
} from './startupLaunchCancellation';

// OS liveness is the boundary; cleanup and tracked-session ownership stay real.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  isPidPresent: vi.fn(),
}));

describe('completeStartupCancellationCleanup', () => {
  beforeEach(() => {
    vi.mocked(isPidPresent).mockReset();
    vi.mocked(isPidPresent).mockReturnValue(false);
  });

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

  it.skipIf(process.platform === 'win32')('retains custody without cleanup while the POSIX runner is still present', async () => {
    vi.mocked(isPidPresent).mockReturnValue(true);
    const tracked = { pid: 4_242, startedBy: 'daemon' as const };
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const onChildExited = vi.fn(async () => undefined);

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      pidToTrackedSession,
      onChildExited,
    })).resolves.toEqual({ status: 'incomplete', reason: 'process_still_running' });
    expect(pidToTrackedSession.get(tracked.pid)).toBe(tracked);
    expect(onChildExited).not.toHaveBeenCalled();
  });
});
