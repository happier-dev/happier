import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { spawnStoppableHttpDaemon, withConfiguredDaemonTestHome, writeDaemonSettingsFixture, writeDaemonStateFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';
import { handleDaemonCliCommand } from '@/cli/commands/daemon';
import { applyBackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { runDaemonServiceCliCommand } from './cli';
import { installDaemonService } from './installer';
import { planDaemonServiceInstall } from './plan';

// Preserve real process behavior except the explicit scheduled-task OS boundary below.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

describe('service manager availability before mutation', () => {
  it('returns a structured missing-manager error from the real JSON start command', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-start-json-', env: {
      PATH: '', HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_DAEMON_SERVICE_UID: '123', HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath,
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: process.argv[1],
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const plan = planDaemonServiceInstall({
        platform: 'linux', uid: 123, userHomeDir: homeDir, happierHomeDir: homeDir,
        channel: 'stable', targetMode: 'default-following', instanceId: 'default',
        serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev', publicServerUrl: 'https://api.happier.dev',
        nodePath: process.execPath, entryPath: process.argv[1],
      });
      const file = plan.files[0]!;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, 'utf8');
      const output = captureStdoutJsonOutput<{ ok: boolean; error: string }>();
      try {
        await expect(runDaemonServiceCliCommand({ argv: ['start', '--json'] })).resolves.toBeUndefined();
        expect(output.json()).toMatchObject({ ok: false, error: 'service_manager_unavailable' });
      } finally {
        output.restore();
      }
    });
  });
  it('removes a pinned Windows service without requiring start-only schtasks', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-remove-pin-', env: { PATH: '' } }, async ({ homeDir }) => {
      // The shared service owner checks executable availability on the host OS.
      // Execution remains mocked at the scheduled-task process boundary below.
      writeFileSync(join(homeDir, 'powershell.exe'), 'fixture', { mode: 0o755 });
      process.env.PATH = homeDir;
      const installedPath = join(homeDir, 'happier-daemon.cloud.ps1');
      writeFileSync(installedPath, 'existing wrapper');
      const realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawnSync;
      const spawn = vi.spyOn(childProcess, 'spawnSync').mockImplementation((...args) => {
        if (args[0] === 'powershell.exe') return { pid: 1, status: 0, signal: null, output: [null, '', ''], stdout: '', stderr: '' };
        return Reflect.apply(realSpawn, childProcess, args);
      });
      try {
        await expect(applyBackgroundServiceRepairPlan({
          currentReleaseChannel: 'stable', existingServices: [], manualWarnings: [],
          actions: [{ kind: 'remove-service', service: {
            label: 'happier-daemon.cloud', installedPath, mode: 'user', releaseChannel: 'stable',
            targetMode: 'pinned', instanceId: 'cloud',
          } }],
        }, { platform: 'win32', systemUser: '', uid: null, userHomeDir: homeDir, happierHomeDir: homeDir }))
          .resolves.toEqual({ executedActions: ['remove:happier-daemon.cloud'] });
        expect(existsSync(installedPath)).toBe(false);
      } finally {
        spawn.mockRestore();
      }
    });
  });
  it.each(['start', 'restart'] as const)('preserves a drifted definition before %s with no manager', async (action) => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-drift-', env: {
      PATH: '', HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_DAEMON_SERVICE_UID: '123', HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath,
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: process.argv[1],
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const plan = planDaemonServiceInstall({
        platform: 'linux', uid: 123, userHomeDir: homeDir, happierHomeDir: homeDir,
        channel: 'stable', targetMode: 'default-following', instanceId: 'default',
        serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev', publicServerUrl: 'https://api.happier.dev',
        nodePath: process.execPath, entryPath: process.argv[1],
      });
      const file = plan.files[0]!;
      const existing = `${file.content}\n# operator customization\n`;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, existing, 'utf8');
      const output = captureStdoutJsonOutput<{ ok: boolean; error: string }>();
      try {
        const error = await runDaemonServiceCliCommand({ argv: [action, '--json'] })
          .then(() => null, (error: unknown) => error);
        expect(readFileSync(file.path, 'utf8')).toBe(existing);
        expect(error).toBeNull();
        expect(output.json()).toMatchObject({ ok: false, error: 'service_manager_unavailable' });
      } finally {
        output.restore();
      }
    });
  });
  it('still rejects manual takeover of a live service-owned daemon without systemctl', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-live-owner-', env: {
      PATH: '', HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const port = await reserveEphemeralPort();
      const daemon = spawnStoppableHttpDaemon(port, 500, { controlToken: 'test-token' });
      const state = {
        pid: daemon.pid, httpPort: port, controlToken: 'test-token',
        startedWithCliVersion: '0.0.0-test', startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service', serviceLabel: 'happier-daemon.default',
      } as const;
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, state);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test-process-exit'); });
      const output = captureStdoutJsonOutput<{ ok: boolean; error: string }>();
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        await expect(handleDaemonCliCommand({
          args: ['daemon', 'start', '--takeover', '--json'],
          rawArgv: ['happier', 'daemon', 'start', '--takeover', '--json'], terminalRuntime: null,
        })).rejects.toThrow('test-process-exit');
        expect(output.json()).toMatchObject({ ok: false, error: 'owner_conflict' });
        expect(await waitForHttpReady(port)).toBe(true);
      } finally {
        exit.mockRestore();
        output.restore();
        await daemon.kill();
      }
    });
  });
  it('preflights installation before stopping a live manual owner for takeover', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-takeover-', env: {
      PATH: '', HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath, HAPPIER_DAEMON_SERVICE_ENTRY_PATH: process.argv[1],
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const port = await reserveEphemeralPort();
      // A real control endpoint rejects stop, so an early takeover attempt is observable
      // without letting the test launch a replacement daemon.
      const daemon = spawnStoppableHttpDaemon(port, 500, { controlToken: 'test-token' });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: daemon.pid, httpPort: port, controlToken: 'test-token',
      });
      const output = captureStdoutJsonOutput<{ ok: boolean; error: string }>();
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        await expect(runDaemonServiceCliCommand({ argv: ['install', '--takeover', '--json'] })).resolves.toBeUndefined();
        expect(output.json()).toMatchObject({ ok: false, error: 'service_manager_unavailable' });
        expect(await waitForHttpReady(port)).toBe(true);
      } finally {
        output.restore();
        await daemon.kill();
      }
    });
  });
  it('returns a structured missing-manager error from the real JSON install command', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-json-', env: {
      PATH: '', HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath, HAPPIER_DAEMON_SERVICE_ENTRY_PATH: process.argv[1],
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const output = captureStdoutJsonOutput<{ ok: boolean; error: string }>();
      try {
        await expect(runDaemonServiceCliCommand({ argv: ['install', '--json'] })).resolves.toBeUndefined();
        expect(output.json()).toMatchObject({ ok: false, error: 'service_manager_unavailable' });
      } finally {
        output.restore();
      }
    });
  });

  it('preserves the existing definition and daemon before an install with no manager', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-install-', env: { PATH: '' } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const options = {
        platform: 'linux', uid: 123, userHomeDir: homeDir, happierHomeDir: homeDir,
        channel: 'stable', targetMode: 'default-following', instanceId: 'default',
        serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev', publicServerUrl: 'https://api.happier.dev',
        nodePath: process.execPath, entryPath: process.argv[1],
      } as const;
      const existingPlan = planDaemonServiceInstall(options);
      const definition = existingPlan.files[0]!;
      mkdirSync(dirname(definition.path), { recursive: true });
      writeFileSync(definition.path, definition.content, 'utf8');
      const beforeApply = vi.fn(async () => undefined);

      await expect(installDaemonService({ ...options, autostart: 'on-demand', beforeApply, commandFailureMode: 'strict' }))
        .rejects.toMatchObject({ code: 'service_manager_unavailable' });

      expect(beforeApply).not.toHaveBeenCalled();
      expect(readFileSync(definition.path, 'utf8')).toBe(definition.content);
    });
  });

  it('does not remove a preexisting definition before doctor repair discovers a missing manager', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'service-manager-repair-', env: { PATH: '' } }, async ({ homeDir }) => {
      const installedPath = join(homeDir, 'happier-daemon.default.service');
      const definition = 'existing user definition';
      writeFileSync(installedPath, definition, 'utf8');
      await expect(applyBackgroundServiceRepairPlan({
        currentReleaseChannel: 'stable', existingServices: [], manualWarnings: [],
        actions: [{ kind: 'remove-service', service: {
          label: 'happier-daemon.default', installedPath, mode: 'user', releaseChannel: 'stable',
          targetMode: 'default-following', instanceId: 'default',
        } }],
      }, { platform: 'linux', systemUser: '', uid: 123, userHomeDir: homeDir, happierHomeDir: homeDir }))
        .rejects.toMatchObject({ code: 'service_manager_unavailable' });
      expect(readFileSync(installedPath, 'utf8')).toBe(definition);
    });
  });
});
