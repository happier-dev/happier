import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { handleDaemonCliCommand } from './daemon';

describe('happier daemon install/uninstall', () => {
  it('aliases daemon install to daemon service install (supports --dry-run --json)', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HOME',
      'PATH',
    ]);

    await withTempDir('happier-daemon-install-alias-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HOME: tmp,
        PATH: join(tmp, 'bin'),
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; plan?: { files?: Array<{ path: string }> } }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'install', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.plan?.files?.[0]?.path).toContain('happier-daemon.default.service');
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });

  it('aliases daemon uninstall to daemon service uninstall (supports --dry-run --json)', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HOME',
      'PATH',
    ]);

    await withTempDir('happier-daemon-uninstall-alias-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HOME: tmp,
        PATH: join(tmp, 'bin'),
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; plan?: { filesToRemove?: string[] } }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'uninstall', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.plan?.filesToRemove?.some((p) => p.includes('happier-daemon.default.service'))).toBe(true);
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });
});
