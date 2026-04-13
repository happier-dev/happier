import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';

describe('daemon service plan win32 mode handling', () => {
  it('uses schtasks-system semantics when mode=system', () => {
    const plan = planDaemonServiceInstall({
      platform: 'win32',
      mode: 'system',
      channel: 'stable',
      instanceId: 'cloud',
      userHomeDir: 'C:\\\\Users\\\\Alice',
      happierHomeDir: 'C:\\\\Users\\\\Alice\\\\.happier',
      serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test',
      publicServerUrl: 'https://api.example.test',
      nodePath: 'C:\\\\Program Files\\\\nodejs\\\\node.exe',
      entryPath: 'C:\\\\happier\\\\dist\\\\index.mjs',
    });

    expect(plan.files[0]?.path ?? '').toMatch(/^C:\\\\ProgramData\\\\happier\\\\services\\\\/);
    const create = plan.commands.find((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
    expect(create).toBeTruthy();
    expect(create?.args.join(' ')).toContain('/SC ONSTART');
    expect(create?.args.join(' ')).toContain('/RU SYSTEM');
  });

  it('uses schtasks-user semantics when mode=user', () => {
    const plan = planDaemonServiceInstall({
      platform: 'win32',
      mode: 'user',
      channel: 'stable',
      instanceId: 'cloud',
      userHomeDir: 'C:\\\\Users\\\\Alice',
      happierHomeDir: 'C:\\\\Users\\\\Alice\\\\.happier',
      serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test',
      publicServerUrl: 'https://api.example.test',
      nodePath: 'C:\\\\Program Files\\\\nodejs\\\\node.exe',
      entryPath: 'C:\\\\happier\\\\dist\\\\index.mjs',
    });

    expect(plan.files[0]?.path ?? '').toContain('\\.happier\\services\\');
    const create = plan.commands.find((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
    expect(create).toBeTruthy();
    expect(create?.args.join(' ')).toContain('/SC ONLOGON');
    expect(create?.args.join(' ')).not.toContain('/RU SYSTEM');
  });

  it('uninstall uses schtasks-system semantics when mode=system', () => {
    const plan = planDaemonServiceUninstall({
      platform: 'win32',
      mode: 'system',
      channel: 'stable',
      instanceId: 'cloud',
      userHomeDir: 'C:\\\\Users\\\\Alice',
      happierHomeDir: 'C:\\\\Users\\\\Alice\\\\.happier',
    });

    const remove = plan.commands.find((c) => c.cmd === 'schtasks' && c.args.includes('/Delete'));
    expect(remove).toBeTruthy();
    expect(plan.filesToRemove[0] ?? '').toMatch(/^C:\\\\ProgramData\\\\happier\\\\services\\\\/);
  });

  it('uninstall targets the discovered Windows wrapper task name when installedPath is legacy-scoped', () => {
    const plan = planDaemonServiceUninstall({
      platform: 'win32',
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'cloud',
      userHomeDir: 'C:\\\\Users\\\\Alice',
      happierHomeDir: 'C:\\\\Users\\\\Alice\\\\.happier',
      installedPath: 'C:\\\\Users\\\\Alice\\\\.happier\\\\services\\\\happier-daemon.preview.default.ps1',
    });

    expect(plan.commands).toContainEqual({
      cmd: 'schtasks',
      args: ['/Delete', '/F', '/TN', 'Happier\\happier-daemon.preview.default'],
    });
  });
});
