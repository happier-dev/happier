import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { withTempDir } from '@/testkit/fs/tempDir';
import { planDaemonServiceInstall } from '@/daemon/service/plan';
import {
  readInstalledDaemonServiceAutostartMode,
  readInstalledDaemonServiceBundleId,
  readInstalledDaemonServiceManagedBy,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';
import { applyBackgroundServiceRepairPlan } from './applyBackgroundServiceRepairPlan';

const { writeFileMock } = vi.hoisted(() => ({ writeFileMock: vi.fn() }));

// Only OS commands and filesystem write failures are substituted. Repair, discovery, installer,
// preserved-field readers, renderers and rollback remain real and use temporary definition files.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn((command: string, args: readonly string[] = []) => ({
    status: 0,
    stdout: Buffer.from(command === 'powershell.exe' && args.some((arg) => arg.includes('.GetFolder("\\Happier")')) ? '[]' : ''),
    stderr: Buffer.from(''),
  })),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  writeFileMock.mockImplementation(actual.writeFile);
  return { ...actual, writeFile: writeFileMock };
});

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
});

function definition(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  homeDir: string;
  targetMode?: 'default-following' | 'pinned';
  managedBy?: 'desktop';
  autostart?: 'at-login' | 'on-demand';
  bundleId?: string;
}>) {
  return planDaemonServiceInstall({
    platform: params.platform,
    channel: 'preview',
    targetMode: params.targetMode ?? 'default-following',
    instanceId: params.targetMode === 'pinned' ? 'company' : 'default',
    activeServerId: 'company',
    uid: 501,
    userHomeDir: params.homeDir,
    happierHomeDir: `${params.homeDir}/.happier`,
    nodePath: '/usr/local/bin/happier',
    entryPath: '',
    serverUrl: 'https://company.example.test',
    publicServerUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
    managedBy: params.managedBy,
    autostart: params.autostart,
    bundleId: params.bundleId,
  }).files[0]!;
}

function installFixture(params: Parameters<typeof definition>[0], legacy: boolean): DaemonServiceListEntry {
  const file = definition(params);
  const canonicalLabel = params.platform === 'darwin' ? 'com.happier.cli.daemon.default' : 'happier-daemon.default';
  const legacyLabel = canonicalLabel.replace('.default', '.preview.default');
  const path = legacy ? file.path.replace(canonicalLabel, legacyLabel) : file.path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, legacy ? file.content.replaceAll(canonicalLabel, legacyLabel) : file.content);
  return {
    serverId: params.targetMode === 'pinned' ? 'company' : 'default',
    name: 'Previous service',
    installed: true,
    installedDefinitionMatchesExpected: false,
    path,
    platform: params.platform,
    mode: 'user',
    happierHomeDir: `${params.homeDir}/.happier`,
    releaseChannel: 'preview',
    label: legacy ? legacyLabel : 'company',
    targetMode: params.targetMode ?? 'default-following',
  };
}

function settings(platform: 'darwin' | 'linux' | 'win32', path: string) {
  return {
    autostart: readInstalledDaemonServiceAutostartMode({ platform, path }),
    managedBy: readInstalledDaemonServiceManagedBy({ platform, path }),
    bundleId: readInstalledDaemonServiceBundleId({ platform, path }),
  };
}

function runtime(platform: 'darwin' | 'linux' | 'win32', homeDir: string) {
  const commandDir = join(homeDir, 'commands');
  mkdirSync(commandDir, { recursive: true });
  for (const command of ['systemctl', 'launchctl', 'powershell.exe', 'schtasks']) {
    // The service owner only accepts executable PATH entries.
    writeFileSync(join(commandDir, command), 'OS command fixture', { mode: 0o755 });
    chmodSync(join(commandDir, command), 0o755);
    if (process.platform === 'win32' && !command.endsWith('.exe')) {
      writeFileSync(join(commandDir, `${command}.exe`), 'OS command fixture');
    }
  }
  vi.stubEnv('PATH', commandDir);
  vi.stubEnv('HAPPIER_HOME_DIR', `${homeDir}/.happier`);
  reloadConfiguration();
  return { platform, systemUser: '', uid: 501, userHomeDir: homeDir, happierHomeDir: `${homeDir}/.happier` };
}

describe('repair preserves the previous definition through real reinstall', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('keeps on-demand, desktop ownership and bundle attribution on %s', async (platform) => {
    await withTempDir(`happier-repair-preserve-${platform}-`, async (homeDir) => {
      const params = { platform, homeDir, managedBy: 'desktop' as const, autostart: 'on-demand' as const, bundleId: 'dev.happier.app.preview' };
      const previous = installFixture(params, true);
      const previousPin = installFixture({ platform, homeDir, targetMode: 'pinned', autostart: 'at-login' }, false);
      const expected = settings(platform, previous.path);
      expect(expected).toEqual({ autostart: 'on-demand', managedBy: 'desktop', bundleId: params.bundleId });
      const plan = buildBackgroundServiceRepairPlan({
        currentReleaseChannel: 'preview', currentHappierHomeDir: `${homeDir}/.happier`,
        currentServerId: 'company', preferredMode: 'user', services: [previousPin, previous],
      });

      await applyBackgroundServiceRepairPlan(plan, runtime(platform, homeDir));

      const repaired = definition(params).path;
      expect(settings(platform, repaired)).toEqual(expected);
      if (platform === 'darwin') {
        expect(readFileSync(repaired, 'utf8')).toContain('<key>AssociatedBundleIdentifiers</key>');
        expect(readFileSync(repaired, 'utf8')).toContain(`<string>${params.bundleId}</string>`);
      }
    });
  });

  it('inherits a migrated current-relay pin when there is no prior default', async () => {
    await withTempDir('happier-repair-preserve-pin-', async (homeDir) => {
      const platform = 'darwin';
      const params = { platform, homeDir, targetMode: 'pinned', managedBy: 'desktop', autostart: 'on-demand', bundleId: 'dev.happier.app.preview' } as const;
      const previous = installFixture(params, false);
      const plan = buildBackgroundServiceRepairPlan({
        currentReleaseChannel: 'preview', currentHappierHomeDir: `${homeDir}/.happier`,
        currentServerId: 'company', preferredMode: 'user', services: [previous],
      });
      const expected = settings(platform, previous.path);

      await applyBackgroundServiceRepairPlan(plan, runtime(platform, homeDir));

      expect(settings(platform, definition({ platform, homeDir }).path)).toEqual(expected);
    });
  });

  it('does not transfer a removed pin\'s desktop ownership onto a user-owned default', async () => {
    await withTempDir('happier-repair-preserve-user-owned-', async (homeDir) => {
      const platform = 'darwin';
      const defaultParams = { platform, homeDir, autostart: 'at-login' } as const;
      const previousDefault = installFixture(defaultParams, true);
      const previousPinned = installFixture({ platform, homeDir, targetMode: 'pinned', managedBy: 'desktop', autostart: 'on-demand', bundleId: 'dev.happier.app.preview' }, false);
      const expected = settings(platform, previousDefault.path);
      const plan = buildBackgroundServiceRepairPlan({
        currentReleaseChannel: 'preview', currentHappierHomeDir: `${homeDir}/.happier`,
        currentServerId: 'company', preferredMode: 'user', services: [previousPinned, previousDefault],
      });

      await applyBackgroundServiceRepairPlan(plan, runtime(platform, homeDir));

      expect(settings(platform, definition(defaultParams).path)).toEqual(expected);
    });
  });

  it('restores each removed service with its own settings if replacement writing fails', async () => {
    await withTempDir('happier-repair-preserve-rollback-', async (homeDir) => {
      const platform = 'darwin';
      const defaultParams = { platform, homeDir, managedBy: 'desktop', autostart: 'on-demand', bundleId: 'dev.happier.app.preview' } as const;
      const pinnedParams = { platform, homeDir, targetMode: 'pinned', autostart: 'at-login' } as const;
      const previousDefault = installFixture(defaultParams, true);
      const previousPinned = installFixture(pinnedParams, false);
      const expectedDefault = settings(platform, previousDefault.path);
      const expectedPinned = settings(platform, previousPinned.path);
      const plan = buildBackgroundServiceRepairPlan({
        currentReleaseChannel: 'preview', currentHappierHomeDir: `${homeDir}/.happier`,
        currentServerId: 'company', preferredMode: 'user', services: [previousDefault, previousPinned],
      });
      const failure = new Error('replacement write failed');
      writeFileMock.mockRejectedValueOnce(failure);

      await expect(applyBackgroundServiceRepairPlan(plan, runtime(platform, homeDir))).rejects.toThrow(failure);

      expect(settings(platform, definition(defaultParams).path)).toEqual(expectedDefault);
      expect(settings(platform, definition(pinnedParams).path)).toEqual(expectedPinned);
    });
  });
});
