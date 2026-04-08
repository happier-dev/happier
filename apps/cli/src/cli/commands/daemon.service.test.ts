import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { commandRegistry } from '@/cli/commandRegistry';
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

      expect(stdout.text()).toContain('happier service');
      expect(stdout.text()).toContain('Usage:');
      expect(stdout.text()).toContain('happier service status [--json]');
    } finally {
      stdout.restore();
    }
  });

  it('supports the top-level service command namespace', async () => {
    const stdout = captureStdout();
    try {
      await commandRegistry.service({
        args: ['service', '-h'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(stdout.text()).toContain('happier service');
      expect(stdout.text()).toContain('Usage:');
      expect(stdout.text()).toContain('happier service status [--json]');
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
      'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ]);

    await withTempDir('happier-daemon-service-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; targetMode?: string; paths?: { unitPath?: string } }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'service', 'paths', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.targetMode).toBe('default-following');
        expect(parsed.paths?.unitPath).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.default.service'));
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });

  it('prints pinned service paths when an explicit ring and instance are provided', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ]);

    await withTempDir('happier-daemon-service-pinned-paths-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; targetMode?: string; paths?: { unitPath?: string } }>();
      try {
        await commandRegistry.service({
          args: ['service', 'paths', '--ring', 'preview', '--instance', 'company', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.targetMode).toBe('pinned');
        expect(parsed.paths?.unitPath).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.preview.company.service'));
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });

  it('prints default-following service paths when the target mode env is set', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ]);

    await withTempDir('happier-daemon-service-default-target-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; targetMode?: string; paths?: { unitPath?: string } }>();
      try {
        await commandRegistry.service({
          args: ['service', 'paths', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.targetMode).toBe('default-following');
        expect(parsed.paths?.unitPath).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.default.service'));
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

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { files?: Array<{ path: string; content?: string }>; commands?: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'service', 'install', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.plan?.files?.[0]?.path).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.default.service'));
        expect(parsed.plan?.files?.[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following');
        expect(parsed.plan?.files?.[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=');
        expect(parsed.plan?.commands?.some((c) => c.cmd === 'systemctl')).toBe(true);

        // Dry-run: do not write to disk
        const { existsSync } = await import('node:fs');
        expect(existsSync(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.default.service'))).toBe(false);
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });

  it('prints a default-following install plan in --dry-run --json when the target mode env is set', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ]);

    await withTempDir('happier-daemon-service-default-install-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { files?: Array<{ path: string; content: string }> };
      }>();
      try {
        await commandRegistry.service({
          args: ['service', 'install', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.plan?.files?.[0]?.path).toBe(join(tmp, '.config', 'systemd', 'user', 'happier-daemon.default.service'));
        expect(parsed.plan?.files?.[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following');
        expect(parsed.plan?.files?.[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=');
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });
});
