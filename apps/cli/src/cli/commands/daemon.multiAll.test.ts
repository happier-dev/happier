import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { waitForHttpReady, reserveEphemeralPort } from '@/testkit/http/portUtils';
import { waitForProcessExit } from '@/testkit/process/spawn';
import {
  spawnStoppableHttpDaemon,
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
  writeDaemonStateFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

import { handleDaemonCliCommand } from './daemon';

describe('happier daemon --all', () => {
  it('stops daemons for all saved servers', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as any);

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-all-',
          env: {
            HAPPIER_DAEMON_HTTP_TIMEOUT: '750',
          },
        },
        async ({ homeDir }) => {
          await writeDaemonSettingsFixture(homeDir);

          const port = await reserveEphemeralPort();
          const daemon = spawnStoppableHttpDaemon(port);
          expect(await waitForHttpReady(port, { timeoutMs: 2_000 })).toBe(true);

          const statePath = await writeDaemonStateFixture(homeDir, 'company', {
            pid: daemon.pid,
            httpPort: port,
          });
          expect(existsSync(statePath)).toBe(true);

          try {
            await expect(
              handleDaemonCliCommand({ args: ['daemon', 'stop', '--all'], rawArgv: [], terminalRuntime: null }),
            ).rejects.toThrow('process.exit(0)');

            expect(await waitForProcessExit(daemon.pid, { timeoutMs: 3_000 })).toBe(true);
            expect(existsSync(statePath)).toBe(false);
          } finally {
            await daemon.kill();
          }
        },
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});
