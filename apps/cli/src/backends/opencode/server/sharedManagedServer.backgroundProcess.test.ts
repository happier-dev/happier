import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));

import { stopSharedManagedOpenCodeServerFromState, type SharedManagedOpenCodeServerState } from './sharedManagedServer';

describe('managed OpenCode background identity probe', () => {
  it('hides the process-birth probe while preserving verified daemon shutdown', async () => {
    const command = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const birthTime = 'Fri Oct 30 12:00:00 2026';
    execFileSyncMock.mockReturnValue(`${birthTime}\n`);
    let retainedState: SharedManagedOpenCodeServerState | null = {
      v: 2,
      baseUrl: 'http://127.0.0.1:1234',
      pid: 111,
      startedAtMs: 1,
      daemonInstanceId: 'current-daemon',
      activeServerDir: '/current-server',
      ownerToken: 'exact-owner',
      expectedCmdlineHash: createHash('sha256').update(command).digest('hex'),
      startTimeMs: Date.parse(birthTime),
    };
    const killed: number[] = [];

    // These injected adapters represent filesystem, process inspection/signals and HTTP boundaries.
    await expect(stopSharedManagedOpenCodeServerFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => retainedState,
      removeState: async () => { retainedState = null; },
      isPidAlive: () => true,
      probeHealth: async () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: command }),
      killPid: (pid) => { killed.push(pid); return true; },
      currentDaemonInstanceId: 'current-daemon',
      currentActiveServerDir: '/current-server',
      readProcessInstanceFingerprint: async () => null,
    })).resolves.toEqual({ didKill: true });

    expect(retainedState).toBeNull();
    expect(killed).toEqual([111]);
    expect(execFileSyncMock).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '111'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    });
  });
});
