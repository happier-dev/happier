import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';

import { createOnHappySessionWebhook } from './onHappySessionWebhook';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

function createMetadata(pid: number, startedBy: 'daemon' | 'terminal'): Metadata {
  return {
    path: '/tmp',
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy,
    machineId: 'machine-test',
  };
}

describe('createOnHappySessionWebhook (PPID correlation)', () => {
  it('correlates an unknown webhook PID to a daemon-tracked wrapper PID via PPID', { timeout: 15_000 }, async () => {
    if (process.platform === 'win32') {
      // Windows path intentionally skips PPID matching.
      return;
    }

    const { parent: wrapper, childPid } = await spawnInlineNodeParentWithChild();
    const wrapperPid = wrapper.pid;
    if (typeof wrapperPid !== 'number') {
      throw new Error('wrapper did not expose a pid');
    }

    try {
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
        [legacyPidSessionTrackingKey(wrapperPid), { trackingKey: legacyPidSessionTrackingKey(wrapperPid), startedBy: 'daemon', pid: wrapperPid }],
      ]);
      const awaiter = vi.fn();
      const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(wrapperPid), awaiter]]);

      const onWebhook = createOnHappySessionWebhook({
        trackedSessionsByKey,
        spawnAwaiterByKey,
        findHappyProcessByPidFn: async () => null,
        writeSessionMarkerFn: async () => {},
      });

      await onWebhook('session-child-1', createMetadata(childPid, 'daemon'));

      expect(awaiter).toHaveBeenCalledTimes(1);
      expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(wrapperPid))).toBe(false);
      expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(wrapperPid))?.happySessionId).toBe('session-child-1');
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
      try {
        process.kill(wrapperPid, 'SIGKILL');
      } catch {}
      await waitForProcessExit(childPid, { timeoutMs: 2_000 });
      await waitForProcessExit(wrapperPid, { timeoutMs: 2_000 });
    }
  });
});
