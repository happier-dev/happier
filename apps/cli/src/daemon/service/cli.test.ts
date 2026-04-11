import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildLaunchdPlistXml, renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStderr, captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { planDaemonServiceInstall } from './plan';

const stopDaemonMock = vi.fn(async () => undefined);
const restartDaemonAndWaitMock = vi.fn(async () => true);

const SCOPED_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_DAEMON_SERVICE_UID',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  'HAPPIER_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS',
  'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
  'HAPPIER_DAEMON_START_WAIT_POLL_MS',
  'SUDO_USER',
  'PATH',
] as const;

function writeValidInstalledDaemonServiceFile(installedPath: string): void {
  writeFileSync(
    installedPath,
    renderSystemdServiceUnit({
      description: 'Happier Daemon',
      execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
      env: {
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      },
      wantedBy: 'default.target',
    }),
    'utf-8',
  );
}

async function loadCliModule(): Promise<typeof import('./cli.js')> {
  return import('./cli.js');
}

describe('runDaemonServiceCliCommand', () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(SCOPED_ENV_KEYS);
    stopDaemonMock.mockReset();
    restartDaemonAndWaitMock.mockReset();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./commandExistsInPath');
    vi.doUnmock('./resolveLinuxSystemUserPaths');
    vi.doUnmock('@/daemon/restartDaemonAndWait');
    vi.unmock('node:child_process');
    vi.unmock('./commandExistsInPath');
    vi.unmock('./resolveLinuxSystemUserPaths');
    vi.unmock('@/daemon/restartDaemonAndWait');
    vi.unmock('node:os');
    vi.resetModules();
  });

  it('restores the manual relay runtime when service restart takeover fails to run the service command', async () => {
    await withTempDir('happier-service-restart-takeover-failure-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn(() => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('systemctl restart failed') })),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] =
        await Promise.all([
          loadCliModule(),
          import('@/persistence'),
        ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43118,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-1',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['restart', '--takeover'] })).rejects.toThrow(/restart/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('restores the manual relay runtime when service install takeover fails to load the service', async () => {
    await withTempDir('happier-service-install-takeover-failure-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn(() => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('systemctl enable failed') })),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43121,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-1',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['install', '--takeover'] })).rejects.toThrow(/install/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('prefers the invoking sudo user home for user-scoped service operations run as root', async () => {
    await withTempDir('happier-service-cli-sudo-user-home-', async (homeDir) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_MODE: 'user',
        HAPPIER_DAEMON_SERVICE_UID: '0',
        SUDO_USER: 'sudo-user',
        HAPPIER_HOME_DIR: `${homeDir}/.happier`,
      } as NodeJS.ProcessEnv);

      vi.resetModules();
      vi.doMock('node:os', () => ({
        homedir: () => '/root',
      }));
      vi.doMock('./resolveLinuxSystemUserPaths', () => ({
        resolveLinuxSystemUserPaths: vi.fn(() => ({
          userHomeDir: '/home/sudo-user',
          happierHomeDir: '/home/sudo-user/.happier',
        })),
      }));

      const { resolveDaemonServiceCliRuntimeFromEnv } = await loadCliModule();
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({
        mode: 'user',
      });

      expect(runtime.userHomeDir).toBe('/home/sudo-user');
    });
  });

  it('restores the manual relay runtime when service install takeover never reaches a healthy loaded service state', async () => {
    await withTempDir('happier-service-install-takeover-postcondition-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'systemctl' && args.includes('is-active')) {
            return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
          }
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43124,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-install-postcondition',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['install', '--takeover'] })).rejects.toThrow(/service state/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('restores the manual relay runtime when service install takeover only reaches a different background service label', async () => {
    await withTempDir('happier-service-install-takeover-other-label-', async (homeDir) => {
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'systemctl' && args.includes('is-active')) {
            return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
          }
          writeDaemonStateImpl?.({
            pid: process.pid,
            httpPort: 43125,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-service',
            startupSource: 'background-service',
            serviceLabel: 'different-service-label',
          });
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      resolveDaemonServicePaths(runtime);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43126,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-install-other-label',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['install', '--takeover'] })).rejects.toThrow(/Failed to install|take ownership/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('restores the manual relay runtime when service install takeover only reaches the same label through a different installed service target', async () => {
    await withTempDir('happier-service-install-takeover-wrong-target-', async (homeDir) => {
      let expectedServiceLabel = '';
      let installedPath = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'launchctl' && args.includes('print')) {
            return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
          }
          writeFileSync(
            installedPath,
            buildLaunchdPlistXml({
              label: expectedServiceLabel,
              programArgs: ['/Users/other/.happier/cli/current/happier', 'daemon', 'start-sync'],
              env: {
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
              },
              workingDirectory: '/tmp',
              stdoutPath: `${homeDir}/other.out.log`,
              stderrPath: `${homeDir}/other.err.log`,
            }),
            'utf-8',
          );
          writeDaemonStateImpl?.({
            pid: process.pid,
            httpPort: 43131,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-service',
            startupSource: 'background-service',
            serviceLabel: expectedServiceLabel,
          });
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
      installedPath = paths.installedPath;
      mkdirSync(dirname(installedPath), { recursive: true });

      writeDaemonState({
        pid: process.pid,
        httpPort: 43132,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-install-wrong-target',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['install', '--takeover'] })).rejects.toThrow(/take ownership/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('allows service install takeover when service ownership appears after the generic daemon start wait budget', async () => {
    await withTempDir('happier-service-install-takeover-delayed-owner-', async (homeDir) => {
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let ownerWritten = false;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '500',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'systemctl' && args.includes('is-active')) {
            return ownerWritten
              ? { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') }
              : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
          }
          setTimeout(() => {
            writeDaemonStateImpl?.({
              pid: process.pid,
              httpPort: 43127,
              startedAt: Date.now(),
              startedWithCliVersion: '0.0.0-service',
              startupSource: 'background-service',
              serviceLabel: expectedServiceLabel,
            });
            ownerWritten = true;
          }, 120);
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43128,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-install-delayed-owner',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        warning?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--json', '--yes', '--takeover'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
        expect(restartDaemonAndWaitMock).not.toHaveBeenCalled();
      } finally {
        output.restore();
      }
    });
  });

  it('starts an already installed darwin service when install takeover replaces a manual relay owner', async () => {
    await withTempDir('happier-service-install-takeover-existing-darwin-', async (homeDir) => {
      let expectedServiceLabel = '';
      let installedPath = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let ownerWritten = false;
      const launchctlCalls: string[] = [];
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '180',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'launchctl') {
            launchctlCalls.push(args.join(' '));
            if (String(args[0] ?? '') === 'print') {
              return ownerWritten
                ? { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') }
                : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('service not running') };
            }
            if (String(args[0] ?? '') === 'bootstrap' || String(args[0] ?? '') === 'kickstart') {
              ownerWritten = true;
              writeDaemonStateImpl?.({
                pid: process.pid,
                httpPort: 43134,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-service',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'background-service',
                serviceLabel: expectedServiceLabel,
                runtimeId: 'runtime-existing-darwin-service',
              });
            }
          }
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { resolveDaemonServiceInstallRuntimeTarget }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('./resolveDaemonServiceInstallRuntimeTarget'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
        currentExecPath: process.execPath,
        explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
        explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
        targetMode: runtime.targetMode,
        processEnv: process.env,
      });
      expectedServiceLabel = paths.label;
      installedPath = paths.installedPath;
      mkdirSync(dirname(installedPath), { recursive: true });
      const expectedInstallPlan = planDaemonServiceInstall({
        platform: runtime.platform,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
        instanceId: runtime.instanceId,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: installRuntimeTarget.nodePath,
        entryPath: installRuntimeTarget.entryPath,
      });
      writeFileSync(installedPath, expectedInstallPlan.files[0]?.content ?? '', 'utf-8');
      writeDaemonStateImpl = writeDaemonState;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43135,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'manual',
        runtimeId: 'runtime-existing-darwin-manual-owner',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--json', '--yes', '--takeover'] });
        expect(output.json()).toEqual(expect.objectContaining({ ok: true, platform: 'darwin' }));
      } finally {
        output.restore();
      }

      expect(launchctlCalls.some((call) => call.startsWith('bootstrap '))).toBe(true);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).not.toHaveBeenCalled();
    });
  });

  it('allows service install takeover for a non-cloud default-following service without legacy cloud cleanup', async () => {
    await withTempDir('happier-service-install-takeover-non-cloud-', async (homeDir) => {
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let ownerWritten = false;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '500',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'systemctl' && args.includes('disable') && args.includes('happier-daemon.service')) {
            return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('legacy cleanup should not run') };
          }
          if (command === 'systemctl' && args.includes('is-active')) {
            return ownerWritten
              ? { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') }
              : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
          }
          setTimeout(() => {
            writeDaemonStateImpl?.({
              pid: process.pid,
              httpPort: 43132,
              startedAt: Date.now(),
              startedWithCliVersion: '0.0.0-service',
              startupSource: 'background-service',
              serviceLabel: expectedServiceLabel,
              runtimeId: 'runtime-install-non-cloud',
            });
            ownerWritten = true;
          }, 120);
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43133,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-install-non-cloud-manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--json', '--yes', '--takeover'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
        expect(restartDaemonAndWaitMock).not.toHaveBeenCalled();
      } finally {
        output.restore();
      }
    });
  });

  it('treats an active wait-for-auth background service as a successful install when the current relay has no credentials', async () => {
    await withTempDir('happier-service-install-wait-for-auth-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'systemctl' && args.includes('disable') && args.includes('happier-daemon.service')) {
              return {
                status: 1,
                stdout: Buffer.from(''),
                stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.service does not exist.'),
              };
            }
            if (command === 'systemctl' && args.includes('is-active')) {
              return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand }, { clearDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      clearDaemonState();

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--json', '--yes'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('linux');
      } finally {
        output.restore();
      }
    });
  });

  it('restores the manual relay runtime when service install takeover only observes a transient healthy owner', async () => {
    await withTempDir('happier-service-install-takeover-transient-owner-', async (homeDir) => {
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let clearDaemonStateImpl: (() => void) | null = null;
      let healthChecks = 0;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '40',
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'systemctl' && args.includes('is-active')) {
            healthChecks += 1;
            if (healthChecks === 1) {
              clearDaemonStateImpl?.();
              return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
            }
            return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
          }
          writeDaemonStateImpl?.({
            pid: process.pid,
            httpPort: 43129,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-service',
            startupSource: 'background-service',
            serviceLabel: expectedServiceLabel,
          });
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState, clearDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      writeDaemonStateImpl = writeDaemonState;
      clearDaemonStateImpl = clearDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43130,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
        runtimeId: 'runtime-install-transient-owner',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['install', '--takeover'] })).rejects.toThrow(/service did not take ownership/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('restarts an already-active linux background service so the current Happier home takes ownership', async () => {
    await withTempDir('happier-service-install-linux-restart-active-unit-', async (homeDir) => {
      let expectedServiceLabel = '';
      let installedPath = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let restartObserved = false;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'systemctl' && args.includes('is-active')) {
              return {
                status: restartObserved ? 0 : 1,
                stdout: Buffer.from(restartObserved ? 'active' : 'inactive'),
                stderr: Buffer.from(''),
              };
            }
            if (command === 'systemctl' && args.includes('restart')) {
              restartObserved = true;
              writeDaemonStateImpl?.({
                pid: process.pid,
                httpPort: 43133,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-service',
                startupSource: 'background-service',
                serviceLabel: expectedServiceLabel,
              });
              return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
            }
            writeFileSync(
              installedPath,
              renderSystemdServiceUnit({
                description: 'Happier Daemon',
                execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                env: {
                  HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                  HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                  HAPPIER_DAEMON_SERVICE_LABEL: expectedServiceLabel,
                  HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                },
                wantedBy: 'default.target',
              }),
              'utf-8',
            );
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
      installedPath = paths.installedPath;
      mkdirSync(dirname(installedPath), { recursive: true });

      await expect(runDaemonServiceCliCommand({ argv: ['install', '--yes'] })).resolves.toBeUndefined();
      expect(restartObserved).toBe(true);
    });
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

  it('resolves the daemon service user home from the real OS user even when HOME is stack-isolated', async () => {
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        userInfo: vi.fn(() => ({ homedir: '/real-user-home' })),
        homedir: vi.fn(() => '/isolated-stack-home'),
      };
    });

    const { resolveDaemonServiceCliRuntimeFromEnv } = await loadCliModule();
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HOME: '/isolated-stack-home',
        USERPROFILE: '/isolated-stack-home',
      },
    });

    expect(runtime.userHomeDir).toBe('/real-user-home');
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
      targetMode?: string;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.targetMode).toBeUndefined();
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.default.service');
      expect(installPayload.plan.files[0]?.content).toContain('User=happier');
      expect(installPayload.plan.files[0]?.content).toContain('WorkingDirectory=/home/happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_HOME_DIR=/home/happier/.happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following');
      expect(installPayload.plan.files[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=');
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
      targetMode?: string;
      paths: { stdoutPath?: string; stderrPath?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const pathsPayload = pathsOutput.json();
      expect(pathsPayload.ok).toBe(true);
      expect(pathsPayload.targetMode).toBe('default-following');
      expect(pathsPayload.paths.stdoutPath).toBe('/home/happier/.happier/logs/daemon-service.default.out.log');
      expect(pathsPayload.paths.stderrPath).toBe('/home/happier/.happier/logs/daemon-service.default.err.log');
    } finally {
      pathsOutput.restore();
    }
  });

  it('scopes systemd unit names by release channel so dev services can coexist with stable', async () => {
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
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'dev',
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
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier', '--ring', 'dev', '--instance', 'company'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.dev.company.service');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=dev');
    } finally {
      installOutput.restore();
    }
  });

  it('reports daemon service status as not installed when the service file is absent', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      installed: boolean;
      daemon?: { running: boolean };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.installed).toBe(false);
      expect(payload.daemon?.running).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('reports daemon service status as not installed when the installed file is invalid', async () => {
    await withTempDir('happier-service-status-invalid-installed-file-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const { runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } = await loadCliModule();
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        installed: boolean;
        daemon?: { running: boolean };
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.installed).toBe(false);
        expect(payload.daemon?.running).toBe(false);
      } finally {
        output.restore();
      }
    });
  });

  it('reports the current relay owner and invocation mismatch in service status JSON', async () => {
    await withTempDir('happier-service-status-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3005,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-1',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        owner?: {
          serviceManaged?: boolean;
          startupSource?: string | null;
          serviceLabel?: string | null;
          startedWithCliVersion?: string | null;
          startedWithPublicReleaseChannel?: string | null;
          currentInvocationMatches?: boolean;
        } | null;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.owner).toEqual(expect.objectContaining({
          serviceManaged: true,
          startupSource: 'background-service',
          serviceLabel: paths.label,
          startedWithCliVersion: '0.0.0-other',
          startedWithPublicReleaseChannel: 'preview',
          currentInvocationMatches: false,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('includes a services inventory field in service status JSON', async () => {
    await withTempDir('happier-service-status-inventory-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonSettingsFixture(homeDir, {
        servers: {
          cloud: {
            id: 'cloud',
            name: 'Cloud',
            serverUrl: 'https://cloud.example.test',
            webappUrl: 'https://cloud.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      });

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3007,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-inventory',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        services?: Array<{
          label?: string;
          ring?: string;
          targetMode?: string;
          installed?: boolean;
          instanceId?: string | null;
        }>;
        owner?: {
          serviceManaged?: boolean;
          startupSource?: string | null;
          serviceLabel?: string | null;
        } | null;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(Array.isArray(payload.services)).toBe(true);
        expect(payload.owner).toEqual(expect.objectContaining({
          serviceManaged: true,
          startupSource: 'background-service',
          serviceLabel: paths.label,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('keeps the relay owner source unknown in service status JSON for legacy daemon state', async () => {
    await withTempDir('happier-service-status-owner-legacy-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(paths.installedPath, '[Unit]\nDescription=Happier\n');

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3006,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-legacy',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        owner?: {
          serviceManaged?: boolean | null;
          startupSource?: string | null;
          currentInvocationMatches?: boolean | null;
        } | null;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.owner).toEqual(expect.objectContaining({
          serviceManaged: null,
          startupSource: null,
          currentInvocationMatches: false,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('fails closed when installing a background service while a manual relay runtime already owns the relay', async () => {
    await withTempDir('happier-service-install-owner-conflict-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3005,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-1',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('owner_conflict');
        expect(payload.message).toContain('manual relay runtime');
      } finally {
        output.restore();
      }
    });
  });

  it('allows planning a background-service install takeover for a manual relay runtime with --takeover', async () => {
    await withTempDir('happier-service-install-owner-takeover-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3006,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-2',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { files: Array<{ path: string }> };
        takeover?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json', '--takeover'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.plan?.files.length).toBeGreaterThan(0);
        expect(payload.takeover).toContain('Taking over the current manual relay runtime');
      } finally {
        output.restore();
      }
    });
  });

  it('fails closed without misclassifying a legacy relay owner as manual during service install', async () => {
    await withTempDir('happier-service-install-owner-legacy-conflict-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3007,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-legacy',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('owner_conflict');
        expect(payload.message).toContain('could not be determined safely');
        expect(payload.message).not.toContain('manual relay runtime');
      } finally {
        output.restore();
      }
    });
  });

  it('fails closed when starting a daemon service that is not installed', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      error: string;
      message: string;
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['start', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('not_installed');
      expect(payload.message).toContain('Background service is not installed');
    } finally {
      output.restore();
    }
  });

  it('fails closed when starting a daemon service with an invalid installed file', async () => {
    await withTempDir('happier-service-start-invalid-installed-file-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const { runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } = await loadCliModule();
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(paths.installedPath, 'not a real systemd unit', 'utf-8');

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('not_installed');
        expect(payload.message).toContain('Background service is not installed');
      } finally {
        output.restore();
      }
    });
  });

  it('reports that stopping the background service will not stop a manual relay owner', async () => {
    await withTempDir('happier-service-stop-owner-note-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43118,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        warning?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['stop', '--dry-run', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.warning).toContain('will not stop the current relay owner');
        expect(payload.warning).toContain('happier daemon stop');
      } finally {
        output.restore();
      }
    });
  });

  it('fails closed when starting a background service while a manual relay runtime already owns the relay', async () => {
    await withTempDir('happier-service-start-owner-conflict-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43116,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('owner_conflict');
        expect(payload.message).toContain('happier daemon stop');
        expect(payload.message).toContain('--takeover');
      } finally {
        output.restore();
      }
    });
  });

  it('treats an active wait-for-auth background service as a successful start when the current relay has no credentials', async () => {
    await withTempDir('happier-service-start-wait-for-auth-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'systemctl' && args.includes('is-active')) {
              return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { clearDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);
      clearDaemonState();

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('linux');
      } finally {
        output.restore();
      }
    });
  });

  it('allows taking over a manual relay runtime when starting a background service with --takeover', async () => {
    await withTempDir('happier-service-start-owner-takeover-', async (homeDir) => {
      stopDaemonMock.mockReset();
      let ownerWritten = false;
      let writeDaemonStateImpl: null | ((state: Parameters<typeof import('@/persistence')['writeDaemonState']>[0]) => void) = null;
      let expectedServiceLabel = '';
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'systemctl' && args.includes('is-active')) {
            return ownerWritten
              ? { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') }
              : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
          }
          writeDaemonStateImpl?.({
            pid: process.pid,
            httpPort: 43122,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-manual',
            startupSource: 'background-service',
            serviceLabel: expectedServiceLabel,
          });
          ownerWritten = true;
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);
      writeDaemonStateImpl = writeDaemonState;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43119,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        warning?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json', '--takeover'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.warning).toContain('Taking over the current manual relay runtime');
        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      } finally {
        output.restore();
      }
    });
  });

  it('trusts the darwin service owner during start takeover when launchctl status lags behind ownership', async () => {
    await withTempDir('happier-service-start-takeover-darwin-status-lag-', async (homeDir) => {
      stopDaemonMock.mockReset();
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '180',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'launchctl') {
            const action = String(args[0] ?? '');
            if (action === 'print') {
              return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('service not found in domain yet') };
            }
            if (action === 'bootstrap' || action === 'kickstart') {
              writeDaemonStateImpl?.({
                pid: process.pid,
                httpPort: 43136,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-service',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'background-service',
                serviceLabel: expectedServiceLabel,
                runtimeId: 'runtime-darwin-status-lag',
              });
            }
          }
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { resolveDaemonServiceInstallRuntimeTarget }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('./resolveDaemonServiceInstallRuntimeTarget'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
        currentExecPath: process.execPath,
        explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
        explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
        targetMode: runtime.targetMode,
        processEnv: process.env,
      });
      expectedServiceLabel = paths.label;
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      const expectedInstallPlan = planDaemonServiceInstall({
        platform: runtime.platform,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
        instanceId: runtime.instanceId,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: installRuntimeTarget.nodePath,
        entryPath: installRuntimeTarget.entryPath,
      });
      writeFileSync(paths.installedPath, expectedInstallPlan.files[0]?.content ?? '', 'utf-8');
      writeDaemonStateImpl = writeDaemonState;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43137,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'manual',
        runtimeId: 'runtime-darwin-status-lag-manual',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json', '--takeover'] });
        expect(output.json()).toEqual(expect.objectContaining({ ok: true, platform: 'darwin' }));
      } finally {
        output.restore();
      }

      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).not.toHaveBeenCalled();
    });
  });

  it('restores the manual relay runtime when service start takeover does not switch relay ownership', async () => {
    await withTempDir('happier-service-start-owner-takeover-postcondition-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] =
        await Promise.all([
          loadCliModule(),
          import('@/persistence'),
        ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43120,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['start', '--takeover'] })).rejects.toThrow(/take ownership/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('allows restarting the currently owning background service label', async () => {
    await withTempDir('happier-service-restart-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        buildLaunchdPlistXml({
          label: paths.label,
          programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            PATH: '/usr/bin:/bin',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_LABEL: paths.label,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          stdoutPath: `${happierHomeDir}/logs/daemon-service.out.log`,
          stderrPath: `${happierHomeDir}/logs/daemon-service.err.log`,
          workingDirectory: '/tmp',
        }),
        'utf-8',
      );

      writeDaemonState({
        pid: process.pid,
        httpPort: 43117,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { commands: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['restart', '--dry-run', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.plan?.commands).toEqual([
          {
            cmd: 'launchctl',
            args: ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${paths.label}`],
          },
        ]);
      } finally {
        output.restore();
      }
    });
  });

  it('treats an active wait-for-auth background service as a successful restart when the current relay has no credentials', async () => {
    await withTempDir('happier-service-restart-wait-for-auth-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'systemctl' && args.includes('is-active')) {
              return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { clearDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);
      clearDaemonState();

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['restart', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('linux');
      } finally {
        output.restore();
      }
    });
  });

  it('allows starting the currently owning background service label without rebootstrap', async () => {
    await withTempDir('happier-service-start-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        buildLaunchdPlistXml({
          label: paths.label,
          programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            PATH: '/usr/bin:/bin',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_LABEL: paths.label,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          stdoutPath: `${happierHomeDir}/logs/daemon-service.out.log`,
          stderrPath: `${happierHomeDir}/logs/daemon-service.err.log`,
          workingDirectory: '/tmp',
        }),
        'utf-8',
      );

      writeDaemonState({
        pid: process.pid,
        httpPort: 43127,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { commands: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--dry-run', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.plan?.commands).toEqual([
          {
            cmd: 'launchctl',
            args: ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${paths.label}`],
          },
        ]);
      } finally {
        output.restore();
      }
    });
  });

  it('refreshes the darwin launch agent definition before starting an installed stopped service', async () => {
    await withTempDir('happier-service-start-darwin-refreshes-plist-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: '',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '500',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      const originalArgv = process.argv;
      process.argv = [originalArgv[0] ?? 'node', 'happier'];

      let ownerWritten = false;
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let installedPath = '';
      let installedPathInitialMtimeMs = 0;
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command !== 'launchctl') {
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }

          const action = String(args[0] ?? '');
          if (action === 'print') {
            return ownerWritten
              ? { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') }
              : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('service not running') };
          }

          if (action === 'bootstrap') {
            const currentMtimeMs = existsSync(installedPath) ? statSync(installedPath).mtimeMs : 0;
            if (currentMtimeMs <= installedPathInitialMtimeMs) {
              return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
            }
            ownerWritten = true;
            writeDaemonStateImpl?.({
              pid: process.pid,
              httpPort: 43124,
              startedAt: Date.now(),
              startedWithCliVersion: '0.0.0-service',
              startedWithPublicReleaseChannel: 'stable',
              startupSource: 'background-service',
              serviceLabel: expectedServiceLabel,
              runtimeId: 'runtime-service-start-darwin',
            });
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }

          if (action === 'kickstart') {
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }

          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
      installedPath = paths.installedPath;
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        buildLaunchdPlistXml({
          label: paths.label,
          programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            PATH: '/usr/bin:/bin',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_LABEL: paths.label,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          stdoutPath: `${happierHomeDir}/logs/daemon-service.out.log`,
          stderrPath: `${happierHomeDir}/logs/daemon-service.err.log`,
          workingDirectory: '/tmp',
        }),
        'utf-8',
      );
      installedPathInitialMtimeMs = statSync(paths.installedPath).mtimeMs;
      writeDaemonStateImpl = writeDaemonState;

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        platform: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
      } finally {
        output.restore();
      }
    });
  });

  it('uses kickstart-only for darwin restart when the current relay owner already matches the background service', async () => {
    await withTempDir('happier-service-restart-darwin-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        buildLaunchdPlistXml({
          label: paths.label,
          programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            PATH: '/usr/bin:/bin',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_LABEL: paths.label,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          stdoutPath: `${happierHomeDir}/logs/daemon-service.out.log`,
          stderrPath: `${happierHomeDir}/logs/daemon-service.err.log`,
          workingDirectory: '/tmp',
        }),
        'utf-8',
      );

      writeDaemonState({
        pid: process.pid,
        httpPort: 43117,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { commands: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['restart', '--dry-run', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.plan?.commands).toEqual([
          {
            cmd: 'launchctl',
            args: ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${paths.label}`],
          },
        ]);
      } finally {
        output.restore();
      }
    });
  });

  it('treats installing the currently owning darwin background service as a no-op when the installed definition already matches', async () => {
    await withTempDir('happier-service-install-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '500',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();

      const launchctlCalls: string[] = [];
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
          if (command === 'launchctl') {
            launchctlCalls.push(args.join(' '));
            if (String(args[0] ?? '') === 'print') {
              return { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') };
            }
          }
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }),
      }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }, { resolveDaemonServiceInstallRuntimeTarget }, controlClient] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
        import('./resolveDaemonServiceInstallRuntimeTarget'),
        import('@/daemon/controlClient'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
        currentExecPath: process.execPath,
        explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
        explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
        targetMode: runtime.targetMode,
        processEnv: process.env,
      });
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      const expectedInstallPlan = planDaemonServiceInstall({
        platform: runtime.platform,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
        instanceId: runtime.instanceId,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: installRuntimeTarget.nodePath,
        entryPath: installRuntimeTarget.entryPath,
      });
      writeFileSync(paths.installedPath, expectedInstallPlan.files[0]?.content ?? '', 'utf-8');

      writeDaemonState({
        pid: process.pid,
        httpPort: 43129,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });
      vi.spyOn(controlClient, 'inspectDaemonRunningStateAndCleanupStaleState').mockResolvedValue({
        status: 'running',
        state: {
          pid: process.pid,
          httpPort: 43129,
          startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service',
          serviceLabel: paths.label,
        },
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        platform: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--yes', '--json'] });
        expect(output.json()).toEqual(expect.objectContaining({ ok: true, platform: 'darwin' }));
      } finally {
        output.restore();
      }

      expect(launchctlCalls.some((call) => call.startsWith('bootstrap '))).toBe(false);
    });
  });
});
