import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

import { handleDaemonCliCommand } from './daemon';

describe('happier daemon service list', () => {
  it('lists per-server installed unit paths on linux', async () => {
    const output = captureConsoleLogAndMuteStdout();

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-service-list-',
          env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          },
        },
        async ({ homeDir }) => {
          process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
          await writeDaemonSettingsFixture(homeDir);

          const unitDir = join(homeDir, '.config', 'systemd', 'user');
          mkdirSync(unitDir, { recursive: true });
          writeFileSync(join(unitDir, 'happier-daemon.company.service'), '# fake', 'utf-8');

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list'], rawArgv: [], terminalRuntime: null });

          const out = output.logs.join('\n');
          expect(out).toContain('company');
          expect(out).toContain('happier-daemon.company.service');
          expect(out.toLowerCase()).toContain('installed');
        },
      );
    } finally {
      output.restore();
    }
  });
});
