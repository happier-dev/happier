import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';

import { spawn } from 'node:child_process';

import { createOnHappySessionWebhook } from './onHappySessionWebhook';

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

    const wrapperScript = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log(String(child.pid));
        setInterval(() => {}, 1000);
      `;

    const wrapper = spawn(process.execPath, ['-e', wrapperScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    const wrapperPid = wrapper.pid;
    if (typeof wrapperPid !== 'number') {
      throw new Error('wrapper did not expose a pid');
    }

    const childPid: number = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for child pid')), 2_000);
      wrapper.stdout?.once('data', (data) => {
        clearTimeout(timeout);
        const pid = Number.parseInt(String(data).trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) {
          reject(new Error(`invalid child pid output: ${String(data)}`));
          return;
        }
        resolve(pid);
      });
    });

    try {
      const pidToTrackedSession = new Map<number, TrackedSession>([
        [wrapperPid, { startedBy: 'daemon', pid: wrapperPid }],
      ]);
      const awaiter = vi.fn();
      const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[wrapperPid, awaiter]]);

      const onWebhook = createOnHappySessionWebhook({
        pidToTrackedSession,
        pidToAwaiter,
        findHappyProcessByPidFn: async () => null,
        writeSessionMarkerFn: async () => {},
      });

      onWebhook('session-child-1', createMetadata(childPid, 'daemon'));

      expect(awaiter).toHaveBeenCalledTimes(1);
      expect(pidToAwaiter.has(wrapperPid)).toBe(false);
      expect(pidToTrackedSession.get(wrapperPid)?.happySessionId).toBe('session-child-1');
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
      try {
        process.kill(wrapperPid, 'SIGKILL');
      } catch {}
    }
  });
});
