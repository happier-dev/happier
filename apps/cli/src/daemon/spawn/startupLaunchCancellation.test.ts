import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPidPresent, probeProcessGroupLiveness } from '@happier-dev/cli-common/process';

import {
  completeStartupCancellationCleanup,
} from './startupLaunchCancellation';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// OS liveness is the boundary; cleanup and tracked-session ownership stay real.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  isPidPresent: vi.fn(),
  probeProcessGroupLiveness: vi.fn(),
}));

describe('completeStartupCancellationCleanup', () => {
  beforeEach(() => {
    vi.mocked(isPidPresent).mockReset();
    vi.mocked(isPidPresent).mockReturnValue(false);
    vi.mocked(probeProcessGroupLiveness).mockReset();
    vi.mocked(probeProcessGroupLiveness).mockReturnValue('absent');
  });

  it('retries the same tracked object at its promoted runner PID', async () => {
    const wrapperPid = 4_242;
    const runnerPid = 4_243;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid),
      pid: wrapperPid,
      startedBy: 'daemon' as const,
      happySessionId: `PID-${wrapperPid}`,
    };
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const onChildExited = vi.fn(async (pid: number) => {
      if (pid === wrapperPid) {
        // Promotion rewrites the Session's pid in place under its key.
        tracked.pid = runnerPid;
        return;
      }
      trackedSessionsByKey.delete(tracked.trackingKey);
    });

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      trackedSessionsByKey,
      onChildExited,
    })).resolves.toEqual({ status: 'stopped' });
    expect(onChildExited.mock.calls.map(([pid]) => pid)).toEqual([
      wrapperPid,
      runnerPid,
    ]);
    expect([...trackedSessionsByKey.values()]).not.toContain(tracked);
  });

  it('reports incomplete when canonical cleanup retains the exact owner', async () => {
    const pid = 4_242;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid),
      pid,
      startedBy: 'daemon' as const,
      happySessionId: `PID-${pid}`,
    };
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      trackedSessionsByKey,
      onChildExited: vi.fn(async () => undefined),
    })).resolves.toEqual({
      status: 'incomplete',
      reason: 'exit_cleanup_incomplete',
    });
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toBe(tracked);
  });

  it.skipIf(process.platform === 'win32')('retains custody while the wrapper\'s process group is present but not signalable', async () => {
    // A group run by an isolated agent user answers EPERM: present, not gone.
    vi.mocked(probeProcessGroupLiveness).mockImplementation((groupId) => groupId === 4_242 ? 'access_denied' : 'absent');
    const tracked = { trackingKey: legacyPidSessionTrackingKey(4_243), pid: 4_243, startedBy: 'daemon' as const };
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const onChildExited = vi.fn(async () => undefined);

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      wrapperPid: 4_242,
      trackedSessionsByKey,
      onChildExited,
    })).resolves.toEqual({ status: 'incomplete', reason: 'process_still_running' });
    expect(onChildExited).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('retains custody without cleanup while the POSIX runner is still present', async () => {
    vi.mocked(isPidPresent).mockReturnValue(true);
    const tracked = { trackingKey: legacyPidSessionTrackingKey(4_242), pid: 4_242, startedBy: 'daemon' as const };
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const onChildExited = vi.fn(async () => undefined);

    await expect(completeStartupCancellationCleanup({
      trackedSession: tracked,
      trackedSessionsByKey,
      onChildExited,
    })).resolves.toEqual({ status: 'incomplete', reason: 'process_still_running' });
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toBe(tracked);
    expect(onChildExited).not.toHaveBeenCalled();
  });
});
