import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';

describe('daemon service legacy cleanup planning', () => {
  it('marks legacy Linux cleanup commands as optional during default-following installs', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'cloud',
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      serverUrl: 'http://127.0.0.1:24910',
      webappUrl: 'http://localhost:24910',
      publicServerUrl: 'http://localhost:24910',
      nodePath: '/home/tester/.happier/cli/current/happier',
      entryPath: '/home/tester/.happier/cli/current/happier',
    });

    expect(plan.commands).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'disable', '--now', 'happier-daemon.service'],
      ignoreFailure: true,
    });
  });

  it('marks legacy Linux cleanup commands as optional during default-following uninstalls', () => {
    const plan = planDaemonServiceUninstall({
      platform: 'linux',
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'cloud',
      userHomeDir: '/home/tester',
    });

    expect(plan.commands).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'disable', '--now', 'happier-daemon.service'],
      ignoreFailure: true,
    });
    expect(plan.commands).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'stop', 'happier-daemon.service'],
      ignoreFailure: true,
    });
  });
});
