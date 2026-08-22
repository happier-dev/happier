import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    spawnSleepyDetachedProcess,
    withConfiguredDaemonTestHome,
    writeDaemonSettingsFixture,
    writeDaemonStateFixture,
} from './testkit/fakeDaemonLifecycle.testkit';
import {
  CANONICAL_DAEMON_STATE_BASENAME,
  resolveLegacyDaemonStateBasenames,
} from './ownership/daemonOwnershipPaths';
import { stopAllDaemonsBestEffort } from './multiDaemon';

describe.sequential('stopAllDaemonsBestEffort completion', () => {
  it('reports a typed incomplete stop when an acknowledged daemon remains alive', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-stop-incomplete-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const sleepy = spawnSleepyDetachedProcess();
      await writeDaemonStateFixture(homeDir, 'company', {
        pid: sleepy.pid,
        httpPort: 43210,
        controlToken: 'test-token',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response);

      try {
        await expect(stopAllDaemonsBestEffort()).rejects.toMatchObject({
          code: 'daemon_stop_incomplete',
          reason: 'graceful_stop_unconfirmed',
          pid: sleepy.pid,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
        await sleepy.kill();
      }
    });
  }, 10_000);

  it('stops every canonical and legacy state under a removed server profile before logout can remove its home', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-removed-profile-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const canonical = spawnSleepyDetachedProcess();
      const legacy = spawnSleepyDetachedProcess();
      const serverDir = join(homeDir, 'servers', 'removed-profile');
      const legacyBasename = resolveLegacyDaemonStateBasenames()[0];
      if (!legacyBasename) throw new Error('expected a supported legacy daemon state basename');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, CANONICAL_DAEMON_STATE_BASENAME), JSON.stringify({
        pid: canonical.pid,
        httpPort: 43211,
        startedAt: 1,
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'canonical-token',
      }), 'utf-8');
      writeFileSync(join(serverDir, legacyBasename), JSON.stringify({
        pid: legacy.pid,
        httpPort: 43212,
        startedAt: 2,
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'legacy-token',
      }), 'utf-8');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        if (url.port === '43211') {
          process.kill(canonical.pid, 'SIGTERM');
        } else if (url.port === '43212') {
          process.kill(legacy.pid, 'SIGTERM');
        } else {
          throw new Error(`unexpected daemon stop target: ${url}`);
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      });

      try {
        await stopAllDaemonsBestEffort();

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).port).sort()).toEqual(['43211', '43212']);
      } finally {
        fetchSpy.mockRestore();
        await canonical.kill();
        await legacy.kill();
      }
    });
  }, 10_000);
});
