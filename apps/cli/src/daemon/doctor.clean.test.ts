import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const { psListMock, crossSpawnSyncMock } = vi.hoisted(() => ({
  psListMock: vi.fn(),
  crossSpawnSyncMock: vi.fn(),
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

vi.mock('cross-spawn', () => ({
  default: {
    sync: (...args: unknown[]) => crossSpawnSyncMock(...args),
  },
}));

describe.sequential('doctor clean process custody', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
    'HAPPIER_SERVER_URL',
  ]);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    psListMock.mockReset();
    crossSpawnSyncMock.mockReset();
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
      'HAPPIER_SERVER_URL',
    ]);
  });

  it('does not signal a discovered daemon PID after its exact lifecycle proof is no longer available', async () => {
    const homeDir = createTempDirSync('happier-doctor-clean-pid-reuse-');
    const daemonPid = 999_999_999;
    const realKill = process.kill.bind(process);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
    });
    // The command must be recognizable to `classifyHappyProcess` from any working
    // directory: deriving it from `process.cwd()` only classifies when the checkout
    // path happens to contain a recognized marker, so the fixture silently stopped
    // exercising the custody rule under other roots (repo root vs execution mirror).
    // `cli-dist-snapshot/src/index.ts` is the canonical source-snapshot daemon shape.
    psListMock.mockResolvedValue([{
      pid: daemonPid,
      name: 'node',
      cmd: `${process.execPath} /opt/happier-test/cli-dist-snapshot/src/index.ts daemon start-sync`,
    }]);

    try {
      vi.resetModules();
      const { configuration } = await import('@/configuration');
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: 1,
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'test-token',
      }), 'utf-8');
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, JSON.stringify({
        t: 'happier_daemon_lock_v1',
        pid: daemonPid,
        ownerToken: '00000000-0000-4000-8000-000000000001',
        processStartedAtMs: 1_000,
        createdAtMs: 1,
      }), 'utf-8');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw Object.assign(new Error(`reused daemon PID received ${String(signal)}`), { code: 'ESRCH' });
      }) as any);
      const { clearProcessSnapshotCacheForTests } = await import('./processSnapshotCache');
      clearProcessSnapshotCacheForTests();
      const { killRunawayHappyProcesses } = await import('./doctor');

      const result = await killRunawayHappyProcesses();

      expect(result.killed).toBe(0);
      expect(result.errors).toEqual([expect.objectContaining({ pid: daemonPid })]);
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
      expect(crossSpawnSyncMock).not.toHaveBeenCalled();
    } finally {
      removeTempDirSync(homeDir);
    }
  });
});
