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

  it('tolerates only absent legacy Linux services during default-following uninstalls', () => {
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
      expectedFailure: 'service-absent',
    });
  });

  it('cleans up legacy channel-scoped default-following Linux units during non-stable uninstalls', () => {
    const plan = planDaemonServiceUninstall({
      platform: 'linux',
      mode: 'user',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      userHomeDir: '/home/tester',
    });

    expect(plan.filesToRemove).toContain('/home/tester/.config/systemd/user/happier-daemon.dev.default.service');
    expect(plan.commands).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'disable', '--now', 'happier-daemon.dev.default.service'],
      expectedFailure: 'service-absent',
    });
  });

  it('removes only the discovered legacy Linux unit when uninstall targets a specific legacy default-following path', () => {
    const plan = planDaemonServiceUninstall({
      platform: 'linux',
      mode: 'user',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      userHomeDir: '/home/tester',
      installedPath: '/home/tester/.config/systemd/user/happier-daemon.dev.default.service',
    });

    expect(plan.filesToRemove).toContain('/home/tester/.config/systemd/user/happier-daemon.dev.default.service');
    expect(plan.filesToRemove).not.toContain('/home/tester/.config/systemd/user/happier-daemon.default.service');
    expect(plan.commands).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'disable', '--now', 'happier-daemon.dev.default.service'],
      expectedFailure: 'service-absent',
    });
    expect(plan.commands).not.toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'disable', '--now', 'happier-daemon.default.service'],
    });
  });

  it('marks legacy Windows scheduled-task cleanup as optional during default-following installs', () => {
    const plan = planDaemonServiceInstall({
      platform: 'win32',
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'cloud',
      userHomeDir: 'C:\\Users\\tester',
      happierHomeDir: 'C:\\Users\\tester\\.happier',
      serverUrl: 'http://127.0.0.1:24910',
      webappUrl: 'http://localhost:24910',
      publicServerUrl: 'http://localhost:24910',
      nodePath: 'C:\\Users\\tester\\.happier\\cli\\current\\happier.exe',
      entryPath: 'C:\\Users\\tester\\.happier\\cli\\current\\happier.exe',
    });

    expect(plan.commands).toContainEqual({
      cmd: 'schtasks',
      args: ['/End', '/TN', 'Happier\\happier-daemon'],
      ignoreFailure: true,
    });
    expect(plan.commands).toContainEqual({
      cmd: 'schtasks',
      args: ['/Delete', '/F', '/TN', 'Happier\\happier-daemon'],
      ignoreFailure: true,
    });
  });
});
