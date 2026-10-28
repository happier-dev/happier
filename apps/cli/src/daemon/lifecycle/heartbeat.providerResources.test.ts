import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { configuration } from '@/configuration';
import { prepareIsolatedDaemonTestHome } from '@/daemon/testkit/realIntegration.testkit';
import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { getOpenCodeServerProcessInfoBestEffort } from '@/backends/opencode/server/openCodeServerProcessState';
import {
  resolveSharedManagedOpenCodeServerStatePathForEnv,
  type SharedManagedOpenCodeServerState,
} from '@/backends/opencode/server/sharedManagedServer';

import { startDaemonHeartbeatLoop } from './heartbeat';

afterEach(() => vi.restoreAllMocks());

describe('daemon heartbeat provider resource reconciliation', () => {
  it('reclaims an unused owned OpenCode server without another acquisition', async () => {
    const home = await prepareIsolatedDaemonTestHome({ prefix: 'happier-heartbeat-opencode-pool-' });
    const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)');
    const pid = child.pid;
    if (!pid) throw new Error('Test server did not spawn');
    let heartbeatTick: (() => Promise<void>) | undefined;
    const timer = setTimeout(() => {}, 1 << 30);
    vi.spyOn(global, 'setInterval').mockImplementation((handler) => {
      heartbeatTick = handler as () => Promise<void>;
      return timer;
    });
    try {
      const info = await getOpenCodeServerProcessInfoBestEffort(pid);
      const birth = readProcessInstanceFingerprintSync(pid);
      if (!info?.cmd || !birth) throw new Error('Test server identity unavailable');
      const statePath = resolveSharedManagedOpenCodeServerStatePathForEnv(process.env);
      const state: SharedManagedOpenCodeServerState = {
        v: 2,
        baseUrl: 'http://127.0.0.1:43111',
        pid,
        startedAtMs: Date.now(),
        status: 'ready',
        launchEnvFingerprint: basename(statePath, '.json'),
        ownerToken: 'heartbeat-test-owned-server',
        processInstanceFingerprint: birth,
        expectedCmdlineHash: createHash('sha256').update(info.cmd).digest('hex'),
        activeServerDir: configuration.activeServerDir,
        daemonInstanceId: 'predecessor-daemon',
      };
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify(state));
      const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
      startDaemonHeartbeatLoop({
        pidToTrackedSession: new Map(),
        spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(),
        getApiMachineForSessions: () => null,
        controlPort: 43112,
        fileState: {
          pid: process.pid,
          httpPort: 43112,
          startedAt: Date.now(),
          startedWithCliVersion: packageJson.version,
          daemonLogPath: join(configuration.happyHomeDir, 'test-daemon.log'),
        },
        currentCliVersion: packageJson.version,
        requestShutdown: () => {},
      });
      if (!heartbeatTick) throw new Error('Heartbeat timer did not register');

      await heartbeatTick();

      expect(await waitForProcessExit(pid, { timeoutMs: 1_000 })).toBe(true);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      clearTimeout(timer);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForProcessExit(pid, { timeoutMs: 1_000 });
      await home.restore();
    }
  });
});
