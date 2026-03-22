import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStderr, captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const SCOPED_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_HOME_DIR',
  'PATH',
] as const;

async function loadCliModule(): Promise<typeof import('./cli.js')> {
  return import('./cli.js');
}

describe('runDaemonServiceCliCommand', () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(SCOPED_ENV_KEYS);
    vi.restoreAllMocks();
    vi.unmock('node:child_process');
    vi.unmock('node:os');
    vi.resetModules();
  });

  it('treats -h as help (not as a subcommand)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      await runDaemonServiceCliCommand({ argv: ['-h'] });

      expect(stdout.text()).toContain('Usage:');
      expect(stderr.text()).not.toContain('Unknown daemon service subcommand');
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  it('supports help JSON output', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      commands: string[];
      flags: string[];
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['--help', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.commands).toContain('install');
      expect(payload.flags).toContain('--json');
    } finally {
      output.restore();
    }
  });

  it('treats --mode system as a flag (not as a subcommand) and reports systemd system paths (linux)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      platform: string;
      paths: { unitPath?: string; unitName?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.platform).toBe('linux');
      expect(payload.paths.unitPath).toContain('/etc/systemd/system/');
      expect(payload.paths.unitName).toContain('happier-daemon.');
    } finally {
      output.restore();
    }
  });

  it('rejects invalid --mode values', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--mode', 'systm'] })).rejects.toThrow(
      'Invalid --mode value "systm" (expected user|system)',
    );
  });

  it('uses the target linux system user home for system install planning and log paths', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          pid: 1,
          output: ['', 'happier:x:1001:1001::/home/happier:/bin/bash\n', ''],
          stdout: 'happier:x:1001:1001::/home/happier:/bin/bash\n',
          stderr: '',
          status: 0,
          signal: null,
        })),
      };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/root'),
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const processWithGetuid = process as typeof process & { getuid: () => number };
    vi.spyOn(processWithGetuid, 'getuid').mockReturnValue(0);
    const installOutput = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.company.service');
      expect(installPayload.plan.files[0]?.content).toContain('User=happier');
      expect(installPayload.plan.files[0]?.content).toContain('WorkingDirectory=/home/happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_HOME_DIR=/home/happier/.happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=PATH=');
      expect(installPayload.plan.files[0]?.content).toContain('/home/happier/.local/bin');
      expect(installPayload.plan.files[0]?.content).toContain('/home/happier/bin');
      expect(installPayload.plan.files[0]?.content).not.toContain('/root/.local/bin');
      expect(installPayload.plan.files[0]?.content).not.toContain('/root/.happier');
    } finally {
      installOutput.restore();
    }

    const pathsOutput = captureStdoutJsonOutput<{
      ok: boolean;
      paths: { stdoutPath?: string; stderrPath?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const pathsPayload = pathsOutput.json();
      expect(pathsPayload.ok).toBe(true);
      expect(pathsPayload.paths.stdoutPath).toBe('/home/happier/.happier/logs/daemon-service.company.out.log');
      expect(pathsPayload.paths.stderrPath).toBe('/home/happier/.happier/logs/daemon-service.company.err.log');
    } finally {
      pathsOutput.restore();
    }
  });
});
