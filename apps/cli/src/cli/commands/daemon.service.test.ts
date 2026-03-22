import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { handleDaemonCliCommand } from './daemon';

describe('happier daemon service', () => {
  it('supports -h as help flag', async () => {
    const stdout = captureStdout();
    try {
      await handleDaemonCliCommand({
        args: ['daemon', 'service', '-h'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(stdout.text()).toContain('happier daemon service');
      expect(stdout.text()).toContain('Usage:');
      expect(stdout.text()).toContain('happier daemon service status [--json]');
    } finally {
      stdout.restore();
    }
  });

  it('prints resolved service paths as JSON', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    ]);

    await withTempDir('happier-daemon-service-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; paths?: { unitPath?: string } }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'service', 'paths', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.paths?.unitPath).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.cloud.service'));
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });

  it('prints an install plan in --dry-run --json without writing files', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    ]);

    await withTempDir('happier-daemon-service-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      });

      const unitPath = join(tmp, '.config', 'systemd', 'user', 'happier-daemon.cloud.service');

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { files?: Array<{ path: string }>; commands?: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'service', 'install', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.plan?.files?.[0]?.path).toBe(unitPath);
        expect(parsed.plan?.commands?.some((c) => c.cmd === 'systemctl')).toBe(true);

        // Dry-run: do not write to disk
        const { existsSync } = await import('node:fs');
        expect(existsSync(unitPath)).toBe(false);
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });
});
