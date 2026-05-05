import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
  installDaemonServiceMock,
  resolveDaemonServiceInstallRuntimeTargetMock,
  inspectDaemonRunningStateMock,
} = vi.hoisted(() => ({
  installDaemonServiceMock: vi.fn(async () => undefined),
  resolveDaemonServiceInstallRuntimeTargetMock: vi.fn(async () => ({
    nodePath: '/managed/node',
    entryPath: '/opt/happier/package-dist/index.mjs',
  })),
  inspectDaemonRunningStateMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' as const })),
}));

vi.mock('./installer', () => ({
  installDaemonService: installDaemonServiceMock,
  uninstallDaemonService: vi.fn(async () => undefined),
}));

vi.mock('./resolveDaemonServiceInstallRuntimeTarget', () => ({
  resolveDaemonServiceInstallRuntimeTarget: resolveDaemonServiceInstallRuntimeTargetMock,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') })),
  };
});

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonRunningStateMock,
  };
});

describe('runDaemonServiceCliCommand install conflict preflight', () => {
  const envKeys = [
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    'HAPPIER_DAEMON_SERVICE_CHANNEL',
    'HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY',
    'HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS',
    'HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS',
    'HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.clearAllMocks();
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock.mockImplementation(async () => ({ status: 'not-running' }));
    vi.resetModules();
  });

  it('fails closed by default when another verified background service is already installed', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '10',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '1',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '0',
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; error?: string; message?: string }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      installDaemonServiceMock.mockRejectedValueOnce(Object.assign(
        new Error('Competing background services detected: happier-daemon.default. Re-run with --yes or --replace-existing=ring|all.'),
        {
          code: 'daemon_service_conflict',
          conflicts: [{ label: 'happier-daemon.default' }],
        },
      ));

      await runDaemonServiceCliCommand({ argv: ['install', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: false,
        error: 'daemon_service_conflict',
        message: expect.stringContaining('--replace-existing=ring|all'),
      }));
      expect(resolveDaemonServiceInstallRuntimeTargetMock).toHaveBeenCalledWith(expect.objectContaining({
        targetMode: 'default-following',
      }));
      expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
        strategy: undefined,
      }));
    } finally {
      output.restore();
    }
  });

  it('allows explicit add semantics when --yes is provided', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '10',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '1',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '0',
    });

    const { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths, runDaemonServiceCliCommand } = await import('./cli.js');
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
    const paths = resolveDaemonServicePaths(runtime);
    inspectDaemonRunningStateMock.mockResolvedValue({
      status: 'running',
      state: {
        pid: process.pid,
        httpPort: 43122,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'dev',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      },
    });
    await expect(runDaemonServiceCliCommand({ argv: ['install', '--yes', '--json'] })).rejects.toThrow(/did not become the active daemon/i);
    expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'add',
    }));
  });

  it('passes replace-all to the installer when explicitly requested', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '10',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '1',
      HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '0',
    });

    const { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths, runDaemonServiceCliCommand } = await import('./cli.js');
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
    const paths = resolveDaemonServicePaths(runtime);
    inspectDaemonRunningStateMock.mockResolvedValue({
      status: 'running',
      state: {
        pid: process.pid,
        httpPort: 43122,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'dev',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      },
    });
    await expect(runDaemonServiceCliCommand({ argv: ['install', '--replace-existing=all', '--yes', '--json'] })).rejects.toThrow(/did not become the active daemon/i);
    expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'replace-all',
    }));
  });
});
