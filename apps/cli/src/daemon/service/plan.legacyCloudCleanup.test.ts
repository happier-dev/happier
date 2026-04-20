import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';

const baseInstallParams = {
  platform: 'linux',
  mode: 'user',
  channel: 'stable',
  userHomeDir: '/home/alice',
  happierHomeDir: '/home/alice/.happier',
  serverUrl: 'https://api.example.test',
  webappUrl: 'https://app.example.test',
  publicServerUrl: 'https://api.example.test',
  nodePath: '/usr/bin/node',
  entryPath: '/opt/happier/package-dist/index.mjs',
} as const;

describe('daemon service plan legacy cloud cleanup', () => {
  it('emits legacy cleanup for non-cloud default-following installs', () => {
    const plan = planDaemonServiceInstall({
      ...baseInstallParams,
      targetMode: 'default-following',
      instanceId: 'company',
    });

    expect(
      plan.commands.some(
        (command) =>
          command.cmd === 'systemctl' &&
          command.args.includes('disable') &&
          command.args.includes('--now') &&
          command.args.includes('happier-daemon.service'),
      ),
    ).toBe(true);
  });

  it('still emits legacy cleanup for cloud default-following installs', () => {
    const plan = planDaemonServiceInstall({
      ...baseInstallParams,
      targetMode: 'default-following',
      instanceId: 'cloud',
    });

    expect(
      plan.commands.some(
        (command) =>
          command.cmd === 'systemctl' &&
          command.args.includes('disable') &&
          command.args.includes('--now') &&
          command.args.includes('happier-daemon.service'),
      ),
    ).toBe(true);
  });

  it('emits legacy channel-scoped cleanup for default-following installs from older channel-specific layouts', () => {
    const plan = planDaemonServiceUninstall({
      platform: 'linux',
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      instanceId: 'default',
      userHomeDir: '/home/alice',
      happierHomeDir: '/home/alice/.happier',
    });

    expect(plan.filesToRemove).toContain('/home/alice/.config/systemd/user/happier-daemon.preview.default.service');
    expect(
      plan.commands.some(
        (command) =>
          command.cmd === 'systemctl' &&
          command.args.includes('disable') &&
          command.args.includes('--now') &&
          command.args.includes('happier-daemon.preview.default.service'),
      ),
    ).toBe(true);
  });
});
